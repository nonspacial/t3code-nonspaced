import {
  Box3,
  DirectionalLight,
  HemisphereLight,
  NeutralToneMapping,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Sphere,
  SRGBColorSpace,
  WebGLRenderer,
  type Object3D,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { PreviewAnnotationCameraView, PreviewAnnotationHit } from "@t3tools/contracts";
import type { ModelPreviewFormat } from "@t3tools/shared/filePreview";
import type { ModelView } from "@t3tools/shared/modelView";

import { createRenderScheduler } from "../device/renderScheduler.ts";
import { disposeModel, frameDistance, type ModelPreviewFacts } from "./modelGeometry.ts";
import { loadModel, type ModelCompanions } from "./modelLoaders.ts";
import { ModelPreviewError } from "./modelPreviewError.ts";
import { hitTester, modelSpace, type ModelSpace, type ViewSample } from "./modelSpace.ts";

export {
  isModelPreviewError,
  ModelPreviewError,
  type ModelPreviewErrorCode,
} from "./modelPreviewError.ts";
export type { ModelCompanions } from "./modelLoaders.ts";
export { readResponseBytes } from "./modelLoaders.ts";
export type { ViewSample } from "./modelSpace.ts";
export type { ModelPreviewFacts } from "./modelGeometry.ts";

/** The view as it was when captured, for annotating it after the camera moves on. */
export interface ModelSnapshot {
  /** The rendered frame on `background`, at device pixels. */
  readonly image: HTMLCanvasElement;
  /** The view's size in CSS pixels, which marks on the snapshot are measured in. */
  readonly width: number;
  readonly height: number;
  readonly cameraView: PreviewAnnotationCameraView;
  /** What the captured camera saw first under `samples`, fractions of the view from its top left. */
  readonly hitAt: (samples: ReadonlyArray<ViewSample>) => PreviewAnnotationHit | null;
}

export interface ModelViewer {
  /** Parses one model and frames it. Resolves with the facts shown beside it. */
  readonly load: (input: {
    readonly format: ModelPreviewFormat;
    readonly data: ArrayBuffer;
    readonly companions: ModelCompanions | null;
    readonly signal: AbortSignal;
    /** The bytes the files it references may add. */
    readonly maxBytes?: number;
    /** A GLB converted from a `.blend` reports views and hits in Blender's Z-up coordinates. */
    readonly blenderSource?: boolean;
  }) => Promise<{ readonly facts: ModelPreviewFacts; readonly missing: ReadonlyArray<string> }>;
  readonly resize: (width: number, height: number, pixelRatio: number) => void;
  readonly resetView: () => void;
  /** Moves the camera to a view given in the file's coordinates. */
  readonly setView: (view: ModelView) => void;
  /** Renders the current view now; null until a model has loaded. */
  readonly snapshot: (background: string) => ModelSnapshot | null;
  readonly dispose: () => void;
}

/**
 * An orbitable view of one model on `canvas`. It renders only when the camera moves, the canvas
 * resizes or a model loads, so an idle preview costs no frames.
 */
export function createModelViewer(options: {
  readonly canvas: HTMLCanvasElement;
  readonly onContextLost: () => void;
}): ModelViewer {
  const { canvas } = options;
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch (cause) {
    throw new ModelPreviewError({ code: "webgl-unavailable", missing: [], cause });
  }
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  const scene = new Scene();
  const environment = (() => {
    const generator = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    try {
      return generator.fromScene(room, 0.04);
    } catch (cause) {
      renderer.dispose();
      renderer.forceContextLoss();
      throw cause;
    } finally {
      room.dispose();
      generator.dispose();
    }
  })();
  // PBR materials, which glTF uses, look flat or black with lights alone.
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.35;
  const camera = new PerspectiveCamera(35, 1, 0.01, 100);
  // A key light that follows the camera keeps the side you look at lit.
  const key = new DirectionalLight(0xffffff, 2.4);
  key.position.set(0.6, 1, 0.3);
  key.target.position.set(0, 0, -1);
  camera.add(key, key.target);
  scene.add(camera, new HemisphereLight(0xffffff, 0x50555e, 0.7));
  const scheduler = createRenderScheduler(() => renderer.render(scene, camera));
  const controls = new OrbitControls(camera, canvas);
  controls.addEventListener("change", scheduler.invalidate);
  // Until the camera is moved, resizing the pane keeps the model fitted.
  let fitted = true;
  controls.addEventListener("start", () => {
    fitted = false;
  });
  let model: Object3D | null = null;
  let space: ModelSpace | null = null;
  let viewSize = { width: 0, height: 0 };
  let radius = 1;
  let disposed = false;
  const contextLost = (event: Event) => {
    event.preventDefault();
    options.onContextLost();
  };
  canvas.addEventListener("webglcontextlost", contextLost);

  const resetView = () => {
    const distance = frameDistance(radius, camera.fov, camera.aspect);
    camera.near = distance / 100;
    camera.far = distance * 100;
    camera.position.set(1, 0.75, 1.25).normalize().multiplyScalar(distance);
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
    fitted = true;
    scheduler.invalidate();
  };

  return {
    async load(input) {
      const loaded = await loadModel(input);
      if (disposed) {
        disposeModel(loaded.root);
        input.signal.throwIfAborted();
        throw new Error("Model viewer was disposed");
      }
      if (model) {
        scene.remove(model);
        disposeModel(model);
      }
      model = loaded.root;
      scene.add(model);
      space = modelSpace(model, {
        format: input.format,
        blenderSource: input.blenderSource === true,
      });
      radius = new Box3().setFromObject(model).getBoundingSphere(new Sphere()).radius || 1;
      resetView();
      return { facts: loaded.facts, missing: loaded.missing };
    },
    resize(width, height, pixelRatio) {
      if (width <= 0 || height <= 0) return;
      renderer.setPixelRatio(Math.min(pixelRatio, 2));
      renderer.setSize(width, height, false);
      viewSize = { width, height };
      camera.aspect = width / height;
      if (fitted) resetView();
      else camera.updateProjectionMatrix();
      scheduler.invalidate();
    },
    resetView,
    setView(view) {
      if (!space) return;
      camera.position.copy(space.fromFile(view.position));
      controls.target.copy(space.fromFile(view.target));
      const distance = camera.position.distanceTo(controls.target);
      camera.near = distance / 100;
      camera.far = (distance + 2 * radius) * 100;
      camera.updateProjectionMatrix();
      controls.update();
      fitted = false;
      scheduler.invalidate();
    },
    snapshot(background) {
      if (!model || !space || viewSize.width <= 0) return null;
      // The drawing buffer is only readable in the task that rendered it.
      renderer.render(scene, camera);
      const image = document.createElement("canvas");
      image.width = canvas.width;
      image.height = canvas.height;
      const context = image.getContext("2d");
      if (!context) return null;
      context.fillStyle = background;
      context.fillRect(0, 0, image.width, image.height);
      context.drawImage(canvas, 0, 0);
      const frozenCamera = camera.clone(false);
      frozenCamera.updateMatrixWorld(true);
      const root = model;
      const frozenSpace = space;
      return {
        image,
        width: viewSize.width,
        height: viewSize.height,
        cameraView: {
          position: frozenSpace.toFile(camera.position),
          target: frozenSpace.toFile(controls.target),
          upAxis: frozenSpace.upAxis,
        },
        hitAt: hitTester({ root, camera: frozenCamera, space: frozenSpace }),
      };
    },
    dispose() {
      disposed = true;
      scheduler.dispose();
      controls.dispose();
      canvas.removeEventListener("webglcontextlost", contextLost);
      if (model) disposeModel(model);
      model = null;
      space = null;
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
