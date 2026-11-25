import type { HostedBlenderInputMessage } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The hidden display helper's control channel; see native/hidden-display/src/control.rs.
// Every stdout packet is `u32 BE length | u8 kind | payload`.
const PACKET_EVENT = 1;
const PACKET_VIDEO = 2;
const SEMU_HEADER_BYTES = 16;
const SEMU_MAGIC = 0x53454d55;
const SEMU_FLAG_KEY = 1;
const MAX_PACKET_BYTES = 64 * 1024 * 1024;

const HelperEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ready"),
    encoder: Schema.String,
    target: Schema.Literals(["window", "output"]),
    width: Schema.Number,
    height: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal("frameSize"), width: Schema.Number, height: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("windowCaptured"), title: Schema.String }),
  Schema.Struct({ type: Schema.Literal("windowClosed") }),
  /** The hidden display's output changed size. */
  Schema.Struct({ type: Schema.Literal("resized"), width: Schema.Number, height: Schema.Number }),
  /** Blender captured the mouse; its cursor left the display. */
  Schema.Struct({ type: Schema.Literal("cursorLeave") }),
  Schema.Struct({ type: Schema.Literal("cursorEnter") }),
  Schema.Struct({
    type: Schema.Literal("exited"),
    process: Schema.Literals(["labwc", "blender"]),
    code: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
export type HelperEvent = typeof HelperEvent.Type;
const decodeHelperEvent = Schema.decodeUnknownOption(Schema.fromJsonString(HelperEvent));

export type HelperPacket =
  | { readonly _tag: "event"; readonly event: HelperEvent }
  /** `data` is the whole SEMU packet, sent to viewers as it is. */
  | { readonly _tag: "video"; readonly key: boolean; readonly data: Uint8Array };

export class HelperPacketError extends Schema.TaggedError<HelperPacketError>()(
  "HelperPacketError",
  { length: Schema.Number },
) {
  override get message(): string {
    return "The hidden display helper sent a malformed packet.";
  }
}

export const isHelperPacketError = Schema.is(HelperPacketError);

const textDecoder = new TextDecoder();

/** Splits the helper's stdout into packets. Events the server doesn't use are skipped. */
export class HelperPacketReader {
  private buffer = new Uint8Array(256 * 1024);
  private length = 0;

  push(chunk: Uint8Array): HelperPacket[] {
    if (this.length + chunk.length > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < this.length + chunk.length) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(chunk, this.length);
    this.length += chunk.length;

    const packets: HelperPacket[] = [];
    let offset = 0;
    while (this.length - offset >= 4) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 4);
      const size = view.getUint32(0, false);
      if (size === 0 || size > MAX_PACKET_BYTES) throw new HelperPacketError({ length: size });
      if (this.length - offset - 4 < size) break;
      const kind = this.buffer[offset + 4];
      const payload = this.buffer.slice(offset + 5, offset + 4 + size);
      offset += 4 + size;
      if (kind === PACKET_EVENT) {
        const event = decodeHelperEvent(textDecoder.decode(payload));
        if (Option.isSome(event)) packets.push({ _tag: "event", event: event.value });
      } else if (kind === PACKET_VIDEO && payload.length > SEMU_HEADER_BYTES) {
        const header = new DataView(payload.buffer, payload.byteOffset, SEMU_HEADER_BYTES);
        if (header.getUint32(0, false) !== SEMU_MAGIC) continue;
        packets.push({
          _tag: "video",
          key: (header.getUint8(5) & SEMU_FLAG_KEY) !== 0,
          data: payload,
        });
      }
    }
    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.length);
      this.length -= offset;
    }
    return packets;
  }
}

export type HelperCommand =
  | { readonly type: "keyframe" }
  | { readonly type: "bitrate"; readonly kbps: number }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "pointerPosition"; readonly x: number; readonly y: number }
  | { readonly type: "pointerMotion"; readonly dx: number; readonly dy: number }
  | { readonly type: "pointerButton"; readonly button: number; readonly pressed: boolean }
  | {
      readonly type: "pointerAxis";
      readonly axis: "vertical" | "horizontal";
      readonly source: "wheel" | "finger";
      readonly value: number;
      readonly discrete?: number;
    }
  | { readonly type: "key"; readonly code: number; readonly pressed: boolean }
  | { readonly type: "keymap"; readonly layout: string; readonly variant: string }
  | { readonly type: "quit" }
  /** T3 is stopping while Blender writes its quit copy: the helper lets Blender finish. */
  | { readonly type: "detach" };

export const helperCommandForInput = (input: HostedBlenderInputMessage): HelperCommand => {
  switch (input.type) {
    case "pointer":
      return { type: "pointerPosition", x: input.x, y: input.y };
    case "pointerMotion":
      return { type: "pointerMotion", dx: input.dx, dy: input.dy };
    case "button":
      return { type: "pointerButton", button: input.button, pressed: input.pressed };
    case "scroll": {
      const { axis, source, value } = input;
      return input.steps === undefined
        ? { type: "pointerAxis", axis, source, value }
        : { type: "pointerAxis", axis, source, value, discrete: input.steps };
    }
    case "key":
      return { type: "key", code: input.code, pressed: input.pressed };
    case "keymap":
      return { type: "keymap", layout: input.layout, variant: input.variant };
  }
};

export const encodeHelperCommand = (command: HelperCommand): string =>
  `${JSON.stringify(command)}\n`;
