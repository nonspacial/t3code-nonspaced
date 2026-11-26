import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { BLEND_LARGE_FILE_BYTES, type BlendConversionStatus } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as AssetSigner from "../assets/AssetSigner.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as BlendConversion from "./BlendConversion.ts";
import { blendCacheDir } from "./blendCache.ts";
import * as BlendFileWatcher from "./BlendFileWatcher.ts";
import * as BlenderDetection from "./BlenderDetection.ts";

type RunInput = Parameters<ProcessRunner.ProcessRunner["Service"]["run"]>[0];
type Run = ProcessRunner.ProcessRunner["Service"]["run"];

const output = (overrides: Partial<ProcessRunner.ProcessRunOutput> = {}) =>
  ({
    stdout: "",
    stderr: "",
    code: 0 as ProcessRunner.ProcessRunOutput["code"],
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
    ...overrides,
  }) satisfies ProcessRunner.ProcessRunOutput;

/** The cache entry a ready status's signed URL names. */
const cacheFileNameOf = (relativeUrl: string): string =>
  JSON.parse(Buffer.from(relativeUrl.split("/")[3]!.split(".")[0]!, "base64url").toString())
    .fileName;

/** Writes a small GLB where Blender would, as a finished export does. */
const writeGlb = (input: RunInput) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(input.args.at(-1)!, "0123456789");
    return output();
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

/** A watcher the test drives: it hears each watch begin and says when files may have changed. */
const makeWatcher = Effect.gen(function* () {
  const opened = yield* Queue.unbounded<ReadonlyArray<string>>();
  const closed = yield* Queue.unbounded<ReadonlyArray<string>>();
  let current: Queue.Queue<void, Cause.Done> | null = null;
  const watcher = BlendFileWatcher.BlendFileWatcher.of({
    changes: (files) =>
      Stream.callback<void>((events) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            current = events;
            Queue.offerUnsafe(events, undefined);
            Queue.offerUnsafe(opened, files);
          }),
          () =>
            Effect.sync(() => {
              current = null;
              Queue.offerUnsafe(closed, files);
            }),
        ),
      ),
  });
  const signal = Effect.sync(() => current && Queue.offerUnsafe(current, undefined));
  return { watcher, opened, closed, signal };
});

/** Compares once when a watch begins and never hears of a change. */
const quietWatcher = BlendFileWatcher.BlendFileWatcher.of({
  changes: () => Stream.make(undefined).pipe(Stream.concat(Stream.never)),
});

const layerFor = (options: {
  readonly run: Run;
  readonly watcher?: BlendFileWatcher.BlendFileWatcher["Service"];
  readonly blender?: BlenderDetection.DetectedBlender | null;
  readonly known?: boolean;
  readonly cacheMaxBytes?: number;
}) =>
  BlendConversion.layerWith({ cacheMaxBytes: options.cacheMaxBytes ?? 1024 * 1024 }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProcessRunner.ProcessRunner)({ run: options.run }),
        Layer.mock(AssetSigner.AssetSigner)({ sign: () => Effect.succeed("signature") }),
        Layer.succeed(BlendFileWatcher.BlendFileWatcher, options.watcher ?? quietWatcher),
        Layer.succeed(BlenderDetection.BlenderDetection, {
          find: Effect.succeed(
            options.blender === undefined
              ? { path: "/opt/blender/blender", version: "5.3.0" }
              : options.blender,
          ),
        }),
        WorkspaceFileSystem.layer.pipe(
          Layer.provide(Layer.mock(WorkspaceEntries.WorkspaceEntries)({})),
          Layer.provide(WorkspacePaths.layer),
        ),
        Layer.succeed(HostProcess.Environment, {
          PATH: "/bin",
          T3CODE_HOME: "/t3",
          BLENDER_USER_CONFIG: "/desktop-blender",
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.mock(KnownWorkspaces.KnownWorkspaces)({
        assertContains: (cwd) =>
          options.known === false
            ? Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd }))
            : Effect.void,
      }),
    ),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-blend-convert-" }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const cacheDirectory = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return blendCacheDir(yield* Path.Path, config.providerStatusCacheDir);
});

