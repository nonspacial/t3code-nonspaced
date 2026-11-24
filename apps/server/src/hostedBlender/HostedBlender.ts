import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  HostedBlenderError,
  HostedBlenderFindHitsInput,
  HostedBlenderHits,
  type HostedBlenderOpenInput,
  type HostedBlenderQuitInput,
  type HostedBlenderRequirement,
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
import { resolveCommandPath } from "@t3tools/shared/shell";
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
import { CONTROL_ADDON_SOURCE } from "./controlAddon.ts";
import { type ControlConnection, requestSave, type SaveReply } from "./ControlSave.ts";
import { HeldInput } from "./HeldInput.ts";
import * as HiddenDisplayBinary from "./HiddenDisplayBinary.ts";
import {
  encodeHelperCommand,
  type HelperCommand,
  type HelperPacket,
  HelperPacketError,
  helperCommandForInput,
  HelperPacketReader,
  isHelperPacketError,
} from "./HelperProtocol.ts";
import { sendHoldingSlot } from "./ControlSlot.ts";
import { ViewerFlow } from "./ViewerFlow.ts";

const MAX_VIEWERS = 4;
const INITIAL_SIZE = { width: 1280, height: 720 };
const MEMORY_SAMPLE_INTERVAL = Duration.seconds(5);
const KEYFRAME_REQUEST_INTERVAL_MS = 250;
const QUIT_TIMEOUT = Duration.seconds(20);
const CONTROL_CONNECT_ATTEMPTS = 150;
// A start that shows no viewport window by then has failed (a broken file, no encoder).
const START_TIMEOUT = Duration.seconds(90);
const HELPER_QUIT_TIMEOUT = Duration.seconds(10);
const CONTROL_REPLY_TIMEOUT = Duration.seconds(5);

// T3's control add-on speaks JSON lines on its private socket; see controlAddon.ts.
const ControlMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("hello"), pid: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("state"), filepath: Schema.String, dirty: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("saving") }),
  Schema.Struct({ type: Schema.Literal("saved") }),
  Schema.Struct({ type: Schema.Literal("quitFailed"), reason: Schema.Literal("saveFailed") }),
  /** The answer to the request with this `id`. */
  Schema.Struct({ type: Schema.Literal("reply"), id: Schema.Int, result: Schema.Unknown }),
]);
const decodeControlMessage = Schema.decodeUnknownOption(Schema.fromJsonString(ControlMessage));
const encodeControlCommand = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ type: Schema.Literal("quit"), save: Schema.Boolean })),
);

// Requests about the person's viewport window, each answered by one `reply`.
const ControlRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("view"), id: Schema.Int }),
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

export type HostedBlenderViewerOutput =
  | { readonly _tag: "frame"; readonly data: Uint8Array }
  | { readonly _tag: "message"; readonly message: HostedBlenderStreamServerMessage }
  | { readonly _tag: "stopped" };

export interface HostedBlenderViewer {
  readonly output: Queue.Dequeue<HostedBlenderViewerOutput>;
  readonly ack: Effect.Effect<void>;
  /**
   * The viewer's pane size in device pixels. The display follows the viewer in control, or
   * the newest viewer while nobody is.
   */
  readonly resize: (width: number, height: number) => Effect.Effect<void>;
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
    readonly open: (input: HostedBlenderOpenInput) => Effect.Effect<void, HostedBlenderError>;
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
  readonly flow: ViewerFlow;
  size: { readonly width: number; readonly height: number } | null;
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
}

type Availability =
  | { readonly status: "ok"; readonly helper: string; readonly blender: string }
  | Extract<HostedBlenderThreadState, { status: "unavailable" | "notSetUp" }>;

type PublishedState = HostedBlenderRunningState | { readonly status: "failed" };

