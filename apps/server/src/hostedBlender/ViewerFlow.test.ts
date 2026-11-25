import { describe, expect, it } from "@effect/vitest";

import { MAX_IN_FLIGHT_FRAMES, MAX_PENDING_FRAMES, ViewerFlow } from "./ViewerFlow.ts";

const frame = (key: boolean, id: number) => ({ key, data: new Uint8Array([id]) });
const ids = (frames: ReadonlyArray<{ readonly data: Uint8Array } | null>) =>
  frames.map((entry) => entry?.data[0] ?? null);

/** Fills the window with deltas after a keyframe, all sent at `now`. */
const filled = (flow: ViewerFlow, now = 0) => {
  flow.offer(frame(true, 0), now);
  for (let id = 1; id < MAX_IN_FLIGHT_FRAMES; id++) flow.offer(frame(false, id), now);
};

describe("ViewerFlow", () => {
  it("waits for a keyframe, then keeps a few frames on the wire and the rest queued", () => {
    const flow = new ViewerFlow();
    expect(flow.offer(frame(false, 1), 0)).toEqual({ send: null, requestKeyframe: true });
    expect(ids([flow.offer(frame(true, 2), 0).send])).toEqual([2]);
    for (let id = 3; id < 2 + MAX_IN_FLIGHT_FRAMES; id++) {
      expect(ids([flow.offer(frame(false, id), 0).send])).toEqual([id]);
    }
    // The window is full: later frames wait for acks, in order.
    expect(flow.offer(frame(false, 20), 0)).toEqual({ send: null, requestKeyframe: false });
    expect(flow.offer(frame(false, 21), 0).send).toBeNull();
    expect(ids([flow.ack(0).next, flow.ack(0).next])).toEqual([20, 21]);
    expect(flow.ack(0).next).toBeNull();
  });

  it("times each frame from going out to its own ack", () => {
    const flow = new ViewerFlow();
    flow.offer(frame(true, 1), 100);
    flow.offer(frame(false, 2), 110);
    expect(flow.ack(140)).toMatchObject({ latencyMs: 40 });
    expect(flow.ack(200)).toEqual({ next: null, latencyMs: 90, requestKeyframe: false });
    expect(flow.ack(300).latencyMs).toBeNull();
  });

  it("resyncs on the next keyframe, which waits behind a full window", () => {
    const flow = new ViewerFlow();
    filled(flow);
    flow.offer(frame(false, 10), 0);
    flow.resync();
    // Showing a pane asks for its keyframe itself; frames still out ask for nothing.
    expect(flow.offer(frame(false, 11), 0).requestKeyframe).toBe(false);
    expect(flow.offer(frame(true, 12), 0).send).toBeNull();
    expect(ids([flow.ack(0).next])).toEqual([12]);
  });

  it("drops queued deltas when a keyframe supersedes them", () => {
    const flow = new ViewerFlow();
    filled(flow);
    flow.offer(frame(false, 10), 0);
    flow.offer(frame(false, 11), 0);
    expect(flow.offer(frame(true, 12), 0)).toEqual({ send: null, requestKeyframe: false });
    expect(ids([flow.ack(0).next])).toEqual([12]);
    expect(flow.ack(0).next).toBeNull();
  });

  it("falls back to the next keyframe when a slow viewer's queue overflows", () => {
    const flow = new ViewerFlow();
    filled(flow);
    for (let id = 1; id <= MAX_PENDING_FRAMES; id++) flow.offer(frame(false, 10 + id), 0);
    // The frames it's stuck on are still out, so it asks for nothing yet.
    expect(flow.offer(frame(false, 99), 0)).toEqual({ send: null, requestKeyframe: false });
    expect(flow.ack(0)).toEqual({ next: null, latencyMs: 0, requestKeyframe: true });
    for (let left = 1; left < MAX_IN_FLIGHT_FRAMES; left++) flow.ack(0);
    expect(flow.offer(frame(false, 100), 0)).toEqual({ send: null, requestKeyframe: true });
    expect(ids([flow.offer(frame(true, 101), 0).send])).toEqual([101]);
  });

  it("asks for keyframes from a stalled viewer only once a stuck frame is acked", () => {
    const flow = new ViewerFlow();
    flow.offer(frame(true, 0), 0);
    // A second at 60 fps, with keyframes forced for others now and then, never acked.
    let requests = 0;
    for (let id = 1; id <= 60; id++) {
      if (flow.offer(frame(id % 10 === 0, id), id * 16).requestKeyframe) requests += 1;
    }
    expect(requests).toBe(0);
  });

  // Blender at 60 fps for 3 s to a viewer whose acks come one round trip after each send.
  const delivered = (roundTripMs: number) => {
    const flow = new ViewerFlow();
    const acks: number[] = [];
    let sent = 0;
    for (let now = 0; now < 3000; now++) {
      while (acks.length > 0 && acks[0]! <= now) {
        acks.shift();
        if (flow.ack(now).next !== null) {
          sent += 1;
          acks.push(now + roundTripMs);
        }
      }
      if (Math.floor(now * 0.06) !== Math.floor((now - 1) * 0.06) || now === 0) {
        if (flow.offer(frame(now % 1000 === 0, 0), now).send !== null) {
          sent += 1;
          acks.push(now + roundTripMs);
        }
      }
    }
    return sent / 3;
  };

  it("P4: keeps up with 60 fps over 50 and 100 ms round trips", () => {
    expect(delivered(50)).toBeGreaterThanOrEqual(59);
    expect(delivered(100)).toBeGreaterThanOrEqual(59);
  });
});
