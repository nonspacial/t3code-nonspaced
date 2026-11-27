import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Texture,
  Vector3,
} from "three";
import { describe, expect, it, vi } from "vite-plus/test";

import { disposeModel, ensureVertexNormals, modelFacts, orientToYUp } from "./modelGeometry.ts";

// One upward-facing triangle in the XY plane, as an STL exporter writes it.
function triangle(normal?: readonly [number, number, number]) {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
  );
  if (normal)
    geometry.setAttribute(
      "normal",
      new BufferAttribute(new Float32Array([...normal, ...normal, ...normal]), 3),
    );
  return geometry;
}

describe("ensureVertexNormals", () => {
  it.each([
    { label: "recomputes missing", normal: undefined, recomputed: true, expected: [0, 0, 1] },
    { label: "recomputes zero", normal: [0, 0, 0] as const, recomputed: true, expected: [0, 0, 1] },
    {
      label: "keeps authored",
      normal: [0, 0, -1] as const,
      recomputed: false,
      expected: [0, 0, -1],
    },
  ])("$label normals", ({ normal, recomputed, expected }) => {
    const geometry = triangle(normal);
    expect(ensureVertexNormals(geometry)).toBe(recomputed);
    const normals = geometry.getAttribute("normal");
    expect([normals.getX(2), normals.getY(2), normals.getZ(2)]).toEqual(expected);
  });
});

describe("orientToYUp", () => {
  const extent = (format: Parameters<typeof orientToYUp>[1]) => {
    const root = new Group().add(new Mesh(new BoxGeometry(1, 2, 3)));
    orientToYUp(root, format);
    return new Box3().setFromObject(root).getSize(new Vector3()).toArray().map(Math.round);
  };

  it.each([
    { format: "stl", up: "Z", size: [1, 3, 2] },
    { format: "3mf", up: "Z", size: [1, 3, 2] },
    { format: "glb", up: "Y", size: [1, 2, 3] },
    { format: "obj", up: "Y", size: [1, 2, 3] },
    { format: "ply", up: "Y", size: [1, 2, 3] },
    { format: "fbx", up: "Y", size: [1, 2, 3] },
  ] as const)("stands a $up-up $format model upright", ({ format, size }) => {
    expect(extent(format)).toEqual(size);
  });
});

describe("modelFacts", () => {
  it("counts triangles, meshes and points and measures the bounding box", () => {
    const root = new Group().add(
      new Mesh(new BoxGeometry(2, 4, 6)),
      new Mesh(triangle()),
      new Points(
        new BufferGeometry().setAttribute("position", new BufferAttribute(new Float32Array(30), 3)),
      ),
    );
    expect(modelFacts(root)).toEqual({ triangles: 13, meshes: 2, points: 10, size: [2, 4, 6] });
  });
});

it("disposes every geometry, material and texture once", () => {
  const map = new Texture();
  const material = new MeshBasicMaterial({ map });
  const geometry = new BoxGeometry();
  const points = new Points(new BufferGeometry(), new PointsMaterial());
  const root = new Group().add(new Mesh(geometry, material), new Mesh(geometry, material), points);
  const spies = [map, material, geometry, points.geometry, points.material].map((resource) =>
    vi.spyOn(resource, "dispose"),
  );
  disposeModel(root);
  for (const spy of spies) expect(spy).toHaveBeenCalledOnce();
});
