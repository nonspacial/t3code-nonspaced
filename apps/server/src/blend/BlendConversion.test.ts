import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as BlendConversion from "./BlendConversion.ts";
import { blendCacheDir } from "./blendCache.ts";
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

/** Writes a small GLB where Blender would, as a finished export does. */
const writeGlb = (input: RunInput) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(input.args.at(-1)!, "0123456789");
    return output();
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

const layerFor = (options: {
  readonly run: Run;
  readonly blender?: BlenderDetection.DetectedBlender | null;
  readonly known?: boolean;
  readonly cacheMaxBytes?: number;
}) =>
  BlendConversion.layerWith({ cacheMaxBytes: options.cacheMaxBytes ?? 1024 * 1024 }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProcessRunner.ProcessRunner)({ run: options.run }),
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
    const seen: Array<BlendConversion.BlendConversionProgress> = [];
    yield* conversion.convert(input, (progress) => Effect.sync(() => seen.push(progress)));
    return seen.map(({ status }) => status);
  });

/** Starts a conversion whose progress arrives on a queue. */
const startConversion = (
  input: Parameters<BlendConversion.BlendConversion["Service"]["convert"]>[0],
) =>
  Effect.gen(function* () {
    const conversion = yield* BlendConversion.BlendConversion;
    const progress = yield* Queue.unbounded<BlendConversion.BlendConversionProgress>();
    const fiber = yield* conversion
      .convert(input, (value) => Queue.offer(progress, value).pipe(Effect.asVoid))
      .pipe(Effect.forkChild);
    return { progress, fiber };
  });

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

        const conversion = yield* BlendConversion.BlendConversion;
        const hits: Array<BlendConversion.BlendConversionProgress> = [];
        yield* conversion.convert(input, (progress) => Effect.sync(() => hits.push(progress)));
        expect(hits).toEqual([expect.objectContaining({ status: "ready", cached: true })]);
        expect(runs).toHaveLength(1);
        // The work folder, with Blender's temp files and config, is gone.
        expect(
          (yield* fileSystem.readDirectory(cacheDir)).filter((name) => name.startsWith(".")),
        ).toEqual([]);

        yield* fileSystem.utimes(
          path.join(root, "parts-5.blend"),
          Date.UTC(2031, 0, 1),
          Date.UTC(2031, 0, 1),
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

  it.effect("reports a slow, failed or impossible conversion", () =>
    Effect.gen(function* () {
      const { root, outside, path } = yield* workspace;
      const input = { cwd: root, relativePath: "bracket.blend" };
      const progress = (layer: ReturnType<typeof layerFor>, value = input) =>
        Effect.gen(function* () {
          const conversion = yield* BlendConversion.BlendConversion;
          const seen: Array<BlendConversion.BlendConversionProgress> = [];
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
            if (progress.status === "ready") names[relativePath] = progress.cacheFileName;
          }),
        );
      }
      // Each GLB is 10 bytes and the cap holds two: the assembly was used again, the bracket not.
      expect((yield* fileSystem.readDirectory(yield* cacheDirectory)).toSorted()).toEqual(
        [names["assembly.blend"], names["bracket-4.blend"]].toSorted(),
      );
    }).pipe(Effect.provide(layerFor({ run: writeGlb, cacheMaxBytes: 25 }))),
  );
});
