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

  it("counts nothing in a file read only as far as its thumbnail, and says why", () => {
    const unread = { ...preview, objects: 0, meshes: 0, libraries: [], partial: true };
    const rows = blendFactRows({ ...unread, large: true });
    expect(rows.map((row) => row.label)).toEqual(["Contents", "Size"]);
    expect(rows[0]?.values).toEqual(["Not read for a file this large"]);
    // Neither a compressed file whose size T3 Code can't tell nor a small one past a read limit
    // is called large.
    for (const why of [{ large: true, sizeUnknown: true }, {}] as const) {
      expect(blendFactRows({ ...unread, ...why })[0]?.values).toEqual([
        "More than T3 Code reads for a preview",
      ]);
    }
  });
});
