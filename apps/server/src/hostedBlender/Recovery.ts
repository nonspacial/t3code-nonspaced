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

// Blender writes `quit.blend` when it quits and `<name>_<pid>_autosave.blend` (or
// `<pid>_autosave.blend` for an unsaved file) on its autosave timer, both to its TMPDIR. Both
// keep the original file's path, so recovering one saves back to the user's file.
const SESSION_FILE = /^(quit|.*_autosave)\.blend$/;

/** The newest copy of the session Blender left in its temporary folder. */
export const newestSession = (
  files: ReadonlyArray<{ readonly name: string; readonly mtimeMs: number }>,
): string | undefined =>
  files.filter((file) => SESSION_FILE.test(file.name)).toSorted((a, b) => b.mtimeMs - a.mtimeMs)[0]
    ?.name;

/**
 * What an ending does once its deadline passes. A Blender that acknowledged its save or quit is
 * still writing, so stopping it could cut the file short: settling waits, and a shutdown leaves
 * it to finish alone.
 */
export const afterDeadline = (input: {
  readonly acknowledged: boolean;
  readonly shutdown: boolean;
}): "wait" | "detach" | "forceQuit" =>
  !input.acknowledged ? "forceQuit" : input.shutdown ? "detach" : "wait";

/** What T3 was doing to a launch it left behind (its `outcome` file), and how that ended. */
export const leftoverEnding = (input: {
  readonly outcome: "closing" | "saving" | null;
  readonly hasQuitCopy: boolean;
}): "closed" | "crashed" | "saved" => {
  if (input.outcome === "closing") return "closed";
  if (input.outcome === "saving" && input.hasQuitCopy) return "saved";
  return "crashed";
};
