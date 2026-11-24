import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";
import { ProjectFileFailure, ProjectFileOperation, ProjectReadFileInput } from "./project.ts";

/** Like a file read: a workspace-relative path, or an absolute host path read in place. */
export const BlendPreviewInput = Schema.Struct({
  cwd: ProjectReadFileInput.fields.cwd,
  relativePath: ProjectReadFileInput.fields.relativePath,
});
export type BlendPreviewInput = typeof BlendPreviewInput.Type;

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
  Schema.Literal("unreadable_blend_file"),
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
    return this.failure === "unreadable_blend_file"
      ? `'${this.relativePath}' is not a .blend file, or it is damaged.`
      : `Could not read '${this.relativePath}' (${this.failure}).`;
  }
}

export const isBlendPreviewError = Schema.is(BlendPreviewError);