/** A workspace with an assembly that links `parts.blend` in, beside it. */
const workspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-blend-workspace-" });
  const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-blend-outside-" });
  const fixtures = path.join(import.meta.dirname, "fixtures");
  for (const [from, to] of [
    ["assembly-5.blend", "assembly.blend"],
    ["parts-5.blend", "parts-5.blend"],
    ["bracket-5.blend", "bracket.blend"],
    ["bracket-4.blend", "bracket-4.blend"],
  ] as const) {
    yield* fileSystem.copyFile(path.join(fixtures, from), path.join(root, to));
  }
  yield* fileSystem.copyFile(path.join(fixtures, "bracket-5.blend"), path.join(outside, "b.blend"));
  return { root, outside, path, fileSystem };
});

/** Runs one conversion to its end and returns everything it reported. */
const convertAll = (input: Parameters<BlendConversion.BlendConversion["Service"]["convert"]>[0]) =>
  Effect.gen(function* () {
    const conversion = yield* BlendConversion.BlendConversion;
    const seen: Array<BlendConversionStatus> = [];
    yield* conversion.convert(input, (progress) => Effect.sync(() => seen.push(progress)));
    return seen.map(({ status }) => status);
  });

/** Starts a conversion whose progress arrives on a queue. */
const startConversion = (
  input: Parameters<BlendConversion.BlendConversion["Service"]["convert"]>[0],
  method: "convert" | "watch" = "convert",
) =>
  Effect.gen(function* () {
    const conversion = yield* BlendConversion.BlendConversion;
    const progress = yield* Queue.unbounded<BlendConversionStatus>();
    const fiber = yield* conversion[method](input, (value) =>
      Queue.offer(progress, value).pipe(Effect.asVoid),
    ).pipe(Effect.forkChild);
    return { progress, fiber };
  });

/** Moves a file's modification time on, as saving it does. */
const touchFile = (file: string, at: number) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.utimes(file, at / 1000, at / 1000),
  );

