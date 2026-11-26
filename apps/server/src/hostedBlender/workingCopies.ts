import { ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Nothing is held longer than this from when it was held, whatever the person answered. */
export const HELD_COPY_LIMIT = Duration.days(30);

// The end of the thread id: fixed prefixes such as `thread-` would make every tag alike.
export const threadTag = (threadId: string) =>
  threadId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-8);

/** `<master name>.wip-<thread>.blend`, beside the master so its relative links still resolve. */
export const workingCopyName = (masterName: string, threadId: string) =>
  `${masterName.replace(/\.blend$/i, "")}.wip-${threadTag(threadId)}.blend`;

/**
 * A working copy T3 made for a thread, kept in T3's state from when `blender_start` makes it.
 * `holding` and `returning` are a move under way: the side that is whole is the one a crash
 * keeps. Held, the copy is `copy.blend` beside this record.
 */
export const WorkingCopyRecord = Schema.Struct({
  threadId: ThreadId,
  /** The master's real path. */
  master: Schema.String,
  /** Where the copy sits in the project, by its real folder: beside the master. */
  path: Schema.String,
  state: Schema.Literals(["live", "holding", "held", "returning"]),
  heldAt: Schema.optional(Schema.Number),
  /** The master's revision as the copy was held, which tells when the master moved on. */
  masterRevision: Schema.optional(Schema.NullOr(Schema.String)),
  bytes: Schema.optional(Schema.Number),
  threadTitle: Schema.optional(Schema.String),
  /** Asked once the master moved on, the person kept it. */
  kept: Schema.optional(Schema.Boolean),
});
export type WorkingCopyRecord = typeof WorkingCopyRecord.Type;
const WorkingCopyRecordJson = Schema.fromJsonString(WorkingCopyRecord);
export const decodeWorkingCopyRecord = Schema.decodeUnknownOption(WorkingCopyRecordJson);
export const encodeWorkingCopyRecord = Schema.encodeSync(WorkingCopyRecordJson);

/**
 * Why the file at a working copy's place isn't provably the copy T3 made, or null when it is:
 * named and placed as that thread's copy of that master, a regular file with no other name (so
 * neither a symlink nor a hard link, the master's included). T3 can't tell a file the person
 * saved under that name from Blender's own save of the copy.
 */
export const notOwnCopy = Effect.fnUntraced(function* (record: WorkingCopyRecord) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    record.path === record.master ||
    record.path !==
      path.join(
        path.dirname(record.master),
        workingCopyName(path.basename(record.master), record.threadId),
      )
  ) {
    return "misplaced" as const;
  }
  const info = yield* fileSystem.lstat(record.path).pipe(Effect.option);
  if (Option.isNone(info)) return "missing" as const;
  if (info.value.type !== "File") return "notAFile" as const;
  if (Option.isNone(info.value.ino) || Option.getOrElse(info.value.nlink, () => 2n) !== 1n) {
    return "linked" as const;
  }
  const master = yield* fileSystem.stat(record.master).pipe(Effect.option);
  if (
    Option.isSome(master) &&
    Option.isSome(master.value.ino) &&
    master.value.dev === info.value.dev &&
    master.value.ino.value === info.value.ino.value
  ) {
    return "linked" as const;
  }
  return null;
});

const sizeAndTime = (fileSystem: FileSystem.FileSystem, file: string) =>
  fileSystem.stat(file).pipe(
    Effect.map((info) => ({
      size: Number(info.size),
      mtime: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
    })),
    Effect.option,
    Effect.map(Option.getOrNull),
  );

/** Written out to the disk, so a rename after it never names half a file after a crash. */
const syncFile = (fileSystem: FileSystem.FileSystem, file: string) =>
  Effect.scoped(fileSystem.open(file, { flag: "r+" }).pipe(Effect.flatMap((open) => open.sync)));

/**
 * Copies a working copy to `held` in T3's state, which may be another drive: through a temporary
 * name, synced, then renamed. False, with nothing left at `held`, when the copy came out a size
 * other than the file's or the file changed meanwhile. The caller removes the original.
 */
export const copyOut = Effect.fnUntraced(function* (from: string, held: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const before = yield* sizeAndTime(fileSystem, from);
  if (before === null) return false;
  const partial = `${held}.partial`;
  yield* fileSystem.copyFile(from, partial);
  yield* syncFile(fileSystem, partial);
  yield* fileSystem.rename(partial, held);
  const after = yield* sizeAndTime(fileSystem, from);
  const copied = yield* sizeAndTime(fileSystem, held);
  if (
    after === null ||
    copied === null ||
    after.size !== before.size ||
    after.mtime !== before.mtime ||
    copied.size !== before.size
  ) {
    yield* fileSystem.remove(held, { force: true });
    return false;
  }
  return true;
});

/**
 * Puts a held copy back at `to`, never over anything there: staged whole beside it, then
 * hard-linked into place, which fails if a file has the name by then.
 */
export const copyBack = Effect.fnUntraced(function* (held: string, to: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const staging = yield* fileSystem.makeTempDirectoryScoped({
        directory: path.dirname(to),
        prefix: ".t3-wip-",
      });
      const partial = path.join(staging, "copy.blend");
      yield* fileSystem.copyFile(held, partial);
      yield* syncFile(fileSystem, partial);
      const [source, staged] = yield* Effect.all([
        sizeAndTime(fileSystem, held),
        sizeAndTime(fileSystem, partial),
      ]);
      if (source === null || staged === null || source.size !== staged.size) {
        return "incomplete" as const;
      }
      const linked = yield* fileSystem.link(partial, to).pipe(Effect.isSuccess);
      return linked ? ("linked" as const) : ("inTheWay" as const);
    }),
  );
});

/** Blender's `.blend1`, `.blend2`… backups of a copy that passed `notOwnCopy`, regular files only. */
export const removeBackups = Effect.fnUntraced(function* (copy: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  // Blender keeps at most 32 save versions.
  for (let version = 1; version <= 32; version++) {
    const backup = `${copy}${version}`;
    const info = yield* fileSystem.lstat(backup).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "File") {
      yield* fileSystem.remove(backup, { force: true });
    }
  }
});
