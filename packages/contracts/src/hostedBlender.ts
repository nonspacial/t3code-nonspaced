import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HOSTED_BLENDER_STREAM_PATH = "/api/hosted-blender-stream";
/** The thread has no hosted Blender running, or it stopped while being watched. */
export const HOSTED_BLENDER_STREAM_STOPPED_CLOSE_CODE = 4404;
/** Too many viewers are already watching this hosted Blender. */
export const HOSTED_BLENDER_STREAM_FULL_CLOSE_CODE = 4429;

/** What the server lacks to host Blender. */
export const HostedBlenderRequirement = Schema.Literals(["helper", "blender", "labwc"]);
export type HostedBlenderRequirement = typeof HostedBlenderRequirement.Type;

export const HostedBlenderRunningState = Schema.Struct({
  status: Schema.Literals(["starting", "running"]),
  /** Relative to the thread's workspace. */
  relativePath: TrimmedNonEmptyString,
  /** The file has changes Blender hasn't saved. */
  dirty: Schema.Boolean,
});
export type HostedBlenderRunningState = typeof HostedBlenderRunningState.Type;

/**
 * A thread's hosted Blender. `unavailable` is a host that can never run one (not Linux);
 * `notSetUp` is a Linux host missing `missing`.
 */
export const HostedBlenderThreadState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unavailable") }),
  Schema.Struct({
    status: Schema.Literal("notSetUp"),
    missing: Schema.Array(HostedBlenderRequirement),
  }),
  Schema.Struct({ status: Schema.Literal("stopped") }),
  /** The last start never showed Blender's viewport window. Opening a file again retries. */
  Schema.Struct({ status: Schema.Literal("failed") }),
  /**
   * Quit by T3 when its thread settled or was archived, or T3 shut down. `recovery` is a copy of
   * the session, unsaved changes included, that Reopen can restore.
   */
  Schema.Struct({
    status: Schema.Literal("closed"),
    relativePath: TrimmedNonEmptyString,
    recovery: Schema.Boolean,
  }),
  /** Blender stopped on its own. `recovery` is its newest autosave, which Restart can restore. */
  Schema.Struct({
    status: Schema.Literal("crashed"),
    relativePath: TrimmedNonEmptyString,
    recovery: Schema.Boolean,
  }),
  HostedBlenderRunningState,
]);
export type HostedBlenderThreadState = typeof HostedBlenderThreadState.Type;

export const HostedBlenderSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type HostedBlenderSubscribeInput = typeof HostedBlenderSubscribeInput.Type;

export const HostedBlenderOpenInput = Schema.Struct({
  threadId: ThreadId,
  /** A `.blend` relative to the thread's workspace or worktree. */
  relativePath: TrimmedNonEmptyString,
});
export type HostedBlenderOpenInput = typeof HostedBlenderOpenInput.Type;

export const HostedBlenderQuitInput = Schema.Struct({
  threadId: ThreadId,
  /** Save the file before quitting. */
  save: Schema.Boolean,
});
export type HostedBlenderQuitInput = typeof HostedBlenderQuitInput.Type;

export const HostedBlenderDismissInput = Schema.Struct({ threadId: ThreadId });
export type HostedBlenderDismissInput = typeof HostedBlenderDismissInput.Type;

export const HostedBlenderReopenInput = Schema.Struct({
  threadId: ThreadId,
  /** Restore the recovery copy or autosave instead of the file as saved. */
  restore: Schema.Boolean,
});
export type HostedBlenderReopenInput = typeof HostedBlenderReopenInput.Type;

/** One hosted Blender on this server, for the Running Blenders list. */
export const HostedBlenderRunningBlender = Schema.Struct({
  threadId: ThreadId,
  status: Schema.Literals(["starting", "running"]),
  relativePath: TrimmedNonEmptyString,
  dirty: Schema.Boolean,
  memoryBytes: Schema.NullOr(Schema.Number),
});
export type HostedBlenderRunningBlender = typeof HostedBlenderRunningBlender.Type;

export const HostedBlenderRunningList = Schema.Array(HostedBlenderRunningBlender);
export type HostedBlenderRunningList = typeof HostedBlenderRunningList.Type;

export class HostedBlenderError extends Schema.TaggedError<HostedBlenderError>()(
  "HostedBlenderError",
  {
    reason: Schema.Literals([
      "unavailable",
      "notSetUp",
      "threadNotFound",
      "notInWorkspace",
      "notBlendFile",
      "fileNotFound",
      "otherFileOpen",
      "openInAnotherThread",
      "saveFailed",
      "nothingToReopen",
      "recoveryPending",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "Hosted Blender is not available on this host.";
      case "notSetUp":
        return "Hosted Blender is not set up on this host.";
      case "threadNotFound":
        return "The thread was not found.";
      case "notInWorkspace":
        return "Only files in the thread's workspace can be opened in a hosted Blender.";
      case "notBlendFile":
        return "Only .blend files can be opened in a hosted Blender.";
      case "fileNotFound":
        return "The file was not found.";
      case "otherFileOpen":
        return "This thread's hosted Blender already has another file open. Quit it first.";
      case "openInAnotherThread":
        return "This file is already open in another thread's hosted Blender.";
      case "saveFailed":
        return "Blender could not save the file.";
      case "nothingToReopen":
        return "This thread has no closed hosted Blender to reopen.";
      case "recoveryPending":
        return "This thread's hosted Blender kept unsaved changes. Reopen or discard them first.";
    }
  }
}

/** Server → viewer text messages on the stream route. Frames are binary SEMU packets. */
export const HostedBlenderStreamServerMessage = Schema.Union([
  /** The size of the frames that follow, in stream pixels. */
  Schema.Struct({
    type: Schema.Literal("viewport"),
    width: Schema.Int,
    height: Schema.Int,
  }),
  /** View-only for now: nobody can take control yet. */
  Schema.Struct({
    type: Schema.Literal("control"),
    canOperate: Schema.Boolean,
    controller: Schema.Literal("unclaimed"),
  }),
  Schema.Struct({
    type: Schema.Literal("stats"),
    encoder: Schema.String,
    /** `output` when the compositor can't capture the viewport window alone. */
    target: Schema.Literals(["window", "output"]),
    memoryBytes: Schema.NullOr(Schema.Number),
  }),
]);
export type HostedBlenderStreamServerMessage = typeof HostedBlenderStreamServerMessage.Type;

/** Viewer → server messages on the stream route. */
export const HostedBlenderStreamClientMessage = Schema.Union([
  /** The last frame arrived; the next one may be sent. */
  Schema.Struct({ type: Schema.Literal("ack") }),
  /** The pane's size in device pixels; the display follows the newest viewer. */
  Schema.Struct({
    type: Schema.Literal("resize"),
    width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7680 })),
    height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4320 })),
  }),
]);
export type HostedBlenderStreamClientMessage = typeof HostedBlenderStreamClientMessage.Type;
