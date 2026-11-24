export const BITRATE = {
  /** The helper's own starting bitrate. */
  initialKbps: 8000,
  minKbps: 1000,
  maxKbps: 16_000,
  /** Acks this much slower than the link's quickest are frames queueing on it. */
  queueingMs: 80,
  /** Acks within this much of the quickest leave room to rise. */
  headroomMs: 25,
  increaseIntervalMs: 2000,
  /** Each rise adds this share of the rate, and at least `minIncreaseKbps`. */
  increaseFactor: 1.1,
  minIncreaseKbps: 250,
  /** Each fall keeps this share of the rate. */
  decreaseFactor: 0.7,
  decreaseHoldMs: 500,
} as const;

/** How long the quickest ack stands for the link's round trip. */
const BASELINE_WINDOW_MS = 10_000;
const MIN_SAMPLES = 4;
const SLOW_ACKS = 3;

/**
 * The stream's bitrate, from how quickly the lead viewer acknowledges frames. Each ack's delay
 * is judged against the quickest of the last few seconds, so a far viewer's round trip isn't
 * read as congestion: it backs off sharply when frames queue on the link, and rises a step at a
 * time when they don't.
 */
export class BitrateControl {
  kbps: number = BITRATE.initialKbps;
  private samples: Array<{ readonly at: number; readonly latencyMs: number }> = [];
  private slow = 0;
  private lastChange: number | null = null;
  private lastDecrease = Number.NEGATIVE_INFINITY;

  /** A frame the lead viewer acknowledged `latencyMs` after it went out. Returns a new rate. */
  ack(latencyMs: number, now: number): number | null {
    this.samples.push({ at: now, latencyMs });
    while (this.samples[0]!.at < now - BASELINE_WINDOW_MS) this.samples.shift();
    this.lastChange ??= now;
    if (this.samples.length < MIN_SAMPLES) return null;
    let quickest = latencyMs;
    for (const sample of this.samples) quickest = Math.min(quickest, sample.latencyMs);
    const queueing = latencyMs - quickest;
    this.slow = queueing > BITRATE.queueingMs ? this.slow + 1 : 0;
    if (this.slow >= SLOW_ACKS) return this.decrease(now);
    if (queueing > BITRATE.headroomMs || now - this.lastChange < BITRATE.increaseIntervalMs) {
      return null;
    }
    return this.set(
      Math.max(this.kbps + BITRATE.minIncreaseKbps, Math.round(this.kbps * BITRATE.increaseFactor)),
      now,
    );
  }

  /** Another viewer leads; its link starts unmeasured. */
  reset(): void {
    this.samples = [];
    this.slow = 0;
  }

  private decrease(now: number): number | null {
    if (now - this.lastDecrease < BITRATE.decreaseHoldMs) return null;
    this.lastDecrease = now;
    this.slow = 0;
    return this.set(Math.round(this.kbps * BITRATE.decreaseFactor), now);
  }

  private set(kbps: number, now: number): number | null {
    const next = Math.min(BITRATE.maxKbps, Math.max(BITRATE.minKbps, kbps));
    this.lastChange = now;
    if (next === this.kbps) return null;
    this.kbps = next;
    return next;
  }
}
