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

  /** `fellBehind`: this viewer's queue overflowed, so it now waits for a keyframe. */
  offer(
    frame: VideoFrame,
    now: number,
  ): {
    readonly send: VideoFrame | null;
    readonly requestKeyframe: boolean;
    readonly fellBehind: boolean;
  } {
    if (frame.key) {
      this.synced = true;
      this.pending = [];
    } else if (!this.synced) {
      return { send: null, requestKeyframe: true, fellBehind: false };
    }
    if (!this.inFlight) {
      this.inFlight = true;
      this.sentAt = now;
      return { send: frame, requestKeyframe: false, fellBehind: false };
    }
    if (this.pending.length >= MAX_PENDING_FRAMES) {
      this.synced = false;
      this.pending = [];
      return { send: null, requestKeyframe: true, fellBehind: true };
    }
    this.pending.push(frame);
    return { send: null, requestKeyframe: false, fellBehind: false };
  }

  /**
   * The frame on the wire arrived. Returns the next one to send, and how long the acked frame
   * took from going out to its ack.
   */
  ack(now: number): { readonly next: VideoFrame | null; readonly latencyMs: number | null } {
    const latencyMs = this.inFlight ? now - this.sentAt : null;
    const next = this.pending.shift() ?? null;
    this.inFlight = next !== null;
    this.sentAt = now;
    return { next, latencyMs };
  }
}
