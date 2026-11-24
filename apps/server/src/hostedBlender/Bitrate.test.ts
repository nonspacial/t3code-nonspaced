import { describe, expect, it } from "@effect/vitest";

import { BITRATE, BitrateControl } from "./Bitrate.ts";

/** Acks `count` frames, `everyMs` apart, each `latencyMs` after it went out. */
const ackAll = (
  control: BitrateControl,
  from: number,
  count: number,
  latencyMs: number,
  everyMs = 33,
) => {
  const changes: number[] = [];
  for (let index = 0; index < count; index++) {
    const kbps = control.ack(latencyMs, from + index * everyMs);
    if (kbps !== null) changes.push(kbps);
  }
  return changes;
};

describe("BitrateControl", () => {
  it("starts at the helper's own bitrate and holds it until it has measured the link", () => {
    const control = new BitrateControl();
    expect(control.kbps).toBe(BITRATE.initialKbps);
    expect(ackAll(control, 0, 3, 400)).toEqual([]);
  });

  it("backs off when acks queue up behind the link, never below the floor", () => {
    const control = new BitrateControl();
    expect(ackAll(control, 0, 10, 20)).toEqual([]);
    const lowered = ackAll(control, 1000, 200, 300);
    expect(lowered[0]).toBeLessThan(BITRATE.initialKbps);
    expect(lowered.every((kbps, index) => index === 0 || kbps < lowered[index - 1]!)).toBe(true);
    expect(control.kbps).toBe(BITRATE.minKbps);
  });

  it("rises slowly again on a quick link, never above the cap", () => {
    const control = new BitrateControl();
    ackAll(control, 0, 10, 20);
    ackAll(control, 1000, 30, 300);
    const low = control.kbps;
    // A minute of quick acks: rises step by step, at most every couple of seconds.
    const raised = ackAll(control, 10_000, 1800, 20);
    expect(raised[0]).toBeGreaterThan(low);
    expect(raised.length).toBeLessThanOrEqual(60_000 / BITRATE.increaseIntervalMs + 1);
    expect(control.kbps).toBe(BITRATE.maxKbps);
  });

  it("judges delay against the link's own round trip, so a far viewer isn't starved", () => {
    const control = new BitrateControl();
    // A steady 180 ms relay round trip is the link, not congestion.
    ackAll(control, 0, 10, 180);
    expect(ackAll(control, 1000, 300, 190)[0]).toBeGreaterThan(BITRATE.initialKbps);
  });

  it("holds its rate over a steady link, however far, when frames come faster than acks", () => {
    const control = new BitrateControl();
    // 60 fps from Blender, but one frame in flight on a steady 44 ms link: an ack every 44 ms.
    expect(ackAll(control, 0, 300, 44, 44).every((kbps) => kbps >= BITRATE.initialKbps)).toBe(true);
    expect(control.kbps).toBeGreaterThanOrEqual(BITRATE.initialKbps);
  });

  it("measures a new lead viewer's link afresh", () => {
    const control = new BitrateControl();
    ackAll(control, 0, 10, 300);
    control.reset();
    // A quick baseline from the new viewer; its acks no longer look like queueing.
    expect(ackAll(control, 1000, 10, 20).every((kbps) => kbps >= BITRATE.initialKbps)).toBe(true);
  });
});
