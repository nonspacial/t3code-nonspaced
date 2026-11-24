import type {
  HostedBlenderFindHitsInput,
  HostedBlenderHits,
  HostedBlenderViewCapture,
  PreviewAnnotationPayload,
  PreviewAnnotationRegionTarget,
  PreviewAnnotationStrokeTarget,
} from "@t3tools/contracts";

import { markSamples, modelAnnotationPayload } from "../files/modelAnnotation";

const WORKING_COPY = /\.wip-[^/.]+\.blend$/i;

export type BlenderHitsRequest = Pick<HostedBlenderFindHitsInput, "projection" | "marks">;

/**
 * "hero.wip-a1b2.blend · Working copy", or "· Master" for any other file. Working copies are
 * named `<master>.wip-<thread>.blend`. The agent reads this title too, so it stays in English.
 */
export function blenderAnnotationTitle(relativePath: string): string {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  return `${name} · ${WORKING_COPY.test(name) ? "Working copy" : "Master"}`;
}

/**
 * An annotation of a frozen Blender pane frame. The camera is the viewport window's when the
 * frame froze; Blender casts each mark through that same view to find what it covers.
 * `findHits` is null when the frame isn't the viewport window alone, so marks can't be placed.
 */
export async function blenderAnnotationPayload(input: {
  readonly id: string;
  readonly relativePath: string;
  readonly comment: string;
  readonly regions: ReadonlyArray<PreviewAnnotationRegionTarget>;
  readonly strokes: ReadonlyArray<PreviewAnnotationStrokeTarget>;
  /** The frame's size in CSS pixels, which the marks are measured in. */
  readonly size: { readonly width: number; readonly height: number };
  readonly screenshot: {
    readonly dataUrl: string;
    readonly width: number;
    readonly height: number;
  };
  readonly capture: HostedBlenderViewCapture | null;
  readonly findHits: ((request: BlenderHitsRequest) => Promise<HostedBlenderHits | null>) | null;
  readonly createdAt: string;
}): Promise<PreviewAnnotationPayload> {
  const marks = [
    ...input.regions.map((region) => markSamples(region.rect, input.size)),
    ...input.strokes.map((stroke) => markSamples(stroke.bounds, input.size, stroke.points)),
  ];
  const found =
    input.capture && input.findHits && marks.length > 0
      ? await input.findHits({ projection: input.capture.projection, marks })
      : null;
  return modelAnnotationPayload({
    id: input.id,
    name: blenderAnnotationTitle(input.relativePath),
    linkPath: input.relativePath,
    comment: input.comment,
    regions: input.regions,
    strokes: input.strokes,
    size: input.size,
    hits: found && {
      regions: found.slice(0, input.regions.length),
      strokes: found.slice(input.regions.length),
    },
    screenshot: input.screenshot,
    cameraView: input.capture?.cameraView ?? null,
    createdAt: input.createdAt,
  });
}
