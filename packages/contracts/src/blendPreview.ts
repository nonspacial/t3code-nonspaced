import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectFileFailure, ProjectFileOperation, ProjectReadFileInput } from "./project.ts";

/** Like a file read: a workspace-relative path, or an absolute host path read in place. */
export const BlendPreviewInput = Schema.Struct({
  cwd: ProjectReadFileInput.fields.cwd,
  relativePath: ProjectReadFileInput.fields.relativePath,
});
export type BlendPreviewInput = typeof BlendPreviewInput.Type;

/** An uploaded attachment, by the same id its asset URL is minted from. */
export const BlendAttachmentPreviewInput = Schema.Struct({
  attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type BlendAttachmentPreviewInput = typeof BlendAttachmentPreviewInput.Type;

export const BlendPreviewThumbnail = Schema.Struct({
  width: NonNegativeInt,
  height: NonNegativeInt,
  /** A `data:image/png;base64,` URL. Blender writes it on save, so a scripted save can leave it stale. */
  dataUrl: Schema.String,
});
export type BlendPreviewThumbnail = typeof BlendPreviewThumbnail.Type;

export const BlendPreviewScene = Schema.Struct({
  name: Schema.String,
  frameStart: Schema.Int,
  frameEnd: Schema.Int,
});
export type BlendPreviewScene = typeof BlendPreviewScene.Type;

/** What a `.blend` shows without Blender: its saved thumbnail and scene facts. */
export const BlendPreview = Schema.Struct({
  relativePath: Schema.NonEmptyString,
  byteLength: NonNegativeInt,
  /** The Blender version that saved the file, such as "4.5". */
  blenderVersion: Schema.String,
  thumbnail: Schema.NullOr(BlendPreviewThumbnail),
  /** The scene the file was saved with open. */
  scene: Schema.NullOr(BlendPreviewScene),
  scenes: NonNegativeInt,
  objects: NonNegativeInt,
  meshes: NonNegativeInt,
  materials: NonNegativeInt,
  /** Linked library paths as saved; `//` starts a path relative to the file. */
  libraries: Schema.Array(Schema.String),
});
export type BlendPreview = typeof BlendPreview.Type;

export const BlendPreviewFailure = Schema.Union([
  ProjectFileFailure,
  Schema.Literals(["unreadable_blend_file", "blend_file_too_large", "attachment_not_found"]),
]);
export type BlendPreviewFailure = typeof BlendPreviewFailure.Type;

export class BlendPreviewError extends Schema.TaggedError<BlendPreviewError>()(
  "BlendPreviewError",
  {
    relativePath: Schema.NonEmptyString,
    failure: BlendPreviewFailure,
    resolvedPath: Schema.optional(Schema.NonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.failure) {
      case "unreadable_blend_file":
        return `'${this.relativePath}' is not a .blend file, or it is damaged.`;
      case "blend_file_too_large":
        return `'${this.relativePath}' is too large to read its details.`;
      case "attachment_not_found":
        return `Attachment '${this.relativePath}' is no longer available.`;
      default:
        return `Could not read '${this.relativePath}' (${this.failure}).`;
    }
  }
}

export const isBlendPreviewError = Schema.is(BlendPreviewError);

/** Converts a workspace `.blend` to GLB with the environment's Blender. */
export const BlendConversionInput = Schema.Struct({
  ...BlendPreviewInput.fields,
  /** Runs without the time limit, after a conversion was too slow. */
  keepTrying: Schema.optionalKey(Schema.Boolean),
  /** Converts again instead of answering from the cache. */
  refresh: Schema.optionalKey(Schema.Boolean),
});
export type BlendConversionInput = typeof BlendConversionInput.Type;

export const BlendConversionUnavailableReason = Schema.Literals([
  "noBlender",
  "newerBlender",
  "outsideWorkspace",
]);
export type BlendConversionUnavailableReason = typeof BlendConversionUnavailableReason.Type;

/** A conversion's progress, ending in `ready`, `slow`, `failed` or `unavailable`. */
export const BlendConversionStatus = Schema.Union([
  /** `ahead` counts the conversions before this one, the running one included. */
  Schema.Struct({ status: Schema.Literal("waiting"), ahead: NonNegativeInt }),
  Schema.Struct({
    status: Schema.Literal("converting"),
    blenderVersion: Schema.String,
    startedAt: Schema.Number,
  }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    /** A signed asset URL for the GLB. */
    relativeUrl: Schema.String,
    byteLength: NonNegativeInt,
    blenderVersion: Schema.String,
    convertedAt: Schema.Number,
    cached: Schema.Boolean,
  }),
  /** Stopped at the time limit; `keepTrying` runs it again without one. */
  Schema.Struct({ status: Schema.Literal("slow") }),
  Schema.Struct({ status: Schema.Literal("failed"), log: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: BlendConversionUnavailableReason,
    /** The environment's Blender, for `newerBlender`. */
    blenderVersion: Schema.optionalKey(Schema.String),
  }),
]);
export type BlendConversionStatus = typeof BlendConversionStatus.Type;