describe("BlendConversion", () => {
  it.effect(
    "runs Blender privately with scripts off, then answers from the cache until a file it links changes",
    () => {
      const runs: Array<RunInput> = [];
      const run: Run = (input) =>
        Effect.sync(() => runs.push(input)).pipe(Effect.andThen(writeGlb(input)));
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2030, 0, 1));
        const { root, path, fileSystem } = yield* workspace;
        const input = { cwd: root, relativePath: "assembly.blend" };

        expect(yield* convertAll(input)).toEqual(["converting", "ready"]);
        const [first] = runs;
        const blendPath = yield* fileSystem.realPath(path.join(root, "assembly.blend"));
        expect(first?.command).toBe("/opt/blender/blender");
        // Options before the file apply to opening it, so scripts are off before it loads.
        expect(first?.args.slice(0, 7)).toEqual([
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "-noaudio",
          "--python-exit-code",
          "1",
          blendPath,
        ]);
        expect(first?.timeout).toEqual(BlendConversion.CONVERSION_TIME_LIMIT);
        const cacheDir = yield* cacheDirectory;
        expect(first?.env).toMatchObject({
          PATH: "/bin",
          TMPDIR: expect.stringContaining(cacheDir),
          BLENDER_USER_CONFIG: expect.stringContaining(cacheDir),
        });
        expect(first?.env?.T3CODE_HOME).toBeUndefined();
        // The child gets only this environment, and works in its private folder, never the file's.
        expect(first?.replaceEnv).toBe(true);
        expect(first?.cwd).toContain(cacheDir);

        const conversion = yield* BlendConversion.BlendConversion;
        const hits: Array<BlendConversionStatus> = [];
        yield* conversion.convert(input, (progress) => Effect.sync(() => hits.push(progress)));
        expect(hits).toEqual([expect.objectContaining({ status: "ready", cached: true })]);
        // A hit counts as a use now, which the size cap's least-recently-used order reads.
        const hit = hits[0]?.status === "ready" ? cacheFileNameOf(hits[0].relativeUrl) : "";
        const used = yield* fileSystem.stat(path.join(yield* cacheDirectory, hit));
        expect(used.mtime._tag === "Some" && used.mtime.value.getTime()).toBe(Date.UTC(2030, 0, 1));
        expect(runs).toHaveLength(1);
        // The work folder, with Blender's temp files and config, is gone.
        expect(
          (yield* fileSystem.readDirectory(cacheDir)).filter((name) => name.startsWith(".")),
        ).toEqual([]);

        yield* fileSystem.utimes(
          path.join(root, "parts-5.blend"),
          Date.UTC(2031, 0, 1) / 1000,
          Date.UTC(2031, 0, 1) / 1000,
        );
        expect(yield* convertAll(input)).toEqual(["converting", "ready"]);
        expect(yield* convertAll({ ...input, refresh: true, keepTrying: true })).toEqual([
          "converting",
          "ready",
        ]);
        expect(runs).toHaveLength(3);
        expect(runs[2]?.timeout).toEqual(Duration.infinity);
      }).pipe(Effect.provide(layerFor({ run })));
    },
  );

  it.effect(
    "converts one file at a time; waiting files hear their place and can be cancelled",
    () => {
      const started: Array<Deferred.Deferred<void>> = [];
      const release = Deferred.makeUnsafe<void>();
      const interrupted = Deferred.makeUnsafe<void>();
      const run: Run = (input) =>
        Effect.gen(function* () {
          const deferred = Deferred.makeUnsafe<void>();
          started.push(deferred);
          yield* Deferred.succeed(deferred, undefined);
          yield* Deferred.await(release);
          return yield* writeGlb(input);
        }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)));
      return Effect.gen(function* () {
        const { root } = yield* workspace;
        const a = yield* startConversion({ cwd: root, relativePath: "assembly.blend" });
        expect((yield* Queue.take(a.progress)).status).toBe("converting");
        const b = yield* startConversion({ cwd: root, relativePath: "bracket.blend" });
        expect(yield* Queue.take(b.progress)).toEqual({ status: "waiting", ahead: 1 });
        const c = yield* startConversion({ cwd: root, relativePath: "bracket-4.blend" });
        expect(yield* Queue.take(c.progress)).toEqual({ status: "waiting", ahead: 2 });
        // B hears the announcement C's arrival made, still one ahead.
        expect(yield* Queue.take(b.progress)).toEqual({ status: "waiting", ahead: 1 });

        yield* Fiber.interrupt(b.fiber);
        expect(yield* Queue.take(c.progress)).toEqual({ status: "waiting", ahead: 1 });
        yield* Deferred.succeed(release, undefined);
        expect((yield* Queue.take(a.progress)).status).toBe("ready");
        yield* Fiber.join(a.fiber);
        let next = yield* Queue.take(c.progress);
        while (next.status === "waiting") next = yield* Queue.take(c.progress);
        expect(next.status).toBe("converting");
        expect(started).toHaveLength(2);

        // Cancelling a running conversion stops Blender.
        yield* Fiber.interrupt(c.fiber);
        yield* Deferred.await(interrupted);
      }).pipe(Effect.provide(layerFor({ run })));
    },
  );

  it.effect("checks a waiting file again when its turn comes, and never converts a swap", () => {
    const release = Deferred.makeUnsafe<void>();
    const runs: Array<RunInput> = [];
    const run: Run = (input) =>
      Effect.sync(() => runs.push(input)).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(writeGlb(input)),
      );
    return Effect.gen(function* () {
      const { root, outside, path, fileSystem } = yield* workspace;
      const a = yield* startConversion({ cwd: root, relativePath: "assembly.blend" });
      expect((yield* Queue.take(a.progress)).status).toBe("converting");
      const b = yield* startConversion({ cwd: root, relativePath: "bracket.blend" });
      expect(yield* Queue.take(b.progress)).toEqual({ status: "waiting", ahead: 1 });
      // While it waits, the file becomes a link to one outside the workspace.
      yield* fileSystem.remove(path.join(root, "bracket.blend"));
      yield* fileSystem.symlink(path.join(outside, "b.blend"), path.join(root, "bracket.blend"));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(a.fiber);
      const refused = yield* Fiber.join(b.fiber).pipe(Effect.flip);
      expect(refused._tag).toBe("WorkspaceFilePathEscapeError");
      expect(runs).toHaveLength(1);
    }).pipe(Effect.provide(layerFor({ run })));
  });

  it.effect("reports a slow, failed or impossible conversion", () =>
    Effect.gen(function* () {
      const { root, outside, path } = yield* workspace;
      const input = { cwd: root, relativePath: "bracket.blend" };
      const progress = (layer: ReturnType<typeof layerFor>, value = input) =>
        Effect.gen(function* () {
          const conversion = yield* BlendConversion.BlendConversion;
          const seen: Array<BlendConversionStatus> = [];
          yield* conversion.convert(value, (item) => Effect.sync(() => seen.push(item)));
          return seen.at(-1);
        }).pipe(Effect.provide(layer));

      expect(
        yield* progress(layerFor({ run: () => Effect.succeed(output({ timedOut: true })) })),
      ).toEqual({ status: "slow" });
      expect(
        yield* progress(
          layerFor({
            run: () => Effect.succeed(output({ code: 1 as never, stderr: "Error: no exporter" })),
          }),
        ),
      ).toEqual({ status: "failed", log: "Error: no exporter" });
      const never: Run = () => Effect.die("Blender must not run");
      expect(yield* progress(layerFor({ run: never, blender: null }))).toEqual({
        status: "unavailable",
        reason: "noBlender",
      });
      expect(
        yield* progress(layerFor({ run: never, blender: { path: "/b", version: "4.5.3" } })),
      ).toEqual({ status: "unavailable", reason: "newerBlender", blenderVersion: "4.5.3" });
      for (const [layer, value] of [
        [layerFor({ run: never }), { cwd: root, relativePath: path.join(outside, "b.blend") }],
        [layerFor({ run: never, known: false }), input],
      ] as const) {
        expect(yield* progress(layer, value)).toEqual({
          status: "unavailable",
          reason: "outsideWorkspace",
        });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the cache under its size cap, evicting the least recently used first", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2030, 0, 1));
      const { root, fileSystem } = yield* workspace;
      const conversion = yield* BlendConversion.BlendConversion;
      const names: Record<string, string> = {};
      for (const relativePath of [
        "assembly.blend",
        "bracket.blend",
        "assembly.blend",
        "bracket-4.blend",
      ]) {
        yield* conversion.convert({ cwd: root, relativePath }, (progress) =>
          Effect.sync(() => {
            if (progress.status === "ready")
              names[relativePath] = cacheFileNameOf(progress.relativeUrl);
          }),
        );
      }
      // Each GLB is 10 bytes and the cap holds two: the assembly was used again, the bracket not.
      expect((yield* fileSystem.readDirectory(yield* cacheDirectory)).toSorted()).toEqual(
        [names["assembly.blend"], names["bracket-4.blend"]].toSorted(),
      );
    }).pipe(Effect.provide(layerFor({ run: writeGlb, cacheMaxBytes: 25 }))),
  );

  it.effect(
    "P7: never admits a GLB larger than the cache can hold, keeping every other entry",
    () =>
      Effect.gen(function* () {
        const { root, fileSystem } = yield* workspace;
        const conversion = yield* BlendConversion.BlendConversion;
        const statuses: Array<BlendConversionStatus> = [];
        for (const relativePath of ["bracket.blend", "assembly.blend"]) {
          yield* conversion.convert({ cwd: root, relativePath }, (progress) =>
            Effect.sync(() => void statuses.push(progress)),
          );
        }
        const kept = statuses.flatMap((status) =>
          status.status === "ready" ? [cacheFileNameOf(status.relativeUrl)] : [],
        );
        expect(kept).toHaveLength(1);
        expect(statuses.at(-1)).toMatchObject({ status: "failed" });
        // Only the bracket's entry, and no work folder left behind.
        expect(yield* fileSystem.readDirectory(yield* cacheDirectory)).toEqual(kept);
      }).pipe(
        Effect.provide(
          layerFor({
            cacheMaxBytes: 25,
            // The assembly converts to 30 bytes, over the 25 the cache holds.
            run: (input) =>
              Effect.gen(function* () {
                const fileSystem = yield* FileSystem.FileSystem;
                const large = input.args.some((arg) => arg.endsWith("assembly.blend"));
                yield* fileSystem.writeFileString(input.args.at(-1)!, "x".repeat(large ? 30 : 10));
                return output();
              }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
          }),
        ),
      ),
  );

  it.effect(
    "while watched, converts again when the file or a file it links changes, until it is closed",
    () => {
      const runs: Array<RunInput> = [];
      const run: Run = (input) =>
        Effect.sync(() => runs.push(input)).pipe(Effect.andThen(writeGlb(input)));
      return Effect.gen(function* () {
        const { watcher, opened, closed, signal } = yield* makeWatcher;
        yield* Effect.gen(function* () {
          const { root, path, fileSystem } = yield* workspace;
          const assembly = yield* fileSystem.realPath(path.join(root, "assembly.blend"));
          const parts = yield* fileSystem.realPath(path.join(root, "parts-5.blend"));
          const live = yield* startConversion(
            { cwd: root, relativePath: "assembly.blend" },
            "watch",
          );
          const statuses = (count: number) =>
            Effect.forEach(Array.from({ length: count }), () => Queue.take(live.progress));

          expect((yield* statuses(2)).map(({ status }) => status)).toEqual(["converting", "ready"]);
          expect(yield* Queue.take(opened)).toEqual([assembly, parts]);

          // Something else in the folder: nothing tracked changed, so nothing converts.
          yield* signal;
          yield* touchFile(assembly, Date.UTC(2031, 0, 1));
          yield* signal;
          expect((yield* Queue.take(closed)).length).toBe(2);
          expect(yield* statuses(2)).toEqual([
            expect.objectContaining({ status: "converting", changed: "assembly.blend" }),
            expect.objectContaining({ status: "ready", cached: false, changed: "assembly.blend" }),
          ]);

          yield* Queue.take(opened);
          yield* touchFile(parts, Date.UTC(2031, 0, 2));
          yield* signal;
          yield* Queue.take(closed);
          expect(yield* statuses(2)).toEqual([
            expect.objectContaining({ status: "converting", changed: "parts-5.blend" }),
            expect.objectContaining({ status: "ready", changed: "parts-5.blend" }),
          ]);
          expect(runs).toHaveLength(3);

          // Closing the preview ends the subscription, and with it the watch.
          yield* Queue.take(opened);
          yield* Fiber.interrupt(live.fiber);
          expect(yield* Queue.take(closed)).toEqual([assembly, parts]);
        }).pipe(Effect.provide(layerFor({ run, watcher })));
      });
    },
  );

  it.effect(
    "converts again at once when the file was saved while it converted, keeping nothing of it",
    () => {
      const release = Deferred.makeUnsafe<void>();
      const run: Run = (input) => Deferred.await(release).pipe(Effect.andThen(writeGlb(input)));
      return Effect.gen(function* () {
        const { root, path, fileSystem } = yield* workspace;
        const live = yield* startConversion({ cwd: root, relativePath: "bracket.blend" }, "watch");
        expect((yield* Queue.take(live.progress)).status).toBe("converting");
        yield* touchFile(path.join(root, "bracket.blend"), Date.UTC(2031, 0, 1));
        yield* Deferred.succeed(release, undefined);
        // The export was of neither version, so it is neither shown nor cached.
        expect(yield* Queue.take(live.progress)).toEqual(
          expect.objectContaining({ status: "converting", changed: "bracket.blend" }),
        );
        expect((yield* Queue.take(live.progress)).status).toBe("ready");
        const cached = (yield* fileSystem.readDirectory(yield* cacheDirectory)).filter((name) =>
          name.endsWith(".glb"),
        );
        expect(cached).toHaveLength(1);
        yield* Fiber.interrupt(live.fiber);
      }).pipe(Effect.provide(layerFor({ run })));
    },
  );

  it.effect(
    "converts a file replaced with one of the same size and time, never the cached one",
    () =>
      Effect.gen(function* () {
        const { root, path, fileSystem } = yield* workspace;
        const file = path.join(root, "bracket.blend");
        const at = Date.UTC(2031, 0, 1);
        yield* touchFile(file, at);
        const input = { cwd: root, relativePath: "bracket.blend" };
        expect(yield* convertAll(input)).toEqual(["converting", "ready"]);
        // A checkout writes another file in its place, with the same size and time.
        const replacement = path.join(root, "bracket.blend.new");
        yield* fileSystem.copyFile(file, replacement);
        yield* touchFile(replacement, at);
        yield* fileSystem.rename(replacement, file);
        expect(yield* convertAll(input)).toEqual(["converting", "ready"]);
        // A once-only conversion converts it, and hears of no change after.
        const once = yield* startConversion({ ...input, once: true }, "watch");
        expect((yield* Queue.take(once.progress)).status).toBe("ready");
        yield* Fiber.join(once.fiber);
      }).pipe(Effect.provide(layerFor({ run: writeGlb }))),
  );

  it.effect(
    "converts a file saved past the size limit only when asked, judged by its size now",
    () =>
      Effect.gen(function* () {
        const { root, path, fileSystem } = yield* workspace;
        const byteLength = BLEND_LARGE_FILE_BYTES + 1;
        yield* fileSystem.truncate(path.join(root, "bracket.blend"), byteLength);
        const input = { cwd: root, relativePath: "bracket.blend" };
        const watched = yield* startConversion(input, "watch");
        expect(yield* Queue.take(watched.progress)).toEqual({ status: "large", byteLength });
        yield* Fiber.join(watched.fiber);
        expect(yield* convertAll(input)).toEqual(["converting", "ready"]);
      }).pipe(Effect.provide(layerFor({ run: writeGlb }))),
  );

  it.effect("keeps watching a file that is missing for a moment while it is saved", () =>
    Effect.gen(function* () {
      const { watcher, opened, signal } = yield* makeWatcher;
      yield* Effect.gen(function* () {
        const { root, path, fileSystem } = yield* workspace;
        const bracket = path.join(root, "bracket.blend");
        const live = yield* startConversion({ cwd: root, relativePath: "bracket.blend" }, "watch");
        yield* Queue.take(live.progress);
        expect((yield* Queue.take(live.progress)).status).toBe("ready");
        yield* Queue.take(opened);

        const saved = yield* fileSystem.readFile(bracket);
        yield* fileSystem.remove(bracket);
        yield* signal;
        expect((yield* Queue.take(live.progress)).status).toBe("failed");

        // The watch compares against the missing file now, so only its return converts again.
        yield* Queue.take(opened);
        yield* fileSystem.writeFile(bracket, saved);
        yield* signal;
        expect(yield* Queue.take(live.progress)).toEqual(
          expect.objectContaining({ status: "converting", changed: "bracket.blend" }),
        );
        expect((yield* Queue.take(live.progress)).status).toBe("ready");
        yield* Fiber.interrupt(live.fiber);
      }).pipe(Effect.provide(layerFor({ run: writeGlb, watcher })));
    }),
  );

  it.effect(
    "converts again when the save that failed a round finishes before the watch reopens",
    () =>
      Effect.gen(function* () {
        const { watcher, opened, signal } = yield* makeWatcher;
        yield* Effect.gen(function* () {
          const { root, path, fileSystem } = yield* workspace;
          const bracket = path.join(root, "bracket.blend");
          const saved = yield* fileSystem.readFile(bracket);
          const conversion = yield* BlendConversion.BlendConversion;
          const progress = yield* Queue.unbounded<BlendConversionStatus>();
          const live = yield* conversion
            .watch({ cwd: root, relativePath: "bracket.blend" }, (status) =>
              // The save lands while the failed round reports, before anything is watched again.
              (status.status === "failed"
                ? fileSystem.writeFile(bracket, saved).pipe(Effect.orDie)
                : Effect.void
              ).pipe(Effect.andThen(Queue.offer(progress, status)), Effect.asVoid),
            )
            .pipe(Effect.forkChild);
          yield* Queue.take(progress);
          expect((yield* Queue.take(progress)).status).toBe("ready");
          yield* Queue.take(opened);

          yield* fileSystem.remove(bracket);
          yield* signal;
          expect((yield* Queue.take(progress)).status).toBe("failed");
          expect(yield* Queue.take(progress)).toEqual(
            expect.objectContaining({ status: "converting", changed: "bracket.blend" }),
          );
          yield* Fiber.interrupt(live);
        }).pipe(Effect.provide(layerFor({ run: writeGlb, watcher })));
      }),
  );

  it.effect("never watches a linked library among the server's own files", () =>
    Effect.gen(function* () {
      const { watcher, opened } = yield* makeWatcher;
      yield* Effect.gen(function* () {
        const { root, path, fileSystem } = yield* workspace;
        const config = yield* ServerConfig.ServerConfig;
        yield* fileSystem.makeDirectory(config.secretsDir, { recursive: true });
        const secret = path.join(config.secretsDir, "parts-5.blend");
        yield* fileSystem.rename(path.join(root, "parts-5.blend"), secret);
        yield* fileSystem.symlink(secret, path.join(root, "parts-5.blend"));
        const assembly = yield* fileSystem.realPath(path.join(root, "assembly.blend"));
        const live = yield* startConversion({ cwd: root, relativePath: "assembly.blend" }, "watch");
        expect(yield* Queue.take(opened)).toEqual([assembly]);
        yield* Fiber.interrupt(live.fiber);
      }).pipe(Effect.provide(layerFor({ run: writeGlb, watcher })));
    }),
  );

  it.effect("stops watching a file it cannot convert", () =>
    Effect.gen(function* () {
      const { root } = yield* workspace;
      const conversion = yield* BlendConversion.BlendConversion;
      const seen: Array<BlendConversionStatus> = [];
      yield* conversion.watch({ cwd: root, relativePath: "bracket.blend" }, (status) =>
        Effect.sync(() => seen.push(status)),
      );
      expect(seen).toEqual([{ status: "unavailable", reason: "noBlender" }]);
    }).pipe(Effect.provide(layerFor({ run: () => Effect.die("never"), blender: null }))),
  );
});
