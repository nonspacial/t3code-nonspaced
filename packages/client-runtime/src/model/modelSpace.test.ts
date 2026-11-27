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

const close = (actual: readonly number[], expected: readonly number[], label?: string) =>
  actual.forEach((value, index) => expect(value, label).toBeCloseTo(expected[index]!, 5));

describe("model file space", () => {
  it("reports a model's points in the file's own coordinates, not the centred Y-up scene", () => {
    const stlRoot = placed(box("", [10, 4, 5]), "stl");
    const stl = modelSpace(stlRoot, { format: "stl", blenderSource: false });
    expect(stl.upAxis, "STL").toBe("z");
    close(stl.toFile(stl.fromFile([10, 4, 5])), [10, 4, 5], "STL round trip");
    close(stl.toFile(new Vector3(0, 0, 0)), [10, 4, 5], "STL centre");
    // Up on screen is up in the file.
    const up = stl.fromFile([10, 4, 6]).sub(stl.fromFile([10, 4, 5]));
    close(up.toArray(), [0, 1, 0], "STL up");

    const gltf = modelSpace(placed(box("", [1, 2, 3]), "glb"), {
      format: "glb",
      blenderSource: false,
    });
    expect(gltf.upAxis, "glTF keeps Y-up").toBe("y");
    close(gltf.toFile(new Vector3(0, 0, 0)), [1, 2, 3], "glTF centre");

    const fromBlend = modelSpace(placed(box("", [1, 2, 3]), "glb"), {
      format: "glb",
      blenderSource: true,
    });
    expect(fromBlend.upAxis, "a GLB made from a .blend").toBe("z");
    // Blender's exporter writes (x, y, z) as glTF (x, z, -y).
    close(fromBlend.toFile(new Vector3(0, 0, 0)), [1, -3, 2], "a GLB made from a .blend, centre");
    close(fromBlend.toFile(fromBlend.fromFile([4, 5, 6])), [4, 5, 6], "a GLB made from a .blend");
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
  const centre = [{ x: 0.5, y: 0.5 }];

  it("names the first object any sample lands on and where, as the file names it", () => {
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

    const group = new Group();
    group.name = "Bracket";
    group.add(box());
    expect(hitUnderMark({ ...scene(group), samples: centre })?.object, "named parent").toBe(
      "Bracket",
    );
    expect(hitUnderMark({ ...scene(box()), samples: centre })?.object, "no name").toBeNull();

    const mesh = box("Mount_Plate001");
    mesh.userData.name = "Mount Plate.001";
    expect(
      hitUnderMark({ ...scene(mesh), samples: centre })?.object,
      "a glTF node's original name, which three.js sanitizes",
    ).toBe("Mount Plate.001");

    const cloud = new Points(new BoxGeometry(1, 1, 1, 8, 8, 8), new PointsMaterial());
    cloud.name = "Scan";
    expect(hitUnderMark({ ...scene(cloud), samples: centre })?.object, "a point cloud").toBe(
      "Scan",
    );

    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([0.003, 0.004, 0, -1, -1, 0]), 3),
    );
    const points = new Group();
    points.add(new Points(geometry, new PointsMaterial()));
    points.updateMatrixWorld(true);
    const vertexHit = hitUnderMark({
      root: points,
      camera,
      space: modelSpace(points, { format: "ply", blenderSource: false }),
      samples: centre,
    });
    close(vertexHit?.point ?? [], [0.003, 0.004, 0], "a point cloud's vertex, not the ray");

    expect(
      hitUnderMark({ ...scene(box("Flange")), samples: [{ x: 0.05, y: 0.95 }] }),
      "every sample misses",
    ).toBeNull();
  });
});
