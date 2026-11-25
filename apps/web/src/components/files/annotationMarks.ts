import type {
  PreviewAnnotationPoint,
  PreviewAnnotationRect,
  PreviewAnnotationRegionTarget,
  PreviewAnnotationStrokeTarget,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { strokePieces } from "./modelAnnotation";

type Point = PreviewAnnotationPoint;
type Size = { readonly width: number; readonly height: number };

const STROKE_WIDTH = 4;
const REGION_STROKE_WIDTH = 2;
const REGION_FILL_OPACITY = 0.1;
/** An arrow's head is this many stroke widths long, and at most half the arrow. */
const ARROW_HEAD_LENGTH = 4.5;
const ARROW_HEAD_SPREAD = 0.6;

/** The colours marks can be drawn in. Null is the theme's primary, read when a mark is drawn. */
export const MARK_COLORS = [
  { id: "theme", value: null, label: msg("Theme color") },
  { id: "red", value: "#ef4444", label: msg("Red", { $context: "annotation color" }) },
  { id: "amber", value: "#f59e0b", label: msg("Amber", { $context: "annotation color" }) },
  { id: "green", value: "#16a34a", label: msg("Green", { $context: "annotation color" }) },
  { id: "magenta", value: "#d946ef", label: msg("Magenta", { $context: "annotation color" }) },
] as const;
export type MarkColorId = (typeof MARK_COLORS)[number]["id"];

export type StrokeShape = "pen" | "line" | "arrow";

/** A mark as drawn: what the editor shows, the screenshot replays and the agent is sent. */
export type MarkDrawing =
  | {
      readonly kind: "region";
      readonly rect: PreviewAnnotationRect;
      readonly color: string;
      readonly filled: boolean;
    }
  | {
      readonly kind: StrokeShape;
      /** In drawing order: a line or an arrow runs from its first point to its last. */
      readonly points: ReadonlyArray<Point>;
      readonly color: string;
    };

/** One shape to paint, as SVG path data so the editor and the screenshot draw the same thing. */
export interface MarkPaint {
  readonly path: string;
  readonly color: string;
  /** Outline width; 0 draws no outline. */
  readonly line: number;
  /** Fill opacity; 0 fills nothing. */
  readonly fill: number;
}

const DIRECTIONS: ReadonlyArray<Point> = [
  { x: 1, y: 0 },
  { x: Math.SQRT1_2, y: Math.SQRT1_2 },
  { x: 0, y: 1 },
  { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
  { x: -1, y: 0 },
  { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
  { x: 0, y: -1 },
  { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
];

/** How far from `start` a ray can go before it leaves the view. */
function reachInside(start: Point, direction: Point, size: Size): number {
  const limit = (from: number, toward: number, extent: number) =>
    toward > 0 ? (extent - from) / toward : toward < 0 ? from / -toward : Infinity;
  return Math.min(
    limit(start.x, direction.x, size.width),
    limit(start.y, direction.y, size.height),
  );
}

/** The drag's end moved onto the nearest 45° step from its start, kept inside the view. */
export function snapToAngle(start: Point, end: Point, size: Size): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const step = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  const direction = DIRECTIONS[(step + 8) % 8]!;
  const reach = Math.min(
    Math.max(0, dx * direction.x + dy * direction.y),
    reachInside(start, direction, size),
  );
  return { x: start.x + direction.x * reach, y: start.y + direction.y * reach };
}

/** The far corner of the largest square the drag spans, kept inside the view. */
export function squareCorner(start: Point, end: Point, size: Size): Point {
  const signX = end.x < start.x ? -1 : 1;
  const signY = end.y < start.y ? -1 : 1;
  const side = Math.min(
    Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)),
    signX > 0 ? size.width - start.x : start.x,
    signY > 0 ? size.height - start.y : start.y,
  );
  return { x: start.x + signX * side, y: start.y + signY * side };
}

/** A pen stroke, or with Shift one straight segment from where it started. */
function penPoints(points: ReadonlyArray<Point>, straight: boolean): ReadonlyArray<Point> {
  const first = points[0];
  const last = points.at(-1);
  return straight && first && last && points.length > 2 ? [first, last] : points;
}

/** An arrowhead whose point is at `tip`, scaled with the stroke and never longer than half the arrow. */
export function arrowHead(tail: Point, tip: Point, width = STROKE_WIDTH) {
  const length = Math.hypot(tip.x - tail.x, tip.y - tail.y);
  const along =
    length === 0 ? { x: 1, y: 0 } : { x: (tip.x - tail.x) / length, y: (tip.y - tail.y) / length };
  const head = Math.min(width * ARROW_HEAD_LENGTH, length / 2);
  const spread = head * ARROW_HEAD_SPREAD;
  const base = { x: tip.x - along.x * head, y: tip.y - along.y * head };
  return {
    base,
    left: { x: base.x + along.y * spread, y: base.y - along.x * spread },
    right: { x: base.x - along.y * spread, y: base.y + along.x * spread },
  };
}

function strokePath(points: ReadonlyArray<Point>): string {
  const pieces = strokePieces(points);
  const last = pieces.at(-1);
  if (!last) return "";
  const curves = pieces
    .slice(0, -1)
    .map(({ control, to }) => ` Q ${control.x} ${control.y} ${to.x} ${to.y}`)
    .join("");
  return `M ${pieces[0]!.from.x} ${pieces[0]!.from.y}${curves} L ${last.to.x} ${last.to.y}`;
}

export function markPaint(mark: MarkDrawing): ReadonlyArray<MarkPaint> {
  if (mark.kind === "region") {
    const { x, y, width, height } = mark.rect;
    return [
      {
        path: `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`,
        color: mark.color,
        line: REGION_STROKE_WIDTH,
        fill: mark.filled ? REGION_FILL_OPACITY : 0,
      },
    ];
  }
  const tail = mark.points[0];
  const tip = mark.points.at(-1);
  const stroke = (path: string) => ({ path, color: mark.color, line: STROKE_WIDTH, fill: 0 });
  if (mark.kind === "pen" || !tail || !tip) return [stroke(strokePath(mark.points))];
  if (mark.kind === "line") return [stroke(`M ${tail.x} ${tail.y} L ${tip.x} ${tip.y}`)];
  const { base, left, right } = arrowHead(tail, tip);
  return [
    stroke(`M ${tail.x} ${tail.y} L ${base.x} ${base.y}`),
    {
      path: `M ${tip.x} ${tip.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`,
      color: mark.color,
      line: 0,
      fill: 1,
    },
  ];
}

function strokeBounds(points: ReadonlyArray<Point>): PreviewAnnotationRect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const padding = STROKE_WIDTH + 3;
  const left = Math.min(...xs) - padding;
  const top = Math.min(...ys) - padding;
  return {
    x: left,
    y: top,
    width: Math.max(...xs) + padding - left,
    height: Math.max(...ys) + padding - top,
  };
}

