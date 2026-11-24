import type { HostedBlenderInputMessage } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { installKeyboardCapture } from "~/lib/keyboardCapture";

import { attachBlenderInput } from "./blenderInput";

/** A 200×100 CSS-pixel stream of 400×200 stream pixels, in control. */
const setup = (keymap = { layout: "us", variant: "" }) => {
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

it("sends absolute positions in stream pixels and buttons as evdev, without autoscroll or paste", async () => {
  using stream = setup();
  const { canvas, sent } = stream;
  pointer(canvas, "pointermove", { clientX: 60, clientY: 45 });
  pointer(canvas, "pointermove", { clientX: 110, clientY: 70 });
  // Moves within a frame merge into the newest position.
  await vi.waitFor(() => expect(sent).toEqual([{ type: "pointer", x: 200, y: 100 }]));

  const middle = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 });
  pointer(canvas, "pointerdown", { button: 1, clientX: 110, clientY: 70 });
  canvas.dispatchEvent(middle);
  const auxclick = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
  canvas.dispatchEvent(auxclick);
  pointer(canvas, "pointerup", { button: 1, clientX: 110, clientY: 70 });
  expect(middle.defaultPrevented).toBe(true);
  expect(auxclick.defaultPrevented).toBe(true);
  expect(sent.slice(1)).toEqual([
    { type: "button", button: 274, pressed: true },
    { type: "button", button: 274, pressed: false },
  ]);
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
  pointer(canvas, "pointerdown", { button: 0, clientX: 20, clientY: 30 });
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
