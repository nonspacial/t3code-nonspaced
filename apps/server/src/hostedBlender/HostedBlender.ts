import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  HostedBlenderError,
  HostedBlenderFindHitsInput,
  HostedBlenderHits,
  type HostedBlenderOpenInput,
  type HostedBlenderQuitInput,
  type HostedBlenderRunningState,
  HostedBlenderSetViewInput,
  type HostedBlenderStreamServerMessage,
  type HostedBlenderViewerMessage,
  type HostedBlenderThreadState,
  HostedBlenderViewCapture,
  HostedBlenderViewProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
import { BitrateControl } from "./Bitrate.ts";
import { sendHoldingSlot } from "./ControlSlot.ts";
import { ViewerFlow } from "./ViewerFlow.ts";

const MAX_VIEWERS = 4;
const INITIAL_SIZE = { width: 1280, height: 720 };
const MEMORY_SAMPLE_INTERVAL = Duration.seconds(5);
const KEYFRAME_REQUEST_INTERVAL_MS = 250;
const QUIT_TIMEOUT = Duration.seconds(20);
const CONTROL_RETRY_INTERVAL = Duration.millis(200);
// A start that shows no viewport window by then has failed (a broken file, no encoder).
const START_TIMEOUT = Duration.seconds(90);
// The add-on starts the agent listener only once this connection is up, so it waits as long as a
// start does: a slow file still gets its listener while T3 is listening for it.
export const CONTROL_CONNECT_ATTEMPTS = Math.ceil(
  Duration.toMillis(START_TIMEOUT) / Duration.toMillis(CONTROL_RETRY_INTERVAL),
);
const HELPER_QUIT_TIMEOUT = Duration.seconds(10);
const CONTROL_REPLY_TIMEOUT = Duration.seconds(5);

// T3's control add-on speaks JSON lines on its private socket; see controlAddon.ts.
const ControlMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("hello"), pid: Schema.Int }),
  Schema.Struct({
    type: Schema.Literal("state"),
    filepath: Schema.String,
    dirty: Schema.Boolean,
    agentListener: Schema.optional(
      Schema.Literals(["off", "starting", "ready", "failed", "untested"]),
    ),
    /** Blender Lab is running agent calls, or just has. */
    agentActing: Schema.optional(Schema.Boolean),
    /** The installed Blender Lab extension's version, when the launch asked for its listener. */
    mcpVersion: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({ type: Schema.Literal("saving") }),
  Schema.Struct({ type: Schema.Literal("saved") }),
  Schema.Struct({ type: Schema.Literal("quitFailed"), reason: Schema.Literal("saveFailed") }),
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
// The add-on enables and starts Blender Lab only on this; a stop it heard first wins.
const GRANT_AGENT_LISTENER = `${encodeListenerCommand({ type: "grantAgentListener" })}\n`;
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
const encodeControlCommand = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ type: Schema.Literal("quit"), save: Schema.Boolean })),
);

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
  }),
]);
type ControlRequest = typeof ControlRequest.Type;
type ControlRequestBody = ControlRequest extends infer Request
  ? Request extends ControlRequest
    ? Omit<Request, "id">
    : never
  : never;
const encodeControlRequest = Schema.encodeSync(Schema.fromJsonString(ControlRequest));
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
      options?: { readonly wait?: boolean },
    ) => Effect.Effect<AgentListenerReport | null>;
    readonly quit: (input: HostedBlenderQuitInput) => Effect.Effect<void, HostedBlenderError>;
    readonly threadState: (threadId: ThreadId) => Stream.Stream<HostedBlenderThreadState>;
    /** `canOperate`: the viewer may take control (`terminal:operate`). */
    readonly attachViewer: (
      threadId: string,
      options: { readonly canOperate: boolean },
    ) => Effect.Effect<HostedBlenderAttachResult, never, Scope.Scope>;
    /** The person's viewport window's camera, for an annotation of the frame shown now. */
    readonly captureView: (
      threadId: ThreadId,
    ) => Effect.Effect<HostedBlenderViewCapture, HostedBlenderError>;
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
  readonly threadId: ThreadId;
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
  openFile: string | null | undefined;
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

