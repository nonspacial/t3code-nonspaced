import { describe, expect, it } from "vite-plus/test";

import { watchableHostedBlender } from "./watchableHostedBlender";

describe("watching a thread's hosted Blender from the thread", () => {
  it("offers a Blender that is running or starting, and nothing else", () => {
    expect(
      watchableHostedBlender({ status: "running", relativePath: "models/hero.blend", dirty: true }),
    ).toEqual({ fileName: "hero.blend" });
    expect(
      watchableHostedBlender({ status: "starting", relativePath: "hero.blend", dirty: false }),
    ).toEqual({ fileName: "hero.blend" });
    expect(watchableHostedBlender({ status: "stopped" })).toBe(null);
    expect(watchableHostedBlender({ status: "failed" })).toBe(null);
    expect(watchableHostedBlender({ status: "notSetUp", missing: ["blender"] })).toBe(null);
    expect(watchableHostedBlender({ status: "unavailable" })).toBe(null);
    // No answer yet, or no read access: the subscription has nothing to show.
    expect(watchableHostedBlender(null)).toBe(null);
  });
});
