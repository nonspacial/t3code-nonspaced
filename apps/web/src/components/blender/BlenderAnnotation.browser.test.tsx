import "~/index.css";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  HostedBlenderControl,
  HostedBlenderStreamEvents,
} from "@t3tools/client-runtime/hosted-blender/stream";
import {
  EnvironmentId,
  type HostedBlenderViewCapture,
  type HostedBlenderViewerMessage,
  type HostedBlenderRunningState,
  ThreadId,
} from "@t3tools/contracts";
import { modelViewFromHref } from "@t3tools/shared/modelView";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { useComposerDraftStore } from "~/composerDraftStore";
import { installKeyboardCapture } from "~/lib/keyboardCapture";
import { act, render } from "../../../test/render";
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
    events: null as HostedBlenderStreamEvents | null,
    sent: [] as HostedBlenderViewerMessage[],
    /** The frame Blender draws after it reports its camera; null when none comes. */
    redraw: "#3d3d3d" as string | null,
  },
}));

/** A decoded frame of Blender in one flat colour, presented at `pts` microseconds. */
function frameOf(color: string, pts = 0) {
  const frame = document.createElement("canvas");
  frame.width = 320;
  frame.height = 180;
  const context = frame.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 320, 180);
  return new VideoFrame(frame, { timestamp: pts });
}

/** Frames that arrive after Blender answers but don't show its camera: one captured before the
 * redraw (later than any frame seen when it answered), then a repeat of cached pixels. */
const STALE = { color: "#00ff00", pts: [52, 56] };
/** The frame the helper marked as Blender's redraw from the reported camera. */
const MARKED = 60;

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

// After Blender answers, a frame it drew before answering arrives first, then the frame its
// redraw draws from the camera it reported (unless `redraw` is null).
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand:
    (command: { label: "captureView" | "findHits" | "quit" }) => async (value: unknown) => {
      const result = await commands[command.label as "captureView" | "findHits"](value);
      const redraw = stream.redraw;
      if (command.label === "captureView")
        setTimeout(() => {
          for (const pts of STALE.pts) stream.sink?.present(frameOf(STALE.color, pts), 320, 180);
          if (redraw !== null) stream.sink?.present(frameOf(redraw, MARKED), 320, 180);
        });
      return { _tag: "Success", value: result };
    },
}));

// A stream that shows one grey frame of Blender through the real canvas sink, then whatever
// a test presents to `stream.sink`.
vi.mock(import("@t3tools/client-runtime/hosted-blender/stream"), async (original) => ({
  ...(await original()),
  createHostedBlenderStreamClient: ((
    _target: unknown,
    sink: NonNullable<typeof stream.sink>,
    events: HostedBlenderStreamEvents,
  ) => {
    stream.events = events;
    events.onStatus("live");
    events.onStats({ type: "stats", encoder: "x264enc", target: stream.target, memoryBytes: null });
    stream.sink = sink;
    sink.present(frameOf("#3d3d3d"), 320, 180);
    return {
      resize: () => {},
      send: (message: HostedBlenderViewerMessage) => stream.sent.push(message),
      stop: () => {},
    };
  }) as never,
}));

// Dictation needs a connected environment; these tests type the comment.
vi.mock("~/speech/useTextFieldSpeech", () => ({
  SpeechTextField: (props: { children: (speech: undefined) => ReactNode }) =>
    props.children(undefined),
  TextFieldSpeechControls: () => null,
}));

