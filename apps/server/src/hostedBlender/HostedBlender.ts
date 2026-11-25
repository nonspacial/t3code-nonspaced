// @effect-diagnostics nodeBuiltinImport:off - names recovery folders by a hash of their file.
import * as NodeCrypto from "node:crypto";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  HostedBlenderError,
  type HostedBlenderDismissInput,
  HostedBlenderFindHitsInput,
  type HostedBlenderKeptCopy,
  HostedBlenderKeptFile,
  HostedBlenderHits,
  type HostedBlenderMasterState,
  type HostedBlenderOpenInput,
  type HostedBlenderQuitInput,
  type HostedBlenderReopenInput,
  type HostedBlenderRunningList,
  type HostedBlenderRunningState,
  HostedBlenderSetViewInput,
  HostedBlenderReloadBlocker,
  HostedBlenderRole,
  type HostedBlenderStreamServerMessage,
  type HostedBlenderViewerMessage,
  type HostedBlenderThreadState,
  ThreadId,
  TrimmedNonEmptyString,
  HostedBlenderViewCapture,
  HostedBlenderViewProjection,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { constUndefined } from "effect/Function";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { readFileRevision } from "../assets/MediaFile.ts";
import * as BlendFileWatcher from "../blend/BlendFileWatcher.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { threadWorkspaceRoot } from "../project/threadWorkspaceRoot.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  displaySize,
  helperArguments,
  runtimeParent,
  helperEnvironment,
  newestBlenderConfigVersion,
} from "./BlenderLaunch.ts";
import { SessionControl } from "../preview/SessionControl.ts";
import { HOSTED_STARTUP_GATE_SOURCE } from "./agentGuard.ts";
import { CONTROL_ADDON_SOURCE } from "./controlAddon.ts";
import * as DesktopBlender from "./DesktopBlender.ts";
import { isSameAccountPeer } from "./loopbackPeer.ts";
import { forwardLoopbackPort } from "./portForward.ts";
import { type ControlConnection, requestSave, type SaveReply } from "./ControlSave.ts";
import { type AgentListenerState, awaitAgentListener } from "./agentListenerWait.ts";
import { HeldInput } from "./HeldInput.ts";
import * as HostedBlenderAgents from "./HostedBlenderAgents.ts";
import * as HostedBlenderSetup from "./HostedBlenderSetup.ts";
import {
  encodeHelperCommand,
  type HelperCommand,
  type HelperPacket,
  HelperPacketError,
  helperCommandForInput,
  HelperPacketReader,
  isHelperPacketError,
} from "./HelperProtocol.ts";
import {
  type BlenderExit,
  cleanupOf,
  endingOf,
  fileKeyOf,
  type KeptFile,
  keptFileOf,
  type RestoreState,
  snapshotOf,
} from "./Recovery.ts";
import { BitrateControl } from "./Bitrate.ts";
import { sendHoldingSlot } from "./ControlSlot.ts";
import { ViewerFlow } from "./ViewerFlow.ts";

const MAX_VIEWERS = 4;
const INITIAL_SIZE = { width: 1280, height: 720 };
const MEMORY_SAMPLE_INTERVAL = Duration.seconds(5);
const KEYFRAME_REQUEST_INTERVAL_MS = 250;
const QUIT_TIMEOUT = Duration.seconds(20);
// The desktop app kills the server 5 seconds after asking it to stop. Blenders get this long
// to finish their quit copies, and the rest is left for stopping or releasing them.
const SHUTDOWN_QUIT_TIMEOUT = Duration.millis(4000);
// A Blender released at shutdown, still writing its quit copy, gets this long at the next start
// to finish before it is stopped.
const RELEASED_FINISH_TIMEOUT = Duration.seconds(60);
const SHUTDOWN_STOP_TIMEOUT = Duration.millis(400);
// A helper asked to stop gives Blender 5 seconds before killing it.
const LEFTOVER_STOP_TIMEOUT = Duration.seconds(7);

/** How startup signals a leftover launch's processes; tests stand in for what the kernel does. */
export const LeftoverSignal = Context.Reference<(pid: number, signal: NodeJS.Signals) => void>(
  "t3/hostedBlender/LeftoverSignal",
  {
    defaultValue: () => (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    },
  },
);
// A desktop Blender that doesn't answer by then counts as one T3 couldn't ask.
const DESKTOP_PROBE_DEADLINE = Duration.seconds(8);
// A start that shows no viewport window by then has failed (a broken file, no encoder).
const START_TIMEOUT = Duration.seconds(90);
const CONTROL_RETRY_INTERVAL = Duration.millis(200);
// The add-on starts the agent listener only once this connection is up, so it waits as long as a
// start does: a slow file still gets its listener while T3 is listening for it. The ending of a
// slow Blender also waits on it, to keep its session.
export const CONTROL_CONNECT_ATTEMPTS = Math.ceil(
  Duration.toMillis(START_TIMEOUT) / Duration.toMillis(CONTROL_RETRY_INTERVAL),
);
const HELPER_QUIT_TIMEOUT = Duration.seconds(10);
const CONTROL_REPLY_TIMEOUT = Duration.seconds(5);
const CONTROL_DRAIN_TIMEOUT = Duration.seconds(1);

// T3's control add-on speaks JSON lines on its private socket; see controlAddon.ts.
const ControlMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("hello"), pid: Schema.Int }),
  Schema.Struct({
    type: Schema.Literal("state"),
    filepath: Schema.String,
    dirty: Schema.Boolean,
    /** How the restore T3 asked for went, once it has run. */
    restore: Schema.optional(Schema.Literals(["ok", "failed"])),
    agentListener: Schema.optional(
      Schema.Literals(["off", "starting", "ready", "failed", "untested"]),
    ),
    /** Blender Lab is running agent calls, or just has. */
    agentActing: Schema.optional(Schema.Boolean),
    /** The installed Blender Lab extension's version, when the launch asked for its listener. */
    mcpVersion: Schema.optional(Schema.NullOr(Schema.String)),
    /** When Blender last loaded a file (open, revert, recover), epoch ms. */
    loadedAt: Schema.optional(Schema.Number),
    /** The file on disk changed since Blender read or saved it. */
    stale: Schema.optional(Schema.Boolean),
    /** What holds the reload of a stale file. */
    staleBlocked: Schema.optional(HostedBlenderReloadBlocker),
  }),
  /**
   * Unsaved changes of `filepath` kept before a reload, in Blender's TMPDIR as `copy`, beside a
   * note naming the file, which salvage reads if T3 never gets to it.
   */
  Schema.Struct({
    type: Schema.Literal("reloading"),
    copy: Schema.String,
    filepath: Schema.String,
  }),
  /** Blender reloaded the file from disk; `kept` when its unsaved changes went to a copy first. */
  Schema.Struct({ type: Schema.Literal("reloaded"), kept: Schema.Boolean }),
  /** The agent called while the file on disk wasn't what Blender read: T3 looks now. */
  Schema.Struct({ type: Schema.Literal("checkDisk") }),
  /** The file and its unsaved bit as Blender began to quit without saving: the run's last word. */
  Schema.Struct({
    type: Schema.Literal("quitting"),
    filepath: Schema.String,
    dirty: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("saving") }),
  /**
   * The file saved, and whether it was unsaved again once the agent's access ended. `quit`
   * false is a save made in Blender (Ctrl+S) that it stays open after; otherwise Save and quit's.
   */
  Schema.Struct({
    type: Schema.Literal("saved"),
    filepath: Schema.String,
    dirty: Schema.Boolean,
    quit: Schema.optional(Schema.Boolean),
    /** The load it was saved from, which a state report may not have named yet. */
    loadedAt: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("quitFailed"),
    reason: Schema.Literals(["saveFailed", "changedOnDisk"]),
  }),
  /** A discard named another file than the one Blender has open, so Blender stays open. */
  Schema.Struct({ type: Schema.Literal("discardRefused") }),
  /** `quitIfClean` found unsaved changes, so Blender stays open. */
  Schema.Struct({ type: Schema.Literal("quitRefused"), id: Schema.optional(Schema.Int) }),
  /** A quit T3 gave up on won't be carried out. */
  Schema.Struct({ type: Schema.Literal("quitCancelled"), id: Schema.Int }),
  /** The answer to the request with this `id`. */
  Schema.Struct({ type: Schema.Literal("reply"), id: Schema.Int, result: Schema.Unknown }),
]);
const decodeControlMessage = Schema.decodeUnknownOption(Schema.fromJsonString(ControlMessage));
const encodeListenerCommand = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.Literals(["grantAgentListener", "stopAgentListener"]) }),
  ),
);
const STOP_AGENT_LISTENER = `${encodeListenerCommand({ type: "stopAgentListener" })}\n`;
// The open file, by its real path, settled on disk at `revision` (null: nothing there);
// `reload` takes it now, since a pane shows this Blender. `panesHidden` takes that back.
const encodeDiskChanged = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("diskChanged"),
      path: Schema.String,
      revision: Schema.NullOr(Schema.String),
      reload: Schema.Boolean,
    }),
  ),
);
const PANES_HIDDEN = '{"type":"panesHidden"}\n';
// The add-on enables and starts Blender Lab only on this; a stop it heard first wins.
const GRANT_AGENT_LISTENER = `${encodeListenerCommand({ type: "grantAgentListener" })}\n`;
// Quits only if Blender, asked at that moment, has no unsaved changes. A quit T3 gave up on is
// cancelled by its id, so a late one never closes a master someone has joined since.
const encodeQuitRequest = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.Literals(["quitIfClean", "cancelQuit"]), id: Schema.Int }),
  ),
);
// Blender loads the file and the official add-on before its listener can come up.
export const AGENT_LISTENER_TIMEOUT = Duration.sum(START_TIMEOUT, Duration.seconds(15));

export type { AgentListenerState };

/**
 * Why the agent's access ended: T3 took it back (a setting or the session), T3 lost its
 * connection to Blender, or Blender has another file open.
 */
export type AgentAccessEnded = "revoked" | "connectionLost" | "otherFile";

/** A lost connection decides what the agent is told: nothing can save through it. */
export const agentAccessEndedFor = (
  controlLost: boolean,
  ended: AgentAccessEnded | null,
): AgentAccessEnded | null => (controlLost ? "connectionLost" : ended);

export interface AgentListenerReport {
  readonly state: AgentListenerState;
  /** `connectionLost` whenever T3 lost Blender, whatever else ended access first. */
  readonly ended: AgentAccessEnded | null;
  /**
   * The file Blender has open, as its add-on last said: null for an untitled scene, undefined
   * before it has said.
   */
  readonly openFile: string | null | undefined;
  /** The installed Blender Lab extension's version, once the add-on has said. */
  readonly mcpVersion: string | null;
}
// `filepath`: a discard of this open file only; the add-on refuses it once another is open.
const encodeControlCommand = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("quit"),
      save: Schema.Boolean,
      filepath: Schema.optionalKey(Schema.String),
    }),
  ),
);

/**
 * What a hosted Blender left for one file of its thread, kept on disk across restarts beside
 * the copy it describes, and written with it.
 */
const RecoveryRecord = Schema.Struct({
  threadId: ThreadId,
  file: HostedBlenderKeptFile,
  kind: Schema.Literals(["closed", "crashed"]),
  /** Its session file (`session.blend` beside the record) holds a copy to restore. */
  recovery: Schema.Boolean,
  /** When the copy was kept, epoch ms; the pane lists the newest first. */
  keptAt: Schema.Number,
  /** Kept as Blender reloaded the file from disk, so the file there is newer than this. */
  reloaded: Schema.optional(Schema.Boolean),
});
type RecoveryRecord = typeof RecoveryRecord.Type;
const RecoveryRecordJson = Schema.fromJsonString(RecoveryRecord);
const decodeRecoveryRecord = Schema.decodeUnknownOption(RecoveryRecordJson);
const encodeRecoveryRecord = Schema.encodeSync(RecoveryRecordJson);
/**
 * Written into each launch folder, so one a stopped server left behind can be salvaged. The
 * helper runs in the folder and names it in its arguments, so a live one is told apart from a
 * reused pid.
 */
const LaunchRecord = Schema.fromJsonString(
  Schema.Struct({
    threadId: ThreadId,
    relativePath: TrimmedNonEmptyString,
    helperPid: Schema.optional(Schema.Int),
    /** Which file a copy staged before a reload is of, by the path Blender gave it. */
    role: Schema.optional(HostedBlenderRole),
    workspaceRoot: Schema.optional(Schema.String),
  }),
);
const decodeLaunchRecord = Schema.decodeUnknownOption(LaunchRecord);
/** The note the add-on writes beside work it staged: the file it is of. */
const decodeStagedNote = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ filepath: Schema.String })),
);
const encodeLaunchRecord = Schema.encodeSync(LaunchRecord);

const EndFile = Schema.Struct({
  file: HostedBlenderKeptFile,
  /** Its absolute path; null for an untitled scene. */
  path: Schema.NullOr(Schema.String),
  /** When Blender opened it, epoch ms (0 for the file it launched with). */
  since: Schema.Number,
});
type EndFile = typeof EndFile.Type;

/** What salvage needs to apply the same cleanup a run's own end would. */
const RunFacts = Schema.fromJsonString(
  Schema.Struct({
    restore: Schema.Literals(["none", "pending", "ok", "failed"]),
    /** The file Blender has open, which its end keeps a copy of. */
    endFile: EndFile,
    /** Blender's last word on that file was a confirmed save. */
    saved: Schema.Boolean,
    /** The one copy that save retires, by when it was kept; none when it held no copy's work. */
    retires: Schema.optional(Schema.NullOr(Schema.Number)),
    /** Blender last reported that file clean. */
    clean: Schema.Boolean,
  }),
);
const decodeRunFacts = Schema.decodeUnknownOption(RunFacts);
const encodeRunFacts = Schema.encodeSync(RunFacts);
// Requests about the person's viewport window, each answered by one `reply`.
const ControlRequest = Schema.Union([
  /** `screenshot` is a file name for the render, in the control socket's private folder. */
  Schema.Struct({ type: Schema.Literal("view"), id: Schema.Int, screenshot: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("hits"),
    id: Schema.Int,
    ...HostedBlenderViewProjection.fields,
    marks: HostedBlenderFindHitsInput.fields.marks,
  }),
  Schema.Struct({
    type: Schema.Literal("setView"),
    id: Schema.Int,
    ...HostedBlenderSetViewInput.fields.view.fields,
    /** The file the link was made for; the add-on refuses if Blender has another open. */
    filepath: Schema.String,
  }),
  /**
   * Restores a kept copy over the open file, unsaved, if `filepath` is still the one open. Unsaved
   * work there is replaced only with `replace`, and kept first as the file's copy.
   */
  Schema.Struct({
    type: Schema.Literal("restore"),
    id: Schema.Int,
    path: Schema.String,
    filepath: Schema.String,
    replace: Schema.Boolean,
  }),
]);
type ControlRequest = typeof ControlRequest.Type;
type ControlRequestBody = ControlRequest extends infer Request
  ? Request extends ControlRequest
    ? Omit<Request, "id">
    : never
  : never;
const encodeControlRequest = Schema.encodeSync(Schema.fromJsonString(ControlRequest));
/** How a restore in place went; `copy` is the unsaved work it replaced, staged to keep. */
const RestoreAnswer = Schema.Struct({
  outcome: Schema.Literals(["restored", "otherFile", "unsaved", "unkeepable", "failed"]),
  copy: Schema.optional(Schema.NullOr(Schema.String)),
  filepath: Schema.optional(Schema.String),
  /** When the restore loaded, which marks the scene as holding the restored copy's work. */
  loadedAt: Schema.optional(Schema.Number),
});
/** What the add-on renders; the server reads the PNG it wrote. */
const AddonViewCapture = Schema.Struct({
  ...HostedBlenderViewCapture.fields,
  /** Null when Blender can't render this view (an external engine's rendered shading). */
  screenshot: Schema.NullOr(Schema.Struct({ width: Schema.Int, height: Schema.Int })),
});
/** Above what the add-on's pixel cap can produce; anything larger is not sent. */
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type HostedBlenderViewerOutput =
  | { readonly _tag: "frame"; readonly data: Uint8Array }
  | { readonly _tag: "message"; readonly message: HostedBlenderStreamServerMessage }
  | { readonly _tag: "stopped" };

export interface HostedBlenderViewer {
  readonly output: Queue.Dequeue<HostedBlenderViewerOutput>;
  readonly ack: Effect.Effect<void>;
  /**
   * The viewer's pane size in device pixels. The display follows the viewer in control, or
   * else the one that most recently opened or showed its pane.
   */
  readonly resize: (width: number, height: number) => Effect.Effect<void>;
  /** Whether the viewer's pane is on screen. Capture runs only while one is. */
  readonly setVisible: (visible: boolean) => Effect.Effect<void>;
  /** Taking control, and input that only reaches Blender from the viewer in control. */
  readonly input: (message: HostedBlenderViewerMessage) => Effect.Effect<void>;
}

export type HostedBlenderAttachResult =
  | { readonly _tag: "attached"; readonly viewer: HostedBlenderViewer }
  | { readonly _tag: "stopped" }
  | { readonly _tag: "full" };

/**
 * A thread's hosted Blender: labwc, Blender and T3's control add-on, run by the hidden display
 * helper, and the viewers watching its viewport window.
 */
export class HostedBlender extends Context.Service<
  HostedBlender,
  {
    /**
     * `agentWorkingCopy`: `blender_start` opens the thread's working copy, the only file whose
     * Blender listens for the thread's agent.
     */
    readonly open: (
      input: HostedBlenderOpenInput,
      options?: { readonly agentWorkingCopy?: boolean },
    ) => Effect.Effect<void, HostedBlenderError>;
    /**
     * The thread's agent listener, or null with no hosted Blender. `wait` waits for a starting
     * listener to settle; one that never does counts as failed.
     */
    readonly agentListener: (
      threadId: ThreadId,
      options?: { readonly wait?: boolean; readonly role?: HostedBlenderRole },
    ) => Effect.Effect<AgentListenerReport | null>;
    readonly quit: (input: HostedBlenderQuitInput) => Effect.Effect<void, HostedBlenderError>;
    /**
     * Reopens a kept copy's file, restoring the copy if asked. `agentWorkingCopy`: the agent's
     * `blender_start` reopens its own working copy, which then listens for it as `open` would.
     * With its Blender running, only the open file's copy (one a reload kept) is restored, in
     * place.
     */
    readonly reopen: (
      input: HostedBlenderReopenInput,
      options?: { readonly agentWorkingCopy?: boolean },
    ) => Effect.Effect<void, HostedBlenderError>;
    /**
     * Discards one kept copy, or clears a failed start. Nothing changes while the thread's
     * Blender runs.
     */
    readonly dismiss: (input: HostedBlenderDismissInput) => Effect.Effect<void>;
    /** Every copy the thread keeps, newest first, running Blender or not. */
    readonly keptCopies: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<HostedBlenderKeptCopy>>;
    /**
     * Saves a recovery copy and quits the thread's Blender, without waiting for it: the thread
     * settled, was archived or was deleted.
     */
    readonly closeOnSettle: (input: { readonly threadId: ThreadId }) => Effect.Effect<void>;
    /**
     * The thread was deleted: ends its hosted Blender as a settle does, then removes every copy
     * the thread kept, which nothing could show again. A master's copy is the master's, never
     * the thread's. Doesn't wait.
     */
    readonly forgetThread: (input: { readonly threadId: ThreadId }) => Effect.Effect<void>;
    /** Every hosted Blender on this server, for Settings. */
    readonly runningBlenders: Stream.Stream<HostedBlenderRunningList>;
    readonly threadState: (threadId: ThreadId) => Stream.Stream<HostedBlenderThreadState>;
    /** `canOperate`: the viewer may take control (`terminal:operate`). */
    readonly attachViewer: (
      threadId: string,
      options: {
        readonly canOperate: boolean;
        readonly role?: HostedBlenderRole | undefined;
        /** Whether its pane is on screen as it attaches; a tab in the background isn't. */
        readonly visible?: boolean | undefined;
      },
    ) => Effect.Effect<HostedBlenderAttachResult, never, Scope.Scope>;
    /** The person's viewport window's camera, for an annotation of the frame shown now. */
    readonly captureView: (
      threadId: ThreadId,
      role?: HostedBlenderRole,
    ) => Effect.Effect<HostedBlenderViewCapture, HostedBlenderError>;
    /**
     * Makes `relativePath` the thread's master and joins the thread to the master Blender that
     * has it, starting one if none does. A desktop Blender that has it open keeps it: the answer
     * is `desktop`, and Move into T3 can take it from there. With `agentSession`, the thread's
     * agent copies back through it, so its `blender-master` port reaches it.
     */
    readonly openMaster: (
      input: HostedBlenderOpenInput,
      /** The provider session whose agent asked; access lasts only while it is current. */
      options?: { readonly agentSession?: string },
    ) => Effect.Effect<
      | { readonly _tag: "desktop" }
      | { readonly _tag: "hosted"; readonly desktopUnchecked: boolean },
      HostedBlenderError
    >;
    /** The thread's known master, opened again as `openMaster` would. */
    readonly reopenMaster: (threadId: ThreadId) => Effect.Effect<void, HostedBlenderError>;
    /**
     * `blender_start` made the thread's working copy from `relativePath`, so that is its master,
     * known but not chosen: nothing starts, no relay opens, and no master Blender counts it until
     * an open chooses it. A master already chosen stays.
     */
    readonly knowMaster: (input: HostedBlenderOpenInput) => Effect.Effect<void, HostedBlenderError>;
    /**
     * The thread stops using its master; the master Blender quits when no thread uses it. One
     * with unsaved changes stays open until someone quits it.
     */
    readonly releaseMaster: (threadId: ThreadId) => Effect.Effect<void>;
    /**
     * Has the desktop Blender save and quit the thread's master, then opens it here for every
     * thread that chose it. `relativePath` is the master the user saw; a changed one is refused.
     */
    readonly moveIntoT3: (input: HostedBlenderOpenInput) => Effect.Effect<void, HostedBlenderError>;
    readonly masterState: (threadId: ThreadId) => Stream.Stream<HostedBlenderMasterState>;
    /** Casts each mark into the scene through a captured view. */
    readonly findHits: (
      input: HostedBlenderFindHitsInput,
    ) => Effect.Effect<HostedBlenderHits, HostedBlenderError>;
    /** Moves the person's viewport window, never the agent's main window. */
    readonly setView: (input: HostedBlenderSetViewInput) => Effect.Effect<void, HostedBlenderError>;
  }