/** Every point a stroke's ink reaches, its arrowhead's corners included. */
function drawnPoints(drawing: Exclude<MarkDrawing, { kind: "region" }>): ReadonlyArray<Point> {
  const tail = drawing.points[0];
  const tip = drawing.points.at(-1);
  if (drawing.kind !== "arrow" || !tail || !tip) return drawing.points;
  const { left, right } = arrowHead(tail, tip);
  return [...drawing.points, left, right];
}

/**
 * The marks as the agent receives them. Lines and arrows are strokes; an arrow's points run from
 * its tip, so the first thing found along it is what it points at.
 */
export function markTargets(
  marks: ReadonlyArray<{ readonly id: string; readonly drawing: MarkDrawing }>,
) {
  const regions: PreviewAnnotationRegionTarget[] = [];
  const strokes: PreviewAnnotationStrokeTarget[] = [];
  for (const { id, drawing } of marks) {
    if (drawing.kind === "region") {
      regions.push({ id, rect: drawing.rect });
      continue;
    }
    strokes.push({
      id,
      color: drawing.color,
      width: STROKE_WIDTH,
      points: drawing.kind === "arrow" ? drawing.points.toReversed() : drawing.points,
      bounds: strokeBounds(drawnPoints(drawing)),
    });
  }
  return { regions, strokes };
}

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(
          1,
          Math.max(0, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared),
        );
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t));
}

