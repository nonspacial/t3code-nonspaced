import { Mesh } from "three";
import { describe, expect, it } from "vite-plus/test";

import { loadModel } from "./modelLoaders.ts";

// One triangle facing +Z whose exporter wrote the facet normal pointing the other way.
const FLIPPED_NORMAL_STL = `solid flipped
facet normal 0 0 -1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
endsolid flipped
`;

describe("loadModel", () => {
  it("recomputes STL normals from the triangles instead of trusting the file", async () => {
    const { root } = await loadModel({
      format: "stl",
      data: new TextEncoder().encode(FLIPPED_NORMAL_STL).buffer,
      companions: null,
      signal: new AbortController().signal,
    });
    const meshes: Mesh[] = [];
    root.traverse((object) => {
      if (object instanceof Mesh) meshes.push(object);
    });
    const normals = meshes[0]?.geometry.getAttribute("normal");
    expect(normals && [normals.getX(0), normals.getY(0), normals.getZ(0)]).toEqual([0, 0, 1]);
  });
});

describe("loadModel OBJ materials", () => {
  const obj = [
    "mtllib materials/a.mtl",
    "mtllib ./materials/b.mtl",
    "mtllib elsewhere/gone.mtl",
    "v 0 0 0",
    "v 1 0 0",
    "v 0 1 0",
    "vt 0 0",
    "vt 1 0",
    "vt 0 1",
    "usemtl wood",
    "f 1/1 2/2 3/3",
  ].join("\n");
  const libraries: Record<string, string> = {
    "/work/models/materials/a.mtl": "newmtl wood\nmap_Kd wood.png\n",
    "/work/models/materials/b.mtl": "newmtl metal\nKd 1 1 1\n",
  };

  it("resolves textures beside the libraries that loaded, however their folder is written", async () => {
    const { missing } = await loadModel({
      format: "obj",
      data: new TextEncoder().encode(obj).buffer,
      companions: {
        modelPath: "/work/models/stool.obj",
        workspaceRoot: "/work",
        mint: async (path) => {
          const library = libraries[path];
          return library === undefined ? null : `data:text/plain,${encodeURIComponent(library)}`;
        },
      },
      signal: new AbortController().signal,
    });
    expect(missing).toEqual(expect.arrayContaining(["materials/wood.png"]));
    expect(missing).not.toContain("wood.png");
  });
});
