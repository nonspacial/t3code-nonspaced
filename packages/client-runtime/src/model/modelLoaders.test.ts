import { Mesh } from "three";
import { describe, expect, it } from "vite-plus/test";

import { loadModel, readResponseBytes } from "./modelLoaders.ts";
import { isModelPreviewError } from "./modelPreviewError.ts";

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

describe("P6: the preview's byte limit", () => {
  // One triangle whose positions are in an external buffer, 36 bytes.
  const gltf = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
    ],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ uri: "triangle.bin", byteLength: 36 }],
  });
  const positions = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const load = (maxBytes: number) =>
    loadModel({
      format: "gltf",
      data: new TextEncoder().encode(gltf).buffer,
      companions: {
        modelPath: "/work/triangle.gltf",
        workspaceRoot: "/work",
        mint: async () => URL.createObjectURL(new Blob([positions])),
      },
      signal: new AbortController().signal,
      maxBytes,
    });

  it("counts a glTF's external buffers against it, before they reach three.js", async () => {
    expect((await load(36)).facts.triangles).toBe(1);
    const refused = await load(35).catch((error: unknown) => error);
    expect(isModelPreviewError(refused) && refused.code).toBe("model-too-large");
  });

  it("reads a body of known length into one buffer, and stops at the limit", async () => {
    const chunked = (sizes: ReadonlyArray<number>, length: number | null) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            let next = 0;
            for (const size of sizes) {
              controller.enqueue(Uint8Array.from({ length: size }, (_, index) => next + index));
              next += size;
            }
            controller.close();
          },
        }),
        length === null ? {} : { headers: { "content-length": String(length) } },
      );
    const whole = Array.from({ length: 10 }, (_, index) => index);
    expect([...new Uint8Array((await readResponseBytes(chunked([4, 6], 10), 10))!)]).toEqual(whole);
    expect([...new Uint8Array((await readResponseBytes(chunked([4, 6], null), 10))!)]).toEqual(
      whole,
    );
    expect(await readResponseBytes(chunked([4, 6], 10), 9)).toBeNull();
    expect(await readResponseBytes(chunked([4, 6], null), 9)).toBeNull();
  });
});
