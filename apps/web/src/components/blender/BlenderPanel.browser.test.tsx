import "@fontsource-variable/inter";
import "~/index.css";

import type {
  HostedBlenderControl,
  HostedBlenderStreamEvents,
} from "@t3tools/client-runtime/hosted-blender/stream";
import { EnvironmentId, type HostedBlenderViewerMessage, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";

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
  state: { status: "running", relativePath: "models/hero.blend", dirty: false } as unknown,
  master: { status: "none" } as unknown,
  commands: [] as Array<{ readonly label: string; readonly value: unknown }>,
  targets: [] as unknown[],
  setup: null as unknown,
}));

vi.mock(import("@t3tools/client-runtime/hosted-blender/stream"), async (original) => ({
  ...(await original()),
  createHostedBlenderStreamClient: ((
    target: unknown,
    _sink: unknown,
    events: HostedBlenderStreamEvents,
  ) => {
    stream.targets.push(target);
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
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: ((command: { readonly label: string }) => async (value: unknown) => {
    stream.commands.push({ label: command.label, value });
    return { _tag: "Success", value: undefined };
  }) as never,
}));
vi.mock(import("~/state/hostedBlender"), async (original) => ({
  ...(await original()),
  useHostedBlenderState: (() => stream.state) as never,
  useHostedBlenderMasterState: (() => stream.master) as never,
  useHostedBlenderSetupState: (() => stream.setup) as never,
  useHostedBlenderStreamAccess: (() => stream.access) as never,
}));

import { BlenderPanel, FloatingBlender } from "./BlenderPanel";
import { useBlenderRoleStore } from "./blenderRole";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const kept = (kind: "closed" | "crashed", relativePath: string, recovery: boolean) => ({
  key: `workspace:${relativePath}`,
  kind,
  file: { kind: "workspace" as const, relativePath },
  recovery,
});
const control = (next: HostedBlenderControl) => act(() => stream.events?.onControl?.(next));

/** The app installs keyboard capture at startup; each test starts with a fresh stream. */
const startup = (): Disposable => {
  stream.sent = [];
  stream.sizes = [];
  stream.visible = [];
  stream.clients = 0;
  stream.events = null;
  stream.targets = [];
  stream.commands = [];
  useBlenderRoleStore.setState({ roles: {} });
  stream.master = { status: "none" };
  stream.state = { status: "running", relativePath: "models/hero.blend", dirty: false };
  return { [Symbol.dispose]: installKeyboardCapture() };
};

it("takes control on a click, sends keys to Blender, and gives control back on a click outside", async () => {
  using _app = startup();
  await using screen = await render(
    <div>
      <button type="button">Outside</button>
      <div style={{ height: 400, width: 600 }}>
        <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
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

/** What each mouse event left the browser to do, read on the window after every handler ran. */
const watchDefaults = () => {
  const log: string[] = [];
  const types = ["pointerup", "mousedown", "mouseup", "auxclick", "contextmenu", "paste"];
  const listener = (event: Event) => {
    const button = event instanceof MouseEvent ? `:${event.button}` : "";
    log.push(`${event.type}${button}${event.defaultPrevented ? " prevented" : ""}`);
  };
  for (const type of types) window.addEventListener(type, listener);
  return {
    log,
    [Symbol.dispose]: () => {
      for (const type of types) window.removeEventListener(type, listener);
    },
  };
};

/** A composer holding the document's selection, and the pane beside it, both real targets. */
const paneBesideComposer = async () => {
  const screen = await render(
    <div>
      <div contentEditable suppressContentEditableWarning aria-label="Composer">
        draft
      </div>
      <div style={{ height: 400, width: 600 }}>
        <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
      </div>
    </div>,
  );
  const composer = screen.getByLabelText("Composer").element() as HTMLElement;
  // The person typed in the composer before going to the pane.
  composer.focus();
  window.getSelection()?.selectAllChildren(composer);
  window.getSelection()?.collapseToEnd();
  const viewport = screen.getByLabelText("Blender viewport").element() as HTMLElement;
  const at = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return [rect.left + rect.width / 2, rect.top + rect.height / 2] as const;
  };
  return { screen, composer, viewport, inside: at(viewport), outside: at(composer) };
};

it("B6: a middle press takes control and focus, is swallowed, and its drag navigates once granted", async () => {
  using _app = startup();
  const pane = await paneBesideComposer();
  await using _screen = pane.screen;
  await control({ canOperate: true, controller: "unclaimed" });
  using defaults = watchDefaults();
  await commands.pointerMove(...pane.inside);
  await commands.pointerDown("middle");
  expect(stream.sent).toEqual([{ type: "takeControl", takeOver: false }]);
  expect(document.activeElement).toBe(pane.viewport);
  await control({ canOperate: true, controller: "you" });
  // Still held once control arrives, so the drag goes on to orbit, then ends outside the pane.
  await commands.pointerMove(pane.inside[0] + 5, pane.inside[1] + 5);
  await commands.pointerMove(...pane.outside);
  await commands.pointerUp("middle");
  // And a plain middle click once in control.
  await commands.pointerMove(...pane.inside);
  await commands.pointerDown("middle");
  await commands.pointerUp("middle");
  await vi.waitFor(() =>
    expect(stream.sent.filter((message) => message.type !== "pointer")).toEqual([
      { type: "takeControl", takeOver: false },
      { type: "button", button: 274, pressed: true },
      { type: "button", button: 274, pressed: false },
      { type: "button", button: 274, pressed: true },
      { type: "button", button: 274, pressed: false },
    ]),
  );
  expect(document.activeElement).toBe(pane.viewport);
  expect(pane.composer.textContent).toBe("draft");
  // Nothing was left for Chromium to act on: no autoscroll, no primary-selection paste.
  expect(defaults.log).toEqual([
    "mousedown:1 prevented",
    "pointerup:1 prevented",
    "mouseup:1 prevented",
    "auxclick:1 prevented",
    "mousedown:1 prevented",
    "pointerup:1 prevented",
    "mouseup:1 prevented",
    "auxclick:1 prevented",
  ]);
});

it("B6: a right click takes control and focus, and Blender gets that click, without a menu", async () => {
  using _app = startup();
  const pane = await paneBesideComposer();
  await using _screen = pane.screen;
  await control({ canOperate: true, controller: "unclaimed" });
  using defaults = watchDefaults();
  await commands.pointerMove(...pane.inside);
  await commands.pointerDown("right");
  await commands.pointerUp("right");
  expect(stream.sent).toEqual([{ type: "takeControl", takeOver: false }]);
  expect(document.activeElement).toBe(pane.viewport);
  // Released before the grant: Blender gets the whole click where it was made, once.
  await control({ canOperate: true, controller: "you" });
  expect(stream.sent.slice(1)).toEqual([
    { type: "pointer", x: expect.any(Number), y: expect.any(Number) },
    { type: "button", button: 273, pressed: true },
    { type: "button", button: 273, pressed: false },
  ]);
  expect(document.activeElement).toBe(pane.viewport);
  expect(defaults.log.filter((entry) => entry.startsWith("contextmenu"))).toEqual([
    "contextmenu:2 prevented",
  ]);
});

it("N3: a right press dragged out of the pane and let go before the grant is never left held", async () => {
  using _app = startup();
  const pane = await paneBesideComposer();
  await using _screen = pane.screen;
  await control({ canOperate: true, controller: "unclaimed" });
  await commands.pointerMove(...pane.inside);
  await commands.pointerDown("right");
  await commands.pointerMove(...pane.outside);
  await commands.pointerUp("right");
  await control({ canOperate: true, controller: "you" });
  expect(stream.sent.filter((message) => message.type !== "pointer")).toEqual([
    { type: "takeControl", takeOver: false },
    { type: "button", button: 273, pressed: true },
    { type: "button", button: 273, pressed: false },
  ]);
});

it("B6: a view-only pane swallows the middle and thumb buttons", async () => {
  using _app = startup();
  const pane = await paneBesideComposer();
  await using _screen = pane.screen;
  await control({ canOperate: false, controller: "unclaimed" });
  using defaults = watchDefaults();
  await commands.pointerMove(...pane.inside);
  await commands.pointerDown("middle");
  await commands.pointerUp("middle");
  // Back and Forward, which Playwright's mouse can't press.
  const canvas = pane.viewport.querySelector("canvas")!;
  for (const button of [3, 4]) {
    for (const type of ["mousedown", "mouseup", "auxclick"]) {
      canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button }));
    }
  }
  expect(stream.sent).toEqual([]);
  expect(pane.composer.textContent).toBe("draft");
  expect(defaults.log).toEqual([
    "mousedown:1 prevented",
    "pointerup:1 prevented",
    "mouseup:1 prevented",
    "auxclick:1 prevented",
    ...[3, 4].flatMap((button) =>
      ["mousedown", "mouseup", "auxclick"].map((type) => `${type}:${button} prevented`),
    ),
  ]);
});

/** One wheel notch over the middle of the pane, as Chromium reports it. */
const wheelNotch = (
  pane: { readonly viewport: HTMLElement; readonly inside: readonly [number, number] },
  down = true,
) => {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: pane.inside[0],
    clientY: pane.inside[1],
    deltaY: down ? 100 : -100,
  });
  Object.defineProperty(event, "wheelDeltaY", { value: down ? -120 : 120 });
  pane.viewport.querySelector("canvas")!.dispatchEvent(event);
  return event;
};

