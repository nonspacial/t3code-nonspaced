import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  PreviewAnnotationCameraViewSchema,
  PreviewAnnotationHitSchema,
  PreviewAnnotationVectorSchema,
} from "./ipc.ts";

export const HOSTED_BLENDER_STREAM_PATH = "/api/hosted-blender-stream";
/** The thread has no hosted Blender running, or it stopped while being watched. */
export const HOSTED_BLENDER_STREAM_STOPPED_CLOSE_CODE = 4404;
/** Too many viewers are already watching this hosted Blender. */
export const HOSTED_BLENDER_STREAM_FULL_CLOSE_CODE = 4429;

/**
 * What the server lacks to host Blender. `enabled` is the Hosted Blender switch in Settings;
 * `check` means nobody with permission to run it has checked the server yet.
 */
export const HostedBlenderRequirement = Schema.Literals([
  "enabled",
  "check",
  "helper",
  "blender",
  "labwc",
  "gstreamer",
  "encoder",
  "glupload",
]);
export type HostedBlenderRequirement = typeof HostedBlenderRequirement.Type;

/** What the setup check looks at. `gpu` and `blenderMcp` never stop the pane. */
export const HostedBlenderSetupItem = Schema.Literals([
  "helper",
  "blender",
  "labwc",
  "gstreamer",
  "encoder",
  "glupload",
  "gpu",
  "blenderMcp",
]);
export type HostedBlenderSetupItem = typeof HostedBlenderSetupItem.Type;

export const HostedBlenderSetupCheck = Schema.Struct({
  item: HostedBlenderSetupItem,
  /**
   * `warning` works, but slowly or only partly: no GPU. `unrecognized` is a program by the right
   * name that isn't the expected one, such as PyPI's unrelated `blender-mcp`.
   */
  status: Schema.Literals(["ok", "missing", "outdated", "warning", "unrecognized"]),
  /** What was found: a version, a path or an encoder. */
  found: Schema.optionalKey(Schema.String),
});
export type HostedBlenderSetupCheck = typeof HostedBlenderSetupCheck.Type;

export const HostedBlenderPackageManager = Schema.Literals(["pacman", "apt", "dnf"]);
export type HostedBlenderPackageManager = typeof HostedBlenderPackageManager.Type;

/** The last setup check's outcome. */
export const HostedBlenderSetupResult = Schema.Union([
  /**
   * `platform`: not Linux. `distro`: a release too old for labwc and GStreamer (Ubuntu 22.04,
   * Debian 12). `sandboxedBlender`: the only Blender is a Flatpak or Snap build.
   */
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["platform", "distro", "sandboxedBlender"]),
    distro: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("checked"),
    /** Everything the pane needs is there. */
    ready: Schema.Boolean,
    checks: Schema.Array(HostedBlenderSetupCheck),
    distro: Schema.NullOr(Schema.String),
    packageManager: Schema.NullOr(HostedBlenderPackageManager),
    /** How the helper captures labwc's windows: labwc 0.9 and later, or the older fallback. */
    capture: Schema.NullOr(Schema.Literals(["ext-image-copy-capture", "wlr-screencopy"])),
    /** Shell commands that install what is missing, for "Show me the commands". */
    commands: Schema.Array(Schema.String),
    checkedAt: Schema.Number,
  }),
]);
export type HostedBlenderSetupResult = typeof HostedBlenderSetupResult.Type;

export const HostedBlenderSetupState = Schema.Struct({
  /** Null until the first check finishes. Kept until "Check again". */
  result: Schema.NullOr(HostedBlenderSetupResult),
  checking: Schema.Boolean,
  /** The "Install with an agent" thread, until its agent finishes and T3 checks again. */
  installThreadId: Schema.NullOr(ThreadId),
});
export type HostedBlenderSetupState = typeof HostedBlenderSetupState.Type;

export const HostedBlenderInstallResult = Schema.Struct({ threadId: ThreadId });
export type HostedBlenderInstallResult = typeof HostedBlenderInstallResult.Type;

