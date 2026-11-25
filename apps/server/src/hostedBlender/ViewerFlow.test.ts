import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { createHostedBlenderStreamClient } from "../../../../packages/client-runtime/src/hostedBlender/stream.ts";

import { MAX_IN_FLIGHT_FRAMES, MAX_PENDING_FRAMES, ViewerFlow } from "./ViewerFlow.ts";

const frame = (key: boolean, id: number) => ({ key, data: new Uint8Array([id]) });
const ids = (frames: ReadonlyArray<{ readonly data: Uint8Array } | null>) =>
  frames.map((entry) => entry?.data[0] ?? null);

/** Fills the window with deltas after an acked keyframe, all sent at `now`. */
const filled = (flow: ViewerFlow, now = 0) => {
  flow.offer(frame(true, 0), now);
  flow.ack(now);
  for (let id = 1; id <= MAX_IN_FLIGHT_FRAMES; id++) flow.offer(frame(false, id), now);
};

describe("ViewerFlow", () => {
  it("waits for a keyframe and its ack, then keeps a few frames on the wire and the rest queued", () => {
    const flow = new ViewerFlow();
    expect(flow.offer(frame(false, 1), 0)).toEqual({ send: null, requestKeyframe: true });
    expect(ids([flow.offer(frame(true, 2), 0).send])).toEqual([2]);
    // Nothing follows a keyframe until it is acked: the viewer may still be starting its decoder.
    const gated = MAX_PENDING_FRAMES - 2;
    for (let id = 3; id < 3 + gated; id++) expect(flow.offer(frame(false, id), 0).send).toBeNull();
    expect(ids(flow.ack(0).send)).toEqual(Array.from({ length: gated }, (_, index) => 3 + index));
    for (let id = 3 + gated; id < 3 + MAX_IN_FLIGHT_FRAMES; id++) {
      expect(ids([flow.offer(frame(false, id), 0).send])).toEqual([id]);
    }
    // The window is full: later frames wait for acks, in order.
    expect(flow.offer(frame(false, 20), 0)).toEqual({ send: null, requestKeyframe: false });
    expect(flow.offer(frame(false, 21), 0).send).toBeNull();
    expect(ids([...flow.ack(0).send, ...flow.ack(0).send])).toEqual([20, 21]);
    expect(flow.ack(0).send).toEqual([]);
  });

  it("times each frame from going out to its own ack", () => {
    const flow = new ViewerFlow();
    flow.offer(frame(true, 1), 100);
    flow.offer(frame(false, 2), 110);
    expect(flow.ack(140)).toMatchObject({ latencyMs: 40 });
    expect(flow.ack(200)).toEqual({ send: [], latencyMs: 60, requestKeyframe: false });
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
    expect(ids(flow.ack(0).send)).toEqual([12]);
  });

  it("drops queued deltas when a keyframe supersedes them", () => {
    const flow = new ViewerFlow();
    filled(flow);
    flow.offer(frame(false, 10), 0);
    flow.offer(frame(false, 11), 0);
    expect(flow.offer(frame(true, 12), 0)).toEqual({ send: null, requestKeyframe: false });
    flow.offer(frame(false, 13), 0);
    expect(ids(flow.ack(0).send)).toEqual([12]);
    expect(flow.ack(0).send).toEqual([]);
  });

  it("falls back to the next keyframe when a slow viewer's queue overflows", () => {
    const flow = new ViewerFlow();
    filled(flow);
    for (let id = 1; id <= MAX_PENDING_FRAMES; id++) flow.offer(frame(false, 10 + id), 0);
    // The frames it's stuck on are still out, so it asks for nothing yet.
    expect(flow.offer(frame(false, 99), 0)).toEqual({ send: null, requestKeyframe: false });
    expect(flow.ack(0)).toEqual({ send: [], latencyMs: 0, requestKeyframe: true });
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
});

// Blender at 60 fps through the real ViewerFlow to the real stream client, over a link with
// `roundTripMs` and a decoder that takes `decodeMs(now)` per frame.
const simulateStream = async (options: {
  readonly roundTripMs: number;
  readonly configureMs: number;
  readonly resizesAt: ReadonlyArray<number>;
  readonly decodeMs: (now: number) => number;
}) => {
  const oneWay = options.roundTripMs / 2;
  const clock = () => vi.getMockedSystemTime()!.getTime();
  const flow = new ViewerFlow();
  const sent: number[] = [];
  const decoded: Array<{ readonly decoder: number; readonly id: number }> = [];
  const presentedAt: number[] = [];
  let acks = 0;
  let socket: SimSocket | null = null;

  class SimSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    binaryType = "blob";
    constructor(_url: string) {
      super();
      socket = this;
      setTimeout(() => {
        this.readyState = SimSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      }, oneWay);
    }
    send(data: string) {
      if (JSON.parse(data).type !== "ack") return;
      setTimeout(() => {
        acks += 1;
        const acked = flow.ack(clock());
        for (const frame of acked.send) deliver(frame);
        wantKeyframe ||= acked.requestKeyframe;
      }, oneWay);
    }
    close() {}
  }
  const deliver = (frame: { readonly key: boolean; readonly data: Uint8Array }) => {
    sent.push(Number(new DataView(frame.data.buffer).getBigUint64(8)));
    const raw = frame.data.slice().buffer;
    setTimeout(() => socket!.dispatchEvent(new MessageEvent("message", { data: raw })), oneWay);
  };

  let decoders = 0;
  class SimDecoder extends EventTarget {
    static isConfigSupported = () => {
      const support = Promise.withResolvers<{ readonly supported: boolean }>();
      setTimeout(() => support.resolve({ supported: true }), options.configureMs);
      return support.promise;
    };
    readonly index = decoders++;
    readonly output: VideoFrameOutputCallback;
    state = "unconfigured";
    queue: number[] = [];
    busy = false;
    get decodeQueueSize() {
      return this.queue.length;
    }
    constructor(init: VideoDecoderInit) {
      super();
      this.output = init.output;
    }
    configure() {
      this.state = "configured";
    }
    decode(chunk: { readonly timestamp: number }) {
      this.queue.push(chunk.timestamp);
      this.next();
    }
    next() {
      if (this.busy || this.queue.length === 0) return;
      this.busy = true;
      setTimeout(() => {
        this.busy = false;
        if (this.state !== "configured") return;
        decoded.push({ decoder: this.index, id: this.queue.shift()! });
        this.output({ displayWidth: 1, displayHeight: 1, close() {} } as unknown as VideoFrame);
        this.dispatchEvent(new Event("dequeue"));
        this.next();
      }, options.decodeMs(clock()));
    }
    close() {
      this.state = "closed";
      this.queue = [];
    }
  }

  vi.stubGlobal("WebSocket", SimSocket);
  vi.stubGlobal("VideoDecoder", SimDecoder);
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      readonly timestamp: number;
      constructor(init: EncodedVideoChunkInit) {
        this.timestamp = init.timestamp;
      }
    },
  );

  const client = createHostedBlenderStreamClient(
    {
      access: { httpBase: "https://t3", wsBase: "wss://t3/blender", credentials: false, query: {} },
      threadId: "thread-1",
    },
    { present: () => (presentedAt.push(clock()), true) },
    { onStatus: () => {}, onStats: () => {}, onFrameRate: () => {}, onUnauthorized: () => {} },
  );

  // Joining asks for a keyframe; so does a viewer that fell too far behind, at most every 250 ms
  // as the server does. A resize starts a keyframe with a new SPS.
  let wantKeyframe = true;
  let lastKeyframe = Number.NEGATIVE_INFINITY;
  let size = 0;
  const resizes = [...options.resizesAt];
  for (let id = 1; id <= 600; id++) {
    await vi.advanceTimersByTimeAsync(1000 / 60);
    const now = clock();
    if (resizes.length > 0 && resizes[0]! <= now) {
      resizes.shift();
      size += 1;
      wantKeyframe = true;
      lastKeyframe = Number.NEGATIVE_INFINITY;
    }
    const key = wantKeyframe && now - lastKeyframe >= 250;
    if (key) {
      wantKeyframe = false;
      lastKeyframe = now;
    }
    const accessUnit = key
      ? [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f + size, 0, 0, 0, 1, 0x65, 0x88]
      : [0, 0, 0, 1, 0x41, 0x9a];
    const data = new Uint8Array(16 + accessUnit.length);
    const view = new DataView(data.buffer);
    view.setUint32(0, 0x53454d55);
    data[4] = 1;
    data[5] = key ? 1 : 0;
    view.setBigUint64(8, BigInt(id));
    data.set(accessUnit, 16);
    const offered = flow.offer({ key, data }, now);
    if (offered.send) deliver(offered.send);
    wantKeyframe ||= offered.requestKeyframe;
  }
  await vi.advanceTimersByTimeAsync(2000);
  client.stop();
  return { sent, decoded, acks, presentedAt };
};