function nearPath(point: Point, path: ReadonlyArray<Point>, reach: number): boolean {
  const [first, ...rest] = path;
  if (!first) return false;
  if (rest.length === 0) return Math.hypot(first.x - point.x, first.y - point.y) <= reach;
  let previous = first;
  for (const next of rest) {
    if (distanceToSegment(point, previous, next) <= reach) return true;
    previous = next;
  }
  return false;
}

function insideTriangle(point: Point, a: Point, b: Point, c: Point): boolean {
  const side = (from: Point, to: Point) =>
    (to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x);
  const sides = [side(a, b), side(b, c), side(c, a)];
  return sides.every((value) => value >= 0) || sides.every((value) => value <= 0);
}

/**
 * Whether the eraser at `point` touches the mark: a filled region anywhere inside, an outlined
 * one by its outline, a stroke along its line, and an arrow's head anywhere on it.
 */
export function touchesMark(mark: MarkDrawing, point: Point): boolean {
  const reach = STROKE_WIDTH + 4;
  if (mark.kind === "region") {
    const { x, y, width, height } = mark.rect;
    const inside = point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
    if (mark.filled) return inside;
    const outline = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
      { x, y },
    ];
    return nearPath(point, outline, reach);
  }
  if (nearPath(point, mark.points, reach)) return true;
  const tail = mark.points[0];
  const tip = mark.points.at(-1);
  if (mark.kind !== "arrow" || !tail || !tip) return false;
  const { left, right } = arrowHead(tail, tip);
  return insideTriangle(point, tip, left, right) || nearPath(point, [tip, left, right, tip], reach);
}

export type DrawTool = "draw" | "line" | "arrow" | "region";

/** A drag in progress: the pointer's path (a line's start and end), and whether Shift is held. */
export interface MarkDrag {
  readonly tool: DrawTool;
  readonly points: ReadonlyArray<Point>;
  readonly straight: boolean;
  readonly color: string;
  readonly filled: boolean;
}

const MIN_MARK_SIZE = 3;

/** What a drag draws, with Shift's straightening applied. */
export function dragDrawing(drag: MarkDrag, size: Size): MarkDrawing {
  const { tool, points, straight, color } = drag;
  if (tool === "draw") return { kind: "pen", points: penPoints(points, straight), color };
  const start = points[0] ?? { x: 0, y: 0 };
  const end = points.at(-1) ?? start;
  if (tool === "region") {
    const corner = straight ? squareCorner(start, end, size) : end;
    return {
      kind: "region",
      rect: {
        x: Math.min(start.x, corner.x),
        y: Math.min(start.y, corner.y),
        width: Math.abs(corner.x - start.x),
        height: Math.abs(corner.y - start.y),
      },
      color,
      filled: drag.filled,
    };
  }
  return { kind: tool, points: [start, straight ? snapToAngle(start, end, size) : end], color };
}

/** A click that barely moved draws no region, line or arrow. A pen's dot still counts. */
export function isTooSmall(drawing: MarkDrawing): boolean {
  if (drawing.kind === "region")
    return drawing.rect.width < MIN_MARK_SIZE || drawing.rect.height < MIN_MARK_SIZE;
  if (drawing.kind === "pen") return false;
  const [start, end] = drawing.points;
  return !start || !end || Math.hypot(end.x - start.x, end.y - start.y) < MIN_MARK_SIZE;
}
