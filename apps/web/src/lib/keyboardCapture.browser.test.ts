import { expect, it, vi } from "vite-plus/test";

import { captureKeyboard, installKeyboardCapture } from "./keyboardCapture";

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
