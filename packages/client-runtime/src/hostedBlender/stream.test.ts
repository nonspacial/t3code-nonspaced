// @effect-diagnostics globalTimers:off - drives the browser transport under fake timers.
import { HOSTED_BLENDER_STREAM_STOPPED_CLOSE_CODE } from "@t3tools/contracts";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { ViewerFlow } from "../../../../apps/server/src/hostedBlender/ViewerFlow.ts";
import { avcFrameSize, createHostedBlenderStreamClient } from "./stream.ts";

afterEach(() => vi.unstubAllGlobals());

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  receive(data: ArrayBuffer | string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  closeWith(code: number) {
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }));
  }
}

const semu = (key: boolean, accessUnit: number[]) => {
  const bytes = new Uint8Array(16 + accessUnit.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x53454d55);
  bytes[4] = 1;
  bytes[5] = key ? 1 : 0;
  view.setBigUint64(8, 1000n);
  bytes.set(accessUnit, 16);
  return bytes.buffer;
};
// An SPS (High, level 3.1) and an IDR slice, then a delta slice.
const keyframe = semu(true, [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0, 0, 0, 1, 0x65, 0x88]);
const delta = semu(false, [0, 0, 0, 1, 0x41, 0x9a]);

it("acks a frame only once the decoder has taken it, and sizes the display", async () => {
  FakeSocket.instances = [];
  const decoded: string[] = [];
  let output: VideoFrameOutputCallback | undefined;
  let decoderInstance: (EventTarget & { decodeQueueSize: number }) | undefined;
  const configured = Promise.withResolvers<VideoDecoderConfig>();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      readonly init: EncodedVideoChunkInit;
      constructor(init: EncodedVideoChunkInit) {
        this.init = init;
      }
    },
  );
  vi.stubGlobal(
    "VideoDecoder",
    class extends EventTarget {
      static isConfigSupported = async () => ({ supported: true });
      state = "unconfigured";
      decodeQueueSize = 0;
      constructor(init: VideoDecoderInit) {
        super();
        output = init.output;
        decoderInstance = this;
      }
      configure(config: VideoDecoderConfig) {
        this.state = "configured";
        configured.resolve(config);
      }
      decode(chunk: { init: EncodedVideoChunkInit }) {
        decoded.push(chunk.init.type);
      }
      close() {
        this.state = "closed";
      }
    },
  );
  const present = vi.fn(() => true);
  const statuses: string[] = [];
  const client = createHostedBlenderStreamClient(
    {
      access: { httpBase: "https://t3", wsBase: "wss://t3/blender", credentials: false, query: {} },
      threadId: "thread-1",
    },
    { present },
    {
      onStatus: (status) => statuses.push(status),
      onStats: vi.fn(),
      onFrameRate: vi.fn(),
      onUnauthorized: vi.fn(),
    },
  );
  const socket = FakeSocket.instances[0]!;
  expect(socket.url).toBe("wss://t3/blender/ws?threadId=thread-1");
  client.resize(1600.4, 900);
  socket.open();
  const ack = JSON.stringify({ type: "ack" });
  const acks = () => socket.sent.filter((message) => message === ack).length;
  expect(socket.sent).toEqual([JSON.stringify({ type: "resize", width: 1600, height: 900 })]);

  // The keyframe's ack waits for the decoder, so no delta arrives while it is configured.
  socket.receive(keyframe);
  expect(acks()).toBe(0);
  expect((await configured.promise).codec).toBe("avc1.64001f");
  await vi.waitFor(() => expect(acks()).toBe(1));
  expect(decoded).toEqual(["key"]);

  // A decoder that falls behind holds the ack until it catches up.
  decoderInstance!.decodeQueueSize = 9;
  socket.receive(delta);
  expect(decoded).toEqual(["key", "delta"]);
  expect(acks()).toBe(1);
  decoderInstance!.decodeQueueSize = 0;
  decoderInstance!.dispatchEvent(new Event("dequeue"));
  expect(acks()).toBe(2);

  output?.({ displayWidth: 1600, displayHeight: 900, close: vi.fn() } as unknown as VideoFrame);
  expect(present).toHaveBeenCalledOnce();

  socket.closeWith(HOSTED_BLENDER_STREAM_STOPPED_CLOSE_CODE);
  expect(statuses).toEqual(["connecting", "live", "stopped"]);
  expect(FakeSocket.instances).toHaveLength(1);
  client.stop();
});

