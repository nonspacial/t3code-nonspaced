import type {
  PreviewAnnotationCameraView,
  PreviewAnnotationHit,
  PreviewAnnotationPayload,
  PreviewAnnotationPoint,
  PreviewAnnotationRect,
  PreviewAnnotationRegionTarget,
  PreviewAnnotationStrokeTarget,
} from "@t3tools/contracts";
import type { ViewSample } from "@t3tools/client-runtime/model/preview-scene";
import { formatModelViewHash } from "@t3tools/shared/modelView";

type Size = { readonly width: number; readonly height: number };

const REGION_GRID = 5;
const STROKE_SAMPLES = 24;

/** A file link that opens the preview at this camera. Parentheses would end a markdown link. */
export function modelFileLink(path: string, view: PreviewAnnotationCameraView): string {
  const encoded = path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[()]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
  return `${encoded}${formatModelViewHash(view)}`;
}

/**
 * Where to look for what a mark covers, as fractions of the view. A mark's middle comes first; a
 * circle drawn around something has it there. Then the rest of a region, or the line of a drawing.
 */
export function markSamples(
  bounds: PreviewAnnotationRect,
  size: Size,
  points?: ReadonlyArray<PreviewAnnotationPoint>,
): ViewSample[] {
  const toSample = (x: number, y: number) => ({
    x: Math.min(1, Math.max(0, x / size.width)),
    y: Math.min(1, Math.max(0, y / size.height)),
  });
  const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  if (points) {
    const step = Math.max(1, points.length / STROKE_SAMPLES);
    const along: ViewSample[] = [];
    for (let index = 0; index < points.length; index += step) {
      const point = points[Math.floor(index)]!;
      along.push(toSample(point.x, point.y));
    }
    return [toSample(centre.x, centre.y), ...along];
  }
  const grid: PreviewAnnotationPoint[] = [];
  for (let row = 0; row < REGION_GRID; row += 1)
    for (let column = 0; column < REGION_GRID; column += 1)
      grid.push({
        x: bounds.x + ((column + 0.5) / REGION_GRID) * bounds.width,
        y: bounds.y + ((row + 0.5) / REGION_GRID) * bounds.height,
      });
  const distance = (point: PreviewAnnotationPoint) =>
    Math.hypot(point.x - centre.x, point.y - centre.y);
  grid.sort((left, right) => distance(left) - distance(right));
  return [toSample(centre.x, centre.y), ...grid.map((point) => toSample(point.x, point.y))];
}

/** An annotation drawn on a 3D view, in the shape browser-preview annotations already reach chat. */
export function modelAnnotationPayload(input: {
  readonly id: string;
  readonly name: string;
  /** The model's path for a link back to this view; null for an attachment. */
  readonly linkPath: string | null;
  readonly comment: string;
  readonly regions: ReadonlyArray<PreviewAnnotationRegionTarget>;
  readonly strokes: ReadonlyArray<PreviewAnnotationStrokeTarget>;
  /** The view's size in CSS pixels, which the marks are measured in. */
  readonly size: Size;
  readonly hitAt: (samples: ReadonlyArray<ViewSample>) => PreviewAnnotationHit | null;
  readonly screenshot: {
    readonly dataUrl: string;
    readonly width: number;
    readonly height: number;
  };
  readonly cameraView: PreviewAnnotationCameraView;
  readonly createdAt: string;
}): PreviewAnnotationPayload {
  const withHit = <Mark extends object>(mark: Mark, samples: ViewSample[]) => {
    const hit = input.hitAt(samples);
    return hit ? { ...mark, hit } : mark;
  };
  return {
    id: input.id,
    pageUrl: input.linkPath === null ? input.name : modelFileLink(input.linkPath, input.cameraView),
    pageTitle: input.name,
    comment: input.comment.trim(),
    elements: [],
    regions: input.regions.map((region) => withHit(region, markSamples(region.rect, input.size))),
    strokes: input.strokes.map((stroke) =>
      withHit(stroke, markSamples(stroke.bounds, input.size, stroke.points)),
    ),
    styleChanges: [],
    screenshot: {
      ...input.screenshot,
      cropRect: { x: 0, y: 0, width: input.size.width, height: input.size.height },
    },
    cameraView: input.cameraView,
    createdAt: input.createdAt,
  };
}
