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
  private synced = false;
  private pending: VideoFrame[] = [];

  offer(frame: VideoFrame): {
    readonly send: VideoFrame | null;
    readonly requestKeyframe: boolean;
  } {
    if (frame.key) {
      this.synced = true;
      this.pending = [];
    } else if (!this.synced) {
      return { send: null, requestKeyframe: true };
    }
    if (!this.inFlight) {
      this.inFlight = true;
      return { send: frame, requestKeyframe: false };
    }
    if (this.pending.length >= MAX_PENDING_FRAMES) {
      this.synced = false;
      this.pending = [];
      return { send: null, requestKeyframe: true };
    }
    this.pending.push(frame);
    return { send: null, requestKeyframe: false };
  }

  /** The frame on the wire arrived; returns the next one to send. */
  ack(): VideoFrame | null {
    const next = this.pending.shift() ?? null;
    this.inFlight = next !== null;
    return next;
  }
}
