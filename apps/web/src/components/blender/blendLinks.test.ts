import { describe, expect, it } from "vite-plus/test";

import { hostedBlenderOpensLink } from "./blendLinks";

const running = { status: "running", relativePath: "models/hero.blend", dirty: false } as const;

describe("hostedBlenderOpensLink", () => {
  it("opens the pane for the file the thread's Blender has open, however the link spells it", () => {
    expect(hostedBlenderOpensLink("models/hero.blend", "/work", running)).toBe(true);
    expect(hostedBlenderOpensLink("./models/hero.blend", "/work", running)).toBe(true);
    expect(hostedBlenderOpensLink("/work/models/hero.blend", "/work/", running)).toBe(true);
    expect(
      hostedBlenderOpensLink("models/hero.blend", "/work", { ...running, status: "starting" }),
    ).toBe(true);
  });

  it("opens the 3D preview for any other file, or when no Blender has it open", () => {
    expect(hostedBlenderOpensLink("models/other.blend", "/work", running)).toBe(false);
    expect(hostedBlenderOpensLink("/elsewhere/models/hero.blend", "/work", running)).toBe(false);
    expect(hostedBlenderOpensLink("models/hero.blend", "/work", { status: "stopped" })).toBe(false);
    expect(hostedBlenderOpensLink("models/hero.blend", "/work", null)).toBe(false);
  });
});
