import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Vector3,
  type Object3D,
} from "three";
import type { ModelPreviewFormat } from "@t3tools/shared/filePreview";
import { describe, expect, it } from "vite-plus/test";

import { orientToYUp } from "./modelGeometry.ts";
import { hitUnderMark, modelSpace } from "./modelSpace.ts";

// Places a model the way the loaders do: turned Y-up when its format is Z-up, then centred.
function placed(model: Object3D, format: ModelPreviewFormat) {
  const root = new Group();
  root.add(model);
  orientToYUp(root, format);
  root.position.sub(new Box3().setFromObject(root).getCenter(new Vector3()));
  root.updateMatrixWorld(true);
  return root;
}

function box(name = "", at: readonly [number, number, number] = [0, 0, 0]) {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.name = name;
  mesh.position.set(...at);
  return mesh;
}

const close = (actual: readonly number[], expected: readonly number[]) =>
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 5));

describe("model file space", () => {
  it("reports an STL's own Z-up coordinates, not the centred Y-up scene", () => {
    const root = placed(box("", [10, 4, 5]), "stl");
    const space = modelSpace(root, { format: "stl", blenderSource: false });
    expect(space.upAxis).toBe("z");
    close(space.toFile(space.fromFile([10, 4, 5])), [10, 4, 5]);
    close(space.toFile(new Vector3(0, 0, 0)), [10, 4, 5]);
    // Up on screen is up in the file.
    const up = space.fromFile([10, 4, 6]).sub(space.fromFile([10, 4, 5]));
    close(up.toArray(), [0, 1, 0]);
  });

  it("keeps a glTF's Y-up coordinates", () => {
    const root = placed(box("", [1, 2, 3]), "glb");
    const space = modelSpace(root, { format: "glb", blenderSource: false });
    expect(space.upAxis).toBe("y");
    close(space.toFile(new Vector3(0, 0, 0)), [1, 2, 3]);
  });

  it("converts a GLB made from a .blend back to Blender's Z-up coordinates", () => {
    const root = placed(box("", [1, 2, 3]), "glb");
    const space = modelSpace(root, { format: "glb", blenderSource: true });
    expect(space.upAxis).toBe("z");
    // Blender's exporter writes (x, y, z) as glTF (x, z, -y).
    close(space.toFile(new Vector3(0, 0, 0)), [1, -3, 2]);
    close(space.toFile(space.fromFile([4, 5, 6])), [4, 5, 6]);
  });
});

describe("hitUnderMark", () => {
  function scene(model: Object3D) {
    const root = placed(model, "glb");
    const camera = new PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    return { root, camera, space: modelSpace(root, { format: "glb", blenderSource: false }) };
  }

  it("names the first object any sample lands on and where", () => {
    const { root, camera, space } = scene(box("Flange"));
    const hit = hitUnderMark({
      root,
      camera,
      space,
      samples: [
        { x: 0.05, y: 0.05 },
        { x: 0.5, y: 0.5 },
      ],
    });
    expect(hit?.object).toBe("Flange");
    close(hit?.point ?? [], [0, 0, 0.5]);
  });

  it("falls back to the nearest named parent, then to no name", () => {
    const group = new Group();
    group.name = "Bracket";
    group.add(box());
    expect(hitUnderMark({ ...scene(group), samples: [{ x: 0.5, y: 0.5 }] })?.object).toBe(
      "Bracket",
    );
    expect(hitUnderMark({ ...scene(box()), samples: [{ x: 0.5, y: 0.5 }] })?.object).toBeNull();
  });

  it("lands on a point cloud, which has no faces to hit", () => {
    const cloud = new Points(new BoxGeometry(1, 1, 1, 8, 8, 8), new PointsMaterial());
    cloud.name = "Scan";
    expect(hitUnderMark({ ...scene(cloud), samples: [{ x: 0.5, y: 0.5 }] })?.object).toBe("Scan");
  });

  it("reports the point cloud's vertex itself, not the nearest spot on the ray", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([0.003, 0.004, 0, -1, -1, 0]), 3),
    );
    const root = new Group();
    root.add(new Points(geometry, new PointsMaterial()));
    root.updateMatrixWorld(true);
    const camera = new PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const space = modelSpace(root, { format: "ply", blenderSource: false });
    const hit = hitUnderMark({ root, camera, space, samples: [{ x: 0.5, y: 0.5 }] });
    close(hit?.point ?? [], [0.003, 0.004, 0]);
  });

  it("keeps a glTF node's original name, which three.js sanitizes", () => {
    const mesh = box("Mount_Plate001");
    mesh.userData.name = "Mount Plate.001";
    expect(hitUnderMark({ ...scene(mesh), samples: [{ x: 0.5, y: 0.5 }] })?.object).toBe(
      "Mount Plate.001",
    );
  });

  it("returns nothing when every sample misses", () => {
    expect(hitUnderMark({ ...scene(box("Flange")), samples: [{ x: 0.05, y: 0.95 }] })).toBeNull();
  });
});
