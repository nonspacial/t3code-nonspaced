import { describe, expect, it } from "vite-plus/test";

import { detectKeymap, evdevKeyCode, keymapForLayout, scrollInput, scrollKind } from "./input.ts";

describe("physical keys", () => {
  it("maps KeyboardEvent.code to Linux evdev codes, whatever the layout prints", () => {
    expect(
      ["Escape", "KeyA", "KeyZ", "F6", "ShiftLeft", "ArrowUp", "NumpadEnter", "IntlBackslash"].map(
        evdevKeyCode,
      ),
    ).toEqual([1, 30, 44, 64, 42, 103, 96, 86]);
    expect(evdevKeyCode("Unidentified")).toBeNull();
  });
});

describe("keyboard layout", () => {
  const layout = (keys: Record<string, string>) => new Map(Object.entries(keys));
  const us = { KeyQ: "q", KeyW: "w", KeyY: "y", Semicolon: ";", Quote: "'", Backslash: "\\" };

  it("recognizes common layouts from the keys they print, leaving any other to the device's setting", () => {
    expect(detectKeymap(layout(us))).toEqual({ layout: "us", variant: "" });
    expect(detectKeymap(layout({ ...us, Backslash: "#" }))).toEqual({ layout: "gb", variant: "" });
    expect(detectKeymap(layout({ ...us, KeyY: "z", Minus: "ß" }))).toEqual({
      layout: "de",
      variant: "",
    });
    expect(detectKeymap(layout({ ...us, KeyQ: "a", KeyW: "z" }))).toEqual({
      layout: "fr",
      variant: "",
    });
    expect(detectKeymap(layout({ ...us, Semicolon: "ñ" }))).toEqual({ layout: "es", variant: "" });
    expect(detectKeymap(layout({ ...us, KeyQ: "'", KeyW: "," }))).toEqual({
      layout: "us",
      variant: "dvorak",
    });
    expect(detectKeymap(layout({ ...us, KeyQ: "й" }))).toEqual({ layout: "ru", variant: "" });

    expect(detectKeymap(undefined), "no layout map").toBeNull();
    expect(detectKeymap(layout({})), "an empty layout map").toBeNull();
    expect(detectKeymap(layout({ ...us, KeyQ: "ק" })), "an unknown layout").toBeNull();
    expect(keymapForLayout("us-colemak"), "the device's chosen variant").toEqual({
      layout: "us",
      variant: "colemak",
    });
    expect(keymapForLayout("se"), "the device's chosen layout").toEqual({
      layout: "se",
      variant: "",
    });
  });
});

describe("scrolling", () => {
  const wheel = { deltaMode: 0, deltaX: 0, deltaY: 100, wheelDeltaX: 0, wheelDeltaY: -120 };
  const trackpad = { deltaMode: 0, deltaX: 1.5, deltaY: 6.25, wheelDeltaX: -4, wheelDeltaY: -18 };

  it("tells a mouse wheel from a trackpad by the shape of its scroll, unless the device says", () => {
    expect(scrollKind(wheel, "auto")).toBe("wheel");
    // Firefox scrolls wheels in lines.
    expect(scrollKind({ deltaMode: 1, deltaX: 0, deltaY: 3 }, "auto")).toBe("wheel");
    expect(scrollKind(trackpad, "auto")).toBe("trackpad");
    // A zoomed page scales a wheel's pixels, but not its notches.
    expect(scrollKind({ ...wheel, deltaY: 133.33 }, "auto")).toBe("wheel");
    expect(scrollKind({ deltaMode: 0, deltaX: 0, deltaY: 4 }, "auto")).toBe("trackpad");
    expect(scrollKind(trackpad, "wheel"), "the device's setting overrides").toBe("wheel");
    expect(scrollKind(wheel, "trackpad"), "the device's setting overrides").toBe("trackpad");
  });

  it("sends a wheel's notches and a trackpad's pixels", () => {
    expect(scrollInput(wheel, "wheel", 2)).toEqual([
      { type: "scroll", axis: "vertical", source: "wheel", value: 15, steps: 1 },
    ]);
    expect(scrollInput({ deltaMode: 1, deltaX: 0, deltaY: -6 }, "wheel", 1)).toEqual([
      { type: "scroll", axis: "vertical", source: "wheel", value: -30, steps: -2 },
    ]);
    expect(scrollInput(trackpad, "trackpad", 2)).toEqual([
      { type: "scroll", axis: "vertical", source: "finger", value: 12.5 },
      { type: "scroll", axis: "horizontal", source: "finger", value: 3 },
    ]);
  });
});