it("B15: a scroll over a view-only pane takes control and focus, and every notch zooms once granted", async () => {
  using _app = startup();
  const pane = await paneBesideComposer();
  await using _screen = pane.screen;
  await control({ canOperate: true, controller: "unclaimed" });
  const notches = [wheelNotch(pane), wheelNotch(pane), wheelNotch(pane, false)];
  expect(notches.map((event) => event.defaultPrevented)).toEqual([true, true, true]);
  expect(stream.sent).toEqual([{ type: "takeControl", takeOver: false }]);
  expect(document.activeElement).toBe(pane.viewport);
  await control({ canOperate: true, controller: "you" });
  // Where the pointer is, so the zoom goes there.
  expect(stream.sent.slice(1)).toEqual([
    { type: "pointer", x: expect.any(Number), y: expect.any(Number) },
    { type: "scroll", axis: "vertical", source: "wheel", value: 15, steps: 1 },
    { type: "scroll", axis: "vertical", source: "wheel", value: 15, steps: 1 },
    { type: "scroll", axis: "vertical", source: "wheel", value: -15, steps: -1 },
  ]);
  // In control, a scroll reaches Blender once, as before.
  expect(wheelNotch(pane).defaultPrevented).toBe(true);
  expect(stream.sent.filter((message) => message.type === "scroll")).toHaveLength(4);
  expect(document.activeElement).toBe(pane.viewport);
});

