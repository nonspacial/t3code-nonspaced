import type { HostedBlenderInputMessage } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createHostedBlenderTouch } from "./touch.ts";

const LEFT = 272;
const RIGHT = 273;
const MIDDLE = 274;
const SHIFT = 42;

function gestures(slop: () => number = () => 10) {
  vi.useFakeTimers();
  const sent: HostedBlenderInputMessage[] = [];
  const touch = createHostedBlenderTouch({ send: (message) => sent.push(message), slop });
  return { sent, touch, [Symbol.dispose]: () => vi.useRealTimers() };
}

describe("hosted Blender touch gestures", () => {
  it("orbits with a one-finger drag as a middle-button drag", () => {
    using fixture = gestures();
    const { sent, touch } = fixture;
    touch.down(1, { x: 100, y: 100 });
    touch.move(1, { x: 104, y: 100 });
    expect(sent).toEqual([]);
    touch.move(1, { x: 130, y: 110 });
    touch.up(1);
    expect(sent).toEqual([
      { type: "pointer", x: 100, y: 100 },
      { type: "button", button: MIDDLE, pressed: true },
      { type: "pointer", x: 130, y: 110 },
      { type: "button", button: MIDDLE, pressed: false },
    ]);
  });

  it("sends relative motion while Blender holds the mouse", () => {
    using fixture = gestures();
    const { sent, touch } = fixture;
    touch.down(1, { x: 100, y: 100 });
    touch.move(1, { x: 120, y: 100 });
    touch.setCaptured(true);
    touch.move(1, { x: 150, y: 90 });
    expect(sent.at(-1)).toEqual({ type: "pointerMotion", dx: 30, dy: -10 });
  });

  it("judges a drag by the stream's current scale", () => {
    let slop = 10;
    using fixture = gestures(() => slop);
    const { sent, touch } = fixture;
    slop = 30;
    touch.down(1, { x: 100, y: 100 });
    touch.move(1, { x: 120, y: 100 });
    expect(sent).toEqual([]);
    touch.move(1, { x: 140, y: 100 });
    expect(sent[1]).toEqual({ type: "button", button: MIDDLE, pressed: true });
  });

  it("left-clicks on a tap", () => {
    using fixture = gestures();
    const { sent, touch } = fixture;
    touch.down(1, { x: 40, y: 50 });
    touch.up(1);
    expect(sent).toEqual([
      { type: "pointer", x: 40, y: 50 },
      { type: "button", button: LEFT, pressed: true },
      { type: "button", button: LEFT, pressed: false },
    ]);
  });

  it("right-clicks on a long press, and nothing more until the finger lifts", () => {
    using fixture = gestures();
    const { sent, touch } = fixture;
    touch.down(1, { x: 40, y: 50 });
    vi.advanceTimersByTime(499);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    touch.move(1, { x: 140, y: 150 });
    touch.up(1);
    expect(sent).toEqual([
      { type: "pointer", x: 40, y: 50 },
      { type: "button", button: RIGHT, pressed: true },
      { type: "button", button: RIGHT, pressed: false },
    ]);
  });

  it("pans with a two-finger drag as a Shift and middle-button drag", () => {
    using fixture = gestures();
    const { sent, touch } = fixture;
    touch.down(1, { x: 100, y: 100 });
    touch.down(2, { x: 200, y: 100 });
    touch.move(1, { x: 120, y: 130 });
    touch.move(2, { x: 220, y: 130 });
    touch.up(1);
    touch.up(2);
    expect(sent).toEqual([
      { type: "pointer", x: 150, y: 100 },
      { type: "key", code: SHIFT, pressed: true },
      { type: "button", button: MIDDLE, pressed: true },
      { type: "pointer", x: 170, y: 130 },
      { type: "button", button: MIDDLE, pressed: false },
      { type: "key", code: SHIFT, pressed: false },
    ]);
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(6);
  });

  it("pans a parallel drag even though each finger reports its move separately", () => {
    using fixture = gestures();
    const { sent, touch } = fixture;
    touch.down(1, { x: 100, y: 100 });
    touch.down(2, { x: 200, y: 100 });
    // The first finger's move alone changes the fingers' distance before the second's arrives.
    for (let step = 1; step <= 3; step++) {
      touch.move(1, { x: 100 + step * 16, y: 100 });
      touch.move(2, { x: 200 + step * 16, y: 100 });
    }
    expect(sent.slice(0, 3)).toEqual([
      { type: "pointer", x: 150, y: 100 },
      { type: "key", code: SHIFT, pressed: true },
      { type: "button", button: MIDDLE, pressed: true },
    ]);
    expect(sent.at(-1)).toEqual({ type: "pointer", x: 198, y: 100 });
    expect(sent.some((message) => message.type === "scroll")).toBe(false);
  });

  it("zooms on a pinch made by one finger around a still one", () => {
    using fixture = gestures();
    const { sent, touch } = fixture;
    touch.down(1, { x: 100, y: 100 });
    touch.down(2, { x: 200, y: 100 });
    touch.move(1, { x: 80, y: 100 });
    expect(sent).toEqual([]);
    touch.move(1, { x: 40, y: 100 });
    expect(sent.filter((message) => message.type === "scroll")).toEqual([
      { type: "scroll", axis: "vertical", source: "wheel", value: -15, steps: -1 },
      { type: "scroll", axis: "vertical", source: "wheel", value: -15, steps: -1 },
      { type: "scroll", axis: "vertical", source: "wheel", value: -15, steps: -1 },
    ]);
  });

  it("zooms in on a pinch apart and out on a pinch together, one wheel notch at a time", () => {
    using fixture = gestures();
    const { sent, touch } = fixture;
    touch.down(1, { x: 100, y: 100 });
    touch.down(2, { x: 200, y: 100 });
    // Spread to 1.5× apart around the same centre: ln(1.5) / 0.15 ≈ 2.7 notches.
    touch.move(1, { x: 75, y: 100 });
    touch.move(2, { x: 225, y: 100 });
    touch.move(1, { x: 100, y: 100 });
    touch.move(2, { x: 200, y: 100 });
    touch.up(1);
    touch.up(2);
    const notches = sent.flatMap((message) => (message.type === "scroll" ? [message.steps] : []));
    expect(sent[0]).toEqual({ type: "pointer", x: 150, y: 100 });
    expect(notches.filter((steps) => steps === -1)).toHaveLength(2);
    expect(notches.filter((steps) => steps === 1)).toHaveLength(2);
    expect(sent.some((message) => message.type === "button")).toBe(false);
  });

  it("lets go of a two-finger drag when the third finger or a cancel lands", () => {
    using fixture = gestures();
    const { sent, touch } = fixture;
    touch.down(1, { x: 100, y: 100 });
    touch.down(2, { x: 200, y: 100 });
    touch.move(1, { x: 120, y: 130 });
    touch.move(2, { x: 220, y: 130 });
    touch.cancel(2);
    expect(sent.slice(-2)).toEqual([
      { type: "button", button: MIDDLE, pressed: false },
      { type: "key", code: SHIFT, pressed: false },
    ]);
    touch.move(1, { x: 300, y: 300 });
    expect(sent.at(-1)).toEqual({ type: "key", code: SHIFT, pressed: false });
  });

  it("releases a held orbit when disposed, and a cancelled tap clicks nothing", () => {
    using fixture = gestures();
    const { sent, touch } = fixture;
    touch.down(1, { x: 100, y: 100 });
    touch.move(1, { x: 150, y: 100 });
    touch.dispose();
    expect(sent.at(-1)).toEqual({ type: "button", button: MIDDLE, pressed: false });
    using other = gestures();
    other.touch.down(1, { x: 10, y: 10 });
    other.touch.cancel(1);
    vi.advanceTimersByTime(1000);
    expect(other.sent).toEqual([]);
  });
});
