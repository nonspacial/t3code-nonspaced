export interface VideoFrame {
  readonly key: boolean;
  readonly data: Uint8Array;
}

/** Deltas a slow viewer may have waiting before it skips to the next keyframe. */
export const MAX_PENDING_FRAMES = 8;

/**
 * Frames on the wire before an ack. A viewer gets at most this many per round trip: Blender is
 * captured at 60 fps, so 6 keeps a 100 ms link (remote, relay) at the full rate; one frame at a
 * time held it to 10 fps.
 */
export const MAX_IN_FLIGHT_FRAMES = 6;

/**
 * One viewer's frames: a few on the wire until the viewer acks them, in order. H.264 deltas
 * can't be skipped, so later frames queue; a keyframe replaces the queue, and a viewer that falls
 * too far behind drops everything until the next keyframe.
 */
export class ViewerFlow {
  /** When each frame on the wire went out, oldest first; acks arrive in that order. */
  private inFlight: number[] = [];
  private synced = false;
  private pending: VideoFrame[] = [];

  /**
   * `requestKeyframe`: this viewer is waiting for one. A viewer with frames still out asks only
   * once it acks one, so a stalled viewer can't keep forcing keyframes on everyone.
   */
  offer(
    frame: VideoFrame,
    now: number,
  ): { readonly send: VideoFrame | null; readonly requestKeyframe: boolean } {
    if (frame.key) {
      this.synced = true;
      this.pending = [];
    } else if (!this.synced) {
      return { send: null, requestKeyframe: this.inFlight.length === 0 };
    }
    if (this.inFlight.length < MAX_IN_FLIGHT_FRAMES && this.pending.length === 0) {
      this.inFlight.push(now);
      return { send: frame, requestKeyframe: false };
    }
    if (this.pending.length >= MAX_PENDING_FRAMES) {
      this.synced = false;
      this.pending = [];
      return { send: null, requestKeyframe: false };
    }
    this.pending.push(frame);
    return { send: null, requestKeyframe: false };
  }

  /** Drops what's queued and waits for the next keyframe. Frames on the wire stay there. */
  resync(): void {
    this.synced = false;
    this.pending = [];
  }

  /**
   * The oldest frame on the wire arrived. Returns the next one to send, how long the acked frame
   * took from going out to its ack, and whether this viewer now waits for a keyframe.
   */
  ack(now: number): {
    readonly next: VideoFrame | null;
    readonly latencyMs: number | null;
    readonly requestKeyframe: boolean;
  } {
    const sentAt = this.inFlight.shift();
    const latencyMs = sentAt === undefined ? null : now - sentAt;
    const next =
      this.inFlight.length < MAX_IN_FLIGHT_FRAMES ? (this.pending.shift() ?? null) : null;
    if (next !== null) this.inFlight.push(now);
    return { next, latencyMs, requestKeyframe: !this.synced && latencyMs !== null };
  }
}