>()("t3/hostedBlender/HostedBlender") {}

interface ViewerEntry {
  readonly id: string;
  readonly canOperate: boolean;
  readonly queue: Queue.Queue<HostedBlenderViewerOutput>;
  flow: ViewerFlow;
  size: { readonly width: number; readonly height: number } | null;
  visible: boolean;
  /** When the viewer last opened or showed its pane, as an ordering. */
  shownAt: number;
}

interface Instance {
  /** Its key in `instances`: the thread for a working Blender, `master:<file>` for a master. */
  readonly key: string;
  readonly role: HostedBlenderRole;
  /** A working Blender's thread; for a master, the thread that started it. */
  readonly threadId: ThreadId;
  /** A master's threads, and those of them whose agents copy back through it. */
  readonly masterThreads: Set<ThreadId>;
  readonly agentThreads: Set<ThreadId>;
  /** Each agent thread's `blender-master` port, relayed to this master's listener. */
  readonly forwards: Map<
    ThreadId,
    { readonly scope: Scope.Closeable; readonly session: string | null }
  >;
  readonly relativePath: string;
  /** The checked real path `open` resolved; `run` never resolves it again. */
  readonly blendPath: string;
  readonly ended: Deferred.Deferred<void>;
  readonly viewers: ViewerEntry[];
  status: "starting" | "running";
  dirty: boolean;
  pid: number | null;
  stats: { readonly encoder: string; readonly target: "window" | "output" } | null;
  memoryBytes: number | null;
  viewport: { readonly width: number; readonly height: number } | null;
  lastKeyframeRequest: number;
  /** A keyframe request is waiting out the throttle. */
  keyframeDeferred: boolean;
  /** The private folder of the control socket, where the add-on writes screenshots. */
  controlDir: string | null;
  /** The screenshot being rendered, shared by every caller until Blender is done with it. */
  capture: Deferred.Deferred<HostedBlenderViewCapture, HostedBlenderError> | null;
  helper: (command: HelperCommand) => Effect.Effect<void>;
  control: ControlConnection | null;
  /** What the add-on says while `quit` waits on a save. */
  saveReplies: Queue.Queue<SaveReply> | null;
  /** The one save-and-quit in flight; every caller gets its result. */
  pendingSave: Deferred.Deferred<boolean> | null;
  /** Requests to the add-on awaiting their `reply`, by id. */
  readonly requests: Map<number, Deferred.Deferred<unknown>>;
  /** Casting blocks Blender's UI thread, so one hit request reaches the add-on at a time. */
  readonly hitsLock: Semaphore.Semaphore;
  lastRequestId: number;
  fiber: Fiber.Fiber<void> | null;
  /** Set by `quit`, so stopping a Blender that is still starting doesn't read as a failed start. */
  quitting: boolean;
  /** Set when T3 quits it for its thread or a shutdown, which keeps a recovery copy. */
  ending: boolean;
  blenderExit: BlenderExit | null;
  /** The recovery copy or autosave this run restored over the file. */
  recover: string | null;
  /** The add-on's last word on `endFile` was a confirmed save, so nothing is left to recover. */
  saved: boolean;
  /** Save and quit saved, so T3 quit it; work recorded after that is kept as on a close. */
  saveConfirmed: boolean;
  /** The file Blender has open, whose copy this run's end keeps. */
  endFile: EndFile;
  /** Blender last reported `endFile` clean, before it began quitting. */
  clean: boolean;
  /** The add-on said it is quitting without saving. */
  quitHeard: boolean;
  /** The load time Blender last reported. */
  loadedAt: number | undefined;
  /** What T3 had asked when the helper exited; later asks can't make a crash look closed. */
  exitIntent: { readonly ending: boolean; readonly quitting: boolean } | null;
  /** The add-on said it is saving or writing its quit copy; stopping it now could cut that short. */
  acknowledged: boolean;
  /** Stopped as a shutdown runs out of time: the helper gets no grace. */
  stopNow: boolean;
  /**
   * Out of time at a shutdown while writing its quit copy: left to finish on its own, with its
   * launch folder, which the next start salvages.
   */
  released: boolean;
  /** Its thread settled: T3 is closing it, though the quit itself may not have begun. */
  closeRequested: boolean;
  /** `pending` until the add-on reports the restore of `recover`. */
  restore: RestoreState;
  /** Blender showed its viewport window. */
  shown: boolean;
  controlReady: Deferred.Deferred<void>;
  stateDir: string | null;
  readonly agentWorkingCopy: boolean;
  agentListener: AgentListenerState;
  /** Done once the listener is ready, failed or off. */
  readonly agentListenerSettled: Deferred.Deferred<void>;
  /** The thread lost agent access; the listener stays off until Blender restarts. */
  agentListenerRevoked: boolean;
  agentAccessEnded: AgentAccessEnded | null;
  /** The launch asked for the agent listener, which the add-on starts only once granted. */
  agentListenerGranted: boolean;
  /** The grant went out, once Blender had shown it has the launch file open. */
  agentListenerGrantSent: boolean;
  /** T3 lost its control connection: nothing can save through it any more. */
  controlLost: boolean;
  /** Where Blender Lab listens once granted; a master's agents reach it through `forwards`. */
  mcpPort: number | null;
  readonly forwardLock: Semaphore.Semaphore;
  /** Its last thread left while T3 couldn't ask it to quit; asked again once it can. */
  retryQuit: boolean;
  /** A desktop Blender T3 couldn't ask was running when this master started. */
  desktopUnchecked: boolean;
  /** Answered when the add-on won't quit a master with unsaved changes. */
  quitRefused: { readonly id: number; readonly done: Deferred.Deferred<void> } | null;
  /** A working copy's agent session, whose end ends its listener. */
  agentSession: string | undefined;
  /** Answered when the add-on has dropped the quit T3 gave up on. */
  quitCancelled: { readonly id: number; readonly done: Deferred.Deferred<void> } | null;
  /** Answered when the add-on refuses a discard that named another file. */
  discardRefused: Deferred.Deferred<void> | null;
  openFile: string | null | undefined;
  /** The real path of the file Blender has open now, which no other hosted Blender may open. */
  openRealPath: string | null;
  /** The files watched for changes on disk: the open file, by its name and its real path. */
  readonly watched: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>>;
  /** The add-on says the open file changed on disk since Blender read or saved it. */
  stale: boolean;
  /** A reload kept the unsaved changes of this file as its copy, which the pane offers. */
  reloadKept: { readonly key: string; readonly at: number } | null;
  /** Why the add-on refused the last Save and quit. */
  saveRefusal: "saveFailed" | "changedOnDisk" | null;
  /** What holds the reload of a stale file, as the add-on last said. */
  staleBlocked: HostedBlenderReloadBlocker | null;
  /** A disk change seen while a save or restore was under way, checked once it is over. */
  diskCheckWaiting: boolean;
  /** The key of the copy the last `reloading` kept, which its `reloaded` offers. */
  keptReload: string | null;
  /** The copy (by when it was kept) whose work the scene holds, since the load that restored it. */
  contained: { readonly keptAt: number | undefined; readonly loadedAt: number | undefined } | null;
  /** A restore in place is under way, until what it displaced is kept; another is refused. */
  restoring: boolean;
  /** The copy (by when it was kept) the last confirmed save retires, if it held its work. */
  retires: number | null;
  /** Asks for a look at the file, settled as a watch event is. */
  readonly diskNudges: Queue.Queue<void>;
  /** The workspace's real path, which the open file is named under. */
  readonly workspaceRoot: string;
  mcpVersion: string | null;
  /** The agent is acting through Blender Lab, as the add-on reports it; for the pane's badge. */
  agentActing: boolean;
  /**
   * Which viewer controls the mouse and keyboard. There is no agent side: the agent works
   * through its own MCP connection, so a viewer in control never pauses it.
   */
  readonly session: SessionControl;
  readonly held: HeldInput;
  /** Blender holds the mouse (a grab or orbit), so the controller sends relative motion. */
  cursorCaptured: boolean;
  /** The display size last asked of the helper. */
  displaySize: string;
  /** Whether the helper captures and encodes; it does from the start until told to pause. */
  capturing: boolean;
  readonly bitrate: BitrateControl;
  /** The viewer whose acks the bitrate follows. */
  bitrateLead: string | null;
}

const masterKey = (blendPath: string) => `master:${blendPath}`;
/**
 * A master Blender is one session its threads share, so its copy has one owner of its own,
 * kept under the master file's real path, whichever threads used it.
 */
const MASTER_OWNER = ThreadId.make("t3:master");
const masterFileOf = (blendPath: string): KeptFile =>
  blendPath === "" ? { kind: "untitled" } : { kind: "outside", path: blendPath };

type PublishedState =
  | HostedBlenderRunningState
  | { readonly status: "failed" }
  | {
      readonly status: "closed" | "crashed";
      readonly copies: readonly [HostedBlenderKeptCopy, ...HostedBlenderKeptCopy[]];
    };

