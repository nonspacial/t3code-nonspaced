import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as HiddenDisplayBinary from "./HiddenDisplayBinary.ts";

const writeBinary = Effect.fn(function* (binaryPath: string, mode: number) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(binaryPath), { recursive: true });
  yield* fileSystem.writeFileString(binaryPath, "binary");
  yield* fileSystem.chmod(binaryPath, mode);
});

const makeService = (
  projectDirectory: string,
  baseDir: string,
  host: {
    readonly platform: NodeJS.Platform;
    readonly libc?: "gnu" | "musl";
    readonly env?: NodeJS.ProcessEnv;
    readonly configPath?: string;
  },
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* HiddenDisplayBinary.make().pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        ...config,
        hiddenDisplayPath: host.configPath,
      }),
    );
  }).pipe(
    Effect.provide(ServerConfig.layerTest(projectDirectory, baseDir)),
    Effect.provideService(HostProcess.Platform, host.platform),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provideService(HostProcess.LinuxLibc, host.libc ?? "gnu"),
    Effect.provideService(HostProcess.Environment, host.env ?? {}),
  );

describe("HiddenDisplayBinary", () => {
  it.effect("prefers the environment override, then the desktop app's path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hidden-display-" });
      const envPath = `${baseDir}/env/t3-hidden-display`;
      const desktopPath = `${baseDir}/desktop/t3-hidden-display`;
      yield* writeBinary(envPath, 0o755);
      yield* writeBinary(desktopPath, 0o755);

      const both = yield* makeService(process.cwd(), baseDir, {
        platform: "linux",
        env: { T3CODE_HIDDEN_DISPLAY_PATH: envPath },
        configPath: desktopPath,
      });
      assert.equal(yield* both.resolve, envPath);

      const desktopOnly = yield* makeService(process.cwd(), baseDir, {
        platform: "linux",
        configPath: desktopPath,
      });
      assert.equal(yield* desktopOnly.resolve, desktopPath);

      const notExecutable = `${baseDir}/plain/t3-hidden-display`;
      yield* writeBinary(notExecutable, 0o644);
      const rejected = yield* makeService(process.cwd(), baseDir, {
        platform: "linux",
        env: { T3CODE_HIDDEN_DISPLAY_PATH: notExecutable },
      });
      assert.instanceOf(
        yield* Effect.flip(rejected.resolve),
        HiddenDisplayBinary.HiddenDisplayBinaryNotExecutable,
        "a non-executable binary is rejected",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["release", "debug"])(
    "resolves a cargo %s binary from the built server layout",
    (profile) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-hidden-display-",
        });
        const projectDirectory = path.join(baseDir, "repo");
        const distDirectory = path.join(projectDirectory, "apps", "server", "dist");
        const binaryPath = path.join(
          projectDirectory,
          "native/hidden-display/target",
          profile,
          "t3-hidden-display",
        );
        yield* fileSystem.makeDirectory(distDirectory, { recursive: true });
        yield* writeBinary(binaryPath, 0o755);

        const service = yield* makeService(projectDirectory, baseDir, { platform: "linux" }).pipe(
          // The bundled module lives in dist rather than src/hostedBlender.
          Effect.provideService(Path.Path, {
            ...path,
            resolve: (...segments) =>
              path.resolve(
                ...segments.map((segment) =>
                  segment === import.meta.dirname ? distDirectory : segment,
                ),
              ),
          }),
        );
        assert.equal(yield* service.resolve, binaryPath);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves the helper staged beside the standalone CLI", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hidden-display-" });
      const cliDirectory = path.join(baseDir, "t3-linux-x64");
      const binaryPath = path.join(cliDirectory, "hidden-display/linux-x64/t3-hidden-display");
      yield* writeBinary(binaryPath, 0o755);

      const service = yield* makeService(baseDir, baseDir, { platform: "linux" }).pipe(
        Effect.provideService(Path.Path, {
          ...path,
          resolve: (...segments) =>
            path.resolve(
              ...segments.map((segment) =>
                segment === import.meta.dirname ? cliDirectory : segment,
              ),
            ),
        }),
      );
      assert.equal(yield* service.resolve, binaryPath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { platform: "darwin", libc: "gnu" },
    { platform: "win32", libc: "gnu" },
    { platform: "linux", libc: "musl" },
  ] as const)("is unsupported on $platform ($libc) without an override", (host) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hidden-display-" });
      const service = yield* makeService(process.cwd(), baseDir, host);
      const error = yield* Effect.flip(service.resolve);
      assert.instanceOf(error, HiddenDisplayBinary.HiddenDisplayBinaryUnsupported);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
