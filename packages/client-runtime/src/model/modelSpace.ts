import {
  Box3,
  Matrix4,
  Mesh,
  Points,
  Raycaster,
  Sphere,
  Vector2,
  Vector3,
  type Camera,
  type Object3D,
} from "three";
import type { PreviewAnnotationHit, PreviewAnnotationVector } from "@t3tools/contracts";
import type { ModelPreviewFormat } from "@t3tools/shared/filePreview";
import { cleanModelCoordinate } from "@t3tools/shared/modelView";

import { isZUpFormat } from "./modelGeometry.ts";

/**
 * The coordinates of the file a preview shows, which views and hits are reported in. The scene is
 * centred and Y-up; the file keeps its own origin and, for STL, 3MF and `.blend`, its Z-up axes.
 */
export interface ModelSpace {
  readonly upAxis: "y" | "z";
  readonly toFile: (world: Vector3) => PreviewAnnotationVector;
  readonly fromFile: (file: PreviewAnnotationVector) => Vector3;
}

/** A point on a view, as fractions of its width and height from the top-left corner. */
export interface ViewSample {
  readonly x: number;
  readonly y: number;
}

// Blender's glTF exporter writes Blender's (x, y, z) as glTF's (x, z, -y).
const BLENDER_TO_GLTF = new Matrix4().makeRotationX(-Math.PI / 2);

export function modelSpace(
  root: Object3D,
  options: { readonly format: ModelPreviewFormat; readonly blenderSource: boolean },
): ModelSpace {
  const fileToWorld = root.matrixWorld.clone();
  if (options.blenderSource) fileToWorld.multiply(BLENDER_TO_GLTF);
  const worldToFile = fileToWorld.clone().invert();
  return {
    upAxis: options.blenderSource || isZUpFormat(options.format) ? "z" : "y",
    toFile: (world) => {
      const file = world.clone().applyMatrix4(worldToFile);
      return [
        cleanModelCoordinate(file.x),
        cleanModelCoordinate(file.y),
        cleanModelCoordinate(file.z),
      ];
    },
    fromFile: (file) => new Vector3(...file).applyMatrix4(fileToWorld),
  };
}

function objectName(object: Object3D, root: Object3D): string | null {
  for (
    let current: Object3D | null = object;
    current && current !== root;
    current = current.parent
  ) {
    // GLTFLoader sanitizes names for animation paths and keeps the file's own in userData.
    const original: unknown = current.userData.name;
    const name = (typeof original === "string" ? original : current.name).trim();
    if (name) return name;
  }
  return null;
}

/** The first surface, or point of a point cloud, under any of `samples`, tried in order. */
export function hitUnderMark(input: {
  readonly root: Object3D;
  readonly camera: Camera;
  readonly space: ModelSpace;
  readonly samples: ReadonlyArray<ViewSample>;
}): PreviewAnnotationHit | null {
  const raycaster = new Raycaster();
  // Point clouds have no faces; a point counts when the ray passes within this of it.
  raycaster.params.Points.threshold =
    new Box3().setFromObject(input.root).getBoundingSphere(new Sphere()).radius / 100 || 0.01;
  const pointer = new Vector2();
  for (const sample of input.samples) {
    pointer.set(sample.x * 2 - 1, 1 - sample.y * 2);
    raycaster.setFromCamera(pointer, input.camera);
    const hit = raycaster
      .intersectObject(input.root, true)
      .find(({ object }) => (object instanceof Mesh || object instanceof Points) && object.visible);
    if (!hit) continue;
    // A point cloud hit reports the spot on the ray nearest the vertex; the vertex is what was marked.
    const position =
      hit.object instanceof Points ? hit.object.geometry.getAttribute("position") : null;
    const point =
      position && hit.index !== undefined
        ? new Vector3()
            .fromBufferAttribute(position, hit.index)
            .applyMatrix4(hit.object.matrixWorld)
        : hit.point;
    return { object: objectName(hit.object, input.root), point: input.space.toFile(point) };
  }
  return null;
}
