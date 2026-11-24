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
