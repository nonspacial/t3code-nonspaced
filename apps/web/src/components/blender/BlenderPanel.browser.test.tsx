import type {
  HostedBlenderControl,
  HostedBlenderStreamEvents,
  HostedBlenderViewerMessage,
} from "@t3tools/client-runtime/hosted-blender/stream";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { toastManager } from "~/components/ui/toast";
import { installKeyboardCapture } from "~/lib/keyboardCapture";

import { act, render } from "../../../test/render";

const stream = vi.hoisted(() => ({
  events: null as HostedBlenderStreamEvents | null,
  sent: [] as HostedBlenderViewerMessage[],
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
    events.onStatus("live");
    return {
      resize: () => undefined,
      send: (message: HostedBlenderViewerMessage) => stream.sent.push(message),
      stop: () => undefined,
    };
  }) as never,
}));
vi.mock(import("~/state/hostedBlender"), async (original) => ({
  ...(await original()),
  useHostedBlenderState: (() => stream.state) as never,
  useHostedBlenderStreamAccess: (() => stream.access) as never,
}));

import { BlenderPanel } from "./BlenderPanel";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const control = (next: HostedBlenderControl) => act(() => stream.events?.onControl?.(next));

/** The app installs keyboard capture at startup; each test starts with a fresh stream. */
const startup = (): Disposable => {
  stream.sent = [];
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
