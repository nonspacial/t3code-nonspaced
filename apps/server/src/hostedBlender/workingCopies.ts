import { ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

/** Nothing is held longer than this from when it was held, whatever the person answered. */
export const HELD_COPY_LIMIT = Duration.days(30);

/**
 * A workspace's held copies, under its root: on the project's own drive, so a hold is a rename
 * and a large scene never fills the OS drive; a dot folder, ignored by its own `.gitignore`.
 */
export const HELD_FOLDER = ".t3/held-working-copies";

/** The workspace's real root, from where the copy sits under it, or null when unknown. */
export const workspaceRootOf = (record: WorkingCopyRecord) =>
  record.relativePath !== undefined && record.path.endsWith(`/${record.relativePath}`)
    ? record.path.slice(0, -(record.relativePath.length + 1))
    : null;

/** Makes the workspace's held folder, ignored by git without touching the project's own rules. */
export const prepareHeldFolder = Effect.fnUntraced(function* (root: string, held: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(held), { recursive: true });
  yield* fileSystem
    .writeFileString(path.join(root, HELD_FOLDER, ".gitignore"), "*\n", { flag: "wx" })
    .pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
    );
});

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
 * keeps. Held, the copy is at `heldFile`, or `copy.blend` beside this record without one.
 */
export const WorkingCopyRecord = Schema.Struct({
  threadId: ThreadId,
  /** The master's real path. */
  master: Schema.String,
  /** Where the copy sits in the project, by its real folder: beside the master. */
  path: Schema.String,
  /** That place under the workspace's real root, which the pane names it by. */
  relativePath: Schema.optional(Schema.String),
  state: Schema.Literals(["live", "holding", "held", "returning"]),
  heldAt: Schema.optional(Schema.Number),
  /** The master's revision as the copy was held, which tells when the master moved on. */
  masterRevision: Schema.optional(Schema.NullOr(Schema.String)),
  bytes: Schema.optional(Schema.Number),
  threadTitle: Schema.optional(Schema.String),
  /** Asked once the master moved on, the person kept it. */
  kept: Schema.optional(Schema.Boolean),
  /**
   * Where the held file is, in its workspace's `HELD_FOLDER`. Absent: beside this record, as
   * when T3's state was the only place (copies held before, or a master across a mount).
   */
  heldFile: Schema.optional(Schema.String),
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
      // A save that writes a new file and renames it over the old one gives it a new inode.
      file: Option.match(info.ino, { onNone: () => "", onSome: (ino) => `${info.dev}:${ino}` }),
    })),
    Effect.option,
    Effect.map(Option.getOrNull),
  );
export type CopiedFile = NonNullable<Effect.Success<ReturnType<typeof sizeAndTime>>>;

/** Written out to the disk, so a rename after it never names half a file after a crash. */
const syncFile = (fileSystem: FileSystem.FileSystem, file: string) =>
  Effect.scoped(fileSystem.open(file, { flag: "r+" }).pipe(Effect.flatMap((open) => open.sync)));

const isCrossDevice = (error: PlatformError.PlatformError) =>
  error.reason._tag === "Unknown" &&
  (error.reason.cause as { readonly code?: unknown } | undefined)?.code === "EXDEV";

/**
 * Moves a working copy to `held` in T3's state by renaming it, which takes whatever is at its
 * place at that instant, so a save landing meanwhile is held rather than lost. Its size, or null
 * when T3's state is on another drive and the copy has to be copied out instead.
 */
export const renameOut = Effect.fnUntraced(function* (from: string, held: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const renamed = yield* fileSystem.rename(from, held).pipe(
    Effect.as(true),
    Effect.catchIf(isCrossDevice, () => Effect.succeed(false)),
  );
  if (!renamed) return null;
  return (yield* sizeAndTime(fileSystem, held))?.size ?? 0;
});

/**
 * Copies a working copy to `held` in T3's state on another drive: through a temporary name,
 * synced, then renamed. The file as it was before the copy, for `takeCopied` to check against,
 * or null, with nothing left at `held`, when the copy came out another size. A copy that fails
 * (a full disk) leaves nothing behind either. The original stays.
 */
export const copyOut = Effect.fnUntraced(function* (from: string, held: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const before = yield* sizeAndTime(fileSystem, from);
  if (before === null) return null;
  const partial = `${held}.partial`;
  const copied = yield* fileSystem.copyFile(from, partial).pipe(
    Effect.andThen(syncFile(fileSystem, partial)),
    Effect.andThen(fileSystem.rename(partial, held)),
    Effect.andThen(sizeAndTime(fileSystem, held)),
    Effect.onError(() => fileSystem.remove(partial, { force: true }).pipe(Effect.ignore)),
  );
  if (copied?.size !== before.size) {
    yield* fileSystem.remove(held, { force: true });
    return null;
  }
  return before;
});

/** Where a hold sets a working copy aside, in its own folder, while it checks it. */
export const asideOf = (copy: string) => copy.replace(/([^/]*)$/, ".$1.t3-hold");

/**
 * Takes a copied-out working copy out of the project: renamed aside first, so nothing can save
 * over it, and removed only if it is still the file `copyOut` copied. Otherwise a newer save
 * came in, and goes back to its place: `restoreAside`.
 */
export const takeCopied = Effect.fnUntraced(function* (from: string, copied: CopiedFile) {
  const fileSystem = yield* FileSystem.FileSystem;
  const aside = asideOf(from);
  yield* fileSystem.rename(from, aside);
  const taken = yield* sizeAndTime(fileSystem, aside);
  if (
    taken !== null &&
    taken.size === copied.size &&
    taken.mtime === copied.mtime &&
    taken.file === copied.file
  ) {
    yield* fileSystem.remove(aside);
    return "taken" as const;
  }
  return yield* restoreAside(from);
});

/**
 * Puts a file a hold set aside back at `to`, never over a file there by then: `setAside`, the
 * file left aside, when one is. `restored` once it is back, or when nothing was aside.
 */
export const restoreAside = Effect.fnUntraced(function* (to: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const aside = asideOf(to);
  const [asideFile, there] = yield* Effect.all([
    sizeAndTime(fileSystem, aside),
    sizeAndTime(fileSystem, to),
  ]);
  if (asideFile === null) return "restored" as const;
  if (there === null) {
    const linked = yield* fileSystem.link(aside, to).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.succeed(false),
      ),
    );
    if (!linked) return "setAside" as const;
    // Linked back before a crash: the same file has both names.
  } else if (there.file === "" || there.file !== asideFile.file) {
    return "setAside" as const;
  }
  yield* fileSystem.remove(aside);
  return "restored" as const;
});

/**
 * Puts a copy held on the project's drive back at `to` by a hard link, which never replaces a
 * file there (`inTheWay`); the caller then removes the held name. A drive with no hard links
 * copies it back instead.
 */
export const linkBack = Effect.fnUntraced(function* (held: string, to: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const linked = yield* fileSystem.link(held, to).pipe(
    Effect.as("linked" as const),
    Effect.catchIf(
      (error) => error.reason._tag === "AlreadyExists",
      () => Effect.succeed("inTheWay" as const),
    ),
    Effect.orElseSucceed(() => null),
  );
  return linked ?? (yield* copyBack(held, to));
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
