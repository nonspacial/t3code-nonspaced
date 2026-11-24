import { describe, expect, it } from "vite-plus/test";

import { formatModelViewHash, modelViewFromHref } from "./modelView.ts";

const view = { position: [120, 80.5, -40] as const, target: [0, 0.25, 0] as const };

// The cases follow StiensWout's annotatable 3D previews (pingdotgg/t3code fork commit d04d876).
describe("model view links", () => {
  it("round-trips a camera through a file link", () => {
    expect(formatModelViewHash(view)).toBe("#view=120,80.5,-40,0,0.25,0");
    expect(modelViewFromHref(`out/bracket.stl${formatModelViewHash(view)}`)).toEqual(view);
    expect(modelViewFromHref("out/bracket.stl#view=120%2C80.5%2C-40%2C0%2C0.25%2C0")).toEqual(view);
    expect(modelViewFromHref("#view=120,80.5,-40,0,0.25,0")).toEqual(view);
  });

  it("keeps every digit, so any camera survives its own link", () => {
    const far = { position: [1000004, 0, 0], target: [1000000, 0, 0] } as const;
    expect(modelViewFromHref(formatModelViewHash(far))).toEqual(far);
    const exact = {
      position: [1 / 3, 0.1 + 0.2, 1e-9],
      target: [123456.789, 0, -0.000123456],
    } as const;
    expect(modelViewFromHref(formatModelViewHash(exact))).toEqual(exact);
    expect(formatModelViewHash({ position: [-0, 1, 2], target: [0, 0, 0] })).toBe(
      "#view=0,1,2,0,0,0",
    );
  });

  it.each([
    "out/bracket.stl",
    "out/bracket.stl#L12",
    "out/bracket.stl#view=1,2,3,0,0",
    "out/bracket.stl#view=1,2,3,0,0,0,9",
    "out/bracket.stl#view=1,2,NaN,0,0,0",
    "out/bracket.stl#view=1,2,Infinity,0,0,0",
    "out/bracket.stl#view=1,2,3,1,2,3",
    "out/bracket.stl#view=1,2,,0,0,0",
    "out/bracket.stl#view=0x1,2,3,0,0,0",
    "out/bracket.stl#review=1,2,3,0,0,0",
    "out/bracket.stl#view=1,2,3,0,0,0%",
  ])("ignores %s", (href) => {
    expect(modelViewFromHref(href)).toBeNull();
  });
});
