import { describe, expect, it } from "@effect/vitest";
import type { HostedBlenderInputMessage } from "@t3tools/contracts";

import {
  encodeHelperCommand,
  HelperPacketReader,
  helperCommandForInput,
} from "./HelperProtocol.ts";

// Mirrors `write_packet`, `write_event` and `write_video` in native/hidden-display/src/control.rs.
const packet = (kind: number, payload: Uint8Array) => {
  const bytes = new Uint8Array(5 + payload.length);
  new DataView(bytes.buffer).setUint32(0, payload.length + 1, false);
  bytes[4] = kind;
  bytes.set(payload, 5);
  return bytes;
};
const event = (value: unknown) => packet(1, new TextEncoder().encode(JSON.stringify(value)));
const video = (key: boolean, accessUnit: number[]) => {
  const semu = new Uint8Array(16 + accessUnit.length);
  const view = new DataView(semu.buffer);
  view.setUint32(0, 0x53454d55, false);
  semu[4] = 1;
  semu[5] = key ? 1 : 0;
  view.setBigUint64(8, 33_000n, false);
  semu.set(accessUnit, 16);
  return { packet: packet(2, semu), semu };
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

describe("HelperPacketReader", () => {
  it("splits events and SEMU video packets, however stdout chunks them", () => {
    const key = video(true, [0, 0, 0, 1, 0x65, 0xaa]);
    const delta = video(false, [0, 0, 0, 1, 0x41]);
    const stream = concat(
      event({
        type: "ready",
        capture: "extImageCopyCapture",
        target: "window",
        encoder: "nvh264enc",
        width: 1280,
        height: 720,
        cursorTracking: true,
      }),
      key.packet,
      event({ type: "cursorLeave" }),
      delta.packet,
      event({ type: "cursorEnter", x: 640, y: 360 }),
      event({ type: "exited", process: "blender", code: 0, signal: null }),
    );

    for (const chunkSize of [1, 7, stream.length]) {
      const reader = new HelperPacketReader();
      const packets = [];
      for (let offset = 0; offset < stream.length; offset += chunkSize) {
        packets.push(...reader.push(stream.subarray(offset, offset + chunkSize)));
      }
      expect(packets).toEqual([
        {
          _tag: "event",
          event: {
            type: "ready",
            encoder: "nvh264enc",
            target: "window",
            width: 1280,
            height: 720,
          },
        },
        { _tag: "video", key: true, data: key.semu },
        { _tag: "event", event: { type: "cursorLeave" } },
        { _tag: "video", key: false, data: delta.semu },
        { _tag: "event", event: { type: "cursorEnter" } },
        { _tag: "event", event: { type: "exited", process: "blender", code: 0, signal: null } },
      ]);
    }
  });

  it("rejects a corrupt length instead of buffering forever", () => {
    const reader = new HelperPacketReader();
    expect(() => reader.push(new Uint8Array([0xff, 0xff, 0xff, 0xff, 1]))).toThrow(
      "malformed packet",
    );
  });
});

it("encodes commands as the JSON lines the helper reads", () => {
  expect(encodeHelperCommand({ type: "resize", width: 1600, height: 900 })).toBe(
    '{"type":"resize","width":1600,"height":900}\n',
  );
});

it("turns viewer input into the helper's pointer, key and keymap commands", () => {
  const inputs: HostedBlenderInputMessage[] = [
    { type: "pointer", x: 10, y: 20.5 },
    { type: "pointerMotion", dx: -3.5, dy: 2 },
    { type: "button", button: 274, pressed: true },
    { type: "scroll", axis: "vertical", source: "wheel", value: 15, steps: 1 },
    { type: "scroll", axis: "horizontal", source: "finger", value: -4.25 },
    { type: "key", code: 30, pressed: false },
    { type: "keymap", layout: "us", variant: "dvorak" },
  ];
  expect(inputs.map(helperCommandForInput)).toEqual([
    { type: "pointerPosition", x: 10, y: 20.5 },
    { type: "pointerMotion", dx: -3.5, dy: 2 },
    { type: "pointerButton", button: 274, pressed: true },
    { type: "pointerAxis", axis: "vertical", source: "wheel", value: 15, discrete: 1 },
    { type: "pointerAxis", axis: "horizontal", source: "finger", value: -4.25 },
    { type: "key", code: 30, pressed: false },
    { type: "keymap", layout: "us", variant: "dvorak" },
  ]);
});
