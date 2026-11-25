import { describe, expect, it } from "@effect/vitest";

import { cleanupOf, endingOf, keptFileOf, snapshotOf } from "./Recovery.ts";

describe("snapshotOf", () => {
  const hero = { stem: "hero", since: 0 };

  it("keeps the newest of Blender's quit copy and the file's autosaves", () => {
    expect(
      snapshotOf(
        [
          { name: "hero_101_autosave.blend", mtimeMs: 10 },
          { name: "quit.blend", mtimeMs: 30 },
          { name: "hero_102_autosave.blend", mtimeMs: 20 },
        ],
        hero,
      ),
    ).toBe("quit.blend");
    expect(
      snapshotOf(
        [
          { name: "hero_101_autosave.blend", mtimeMs: 10 },
          { name: "hero_102_autosave.blend", mtimeMs: 20 },
          { name: "hero.crash.txt", mtimeMs: 40 },
          { name: "blender_x1y2", mtimeMs: 50 },
        ],
        hero,
      ),
    ).toBe("hero_102_autosave.blend");
  });

  it("never takes another file's autosave, or one from before the file was opened", () => {
    const files = [
      { name: "cube_101_autosave.blend", mtimeMs: 30 },
      { name: "hero_101_autosave.blend", mtimeMs: 10 },
      { name: "101_autosave.blend", mtimeMs: 40 },
    ];
    expect(snapshotOf(files, hero)).toBe("hero_101_autosave.blend");
    expect(snapshotOf(files, { stem: "hero", since: 20 })).toBeUndefined();
    expect(snapshotOf(files, { stem: null, since: 0 })).toBe("101_autosave.blend");
    // A stem is matched as text, never as a pattern.
    expect(
      snapshotOf([{ name: "h_r_101_autosave.blend", mtimeMs: 1 }], { stem: "h.r", since: 0 }),
    ).toBeUndefined();
  });
});

describe("keptFileOf", () => {
  // As path.relative answers for these.
  const relative = (from: string, to: string) =>
    to === from ? "" : to.startsWith(`${from}/`) ? to.slice(from.length + 1) : `..${to}`;

  it("names a file by its place in the workspace, outside it, or as untitled", () => {
    expect(keptFileOf("/work/models/a.blend", "/work", relative)).toEqual({
      kind: "workspace",
      relativePath: "models/a.blend",
    });
    expect(keptFileOf("/elsewhere/a.blend", "/work", relative)).toEqual({
      kind: "outside",
      path: "/elsewhere/a.blend",
    });
    expect(keptFileOf("/work-other/a.blend", "/work", relative)).toMatchObject({ kind: "outside" });
    expect(keptFileOf("", "/work", relative)).toEqual({ kind: "untitled" });
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
  const run = { restore: "none", saved: false, ending: "closed", clean: false } as const;

  it("keeps a closed or crashed run's snapshot of the file it ended on", () => {
    expect(cleanupOf(run)).toEqual({ action: "keep", kind: "closed" });
    expect(cleanupOf({ ...run, ending: "crashed" })).toEqual({ action: "keep", kind: "crashed" });
    expect(cleanupOf({ ...run, restore: "ok" })).toEqual({ action: "keep", kind: "closed" });
  });

  it("forgets the file's copy once its last word was a confirmed save", () => {
    expect(cleanupOf({ ...run, saved: true })).toEqual({ action: "forget" });
    expect(cleanupOf({ ...run, ending: "crashed", saved: true })).toEqual({ action: "forget" });
  });

  it("keeps nothing new for a file Blender last reported clean, but a crash's autosave", () => {
    expect(cleanupOf({ ...run, clean: true })).toEqual({ action: "leave" });
    expect(cleanupOf({ ...run, clean: true, restore: "ok" })).toEqual({ action: "leave" });
    expect(cleanupOf({ ...run, clean: true, ending: "crashed" })).toEqual({
      action: "keep",
      kind: "crashed",
    });
    expect(cleanupOf({ ...run, clean: true, saved: true })).toEqual({ action: "forget" });
  });

  it("leaves every copy alone after a quit, a failed start, or a restore that never succeeded", () => {
    expect(cleanupOf({ ...run, ending: "stopped" })).toEqual({ action: "leave" });
    expect(cleanupOf({ ...run, ending: "failed" })).toEqual({ action: "leave" });
    expect(cleanupOf({ ...run, restore: "failed" })).toEqual({ action: "leave" });
    expect(cleanupOf({ ...run, restore: "pending", ending: "crashed" })).toEqual({
      action: "leave",
    });
  });
});
