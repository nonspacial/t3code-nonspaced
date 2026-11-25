// @effect-diagnostics globalFetch:off - This browser-only loader fetches signed companion files without an Effect runtime, like the device model.
import {
  Box3,
  type CompressedTexture,
  DoubleSide,
  Group,
  ImageLoader,
  Loader,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Texture,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
  type WebGLRenderer,
} from "three";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader, type GLTFParser } from "three/addons/loaders/GLTFLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import type { ModelPreviewFormat } from "@t3tools/shared/filePreview";

import { resolveModelCompanionPath } from "./companionPath.ts";
import { disposeModel, ensureVertexNormals, modelFacts, orientToYUp } from "./modelGeometry.ts";
import { ModelPreviewError } from "./modelPreviewError.ts";

/**
 * Where the Draco and KTX2 decoders are served, by their file names in three's `libs`. Each loads
 * only when a glTF needs it; `renderer` says which compressed textures KTX2 may transcode to.
 */
export interface ModelDecoders {
  readonly files: Readonly<Record<string, string>>;
  readonly renderer: WebGLRenderer | null;
}

/** The extensions a glTF or GLB says it uses, read from its JSON without parsing the model. */
function gltfExtensionsUsed(data: ArrayBuffer): ReadonlySet<string> {
  try {
    const bytes = new Uint8Array(data);
    const view = new DataView(data);
    const binary = bytes.byteLength >= 20 && view.getUint32(0, true) === 0x46546c67;
    const text = new TextDecoder().decode(
      binary ? bytes.subarray(20, 20 + view.getUint32(12, true)) : bytes,
    );
    const used: unknown = JSON.parse(text).extensionsUsed;
    return new Set(Array.isArray(used) ? used.filter((name) => typeof name === "string") : []);
  } catch {
    return new Set();
  }
}

export interface ModelCompanions {
  /** Absolute host path of the model; the files it references resolve against its folder. */
  readonly modelPath: string;
  readonly workspaceRoot: string | null;
  /** Signs a URL for one referenced file, or resolves null when it cannot be read. */
  readonly mint: (path: string, signal: AbortSignal) => Promise<string | null>;
}

// Loaders' own requests for anything but embedded data end here and never leave the page:
// every referenced file is read through `companionFiles`, which applies the folder policy.
const BLOCKED_URL = "about:blank#blocked";

/** Bytes still free, shared by every read it is passed to, so concurrent reads can't overrun it. */
interface ByteBudget {
  readonly take: (bytes: number) => boolean;
  readonly give: (bytes: number) => void;
}

const byteBudget = (limit: number): ByteBudget => {
  let left = limit;
  return {
    take: (bytes) => {
      if (bytes > left) return false;
      left -= bytes;
      return true;
    },
    give: (bytes) => {
      left += bytes;
    },
  };
};

/**
 * A response's body, or null once it is over `limit` bytes. With a known length it reads into
 * one buffer of that size, so a large model is never held twice.
 */
export const readResponseBytes = (response: Response, limit: number) =>
  readWithin(response, byteBudget(limit));

/**
 * A body taken out of `budget` as it is read: a known length is reserved before its buffer is
 * allocated, an unknown one chunk by chunk. Null, with nothing taken, once it doesn't fit.
 */
async function readWithin(response: Response, budget: ByteBudget): Promise<ArrayBuffer | null> {
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    return budget.take(bytes.byteLength) ? bytes : null;
  }
  const length = Number(response.headers.get("content-length")) || null;
  if (length !== null && !budget.take(length)) {
    await response.body.cancel();
    return null;
  }
  const reader = response.body.getReader();
  let taken = length ?? 0;
  try {
    if (length !== null) {
      const bytes = new Uint8Array(length);
      let offset = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > length) throw new Error("More bytes than declared");
        bytes.set(value, offset);
        offset += value.byteLength;
      }
      budget.give(length - offset);
      taken = offset;
      return offset === length ? bytes.buffer : bytes.buffer.slice(0, offset);
    }
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!budget.take(value.byteLength)) {
        budget.give(taken);
        taken = 0;
        return null;
      }
      taken += value.byteLength;
      chunks.push(value);
    }
    const bytes = new Uint8Array(taken);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  } catch (cause) {
    budget.give(taken);
    throw cause;
  } finally {
    await reader.cancel();
  }
}

