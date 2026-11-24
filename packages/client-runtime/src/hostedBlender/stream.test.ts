import { HOSTED_BLENDER_STREAM_STOPPED_CLOSE_CODE } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { createHostedBlenderStreamClient } from "./stream.ts";

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
