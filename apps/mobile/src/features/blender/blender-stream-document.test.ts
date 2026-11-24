import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

import { deviceStreamDocument } from "../devices/device-stream-document";
import { blenderStreamMessage } from "./blender-stream-document";

describe("mobile Blender stream bridge", () => {
  it("starts the Blender stream script, not the device one, in the shared document", () => {
    const html = deviceStreamDocument(
      JSON.stringify({ threadId: "thread-1" }),
      "var T3BlenderStream={start(input){return input}};",
      "stopped",
      "T3BlenderStream",
    );
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    const input: unknown = NodeVM.runInNewContext(script!, { window: { addEventListener() {} } });
    expect(input).toEqual({ threadId: "thread-1" });
  });

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
