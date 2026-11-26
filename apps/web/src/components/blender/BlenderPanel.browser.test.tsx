import "@fontsource-variable/inter";
import "~/index.css";

import type {
  HostedBlenderControl,
  HostedBlenderStreamEvents,
} from "@t3tools/client-runtime/hosted-blender/stream";
import {
  EnvironmentId,
  type HostedBlenderInputMessage,
  type HostedBlenderRunningState,
  type HostedBlenderViewCapture,
  type HostedBlenderViewerMessage,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { modelViewFromHref } from "@t3tools/shared/modelView";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { commands, userEvent } from "vite-plus/test/browser";

import { useComposerDraftStore } from "~/composerDraftStore";
import { toastManager } from "~/components/ui/toast";
import { captureKeyboard, installKeyboardCapture } from "~/lib/keyboardCapture";

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
  /** Unsaved image edits hold any quit that isn't a discard. */
  imagesHold: false,
  /** Blender has another file open than the quit named, so the next quit is refused. */
  openFileChanged: false,
  // The annotation tests: the real canvas sink, one grey frame, and Blender's answers.
  annotating: false,
  target: "window" as "window" | "output",
  sink: null as null | { present: (source: CanvasImageSource, w: number, h: number) => boolean },
  captureView: null as unknown as (value: unknown) => Promise<unknown>,
  findHits: null as unknown as (value: unknown) => Promise<unknown>,
}));

vi.mock(import("@t3tools/client-runtime/hosted-blender/stream"), async (original) => ({
  ...(await original()),
  createHostedBlenderStreamClient: ((
    target: unknown,
    sink: unknown,
    events: HostedBlenderStreamEvents,
  ) => {
    stream.targets.push(target);
    stream.events = events;
    stream.clients += 1;
    events.onStatus("live");
    if (stream.annotating) {
      events.onStats({
        type: "stats",
        encoder: "x264enc",
        target: stream.target,
        memoryBytes: null,
      });
      stream.sink = sink as NonNullable<typeof stream.sink>;
      stream.sink.present(frameOf("#3d3d3d"), 320, 180);
    }
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
vi.mock(import("@t3tools/client-runtime/device/frame"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createCanvasFrameSink: ((
      canvas: HTMLCanvasElement,
      onSize?: (width: number, height: number) => void,
    ) => {
      if (stream.annotating) return actual.createCanvasFrameSink(canvas, onSize);
      onSize?.(1046, 1336);
      return { present: () => true };
    }) as never,
  };
});
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: ((command: { readonly label: string }) => async (value: unknown) => {
    stream.commands.push({ label: command.label, value });
    const input = (value as { readonly input?: { readonly discard?: boolean } }).input;
    if (stream.openFileChanged && command.label.endsWith(":quit")) {
      stream.openFileChanged = false;
      const { HostedBlenderError } = await import("@t3tools/contracts");
      const Cause = await import("effect/Cause");
      return {
        _tag: "Failure",
        cause: Cause.fail(new HostedBlenderError({ reason: "openFileChanged" })),
      };
    }
    if (stream.imagesHold && command.label.endsWith(":quit") && input?.discard !== true) {
      const { HostedBlenderError } = await import("@t3tools/contracts");
      const Cause = await import("effect/Cause");
      return {
        _tag: "Failure",
        cause: Cause.fail(new HostedBlenderError({ reason: "unsavedImages" })),
      };
    }
    const answer = command.label.endsWith(":capture-view")
      ? stream.captureView
      : command.label.endsWith(":find-hits")
        ? stream.findHits
        : null;
    if (answer === null) return { _tag: "Success", value: undefined };
    const result = await answer(value);
    return result === FAILED
      ? { _tag: "Failure", cause: new Error("failed") }
      : { _tag: "Success", value: result };
  }) as never,
}));
// Dictation needs a connected environment; the annotation tests type the comment.
vi.mock("~/speech/useTextFieldSpeech", () => ({
  SpeechTextField: (props: { children: (speech: undefined) => ReactNode }) =>
    props.children(undefined),
  TextFieldSpeechControls: () => null,
}));
vi.mock(import("~/state/hostedBlender"), async (original) => ({
  ...(await original()),
  useHostedBlenderState: (() => stream.state) as never,
  useHostedBlenderMasterState: (() => stream.master) as never,
  useHostedBlenderSetupState: (() => stream.setup) as never,
  useHostedBlenderStreamAccess: (() => stream.access) as never,
}));

import { attachBlenderInput, type TakeScroll } from "./blenderInput";
import { BlenderPanel, FloatingBlender } from "./BlenderPanel";
import { useBlenderRoleStore } from "./blenderRole";
import { useKeptCopySelection } from "./keptCopies";

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
const canReopen = async () => {
  const { hostedBlenderEnvironment } = await import("~/state/hostedBlender");
  const { Atom } = await import("effect/reactivity");
  return vi
    .spyOn(hostedBlenderEnvironment.reopen, "permissionAtom")
    .mockReturnValue(Atom.make(true) as never);
};
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
  stream.imagesHold = false;
  stream.openFileChanged = false;
  useBlenderRoleStore.setState({ roles: {} });
  useKeptCopySelection.setState({ byThread: {}, dismissedReloads: {} });
  stream.master = { status: "none" };
  stream.state = { status: "running", relativePath: "models/hero.blend", dirty: false };
  stream.annotating = false;
  stream.access = {
    httpBase: "https://t3",
    wsBase: "wss://t3/blender",
    credentials: false,
    query: {},
  };
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
  // The memory figure says whose it is, still on the same line.
  const memory = screen.getByText(/^Blender memory /).element();
  expect(lines(memory)).toBe(1);
});

