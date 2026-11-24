// @effect-diagnostics globalTimers:off - This WebView input runs without an Effect runtime.
import type { HostedBlenderInputMessage, HostedBlenderPointerButton } from "@t3tools/contracts";

/** A point in stream pixels. */
export interface TouchPoint {
  readonly x: number;
  readonly y: number;
}

export interface HostedBlenderTouch {
  readonly down: (id: number, point: TouchPoint) => void;
  readonly move: (id: number, point: TouchPoint) => void;
  readonly up: (id: number) => void;
  /** The system took the touch: nothing it started clicks, and held input is let go. */
  readonly cancel: (id: number) => void;
  /** Blender holds the mouse (a grab or an orbit), so motion is sent relative. */
  readonly setCaptured: (captured: boolean) => void;
  /** Lets go of anything held. */
  readonly dispose: () => void;
}

const LEFT: HostedBlenderPointerButton = 272;
const RIGHT: HostedBlenderPointerButton = 273;
const MIDDLE: HostedBlenderPointerButton = 274;
const SHIFT = 42;
const LONG_PRESS_MS = 500;
// One wheel notch per this much change in the natural log of the fingers' distance (~16%).
const PINCH_STEP = 0.15;
// libinput reports a wheel notch as 15 degrees, as `scrollInput` does.
const WHEEL_VALUE_PER_STEP = 15;
const MAX_DELTA = 10_000;

type Gesture =
  | { readonly kind: "idle" }
  /** One finger down, not yet a drag, a tap or a long press. */
  | { readonly kind: "press"; readonly start: TouchPoint }
  | { readonly kind: "orbit"; last: TouchPoint }
  /** Two fingers down, not yet a pan or a pinch. */
  | {
      readonly kind: "pair";
      readonly starts: ReadonlyMap<number, TouchPoint>;
      readonly centre: TouchPoint;
      readonly distance: number;
    }
  | { readonly kind: "pan"; last: TouchPoint }
  | { readonly kind: "pinch"; base: number }
  /** Finished (a long press, a lifted or extra finger); ignored until every finger lifts. */
  | { readonly kind: "done" };

