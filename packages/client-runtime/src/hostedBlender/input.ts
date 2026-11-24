import type { HostedBlenderInputMessage, HostedBlenderKeymap } from "@t3tools/contracts";

// `KeyboardEvent.code` names physical keys; these are their Linux evdev codes
// (linux/input-event-codes.h). Blender gets the key, and the xkb keymap decides what it types.
const EVDEV_KEY_CODES: Readonly<Record<string, number>> = {
  Escape: 1,
  Digit1: 2,
  Digit2: 3,
  Digit3: 4,
  Digit4: 5,
  Digit5: 6,
  Digit6: 7,
  Digit7: 8,
  Digit8: 9,
  Digit9: 10,
  Digit0: 11,
  Minus: 12,
  Equal: 13,
  Backspace: 14,
  Tab: 15,
  KeyQ: 16,
  KeyW: 17,
  KeyE: 18,
  KeyR: 19,
  KeyT: 20,
  KeyY: 21,
  KeyU: 22,
  KeyI: 23,
  KeyO: 24,
  KeyP: 25,
  BracketLeft: 26,
  BracketRight: 27,
  Enter: 28,
  ControlLeft: 29,
  KeyA: 30,
  KeyS: 31,
  KeyD: 32,
  KeyF: 33,
  KeyG: 34,
  KeyH: 35,
  KeyJ: 36,
  KeyK: 37,
  KeyL: 38,
  Semicolon: 39,
  Quote: 40,
  Backquote: 41,
  ShiftLeft: 42,
  Backslash: 43,
  KeyZ: 44,
  KeyX: 45,
  KeyC: 46,
  KeyV: 47,
  KeyB: 48,
  KeyN: 49,
  KeyM: 50,
  Comma: 51,
  Period: 52,
  Slash: 53,
  ShiftRight: 54,
  NumpadMultiply: 55,
  AltLeft: 56,
  Space: 57,
  CapsLock: 58,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  NumLock: 69,
  ScrollLock: 70,
  Numpad7: 71,
  Numpad8: 72,
  Numpad9: 73,
  NumpadSubtract: 74,
  Numpad4: 75,
  Numpad5: 76,
  Numpad6: 77,
  NumpadAdd: 78,
  Numpad1: 79,
  Numpad2: 80,
  Numpad3: 81,
  Numpad0: 82,
  NumpadDecimal: 83,
  IntlBackslash: 86,
  F11: 87,
  F12: 88,
  IntlRo: 89,
  Convert: 92,
  KanaMode: 93,
  NonConvert: 94,
  NumpadEnter: 96,
  ControlRight: 97,
  NumpadDivide: 98,
  PrintScreen: 99,
  AltRight: 100,
  Home: 102,
  ArrowUp: 103,
  PageUp: 104,
  ArrowLeft: 105,
  ArrowRight: 106,
  End: 107,
  ArrowDown: 108,
  PageDown: 109,
  Insert: 110,
  Delete: 111,
  NumpadEqual: 117,
  Pause: 119,
  NumpadComma: 121,
  Lang1: 122,
  Lang2: 123,
  IntlYen: 124,
  MetaLeft: 125,
  MetaRight: 126,
  ContextMenu: 127,
  F13: 183,
  F14: 184,
  F15: 185,
  F16: 186,
  F17: 187,
  F18: 188,
  F19: 189,
  F20: 190,
  F21: 191,
  F22: 192,
  F23: 193,
  F24: 194,
};

export const evdevKeyCode = (code: string): number | null => EVDEV_KEY_CODES[code] ?? null;

/** KEY_ESC, for the Esc a browser swallows to end a pointer lock. */
export const EVDEV_KEY_ESCAPE = 1;

/** The layouts a device can choose; `auto` detects the layout where the browser can. */
export const HOSTED_BLENDER_KEYBOARD_LAYOUTS = [
  "us",
  "gb",
  "de",
  "fr",
  "es",
  "it",
  "pt",
  "br",
  "se",
  "no",
  "dk",
  "ch",
  "ru",
  "jp",
  "us-dvorak",
  "us-colemak",
] as const;
export type HostedBlenderKeyboardLayout = (typeof HOSTED_BLENDER_KEYBOARD_LAYOUTS)[number];

export const keymapForLayout = (layout: HostedBlenderKeyboardLayout): HostedBlenderKeymap => {
  const [name = "us", variant = ""] = layout.split("-");
  return { layout: name, variant };
};

