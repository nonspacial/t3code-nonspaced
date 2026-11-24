import "@fontsource-variable/inter";
import "~/index.css";

import type {
  HostedBlenderControl,
  HostedBlenderStreamEvents,
} from "@t3tools/client-runtime/hosted-blender/stream";
import { EnvironmentId, type HostedBlenderViewerMessage, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { toastManager } from "~/components/ui/toast";
import { installKeyboardCapture } from "~/lib/keyboardCapture";

import { HiddenThreadContext } from "../chat/backgroundThread";

import { act, render } from "../../../test/render";

const stream = vi.hoisted(() => ({
  events: null as HostedBlenderStreamEvents | null,
  sent: [] as HostedBlenderViewerMessage[],
  sizes: [] as Array<readonly [number, number]>,
  visible: [] as boolean[],
  clients: 0,
  access: { httpBase: "https://t3", wsBase: "wss://t3/blender", credentials: false, query: {} },
  state: { status: "running", relativePath: "models/hero.blend", dirty: false },
}));

vi.mock(import("@t3tools/client-runtime/hosted-blender/stream"), async (original) => ({
  ...(await original()),
  createHostedBlenderStreamClient: ((
    _target: unknown,
    _sink: unknown,
    events: HostedBlenderStreamEvents,
  ) => {
    stream.events = events;
    stream.clients += 1;
    events.onStatus("live");
    return {
      resize: (width: number, height: number) => stream.sizes.push([width, height]),
      // Like the real client, a repeat says nothing.
      setVisible: (visible: boolean) => {
        if (stream.visible.at(-1) !== visible) stream.visible.push(visible);
      },
      send: (message: HostedBlenderViewerMessage) => stream.sent.push(message),
      stop: () => undefined,
    };
  }) as never,
}));
// Decoded frames report the stream's size; this one is a tall pane on a HiDPI screen.
vi.mock(import("@t3tools/client-runtime/device/frame"), async (original) => ({
  ...(await original()),
  createCanvasFrameSink: ((_canvas: unknown, onSize?: (width: number, height: number) => void) => {
    onSize?.(1046, 1336);
    return { present: () => true };
  }) as never,
}));
vi.mock(import("~/state/hostedBlender"), async (original) => ({
  ...(await original()),
  useHostedBlenderState: (() => stream.state) as never,
  useHostedBlenderStreamAccess: (() => stream.access) as never,
}));

import { BlenderPanel, FloatingBlender } from "./BlenderPanel";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const control = (next: HostedBlenderControl) => act(() => stream.events?.onControl?.(next));

/** The app installs keyboard capture at startup; each test starts with a fresh stream. */
const startup = (): Disposable => {
  stream.sent = [];
  stream.sizes = [];
  stream.visible = [];
  stream.clients = 0;
  stream.events = null;
  return { [Symbol.dispose]: installKeyboardCapture() };
};

it("takes control on a click, sends keys to Blender, and gives control back on a click outside", async () => {
  using _app = startup();
  await using screen = await render(
    <div>
      <button type="button">Outside</button>
      <div style={{ height: 400, width: 600 }}>
        <BlenderPanel threadRef={threadRef} visible />
      </div>
    </div>,
  );
  await expect.element(screen.getByText("Watching")).toBeInTheDocument();
  // Without terminal:operate, the pane stays view-only.
  await expect.element(screen.getByText("Take control")).not.toBeInTheDocument();

  await control({ canOperate: true, controller: "unclaimed" });
  const viewport = screen.getByLabelText("Blender viewport");
  await viewport.click();
  expect(stream.sent).toEqual([{ type: "takeControl", takeOver: false }]);
  await control({ canOperate: true, controller: "you" });
  await expect.element(screen.getByText("You're in control")).toBeInTheDocument();
  await expect.element(screen.getByText("Fullscreen")).toBeInTheDocument();

  // Shift+F6 is Blender's; the window's own shortcut listeners never see it.
  const appShortcut = vi.fn();
  window.addEventListener("keydown", appShortcut, true);
  const target = viewport.element();
  target.dispatchEvent(
    new KeyboardEvent("keydown", { code: "F6", key: "F6", shiftKey: true, bubbles: true }),
  );
  window.removeEventListener("keydown", appShortcut, true);
  expect(appShortcut).not.toHaveBeenCalled();
  expect(stream.sent.slice(1)).toEqual([
    { type: "keymap", layout: "us", variant: "" },
    { type: "key", code: 64, pressed: true },
  ]);

  stream.sent = [];
  await screen.getByText("Outside").click();
  expect(stream.sent).toEqual([
    { type: "key", code: 64, pressed: false },
    { type: "releaseControl" },
  ]);
});

it("offers Take over while another device is in control, and says when control is lost", async () => {
  using _app = startup();
  await using screen = await render(
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible />
    </div>,
  );
  await control({ canOperate: true, controller: "another-viewer" });
  await expect.element(screen.getByText("Another device is in control")).toBeInTheDocument();
  // A click on the stream never takes control from someone else.
  await screen.getByLabelText("Blender viewport").click();
  expect(stream.sent).toEqual([]);
  await screen.getByText("Take over").click();
  expect(stream.sent).toEqual([{ type: "takeControl", takeOver: true }]);

  const toast = vi.spyOn(toastManager, "add");
  await control({ canOperate: true, controller: "you" });
  expect(toast).not.toHaveBeenCalled();
  await control({ canOperate: true, controller: "another-viewer" });
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Another device took control of Blender" }),
  );
  toast.mockRestore();
});