const centreOf = (a: TouchPoint, b: TouchPoint): TouchPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});
const distanceOf = (a: TouchPoint, b: TouchPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const clampDelta = (value: number) => Math.max(-MAX_DELTA, Math.min(MAX_DELTA, value));

/**
 * Turns touches on the stream into Blender's mouse: one finger orbits (middle drag), two pan
 * (Shift + middle drag), a pinch zooms (wheel notches), a long press right-clicks and a tap
 * left-clicks. `slop` is how far, in stream pixels, a finger moves before it drags; it is read
 * on each touch, so it follows the stream's scale.
 */
export function createHostedBlenderTouch(options: {
  readonly send: (message: HostedBlenderInputMessage) => void;
  readonly slop: () => number;
}): HostedBlenderTouch {
  const { send, slop } = options;
  const fingers = new Map<number, TouchPoint>();
  let gesture: Gesture = { kind: "idle" };
  let captured = false;
  let longPress: ReturnType<typeof setTimeout> | null = null;

  const clearLongPress = () => {
    if (longPress !== null) clearTimeout(longPress);
    longPress = null;
  };
  const pointer = (point: TouchPoint) => send({ type: "pointer", x: point.x, y: point.y });
  const button = (code: HostedBlenderPointerButton, pressed: boolean) =>
    send({ type: "button", button: code, pressed });
  const click = (point: TouchPoint, code: HostedBlenderPointerButton) => {
    pointer(point);
    button(code, true);
    button(code, false);
  };
  const moveTo = (from: TouchPoint, to: TouchPoint) => {
    if (captured) {
      const dx = clampDelta(to.x - from.x);
      const dy = clampDelta(to.y - from.y);
      if (dx !== 0 || dy !== 0) send({ type: "pointerMotion", dx, dy });
    } else pointer(to);
  };

  const release = () => {
    clearLongPress();
    if (gesture.kind === "orbit") button(MIDDLE, false);
    if (gesture.kind === "pan") {
      button(MIDDLE, false);
      send({ type: "key", code: SHIFT, pressed: false });
    }
  };

  const finishOne = (tap: boolean) => {
    const start = gesture.kind === "press" && tap ? gesture.start : null;
    release();
    gesture = fingers.size === 0 ? { kind: "idle" } : { kind: "done" };
    if (start !== null) click(start, LEFT);
  };

  const pair = (): [TouchPoint, TouchPoint] | null => {
    const [a, b] = [...fingers.values()];
    return a && b ? [a, b] : null;
  };

  return {
    down: (id, point) => {
      fingers.set(id, point);
      if (fingers.size === 1 && gesture.kind === "idle") {
        gesture = { kind: "press", start: point };
        longPress = setTimeout(() => {
          longPress = null;
          if (gesture.kind !== "press") return;
          const start = gesture.start;
          gesture = { kind: "done" };
          click(start, RIGHT);
        }, LONG_PRESS_MS);
        return;
      }
      const both = pair();
      if (fingers.size === 2 && both && (gesture.kind === "press" || gesture.kind === "orbit")) {
        release();
        gesture = {
          kind: "pair",
          starts: new Map(fingers),
          centre: centreOf(...both),
          distance: distanceOf(...both),
        };
        return;
      }
      release();
      gesture = { kind: "done" };
    },
    move: (id, point) => {
      const previous = fingers.get(id);
      if (previous === undefined) return;
      fingers.set(id, point);
      switch (gesture.kind) {
        case "press": {
          if (distanceOf(gesture.start, point) <= slop()) return;
          clearLongPress();
          pointer(gesture.start);
          button(MIDDLE, true);
          moveTo(gesture.start, point);
          gesture = { kind: "orbit", last: point };
          return;
        }
        case "orbit":
          moveTo(gesture.last, point);
          gesture.last = point;
          return;
        case "pair": {
          const both = pair();
          if (!both) return;
          const centre = centreOf(...both);
          const kind = pairKind(gesture.starts, slop());
          if (kind === null) return;
          pointer(gesture.centre);
          if (kind === "pinch" && gesture.distance > 0) {
            gesture = { kind: "pinch", base: Math.log(gesture.distance) };
            return zoom(both);
          }
          send({ type: "key", code: SHIFT, pressed: true });
          button(MIDDLE, true);
          moveTo(gesture.centre, centre);
          gesture = { kind: "pan", last: centre };
          return;
        }
        case "pan": {
          const both = pair();
          if (!both) return;
          const centre = centreOf(...both);
          moveTo(gesture.last, centre);
          gesture.last = centre;
          return;
        }
        case "pinch": {
          const both = pair();
          if (both) zoom(both);
          return;
        }
      }
    },
    up: (id) => {
      if (!fingers.delete(id)) return;
      finishOne(true);
    },
    cancel: (id) => {
      if (!fingers.delete(id)) return;
      finishOne(false);
    },
    setCaptured: (next) => {
      captured = next;
    },
    dispose: () => {
      release();
      fingers.clear();
      gesture = { kind: "idle" };
    },
  };

  // Each finger reports its own move, so one finger's move alone can look like a pinch. Judge by
  // both fingers' travel: together is a pan, apart or together is a pinch. Until the second
  // finger reports, wait, unless the first has gone far enough to be a pinch around a still one.
  function pairKind(starts: ReadonlyMap<number, TouchPoint>, threshold: number) {
    const travel = [...starts].map(([id, start]) => {
      const now = fingers.get(id) ?? start;
      return { x: now.x - start.x, y: now.y - start.y };
    });
    const [a, b] = travel;
    if (!a || !b) return null;
    const lengths = [Math.hypot(a.x, a.y), Math.hypot(b.x, b.y)];
    const far = Math.max(...lengths);
    if (far <= threshold) return null;
    if (Math.min(...lengths) < threshold / 2) return far > threshold * 4 ? "pinch" : null;
    return a.x * b.x + a.y * b.y > 0 ? "pan" : "pinch";
  }

  function zoom(both: [TouchPoint, TouchPoint]) {
    if (gesture.kind !== "pinch") return;
    const distance = distanceOf(...both);
    if (distance <= 0) return;
    const level = Math.log(distance);
    // Spreading the fingers zooms in, like scrolling the wheel up.
    while (level - gesture.base >= PINCH_STEP) {
      gesture.base += PINCH_STEP;
      notch(-1);
    }
    while (gesture.base - level >= PINCH_STEP) {
      gesture.base -= PINCH_STEP;
      notch(1);
    }
  }

  function notch(steps: -1 | 1) {
    send({
      type: "scroll",
      axis: "vertical",
      source: "wheel",
      value: steps * WHEEL_VALUE_PER_STEP,
      steps,
    });
  }
}
