import type { BlendPreview as BlendPreviewResult, BlendPreviewInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type BlendFileFormatError, isBlendFileFormatError, readBlendFile } from "./blendFile.ts";
import { encodeRgbaPng } from "./png.ts";

export class BlendPreview extends Context.Service<
  BlendPreview,
  {
    /** The saved thumbnail and scene facts, read without Blender. Never runs the file's scripts. */
    readonly read: (
      input: BlendPreviewInput,
    ) => Effect.Effect<
      BlendPreviewResult,
      | BlendFileFormatError
      | WorkspaceFileSystem.WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/blend/BlendPreview") {}

const make = Effect.gen(function* () {
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;

  const read: BlendPreview["Service"]["read"] = Effect.fn("BlendPreview.read")(function* (input) {
    const target = yield* workspaceFileSystem.resolveReadPath(input);
    const facts = yield* Effect.tryPromise({
      try: () => readBlendFile(target.realPath),
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
    const { thumbnail, ...rest } = facts;
    return {
      ...rest,
      relativePath: target.relativePath,
      thumbnail:
        thumbnail === null
          ? null
          : {
              width: thumbnail.width,
              height: thumbnail.height,
              dataUrl: `data:image/png;base64,${encodeRgbaPng(thumbnail.width, thumbnail.height, thumbnail.rgba).toString("base64")}`,
            },
    };
  });

  return BlendPreview.of({ read });
});

export const layer = Layer.effect(BlendPreview, make);
