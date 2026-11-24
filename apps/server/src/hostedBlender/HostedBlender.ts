import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  HostedBlenderError,
  type HostedBlenderDismissInput,
  HostedBlenderFindHitsInput,
  HostedBlenderHits,
  type HostedBlenderOpenInput,
  type HostedBlenderQuitInput,
  type HostedBlenderReopenInput,
  type HostedBlenderRunningList,
  type HostedBlenderRunningState,
  HostedBlenderSetViewInput,
  type HostedBlenderStreamServerMessage,
  type HostedBlenderViewerMessage,
  type HostedBlenderThreadState,
  ThreadId,
  TrimmedNonEmptyString,
  HostedBlenderViewCapture,
  HostedBlenderViewProjection,
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
import { CONTROL_ADDON_SOURCE } from "./controlAddon.ts";
import { type ControlConnection, requestSave, type SaveReply } from "./ControlSave.ts";
import { HeldInput } from "./HeldInput.ts";
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
  newestSession,
  type RestoreState,
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
// to finish their quit copies, and the rest is left for stopping them.
const SHUTDOWN_QUIT_TIMEOUT = Duration.millis(4000);
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
// A start that shows no viewport window by then has failed (a broken file, no encoder).
const START_TIMEOUT = Duration.seconds(90);
const CONTROL_CONNECT_INTERVAL = Duration.millis(200);
// The add-on's socket can appear as late as the viewport window, so connecting covers it all.
const CONTROL_CONNECT_ATTEMPTS = Math.ceil(
  Duration.toMillis(START_TIMEOUT) / Duration.toMillis(CONTROL_CONNECT_INTERVAL),
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
    /** How the restore T3 asked for went, once it has run. */
    restore: Schema.optional(Schema.Literals(["ok", "failed"])),
  }),
  Schema.Struct({ type: Schema.Literal("quitting") }),
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

/** What a thread's last hosted Blender left to reopen, kept on disk across restarts. */
const RecoveryRecord = Schema.Struct({
  threadId: ThreadId,
  kind: Schema.Literals(["closed", "crashed"]),
  relativePath: TrimmedNonEmptyString,
  /** Its session file (`session.blend` beside the record) holds a copy to restore. */
  recovery: Schema.Boolean,
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
  }),
);
const decodeLaunchRecord = Schema.decodeUnknownOption(LaunchRecord);
const encodeLaunchRecord = Schema.encodeSync(LaunchRecord);

