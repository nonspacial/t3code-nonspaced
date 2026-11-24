import * as Schema from "effect/Schema";

const CODES = [
  "webgl-unavailable",
  "model-unreadable",
  "model-empty",
  "companion-missing",
] as const;

export type ModelPreviewErrorCode = (typeof CODES)[number];

const ENGLISH: Record<ModelPreviewErrorCode, string> = {
  "webgl-unavailable": "3D previews need WebGL, which is unavailable here.",
  "model-unreadable": "This 3D file is damaged or uses features the preview does not support.",
  "model-empty": "This 3D file has no geometry to show.",
  "companion-missing": "A file this model needs could not be found.",
};

/** A model the preview could not show; the window translates `code`, and `message` stays English for logs. */
export class ModelPreviewError extends Schema.TaggedError<ModelPreviewError>()(
  "ModelPreviewError",
  {
    code: Schema.Literals(CODES),
    /** Referenced files that could not be read, as the model names them. */
    missing: Schema.Array(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return ENGLISH[this.code];
  }
}

export const isModelPreviewError = Schema.is(ModelPreviewError);
