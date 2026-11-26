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

/**
 * Converting loads the whole scene in a headless Blender, so a file larger than this converts
 * only when asked, once; its preview reads only the start of the file.
 */
export const BLEND_LARGE_FILE_BYTES = 512 * 1024 * 1024;

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
  /**
   * Only the start of the file was read, as for a large one: its size, version and thumbnail. The
   * scene, counts and libraries above weren't read.
   */
  partial: Schema.optionalKey(Schema.Boolean),
  /**
   * Over `BLEND_LARGE_FILE_BYTES` on disk or once inflated: a compressed file small on disk can
   * be large in Blender. It converts only when asked.
   */
  large: Schema.optionalKey(Schema.Boolean),
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
  /** Converts once, not again when the file changes: a large file converts only when asked. */
  once: Schema.optionalKey(Schema.Boolean),
});
export type BlendConversionInput = typeof BlendConversionInput.Type;

export const BlendConversionUnavailableReason = Schema.Literals([
  "noBlender",
  "newerBlender",
  "outsideWorkspace",
]);
export type BlendConversionUnavailableReason = typeof BlendConversionUnavailableReason.Type;

/** The name of the file whose change started this conversion: the `.blend` or a library it links. */
const changed = Schema.optionalKey(Schema.String);

/**
 * A conversion's progress, reaching `ready`, `slow`, `failed` or `unavailable`. A watched file
 * starts again, with `changed`, each time it or a library it links changes.
 */
export const BlendConversionStatus = Schema.Union([
  /** `ahead` counts the conversions before this one, the running one included. */
  Schema.Struct({ status: Schema.Literal("waiting"), ahead: NonNegativeInt, changed }),
  Schema.Struct({
    status: Schema.Literal("converting"),
    blenderVersion: Schema.String,
    startedAt: Schema.Number,
    changed,
  }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    changed,
    /** A signed asset URL for the GLB. */
    relativeUrl: Schema.String,
    byteLength: NonNegativeInt,
    blenderVersion: Schema.String,
    convertedAt: Schema.Number,
    cached: Schema.Boolean,
  }),
  /** Stopped at the time limit; `keepTrying` runs it again without one. */
  Schema.Struct({ status: Schema.Literal("slow") }),
  /**
   * Over `BLEND_LARGE_FILE_BYTES` on disk or once inflated, as the server last read it: a `once`
   * request converts it.
   */
  Schema.Struct({ status: Schema.Literal("large"), byteLength: NonNegativeInt }),
  Schema.Struct({ status: Schema.Literal("failed"), log: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: BlendConversionUnavailableReason,
    /** The environment's Blender, for `newerBlender`. */
    blenderVersion: Schema.optionalKey(Schema.String),
  }),
]);
export type BlendConversionStatus = typeof BlendConversionStatus.Type;
