import {
  Box3,
  InstancedMesh,
  Line,
  Mesh,
  Points,
  Texture,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from "three";
import type { ModelPreviewFormat } from "@t3tools/shared/filePreview";

/**
 * Recomputes normals a model left out or wrote as zeros. STL exporters often write zero facet
 * normals, which light as solid black. Returns whether the normals were recomputed.
 */
export function ensureVertexNormals(geometry: BufferGeometry): boolean {
  const normals = geometry.getAttribute("normal");
  if (normals && normals.count > 0) {
    let usable = true;
    for (let index = 0; index < normals.count && usable; index += 1)
      usable = normals.getX(index) !== 0 || normals.getY(index) !== 0 || normals.getZ(index) !== 0;
    if (usable) return false;
  }
  geometry.computeVertexNormals();
  return true;
}

const Z_UP_FORMATS: ReadonlySet<ModelPreviewFormat> = new Set(["stl", "3mf"]);

export function isZUpFormat(format: ModelPreviewFormat) {
  return Z_UP_FORMATS.has(format);
}

/** STL and 3MF models are Z-up; three.js is Y-up. */
export function orientToYUp(root: Object3D, format: ModelPreviewFormat) {
  if (isZUpFormat(format)) root.rotateX(-Math.PI / 2);
  root.updateMatrixWorld(true);
}

/**
 * How far a camera must sit from a bounding sphere to fit it in both directions of the view,
 * with a margin that keeps the model clear of the preview's corner overlays.
 */
export function frameDistance(radius: number, verticalFovDegrees: number, aspect: number) {
  const vertical = (verticalFovDegrees * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
  return (radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.25;
}

export interface ModelPreviewFacts {
  readonly triangles: number;
  readonly points: number;
  readonly meshes: number;
  /** Bounding-box size in the model's own units, Y-up. */
  readonly size: readonly [x: number, y: number, z: number];
}

export function modelFacts(root: Object3D): ModelPreviewFacts {
  let triangles = 0;
  let points = 0;
  let meshes = 0;
  root.traverse((object) => {
    if (object instanceof Mesh) {
      const geometry: BufferGeometry = object.geometry;
      const count = geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0;
      triangles += Math.floor(count / 3) * (object instanceof InstancedMesh ? object.count : 1);
      meshes += 1;
    } else if (object instanceof Points) {
      const geometry: BufferGeometry = object.geometry;
      points += geometry.getAttribute("position")?.count ?? 0;
    }
  });
  const size = new Box3().setFromObject(root).getSize(new Vector3());
  const finite = (value: number) => (Number.isFinite(value) ? value : 0);
  return { triangles, points, meshes, size: [finite(size.x), finite(size.y), finite(size.z)] };
}

/** Frees every geometry, material and texture under `root`. */
export function disposeModel(root: Object3D) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (!(object instanceof Mesh || object instanceof Points || object instanceof Line)) return;
    geometries.add(object.geometry);
    const objectMaterials: Material | Material[] = object.material;
    for (const material of Array.isArray(objectMaterials) ? objectMaterials : [objectMaterials]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) {
    texture.dispose();
    if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap)
      texture.image.close();
  }
}
