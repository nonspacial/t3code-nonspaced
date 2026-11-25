// @effect-diagnostics globalTimers:off globalDate:off - This browser and WebView transport runs without an Effect runtime.
import {
  HOSTED_BLENDER_STREAM_FULL_CLOSE_CODE,
  HOSTED_BLENDER_STREAM_STOPPED_CLOSE_CODE,
  HostedBlenderStreamServerMessage,
  type HostedBlenderViewerMessage,
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

export type HostedBlenderControl = Omit<
  Extract<HostedBlenderStreamServerMessage, { readonly type: "control" }>,
  "type"
>;

/** Before the server says otherwise, and after a disconnect. */
export const VIEW_ONLY: HostedBlenderControl = { canOperate: false, controller: "unclaimed" };

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
  /** Who controls Blender. Without a connection, this viewer is view-only. */
  readonly onControl?: (control: HostedBlenderControl) => void;
  /** Blender holds the mouse (a grab or an orbit), so motion should be relative. */
  readonly onCursor?: (captured: boolean) => void;
}

export interface HostedBlenderStreamClient {
  /**
   * The pane's size in device pixels. The display follows the viewer in control, or else the
   * pane shown most recently; a viewer that never sends one leaves it as it is.
   */
  readonly resize: (width: number, height: number) => void;
  /** Whether the pane is on screen. While no pane is, the server stops capturing. */
  readonly setVisible: (visible: boolean) => void;
  /** Dropped while disconnected: control doesn't survive a reconnect. */
  readonly send: (message: HostedBlenderViewerMessage) => void;
  readonly stop: () => void;
}

const ACK = JSON.stringify({ type: "ack" });
// As the device stream's decoder: past this many queued chunks the decoder has fallen behind.
const SOFT_DECODE_QUEUE = 8;
const decodeServerMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(HostedBlenderStreamServerMessage),
);

/** The SPS NAL alone: `scanAccessUnit` returns it with the rest of the access unit after it. */
const spsNal = (sps: Uint8Array) => {
  for (let i = 0; i + 2 < sps.length; i++) {
    if (sps[i] === 0 && sps[i + 1] === 0 && (sps[i + 2] === 1 || sps[i + 2] === 0)) {
      return sps.subarray(0, i);
    }
  }
  return sps;
};
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

// Profiles whose SPS carries chroma format, bit depths and scaling lists (H.264 7.3.2.1.1).
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/**
 * The displayed (cropped) frame size an H.264 SPS NAL unit, header byte first, describes;
 * null when it can't be read.
 */
