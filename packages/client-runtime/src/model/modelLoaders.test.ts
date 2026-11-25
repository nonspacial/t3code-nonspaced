import { Mesh } from "three";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

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

  it("N5: reads at once share it, so a buffer past it is never read into memory", async () => {
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    // Two 80-byte external buffers, each under the limit alone.
    const twoBuffers = JSON.stringify({
      ...JSON.parse(gltf),
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 1 } }] }],
      accessors: [0, 1].map((bufferView) => ({
        bufferView,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      })),
      bufferViews: [0, 1].map((buffer) => ({ buffer, byteLength: 36 })),
      buffers: ["a.bin", "b.bin"].map((uri) => ({ uri, byteLength: 80 })),
    });
    let read = 0;
    vi.stubGlobal("fetch", async () => {
      const body = new Uint8Array(80);
      body.set(positions);
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              read += body.byteLength;
              controller.enqueue(body);
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-length": "80" } },
      );
    });
    const refused = await loadModel({
      format: "gltf",
      data: new TextEncoder().encode(twoBuffers).buffer,
      companions: {
        modelPath: "/work/triangle.gltf",
        workspaceRoot: "/work",
        mint: async (path) => `https://t3/companion${path}`,
      },
      signal: new AbortController().signal,
      maxBytes: 100,
    }).catch((error: unknown) => error);
    expect(isModelPreviewError(refused) && refused.code).toBe("model-too-large");
    expect(read).toBeLessThanOrEqual(100);
  });

  it("N5: counts an OBJ's materials against it too", async () => {
    const refused = await loadModel({
      format: "obj",
      data: new TextEncoder().encode("mtllib big.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n").buffer,
      companions: {
        modelPath: "/work/stool.obj",
        workspaceRoot: "/work",
        mint: async () =>
          `data:text/plain,${encodeURIComponent(`newmtl big\n#${"x".repeat(200)}\n`)}`,
      },
      signal: new AbortController().signal,
      maxBytes: 100,
    }).catch((error: unknown) => error);
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

describe("N6: a glTF's KTX2 texture", () => {
  it("is read through the companion files, and named when it can't be", async () => {
    // One triangle whose material's texture is a sibling .ktx2.
    const positions = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const gltf = JSON.stringify({
      asset: { version: "2.0" },
      extensionsUsed: ["KHR_texture_basisu"],
      extensionsRequired: ["KHR_texture_basisu"],
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
      images: [{ uri: "wood.ktx2" }],
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
      buffers: [{ uri: "crate.bin", byteLength: 36 }],
    });
    // KTX2Loader's worker pool looks for `self`, which Node lacks; no worker starts here.
    vi.stubGlobal("self", globalThis);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const asked: string[] = [];
    const { missing } = await loadModel({
      format: "gltf",
      data: new TextEncoder().encode(gltf).buffer,
      companions: {
        modelPath: "/work/crate.gltf",
        workspaceRoot: "/work",
        mint: async (path) => {
          asked.push(path);
          return path.endsWith(".bin") ? URL.createObjectURL(new Blob([positions])) : null;
        },
      },
      signal: new AbortController().signal,
      decoders: {
        files: {},
        // Enough of a WebGL renderer for KTX2Loader to pick a transcode target.
        renderer: { extensions: { has: () => false }, capabilities: {} } as never,
      },
    });
    expect(asked).toContain("/work/wood.ktx2");
    expect(missing).toEqual(["wood.ktx2"]);
  });
});
