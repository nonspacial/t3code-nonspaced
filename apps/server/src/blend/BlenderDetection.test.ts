// @effect-diagnostics nodeBuiltinImport:off - the tests write stand-in Blender scripts to a temp folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BlenderDetection from "./BlenderDetection.ts";

const tempDir = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-blender-detect-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

const standIn = (dir: string, name: string, body: string) => {
  const file = NodePath.join(dir, name);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
};

const find = (input: {
  readonly path: string;
  readonly home: string;
  readonly blenderPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const detection = yield* BlenderDetection.BlenderDetection;
    return yield* detection.find;
  }).pipe(
    Effect.provide(
      BlenderDetection.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ProcessRunner.layer,
            ServerSettings.ServerSettingsService.layerTest({
              blenderPath: input.blenderPath ?? "",
            }),
            // Not Linux, so Blender installed on the machine running the tests stays out of it.
            Layer.succeed(HostProcess.Platform, input.platform ?? "darwin"),
            Layer.succeed(HostProcess.Environment, { ...input.env, PATH: input.path }),
            Layer.succeed(HostProcess.HomeDirectory, input.home),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("BlenderDetection", () => {
  it.each([
    ["Blender 4.5.3 LTS\n\tbuild date: 2025-09-01", "4.5.3"],
    ["Blender 5.3.0\n", "5.3.0"],
    ["Read prefs\nBlender 3.6\n", "3.6"],
    ["Not Blender", null],
  ])("reads the version from %j", (stdout, version) => {
    expect(BlenderDetection.parseBlenderVersion(stdout)).toBe(version);
  });

  it("looks in the usual install folders, newest Windows install first", () => {
    const join = (...segments: ReadonlyArray<string>) => segments.join("/");
    expect(
      BlenderDetection.blenderInstallCandidates({
        platform: "win32",
        homeDirectory: "C:/Users/me",
        env: { ProgramFiles: "D:/Apps" },
        join,
        windowsVersionFolders: ["Blender 4.2", "Blender 4.10", "notes", "Blender 3.6"],
      }),
    ).toEqual([
      "D:/Apps/Blender Foundation/Blender 4.10/blender.exe",
      "D:/Apps/Blender Foundation/Blender 4.2/blender.exe",
      "D:/Apps/Blender Foundation/Blender 3.6/blender.exe",
      "D:/Apps/Blender Foundation/Blender/blender.exe",
    ]);
    expect(
      BlenderDetection.blenderInstallCandidates({
        platform: "darwin",
        homeDirectory: "/Users/me",
        env: {},
        join,
        windowsVersionFolders: [],
      }),
    ).toEqual([
      "/Applications/Blender.app/Contents/MacOS/Blender",
      "/Users/me/Applications/Blender.app/Contents/MacOS/Blender",
    ]);
  });

  it("keeps T3's variables and Blender's settings overrides away from Blender", () => {
    expect(
      BlenderDetection.blenderEnvironment(
        { PATH: "/bin", T3CODE_HOME: "/t3", BLENDER_USER_CONFIG: "/desktop", HOME: "/h" },
        { TMPDIR: "/private" },
      ),
    ).toEqual({ PATH: "/bin", HOME: "/h", TMPDIR: "/private" });
  });

  it.live("finds a working Blender on PATH, skipping one that does not answer", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const broken = NodePath.join(dir, "broken");
      const working = NodePath.join(dir, "working");
      standIn(broken, "blender", "exit 1");
      standIn(working, "blender", 'echo "Blender 4.5.3 LTS"');
      expect(yield* find({ path: `${broken}:${working}`, home: dir })).toBeNull();
      expect(yield* find({ path: working, home: dir })).toEqual({
        path: NodePath.join(working, "blender"),
        version: "4.5.3",
      });

      // Not on PATH: found in an install folder.
      const installed = standIn(
        NodePath.join(dir, "Applications/Blender.app/Contents/MacOS"),
        "Blender",
        'echo "Blender 4.2.1 LTS"',
      );
      expect(yield* find({ path: "", home: dir }), "an install folder").toEqual({
        path: installed,
        version: "4.2.1",
      });
    }),
  );

  it.live("uses only the Blender path setting when it is set", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const onPath = NodePath.join(dir, "bin");
      standIn(onPath, "blender", 'echo "Blender 4.5.3"');
      const chosen = standIn(NodePath.join(dir, "chosen"), "my-blender", 'echo "Blender 5.3.0"');
      expect(yield* find({ path: onPath, home: dir, blenderPath: chosen })).toEqual({
        path: chosen,
        version: "5.3.0",
      });
      expect(
        yield* find({ path: onPath, home: dir, blenderPath: NodePath.join(dir, "missing") }),
      ).toBeNull();
      // A path typed as ~/… means the server's home, as in a shell.
      expect(yield* find({ path: onPath, home: dir, blenderPath: "~/chosen/my-blender" })).toEqual({
        path: chosen,
        version: "5.3.0",
      });
      // A bare name in the setting runs by its absolute place on PATH.
      expect(
        yield* find({ path: onPath, home: dir, blenderPath: "blender" }),
        "a bare name",
      ).toEqual({
        path: NodePath.join(onPath, "blender"),
        version: "4.5.3",
      });
    }),
  );
});