it("B15: a scroll takes nothing while another device is in control, the viewer can't operate, or no frame shows", async () => {
  using _app = startup();
  const pane = await paneBesideComposer();
  await using _screen = pane.screen;
  await control({ canOperate: true, controller: "another-viewer" });
  expect(wheelNotch(pane).defaultPrevented).toBe(true);
  await control({ canOperate: false, controller: "unclaimed" });
  expect(wheelNotch(pane).defaultPrevented).toBe(true);
  // Still connecting: the spinner shows and the canvas is hidden.
  await act(() => stream.events?.onStatus("connecting"));
  await control({ canOperate: true, controller: "unclaimed" });
  expect(wheelNotch(pane).defaultPrevented).toBe(true);
  expect(stream.sent).toEqual([]);
  expect(document.activeElement).toBe(pane.composer);
});

it("B15: a scroll while a take over waits for its grant never reaches Blender", async () => {
  using _app = startup();
  const pane = await paneBesideComposer();
  await using _screen = pane.screen;
  await control({ canOperate: true, controller: "another-viewer" });
  await pane.screen.getByText("Take over").click();
  expect(wheelNotch(pane).defaultPrevented).toBe(true);
  await control({ canOperate: true, controller: "you" });
  expect(stream.sent).toEqual([{ type: "takeControl", takeOver: true }]);
});

