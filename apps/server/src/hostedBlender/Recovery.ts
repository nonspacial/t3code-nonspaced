/** How a hosted Blender's run ended, which decides what its thread shows next. */
export type Ending = "closed" | "crashed" | "stopped" | "failed";

export interface BlenderExit {
  readonly code: number | null;
  readonly signal: number | null;
}

/**
 * `ending` is T3 quitting it for its thread or a shutdown, which keeps a recovery copy;
 * `quitting` is any quit T3 asked for. Anything else that ends a running Blender, short of
 * Blender exiting cleanly from its own File menu, is a crash.
 */
export const endingOf = (run: {
  readonly wasRunning: boolean;
  readonly ending: boolean;
  readonly quitting: boolean;
  readonly blenderExit: BlenderExit | null;
}): Ending => {
  if (run.ending) return "closed";
  if (run.quitting) return "stopped";
  if (!run.wasRunning) return "failed";
  const exit = run.blenderExit;
  return exit !== null && exit.signal === null && exit.code === 0 ? "stopped" : "crashed";
};

/** The file a recovery copy is of. A thread keeps at most one copy per file. */
export type KeptFile =
  | { readonly kind: "workspace"; readonly relativePath: string }
  | { readonly kind: "outside"; readonly path: string }
  | { readonly kind: "untitled" };

export const fileKeyOf = (file: KeptFile): string =>
  file.kind === "workspace"
    ? `workspace:${file.relativePath}`
    : file.kind === "outside"
      ? `outside:${file.path}`
      : "untitled";

/** The file a path Blender reports is, under the workspace's real root. */
export const keptFileOf = (
  filepath: string,
  workspaceRoot: string,
  relative: (from: string, to: string) => string,
): KeptFile => {
  if (filepath === "") return { kind: "untitled" };
  const inside = relative(workspaceRoot, filepath);
  return inside === "" || inside.startsWith("../") || inside === ".." || inside.startsWith("/")
    ? { kind: "outside", path: filepath }
    : { kind: "workspace", relativePath: inside };
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Blender's snapshot of the file it ended on: its quit copy, or an autosave named for that file
 * (`<stem>_<pid>_autosave.blend`, `<pid>_autosave.blend` untitled) since it opened it.
 */
export const snapshotOf = (
  files: ReadonlyArray<{ readonly name: string; readonly mtimeMs: number }>,
  file: { readonly stem: string | null; readonly since: number },
): string | undefined => {
  const autosave =
    file.stem === null
      ? /^\d+_autosave\.blend$/
      : new RegExp(`^${escapeRegExp(file.stem)}_\\d+_autosave\\.blend$`);
  const newest = files
    .filter(
      (entry) =>
        entry.mtimeMs >= 0 &&
        (entry.name === "quit.blend" || (autosave.test(entry.name) && entry.mtimeMs >= file.since)),
    )
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return newest?.name;
};

export type RestoreState = "none" | "pending" | "ok" | "failed";

/**
 * What a run's end does, to the copy of the file it ended on and to no other file's: keep its
 * snapshot, forget the copy after a confirmed save of that file, or leave things as they are.
 */
export type Cleanup =
  | { readonly action: "keep"; readonly kind: "closed" | "crashed" }
  | { readonly action: "forget" }
  | { readonly action: "leave" };

export const cleanupOf = (run: {
  readonly restore: RestoreState;
  /** A confirmed save of the file it ended on was its last word on that file. */
  readonly saved: boolean;
  readonly ending: Ending;
  /** Blender's last report for that file, before it began quitting, was clean. */
  readonly clean: boolean;
}): Cleanup => {
  // A restore that never succeeded had the saved file open, never the copy's work.
  if (run.restore === "pending" || run.restore === "failed") return { action: "leave" };
  if (run.saved) return { action: "forget" };
  // Quit by the person, or by Blender's own File menu: nothing more to keep, and nothing to
  // remove but by Discard.
  if (run.ending === "stopped" || run.ending === "failed") return { action: "leave" };
  // Closed clean: nothing new is kept, and a waiting copy of the file stays as it was. Every
  // agent call marks the file unsaved, so what this gives up is a person's own script that
  // bypasses undo. A crash keeps an autosave of the file newer than its opening, if any.
  if (run.clean && run.ending === "closed") return { action: "leave" };
  return { action: "keep", kind: run.ending };
};