export class HostedBlenderSetupError extends Schema.TaggedError<HostedBlenderSetupError>()(
  "HostedBlenderSetupError",
  {
    reason: Schema.Literals([
      "unavailable",
      "nothingToInstall",
      "noProject",
      "noDefaultModel",
      "launchFailed",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "Hosted Blender is not available on this host.";
      case "nothingToInstall":
        return "Hosted Blender has everything it needs. Check again if something changed.";
      case "noProject":
        return "This server cannot start threads without a project.";
      case "noDefaultModel":
        return "Choose a default model for new threads first.";
      case "launchFailed":
        return "T3 Code could not start the setup thread.";
    }
  }
}

export const HostedBlenderRunningState = Schema.Struct({
  status: Schema.Literals(["starting", "running"]),
  /** Relative to the thread's workspace. */
  relativePath: TrimmedNonEmptyString,
  /** The file has changes Blender hasn't saved. */
  dirty: Schema.Boolean,
  /** The agent is acting in this Blender through Blender Lab's MCP, as T3's add-on reports. */
  agentActing: Schema.optionalKey(Schema.Boolean),
  /**
   * The file changed on disk, so Blender reloaded it, keeping its unsaved changes as the copy
   * with this key, which Reopen with `restore` puts back. `at` tells one reload from the next.
   */
  reloadKept: Schema.optionalKey(Schema.Struct({ key: Schema.String, at: Schema.Number })),
});
export type HostedBlenderRunningState = typeof HostedBlenderRunningState.Type;

/** A file a thread keeps a recovery copy of: one in its workspace, one outside it, or untitled. */
export const HostedBlenderKeptFile = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("workspace"), relativePath: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("outside"), path: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("untitled") }),
]);
export type HostedBlenderKeptFile = typeof HostedBlenderKeptFile.Type;

/**
 * What a thread's hosted Blender left for one file: `closed` when T3 quit it (its thread settled
 * or was archived, T3 shut down, or Hosted Blender was switched off), `crashed` when it stopped
 * on its own. `recovery` is a copy of that file's session, unsaved changes included.
 */
export const HostedBlenderKeptCopy = Schema.Struct({
  /** Names this copy to Reopen and Discard. */
  key: Schema.String,
  kind: Schema.Literals(["closed", "crashed"]),
  file: HostedBlenderKeptFile,
  recovery: Schema.Boolean,
  /** The last try to restore it failed; the copy is kept. */
  restoreFailed: Schema.optional(Schema.Boolean),
  /** Where the copy is on the server, for one T3 can't reopen: untitled or outside the workspace. */
  copyPath: Schema.optional(Schema.String),
});
export type HostedBlenderKeptCopy = typeof HostedBlenderKeptCopy.Type;

/**
 * A thread's hosted Blender. `unavailable` is a host that can never run one (not Linux);
 * `notSetUp` is a Linux host missing `missing`.
 */
export const HostedBlenderThreadState = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.optionalKey(Schema.Literals(["platform", "distro", "sandboxedBlender"])),
  }),
  Schema.Struct({
    status: Schema.Literal("notSetUp"),
    missing: Schema.Array(HostedBlenderRequirement),
  }),
  Schema.Struct({ status: Schema.Literal("stopped") }),
  /** The last start never showed Blender's viewport window. Opening a file again retries. */
  Schema.Struct({ status: Schema.Literal("failed") }),
  /** No Blender running, and what earlier ones left for each file, newest first. */
  Schema.Struct({
    /** The newest copy's kind. */
    status: Schema.Literals(["closed", "crashed"]),
    copies: Schema.NonEmptyArray(HostedBlenderKeptCopy),
  }),
  HostedBlenderRunningState,
]);
export type HostedBlenderThreadState = typeof HostedBlenderThreadState.Type;

/**
 * Which of a thread's hosted Blenders: its own working Blender, or the master Blender it shares
 * with the other threads working on the same master file. Absent means `working`.
 */
