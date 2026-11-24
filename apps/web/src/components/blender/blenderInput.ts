import {
  EVDEV_KEY_ESCAPE,
  evdevKeyCode,
  type HostedBlenderScrollPreference,
  scrollInput,
  scrollKind,
} from "@t3tools/client-runtime/hosted-blender/input";
import type {
  HostedBlenderInputMessage,
  HostedBlenderKeymap,
  HostedBlenderPointerButton,
} from "@t3tools/contracts";

import { captureKeyboard } from "~/lib/keyboardCapture";

export interface BlenderInputOptions {
  /** The focused element that owns the keyboard while in control. */
  readonly surface: HTMLElement;
  /** The stream; its size in pixels is the stream's. */
  readonly canvas: HTMLCanvasElement;
  readonly send: (message: HostedBlenderInputMessage) => void;
  /** Read at each key press, so a layout switch reaches Blender before the next key. */
  readonly keymap: () => HostedBlenderKeymap;
  readonly scrollPreference: () => HostedBlenderScrollPreference;
  /** Keys T3 keeps while in control, such as its focus shortcuts. */
  readonly passThrough: (event: KeyboardEvent) => boolean;
}

export interface BlenderInput {
  /** Blender captured the mouse (a grab or orbit), or let it go. */
  readonly setCaptured: (captured: boolean) => void;
  /** Releases every key and button Blender thinks is held. */
  readonly releaseAll: () => void;
  readonly dispose: () => void;
}

const MIDDLE_BUTTON = 1;
// MouseEvent.button → its PointerEvent.buttons bit: primary, middle, secondary, back, forward.
const BUTTON_FOR_INDEX = [1, 4, 2, 8, 16];
// PointerEvent.buttons bits: primary, secondary, auxiliary (middle), back, forward.
const BUTTON_BITS: ReadonlyArray<readonly [number, HostedBlenderPointerButton]> = [
  [1, 272],
  [2, 273],
  [4, 274],
  [8, 275],
  [16, 276],
];

/**
 * The mouse and keyboard of the viewer in control. While Blender holds the mouse the pointer
 * is locked and motion is relative, so grabs and orbits carry on past the pane's edge;
 * otherwise the local cursor's position is sent.
 */
