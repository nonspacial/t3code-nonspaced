import { describe, expect, it } from "vite-plus/test";

import {
  type MarkDrag,
  arrowHead,
  dragDrawing,
  isTooSmall,
  markPaint,
  markTargets,
  snapToAngle,
  squareCorner,
  touchesMark,
} from "./annotationMarks";
import { markSamples } from "./modelAnnotation";

const size = { width: 400, height: 300 };
const drag = (tool: MarkDrag["tool"], points: MarkDrag["points"], straight: boolean) =>
  dragDrawing({ tool, points, straight, color: "#ef4444", filled: true }, size);

describe("snapToAngle", () => {
  it.each([
    { end: { x: 300, y: 112 }, snapped: { x: 300, y: 100 }, step: "0°" },
    { end: { x: 110, y: 280 }, snapped: { x: 100, y: 280 }, step: "90°" },
    { end: { x: 190, y: 200 }, snapped: { x: 195, y: 195 }, step: "45°" },
    { end: { x: 10, y: 15 }, snapped: { x: 12.5, y: 12.5 }, step: "225°" },
  ])("moves a drag's end onto the $step step through its start", ({ end, snapped }) => {
    const point = snapToAngle({ x: 100, y: 100 }, end, size);
    expect(point.x).toBeCloseTo(snapped.x, 6);
    expect(point.y).toBeCloseTo(snapped.y, 6);
  });

  it("stops a snapped line at the edge of the view", () => {
    // The pointer's projection onto the diagonal lies below the view, so the line ends at its edge.
    const point = snapToAngle({ x: 300, y: 260 }, { x: 390, y: 300 }, size);
    expect(point.x).toBeCloseTo(340, 6);
    expect(point.y).toBeCloseTo(300, 6);
  });
});

describe("squareCorner", () => {
  it("spans the longer side of the drag in the drag's direction", () => {
    expect(squareCorner({ x: 100, y: 100 }, { x: 160, y: 120 }, size)).toEqual({ x: 160, y: 160 });
    expect(squareCorner({ x: 100, y: 100 }, { x: 80, y: 30 }, size)).toEqual({ x: 30, y: 30 });
  });

  it("stays inside the view", () => {
    expect(squareCorner({ x: 350, y: 100 }, { x: 390, y: 250 }, size)).toEqual({ x: 400, y: 150 });
  });
});

describe("dragDrawing", () => {
  const wobble = [
    { x: 10, y: 10 },
    { x: 30, y: 40 },
    { x: 60, y: 20 },
    { x: 90, y: 50 },
  ];

  it("draws the pen's path, or with Shift one straight segment from where it started", () => {
    expect(drag("draw", wobble, false)).toMatchObject({ kind: "pen", points: wobble });
    expect(drag("draw", wobble, true)).toMatchObject({
      kind: "pen",
      points: [wobble[0], wobble[3]],
    });
  });

  it("snaps a line or an arrow to 45° steps and a region to a square with Shift", () => {
    const start = { x: 100, y: 100 };
    const end = { x: 300, y: 130 };
    expect(drag("line", [start, end], false)).toMatchObject({ points: [start, end] });
    expect(drag("arrow", [start, end], true)).toMatchObject({
      kind: "arrow",
      points: [start, { x: 300, y: 100 }],
    });
    expect(drag("region", [start, end], false)).toMatchObject({
      rect: { x: 100, y: 100, width: 200, height: 30 },
    });
    expect(drag("region", [start, end], true)).toMatchObject({
      rect: { x: 100, y: 100, width: 200, height: 200 },
    });
  });

  it("drops a line, an arrow or a region that barely moved, but keeps a pen's dot", () => {
    const click = [
      { x: 50, y: 50 },
      { x: 51, y: 51 },
    ];
    expect(isTooSmall(drag("line", click, false))).toBe(true);
    expect(isTooSmall(drag("arrow", click, false))).toBe(true);
    expect(isTooSmall(drag("region", click, false))).toBe(true);
    expect(isTooSmall(drag("draw", [{ x: 50, y: 50 }], false))).toBe(false);
  });
});

describe("arrowHead", () => {
  it("puts the head's point at the tip, scaled with the stroke", () => {
    const head = arrowHead({ x: 0, y: 100 }, { x: 200, y: 100 }, 4);
    expect(head.base).toEqual({ x: 182, y: 100 });
    expect(head.left.x).toBeCloseTo(182, 6);
    expect(head.right.x).toBeCloseTo(182, 6);
    expect(Math.abs(head.left.y - head.right.y)).toBeCloseTo(2 * 18 * 0.6, 6);
  });

  it("keeps a short arrow's head to half its length", () => {
    expect(arrowHead({ x: 0, y: 0 }, { x: 10, y: 0 }, 4).base).toEqual({ x: 5, y: 0 });
  });
});