export const HostedBlenderRole = Schema.Literals(["working", "master"]);
export type HostedBlenderRole = typeof HostedBlenderRole.Type;

/**
 * The thread's master file and where it is open. `none`: the thread has named no master yet.
 * `notOpen`: no master Blender has it; `desktop` is what T3 last found in the user's desktop
 * Blender: `open` there (Move into T3 can take it), or `noAddon`, a desktop Blender T3 can't ask.
 */
export const HostedBlenderMasterState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("none") }),
  Schema.Struct({
    status: Schema.Literal("notOpen"),
    relativePath: TrimmedNonEmptyString,
    desktop: Schema.NullOr(Schema.Literals(["open", "noAddon"])),
    /** The desktop Blender has unsaved changes in it, which Move into T3 saves. */
    desktopDirty: Schema.Boolean,
  }),
  Schema.Struct({ status: Schema.Literal("failed"), relativePath: TrimmedNonEmptyString }),
  /** No master Blender running, and the one copy the last one left of the master file. */
  Schema.Struct({
    status: Schema.Literals(["closed", "crashed"]),
    relativePath: TrimmedNonEmptyString,
    copies: Schema.NonEmptyArray(HostedBlenderKeptCopy),
  }),
  Schema.Struct({
    ...HostedBlenderRunningState.fields,
    /** A desktop Blender T3 couldn't ask was running when it opened, and may have it open too. */
    desktopUnchecked: Schema.optionalKey(Schema.Boolean),
  }),
]);
export type HostedBlenderMasterState = typeof HostedBlenderMasterState.Type;

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
  /**
   * The person chose Quit without saving in the save/discard dialog: only this discards what
   * Blender has unsaved. Any other quit without saving keeps it, as a settle does.
   */
  discard: Schema.optionalKey(Schema.Boolean),
  /** Quitting the master Blender quits it for every thread sharing it. */
  role: Schema.optionalKey(HostedBlenderRole),
  /** A master Blender by its key from the Running Blenders list, which may have no thread. */
  master: Schema.optionalKey(Schema.String),
});
export type HostedBlenderQuitInput = typeof HostedBlenderQuitInput.Type;

export const HostedBlenderDismissInput = Schema.Struct({
  threadId: ThreadId,
  /** The master's copy, shared by every thread whose master is that file. */
  role: Schema.optionalKey(HostedBlenderRole),
  /** Discards this copy; without one, clears a failed start. */
  key: Schema.optional(Schema.String),
});
export type HostedBlenderDismissInput = typeof HostedBlenderDismissInput.Type;

export const HostedBlenderReopenInput = Schema.Struct({
  threadId: ThreadId,
  /** The master's copy, restored in the master Blender, which the thread joins. */
  role: Schema.optionalKey(HostedBlenderRole),
  /** The kept copy whose file to reopen. */
  key: Schema.String,
  /** Restore that recovery copy or autosave instead of the file as saved. */
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
  /** A master Blender's own key, which Quit takes: it may have no thread left. */
  master: Schema.optionalKey(Schema.String),
});
export type HostedBlenderRunningBlender = typeof HostedBlenderRunningBlender.Type;

export const HostedBlenderRunningList = Schema.Array(HostedBlenderRunningBlender);
export type HostedBlenderRunningList = typeof HostedBlenderRunningList.Type;
export const HostedBlenderThreadInput = Schema.Struct({
  threadId: ThreadId,
  role: Schema.optionalKey(HostedBlenderRole),
});
export type HostedBlenderThreadInput = typeof HostedBlenderThreadInput.Type;

const Fraction = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/**
 * How the viewport window showed the scene when a frame was frozen, so a mark drawn on that
 * frame can be cast into the scene later: the 3D view's `perspective_matrix` (row-major), and
 * where its drawing region sits in the window, as fractions from the top-left corner.
 */
