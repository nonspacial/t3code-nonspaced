// @effect-diagnostics globalTimers:off globalDate:off - This browser and WebView transport runs without an Effect runtime.
import {
  HOSTED_BLENDER_STREAM_FULL_CLOSE_CODE,
  HOSTED_BLENDER_STREAM_STOPPED_CLOSE_CODE,
  HostedBlenderStreamServerMessage,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { DeviceFrameSink } from "../device/frame.ts";
import { type DeviceHubAccess, withDeviceHubQuery } from "../device/hubAccess.ts";
import { avcCodecString, parseSemuPacket, scanAccessUnit } from "../device/stream.ts";

export type HostedBlenderStreamStatus = "connecting" | "live" | "stopped" | "full" | "unsupported";

export type HostedBlenderStreamStats = Extract<
  HostedBlenderStreamServerMessage,
  { readonly type: "stats" }
>;

export interface HostedBlenderFrameRate {
  readonly framesPerSecond: number;
  readonly bitsPerSecond: number;
}

export interface HostedBlenderStreamEvents {
  readonly onStatus: (status: HostedBlenderStreamStatus) => void;
  readonly onStats: (stats: HostedBlenderStreamStats) => void;
  /** At most once a second, while frames arrive. */
  readonly onFrameRate: (rate: HostedBlenderFrameRate) => void;
  /** The upgrade was refused; refresh access and start a new client. */
  readonly onUnauthorized: () => void;
}

export interface HostedBlenderStreamClient {
  /** The pane's size in device pixels; the display follows the newest viewer. */
  readonly resize: (width: number, height: number) => void;
  readonly stop: () => void;
}

const ACK = JSON.stringify({ type: "ack" });
const decodeServerMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(HostedBlenderStreamServerMessage),
);

const webCodecsAvailable = () => "VideoDecoder" in globalThis && "EncodedVideoChunk" in globalThis;

/**
 * Watches a thread's hosted Blender: SEMU-framed H.264 from `/api/hosted-blender-stream`,
 * decoded with WebCodecs onto `sink`, one acknowledged frame at a time.
 */
export function createHostedBlenderStreamClient(
  target: { readonly access: DeviceHubAccess; readonly threadId: string },
  sink: DeviceFrameSink,
  events: HostedBlenderStreamEvents,
): HostedBlenderStreamClient {
  const url = withDeviceHubQuery(
    `${target.access.wsBase}/ws?${new URLSearchParams({ threadId: target.threadId }).toString()}`,
    target.access,
  );
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let decoder: VideoDecoder | null = null;
  let configuring = false;
  let size: { readonly width: number; readonly height: number } | null = null;
  let live = false;
  let rate = { start: 0, frames: 0, bytes: 0 };

  const closeDecoder = () => {
    try {
      decoder?.close();
    } catch {}
    decoder = null;
    configuring = false;
  };

  const countFrame = (bytes: number) => {
    const now = Date.now();
    if (rate.start === 0) rate = { start: now, frames: 0, bytes: 0 };
    rate.frames += 1;
    rate.bytes += bytes;
    const elapsed = now - rate.start;
    if (elapsed < 1000) return;
    events.onFrameRate({
      framesPerSecond: Math.round((rate.frames * 1000) / elapsed),
      bitsPerSecond: Math.round((rate.bytes * 8 * 1000) / elapsed),
    });
    rate = { start: now, frames: 0, bytes: 0 };
  };

  const decode = (data: Uint8Array, key: boolean, timestamp: number) => {
    if (decoder?.state !== "configured") return;
    try {
      decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data }));
    } catch {
      // A broken decoder resyncs on the keyframe a fresh connection starts with.
      reconnect();
    }
  };

  const configure = async (ws: WebSocket, sps: Uint8Array, data: Uint8Array, pts: number) => {
    configuring = true;
    const config: VideoDecoderConfig = { codec: avcCodecString(sps), optimizeForLatency: true };
    const support = await VideoDecoder.isConfigSupported(config).catch(() => ({
      supported: false,
    }));
    if (socket !== ws) return;
    if (!support.supported) {
      stopped = true;
      events.onStatus("unsupported");
      ws.close();
      return;
    }
    const next = new VideoDecoder({
      output: (frame) => {
        try {
          if (decoder !== next) return;
          sink.present(frame, frame.displayWidth, frame.displayHeight);
          if (!live) {
            live = true;
            events.onStatus("live");
          }
        } finally {
          frame.close();
        }
      },
      error: () => {
        if (decoder === next) reconnect();
      },
    });
    next.configure(config);
    decoder = next;
    configuring = false;
    decode(data, true, pts);
  };

  const onFrame = (ws: WebSocket, raw: ArrayBuffer) => {
    const packet = parseSemuPacket(raw);
    const timestamp = packet.timestamp ?? 0;
    countFrame(raw.byteLength);
    if (decoder?.state === "configured")
      return decode(packet.data, packet.isKey ?? false, timestamp);
    if (configuring || packet.isKey === false) return;
    const scanned = scanAccessUnit(packet.data);
    if (!scanned.isKey || scanned.sps === null) return;
    void configure(ws, scanned.sps, packet.data, timestamp);
  };

  const sendSize = () => {
    if (size === null || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "resize", ...size }));
  };

  const connect = () => {
    if (stopped) return;
    if (!webCodecsAvailable()) {
      stopped = true;
      events.onStatus("unsupported");
      return;
    }
    live = false;
    events.onStatus("connecting");
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      sendSize();
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        failures = 0;
        ws.send(ACK);
        onFrame(ws, event.data);
        return;
      }
      if (typeof event.data !== "string") return;
      const message = decodeServerMessage(event.data);
      if (Option.isSome(message) && message.value.type === "stats") events.onStats(message.value);
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      closeDecoder();
      if (stopped) return;
      if (event.code === HOSTED_BLENDER_STREAM_STOPPED_CLOSE_CODE) {
        stopped = true;
        events.onStatus("stopped");
        return;
      }
      if (event.code === HOSTED_BLENDER_STREAM_FULL_CLOSE_CODE) {
        stopped = true;
        events.onStatus("full");
        return;
      }
      // Rejected upgrades surface as 1006 before open for both cookies and tickets.
      if (event.code === 1008 || event.code === 4401 || (!opened && event.code === 1006)) {
        stopped = true;
        events.onUnauthorized();
        return;
      }
      events.onStatus("connecting");
      retryTimer = setTimeout(connect, Math.min(500 * 2 ** failures++, 10_000));
    });
    ws.addEventListener("error", () => ws.close());
  };

  const reconnect = () => {
    const ws = socket;
    socket = null;
    closeDecoder();
    ws?.close();
    connect();
  };

  connect();

  return {
    resize: (width, height) => {
      const next = { width: Math.round(width), height: Math.round(height) };
      if (next.width <= 0 || next.height <= 0) return;
      if (size?.width === next.width && size.height === next.height) return;
      size = next;
      sendSize();
    },
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      const ws = socket;
      socket = null;
      closeDecoder();
      ws?.close();
    },
  };
}
