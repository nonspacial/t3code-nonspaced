import type { BlendConversionInput, BlendConversionStatus } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { issueBlendGlbUrl } from "../assets/AssetAccess.ts";
import * as AssetSigner from "../assets/AssetSigner.ts";
import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import { readFileRevision } from "../assets/MediaFile.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as BlenderDetection from "./BlenderDetection.ts";
import { blendCacheDir, isBlendCacheFileName } from "./blendCache.ts";
import * as BlendFileWatcher from "./BlendFileWatcher.ts";
import { BLEND_EXPORT_SCRIPT } from "./blendExportScript.ts";
import {
  type BlendFileFormatError,
  isBlendFileFormatError,
  readBlendFileFacts,
} from "./blendFile.ts";

/** A first conversion stops here and offers Keep trying, which has no limit. */
export const CONVERSION_TIME_LIMIT = Duration.seconds(60);
const CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** The 3D viewer's own limit: a larger GLB is never shown, so it never enters the cache. */
const VIEWER_MAX_BYTES = 1024 * 1024 * 1024;
const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const LOG_MAX_CHARACTERS = 32 * 1024;

type ConversionError =
  | BlendFileFormatError
  | WorkspaceFileSystem.WorkspaceFileSystemError
  | WorkspacePaths.WorkspacePathOutsideRootError;

type Emit = (status: BlendConversionStatus) => Effect.Effect<void>;

export class BlendConversion extends Context.Service<
  BlendConversion,
  {
    /**
     * Converts a workspace `.blend` to GLB, one file at a time per environment. Interrupting it
     * cancels the conversion, whether it is waiting or running.
     */
    readonly convert: (
      input: BlendConversionInput,
      emit: Emit,
    ) => Effect.Effect<void, ConversionError>;
    /**
     * Converts like `convert`, then again each time the file or a library it links changes,
     * until interrupted. It ends only when the file cannot be converted at all, or after the one
     * conversion `once` asks for.
     */
    readonly watch: (
      input: BlendConversionInput,
      emit: Emit,
    ) => Effect.Effect<void, ConversionError>;
  }
>()("t3/blend/BlendConversion") {}

/** The command line; the order matters, as Blender applies options before the file it opens. */
const conversionArguments = (input: {
  readonly blendPath: string;
  readonly scriptPath: string;
  readonly outputPath: string;
}): ReadonlyArray<string> => [
  "--background",
  // Factory settings: no user add-ons or startup file, whatever the user's Blender has set up.
  "--factory-startup",
  // Scripts embedded in the file never run during a conversion.
  "--disable-autoexec",
  "-noaudio",
  "--python-exit-code",
  "1",
  input.blendPath,
  "--python",
  input.scriptPath,
  "--",
  input.outputPath,
];

type Unavailable = Extract<BlendConversionStatus, { readonly status: "unavailable" }>;
const unavailable = (status: Omit<Unavailable, "status">): Unavailable => ({
  status: "unavailable",
  ...status,
});

/** A workspace `.blend` that passed its checks, by its real path. */
interface Source {
  readonly blendPath: string;
  readonly libraries: ReadonlyArray<string>;
  readonly blender: BlenderDetection.DetectedBlender;
  /** The file and the libraries it watches, as they were when checked; null while missing. */
  readonly revisions: ReadonlyArray<Revision>;
  /** The file and every library it links, the server's own too: what its cache entry is of. */
  readonly keyRevisions: ReadonlyArray<Revision>;
}

interface Revision {
  readonly file: string;
  readonly revision: string | null;
}

const readRevisions = (files: ReadonlyArray<Revision>) =>
  Effect.forEach(files, ({ file }) =>
    Effect.map(readFileRevision(file), (revision) => ({ file, revision })),
  );

const sameRevisions = (a: ReadonlyArray<Revision>, b: ReadonlyArray<Revision>) =>
  a.length === b.length && a.every((entry, index) => entry.revision === b[index]?.revision);

const encodeCacheKey = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const versionParts = (version: string) => {
  const match = /^(\d+)\.(\d+)/.exec(version);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
};

