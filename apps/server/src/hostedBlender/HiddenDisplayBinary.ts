import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const EXECUTABLE = "t3-hidden-display";

export class HiddenDisplayBinaryUnsupported extends Schema.TaggedError<HiddenDisplayBinaryUnsupported>()(
  "HiddenDisplayBinaryUnsupported",
  {
    platform: Schema.String,
    architecture: Schema.String,
  },
) {
  override get message(): string {
    return `Hosted Blender's hidden display is unsupported on ${this.platform}/${this.architecture}.`;
  }
}

export class HiddenDisplayBinaryNotFound extends Schema.TaggedError<HiddenDisplayBinaryNotFound>()(
  "HiddenDisplayBinaryNotFound",
  {
    candidates: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return "The hidden display helper was not found.";
  }
}

export class HiddenDisplayBinaryNotExecutable extends Schema.TaggedError<HiddenDisplayBinaryNotExecutable>()(
  "HiddenDisplayBinaryNotExecutable",
  {
    path: Schema.String,
    mode: Schema.Number,
  },
) {
  override get message(): string {
    return `The hidden display helper at '${this.path}' is not executable.`;
  }
}

export type HiddenDisplayBinaryError =
  | HiddenDisplayBinaryUnsupported
  | HiddenDisplayBinaryNotFound
  | HiddenDisplayBinaryNotExecutable;

/**
 * Locates `native/hidden-display`, the helper that runs a hosted Blender on a hidden display.
 * @public The hosted Blender service consumes it.
 */
export class HiddenDisplayBinary extends Context.Service<
  HiddenDisplayBinary,
  {
    readonly resolve: Effect.Effect<string, HiddenDisplayBinaryError>;
  }
>()("t3/hostedBlender/HiddenDisplayBinary") {}

function rustTarget(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  linuxLibc: "gnu" | "musl" | undefined,
): string | undefined {
  if (platform !== "linux" || linuxLibc !== "gnu") return undefined;
  if (architecture === "x64") return "x86_64-unknown-linux-gnu";
  if (architecture === "arm64") return "aarch64-unknown-linux-gnu";
  return undefined;
}

export const make = Effect.fn("hostedBlender.hiddenDisplayBinary.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const linuxLibc = platform === "linux" ? yield* HostProcess.LinuxLibc : undefined;
  const target = rustTarget(platform, architecture, linuxLibc);
  const overrides = [environment.T3CODE_HIDDEN_DISPLAY_PATH, config.hiddenDisplayPath].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  // The desktop app passes `hiddenDisplayPath`; the standalone CLI ships the helper beside its
  // executable; a checkout has a cargo build of `native/hidden-display`.
  const bundled =
    target === undefined
      ? []
      : [
          path.resolve(import.meta.dirname, "hidden-display", `linux-${architecture}`, EXECUTABLE),
          path.resolve(import.meta.dirname, "hidden-display", EXECUTABLE),
          ...[
            path.resolve(import.meta.dirname, "../../../../native/hidden-display"),
            path.resolve(import.meta.dirname, "../../../native/hidden-display"),
          ].flatMap((crate) =>
            [path.join("target", target, "release"), "target/release", "target/debug"].map(
              (directory) => path.join(crate, directory, EXECUTABLE),
            ),
          ),
        ];
  const candidates = [...overrides, ...bundled];
  if (candidates.length === 0) {
    return HiddenDisplayBinary.of({
      resolve: Effect.fail(new HiddenDisplayBinaryUnsupported({ platform, architecture })),
    });
  }

  const resolve: HiddenDisplayBinary["Service"]["resolve"] = Effect.gen(function* () {
    for (const candidate of candidates) {
      const stat = yield* fileSystem.stat(candidate).pipe(Effect.option);
      if (Option.isNone(stat)) continue;
      if (stat.value.type === "Directory" || (stat.value.mode & 0o111) === 0) {
        return yield* new HiddenDisplayBinaryNotExecutable({
          path: candidate,
          mode: stat.value.mode,
        });
      }
      return candidate;
    }
    return yield* new HiddenDisplayBinaryNotFound({ candidates });
  });

  return HiddenDisplayBinary.of({ resolve });
});

/** @public */
export const layer = Layer.effect(HiddenDisplayBinary, make());
