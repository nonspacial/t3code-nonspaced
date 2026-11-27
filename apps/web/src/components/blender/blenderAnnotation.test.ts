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
  scene: "launch:1",
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
  file: { kind: "workspace" as const, relativePath: "models/hero.wip-a1b2.blend" },
  comment: " Round this edge ",
  regions: [region],
  strokes: [stroke],
  size,
  screenshot: { dataUrl: "data:image/png;base64,AA==", width: 800, height: 600 },
  createdAt: "2026-11-24T10:00:00.000Z",
};

describe("blenderAnnotationPayload", () => {
  it("casts each mark through the frozen view and links back to it", async () => {
    const findHits = vi.fn(async () => [{ object: "Cube", point: [0, -1, 0.5] as const }, null]);
    const payload = await blenderAnnotationPayload({ ...base, capture, findHits });

    expect(findHits).toHaveBeenCalledWith({
      projection: capture.projection,
      scene: capture.scene,
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

    expect(blenderAnnotationTitle("models/hero.blend"), "a master's title").toBe(
      "hero.blend · Master",
    );
    expect(blenderAnnotationTitle("hero.wip.blend"), "a master's title").toBe(
      "hero.wip.blend · Master",
    );

    for (const [why, findHits] of [
      ["Blender can't say what the marks cover", async () => null],
      ["the frame isn't the viewport window alone", null],
    ] as const) {
      const unhit = await blenderAnnotationPayload({ ...base, capture, findHits });
      expect(unhit.cameraView, `the camera is kept when ${why}`).toEqual(capture.cameraView);
      expect(unhit.regions[0], `no hit when ${why}`).not.toHaveProperty("hit");
    }

    const noCameraHits = vi.fn(async () => []);
    const noCamera = await blenderAnnotationPayload({
      ...base,
      capture: null,
      findHits: noCameraHits,
    });
    expect(noCameraHits, "no camera: nothing is cast").not.toHaveBeenCalled();
    expect(noCamera, "no camera").not.toHaveProperty("cameraView");
    expect(noCamera.pageUrl, "no camera: a plain file link").toBe("models/hero.wip-a1b2.blend");
    expect(noCamera.screenshot?.dataUrl, "no camera: still the screenshot").toBe(
      base.screenshot.dataUrl,
    );
  });

  it("names the file the frame is of, and asks for hits in its scene only", async () => {
    const findHits = vi.fn(async () => [null, null]);
    const outside = await blenderAnnotationPayload({
      ...base,
      file: { kind: "outside", path: "/elsewhere/other.blend" },
      capture: { ...capture, scene: "launch:7" },
      findHits,
    });
    expect(outside.pageUrl.startsWith("/elsewhere/other.blend#view=")).toBe(true);
    expect(outside.pageTitle).toBe("other.blend · Master");
    expect(findHits).toHaveBeenCalledWith(expect.objectContaining({ scene: "launch:7" }));
    const untitled = await blenderAnnotationPayload({
      ...base,
      file: { kind: "untitled" },
      capture: null,
      findHits: null,
    });
    expect(untitled.pageTitle).toBe("Untitled scene");
  });
});
