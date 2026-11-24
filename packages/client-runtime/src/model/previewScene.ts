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
import type { ModelPreviewFormat } from "@t3tools/shared/filePreview";

import { createRenderScheduler } from "../device/renderScheduler.ts";
import { disposeModel, frameDistance, type ModelPreviewFacts } from "./modelGeometry.ts";
import { loadModel, type ModelCompanions } from "./modelLoaders.ts";
import { ModelPreviewError } from "./modelPreviewError.ts";

export {
  isModelPreviewError,
  ModelPreviewError,
  type ModelPreviewErrorCode,
} from "./modelPreviewError.ts";
export type { ModelCompanions } from "./modelLoaders.ts";
export type { ModelPreviewFacts } from "./modelGeometry.ts";

export interface ModelViewer {
  /** Parses one model and frames it. Resolves with the facts shown beside it. */
  readonly load: (input: {
    readonly format: ModelPreviewFormat;
    readonly data: ArrayBuffer;
    readonly companions: ModelCompanions | null;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly facts: ModelPreviewFacts; readonly missing: ReadonlyArray<string> }>;
  readonly resize: (width: number, height: number, pixelRatio: number) => void;
  readonly resetView: () => void;
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
      radius = new Box3().setFromObject(model).getBoundingSphere(new Sphere()).radius || 1;
      resetView();
      return { facts: loaded.facts, missing: loaded.missing };
    },
    resize(width, height, pixelRatio) {
      if (width <= 0 || height <= 0) return;
      renderer.setPixelRatio(Math.min(pixelRatio, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      if (fitted) resetView();
      else camera.updateProjectionMatrix();
      scheduler.invalidate();
    },
    resetView,
    dispose() {
      disposed = true;
      scheduler.dispose();
      controls.dispose();
      canvas.removeEventListener("webglcontextlost", contextLost);
      if (model) disposeModel(model);
      model = null;
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
