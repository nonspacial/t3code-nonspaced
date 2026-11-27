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

  it.each([
    [
      "T3 ended it for its thread or a shutdown",
      { ...running, ending: true, quitting: true },
      "closed",
    ],
    [
      // Its recovery copy is still kept.
      "T3 was ending it when it died",
      { ...running, ending: true, quitting: true, blenderExit: { code: null, signal: 9 } },
      "closed",
    ],
    ["someone quit it", { ...running, quitting: true }, "stopped"],
    [
      "File > Quit exited cleanly",
      { ...running, blenderExit: { code: 0, signal: null } },
      "stopped",
    ],
    ["a signal", { ...running, blenderExit: { code: null, signal: 11 } }, "crashed"],
    ["a non-zero exit", { ...running, blenderExit: { code: 1, signal: null } }, "crashed"],
    ["the helper or labwc died, taking Blender with it", running, "crashed"],
    ["a start that never showed Blender", { ...running, wasRunning: false }, "failed"],
    ["a start someone quit", { ...running, wasRunning: false, quitting: true }, "stopped"],
    ["a start T3 ended", { ...running, wasRunning: false, ending: true, quitting: true }, "closed"],
  ] as const)("names how a run ended when %s", (_, run, ending) => {
    expect(endingOf(run)).toBe(ending);
  });
});

describe("cleanupOf", () => {
  const run = { restore: "none", saved: false, ending: "closed", clean: false } as const;
  const keep = (kind: "closed" | "crashed") => ({ action: "keep", kind });

  it.each([
    ["a closed run keeps its snapshot", run, keep("closed")],
    ["a crashed run keeps its snapshot", { ...run, ending: "crashed" }, keep("crashed")],
    ["a run restored from a copy keeps its snapshot", { ...run, restore: "ok" }, keep("closed")],
    [
      "a confirmed save as the last word forgets the copy",
      { ...run, saved: true },
      { action: "forget" },
    ],
    [
      "a confirmed save forgets the copy after a crash too",
      { ...run, ending: "crashed", saved: true },
      { action: "forget" },
    ],
    ["a file last reported clean keeps nothing new", { ...run, clean: true }, { action: "leave" }],
    [
      "a restored file last reported clean keeps nothing new",
      { ...run, clean: true, restore: "ok" },
      { action: "leave" },
    ],
    [
      "a file last reported clean keeps a crash's autosave",
      { ...run, clean: true, ending: "crashed" },
      keep("crashed"),
    ],
    [
      "a clean file's confirmed save forgets the copy",
      { ...run, clean: true, saved: true },
      { action: "forget" },
    ],
    ["a quit leaves every copy alone", { ...run, ending: "stopped" }, { action: "leave" }],
    ["a failed start leaves every copy alone", { ...run, ending: "failed" }, { action: "leave" }],
    [
      "a failed restore leaves every copy alone",
      { ...run, restore: "failed" },
      { action: "leave" },
    ],
    [
      "a restore that never succeeded leaves every copy alone",
      { ...run, restore: "pending", ending: "crashed" },
      { action: "leave" },
    ],
  ] as const)("decides what a run keeps: %s", (_, ended, cleanup) => {
    expect(cleanupOf(ended)).toEqual(cleanup);
  });
});
