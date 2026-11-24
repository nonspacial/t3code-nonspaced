import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

export interface DetectedBlender {
  readonly path: string;
  /** Such as "4.5.3". */
  readonly version: string;
}

/**
 * Finds the environment's Blender: the `blenderPath` setting when set, otherwise PATH and then
 * Blender's usual install folders.
 */
export class BlenderDetection extends Context.Service<
  BlenderDetection,
  { readonly find: Effect.Effect<DetectedBlender | null> }
>()("t3/blend/BlenderDetection") {}

/** `blender --version` starts with a line such as "Blender 4.5.3 LTS". */
export const parseBlenderVersion = (stdout: string): string | null =>
  /^Blender (\d+\.\d+(?:\.\d+)?)/m.exec(stdout)?.[1] ?? null;

/** Where installers and package managers put Blender when it is not on PATH. */
export const blenderInstallCandidates = (input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly join: (...segments: ReadonlyArray<string>) => string;
  /** Folder names under `Blender Foundation`, such as "Blender 4.5", on Windows. */
  readonly windowsVersionFolders: ReadonlyArray<string>;
}): ReadonlyArray<string> => {
  const { join, homeDirectory } = input;
  switch (input.platform) {
    case "darwin":
      return [
        "/Applications/Blender.app/Contents/MacOS/Blender",
        join(homeDirectory, "Applications/Blender.app/Contents/MacOS/Blender"),
      ];
    case "win32": {
      const programFiles = input.env.ProgramFiles ?? "C:\\Program Files";
      const foundation = join(programFiles, "Blender Foundation");
      const newestFirst = input.windowsVersionFolders
        .map((folder) => ({ folder, match: /^Blender (\d+)\.(\d+)$/.exec(folder) }))
        .filter((entry) => entry.match !== null)
        .toSorted(
          (a, b) =>
            Number(b.match![1]) - Number(a.match![1]) || Number(b.match![2]) - Number(a.match![2]),
        );
      return [
        ...newestFirst.map(({ folder }) => join(foundation, folder, "blender.exe")),
        join(foundation, "Blender", "blender.exe"),
      ];
    }
    default:
      return [
        "/usr/local/bin/blender",
        "/usr/bin/blender",
        "/snap/bin/blender",
        "/opt/blender/blender",
        join(homeDirectory, ".local/share/flatpak/exports/bin/org.blender.Blender"),
        "/var/lib/flatpak/exports/bin/org.blender.Blender",
      ];
  }
};

/** Blender runs with the server's environment minus T3's own variables and Blender overrides. */
export const blenderEnvironment = (
  parent: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(parent).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith("T3CODE_") &&
        !entry[0].startsWith("BLENDER_USER_"),
    ),
  ),
  ...extra,
});

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const settings = yield* ServerSettings.ServerSettingsService;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const lookupContext = yield* Effect.context<Path.Path | FileSystem.FileSystem>();
  // `--version` starts Blender, so each binary is asked once per modification.
  const versions = new Map<string, string | null>();

  const versionOf = Effect.fnUntraced(function* (candidate: string) {
    const info = yield* fileSystem.stat(candidate).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") return null;
    const key = `${candidate}\0${info.value.mtime._tag === "Some" ? info.value.mtime.value.getTime() : ""}`;
    const known = versions.get(key);
    if (known !== undefined) return known;
    const version = yield* runner
      .run({
        command: candidate,
        args: ["--version"],
        env: blenderEnvironment(environment),
        timeout: "30 seconds",
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((output) => (output.code === 0 ? parseBlenderVersion(output.stdout) : null)),
        Effect.orElseSucceed(() => null),
      );
    versions.set(key, version);
    return version;
  });

  const find: BlenderDetection["Service"]["find"] = Effect.gen(function* () {
    const configured = yield* settings.getSettings.pipe(
      Effect.map((current) => current.blenderPath),
      Effect.orElseSucceed(() => ""),
    );
    const candidates =
      configured !== ""
        ? [configured]
        : [
            yield* resolveCommandPath("blender").pipe(Effect.provideContext(lookupContext)),
            ...blenderInstallCandidates({
              platform,
              homeDirectory,
              env: environment,
              join: path.join,
              windowsVersionFolders:
                platform === "win32"
                  ? yield* fileSystem
                      .readDirectory(
                        path.join(
                          environment.ProgramFiles ?? "C:\\Program Files",
                          "Blender Foundation",
                        ),
                      )
                      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
                  : [],
            }),
          ];
    for (const candidate of new Set(candidates)) {
      if (candidate === null) continue;
      const version = yield* versionOf(candidate);
      if (version !== null) return { path: candidate, version };
    }
    return null;
  }).pipe(Effect.withSpan("BlenderDetection.find"));

  return BlenderDetection.of({ find });
});

export const layer = Layer.effect(BlenderDetection, make);
