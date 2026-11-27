import type { PreviewAnnotationHit } from "@t3tools/contracts";
import { modelViewFromHref } from "@t3tools/shared/modelView";
import { describe, expect, it, vi } from "vite-plus/test";

import { markSamples, modelAnnotationPayload, modelFileLink } from "./modelAnnotation";

const cameraView = {
  position: [120, 80.5, -40] as const,
  target: [0, 0.25, 0] as const,
  upAxis: "z" as const,
};
const screenshot = { dataUrl: "data:image/png;base64,AA==", width: 800, height: 600 };
const size = { width: 400, height: 300 };

describe("modelFileLink", () => {
  it("links the file at the camera, escaping what would break a markdown link", () => {
    const link = modelFileLink("out/hinge (v3).stl", cameraView);
    expect(link).toBe("out/hinge%20%28v3%29.stl#view=120,80.5,-40,0,0.25,0");
    expect(modelViewFromHref(link)).toEqual({
      position: cameraView.position,
      target: cameraView.target,
    });
  });
});

describe("markSamples", () => {
  it("tries where the person meant first: a region's centre, a loop's middle, then along the drawn curve", () => {
    const inRegion = markSamples({ x: 100, y: 60, width: 200, height: 120 }, size);
    expect(inRegion[0], "a region's centre first").toEqual({ x: 0.5, y: 0.4 });
    expect(inRegion.length, "then the rest of the region").toBeGreaterThan(1);
    for (const sample of inRegion) {
      expect(sample.x, "inside the region").toBeGreaterThanOrEqual(0.25);
      expect(sample.x, "inside the region").toBeLessThanOrEqual(0.75);
    }

    const loop = [
      { x: 100, y: 150 },
      { x: 200, y: 50 },
      { x: 300, y: 150 },
      { x: 200, y: 250 },
      { x: 105, y: 155 },
    ];
    const inLoop = markSamples({ x: 100, y: 50, width: 200, height: 200 }, size, loop);
    expect(inLoop[0], "a closed loop's middle first").toEqual({ x: 0.5, y: 0.5 });
    expect(
      inLoop.some(
        (sample) => Math.abs(sample.x - 0.5) <= 0.01 && Math.abs(sample.y - 75 / 300) <= 0.01,
      ),
      "then the loop's line itself, across the top of its curve",
    ).toBe(true);

    // A fast stroke recorded only its ends; a small part sits halfway along it.
    const fast = markSamples({ x: 0, y: 0, width: 400, height: 300 }, size, [
      { x: 0, y: 0 },
      { x: 400, y: 300 },
    ]);
    expect(
      fast.some((sample) => Math.abs(sample.x - 0.5) <= 0.01 && Math.abs(sample.y - 0.5) <= 0.01),
      "the whole of an open line, between its pointer events",
    ).toBe(true);
    expect(fast[0], "an open line from its start").toEqual({ x: 0, y: 0 });
    expect(fast.at(-1), "an open line to its end").toEqual({ x: 1, y: 1 });
    for (const sample of fast)
      expect(sample.y, "on the line, not its box").toBeCloseTo(sample.x, 6);

    // A sharp turn at (300, 100): the drawn curve turns back at x = 250, short of the point.
    const turn = markSamples({ x: 93, y: 93, width: 214, height: 24 }, size, [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 100, y: 110 },
    ]);
    const furthest = Math.max(...turn.map((sample) => sample.x * size.width));
    expect(furthest, "the drawn curve, not the straight lines").toBeGreaterThan(245);
    expect(furthest, "the drawn curve, not the straight lines").toBeLessThanOrEqual(250.5);
    expect(turn.at(-1)).toEqual({ x: 0.25, y: 110 / 300 });

    const long = Array.from({ length: 2000 }, (_unused, index) => ({ x: index % 400, y: 150 }));
    expect(
      markSamples({ x: 0, y: 140, width: 400, height: 20 }, size, long).length,
      "a very long line's samples are capped",
    ).toBeLessThanOrEqual(130);
  });
});

describe("modelAnnotationPayload", () => {
  const flange: PreviewAnnotationHit = { object: "Flange", point: [1.5, 2, -3] };
  const build = (overrides: Partial<Parameters<typeof modelAnnotationPayload>[0]> = {}) =>
    modelAnnotationPayload({
      id: "a1",
      name: "hinge (v3).stl",
      linkPath: "out/hinge (v3).stl",
      comment: "  Open the pin hole to 3.2 mm ",
      regions: [{ id: "r1", rect: { x: 100, y: 60, width: 200, height: 120 } }],
      strokes: [
        {
          id: "s1",
          color: "#2563eb",
          width: 4,
          points: [{ x: 10, y: 10 }],
          bounds: { x: 3, y: 3, width: 14, height: 14 },
        },
      ],
      size,
      hitAt: (samples) => (samples[0]?.x === 0.5 ? flange : null),
      screenshot,
      cameraView,
      createdAt: "2026-11-20T12:00:00.000Z",
      ...overrides,
    });

  it("carries the camera, a link back to it and what is under each mark", () => {
    const annotation = build();
    expect(annotation).toMatchObject({
      pageTitle: "hinge (v3).stl",
      pageUrl: "out/hinge%20%28v3%29.stl#view=120,80.5,-40,0,0.25,0",
      comment: "Open the pin hole to 3.2 mm",
      elements: [],
      styleChanges: [],
      cameraView,
      screenshot: { ...screenshot, cropRect: { x: 0, y: 0, width: 400, height: 300 } },
    });
    expect(annotation.regions[0]?.hit).toEqual(flange);
    expect(annotation.strokes[0]).not.toHaveProperty("hit");

    const hitAt = vi.fn(() => null);
    const attachment = build({ linkPath: null, hitAt });
    expect(attachment.pageUrl, "an attachment, with no path to link to, is named").toBe(
      "hinge (v3).stl",
    );
    expect(hitAt, "an attachment's marks are still cast").toHaveBeenCalled();
  });

  it("stops looking for hits once its time budget is spent, keeping the hits it found", () => {
    let clock = 0;
    let casts = 0;
    const hitAt = vi.fn((samples: ReadonlyArray<{ x: number; y: number }>) => {
      casts += samples.length;
      clock += 60 * samples.length;
      return casts === 1 ? flange : null;
    });
    const annotation = build({ hitAt, now: () => clock });
    // 60 ms per cast: the region's centre hits, then one more cast spends the 100 ms budget.
    expect(annotation.regions[0]?.hit).toEqual(flange);
    expect(annotation.strokes[0]).not.toHaveProperty("hit");
    expect(casts).toBe(2);
  });
});