function companionFiles(companions: ModelCompanions | null, signal: AbortSignal, maxBytes: number) {
  // What the files may still take, with the model's own bytes already counted: one budget for
  // every file, so reads at once can't each see all of it.
  const budget = byteBudget(maxBytes);
  let overBudget = false;
  const missing = new Set<string>();
  /** Missing files the model cannot render without, such as a glTF buffer. */
  const required = new Set<string>();
  const urls = new Map<string, Promise<string | null>>();
  const images = new ImageLoader(new LoadingManager()).setCrossOrigin("anonymous");
  const locate = async (reference: string) => {
    const target = resolveModelCompanionPath({
      reference,
      modelPath: companions?.modelPath ?? "",
      workspaceRoot: companions?.workspaceRoot ?? null,
    });
    if (target._tag === "embedded") return { url: reference, name: null };
    if (target._tag === "rejected" || companions === null) return { url: null, name: target.name };
    let url = urls.get(target.path);
    if (url === undefined) {
      url = companions.mint(target.path, signal).catch(() => null);
      urls.set(target.path, url);
    }
    return { url: await url, name: target.name };
  };
  const read = async <T>(reference: string, load: (url: string) => Promise<T>, needed = false) => {
    const { url, name } = await locate(reference);
    const value = url === null ? null : await load(url).catch(() => null);
    if (value === null && name !== null) {
      missing.add(name);
      if (needed) required.add(name);
    }
    return value;
  };
  const fetchBytes = async (url: string, reference: string) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Companion request failed: ${response.status}`);
    const bytes = await readWithin(response, budget);
    if (bytes === null) {
      overBudget = true;
      throw new Error(`Companion over the preview's size limit: ${reference}`);
    }
    return bytes;
  };
  return {
    missing,
    required,
    get overBudget() {
      return overBudget;
    },
    bytes: (reference: string, needed?: boolean) =>
      read(reference, (url) => fetchBytes(url, reference), needed),
    text: (reference: string) =>
      read(reference, async (url) => new TextDecoder().decode(await fetchBytes(url, reference))),
    image: (reference: string) =>
      read(reference, async (url) => {
        // Embedded images are already in memory; a file's bytes are counted before decoding.
        if (/^(?:data|blob):/i.test(url)) return images.loadAsync(url);
        const local = URL.createObjectURL(new Blob([await fetchBytes(url, reference)]));
        try {
          return await images.loadAsync(local);
        } finally {
          URL.revokeObjectURL(local);
        }
      }),
  };
}

type CompanionFiles = ReturnType<typeof companionFiles>;

/**
 * Stands in for `TextureLoader` for every texture a glTF, MTL or FBX file names. Like
 * `TextureLoader` it returns the texture at once and fills its image later, but it reads the
 * image through the companion policy instead of the loader's synchronous URL.
 */
class CompanionTextureLoader extends Loader<Texture> {
  readonly pending: Promise<void>[] = [];
  readonly #files: CompanionFiles;

  constructor(manager: LoadingManager, files: CompanionFiles) {
    super(manager);
    this.#files = files;
  }

  override load(
    url: string,
    onLoad?: (texture: Texture) => void,
    _onProgress?: unknown,
    onError?: (error: unknown) => void,
  ): Texture {
    const texture = new Texture();
    // FBX clears the path for embedded images; MTLLoader prefixes its folder even to `data:` URLs.
    const joined = this.path ? `${this.path}${url}` : url;
    const reference = /(?:^|\/)((?:data|blob):.*)$/i.exec(joined)?.[1] ?? joined;
    this.pending.push(
      this.#files.image(reference).then((image) => {
        // FBX makes object URLs for embedded images and never revokes them.
        if (reference.startsWith("blob:")) URL.revokeObjectURL(reference);
        if (image === null) {
          onError?.(new Error(`Texture unavailable: ${reference}`));
          return;
        }
        texture.image = image;
        texture.needsUpdate = true;
        onLoad?.(texture);
      }),
    );
    return texture;
  }
}

function companionBuffers(parser: GLTFParser, files: CompanionFiles) {
  const json: {
    readonly bufferViews?: ReadonlyArray<{
      readonly buffer: number;
      readonly byteOffset?: number;
      readonly byteLength: number;
    }>;
    readonly buffers?: ReadonlyArray<{ readonly uri?: string }>;
  } = parser.json;
  const buffers = new Map<number, Promise<ArrayBuffer>>();
  return {
    name: "T3_companion_buffers",
    loadBufferView(index: number) {
      const view = json.bufferViews?.[index];
      const uri = view === undefined ? undefined : json.buffers?.[view.buffer]?.uri;
      if (view === undefined || uri === undefined || /^data:/i.test(uri)) return null;
      let buffer = buffers.get(view.buffer);
      if (buffer === undefined) {
        buffer = files.bytes(uri, true).then((bytes) => {
          if (bytes === null) throw new Error(`glTF buffer unavailable: ${uri}`);
          return bytes;
        });
        buffers.set(view.buffer, buffer);
      }
      const start = view.byteOffset ?? 0;
      return buffer.then((bytes) => bytes.slice(start, start + view.byteLength));
    },
  };
}