const capture: HostedBlenderViewCapture = {
  frame: MARKED,
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
  stream.sent = [];
  stream.redraw = "#3d3d3d";
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

it("freezes the marked frame, not a stale one or a cached repeat that arrives first", async () => {
  const blender = setup("thread-blender-after-reply", "window");
  stream.redraw = "#ff0000";
  await using screen = await render(blender.element, pane());
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  expect(await frozenColor(screen)).toEqual([255, 0, 0]);
  const surface = screen.getByRole("img", { name: "Frozen 3D view to annotate" });
  await userEvent.click(screen.getByRole("button", { name: "Mark a region" }));
  drag(surface.element(), [0.4, 0.4], [0.6, 0.6]);
  await userEvent.click(screen.getByRole("button", { name: "Add to chat" }));
  await vi.waitFor(() => expect(blender.draft()?.previewAnnotations).toHaveLength(1));
  const annotation = blender.draft()!.previewAnnotations[0]!;
  expect(annotation.cameraView).toEqual(capture.cameraView);
  expect(annotation.regions[0]?.hit).toEqual({ object: "Cube", point: [0.2, -1, 0.4] });
});

it("keeps the screenshot but not the camera when no frame follows Blender's answer", async () => {
  const blender = setup("thread-blender-no-redraw", "window");
  stream.redraw = null;
  await using screen = await render(blender.element, pane());
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  const surface = screen.getByRole("img", { name: "Frozen 3D view to annotate" });
  await expect.element(surface, { timeout: 3000 }).toBeVisible();
  expect(await frozenColor(screen)).toEqual([0, 255, 0]);
  await userEvent.click(screen.getByRole("button", { name: "Mark a region" }));
  drag(surface.element(), [0.4, 0.4], [0.6, 0.6]);
  await userEvent.click(screen.getByRole("button", { name: "Add to chat" }));
  await vi.waitFor(() => expect(blender.draft()?.previewAnnotations).toHaveLength(1));
  const annotation = blender.draft()!.previewAnnotations[0]!;
  expect(annotation).not.toHaveProperty("cameraView");
  expect(annotation.regions[0]).not.toHaveProperty("hit");
  expect(commands.findHits).not.toHaveBeenCalled();
});

it("hands the keyboard to the annotation editor while in control, and control back when it closes", async () => {
  using _app = { [Symbol.dispose]: installKeyboardCapture() };
  const blender = setup("thread-blender-in-control", "window");
  await using screen = await render(blender.element, pane());
  const control = (next: HostedBlenderControl) => act(() => stream.events?.onControl?.(next));
  await control({ canOperate: true, controller: "unclaimed" });
  const viewport = screen.getByLabelText("Blender viewport");
  await viewport.click();
  await control({ canOperate: true, controller: "you" });
  await expect.element(screen.getByText("You're in control")).toBeInTheDocument();
  const pressA = () => {
    for (const type of ["keydown", "keyup"])
      viewport
        .element()
        .dispatchEvent(new KeyboardEvent(type, { code: "KeyA", key: "a", bubbles: true }));
  };
  pressA();
  expect(stream.sent.filter((message) => message.type === "key")).toHaveLength(2);

  stream.sent = [];
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  const comment = screen.getByRole("textbox", { name: "Annotation comment" });
  await expect.element(comment).toHaveFocus();
  await userEvent.keyboard("Bevel");
  await expect.element(comment).toHaveValue("Bevel");
  // The editor has the keyboard: nothing reaches Blender, and this device keeps control.
  expect(stream.sent.filter((message) => message.type === "key")).toEqual([]);
  expect(stream.sent).not.toContainEqual({ type: "releaseControl" });
  await expect.element(screen.getByText("You're in control")).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  await expect.element(comment).not.toBeInTheDocument();
  await expect.element(viewport).toHaveFocus();
  pressA();
  expect(stream.sent.filter((message) => message.type === "key")).toHaveLength(2);
  expect(stream.sent).not.toContainEqual({ type: "releaseControl" });
});

it("gives control back when focus leaves the annotation editor for elsewhere in T3", async () => {
  using _app = { [Symbol.dispose]: installKeyboardCapture() };
  const blender = setup("thread-blender-editor-leave", "window");
  await using screen = await render(
    <div className="flex flex-col">
      <button type="button">Composer</button>
      <div className="flex h-96 w-[32rem] flex-col">{blender.element}</div>
    </div>,
  );
  const control = (next: HostedBlenderControl) => act(() => stream.events?.onControl?.(next));
  await control({ canOperate: true, controller: "unclaimed" });
  await screen.getByLabelText("Blender viewport").click();
  await control({ canOperate: true, controller: "you" });
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  await expect.element(screen.getByRole("textbox", { name: "Annotation comment" })).toHaveFocus();
  expect(stream.sent).not.toContainEqual({ type: "releaseControl" });

  await userEvent.click(screen.getByRole("button", { name: "Composer" }));
  expect(stream.sent).toContainEqual({ type: "releaseControl" });
});

it("keeps a grant that lands while the annotation editor has focus", async () => {
  using _app = { [Symbol.dispose]: installKeyboardCapture() };
  const blender = setup("thread-blender-late-grant", "window");
  await using screen = await render(blender.element, pane());
  const control = (next: HostedBlenderControl) => act(() => stream.events?.onControl?.(next));
  await control({ canOperate: true, controller: "unclaimed" });
  await screen.getByLabelText("Blender viewport").click();
  expect(stream.sent).toEqual([{ type: "takeControl", takeOver: false }]);
  // The take is still on its way when the person opens the editor.
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  await expect.element(screen.getByRole("textbox", { name: "Annotation comment" })).toHaveFocus();
  await control({ canOperate: true, controller: "you" });
  await expect.element(screen.getByText("You're in control")).toBeInTheDocument();
  expect(stream.sent).not.toContainEqual({ type: "releaseControl" });
});

it("keeps the screenshot but not the camera when Blender's redraw couldn't be marked", async () => {
  const blender = setup("thread-blender-unmarked", "window");
  commands.captureView.mockReset().mockResolvedValue({ ...capture, frame: null });
  stream.redraw = null;
  await using screen = await render(blender.element, pane());
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  const surface = screen.getByRole("img", { name: "Frozen 3D view to annotate" });
  await expect.element(surface).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Mark a region" }));
  drag(surface.element(), [0.4, 0.4], [0.6, 0.6]);
  await userEvent.click(screen.getByRole("button", { name: "Add to chat" }));
  await vi.waitFor(() => expect(blender.draft()?.previewAnnotations).toHaveLength(1));
  expect(blender.draft()!.previewAnnotations[0]).not.toHaveProperty("cameraView");
  expect(commands.findHits).not.toHaveBeenCalled();
});
