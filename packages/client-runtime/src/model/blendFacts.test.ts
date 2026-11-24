import { describe, expect, it } from "vite-plus/test";

import { blendFactRows } from "./blendFacts.ts";

describe("blendFactRows", () => {
  it("keeps linked files' folders, so files with the same name stay apart", () => {
    const rows = blendFactRows({
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
    });
    expect(rows.find((row) => row.label === "Linked files")?.values).toEqual([
      "//props/chair.blend",
      "//sets/chair.blend",
    ]);
  });
});
