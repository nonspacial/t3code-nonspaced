import { describe, expect, it } from "@effect/vitest";

import { MAX_PENDING_FRAMES, ViewerFlow } from "./ViewerFlow.ts";

const frame = (key: boolean, id: number) => ({ key, data: new Uint8Array([id]) });
const ids = (frames: ReadonlyArray<{ readonly data: Uint8Array }>) =>
  frames.map((entry) => entry.data[0]);

describe("ViewerFlow", () => {
  it("waits for a keyframe, then keeps one frame on the wire and the rest queued", () => {
    const flow = new ViewerFlow();
    expect(flow.offer(frame(false, 1))).toEqual({ send: null, requestKeyframe: true });
    expect(ids([flow.offer(frame(true, 2)).send!])).toEqual([2]);
    expect(flow.offer(frame(false, 3))).toEqual({ send: null, requestKeyframe: false });
    expect(flow.offer(frame(false, 4)).send).toBeNull();
    expect(ids([flow.ack()!, flow.ack()!])).toEqual([3, 4]);
    expect(flow.ack()).toBeNull();
    expect(ids([flow.offer(frame(false, 5)).send!])).toEqual([5]);
  });

  it("drops queued deltas when a keyframe supersedes them", () => {
    const flow = new ViewerFlow();
    flow.offer(frame(true, 1));
    flow.offer(frame(false, 2));
    flow.offer(frame(false, 3));
    expect(flow.offer(frame(true, 4))).toEqual({ send: null, requestKeyframe: false });
    expect(ids([flow.ack()!])).toEqual([4]);
    expect(flow.ack()).toBeNull();
  });

  it("falls back to the next keyframe when a slow viewer's queue overflows", () => {
    const flow = new ViewerFlow();
    flow.offer(frame(true, 0));
    for (let id = 1; id <= MAX_PENDING_FRAMES; id++) flow.offer(frame(false, id));
    expect(flow.offer(frame(false, 99))).toEqual({ send: null, requestKeyframe: true });
    expect(flow.ack()).toBeNull();
    expect(flow.offer(frame(false, 100))).toEqual({ send: null, requestKeyframe: true });
    expect(ids([flow.offer(frame(true, 101)).send!])).toEqual([101]);
  });
});
