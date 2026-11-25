import type { HostedBlenderInputMessage } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { installKeyboardCapture } from "~/lib/keyboardCapture";

import { attachBlenderInput, type TakeScroll } from "./blenderInput";

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
