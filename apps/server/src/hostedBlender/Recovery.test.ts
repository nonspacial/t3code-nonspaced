import { describe, expect, it } from "@effect/vitest";

import { cleanupOf, endingOf, newestSession } from "./Recovery.ts";

describe("newestSession", () => {
  it("keeps the newest of Blender's quit copy and its autosaves", () => {
    expect(
      newestSession([
        { name: "hero_101_autosave.blend", mtimeMs: 10 },
        { name: "quit.blend", mtimeMs: 30 },
        { name: "hero_102_autosave.blend", mtimeMs: 20 },
      ]),
    ).toBe("quit.blend");
    expect(
      newestSession([
        { name: "hero_101_autosave.blend", mtimeMs: 10 },
        { name: "hero_102_autosave.blend", mtimeMs: 20 },
        { name: "hero.crash.txt", mtimeMs: 40 },
      ]),
    ).toBe("hero_102_autosave.blend");
  });

  it("ignores everything else Blender leaves in its temporary folder", () => {
    expect(
      newestSession([
        { name: "hero.crash.txt", mtimeMs: 40 },
        { name: "blender_x1y2", mtimeMs: 50 },
      ]),
    ).toBeUndefined();
  });
});

describe("endingOf", () => {
  const running = { wasRunning: true, ending: false, quitting: false, blenderExit: null };

  it("closes a Blender T3 ended for its thread or a shutdown", () => {
    expect(endingOf({ ...running, ending: true, quitting: true })).toBe("closed");
    // Even one that died while T3 was ending it: its recovery copy is still kept.
    expect(
      endingOf({
        ...running,
        ending: true,
        quitting: true,
        blenderExit: { code: null, signal: 9 },
      }),
    ).toBe("closed");
  });

  it("stops a Blender someone quit", () => {
    expect(endingOf({ ...running, quitting: true })).toBe("stopped");
    // Quitting from Blender's own File menu exits cleanly.
    expect(endingOf({ ...running, blenderExit: { code: 0, signal: null } })).toBe("stopped");
  });

  it("treats any other end of a running Blender as a crash", () => {
    expect(endingOf({ ...running, blenderExit: { code: null, signal: 11 } })).toBe("crashed");
    expect(endingOf({ ...running, blenderExit: { code: 1, signal: null } })).toBe("crashed");
    // The helper or labwc died, taking Blender with it.
    expect(endingOf(running)).toBe("crashed");
  });

  it("reports a start that never showed Blender as failed", () => {
    expect(endingOf({ ...running, wasRunning: false })).toBe("failed");
    expect(endingOf({ ...running, wasRunning: false, quitting: true })).toBe("stopped");
    expect(endingOf({ ...running, wasRunning: false, ending: true, quitting: true })).toBe(
      "closed",
    );
  });
});

describe("cleanupOf", () => {
  const run = { restore: "none", saved: false, changed: true, ending: "closed" } as const;

  it("keeps a closed or crashed run's copy, or the waiting one if the run changed nothing", () => {
    expect(cleanupOf(run)).toEqual({ action: "keep", kind: "closed", unchanged: false });
    expect(cleanupOf({ ...run, ending: "crashed", changed: false })).toEqual({
      action: "keep",
      kind: "crashed",
      unchanged: true,
    });
  });

  it("clears what's waiting once the run saved, or someone quit it", () => {
    expect(cleanupOf({ ...run, saved: true })).toEqual({ action: "forget" });
    expect(cleanupOf({ ...run, ending: "crashed", saved: true })).toEqual({ action: "forget" });
    expect(cleanupOf({ ...run, ending: "stopped" })).toEqual({ action: "forget" });
  });

  it("leaves the waiting copy alone after a restore that never succeeded, or a failed start", () => {
    expect(cleanupOf({ ...run, restore: "failed" })).toEqual({ action: "leave" });
    expect(cleanupOf({ ...run, restore: "pending", ending: "crashed" })).toEqual({
      action: "leave",
    });
    expect(cleanupOf({ ...run, restore: "ok" })).toMatchObject({ action: "keep" });
    expect(cleanupOf({ ...run, ending: "failed" })).toEqual({ action: "leave" });
  });
});