/** Whether a file saved by `fileVersion` is newer than this Blender can be trusted to open. */
const savedByNewerBlender = (fileVersion: string, blenderVersion: string) => {
  const file = versionParts(fileVersion);
  const blender = versionParts(blenderVersion);
  if (file === null || blender === null) return false;
  return file.major > blender.major || (file.major === blender.major && file.minor > blender.minor);
};

const make = Effect.fn("BlendConversion.make")(function* (options: {
  readonly cacheMaxBytes: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const detection = yield* BlenderDetection.BlenderDetection;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const digest = yield* Digest.Digest;
  const environment = yield* HostProcess.Environment;
  const signer = yield* AssetSigner.AssetSigner;
  const watcher = yield* BlendFileWatcher.BlendFileWatcher;
  const isServerInternalPath = yield* makeIsServerInternalPath;
  const cacheDir = blendCacheDir(path, config.providerStatusCacheDir);

  const lock = yield* Semaphore.make(1);
  // Conversions waiting for the lock, oldest first; each hears its place when the line moves.
  const waiting: Array<{
    readonly emit: (status: BlendConversionStatus) => Effect.Effect<void>;
  }> = [];
  let running = false;
  const announce = Effect.suspend(() =>
    Effect.forEach(
      [...waiting],
      (job, index) => {
        const ahead = index + (running ? 1 : 0);
        // A conversion with nothing ahead starts at once and says so itself.
        return ahead === 0 ? Effect.void : job.emit({ status: "waiting", ahead });
      },
      { discard: true },
    ),
  );

  const modifiedAt = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => ({
        size: Number(info.size),
        mtime: info.mtime._tag === "Some" ? info.mtime.value.getTime() : null,
      })),
      Effect.orElseSucceed(() => null),
    );

  /** Saved library paths start with `//` when they are relative to the file. */
  const libraryPath = (blendPath: string, saved: string) =>
    saved.startsWith("//")
      ? path.resolve(path.dirname(blendPath), saved.slice(2).replaceAll("\\", "/"))
      : saved;

  // The revisions the watcher compares, so a change it sees is never answered from the cache.
  const cacheKey = Effect.fnUntraced(function* (input: Source) {
    const key = yield* encodeCacheKey({
      path: input.blendPath,
      revisions: input.keyRevisions,
      blender: input.blender,
      script: BLEND_EXPORT_SCRIPT,
    });
    return yield* digest
      .digest(Digest.sha256, new TextEncoder().encode(key))
      .pipe(Effect.map(Hex.encode));
  }, Effect.orDie);

  /** Marks a hit as recently used, so the size cap evicts other entries first. */
  const touch = (file: string) =>
    // Node reads numeric times as seconds.
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      fileSystem.utimes(file, now / 1000, now / 1000),
    ).pipe(Effect.ignore);

  /** A ready status carries a signed URL for the cache entry; no client can name one itself. */
  const ready = (
    cacheFileName: string,
    facts: Omit<
      Extract<BlendConversionStatus, { readonly status: "ready" }>,
      "status" | "relativeUrl"
    >,
  ) =>
    issueBlendGlbUrl(cacheFileName).pipe(
      Effect.provideService(AssetSigner.AssetSigner, signer),
      Effect.map((relativeUrl): BlendConversionStatus => ({
        status: "ready",
        relativeUrl,
        ...facts,
      })),
      Effect.orElseSucceed((): BlendConversionStatus => ({
        status: "failed",
        log: "The converted file could not be served.",
      })),
    );

  const cached = Effect.fnUntraced(function* (cacheFileName: string) {
    const file = path.join(cacheDir, cacheFileName);
    const info = yield* modifiedAt(file);
    if (info === null || info.size === 0) return null;
    yield* touch(file);
    return info;
  });

  const evict = Effect.fnUntraced(function* (keep: string) {
    const names = yield* fileSystem
      .readDirectory(cacheDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const entries = yield* Effect.forEach(names.filter(isBlendCacheFileName), (name) =>
      Effect.map(modifiedAt(path.join(cacheDir, name)), (info) => ({ name, info })),
    );
    // The entry just written stays; the others go least recently used first.
    let total = entries.find((entry) => entry.name === keep)?.info?.size ?? 0;
    const newestFirst = entries
      .filter((entry) => entry.name !== keep && entry.info !== null)
      .toSorted((a, b) => (b.info?.mtime ?? 0) - (a.info?.mtime ?? 0));
    for (const entry of newestFirst) {
      total += entry.info?.size ?? 0;
      if (total > options.cacheMaxBytes) {
        yield* fileSystem.remove(path.join(cacheDir, entry.name)).pipe(Effect.ignore);
      }
    }
  });

  const run = Effect.fnUntraced(
    function* (input: {
      readonly blendPath: string;
      readonly blender: BlenderDetection.DetectedBlender;
      readonly cacheFileName: string;
      readonly keepTrying: boolean;
      /** What the export must still be of when it is cached. */
      readonly keyRevisions: ReadonlyArray<Revision>;
      /** A watch converts a file changed meanwhile again, so it hears nothing of this one. */
      readonly watching: boolean;
      readonly emit: (status: BlendConversionStatus) => Effect.Effect<void>;
    }) {
      yield* fileSystem.makeDirectory(cacheDir, { recursive: true });
      // Beside the cache, so the finished GLB is renamed into place rather than copied.
      const workDir = yield* fileSystem.makeTempDirectoryScoped({
        directory: cacheDir,
        prefix: ".convert-",
      });
      const scriptPath = path.join(workDir, "t3_export.py");
      const outputPath = path.join(workDir, "scene.glb");
      const tempDir = path.join(workDir, "tmp");
      const userDir = path.join(workDir, "blender-user");
      yield* Effect.all([
        fileSystem.writeFileString(scriptPath, BLEND_EXPORT_SCRIPT),
        fileSystem.makeDirectory(tempDir),
        fileSystem.makeDirectory(path.join(userDir, "config"), { recursive: true }),
        fileSystem.makeDirectory(path.join(userDir, "scripts"), { recursive: true }),
      ]);
      // The checked path must still be the file itself, not a link swapped in since.
      if ((yield* fileSystem.realPath(input.blendPath)) !== input.blendPath) {
        return yield* input.emit({ status: "unavailable", reason: "outsideWorkspace" });
      }
      yield* input.emit({
        status: "converting",
        blenderVersion: input.blender.version,
        startedAt: yield* Clock.currentTimeMillis,
      });
      const output = yield* runner
        .run({
          command: input.blender.path,
          args: conversionArguments({ blendPath: input.blendPath, scriptPath, outputPath }),
          // Never the file's folder: workspace content must not decide what Blender finds there.
          cwd: workDir,
          env: BlenderDetection.blenderEnvironment(environment, {
            TMPDIR: tempDir,
            TEMP: tempDir,
            TMP: tempDir,
            // A private config, so nothing reaches or comes from the user's own Blender settings.
            BLENDER_USER_RESOURCES: userDir,
            BLENDER_USER_CONFIG: path.join(userDir, "config"),
            BLENDER_USER_SCRIPTS: path.join(userDir, "scripts"),
          }),
          replaceEnv: true,
          timeout: input.keepTrying ? Duration.infinity : CONVERSION_TIME_LIMIT,
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: 256 * 1024,
          outputMode: "truncate",
        })
        .pipe(Effect.result);
      if (output._tag === "Failure") {
        return yield* input.emit({ status: "failed", log: output.failure.message });
      }
      if (output.success.timedOut) return yield* input.emit({ status: "slow" });
      const written = yield* modifiedAt(outputPath);
      if (output.success.code !== 0 || written === null || written.size === 0) {
        const log = `${output.success.stdout}\n${output.success.stderr}`.trim();
        return yield* input.emit({
          status: "failed",
          log: log.length > LOG_MAX_CHARACTERS ? log.slice(-LOG_MAX_CHARACTERS) : log,
        });
      }
      // Admitting it would evict every other entry for a model no viewer opens; the scoped
      // work folder removes it instead.
      const admissible = Math.min(options.cacheMaxBytes, VIEWER_MAX_BYTES);
      if (written.size > admissible) {
        return yield* input.emit({
          status: "failed",
          log: `The converted model is ${megabytes(written.size)}, over the ${megabytes(admissible)} a 3D preview can hold.`,
        });
      }
      // Changed while Blender read it: the export is of no version the key names.
      if (!sameRevisions(yield* readRevisions(input.keyRevisions), input.keyRevisions)) {
        if (input.watching) return;
        return yield* input.emit({
          status: "failed",
          log: "The file changed while Blender converted it, so the result wasn't kept. Try again.",
        });
      }
      const target = path.join(cacheDir, input.cacheFileName);
      yield* fileSystem.rename(outputPath, target);
      yield* evict(input.cacheFileName);
      yield* input.emit(
        yield* ready(input.cacheFileName, {
          byteLength: written.size,
          blenderVersion: input.blender.version,
          convertedAt: yield* Clock.currentTimeMillis,
          cached: false,
        }),
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.scoped,
        // A full disk or an unwritable cache fails this conversion, not the server.
        Effect.catchTags({
          PlatformError: (error) => input.emit({ status: "failed", log: error.message }),
        }),
      ),
  );

  /** Converts once, returning the file as it was last checked, or null when it can't be. */
  const convertOnce = Effect.fnUntraced(function* (
    input: BlendConversionInput,
    emit: Emit,
    watching: boolean,
  ) {
    // Checked again once the conversion gets its turn: the file can be replaced while it waits.
    const check = Effect.fnUntraced(function* () {
      const target = yield* workspaceFileSystem.resolveReadPath(input);
      const insideWorkspace = yield* knownWorkspaces.assertContains(input.cwd).pipe(
        Effect.andThen(fileSystem.realPath(input.cwd)),
        Effect.map((root) => KnownWorkspaces.isWithinRoot(path, target.realPath, root)),
        Effect.orElseSucceed(() => false),
      );
      if (!insideWorkspace) {
        return unavailable({ reason: "outsideWorkspace" });
      }
      // Read before the file's contents, so a save from here on counts as a change.
      const revision = yield* readFileRevision(target.realPath);
      const info = yield* fileSystem.stat(target.realPath).pipe(Effect.option);
      if (info._tag === "None" || info.value.type !== "File") {
        return yield* new WorkspaceFileSystem.WorkspacePathNotFileError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.realPath,
        });
      }
      const facts = yield* Effect.tryPromise({
        try: (signal) => readBlendFileFacts(target.realPath, revision, signal),
        catch: (cause) =>
          isBlendFileFormatError(cause)
            ? cause
            : new WorkspaceFileSystem.WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: target.realPath,
                operationPath: target.realPath,
                operation: "read",
                cause,
              }),
      });
      const blender = yield* detection.find;
      if (blender === null) return unavailable({ reason: "noBlender" });
      if (savedByNewerBlender(facts.blenderVersion, blender.version)) {
        return unavailable({ reason: "newerBlender", blenderVersion: blender.version });
      }
      const libraries = yield* Effect.forEach(
        facts.libraries.map((saved) => libraryPath(target.realPath, saved)),
        (file) => Effect.map(readFileRevision(file), (revision) => ({ file, revision })),
      );
      // The server's own files are never watched, so no change notice can tell of them.
      const watchable = yield* Effect.filter(libraries, ({ file }) =>
        Effect.map(isServerInternalPath(file), (internal) => !internal),
      );
      const own = { file: target.realPath, revision };
      const source: Source = {
        blendPath: target.realPath,
        libraries: facts.libraries,
        blender,
        revisions: [own, ...watchable],
        keyRevisions: [own, ...libraries],
      };
      return source;
    });
    const fromCache = Effect.fnUntraced(function* (key: Source) {
      const cacheFileName = `${yield* cacheKey(key)}.glb`;
      const hit = yield* cached(cacheFileName);
      if (hit === null) return { cacheFileName, hit: false } as const;
      yield* emit(
        yield* ready(cacheFileName, {
          byteLength: hit.size,
          blenderVersion: key.blender.version,
          convertedAt: hit.mtime ?? (yield* Clock.currentTimeMillis),
          cached: true,
        }),
      );
      return { cacheFileName, hit: true } as const;
    });

    const first = yield* check();
    if ("status" in first) {
      yield* emit(first);
      return null;
    }
    if (!input.refresh && (yield* fromCache(first)).hit) return first;

    const job = { emit };
    const leave = Effect.suspend(() => {
      const index = waiting.indexOf(job);
      if (index !== -1) waiting.splice(index, 1);
      return announce;
    });
    waiting.push(job);
    yield* announce;
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          running = true;
          yield* leave;
          const source = yield* check();
          if ("status" in source) {
            yield* emit(source);
            return null;
          }
          // A conversion that waited may find the file converted by the one before it.
          const lookup = input.refresh
            ? { cacheFileName: `${yield* cacheKey(source)}.glb`, hit: false }
            : yield* fromCache(source);
          if (lookup.hit) return source;
          yield* run({
            blendPath: source.blendPath,
            blender: source.blender,
            cacheFileName: lookup.cacheFileName,
            keepTrying: input.keepTrying === true,
            keyRevisions: source.keyRevisions,
            watching,
            emit,
          });
          return source;
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              running = false;
              return announce;
            }),
          ),
        ),
      )
      .pipe(Effect.onInterrupt(() => leave));
  });

  /** The first file that differs from when it was checked, and every file as it was then. */
  const nextChange = (source: Source) =>
    watcher.changes(source.revisions.map(({ file }) => file)).pipe(
      Stream.mapEffect(() => readRevisions(source.revisions)),
      Stream.map((revisions) => ({
        changed: revisions.find(
          ({ revision }, index) => revision !== source.revisions[index]?.revision,
        ),
        revisions,
      })),
      Stream.filter(({ changed }) => changed !== undefined),
      Stream.runHead,
    );

  const watch: BlendConversion["Service"]["watch"] = Effect.fn("BlendConversion.watch")(
    function* (input, emit) {
      let request = input;
      let changed: string | null = null;
      const seen: { last: BlendConversionStatus | null } = { last: null };
      const withChange: Emit = (status) => {
        seen.last = status;
        return changed !== null &&
          (status.status === "waiting" ||
            status.status === "converting" ||
            status.status === "ready")
          ? emit({ ...status, changed })
          : emit(status);
      };
      // A large file converts only when asked, and not again on its own.
      if (input.once === true)
        return yield* convertOnce(request, withChange, false).pipe(Effect.asVoid);
      let source = yield* convertOnce(request, withChange, true);
      while (true) {
        if (source === null || seen.last?.status === "unavailable") return;
        const change = yield* nextChange(source);
        if (change._tag === "None" || change.value.changed === undefined) return;
        changed = path.basename(change.value.changed.file);
        // A change makes a new cache key, so later rounds may use the cache again.
        request = { ...input, refresh: false };
        // A file caught mid-save fails this round, not the watch, which then waits for a version
        // other than the one that failed, even one saved before it watches again.
        const failedOn: Source = { ...source, revisions: change.value.revisions };
        source = yield* convertOnce(request, withChange, true).pipe(
          Effect.catch((error) =>
            withChange({ status: "failed", log: error.message }).pipe(Effect.as(failedOn)),
          ),
        );
      }
    },
  );

  const convert: BlendConversion["Service"]["convert"] = Effect.fn("BlendConversion.convert")(
    function* (input, emit) {
      yield* convertOnce(input, emit, false);
    },
  );

  return BlendConversion.of({ convert, watch });
});

export const layer = Layer.effect(BlendConversion, make({ cacheMaxBytes: CACHE_MAX_BYTES }));
export const layerWith = (options: { readonly cacheMaxBytes: number }) =>
  Layer.effect(BlendConversion, make(options));