it("gives back a take still on its way when the user clicks away first", async () => {
  using _app = startup();
  await using screen = await render(
    <div>
      <button type="button">Outside</button>
      <div style={{ height: 400, width: 600 }}>
        <BlenderPanel threadRef={threadRef} visible />
      </div>
    </div>,
  );
  await control({ canOperate: true, controller: "unclaimed" });
  await screen.getByLabelText("Blender viewport").click();
  // The grant hasn't arrived; leaving now must still undo the take.
  await screen.getByText("Outside").click();
  expect(stream.sent).toEqual([
    { type: "takeControl", takeOver: false },
    { type: "releaseControl" },
  ]);
});

it("keeps the status strip on one line in a narrow pane, shortening the stats first", async () => {
  using _app = startup();
  await using screen = await render(
    <div style={{ height: 400, width: 540 }}>
      <BlenderPanel threadRef={threadRef} visible />
    </div>,
  );
  await control({ canOperate: true, controller: "another-viewer" });
  await act(() => {
    stream.events?.onStats({
      type: "stats",
      encoder: "nvh264enc",
      target: "window",
      memoryBytes: 1_200_000_000,
    });
    stream.events?.onFrameRate({ framesPerSecond: 60, bitsPerSecond: 12_400_000 });
  });
  const label = screen.getByText("Another device is in control").element();
  const stats = screen.getByText(/60 fps/).element();
  await expect.element(screen.getByText(/60 fps/)).toBeInTheDocument();
  // A Range gives one box per line the text takes, even inside a flex item.
  const lines = (element: Element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  };
  expect(lines(label)).toBe(1);
  expect(lines(stats)).toBe(1);
});

it("gives control straight back when it's granted after focus has moved elsewhere in T3", async () => {
  using _app = startup();
  await using screen = await render(
    <div>
      <button type="button">Outside</button>
      <div style={{ height: 400, width: 600 }}>
        <BlenderPanel threadRef={threadRef} visible />
      </div>
    </div>,
  );
  await control({ canOperate: true, controller: "another-viewer" });
  await screen.getByText("Take over").click();
  // The previous controller lets go while the take over is on its way.
  await control({ canOperate: true, controller: "unclaimed" });
  await screen.getByText("Outside").click();
  await control({ canOperate: true, controller: "you" });
  expect(stream.sent).toEqual([
    { type: "takeControl", takeOver: true },
    { type: "releaseControl" },
  ]);
});

it("sizes the display in real pixels, and says when the window hides the pane", async () => {
  using _app = startup();
  await using screen = await render(
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible />
    </div>,
  );
  const viewport = screen.getByLabelText("Blender viewport").element() as HTMLElement;
  const ratio = window.devicePixelRatio || 1;
  await vi.waitFor(() =>
    expect(stream.sizes.at(-1)).toEqual([
      viewport.clientWidth * ratio,
      viewport.clientHeight * ratio,
    ]),
  );
  expect(stream.visible).toEqual([true]);

  const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState")!;
  let state: DocumentVisibilityState = "hidden";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  try {
    document.dispatchEvent(new Event("visibilitychange"));
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  } finally {
    Object.defineProperty(document, "visibilityState", visibility);
  }
  expect(stream.visible).toEqual([true, false, true]);
});

it("floats watch-only: no size for the display, no control, and the frame size for its layout", async () => {
  using _app = startup();
  const frameSizes: unknown[] = [];
  await using screen = await render(
    <div style={{ height: 180, width: 320 }}>
      <FloatingBlender threadRef={threadRef} onFrameSize={(size) => frameSizes.push(size)} />
    </div>,
  );
  await control({ canOperate: true, controller: "unclaimed" });
  await screen.getByLabelText("Blender viewport").click();
  expect(stream.sent).toEqual([]);
  expect(stream.sizes).toEqual([]);
  expect(stream.visible).toEqual([true]);
  expect(frameSizes).toEqual([{ width: 1046, height: 1336 }]);
});

it("is off screen while Settings or Usage cover its thread, though the window is visible", async () => {
  using _app = startup();
  const pane = (hidden: boolean) => (
    <HiddenThreadContext value={hidden}>
      <div style={{ height: 400, width: 600 }}>
        <BlenderPanel threadRef={threadRef} visible />
      </div>
    </HiddenThreadContext>
  );
  await using screen = await render(pane(true));
  await expect.element(screen.getByLabelText("Blender viewport")).toBeInTheDocument();
  expect(stream.visible.at(-1)).toBe(false);
  await screen.rerender(pane(false));
  expect(stream.visible.at(-1)).toBe(true);
  // The stream stays connected throughout, so control and the decoder survive.
  expect(stream.clients).toBe(1);
});
