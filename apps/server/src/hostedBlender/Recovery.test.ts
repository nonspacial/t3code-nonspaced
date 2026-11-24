import { describe, expect, it } from "@effect/vitest";

import { endingOf, newestSession } from "./Recovery.ts";

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
