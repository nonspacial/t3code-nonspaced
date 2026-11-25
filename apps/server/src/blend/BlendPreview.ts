import {
  type BlendAttachmentPreviewInput,
  type BlendPreview as BlendPreviewResult,
  BlendPreviewError,
  type BlendPreviewInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { readFileRevision } from "../assets/MediaFile.ts";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  type BlendFileFacts,
  type BlendFileFormatError,
  isBlendFileFormatError,
  readBlendFileFacts,
} from "./blendFile.ts";
import { encodeRgbaPng } from "./png.ts";

/** No stored attachment has this id, or it could not be read. */
export class BlendAttachmentNotFoundError extends Schema.TaggedError<BlendAttachmentNotFoundError>()(
  "BlendAttachmentNotFoundError",
  {
    attachmentId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "The attachment could not be found.";
  }
}

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
    /** The same for an uploaded attachment, found the way its asset URL finds it. */
    readonly readAttachment: (
      input: BlendAttachmentPreviewInput,
    ) => Effect.Effect<BlendPreviewResult, BlendPreviewError>;
  }
>()("t3/blend/BlendPreview") {}

const toResult = (relativePath: string, facts: BlendFileFacts): BlendPreviewResult => {
  const { thumbnail, ...rest } = facts;
  return {
    ...rest,
    relativePath,
    thumbnail:
      thumbnail === null
        ? null
        : {
            width: thumbnail.width,
            height: thumbnail.height,
            dataUrl: `data:image/png;base64,${encodeRgbaPng(thumbnail.width, thumbnail.height, thumbnail.rgba).toString("base64")}`,
          },
  };
};

/** An attachment read's failure as the error clients get. */
const attachmentPreviewError =
  (attachmentId: string) =>
  (cause: BlendFileFormatError | BlendAttachmentNotFoundError): BlendPreviewError =>
    new BlendPreviewError({
      relativePath: attachmentId,
      failure:
        cause._tag === "BlendAttachmentNotFoundError"
          ? "attachment_not_found"
          : cause.problem === "too_large"
            ? "blend_file_too_large"
            : "unreadable_blend_file",
      cause,
    });

const make = Effect.gen(function* () {
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const config = yield* ServerConfig.ServerConfig;

  const read: BlendPreview["Service"]["read"] = Effect.fn("BlendPreview.read")(function* (input) {
    const target = yield* workspaceFileSystem.resolveReadPath(input);
    const revision = yield* readFileRevision(target.realPath);
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
    return toResult(target.relativePath, facts);
  });

  const readAttachment: BlendPreview["Service"]["readAttachment"] = Effect.fn(
    "BlendPreview.readAttachment",
  )(
    function* (input) {
      const attachmentPath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: input.attachmentId,
      });
      if (attachmentPath === null)
        return yield* new BlendAttachmentNotFoundError({ attachmentId: input.attachmentId });
      const revision = yield* readFileRevision(attachmentPath);
      const facts = yield* Effect.tryPromise({
        try: (signal) => readBlendFileFacts(attachmentPath, revision, signal),
        catch: (cause) =>
          isBlendFileFormatError(cause)
            ? cause
            : new BlendAttachmentNotFoundError({ attachmentId: input.attachmentId, cause }),
      });
      return toResult(input.attachmentId, facts);
    },
    (effect, input) => effect.pipe(Effect.mapError(attachmentPreviewError(input.attachmentId))),
  );

  return BlendPreview.of({ read, readAttachment });
});

export const layer = Layer.effect(BlendPreview, make);
