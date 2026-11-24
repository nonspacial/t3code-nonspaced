import "~/index.css";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  type HostedBlenderViewCapture,
  type HostedBlenderRunningState,
  ThreadId,
} from "@t3tools/contracts";
import { modelViewFromHref } from "@t3tools/shared/modelView";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { useComposerDraftStore } from "~/composerDraftStore";
import { render } from "../../../test/render";
import { BlenderPanel } from "./BlenderPanel";

const { commands, stream } = vi.hoisted(() => ({
  commands: {
    captureView: vi.fn<(value: unknown) => Promise<unknown>>(),
    findHits: vi.fn<(value: unknown) => Promise<unknown>>(),
  },
  stream: {
    target: "window" as "window" | "output",
    access: {},
    sink: null as null | { present: (source: CanvasImageSource, w: number, h: number) => boolean },
  },
}));

/** A frame of Blender in one flat colour, as the stream's decoder would hand it over. */
function frameOf(color: string) {
  const frame = document.createElement("canvas");
  frame.width = 320;
  frame.height = 180;
  const context = frame.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 320, 180);
  return frame;
}

const state: HostedBlenderRunningState = {
  status: "running",
  relativePath: "models/hero.wip-a1b2.blend",
  dirty: false,
};

vi.mock("~/state/hostedBlender", () => ({
  hostedBlenderEnvironment: {
    quit: { label: "quit", permissionAtom: () => Atom.make(false) },
    captureView: { label: "captureView" },
    findHits: { label: "findHits" },
  },
  useHostedBlenderState: () => state,
  useHostedBlenderStreamAccess: () => stream.access,
  refreshHostedBlenderStreamAccess: () => {},
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand:
    (command: { label: "captureView" | "findHits" | "quit" }) => async (value: unknown) => ({
      _tag: "Success",
      value: await commands[command.label as "captureView" | "findHits"](value),
    }),
}));

// A stream that shows one grey frame of Blender through the real canvas sink, then whatever
// a test presents to `stream.sink`.
vi.mock("@t3tools/client-runtime/hosted-blender/stream", () => ({
  createHostedBlenderStreamClient: (
    _target: unknown,
    sink: NonNullable<typeof stream.sink>,
    handlers: {
      onStatus: (status: "live") => void;
      onStats: (stats: { encoder: string; target: string; memoryBytes: null }) => void;
    },
  ) => {
    handlers.onStatus("live");
    handlers.onStats({ encoder: "x264enc", target: stream.target, memoryBytes: null });
    stream.sink = sink;
    sink.present(frameOf("#3d3d3d"), 320, 180);
    return { resize: () => {}, stop: () => {} };
  },
}));

// Dictation needs a connected environment; these tests type the comment.
vi.mock("~/speech/useTextFieldSpeech", () => ({
  SpeechTextField: (props: { children: (speech: undefined) => ReactNode }) =>
    props.children(undefined),
  TextFieldSpeechControls: () => null,
}));

const capture: HostedBlenderViewCapture = {
  cameraView: { position: [6, -6, 5], target: [0, 0, 0], upAxis: "z" },
  projection: {
    matrix: Array.from({ length: 16 }, (_, index) => (index % 5 === 0 ? 1 : 0)),
    region: { x: 0.05, y: 0.1, width: 0.9, height: 0.85 },
  },
};

function pane() {
  const container = document.createElement("div");
  container.className = "flex h-96 w-[32rem] flex-col";
  return { container };
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
  target.dispatchEvent(new PointerEvent("pointermove", at(to)));
  target.dispatchEvent(new PointerEvent("pointerup", at(to)));
}

function setup(threadId: string, target: "window" | "output") {
  stream.target = target;
  commands.captureView.mockReset().mockResolvedValue(capture);
  commands.findHits
    .mockReset()
    .mockResolvedValue([{ object: "Cube", point: [0.2, -1, 0.4] as const }]);
  const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make(threadId));
  return {
    element: <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />,
    draft: () => useComposerDraftStore.getState().getComposerDraft(threadRef),
  };
}

