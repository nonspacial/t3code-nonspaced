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
    }
  }
}

export const HostedBlenderController = Schema.Literals(["unclaimed", "you", "another-viewer"]);
export type HostedBlenderController = typeof HostedBlenderController.Type;

/** Linux evdev pointer buttons: left, right, middle, back, forward. */
export const HostedBlenderPointerButton = Schema.Literals([272, 273, 274, 275, 276]);
export type HostedBlenderPointerButton = typeof HostedBlenderPointerButton.Type;

const StreamCoordinate = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 7680 }));
const MotionDelta = Schema.Number.check(Schema.isBetween({ minimum: -10_000, maximum: 10_000 }));
const XkbName = (maxLength: number) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^[a-z0-9_]{0,${maxLength}}$`)));

/** An xkb layout and variant, such as `de` or `us` with `dvorak`. */
export const HostedBlenderKeymap = Schema.Struct({
  layout: XkbName(16).check(Schema.isMinLength(1)),
  variant: XkbName(32),
});
export type HostedBlenderKeymap = typeof HostedBlenderKeymap.Type;

/** Input from the viewer in control; the server drops it from anyone else. */
export const HostedBlenderInputMessage = Schema.Union([
  /** Where the local cursor is, in stream pixels. */
  Schema.Struct({ type: Schema.Literal("pointer"), x: StreamCoordinate, y: StreamCoordinate }),
  /** Relative motion in stream pixels, sent while Blender holds the mouse. */
  Schema.Struct({ type: Schema.Literal("pointerMotion"), dx: MotionDelta, dy: MotionDelta }),
  Schema.Struct({
    type: Schema.Literal("button"),
    button: HostedBlenderPointerButton,
    pressed: Schema.Boolean,
  }),
  /** `wheel` scrolls in notches (`steps`); `finger` is a trackpad's continuous scroll. */
  Schema.Struct({
    type: Schema.Literal("scroll"),
    axis: Schema.Literals(["vertical", "horizontal"]),
    source: Schema.Literals(["wheel", "finger"]),
    value: MotionDelta,
    steps: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 }))),
  }),
  /** A physical key as a Linux evdev code. */
  Schema.Struct({
    type: Schema.Literal("key"),
    code: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 767 })),
    pressed: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("keymap"), ...HostedBlenderKeymap.fields }),
]);
export type HostedBlenderInputMessage = typeof HostedBlenderInputMessage.Type;

/** Server → viewer text messages on the stream route. Frames are binary SEMU packets. */
export const HostedBlenderStreamServerMessage = Schema.Union([
  /** The size of the frames that follow, in stream pixels. */
  Schema.Struct({
    type: Schema.Literal("viewport"),
    width: Schema.Int,
    height: Schema.Int,
  }),
  /**
   * Who controls the viewport window's mouse and keyboard. `canOperate` is whether this viewer
   * may take control at all. A viewer that goes from `you` to `another-viewer` was taken over.
   */
  Schema.Struct({
    type: Schema.Literal("control"),
    canOperate: Schema.Boolean,
    controller: HostedBlenderController,
  }),
  /** Blender captured the mouse (a grab or an orbit) and hid its cursor, or let it go. */
  Schema.Struct({ type: Schema.Literal("cursor"), captured: Schema.Boolean }),
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
  /**
   * The pane's size in device pixels. The display follows the viewer in control, or else the
   * one that most recently opened or showed its pane.
   */
  Schema.Struct({
    type: Schema.Literal("resize"),
    width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7680 })),
    height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4320 })),
  }),
  /**
   * Whether the pane is on screen; a viewer starts visible. With no viewer on screen, capture and
   * encoding stop, and a pane shown again starts on a keyframe. Control is kept while hidden.
   */
  Schema.Struct({ type: Schema.Literal("visibility"), visible: Schema.Boolean }),
  /**
   * Needs `terminal:operate`. With `takeOver`, control moves here from whoever has it;
   * otherwise it is taken only when nobody has it.
   */
  Schema.Struct({ type: Schema.Literal("takeControl"), takeOver: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("releaseControl") }),
  ...HostedBlenderInputMessage.members,
]);
export type HostedBlenderStreamClientMessage = typeof HostedBlenderStreamClientMessage.Type;

/** What a viewer sends besides acks, its size and visibility: taking control, and input. */
export type HostedBlenderViewerMessage = Exclude<
  HostedBlenderStreamClientMessage,
  { readonly type: "ack" | "resize" | "visibility" }
>;