export function avcFrameSize(
  nal: Uint8Array,
): { readonly width: number; readonly height: number } | null {
  // The RBSP: the payload after the header, without emulation-prevention bytes (00 00 03).
  const rbsp: number[] = [];
  for (let i = 1; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0 && rbsp.length >= 2) {
      const [a, b] = rbsp.slice(-2);
      if (a === 0 && b === 0) continue;
    }
    rbsp.push(nal[i]!);
  }
  let bit = 0;
  const u = (count: number) => {
    let value = 0;
    for (let i = 0; i < count; i++, bit++) {
      const byte = rbsp[bit >> 3];
      if (byte === undefined) throw new RangeError("SPS ended early");
      value = value * 2 + ((byte >> (7 - (bit & 7))) & 1);
    }
    return value;
  };
  const ue = () => {
    let zeros = 0;
    while (u(1) === 0) if (++zeros > 31) throw new RangeError("bad exp-Golomb code");
    return 2 ** zeros - 1 + u(zeros);
  };
  const se = () => {
    const code = ue();
    return code % 2 === 1 ? (code + 1) / 2 : -code / 2;
  };
  try {
    const profile = u(8);
    u(16); // constraint flags and level
    ue(); // seq_parameter_set_id
    let chromaFormat = 1;
    let separateColourPlanes = false;
    if (HIGH_PROFILES.has(profile)) {
      chromaFormat = ue();
      if (chromaFormat === 3) separateColourPlanes = u(1) === 1;
      ue(); // bit depths
      ue();
      u(1); // qpprime_y_zero_transform_bypass_flag
      if (u(1) === 1) {
        for (let list = 0; list < (chromaFormat === 3 ? 12 : 8); list++) {
          if (u(1) === 0) continue;
          let last = 8;
          let next = 8;
          for (let j = 0; j < (list < 6 ? 16 : 64) && next !== 0; j++) {
            next = (last + se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
    ue(); // log2_max_frame_num_minus4
    const pocType = ue();
    if (pocType === 0) ue();
    else if (pocType === 1) {
      u(1);
      se();
      se();
      const cycle = ue();
      for (let i = 0; i < cycle; i++) se();
    }
    ue(); // max_num_ref_frames
    u(1); // gaps_in_frame_num_value_allowed_flag
    const widthInMbs = ue() + 1;
    const heightInMapUnits = ue() + 1;
    const frameMbsOnly = u(1);
    if (frameMbsOnly === 0) u(1);
    u(1); // direct_8x8_inference_flag
    let [left, right, top, bottom] = [0, 0, 0, 0];
    if (u(1) === 1) [left, right, top, bottom] = [ue(), ue(), ue(), ue()];
    const chromaArrayType = separateColourPlanes ? 0 : chromaFormat;
    const cropX = chromaArrayType === 0 || chromaArrayType === 3 ? 1 : 2;
    const cropY = (chromaArrayType === 1 ? 2 : 1) * (2 - frameMbsOnly);
    const width = widthInMbs * 16 - cropX * (left + right);
    const height = (2 - frameMbsOnly) * heightInMapUnits * 16 - cropY * (top + bottom);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

const webCodecsAvailable = () => "VideoDecoder" in globalThis && "EncodedVideoChunk" in globalThis;

/**
 * Watches a thread's hosted Blender: SEMU-framed H.264 from `/api/hosted-blender-stream`,
 * decoded with WebCodecs onto `sink`, acking each frame once the decoder can take more.
 */
export function createHostedBlenderStreamClient(
  target: {
    readonly access: DeviceHubAccess;
    readonly threadId: string;
    /** The thread's master Blender instead of its working Blender. */
    readonly master?: boolean;
  },
  sink: DeviceFrameSink,
  events: HostedBlenderStreamEvents,
): HostedBlenderStreamClient {
  // Each connection says whether its pane is on screen, so a hidden one never starts capture.
  const urlFor = (visible: boolean) => {
    const query = new URLSearchParams({
      threadId: target.threadId,
      ...(target.master === true ? { role: "master" } : {}),
      ...(visible ? {} : { hidden: "1" }),
    });
    return withDeviceHubQuery(`${target.access.wsBase}/ws?${query.toString()}`, target.access);
  };
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let decoder: VideoDecoder | null = null;
  // The SPS the decoder was configured with; a keyframe with another one is a new frame size.
  let decoderSps: Uint8Array | null = null;
  let configuring = false;
  let size: { readonly width: number; readonly height: number } | null = null;
  let visible = true;
  let live = false;
  // Whether the server last said this viewer controls Blender, on the current socket.
  let controlling = false;
  // One ack per frame received, held while the decoder is configured or behind: the server keeps
  // only a few frames unacked and sends nothing after a keyframe until it is acked, so holding
  // acks bounds the decode queue, and losing one would cost a slot of its window for good.
  let acksOwed = 0;
  // Frames that arrive while a decoder is configured, decoded after its keyframe.
  let held: Array<{
    readonly data: Uint8Array;
    readonly key: boolean | null;
    readonly timestamp: number;
  }> = [];
  let rate = { start: 0, frames: 0, bytes: 0 };

  const closeDecoder = () => {
    try {
      decoder?.close();
    } catch {}
    decoder = null;
    decoderSps = null;
    configuring = false;
    acksOwed = 0;
    held = [];
  };

  const sendAcks = () => {
    if (acksOwed === 0 || configuring || socket?.readyState !== WebSocket.OPEN) return;
    if ((decoder?.decodeQueueSize ?? 0) > SOFT_DECODE_QUEUE) return;
    for (; acksOwed > 0; acksOwed--) socket.send(ACK);
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
    // Without the size, Android's WebView decoder keeps every frame at its default 1280×720,
    // cropping or padding the real picture into it.
    const size = avcFrameSize(spsNal(sps));
    const config: VideoDecoderConfig = {
      codec: avcCodecString(sps),
      optimizeForLatency: true,
      ...(size ? { codedWidth: size.width, codedHeight: size.height } : {}),
    };
    const support = await VideoDecoder.isConfigSupported(config).catch(() => ({
      supported: false,
    }));
    if (socket !== ws) return;
    if (!support.supported) {
      configuring = false;
      held = [];
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
    next.addEventListener("dequeue", sendAcks);
    next.configure(config);
    decoder = next;
    decoderSps = spsNal(sps).slice();
    configuring = false;
    decode(data, true, pts);
    const after = held;
    held = [];
    for (const frame of after) onDecodable(ws, frame.data, frame.key, frame.timestamp);
    sendAcks();
  };

  const onFrame = (ws: WebSocket, raw: ArrayBuffer) => {
    const packet = parseSemuPacket(raw);
    countFrame(raw.byteLength);
    acksOwed += 1;
    onDecodable(ws, packet.data, packet.isKey, packet.timestamp ?? 0);
    sendAcks();
  };

  const onDecodable = (ws: WebSocket, data: Uint8Array, key: boolean | null, timestamp: number) => {
    if (configuring) {
      held.push({ data, key, timestamp });
      return;
    }
    const scanned = key === false ? null : scanAccessUnit(data);
    if (decoder?.state === "configured") {
      const resized =
        scanned?.isKey === true &&
        scanned.sps !== null &&
        decoderSps !== null &&
        !sameBytes(spsNal(scanned.sps), decoderSps);
      if (!resized) return decode(data, key ?? false, timestamp);
      // The display resized. Some decoders (Android's WebView) keep the first frame size across
      // an in-band SPS change, so the new size starts a decoder of its own.
      try {
        decoder.close();
      } catch {}
      decoder = null;
      decoderSps = null;
    }
    // Without a decoder only a keyframe with its SPS can start one.
    if (!scanned?.isKey || scanned.sps === null) return;
    void configure(ws, scanned.sps, data, timestamp);
  };

  const sendSize = () => {
    if (size === null || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "resize", ...size }));
  };

  const sendVisibility = () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "visibility", visible }));
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
    const askedVisible = visible;
    const ws = new WebSocket(urlFor(askedVisible));
    ws.binaryType = "arraybuffer";
    socket = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      if (visible !== askedVisible) sendVisibility();
      sendSize();
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        failures = 0;
        onFrame(ws, event.data);
        return;
      }
      if (typeof event.data !== "string") return;
      const message = decodeServerMessage(event.data);
      if (Option.isNone(message)) return;
      switch (message.value.type) {
        case "stats":
          return events.onStats(message.value);
        case "control": {
          const granted = !controlling && message.value.controller === "you";
          controlling = message.value.controller === "you";
          // The display follows the viewer in control; repeat the size in case it never landed.
          if (granted) sendSize();
          return events.onControl?.({
            canOperate: message.value.canOperate,
            controller: message.value.controller,
          });
        }
        case "cursor":
          return events.onCursor?.(message.value.captured);
        case "viewport":
          return;
      }
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      closeDecoder();
      controlling = false;
      events.onControl?.(VIEW_ONLY);
      events.onCursor?.(false);
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
    controlling = false;
    events.onControl?.(VIEW_ONLY);
    events.onCursor?.(false);
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
    setVisible: (next) => {
      if (next === visible) return;
      visible = next;
      sendVisibility();
    },
    send: (message) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
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
