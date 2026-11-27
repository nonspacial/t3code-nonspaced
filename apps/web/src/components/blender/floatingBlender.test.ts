import { describe, expect, it } from "vite-plus/test";

import { BLENDER_MINI_PLAYER_SOURCE } from "../../previewMiniPlayerStore";
import {
  decideFloatingBlender,
  type FloatingBlenderInput,
  floatingBlenderAction,
  resetFloatingBlenderDecisionsForTests,
} from "./floatingBlender";

const running = { status: "running", relativePath: "cube.blend", dirty: false } as const;
const working: FloatingBlenderInput = {
  runningTurnId: "turn-1",
  decidedTurnId: null,
  state: running,
  autoShowFloatingPreview: true,
  floating: null,
  panelShown: false,
};

const device = {
  kind: "device",
  hostId: "host",
  deviceId: "phone",
  platform: "ios",
  name: "Phone",
} as const;
const floated = { ...working, floating: BLENDER_MINI_PLAYER_SOURCE, decidedTurnId: "turn-1" };

describe("floatingBlenderAction", () => {
  it.each([
    {
      label: "floats over a running Blender",
      input: working,
      expected: { action: "float", decidedTurnId: "turn-1" },
    },
    {
      label: "floats over a starting Blender",
      input: { ...working, state: { ...running, status: "starting" } },
      expected: { action: "float", decidedTurnId: "turn-1" },
    },
    {
      label: "stays closed for the rest of a turn the user closed it in",
      input: { ...working, decidedTurnId: "turn-1" },
      expected: { action: "none" },
    },
    {
      label: "floats again on the next turn",
      input: { ...working, decidedTurnId: "turn-1", runningTurnId: "turn-2" },
      expected: { action: "float", decidedTurnId: "turn-2" },
    },
    {
      label: "waits for a turn",
      input: { ...working, runningTurnId: null },
      expected: { action: "none", decidedTurnId: null },
    },
    {
      label: "waits for Blender's state",
      input: { ...working, state: null },
      expected: { decidedTurnId: null },
    },
    {
      label: "waits for Blender to be up",
      input: { ...working, state: { status: "stopped" } },
      expected: { decidedTurnId: null },
    },
    {
      label: "leaves it to the user when auto-show is off",
      input: { ...working, autoShowFloatingPreview: false },
      expected: { action: "none", decidedTurnId: "turn-1" },
    },
    {
      label: "leaves it to the user when the pane is shown",
      input: { ...working, panelShown: true },
      expected: { action: "none", decidedTurnId: "turn-1" },
    },
    {
      label: "leaves it to the user when something else floats",
      input: { ...working, floating: device },
      expected: { action: "none", decidedTurnId: "turn-1" },
    },
    {
      label: "closes a float whose Blender stopped",
      input: { ...floated, state: { status: "stopped" } },
      expected: { action: "close" },
    },
    {
      label: "closes a float whose Blender failed",
      input: { ...floated, state: { status: "failed" } },
      expected: { action: "close" },
    },
    {
      label: "keeps a float between turns",
      input: { ...floated, runningTurnId: null },
      expected: { action: "none" },
    },
    {
      label: "keeps a float while the state is unknown",
      input: { ...floated, state: null },
      expected: { action: "none" },
    },
  ] satisfies ReadonlyArray<{ label: string; input: FloatingBlenderInput; expected: object }>)(
    "$label",
    ({ input, expected }) => {
      expect(floatingBlenderAction(input)).toMatchObject(expected);
    },
  );
});

describe("decideFloatingBlender", () => {
  const { decidedTurnId: _decided, ...inThread } = working;

  it("remembers each thread's dismissal across visits to other threads", () => {
    resetFloatingBlenderDecisionsForTests();
    expect(decideFloatingBlender("thread-a", inThread)).toBe("float");
    // Thread B's own turn floats there...
    expect(decideFloatingBlender("thread-b", { ...inThread, runningTurnId: "turn-b" })).toBe(
      "float",
    );
    // ...and coming back to A, whose float the user closed, during the same turn leaves it closed.
    expect(decideFloatingBlender("thread-a", inThread)).toBe("none");
    expect(decideFloatingBlender("thread-a", { ...inThread, runningTurnId: "turn-2" })).toBe(
      "float",
    );

    expect(
      decideFloatingBlender("thread-c", { ...inThread, autoShowFloatingPreview: null }),
      "nothing is decided until the saved settings load",
    ).toBe("none");
    // Once they load with auto-show off, the turn is decided without floating.
    expect(decideFloatingBlender("thread-c", { ...inThread, autoShowFloatingPreview: false })).toBe(
      "none",
    );
    expect(decideFloatingBlender("thread-c", inThread), "decided once settings load").toBe("none");
  });
});
