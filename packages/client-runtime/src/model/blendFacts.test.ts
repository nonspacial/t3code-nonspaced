import { describe, expect, it } from "vite-plus/test";

import { blendFactRows } from "./blendFacts.ts";

const preview = {
  relativePath: "shot.blend",
  byteLength: 1024,
  blenderVersion: "5.3",
  thumbnail: null,
  scene: null,
  scenes: 1,
  objects: 2,
  meshes: 2,
  materials: 0,
  libraries: ["//props/chair.blend", "//sets/chair.blend"],
};

describe("blendFactRows", () => {
  it("keeps linked files' folders, so files with the same name stay apart", () => {
    const rows = blendFactRows(preview);
    expect(rows.find((row) => row.label === "Linked files")?.values).toEqual([
      "//props/chair.blend",
      "//sets/chair.blend",
    ]);
  });

  it("counts nothing in a file read only as far as its thumbnail", () => {
    const rows = blendFactRows({ ...preview, objects: 0, meshes: 0, libraries: [], partial: true });
    expect(rows.map((row) => row.label)).toEqual(["Contents", "Size"]);
  });
});