function defaultMaterial(geometry: BufferGeometry) {
  return new MeshStandardMaterial({
    color: geometry.getAttribute("color") ? 0xffffff : 0xb3bac4,
    vertexColors: geometry.getAttribute("color") !== undefined,
    roughness: 0.6,
    metalness: 0.05,
    side: DoubleSide,
  });
}

/**
 * three's BasisU path hands a glTF's `.ktx2` straight to `KTX2Loader`, past the texture loader:
 * a file it names is read through the companion policy and budget, and decoded from memory.
 */
function readKtx2Through(ktx2: Loader<CompressedTexture>, files: CompanionFiles) {
  const load = ktx2.load.bind(ktx2);
  ktx2.load = (url, onLoad, onProgress, onError) => {
    if (/^(?:data|blob):/i.test(url)) return load(url, onLoad, onProgress, onError);
    void files.bytes(url).then((bytes) => {
      if (bytes === null) {
        onError?.(new Error(`Texture unavailable: ${url}`));
        return;
      }
      const local = URL.createObjectURL(new Blob([bytes]));
      const done = () => URL.revokeObjectURL(local);
      load(
        local,
        (texture) => {
          done();
          onLoad?.(texture);
        },
        onProgress,
        (error) => {
          done();
          onError?.(error);
        },
      );
    });
  };
}

async function parseGltf(
  data: ArrayBuffer,
  manager: LoadingManager,
  files: CompanionFiles,
  decoders: ModelDecoders | null,
): Promise<Object3D> {
  const loader = new GLTFLoader(manager).register((parser) => companionBuffers(parser, files));
  const used = gltfExtensionsUsed(data);
  const disposers: Array<() => void> = [];
  if (decoders !== null) {
    // The decoders' own requests reach only their files; anything else stays blocked.
    const decoderManager = new LoadingManager();
    decoderManager.setURLModifier(
      (url) =>
        decoders.files[url.slice(url.lastIndexOf("/") + 1)] ??
        (/^(?:data|blob):/i.test(url) ? url : BLOCKED_URL),
    );
    if (used.has("KHR_draco_mesh_compression")) {
      const { DRACOLoader } = await import("three/addons/loaders/DRACOLoader.js");
      const draco = new DRACOLoader(decoderManager);
      loader.setDRACOLoader(draco);
      disposers.push(() => draco.dispose());
    }
    if (used.has("KHR_texture_basisu") && decoders.renderer !== null) {
      const { KTX2Loader } = await import("three/addons/loaders/KTX2Loader.js");
      const ktx2 = new KTX2Loader(decoderManager).detectSupport(decoders.renderer);
      readKtx2Through(ktx2, files);
      loader.setKTX2Loader(ktx2);
      disposers.push(() => ktx2.dispose());
    }
  }
  try {
    return (await loader.parseAsync(data, "")).scene;
  } finally {
    for (const dispose of disposers) dispose();
  }
}

async function parseModel(
  format: ModelPreviewFormat,
  data: ArrayBuffer,
  manager: LoadingManager,
  files: CompanionFiles,
  decoders: ModelDecoders | null,
): Promise<Object3D> {
  switch (format) {
    case "glb":
    case "gltf":
      return parseGltf(data, manager, files, decoders);
    case "stl":
      return new Mesh(...withDefaultMaterial(new STLLoader(manager).parse(data)));
    case "ply": {
      const geometry = new PLYLoader(manager).parse(data);
      // A PLY without faces is a point cloud, common for scans.
      if (geometry.index !== null) return new Mesh(...withDefaultMaterial(geometry));
      geometry.computeBoundingSphere();
      return new Points(
        geometry,
        new PointsMaterial({
          size: (geometry.boundingSphere?.radius ?? 1) / 250,
          vertexColors: geometry.getAttribute("color") !== undefined,
        }),
      );
    }
    case "3mf":
      return new ThreeMFLoader(manager).parse(data);
    case "fbx":
      return new FBXLoader(manager).parse(data, "");
    case "obj": {
      const text = new TextDecoder().decode(data);
      const loader = new OBJLoader(manager);
      const libraries = [...text.matchAll(/^[ \t]*mtllib[ \t]+(.+?)[ \t\r]*$/gm)].flatMap((match) =>
        match[1] ? [match[1]] : [],
      );
      const texts = await Promise.all(libraries.map(files.text));
      const loaded = libraries.flatMap((library, index) => {
        const material = texts[index];
        return material == null ? [] : [{ library, material }];
      });
      // Textures resolve beside their MTL; libraries in several folders fall back to the model's.
      const folders = new Set(
        loaded.map(({ library }) =>
          library
            .replaceAll("\\", "/")
            .split("/")
            .slice(0, -1)
            .filter((segment) => segment !== "" && segment !== ".")
            .map((segment) => `${segment}/`)
            .join(""),
        ),
      );
      const folder = folders.size === 1 ? ([...folders][0] ?? "") : "";
      if (loaded.length > 0)
        loader.setMaterials(
          new MTLLoader(manager).parse(loaded.map(({ material }) => material).join("\n"), folder),
        );
      return loader.parse(text);
    }
  }
}