const sameState = (a: HostedBlenderThreadState, b: HostedBlenderThreadState) =>
  JSON.stringify(a) === JSON.stringify(b);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;
  const setup = yield* HostedBlenderSetup.HostedBlenderSetup;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const watcher = yield* BlendFileWatcher.BlendFileWatcher;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const agents = yield* Effect.serviceOption(HostedBlenderAgents.HostedBlenderAgents);
  const desktop = yield* Effect.serviceOption(DesktopBlender.DesktopBlender);
  const lookupContext = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | ThreadManagementService.ThreadManagementService
    | ProjectService.ProjectService
  >();
  const serviceScope = yield* Effect.scope;
  const signalProcess = yield* LeftoverSignal;
  // Runs live here, so on shutdown they are ended with recovery copies before it closes.
  const runScope = yield* Scope.fork(serviceScope);
  let screenshots = 0;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  let nextViewerId = 0;
  let nextShownAt = 0;

  const instances = new Map<string, Instance>();
  // Hosted Blender was switched off in Settings; see the readiness subscription below.
  let switchedOff = false;
  const states = yield* SubscriptionRef.make<ReadonlyMap<string, PublishedState>>(new Map());
  const running = yield* SubscriptionRef.make<HostedBlenderRunningList>([]);
  // Threads whose last start failed, until they open a file again.
  const failedStarts = new Set<string>();
  // What each thread's Blenders left, one record per file (by `fileKeyOf`), until a newer copy
  // of that file, a confirmed save of it, or Discard. Mirrors the records under `recovery/`.
  const records = new Map<string, Map<string, RecoveryRecord>>();
  // Copies whose last restore failed, by `copyId`; the copy is kept and the pane says so.
  const failedRestores = new Set<string>();
  const copyId = (threadId: string, key: string) => `${threadId}\n${key}`;
  /** Each thread's master file, by its checked real path, and what T3 last saw of it. */
  const threadMasters = new Map<
    ThreadId,
    {
      readonly blendPath: string;
      readonly relativePath: string;
      desktop: "open" | "noAddon" | null;
      desktopDirty: boolean;
      /** The desktop Blender's own path for the file, which may be another link to it. */
      desktopPath: string | null;
      /** The provider session whose agent copies back through it, while that stays current. */
      agentSession: string | null;
      /**
       * Opened by the person or an agent. Only known (its working copy was made from it), a
       * master is never joined to, nor moved with, a master Blender another thread starts.
       */
      chosen: boolean;
    }
  >();
  // Masters whose last start failed, by real path, until they are opened again.
  const failedMasters = new Set<string>();
  const masterStates = yield* SubscriptionRef.make<ReadonlyMap<ThreadId, HostedBlenderMasterState>>(
    new Map(),
  );
  const userResourcesLock = yield* Semaphore.make(1);
  // File claims and master membership change one at a time: opens, joins and releases.
  const claimLock = yield* Semaphore.make(1);
  /** Master files claimed while the desktop Blender is asked, before their Blender starts. */
  const reserved = new Set<string>();
  const rootDir = path.join(config.stateDir, "hosted-blender");
  const launchesDir = path.join(rootDir, "launches");
  // Thread ids are opaque, so each gets a folder name that can't leave `recovery/`.
  const recoveryDir = (threadId: string) =>
    path.join(rootDir, "recovery", Buffer.from(threadId).toString("base64url"));
  // A file's key can be a long path, so its folder is named by the key's hash.
  const copyDir = (threadId: string, key: string) =>
    path.join(recoveryDir(threadId), NodeCrypto.createHash("sha256").update(key).digest("hex"));
  const sessionPath = (threadId: string, key: string) =>
    path.join(copyDir(threadId, key), "session.blend");

  /** The thread's copies, newest first, as the pane and the agent see them. */
  const copiesOf = (threadId: string): Array<HostedBlenderKeptCopy> =>
    Array.from(records.get(threadId)?.values() ?? [])
      .toSorted((a, b) => b.keptAt - a.keptAt)
      .map((record) => {
        const key = fileKeyOf(record.file);
        return {
          key,
          kind: record.kind,
          file: record.file,
          recovery: record.recovery,
          ...(record.reloaded === true ? { reloaded: true } : {}),
          ...(failedRestores.has(copyId(threadId, key)) ? { restoreFailed: true } : {}),
          // T3 reopens only workspace files; the person can find any other copy here.
          ...(record.recovery && record.file.kind !== "workspace"
            ? { copyPath: sessionPath(threadId, key) }
            : {}),
        };
      });

  /** The file Blender has open now, once it has said, as the client names it. */
  const openFileOf = (instance: Instance): { readonly openFile?: KeptFile } =>
    instance.openFile === undefined
      ? {}
      : { openFile: keptFileOf(instance.openFile ?? "", instance.workspaceRoot, path.relative) };

  /** The copy a reload kept, while it is still the open file's, and a reload being held. */
  const reloadKeptOf = (instance: Instance) => {
    const kept = instance.reloadKept;
    return {
      ...(kept !== null &&
      kept.key === fileKeyOf(instance.endFile.file) &&
      records.get(ownerOf(instance))?.get(kept.key)?.recovery === true
        ? { reloadKept: kept }
        : {}),
      ...(instance.stale && instance.staleBlocked !== null
        ? { reloadBlocked: instance.staleBlocked }
        : {}),
    };
  };

  const publishRunning = () =>
    Effect.suspend(() =>
      SubscriptionRef.set(
        running,
        Array.from(instances.values(), (instance) => ({
          threadId: instance.threadId,
          status: instance.status,
          relativePath: instance.relativePath,
          dirty: instance.dirty,
          ...openFileOf(instance),
          memoryBytes: instance.memoryBytes,
          // A master may have no thread left, so Quit names it by its own key.
          ...(instance.role === "master" ? { master: instance.key } : {}),
        })),
      ),
    );

  // A running Blender outranks what an earlier one left to reopen, and that outranks a failed
  // start, so a restore that fails to start still offers its recovery copy.
  const masterStateOf = (threadId: ThreadId): HostedBlenderMasterState => {
    const known = threadMasters.get(threadId);
    if (known === undefined) return { status: "none" };
    const instance = instances.get(masterKey(known.blendPath));
    if (instance?.masterThreads.has(threadId)) {
      return {
        // Unavailable while a quit it may still carry out is unsettled.
        status: instance.quitCancelled != null ? "starting" : instance.status,
        relativePath: known.relativePath,
        dirty: instance.dirty,
        ...(instance.agentActing ? { agentActing: true } : {}),
        ...openFileOf(instance),
        ...reloadKeptOf(instance),
        ...(instance.desktopUnchecked ? { desktopUnchecked: true } : {}),
      };
    }
    // The master's one copy, shown to each thread under its own name for the file.
    const key = fileKeyOf(masterFileOf(known.blendPath));
    const record = records.get(MASTER_OWNER)?.get(key);
    if (record !== undefined) {
      return {
        status: record.kind,
        relativePath: known.relativePath,
        copies: [
          {
            key,
            kind: record.kind,
            file: { kind: "workspace", relativePath: known.relativePath },
            recovery: record.recovery,
            ...(failedRestores.has(copyId(MASTER_OWNER, key)) ? { restoreFailed: true } : {}),
          },
        ],
      };
    }
    if (failedMasters.has(known.blendPath)) {
      return { status: "failed", relativePath: known.relativePath };
    }
    return {
      status: "notOpen",
      relativePath: known.relativePath,
      desktop: known.desktop,
      desktopDirty: known.desktopDirty,
    };
  };

  const publishNow = () =>
    Effect.suspend(() =>
      SubscriptionRef.set(
        states,
        new Map<string, PublishedState>([
          ...Array.from(failedStarts, (threadId): [string, PublishedState] => [
            threadId,
            { status: "failed" },
          ]),
          ...Array.from(records.keys()).flatMap((threadId): Array<[string, PublishedState]> => {
            const [newest, ...rest] = copiesOf(threadId);
            return newest === undefined
              ? []
              : [[threadId, { status: newest.kind, copies: [newest, ...rest] }]];
          }),
          ...Array.from(instances.values())
            .filter((instance) => instance.role === "working")
            .map((instance): [string, PublishedState] => [
              instance.threadId,
              {
                status: instance.status,
                relativePath: instance.relativePath,
                dirty: instance.dirty,
                ...(instance.agentActing ? { agentActing: true } : {}),
                ...openFileOf(instance),
                ...reloadKeptOf(instance),
              },
            ]),
        ]),
      ).pipe(
        Effect.andThen(
          SubscriptionRef.set(
            masterStates,
            new Map(
              Array.from(threadMasters.keys(), (threadId) => [threadId, masterStateOf(threadId)]),
            ),
          ),
        ),
      ),
    ).pipe(Effect.andThen(publishRunning()));

  // Each write goes through a temporary name, so a crash mid-write never leaves half a file.
  // Runs inside keepRecord's span.
  const writeAtomically = Effect.fnUntraced(function* (
    target: string,
    write: (to: string) => Effect.Effect<void, PlatformError>,
  ) {
    const partial = `${target}.partial`;
    yield* write(partial);
    yield* fileSystem.rename(partial, target);
  });

  const writeRecordFile = (record: RecoveryRecord) =>
    writeAtomically(
      path.join(copyDir(record.threadId, fileKeyOf(record.file)), "record.json"),
      (to) => fileSystem.writeFileString(to, encodeRecoveryRecord(record)),
    );
  const rememberRecord = (record: RecoveryRecord) => {
    const kept = records.get(record.threadId) ?? new Map<string, RecoveryRecord>();
    kept.set(fileKeyOf(record.file), record);
    records.set(record.threadId, kept);
  };
  const writeRecord = Effect.fnUntraced(function* (record: RecoveryRecord) {
    yield* writeRecordFile(record);
    rememberRecord(record);
  });

  /**
   * A save retires the file's copy only once the scene holds that copy's work. A copy a reload
   * or a restore displaced never was in it, until it is restored and not reloaded since.
   */
  const copyRetiredBySave = (instance: Instance, loadedAt: number | undefined) => {
    const record = records.get(ownerOf(instance))?.get(fileKeyOf(instance.endFile.file));
    if (record === undefined) return null;
    if (record.reloaded !== true) return record.keptAt;
    const contained = instance.contained;
    return contained !== null &&
      contained.keptAt === record.keptAt &&
      contained.loadedAt === loadedAt
      ? record.keptAt
      : null;
  };

  /**
   * Keeps the snapshot Blender left in `tmpDir` of the file it ended on as that file's copy,
   * with what it is of, replacing only an older copy of that same file. With no snapshot, an
   * earlier copy of the file stays as it was; with none either, the card still says how it
   * ended. No other file's copy is read or touched.
   */
  const keepCopy = Effect.fn("HostedBlender.keepCopy")(function* (input: {
    readonly threadId: ThreadId;
    readonly endFile: EndFile;
    readonly kind: RecoveryRecord["kind"];
    readonly tmpDir: string;
  }) {
    const { file, since } = input.endFile;
    const key = fileKeyOf(file);
    const names = yield* fileSystem
      .readDirectory(input.tmpDir)
      .pipe(Effect.orElseSucceed(() => []));
    const mtimeOf = (target: string) =>
      fileSystem.stat(target).pipe(
        Effect.map((info) =>
          info.type === "File"
            ? Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() })
            : -1,
        ),
        Effect.orElseSucceed(() => -1),
      );
    const files = yield* Effect.forEach(names, (name) =>
      mtimeOf(path.join(input.tmpDir, name)).pipe(Effect.map((mtimeMs) => ({ name, mtimeMs }))),
    );
    const snapshot = snapshotOf(files, {
      stem:
        file.kind === "untitled"
          ? null
          : path.basename(file.kind === "workspace" ? file.relativePath : file.path, ".blend"),
      since,
    });
    const existing = records.get(input.threadId)?.get(key);
    if (snapshot === undefined && existing !== undefined) return;
    yield* fileSystem.makeDirectory(copyDir(input.threadId, key), { recursive: true });
    if (snapshot === undefined) {
      yield* fileSystem.remove(sessionPath(input.threadId, key), { force: true });
    } else {
      yield* writeAtomically(sessionPath(input.threadId, key), (to) =>
        fileSystem.copyFile(path.join(input.tmpDir, snapshot), to),
      );
      failedRestores.delete(copyId(input.threadId, key));
    }
    yield* writeRecord({
      threadId: input.threadId,
      file,
      kind: input.kind,
      recovery: snapshot !== undefined,
      keptAt: yield* Clock.currentTimeMillis,
    });
  });

  const forgetCopy = Effect.fn("HostedBlender.forgetCopy")(function* (
    threadId: string,
    key: string,
  ) {
    failedRestores.delete(copyId(threadId, key));
    const kept = records.get(threadId);
    if (!kept?.delete(key)) return false;
    if (kept.size === 0) records.delete(threadId);
    yield* fileSystem
      .remove(copyDir(threadId, key), { recursive: true, force: true })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("couldn't remove a hosted Blender's recovery copy", { cause }),
        ),
      );
    return true;
  });

  /** Saved beside the launch as they change, so salvage can apply the same cleanup. */
  const writeRunFacts = (instance: Instance) =>
    instance.stateDir === null
      ? Effect.void
      : writeAtomically(path.join(instance.stateDir, "run.json"), (to) =>
          fileSystem.writeFileString(
            to,
            encodeRunFacts({
              restore: instance.restore,
              endFile: instance.endFile,
              saved: instance.saved,
              retires: instance.retires,
              clean: instance.clean,
            }),
          ),
        ).pipe(Effect.ignore);

  /** Applies a run's cleanup, its end or salvaged; a failure leaves the launch for later. */
  const applyCleanup = Effect.fnUntraced(function* (
    run: {
      readonly threadId: ThreadId;
      readonly endFile: EndFile;
      readonly tmpDir: string;
      /**
       * The copy its last save retires; any other, kept since, outlives that save. `any` for
       * facts from before saves named one.
       */
      readonly retires: number | null | "any";
    },
    cleanup: ReturnType<typeof cleanupOf>,
  ) {
    const key = fileKeyOf(run.endFile.file);
    if (cleanup.action === "keep") {
      yield* keepCopy({ ...run, kind: cleanup.kind });
    } else if (
      cleanup.action === "forget" &&
      (run.retires === "any" || records.get(run.threadId)?.get(key)?.keptAt === run.retires)
    ) {
      yield* forgetCopy(run.threadId, key);
    }
  });

  // Only a helper running in this launch folder, with the folder in its arguments, is ours.
  const leftoverHelperAlive = (pid: number, launchDir: string) =>
    Effect.all([
      fileSystem.readLink(`/proc/${pid}/cwd`),
      fileSystem.readFileString(`/proc/${pid}/cmdline`),
      fileSystem.realPath(launchDir),
    ]).pipe(
      Effect.map(
        ([cwd, cmdline, real]) =>
          cwd === real && cmdline.split("\0").some((arg) => arg === launchDir || arg === real),
      ),
      Effect.orElseSucceed(() => false),
    );

  // /proc/<pid>/stat is "pid (comm) state ppid pgrp ..."; comm may hold spaces and parens.
  const processGroupOf = (pid: string) =>
    fileSystem.readFileString(`/proc/${pid}/stat`).pipe(
      Effect.map((stat) => {
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return fields[0] === "Z" ? null : Number(fields[2]);
      }),
      Effect.orElseSucceed(() => null),
    );

  /**
   * The live processes of a leftover launch: the helper, and the members of its process group
   * (it leads one) whose arguments name the launch folder, as Blender's and labwc's do.
   */
  const leftoverProcesses = Effect.fnUntraced(function* (helperPid: number, launchDir: string) {
    const real = yield* fileSystem.realPath(launchDir).pipe(Effect.orElseSucceed(() => launchDir));
    const pids = (yield* fileSystem
      .readDirectory("/proc")
      .pipe(Effect.orElseSucceed(() => []))).filter((entry) => /^\d+$/.test(entry));
    const members = yield* Effect.forEach(pids, (pid) =>
      Effect.gen(function* () {
        if ((yield* processGroupOf(pid)) !== helperPid) return null;
        const cmdline = yield* fileSystem
          .readFileString(`/proc/${pid}/cmdline`)
          .pipe(Effect.orElseSucceed(() => ""));
        return cmdline.includes(launchDir) || cmdline.includes(real) ? Number(pid) : null;
      }),
    );
    const live = members.filter((pid) => pid !== null);
    // Not its group's leader, the helper is still ours when it runs in the folder.
    if (!live.includes(helperPid) && (yield* leftoverHelperAlive(helperPid, launchDir))) {
      live.push(helperPid);
    }
    return live;
  });

  // A helper from a server that died stops Blender itself once asked. Whatever of its launch
  // outlasts the grace is killed. True once nothing of it is running, so its files can be
  // collected; a launch still running after that (Blender stuck in the kernel) is left alone.
  const stopLeftover = Effect.fnUntraced(function* (helperPid: number, launchDir: string) {
    const gone = (timeout: Duration.Input) =>
      leftoverProcesses(helperPid, launchDir).pipe(
        Effect.repeat({
          while: (left) => left.length > 0,
          schedule: Schedule.spaced("500 millis"),
        }),
        Effect.timeoutOption(timeout),
      );
    // One released at shutdown is still writing its quit copy: it exits once that is done.
    const released =
      (yield* fileSystem
        .readFileString(path.join(launchDir, "outcome"))
        .pipe(Effect.orElseSucceed(() => ""))) === "released";
    if (released && Option.isSome(yield* gone(RELEASED_FINISH_TIMEOUT))) return true;
    const running = yield* leftoverProcesses(helperPid, launchDir);
    if (running.length === 0) return true;
    const asked = running.includes(helperPid) ? [helperPid] : running;
    yield* Effect.sync(() => asked.forEach((pid) => signalProcess(pid, "SIGTERM")));
    if (Option.isSome(yield* gone(LEFTOVER_STOP_TIMEOUT))) return true;
    const left = yield* leftoverProcesses(helperPid, launchDir);
    yield* Effect.sync(() => left.forEach((pid) => signalProcess(pid, "SIGKILL")));
    return Option.isSome(yield* gone(Duration.seconds(1)));
  });

  /** Keeps what a launch a stopped server left behind holds, then removes it. */
  const salvage = Effect.fn("HostedBlender.salvage")(
    function* (launchDir: string) {
      const launch = decodeLaunchRecord(
        yield* fileSystem
          .readFileString(path.join(launchDir, "launch.json"))
          .pipe(Effect.orElseSucceed(() => "")),
      );
      if (Option.isSome(launch)) {
        const read = (name: string) =>
          fileSystem
            .readFileString(path.join(launchDir, name))
            .pipe(Effect.orElseSucceed(() => ""));
        const { threadId, relativePath } = launch.value;
        // Without facts, the file it launched with, and nothing known to be saved.
        const facts: typeof RunFacts.Type = Option.getOrElse(
          decodeRunFacts(yield* read("run.json")),
          () => ({
            restore: "none" as const,
            endFile: { file: { kind: "workspace" as const, relativePath }, path: null, since: 0 },
            saved: false,
            clean: false,
          }),
        );
        // T3 was closing it, or it stopped with the server: a crash, for all T3 knows.
        const outcome = yield* read("outcome");
        const ending = outcome === "closing" || outcome === "released" ? "closed" : "crashed";
        // A launch from before reloads staged nothing.
        const { role, workspaceRoot } = launch.value;
        if (role !== undefined && workspaceRoot !== undefined) {
          yield* keepStagedLeft({
            owner: threadId,
            role,
            workspaceRoot,
            tmpDir: path.join(launchDir, "tmp"),
          });
        }
        yield* applyCleanup(
          {
            threadId,
            endFile: facts.endFile,
            tmpDir: path.join(launchDir, "tmp"),
            retires: facts.retires === undefined ? "any" : facts.retires,
          },
          cleanupOf({ ...facts, ending }),
        );
      }
      yield* fileSystem.remove(launchDir, { recursive: true, force: true });
    },
    // A launch that can't be salvaged stays for the next start to try again.
    Effect.catch((cause) => Effect.logWarning("couldn't salvage a hosted Blender", { cause })),
  );

  // The copies earlier runs of this server kept, read before the service takes any request. A
  // folder that can't be read is skipped, never a failed start.
  const readRecords = Effect.gen(function* () {
    const recoveryRoot = path.join(rootDir, "recovery");
    const readText = (file: string) =>
      fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    for (const entry of yield* fileSystem
      .readDirectory(recoveryRoot)
      .pipe(Effect.orElseSucceed(() => []))) {
      const threadDir = path.join(recoveryRoot, entry);
      yield* Effect.gen(function* () {
        for (const copy of yield* fileSystem
          .readDirectory(threadDir)
          .pipe(Effect.orElseSucceed(() => []))) {
          const record = decodeRecoveryRecord(
            yield* readText(path.join(threadDir, copy, "record.json")),
          );
          // A record whose copy never arrived is offered only once salvage brings it.
          if (
            Option.isSome(record) &&
            copyDir(record.value.threadId, fileKeyOf(record.value.file)) ===
              path.join(threadDir, copy) &&
            (!record.value.recovery ||
              (yield* fileSystem
                .exists(path.join(threadDir, copy, "session.blend"))
                .pipe(Effect.orElseSucceed(() => false))))
          ) {
            const kept = records.get(record.value.threadId) ?? new Map<string, RecoveryRecord>();
            kept.set(fileKeyOf(record.value.file), record.value);
            records.set(record.value.threadId, kept);
          }
        }
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("skipped a hosted Blender recovery folder", { threadDir, cause }),
        ),
      );
    }
  });

  // The launch folders of Blenders a stopped server didn't finish ending. Stopping them can take
  // seconds, so it runs beside the service; whatever reads or changes copies waits for it.
  const salvageLeftovers = Effect.gen(function* () {
    const leftovers = (yield* fileSystem
      .readDirectory(launchesDir)
      .pipe(Effect.orElseSucceed(() => []))).map((entry) => path.join(launchesDir, entry));
    // Every leftover's Blender is stopped at once, so several cost one grace period.
    const quiet = yield* Effect.forEach(
      leftovers,
      (launchDir) =>
        fileSystem.readFileString(path.join(launchDir, "launch.json")).pipe(
          Effect.map((text) => Option.getOrUndefined(decodeLaunchRecord(text))?.helperPid),
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap((helperPid) =>
            helperPid === undefined ? Effect.succeed(true) : stopLeftover(helperPid, launchDir),
          ),
        ),
      { concurrency: "unbounded" },
    );
    for (const [index, launchDir] of leftovers.entries()) {
      if (quiet[index]) {
        yield* salvage(launchDir);
      } else {
        // Its copy may still be being written; the next start tries again.
        yield* Effect.logWarning("a hosted Blender from before outlived being stopped", {
          launchDir,
        });
      }
    }
  });
  yield* readRecords;
  yield* publishNow();
  const salvaged = yield* Deferred.make<void>();
  yield* salvageLeftovers.pipe(
    Effect.andThen(publishNow()),
    Effect.ensuring(Deferred.succeed(salvaged, undefined)),
    Effect.forkIn(serviceScope),
  );
  /** Done once what a stopped server left is kept, so no request acts on copies before it. */
  const afterSalvage = Deferred.await(salvaged);

  const broadcast = (instance: Instance, message: HostedBlenderStreamServerMessage) =>
    Effect.forEach(
      instance.viewers,
      (viewer) => Queue.offer(viewer.queue, { _tag: "message", message }),
      { discard: true },
    );

  const controlMessage = (
    instance: Instance,
    viewer: ViewerEntry,
  ): HostedBlenderStreamServerMessage => ({
    type: "control",
    canOperate: viewer.canOperate,
    controller:
      instance.session.controller === null
        ? "unclaimed"
        : instance.session.controller === viewer.id
          ? "you"
          : "another-viewer",
  });

  const broadcastControl = (instance: Instance) =>
    Effect.forEach(
      instance.viewers,
      (viewer) =>
        Queue.offer(viewer.queue, { _tag: "message", message: controlMessage(instance, viewer) }),
      { discard: true },
    );

  // Both run inside the session's order, so a handoff's releases follow everything the last
  // controller sent and nothing it sent can land after them.
  const sendInput = (instance: Instance, command: HelperCommand) =>
    runPromise(
      Effect.suspend(() =>
        instance.held.shouldSend(command) ? instance.helper(command) : Effect.void,
      ),
    );
  const releaseHeld = (instance: Instance) =>
    runPromise(
      Effect.suspend(() =>
        Effect.forEach(instance.held.releaseAll(), instance.helper, { discard: true }),
      ),
    );
  // Refusals (control changed, Blender gone) mean the input no longer applies.
  const settle = (work: Promise<unknown>) =>
    Effect.promise(() => work.then(constUndefined, constUndefined));

  /** The viewer that most recently opened or showed its pane, among those that `match`. */
  const latestShown = (instance: Instance, match: (viewer: ViewerEntry) => boolean) => {
    let latest: ViewerEntry | null = null;
    for (const viewer of instance.viewers) {
      if (match(viewer) && (latest === null || viewer.shownAt > latest.shownAt)) latest = viewer;
    }
    return latest;
  };

  /** The viewer whose acks set the bitrate: the one in control, else the latest on screen. */
  const leadViewer = (instance: Instance) =>
    instance.viewers.find(
      (viewer) => viewer.visible && viewer.id === instance.session.controller,
    ) ?? latestShown(instance, (viewer) => viewer.visible);

  // The display follows the viewer in control, or else the latest pane shown. A floating
  // player that never sends a size leaves the display as it is.
  const applySize = (instance: Instance) =>
    Effect.suspend(() => {
      const sizer =
        instance.viewers.find(
          (viewer) => viewer.size !== null && viewer.id === instance.session.controller,
        ) ??
        latestShown(instance, (viewer) => viewer.size !== null && viewer.visible) ??
        latestShown(instance, (viewer) => viewer.size !== null);
      if (sizer?.size == null) return Effect.void;
      const size = displaySize(sizer.size.width, sizer.size.height);
      const key = `${size.width}x${size.height}`;
      if (key === instance.displaySize) return Effect.void;
      instance.displaySize = key;
      return instance.helper({ type: "resize", ...size });
    });

  // Runs from both a viewer's input and its detach, inside their spans.
  const releaseControl = Effect.fnUntraced(function* (instance: Instance, viewer: ViewerEntry) {
    if (instance.session.controller !== viewer.id) return;
    const releasing = instance.session.disconnect(viewer.id, () => releaseHeld(instance));
    yield* broadcastControl(instance);
    yield* settle(releasing);
    yield* applySize(instance);
  });

  // Input arrives for every pointer move; it shares the viewer's stream span.
  const handleViewerInput = Effect.fnUntraced(function* (
    instance: Instance,
    viewer: ViewerEntry,
    message: HostedBlenderViewerMessage,
  ) {
    const owner = instance.session.controller;
    switch (message.type) {
      case "takeControl": {
        if (!viewer.canOperate || owner === viewer.id) return;
        // Someone else won the race: tell this viewer, whose view of control is stale.
        if (owner !== null && !message.takeOver) {
          return yield* Queue.offer(viewer.queue, {
            _tag: "message",
            message: controlMessage(instance, viewer),
          });
        }
        const handoff =
          owner === null
            ? Promise.resolve()
            : instance.session.disconnect(owner, () => releaseHeld(instance));
        const taking = instance.session.take(viewer.id);
        yield* broadcastControl(instance);
        yield* settle(Promise.all([handoff, taking]));
        return yield* applySize(instance);
      }
      case "releaseControl":
        return yield* releaseControl(instance, viewer);
      default: {
        if (owner !== viewer.id) return;
        const command = helperCommandForInput(message);
        return yield* settle(instance.session.human(viewer.id, () => sendInput(instance, command)));
      }
    }
  });

  const statsMessage = (instance: Instance): HostedBlenderStreamServerMessage | null =>
    instance.stats === null
      ? null
      : { type: "stats", ...instance.stats, memoryBytes: instance.memoryBytes };

  // Keyframe requests, packets, control lines, memory samples and viewer detaches run many times
  // per instance; they share its `HostedBlender.run` span instead of each opening one.
  const requestKeyframe: (instance: Instance) => Effect.Effect<void> = Effect.fnUntraced(function* (
    instance: Instance,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const wait = instance.lastKeyframeRequest + KEYFRAME_REQUEST_INTERVAL_MS - now;
    if (wait > 0) {
      // Deferred, not dropped: on an idle viewport no later frame would ask again.
      if (instance.keyframeDeferred) return;
      instance.keyframeDeferred = true;
      yield* Effect.sleep(wait).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            instance.keyframeDeferred = false;
            return requestKeyframe(instance);
          }),
        ),
        Effect.forkIn(serviceScope),
      );
      return;
    }
    instance.lastKeyframeRequest = now;
    yield* instance.helper({ type: "keyframe" });
  });

  const setBitrate = (instance: Instance, kbps: number | null) =>
    kbps === null ? Effect.void : instance.helper({ type: "bitrate", kbps });

  // With no viewer on screen, capture and encoding stop entirely; the helper resumes on a
  // keyframe.
  const applyCapture = (instance: Instance) =>
    Effect.suspend(() => {
      // A Blender being saved, closed or quit is left as it is; a failed save catches up.
      if (instance.quitting || instance.closeRequested || instance.pendingSave !== null) {
        return Effect.void;
      }
      const wanted = instance.viewers.some((viewer) => viewer.visible);
      if (wanted === instance.capturing) return Effect.void;
      instance.capturing = wanted;
      return instance.helper({ type: wanted ? "resume" : "pause" });
    });

  // A viewer that joins or shows its pane starts on a keyframe, whatever was asked for lately.
  const joinOnKeyframe = (instance: Instance) =>
    Effect.suspend(() => {
      instance.lastKeyframeRequest = Number.NEGATIVE_INFINITY;
      return requestKeyframe(instance);
    });

  const handlePacket = Effect.fnUntraced(function* (instance: Instance, packet: HelperPacket) {
    if (packet._tag === "video") {
      const now = yield* Clock.currentTimeMillis;
      // A viewer that falls behind is slower than Blender's frame rate, which a lower bitrate
      // can't fix; it resyncs on a keyframe, and only ack delay moves the bitrate.
      let wantsKeyframe = false;
      for (const viewer of instance.viewers) {
        if (!viewer.visible) continue;
        const offered = viewer.flow.offer(packet, now);
        if (offered.send) yield* Queue.offer(viewer.queue, { _tag: "frame", data: packet.data });
        wantsKeyframe ||= offered.requestKeyframe;
      }
      if (wantsKeyframe) yield* requestKeyframe(instance);
      return;
    }
    const event = packet.event;
    switch (event.type) {
      case "ready": {
        instance.stats = { encoder: event.encoder, target: event.target };
        // Sizes asked for before the helper ran went nowhere; ask for the wanted one now.
        instance.displaySize = `${event.width}x${event.height}`;
        yield* applySize(instance);
        instance.capturing = true;
        yield* applyCapture(instance);
        const stats = statsMessage(instance);
        if (stats) yield* broadcast(instance, stats);
        // Without window capture there is no `windowCaptured`; the whole display is the stream.
        if (event.target === "output") yield* markRunning(instance);
        return;
      }
      case "windowCaptured":
        return yield* markRunning(instance);
      case "frameSize":
        instance.viewport = { width: event.width, height: event.height };
        return yield* broadcast(instance, { type: "viewport", ...instance.viewport });
      case "exited":
        if (event.process === "blender") {
          instance.blenderExit = { code: event.code, signal: event.signal };
        }
        // labwc or Blender is gone; the helper has nothing left to show.
        return yield* instance.helper({ type: "quit" });
      case "error":
        return yield* Effect.logWarning("hosted Blender's hidden display reported an error", {
          message: event.message,
        });
      case "cursorLeave":
      case "cursorEnter": {
        const captured = event.type === "cursorLeave";
        if (instance.cursorCaptured === captured) return;
        instance.cursorCaptured = captured;
        return yield* broadcast(instance, { type: "cursor", captured });
      }
      case "windowClosed":
        return;
    }
  });

  // Running once Blender shows its viewport window and any restore asked for has succeeded.
  const markRunning = Effect.fnUntraced(function* (instance: Instance) {
    instance.shown = true;
    if (instance.status === "running" || instance.restore === "pending") return;
    if (instance.restore === "failed") return;
    instance.status = "running";
    yield* publishNow();
  });

  const updateRestore = Effect.fnUntraced(function* (
    instance: Instance,
    result: "ok" | "failed",
    loadedAt: number | undefined,
  ) {
    // Every later report repeats the result; only this one saw the copy restored.
    if (instance.restore !== "pending") return;
    instance.restore = result;
    yield* writeRunFacts(instance);
    if (result === "ok") {
      const restored = records.get(ownerOf(instance))?.get(fileKeyOf(instance.endFile.file));
      instance.contained = { keptAt: restored?.keptAt, loadedAt };
      if (instance.shown) yield* markRunning(instance);
      return yield* checkWaitingDisk(instance);
    }
    // The file as saved is open instead; quitting it keeps the copy for another try.
    failedRestores.add(copyId(ownerOf(instance), fileKeyOf(instance.endFile.file)));
    yield* quitWithoutSaving(instance).pipe(Effect.forkIn(serviceScope));
  });

  const setAgentListener = Effect.fnUntraced(function* (
    instance: Instance,
    state: AgentListenerState,
  ) {
    instance.agentListener = state;
    // A master's agents are told it's ready only once their ports reach it.
    if (instance.role === "master") yield* syncForwards(instance);
    if (state !== "starting") yield* Deferred.succeed(instance.agentListenerSettled, undefined);
  });

  /**
   * A master's listener is reached only through the ports of the agent threads using it, each
   * open while that thread may copy back and the listener is ready.
   */
  const syncForwards = Effect.fn("HostedBlender.syncForwards")((instance: Instance) =>
    instance.forwardLock.withPermits(1)(
      Effect.gen(function* () {
        // Only the agent session that asked, while it is still the thread's, keeps its relay.
        for (const threadId of instance.agentThreads) {
          if (!(yield* sessionCurrent(threadId))) instance.agentThreads.delete(threadId);
        }
        const ready = instance.agentListener === "ready" && !instance.agentListenerRevoked;
        // A relay serves the session it was opened for; a newer one gets a fresh relay.
        for (const [threadId, relay] of instance.forwards) {
          const session = threadMasters.get(threadId)?.agentSession ?? null;
          if (ready && instance.agentThreads.has(threadId) && relay.session === session) continue;
          instance.forwards.delete(threadId);
          yield* Scope.close(relay.scope, Exit.void);
        }
        if (!ready || Option.isNone(agents) || instance.mcpPort === null) return;
        for (const threadId of instance.agentThreads) {
          if (instance.forwards.has(threadId)) continue;
          const listenPort = yield* agents.value.masterListenerPort(threadId);
          if (listenPort === null) continue;
          const scope = yield* Scope.make();
          const opened = yield* forwardLoopbackPort({
            listenPort,
            targetPort: instance.mcpPort,
            // As Blender's add-on checks its own clients: only this OS account's connections.
            accept: (socket) =>
              runPromise(
                isSameAccountPeer(socket).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                ),
              ),
          }).pipe(Scope.provide(scope), Effect.isSuccess);
          const session = threadMasters.get(threadId)?.agentSession ?? null;
          if (opened) instance.forwards.set(threadId, { scope, session });
          else yield* Scope.close(scope, Exit.void);
        }
      }),
    ),
  );

  /** The agent session that asked for the thread's master is still the thread's. */
  const sessionCurrent = Effect.fnUntraced(function* (threadId: ThreadId) {
    const session = threadMasters.get(threadId)?.agentSession ?? null;
    if (session === null || Option.isNone(agents)) return false;
    return (yield* agents.value.currentSession(threadId)) === session;
  });

  /** Granted once Blender has shown it has the launch file open, and a master an agent too. */
  // Runs for every control line; it shares the instance's run span.
  const maybeGrant = Effect.fnUntraced(function* (instance: Instance) {
    if (
      instance.agentListenerGranted &&
      !instance.agentListenerGrantSent &&
      !instance.agentListenerRevoked &&
      instance.openFile === instance.blendPath &&
      (instance.role === "working" || instance.agentThreads.size > 0) &&
      instance.control
    ) {
      // A master listens only for an agent session still current; a stale one never starts it.
      if (instance.role === "master") {
        let current = false;
        for (const threadId of instance.agentThreads) current ||= yield* sessionCurrent(threadId);
        if (!current) return;
      }
      instance.agentListenerGrantSent = true;
      yield* instance.control.write(GRANT_AGENT_LISTENER);
    }
  });

  // Switching agents off, or the thread's session ending, closes the listener and every
  // connection to it. The pane keeps working.
  const revokeAgentListener = Effect.fnUntraced(function* (
    instance: Instance,
    reason: AgentAccessEnded = "revoked",
  ) {
    if (instance.agentListener === "off" || instance.agentListenerRevoked) return;
    instance.agentListenerRevoked = true;
    instance.agentAccessEnded = reason;
    yield* setAgentListener(instance, "off");
    if (instance.control) yield* instance.control.write(STOP_AGENT_LISTENER);
    if (instance.agentActing) {
      instance.agentActing = false;
      yield* publishNow();
    }
  });

  /** T3 is ending this Blender: a settle close, a quit, a save that will quit, or a shutdown. */
  const closingByT3 = (instance: Instance) =>
    instance.quitting ||
    instance.closeRequested ||
    instance.ending ||
    instance.pendingSave !== null;

  /**
   * Records what Blender says of the file it has open, which the run's end keeps a copy of:
   * the file, whether it is unsaved, and whether its last word was a confirmed save.
   */
  const noteFile = Effect.fnUntraced(function* (
    instance: Instance,
    filepath: string,
    dirty: boolean,
    options: {
      readonly loadedAt?: number | undefined;
      readonly saved?: boolean;
      /** Saved now: an autosave from before this is older than the file on disk. */
      readonly savedAt?: number;
      /** With `saved`, the copy that save retires. */
      readonly retires?: number | null;
    } = {},
  ) {
    const openFile = filepath === "" ? null : filepath;
    const facts = () =>
      `${fileKeyOf(instance.endFile.file)}:${instance.endFile.since}:${instance.saved}:${instance.retires}:${instance.clean}`;
    const before = facts();
    // Before anything that waits, so the run's end always sees the file this names.
    const switched = openFile !== instance.openFile;
    if (switched) {
      instance.openFile = openFile;
      const file =
        instance.role === "master"
          ? masterFileOf(filepath)
          : keptFileOf(filepath, instance.workspaceRoot, path.relative);
      if (fileKeyOf(file) !== fileKeyOf(instance.endFile.file)) {
        instance.endFile = { file, path: openFile, since: yield* Clock.currentTimeMillis };
        instance.saved = false;
      }
    }
    // Any load, the same file's revert included: an autosave from before it is not its work.
    if (options.loadedAt !== undefined && options.loadedAt !== instance.loadedAt) {
      instance.loadedAt = options.loadedAt;
      instance.endFile = { ...instance.endFile, since: options.loadedAt };
    }
    if (options.savedAt !== undefined) {
      instance.endFile = { ...instance.endFile, since: options.savedAt };
    }
    if (dirty) instance.saved = false;
    if (options.saved !== undefined) instance.saved = options.saved;
    if (options.retires !== undefined) instance.retires = options.retires;
    instance.clean = !dirty;
    if (switched) {
      instance.openRealPath =
        openFile === null
          ? null
          : yield* fileSystem.realPath(openFile).pipe(Effect.orElseSucceed(() => openFile));
      yield* SubscriptionRef.set(
        instance.watched,
        openFile === null ? [] : [...new Set([openFile, instance.openRealPath ?? openFile])],
      );
    }
    if (before !== facts()) {
      yield* writeRunFacts(instance);
    }
  });

  const paneShown = (instance: Instance) => instance.viewers.some((viewer) => viewer.visible);

  /**
   * The open file may have changed on disk: the add-on compares it with what Blender read or
   * saved itself, and reloads at once only while a pane shows it. Otherwise it reloads when a pane
   * next shows it, or before the agent's next call.
   */
  const checkDisk: (instance: Instance) => Effect.Effect<void> = Effect.fnUntraced(function* (
    instance: Instance,
  ) {
    const control = instance.control;
    if (control === null || instance.quitting || instance.closeRequested || instance.ending) {
      return;
    }
    // Checked once the save or restore is over: the add-on would only hold it till then, and a
    // refused save leaves the change to catch up with.
    if (instance.pendingSave !== null || instance.restore === "pending") {
      instance.diskCheckWaiting = true;
      return;
    }
    instance.diskCheckWaiting = false;
    const file = instance.openRealPath;
    if (file === null) return;
    yield* control.write(
      `${encodeDiskChanged({
        type: "diskChanged",
        path: file,
        revision: yield* readFileRevision(file),
        reload: paneShown(instance),
      })}\n`,
    );
  });

  const checkWaitingDisk = (instance: Instance) =>
    instance.diskCheckWaiting ? checkDisk(instance) : Effect.void;

  /** A Blender out of date with its file catches up once a pane shows it. */
  const askReload = (instance: Instance) =>
    instance.stale && paneShown(instance) ? checkDisk(instance) : Effect.void;

  /** Nothing is reloaded for a pane nobody can see; the agent's next call still catches up. */
  const panesGone = (instance: Instance) =>
    instance.stale && !paneShown(instance) && instance.control !== null
      ? instance.control.write(PANES_HIDDEN)
      : Effect.void;

  /** The file a path Blender reports is, as its run's copies name it. */
  const keptFileFor = (role: HostedBlenderRole, workspaceRoot: string, filepath: string) =>
    role === "master"
      ? fileSystem.realPath(filepath).pipe(
          Effect.orElseSucceed(() => filepath),
          Effect.map(masterFileOf),
        )
      : Effect.succeed(keptFileOf(filepath, workspaceRoot, path.relative));

  /**
   * Work Blender staged before a reload or restore becomes the copy of the file it names,
   * replacing an older copy of that file only. Its note goes last, so a failure leaves both for
   * salvage.
   */
  const keepStaged = Effect.fnUntraced(function* (input: {
    readonly owner: ThreadId;
    readonly role: HostedBlenderRole;
    readonly workspaceRoot: string;
    readonly tmpDir: string;
    readonly name: string;
    readonly filepath: string;
  }) {
    if (path.basename(input.name) !== input.name || !/^t3-reload-\d+\.blend$/.test(input.name)) {
      return null;
    }
    const from = path.join(input.tmpDir, input.name);
    const info = yield* fileSystem.lstat(from).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return null;
    const file = yield* keptFileFor(input.role, input.workspaceRoot, input.filepath);
    const key = fileKeyOf(file);
    const record: RecoveryRecord = {
      threadId: input.owner,
      file,
      kind: "closed",
      recovery: true,
      keptAt: yield* Clock.currentTimeMillis,
      reloaded: true,
    };
    // Record, move, then note, so a crash at any step leaves salvage what it needs to finish;
    // the copy is offered only once both are in place.
    yield* fileSystem.makeDirectory(copyDir(input.owner, key), { recursive: true });
    yield* writeRecordFile(record);
    // On the same disk a rename, which costs nothing however large the file is.
    yield* fileSystem
      .rename(from, sessionPath(input.owner, key))
      .pipe(
        Effect.catch(() =>
          writeAtomically(sessionPath(input.owner, key), (to) => fileSystem.copyFile(from, to)),
        ),
      );
    failedRestores.delete(copyId(input.owner, key));
    rememberRecord(record);
    yield* fileSystem.remove(from.replace(/\.blend$/, ".json"), { force: true });
    return key;
  });

  const keepReloadCopy = (instance: Instance, name: string, filepath: string) =>
    instance.stateDir === null
      ? Effect.succeed(null)
      : keepStaged({
          owner: ownerOf(instance),
          role: instance.role,
          workspaceRoot: instance.workspaceRoot,
          tmpDir: path.join(instance.stateDir, "tmp"),
          name,
          filepath,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("couldn't keep a hosted Blender's changes before its reload", {
              cause,
            }).pipe(Effect.as(null)),
          ),
        );

  /** Whatever a launch staged and T3 never kept, oldest first, before its end keeps its own. */
  const keepStagedLeft = Effect.fnUntraced(function* (input: {
    readonly owner: ThreadId;
    readonly role: HostedBlenderRole;
    readonly workspaceRoot: string;
    readonly tmpDir: string;
  }) {
    const notes = (yield* fileSystem
      .readDirectory(input.tmpDir)
      .pipe(Effect.orElseSucceed(() => [])))
      .filter((name) => /^t3-reload-\d+\.json$/.test(name))
      .toSorted((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
    for (const note of notes) {
      const filepath = decodeStagedNote(
        yield* fileSystem
          .readFileString(path.join(input.tmpDir, note))
          .pipe(Effect.orElseSucceed(() => "")),
      );
      if (Option.isNone(filepath)) continue;
      yield* keepStaged({
        ...input,
        name: note.replace(/\.json$/, ".blend"),
        filepath: filepath.value.filepath,
      });
    }
  });

  const handleControlLine = Effect.fnUntraced(function* (instance: Instance, line: string) {
    const message = decodeControlMessage(line);
    if (Option.isNone(message)) return;
    switch (message.value.type) {
      case "hello":
        instance.pid = message.value.pid;
        return;
      case "state": {
        if (message.value.restore !== undefined) {
          // Blender restores the path the copy was saved from; saving must not write elsewhere
          // than the file it reopened (a workspace moved, say), so then the copy is kept unsaved.
          const target = message.value.filepath;
          const saves =
            target === instance.blendPath ||
            (target !== "" &&
              (yield* fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => ""))) ===
                instance.blendPath);
          yield* updateRestore(
            instance,
            message.value.restore === "ok" && saves ? "ok" : "failed",
            message.value.loadedAt,
          );
        }
        const openBefore = instance.openFile;
        // Its quit pushes an undo step for the quit copy, so a report after "quitting" is always
        // unsaved and says nothing about the person's work; "quitting" itself carried the facts.
        if (!instance.quitHeard) {
          yield* noteFile(instance, message.value.filepath, message.value.dirty, {
            loadedAt: message.value.loadedAt,
          });
        }
        if (message.value.mcpVersion !== undefined) instance.mcpVersion = message.value.mcpVersion;
        const stale = message.value.stale === true;
        const blocked = message.value.staleBlocked ?? null;
        if (stale !== instance.stale || blocked !== instance.staleBlocked) {
          const caughtUp = stale !== instance.stale;
          instance.stale = stale;
          instance.staleBlocked = blocked;
          if (caughtUp) yield* askReload(instance);
          yield* publishNow();
        }
        // Only the working copy T3 opened may reach the agent, so the file is checked before
        // any listener state is taken; the add-on closes it too.
        const listener = message.value.agentListener;
        if (message.value.filepath !== instance.blendPath) {
          yield* revokeAgentListener(instance, "otherFile");
        } else {
          if (listener !== undefined && !instance.agentListenerRevoked) {
            yield* setAgentListener(instance, listener);
          }
          yield* maybeGrant(instance);
        }
        // A report queued before T3 revoked access is stale: nothing acts after that.
        const agentActing = message.value.agentActing === true && !instance.agentListenerRevoked;
        if (
          instance.dirty === message.value.dirty &&
          instance.agentActing === agentActing &&
          instance.openFile === openBefore
        ) {
          return;
        }
        instance.dirty = message.value.dirty;
        instance.agentActing = agentActing;
        return yield* publishNow();
      }
      case "quitting":
        instance.acknowledged = true;
        if (!instance.quitHeard) {
          instance.quitHeard = true;
          yield* noteFile(instance, message.value.filepath, message.value.dirty);
        }
        return;
      case "quitRefused":
        if (instance.quitRefused !== null && instance.quitRefused.id === message.value.id) {
          yield* Deferred.succeed(instance.quitRefused.done, undefined);
        }
        return;
      case "quitCancelled":
        if (instance.quitCancelled?.id === message.value.id) {
          yield* Deferred.succeed(instance.quitCancelled.done, undefined);
        }
        return;
      case "saved":
        // A save retires the copy whose work it held, judged against the load it was saved from
        // (a revert saved at once holds none); a restore that never succeeded held none.
        const retires =
          instance.restore === "pending" || instance.restore === "failed"
            ? null
            : copyRetiredBySave(instance, message.value.loadedAt ?? instance.loadedAt);
        if (message.value.quit === false) {
          yield* noteFile(instance, message.value.filepath, message.value.dirty, {
            saved: true,
            savedAt: yield* Clock.currentTimeMillis,
            retires,
          });
          if (
            retires !== null &&
            (yield* forgetCopy(ownerOf(instance), fileKeyOf(instance.endFile.file)))
          ) {
            yield* publishNow();
          }
          return;
        }
        instance.saveConfirmed = true;
        // A confirmed save only if nothing was left unsaved, recorded with the file saved
        // before the save is answered, so salvage after a restart reads the same.
        yield* noteFile(instance, message.value.filepath, message.value.dirty, {
          saved: !message.value.dirty,
          retires,
        });
        // The add-on ended the grant before saying so; Blender quits next.
        yield* revokeAgentListener(instance);
        if (instance.saveReplies) yield* Queue.offer(instance.saveReplies, "saved");
        return;
      case "checkDisk":
        return yield* Queue.offer(instance.diskNudges, undefined);
      case "reloading":
        instance.keptReload = yield* keepReloadCopy(
          instance,
          message.value.copy,
          message.value.filepath,
        );
        return;
      case "reloaded": {
        // Offered only once its record is written.
        const key = instance.keptReload;
        instance.keptReload = null;
        if (message.value.kept && key !== null) {
          instance.reloadKept = { key, at: yield* Clock.currentTimeMillis };
        }
        return yield* publishNow();
      }
      case "discardRefused":
        if (instance.discardRefused) yield* Deferred.succeed(instance.discardRefused, undefined);
        return;
      case "saving":
      case "quitFailed":
        if (message.value.type === "quitFailed") {
          instance.saveRefusal = message.value.reason;
          // Refused because the file changed: that change is still to be caught up with.
          if (message.value.reason === "changedOnDisk") instance.diskCheckWaiting = true;
        }
        instance.acknowledged = message.value.type === "saving";
        if (instance.saveReplies) yield* Queue.offer(instance.saveReplies, message.value.type);
        return;
      case "reply": {
        const request = instance.requests.get(message.value.id);
        instance.requests.delete(message.value.id);
        if (request) yield* Deferred.succeed(request, message.value.result);
        return;
      }
    }
  });

  const connectControl = Effect.fn("HostedBlender.connectControl")(
    function* (instance: Instance, socketPath: string) {
      const socket = yield* NodeSocket.makeNet({ path: socketPath });
      // The socket appears once Blender has loaded the file and run the add-on.
      const reader = yield* socket.reader.pipe(
        Effect.retry({
          schedule: Schedule.spaced(CONTROL_RETRY_INTERVAL),
          times: CONTROL_CONNECT_ATTEMPTS,
        }),
      );
      const writer = yield* socket.writer;
      const closed = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
      instance.control = { write: (line) => writer.write(line).pipe(Effect.ignore), closed };
      yield* Deferred.succeed(instance.controlReady, undefined);
      // Its last thread left before T3 could ask it to quit; ask now.
      if (instance.retryQuit) yield* retryQuit(instance).pipe(Effect.forkIn(serviceScope));
      // Revoked before the add-on could hear it; a grant waits for its first state.
      if (instance.agentListenerRevoked) yield* instance.control.write(STOP_AGENT_LISTENER);
      const decoder = new TextDecoder();
      let buffer = "";
      return yield* Effect.forever(
        reader.pull.pipe(
          Effect.flatMap((chunks) => {
            for (const chunk of chunks) {
              buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
            }
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            return Effect.forEach(lines, (line) => handleControlLine(instance, line), {
              discard: true,
            });
          }),
        ),
      );
    },
    // The connection's own scope: when Blender's end closes, `quit` stops waiting on it.
    Effect.scoped,
    (effect, instance) =>
      effect.pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            // Nothing more will answer the requests still waiting.
            instance.requests.clear();
            instance.control = null;
            // A Blender T3 is closing drops this connection as it goes; that isn't a loss the
            // agent should work around, and its access already ended with the close.
            const closing = closingByT3(instance);
            if (!closing) instance.controlLost = true;
            // The add-on closes its listener when this connection drops, and nothing reopens it.
            if (!instance.agentListenerRevoked && instance.agentListener !== "off") {
              instance.agentAccessEnded = closing ? "revoked" : "connectionLost";
            }
            instance.agentListenerRevoked = true;
            const wasActing = instance.agentActing;
            instance.agentActing = false;
            return setAgentListener(instance, "off").pipe(
              Effect.andThen(wasActing ? publishNow() : Effect.void),
            );
          }),
        ),
      ),
  );

  // Settings lists every Blender's memory, so it is sampled whether or not anyone watches.
  const sampleMemory = Effect.fnUntraced(function* (instance: Instance) {
    if (instance.pid === null) return;
    const status = yield* fileSystem
      .readFileString(`/proc/${instance.pid}/status`)
      .pipe(Effect.orElseSucceed(() => ""));
    const kilobytes = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
    const memoryBytes = kilobytes === undefined ? null : Number(kilobytes) * 1024;
    if (memoryBytes === instance.memoryBytes) return;
    instance.memoryBytes = memoryBytes;
    yield* publishRunning();
    const stats = statsMessage(instance);
    if (stats && instance.viewers.length > 0) yield* broadcast(instance, stats);
  });

  // Links are skipped, so nothing in the copy leads back to the desktop Blender's files.
  // Each folder level shares the first-use copy's span.
  const copyWithoutLinks: (from: string, to: string) => Effect.Effect<void, PlatformError> =
    Effect.fnUntraced(function* (from: string, to: string) {
      yield* fileSystem.makeDirectory(to, { recursive: true });
      for (const entry of yield* fileSystem.readDirectory(from)) {
        const source = path.join(from, entry);
        const info = yield* fileSystem.lstat(source);
        if (info.type === "Directory") yield* copyWithoutLinks(source, path.join(to, entry));
        else if (info.type === "File") yield* fileSystem.copyFile(source, path.join(to, entry));
      }
    });

  const userBlenderSettings = Effect.fnUntraced(function* () {
    const configHome = environment.XDG_CONFIG_HOME || path.join(homeDirectory, ".config");
    const source = path.join(configHome, "blender");
    const version = newestBlenderConfigVersion(
      yield* fileSystem.readDirectory(source).pipe(Effect.orElseSucceed(() => [])),
    );
    return version === undefined ? undefined : path.join(source, version);
  });

  // Blender Lab is never kept in the settings copy, where Blender could load it at startup.
  const removeBlenderLab = Effect.fnUntraced(function* (userResources: string) {
    const extensions = path.join(userResources, "extensions");
    const repos = yield* fileSystem.readDirectory(extensions).pipe(Effect.orElseSucceed(() => []));
    for (const repo of repos) {
      yield* fileSystem.remove(path.join(extensions, repo, "mcp"), {
        recursive: true,
        force: true,
      });
    }
  });

  // What a folder holds, links left out as copyWithoutLinks leaves them, to tell a whole copy.
  // Each folder level shares the snapshot's span.
  const listFolder: (
    dir: string,
    relative?: string,
  ) => Effect.Effect<ReadonlyArray<string>, PlatformError> = Effect.fnUntraced(function* (
    dir: string,
    relative = "",
  ) {
    const entries: Array<string> = [];
    for (const entry of (yield* fileSystem.readDirectory(path.join(dir, relative))).toSorted()) {
      const child = path.join(relative, entry);
      const info = yield* fileSystem.lstat(path.join(dir, child));
      if (info.type === "Directory") entries.push(`${child}/`, ...(yield* listFolder(dir, child)));
      else if (info.type === "File") {
        const mtime = Option.getOrUndefined(info.mtime)?.getTime() ?? 0;
        entries.push(`${child} ${String(info.size)} ${mtime}`);
      }
    }
    return entries;
  });
  const withoutTimes = (entries: ReadonlyArray<string>) =>
    entries.map((entry) => entry.replace(/ \d+$/, ""));

  /**
   * The user's Blender Lab, copied into a launch's private folder for that Blender alone, or
   * null with none installed or none that holds still while it is copied.
   */
  const snapshotBlenderLab = Effect.fnUntraced(function* (stateDir: string) {
    const settings = yield* userBlenderSettings();
    if (settings === undefined) return null;
    const extensions = path.join(settings, "extensions");
    const repos = (yield* fileSystem
      .readDirectory(extensions)
      .pipe(Effect.orElseSucceed(() => []))).toSorted(
      (a, b) =>
        Number(b === "lab_blender_org") - Number(a === "lab_blender_org") ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
    let installed: string | undefined;
    for (const repo of repos) {
      const candidate = path.join(extensions, repo, "mcp");
      const info = yield* fileSystem.lstat(candidate).pipe(Effect.option);
      const manifest = path.join(candidate, "blender_manifest.toml");
      if (
        Option.isSome(info) &&
        info.value.type === "Directory" &&
        (yield* fileSystem.exists(manifest))
      ) {
        installed = candidate;
        break;
      }
    }
    if (installed === undefined) return null;
    const snapshot = path.join(stateDir, "blender-lab");
    const copy = path.join(snapshot, "mcp");
    for (let attempt = 0; attempt < 3; attempt++) {
      yield* fileSystem.remove(snapshot, { recursive: true, force: true });
      yield* fileSystem.makeDirectory(snapshot, { recursive: true });
      const before = yield* listFolder(installed);
      yield* copyWithoutLinks(installed, copy);
      const after = yield* listFolder(installed);
      const copied = yield* listFolder(copy);
      // Unchanged while it was copied, and all of it copied: one version, whole.
      if (
        before.join("\n") === after.join("\n") &&
        withoutTimes(before).join("\n") === withoutTimes(copied).join("\n")
      ) {
        return snapshot;
      }
    }
    yield* Effect.logWarning("hosted Blender's copy of Blender Lab's MCP kept changing");
    return null;
  });

  // Runs before Blender enables add-ons, so Blender Lab never registers from these settings.
  const writeStartupGate = Effect.fnUntraced(function* (userResources: string) {
    const startup = path.join(userResources, "scripts", "startup");
    yield* fileSystem.makeDirectory(startup, { recursive: true });
    const gate = path.join(startup, "t3_hosted_gate.py");
    yield* fileSystem.writeFileString(`${gate}.partial`, HOSTED_STARTUP_GATE_SOURCE);
    yield* fileSystem.rename(`${gate}.partial`, gate);
  });

  /** T3's own copy of the user's newest Blender settings, made on first use. */
  const ensureUserResources = userResourcesLock.withPermits(1)(
    Effect.gen(function* () {
      const target = path.join(rootDir, "user-resources");
      if (!(yield* fileSystem.exists(target))) {
        const settings = yield* userBlenderSettings();
        const partial = `${target}.partial`;
        yield* fileSystem.remove(partial, { recursive: true, force: true });
        if (settings === undefined) {
          yield* fileSystem.makeDirectory(partial, { recursive: true });
        } else {
          yield* copyWithoutLinks(settings, partial);
        }
        yield* removeBlenderLab(partial);
        yield* fileSystem.rename(partial, target);
      }
      // Copies made before T3 kept Blender Lab out still hold it.
      yield* removeBlenderLab(target);
      yield* writeStartupGate(target);
      return target;
    }),
  );

  const run = Effect.fn("HostedBlender.run")(
    function* (instance: Instance, tools: { readonly helper: string; readonly blender: string }) {
      yield* Effect.annotateCurrentSpan({ threadId: instance.threadId });
      // Everything a launch writes (labwc config, Blender's TMPDIR) goes when it ends, once
      // what it leaves to reopen is kept. Until then, the next start can still salvage it.
      yield* fileSystem.makeDirectory(launchesDir, { recursive: true });
      const stateDir = yield* fileSystem.makeTempDirectory({ directory: launchesDir });
      instance.stateDir = stateDir;
      const launchRecord = {
        threadId: ownerOf(instance),
        relativePath: instance.relativePath,
        role: instance.role,
        workspaceRoot: instance.workspaceRoot,
      };
      // Runs once the helper and Blender have stopped: a closed or crashed Blender's quit copy
      // or newest autosave of the file it ended on is kept as that file's copy. A restore that
      // never succeeded leaves the copy it came from alone.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          // Still writing its copy, which the next start's salvage keeps.
          if (instance.released) return;
          const intent = instance.exitIntent ?? instance;
          yield* keepStagedLeft({
            owner: ownerOf(instance),
            role: instance.role,
            workspaceRoot: instance.workspaceRoot,
            tmpDir: path.join(stateDir, "tmp"),
          });
          yield* applyCleanup(
            {
              threadId: ownerOf(instance),
              endFile: instance.endFile,
              tmpDir: path.join(stateDir, "tmp"),
              retires: instance.retires,
            },
            cleanupOf({
              restore: instance.restore,
              saved: instance.saved,
              clean: instance.clean,
              ending: endingOf({
                wasRunning: instance.status === "running",
                ending: intent.ending || (instance.saveConfirmed && !instance.saved),
                quitting: intent.quitting,
                blenderExit: instance.blenderExit,
              }),
            }),
          );
          yield* fileSystem.remove(stateDir, { recursive: true, force: true });
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("couldn't keep a hosted Blender's recovery copy", { cause }),
          ),
        ),
      );
      yield* writeRunFacts(instance);
      yield* fileSystem.writeFileString(
        path.join(stateDir, "launch.json"),
        encodeLaunchRecord(launchRecord),
      );
      const addonPath = path.join(stateDir, "t3_control.py");
      yield* fileSystem.writeFileString(addonPath, CONTROL_ADDON_SOURCE);
      const userResources = yield* ensureUserResources;
      // Unix socket paths are capped near 108 bytes, so the control socket and the helper's
      // Wayland runtime live in a short private dir.
      const controlDir = yield* fileSystem.makeTempDirectoryScoped({
        directory: runtimeParent(environment.XDG_RUNTIME_DIR),
        prefix: "t3hb-",
      });
      yield* fileSystem.chmod(controlDir, 0o700);
      const controlSocket = path.join(controlDir, "control.sock");
      instance.controlDir = controlDir;
      // A master is shared, so its listener gets a private port its agents' ports relay to.
      const agentPort = Option.isNone(agents)
        ? null
        : instance.role === "master"
          ? (yield* agents.value.agentsAllowed)
            ? yield* agents.value.reservePrivatePort
            : null
          : instance.agentWorkingCopy
            ? yield* agents.value.listenerPort(instance.threadId)
            : null;
      if (agentPort !== null && instance.role === "working" && Option.isSome(agents)) {
        instance.agentSession =
          (yield* agents.value.currentSession(instance.threadId)) ?? undefined;
      }
      if (agentPort === null) yield* setAgentListener(instance, "off");
      const mcpSnapshot =
        agentPort === null
          ? null
          : yield* snapshotBlenderLab(stateDir).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("hosted Blender could not copy Blender Lab's MCP", {
                  cause,
                }).pipe(Effect.as(null)),
              ),
            );
      instance.agentListenerGranted = agentPort !== null;
      const mcpPort = agentPort ?? (yield* net.reserveLoopbackPort());
      instance.mcpPort = agentPort;
      const shell = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.flatMap((threads) => threads.getThreadShell(instance.threadId)),
        Effect.orElseSucceed(() => null),
        Effect.provideContext(lookupContext),
      );
      // The file `open` checked must still be that file, not a link swapped in since.
      if ((yield* fileSystem.realPath(instance.blendPath)) !== instance.blendPath) {
        return yield* Effect.logWarning("hosted Blender's file changed before it started");
      }
      // Read before Blender reads it, so a change made meanwhile still counts as one.
      const revision = yield* readFileRevision(instance.blendPath);

      const handle = yield* Effect.acquireRelease(
        spawner.spawn(
          ChildProcess.make(
            tools.helper,
            helperArguments({
              stateDir,
              userResources,
              blender: tools.blender,
              addonPath,
              blendPath: instance.blendPath,
              controlSocket,
              mcpPort,
              recover: instance.recover,
              revision,
              mcpListen: agentPort !== null,
              ...(mcpSnapshot === null ? {} : { mcpSnapshot }),
              // Plan mode is read-only, whatever the runtime mode. A master serves threads of
              // any mode, so its embedded scripts never run.
              autoRun:
                instance.role === "working" &&
                shell?.runtimeMode === "full-access" &&
                shell.interactionMode !== "plan",
              ...INITIAL_SIZE,
            }),
            {
              cwd: stateDir,
              env: { ...helperEnvironment(environment), XDG_RUNTIME_DIR: controlDir },
              stdin: { stream: "pipe", endOnDone: false },
              stdout: "pipe",
              stderr: "pipe",
              killSignal: "SIGTERM",
              forceKillAfter: Duration.seconds(10),
            },
          ),
        ),
        // Asked to quit, the helper stops Blender and labwc and removes its runtime itself;
        // killing its process group would take its labwc watchdog down first. Out of time on
        // shutdown, it gets a moment, then the group is killed.
        (child) =>
          // Released, it outlives T3: nothing may signal its process group, Blender's included.
          instance.released
            ? child.unref.pipe(Effect.ignore)
            : Stream.run(
                Stream.encodeText(Stream.make(encodeHelperCommand({ type: "quit" }))),
                child.stdin,
              ).pipe(
                Effect.andThen(child.exitCode),
                Effect.timeout(instance.stopNow ? SHUTDOWN_STOP_TIMEOUT : HELPER_QUIT_TIMEOUT),
                Effect.catch(() =>
                  child.kill(
                    instance.stopNow
                      ? { killSignal: "SIGKILL", forceKillAfter: SHUTDOWN_STOP_TIMEOUT }
                      : undefined,
                  ),
                ),
                Effect.ignore,
              ),
      );
      yield* fileSystem.writeFileString(
        path.join(stateDir, "launch.json"),
        encodeLaunchRecord({ ...launchRecord, helperPid: handle.pid }),
      );
      const stdinLock = yield* Semaphore.make(1);
      instance.helper = (command) =>
        stdinLock
          .withPermits(1)(
            Stream.run(Stream.encodeText(Stream.make(encodeHelperCommand(command))), handle.stdin),
          )
          .pipe(Effect.ignore);

      // A start that gives up ends the run, so the scope's graceful quit stops the helper.
      const gaveUp = yield* Deferred.make<void>();
      yield* Effect.sleep(START_TIMEOUT).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            instance.status === "running" ? Effect.void : Deferred.succeed(gaveUp, undefined),
          ),
        ),
        Effect.forkScoped,
      );
      // Blender and labwc write here; unread, it would pile up in memory for the whole session.
      yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Effect.logDebug("hosted Blender output", { line })),
        Effect.ignore,
        Effect.forkScoped,
      );
      const reader = new HelperPacketReader();
      yield* handle.stdout.pipe(
        Stream.runForEach((chunk) =>
          Effect.try({
            try: () => reader.push(chunk),
            catch: (cause) =>
              isHelperPacketError(cause) ? cause : new HelperPacketError({ length: -1 }),
          }).pipe(
            Effect.flatMap((packets) =>
              Effect.forEach(packets, (packet) => handlePacket(instance, packet), {
                discard: true,
              }),
            ),
          ),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("hosted Blender's hidden display stream failed", { cause }),
        ),
        Effect.forkScoped,
      );
      yield* connectControl(instance, controlSocket).pipe(Effect.ignore, Effect.forkScoped);
      // The open file's folder is watched, never the file read: its revision is a stat away.
      yield* Stream.fromEffect(Deferred.await(instance.controlReady)).pipe(
        Stream.flatMap(() => SubscriptionRef.changes(instance.watched)),
        Stream.changesWith((a, b) => a.join("\n") === b.join("\n")),
        Stream.switchMap((files) =>
          files.length === 0
            ? Stream.empty
            : watcher.changes(files, Stream.fromQueue(instance.diskNudges)),
        ),
        Stream.runForEach(() => checkDisk(instance)),
        Effect.forkScoped,
      );
      yield* sampleMemory(instance).pipe(
        Effect.repeat(Schedule.spaced(MEMORY_SAMPLE_INTERVAL)),
        Effect.forkScoped,
      );
      const exitCode = yield* Effect.raceFirst(
        handle.exitCode,
        Deferred.await(gaveUp).pipe(Effect.as("gave up" as const)),
      );
      instance.exitIntent = { ending: instance.ending, quitting: instance.quitting };
      if (exitCode !== 0) {
        yield* Effect.logWarning("hosted Blender's hidden display exited", { exitCode });
      }
      // The add-on's last lines (the file it had open, a save) can still be unread when the
      // helper exits; its connection closes once they are, and the cleanup needs them.
      const control = instance.control;
      if (control !== null) {
        yield* Deferred.await(control.closed).pipe(Effect.timeoutOption(CONTROL_DRAIN_TIMEOUT));
      }
    },
    Effect.scoped,
    (effect, instance) =>
      effect.pipe(
        Effect.catch((cause) => Effect.logWarning("hosted Blender failed", { cause })),
        Effect.ensuring(
          Effect.gen(function* () {
            instances.delete(instance.key);
            yield* settle(instance.session.close());
            if (instance.status === "starting" && !instance.quitting) {
              if (instance.role === "working") failedStarts.add(instance.threadId);
              else failedMasters.add(instance.blendPath);
            }
            instance.agentThreads.clear();
            yield* syncForwards(instance);
            yield* Effect.forEach(
              instance.viewers,
              (viewer) => Queue.offer(viewer.queue, { _tag: "stopped" }),
              { discard: true },
            );
            yield* publishNow();
            yield* Deferred.succeed(instance.ended, undefined);
          }),
        ),
      ),
  );

  /** Whose copies a run's end keeps: its thread's, or every master's one owner. */
  const ownerOf = (instance: Instance) =>
    instance.role === "master" ? MASTER_OWNER : instance.threadId;

  const threadRoot = (threadId: ThreadId) =>
    threadWorkspaceRoot(threadId).pipe(Effect.provideContext(lookupContext));

  /**
   * A `.blend` the thread may open: inside its workspace, really (no symlink out), and a file.
   * Opening is the pane's first use, by a caller allowed to start programs here.
   */
  // Runs inside open's or openMaster's span.
  const checkedBlend = Effect.fnUntraced(function* (threadId: ThreadId, relativePath: string) {
    yield* setup.ensureChecked;
    const tools = yield* setup.readiness.pipe(Stream.runHead, Effect.map(Option.getOrNull));
    if (tools?.status !== "ok") {
      return yield* new HostedBlenderError({ reason: tools?.status ?? "notSetUp" });
    }
    if (!relativePath.toLowerCase().endsWith(".blend"))
      return yield* new HostedBlenderError({ reason: "notBlendFile" });
    const root = yield* threadRoot(threadId);
    if (root === undefined) return yield* new HostedBlenderError({ reason: "threadNotFound" });
    // No cause on these: the error reaches the browser, and the reason says what was wrong.
    const resolved = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: root, relativePath })
      .pipe(Effect.mapError(() => new HostedBlenderError({ reason: "notInWorkspace" })));
    // A symlink inside the workspace must not reach a file outside it.
    const real = yield* Effect.all([
      fileSystem.realPath(root),
      fileSystem.realPath(resolved.absolutePath),
    ]).pipe(Effect.mapError(() => new HostedBlenderError({ reason: "fileNotFound" })));
    if (!isWithinRoot(path, real[1], real[0])) {
      return yield* new HostedBlenderError({ reason: "notInWorkspace" });
    }
    const stat = yield* fileSystem
      .stat(real[1])
      .pipe(Effect.mapError(() => new HostedBlenderError({ reason: "fileNotFound" })));
    if (stat.type !== "File") return yield* new HostedBlenderError({ reason: "fileNotFound" });
    return { tools, relativePath: resolved.relativePath, blendPath: real[1], root: real[0] };
  });

  // Runs inside open's or openMaster's span; the instance's own work has HostedBlender.run.
  /** A file's device and inode, so a hard link to it is the same file. */
  const fileIdentity = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => (Option.isSome(info.ino) ? `${info.dev}:${info.ino.value}` : file)),
      Effect.orElseSucceed(() => null),
    );

  /** A hosted Blender, other than `except`, launching on this file or with it open now. */
  // Runs inside open's or openMaster's span.
  const claimedBy = Effect.fnUntraced(function* (blendPath: string, except?: Instance) {
    const wanted = yield* fileIdentity(blendPath);
    for (const file of reserved) {
      if (file === blendPath || (wanted !== null && (yield* fileIdentity(file)) === wanted)) {
        return file;
      }
    }
    for (const other of instances.values()) {
      if (other === except) continue;
      const files = new Set([other.blendPath]);
      if (typeof other.openFile === "string") files.add(other.openFile);
      for (const file of files) {
        if (file === blendPath) return other;
        if (wanted !== null && (yield* fileIdentity(file)) === wanted) return other;
      }
    }
    return undefined;
  });

  const startInstance = Effect.fnUntraced(function* (
    input: {
      readonly role: HostedBlenderRole;
      readonly threadId: ThreadId;
      readonly relativePath: string;
      readonly blendPath: string;
      readonly agentWorkingCopy: boolean;
      /** The workspace's real path, which the open file is named under. */
      readonly workspaceRoot: string;
      /** A recovery copy or autosave to restore over the file. */
      readonly recover: string | null;
    },
    tools: { readonly helper: string; readonly blender: string },
  ) {
    // Checked as the launch is reserved, with no wait since: a switch-off scan either sees it
    // or it never starts.
    if (switchedOff) return yield* new HostedBlenderError({ reason: "notSetUp" });
    const launchFile: KeptFile =
      input.role === "master"
        ? masterFileOf(input.blendPath)
        : { kind: "workspace", relativePath: input.relativePath };
    const instance: Instance = {
      key: input.role === "master" ? masterKey(input.blendPath) : input.threadId,
      role: input.role,
      threadId: input.threadId,
      masterThreads: new Set(input.role === "master" ? [input.threadId] : []),
      agentThreads: new Set(),
      forwards: new Map(),
      relativePath: input.relativePath,
      blendPath: input.blendPath,
      ended: yield* Deferred.make<void>(),
      viewers: [],
      status: "starting",
      dirty: false,
      pid: null,
      stats: null,
      memoryBytes: null,
      viewport: null,
      lastKeyframeRequest: Number.NEGATIVE_INFINITY,
      keyframeDeferred: false,
      controlDir: null,
      capture: null,
      helper: () => Effect.void,
      control: null,
      saveReplies: null,
      pendingSave: null,
      requests: new Map(),
      hitsLock: yield* Semaphore.make(1),
      lastRequestId: 0,
      fiber: null,
      quitting: false,
      ending: false,
      blenderExit: null,
      recover: input.recover,
      saved: false,
      saveConfirmed: false,
      endFile: { file: launchFile, path: input.blendPath, since: 0 },
      clean: false,
      quitHeard: false,
      loadedAt: undefined,
      exitIntent: null,
      acknowledged: false,
      stopNow: false,
      released: false,
      closeRequested: false,
      restore: input.recover === null ? "none" : "pending",
      shown: false,
      controlReady: yield* Deferred.make<void>(),
      stateDir: null,
      agentWorkingCopy: input.agentWorkingCopy,
      agentListener: "starting",
      agentListenerSettled: yield* Deferred.make<void>(),
      agentListenerRevoked: false,
      agentAccessEnded: null,
      agentListenerGranted: false,
      agentListenerGrantSent: false,
      controlLost: false,
      mcpPort: null,
      forwardLock: yield* Semaphore.make(1),
      retryQuit: false,
      desktopUnchecked: false,
      quitRefused: null,
      quitCancelled: null,
      discardRefused: null,
      agentSession: undefined,
      openFile: undefined,
      openRealPath: input.blendPath,
      watched: yield* SubscriptionRef.make<ReadonlyArray<string>>([input.blendPath]),
      stale: false,
      reloadKept: null,
      saveRefusal: null,
      staleBlocked: null,
      diskCheckWaiting: false,
      keptReload: null,
      contained: null,
      restoring: false,
      retires: null,
      diskNudges: yield* Queue.sliding<void>(1),
      workspaceRoot: input.workspaceRoot,
      mcpVersion: null,
      agentActing: false,
      session: new SessionControl(null),
      held: new HeldInput(),
      cursorCaptured: false,
      displaySize: "",
      capturing: true,
      bitrate: new BitrateControl(),
      bitrateLead: null,
    };
    // A copy a reload kept waits for the person, offered while this Blender runs the file as on
    // disk.
    const waiting = records.get(ownerOf(instance))?.get(fileKeyOf(launchFile));
    if (input.recover === null && waiting?.reloaded === true && waiting.recovery) {
      instance.reloadKept = { key: fileKeyOf(launchFile), at: waiting.keptAt };
    }
    instances.set(instance.key, instance);
    yield* publishNow();
    // Started now, so a quit straight after still runs its cleanup; a fiber interrupted before
    // it starts never does. Beside the other runs, so a shutdown ends it with its copy.
    instance.fiber = yield* run(instance, tools).pipe(
      Effect.forkIn(runScope, { startImmediately: true }),
    );
    return instance;
  });

  const open: HostedBlender["Service"]["open"] = Effect.fn("HostedBlender.open")(function* (
    { threadId, relativePath },
    options,
  ) {
    yield* Effect.annotateCurrentSpan({ threadId });
    yield* afterSalvage;
    const file = yield* checkedBlend(threadId, relativePath);
    yield* claimLock.withPermits(1)(
      startWorking(threadId, file, null, false, options?.agentWorkingCopy === true),
    );
  });

  /** The thread's working Blender, or the master Blender it uses. */
  const instanceFor = (threadId: string, role: HostedBlenderRole | undefined) => {
    if (role !== "master") {
      const working = instances.get(threadId);
      return working?.role === "working" ? working : undefined;
    }
    const known = threadMasters.get(threadId as ThreadId);
    const master = known === undefined ? undefined : instances.get(masterKey(known.blendPath));
    return master?.masterThreads.has(threadId as ThreadId) ? master : undefined;
  };

  /** The thread's working Blender on `file`; runs inside open's or reopen's span. */
  const startWorking = Effect.fnUntraced(function* (
    threadId: ThreadId,
    file: Effect.Success<ReturnType<typeof checkedBlend>>,
    recover: string | null,
    /** Reopen may start while the file's copy waits; open may not, since its end replaces it. */
    allowPendingRecovery: boolean,
    /** An agent's `blender_start`: only then may the agent's listener be granted. */
    agentWorkingCopy: boolean,
  ) {
    // Checked together, with no wait before the launch is reserved.
    const existing = instances.get(threadId);
    if (existing) {
      if (existing.relativePath === file.relativePath) return;
      return yield* new HostedBlenderError({ reason: "otherFileOpen" });
    }
    // Its end would keep a newer copy of the same file; other files' copies are never touched.
    const key = fileKeyOf({ kind: "workspace", relativePath: file.relativePath });
    if (!allowPendingRecovery && records.get(threadId)?.get(key)?.recovery === true) {
      return yield* new HostedBlenderError({ reason: "recoveryPending" });
    }
    // One file is open in at most one hosted Blender, whichever thread opened it.
    if ((yield* claimedBy(file.blendPath)) !== undefined) {
      return yield* new HostedBlenderError({ reason: "openInAnotherThread" });
    }
    failedStarts.delete(threadId);
    yield* startInstance(
      {
        role: "working",
        threadId,
        relativePath: file.relativePath,
        blendPath: file.blendPath,
        agentWorkingCopy,
        workspaceRoot: file.root,
        recover,
      },
      file.tools,
    );
  });

  /** The master copy a thread's Master side shows: its master file's, while none runs. */
  const masterCopyOf = (threadId: ThreadId) => {
    const known = threadMasters.get(threadId);
    if (known === undefined) return undefined;
    const key = fileKeyOf(masterFileOf(known.blendPath));
    const record = records.get(MASTER_OWNER)?.get(key);
    return record === undefined ? undefined : { known, key, record };
  };

  const reopen: HostedBlender["Service"]["reopen"] = Effect.fn("HostedBlender.reopen")(function* (
    { threadId, key, restore, role, replaceUnsaved },
    options,
  ) {
    yield* Effect.annotateCurrentSpan({ threadId, restore, role });
    yield* afterSalvage;
    // A running Blender restores the copy a reload kept in place; nothing else reopens it.
    const running = instanceFor(threadId, role);
    if (running !== undefined) {
      return yield* restoreInPlace(running, key, restore, replaceUnsaved === true);
    }
    if (role === "master") {
      const copy = masterCopyOf(threadId);
      if (copy === undefined || copy.key !== key) {
        return yield* new HostedBlenderError({ reason: "nothingToReopen" });
      }
      failedRestores.delete(copyId(MASTER_OWNER, key));
      // Restored in the master Blender, which this thread joins; others then join it as usual.
      return yield* openMasterFile(
        { threadId, relativePath: copy.known.relativePath },
        undefined,
        restore && copy.record.recovery ? sessionPath(MASTER_OWNER, key) : null,
      );
    }
    const record = records.get(threadId)?.get(key);
    if (record === undefined) return yield* new HostedBlenderError({ reason: "nothingToReopen" });
    // T3 opens only workspace files, so only there can it check where a restore would save.
    if (record.file.kind !== "workspace") {
      return yield* new HostedBlenderError({ reason: "notInWorkspace" });
    }
    const file = yield* checkedBlend(threadId, record.file.relativePath);
    failedRestores.delete(copyId(threadId, key));
    // The record stays until this Blender ends too, so a restore that fails keeps its copy.
    yield* claimLock.withPermits(1)(
      startWorking(
        threadId,
        file,
        restore && record.recovery ? sessionPath(threadId, key) : null,
        true,
        // Reopening from the pane is the person's: like any file they open, it never listens
        // for the agent, which calls blender_start again to get its copy back.
        options?.agentWorkingCopy === true,
      ),
    );
  });

  /** The copy of the open file put back over it, unsaved, as a launch's restore would. */
  // Runs inside reopen's span.
  const restoreInPlace = Effect.fnUntraced(function* (
    instance: Instance,
    key: string,
    restore: boolean,
    replaceUnsaved: boolean,
  ) {
    const owner = ownerOf(instance);
    const filepath = instance.openFile;
    const record = records.get(owner)?.get(key);
    if (
      !restore ||
      typeof filepath !== "string" ||
      key !== fileKeyOf(instance.endFile.file) ||
      record?.recovery !== true
    ) {
      return;
    }
    // Two panes of a shared master confirming at once: the second would stage the first's
    // restored work over what the first displaced.
    if (instance.restoring) return yield* new HostedBlenderError({ reason: "restoreFailed" });
    instance.restoring = true;
    // Finished, and the flag held until what it displaced is kept, whether or not the caller
    // still waits: Blender restores once asked.
    const restoring = Effect.gen(function* () {
      const answer = yield* ask(
        instance,
        { type: "restore", path: sessionPath(owner, key), filepath, replace: replaceUnsaved },
        RestoreAnswer,
        // A large file takes as long as it takes.
        { untimed: true },
      );
      if (answer.outcome !== "restored") return answer;
      instance.contained = { keptAt: record.keptAt, loadedAt: answer.loadedAt };
      // What the restore replaced is the file's copy now, offered as the restored one was: the
      // same step undoes it.
      const kept =
        answer.copy == null
          ? null
          : yield* keepReloadCopy(instance, answer.copy, answer.filepath ?? filepath);
      instance.reloadKept =
        kept === null ? null : { key: kept, at: yield* Clock.currentTimeMillis };
      yield* publishNow();
      return answer;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          instance.restoring = false;
        }),
      ),
    );
    const answer = yield* Fiber.join(
      yield* restoring.pipe(Effect.forkIn(serviceScope, { startImmediately: true })),
    );
    switch (answer.outcome) {
      case "otherFile":
        return yield* new HostedBlenderError({ reason: "openFileChanged" });
      case "unsaved":
        return yield* new HostedBlenderError({ reason: "restoreReplacesUnsaved" });
      case "unkeepable":
        return yield* new HostedBlenderError({ reason: "unkeepableEdits" });
      case "failed":
        return yield* new HostedBlenderError({ reason: "restoreFailed" });
    }
  });

  const dismiss: HostedBlender["Service"]["dismiss"] = Effect.fn("HostedBlender.dismiss")(
    function* ({ threadId, key, role }) {
      yield* Effect.annotateCurrentSpan({ threadId, role });
      yield* afterSalvage;
      if (role === "master") {
        const copy = masterCopyOf(threadId);
        if (copy === undefined || copy.key !== key) return;
        if (instances.has(masterKey(copy.known.blendPath))) return;
        if (yield* forgetCopy(MASTER_OWNER, copy.key)) yield* publishNow();
        return;
      }
      if (instances.has(threadId)) return;
      const changed =
        key === undefined ? failedStarts.delete(threadId) : yield* forgetCopy(threadId, key);
      if (changed) yield* publishNow();
    },
  );

  const keptCopies: HostedBlender["Service"]["keptCopies"] = (threadId) =>
    Effect.sync(() => copiesOf(threadId));

  // Last resort: the helper stops Blender with SIGTERM, then SIGKILL.
  const forceQuit = Effect.fn("HostedBlender.forceQuit")(function* (instance: Instance) {
    instance.quitting = true;
    if (instance.fiber) yield* Fiber.interrupt(instance.fiber);
  });

  /**
   * How an ending waits: until `until` (epoch ms). Settling never stops a Blender that said it is
   * saving or writing its quit copy; a shutdown has one deadline for everything, then stops it.
   */
  interface Deadline {
    readonly until: number;
    readonly shutdown: boolean;
  }

  const deadlineIn = (timeout: Duration.Input, shutdown: boolean) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now): Deadline => ({ until: now + Duration.toMillis(timeout), shutdown })),
    );

  const within = <A, E>(effect: Effect.Effect<A, E>, deadline: Deadline) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => effect.pipe(Effect.timeoutOption(Math.max(0, deadline.until - now)))),
    );

  const pastDeadline = Effect.fnUntraced(function* (instance: Instance, deadline: Deadline) {
    if (!deadline.shutdown && instance.acknowledged) return yield* Deferred.await(instance.ended);
    // T3 is exiting, but this Blender said it is saving or writing its quit copy, which is then
    // the only copy of its latest work: it is left to finish, never stopped mid-write.
    if (deadline.shutdown && instance.acknowledged) {
      instance.released = true;
      if (instance.stateDir !== null) {
        yield* fileSystem
          .writeFileString(path.join(instance.stateDir, "outcome"), "released")
          .pipe(Effect.ignore);
      }
      yield* instance.helper({ type: "detach" });
      return yield* forceQuit(instance);
    }
    // Saves go through a temporary file, so stopping Blender never damages the user's file.
    instance.stopNow = deadline.shutdown;
    yield* forceQuit(instance);
  });

  const awaitEnded = Effect.fnUntraced(function* (instance: Instance, deadline: Deadline) {
    const ended = yield* within(Deferred.await(instance.ended), deadline);
    if (Option.isNone(ended)) yield* pastDeadline(instance, deadline);
  });

  /** Asks the add-on to quit without saving, waiting until the deadline for it to connect. */
  const sendQuitWithoutSaving = Effect.fnUntraced(function* (
    instance: Instance,
    deadline: Deadline,
    /** A discard of this open file only. */
    filepath?: string,
  ) {
    const connected = yield* within(Deferred.await(instance.controlReady), deadline).pipe(
      Effect.raceFirst(Deferred.await(instance.ended).pipe(Effect.as(Option.none()))),
    );
    const control = instance.control;
    if (Option.isNone(connected) || control === null) return false;
    yield* control
      .write(
        `${encodeControlCommand({ type: "quit", save: false, ...(filepath === undefined ? {} : { filepath }) })}\n`,
      )
      .pipe(Effect.raceFirst(Deferred.await(control.closed)));
    return true;
  });

  /**
   * The person's Quit without saving, or a quit of a Blender still starting. A discard names the
   * file the dialog showed: Blender refuses it with another open, and stays open.
   */
  const quitWithoutSaving = Effect.fn("HostedBlender.quitWithoutSaving")(function* (
    instance: Instance,
    filepath?: string,
  ) {
    instance.quitting = true;
    yield* revokeAgentListener(instance);
    // Quitting a Blender still starting has nothing of its session to keep.
    if (instance.control === null) return yield* forceQuit(instance);
    const deadline = yield* deadlineIn(QUIT_TIMEOUT, false);
    const refused = yield* Deferred.make<void>();
    instance.discardRefused = refused;
    if (!(yield* sendQuitWithoutSaving(instance, deadline, filepath))) {
      return yield* forceQuit(instance);
    }
    const outcome = yield* within(
      Effect.raceFirst(
        Deferred.await(instance.ended).pipe(Effect.as("ended" as const)),
        Deferred.await(refused).pipe(Effect.as("refused" as const)),
      ),
      deadline,
    );
    if (instance.discardRefused === refused) instance.discardRefused = null;
    // What it would keep is what the person chose to lose, so a Blender busy past the deadline
    // (a Save and quit stuck in it included) is stopped; saves never damage the file.
    if (Option.isNone(outcome)) return yield* forceQuit(instance);
    if (outcome.value === "refused") {
      instance.quitting = false;
      return yield* new HostedBlenderError({ reason: "openFileChanged" });
    }
  });

  /** Quits without saving, so Blender writes its quit copy, which the run keeps to reopen. */
  const end = Effect.fn("HostedBlender.end")(function* (instance: Instance, given: Deadline) {
    yield* Effect.annotateCurrentSpan({ threadId: instance.threadId, shutdown: given.shutdown });
    // Gone already: how it ended was settled when the helper exited.
    if (instance.exitIntent !== null) return yield* Deferred.await(instance.ended);
    // A Blender T3 is closing is no longer the agent's, whatever happens to the close. Marked
    // first, so a connection dropping during the stop reads as this close, not a loss.
    instance.closeRequested = true;
    yield* revokeAgentListener(instance);
    let deadline = given;
    // A Save and quit already under way decides first; only a failed one leaves work to keep.
    // Settling waits however long a save Blender has begun takes; one still queued in a busy
    // Blender, never begun by the deadline, is stopped as any unanswered quit is. A shutdown
    // keeps its one deadline.
    const pending = instance.pendingSave;
    if (pending !== null) {
      const answered = yield* within(Deferred.await(pending), deadline);
      if (Option.isNone(answered) && (deadline.shutdown || !instance.acknowledged)) {
        return yield* pastDeadline(instance, deadline);
      }
      const saved = Option.isSome(answered) ? answered.value : yield* Deferred.await(pending);
      if (saved) return yield* awaitEnded(instance, deadline);
      // Blender stays open after a failed save; the recovery quit gets a deadline of its own.
      if (!deadline.shutdown) deadline = yield* deadlineIn(QUIT_TIMEOUT, false);
      // A save lost with its connection usually means Blender is gone (a crash): its run ends
      // on its own and keeps what it left as such.
      const control = instance.control;
      if (control === null || (yield* Deferred.isDone(control.closed))) {
        const ended = yield* within(Deferred.await(instance.ended), deadline);
        if (Option.isSome(ended)) return;
      }
    }
    if (!instance.ending) {
      instance.ending = true;
      instance.quitting = true;
      instance.acknowledged = false;
      if (instance.stateDir !== null) {
        // If the server stops before this run ends, the next start still reads it as closed.
        yield* fileSystem
          .writeFileString(path.join(instance.stateDir, "outcome"), "closing")
          .pipe(Effect.ignore);
      }
      // A Blender still starting has until the deadline to connect, so its session is kept.
      if (!(yield* sendQuitWithoutSaving(instance, deadline))) {
        return yield* pastDeadline(instance, deadline);
      }
    }
    yield* awaitEnded(instance, deadline);
  });

  const closeOnSettle: HostedBlender["Service"]["closeOnSettle"] = Effect.fn(
    "HostedBlender.closeOnSettle",
  )(function* ({ threadId }) {
    yield* Effect.annotateCurrentSpan({ threadId });
    const instance = instanceFor(threadId, undefined);
    if (instance === undefined) return;
    yield* closeInstance(instance);
  });

  const forgetThread: HostedBlender["Service"]["forgetThread"] = Effect.fn(
    "HostedBlender.forgetThread",
  )(function* ({ threadId }) {
    yield* Effect.annotateCurrentSpan({ threadId });
    const instance = instanceFor(threadId, undefined);
    yield* Effect.gen(function* () {
      if (instance !== undefined) {
        instance.closeRequested = true;
        yield* end(instance, yield* deadlineIn(QUIT_TIMEOUT, false));
        // Its end keeps its copy before `ended`, so that copy goes too.
        yield* Deferred.await(instance.ended);
      }
      yield* afterSalvage;
      records.delete(threadId);
      failedStarts.delete(threadId);
      yield* fileSystem.remove(recoveryDir(threadId), { recursive: true, force: true }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("couldn't remove a deleted thread's hosted Blender copies", {
            cause,
          }),
        ),
      );
      yield* publishNow();
    }).pipe(Effect.forkIn(serviceScope));
  });

  /** Ends it as a settle does, without waiting: a working Blender or a master. */
  const closeInstance = Effect.fnUntraced(function* (instance: Instance) {
    instance.closeRequested = true;
    const deadline = yield* deadlineIn(QUIT_TIMEOUT, false);
    yield* end(instance, deadline).pipe(Effect.forkIn(serviceScope));
  });

  // Switching Hosted Blender off closes every hosted Blender as a settle does, copies kept.
  // Set before the scan, which an open checks as it reserves its launch, so none slips past.
  yield* setup.readiness.pipe(
    Stream.map(
      (readiness) => readiness.status === "notSetUp" && readiness.missing.includes("enabled"),
    ),
    Stream.changes,
    Stream.runForEach((off) => {
      switchedOff = off;
      return off ? Effect.forEach([...instances.values()], closeInstance) : Effect.void;
    }),
    Effect.forkIn(serviceScope),
  );

  // Added after `runScope`, so on shutdown every Blender gets to save its copy first, all
  // within one deadline.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const deadline = yield* deadlineIn(SHUTDOWN_QUIT_TIMEOUT, true);
      yield* Effect.forEach(instances.values(), (instance) => end(instance, deadline), {
        concurrency: "unbounded",
        discard: true,
      });
    }),
  );

  const quit: HostedBlender["Service"]["quit"] = Effect.fn("HostedBlender.quit")(function* ({
    threadId,
    save,
    discard,
    openFile,
    role,
    master,
  }) {
    yield* Effect.annotateCurrentSpan({ threadId, save, role });
    // A master by its own key, from the Running Blenders list: it may have no thread left.
    const byKey = master === undefined ? undefined : instances.get(master);
    const instance = byKey?.role === "master" ? byKey : instanceFor(threadId, role);
    // Nothing running: a stale Quit never touches what an ended Blender kept. Discard does.
    if (instance === undefined) {
      const known = role === "master" ? threadMasters.get(threadId) : undefined;
      const cleared =
        role === "master"
          ? known !== undefined && failedMasters.delete(known.blendPath)
          : failedStarts.delete(threadId);
      if (!cleared) return;
      return yield* publishNow();
    }
    return yield* quitInstance(instance, save, discard === true ? { openFile } : null);
  });

  // Runs inside quit's span.
  const quitInstance = Effect.fnUntraced(function* (
    instance: Instance,
    save: boolean,
    /** The person's Quit without saving, and the file its dialog named. */
    discard: { readonly openFile: KeptFile | undefined } | null,
  ) {
    const control = instance.control;
    const saveFailed = new HostedBlenderError({ reason: "saveFailed" });
    // Only the person's choice in the save/discard dialog discards. Any other quit without
    // saving (a file the client believed clean, an agent's) ends as a settle does, so what
    // Blender says as it quits decides what is kept. One still starting has no session yet.
    if (!save && discard?.openFile !== undefined) {
      const open = openFileOf(instance).openFile;
      if (open === undefined || fileKeyOf(open) !== fileKeyOf(discard.openFile)) {
        return yield* new HostedBlenderError({ reason: "openFileChanged" });
      }
      return yield* quitWithoutSaving(instance, instance.openFile ?? "");
    }
    if (!save && (discard !== null || instance.status === "starting")) {
      return yield* quitWithoutSaving(instance);
    }
    if (!save) return yield* end(instance, yield* deadlineIn(QUIT_TIMEOUT, false));
    // Save and quit never stops Blender before the add-on says the file is saved. A save
    // already asked for answers every caller, until Blender exits or it fails.
    let pending = instance.pendingSave;
    if (pending === null) {
      if (control === null) return yield* saveFailed;
      instance.saveRefusal = null;
      const started = yield* Deferred.make<boolean>();
      pending = started;
      instance.pendingSave = started;
      const clear = Effect.suspend(() => {
        if (instance.pendingSave !== started) return Effect.void;
        instance.pendingSave = null;
        // Blender stays open after a failed save: capture follows the panes again, and a change
        // on disk seen meanwhile, or that refused it, is caught up with.
        return applyCapture(instance).pipe(Effect.andThen(checkWaitingDisk(instance)));
      });
      yield* saveThenQuit(instance, control).pipe(
        // Only a failure clears it, before answering, so a retry starts a new save.
        Effect.tap((saved) => (saved ? Effect.void : clear)),
        Effect.flatMap((saved) => Deferred.succeed(started, saved)),
        Effect.onInterrupt(() => clear.pipe(Effect.andThen(Deferred.succeed(started, false)))),
        // Beside the runs, so a shutdown's endings still see the save through.
        Effect.forkIn(runScope),
      );
    }
    if (!(yield* Deferred.await(pending))) {
      return yield* instance.saveRefusal === "changedOnDisk"
        ? new HostedBlenderError({ reason: "changedOnDisk" })
        : saveFailed;
    }
    // Saved, Blender quits: the agent's access ends with it.
    yield* revokeAgentListener(instance);
    instance.quitting = true;
    const ended = yield* Deferred.await(instance.ended).pipe(Effect.timeoutOption(QUIT_TIMEOUT));
    if (Option.isNone(ended)) yield* forceQuit(instance);
  });

  const saveThenQuit = Effect.fn("HostedBlender.saveThenQuit")(
    function* (instance: Instance, connection: ControlConnection) {
      const replies = yield* Queue.unbounded<SaveReply>();
      // Until T3 has confirmed a restore, saving could write the copy somewhere else, or write
      // the file as saved over the copy's changes: checked right before the save goes out.
      if (instance.restore === "pending" || instance.restore === "failed") return false;
      instance.saveReplies = replies;
      return yield* requestSave({
        connection,
        replies,
        ended: Deferred.await(instance.ended),
        command: `${encodeControlCommand({ type: "quit", save: true })}\n`,
        writeTimeout: CONTROL_REPLY_TIMEOUT,
      });
    },
    (effect, instance) =>
      effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            instance.saveReplies = null;
          }),
        ),
      ),
  );

  // A running Blender stays visible, and can be quit, even after setup or the switch changes.
  // From after the salvage, so a copy it keeps never first shows as nothing kept.
  const threadState: HostedBlender["Service"]["threadState"] = (threadId) =>
    Stream.zipLatest(setup.readiness, SubscriptionRef.changes(states)).pipe(
      Stream.onStart(afterSalvage),
      Stream.map(
        ([readiness, running]): HostedBlenderThreadState =>
          running.get(threadId) ?? (readiness.status === "ok" ? { status: "stopped" } : readiness),
      ),
      Stream.changesWith(sameState),
    );

  const detach = Effect.fnUntraced(function* (instance: Instance, entry: ViewerEntry) {
    const index = instance.viewers.indexOf(entry);
    if (index >= 0) instance.viewers.splice(index, 1);
    yield* Queue.shutdown(entry.queue);
    yield* releaseControl(instance, entry);
    yield* applySize(instance);
    yield* applyCapture(instance);
    yield* panesGone(instance);
  });

  // Showing a pane joins on a keyframe, as attaching does; a hidden pane gets no frames.
  const setVisible = Effect.fn("HostedBlender.setVisible")(function* (
    instance: Instance,
    entry: ViewerEntry,
    visible: boolean,
  ) {
    if (entry.visible === visible) return;
    entry.visible = visible;
    entry.flow.resync();
    if (visible) entry.shownAt = nextShownAt++;
    yield* applyCapture(instance);
    yield* applySize(instance);
    if (visible) {
      yield* joinOnKeyframe(instance);
      yield* askReload(instance);
    } else {
      yield* panesGone(instance);
    }
  });

  // Acks arrive for every frame; they share the viewer's stream span.
  const ackFrame = Effect.fnUntraced(function* (instance: Instance, entry: ViewerEntry) {
    const now = yield* Clock.currentTimeMillis;
    const { send, latencyMs, requestKeyframe: wantsKeyframe } = entry.flow.ack(now);
    for (const frame of send) yield* Queue.offer(entry.queue, { _tag: "frame", data: frame.data });
    if (wantsKeyframe) yield* requestKeyframe(instance);
    if (latencyMs === null || leadViewer(instance) !== entry) return;
    if (instance.bitrateLead !== entry.id) {
      instance.bitrateLead = entry.id;
      instance.bitrate.reset();
    }
    yield* setBitrate(instance, instance.bitrate.ack(latencyMs, now));
  });

  const attachViewer: HostedBlender["Service"]["attachViewer"] = Effect.fn(
    "HostedBlender.attachViewer",
  )(function* (threadId, { canOperate, role, visible = true }) {
    yield* Effect.annotateCurrentSpan({ threadId, canOperate, role, visible });
    const instance = instanceFor(threadId, role);
    // Nor a viewer: the master may still quit under it.
    if (instance === undefined || instance.quitCancelled != null)
      return { _tag: "stopped" as const };
    if (instance.viewers.length >= MAX_VIEWERS) return { _tag: "full" as const };
    const entry: ViewerEntry = {
      id: `viewer-${nextViewerId++}`,
      canOperate,
      // ViewerFlow bounds the frames queued here; the rest are small, infrequent messages.
      queue: yield* Queue.unbounded<HostedBlenderViewerOutput>(),
      flow: new ViewerFlow(),
      size: null,
      visible,
      shownAt: nextShownAt++,
    };
    instance.viewers.push(entry);
    yield* Effect.addFinalizer(() => detach(instance, entry));
    const initial: HostedBlenderStreamServerMessage[] = [
      controlMessage(instance, entry),
      { type: "cursor", captured: instance.cursorCaptured },
    ];
    if (instance.viewport) initial.push({ type: "viewport", ...instance.viewport });
    const stats = statsMessage(instance);
    if (stats) initial.push(stats);
    yield* Queue.offerAll(
      entry.queue,
      initial.map((message) => ({ _tag: "message" as const, message })),
    );
    yield* applyCapture(instance);
    if (visible) {
      yield* joinOnKeyframe(instance);
      yield* askReload(instance);
    }
    return {
      _tag: "attached" as const,
      viewer: {
        output: entry.queue,
        ack: Effect.suspend(() => ackFrame(instance, entry)),
        resize: (width, height) =>
          Effect.suspend(() => {
            entry.size = { width, height };
            return applySize(instance);
          }),
        setVisible: (visible) => setVisible(instance, entry, visible),
        input: (message) => handleViewerInput(instance, entry, message),
      },
    };
  });

  const runningBlenders: HostedBlender["Service"]["runningBlenders"] = SubscriptionRef.changes(
    running,
  ).pipe(Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)));
  // Each request runs inside its caller's span (captureView, findHits, setView).
  const ask = Effect.fnUntraced(function* <A>(
    instance: Instance | undefined,
    body: ControlRequestBody,
    result: Schema.Decoder<A>,
    options: {
      /** One slot of this is held until the add-on answers or its connection closes. */
      readonly slot?: Semaphore.Semaphore;
      /** Waits for the add-on's answer however long it takes; the caller bounds the wait. */
      readonly untimed?: boolean;
    } = {},
  ) {
    const { slot } = options;
    if (instance === undefined || instance.status !== "running") {
      return yield* new HostedBlenderError({ reason: "notRunning" });
    }
    const control = instance.control;
    if (control === null) return yield* new HostedBlenderError({ reason: "noReply" });
    const reply = yield* Deferred.make<unknown>();
    const closed = Deferred.await(control.closed);
    const send = Effect.suspend(() => {
      instance.lastRequestId += 1;
      const id = instance.lastRequestId;
      instance.requests.set(id, reply);
      return control
        .write(`${encodeControlRequest({ ...body, id })}\n`)
        .pipe(Effect.raceFirst(closed));
    });
    if (slot) {
      // A caller that stops waiting doesn't free the slot: Blender may still be working on it.
      const sent = yield* sendHoldingSlot({
        slot,
        send,
        settled: Effect.raceFirst(Deferred.await(reply), closed),
        scope: serviceScope,
        timeout: CONTROL_REPLY_TIMEOUT,
      });
      if (!sent) return yield* new HostedBlenderError({ reason: "noReply" });
    } else {
      yield* send;
    }
    const answer = yield* Deferred.await(reply).pipe(
      Effect.asSome,
      Effect.raceFirst(closed.pipe(Effect.as(Option.none()))),
      options.untimed ? Effect.asSome : Effect.timeoutOption(CONTROL_REPLY_TIMEOUT),
      Effect.map(Option.flatten),
    );
    if (Option.isNone(answer)) return yield* new HostedBlenderError({ reason: "noReply" });
    // The add-on answers null when Blender has no viewport window to read or move.
    if (answer.value === null) return yield* new HostedBlenderError({ reason: "noViewport" });
    return yield* Schema.decodeEffect(result)(answer.value).pipe(
      Effect.mapError(() => new HostedBlenderError({ reason: "noReply" })),
    );
  });

  const captureView: HostedBlender["Service"]["captureView"] = Effect.fn(
    "HostedBlender.captureView",
  )(function* (threadId, role) {
    yield* Effect.annotateCurrentSpan({ threadId, role });
    const instance = instanceFor(threadId, role);
    if (instance === undefined || instance.controlDir === null) {
      return yield* new HostedBlenderError({ reason: "notRunning" });
    }
    // Rendering blocks Blender, so one screenshot renders at a time; callers meanwhile share it.
    if (instance.capture === null) {
      const capture = yield* Deferred.make<HostedBlenderViewCapture, HostedBlenderError>();
      instance.capture = capture;
      yield* renderScreenshot(instance, instance.controlDir, capture).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (instance.capture === capture) instance.capture = null;
          }),
        ),
        Effect.forkIn(serviceScope),
      );
    }
    const captured = yield* Deferred.await(instance.capture).pipe(
      Effect.timeoutOption(CONTROL_REPLY_TIMEOUT),
    );
    if (Option.isNone(captured)) return yield* new HostedBlenderError({ reason: "noReply" });
    return captured.value;
  });

  /**
   * Has the add-on render the viewport into the private control folder and answers `capture`.
   * It waits for Blender however long the render takes, so the file is removed only once
   * Blender is done with it, whoever stopped waiting.
   */
  const renderScreenshot = Effect.fnUntraced(function* (
    instance: Instance,
    controlDir: string,
    capture: Deferred.Deferred<HostedBlenderViewCapture, HostedBlenderError>,
  ) {
    screenshots += 1;
    const file = path.join(controlDir, `view-${screenshots}.png`);
    const noScreenshot = new HostedBlenderError({ reason: "noScreenshot" });
    const outcome = yield* Effect.gen(function* () {
      // Blender renders the viewport region with the camera it reports, so the two always agree.
      const view = yield* ask(
        instance,
        { type: "view", screenshot: path.basename(file) },
        AddonViewCapture,
        { untimed: true },
      );
      if (view.screenshot === null) return yield* noScreenshot;
      // Only Blender writes in that folder; a link or anything odd there is refused.
      const info = yield* fileSystem.lstat(file).pipe(Effect.mapError(() => noScreenshot));
      if (info.type !== "File" || Number(info.size) > MAX_SCREENSHOT_BYTES) {
        return yield* noScreenshot;
      }
      const png = yield* fileSystem.readFile(file).pipe(Effect.mapError(() => noScreenshot));
      if (!PNG_SIGNATURE.every((byte, index) => png[index] === byte)) return yield* noScreenshot;
      return {
        ...view,
        screenshot: {
          ...view.screenshot,
          dataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
        },
      };
    }).pipe(Effect.exit);
    yield* Effect.forEach(
      [file, `${file}.part`],
      (leftover) => fileSystem.remove(leftover, { force: true }).pipe(Effect.ignore),
      { discard: true },
    );
    yield* Deferred.done(capture, outcome);
  });

  const findHits: HostedBlender["Service"]["findHits"] = Effect.fn("HostedBlender.findHits")(
    function* ({ threadId, projection, marks, role }) {
      yield* Effect.annotateCurrentSpan({ threadId, marks: marks.length, role });
      const instance = instanceFor(threadId, role);
      if (instance === undefined) return yield* new HostedBlenderError({ reason: "notRunning" });
      return yield* ask(instance, { type: "hits", ...projection, marks }, HostedBlenderHits, {
        slot: instance.hitsLock,
      });
    },
  );

  const setView: HostedBlender["Service"]["setView"] = Effect.fn("HostedBlender.setView")(
    function* ({ threadId, relativePath, view, role }) {
      yield* Effect.annotateCurrentSpan({ threadId, role });
      // The link was routed here on the client's last word on the file; Blender may have moved on,
      // so the add-on compares the file it has open now as it moves the camera.
      const instance = instanceFor(threadId, role);
      const root = yield* threadRoot(threadId);
      const filepath = yield* realPathOr(path.resolve(root ?? "/", relativePath));
      const moved = yield* ask(
        instance,
        { type: "setView", ...view, filepath },
        Schema.Union([Schema.Literal(true), Schema.Literal("otherFile")]),
      );
      if (moved === "otherFile") return yield* new HostedBlenderError({ reason: "otherFileOpen" });
    },
  );

  const agentListener: HostedBlender["Service"]["agentListener"] = Effect.fn(
    "HostedBlender.agentListener",
  )(function* (threadId, options) {
    const instance = instanceFor(threadId, options?.role);
    if (instance === undefined) return null;
    const listener =
      options?.wait === false
        ? instance.agentListener
        : yield* awaitAgentListener({
            settled: Deferred.await(instance.agentListenerSettled).pipe(
              Effect.raceFirst(Deferred.await(instance.ended)),
            ),
            current: () => instance.agentListener,
            timeout: AGENT_LISTENER_TIMEOUT,
            revoke: revokeAgentListener(instance),
          });
    // A master's listener reaches this thread only through its own port.
    const state =
      instance.role === "working" || listener !== "ready"
        ? listener
        : !instance.agentThreads.has(threadId)
          ? "off"
          : instance.forwards.has(threadId)
            ? "ready"
            : "failed";
    return {
      state,
      ended: agentAccessEndedFor(
        instance.controlLost,
        instance.agentAccessEnded ??
          (instance.role === "master" && state === "off" ? "revoked" : null),
      ),
      openFile: instance.openFile,
      mcpVersion: instance.mcpVersion,
    };
  });

  if (Option.isSome(agents)) {
    yield* agents.value.revocations.pipe(
      Stream.runForEach((revocation) =>
        Effect.gen(function* () {
          // Only what the ended session was granted: a newer session keeps its own.
          const ended = (session: string | null | undefined) =>
            revocation === null ||
            revocation.session === undefined ||
            session === undefined ||
            session === revocation.session;
          const forThread = (threadId: ThreadId) =>
            revocation === null || threadId === revocation.threadId;
          // An ended session's request is forgotten wherever it waits: desktop, stopped or joined.
          for (const [id, known] of threadMasters) {
            if (forThread(id) && ended(known.agentSession)) known.agentSession = null;
          }
          yield* Effect.forEach(
            [...instances.values()],
            (instance) => {
              if (revocation === null) return revokeAgentListener(instance);
              if (instance.role === "working") {
                return forThread(instance.threadId) && ended(instance.agentSession)
                  ? revokeAgentListener(instance)
                  : Effect.void;
              }
              // One thread's access to a shared master ends, its relay at once; others keep theirs.
              // A relay opened for the ended session closes even when a newer grant is recorded;
              // the sync then opens a fresh one for that grant.
              const known = threadMasters.get(revocation.threadId);
              const relay = instance.forwards.get(revocation.threadId);
              const stale = relay !== undefined && ended(relay.session);
              if (known?.agentSession == null) instance.agentThreads.delete(revocation.threadId);
              if (stale) instance.forwards.delete(revocation.threadId);
              return (stale ? Scope.close(relay.scope, Exit.void) : Effect.void).pipe(
                Effect.andThen(syncForwards(instance)),
              );
            },
            { discard: true },
          );
        }),
      ),
      Effect.forkIn(serviceScope),
    );
  }

  /**
   * Each master file has one queue: joins, leaves, quit decisions and moves for it run one at a
   * time, and a thread's own choice of master changes one at a time too.
   */
  const masterQueues = yield* KeyedLock.make<string>();
  const threadQueues = yield* KeyedLock.make<ThreadId>();
  const inMasterQueue =
    (blendPath: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      masterQueues.withLock(blendPath, effect);
  const inThreadQueue =
    (threadId: ThreadId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      threadQueues.withLock(threadId, effect);

  /** The same file, by device and inode where they can be read. */
  const sameFile = Effect.fnUntraced(function* (a: string, b: string) {
    const [left, right] = yield* Effect.all([fileIdentity(a), fileIdentity(b)]);
    return left !== null ? left === right : (yield* realPathOr(a)) === (yield* realPathOr(b));
  });

  const realPathOr = (file: string) =>
    fileSystem.realPath(file).pipe(Effect.orElseSucceed(() => file));

  const openMaster: HostedBlender["Service"]["openMaster"] = Effect.fn("HostedBlender.openMaster")(
    function* (input, options) {
      yield* Effect.annotateCurrentSpan({
        threadId: input.threadId,
        agent: options?.agentSession !== undefined,
      });
      return yield* openMasterFile(input, options, undefined);
    },
  );

  /**
   * `recover` restores the master's copy as Reopen does; `undefined` is an ordinary open, which
   * a waiting copy of the master file shows first.
   */
  const openMasterFile = Effect.fnUntraced(function* (
    { threadId, relativePath }: { readonly threadId: ThreadId; readonly relativePath: string },
    options: { readonly agentSession?: string } | undefined,
    recover: string | null | undefined,
  ) {
    yield* afterSalvage;
    const file = yield* checkedBlend(threadId, relativePath);
    return yield* inThreadQueue(threadId)(
      Effect.gen(function* () {
        const previous = threadMasters.get(threadId);
        if (previous !== undefined && previous.blendPath !== file.blendPath) {
          yield* leave(threadId);
          // The pane reaches a master only through its thread; one with unsaved work stays.
          if (threadMasters.get(threadId)?.blendPath === previous.blendPath) {
            return yield* new HostedBlenderError({ reason: "masterUnsaved" });
          }
        }
        const known = threadMasters.get(threadId) ?? {
          blendPath: file.blendPath,
          relativePath: file.relativePath,
          desktop: null,
          desktopDirty: false,
          desktopPath: null,
          agentSession: null,
          chosen: true,
        };
        known.chosen = true;
        if (options?.agentSession !== undefined) known.agentSession = options.agentSession;
        threadMasters.set(threadId, known);
        return yield* inMasterQueue(file.blendPath)(joinMaster(threadId, file, recover));
      }),
    );
  });

  /**
   * Joins the thread to the master Blender for `file`, starting one if the desktop Blender doesn't
   * have the file. A Blender that starts takes every thread that chose the file, as a Move does.
   */
  // Runs inside openMaster's or moveIntoT3's span, in the master's queue.
  const joinMaster = Effect.fnUntraced(function* (
    threadId: ThreadId,
    file: Effect.Success<ReturnType<typeof checkedBlend>>,
    recover: string | null | undefined = undefined,
  ) {
    // Switched off while it waited in the master's queue.
    if (switchedOff) return yield* new HostedBlenderError({ reason: "notSetUp" });
    const existing = instances.get(masterKey(file.blendPath));
    // A master not running whose copy waits shows that copy first; a running one is joined, its
    // copy live in it.
    if (
      existing === undefined &&
      recover === undefined &&
      records.get(MASTER_OWNER)?.get(fileKeyOf(masterFileOf(file.blendPath)))?.recovery === true
    ) {
      // The thread's Master side now shows that card.
      yield* publishNow();
      return yield* new HostedBlenderError({ reason: "recoveryPending" });
    }
    // A quit it may still carry out: nobody is handed this master until that is settled.
    if (existing?.quitCancelled != null) {
      return yield* new HostedBlenderError({ reason: "masterBusy" });
    }
    // Copy back writes into a master; no other Blender may have its file, by any name. The file
    // is held while the desktop Blender is asked, outside the lock other opens wait on.
    yield* claimLock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* claimedBy(file.blendPath, existing)) !== undefined) {
          return yield* new HostedBlenderError({ reason: "openInAnotherThread" });
        }
        if (existing === undefined) reserved.add(file.blendPath);
      }),
    );
    const start = Effect.gen(function* () {
      if (existing !== undefined) return { instance: existing, desktopUnchecked: false };
      const probe = Option.isNone(desktop)
        ? Option.some<DesktopBlender.DesktopBlenderProbe>({ _tag: "none" })
        : yield* desktop.value.probe.pipe(Effect.timeoutOption(DESKTOP_PROBE_DEADLINE));
      // The desktop Blender keeps a master it has open, under any name for the same file.
      if (
        Option.isSome(probe) &&
        probe.value._tag === "open" &&
        (yield* sameFile(probe.value.filepath, file.blendPath))
      ) {
        for (const known of threadMasters.values()) {
          if (known.blendPath !== file.blendPath) continue;
          known.desktop = "open";
          known.desktopDirty = probe.value.dirty;
          known.desktopPath = probe.value.filepath;
        }
        return undefined;
      }
      failedMasters.delete(file.blendPath);
      const instance = yield* claimLock.withPermits(1)(
        Effect.suspend(() => {
          reserved.delete(file.blendPath);
          return startInstance(
            {
              role: "master",
              threadId,
              relativePath: file.relativePath,
              blendPath: file.blendPath,
              agentWorkingCopy: false,
              workspaceRoot: file.root,
              recover: recover ?? null,
            },
            file.tools,
          );
        }),
      );
      // A desktop Blender nobody could ask, or one that didn't answer in time.
      instance.desktopUnchecked = Option.isNone(probe) || probe.value._tag === "noAddon";
      return { instance, desktopUnchecked: instance.desktopUnchecked };
    }).pipe(Effect.ensuring(Effect.sync(() => reserved.delete(file.blendPath))));
    const started = yield* start;
    if (started === undefined) {
      yield* publishNow();
      return { _tag: "desktop" as const };
    }
    const instance = started.instance;
    instance.retryQuit = false;
    for (const [id, known] of threadMasters) {
      if (
        known.blendPath !== file.blendPath ||
        (id !== threadId && (existing !== undefined || !known.chosen))
      ) {
        continue;
      }
      known.desktop = null;
      instance.masterThreads.add(id);
      // Granted only to the agent session that asked, while it is still the thread's.
      if (yield* sessionCurrent(id)) instance.agentThreads.add(id);
    }
    yield* maybeGrant(instance);
    yield* syncForwards(instance);
    yield* publishNow();
    return { _tag: "hosted" as const, desktopUnchecked: instance.desktopUnchecked };
  });

  type QuitOutcome = "quit" | "refused" | "uncertain";

  /**
   * Asks Blender to quit only if it has nothing unsaved, as its own quit would check. `uncertain`
   * when it can't be asked or doesn't answer: the process is kept.
   */
  // Runs inside the master's queue.
  const quitIfClean = Effect.fnUntraced(function* (instance: Instance) {
    const control = instance.control;
    // An earlier quit still unresolved in Blender stands for this one too: it isn't asked twice.
    if (control === null || instance.quitCancelled != null) return "uncertain" as QuitOutcome;
    instance.lastRequestId += 1;
    const id = instance.lastRequestId;
    const refused = yield* Deferred.make<void>();
    instance.quitRefused = { id, done: refused };
    instance.quitting = true;
    const ended = Deferred.await(instance.ended).pipe(Effect.as<QuitOutcome>("quit"));
    // The write is part of the attempt: a stalled socket counts against its deadline.
    const outcome = yield* control
      .write(`${encodeQuitRequest({ type: "quitIfClean", id })}\n`)
      .pipe(
        Effect.andThen(
          Effect.raceFirst(ended, Deferred.await(refused).pipe(Effect.as<QuitOutcome>("refused"))),
        ),
        Effect.timeoutOption(QUIT_TIMEOUT),
      );
    instance.quitRefused = null;
    if (Option.isSome(outcome)) {
      if (outcome.value !== "quit") instance.quitting = false;
      return outcome.value;
    }
    // No answer in time: the request may still be waiting in a busy Blender. The leave ends
    // here; the master stays unavailable until Blender drops the quit, exits, or its connection
    // closes, so a late quit can't close it under a thread that joins meanwhile.
    const cancelled = yield* Deferred.make<void>();
    instance.quitCancelled = { id, done: cancelled };
    yield* publishNow();
    // A stalled write must not hold the race up.
    yield* control
      .write(`${encodeQuitRequest({ type: "cancelQuit", id })}\n`)
      .pipe(Effect.forkIn(serviceScope));
    yield* Effect.raceFirst(
      Deferred.await(instance.ended),
      Effect.raceFirst(Deferred.await(cancelled), Deferred.await(control.closed)),
    ).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (instance.quitCancelled?.done === cancelled) instance.quitCancelled = null;
          instance.quitting = false;
          return publishNow();
        }),
      ),
      Effect.forkIn(serviceScope),
    );
    return "uncertain" as QuitOutcome;
  });

  /**
   * The last thread leaving a master: quits it if clean. It is kept for that thread on unsaved
   * changes, and asked again once T3 can reach it if it couldn't be asked.
   */
  // Runs in the master's queue.
  const decideQuit = Effect.fnUntraced(function* (instance: Instance, threadId: ThreadId) {
    const outcome = yield* quitIfClean(instance);
    instance.retryQuit = outcome === "uncertain";
    if (outcome === "quit" && threadMasters.get(threadId)?.blendPath === instance.blendPath) {
      threadMasters.delete(threadId);
    }
    yield* publishNow();
  });

  /** In the master's queue, finished even when the caller stops waiting. */
  const leave = Effect.fnUntraced(function* (threadId: ThreadId) {
    const known = threadMasters.get(threadId);
    if (known === undefined) return;
    const step = inMasterQueue(known.blendPath)(
      Effect.gen(function* () {
        known.agentSession = null;
        const instance = instances.get(masterKey(known.blendPath));
        if (instance === undefined || !instance.masterThreads.has(threadId)) {
          if (threadMasters.get(threadId) === known) threadMasters.delete(threadId);
          return yield* publishNow();
        }
        instance.agentThreads.delete(threadId);
        yield* syncForwards(instance);
        if (instance.masterThreads.size > 1) {
          instance.masterThreads.delete(threadId);
          if (threadMasters.get(threadId) === known) threadMasters.delete(threadId);
          return yield* publishNow();
        }
        yield* decideQuit(instance, threadId);
      }),
    );
    // Takes its place in the queue now, as called, and finishes even if the caller goes.
    yield* Fiber.join(yield* step.pipe(Effect.forkIn(serviceScope, { startImmediately: true })));
  });

  /** Blender that couldn't be asked to quit is asked again once T3 reaches it. */
  // Runs in the instance's run span, when its control connection comes up.
  const retryQuit = Effect.fnUntraced(function* (instance: Instance) {
    yield* inMasterQueue(instance.blendPath)(
      Effect.suspend(() => {
        const [only] = instance.masterThreads;
        return instance.retryQuit && instance.masterThreads.size === 1 && only !== undefined
          ? decideQuit(instance, only)
          : Effect.void;
      }),
    );
  });

  const releaseMaster: HostedBlender["Service"]["releaseMaster"] = Effect.fn(
    "HostedBlender.releaseMaster",
  )(function* (threadId) {
    yield* inThreadQueue(threadId)(leave(threadId));
  });

  const knownMaster = (threadId: ThreadId) => {
    const known = threadMasters.get(threadId);
    return known === undefined
      ? Effect.fail(new HostedBlenderError({ reason: "noMaster" }))
      : Effect.succeed(known);
  };

  const knowMaster: HostedBlender["Service"]["knowMaster"] = Effect.fn("HostedBlender.knowMaster")(
    function* ({ threadId, relativePath }) {
      yield* Effect.annotateCurrentSpan({ threadId });
      yield* afterSalvage;
      const file = yield* checkedBlend(threadId, relativePath);
      yield* inThreadQueue(threadId)(
        Effect.suspend(() => {
          const previous = threadMasters.get(threadId);
          // A master the person or an agent chose stays; switching is an open's.
          if (previous?.blendPath === file.blendPath || previous?.chosen === true) {
            return Effect.void;
          }
          threadMasters.set(threadId, {
            blendPath: file.blendPath,
            relativePath: file.relativePath,
            desktop: null,
            desktopDirty: false,
            desktopPath: null,
            agentSession: null,
            chosen: false,
          });
          return publishNow();
        }),
      );
    },
  );

  const reopenMaster: HostedBlender["Service"]["reopenMaster"] = Effect.fn(
    "HostedBlender.reopenMaster",
  )(function* (threadId) {
    const known = yield* knownMaster(threadId);
    yield* openMaster({ threadId, relativePath: known.relativePath });
  });

  /** What the desktop Blender has now, for every thread that chose this master. */
  // Runs in the master's queue, inside moveIntoT3's span.
  const recheckDesktop = Effect.fnUntraced(function* (blendPath: string) {
    if (Option.isNone(desktop)) return undefined;
    const probe = yield* desktop.value.probe.pipe(Effect.timeoutOption(DESKTOP_PROBE_DEADLINE));
    const open =
      Option.isSome(probe) &&
      probe.value._tag === "open" &&
      (yield* sameFile(probe.value.filepath, blendPath))
        ? probe.value
        : undefined;
    // Its path and unsaved changes go together, and both go when it no longer has the file.
    for (const known of threadMasters.values()) {
      if (known.blendPath !== blendPath) continue;
      known.desktop =
        open !== undefined
          ? "open"
          : Option.isSome(probe) && probe.value._tag === "noAddon"
            ? "noAddon"
            : null;
      known.desktopPath = open?.filepath ?? null;
      known.desktopDirty = open?.dirty ?? false;
    }
    yield* publishNow();
    return open;
  });

  const moveIntoT3: HostedBlender["Service"]["moveIntoT3"] = Effect.fn("HostedBlender.moveIntoT3")(
    function* ({ threadId, relativePath }) {
      yield* Effect.annotateCurrentSpan({ threadId });
      const known = yield* knownMaster(threadId);
      // The user clicked Move for the master they saw; a different one since is refused.
      if (known.relativePath !== relativePath) {
        return yield* new HostedBlenderError({ reason: "masterChanged" });
      }
      if (Option.isNone(desktop)) {
        return yield* new HostedBlenderError({ reason: "desktopUnreachable" });
      }
      const blendPath = known.blendPath;
      yield* inMasterQueue(blendPath)(
        Effect.gen(function* () {
          // Checked in its turn: a leave queued first may have dropped the thread's choice.
          const current = threadMasters.get(threadId);
          if (current !== known || current.relativePath !== relativePath) {
            return yield* new HostedBlenderError({ reason: "masterChanged" });
          }
          // What the desktop Blender has right now, not what T3 saw when it offered the move.
          const open = yield* recheckDesktop(blendPath);
          if (open === undefined) {
            return yield* new HostedBlenderError({
              reason: known.desktop === "noAddon" ? "desktopUnreachable" : "desktopOtherFile",
            });
          }
          // Blender saves by replacing the entry it opened, so under another name for the
          // master, a symlink included, its save would land beside the master rather than in
          // it. The entry is its folder, resolved, and its own name, not resolved.
          const target = path.join(
            yield* realPathOr(path.dirname(open.filepath)),
            path.basename(open.filepath),
          );
          if (target !== blendPath) {
            return yield* new HostedBlenderError({ reason: "desktopAlias" });
          }
          yield* desktop.value.saveAndQuit(target).pipe(
            Effect.tapError(() => recheckDesktop(blendPath)),
            Effect.mapError(
              (error) =>
                new HostedBlenderError({
                  reason:
                    error.reason === "otherFile"
                      ? "desktopOtherFile"
                      : error.reason === "didNotQuit"
                        ? "desktopDidNotQuit"
                        : "desktopUnreachable",
                }),
            ),
          );
          for (const other of threadMasters.values()) {
            if (other.blendPath !== blendPath) continue;
            other.desktop = null;
            other.desktopPath = null;
            other.desktopDirty = false;
          }
          // Handed off: what's at the master's name now is the file Blender saved.
          const saved = yield* fileSystem.stat(blendPath).pipe(Effect.option);
          if (Option.isNone(saved) || saved.value.type !== "File") {
            yield* publishNow();
            return yield* new HostedBlenderError({ reason: "desktopDidNotQuit" });
          }
          // Published first, so a hosted open that fails leaves the pane offering to try again.
          yield* publishNow();
          // The threads that still chose this master go with it, the mover first if it did.
          const mover = threadMasters.get(threadId);
          if (mover?.blendPath === blendPath) mover.chosen = true;
          const movers = [...threadMasters]
            .filter(([, other]) => other.blendPath === blendPath && other.chosen)
            .map(([id]) => id)
            .toSorted((a) => (a === threadId ? -1 : 0));
          const first = movers[0];
          if (first === undefined) return;
          const file = yield* checkedBlend(first, threadMasters.get(first)!.relativePath);
          const opened = yield* joinMaster(first, file);
          if (opened._tag === "desktop") {
            return yield* new HostedBlenderError({ reason: "desktopDidNotQuit" });
          }
        }),
      );
    },
  );

  const masterState: HostedBlender["Service"]["masterState"] = (threadId) =>
    SubscriptionRef.changes(masterStates).pipe(
      Stream.map((all): HostedBlenderMasterState => all.get(threadId) ?? { status: "none" }),
      Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    );

  return HostedBlender.of({
    openMaster,
    reopenMaster,
    knowMaster,
    releaseMaster,
    moveIntoT3,
    masterState,
    open,
    agentListener,
    quit,
    reopen,
    dismiss,
    keptCopies,
    closeOnSettle,
    forgetThread,
    threadState,
    attachViewer,
    runningBlenders,
    captureView,
    findHits,
    setView,
  });
});

export const layer = Layer.effect(HostedBlender, make);
