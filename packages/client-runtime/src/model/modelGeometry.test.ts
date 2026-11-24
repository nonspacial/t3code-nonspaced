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

import {
  disposeModel,
  ensureVertexNormals,
  frameDistance,
  modelFacts,
  orientToYUp,
} from "./modelGeometry.ts";

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
    ["missing", undefined],
    ["zero", [0, 0, 0] as const],
  ])("recomputes %s normals", (_label, normal) => {
    const geometry = triangle(normal);
    expect(ensureVertexNormals(geometry)).toBe(true);
    const normals = geometry.getAttribute("normal");
    expect([normals.getX(0), normals.getY(0), normals.getZ(0)]).toEqual([0, 0, 1]);
  });

  it("keeps authored normals", () => {
    const geometry = triangle([0, 0, -1]);
    expect(ensureVertexNormals(geometry)).toBe(false);
    expect(geometry.getAttribute("normal").getZ(2)).toBe(-1);
  });
});

describe("orientToYUp", () => {
  const extent = (format: Parameters<typeof orientToYUp>[1]) => {
    const root = new Group().add(new Mesh(new BoxGeometry(1, 2, 3)));
    orientToYUp(root, format);
    return new Box3().setFromObject(root).getSize(new Vector3()).toArray().map(Math.round);
  };

  it.each(["stl", "3mf"] as const)("stands a Z-up %s model upright", (format) => {
    expect(extent(format)).toEqual([1, 3, 2]);
  });

  it.each(["glb", "obj", "ply", "fbx"] as const)("leaves a Y-up %s model as it is", (format) => {
    expect(extent(format)).toEqual([1, 2, 3]);
  });
});

describe("frameDistance", () => {
  it("fits the bounding sphere in the narrower direction of the view", () => {
    const wide = frameDistance(1, 90, 2);
    expect(wide).toBeCloseTo(1.25 / Math.sin(Math.PI / 4));
    expect(frameDistance(1, 90, 0.5)).toBeGreaterThan(wide);
    expect(frameDistance(2, 90, 2)).toBeCloseTo(wide * 2);
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
