import { describe, expect, it } from "vite-plus/test";

import {
  type MarkDrag,
  arrowHead,
  dragDrawing,
  isTooSmall,
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
  const from = { x: 100, y: 100 };
  it.each([
    { start: from, end: { x: 300, y: 112 }, snapped: { x: 300, y: 100 }, step: "0° step" },
    { start: from, end: { x: 110, y: 280 }, snapped: { x: 100, y: 280 }, step: "90° step" },
    { start: from, end: { x: 190, y: 200 }, snapped: { x: 195, y: 195 }, step: "45° step" },
    { start: from, end: { x: 10, y: 15 }, snapped: { x: 12.5, y: 12.5 }, step: "225° step" },
    // The pointer's projection onto the diagonal lies below the view, so the line ends at its edge.
    {
      start: { x: 300, y: 260 },
      end: { x: 390, y: 300 },
      snapped: { x: 340, y: 300 },
      step: "edge",
    },
  ])("moves a drag's end onto the $step through its start", ({ start, end, snapped }) => {
    const point = snapToAngle(start, end, size);
    expect(point.x).toBeCloseTo(snapped.x, 6);
    expect(point.y).toBeCloseTo(snapped.y, 6);
  });
});

describe("dragDrawing", () => {
  const wobble = [
    { x: 10, y: 10 },
    { x: 30, y: 40 },
    { x: 60, y: 20 },
    { x: 90, y: 50 },
  ];
  const start = { x: 100, y: 100 };
  const end = { x: 300, y: 130 };
  const click = [
    { x: 50, y: 50 },
    { x: 51, y: 51 },
  ];

  it("draws each tool's drag as the mark the person drew, straightened with Shift", () => {
    expect(drag("draw", wobble, false), "a pen's path").toMatchObject({
      kind: "pen",
      points: wobble,
    });
    expect(
      drag("draw", wobble, true),
      "a pen with Shift, one segment from its start",
    ).toMatchObject({
      kind: "pen",
      points: [wobble[0], wobble[3]],
    });
    expect(drag("line", [start, end], false)).toMatchObject({ points: [start, end] });
    expect(drag("arrow", [start, end], true), "an arrow with Shift, on a 45° step").toMatchObject({
      kind: "arrow",
      points: [start, { x: 300, y: 100 }],
    });
    expect(drag("region", [start, end], false)).toMatchObject({
      rect: { x: 100, y: 100, width: 200, height: 30 },
    });
    expect(drag("region", [start, end], true), "a square on the drag's longer side").toMatchObject({
      rect: { x: 100, y: 100, width: 200, height: 200 },
    });
    expect(squareCorner(start, { x: 80, y: 30 }, size), "a square in the drag's direction").toEqual(
      {
        x: 30,
        y: 30,
      },
    );
    expect(squareCorner({ x: 350, y: 100 }, { x: 390, y: 250 }, size), "inside the view").toEqual({
      x: 400,
      y: 150,
    });

    for (const tool of ["line", "arrow", "region"] as const) {
      expect(isTooSmall(drag(tool, click, false)), `a ${tool} that barely moved is dropped`).toBe(
        true,
      );
    }
    expect(isTooSmall(drag("draw", [{ x: 50, y: 50 }], false)), "a pen's dot is kept").toBe(false);
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

    const short = markTargets([
      {
        id: "stroke_3",
        drawing: {
          kind: "arrow",
          points: [
            { x: 100, y: 100 },
            { x: 104, y: 100 },
          ],
          color: "#d946ef",
        },
      },
    ]).strokes[0]!;
    expect(
      markSamples(short.bounds, size, short.points)[0],
      "a short arrow starts at its tip, not the middle of its box",
    ).toEqual({ x: 104 / 400, y: 100 / 300 });
  });
});

describe("touchesMark", () => {
  it("erases the mark under the pointer, keeping marks inside an outlined region reachable", () => {
    const line = {
      kind: "line" as const,
      points: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
      ],
      color: "#ef4444",
    };
    expect(touchesMark(line, { x: 100, y: 5 }), "a line anywhere along it").toBe(true);
    expect(touchesMark(line, { x: 100, y: 20 }), "beside a line").toBe(false);

    const rect = { x: 100, y: 100, width: 100, height: 100 };
    const outlined = { kind: "region" as const, rect, color: "#ef4444", filled: false };
    expect(touchesMark(outlined, { x: 150, y: 150 }), "inside an outlined region").toBe(false);
    expect(touchesMark(outlined, { x: 103, y: 150 }), "an outlined region's outline").toBe(true);
    expect(touchesMark({ ...outlined, filled: true }, { x: 150, y: 150 }), "a filled region").toBe(
      true,
    );

    const arrow = {
      kind: "arrow" as const,
      points: [
        { x: 0, y: 100 },
        { x: 200, y: 100 },
      ],
      color: "#ef4444",
    };
    const { left } = arrowHead(arrow.points[0]!, arrow.points[1]!);
    expect(touchesMark(arrow, left), "an arrowhead's corner").toBe(true);
    expect(touchesMark(arrow, { x: 186, y: 100 - 9.5 }), "an arrowhead's side").toBe(true);
  });
});
