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

type Fixture = ReturnType<typeof gestures>;
const scroll = (steps: number) =>
  ({ type: "scroll", axis: "vertical", source: "wheel", value: 15 * steps, steps }) as const;
const scrolls = (sent: Fixture["sent"]) => sent.filter((message) => message.type === "scroll");
const twoFingers = ({ touch }: Fixture) => {
  touch.down(1, { x: 100, y: 100 });
  touch.down(2, { x: 200, y: 100 });
};
// The first finger's move alone changes the fingers' distance before the second's arrives.
const parallelDrag = ({ touch }: Fixture) => {
  for (let step = 1; step <= 3; step++) {
    touch.move(1, { x: 100 + step * 16, y: 100 });
    touch.move(2, { x: 200 + step * 16, y: 100 });
  }
};

describe("hosted Blender touch gestures", () => {
  it.each<[string, (fixture: Fixture, setSlop: (slop: number) => void) => void]>([
    [
      "orbits with a one-finger drag as a middle-button drag",
      ({ sent, touch }) => {
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
      },
    ],
    [
      "orbits in relative motion while Blender holds the mouse",
      ({ sent, touch }) => {
        touch.down(1, { x: 100, y: 100 });
        touch.move(1, { x: 120, y: 100 });
        touch.setCaptured(true);
        touch.move(1, { x: 150, y: 90 });
        expect(sent.at(-1)).toEqual({ type: "pointerMotion", dx: 30, dy: -10 });
      },
    ],
    [
      "orbits only once a drag passes the slop at the stream's current scale",
      ({ sent, touch }, setSlop) => {
        setSlop(30);
        touch.down(1, { x: 100, y: 100 });
        touch.move(1, { x: 120, y: 100 });
        expect(sent).toEqual([]);
        touch.move(1, { x: 140, y: 100 });
        expect(sent[1]).toEqual({ type: "button", button: MIDDLE, pressed: true });
      },
    ],
    [
      "releases a held orbit when disposed",
      ({ sent, touch }) => {
        touch.down(1, { x: 100, y: 100 });
        touch.move(1, { x: 150, y: 100 });
        touch.dispose();
        expect(sent.at(-1)).toEqual({ type: "button", button: MIDDLE, pressed: false });
      },
    ],
    [
      "zooms on a pinch made by one finger around a still one",
      (fixture) => {
        twoFingers(fixture);
        fixture.touch.move(1, { x: 80, y: 100 });
        expect(fixture.sent).toEqual([]);
        fixture.touch.move(1, { x: 40, y: 100 });
        expect(scrolls(fixture.sent)).toEqual([scroll(-1), scroll(-1), scroll(-1)]);
      },
    ],
    [
      "zooms on a pinch whose midpoint drifts, rather than panning",
      (fixture) => {
        twoFingers(fixture);
        // The fingers spread 32 px while their midpoint drifts 20 px down.
        fixture.touch.move(1, { x: 84, y: 120 });
        fixture.touch.move(2, { x: 216, y: 120 });
        expect(fixture.sent.some((message) => message.type === "key")).toBe(false);
        expect(scrolls(fixture.sent)).toHaveLength(1);
      },
    ],
    [
      "zooms on a small pinch made by one finger once the other has had time to move",
      (fixture) => {
        twoFingers(fixture);
        // The gap shrinks from 100 px to 69 px; the moving finger never travels 40 px.
        for (const x of [192, 184, 176, 169]) fixture.touch.move(2, { x, y: 100 });
        expect(fixture.sent).toEqual([]);
        vi.advanceTimersByTime(100);
        expect(fixture.sent).toEqual([{ type: "pointer", x: 150, y: 100 }, scroll(1), scroll(1)]);
      },
    ],
    [
      "zooms in on a pinch apart and out on a pinch together, one wheel notch at a time",
      (fixture) => {
        const { sent, touch } = fixture;
        twoFingers(fixture);
        // Spread to 1.5× apart around the same centre: ln(1.5) / 0.15 ≈ 2.7 notches.
        touch.move(1, { x: 75, y: 100 });
        touch.move(2, { x: 225, y: 100 });
        touch.move(1, { x: 100, y: 100 });
        touch.move(2, { x: 200, y: 100 });
        touch.up(1);
        touch.up(2);
        const notches = scrolls(sent).map((message) => message.steps);
        expect(sent[0]).toEqual({ type: "pointer", x: 150, y: 100 });
        expect(notches.filter((steps) => steps === -1)).toHaveLength(2);
        expect(notches.filter((steps) => steps === 1)).toHaveLength(2);
        expect(sent.some((message) => message.type === "button")).toBe(false);
      },
    ],
  ])("%s", (_gesture, play) => {
    let slop = 10;
    using fixture = gestures(() => slop);
    play(fixture, (next) => {
      slop = next;
    });
  });

  it("left-clicks on a tap, right-clicks on a long press, and clicks nothing for a cancelled tap", () => {
    using fixture = gestures();
    const { sent, touch } = fixture;
    touch.down(1, { x: 40, y: 50 });
    touch.up(1);
    expect(sent, "a tap").toEqual([
      { type: "pointer", x: 40, y: 50 },
      { type: "button", button: LEFT, pressed: true },
      { type: "button", button: LEFT, pressed: false },
    ]);

    sent.length = 0;
    touch.down(1, { x: 40, y: 50 });
    vi.advanceTimersByTime(499);
    expect(sent, "a press not yet long").toEqual([]);
    vi.advanceTimersByTime(1);
    touch.move(1, { x: 140, y: 150 });
    touch.up(1);
    expect(sent, "a long press, and nothing more until the finger lifts").toEqual([
      { type: "pointer", x: 40, y: 50 },
      { type: "button", button: RIGHT, pressed: true },
      { type: "button", button: RIGHT, pressed: false },
    ]);

    sent.length = 0;
    touch.down(1, { x: 10, y: 10 });
    touch.cancel(1);
    vi.advanceTimersByTime(1000);
    expect(sent, "a cancelled tap").toEqual([]);
  });

  it("pans with a two-finger drag as a Shift and middle-button drag, released whole", () => {
    using fixture = gestures();
    const { sent, touch } = fixture;
    twoFingers(fixture);
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

    sent.length = 0;
    twoFingers(fixture);
    parallelDrag(fixture);
    expect(sent.slice(0, 3), "a parallel drag, each finger's move reported apart").toEqual([
      { type: "pointer", x: 150, y: 100 },
      { type: "key", code: SHIFT, pressed: true },
      { type: "button", button: MIDDLE, pressed: true },
    ]);
    expect(sent.at(-1)).toEqual({ type: "pointer", x: 198, y: 100 });
    expect(scrolls(sent), "a parallel drag never zooms").toEqual([]);
    touch.cancel(2);
    expect(sent.slice(-2), "a cancel lets go").toEqual([
      { type: "button", button: MIDDLE, pressed: false },
      { type: "key", code: SHIFT, pressed: false },
    ]);
    touch.move(1, { x: 300, y: 300 });
    expect(sent.at(-1), "nothing after the cancel").toEqual({
      type: "key",
      code: SHIFT,
      pressed: false,
    });
    touch.up(1);

    sent.length = 0;
    twoFingers(fixture);
    touch.move(2, { x: 180, y: 100 });
    touch.move(2, { x: 200, y: 100 });
    vi.advanceTimersByTime(100);
    parallelDrag(fixture);
    expect(scrolls(sent), "a one-finger pinch back to its starting gap is forgotten").toEqual([]);
    expect(sent).toContainEqual({ type: "key", code: SHIFT, pressed: true });
  });
});