async function annotateRegion(screen: Awaited<ReturnType<typeof render>>) {
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  const surface = screen.getByRole("img", { name: "Frozen 3D view to annotate" });
  await expect.element(surface).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Mark a region" }));
  drag(surface.element(), [0.4, 0.4], [0.6, 0.6]);
  await userEvent.fill(screen.getByRole("textbox", { name: "Annotation comment" }), "Bevel");
  await userEvent.click(screen.getByRole("button", { name: "Add to chat" }));
  await expect.element(surface).not.toBeInTheDocument();
}

it("freezes the pane's frame and attaches the viewport window's camera and what each mark covers", async () => {
  const blender = setup("thread-blender-annotate", "window");
  await using screen = await render(blender.element, pane());
  await annotateRegion(screen);

  await vi.waitFor(() => expect(blender.draft()?.previewAnnotations).toHaveLength(1));
  const annotation = blender.draft()!.previewAnnotations[0]!;
  expect(annotation).toMatchObject({
    pageTitle: "hero.wip-a1b2.blend · Working copy",
    comment: "Bevel",
    cameraView: capture.cameraView,
  });
  expect(annotation.regions[0]?.hit).toEqual({ object: "Cube", point: [0.2, -1, 0.4] });
  expect(modelViewFromHref(annotation.pageUrl)).toEqual({
    position: [6, -6, 5],
    target: [0, 0, 0],
  });
  expect(commands.captureView).toHaveBeenCalledTimes(1);
  const request = commands.findHits.mock.calls[0]?.[0] as {
    input: { threadId: string; projection: unknown; marks: Array<Array<{ x: number }>> };
  };
  expect(request.input.projection).toEqual(capture.projection);
  // The region's middle, as a fraction of the frozen frame, is tried first.
  expect(request.input.marks).toHaveLength(1);
  expect(request.input.marks[0]![0]!.x).toBeCloseTo(0.5, 2);
  expect(blender.draft()?.images.map((image) => image.id)).toEqual([annotation.id]);
});

it("keeps the camera but places no marks when the stream shows the whole display", async () => {
  const blender = setup("thread-blender-display", "output");
  await using screen = await render(blender.element, pane());
  await annotateRegion(screen);

  await vi.waitFor(() => expect(blender.draft()?.previewAnnotations).toHaveLength(1));
  const annotation = blender.draft()!.previewAnnotations[0]!;
  expect(annotation.cameraView).toEqual(capture.cameraView);
  expect(annotation.regions[0]).not.toHaveProperty("hit");
  expect(commands.findHits).not.toHaveBeenCalled();
});

/** The colour in the middle of the frozen frame the editor shows. */
async function frozenColor(screen: Awaited<ReturnType<typeof render>>) {
  const surface = screen.getByRole("img", { name: "Frozen 3D view to annotate" });
  await expect.element(surface).toBeVisible();
  const href = surface.element().querySelector("image")!.getAttribute("href")!;
  const image = new Image();
  image.src = href;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  return Array.from(context.getImageData(160, 90, 1, 1).data.slice(0, 3));
}

it("freezes the first frame drawn after Blender reports its view, not the one already showing", async () => {
  const blender = setup("thread-blender-catch-up", "window");
  const reply = Promise.withResolvers<HostedBlenderViewCapture>();
  commands.captureView.mockReset().mockReturnValue(reply.promise);
  await using screen = await render(blender.element, pane());
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  // Blender has jumped to a new view; the stream is still showing the old one when it answers.
  reply.resolve(capture);
  // The new view's frames keep arriving until one is frozen.
  await vi.waitFor(() => {
    stream.sink!.present(frameOf("#ff0000"), 320, 180);
    expect(screen.getByRole("img", { name: "Frozen 3D view to annotate" }).query()).not.toBeNull();
  });
  expect(await frozenColor(screen)).toEqual([255, 0, 0]);
});

it("freezes the frame on screen when Blender sends no newer one", async () => {
  const blender = setup("thread-blender-still", "window");
  await using screen = await render(blender.element, pane());
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  expect(await frozenColor(screen)).toEqual([0x3d, 0x3d, 0x3d]);
});