describe("markPaint", () => {
  it("paints an arrow as its shaft and a filled head ending at the tip", () => {
    const [shaft, head] = markPaint({
      kind: "arrow",
      points: [
        { x: 0, y: 100 },
        { x: 200, y: 100 },
      ],
      color: "#16a34a",
    });
    expect(shaft).toMatchObject({ path: "M 0 100 L 182 100", line: 4, fill: 0 });
    expect(head).toMatchObject({ color: "#16a34a", line: 0, fill: 1 });
    expect(head?.path.startsWith("M 200 100 ")).toBe(true);
  });

  it("fills a region only when it was drawn filled", () => {
    const rect = { x: 10, y: 20, width: 30, height: 40 };
    expect(markPaint({ kind: "region", rect, color: "#ef4444", filled: true })[0]?.fill).toBe(0.1);
    expect(markPaint({ kind: "region", rect, color: "#ef4444", filled: false })[0]?.fill).toBe(0);
  });
});

describe("markTargets", () => {
  it("sends a line and an arrow as strokes, the arrow's samples starting at its tip", () => {
    const tail = { x: 20, y: 150 };
    const tip = { x: 380, y: 150 };
    const { regions, strokes } = markTargets([
      { id: "stroke_1", drawing: { kind: "line", points: [tail, tip], color: "#ef4444" } },
      { id: "stroke_2", drawing: { kind: "arrow", points: [tail, tip], color: "#d946ef" } },
    ]);
    expect(regions).toEqual([]);
    expect(strokes.map((stroke) => stroke.color)).toEqual(["#ef4444", "#d946ef"]);

    const lineSamples = markSamples(strokes[0]!.bounds, size, strokes[0]!.points);
    // A two-point line is cast all along it, not only at its ends.
    expect(lineSamples.length).toBeGreaterThan(50);
    expect(lineSamples[0]).toEqual({ x: 20 / 400, y: 0.5 });
    expect(lineSamples.at(-1)).toEqual({ x: 380 / 400, y: 0.5 });

    const arrowSamples = markSamples(strokes[1]!.bounds, size, strokes[1]!.points);
    expect(arrowSamples[0]).toEqual({ x: 380 / 400, y: 0.5 });
    // The arrowhead is inside the box the agent is told the drawing covers.
    const box = strokes[1]!.bounds;
    expect(box.y).toBeLessThan(150 - 18 * 0.6);
    expect(box.y + box.height).toBeGreaterThan(150 + 18 * 0.6);
  });

  it("starts a short arrow's samples at its tip, not at the middle of its box", () => {
    const { strokes } = markTargets([
      {
        id: "stroke_1",
        drawing: {
          kind: "arrow",
          points: [
            { x: 100, y: 100 },
            { x: 104, y: 100 },
          ],
          color: "#d946ef",
        },
      },
    ]);
    const samples = markSamples(strokes[0]!.bounds, size, strokes[0]!.points);
    expect(samples[0]).toEqual({ x: 104 / 400, y: 100 / 300 });
  });
});

describe("touchesMark", () => {
  it("erases a straight line anywhere along it, not only at its ends", () => {
    const line = {
      kind: "line" as const,
      points: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
      ],
      color: "#ef4444",
    };
    expect(touchesMark(line, { x: 100, y: 5 })).toBe(true);
    expect(touchesMark(line, { x: 100, y: 20 })).toBe(false);
  });

  it("erases an unfilled region by its outline, so marks inside it stay reachable", () => {
    const rect = { x: 100, y: 100, width: 100, height: 100 };
    const outlined = { kind: "region" as const, rect, color: "#ef4444", filled: false };
    expect(touchesMark(outlined, { x: 150, y: 150 })).toBe(false);
    expect(touchesMark(outlined, { x: 103, y: 150 })).toBe(true);
    expect(touchesMark({ ...outlined, filled: true }, { x: 150, y: 150 })).toBe(true);
  });

  it("erases an arrow from the corners of its head", () => {
    const arrow = {
      kind: "arrow" as const,
      points: [
        { x: 0, y: 100 },
        { x: 200, y: 100 },
      ],
      color: "#ef4444",
    };
    const { left } = arrowHead(arrow.points[0]!, arrow.points[1]!);
    expect(touchesMark(arrow, left)).toBe(true);
    expect(touchesMark(arrow, { x: 186, y: 100 - 9.5 })).toBe(true);
  });
});
