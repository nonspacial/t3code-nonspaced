import { expect, it } from "@effect/vitest";

import { HeldInput } from "./HeldInput.ts";

it("passes presses once, drops repeats and stray releases, and releases what is held", () => {
  const held = new HeldInput();
  const sent = [
    { type: "key", code: 42, pressed: true },
    { type: "key", code: 42, pressed: true },
    { type: "key", code: 30, pressed: true },
    { type: "key", code: 30, pressed: false },
    { type: "key", code: 30, pressed: false },
    { type: "pointerButton", button: 274, pressed: true },
    { type: "pointerMotion", dx: 4, dy: 0 },
  ] as const;
  expect(sent.map((command) => held.note(command))).toEqual([
    true,
    false,
    true,
    true,
    false,
    true,
    true,
  ]);
  expect(held.releaseAll()).toEqual([
    { type: "key", code: 42, pressed: false },
    { type: "pointerButton", button: 274, pressed: false },
  ]);
  expect(held.releaseAll()).toEqual([]);
});
