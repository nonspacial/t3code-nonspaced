import { describe, expect, it } from "vite-plus/test";

import { notSetUpDetail } from "./hostedBlenderSetupText";

describe("hosted Blender not set up, on a phone", () => {
  it("points a switched-off Hosted Blender at Settings on web or desktop", () => {
    expect(notSetUpDetail(["enabled", "check", "blender"])).toBe(
      "Hosted Blender is switched off. Switch it on in Settings › Blender in T3 Code on the web or desktop.",
    );
  });

  it("points a server nobody has checked yet at Settings on web or desktop", () => {
    expect(notSetUpDetail(["check"])).toBe(
      "T3 Code hasn't checked this server yet. Check it in Settings › Blender in T3 Code on the web or desktop.",
    );
  });

  it("names everything else the server is missing", () => {
    expect(notSetUpDetail(["helper", "gstreamer", "encoder", "glupload", "labwc"])).toBe(
      "This server is missing: T3 Code's hidden display helper, GStreamer, an H.264 encoder, GStreamer's OpenGL plugin, labwc. Install them on the server, then open this again.",
    );
  });
});