it("reports who controls Blender and whether it holds the mouse, and sends input while open", () => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  vi.stubGlobal("VideoDecoder", vi.fn());
  const control = vi.fn();
  const cursor = vi.fn();
  const client = createHostedBlenderStreamClient(
    {
      access: { httpBase: "https://t3", wsBase: "wss://t3/blender", credentials: false, query: {} },
      threadId: "thread-1",
    },
    { present: vi.fn(() => true) },
    {
      onStatus: vi.fn(),
      onStats: vi.fn(),
      onFrameRate: vi.fn(),
      onUnauthorized: vi.fn(),
      onControl: control,
      onCursor: cursor,
    },
  );
  const socket = FakeSocket.instances[0]!;
  // Input before the socket opens would land on a stale controller; it is dropped.
  client.send({ type: "key", code: 30, pressed: true });
  socket.open();
  client.send({ type: "takeControl", takeOver: false });
  expect(socket.sent).toEqual([JSON.stringify({ type: "takeControl", takeOver: false })]);
  socket.receive(JSON.stringify({ type: "control", canOperate: true, controller: "you" }));
  socket.receive(JSON.stringify({ type: "cursor", captured: true }));
  expect(control).toHaveBeenCalledWith({ canOperate: true, controller: "you" });
  expect(cursor).toHaveBeenCalledWith(true);

  // A reconnect starts view-only until the server says otherwise.
  socket.closeWith(1012);
  expect(control).toHaveBeenLastCalledWith({ canOperate: false, controller: "unclaimed" });
  expect(cursor).toHaveBeenLastCalledWith(false);
  client.stop();
});

it("tells the server when the pane leaves the screen and comes back, across reconnects", () => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  vi.stubGlobal("VideoDecoder", vi.fn());
  const client = createHostedBlenderStreamClient(
    {
      access: { httpBase: "https://t3", wsBase: "wss://t3/blender", credentials: false, query: {} },
      threadId: "thread-1",
    },
    { present: vi.fn(() => true) },
    { onStatus: vi.fn(), onStats: vi.fn(), onFrameRate: vi.fn(), onUnauthorized: vi.fn() },
  );
  const first = FakeSocket.instances[0]!;
  // A viewer starts visible, so an on-screen pane says nothing.
  first.open();
  client.setVisible(true);
  client.setVisible(false);
  client.setVisible(false);
  client.setVisible(true);
  expect(first.sent).toEqual([
    JSON.stringify({ type: "visibility", visible: false }),
    JSON.stringify({ type: "visibility", visible: true }),
  ]);

  // A pane hidden while reconnecting says so as it connects, before the server attaches it, so
  // nothing starts capturing or reloading for it; it says nothing more once open.
  client.setVisible(false);
  first.closeWith(1012);
  vi.runAllTimers();
  const second = FakeSocket.instances[1]!;
  expect(second.url).toBe("wss://t3/blender/ws?threadId=thread-1&hidden=1");
  second.open();
  expect(second.sent).toEqual([]);
  // Shown again before the next connection opens, it says so once open.
  second.closeWith(1012);
  vi.runAllTimers();
  const third = FakeSocket.instances[2]!;
  client.setVisible(true);
  third.open();
  expect(third.sent).toEqual([JSON.stringify({ type: "visibility", visible: true })]);
  client.stop();
});

