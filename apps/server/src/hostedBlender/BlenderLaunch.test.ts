import { describe, expect, it } from "@effect/vitest";

import {
  displaySize,
  helperArguments,
  helperEnvironment,
  newestBlenderConfigVersion,
} from "./BlenderLaunch.ts";

describe("helperArguments", () => {
  it("runs Blender online, without embedded scripts, with the control add-on and its own ports", () => {
    expect(
      helperArguments({
        stateDir: "/state/thread-1",
        userResources: "/state/user-resources",
        blender: "/usr/bin/blender",
        addonPath: "/state/thread-1/t3_control.py",
        blendPath: "/work/models/hero.blend",
        controlSocket: "/run/user/1000/t3hb-1/control.sock",
        mcpPort: 41234,
        width: 1280,
        height: 720,
      }),
    ).toEqual([
      "--state-dir",
      "/state/thread-1",
      "--user-resources",
      "/state/user-resources",
      "--window-title",
      "3D Viewport",
      "--width",
      "1280",
      "--height",
      "720",
      "--",
      "/usr/bin/blender",
      "--online-mode",
      "-noaudio",
      "--disable-autoexec",
      "/work/models/hero.blend",
      "--python",
      "/state/thread-1/t3_control.py",
      "--",
      "--t3-control",
      "/run/user/1000/t3hb-1/control.sock",
      "--t3-mcp-port",
      "41234",
    ]);
  });
});

it("never passes T3's own variables, such as the thread id, to the helper", () => {
  expect(
    helperEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/me",
      T3CODE_THREAD_ID: "thread-1",
      T3CODE_AUTH_TOKEN: "secret",
      UNSET: undefined,
    }),
  ).toEqual({ PATH: "/usr/bin", HOME: "/home/me" });
});

it("copies settings from the newest Blender version folder", () => {
  expect(newestBlenderConfigVersion(["4.2", "5.10", "5.3", "scripts", "5.3.1"])).toBe("5.10");
  expect(newestBlenderConfigVersion(["notes"])).toBeUndefined();
});

it("keeps display sizes even and within the encoder's range", () => {
  expect(displaySize(1601, 901)).toEqual({ width: 1600, height: 900 });
  expect(displaySize(10, 10)).toEqual({ width: 320, height: 240 });
  expect(displaySize(9999, 9999)).toEqual({ width: 3840, height: 2160 });
});
