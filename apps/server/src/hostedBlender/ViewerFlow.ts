export interface VideoFrame {
  readonly key: boolean;
  readonly data: Uint8Array;
}

/** Deltas a slow viewer may have waiting before it skips to the next keyframe. */
export const MAX_PENDING_FRAMES = 8;

/**
 * Frames on the wire before an ack. A viewer gets at most this many per round trip: Blender is
 * captured at 60 fps, so 8 keeps a 100 ms link (remote, relay) at the full rate with room to catch
 * up after a keyframe, which waits a round trip for its ack; one frame at a time held it to 10 fps.
 */
export const MAX_IN_FLIGHT_FRAMES = 8;

/**
 * One viewer's frames: a few on the wire until acked, in order. Deltas can't be skipped, so later
 * frames queue; a keyframe replaces the queue and nothing follows it until it is acked (the client
 * acks it once its decoder is configured); a viewer too far behind waits for the next keyframe.
 */
export class ViewerFlow {
  /** Each frame on the wire, oldest first; acks arrive in that order. */
  private inFlight: Array<{ readonly sentAt: number; readonly key: boolean }> = [];
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
    if (this.canSend() && this.pending.length === 0) {
      this.inFlight.push({ sentAt: now, key: frame.key });
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
   * The oldest frame on the wire arrived. Returns the frames to send now, how long the acked
   * frame took from going out to its ack, and whether this viewer now waits for a keyframe.
   */
  ack(now: number): {
    readonly send: ReadonlyArray<VideoFrame>;
    readonly latencyMs: number | null;
    readonly requestKeyframe: boolean;
  } {
    const acked = this.inFlight.shift();
    const latencyMs = acked === undefined ? null : now - acked.sentAt;
    const send: VideoFrame[] = [];
    while (this.canSend() && this.pending.length > 0) {
      const next = this.pending.shift()!;
      this.inFlight.push({ sentAt: now, key: next.key });
      send.push(next);
    }
    return { send, latencyMs, requestKeyframe: !this.synced && latencyMs !== null };
  }

  private canSend(): boolean {
    return this.inFlight.length < MAX_IN_FLIGHT_FRAMES && !this.inFlight.some((sent) => sent.key);
  }
}