const sameState = (a: HostedBlenderThreadState, b: HostedBlenderThreadState) =>
  JSON.stringify(a) === JSON.stringify(b);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;
  const hiddenDisplay = yield* HiddenDisplayBinary.HiddenDisplayBinary;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const lookupContext = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | ThreadManagementService.ThreadManagementService
    | ProjectService.ProjectService
  >();
  const serviceScope = yield* Effect.scope;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  let nextViewerId = 0;

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
            { status: instance.status, relativePath: instance.relativePath, dirty: instance.dirty },
          ]),
        ]),
      ),
    );

  const availability = Effect.gen(function* (): Effect.fn.Return<
    Availability,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    if (platform !== "linux") return { status: "unavailable" };
    const missing: HostedBlenderRequirement[] = [];
    const helper = yield* hiddenDisplay.resolve.pipe(
      Effect.map((resolved): string | null => resolved),
      Effect.catchTags({
        HiddenDisplayBinaryUnsupported: () => Effect.undefined,
        HiddenDisplayBinaryNotFound: () => Effect.succeed(null),
        HiddenDisplayBinaryNotExecutable: () => Effect.succeed(null),
      }),
    );
    if (helper === undefined) return { status: "unavailable" };
    if (helper === null) missing.push("helper");
    const blender = yield* resolveCommandPath("blender");
    if (blender === null) missing.push("blender");
    if ((yield* resolveCommandPath("labwc")) === null) missing.push("labwc");
    if (helper === null || blender === null || missing.length > 0) {
      return { status: "notSetUp", missing };
    }
    return { status: "ok", helper, blender };
  }).pipe(Effect.provideContext(lookupContext));

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

  // The display follows the viewer in control, or the newest viewer while nobody is.
  const applySize = (instance: Instance) =>
    Effect.suspend(() => {
      const sizer =
        instance.viewers.find((viewer) => viewer.id === instance.session.controller) ??
        instance.viewers.at(-1);
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
  const requestKeyframe = Effect.fnUntraced(function* (instance: Instance) {
    const now = yield* Clock.currentTimeMillis;
    if (now - instance.lastKeyframeRequest < KEYFRAME_REQUEST_INTERVAL_MS) return;
    instance.lastKeyframeRequest = now;
    yield* instance.helper({ type: "keyframe" });
  });

  const handlePacket = Effect.fnUntraced(function* (instance: Instance, packet: HelperPacket) {
    if (packet._tag === "video") {
      let wantsKeyframe = false;
      for (const viewer of instance.viewers) {
        const offered = viewer.flow.offer(packet);
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
        if (instance.viewers.length === 0) yield* instance.helper({ type: "pause" });
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

  const handleControlLine = Effect.fnUntraced(function* (instance: Instance, line: string) {
    const message = decodeControlMessage(line);
    if (Option.isNone(message)) return;
    switch (message.value.type) {
      case "hello":
        instance.pid = message.value.pid;
        return;
      case "state":
        if (instance.dirty === message.value.dirty) return;
        instance.dirty = message.value.dirty;
        return yield* publishNow();
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
        Effect.retry({ schedule: Schedule.spaced("200 millis"), times: CONTROL_CONNECT_ATTEMPTS }),
      );
      const writer = yield* socket.writer;
      const closed = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
      instance.control = { write: (line) => writer.write(line).pipe(Effect.ignore), closed };
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
          Effect.sync(() => {
            // Nothing more will answer the requests still waiting.
            instance.requests.clear();
            instance.control = null;
          }),
        ),
      ),
  );

  const sampleMemory = Effect.fnUntraced(function* (instance: Instance) {
    if (instance.pid === null || instance.viewers.length === 0) return;
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

  /** T3's own copy of the user's newest Blender settings, made on first use. */
  const ensureUserResources = userResourcesLock.withPermits(1)(
    Effect.gen(function* () {
      const target = path.join(rootDir, "user-resources");
      if (yield* fileSystem.exists(target)) return target;
      const configHome = environment.XDG_CONFIG_HOME || path.join(homeDirectory, ".config");
      const source = path.join(configHome, "blender");
      const version = newestBlenderConfigVersion(
        yield* fileSystem.readDirectory(source).pipe(Effect.orElseSucceed(() => [])),
      );
      const partial = `${target}.partial`;
      yield* fileSystem.remove(partial, { recursive: true, force: true });
      if (version === undefined) {
        yield* fileSystem.makeDirectory(partial, { recursive: true });
      } else {
        yield* copyWithoutLinks(path.join(source, version), partial);
      }
      yield* fileSystem.rename(partial, target);
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
      const mcpPort = yield* net.reserveLoopbackPort();
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

  const open: HostedBlender["Service"]["open"] = Effect.fn("HostedBlender.open")(function* ({
    threadId,
    relativePath,
  }) {
    yield* Effect.annotateCurrentSpan({ threadId });
    const tools = yield* availability;
    if (tools.status !== "ok") return yield* new HostedBlenderError({ reason: tools.status });
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
      lastKeyframeRequest: 0,
      helper: () => Effect.void,
      control: null,
      saveReplies: null,
      pendingSave: null,
      requests: new Map(),
      hitsLock: yield* Semaphore.make(1),
      lastRequestId: 0,
      fiber: null,
      quitting: false,
      session: new SessionControl(null),
      held: new HeldInput(),
      cursorCaptured: false,
      displaySize: "",
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

  const threadState: HostedBlender["Service"]["threadState"] = (threadId) =>
    Stream.unwrap(
      availability.pipe(
        Effect.map((available) =>
          available.status !== "ok"
            ? Stream.concat(Stream.succeed<HostedBlenderThreadState>(available), Stream.never)
            : SubscriptionRef.changes(states).pipe(
                Stream.map(
                  (running): HostedBlenderThreadState =>
                    running.get(threadId) ?? { status: "stopped" },
                ),
                Stream.changesWith(sameState),
              ),
        ),
      ),
    );

  const detach = Effect.fnUntraced(function* (instance: Instance, entry: ViewerEntry) {
    const index = instance.viewers.indexOf(entry);
    if (index >= 0) instance.viewers.splice(index, 1);
    yield* Queue.shutdown(entry.queue);
    yield* releaseControl(instance, entry);
    yield* applySize(instance);
    // With nobody watching, capture and encoding stop entirely.
    if (instance.viewers.length === 0) yield* instance.helper({ type: "pause" });
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
    if (instance.viewers.length === 1) yield* instance.helper({ type: "resume" });
    // Each viewer joins on a keyframe.
    instance.lastKeyframeRequest = 0;
    yield* requestKeyframe(instance);
    return {
      _tag: "attached" as const,
      viewer: {
        output: entry.queue,
        ack: Effect.suspend(() => {
          const next = entry.flow.ack();
          return next ? Queue.offer(entry.queue, { _tag: "frame", data: next.data }) : Effect.void;
        }).pipe(Effect.asVoid),
        resize: (width, height) =>
          Effect.suspend(() => {
            entry.size = { width, height };
            return applySize(instance);
          }),
        input: (message) => handleViewerInput(instance, entry, message),
      },
    };
  });

  // Each request runs inside its caller's span (captureView, findHits, setView).
  const ask = Effect.fnUntraced(function* <A>(
    threadId: ThreadId,
    body: ControlRequestBody,
    result: Schema.Decoder<A>,
    /** One slot of this is held until the add-on answers or its connection closes. */
    slot?: Semaphore.Semaphore,
  ) {
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
      Effect.timeoutOption(CONTROL_REPLY_TIMEOUT),
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
    return yield* ask(threadId, { type: "view" }, HostedBlenderViewCapture);
  });

  const findHits: HostedBlender["Service"]["findHits"] = Effect.fn("HostedBlender.findHits")(
    function* ({ threadId, projection, marks }) {
      yield* Effect.annotateCurrentSpan({ threadId, marks: marks.length });
      const instance = instances.get(threadId);
      if (instance === undefined) return yield* new HostedBlenderError({ reason: "notRunning" });
      return yield* ask(
        threadId,
        { type: "hits", ...projection, marks },
        HostedBlenderHits,
        instance.hitsLock,
      );
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

  return HostedBlender.of({
    open,
    quit,
    threadState,
    attachViewer,
    captureView,
    findHits,
    setView,
  });
});

export const layer = Layer.effect(HostedBlender, make);