export const HostedBlenderViewProjection = Schema.Struct({
  matrix: Schema.Array(Schema.Finite).check(Schema.isMinLength(16), Schema.isMaxLength(16)),
  region: Schema.Struct({ x: Fraction, y: Fraction, width: Fraction, height: Fraction }),
});
export type HostedBlenderViewProjection = typeof HostedBlenderViewProjection.Type;

/** The person's viewport window's camera, in Blender's scene coordinates. */
export const HostedBlenderViewCapture = Schema.Struct({
  /** Blender's own render of the viewport's 3D region, drawn with this camera, as a PNG. */
  screenshot: Schema.Struct({
    dataUrl: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
  cameraView: PreviewAnnotationCameraViewSchema,
  projection: HostedBlenderViewProjection,
});
export type HostedBlenderViewCapture = typeof HostedBlenderViewCapture.Type;

/** A point on the streamed window, as fractions of its width and height from the top-left. */
const WindowSample = Schema.Struct({ x: Fraction, y: Fraction });

export const HostedBlenderFindHitsInput = Schema.Struct({
  threadId: ThreadId,
  role: Schema.optionalKey(HostedBlenderRole),
  projection: HostedBlenderViewProjection,
  /** Each mark's samples, tried in order until one meets a surface. */
  marks: Schema.Array(Schema.Array(WindowSample).check(Schema.isMaxLength(256))).check(
    Schema.isMaxLength(64),
  ),
});
export type HostedBlenderFindHitsInput = typeof HostedBlenderFindHitsInput.Type;

/** What each mark covers, in the order of the marks; null where it meets nothing. */
export const HostedBlenderHits = Schema.Array(Schema.NullOr(PreviewAnnotationHitSchema));
export type HostedBlenderHits = typeof HostedBlenderHits.Type;

export const HostedBlenderSetViewInput = Schema.Struct({
  threadId: ThreadId,
  role: Schema.optionalKey(HostedBlenderRole),
  /** The file the link points at; refused when the thread's Blender has another file open. */
  relativePath: TrimmedNonEmptyString,
  /** A `#view=` link's camera position and target, in Blender's scene coordinates. */
  view: Schema.Struct({
    position: PreviewAnnotationVectorSchema,
    target: PreviewAnnotationVectorSchema,
  }),
});
export type HostedBlenderSetViewInput = typeof HostedBlenderSetViewInput.Type;

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
      "notRunning",
      "noReply",
      "noViewport",
      "noScreenshot",
      "noMaster",
      "desktopUnreachable",
      "desktopOtherFile",
      "desktopDidNotQuit",
      "masterUnsaved",
      "masterChanged",
      "desktopAlias",
      "masterBusy",
      "changedOnDisk",
      "restoreFailed",
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
        return "This thread's hosted Blender kept unsaved changes to this file. Reopen or discard them first.";
      case "notRunning":
        return "This thread has no hosted Blender running.";
      case "noReply":
        return "The hosted Blender didn't answer.";
      case "noViewport":
        return "The hosted Blender has no viewport window open.";
      case "noScreenshot":
        return "The hosted Blender couldn't take a picture of its viewport.";
      case "noMaster":
        return "This thread hasn't named a master file yet.";
      case "desktopUnreachable":
        return "T3 Code can't reach the desktop Blender's MCP add-on, so it can't move the file. Save and close it there, then open the master here.";
      case "desktopOtherFile":
        return "The desktop Blender no longer has this master open.";
      case "desktopDidNotQuit":
        return "The desktop Blender didn't save and quit. Check it for an error, then try again.";
      case "masterUnsaved":
        return "This thread's master Blender has unsaved changes. Save or quit it in the Blender pane's Master view first.";
      case "masterChanged":
        return "This thread's master changed. Check the Blender pane and try again.";
      case "masterBusy":
        return "The master Blender is busy finishing an earlier request to quit. Try again in a moment.";
      case "desktopAlias":
        return "The desktop Blender has this master open under another name, so its save wouldn't reach the master. Open the master itself there, or quit it and open the master here.";
      case "changedOnDisk":
        return "The file changed on disk after this Blender loaded it, so Blender didn't save over it. Show the Blender pane to load the file as it is now; its unsaved changes are kept as a recovery copy.";
      case "restoreFailed":
        return "Blender couldn't restore the kept changes. The copy is still kept.";
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

/** `blender_start`: the master file an agent wants changed, from the thread's workspace. */
export const HostedBlenderToolStartInput = Schema.Struct({
  path: TrimmedNonEmptyString.annotate({
    description:
      "The master `.blend`: the file the user wants changed, absolute or relative to the thread's workspace. T3 opens a working copy of it.",
  }),
});
export type HostedBlenderToolStartInput = typeof HostedBlenderToolStartInput.Type;

export const HostedBlenderToolStartResult = Schema.Struct({
  /** The working copy's absolute path, beside the master. */
  workingCopy: Schema.String,
  master: Schema.String,
  /** False when the thread's earlier working copy was kept. */
  created: Schema.Boolean,
  status: Schema.Literals(["starting", "running"]),
  /** The MCP server whose tools edit the working copy. */
  mcpServer: Schema.String,
});
export type HostedBlenderToolStartResult = typeof HostedBlenderToolStartResult.Type;

export const HostedBlenderToolStatusResult = Schema.Struct({
  blenders: Schema.Array(
    Schema.Struct({
      role: HostedBlenderRole,
      status: Schema.Literals(["starting", "running", "failed", "closed", "crashed"]),
      /** The file's absolute path; absent for a start that failed or an untitled scene. */
      file: Schema.optionalKey(Schema.String),
      /** Closed or crashed: a recovery copy of its session that Reopen in the pane can restore. */
      recovery: Schema.optionalKey(Schema.Boolean),
      unsavedChanges: Schema.optionalKey(Schema.Boolean),
      /** Whether its Blender MCP takes this thread's `blender-hosted` calls. */
      agentAccess: Schema.optionalKey(Schema.Boolean),
      /**
       * Why that access ended: switched off or the session ended, T3 lost its connection to
       * Blender, or Blender has another file open.
       */
      agentAccessEnded: Schema.optionalKey(
        Schema.Literals(["revoked", "connectionLost", "otherFile"]),
      ),
      /** T3 never gave access: the Blender's Blender Lab version is one T3 hasn't tested. */
      agentAccessRefused: Schema.optionalKey(Schema.Literal("untestedBlenderLab")),
    }),
  ),
});
export type HostedBlenderToolStatusResult = typeof HostedBlenderToolStatusResult.Type;

export const HostedBlenderToolMasterOpenInput = Schema.Struct({
  path: TrimmedNonEmptyString.annotate({
    description:
      "The master `.blend`, not your working copy: absolute or relative to the thread's workspace.",
  }),
});
export type HostedBlenderToolMasterOpenInput = typeof HostedBlenderToolMasterOpenInput.Type;

export const HostedBlenderToolMasterOpenResult = Schema.Struct({
  master: Schema.String,
  /** `desktop`: the user's desktop Blender has it open, so copy back goes through `blender`. */
  status: Schema.Literals(["desktop", "starting", "running"]),
  /** The MCP server to copy back through. */
  mcpServer: Schema.String,
  /** A desktop Blender is running that T3 couldn't ask; it may have the master open too. */
  desktopUnchecked: Schema.optionalKey(Schema.Boolean),
});
export type HostedBlenderToolMasterOpenResult = typeof HostedBlenderToolMasterOpenResult.Type;

export const HostedBlenderToolQuitInput = Schema.Struct({
  save: Schema.Boolean.annotate({
    description: "Save the working copy first. Quitting without saving loses unsaved edits.",
  }),
});
export type HostedBlenderToolQuitInput = typeof HostedBlenderToolQuitInput.Type;

/** Why a hosted Blender tool could not act; the reason is written for the agent. */
export class HostedBlenderToolError extends Schema.TaggedError<HostedBlenderToolError>()(
  "HostedBlenderToolError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
