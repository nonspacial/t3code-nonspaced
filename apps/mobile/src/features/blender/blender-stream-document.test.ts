import { describe, expect, it } from "vite-plus/test";

import { blenderStreamMessage } from "./blender-stream-document";

describe("mobile Blender stream bridge", () => {
  it("reads who is in control and drops anything else", () => {
    expect(
      blenderStreamMessage('{"type":"control","canOperate":true,"controller":"another-viewer"}'),
    ).toEqual({ type: "control", canOperate: true, controller: "another-viewer" });
    expect(blenderStreamMessage('{"type":"control","canOperate":true,"controller":"me"}')).toBe(
      null,
    );
    expect(blenderStreamMessage("not json")).toBe(null);
  });
});