it("keeps a reload notice dismissed when the pane is shown again", async () => {
  using _app = startup();
  stream.state = {
    status: "running",
    relativePath: "models/hero.blend",
    dirty: false,
    reloadKept: { key: "workspace:models/hero.blend", at: 5 },
  };
  const pane = () => (
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>
  );
  {
    await using screen = await render(pane());
    await screen.getByRole("button", { name: "Dismiss" }).click();
    await expect
      .element(screen.getByText("changed on disk, so Blender reloaded it", { exact: false }))
      .not.toBeInTheDocument();
  }
  // The right panel unmounts a hidden surface; showing it again mounts the pane anew.
  await using again = await render(pane());
  await expect.element(again.getByText("Watching")).toBeInTheDocument();
  await expect
    .element(again.getByText("changed on disk, so Blender reloaded it", { exact: false }))
    .not.toBeInTheDocument();
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
  const { hostedBlenderEnvironment } = await import("~/state/hostedBlender");
  const { Atom } = await import("effect/reactivity");
  using _check = vi
    .spyOn(hostedBlenderEnvironment.checkSetup, "permissionAtom")
    .mockReturnValue(Atom.make(true) as never);
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
    // Installed, but the test encode failed: nothing to install, and Check again retries it.
    stream.setup = {
      result: {
        status: "checked",
        ready: false,
        checks: [{ item: "encoder", status: "failed" }],
        distro: null,
        packageManager: null,
        capture: null,
        commands: [],
        checkedAt: 1,
      },
      checking: false,
      installThreadId: null,
    };
    stream.state = { status: "notSetUp", missing: ["encoder"] };
    await screen.rerender(
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />,
    );
    await expect
      .element(screen.getByText("If the GPU was busy, check again.", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("This server is missing", { exact: false }))
      .not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Check again" }).click();
    expect(stream.commands.at(-1)?.value).toEqual({
      environmentId: threadRef.environmentId,
      input: {},
    });
    stream.setup = null;
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

it("B19: asks about other threads' held copies once the master moved on, and Delete or Keep answers for them", async () => {
  using _app = startup();
  const { hostedBlenderEnvironment } = await import("~/state/hostedBlender");
  const { Atom } = await import("effect/reactivity");
  vi.spyOn(hostedBlenderEnvironment.deleteHeld, "permissionAtom").mockReturnValue(
    Atom.make(true) as never,
  );
  stream.state = {
    status: "stopped",
    heldBehind: {
      ids: ["held-a", "held-b"],
      master: "models/hero.blend",
      threadTitles: ["Hero pass", "Rig fix"],
      bytes: 3 * 1024 * 1024,
      expiresAt: new Date(2026, 11, 20).getTime(),
    },
  };
  await using screen = await render(
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>,
  );
  await expect
    .element(
      screen.getByText(
        /^hero\.blend has changed since T3 Code held 2 working copies of it from Hero pass, Rig fix \(3(\.0+)? MB\)\. They hold an edition you've moved past\. Delete them now, or keep them until [^.]*20[^.]*\.$/,
      ),
    )
    .toBeInTheDocument();
  await screen.getByRole("button", { name: "Delete" }).click();
  await screen.getByRole("button", { name: "Keep" }).click();
  expect(stream.commands).toEqual([
    {
      label: "environment-data:hosted-blender:delete-held",
      value: { environmentId: threadRef.environmentId, input: { ids: ["held-a", "held-b"] } },
    },
    {
      label: "environment-data:hosted-blender:keep-held",
      value: { environmentId: threadRef.environmentId, input: { ids: ["held-a", "held-b"] } },
    },
  ]);
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

it("asks with the quit dialog when image edits hold a quit, and says so in the pane meanwhile", async () => {
  using _app = startup();
  stream.imagesHold = true;
  const { hostedBlenderEnvironment } = await import("~/state/hostedBlender");
  const { Atom } = await import("effect/reactivity");
  using _quit = vi
    .spyOn(hostedBlenderEnvironment.quit, "permissionAtom")
    .mockReturnValue(Atom.make(true) as never);
  const ui = () => (
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>
  );
  const line = "Blender has unsaved image edits, which quitting without saving discards.";
  const quits = () =>
    stream.commands.filter((command) => command.label.endsWith(":quit")).map(({ value }) => value);
  {
    await using screen = await render(ui());
    await control({ canOperate: true, controller: "unclaimed" });
    await screen.getByRole("button", { name: "Blender menu" }).click();
    await screen.getByRole("menuitem", { name: "Quit Blender" }).click();
    await expect.element(screen.getByText(line)).toBeVisible();
    await act(() =>
      (
        screen.getByRole("button", { name: "Quit without saving" }).element() as HTMLElement
      ).click(),
    );
    await vi.waitFor(() => expect(quits()).toHaveLength(2));
    expect(quits()).toEqual([
      {
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, save: false },
      },
      {
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, save: false, discard: true },
      },
    ]);
  }
  // A settle held meanwhile: the pane says why Blender stayed open, and its Quit asks at once.
  stream.commands = [];
  const openFile = { kind: "workspace", relativePath: "models/hero.blend" } as const;
  stream.state = {
    status: "running",
    relativePath: "models/hero.blend",
    dirty: false,
    openFile,
    quitHeld: "images",
  };
  await using screen = await render(ui());
  await expect
    .element(screen.getByText(/Blender stayed open: quitting would lose its unsaved image edits/))
    .toBeVisible();
  await screen.getByRole("button", { name: "Quit…" }).click();
  await expect.element(screen.getByText(line)).toBeVisible();
  expect(quits()).toEqual([]);
  // Save and quit names the file the dialog showed, as Quit without saving does.
  await screen.getByRole("button", { name: "Save and quit" }).click();
  await vi.waitFor(() => expect(quits()).toHaveLength(1));
  expect(quits()[0]).toEqual({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, save: true, openFile },
  });
});

it("keeps the quit dialog on the file it asked about, asking afresh once Blender has another open", async () => {
  using _app = startup();
  const { hostedBlenderEnvironment } = await import("~/state/hostedBlender");
  const { Atom } = await import("effect/reactivity");
  using _quit = vi
    .spyOn(hostedBlenderEnvironment.quit, "permissionAtom")
    .mockReturnValue(Atom.make(true) as never);
  const running = stream.state;
  const hero = { kind: "workspace", relativePath: "models/hero.blend" } as const;
  const other = { kind: "workspace", relativePath: "models/other.blend" } as const;
  const opened = (openFile: typeof hero | typeof other) => ({
    status: "running",
    relativePath: "models/hero.blend",
    dirty: true,
    openFile,
  });
  const ui = () => (
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>
  );
  const quits = () =>
    stream.commands.filter((command) => command.label.endsWith(":quit")).map(({ value }) => value);
  try {
    stream.state = opened(hero);
    await using screen = await render(ui());
    await control({ canOperate: true, controller: "unclaimed" });
    await screen.getByRole("button", { name: "Blender menu" }).click();
    await screen.getByRole("menuitem", { name: "Quit Blender" }).click();
    await expect
      .element(screen.getByText("Save changes to hero.blend before quitting?"))
      .toBeVisible();
    // Another device opens other.blend while the dialog is up: what it asked is void.
    stream.state = opened(other);
    await screen.rerender(ui());
    await expect
      .element(screen.getByText("Blender has other.blend open now.", { exact: false }))
      .toBeVisible();
    await expect
      .element(screen.getByText("Save changes to other.blend before quitting?"))
      .toBeVisible();
    expect(quits()).toEqual([]);
    // Blender opened yet another before the save reached it: refused, and the dialog asks again.
    stream.openFileChanged = true;
    await screen.getByRole("button", { name: "Save and quit" }).click();
    await vi.waitFor(() => expect(quits()).toHaveLength(1));
    expect(quits()[0]).toEqual({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, save: true, openFile: other },
    });
    await expect
      .element(screen.getByText("Blender has other.blend open now.", { exact: false }))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Save and quit" })).toBeVisible();
  } finally {
    stream.state = running;
  }
});

it("fits its toolbar in a 360 px pane with a master, the menu still in reach and the name whole on its own line", async () => {
  using _app = startup();
  const { hostedBlenderEnvironment } = await import("~/state/hostedBlender");
  const { Atom } = await import("effect/reactivity");
  using _quit = vi
    .spyOn(hostedBlenderEnvironment.quit, "permissionAtom")
    .mockReturnValue(Atom.make(true) as never);
  stream.state = { status: "running", relativePath: "models/hero.wip-a1b2.blend", dirty: false };
  stream.master = {
    status: "running",
    relativePath: "models/hero.blend",
    dirty: false,
  };
  await using screen = await render(
    <div style={{ height: 400, width: 360 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>,
  );
  await control({ canOperate: true, controller: "unclaimed" });
  const toolbar = screen.getByRole("button", { name: "Blender menu" }).element().parentElement!;
  const bounds = toolbar.getBoundingClientRect();
  for (const name of ["Blender menu", "Take control", "Screenshot & annotate"]) {
    const box = screen.getByRole("button", { name }).element().getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.right).toBeLessThanOrEqual(bounds.right);
  }
  // The name has a line of its own under the buttons, whole, rather than cut between them.
  const name = [...screen.container.querySelectorAll("span")].find(
    (span) => span.textContent === "hero.wip-a1b2.blend" && span.checkVisibility(),
  )!;
  const menu = screen.getByRole("button", { name: "Blender menu" }).element();
  expect(name.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    menu.getBoundingClientRect().bottom,
  );
  expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
});

it("points a thread with no Blender running at Files, where .blend files open", async () => {
  using _app = startup();
  const { useRightPanelStore } = await import("~/rightPanelStore");
  using openPane = vi.spyOn(useRightPanelStore.getState(), "open").mockImplementation(() => {});
  stream.state = { status: "stopped" };
  await using pane = await render(
    <BlenderPanel
      threadRef={threadRef}
      visible
      composerTarget={threadRef}
      projectId={"project-1" as ProjectId}
    />,
  );
  await pane.getByRole("button", { name: "Open Files" }).click();
  expect(openPane).toHaveBeenCalledWith(threadRef, "files");
});

it("offers a reload's copy as older than the file, opening the file first", async () => {
  using _app = startup();
  using _reopen = await canReopen();
  stream.state = {
    status: "closed",
    copies: [{ ...kept("closed", "models/hero.blend", true), reloaded: true }],
  };
  await using pane = await render(
    <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />,
  );
  await expect
    .element(pane.getByText("The file on disk is newer than them", { exact: false }))
    .toBeInTheDocument();
  await expect.element(pane.getByRole("button", { name: "Reopen" })).not.toBeInTheDocument();
  const open = pane.getByRole("button", { name: "Open as last saved" }).element();
  const restore = pane.getByRole("button", { name: "Restore changes" }).element();
  expect(open.compareDocumentPosition(restore) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await pane.getByRole("button", { name: "Open as last saved" }).click();
  expect(stream.commands.at(-1)?.value).toMatchObject({ input: { restore: false } });
});

it("shows where a copy is once its file is gone, offering no open of the file as saved", async () => {
  using _app = startup();
  using _reopen = await canReopen();
  stream.state = {
    status: "closed",
    copies: [
      {
        ...kept("closed", "models/hero.blend", true),
        missing: true,
        copyPath: "/srv/state/session.blend",
      },
    ],
  };
  await using pane = await render(
    <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />,
  );
  await expect
    .element(pane.getByText("hero.blend is no longer in this project", { exact: false }))
    .toBeInTheDocument();
  await expect
    .element(pane.getByText("/srv/state/session.blend", { exact: false }))
    .toBeInTheDocument();
  await expect.element(pane.getByRole("button", { name: "Copy path" })).toBeInTheDocument();
  await expect
    .element(pane.getByRole("button", { name: "Open as last saved" }))
    .not.toBeInTheDocument();
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

it("shows a master's copy of another file it had open, with where it is and a way to open the master", async () => {
  using _app = startup();
  const { hostedBlenderEnvironment } = await import("~/state/hostedBlender");
  const { Atom } = await import("effect/reactivity");
  vi.spyOn(hostedBlenderEnvironment.openMaster, "permissionAtom").mockReturnValue(
    Atom.make(true) as never,
  );
  await canReopen();
  stream.state = { status: "none" };
  stream.master = {
    status: "closed",
    relativePath: "models/hero.blend",
    copies: [
      {
        key: "outside:/real/models/other.blend",
        kind: "closed",
        file: { kind: "outside", path: "/real/models/other.blend" },
        copyPath: "/state/recovery/master/abc/session.blend",
        recovery: true,
        keptAt: 1,
      },
    ],
  };
  await using screen = await render(
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>,
  );
  await screen.getByRole("button", { name: "Master" }).click();
  await expect
    .element(
      screen.getByText("Blender had other.blend open instead of the master file", { exact: false }),
    )
    .toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Copy path" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Open hero.blend" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Reopen" })).not.toBeInTheDocument();
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

it("B16: Timeline in the pane's menu shows or hides the strip for everyone, for those who may operate Blender", async () => {
  using _app = startup();
  const { hostedBlenderEnvironment } = await import("~/state/hostedBlender");
  const { Atom } = await import("effect/reactivity");
  const ui = () => (
    <div style={{ height: 400, width: 600 }}>
      <BlenderPanel threadRef={threadRef} visible composerTarget={threadRef} />
    </div>
  );
  // A viewer who may only watch gets no menu, so nothing to switch.
  {
    await using watching = await render(ui());
    await control({ canOperate: false, controller: "unclaimed" });
    await expect.element(watching.getByText("Watching")).toBeInTheDocument();
    await expect
      .element(watching.getByRole("button", { name: "Blender menu" }))
      .not.toBeInTheDocument();
  }

  vi.spyOn(hostedBlenderEnvironment.setTimeline, "permissionAtom").mockReturnValue(
    Atom.make(true) as never,
  );
  await using screen = await render(ui());
  await control({ canOperate: false, controller: "unclaimed" });
  await screen.getByRole("button", { name: "Blender menu" }).click();
  // On until the server's setting says otherwise.
  const item = screen.getByRole("menuitemcheckbox", { name: "Timeline" });
  await expect.element(item).toHaveAttribute("aria-checked", "true");
  await item.click();
  expect(stream.commands.at(-1)).toEqual({
    label: "environment-data:hosted-blender:set-timeline",
    value: { environmentId: threadRef.environmentId, input: { shown: false } },
  });
});

// The pane's input, below the component: keyboard capture, then pointer, key and wheel mapping.

const disposable = (cleanup: () => void): Disposable => ({ [Symbol.dispose]: cleanup });
const element = () => {
  const node = document.body.appendChild(document.createElement("div"));
  return Object.assign(node, { [Symbol.dispose]: () => node.remove() });
};

const press = (target: EventTarget, init: KeyboardEventInit, type = "keydown") => {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

it("hands keys inside the owner to it ahead of the app's own window shortcuts", () => {
  using _capture = disposable(installKeyboardCapture());
  const appShortcut = vi.fn();
  // Registered after the capture listener, as every app shortcut is.
  window.addEventListener("keydown", appShortcut, true);
  using _shortcut = disposable(() => window.removeEventListener("keydown", appShortcut, true));
  using surface = element();
  using outside = element();
  const owned: string[] = [];
  using _owner = disposable(
    captureKeyboard(surface, {
      onKey: (event) => owned.push(`${event.type}:${event.code}`),
      passThrough: (event) => event.code === "F6" && !event.shiftKey,
    }),
  );

  const typed = press(surface, { code: "KeyB", ctrlKey: true });
  press(surface, { code: "KeyB", ctrlKey: true }, "keyup");
  expect(owned).toEqual(["keydown:KeyB", "keyup:KeyB"]);
  expect(typed.defaultPrevented).toBe(true);
  expect(appShortcut).not.toHaveBeenCalled();

  // T3's focus shortcut still leaves; Shift+F6 goes to the owner.
  press(surface, { code: "F6" });
  press(surface, { code: "F6", shiftKey: true });
  press(outside, { code: "KeyB" });
  expect(owned).toEqual(["keydown:KeyB", "keyup:KeyB", "keydown:F6"]);
  expect(appShortcut).toHaveBeenCalledTimes(2);
});

it("lets the app have the keyboard again once the owner lets go", () => {
  using _capture = disposable(installKeyboardCapture());
  using surface = element();
  const onKey = vi.fn();
  const release = captureKeyboard(surface, { onKey, passThrough: () => false });
  release();
  expect(press(surface, { code: "KeyA" }).defaultPrevented).toBe(false);
  expect(onKey).not.toHaveBeenCalled();
});

/** A 200×100 CSS-pixel stream of 400×200 stream pixels, in control. */
const setup = (
  keymap = { layout: "us", variant: "" },
  takeScrolls: ReadonlyArray<TakeScroll> = [],
) => {
  const cleanups = [installKeyboardCapture()];
  const surface = document.body.appendChild(document.createElement("div"));
  surface.tabIndex = 0;
  const canvas = surface.appendChild(document.createElement("canvas"));
  canvas.width = 400;
  canvas.height = 200;
  Object.assign(canvas.style, {
    position: "fixed",
    left: "10px",
    top: "20px",
    width: "200px",
    height: "100px",
  });
  surface.focus();
  const sent: HostedBlenderInputMessage[] = [];
  const input = attachBlenderInput({
    surface,
    canvas,
    send: (message) => sent.push(message),
    keymap: () => keymap,
    scrollPreference: () => "auto",
    passThrough: (event) => event.code === "F6" && !event.shiftKey,
    takeScrolls,
  });
  cleanups.push(
    () => input.dispose(),
    () => surface.remove(),
  );
  return {
    surface,
    canvas,
    sent,
    input,
    cleanups,
    [Symbol.dispose]: () => {
      for (const cleanup of cleanups.reverse()) cleanup();
    },
  };
};

const key = (target: EventTarget, type: string, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
const pointer = (target: EventTarget, type: string, init: PointerEventInit) => {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

it("sends absolute positions in stream pixels and buttons as evdev", async () => {
  using stream = setup();
  const { canvas, sent } = stream;
  pointer(canvas, "pointermove", { clientX: 60, clientY: 45 });
  pointer(canvas, "pointermove", { clientX: 110, clientY: 70 });
  // Moves within a frame merge into the newest position.
  await vi.waitFor(() => expect(sent).toEqual([{ type: "pointer", x: 200, y: 100 }]));

  pointer(canvas, "pointerdown", { button: 1, buttons: 4, clientX: 110, clientY: 70 });
  pointer(canvas, "pointerup", { button: 1, buttons: 0, clientX: 110, clientY: 70 });
  expect(sent.slice(1)).toEqual([
    { type: "button", button: 274, pressed: true },
    { type: "button", button: 274, pressed: false },
  ]);
});

it("B6: opens no context menu where a right drag from the pane ends", () => {
  using stream = setup();
  pointer(stream.canvas, "pointerdown", { button: 2, buttons: 2, clientX: 20, clientY: 30 });
  pointer(document.body, "pointerup", { button: 2, buttons: 0, clientX: 500, clientY: 500 });
  // As Windows does, on the release, wherever it is.
  const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  document.body.dispatchEvent(menu);
  expect(menu.defaultPrevented).toBe(true);
  // Only that one: a later right click elsewhere in T3 has its menu.
  const later = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  document.body.dispatchEvent(later);
  expect(later.defaultPrevented).toBe(false);
});

it("sends physical keys once each, with the keymap first, and leaves T3's focus keys alone", () => {
  using stream = setup({ layout: "de", variant: "" });
  const { surface, sent } = stream;
  key(surface, "keydown", { code: "KeyA", key: "a" });
  key(surface, "keydown", { code: "KeyA", key: "a", repeat: true });
  key(surface, "keyup", { code: "KeyA", key: "a" });
  key(surface, "keydown", { code: "ShiftLeft", key: "Shift", shiftKey: true });
  key(surface, "keydown", { code: "F6", key: "F6", shiftKey: true });
  key(surface, "keydown", { code: "F6", key: "F6" });
  expect(sent).toEqual([
    { type: "keymap", layout: "de", variant: "" },
    { type: "key", code: 30, pressed: true },
    { type: "key", code: 30, pressed: false },
    { type: "key", code: 42, pressed: true },
    { type: "key", code: 64, pressed: true },
  ]);
});

it("releases every held key and button when it lets go", () => {
  using stream = setup();
  const { surface, canvas, sent, input } = stream;
  key(surface, "keydown", { code: "ControlLeft", key: "Control" });
  pointer(canvas, "pointerdown", { button: 0, buttons: 1, clientX: 20, clientY: 30 });
  sent.length = 0;
  input.releaseAll();
  input.releaseAll();
  expect(sent).toEqual([
    { type: "key", code: 29, pressed: false },
    { type: "button", button: 272, pressed: false },
  ]);
});

it("locks the pointer and sends relative motion while Blender holds the mouse", async () => {
  using stream = setup();
  const { canvas, sent, input, cleanups } = stream;
  let locked: Element | null = null;
  Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => locked });
  cleanups.push(() => Reflect.deleteProperty(document, "pointerLockElement"));
  const changeLock = (element: Element | null) => {
    locked = element;
    document.dispatchEvent(new Event("pointerlockchange"));
  };
  canvas.requestPointerLock = vi.fn(async () => changeLock(canvas));
  document.exitPointerLock = vi.fn(() => changeLock(null));

  input.setCaptured(true);
  expect(canvas.requestPointerLock).toHaveBeenCalledOnce();
  pointer(canvas, "pointermove", { movementX: 3, movementY: -1 } as PointerEventInit);
  pointer(canvas, "pointermove", { movementX: 2, movementY: 0 } as PointerEventInit);
  await vi.waitFor(() => expect(sent).toEqual([{ type: "pointerMotion", dx: 10, dy: -2 }]));

  // Blender let go: T3 ends the lock itself, which is no Esc.
  input.setCaptured(false);
  expect(document.exitPointerLock).toHaveBeenCalledOnce();
  input.setCaptured(true);
  sent.length = 0;
  // The browser ended the lock on its own: it swallowed an Esc meant for Blender.
  changeLock(null);
  expect(sent).toEqual([
    { type: "key", code: 1, pressed: true },
    { type: "key", code: 1, pressed: false },
  ]);
});

it("sends a mouse wheel as notches", () => {
  using stream = setup();
  const { canvas, sent } = stream;
  const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
  Object.defineProperty(wheel, "wheelDeltaY", { value: -120 });
  canvas.dispatchEvent(wheel);
  expect(wheel.defaultPrevented).toBe(true);
  expect(sent).toEqual([
    { type: "scroll", axis: "vertical", source: "wheel", value: 15, steps: 1 },
  ]);
});

it("B15: sends the scrolls that took control in order, each where it was made", () => {
  const notch = { deltaMode: 0, deltaX: 0, deltaY: 100, wheelDeltaY: -120 };
  using stream = setup(undefined, [
    { scroll: notch, clientX: 60, clientY: 45 },
    { scroll: notch, clientX: 60, clientY: 45 },
    { scroll: { ...notch, deltaY: -100, wheelDeltaY: 120 }, clientX: 110, clientY: 70 },
  ]);
  expect(stream.sent).toEqual([
    { type: "pointer", x: 100, y: 50 },
    { type: "scroll", axis: "vertical", source: "wheel", value: 15, steps: 1 },
    { type: "scroll", axis: "vertical", source: "wheel", value: 15, steps: 1 },
    { type: "pointer", x: 200, y: 100 },
    { type: "scroll", axis: "vertical", source: "wheel", value: -15, steps: -1 },
  ]);
});

it("follows chorded buttons from the buttons held, so none is left down in Blender", () => {
  using stream = setup();
  const { canvas, sent } = stream;
  const at = { clientX: 60, clientY: 45 };
  // Only the first press and the last release are pointerdown and pointerup.
  pointer(canvas, "pointerdown", { ...at, button: 1, buttons: 4 });
  pointer(canvas, "pointermove", { ...at, button: 2, buttons: 6 });
  pointer(canvas, "pointermove", { ...at, button: 1, buttons: 2 });
  pointer(canvas, "pointerup", { ...at, button: 2, buttons: 0 });
  pointer(canvas, "pointerdown", { ...at, button: 0, buttons: 1 });
  pointer(canvas, "pointercancel", { ...at, button: -1, buttons: 0 });
  expect(sent.filter((message) => message.type === "button")).toEqual([
    { type: "button", button: 274, pressed: true },
    { type: "button", button: 273, pressed: true },
    { type: "button", button: 274, pressed: false },
    { type: "button", button: 273, pressed: false },
    { type: "button", button: 272, pressed: true },
    { type: "button", button: 272, pressed: false },
  ]);
});

it("sends the motion queued for the next frame before a button changes", () => {
  using stream = setup();
  const { canvas, sent } = stream;
  pointer(canvas, "pointerdown", { button: 0, buttons: 1, clientX: 20, clientY: 30 });
  pointer(canvas, "pointermove", { button: -1, buttons: 1, clientX: 110, clientY: 70 });
  pointer(canvas, "pointerup", { button: 0, buttons: 0, clientX: 110, clientY: 70 });
  expect(sent).toEqual([
    { type: "pointer", x: 20, y: 20 },
    { type: "button", button: 272, pressed: true },
    { type: "pointer", x: 200, y: 100 },
    { type: "button", button: 272, pressed: false },
  ]);
});

it("never presses for the click that took control, still held when control arrives", () => {
  using stream = setup();
  const { canvas, sent } = stream;
  const at = { clientX: 60, clientY: 45 };
  pointer(canvas, "pointermove", { ...at, button: -1, buttons: 1 });
  pointer(canvas, "pointerup", { ...at, button: 0, buttons: 0 });
  expect(sent.filter((message) => message.type === "button")).toEqual([]);
  // The next click is the user's, in Blender.
  pointer(canvas, "pointerdown", { ...at, button: 0, buttons: 1 });
  expect(sent.filter((message) => message.type === "button")).toEqual([
    { type: "button", button: 272, pressed: true },
  ]);
});

// Annotating the pane: Blender's own render of its viewport window, and what each mark covers.

const annotate = {
  captureView: vi.fn<(value: unknown) => Promise<unknown>>(),
  findHits: vi.fn<(value: unknown) => Promise<unknown>>(),
};

/** What a command answers when it fails. */
const FAILED = Symbol("failed");

/** A canvas of one flat colour, the size of the stream. */
function canvasOf(color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 320, 180);
  return canvas;
}

/** A decoded stream frame of Blender in one flat colour. */
const frameOf = (color: string) => new VideoFrame(canvasOf(color), { timestamp: 0 });

const annotatedCopy: HostedBlenderRunningState = {
  status: "running",
  relativePath: "models/hero.wip-a1b2.blend",
  dirty: false,
};

// Blender's own render of the viewport, which differs from the grey stream frame.
const capture: HostedBlenderViewCapture = {
  screenshot: { dataUrl: canvasOf("#ff0000").toDataURL("image/png"), width: 320, height: 180 },
  cameraView: { position: [6, -6, 5], target: [0, 0, 0], upAxis: "z" },
  projection: {
    matrix: Array.from({ length: 16 }, (_, index) => (index % 5 === 0 ? 1 : 0)),
    region: { x: 0.05, y: 0.1, width: 0.9, height: 0.85 },
  },
  scene: "launch:1",
};

function annotationPane() {
  const container = document.createElement("div");
  container.className = "flex h-96 w-[32rem] flex-col";
  return { container };
}

function dragOn(target: Element, from: [number, number], to: [number, number]) {
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

function annotationSetup(threadId: string, target: "window" | "output") {
  stream.annotating = true;
  stream.target = target;
  stream.sent = [];
  stream.state = annotatedCopy;
  stream.master = { status: "none" };
  stream.access = {} as typeof stream.access;
  stream.captureView = annotate.captureView;
  stream.findHits = annotate.findHits;
  annotate.captureView.mockReset().mockResolvedValue(capture);
  annotate.findHits
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
  dragOn(surface.element(), [0.4, 0.4], [0.6, 0.6]);
  await userEvent.fill(screen.getByRole("textbox", { name: "Annotation comment" }), "Bevel");
  await userEvent.click(screen.getByRole("button", { name: "Add to chat" }));
  await expect.element(surface).not.toBeInTheDocument();
}

it("freezes the pane's frame and attaches the viewport window's camera and what each mark covers", async () => {
  const blender = annotationSetup("thread-blender-annotate", "window");
  await using screen = await render(blender.element, annotationPane());
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
  expect(annotate.captureView).toHaveBeenCalledTimes(1);
  const request = annotate.findHits.mock.calls[0]?.[0] as {
    input: { threadId: string; projection: unknown; marks: Array<Array<{ x: number }>> };
  };
  expect(request.input.projection).toEqual(capture.projection);
  // The region's middle, as a fraction of the frozen frame, is tried first.
  expect(request.input.marks).toHaveLength(1);
  expect(request.input.marks[0]![0]!.x).toBeCloseTo(0.5, 2);
  expect(blender.draft()?.images.map((image) => image.id)).toEqual([annotation.id]);
});

it("links to the file Blender rendered, opened since it started", async () => {
  const blender = annotationSetup("thread-blender-other-file", "window");
  annotate.captureView.mockReset().mockResolvedValue({
    ...capture,
    openFile: { kind: "workspace", relativePath: "models/other.blend" },
  });
  await using screen = await render(blender.element, annotationPane());
  await annotateRegion(screen);
  await vi.waitFor(() => expect(blender.draft()?.previewAnnotations).toHaveLength(1));
  const annotation = blender.draft()!.previewAnnotations[0]!;
  expect(annotation.pageTitle).toBe("other.blend · Master");
  expect(annotation.pageUrl.startsWith("models/other.blend#view=")).toBe(true);
});

it("asks Blender what an arrow points at first, from its tip", async () => {
  const blender = annotationSetup("thread-blender-arrow", "window");
  await using screen = await render(blender.element, annotationPane());
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  const surface = screen.getByRole("img", { name: "Frozen 3D view to annotate" });
  await expect.element(surface).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Arrow", exact: true }));
  // The tip is at the middle, which is the frozen frame's middle however it is letterboxed.
  dragOn(surface.element(), [0.1, 0.9], [0.5, 0.5]);
  await userEvent.click(screen.getByRole("button", { name: "Add to chat" }));

  await vi.waitFor(() => expect(blender.draft()?.previewAnnotations).toHaveLength(1));
  const request = annotate.findHits.mock.calls[0]?.[0] as {
    input: { marks: Array<Array<{ x: number; y: number }>> };
  };
  expect(request.input.marks[0]![0]!.x).toBeCloseTo(0.5, 2);
  expect(request.input.marks[0]![0]!.y).toBeCloseTo(0.5, 2);
  const annotation = blender.draft()!.previewAnnotations[0]!;
  expect(annotation.strokes[0]?.hit).toEqual({ object: "Cube", point: [0.2, -1, 0.4] });
});

it("places marks even when the stream shows the whole display, since Blender rendered the view", async () => {
  const blender = annotationSetup("thread-blender-display", "output");
  await using screen = await render(blender.element, annotationPane());
  await annotateRegion(screen);

  await vi.waitFor(() => expect(blender.draft()?.previewAnnotations).toHaveLength(1));
  const annotation = blender.draft()!.previewAnnotations[0]!;
  expect(annotation.cameraView).toEqual(capture.cameraView);
  expect(annotation.regions[0]?.hit).toEqual({ object: "Cube", point: [0.2, -1, 0.4] });
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

it("freezes Blender's own render of the view, not the stream frame showing", async () => {
  const blender = annotationSetup("thread-blender-render", "window");
  await using screen = await render(blender.element, annotationPane());
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  expect(await frozenColor(screen)).toEqual([255, 0, 0]);
});

it("freezes the stream frame, without camera or marks, when Blender can't render the view", async () => {
  const blender = annotationSetup("thread-blender-no-render", "window");
  annotate.captureView.mockReset().mockResolvedValue(FAILED);
  await using screen = await render(blender.element, annotationPane());
  await userEvent.click(screen.getByRole("button", { name: "Screenshot & annotate" }));
  expect(await frozenColor(screen)).toEqual([0x3d, 0x3d, 0x3d]);
  const surface = screen.getByRole("img", { name: "Frozen 3D view to annotate" });
  await userEvent.click(screen.getByRole("button", { name: "Mark a region" }));
  dragOn(surface.element(), [0.4, 0.4], [0.6, 0.6]);
  await userEvent.click(screen.getByRole("button", { name: "Add to chat" }));
  await vi.waitFor(() => expect(blender.draft()?.previewAnnotations).toHaveLength(1));
  const annotation = blender.draft()!.previewAnnotations[0]!;
  expect(annotation).not.toHaveProperty("cameraView");
  expect(annotation.regions[0]).not.toHaveProperty("hit");
  expect(annotate.findHits).not.toHaveBeenCalled();
});

it("hands the keyboard to the annotation editor while in control, and control back when it closes", async () => {
  using _app = { [Symbol.dispose]: installKeyboardCapture() };
  const blender = annotationSetup("thread-blender-in-control", "window");
  await using screen = await render(blender.element, annotationPane());
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
  const blender = annotationSetup("thread-blender-editor-leave", "window");
  await using screen = await render(
    <div className="flex flex-col">
      <button type="button">Composer</button>
      <div className="flex h-96 w-[32rem] flex-col">{blender.element}</div>
    </div>,
  );
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
  const blender = annotationSetup("thread-blender-late-grant", "window");
  await using screen = await render(blender.element, annotationPane());
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
