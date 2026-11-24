import "~/index.css";

import { EnvironmentId, ThreadId, type AssetResource } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { MODEL_CONFIRM_BYTES, ModelFilePreview } from "./ModelFilePreview";

const { mint } = vi.hoisted(() => ({
  mint: vi.fn<(resource: AssetResource) => Promise<string | null>>(),
}));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlMinter: () => mint,
}));

function setup(files: Record<string, BlobPart> = {}) {
  mint.mockReset();
  mint.mockImplementation(async (resource) => {
    const path = resource._tag === "media-file" ? resource.path : undefined;
    const file = path === undefined ? undefined : files[path];
    return file === undefined ? null : URL.createObjectURL(new Blob([file]));
  });
}

const modelUrl = (contents: BlobPart) => URL.createObjectURL(new Blob([contents]));

// The preview fills the file pane, so it needs a pane with a size to lay out in.
function pane() {
  const container = document.createElement("div");
  container.className = "flex h-96 w-[32rem] flex-col";
  return { container };
}

// A binary STL with two facets whose normals are all zero, as many exporters write them.
function stl() {
  const view = new DataView(new ArrayBuffer(84 + 2 * 50));
  view.setUint32(80, 2, true);
  const facets = [
    [0, 0, 0, 10, 0, 0, 0, 20, 5],
    [10, 0, 0, 10, 20, 5, 0, 20, 5],
  ];
  facets.forEach((vertices, facet) =>
    vertices.forEach((value, index) =>
      view.setFloat32(84 + facet * 50 + 12 + index * 4, value, true),
    ),
  );
  return view.buffer;
}

const workspaceRoot = "/work/project";
const crate = {
  environmentId: EnvironmentId.make("environment-1"),
  resource: {
    _tag: "media-file" as const,
    threadId: ThreadId.make("thread-1"),
    path: "/work/project/models/crate/crate.gltf",
  },
  workspaceRoot,
};

// One textured triangle whose geometry lives in a separate crate.bin.
const gltf = JSON.stringify({
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
  materials: [
    { pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } },
  ],
  textures: [{ source: 0 }, { source: 1 }],
  images: [{ uri: "textures/crate%20diffuse.png" }, { uri: "../shared/escape.png" }],
  buffers: [{ uri: "crate.bin", byteLength: 60 }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 36 },
    { buffer: 0, byteOffset: 36, byteLength: 24 },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
    { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" },
  ],
});
const crateBin = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]);

it("renders a model in the browser and lists what it measured", async () => {
  setup();
  const preview = (src: string) => (
    <ModelFilePreview
      src={src}
      name="bracket.stl"
      format="stl"
      sizeBytes={0}
      companions={null}
      onRefresh={() => {}}
    />
  );
  await using screen = await render(preview(modelUrl(stl())), pane());
  await expect.element(screen.getByText("STL · rendered in the browser")).toBeVisible();
  await expect.element(screen.getByRole("img", { name: "3D view of bracket.stl" })).toBeVisible();
  await expect.element(screen.getByText("Triangles")).toBeVisible();
  await expect.element(screen.getByText("10 × 5 × 20 mm")).toBeVisible();
  expect(mint).not.toHaveBeenCalled();

  // A viewer forces its WebGL context lost when it goes, so the next one needs its own canvas.
  await screen.rerender(preview(modelUrl(stl())));
  await expect.element(screen.getByText("Loading 3D model…")).toBeVisible();
  await expect.element(screen.getByText("STL · rendered in the browser")).toBeVisible();
  const canvases = screen.container.querySelectorAll("canvas");
  expect(canvases).toHaveLength(1);
  expect(canvases[0]?.getContext("webgl2")?.isContextLost()).toBe(false);
});

it("signs each file a glTF references beside it and names the ones it cannot read", async () => {
  setup({ "/work/project/models/crate/crate.bin": crateBin });
  await using screen = await render(
    <ModelFilePreview
      src={modelUrl(gltf)}
      name="crate.gltf"
      format="gltf"
      sizeBytes={0}
      companions={crate}
      onRefresh={() => {}}
    />,
    pane(),
  );
  await expect.element(screen.getByText("2 textures not found")).toBeVisible();
  await screen.getByText("2 textures not found").click();
  await expect
    .element(screen.getByText(/not found next to crate\.gltf$/))
    .toMatchTextContent("textures/crate diffuse.png");
  await expect
    .element(screen.getByText(/not found next to crate\.gltf$/))
    .toMatchTextContent("../shared/escape.png");
  expect(mint.mock.calls.map(([resource]) => resource)).toEqual(
    expect.arrayContaining([
      {
        ...crate.resource,
        path: "/work/project/models/crate/crate.bin",
        disposition: "attachment",
      },
      { ...crate.resource, path: "/work/project/models/crate/textures/crate diffuse.png" },
    ]),
  );
  expect(mint).toHaveBeenCalledTimes(2);
});

it("explains which file is missing when a model cannot load without it", async () => {
  setup();
  await using screen = await render(
    <ModelFilePreview
      src={modelUrl(gltf)}
      name="crate.gltf"
      format="gltf"
      sizeBytes={0}
      companions={crate}
      onRefresh={() => {}}
    />,
    pane(),
  );
  await expect
    .element(screen.getByText("crate.bin could not be found next to crate.gltf."))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Try again" })).toBeVisible();
});

it("asks before parsing a very large model", async () => {
  setup();
  await using screen = await render(
    <ModelFilePreview
      src={modelUrl(stl())}
      name="scan.stl"
      format="stl"
      sizeBytes={MODEL_CONFIRM_BYTES + 1}
      companions={null}
      onRefresh={() => {}}
    />,
    pane(),
  );
  await expect.element(screen.getByText("Large model")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Load model" }));
  await expect.element(screen.getByText("STL · rendered in the browser")).toBeVisible();
});