function withDefaultMaterial(geometry: BufferGeometry) {
  return [geometry, defaultMaterial(geometry)] as const;
}

/** Drops maps whose image never arrived; a texture with no image samples as black. */
function stripUnloadedTextures(root: Object3D) {
  root.traverse((object) => {
    if (!(object instanceof Mesh || object instanceof Points)) return;
    const materials: Material | Material[] = object.material;
    for (const material of Array.isArray(materials) ? materials : [materials]) {
      for (const [key, value] of Object.entries(material)) {
        if (!(value instanceof Texture) || value.image) continue;
        value.dispose();
        Reflect.set(material, key, null);
        material.needsUpdate = true;
      }
    }
  });
}

export interface LoadedModel {
  /** Y-up and centred on the origin. */
  readonly root: Object3D;
  readonly facts: ReturnType<typeof modelFacts>;
  /** Referenced files that could not be read; the model renders without them. */
  readonly missing: ReadonlyArray<string>;
}

/** Parses meshes and materials only; nothing a file embeds is executed. */
export async function loadModel(input: {
  readonly format: ModelPreviewFormat;
  readonly data: ArrayBuffer;
  readonly companions: ModelCompanions | null;
  readonly signal: AbortSignal;
  /** The bytes the files it references may add, read before any reaches three.js. */
  readonly maxBytes?: number;
  readonly decoders?: ModelDecoders | null;
}): Promise<LoadedModel> {
  const files = companionFiles(
    input.companions,
    input.signal,
    input.maxBytes ?? Number.POSITIVE_INFINITY,
  );
  let loading = false;
  let whenIdle = () => {};
  const manager = new LoadingManager(() => {
    loading = false;
    whenIdle();
  });
  manager.onStart = () => {
    loading = true;
  };
  manager.setURLModifier((url) => (/^(?:data|blob):/i.test(url) ? url : BLOCKED_URL));
  const textures = new CompanionTextureLoader(manager, files);
  manager.addHandler(/^(?!data:|blob:)/i, textures);
  let model: Object3D;
  try {
    model = await parseModel(input.format, input.data, manager, files, input.decoders ?? null);
    await Promise.all(textures.pending);
    // Some loaders (3MF, FBX) read embedded images on their own; wait before dropping unloaded maps.
    if (loading) await new Promise<void>((resolve) => (whenIdle = resolve));
    // A texture or material over the limit is too large too, not a file that wasn't found.
    if (files.overBudget) {
      disposeModel(model);
      throw new Error("Companions over the preview's size limit");
    }
  } catch (cause) {
    await Promise.allSettled(textures.pending);
    if (files.overBudget) {
      throw new ModelPreviewError({ code: "model-too-large", missing: [], cause });
    }
    throw new ModelPreviewError({
      code: files.required.size > 0 ? "companion-missing" : "model-unreadable",
      missing: [...(files.required.size > 0 ? files.required : files.missing)],
      cause,
    });
  }
  const root = new Group();
  root.add(model);
  if (input.signal.aborted) {
    disposeModel(root);
    input.signal.throwIfAborted();
  }
  stripUnloadedTextures(root);
  if (input.format !== "glb" && input.format !== "gltf") {
    // glTF leaves out normals on purpose: viewers must shade those meshes flat. STL and 3MF
    // exporters often write zero or flipped facet normals, so those are always recomputed.
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      if (input.format === "stl" || input.format === "3mf") object.geometry.computeVertexNormals();
      else ensureVertexNormals(object.geometry);
    });
  }
  orientToYUp(root, input.format);
  const facts = modelFacts(root);
  if (facts.triangles === 0 && facts.points === 0) {
    disposeModel(root);
    throw new ModelPreviewError({ code: "model-empty", missing: [...files.missing] });
  }
  const center = new Box3().setFromObject(root).getCenter(new Vector3());
  root.position.sub(center);
  root.updateMatrixWorld(true);
  return { root, facts, missing: [...files.missing] };
}
