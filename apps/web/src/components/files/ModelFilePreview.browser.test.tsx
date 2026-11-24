import "~/index.css";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type AssetResource } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { useComposerDraftStore } from "~/composerDraftStore";
import { render } from "../../../test/render";
import { MODEL_CONFIRM_BYTES, ModelFilePreview } from "./ModelFilePreview";

const { mint } = vi.hoisted(() => ({
  mint: vi.fn<(resource: AssetResource) => Promise<string | null>>(),
}));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlMinter: () => mint,
}));

// Dictation needs a connected environment; these tests type the comment.
vi.mock("~/speech/useTextFieldSpeech", () => ({
  SpeechTextField: (props: { children: (speech: undefined) => ReactNode }) =>
    props.children(undefined),
  TextFieldSpeechControls: () => null,
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
function stl(scale = 1) {
  const view = new DataView(new ArrayBuffer(84 + 2 * 50));
  view.setUint32(80, 2, true);
  const facets = [
    [0, 0, 0, 10, 0, 0, 0, 20, 5],
    [10, 0, 0, 10, 20, 5, 0, 20, 5],
  ];
  facets.forEach((vertices, facet) =>
    vertices.forEach((value, index) =>
      view.setFloat32(84 + facet * 50 + 12 + index * 4, value * scale, true),
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

  // A new version loads into the same viewer, so its WebGL context stays.
  const canvas = screen.container.querySelector("canvas");
  await screen.rerender(preview(modelUrl(stl(2))));
  await expect.element(screen.getByText("20 × 10 × 40 mm")).toBeVisible();
  await expect.element(screen.getByText("STL · rendered in the browser")).toBeVisible();
  const canvases = screen.container.querySelectorAll("canvas");
  expect(canvases).toHaveLength(1);
  expect(canvases[0]).toBe(canvas);
  expect(canvases[0]?.getContext("webgl2")?.isContextLost()).toBe(false);
});

it("starts a new 3D view on Reload after the first one could not start", async () => {
  setup();
  const preview = (src: string, onRefresh: () => void) => (
    <ModelFilePreview
      src={src}
      name="bracket.stl"
      format="stl"
      sizeBytes={0}
      companions={null}
      onRefresh={onRefresh}
    />
  );
  const refuse = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const reload = () => void screen.rerender(preview(modelUrl(stl()), reload));
  await using screen = await render(preview(modelUrl(stl()), reload), pane());
  await expect.element(screen.getByText(/3D previews need WebGL/)).toBeVisible();

  refuse.mockRestore();
  await userEvent.click(screen.getByRole("button", { name: "Reload model" }));
  await expect.element(screen.getByRole("img", { name: "3D view of bracket.stl" })).toBeVisible();
  await expect.element(screen.getByText("10 × 5 × 20 mm")).toBeVisible();
});

it("keeps the shown model while a new version downloads, and after one that fails", async () => {
  setup();
  const preview = (src: string, pending = false) => (
    <ModelFilePreview
      src={src}
      name="bracket.stl"
      format="stl"
      sizeBytes={0}
      companions={null}
      onRefresh={() => {}}
      updatingChip={<p>bracket.stl changed · updating…</p>}
      pendingChip={pending ? <p>Converting the next save…</p> : undefined}
    />
  );
  await using screen = await render(preview(modelUrl(stl())), pane());
  await expect.element(screen.getByText("10 × 5 × 20 mm")).toBeVisible();

  const slow = "https://example.test/slow.stl";
  const { promise: download, resolve: finishDownload } = Promise.withResolvers<Response>();
  const realFetch = globalThis.fetch;
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => (input === slow ? download : realFetch(input, init)));
  await screen.rerender(preview(slow));
  await expect.element(screen.getByText("bracket.stl changed · updating…")).toBeVisible();
  await expect.element(screen.getByText("10 × 5 × 20 mm")).toBeVisible();
  finishDownload(new Response(stl(2)));
  await expect.element(screen.getByText("20 × 10 × 40 mm")).toBeVisible();
  await expect.element(screen.getByText("STL · rendered in the browser")).toBeVisible();

  const broken = modelUrl("not a model");
  await screen.rerender(preview(broken));
  await expect.element(screen.getByText("Couldn't load the new version")).toBeVisible();
  await expect.element(screen.getByText("20 × 10 × 40 mm")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Reset view" })).toBeVisible();

  // Work on the next version outranks the last one's failure.
  await screen.rerender(preview(broken, true));
  await expect.element(screen.getByText("Converting the next save…")).toBeVisible();
  await expect.element(screen.getByText("Couldn't load the new version")).not.toBeInTheDocument();
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

it("asks over the shown model before loading a very large new version", async () => {
  setup();
  const preview = (src: string, sizeBytes: number) => (
    <ModelFilePreview
      src={src}
      name="scan.stl"
      format="stl"
      sizeBytes={sizeBytes}
      companions={null}
      onRefresh={() => {}}
    />
  );
  await using screen = await render(preview(modelUrl(stl()), 0), pane());
  await expect.element(screen.getByText("10 × 5 × 20 mm")).toBeVisible();
  const canvas = screen.container.querySelector("canvas");

  // Known to be large before it downloads.
  await screen.rerender(preview(modelUrl(stl(2)), MODEL_CONFIRM_BYTES + 1));
  await expect.element(screen.getByRole("button", { name: "Load model" })).toBeVisible();
  await expect.element(screen.getByText("10 × 5 × 20 mm")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Keep this version" }));
  await expect.element(screen.getByText("A newer version is available")).toBeVisible();
  await expect.element(screen.getByText("10 × 5 × 20 mm")).toBeVisible();
  await userEvent.click(screen.getByText("A newer version is available"));
  await userEvent.click(screen.getByRole("button", { name: "Load model" }));
  await expect.element(screen.getByText("20 × 10 × 40 mm")).toBeVisible();
  expect(screen.container.querySelector("canvas")).toBe(canvas);
});

it("asks over the shown model when a new version turns out large as it downloads", async () => {
  setup();
  const preview = (src: string) => (
    <ModelFilePreview
      src={src}
      name="scan.stl"
      format="stl"
      sizeBytes={0}
      companions={null}
      onRefresh={() => {}}
    />
  );
  await using screen = await render(preview(modelUrl(stl())), pane());
  await expect.element(screen.getByText("10 × 5 × 20 mm")).toBeVisible();
  const canvas = screen.container.querySelector("canvas");

  const large = "https://example.test/large.stl";
  const realFetch = globalThis.fetch;
  using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    input === large
      ? Promise.resolve(
          new Response(stl(2), {
            headers: { "content-length": String(MODEL_CONFIRM_BYTES + 1) },
          }),
        )
      : realFetch(input, init),
  );
  await screen.rerender(preview(large));
  await expect.element(screen.getByRole("button", { name: "Load model" })).toBeVisible();
  await expect.element(screen.getByText("10 × 5 × 20 mm")).toBeVisible();
  expect(screen.container.querySelector("canvas")).toBe(canvas);
});

const environmentId = EnvironmentId.make("environment-1");

function annotated(threadId: string, view?: { position: number[]; target: number[] }) {
  const composerTarget = scopeThreadRef(environmentId, ThreadId.make(threadId));
  return {
    composerTarget,
    draft: () => useComposerDraftStore.getState().getComposerDraft(composerTarget),
    element: (
      <ModelFilePreview
        src={modelUrl(stl())}
        name="bracket (v2).stl"
        format="stl"
        sizeBytes={0}
        companions={null}
        onRefresh={() => {}}
        annotation={{ composerTarget, environmentId, linkPath: "out/bracket (v2).stl" }}
        {...(view
          ? {
              view: {
                view: {
                  position: view.position as [number, number, number],
                  target: view.target as [number, number, number],
                },
                requestId: 1,
              },
            }
          : {})}
      />
    ),
  };
}

function drag(target: Element, from: [number, number], to: [number, number]) {
  const box = target.getBoundingClientRect();
  const at = ([x, y]: [number, number]) => ({
    clientX: box.left + box.width * x,
    clientY: box.top + box.height * y,
    pointerId: 1,
    button: 0,
    bubbles: true,
  });
  target.dispatchEvent(new PointerEvent("pointerdown", at(from)));
  target.dispatchEvent(
    new PointerEvent("pointermove", at([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2])),
  );
  target.dispatchEvent(new PointerEvent("pointermove", at(to)));
  target.dispatchEvent(new PointerEvent("pointerup", at(to)));
}

it("freezes the view to annotate and attaches its camera and what each mark covers", async () => {
  setup();
  const model = annotated("thread-annotate");
  await using screen = await render(model.element, pane());
  await expect.element(screen.getByText("STL · rendered in the browser")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  const surface = screen.getByRole("img", { name: "Frozen 3D view to annotate" });
  await expect.element(surface).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Mark a region" }));
  drag(surface.element(), [0.45, 0.45], [0.55, 0.55]);
  await userEvent.click(screen.getByRole("button", { name: "Draw" }));
  drag(surface.element(), [0.02, 0.02], [0.06, 0.04]);
  // A stray line in the middle is erased; the marks around it stay.
  drag(surface.element(), [0.2, 0.8], [0.3, 0.8]);
  drag(surface.element(), [0.9, 0.9], [0.95, 0.95]);
  await userEvent.click(screen.getByRole("button", { name: "Erase a mark" }));
  drag(surface.element(), [0.25, 0.8], [0.25, 0.8]);
  await userEvent.fill(screen.getByRole("textbox", { name: "Annotation comment" }), "Thicken");
  await userEvent.click(screen.getByRole("button", { name: "Add to chat" }));

  await vi.waitFor(() => expect(model.draft()?.previewAnnotations).toHaveLength(1));
  await expect.element(surface).not.toBeInTheDocument();
  const annotation = model.draft()!.previewAnnotations[0]!;
  expect(annotation).toMatchObject({
    pageTitle: "bracket (v2).stl",
    comment: "Thicken",
    cameraView: { upAxis: "z" },
  });
  expect(annotation.pageUrl).toMatch(/^out\/bracket%20%28v2%29\.stl#view=/);
  // The region covers the slanted facets, whose points satisfy z = y / 4 in the STL's own space.
  const hit = annotation.regions[0]?.hit;
  expect(hit?.object).toBeNull();
  expect(hit?.point[2]).toBeCloseTo((hit?.point[1] ?? Number.NaN) / 4, 2);
  // The drawings in the empty corners cover nothing.
  expect(annotation.strokes).toHaveLength(2);
  expect(annotation.strokes[0]).not.toHaveProperty("hit");
  expect(model.draft()?.images.map((image) => image.id)).toEqual([annotation.id]);
});

it("cancels an annotation without attaching anything", async () => {
  setup();
  const model = annotated("thread-cancel");
  await using screen = await render(model.element, pane());
  await expect.element(screen.getByText("STL · rendered in the browser")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  await userEvent.keyboard("{Escape}");
  await expect
    .element(screen.getByRole("img", { name: "Frozen 3D view to annotate" }))
    .not.toBeInTheDocument();
  expect(model.draft()?.previewAnnotations ?? []).toHaveLength(0);
  await expect.element(screen.getByRole("button", { name: "Screenshot & annotate" })).toBeVisible();
});

it("opens at the camera a view link carries, in the file's own coordinates", async () => {
  setup();
  const model = annotated("thread-view", { position: [30, 40, 50], target: [5, 10, 2.5] });
  await using screen = await render(model.element, pane());
  await expect.element(screen.getByText("STL · rendered in the browser")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  await userEvent.fill(screen.getByRole("textbox", { name: "Annotation comment" }), "From here");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(model.draft()?.previewAnnotations).toHaveLength(1));
  const camera = model.draft()!.previewAnnotations[0]!.cameraView!;
  camera.position.forEach((value, index) => expect(value).toBeCloseTo([30, 40, 50][index]!, 3));
  camera.target.forEach((value, index) => expect(value).toBeCloseTo([5, 10, 2.5][index]!, 3));
});