it("starts a new decoder when a keyframe brings a new frame size, and keeps it otherwise", async () => {
  FakeSocket.instances = [];
  const decoders: Array<{ codec: string | null; decoded: string[]; state: string }> = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      readonly init: EncodedVideoChunkInit;
      constructor(init: EncodedVideoChunkInit) {
        this.init = init;
      }
    },
  );
  vi.stubGlobal(
    "VideoDecoder",
    class extends EventTarget {
      static isConfigSupported = async () => ({ supported: true });
      readonly record = {
        codec: null as string | null,
        decoded: [] as string[],
        state: "unconfigured",
      };
      decodeQueueSize = 0;
      constructor() {
        super();
        decoders.push(this.record);
      }
      get state() {
        return this.record.state;
      }
      configure(config: VideoDecoderConfig) {
        this.record.state = "configured";
        this.record.codec = config.codec;
      }
      decode(chunk: { init: EncodedVideoChunkInit }) {
        this.record.decoded.push(chunk.init.type);
      }
      close() {
        this.record.state = "closed";
      }
    },
  );
  const client = createHostedBlenderStreamClient(
    {
      access: { httpBase: "https://t3", wsBase: "wss://t3/blender", credentials: false, query: {} },
      threadId: "thread-1",
    },
    { present: vi.fn(() => true) },
    { onStatus: vi.fn(), onStats: vi.fn(), onFrameRate: vi.fn(), onUnauthorized: vi.fn() },
  );
  const socket = FakeSocket.instances[0]!;
  socket.open();
  socket.receive(keyframe);
  await vi.waitFor(() => expect(decoders[0]?.decoded).toEqual(["key"]));
  // The same SPS again, with a different slice: the same decoder carries on.
  socket.receive(semu(true, [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0, 0, 0, 1, 0x65, 0x99]));
  expect(decoders).toHaveLength(1);
  expect(decoders[0]!.decoded).toEqual(["key", "key"]);
  // The display resized: a different SPS (here level 4.0) starts a decoder of its own, since some
  // decoders (Android's WebView) keep the first frame size.
  socket.receive(semu(true, [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0, 0, 0, 1, 0x65, 0x88]));
  await vi.waitFor(() => expect(decoders[1]?.decoded).toEqual(["key"]));
  expect(decoders[0]!.state).toBe("closed");
  expect(decoders[1]!.codec).toBe("avc1.640028");
  client.stop();
});

it("sends its size again when it is granted control, so the display follows it", () => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  vi.stubGlobal("VideoDecoder", vi.fn());
  const client = createHostedBlenderStreamClient(
    {
      access: { httpBase: "https://t3", wsBase: "wss://t3/blender", credentials: false, query: {} },
      threadId: "thread-1",
    },
    { present: vi.fn(() => true) },
    { onStatus: vi.fn(), onStats: vi.fn(), onFrameRate: vi.fn(), onUnauthorized: vi.fn() },
  );
  const socket = FakeSocket.instances[0]!;
  client.resize(1044, 2002);
  socket.open();
  const resize = JSON.stringify({ type: "resize", width: 1044, height: 2002 });
  expect(socket.sent).toEqual([resize]);
  socket.receive(JSON.stringify({ type: "control", canOperate: true, controller: "unclaimed" }));
  expect(socket.sent).toEqual([resize]);
  socket.receive(JSON.stringify({ type: "control", canOperate: true, controller: "you" }));
  expect(socket.sent).toEqual([resize, resize]);
  // Still in control: nothing new to say.
  socket.receive(JSON.stringify({ type: "control", canOperate: true, controller: "you" }));
  expect(socket.sent).toEqual([resize, resize]);
  client.stop();
});

