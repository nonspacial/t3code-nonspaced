import { describe, expect, it } from "vite-plus/test";

import { BLENDER_MINI_PLAYER_SOURCE } from "../../previewMiniPlayerStore";
import {
  decideFloatingBlender,
  type FloatingBlenderInput,
  floatingBlenderAction,
  resetFloatingBlenderDecisionsForTests,
} from "./floatingBlender";

const running = {
  status: "running",
  relativePath: "cube.blend",
  dirty: false,
  agentActing: true,
} as const;
const working: FloatingBlenderInput = {
  runningTurnId: "turn-1",
  decidedTurnId: null,
  state: running,
  autoShowFloatingPreview: true,
  floating: null,
  panelShown: false,
};

describe("floatingBlenderAction", () => {
  it("floats the pane once per turn while the agent works in a running Blender", () => {
    expect(floatingBlenderAction(working)).toEqual({ action: "float", decidedTurnId: "turn-1" });
    expect(
      floatingBlenderAction({ ...working, state: { ...running, status: "starting" } }),
    ).toEqual({ action: "float", decidedTurnId: "turn-1" });
    // Closed by the user during the same turn: it stays closed until the next one.
    expect(floatingBlenderAction({ ...working, decidedTurnId: "turn-1" }).action).toBe("none");
    expect(
      floatingBlenderAction({ ...working, decidedTurnId: "turn-1", runningTurnId: "turn-2" }),
    ).toEqual({ action: "float", decidedTurnId: "turn-2" });
  });

  it("waits, undecided, for the agent to act in Blender, not just for any turn", () => {
    const idle = { ...running, agentActing: false };
    expect(floatingBlenderAction({ ...working, state: idle })).toEqual({
      action: "none",
      decidedTurnId: null,
    });
    const { agentActing: _acting, ...unreported } = running;
    expect(floatingBlenderAction({ ...working, state: unreported }).decidedTurnId).toBeNull();
  });

  it("waits for both a turn and a Blender", () => {
    expect(floatingBlenderAction({ ...working, runningTurnId: null })).toEqual({
      action: "none",
      decidedTurnId: null,
    });
    // The state isn't known yet, or Blender isn't up: the turn is still undecided.
    expect(floatingBlenderAction({ ...working, state: null }).decidedTurnId).toBeNull();
    expect(floatingBlenderAction({ ...working, state: { status: "stopped" } }).decidedTurnId).toBe(
      null,
    );
  });

  it("leaves it to the user when auto-show is off, the pane is shown, or something floats", () => {
    const device = {
      kind: "device",
      hostId: "host",
      deviceId: "phone",
      platform: "ios",
      name: "Phone",
    } as const;
    for (const input of [
      { ...working, autoShowFloatingPreview: false },
      { ...working, panelShown: true },
      { ...working, floating: device },
    ]) {
      expect(floatingBlenderAction(input)).toEqual({ action: "none", decidedTurnId: "turn-1" });
    }
  });

  it("closes a floating pane whose Blender stopped", () => {
    const floating = { ...working, floating: BLENDER_MINI_PLAYER_SOURCE, decidedTurnId: "turn-1" };
    expect(floatingBlenderAction({ ...floating, state: { status: "stopped" } }).action).toBe(
      "close",
    );
    expect(floatingBlenderAction({ ...floating, state: { status: "failed" } }).action).toBe(
      "close",
    );
    expect(floatingBlenderAction({ ...floating, runningTurnId: null }).action).toBe("none");
    expect(floatingBlenderAction({ ...floating, state: null }).action).toBe("none");
  });
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
  });

  it("decides nothing until the saved settings have loaded", () => {
    resetFloatingBlenderDecisionsForTests();
    expect(decideFloatingBlender("thread-a", { ...inThread, autoShowFloatingPreview: null })).toBe(
      "none",
    );
    // Once they load with auto-show off, the turn is decided without floating.
    expect(decideFloatingBlender("thread-a", { ...inThread, autoShowFloatingPreview: false })).toBe(
      "none",
    );
    expect(decideFloatingBlender("thread-a", inThread)).toBe("none");
  });
});