type PublishedState = HostedBlenderRunningState | { readonly status: "failed" };

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
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const agents = yield* Effect.serviceOption(HostedBlenderAgents.HostedBlenderAgents);
  const lookupContext = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | ThreadManagementService.ThreadManagementService
    | ProjectService.ProjectService
  >();
  const serviceScope = yield* Effect.scope;
  let screenshots = 0;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  let nextViewerId = 0;
  let nextShownAt = 0;

  const instances = new Map<string, Instance>();
  const states = yield* SubscriptionRef.make<ReadonlyMap<string, PublishedState>>(new Map());
  // Threads whose last start failed, until they open a file again.
  const failedStarts = new Set<string>();
  const userResourcesLock = yield* Semaphore.make(1);
  const rootDir = path.join(config.stateDir, "hosted-blender");

  const publishNow = () =>
    Effect.suspend(() =>
      SubscriptionRef.set(
        states,
        new Map<string, PublishedState>([
          ...Array.from(failedStarts, (threadId): [string, PublishedState] => [
            threadId,
            { status: "failed" },
          ]),
          ...Array.from(instances.values(), (instance): [string, PublishedState] => [
            instance.threadId,
            {
              status: instance.status,
              relativePath: instance.relativePath,
              dirty: instance.dirty,
              ...(instance.agentActing ? { agentActing: true } : {}),
            },
          ]),
        ]),
      ),
    );

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

  const markRunning = Effect.fnUntraced(function* (instance: Instance) {
    if (instance.status === "running") return;
    instance.status = "running";
    yield* publishNow();
  });

  const setAgentListener = Effect.fnUntraced(function* (
    instance: Instance,
    state: AgentListenerState,
  ) {
    instance.agentListener = state;
    if (state !== "starting") yield* Deferred.succeed(instance.agentListenerSettled, undefined);
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

  const handleControlLine = Effect.fnUntraced(function* (instance: Instance, line: string) {
    const message = decodeControlMessage(line);
    if (Option.isNone(message)) return;
    switch (message.value.type) {
      case "hello":
        instance.pid = message.value.pid;
        return;
      case "state": {
        instance.openFile = message.value.filepath === "" ? null : message.value.filepath;
        if (message.value.mcpVersion !== undefined) instance.mcpVersion = message.value.mcpVersion;
        // Only the working copy T3 opened may reach the agent, so the file is checked before
        // any listener state is taken; the add-on closes it too.
        const listener = message.value.agentListener;
        if (message.value.filepath !== instance.blendPath) {
          yield* revokeAgentListener(instance, "otherFile");
        } else {
          if (listener !== undefined && !instance.agentListenerRevoked) {
            yield* setAgentListener(instance, listener);
          }
          // Granted only once Blender has shown it has the launch file open.
          if (
            instance.agentListenerGranted &&
            !instance.agentListenerGrantSent &&
            !instance.agentListenerRevoked &&
            instance.control
          ) {
            instance.agentListenerGrantSent = true;
            yield* instance.control.write(GRANT_AGENT_LISTENER);
          }
        }
        // A report queued before T3 revoked access is stale: nothing acts after that.
        const agentActing = message.value.agentActing === true && !instance.agentListenerRevoked;
        if (instance.dirty === message.value.dirty && instance.agentActing === agentActing) return;
        instance.dirty = message.value.dirty;
        instance.agentActing = agentActing;
        return yield* publishNow();
      }
      case "saving":
      case "saved":
      case "quitFailed":
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
            instance.controlLost = true;
            // The add-on closes its listener when this connection drops, and nothing reopens it.
            if (!instance.agentListenerRevoked && instance.agentListener !== "off") {
              instance.agentAccessEnded = "connectionLost";
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

  const sampleMemory = Effect.fnUntraced(function* (instance: Instance) {
    if (instance.pid === null || !instance.capturing) return;
    const status = yield* fileSystem
      .readFileString(`/proc/${instance.pid}/status`)
      .pipe(Effect.orElseSucceed(() => ""));
    const kilobytes = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
    instance.memoryBytes = kilobytes === undefined ? null : Number(kilobytes) * 1024;
    const stats = statsMessage(instance);
    if (stats) yield* broadcast(instance, stats);
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
    const repos = (yield* fileSystem.readDirectory(extensions).pipe(Effect.orElseSucceed(() => [])))
      .toSorted()
      .toSorted((a, b) => Number(b === "lab_blender_org") - Number(a === "lab_blender_org"));
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
      // Everything a launch writes (labwc config, Blender's TMPDIR) goes when it ends.
      const launchesDir = path.join(rootDir, "launches");
      yield* fileSystem.makeDirectory(launchesDir, { recursive: true });
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({ directory: launchesDir });
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
      const agentPort =
        Option.isSome(agents) && instance.agentWorkingCopy
          ? yield* agents.value.listenerPort(instance.threadId)
          : null;
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
      const shell = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.flatMap((threads) => threads.getThreadShell(instance.threadId)),
        Effect.orElseSucceed(() => null),
        Effect.provideContext(lookupContext),
      );
      // The file `open` checked must still be that file, not a link swapped in since.
      if ((yield* fileSystem.realPath(instance.blendPath)) !== instance.blendPath) {
        return yield* Effect.logWarning("hosted Blender's file changed before it started");
      }

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
              mcpListen: agentPort !== null,
              ...(mcpSnapshot === null ? {} : { mcpSnapshot }),
              // Plan mode is read-only, whatever the runtime mode.
              autoRun: shell?.runtimeMode === "full-access" && shell.interactionMode !== "plan",
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
        // killing its process group would take its labwc watchdog down first.
        (child) =>
          Stream.run(
            Stream.encodeText(Stream.make(encodeHelperCommand({ type: "quit" }))),
            child.stdin,
          ).pipe(
            Effect.andThen(child.exitCode),
            Effect.timeout(HELPER_QUIT_TIMEOUT),
            Effect.catch(() => child.kill()),
            Effect.ignore,
          ),
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
      yield* sampleMemory(instance).pipe(
        Effect.repeat(Schedule.spaced(MEMORY_SAMPLE_INTERVAL)),
        Effect.forkScoped,
      );
      const exitCode = yield* Effect.raceFirst(
        handle.exitCode,
        Deferred.await(gaveUp).pipe(Effect.as("gave up" as const)),
      );
      if (exitCode !== 0) {
        yield* Effect.logWarning("hosted Blender's hidden display exited", { exitCode });
      }
    },
    Effect.scoped,
    (effect, instance) =>
      effect.pipe(
        Effect.catch((cause) => Effect.logWarning("hosted Blender failed", { cause })),
        Effect.ensuring(
          Effect.gen(function* () {
            instances.delete(instance.threadId);
            yield* settle(instance.session.close());
            if (instance.status === "starting" && !instance.quitting) {
              failedStarts.add(instance.threadId);
            }
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

  const threadRoot = (threadId: ThreadId) =>
    threadWorkspaceRoot(threadId).pipe(Effect.provideContext(lookupContext));

  const open: HostedBlender["Service"]["open"] = Effect.fn("HostedBlender.open")(function* (
    { threadId, relativePath },
    options,
  ) {
    yield* Effect.annotateCurrentSpan({ threadId });
    // Opening is the pane's first use, by a caller allowed to start programs here.
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

    const existing = instances.get(threadId);
    if (existing) {
      if (existing.relativePath === resolved.relativePath) return;
      return yield* new HostedBlenderError({ reason: "otherFileOpen" });
    }
    // One file is open in at most one hosted Blender, whichever thread opened it.
    if ([...instances.values()].some((other) => other.blendPath === real[1])) {
      return yield* new HostedBlenderError({ reason: "openInAnotherThread" });
    }
    const instance: Instance = {
      threadId,
      relativePath: resolved.relativePath,
      blendPath: real[1],
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
      agentWorkingCopy: options?.agentWorkingCopy === true,
      agentListener: "starting",
      agentListenerSettled: yield* Deferred.make<void>(),
      agentListenerRevoked: false,
      agentAccessEnded: null,
      agentListenerGranted: false,
      agentListenerGrantSent: false,
      controlLost: false,
      openFile: undefined,
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
    failedStarts.delete(threadId);
    instances.set(threadId, instance);
    yield* publishNow();
    instance.fiber = yield* run(instance, tools).pipe(Effect.forkIn(serviceScope));
  });

  const quit: HostedBlender["Service"]["quit"] = Effect.fn("HostedBlender.quit")(function* ({
    threadId,
    save,
  }) {
    yield* Effect.annotateCurrentSpan({ threadId, save });
    const instance = instances.get(threadId);
    if (instance === undefined) {
      if (!failedStarts.delete(threadId)) return;
      return yield* publishNow();
    }
    const control = instance.control;
    const forceQuit = Effect.gen(function* () {
      instance.quitting = true;
      if (instance.fiber) yield* Fiber.interrupt(instance.fiber);
    });
    const saveFailed = new HostedBlenderError({ reason: "saveFailed" });
    if (!save) {
      // Quit without saving: Blender may be stopped however it takes.
      if (control === null) return yield* forceQuit;
      instance.quitting = true;
      yield* control
        .write(`${encodeControlCommand({ type: "quit", save })}\n`)
        .pipe(Effect.raceFirst(Deferred.await(control.closed)));
      const ended = yield* Deferred.await(instance.ended).pipe(Effect.timeoutOption(QUIT_TIMEOUT));
      if (Option.isNone(ended)) yield* forceQuit;
      return;
    }
    // Save and quit never stops Blender before the add-on says the file is saved. A save
    // already asked for answers every caller, until Blender exits or it fails.
    let pending = instance.pendingSave;
    if (pending === null) {
      if (control === null) return yield* saveFailed;
      const started = yield* Deferred.make<boolean>();
      pending = started;
      instance.pendingSave = started;
      const clear = Effect.sync(() => {
        if (instance.pendingSave === started) instance.pendingSave = null;
      });
      yield* saveThenQuit(instance, control).pipe(
        // Only a failure clears it, before answering, so a retry starts a new save.
        Effect.tap((saved) => (saved ? Effect.void : clear)),
        Effect.flatMap((saved) => Deferred.succeed(started, saved)),
        Effect.onInterrupt(() => clear.pipe(Effect.andThen(Deferred.succeed(started, false)))),
        Effect.forkIn(serviceScope),
      );
    }
    if (!(yield* Deferred.await(pending))) return yield* saveFailed;
    instance.quitting = true;
    const ended = yield* Deferred.await(instance.ended).pipe(Effect.timeoutOption(QUIT_TIMEOUT));
    if (Option.isNone(ended)) yield* forceQuit;
  });

  const saveThenQuit = Effect.fn("HostedBlender.saveThenQuit")(
    function* (instance: Instance, connection: ControlConnection) {
      const replies = yield* Queue.unbounded<SaveReply>();
      instance.saveReplies = replies;
      return yield* requestSave({
        connection,
        replies,
        ended: Deferred.await(instance.ended),
        command: `${encodeControlCommand({ type: "quit", save: true })}\n`,
        replyTimeout: CONTROL_REPLY_TIMEOUT,
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
  const threadState: HostedBlender["Service"]["threadState"] = (threadId) =>
    Stream.zipLatest(setup.readiness, SubscriptionRef.changes(states)).pipe(
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
    if (visible) yield* joinOnKeyframe(instance);
  });

  // Acks arrive for every frame; they share the viewer's stream span.
  const ackFrame = Effect.fnUntraced(function* (instance: Instance, entry: ViewerEntry) {
    const now = yield* Clock.currentTimeMillis;
    const { next, latencyMs, requestKeyframe: wantsKeyframe } = entry.flow.ack(now);
    if (next) yield* Queue.offer(entry.queue, { _tag: "frame", data: next.data });
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
  )(function* (threadId, { canOperate }) {
    yield* Effect.annotateCurrentSpan({ threadId, canOperate });
    const instance = instances.get(threadId);
    if (instance === undefined) return { _tag: "stopped" as const };
    if (instance.viewers.length >= MAX_VIEWERS) return { _tag: "full" as const };
    const entry: ViewerEntry = {
      id: `viewer-${nextViewerId++}`,
      canOperate,
      // ViewerFlow keeps at most one frame queued; the rest are small, infrequent messages.
      queue: yield* Queue.unbounded<HostedBlenderViewerOutput>(),
      flow: new ViewerFlow(),
      size: null,
      visible: true,
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
    yield* joinOnKeyframe(instance);
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

  // Each request runs inside its caller's span (captureView, findHits, setView).
  const ask = Effect.fnUntraced(function* <A>(
    threadId: ThreadId,
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
    const instance = instances.get(threadId);
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
  )(function* (threadId) {
    yield* Effect.annotateCurrentSpan({ threadId });
    const instance = instances.get(threadId);
    if (instance === undefined || instance.controlDir === null) {
      return yield* new HostedBlenderError({ reason: "notRunning" });
    }
    // Rendering blocks Blender, so one screenshot renders at a time; callers meanwhile share it.
    if (instance.capture === null) {
      const capture = yield* Deferred.make<HostedBlenderViewCapture, HostedBlenderError>();
      instance.capture = capture;
      yield* renderScreenshot(threadId, instance.controlDir, capture).pipe(
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
    threadId: ThreadId,
    controlDir: string,
    capture: Deferred.Deferred<HostedBlenderViewCapture, HostedBlenderError>,
  ) {
    screenshots += 1;
    const file = path.join(controlDir, `view-${screenshots}.png`);
    const noScreenshot = new HostedBlenderError({ reason: "noScreenshot" });
    const outcome = yield* Effect.gen(function* () {
      // Blender renders the viewport region with the camera it reports, so the two always agree.
      const view = yield* ask(
        threadId,
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
    function* ({ threadId, projection, marks }) {
      yield* Effect.annotateCurrentSpan({ threadId, marks: marks.length });
      const instance = instances.get(threadId);
      if (instance === undefined) return yield* new HostedBlenderError({ reason: "notRunning" });
      return yield* ask(threadId, { type: "hits", ...projection, marks }, HostedBlenderHits, {
        slot: instance.hitsLock,
      });
    },
  );

  const setView: HostedBlender["Service"]["setView"] = Effect.fn("HostedBlender.setView")(
    function* ({ threadId, relativePath, view }) {
      yield* Effect.annotateCurrentSpan({ threadId });
      // The link was routed here on the client's last word on the file; Blender may have moved on.
      const instance = instances.get(threadId);
      if (instance !== undefined && instance.relativePath !== relativePath) {
        return yield* new HostedBlenderError({ reason: "otherFileOpen" });
      }
      yield* ask(threadId, { type: "setView", ...view }, Schema.Literal(true));
    },
  );

  const agentListener: HostedBlender["Service"]["agentListener"] = Effect.fn(
    "HostedBlender.agentListener",
  )(function* (threadId, options) {
    const instance = instances.get(threadId);
    if (instance === undefined) return null;
    const state =
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
    return {
      state,
      ended: agentAccessEndedFor(instance.controlLost, instance.agentAccessEnded),
      openFile: instance.openFile,
      mcpVersion: instance.mcpVersion,
    };
  });

  if (Option.isSome(agents)) {
    yield* agents.value.revocations.pipe(
      Stream.runForEach((threadId) =>
        Effect.forEach(
          [...instances.values()].filter(
            (instance) => threadId === null || instance.threadId === threadId,
          ),
          (instance) => revokeAgentListener(instance),
          { discard: true },
        ),
      ),
      Effect.forkIn(serviceScope),
    );
  }

  return HostedBlender.of({
    open,
    agentListener,
    quit,
    threadState,
    attachViewer,
    captureView,
    findHits,
    setView,
  });
});

export const layer = Layer.effect(HostedBlender, make);
