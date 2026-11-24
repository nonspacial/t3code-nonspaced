export interface VideoFrame {
  readonly key: boolean;
  readonly data: Uint8Array;
}

/** Deltas a slow viewer may have waiting before it skips to the next keyframe. */
export const MAX_PENDING_FRAMES = 8;

/**
 * One viewer's frames: at most one on the wire until the viewer acks it. H.264 deltas can't
 * be skipped, so later frames queue; a keyframe replaces the queue, and a viewer that falls
 * too far behind drops everything until the next keyframe.
 */
export class ViewerFlow {
  private inFlight = false;
  private sentAt = 0;
  private synced = false;
  private pending: VideoFrame[] = [];

  /**
   * `requestKeyframe`: this viewer is waiting for one. A viewer whose frame is still out asks only
   * once it acks that frame, so a stalled viewer can't keep forcing keyframes on everyone.
   */
  offer(
    frame: VideoFrame,
    now: number,
  ): { readonly send: VideoFrame | null; readonly requestKeyframe: boolean } {
    if (frame.key) {
      this.synced = true;
      this.pending = [];
    } else if (!this.synced) {
      return { send: null, requestKeyframe: !this.inFlight };
    }
    if (!this.inFlight) {
      this.inFlight = true;
      this.sentAt = now;
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

  /**
   * Drops what's queued and waits for the next keyframe. A frame still on the wire stays there,
   * so its late ack can't let a second one out.
   */
  resync(): void {
    this.synced = false;
    this.pending = [];
  }

  /**
   * The frame on the wire arrived. Returns the next one to send, how long the acked frame took
   * from going out to its ack, and whether this viewer now waits for a keyframe.
   */
  ack(now: number): {
    readonly next: VideoFrame | null;
    readonly latencyMs: number | null;
    readonly requestKeyframe: boolean;
  } {
    const latencyMs = this.inFlight ? now - this.sentAt : null;
    const next = this.pending.shift() ?? null;
    this.inFlight = next !== null;
    this.sentAt = now;
    return { next, latencyMs, requestKeyframe: !this.synced && latencyMs !== null };
  }
}
