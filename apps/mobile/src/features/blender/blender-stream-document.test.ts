import { describe, expect, it } from "vite-plus/test";

import {
  blenderStreamMessage,
  blenderViewerReducer,
  initialBlenderViewer,
} from "./blender-stream-document";

describe("mobile Blender stream bridge", () => {
  it("reads who is in control and drops anything else", () => {
    expect(
      blenderStreamMessage('{"type":"control","canOperate":true,"controller":"another-viewer"}'),
    ).toEqual({ type: "control", canOperate: true, controller: "another-viewer" });
    expect(blenderStreamMessage('{"type":"control","canOperate":true,"controller":"me"}')).toBe(
      null,
    );
    expect(blenderStreamMessage("not json")).toBe(null);
    expect(blenderStreamMessage('{"type":"frameSize","width":1046,"height":2004}')).toEqual({
      type: "frameSize",
      width: 1046,
      height: 2004,
    });
  });
});

describe("mobile Blender viewer recovery", () => {
  it("refreshes a refused ticket a few times, then waits for Reconnect", () => {
    let state = initialBlenderViewer("v0");
    for (const viewer of ["v1", "v2", "v3"]) {
      state = blenderViewerReducer(state, { type: "unauthorized", viewer });
      expect(state).toMatchObject({ status: "connecting", viewer });
    }
    state = blenderViewerReducer(state, { type: "unauthorized", viewer: "v4" });
    expect(state).toMatchObject({ status: "error", viewer: "v3" });
    state = blenderViewerReducer(state, { type: "reconnect", viewer: "v5" });
    expect(state).toMatchObject({ status: "connecting", viewer: "v5" });
    state = blenderViewerReducer(state, { type: "unauthorized", viewer: "v6" });
    expect(state).toMatchObject({ status: "connecting", viewer: "v6" });
  });

  it("forgets earlier refusals once the stream is live", () => {
    let state = initialBlenderViewer("v0");
    for (const viewer of ["v1", "v2", "v3"]) {
      state = blenderViewerReducer(state, { type: "unauthorized", viewer });
    }
    state = blenderViewerReducer(state, { type: "status", status: "live" });
    state = blenderViewerReducer(state, { type: "unauthorized", viewer: "v4" });
    expect(state).toMatchObject({ status: "connecting", viewer: "v4" });
  });
});