/**
 * The xkb layout a `navigator.keyboard.getLayoutMap()` result looks like, from a few keys
 * that tell common layouts apart. `null` when it can't tell.
 */
export const detectKeymap = (
  map: Pick<ReadonlyMap<string, string>, "get"> | undefined,
): HostedBlenderKeymap | null => {
  const key = (code: string) => map?.get(code);
  const layout = (name: HostedBlenderKeyboardLayout) => keymapForLayout(name);
  if (key("KeyQ") === "й") return layout("ru");
  if (key("KeyQ") === "'" && key("KeyW") === ",") return layout("us-dvorak");
  if (key("KeyE") === "f" && key("KeyR") === "p") return layout("us-colemak");
  if (key("KeyQ") === "a" && key("KeyW") === "z") return layout("fr");
  if (key("KeyQ") !== "q") return null;
  if (key("KeyY") === "z") return layout(key("Minus") === "'" ? "ch" : "de");
  switch (key("Semicolon")) {
    case "ñ":
      return layout("es");
    case "ò":
      return layout("it");
    case "ç":
      return layout(key("Quote") === "~" ? "br" : "pt");
    case "ö":
      return layout("se");
    case "ø":
      return layout("no");
    case "æ":
      return layout("dk");
  }
  if (key("BracketLeft") === "@") return layout("jp");
  if (key("Backslash") === "#") return layout("gb");
  return layout("us");
};

export type HostedBlenderScrollPreference = "auto" | "wheel" | "trackpad";

export interface ScrollEventLike {
  readonly deltaMode: number;
  readonly deltaX: number;
  readonly deltaY: number;
  /** Chromium and WebKit's legacy deltas: a wheel moves them 120 per notch, at any zoom. */
  readonly wheelDeltaX?: number;
  readonly wheelDeltaY?: number;
}

const NOTCH = 120;

export const scrollKind = (
  event: ScrollEventLike,
  preference: HostedBlenderScrollPreference,
): "wheel" | "trackpad" => {
  if (preference !== "auto") return preference;
  if (event.deltaMode !== 0) return "wheel";
  const legacy = [event.wheelDeltaX ?? 0, event.wheelDeltaY ?? 0].filter((delta) => delta !== 0);
  if (legacy.length > 0) return legacy.every((delta) => delta % NOTCH === 0) ? "wheel" : "trackpad";
  // Without legacy deltas, a wheel's notch is a large whole number of pixels.
  return Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 50 && event.deltaX === 0
    ? "wheel"
    : "trackpad";
};

// libinput reports a wheel notch as 15 degrees.
const WHEEL_VALUE_PER_STEP = 15;
const LINE_PIXELS = 16;
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

const wheelSteps = (event: ScrollEventLike, delta: number, legacy: number | undefined) => {
  if (delta === 0) return 0;
  const raw =
    legacy !== undefined && legacy !== 0
      ? -legacy / NOTCH
      : event.deltaMode === 1
        ? delta / 3
        : event.deltaMode === 2
          ? delta
          : delta / 100;
  return Math.sign(delta) * Math.max(1, Math.round(Math.abs(raw)));
};

/**
 * One scroll event as input, per axis. `pixelRatio` turns CSS pixels into stream pixels for a
 * trackpad's continuous scroll.
 */
export const scrollInput = (
  event: ScrollEventLike,
  kind: "wheel" | "trackpad",
  pixelRatio: number,
): HostedBlenderInputMessage[] => {
  const axes = [
    { axis: "vertical", delta: event.deltaY, legacy: event.wheelDeltaY },
    { axis: "horizontal", delta: event.deltaX, legacy: event.wheelDeltaX },
  ] as const;
  return axes.flatMap(({ axis, delta, legacy }): HostedBlenderInputMessage[] => {
    if (delta === 0) return [];
    if (kind === "wheel") {
      const steps = clamp(wheelSteps(event, delta, legacy), 100);
      return [
        { type: "scroll", axis, source: "wheel", value: steps * WHEEL_VALUE_PER_STEP, steps },
      ];
    }
    const pixels = event.deltaMode === 0 ? delta : delta * LINE_PIXELS;
    return [{ type: "scroll", axis, source: "finger", value: clamp(pixels * pixelRatio, 10_000) }];
  });
};
