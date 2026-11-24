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
  constructor(readonly url: string) {
    super();
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

it("decodes the stream from its first keyframe, acks every frame, and sizes the display", async () => {
  FakeSocket.instances = [];
  const decoded: string[] = [];
  let output: VideoFrameOutputCallback | undefined;
  const configured = Promise.withResolvers<VideoDecoderConfig>();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      constructor(readonly init: EncodedVideoChunkInit) {}
    },
  );
  vi.stubGlobal(
    "VideoDecoder",
    class {
      static isConfigSupported = async () => ({ supported: true });
      state = "unconfigured";
      constructor(init: VideoDecoderInit) {
        output = init.output;
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
  socket.receive(delta);
  socket.receive(keyframe);
  expect((await configured.promise).codec).toBe("avc1.64001f");
  socket.receive(delta);
  expect(decoded).toEqual(["key", "delta"]);
  output?.({ displayWidth: 1600, displayHeight: 900, close: vi.fn() } as unknown as VideoFrame);
  expect(present).toHaveBeenCalledOnce();
  expect(socket.sent).toEqual([
    JSON.stringify({ type: "resize", width: 1600, height: 900 }),
    ...Array.from({ length: 3 }, () => JSON.stringify({ type: "ack" })),
  ]);

  socket.closeWith(HOSTED_BLENDER_STREAM_STOPPED_CLOSE_CODE);
  expect(statuses).toEqual(["connecting", "live", "stopped"]);
  expect(FakeSocket.instances).toHaveLength(1);
  client.stop();
});