describe("the stream client against ViewerFlow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const expectWhole = (run: Awaited<ReturnType<typeof simulateStream>>) => {
    // Every frame on the wire is acked, so no slot of the window is lost for good.
    expect(run.acks).toBe(run.sent.length);
    // Every frame the server sent is decoded, in order: no delta is dropped.
    expect(run.decoded.map((entry) => entry.id)).toEqual(run.sent);
  };
  const fps = (presentedAt: ReadonlyArray<number>, from: number, to: number) =>
    (presentedAt.filter((at) => at >= from && at < to).length * 1000) / (to - from);

  it.each([20, 50, 100])(
    "R1: starts, resizes six times and keeps 60 fps over a %i ms round trip",
    async (roundTripMs) => {
      vi.useFakeTimers({ now: 0 });
      const run = await simulateStream({
        roundTripMs,
        configureMs: 40,
        resizesAt: [1500, 3000, 4500, 6000, 7500, 9000],
        decodeMs: () => 2,
      });
      expectWhole(run);
      expect(fps(run.presentedAt, 1000, 10_000)).toBeGreaterThanOrEqual(59);
      expect(run.presentedAt.at(-1)).toBeGreaterThanOrEqual(10_000 - 100 + roundTripMs / 2);
    },
  );

  it("R1: a decoder that falls behind for two seconds loses no slot and recovers", async () => {
    vi.useFakeTimers({ now: 0 });
    const run = await simulateStream({
      roundTripMs: 50,
      configureMs: 40,
      resizesAt: [],
      decodeMs: (now) => (now >= 3000 && now < 5000 ? 30 : 2),
    });
    expectWhole(run);
    expect(fps(run.presentedAt, 6000, 10_000)).toBeGreaterThanOrEqual(59);
  });
});
