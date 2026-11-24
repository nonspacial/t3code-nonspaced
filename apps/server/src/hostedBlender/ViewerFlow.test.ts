import { describe, expect, it } from "@effect/vitest";

import { MAX_PENDING_FRAMES, ViewerFlow } from "./ViewerFlow.ts";

const frame = (key: boolean, id: number) => ({ key, data: new Uint8Array([id]) });
const ids = (frames: ReadonlyArray<{ readonly data: Uint8Array } | null>) =>
  frames.map((entry) => entry?.data[0] ?? null);

describe("ViewerFlow", () => {
  it("waits for a keyframe, then keeps one frame on the wire and the rest queued", () => {
    const flow = new ViewerFlow();
    expect(flow.offer(frame(false, 1), 0)).toEqual({ send: null, requestKeyframe: true });
    expect(ids([flow.offer(frame(true, 2), 0).send])).toEqual([2]);
    expect(flow.offer(frame(false, 3), 0)).toEqual({ send: null, requestKeyframe: false });
    expect(flow.offer(frame(false, 4), 0).send).toBeNull();
    expect(ids([flow.ack(0).next, flow.ack(0).next])).toEqual([3, 4]);
    expect(flow.ack(0).next).toBeNull();
    expect(ids([flow.offer(frame(false, 5), 0).send])).toEqual([5]);
  });

  it("times each frame from going out to its ack", () => {
    const flow = new ViewerFlow();
    flow.offer(frame(true, 1), 100);
    flow.offer(frame(false, 2), 110);
    // Frame 2 goes out when frame 1 is acked, so its time starts there.
    expect(flow.ack(140)).toMatchObject({ latencyMs: 40 });
    expect(flow.ack(200)).toEqual({ next: null, latencyMs: 60, requestKeyframe: false });
    expect(flow.ack(300).latencyMs).toBeNull();
  });

  it("resyncs on the next keyframe without a second frame going out", () => {
    const flow = new ViewerFlow();
    flow.offer(frame(true, 1), 0);
    flow.offer(frame(false, 2), 0);
    flow.resync();
    // Showing a pane asks for its keyframe itself; a frame still out asks for nothing.
    expect(flow.offer(frame(false, 3), 0).requestKeyframe).toBe(false);
    // Frame 1 is still on the wire, so the keyframe waits for its ack.
    expect(flow.offer(frame(true, 4), 0).send).toBeNull();
    expect(ids([flow.ack(0).next])).toEqual([4]);
  });

  it("drops queued deltas when a keyframe supersedes them", () => {
    const flow = new ViewerFlow();
    flow.offer(frame(true, 1), 0);
    flow.offer(frame(false, 2), 0);
    flow.offer(frame(false, 3), 0);
    expect(flow.offer(frame(true, 4), 0)).toEqual({ send: null, requestKeyframe: false });
    expect(ids([flow.ack(0).next])).toEqual([4]);
    expect(flow.ack(0).next).toBeNull();
  });

  it("falls back to the next keyframe when a slow viewer's queue overflows", () => {
    const flow = new ViewerFlow();
    flow.offer(frame(true, 0), 0);
    for (let id = 1; id <= MAX_PENDING_FRAMES; id++) flow.offer(frame(false, id), 0);
    // The frame it's stuck on is still out, so it asks for nothing yet.
    expect(flow.offer(frame(false, 99), 0)).toEqual({ send: null, requestKeyframe: false });
    expect(flow.ack(0)).toEqual({ next: null, latencyMs: 0, requestKeyframe: true });
    expect(flow.offer(frame(false, 100), 0)).toEqual({ send: null, requestKeyframe: true });
    expect(ids([flow.offer(frame(true, 101), 0).send])).toEqual([101]);
  });

  it("asks for keyframes from a stalled viewer only once its stuck frame is acked", () => {
    const flow = new ViewerFlow();
    flow.offer(frame(true, 0), 0);
    // A second at 60 fps, with keyframes forced for others now and then, never acked.
    let requests = 0;
    for (let id = 1; id <= 60; id++) {
      if (flow.offer(frame(id % 10 === 0, id), id * 16).requestKeyframe) requests += 1;
    }
    expect(requests).toBe(0);
  });
});