it("B15: scrolls remembered for a take that never lands are dropped", async () => {
  using _app = startup();
  const pane = await paneBesideComposer();
  await using _screen = pane.screen;
  await control({ canOperate: true, controller: "unclaimed" });
  wheelNotch(pane);
  // Refused: someone else got there first.
  await control({ canOperate: true, controller: "another-viewer" });
  await control({ canOperate: true, controller: "you" });
  expect(stream.sent.filter((message) => message.type === "scroll")).toEqual([]);
});

it("offers Take over while another device is in control, and says when control is lost", async () => {
  using _app = startup();
  await using screen = await render(
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
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
        <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
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
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
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
        <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
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

it("shows Setup needed, saying what is missing, with a way into Settings › Blender", async () => {
  using _app = startup();
  const running = stream.state;
  try {
    stream.state = { status: "notSetUp", missing: ["enabled"] };
    await using screen = await render(
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />,
    );
    await expect.element(screen.getByText("Setup needed")).toBeInTheDocument();
    await expect
      .element(screen.getByText("Switch on Hosted Blender in Settings › Blender", { exact: false }))
      .toBeInTheDocument();
    stream.state = { status: "notSetUp", missing: ["check"] };
    await screen.rerender(
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />,
    );
    await expect
      .element(screen.getByText("T3 Code hasn't checked this server yet.", { exact: false }))
      .toBeInTheDocument();
    stream.state = { status: "notSetUp", missing: ["labwc", "encoder"] };
    await screen.rerender(
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />,
    );
    await expect
      .element(screen.getByText("labwc, an H.264 encoder", { exact: false }))
      .toBeInTheDocument();
    await screen.getByRole("button", { name: "Open Blender settings" }).click();
    expect(screen.router?.state.location.pathname).toBe("/settings/blender");
    expect(screen.router?.state.location.search).toEqual({ machine: "environment-1" });

    stream.state = { status: "unavailable", reason: "sandboxedBlender" };
    await screen.rerender(
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />,
    );
    await expect.element(screen.getByText("Not available on this host")).toBeInTheDocument();
    await expect
      .element(screen.getByText("Flatpak and Snap builds of Blender", { exact: false }))
      .toBeInTheDocument();
  } finally {
    stream.state = running;
  }
});

it("shows a closed or crashed Blender's card in the pane, never in the float", async () => {
  using _app = startup();
  const running = stream.state;
  try {
    stream.state = { status: "closed", copies: [kept("closed", "models/hero.blend", true)] };
    await using pane = await render(
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />,
    );
    await expect.element(pane.getByText("Blender was closed")).toBeInTheDocument();
    await expect
      .element(pane.getByText("kept its unsaved changes", { exact: false }))
      .toBeInTheDocument();

    stream.state = { status: "crashed", copies: [kept("crashed", "models/hero.blend", false)] };
    await using float = await render(
      <div style={{ height: 180, width: 320 }}>
        <FloatingBlender threadRef={threadRef} onFrameSize={() => undefined} />
      </div>,
    );
    expect(float.container.textContent).toBe("");
    expect(stream.clients).toBe(0);
  } finally {
    stream.state = running;
  }
});

it("shows each kept file's card, naming its own file, and acts on that file", async () => {
  using _app = startup();
  const running = stream.state;
  try {
    stream.state = {
      status: "closed",
      copies: [
        {
          key: "outside:/elsewhere/outside.blend",
          kind: "closed",
          file: { kind: "outside", path: "/elsewhere/outside.blend" },
          recovery: true,
          copyPath: "/srv/state/copy.blend",
        },
        kept("crashed", "models/hero.blend", true),
      ],
    };
    await using pane = await render(
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />,
    );
    // Outside the project: named, located, and only discardable.
    await expect
      .element(pane.getByText("outside.blend is outside this project", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(pane.getByText("/srv/state/copy.blend", { exact: false }))
      .toBeInTheDocument();
    // The other file's copy is a click away, and its card is that file's.
    await pane.getByRole("button", { name: "hero.blend" }).click();
    await expect.element(pane.getByText("Blender crashed")).toBeInTheDocument();
    await expect
      .element(pane.getByText("hero.blend stopped unexpectedly", { exact: false }))
      .toBeInTheDocument();
    await expect.element(pane.getByRole("button", { name: "outside.blend" })).toBeInTheDocument();
  } finally {
    stream.state = running;
  }
});

it("warns in the status strip when the server has no usable GPU", async () => {
  using _app = startup();
  // A GPU T3 can't open is named as such, not as a missing GPU.
  for (const [status, warning] of [
    ["warning", "No GPU: Blender will be slow"],
    ["missing", "No GPU access: Blender will be slow"],
  ] as const) {
    stream.setup = {
      result: {
        status: "checked",
        ready: true,
        checks: [{ item: "gpu", status }],
        distro: null,
        packageManager: null,
        capture: null,
        commands: [],
        checkedAt: 0,
      },
      checking: false,
      installThreadId: null,
    };
    try {
      await using screen = await render(
        <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />,
      );
      await expect.element(screen.getByText(warning)).toBeInTheDocument();
    } finally {
      stream.setup = null;
    }
  }
});

it("shows Agent editing in the status strip only while the add-on says the agent acts", async () => {
  using _app = startup();
  const idle = stream.state;
  try {
    stream.state = { ...(idle as object), agentActing: true };
    await using acting = await render(
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />,
    );
    await expect.element(acting.getByText("Agent editing")).toBeInTheDocument();
  } finally {
    stream.state = idle;
  }
  await using quiet = await render(
    <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />,
  );
  await expect
    .element(quiet.getByText("You're in control").or(quiet.getByText("Watching")))
    .toBeInTheDocument();
  expect(quiet.container.textContent).not.toContain("Agent editing");
});

it("sizes the display in real pixels, and says when the window hides the pane", async () => {
  using _app = startup();
  await using screen = await render(
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
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
  const viewport = screen.getByLabelText("Blender viewport");
  await viewport.click();
  // The chat behind it still scrolls.
  const scroll = wheelNotch({ viewport: viewport.element() as HTMLElement, inside: [0, 0] });
  expect(scroll.defaultPrevented).toBe(false);
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
        <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
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

it("switches between the working copy and the master, each with its own stream", async () => {
  using _app = startup();
  stream.master = { status: "running", relativePath: "models/hero.blend", dirty: true };
  stream.state = {
    status: "running",
    relativePath: "models/hero.wip-1a2b3c4d.blend",
    dirty: false,
  };
  await using screen = await render(
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>,
  );
  await expect.element(screen.getByText("hero.wip-1a2b3c4d.blend")).toBeInTheDocument();
  await screen.getByRole("button", { name: "Master" }).click();
  await expect.element(screen.getByText("hero.blend", { exact: true })).toBeInTheDocument();
  expect(stream.targets.at(-1)).toMatchObject({ threadId: "thread-1", master: true });
  await screen.getByRole("button", { name: "Working copy" }).click();
  await expect.element(screen.getByText("hero.wip-1a2b3c4d.blend")).toBeInTheDocument();
  expect(stream.targets.at(-1)).toMatchObject({ master: false });
});

it("shows Agent editing for whichever Blender the agent acts in, master or working copy", async () => {
  using _app = startup();
  stream.master = {
    status: "running",
    relativePath: "models/hero.blend",
    dirty: true,
    agentActing: true,
  };
  stream.state = {
    status: "running",
    relativePath: "models/hero.wip-1a2b3c4d.blend",
    dirty: false,
  };
  await using screen = await render(
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>,
  );
  await expect.element(screen.getByText("hero.wip-1a2b3c4d.blend")).toBeInTheDocument();
  expect(screen.container.textContent).not.toContain("Agent editing");
  await screen.getByRole("button", { name: "Master" }).click();
  await expect.element(screen.getByText("Agent editing")).toBeInTheDocument();
});

it("N8: shows the switch beside an agent's working copy whose master is only known, offering Open in T3 Code", async () => {
  using _app = startup();
  const { hostedBlenderEnvironment } = await import("~/state/hostedBlender");
  const { Atom } = await import("effect/reactivity");
  vi.spyOn(hostedBlenderEnvironment.openMaster, "permissionAtom").mockReturnValue(
    Atom.make(true) as never,
  );
  stream.state = {
    status: "running",
    relativePath: "models/hero.wip-1a2b3c4d.blend",
    dirty: false,
  };
  stream.master = {
    status: "notOpen",
    relativePath: "models/hero.blend",
    desktop: null,
    desktopDirty: false,
  };
  await using screen = await render(
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>,
  );
  await expect.element(screen.getByText("hero.wip-1a2b3c4d.blend")).toBeInTheDocument();
  await screen.getByRole("button", { name: "Master" }).click();
  await expect.element(screen.getByText("Master not open in T3 Code")).toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Open in T3 Code" })).toBeVisible();
  // Nothing streams a master Blender that isn't open.
  expect(stream.clients).toBe(1);
});

it("shows no switch until the thread has a master", async () => {
  using _app = startup();
  stream.state = { status: "running", relativePath: "models/hero.blend", dirty: false };
  await using screen = await render(
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>,
  );
  await expect.element(screen.getByText("hero.blend")).toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Master" })).not.toBeInTheDocument();
});

it("shows the master's one copy on the Master side, and the working side's own copies there", async () => {
  using _app = startup();
  stream.state = { status: "closed", copies: [kept("closed", "models/part.blend", true)] };
  stream.master = {
    status: "crashed",
    relativePath: "models/hero.blend",
    copies: [
      {
        key: "outside:/real/models/hero.blend",
        kind: "crashed",
        file: { kind: "workspace", relativePath: "models/hero.blend" },
        recovery: true,
      },
    ],
  };
  await using screen = await render(
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>,
  );
  await expect
    .element(screen.getByText("T3 Code closed part.blend", { exact: false }))
    .toBeInTheDocument();
  // The working side never lists the master's copy under Also kept.
  await expect.element(screen.getByText("Also kept:")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Master" }).click();
  await expect.element(screen.getByText("Blender crashed")).toBeInTheDocument();
  await expect
    .element(screen.getByText("hero.blend stopped unexpectedly", { exact: false }))
    .toBeInTheDocument();
});

it("offers Move into T3 Code for a master open in the desktop Blender, and warns without its add-on", async () => {
  using _app = startup();
  stream.state = { status: "stopped" };
  stream.master = {
    status: "notOpen",
    relativePath: "models/hero.blend",
    desktop: "open",
    desktopDirty: true,
  };
  await using screen = await render(
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>,
  );
  // The switch stays above a card, so the way back is always there.
  await screen.getByRole("button", { name: "Master" }).click();
  await expect.element(screen.getByText("Open in your desktop Blender")).toBeInTheDocument();
  await expect.element(screen.getByText(/with its unsaved changes/)).toBeInTheDocument();
  await screen.getByRole("button", { name: "Working copy" }).click();
  await expect.element(screen.getByText("No hosted Blender running")).toBeInTheDocument();

  stream.master = {
    status: "notOpen",
    relativePath: "models/hero.blend",
    desktop: "noAddon",
    desktopDirty: false,
  };
  await screen.rerender(
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>,
  );
  await screen.getByRole("button", { name: "Master" }).click();
  await expect.element(screen.getByText(/can't reach its MCP add-on/)).toBeInTheDocument();
  expect(stream.clients).toBe(0);
});

it("moves the master it shows, and warns over a master a desktop Blender may share", async () => {
  using _app = startup();
  const { hostedBlenderEnvironment } = await import("~/state/hostedBlender");
  const { Atom } = await import("effect/reactivity");
  vi.spyOn(hostedBlenderEnvironment.moveIntoT3, "permissionAtom").mockReturnValue(
    Atom.make(true) as never,
  );
  stream.state = { status: "stopped" };
  stream.master = {
    status: "notOpen",
    relativePath: "models/hero.blend",
    desktop: "open",
    desktopDirty: false,
  };
  const ui = () => (
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>
  );
  await using screen = await render(ui());
  await screen.getByRole("button", { name: "Master" }).click();
  await screen.getByRole("button", { name: "Move into T3 Code" }).click();
  expect(stream.commands.at(-1)?.value).toEqual({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, relativePath: "models/hero.blend" },
  });

  stream.master = {
    status: "running",
    relativePath: "models/hero.blend",
    dirty: false,
    desktopUnchecked: true,
  };
  await screen.rerender(ui());
  await expect
    .element(screen.getByText(/couldn't check may also have this file open/))
    .toBeInTheDocument();
});