/** What salvage needs to apply the same cleanup a run's own end would. */
const RunFacts = Schema.fromJsonString(
  Schema.Struct({
    restore: Schema.Literals(["none", "pending", "ok", "failed"]),
    saved: Schema.Boolean,
    changed: Schema.Boolean,
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
    readonly open: (input: HostedBlenderOpenInput) => Effect.Effect<void, HostedBlenderError>;
    readonly quit: (input: HostedBlenderQuitInput) => Effect.Effect<void, HostedBlenderError>;
    /** Reopens the thread's closed or crashed Blender, restoring its recovery copy if asked. */
    readonly reopen: (input: HostedBlenderReopenInput) => Effect.Effect<void, HostedBlenderError>;
    /** Forgets what a stopped thread's Blender left to reopen. A running one is left alone. */
    readonly dismiss: (input: HostedBlenderDismissInput) => Effect.Effect<void>;
    /**
     * Saves a recovery copy and quits the thread's Blender, without waiting for it: the thread
     * settled, was archived or was deleted.
     */
    readonly closeOnSettle: (input: { readonly threadId: ThreadId }) => Effect.Effect<void>;
    /** Every hosted Blender on this server, for Settings. */
    readonly runningBlenders: Stream.Stream<HostedBlenderRunningList>;
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
  /** Set when T3 quits it for its thread or a shutdown, which keeps a recovery copy. */
  ending: boolean;
  blenderExit: BlenderExit | null;
  /** The recovery copy or autosave this run restored over the file. */
  recover: string | null;
  /** The add-on confirmed a save before quitting, so nothing is left to recover. */
  saved: boolean;
  /** The add-on said it is saving or writing its quit copy; stopping it now could cut that short. */
  acknowledged: boolean;
  /** Stopped as a shutdown runs out of time: the helper gets no grace. */
  stopNow: boolean;
  /** Its thread settled: T3 is closing it, though the quit itself may not have begun. */
  closeRequested: boolean;
  /** `pending` until the add-on reports the restore of `recover`. */
  restore: RestoreState;
  /** Blender showed its viewport window. */
  shown: boolean;
  /** Changed before T3 began ending it. */
  changed: boolean;
  controlReady: Deferred.Deferred<void>;
  stateDir: string | null;
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

type PublishedState =
  | HostedBlenderRunningState
  | { readonly status: "failed" }
  | {
      readonly status: "closed" | "crashed";
      readonly relativePath: string;
      readonly recovery: boolean;
      readonly restoreFailed?: boolean;
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
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
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
  const states = yield* SubscriptionRef.make<ReadonlyMap<string, PublishedState>>(new Map());
  const running = yield* SubscriptionRef.make<HostedBlenderRunningList>([]);
  // Threads whose last start failed, until they open a file again.
  const failedStarts = new Set<string>();
  // Each thread's last closed or crashed Blender, until it is reopened and ends again, or is
  // dismissed. Mirrors the records under `recovery/`.
  const records = new Map<string, RecoveryRecord>();
  // Threads whose last restore failed; their copy is kept and the pane says so.
  const failedRestores = new Set<string>();
  const userResourcesLock = yield* Semaphore.make(1);
  const rootDir = path.join(config.stateDir, "hosted-blender");
  const launchesDir = path.join(rootDir, "launches");
  // Thread ids are opaque, so each gets a folder name that can't leave `recovery/`.
  const recoveryDir = (threadId: string) =>
    path.join(rootDir, "recovery", Buffer.from(threadId).toString("base64url"));
  const sessionPath = (threadId: string) => path.join(recoveryDir(threadId), "session.blend");

  const publishRunning = () =>
    Effect.suspend(() =>
      SubscriptionRef.set(
        running,
        Array.from(instances.values(), (instance) => ({
          threadId: instance.threadId,
          status: instance.status,
          relativePath: instance.relativePath,
          dirty: instance.dirty,
          memoryBytes: instance.memoryBytes,
        })),
      ),
    );

  // A running Blender outranks what an earlier one left to reopen, and that outranks a failed
  // start, so a restore that fails to start still offers its recovery copy.
  const publishNow = () =>
    Effect.suspend(() =>
      SubscriptionRef.set(
        states,
        new Map<string, PublishedState>([
          ...Array.from(failedStarts, (threadId): [string, PublishedState] => [
            threadId,
            { status: "failed" },
          ]),
          ...Array.from(records.values(), (record): [string, PublishedState] => [
            record.threadId,
            {
              status: record.kind,
              relativePath: record.relativePath,
              recovery: record.recovery,
              ...(failedRestores.has(record.threadId) ? { restoreFailed: true } : {}),
            },
          ]),
          ...Array.from(instances.values(), (instance): [string, PublishedState] => [
            instance.threadId,
            { status: instance.status, relativePath: instance.relativePath, dirty: instance.dirty },
          ]),
        ]),
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

  /**
   * Keeps the newest session Blender left in `tmpDir` as the thread's recovery copy. With none,
   * or when the run changed nothing (`unchanged`), an earlier copy of the same file stays: it is
   * still the newest unsaved work T3 has.
   */
  const keepRecord = Effect.fn("HostedBlender.keepRecord")(function* (input: {
    readonly threadId: ThreadId;
    readonly relativePath: string;
    readonly kind: RecoveryRecord["kind"];
    readonly tmpDir: string;
    readonly unchanged: boolean;
  }) {
    const dir = recoveryDir(input.threadId);
    yield* fileSystem.makeDirectory(dir, { recursive: true });
    const names = yield* fileSystem
      .readDirectory(input.tmpDir)
      .pipe(Effect.orElseSucceed(() => []));
    const files = yield* Effect.forEach(names, (name) =>
      fileSystem.stat(path.join(input.tmpDir, name)).pipe(
        Effect.map((info) => ({
          name,
          mtimeMs:
            info.type === "File"
              ? Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() })
              : -1,
        })),
        Effect.orElseSucceed(() => ({ name, mtimeMs: -1 })),
      ),
    );
    const previous = records.get(input.threadId);
    const keepsPrevious =
      previous?.recovery === true && previous.relativePath === input.relativePath;
    const newest =
      keepsPrevious && input.unchanged
        ? undefined
        : newestSession(files.filter((file) => file.mtimeMs >= 0));
    let recovery = false;
    if (newest !== undefined) {
      yield* writeAtomically(sessionPath(input.threadId), (to) =>
        fileSystem.copyFile(path.join(input.tmpDir, newest), to),
      );
      recovery = true;
    } else if (keepsPrevious) {
      recovery = true;
    } else {
      yield* fileSystem.remove(sessionPath(input.threadId), { force: true });
    }
    const record: RecoveryRecord = {
      threadId: input.threadId,
      kind: input.kind,
      relativePath: input.relativePath,
      recovery,
    };
    yield* writeAtomically(path.join(dir, "record.json"), (to) =>
      fileSystem.writeFileString(to, encodeRecoveryRecord(record)),
    );
    records.set(input.threadId, record);
  });

  const forgetRecord = Effect.fn("HostedBlender.forgetRecord")(function* (threadId: string) {
    failedRestores.delete(threadId);
    if (!records.delete(threadId)) return false;
    yield* fileSystem
      .remove(recoveryDir(threadId), { recursive: true, force: true })
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
              saved: instance.saved,
              changed: instance.changed,
            }),
          ),
        ).pipe(Effect.ignore);

  /** Applies a run's cleanup, its end or salvaged; a failure leaves the launch for later. */
  const applyCleanup = Effect.fnUntraced(function* (
    run: { readonly threadId: ThreadId; readonly relativePath: string; readonly tmpDir: string },
    cleanup: ReturnType<typeof cleanupOf>,
  ) {
    if (cleanup.action === "keep") {
      yield* keepRecord({ ...run, kind: cleanup.kind, unchanged: cleanup.unchanged });
    } else if (cleanup.action === "forget") {
      yield* forgetRecord(run.threadId);
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
    const running = yield* leftoverProcesses(helperPid, launchDir);
    if (running.length === 0) return true;
    const asked = running.includes(helperPid) ? [helperPid] : running;
    yield* Effect.sync(() => asked.forEach((pid) => signalProcess(pid, "SIGTERM")));
    const gone = (timeout: Duration.Input) =>
      leftoverProcesses(helperPid, launchDir).pipe(
        Effect.repeat({
          while: (left) => left.length > 0,
          schedule: Schedule.spaced("100 millis"),
        }),
        Effect.timeoutOption(timeout),
      );
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
        const { threadId, relativePath } = launch.value;
        const read = (name: string) =>
          fileSystem
            .readFileString(path.join(launchDir, name))
            .pipe(Effect.orElseSucceed(() => ""));
        const facts = Option.getOrElse(decodeRunFacts(yield* read("run.json")), () => ({
          restore: "none" as const,
          saved: false,
          changed: true,
        }));
        // T3 was closing it, or it stopped with the server: a crash, for all T3 knows.
        const ending = (yield* read("outcome")) === "closing" ? "closed" : "crashed";
        yield* applyCleanup(
          { threadId, relativePath, tmpDir: path.join(launchDir, "tmp") },
          cleanupOf({ ...facts, ending }),
        );
      }
      yield* fileSystem.remove(launchDir, { recursive: true, force: true });
    },
    // A launch that can't be salvaged stays for the next start to try again.
    Effect.catch((cause) => Effect.logWarning("couldn't salvage a hosted Blender", { cause })),
  );

  // What earlier runs of this server left: their records, and the launch folders of Blenders a
  // stopped server didn't finish ending. This completes before the service takes any request.
  const restoreRecords = Effect.gen(function* () {
    const recoveryRoot = path.join(rootDir, "recovery");
    for (const entry of yield* fileSystem
      .readDirectory(recoveryRoot)
      .pipe(Effect.orElseSucceed(() => []))) {
      const text = yield* fileSystem
        .readFileString(path.join(recoveryRoot, entry, "record.json"))
        .pipe(Effect.orElseSucceed(() => ""));
      const record = decodeRecoveryRecord(text);
      if (
        Option.isSome(record) &&
        recoveryDir(record.value.threadId) === path.join(recoveryRoot, entry)
      ) {
        records.set(record.value.threadId, record.value);
      }
    }
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
  yield* restoreRecords;
  yield* publishNow();

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

  const updateRestore = Effect.fnUntraced(function* (instance: Instance, result: "ok" | "failed") {
    if (instance.restore !== "pending") return;
    instance.restore = result;
    yield* writeRunFacts(instance);
    if (result === "ok") {
      if (instance.shown) yield* markRunning(instance);
      return;
    }
    // The file as saved is open instead; quitting it keeps the copy for another try.
    failedRestores.add(instance.threadId);
    yield* quitWithoutSaving(instance).pipe(Effect.forkIn(serviceScope));
  });

  const handleControlLine = Effect.fnUntraced(function* (instance: Instance, line: string) {
    const message = decodeControlMessage(line);
    if (Option.isNone(message)) return;
    switch (message.value.type) {
      case "hello":
        instance.pid = message.value.pid;
        return;
      case "state":
        if (message.value.restore !== undefined) {
          yield* updateRestore(instance, message.value.restore);
        }
        if (message.value.dirty && !instance.ending && !instance.changed) {
          instance.changed = true;
          yield* writeRunFacts(instance);
        }
        if (instance.dirty === message.value.dirty) return;
        instance.dirty = message.value.dirty;
        return yield* publishNow();
      case "quitting":
        instance.acknowledged = true;
        return;
      case "saved":
        instance.saved = true;
        yield* writeRunFacts(instance);
        if (instance.saveReplies) yield* Queue.offer(instance.saveReplies, "saved");
        return;
      case "saving":
      case "quitFailed":
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
          schedule: Schedule.spaced(CONTROL_CONNECT_INTERVAL),
          times: CONTROL_CONNECT_ATTEMPTS,
        }),
      );
      const writer = yield* socket.writer;
      const closed = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
      instance.control = { write: (line) => writer.write(line).pipe(Effect.ignore), closed };
      yield* Deferred.succeed(instance.controlReady, undefined);
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
      // Everything a launch writes (labwc config, Blender's TMPDIR) goes when it ends, once
      // what it leaves to reopen is kept. Until then, the next start can still salvage it.
      yield* fileSystem.makeDirectory(launchesDir, { recursive: true });
      const stateDir = yield* fileSystem.makeTempDirectory({ directory: launchesDir });
      instance.stateDir = stateDir;
      const launchRecord = { threadId: instance.threadId, relativePath: instance.relativePath };
      // Runs once the helper and Blender have stopped: a closed or crashed Blender's quit copy
      // or newest autosave is kept to reopen; a quit Blender's earlier record goes with it. A
      // restore that never succeeded leaves the copy it came from alone.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* applyCleanup(
            {
              threadId: instance.threadId,
              relativePath: instance.relativePath,
              tmpDir: path.join(stateDir, "tmp"),
            },
            cleanupOf({
              restore: instance.restore,
              saved: instance.saved,
              changed: instance.changed,
              ending: endingOf({
                wasRunning: instance.status === "running",
                ending: instance.ending,
                quitting: instance.quitting,
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
              recover: instance.recover,
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
          Stream.run(
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

  // Shared by open and reopen, whose spans it runs in.
  const start = Effect.fnUntraced(function* (
    threadId: ThreadId,
    relativePath: string,
    recover: string | null,
    /** Reopen may start while a copy waits; open may not, since its ending would replace it. */
    allowPendingRecovery: boolean,
  ) {
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

    const ended = yield* Deferred.make<void>();
    const controlReady = yield* Deferred.make<void>();
    // Checked together, with no wait before the launch is reserved below.
    const existing = instances.get(threadId);
    if (existing) {
      if (existing.relativePath === resolved.relativePath) return;
      return yield* new HostedBlenderError({ reason: "otherFileOpen" });
    }
    if (!allowPendingRecovery && records.get(threadId)?.recovery === true) {
      return yield* new HostedBlenderError({ reason: "recoveryPending" });
    }
    // One file is open in at most one hosted Blender, whichever thread opened it.
    if ([...instances.values()].some((other) => other.blendPath === real[1])) {
      return yield* new HostedBlenderError({ reason: "openInAnotherThread" });
    }
    const instance: Instance = {
      threadId,
      relativePath: resolved.relativePath,
      blendPath: real[1],
      ended,
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
      recover,
      saved: false,
      acknowledged: false,
      stopNow: false,
      closeRequested: false,
      restore: recover === null ? "none" : "pending",
      shown: false,
      changed: false,
      controlReady,
      stateDir: null,
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
    instance.fiber = yield* run(instance, tools).pipe(Effect.forkIn(runScope));
  });

  const open: HostedBlender["Service"]["open"] = Effect.fn("HostedBlender.open")(function* ({
    threadId,
    relativePath,
  }) {
    yield* Effect.annotateCurrentSpan({ threadId });
    yield* start(threadId, relativePath, null, false);
  });

  const reopen: HostedBlender["Service"]["reopen"] = Effect.fn("HostedBlender.reopen")(function* ({
    threadId,
    restore,
  }) {
    yield* Effect.annotateCurrentSpan({ threadId, restore });
    if (instances.has(threadId)) return;
    const record = records.get(threadId);
    if (record === undefined) return yield* new HostedBlenderError({ reason: "nothingToReopen" });
    failedRestores.delete(threadId);
    // The record stays until this Blender ends too, so a restore that fails keeps its copy.
    yield* start(
      threadId,
      record.relativePath,
      restore && record.recovery ? sessionPath(threadId) : null,
      true,
    );
  });

  const dismiss: HostedBlender["Service"]["dismiss"] = Effect.fn("HostedBlender.dismiss")(
    function* ({ threadId }) {
      yield* Effect.annotateCurrentSpan({ threadId });
      if (instances.has(threadId)) return;
      const failed = failedStarts.delete(threadId);
      if (!(yield* forgetRecord(threadId)) && !failed) return;
      yield* publishNow();
    },
  );

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
  ) {
    const connected = yield* within(Deferred.await(instance.controlReady), deadline).pipe(
      Effect.raceFirst(Deferred.await(instance.ended).pipe(Effect.as(Option.none()))),
    );
    const control = instance.control;
    if (Option.isNone(connected) || control === null) return false;
    yield* control
      .write(`${encodeControlCommand({ type: "quit", save: false })}\n`)
      .pipe(Effect.raceFirst(Deferred.await(control.closed)));
    return true;
  });

  const quitWithoutSaving = Effect.fn("HostedBlender.quitWithoutSaving")(function* (
    instance: Instance,
  ) {
    instance.quitting = true;
    // Quitting a Blender still starting has nothing of its session to keep.
    if (instance.control === null) return yield* forceQuit(instance);
    const deadline = yield* deadlineIn(QUIT_TIMEOUT, false);
    if (!(yield* sendQuitWithoutSaving(instance, deadline))) return yield* forceQuit(instance);
    yield* awaitEnded(instance, deadline);
  });

  /** Quits without saving, so Blender writes its quit copy, which the run keeps to reopen. */
  const end = Effect.fn("HostedBlender.end")(function* (instance: Instance, given: Deadline) {
    yield* Effect.annotateCurrentSpan({ threadId: instance.threadId, shutdown: given.shutdown });
    let deadline = given;
    // A Save and quit already under way decides first; only a failed one leaves work to keep.
    // Settling waits for its answer however long the save takes (an unacknowledged one answers
    // within seconds); a shutdown keeps its one deadline.
    const pending = instance.pendingSave;
    if (pending !== null) {
      let saved: boolean;
      if (deadline.shutdown) {
        const answered = yield* within(Deferred.await(pending), deadline);
        if (Option.isNone(answered)) return yield* pastDeadline(instance, deadline);
        saved = answered.value;
      } else {
        saved = yield* Deferred.await(pending);
      }
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
    const instance = instances.get(threadId);
    if (instance === undefined) return;
    instance.closeRequested = true;
    const deadline = yield* deadlineIn(QUIT_TIMEOUT, false);
    yield* end(instance, deadline).pipe(Effect.forkIn(serviceScope));
  });

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
  }) {
    yield* Effect.annotateCurrentSpan({ threadId, save });
    // Nothing running: a stale Quit never touches what an ended Blender kept. Discard does.
    const instance = instances.get(threadId);
    if (instance === undefined) return;
    const control = instance.control;
    const saveFailed = new HostedBlenderError({ reason: "saveFailed" });
    if (!save) return yield* quitWithoutSaving(instance);
    // Save and quit never stops Blender before the add-on says the file is saved. A save
    // already asked for answers every caller, until Blender exits or it fails.
    let pending = instance.pendingSave;
    if (pending === null) {
      if (control === null) return yield* saveFailed;
      const started = yield* Deferred.make<boolean>();
      pending = started;
      instance.pendingSave = started;
      const clear = Effect.suspend(() => {
        if (instance.pendingSave !== started) return Effect.void;
        instance.pendingSave = null;
        // Blender stays open after a failed save: capture follows the panes again.
        return applyCapture(instance);
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
    if (!(yield* Deferred.await(pending))) return yield* saveFailed;
    instance.quitting = true;
    const ended = yield* Deferred.await(instance.ended).pipe(Effect.timeoutOption(QUIT_TIMEOUT));
    if (Option.isNone(ended)) yield* forceQuit(instance);
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

  const runningBlenders: HostedBlender["Service"]["runningBlenders"] = SubscriptionRef.changes(
    running,
  ).pipe(Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)));
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

  return HostedBlender.of({
    open,
    quit,
    reopen,
    dismiss,
    closeOnSettle,
    threadState,
    attachViewer,
    runningBlenders,
    captureView,
    findHits,
    setView,
  });
});

export const layer = Layer.effect(HostedBlender, make);
