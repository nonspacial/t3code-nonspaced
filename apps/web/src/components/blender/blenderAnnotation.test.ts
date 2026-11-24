import type { HostedBlenderViewCapture } from "@t3tools/contracts";
import { modelViewFromHref } from "@t3tools/shared/modelView";
import { describe, expect, it, vi } from "vite-plus/test";

import { markSamples } from "../files/modelAnnotation";
import { blenderAnnotationPayload, blenderAnnotationTitle } from "./blenderAnnotation";

const capture: HostedBlenderViewCapture = {
  screenshot: { dataUrl: "data:image/png;base64,AA==", width: 400, height: 300 },
  cameraView: { position: [6, -6, 5], target: [0, 0, 0], upAxis: "z" },
  projection: {
    matrix: Array.from({ length: 16 }, (_, index) => index),
    region: { x: 0.05, y: 0.1, width: 0.9, height: 0.85 },
  },
};
const size = { width: 400, height: 300 };
const region = { id: "region_1", rect: { x: 180, y: 130, width: 40, height: 40 } };
const stroke = {
  id: "stroke_2",
  color: "#2563eb",
  width: 4,
  points: [
    { x: 10, y: 10 },
    { x: 30, y: 20 },
  ],
  bounds: { x: 3, y: 3, width: 34, height: 24 },
};
const base = {
  id: "model_1",
  relativePath: "models/hero.wip-a1b2.blend",
  comment: " Round this edge ",
  regions: [region],
  strokes: [stroke],
  size,
  screenshot: { dataUrl: "data:image/png;base64,AA==", width: 800, height: 600 },
  createdAt: "2026-11-24T10:00:00.000Z",
};

describe("blenderAnnotationTitle", () => {
  it("names the file and whether it is a working copy or the master", () => {
    expect(blenderAnnotationTitle("models/hero.wip-a1b2.blend")).toBe(
      "hero.wip-a1b2.blend · Working copy",
    );
    expect(blenderAnnotationTitle("models/hero.blend")).toBe("hero.blend · Master");
    expect(blenderAnnotationTitle("hero.wip.blend")).toBe("hero.wip.blend · Master");
  });
});

describe("blenderAnnotationPayload", () => {
  it("casts each mark through the frozen view and links back to it", async () => {
    const findHits = vi.fn(async () => [{ object: "Cube", point: [0, -1, 0.5] as const }, null]);
    const payload = await blenderAnnotationPayload({ ...base, capture, findHits });

    expect(findHits).toHaveBeenCalledWith({
      projection: capture.projection,
      marks: [markSamples(region.rect, size), markSamples(stroke.bounds, size, stroke.points)],
    });
    expect(payload).toMatchObject({
      pageTitle: "hero.wip-a1b2.blend · Working copy",
      comment: "Round this edge",
      cameraView: capture.cameraView,
    });
    expect(payload.regions[0]?.hit).toEqual({ object: "Cube", point: [0, -1, 0.5] });
    expect(payload.strokes[0]).not.toHaveProperty("hit");
    expect(payload.pageUrl.startsWith("models/hero.wip-a1b2.blend#view=")).toBe(true);
    expect(modelViewFromHref(payload.pageUrl)).toEqual({ position: [6, -6, 5], target: [0, 0, 0] });
  });

  it("keeps the camera when Blender can't say what the marks cover", async () => {
    const payload = await blenderAnnotationPayload({
      ...base,
      capture,
      findHits: async () => null,
    });
    expect(payload.cameraView).toEqual(capture.cameraView);
    expect(payload.regions[0]).not.toHaveProperty("hit");
  });

  it("is still the screenshot and comment when the camera couldn't be read", async () => {
    const findHits = vi.fn(async () => []);
    const payload = await blenderAnnotationPayload({ ...base, capture: null, findHits });
    expect(findHits).not.toHaveBeenCalled();
    expect(payload).not.toHaveProperty("cameraView");
    expect(payload.pageUrl).toBe("models/hero.wip-a1b2.blend");
    expect(payload.screenshot?.dataUrl).toBe(base.screenshot.dataUrl);
  });

  it("looks for nothing under the marks when the frame isn't the viewport window alone", async () => {
    const payload = await blenderAnnotationPayload({ ...base, capture, findHits: null });
    expect(payload.cameraView).toEqual(capture.cameraView);
    expect(payload.regions[0]).not.toHaveProperty("hit");
  });
});
