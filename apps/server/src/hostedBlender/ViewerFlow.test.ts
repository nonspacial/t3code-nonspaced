import { describe, expect, it } from "@effect/vitest";

import { MAX_PENDING_FRAMES, ViewerFlow } from "./ViewerFlow.ts";

const frame = (key: boolean, id: number) => ({ key, data: new Uint8Array([id]) });
const ids = (frames: ReadonlyArray<{ readonly data: Uint8Array } | null>) =>
  frames.map((entry) => entry?.data[0] ?? null);

describe("ViewerFlow", () => {
  it("waits for a keyframe, then keeps one frame on the wire and the rest queued", () => {
    const flow = new ViewerFlow();
    expect(flow.offer(frame(false, 1), 0)).toEqual({
      send: null,
      requestKeyframe: true,
      fellBehind: false,
    });
    expect(ids([flow.offer(frame(true, 2), 0).send])).toEqual([2]);
    expect(flow.offer(frame(false, 3), 0)).toEqual({
      send: null,
      requestKeyframe: false,
      fellBehind: false,
    });
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
    expect(flow.ack(200)).toEqual({ next: null, latencyMs: 60 });
    expect(flow.ack(300).latencyMs).toBeNull();
  });

  it("drops queued deltas when a keyframe supersedes them", () => {
    const flow = new ViewerFlow();
    flow.offer(frame(true, 1), 0);
    flow.offer(frame(false, 2), 0);
    flow.offer(frame(false, 3), 0);
    expect(flow.offer(frame(true, 4), 0)).toEqual({
      send: null,
      requestKeyframe: false,
      fellBehind: false,
    });
    expect(ids([flow.ack(0).next])).toEqual([4]);
    expect(flow.ack(0).next).toBeNull();
  });

  it("falls back to the next keyframe when a slow viewer's queue overflows", () => {
    const flow = new ViewerFlow();
    flow.offer(frame(true, 0), 0);
    for (let id = 1; id <= MAX_PENDING_FRAMES; id++) flow.offer(frame(false, id), 0);
    expect(flow.offer(frame(false, 99), 0)).toEqual({
      send: null,
      requestKeyframe: true,
      fellBehind: true,
    });
    expect(flow.ack(0).next).toBeNull();
    expect(flow.offer(frame(false, 100), 0)).toEqual({
      send: null,
      requestKeyframe: true,
      fellBehind: false,
    });
    expect(ids([flow.offer(frame(true, 101), 0).send])).toEqual([101]);
  });
});