// SPS NAL units (header byte first) from GStreamer's nvh264enc and x264enc at the sizes a hosted
// Blender's display takes; x264's carry emulation-prevention bytes.
const SPS = {
  "nvh264enc baseline 1280x720": [
    0x67, 0x42, 0xc0, 0x1f, 0x95, 0x90, 0x05, 0x00, 0x5b, 0xb0, 0x16, 0xa0, 0x20, 0x20, 0x28, 0x00,
    0x00, 0x1f, 0x40, 0x00, 0x07, 0x53, 0x04, 0x20,
  ],
  "nvh264enc baseline 1046x1336": [
    0x67, 0x42, 0xc0, 0x28, 0x95, 0x90, 0x04, 0x20, 0x2a, 0x79, 0xa5, 0xc0, 0x5a, 0x80, 0x80, 0x80,
    0xa0, 0x00, 0x00, 0x7d, 0x00, 0x00, 0x1d, 0x4c, 0x10, 0x80,
  ],
  "nvh264enc baseline 1044x2002": [
    0x67, 0x42, 0xc0, 0x2a, 0x95, 0x90, 0x04, 0x20, 0x3f, 0x79, 0xe2, 0x30, 0x16, 0xa0, 0x20, 0x20,
    0x28, 0x00, 0x00, 0x1f, 0x40, 0x00, 0x07, 0x53, 0x04, 0x20,
  ],
  "nvh264enc high 1044x2002": [
    0x67, 0x64, 0x00, 0x2a, 0xac, 0x2b, 0x20, 0x08, 0x40, 0x7e, 0xf3, 0xc4, 0x60, 0x2d, 0x40, 0x40,
    0x40, 0x50, 0x00, 0x00, 0x3e, 0x80, 0x00, 0x0e, 0xa6, 0x08, 0x40,
  ],
  "x264enc 1280x720": [
    0x67, 0x42, 0xc0, 0x1f, 0xda, 0x01, 0x40, 0x16, 0xec, 0x05, 0xa8, 0x08, 0x08, 0x0a, 0x00, 0x00,
    0x03, 0x00, 0x02, 0x00, 0x00, 0x03, 0x00, 0x79, 0x1e, 0x30, 0x65, 0x40,
  ],
  "x264enc 1046x1336": [
    0x67, 0x42, 0xc0, 0x28, 0xda, 0x01, 0x08, 0x0a, 0x9e, 0x69, 0x70, 0x16, 0xa0, 0x20, 0x20, 0x28,
    0x00, 0x00, 0x03, 0x00, 0x08, 0x00, 0x00, 0x03, 0x01, 0xe4, 0x78, 0xc1, 0x95,
  ],
  "x264enc 1044x2002": [
    0x67, 0x42, 0xc0, 0x2a, 0xda, 0x01, 0x08, 0x0f, 0xde, 0x78, 0x8c, 0x05, 0xa8, 0x08, 0x08, 0x0a,
    0x00, 0x00, 0x03, 0x00, 0x02, 0x00, 0x00, 0x03, 0x00, 0x79, 0x1e, 0x30, 0x65, 0x40,
  ],
};

it.each(Object.entries(SPS))("reads the cropped frame size from the SPS (%s)", (name, bytes) => {
  const [width, height] = name.split(" ").at(-1)!.split("x").map(Number);
  expect(avcFrameSize(new Uint8Array(bytes))).toEqual({ width, height });
});

it("tells the decoder the frame size, which Android's WebView needs to show it uncropped", async () => {
  FakeSocket.instances = [];
  const configured = Promise.withResolvers<VideoDecoderConfig>();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  vi.stubGlobal(
    "VideoDecoder",
    class extends EventTarget {
      static isConfigSupported = async () => ({ supported: true });
      state = "unconfigured";
      decodeQueueSize = 0;
      configure(config: VideoDecoderConfig) {
        this.state = "configured";
        configured.resolve(config);
      }
      decode() {}
      close() {}
    },
  );
  const client = createHostedBlenderStreamClient(
    {
      access: { httpBase: "https://t3", wsBase: "wss://t3/blender", credentials: false, query: {} },
      threadId: "thread-1",
    },
    { present: vi.fn(() => true) },
    { onStatus: vi.fn(), onStats: vi.fn(), onFrameRate: vi.fn(), onUnauthorized: vi.fn() },
  );
  const socket = FakeSocket.instances[0]!;
  socket.open();
  socket.receive(
    semu(true, [0, 0, 0, 1, ...SPS["nvh264enc high 1044x2002"], 0, 0, 0, 1, 0x65, 0x88]),
  );
  expect(await configured.promise).toMatchObject({
    codec: "avc1.64002a",
    codedWidth: 1044,
    codedHeight: 2002,
  });
  client.stop();
});

it("watches the thread's master Blender when asked", () => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  vi.stubGlobal("VideoDecoder", vi.fn());
  createHostedBlenderStreamClient(
    {
      access: { httpBase: "https://t3", wsBase: "wss://t3/blender", credentials: false, query: {} },
      threadId: "thread-1",
      master: true,
    },
    { present: vi.fn(() => true) },
    { onStatus: vi.fn(), onStats: vi.fn(), onFrameRate: vi.fn(), onUnauthorized: vi.fn() },
  ).stop();
  expect(FakeSocket.instances.at(-1)!.url).toBe(
    "wss://t3/blender/ws?threadId=thread-1&role=master",
  );
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

describe("the stream client against the server's ViewerFlow", () => {
  afterEach(() => vi.useRealTimers());

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