export function attachBlenderInput(options: BlenderInputOptions): BlenderInput {
  const { surface, canvas, send } = options;
  const heldKeys = new Set<number>();
  const heldButtons = new Set<HostedBlenderPointerButton>();
  let sentKeymap = "";
  let captured = false;
  let unlocking = false;
  let position: { x: number; y: number } | null = null;
  let sentPosition = "";
  let motion = { dx: 0, dy: 0 };
  let frame: number | null = null;

  const scale = () => {
    const rect = canvas.getBoundingClientRect();
    return { rect, x: canvas.width / (rect.width || 1), y: canvas.height / (rect.height || 1) };
  };

  const flush = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    const at = position === null ? sentPosition : `${position.x},${position.y}`;
    if (position !== null && at !== sentPosition) send({ type: "pointer", ...position });
    sentPosition = at;
    if (motion.dx !== 0 || motion.dy !== 0) send({ type: "pointerMotion", ...motion });
    position = null;
    motion = { dx: 0, dy: 0 };
  };
  // A fast mouse moves far more often than frames are shown; one message a frame is enough.
  const schedule = () => {
    frame ??= requestAnimationFrame(flush);
  };

  const sendKey = (code: number, pressed: boolean) => {
    if (heldKeys.has(code) === pressed) return;
    if (pressed) heldKeys.add(code);
    else heldKeys.delete(code);
    send({ type: "key", code, pressed });
  };

  const onKey = (event: KeyboardEvent) => {
    const code = evdevKeyCode(event.code);
    // Blender repeats held keys itself.
    if (code === null || event.repeat) return;
    if (event.type === "keydown") {
      const keymap = options.keymap();
      const serialized = `${keymap.layout}(${keymap.variant})`;
      if (serialized !== sentKeymap) {
        sentKeymap = serialized;
        send({ type: "keymap", ...keymap });
      }
    }
    sendKey(code, event.type === "keydown");
  };

  // Chorded presses and releases arrive as pointermove, so the `buttons` bitmask decides.
  // A press must be seen starting: a button already down when control arrived (the click
  // that took it) is never pressed in Blender. `null` until the first event sets a baseline.
  let lastButtons: number | null = null;
  const syncButtons = (buttons: number, started = 0) => {
    const before = (lastButtons ?? buttons) & ~started;
    lastButtons = buttons;
    const changes = BUTTON_BITS.filter(([bit, button]) =>
      heldButtons.has(button) ? (buttons & bit) === 0 : (buttons & bit & ~before) !== 0,
    );
    if (changes.length === 0) return;
    // Motion waiting for the next frame happened first; a release must not overtake it.
    flush();
    for (const [, button] of changes) {
      const pressed = !heldButtons.has(button);
      if (pressed) heldButtons.add(button);
      else heldButtons.delete(button);
      send({ type: "button", button, pressed });
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    const { rect, x, y } = scale();
    if (captured) {
      motion = { dx: motion.dx + event.movementX * x, dy: motion.dy + event.movementY * y };
    } else {
      position = {
        x: Math.min(Math.max((event.clientX - rect.left) * x, 0), Math.max(canvas.width - 1, 0)),
        y: Math.min(Math.max((event.clientY - rect.top) * y, 0), Math.max(canvas.height - 1, 0)),
      };
    }
    schedule();
    syncButtons(
      event.buttons,
      event.type === "pointerdown" ? (BUTTON_FOR_INDEX[event.button] ?? 0) : 0,
    );
  };

  const onPointerDown = (event: PointerEvent) => {
    onPointerMove(event);
    // Keeps a drag's moves coming once it leaves the pane.
    if (!captured && surface.hasPointerCapture?.(event.pointerId) === false) {
      try {
        surface.setPointerCapture(event.pointerId);
      } catch {}
    }
  };

  const onPointerCancel = () => syncButtons(0);

  // Middle-click starts autoscroll on press and pastes the primary selection on click.
  const suppressMiddle = (event: MouseEvent) => {
    if (event.button === MIDDLE_BUTTON) event.preventDefault();
  };
  const suppress = (event: Event) => event.preventDefault();

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const legacy = event as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number };
    const scroll = {
      deltaMode: event.deltaMode,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      ...(legacy.wheelDeltaX === undefined ? {} : { wheelDeltaX: legacy.wheelDeltaX }),
      ...(legacy.wheelDeltaY === undefined ? {} : { wheelDeltaY: legacy.wheelDeltaY }),
    };
    for (const message of scrollInput(
      scroll,
      scrollKind(scroll, options.scrollPreference()),
      scale().y,
    )) {
      send(message);
    }
  };

  const onPointerLockChange = () => {
    if (document.pointerLockElement === canvas) return;
    const ours = unlocking;
    unlocking = false;
    // The browser ends a lock on Esc and never delivers the key; Blender needs it to cancel.
    if (!ours && captured && document.hasFocus()) {
      send({ type: "key", code: EVDEV_KEY_ESCAPE, pressed: true });
      send({ type: "key", code: EVDEV_KEY_ESCAPE, pressed: false });
    }
  };

  const unlock = () => {
    if (document.pointerLockElement !== canvas) return;
    unlocking = true;
    document.exitPointerLock();
  };

  const releaseAll = () => {
    flush();
    for (const code of heldKeys) send({ type: "key", code, pressed: false });
    for (const button of heldButtons) send({ type: "button", button, pressed: false });
    heldKeys.clear();
    heldButtons.clear();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") releaseAll();
  };

  const releaseKeyboard = captureKeyboard(surface, { onKey, passThrough: options.passThrough });
  const listeners: Array<[EventTarget, string, EventListener, AddEventListenerOptions?]> = [
    [surface, "pointermove", onPointerMove as EventListener],
    [surface, "pointerdown", onPointerDown as EventListener],
    [surface, "pointerup", onPointerMove as EventListener],
    [surface, "pointercancel", onPointerCancel],
    [surface, "mousedown", suppressMiddle as EventListener],
    [surface, "auxclick", suppressMiddle as EventListener],
    [surface, "contextmenu", suppress],
    [surface, "wheel", onWheel as EventListener, { passive: false }],
    [surface, "blur", releaseAll],
    [document, "pointerlockchange", onPointerLockChange],
    [document, "visibilitychange", onVisibilityChange],
  ];
  for (const [target, type, listener, listenerOptions] of listeners) {
    target.addEventListener(type, listener, listenerOptions);
  }

  return {
    setCaptured: (next) => {
      if (captured === next) return;
      captured = next;
      position = null;
      sentPosition = "";
      if (!next) return unlock();
      // A lock refused (no recent gesture, or just after the user ended one) leaves relative
      // motion bounded by the screen's edge, which still works.
      void Promise.resolve(canvas.requestPointerLock?.()).catch(() => undefined);
    },
    releaseAll,
    dispose: () => {
      releaseAll();
      captured = false;
      unlock();
      releaseKeyboard();
      for (const [target, type, listener, listenerOptions] of listeners) {
        target.removeEventListener(type, listener, listenerOptions);
      }
    },
  };
}
