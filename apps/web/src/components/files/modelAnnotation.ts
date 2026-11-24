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
/** Casts along a drawing, this many CSS pixels apart until a long one reaches the cap below. */
const STROKE_SAMPLE_SPACING = 4;
const STROKE_SAMPLES = 128;
/** A drawing whose ends meet within this share of its box's diagonal is an outline. */
const CLOSED_LOOP_GAP = 0.25;
const CURVE_STEPS = 8;
/** Raycasting a large point cloud is slow; hits stop being looked for after this long. */
const HIT_BUDGET_MS = 100;

/** One piece of a drawn stroke: a quadratic curve, straight when its control is its start. */
export interface StrokePiece {
  readonly from: PreviewAnnotationPoint;
  readonly control: PreviewAnnotationPoint;
  readonly to: PreviewAnnotationPoint;
}

/**
 * The curve a stroke is drawn as: through the midpoints between pointer points, bending at each
 * point, then straight to the last one. The editor, the screenshot and the raycasts all follow it.
 */
export function strokePieces(points: ReadonlyArray<PreviewAnnotationPoint>): StrokePiece[] {
  const [first, ...rest] = points;
  if (!first) return [];
  const pieces: StrokePiece[] = [];
  let current = first;
  let previous = first;
  for (const point of rest) {
    const middle = { x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2 };
    pieces.push({ from: current, control: previous, to: middle });
    current = middle;
    previous = point;
  }
  pieces.push({ from: current, control: current, to: previous });
  return pieces;
}

function flattenStroke(points: ReadonlyArray<PreviewAnnotationPoint>): PreviewAnnotationPoint[] {
  const pieces = strokePieces(points);
  const line = pieces[0] ? [pieces[0].from] : [];
  for (const { from, control, to } of pieces)
    for (let step = 1; step <= CURVE_STEPS; step += 1) {
      const t = step / CURVE_STEPS;
      const a = (1 - t) * (1 - t);
      const b = 2 * (1 - t) * t;
      const c = t * t;
      line.push({
        x: a * from.x + b * control.x + c * to.x,
        y: a * from.y + b * control.y + c * to.y,
      });
    }
  return line;
}

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
 * Where to look for what a mark covers, as fractions of the view. A region or a closed loop tries
 * its middle first, since a circle drawn around something has it there; an open line tries only
 * the pixels it covers, because the middle of its box can be empty or a different part.
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
    const line = flattenStroke(points);
    // Pointer events are sparse on a fast stroke, so cast along each segment, not just at its ends.
    let length = 0;
    for (let index = 1; index < line.length; index += 1)
      length += Math.hypot(
        line[index]!.x - line[index - 1]!.x,
        line[index]!.y - line[index - 1]!.y,
      );
    const spacing = Math.max(STROKE_SAMPLE_SPACING, length / STROKE_SAMPLES);
    const along: ViewSample[] = [];
    let untilNext = 0;
    for (let index = 1; index < line.length; index += 1) {
      const from = line[index - 1]!;
      const to = line[index]!;
      const segment = Math.hypot(to.x - from.x, to.y - from.y);
      for (; untilNext <= segment; untilNext += spacing) {
        const t = segment === 0 ? 0 : untilNext / segment;
        along.push(toSample(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t));
      }
      untilNext -= segment;
    }
    const end = line.at(-1);
    if (end) along.push(toSample(end.x, end.y));
    const first = points[0];
    const last = points.at(-1);
    const gap = first && last ? Math.hypot(last.x - first.x, last.y - first.y) : 0;
    const closed = gap <= Math.hypot(bounds.width, bounds.height) * CLOSED_LOOP_GAP;
    return closed ? [toSample(centre.x, centre.y), ...along] : along;
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
  /** The clock the hit budget is measured on, in milliseconds. */
  readonly now?: () => number;
}): PreviewAnnotationPayload {
  const now = input.now ?? (() => performance.now());
  const deadline = now() + HIT_BUDGET_MS;
  const withHit = <Mark extends object>(mark: Mark, samples: ViewSample[]) => {
    for (const sample of samples) {
      if (now() >= deadline) return mark;
      const hit = input.hitAt([sample]);
      if (hit) return { ...mark, hit };
    }
    return mark;
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
