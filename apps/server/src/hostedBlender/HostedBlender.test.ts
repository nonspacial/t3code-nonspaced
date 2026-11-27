// @effect-diagnostics nodeBuiltinImport:off - the real-Blender fixture probes the host and reads Blender's /proc entries.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  type HostedBlenderHeldList,
  type HostedBlenderThreadState,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as BlendFileWatcher from "../blend/BlendFileWatcher.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { HOSTED_STARTUP_GATE_SOURCE } from "./agentGuard.ts";
import { startAgentWorkingCopy } from "./agentWorkingCopy.ts";
import { workingCopyName } from "./workingCopies.ts";
import { CONTROL_ADDON_SOURCE } from "./controlAddon.ts";
import * as DesktopBlender from "./DesktopBlender.ts";
import * as HostedBlender from "./HostedBlender.ts";
import * as HostedBlenderAgents from "./HostedBlenderAgents.ts";
import * as HostedBlenderSetup from "./HostedBlenderSetup.ts";
import * as LoopbackPeer from "./loopbackPeer.ts";

const threadId = ThreadId.make("thread-hosted-blender");
const otherThreadId = ThreadId.make("thread-same-workspace");

interface Host {
  readonly helper?: string | null;
  /** What setup reports; by default ready with `helper` and the first Blender on PATH. */
  readonly readiness?: HostedBlenderSetup.HostedBlenderReadiness;
  readonly env: NodeJS.ProcessEnv;
  readonly workspaceRoot: string;
  readonly baseDir: string;
  /** Runs before each thread lookup, so a test can hold `open` mid-validation. */
  readonly beforeThreadLookup?: () => Effect.Effect<void>;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: "default" | "plan";
  /** The thread's agent session holds the hosted Blender MCP on this port. */
  readonly agentPort?: number;
  /** Agent access T3 takes back, by thread (null for every thread). */
  /** What setup reports after its first readiness, as Settings changes it. */
  readonly readinessChanges?: Stream.Stream<HostedBlenderSetup.HostedBlenderReadiness>;
  readonly revocations?: Stream.Stream<HostedBlenderAgents.HostedBlenderRevocation | null>;
  /** Each role's agent access ending, as HostedBlender reports it. */
  readonly accessEnded?: Queue.Queue<{
    readonly threadId: ThreadId;
    readonly role: HostedBlenderAgents.HostedBlenderRole;
    readonly grant: string;
  }>;
  /** Each thread's `blender-master` port, held by its agent session. */
  readonly masterPorts?: ReadonlyMap<ThreadId, number>;
  /** "Allow agents to start hosted Blenders"; on by default. */
  readonly agentsAllowed?: boolean;
  /** Threads whose agent session has ended since it asked. */
  readonly endedSessions?: ReadonlySet<ThreadId>;
  /** Each thread's current agent session; "session-1" when unnamed. */
  readonly sessions?: ReadonlyMap<ThreadId, string>;
  /** The master's own listener port, from the shared registry. */
  readonly privatePort?: number;
  /** The user's desktop Blender, as T3 reaches it; none by default. */
  readonly desktop?: DesktopBlender.DesktopBlender["Service"];
  /** The TCP tables a master's relay reads its clients' accounts from; the kernel's by default. */
  readonly tcpTables?: ReadonlyArray<string>;
  /** Runs after each settings read; a test holds one there. */
  readonly afterSettingsRead?: Effect.Effect<void>;
  /** Holds back T3's words to the add-on. */
  readonly heldWords?: (word: "connected" | "viewportShown") => Effect.Effect<void>;
  /** Whether the thread is settled now; it is unless a test makes it active again. */
  readonly threadSettled?: () => boolean;
  /** Whether the thread is archived now, rather than settled. */
  readonly threadArchived?: () => boolean;
  /** Holds a working copy's hold between copying it out and removing it from the project. */
  readonly holdGate?: (copyPath: string) => Effect.Effect<void>;
  /** The files the service sees, such as T3's state on another drive: `otherDrive`. */
  readonly fileSystem?: (base: FileSystem.FileSystem) => FileSystem.FileSystem;
}

const systemError = (method: string, path: string, code: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    syscall: method,
    cause: Object.assign(new Error(code), { code }),
  });

/**
 * T3's state on another drive than the project, as on most machines: a rename between them fails
 * as the kernel's does, and `afterCopy` runs as each copy into the state finishes.
 */
const otherDrive =
  (afterCopy: (from: string) => Effect.Effect<void, PlatformError.PlatformError>) =>
  (base: FileSystem.FileSystem): FileSystem.FileSystem => ({
    ...base,
    rename: (from, to) =>
      /\/(held-)?working-copies\//.test(to) && !/\/(held-)?working-copies\//.test(from)
        ? Effect.fail(systemError("rename", from, "EXDEV"))
        : base.rename(from, to),
    copyFile: (from, to) =>
      base
        .copyFile(from, to)
        .pipe(Effect.andThen(to.includes("/working-copies/") ? afterCopy(from) : Effect.void)),
  });

const blenderOnPath = (env: NodeJS.ProcessEnv) =>
  (env.PATH ?? "")
    .split(NodePath.delimiter)
    .filter(Boolean)
    .map((dir) => NodePath.join(dir, "blender"))
    .find((candidate) => NodeFS.existsSync(candidate));

const readinessFor = (host: Host): HostedBlenderSetup.HostedBlenderReadiness => {
  if (host.readiness) return host.readiness;
  const blender = blenderOnPath(host.env);
  return host.helper == null || blender === undefined
    ? { status: "notSetUp", missing: ["helper"] }
    : { status: "ok", helper: host.helper, blender, blenderMcp: null, blenderMcpCapture: null };
};

/** Test settings whose writes reach `subscribeChanges`, which `layerTest` never streams. */
const changingSettings = (afterRead: Effect.Effect<void> = Effect.void) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettings.ServerSettingsService;
      const changes = yield* PubSub.unbounded<Effect.Success<typeof base.getSettings>>();
      return {
        ...base,
        // A read can be held after it has read, so what it read goes stale meanwhile.
        getSettings: base.getSettings.pipe(Effect.tap(() => afterRead)),
        updateSettings: (patch) =>
          base.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
        subscribeChanges: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
      };
    }),
  ).pipe(Layer.provide(ServerSettings.ServerSettingsService.layerTest()));

const layerFor = (host: Host) =>
  HostedBlender.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          HostedBlenderSetup.HostedBlenderSetup,
          HostedBlenderSetup.HostedBlenderSetup.of({
            state: Stream.never,
            check: Effect.void,
            ensureChecked: Effect.void,
            ensureCheckedForOpen: Effect.void,
            installWithAgent: Effect.die("not used"),
            readiness: Stream.concat(
              Stream.succeed(readinessFor(host)),
              host.readinessChanges ?? Stream.never,
            ),
            progress: Stream.never,
          }),
        ),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.suspend(() => host.beforeThreadLookup?.() ?? Effect.void).pipe(
              Effect.as(
                id === threadId || id === otherThreadId
                  ? ({
                      worktreePath: host.workspaceRoot,
                      projectId: "project",
                      runtimeMode: host.runtimeMode ?? "approval-required",
                      interactionMode: host.interactionMode ?? "default",
                      title: id === threadId ? "Hero pass" : "Other pass",
                      settledOverride:
                        host.threadSettled?.() === false || host.threadArchived?.() === true
                          ? "active"
                          : "settled",
                      archivedAt: host.threadArchived?.() === true ? DateTime.makeUnsafe(0) : null,
                      deletedAt: null,
                    } as never)
                  : null,
              ),
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(HostedBlenderAgents.HostedBlenderAgents)({
          listenerPort: () => Effect.succeed(host.agentPort ?? null),
          masterListenerPort: (id) => Effect.succeed(host.masterPorts?.get(id) ?? null),
          // Every thread's agent session is the one that asked, unless a test ends it.
          currentSession: (id) =>
            Effect.sync(() =>
              host.endedSessions?.has(id) === true ? null : (host.sessions?.get(id) ?? "session-1"),
            ),
          reservePrivatePort: Effect.suspend(() =>
            host.privatePort === undefined
              ? Effect.flatMap(NetService.NetService, (net) => net.reserveLoopbackPort())
              : Effect.succeed(host.privatePort),
          ).pipe(Effect.provide(NetService.layer)),
          agentsAllowed: Effect.succeed(host.agentsAllowed ?? true),
          revocations: host.revocations ?? Stream.never,
          agentAccessEnded: (id, role, grant) =>
            host.accessEnded === undefined
              ? Effect.void
              : Queue.offer(host.accessEnded, { threadId: id, role, grant }).pipe(Effect.asVoid),
        }),
        host.desktop === undefined
          ? Layer.empty
          : Layer.succeed(DesktopBlender.DesktopBlender, host.desktop),
        WorkspacePaths.layer,
        NetService.layer,
        BlendFileWatcher.layer,
        ServerConfig.layerTest(host.workspaceRoot, host.baseDir),
      ),
    ),
    // Kept in the built context, so a test can switch settings as Settings would.
    Layer.provideMerge(changingSettings(host.afterSettingsRead)),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "linux"),
        host.tcpTables === undefined
          ? Layer.empty
          : Layer.succeed(LoopbackPeer.LoopbackTcpTables, host.tcpTables),
        host.heldWords === undefined
          ? Layer.empty
          : Layer.succeed(HostedBlender.HeldWords, host.heldWords),
        host.holdGate === undefined
          ? Layer.empty
          : Layer.succeed(HostedBlender.HoldGate, host.holdGate),
        Layer.succeed(HostProcess.Environment, host.env),
        Layer.succeed(HostProcess.HomeDirectory, host.baseDir),
      ),
    ),
    Layer.provide(
      ((wrap) =>
        wrap === undefined
          ? Layer.empty
          : Layer.effect(
              FileSystem.FileSystem,
              Effect.gen(function* () {
                return wrap(yield* FileSystem.FileSystem);
              }),
            ))(host.fileSystem),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** The layer lives as long as the test's scope, as it does for the server's lifetime. */
const serviceFor = (layer: ReturnType<typeof layerFor>) =>
  Layer.build(layer).pipe(
    Effect.map((context) => Context.get(context, HostedBlender.HostedBlender)),
  );

const tempDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-hosted-blender-${prefix}-`)),
    ),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const firstState = (service: HostedBlender.HostedBlender["Service"]) =>
  service
    .threadState(threadId)
    .pipe(Stream.runHead, Effect.map(Option.getOrThrow), Effect.map(card));

/** A PATH holding stand-ins for Blender, labwc and the helper, which never start Blender. */
const fakeTools = (dir: string, helper = "exit 1") => {
  const bin = NodePath.join(dir, "bin");
  NodeFS.mkdirSync(bin, { recursive: true });
  for (const [name, body] of [
    ["blender", "exit 1"],
    ["labwc", "exit 1"],
    ["helper", helper],
  ]) {
    NodeFS.writeFileSync(NodePath.join(bin, name!), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  return bin;
};
// Stays "starting" until the server asks it to quit, as a helper waiting on Blender does.
const WAITING_HELPER = 'while read line; do case "$line" in *quit*) exit 0;; esac; done';

/**
 * Stands in for the helper and its Blender, answering the control socket as the add-on would
 * (per STANDIN_SCENARIO). Like Blender, a quit without saving leaves quit.blend in its TMPDIR,
 * and SIGUSR1 crashes it leaving an autosave. It answers keyframe requests and resizes, and
 * STANDIN_* files record what it was asked to do.
 */
const STANDIN_HELPER = String.raw`
import json, os, signal, socket, struct, sys, threading, time
own = sys.argv[1:][:sys.argv[1:].index("--")]
rest = sys.argv[1:][sys.argv[1:].index("--") + 1:]
t3 = rest[rest.index("--") + 1:]
scenario = os.environ.get("STANDIN_SCENARIO", "")
tmp = os.path.join(own[own.index("--state-dir") + 1], "tmp")
os.makedirs(tmp, exist_ok=True)
if os.environ.get("STANDIN_LAUNCHES"):
    with open(os.environ["STANDIN_LAUNCHES"], "a") as log:
        log.write(json.dumps(rest) + "\n")
if os.environ.get("STANDIN_PID"):
    open(os.environ["STANDIN_PID"], "w").write(str(os.getpid()))
lock = threading.Lock()
def event(value):
    data = json.dumps(value).encode()
    with lock:
        try:
            sys.stdout.buffer.write(struct.pack(">IB", len(data) + 1, 1) + data)
            sys.stdout.buffer.flush()
        except OSError:
            pass  # T3 is gone: a detached helper outlives it.
state = {"connection": None, "stem": "cube"}
matrix = json.load(open(os.environ["STANDIN_MATRIX"])) if scenario == "matrix" else {}
def lose_connection(*_args):
    # Blender dies: its autosave of the file it has open stays (named as Blender names it), and
    # the add-on's connection really drops (shutdown, as close leaves it open while the reader
    # holds it), though the helper is still running.
    if matrix.get("autosave", True):
        name = "%s_4242_autosave.blend" % state["stem"] if state["stem"] else "4242_autosave.blend"
        open(os.path.join(tmp, name), "w").write("autosave")
    if state["connection"] is not None:
        try:
            state["connection"].shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
def crash(*_args):
    lose_connection()
    event({"type": "exited", "process": "blender", "code": None, "signal": 11})
# Handled on a thread of their own: a handler runs on the main thread, which may be holding
# the stdout lock mid-packet when the signal lands.
signal.signal(signal.SIGUSR2, lambda *_args: threading.Thread(target=lose_connection).start())
signal.signal(signal.SIGUSR1, lambda *_args: threading.Thread(target=crash).start())
state["finishing"] = threading.Event()
state["finishing"].set()
def video(key):
    # A SEMU header (magic, version, flags, pts) and one byte of "access unit".
    data = struct.pack(">IBBHQ", 0x53454D55, 1, 1 if key else 0, 0, 0) + b"\x00"
    with lock:
        sys.stdout.buffer.write(struct.pack(">IB", len(data) + 1, 2) + data)
        sys.stdout.buffer.flush()
server = socket.socket(socket.AF_UNIX)
def listen():
    # "late-control": the add-on's socket appears only once the test creates STANDIN_BIND.
    if scenario == "late-control":
        while not os.path.exists(os.environ["STANDIN_BIND"]):
            time.sleep(0.05)
    if scenario == "never-connects":
        threading.Event().wait()
    if scenario == "late-slow-quit":
        time.sleep(3)
    server.bind(t3[t3.index("--t3-control") + 1])
    server.listen(1)
event({"type": "ready", "capture": "extImageCopyCapture", "target": "window",
       "encoder": "x264enc", "width": 1280, "height": 720, "cursorTracking": True})
if scenario != "never-shows":
    event({"type": "windowCaptured", "title": "3D Viewport"})
# The quit being answered: as the add-on does, every answer about a quit names its request.
asking = [None]
QUIT_ANSWERS = ("quitAccepted", "quitting", "saving", "saved", "quitFailed", "discardRefused",
                "quitExpired")
def send(connection, value):
    if value.get("type") in QUIT_ANSWERS and value.get("quit") is not False and "id" not in value:
        value = dict(value, id=asking[0])
    if value.get("type") == "state":
        state["open"] = value["filepath"]
        state["dirty"] = value["dirty"]
        if "loadedAt" in value:
            state["loadedAt"] = value["loadedAt"]
        # As the add-on: every report names the last load, and once a restore has run, how it
        # went.
        if scenario == "reloads" and "loadedAt" in state:
            value = dict(value, loadedAt=state["loadedAt"])
        if scenario == "reloads" and "--t3-recover" in t3:
            value = dict(value, restore="ok")
        # Granted at launch, its agent listener stays up through a reload of the same file.
        if scenario == "reloads" and "--t3-mcp-listen" in t3:
            value = dict(value, agentListener="ready")
    if value.get("type") == "saved" and "loadedAt" in state:
        value = dict(value, loadedAt=state["loadedAt"])
    connection.sendall((json.dumps(value) + "\n").encode())
# A 1x1 PNG, as the add-on renders the viewport into the control socket's private folder.
PIXEL = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de"
    "0000000c4944415408d763f8cfc0000003010100c9fe92ef0000000049454e44ae426082")
shots = os.path.dirname(t3[t3.index("--t3-control") + 1])
def screenshot(name):
    path = os.path.join(shots, name)
    if scenario == "linked-shot":
        # A real PNG, but outside the private folder: only a plain file there is read.
        outside = os.path.join(os.path.dirname(os.environ["STANDIN_SAVES"]), "outside.png")
        open(outside, "wb").write(PIXEL)
        os.symlink(outside, path)
    elif scenario == "big-shot":
        # A real PNG signature, but too large to send over the shared connection.
        open(path, "wb").write(PIXEL + b"\0" * (8 * 1024 * 1024))
    else:
        open(path + ".part", "wb").write(PIXEL)
        os.replace(path + ".part", path)
def view_reply(command):
    with open(os.environ["STANDIN_SAVES"] + ".views", "a") as log:
        log.write("view\n")
    if scenario == "no-render":
        return None
    screenshot(command["screenshot"])
    return {"width": 1, "height": 1}
def control():
    listen()
    connection, _ = server.accept()
    state["connection"] = connection
    send(connection, {"type": "hello", "pid": os.getpid()})
    # Blender reports the file it has open by its full path, as it was given.
    opened = next(arg for arg in rest if arg.endswith(".blend"))
    first = {"type": "state", "filepath": opened,
             "dirty": scenario not in ("switches", "matrix", "quit-dirty", "quit-other")}
    if "--t3-recover" in t3 and scenario != "restore-silent":
        first["restore"] = "failed" if scenario == "restore-fails" else matrix.get("restore", "ok")
        if scenario == "restored-elsewhere":
            # The copy brings back the path it was saved from, which isn't where it reopened.
            first["filepath"] = "/elsewhere/cube.blend"
    send(connection, first)
    if scenario == "saves-in-blender":
        # The restored copy's work, saved with Ctrl+S in the pane: Blender stays open, clean.
        # In save_post Blender still reads unsaved; a later notifier clears it.
        send(connection, {"type": "saved", "filepath": opened, "dirty": True, "quit": False})
        send(connection, dict(first, dirty=False))
    if scenario == "opens-other" and "--t3-recover" not in t3:
        # The person opens another file of the workspace from Blender's own File menu.
        send(connection, dict(first, filepath=os.path.join(os.path.dirname(opened), "other.blend")))
    if scenario == "matrix":
        # Ends on the file asked for, clean or dirty; a dirty state first tells the test T3 has
        # read everything before it.
        end = {"same": opened, "other": os.path.join(os.path.dirname(opened), "other.blend"),
               "outside": "/elsewhere/outside.blend", "untitled": ""}[matrix["end"]]
        state["stem"] = os.path.basename(end)[:-len(".blend")] if end else ""
        last = {"type": "state", "filepath": end, "dirty": True}
        send(connection, last)
        if not matrix["dirty"] and not matrix.get("revert"):
            send(connection, dict(last, dirty=False))
        if matrix.get("revert"):
            # Edited and autosaved, then reverted to the file as saved, which Blender reports
            # as a load after that autosave.
            open(os.path.join(tmp, "%s_4242_autosave.blend" % state["stem"]), "w").write("autosave")
            time.sleep(0.01)
            send(connection, dict(last, dirty=False, loadedAt=time.time() * 1000))
    if scenario == "opens-outside":
        # The person opens a file from outside the workspace and edits it.
        send(connection, dict(first, filepath="/elsewhere/outside.blend"))
    if scenario == "switches":
        # Opens another file and edits it: once T3 sees it dirty, it has seen the switch.
        other = os.path.join(os.path.dirname(opened), "other.blend")
        send(connection, dict(first, filepath=other, dirty=True))
    saves = 0
    discards = [0]
    if scenario in ("deaf-discard", "answers-second"):
        # What Blender last autosaved, which a crash keeps.
        open(os.path.join(tmp, "cube_4242_autosave.blend"), "w").write("autosave")
    view = {"position": [7, -7, 5], "target": [0, 0, 1]}
    outstanding = [0]
    late = []
    def slow_hits(command):
        # Answers later, saying how many hit requests were waiting when this one arrived.
        result = [{"object": "in flight %d" % outstanding[0], "point": [0, 0, 0]}]
        time.sleep(0.3)
        outstanding[0] -= 1
        connection.sendall((json.dumps({"type": "reply", "id": command["id"], "result": result}) + "\n").encode())
    # "reloads": as the add-on tells Blender's own file from a change on disk, by its revision.
    def revision():
        info = os.stat(opened)
        return (info.st_ino, info.st_size, info.st_mtime_ns)
    disk = [revision()]
    def staged_for():
        # "staged-for": Blender opened that file since T3 last heard, and staged its work.
        named = os.path.join(os.path.dirname(os.environ["STANDIN_SAVES"]), "staged-for")
        return open(named).read() if os.path.exists(named) else opened
    def reload_now():
        # Unsaved changes go to an autosave in TMPDIR first, then Blender reads the file.
        reloads = os.environ["STANDIN_SAVES"] + ".reloads"
        count = (len(open(reloads).read().splitlines()) if os.path.exists(reloads) else 0) + 1
        open(reloads, "a").write("reload\n")
        kept = state.get("dirty", True)
        disk[0] = revision()
        if kept:
            open(os.path.join(tmp, "t3-reload-%d.blend" % count), "w").write("unsaved %d" % count)
            open(os.path.join(tmp, "t3-reload-%d.json" % count), "w").write(json.dumps({"filepath": opened}))
            send(connection, {"type": "reloading", "copy": "t3-reload-%d.blend" % count,
                              "filepath": staged_for()})
        send(connection, {"type": "state", "filepath": opened, "dirty": False,
                          "loadedAt": time.time() * 1000})
        send(connection, {"type": "reloaded", "kept": kept})
    if scenario == "reloads":
        def agent_call():
            # The agent's next call, made while no pane shows Blender, reloads first.
            while not os.path.exists(os.environ["STANDIN_BIND"]):
                time.sleep(0.05)
            if revision() != disk[0]:
                reload_now()
        threading.Thread(target=agent_call, daemon=True).start()
        folder = os.path.dirname(os.environ["STANDIN_SAVES"])
        def triggered(name):
            path = os.path.join(folder, name)
            if not os.path.exists(path):
                return False
            os.remove(path)
            return True
        def ctrl_s():
            while True:
                time.sleep(0.05)
                if triggered("ctrl-s"):
                    # The person edits, then saves with Ctrl+S in the pane.
                    send(connection, {"type": "state", "filepath": opened, "dirty": True})
                    disk[0] = revision()
                    send(connection, {"type": "saved", "filepath": opened, "dirty": False, "quit": False})
                    send(connection, {"type": "state", "filepath": opened, "dirty": False})
                if triggered("revert-save"):
                    # Reverted to the file, then saved at once, before any state report says so.
                    state["loadedAt"] = time.time() * 1000
                    disk[0] = revision()
                    send(connection, {"type": "saved", "filepath": opened, "dirty": False, "quit": False})
                    send(connection, {"type": "state", "filepath": opened, "dirty": False,
                                      "loadedAt": state["loadedAt"]})
                named = os.path.join(folder, "save-as")
                if os.path.exists(named):
                    # Save As under another name, which Blender has open from then on.
                    target = open(named).read()
                    os.remove(named)
                    send(connection, {"type": "saved", "filepath": target, "dirty": False, "quit": False})
                    send(connection, {"type": "state", "filepath": target, "dirty": False})
                if triggered("edit"):
                    send(connection, {"type": "state", "filepath": opened, "dirty": True})
                if triggered("stage-quietly"):
                    # Staged before a reload T3 never kept, beside an autosave from before it;
                    # Blender then quits without a quit copy.
                    autosave = os.path.join(tmp, "cube_4242_autosave.blend")
                    open(autosave, "w").write("older autosave")
                    os.utime(autosave, (time.time() - 5, time.time() - 5))
                    open(os.path.join(tmp, "t3-reload-5.blend"), "w").write("staged work")
                    open(os.path.join(tmp, "t3-reload-5.json"), "w").write(json.dumps({"filepath": opened}))
                    open(os.path.join(folder, "staged-quietly"), "w").close()
                if triggered("poke"):
                    # The agent called on a file written before T3's word: T3 is asked to look.
                    send(connection, {"type": "checkDisk"})
                    # Long enough for an immediate look to have been taken, well inside a settle.
                    time.sleep(0.05)
                    open(os.path.join(folder, "poked"), "w").close()
        threading.Thread(target=ctrl_s, daemon=True).start()
    lines = connection.makefile()
    for line in lines:
        with open(os.environ["STANDIN_SAVES"] + ".control", "a") as log:
            log.write(line)
        command = json.loads(line)
        if command.get("type") == "quit":
            asking[0] = command.get("id")
        if command.get("type") == "quit" and not command.get("save") and os.environ.get("STANDIN_LINGER"):
            # Read, then still reading a moment before answering: anything T3 sends after its
            # quit lands here.
            open(os.environ["STANDIN_SAVES"] + ".quitRead", "w").close()
            connection.settimeout(0.5)
            try:
                for late in lines:
                    with open(os.environ["STANDIN_SAVES"] + ".control", "a") as log:
                        log.write(late)
            except (socket.timeout, OSError):
                pass
            connection.settimeout(None)
        if command.get("type") == "panesHidden" and scenario == "reloads":
            with open(os.environ["STANDIN_SAVES"] + ".disk", "a") as log:
                log.write(line)
            continue
        if command.get("type") == "diskChanged" and scenario == "reloads":
            with open(os.environ["STANDIN_SAVES"] + ".disk", "a") as log:
                log.write(line)
            held = os.path.join(os.path.dirname(os.environ["STANDIN_SAVES"]), "hold-reload")
            if revision() != disk[0] and command["reload"] and os.path.exists(held):
                # Unsaved image edits hold the reload, as the add-on says.
                send(connection, {"type": "state", "filepath": opened, "dirty": state.get("dirty", True),
                                  "stale": True, "staleBlocked": "images"})
            elif revision() != disk[0] and command["reload"]:
                reload_now()
            elif revision() != disk[0]:
                send(connection, {"type": "state", "filepath": opened,
                                  "dirty": state.get("dirty", True), "stale": True})
            continue
        if command.get("type") == "restore":
            # Puts the copy back, unsaved, as recover_auto_save does: a load, taking its time.
            open(os.environ["STANDIN_SAVES"] + ".restores", "a").write("restore\n")
            time.sleep(0.3)
            loaded = time.time() * 1000
            result = {"outcome": "restored" if os.path.exists(command["path"]) else "failed",
                      "loadedAt": loaded}
            if command.get("replace") and state.get("dirty"):
                # What it replaces is staged to keep, as the add-on does.
                open(os.path.join(tmp, "t3-reload-9.blend"), "w").write("displaced by the restore")
                open(os.path.join(tmp, "t3-reload-9.json"), "w").write(json.dumps({"filepath": opened}))
                result.update(copy="t3-reload-9.blend", filepath=opened)
            connection.sendall((json.dumps({"type": "reply", "id": command["id"], "result": result}) + "\n").encode())
            state["loadedAt"] = loaded
            if os.path.exists(os.path.join(os.path.dirname(os.environ["STANDIN_SAVES"]), "save-after-restore")):
                # The person saves the restored scene at once, before T3 has kept what it replaced.
                send(connection, {"type": "saved", "filepath": opened, "dirty": False, "quit": False})
            send(connection, {"type": "state", "filepath": opened, "dirty": True, "loadedAt": loaded})
            continue
        if command.get("type") == "quit" and not command.get("save") \
                and scenario in ("deaf-discard", "answers-second"):
            # Too busy to answer a discard; "answers-second" answers its second, refusing it.
            discards[0] += 1
            if scenario == "answers-second" and discards[0] == 2:
                send(connection, {"type": "discardRefused"})
            continue
        held = os.path.join(os.path.dirname(os.environ["STANDIN_SAVES"]), "images-saved")
        if command.get("type") == "quit" and command.get("hold") and scenario == "unsaved-images" \
                and not os.path.exists(held):
            # Unsaved image edits, which no copy keeps, hold a quit that asks, as the add-on does;
            # a save first saves what it can, and names what it couldn't.
            if command.get("save"):
                send(connection, {"type": "saving", "filepath": opened})
                send(connection, {"type": "quitFailed", "reason": "images", "images": ["paint"]})
            else:
                gate = os.path.join(os.path.dirname(os.environ["STANDIN_SAVES"]), "held-gate")
                if os.path.exists(gate):
                    # Busy for a moment: it answers once the test opens the gate.
                    os.remove(gate)
                    open(gate + ".asked", "w").close()
                    while not os.path.exists(gate + ".open"):
                        time.sleep(0.05)
                send(connection, {"type": "quitFailed", "reason": "images"})
            open(os.environ["STANDIN_SAVES"] + ".held", "a").write("held\n")
            continue
        if command.get("type") == "quit" and command.get("save") and scenario == "reloads" and revision() != disk[0]:
            send(connection, {"type": "quitFailed", "reason": "changedOnDisk"})
            continue
        if command.get("type") == "quit" and command.get("save") and scenario == "reloads":
            send(connection, {"type": "saving"})
            send(connection, {"type": "saved", "filepath": opened, "dirty": False})
            event({"type": "exited", "process": "blender", "code": 0, "signal": None})
            connection.close()
            return
        if command.get("type") == "quit" and command.get("save") and scenario == "opens-during-discard":
            # A window announced while the save is queued, then the save fails.
            send(connection, {"type": "saving", "filepath": opened})
            send(connection, {"type": "state", "filepath": opened, "dirty": True, "viewport": 3})
            send(connection, {"type": "quitFailed", "reason": "saveFailed"})
            continue
        if command.get("type") == "quit" and not command.get("save") and scenario == "opens-during-discard":
            # File > Open finishes while the discard waits, announcing a viewport window T3 must
            # expect; the discard, naming the file that was open, is then refused.
            send(connection, {"type": "state", "filepath": opened, "dirty": True, "viewport": 2})
            send(connection, {"type": "discardRefused"})
            continue
        if command.get("type") == "quit" and not command.get("save") and scenario == "answers-late":
            # Busy with a render through the first quit; free by the next, it reads the first
            # past its deadline, refuses it, then takes the next.
            late.append(command.get("id"))
            if len(late) == 1:
                continue
            send(connection, {"type": "quitExpired", "id": late[0]})
            send(connection, {"type": "quitAccepted"})
        if command.get("type") == "quit" and not command.get("save"):
            if scenario == "ignores-quit":
                continue
            # As the add-on does: the file and its unsaved bit as they are as it begins to quit.
            # "quit-dirty" was edited, and "quit-other" opened another file, since it last said.
            other = os.path.join(os.path.dirname(opened), "other.blend")
            quitting = {"type": "quitting", "filepath": state.get("open", opened),
                        "dirty": state.get("dirty", True)}
            if scenario == "quit-dirty":
                quitting["dirty"] = True
            if scenario == "quit-other":
                quitting.update(filepath=other, dirty=True)
            send(connection, quitting)
            # Its quit pushes an undo step, so its next report is unsaved.
            send(connection, {"type": "state", "filepath": state.get("open", opened), "dirty": True})
            state["finishing"].clear()
            if scenario in ("slow-quit", "late-slow-quit"):
                # Still writing its quit copy past T3's shutdown deadline.
                time.sleep(5)
            quiet = os.path.join(os.path.dirname(os.environ["STANDIN_SAVES"]), "staged-quietly")
            if scenario != "no-quit-copy" and not os.path.exists(quiet):
                open(os.path.join(tmp, "quit.blend"), "w").write("quit copy %d" % os.getpid())
                open(os.environ["STANDIN_SAVES"] + ".quitInode", "w").write(str(os.stat(os.path.join(tmp, "quit.blend")).st_ino))
            event({"type": "exited", "process": "blender", "code": 0, "signal": None})
            connection.close()
            state["finishing"].set()
            return
        kind = command.get("type")
        if kind == "hits" and scenario == "slow-hits":
            outstanding[0] += 1
            threading.Thread(target=slow_hits, args=(command,), daemon=True).start()
            continue
        if kind in ("view", "hits", "setView") and scenario == "drop-on-view":
            connection.close()
            return
        if kind == "view" and scenario == "no-viewport":
            result = None
        elif kind == "view" and scenario == "slow-view":
            # Renders slowly, on its own thread, then answers as the add-on would.
            def slow_view(command):
                time.sleep(0.3)
                shot = view_reply(command)
                reply = {"screenshot": shot, "scene": "launch:7", "cameraView": {**view, "upAxis": "z"},
                         "projection": {"matrix": [1] * 16,
                                        "region": {"x": 0, "y": 0, "width": 1, "height": 1}}}
                connection.sendall((json.dumps({"type": "reply", "id": command["id"], "result": reply}) + "\n").encode())
            threading.Thread(target=slow_view, args=(command,), daemon=True).start()
            continue
        elif kind == "view":
            result = {"screenshot": view_reply(command),
                      # The file it has open, by its path as given, and the scene it drew.
                      "filepath": opened, "scene": "launch:7",
                      "cameraView": {**view, "upAxis": "z"},
                      "projection": {"matrix": [2] + [0] * 15,
                                     "region": {"x": 0.1, "y": 0.05, "width": 0.8, "height": 0.9}}}
        elif kind == "hits":
            # Echoes what it was sent: the matrix's first entry and each mark's first sample.
            result = [{"object": "m%g" % command["matrix"][0],
                       "point": [mark[0]["x"], mark[0]["y"], len(command["marks"])]}
                      if mark else None for mark in command["marks"]]
        elif kind == "setView":
            # The file it has open: its launch file, or another one opened since.
            opened = ("/elsewhere/other.blend" if scenario == "opened-other"
                      else os.path.realpath(next(a for a in sys.argv if a.endswith(".blend"))))
            if command.get("filepath") != opened:
                result = "otherFile"
            else:
                view = {"position": command["position"], "target": command["target"]}
                result = True
        else:
            result = None
        if kind in ("view", "hits", "setView"):
            connection.sendall((json.dumps({"type": "reply", "id": command["id"], "result": result}) + "\n").encode())
            continue
        if kind != "quit" or not command.get("save"):
            continue
        saves += 1
        with open(os.environ["STANDIN_SAVES"], "a") as log:
            log.write("save\n")
        if scenario == "busy-save":
            # Blender's main thread never frees up: the save is never begun, and nothing after
            # it is read.
            threading.Event().wait()
        send(connection, {"type": "saving", "filepath": opened})
        if scenario == "stuck-saving":
            # Begun, and stuck in the write: nothing after it is read.
            threading.Event().wait()
        failed = {"type": "quitFailed", "reason": "saveFailed", "id": command.get("id")}
        if scenario == "held-save":
            # Acknowledged, then fails once the test creates STANDIN_BIND.
            def fail_when_released():
                while not os.path.exists(os.environ["STANDIN_BIND"]):
                    time.sleep(0.05)
                send(connection, failed)
            threading.Thread(target=fail_when_released, daemon=True).start()
            continue
        if scenario == "late-failing-save":
            # Acknowledged, then fails only after T3's 20-second settle deadline.
            threading.Timer(21.0, lambda: send(connection, failed)).start()
            continue
        if scenario == "exit-while-saving":
            os._exit(0)
        if scenario == "drop-socket":
            connection.close()
            server.close()
            return
        if scenario == "saved-then-dirty":
            # Saved, then ending the agent's grant recorded its pending work: unsaved again,
            # and Blender quits into its quit copy.
            send(connection, {"type": "saved", "filepath": opened, "dirty": True})
            open(os.path.join(tmp, "quit.blend"), "w").write("quit copy %d" % os.getpid())
            event({"type": "exited", "process": "blender", "code": 0, "signal": None})
            connection.close()
            return
        if scenario == "save-other":
            # Opened other.blend since it last said, and that is the file it saved.
            send(connection, {"type": "saved", "dirty": False,
                              "filepath": os.path.join(os.path.dirname(opened), "other.blend")})
            open(os.path.join(tmp, "quit.blend"), "w").write("quit copy %d" % os.getpid())
            event({"type": "exited", "process": "blender", "code": 0, "signal": None})
            connection.close()
            return
        if scenario == "saved-then-exit":
            # Saved, then a moment before Blender is gone; "clean" marks the moment.
            send(connection, {"type": "saved", "filepath": opened, "dirty": False})
            send(connection, {"type": "state", "filepath": opened, "dirty": False})
            connection.close()
            threading.Timer(1.0, lambda: os._exit(0)).start()
            return
        if scenario == "slow-failing-save" and saves == 1:
            threading.Timer(1.0, lambda: send(connection, failed)).start()
threading.Thread(target=control, daemon=True).start()
def stopped(how):
    marker = os.environ.get("STANDIN_MARKER")
    if marker:
        # Whole once it appears: a test waits for the file, then reads it.
        with open(marker + ".partial", "w") as out:
            out.write(how)
        os.replace(marker + ".partial", marker)
    os._exit(0)
# As the helper does once detached: T3's quit and its going away are ignored, and it exits once
# Blender has finished its quit copy.
detached = threading.Event()
def finish_detached():
    state["finishing"].wait()
    stopped("finished")
for line in sys.stdin:
    command = json.loads(line)
    if command.get("type") == "detach":
        detached.set()
        threading.Thread(target=finish_detached, daemon=True).start()
        continue
    if command.get("type") != "quit":
        with open(os.environ["STANDIN_COMMANDS"], "a") as log:
            log.write(line)
    if command.get("type") not in ("quit", "keyframe", "pause", "resume", "bitrate"):
        with open(os.environ["STANDIN_INPUT"], "a") as log:
            log.write(line)
    if command.get("type") == "keyframe":
        video(True)
    if command.get("type") == "resize":
        event({"type": "frameSize", "width": command["width"], "height": command["height"]})
    # F1: a burst of deltas, then Blender "captures" the cursor to mark the end of it.
    if command.get("type") == "key" and command.get("code") == 59:
        if command["pressed"]:
            # More than a viewer's frames in flight and waiting together.
            for _ in range(24):
                video(False)
        event({"type": "cursorLeave"} if command["pressed"] else {"type": "cursorEnter", "x": 1, "y": 2})
    # A middle-drag orbit: Blender hides its cursor while the button is down.
    if command.get("type") == "pointerButton" and command.get("button") == 274:
        event({"type": "cursorLeave"} if command["pressed"] else {"type": "cursorEnter", "x": 1, "y": 2})
    if '"quit"' in line and scenario == "never-connects":
        continue  # A helper stuck stopping Blender.
    if '"quit"' in line and detached.is_set():
        continue
    if '"quit"' in line:
        stopped("quit" if state["finishing"].is_set() else "killed")
if detached.is_set():
    finish_detached()
stopped("quit" if state["finishing"].is_set() else "killed")
`;
const python = NodeChildProcess.execFileSync("sh", ["-c", "command -v python3"], {
  encoding: "utf8",
}).trim();

/** A workspace with cube.blend, served by the stand-in helper in `scenario`. */
const standIn = Effect.fn(function* (
  prefix: string,
  scenario: string,
  beforeThreadLookup?: () => Effect.Effect<void>,
  host: Pick<
    Host,
    "readinessChanges" | "agentPort" | "heldWords" | "threadSettled" | "holdGate"
  > = {},
  extraEnv: Readonly<Record<string, string>> = {},
) {
  const dir = yield* tempDir(prefix);
  const bin = fakeTools(dir);
  NodeFS.writeFileSync(NodePath.join(bin, "helper"), `#!${python}\n${STANDIN_HELPER}`, {
    mode: 0o755,
  });
  const runtime = NodePath.join(dir, "run");
  NodeFS.mkdirSync(runtime);
  NodeFS.writeFileSync(NodePath.join(dir, "cube.blend"), "");
  const marker = NodePath.join(dir, "helper-quit");
  const savesLog = NodePath.join(dir, "saves.log");
  const inputLog = NodePath.join(dir, "input.log");
  const commandLog = NodePath.join(dir, "commands.log");
  const launchesLog = NodePath.join(dir, "launches.log");
  const pidFile = NodePath.join(dir, "helper.pid");
  const layer = layerFor({
    env: {
      PATH: bin,
      XDG_RUNTIME_DIR: runtime,
      STANDIN_SCENARIO: scenario,
      STANDIN_MARKER: marker,
      STANDIN_SAVES: savesLog,
      STANDIN_INPUT: inputLog,
      STANDIN_COMMANDS: commandLog,
      STANDIN_LAUNCHES: launchesLog,
      STANDIN_PID: pidFile,
      STANDIN_BIND: NodePath.join(dir, "bind"),
      STANDIN_MATRIX: NodePath.join(dir, "matrix.json"),
      ...extraEnv,
    },
    helper: NodePath.join(bin, "helper"),
    workspaceRoot: dir,
    baseDir: dir,
    ...(beforeThreadLookup === undefined ? {} : { beforeThreadLookup }),
    ...host,
  });
  const service = yield* serviceFor(layer);
  const states = yield* Queue.unbounded<HostedBlenderThreadState>();
  yield* service.threadState(threadId).pipe(
    Stream.runForEach((state) => Queue.offer(states, state)),
    Effect.forkScoped,
  );
  const awaitStatus = (status: HostedBlenderThreadState["status"]) =>
    Queue.take(states).pipe(
      Effect.repeat({ until: (state) => state.status === status }),
      Effect.map(card),
    );
  const awaitDirty = (dirty: boolean) =>
    Queue.take(states).pipe(
      Effect.repeat({ until: (state) => state.status === "running" && state.dirty === dirty }),
    );
  /** Opened, running, and with the control connection up, so a save really reaches it. */
  const openReady = service
    .open({ threadId, relativePath: "cube.blend" })
    .pipe(Effect.andThen(awaitDirty(true)));
  /** How many screenshots the add-on was asked to render. */
  const viewRequests = () =>
    NodeFS.existsSync(`${savesLog}.views`)
      ? NodeFS.readFileSync(`${savesLog}.views`, "utf8").split("\n").length - 1
      : 0;
  const saveCommands = () =>
    NodeFS.existsSync(savesLog) ? NodeFS.readFileSync(savesLog, "utf8").split("\n").length - 1 : 0;
  /** The input commands the helper got, in order. */
  const readLog = (
    log: string,
  ): Array<{ readonly type: string; readonly [key: string]: unknown }> =>
    NodeFS.existsSync(log)
      ? NodeFS.readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line))
      : [];
  /** Every launch's Blender arguments, oldest first. */
  const launches = (): ReadonlyArray<ReadonlyArray<string>> =>
    NodeFS.existsSync(launchesLog)
      ? NodeFS.readFileSync(launchesLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const hostedDir = NodePath.join(dir, "userdata", "hosted-blender");
  const helperInput = (): unknown[] => readLog(inputLog);
  /** Every command the helper got but quit, in order. */
  const helperCommands = () => readLog(commandLog);
  return {
    dir,
    layer,
    service,
    awaitStatus,
    awaitDirty,
    openReady,
    saveCommands,
    viewRequests,
    helperInput,
    helperCommands,
    marker,
    runtime,
    launches,
    hostedDir,
    /** Lets a "late-control" stand-in's add-on socket appear. */
    bind: () => NodeFS.writeFileSync(NodePath.join(dir, "bind"), ""),
    /** Crashes the stand-in Blender, by the pid it wrote itself at spawn. */
    crash: () => process.kill(Number(NodeFS.readFileSync(pidFile, "utf8")), "SIGUSR1"),
    /** Drops the stand-in Blender's connection, leaving it to report its exit on `crash`. */
    loseConnection: () => process.kill(Number(NodeFS.readFileSync(pidFile, "utf8")), "SIGUSR2"),
  };
});

const CUBE = "workspace:cube.blend";
const OTHER = "workspace:other.blend";

/** The kept copy of one file (cube.blend by default) of the thread, and what it holds. */
const recoveryOf = (hostedDir: string, key = CUBE, thread: string = threadId) => {
  const root = NodePath.join(hostedDir, "recovery", Buffer.from(thread).toString("base64url"));
  for (const folder of NodeFS.existsSync(root) ? NodeFS.readdirSync(root) : []) {
    const recordPath = NodePath.join(root, folder, "record.json");
    if (!NodeFS.existsSync(recordPath)) continue;
    const record = JSON.parse(NodeFS.readFileSync(recordPath, "utf8"));
    const file = record.file;
    const recordKey =
      file.kind === "workspace"
        ? `workspace:${file.relativePath}`
        : file.kind === "outside"
          ? `outside:${file.path}`
          : "untitled";
    if (recordKey !== key) continue;
    const session = NodePath.join(root, folder, "session.blend");
    return {
      record,
      session,
      contents: NodeFS.existsSync(session) ? NodeFS.readFileSync(session, "utf8") : null,
    };
  }
  return null;
};

/** A thread state, with a closed or crashed one shown as its newest copy, as the card is. */
const card = (state: HostedBlenderThreadState) => {
  if (!("copies" in state)) return state;
  const [newest, ...rest] = state.copies;
  return {
    status: state.status,
    ...(newest.file.kind === "workspace"
      ? { relativePath: newest.file.relativePath }
      : newest.file.kind === "outside"
        ? { outside: newest.file.path }
        : { untitled: true }),
    recovery: newest.recovery,
    ...(newest.restoreFailed ? { restoreFailed: true } : {}),
    ...(rest.length > 0 ? { alsoKept: rest.map((copy) => copy.key) } : {}),
  };
};

describe("Save and quit", () => {
  it.live("fails when Blender exits before confirming the save", () =>
    Effect.gen(function* () {
      const { service, openReady, saveCommands } = yield* standIn(
        "exit-saving",
        "exit-while-saving",
      );
      yield* openReady;
      const failed = yield* service.quit({ threadId, save: true }).pipe(Effect.flip);
      expect(failed.reason).toBe("saveFailed");
      expect(saveCommands()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.live("fails, and leaves Blender running, when the control socket closes mid-save", () =>
    Effect.gen(function* () {
      const { service, openReady, saveCommands } = yield* standIn("drop-socket", "drop-socket");
      yield* openReady;
      const failed = yield* service.quit({ threadId, save: true }).pipe(Effect.flip);
      expect(failed.reason).toBe("saveFailed");
      expect(saveCommands()).toBe(1);
      expect((yield* firstState(service)).status).toBe("running");
    }).pipe(Effect.scoped),
  );

  it.live("answers every caller of a save already in flight", () =>
    Effect.gen(function* () {
      const { service, openReady, saveCommands } = yield* standIn(
        "shared-save",
        "slow-failing-save",
      );
      yield* openReady;
      const results = yield* Effect.all(
        [
          service.quit({ threadId, save: true }).pipe(Effect.flip),
          service.quit({ threadId, save: true }).pipe(Effect.flip),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.map((error) => error.reason)).toEqual(["saveFailed", "saveFailed"]);
      expect(saveCommands()).toBe(1);
      expect((yield* firstState(service)).status).toBe("running");
    }).pipe(Effect.scoped),
  );

  it.live("joins a confirmed save still waiting for Blender to exit", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitDirty, awaitStatus, saveCommands } = yield* standIn(
        "saved-window",
        "saved-then-exit",
      );
      yield* openReady;
      const first = yield* Effect.forkChild(service.quit({ threadId, save: true }));
      // Saved, socket closing, Blender not yet gone: a second Save and quit lands here.
      yield* awaitDirty(false);
      yield* service.quit({ threadId, save: true });
      yield* Fiber.join(first);
      yield* awaitStatus("stopped");
      expect(saveCommands()).toBe(1);
    }).pipe(Effect.scoped),
  );
});

/** A launch folder a stopped server left behind, and the copy already waiting for the thread. */
/** A copy of cube.blend left waiting by an earlier run, in today's layout. */
const waitingCopy = (hostedDir: string, contents: string, relativePath = "cube.blend") => {
  const key = `workspace:${relativePath}`;
  const folder = NodePath.join(
    hostedDir,
    "recovery",
    Buffer.from(threadId).toString("base64url"),
    NodeCrypto.createHash("sha256").update(key).digest("hex"),
  );
  NodeFS.mkdirSync(folder, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(folder, "session.blend"), contents);
  NodeFS.writeFileSync(
    NodePath.join(folder, "record.json"),
    JSON.stringify({
      threadId,
      file: { kind: "workspace", relativePath },
      kind: "closed",
      recovery: true,
      keptAt: 1,
    }),
  );
};

const leftover = (
  dir: string,
  input: {
    readonly facts?: {
      readonly restore: string;
      readonly saved: boolean;
      readonly changed: boolean;
      /** The copy the run's last save retires, by when it was kept. */
      readonly retires?: number | null;
      readonly relativePath?: string;
      /** A master's file, by its real path, as a master's run names it. */
      readonly path?: string;
    };
    readonly waiting?: string;
    readonly helperPid?: number;
    readonly name?: string;
    /** Whose launch it was: a thread's, or every master's one owner. */
    readonly owner?: string;
  },
) => {
  const hostedDir = NodePath.join(dir, "userdata", "hosted-blender");
  const launchDir = NodePath.join(hostedDir, "launches", input.name ?? "left");
  NodeFS.mkdirSync(NodePath.join(launchDir, "tmp"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(launchDir, "launch.json"),
    JSON.stringify({
      threadId: input.owner ?? threadId,
      relativePath: "cube.blend",
      helperPid: input.helperPid,
    }),
  );
  NodeFS.writeFileSync(NodePath.join(launchDir, "outcome"), "closing");
  if (input.facts) {
    const { restore, saved, changed, relativePath = "cube.blend", path } = input.facts;
    NodeFS.writeFileSync(
      NodePath.join(launchDir, "run.json"),
      JSON.stringify({
        restore,
        endFile:
          path === undefined
            ? {
                file: { kind: "workspace", relativePath },
                path: NodePath.join(dir, relativePath),
                since: 0,
              }
            : { file: { kind: "outside", path }, path, since: 0 },
        saved,
        ...(input.facts.retires === undefined ? {} : { retires: input.facts.retires }),
        clean: !changed,
      }),
    );
  }
  // Written as Blender quit, after any save of the file.
  const quitCopy = NodePath.join(launchDir, "tmp", "quit.blend");
  NodeFS.writeFileSync(quitCopy, "left behind");
  const later = NodeFS.statSync(quitCopy).mtimeMs / 1000 + 60;
  NodeFS.utimesSync(quitCopy, later, later);
  if (input.waiting !== undefined) waitingCopy(hostedDir, input.waiting);
  return { hostedDir, launchDir };
};

/** Once `file` exists in `dir`, checked as the watch starts, so one already there counts. */
const fileAppears = (dir: string, file: string, ready = () => NodeFS.existsSync(file)) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (!ready()) return;
          watcher.close();
          resolve();
        };
        const watcher = NodeFS.watch(dir, check);
        check();
      }),
  );

/** A service on `dir` whose Blenders never start: only startup and records are under test. */
const idleService = (dir: string) => {
  const bin = fakeTools(dir);
  NodeFS.writeFileSync(NodePath.join(dir, "cube.blend"), "");
  NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
  return serviceFor(
    layerFor({
      env: { PATH: bin },
      helper: NodePath.join(bin, "helper"),
      workspaceRoot: dir,
      baseDir: dir,
    }),
  );
};

interface Cell {
  readonly waiting: boolean;
  readonly restore: "none" | "ok" | "failed";
  readonly dirty: boolean;
  readonly end: "same" | "other" | "outside" | "untitled";
  readonly ending: "settle" | "crash";
  readonly autosave?: boolean;
  readonly revert?: boolean;
}

const END_KEYS = {
  same: CUBE,
  other: OTHER,
  outside: "outside:/elsewhere/outside.blend",
  untitled: "untitled",
} as const;

/**
 * One run of a thread with or without a copy of cube.blend waiting: restored or not (or failing
 * to), changed or not, ending on cube.blend or another file, by a settle or a crash. Returns
 * the thread's copies after, by key, and its state.
 */
const runCell = Effect.fn(function* (cell: Cell) {
  const name = `m-${cell.waiting ? "w" : "n"}-${cell.restore}-${cell.dirty ? "d" : "c"}-${cell.end}-${cell.ending}`;
  const { dir, layer, hostedDir, crash } = yield* standIn(name, "matrix");
  NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
  NodeFS.writeFileSync(
    NodePath.join(dir, "matrix.json"),
    JSON.stringify({
      restore: cell.restore,
      dirty: cell.dirty,
      end: cell.end,
      autosave: cell.autosave ?? true,
      revert: cell.revert ?? false,
    }),
  );
  if (cell.waiting) waitingCopy(hostedDir, "waiting copy");
  const before = recoveryOf(hostedDir);
  const service = yield* serviceFor(layer);
  const states = yield* Queue.unbounded<HostedBlenderThreadState>();
  yield* service.threadState(threadId).pipe(
    Stream.runForEach((state) => Queue.offer(states, state)),
    Effect.forkScoped,
  );
  const until = (matches: (state: HostedBlenderThreadState) => boolean) =>
    Queue.take(states).pipe(Effect.repeat({ until: matches }));
  if (cell.restore !== "none") {
    yield* service.reopen({ threadId, key: CUBE, restore: true });
  } else if (cell.waiting) {
    // Open as last saved: the waiting copy isn't restored.
    yield* service.reopen({ threadId, key: CUBE, restore: false });
  } else {
    yield* service.open({ threadId, relativePath: "cube.blend" });
  }
  if (cell.restore === "failed") {
    // A copy waiting shows its card first; this run's end is the card after it starts.
    yield* until((state) => state.status === "starting");
    yield* until((state) => state.status === "closed" || state.status === "crashed");
  } else {
    // T3 has read every state the add-on sent once it has seen one dirty, then its last.
    let sawDirty = false;
    yield* until((state) => {
      if ("dirty" in state && state.dirty) sawDirty = true;
      return sawDirty && state.status === "running" && state.dirty === cell.dirty;
    });
    if (cell.ending === "settle") {
      yield* service.closeOnSettle({ threadId });
    } else {
      crash();
    }
    // Gone: a card, or none when nothing was kept.
    yield* until((state) => state.status !== "running" && state.status !== "starting");
  }
  const copies = yield* service.keptCopies(threadId);
  const threadDir = NodePath.join(
    hostedDir,
    "recovery",
    Buffer.from(threadId).toString("base64url"),
  );
  const folders = NodeFS.existsSync(threadDir) ? NodeFS.readdirSync(threadDir) : [];
  const misfiled = folders.filter((folder) => {
    const record = JSON.parse(
      NodeFS.readFileSync(NodePath.join(threadDir, folder, "record.json"), "utf8"),
    );
    const key =
      record.file.kind === "workspace"
        ? `workspace:${record.file.relativePath}`
        : record.file.kind === "outside"
          ? `outside:${record.file.path}`
          : "untitled";
    return folder !== NodeCrypto.createHash("sha256").update(key).digest("hex");
  });
  return {
    service,
    before,
    misfiled,
    copies: new Map(copies.map((copy) => [copy.key, copy])),
    cube: recoveryOf(hostedDir),
    end: recoveryOf(hostedDir, END_KEYS[cell.end]),
  };
});

const CELLS: ReadonlyArray<Cell> = [false, true].flatMap((waiting) =>
  (waiting ? (["none", "ok", "failed"] as const) : (["none"] as const)).flatMap((restore) =>
    [false, true].flatMap((dirty) =>
      (["same", "other", "untitled"] as const).flatMap((end) =>
        (["settle", "crash"] as const).map((ending) => ({ waiting, restore, dirty, end, ending })),
      ),
    ),
  ),
);

describe("One recovery copy per file", () => {
  it.live(
    "no run loses a copy, overwrites one with another file's, or names it after another file",
    () =>
      Effect.forEach(
        CELLS,
        (cell) =>
          Effect.gen(function* () {
            const label = JSON.stringify(cell);
            const { before, copies, cube, end, misfiled } = yield* runCell(cell);
            const snapshot = cell.ending === "settle" ? /^quit copy / : /^autosave$/;
            // Every record is in its own file's folder, labelled with that file.
            expect(misfiled, label).toEqual([]);
            if (cell.restore === "failed") {
              // The saved file was open, never the copy's work: everything stays as it was.
              expect(cube, label).toEqual(before);
              expect(copies.get(CUBE)?.restoreFailed, label).toBe(true);
              expect(copies.size, label).toBe(1);
              return;
            }
            if (cell.ending === "settle" && !cell.dirty) {
              // Blender's last word was clean: nothing new is kept, and no copy is touched.
              expect(cube, label).toEqual(before);
              expect(copies.size, label).toBe(cell.waiting ? 1 : 0);
              return;
            }
            if (cell.end === "same") {
              // A newer copy of the same file replaces its older one.
              expect(cube?.contents, label).toMatch(snapshot);
              expect(cube?.record.kind, label).toBe(
                cell.ending === "settle" ? "closed" : "crashed",
              );
              expect(copies.size, label).toBe(1);
              return;
            }
            // Ending on another file never reads, relabels, replaces or deletes cube.blend's.
            expect(cube, label).toEqual(before);
            expect(end?.contents, label).toMatch(snapshot);
            expect(copies.get(END_KEYS[cell.end])?.kind, label).toBe(
              cell.ending === "settle" ? "closed" : "crashed",
            );
            expect(copies.size, label).toBe(cell.waiting ? 2 : 1);
          }),
        { discard: true },
      ).pipe(Effect.scoped),
  );

  it.live("a clean look at a file keeps nothing, and the file opens normally after", () =>
    Effect.gen(function* () {
      const { copies, cube, service } = yield* runCell({
        waiting: false,
        restore: "none",
        dirty: false,
        end: "same",
        ending: "settle",
      });
      expect(cube).toBeNull();
      expect(copies.size).toBe(0);
      expect((yield* firstState(service)).status).toBe("stopped");
      yield* service.open({ threadId, relativePath: "cube.blend" });
    }).pipe(Effect.scoped),
  );

  it.live("M15: a crash after a revert never offers an autosave from before it", () =>
    Effect.gen(function* () {
      const { before, cube } = yield* runCell({
        waiting: true,
        restore: "none",
        dirty: false,
        end: "same",
        ending: "crash",
        autosave: false,
        revert: true,
      });
      expect(cube).toEqual(before);
      expect(cube?.contents).toBe("waiting copy");
    }).pipe(Effect.scoped),
  );

  it.live("M13: an edit after Blender's last report is kept, as its quit says", () =>
    Effect.gen(function* () {
      const { service, awaitStatus, hostedDir } = yield* standIn("quit-dirty", "quit-dirty");
      yield* service.open({ threadId, relativePath: "cube.blend" });
      yield* awaitStatus("running");
      yield* service.closeOnSettle({ threadId });
      expect(yield* awaitStatus("closed")).toEqual({
        status: "closed",
        relativePath: "cube.blend",
        recovery: true,
      });
      expect(recoveryOf(hostedDir)?.contents).toMatch(/^quit copy /);
    }).pipe(Effect.scoped),
  );

  it.live(
    "M13: a file opened after Blender's last report is the one its quit copy is filed under",
    () =>
      Effect.gen(function* () {
        const { dir, service, awaitStatus, hostedDir } = yield* standIn("quit-other", "quit-other");
        NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
        yield* service.open({ threadId, relativePath: "cube.blend" });
        yield* awaitStatus("running");
        yield* service.closeOnSettle({ threadId });
        expect(yield* awaitStatus("closed")).toEqual({
          status: "closed",
          relativePath: "other.blend",
          recovery: true,
        });
        expect(recoveryOf(hostedDir, OTHER)?.contents).toMatch(/^quit copy /);
        expect(recoveryOf(hostedDir)).toBeNull();
      }).pipe(Effect.scoped),
  );

  it.live("M14: saving a file opened since the last report never removes another file's copy", () =>
    Effect.gen(function* () {
      const { dir, layer, hostedDir } = yield* standIn("save-other", "save-other");
      NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
      waitingCopy(hostedDir, "waiting copy");
      const service = yield* serviceFor(layer);
      yield* service.reopen({ threadId, key: CUBE, restore: false });
      // Its add-on is connected once it has reported the file unsaved.
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && state.dirty),
        Stream.runHead,
      );
      yield* service.quit({ threadId, save: true });
      const ended = yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status !== "running" && state.status !== "starting"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(card(ended)).toMatchObject({ status: "closed", relativePath: "cube.blend" });
      expect(recoveryOf(hostedDir)?.contents).toBe("waiting copy");
    }).pipe(Effect.scoped),
  );

  it.live("B3: a save in Blender of a reopened copy's work leaves that copy nothing to offer", () =>
    Effect.gen(function* () {
      const { layer, hostedDir } = yield* standIn("save-in-blender", "saves-in-blender");
      waitingCopy(hostedDir, "waiting copy");
      const service = yield* serviceFor(layer);
      yield* service.reopen({ threadId, key: CUBE, restore: true });
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && !state.dirty),
        Stream.runHead,
      );
      yield* service.closeOnSettle({ threadId });
      const ended = yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status !== "running" && state.status !== "starting"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(card(ended)).toEqual({ status: "stopped" });
      expect(recoveryOf(hostedDir)).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.live(
    "M9: a crash on a file outside the workspace, before any autosave, keeps the waiting copy",
    () =>
      Effect.gen(function* () {
        const { before, copies, cube, end } = yield* runCell({
          waiting: true,
          restore: "none",
          dirty: true,
          end: "outside",
          ending: "crash",
          autosave: false,
        });
        expect(cube).toEqual(before);
        expect(cube?.contents).toBe("waiting copy");
        // The crash is told under the file it happened in, with nothing of it to restore.
        expect(end?.record).toMatchObject({
          file: { kind: "outside", path: "/elsewhere/outside.blend" },
          kind: "crashed",
          recovery: false,
        });
        expect([...copies.keys()]).toEqual([END_KEYS.outside, CUBE]);
      }).pipe(Effect.scoped),
  );
});

describe("Salvaging what a stopped server left", () => {
  it.live("B4: a half-migrated or garbage recovery folder is skipped, and a good copy listed", () =>
    Effect.gen(function* () {
      const { layer, hostedDir } = yield* standIn("bad-folders", "");
      waitingCopy(hostedDir, "waiting copy");
      const recovery = NodePath.join(hostedDir, "recovery");
      // An earlier head's single record whose session.blend had already been moved.
      const half = NodePath.join(recovery, Buffer.from(otherThreadId).toString("base64url"));
      NodeFS.mkdirSync(half, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(half, "record.json"),
        JSON.stringify({
          threadId: otherThreadId,
          kind: "closed",
          relativePath: "cube.blend",
          recovery: true,
        }),
      );
      NodeFS.writeFileSync(NodePath.join(recovery, "garbage"), "not a folder");
      NodeFS.mkdirSync(NodePath.join(recovery, "junk", "copy"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(recovery, "junk", "copy", "record.json"), "{");
      const service = yield* serviceFor(layer);
      expect(yield* firstState(service)).toEqual({
        status: "closed",
        relativePath: "cube.blend",
        recovery: true,
      });
    }).pipe(Effect.scoped),
  );

  it.live("stops a live leftover helper and finishes before taking any request", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage-live");
      const { hostedDir, launchDir } = leftover(dir, {});
      // Stands in for a helper still running there: in the folder, naming it in its arguments.
      const helper = NodeChildProcess.spawn(
        python,
        ["-c", "import time; time.sleep(600)", "--state-dir", launchDir],
        { cwd: launchDir, stdio: "ignore" },
      );
      const exit = new Promise<NodeJS.Signals | null>((resolve) =>
        helper.once("exit", (_code, signal) => resolve(signal)),
      );
      const exited = Effect.promise(() => exit);
      leftover(dir, { helperPid: helper.pid! });
      const service = yield* idleService(dir);
      expect(yield* exited).toBe("SIGTERM");
      // Already salvaged when the service is ready: open sees the copy waiting.
      expect(yield* firstState(service)).toEqual({
        status: "closed",
        relativePath: "cube.blend",
        recovery: true,
      });
      expect(recoveryOf(hostedDir)?.contents).toBe("left behind");
      const refused = yield* service
        .open({ threadId, relativePath: "cube.blend" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("recoveryPending");
      expect(NodeFS.existsSync(launchDir)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("waits for the leftover's whole process group before collecting its files", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage-group");
      const { hostedDir, launchDir } = leftover(dir, {});
      const childPidFile = NodePath.join(dir, "child.pid");
      // A helper leading its own group, whose Blender ignores SIGTERM and outlives it.
      const helper = NodeChildProcess.spawn(
        python,
        [
          "-c",
          [
            "import subprocess, sys, time",
            "subprocess.Popen([sys.executable, '-c', 'import os, signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], \"w\").write(str(os.getpid())); time.sleep(600)', sys.argv[1], '--state-dir', sys.argv[2]])",
            "time.sleep(600)",
          ].join("\n"),
          childPidFile,
          launchDir,
        ],
        { cwd: launchDir, stdio: "ignore", detached: true },
      );
      yield* fileAppears(
        dir,
        childPidFile,
        () => NodeFS.existsSync(childPidFile) && NodeFS.readFileSync(childPidFile, "utf8") !== "",
      );
      const childPid = Number(NodeFS.readFileSync(childPidFile, "utf8"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const pid of [childPid, helper.pid!]) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        }),
      );
      leftover(dir, { helperPid: helper.pid! });
      const service = yield* idleService(dir);
      // Its files are collected only once nothing of that launch is still running.
      expect((yield* firstState(service)).status).toBe("closed");
      const stat = NodeFS.existsSync(`/proc/${childPid}/stat`)
        ? NodeFS.readFileSync(`/proc/${childPid}/stat`, "utf8")
        : "";
      expect(stat === "" || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")).toBe(true);
      expect(recoveryOf(hostedDir)?.contents).toBe("left behind");
    }).pipe(Effect.scoped),
  );

  it.live("P5: starts while a stubborn leftover is still being stopped; an open waits for it", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage-beside");
      const { launchDir } = leftover(dir, {});
      const readyFile = NodePath.join(dir, "ready");
      // Ignores SIGTERM, so only the kill after the grace period stops it.
      const helper = NodeChildProcess.spawn(
        python,
        [
          "-c",
          "import signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], 'w').close(); time.sleep(600)",
          readyFile,
          "--state-dir",
          launchDir,
        ],
        { cwd: launchDir, stdio: "ignore", detached: true },
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => helper.kill("SIGKILL")));
      yield* fileAppears(dir, readyFile);
      leftover(dir, { helperPid: helper.pid! });
      const service = yield* idleService(dir);
      expect(helper.exitCode).toBeNull();
      expect(helper.signalCode).toBeNull();
      // Only after the salvage has kept the leftover's copy does open see it waiting.
      const refused = yield* service
        .open({ threadId, relativePath: "cube.blend" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("recoveryPending");
    }).pipe(Effect.scoped),
  );

  it.live(
    "leaves a Blender released at shutdown to finish its copy, refusing an open of its file in any thread meanwhile",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir("salvage-released");
        const { hostedDir, launchDir } = leftover(dir, {});
        const done = NodePath.join(dir, "done");
        const signalled = NodePath.join(dir, "signalled");
        const readyFile = NodePath.join(dir, "ready");
        // Still writing its quit copy: it notes any signal, and exits once the test says.
        const helper = NodeChildProcess.spawn(
          python,
          [
            "-c",
            "import os, signal, sys, time\nsignal.signal(signal.SIGTERM, lambda *_: open(sys.argv[2], 'w').close())\nopen(sys.argv[3], 'w').close()\nwhile not os.path.exists(sys.argv[1]): time.sleep(0.05)",
            done,
            signalled,
            readyFile,
            "--state-dir",
            launchDir,
          ],
          { cwd: launchDir, stdio: "ignore", detached: true },
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => helper.kill("SIGKILL")));
        yield* fileAppears(dir, readyFile);
        leftover(dir, {
          helperPid: helper.pid!,
          facts: { restore: "none", saved: false, changed: true },
        });
        NodeFS.writeFileSync(NodePath.join(launchDir, "outcome"), "released");
        const service = yield* idleService(dir);
        // Ready while it still runs: nothing waits for it.
        expect((yield* firstState(service).pipe(Effect.timeout("5 seconds"))).status).toBe(
          "stopped",
        );
        // Its file is its own until it exits: an open of it, from any thread, says so at once.
        for (const id of [threadId, otherThreadId]) {
          const refused = yield* service
            .open({ threadId: id, relativePath: "cube.blend" })
            .pipe(Effect.flip, Effect.timeout("5 seconds"));
          expect(refused.reason).toBe("stillSaving");
        }
        // Nor is the copy it writes discarded, which would only come back once it exits.
        const discard = yield* service
          .dismiss({ threadId, key: CUBE })
          .pipe(Effect.flip, Effect.timeout("5 seconds"));
        expect(discard.reason).toBe("stillSaving");
        NodeFS.writeFileSync(done, "");
        // Kept once it exits, and then an open finds the copy waiting.
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "closed"),
          Stream.runHead,
        );
        const opening = yield* service
          .open({ threadId, relativePath: "cube.blend" })
          .pipe(Effect.flip, Effect.forkChild);
        expect((yield* Fiber.join(opening)).reason).toBe("recoveryPending");
        expect(recoveryOf(hostedDir)?.contents).toBe("left behind");
        expect(NodeFS.existsSync(signalled)).toBe(false);
        expect(NodeFS.existsSync(launchDir)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.live("stops a Blender released at shutdown that never finishes, keeping what it left", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage-stuck");
      const { hostedDir, launchDir } = leftover(dir, {});
      const signalled = NodePath.join(dir, "signalled");
      const readyFile = NodePath.join(dir, "ready");
      // Never finishes on its own; the signal that stops it is noted.
      const helper = NodeChildProcess.spawn(
        python,
        [
          "-c",
          "import signal, sys, time\nsignal.signal(signal.SIGTERM, lambda *_: (open(sys.argv[1], 'w').close(), sys.exit(0)))\nopen(sys.argv[2], 'w').close()\nwhile True: time.sleep(0.05)",
          signalled,
          readyFile,
          "--state-dir",
          launchDir,
        ],
        { cwd: launchDir, stdio: "ignore", detached: true },
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => helper.kill("SIGKILL")));
      yield* fileAppears(dir, readyFile);
      leftover(dir, { helperPid: helper.pid! });
      NodeFS.writeFileSync(NodePath.join(launchDir, "outcome"), "released");
      // Its bound shortened from two hours.
      const service = yield* idleService(dir).pipe(
        Effect.provideService(HostedBlender.ReleasedFinishTimeout, "1 second"),
      );
      yield* fileAppears(dir, signalled);
      const kept = yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "closed"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(card(kept)).toEqual({ status: "closed", relativePath: "cube.blend", recovery: true });
      expect(recoveryOf(hostedDir)?.contents).toBe("left behind");
    }).pipe(Effect.scoped),
  );

  it.live("leaves a launch it couldn't stop for the next start, collecting nothing", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage-unkillable");
      const { hostedDir, launchDir } = leftover(dir, {});
      const readyFile = NodePath.join(dir, "ready");
      const helper = NodeChildProcess.spawn(
        python,
        [
          "-c",
          "import signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], 'w').close(); time.sleep(600)",
          readyFile,
          "--state-dir",
          launchDir,
        ],
        { cwd: launchDir, stdio: "ignore", detached: true },
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => helper.kill("SIGKILL")));
      yield* fileAppears(dir, readyFile);
      leftover(dir, { helperPid: helper.pid! });
      // Stands in for a Blender stuck in the kernel: SIGKILL doesn't take, SIGTERM is ignored.
      const service = yield* idleService(dir).pipe(
        Effect.provideService(HostedBlender.LeftoverSignal, (pid, signal) => {
          if (signal !== "SIGKILL") process.kill(pid, signal);
        }),
      );
      // Startup still completes, and takes nothing from a launch that may still be writing.
      expect((yield* firstState(service)).status).toBe("stopped");
      expect(recoveryOf(hostedDir)).toBeNull();
      expect(NodeFS.readFileSync(NodePath.join(launchDir, "tmp", "quit.blend"), "utf8")).toBe(
        "left behind",
      );
    }).pipe(Effect.scoped),
  );

  it.live("stops several stubborn leftovers in one grace period", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage-many");
      const ready = (file: string) =>
        new Promise<void>((resolve) => {
          const watcher = NodeFS.watch(dir, () => {
            if (!NodeFS.existsSync(file)) return;
            watcher.close();
            resolve();
          });
        });
      const helpers = ["one", "two"].map((name) => {
        const { launchDir } = leftover(dir, { name });
        const readyFile = NodePath.join(dir, `${name}.ready`);
        const isReady = ready(readyFile);
        const helper = NodeChildProcess.spawn(
          python,
          [
            "-c",
            "import signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], 'w').close(); time.sleep(600)",
            readyFile,
            "--state-dir",
            launchDir,
          ],
          { cwd: launchDir, stdio: "ignore", detached: true },
        );
        leftover(dir, { name, helperPid: helper.pid! });
        return {
          isReady,
          exited: new Promise<void>((resolve) => helper.once("exit", () => resolve())),
        };
      });
      yield* Effect.promise(() => Promise.all(helpers.map((helper) => helper.isReady)));
      const started = yield* Clock.currentTimeMillis;
      yield* idleService(dir);
      yield* Effect.promise(() => Promise.all(helpers.map((helper) => helper.exited)));
      // Each would take the 7-second grace if they were stopped one after another.
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(10_000);
    }).pipe(Effect.scoped),
  );

  it.effect("never stops a process that merely reuses a leftover helper's pid", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage-pid");
      // A process elsewhere, as one that took over the pid would be.
      const stranger = NodeChildProcess.spawn(python, ["-c", "import time; time.sleep(600)"], {
        cwd: dir,
        stdio: "ignore",
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => stranger.kill("SIGKILL")));
      leftover(dir, { helperPid: stranger.pid! });
      yield* firstState(yield* idleService(dir));
      expect(stranger.exitCode).toBeNull();
      expect(stranger.signalCode).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("keeps nothing of a run that ended with its file clean", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage-unchanged");
      const { hostedDir } = leftover(dir, {
        facts: { restore: "none", saved: false, changed: false },
      });
      expect((yield* firstState(yield* idleService(dir))).status).toBe("stopped");
      expect(recoveryOf(hostedDir)).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps the waiting copy a clean run didn't restore, whether its snapshot is newer or not",
    () =>
      Effect.gen(function* () {
        for (const shift of [0, -120]) {
          const dir = yield* tempDir("salvage-unrestored");
          const { hostedDir, launchDir } = leftover(dir, {
            facts: { restore: "none", saved: false, changed: false },
            waiting: "waiting copy",
          });
          const quitCopy = NodePath.join(launchDir, "tmp", "quit.blend");
          const at = NodeFS.statSync(quitCopy).mtimeMs / 1000 + shift;
          NodeFS.utimesSync(quitCopy, at, at);
          expect((yield* firstState(yield* idleService(dir))).status).toBe("closed");
          expect(recoveryOf(hostedDir)?.contents).toBe("waiting copy");
        }
      }).pipe(Effect.scoped),
  );

  it.live("keeps a run that ended on another file under that file, never touching this one's", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage-switched");
      const { hostedDir } = leftover(dir, {
        facts: { restore: "none", saved: false, changed: true, relativePath: "other.blend" },
        waiting: "waiting copy",
      });
      expect(yield* firstState(yield* idleService(dir))).toEqual({
        status: "closed",
        relativePath: "other.blend",
        recovery: true,
        alsoKept: [CUBE],
      });
      expect(recoveryOf(hostedDir)?.contents).toBe("waiting copy");
      expect(recoveryOf(hostedDir, OTHER)?.contents).toBe("left behind");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the waiting copy after a restore that failed or never finished", () =>
    Effect.gen(function* () {
      for (const restore of ["failed", "pending"]) {
        const dir = yield* tempDir(`salvage-${restore}`);
        const { hostedDir } = leftover(dir, {
          facts: { restore, saved: false, changed: true },
          waiting: "waiting copy",
        });
        expect((yield* firstState(yield* idleService(dir))).status).toBe("closed");
        expect(recoveryOf(hostedDir)?.contents).toBe("waiting copy");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("clears an older copy once the run's last word was a confirmed save", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage-saved");
      const { hostedDir } = leftover(dir, {
        facts: { restore: "none", saved: true, changed: true },
        waiting: "waiting copy",
      });
      expect((yield* firstState(yield* idleService(dir))).status).toBe("stopped");
      expect(recoveryOf(hostedDir)).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect(
    "finishes a run's copy whose record was written before T3 stopped, with or without an older copy there",
    () =>
      Effect.gen(function* () {
        for (const older of [true, false]) {
          const dir = yield* tempDir("salvage-record-first");
          const { hostedDir, launchDir } = leftover(dir, {
            facts: { restore: "none", saved: false, changed: true },
            waiting: "older copy",
          });
          // The record went first, as of the quit copy's capture; T3 stopped before the move.
          const recordPath = recoveryOf(hostedDir)!.session.replace(
            /session\.blend$/,
            "record.json",
          );
          const captured = Math.floor(
            NodeFS.statSync(NodePath.join(launchDir, "tmp", "quit.blend")).mtimeMs,
          );
          NodeFS.writeFileSync(
            recordPath,
            JSON.stringify({
              ...JSON.parse(NodeFS.readFileSync(recordPath, "utf8")),
              keptAt: captured,
            }),
          );
          if (!older) NodeFS.rmSync(recordPath.replace(/record\.json$/, "session.blend"));
          const service = yield* idleService(dir);
          expect((yield* firstState(service)).status).toBe("closed");
          expect(recoveryOf(hostedDir)?.contents).toBe("left behind");
          expect(NodeFS.existsSync(launchDir)).toBe(false);
        }
      }).pipe(Effect.scoped),
  );

  it.effect("replaces the waiting copy with a changed run's", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage-changed");
      const { hostedDir } = leftover(dir, {
        facts: { restore: "none", saved: false, changed: true },
        waiting: "waiting copy",
      });
      expect((yield* firstState(yield* idleService(dir))).status).toBe("closed");
      expect(recoveryOf(hostedDir)?.contents).toBe("left behind");
    }).pipe(Effect.scoped),
  );
});

describe("B19: a finished thread's working copy is held", () => {
  const COPY = workingCopyName("cube.blend", threadId);
  const OTHER_COPY = workingCopyName("other.blend", threadId);
  /** A workspace with cube.blend and the copy of it T3 made for the thread, and no Blender. */
  const heldHost = Effect.fn(function* (
    prefix: string,
    host: Pick<
      Host,
      | "threadSettled"
      | "threadArchived"
      | "holdGate"
      | "fileSystem"
      | "beforeThreadLookup"
      | "readiness"
    > = {},
  ) {
    const dir = NodeFS.realpathSync(yield* tempDir(prefix));
    // A Blender that stays starting until it is quit, never launching anything.
    const bin = fakeTools(dir, WAITING_HELPER);
    NodeFS.writeFileSync(NodePath.join(dir, "cube.blend"), "master");
    NodeFS.writeFileSync(NodePath.join(dir, COPY), "working copy");
    const layer = layerFor({
      env: { PATH: bin },
      helper: NodePath.join(bin, "helper"),
      workspaceRoot: dir,
      baseDir: dir,
      ...host,
    });
    const at = (name: string) => NodePath.join(dir, name);
    const record = (
      service: HostedBlender.HostedBlender["Service"],
      name = COPY,
      master = "cube.blend",
      thread: ThreadId = threadId,
    ) =>
      service.recordWorkingCopy({
        threadId: thread,
        master: at(master),
        path: at(name),
        relativePath: name,
      });
    const heldWhen = (
      service: HostedBlender.HostedBlender["Service"],
      done: (list: HostedBlenderHeldList) => boolean,
    ) =>
      service.heldCopies.pipe(Stream.filter(done), Stream.runHead, Effect.map(Option.getOrThrow));
    // Held in the workspace, on the project's drive; the record stays in T3's state.
    const heldFile = (id: string) =>
      NodePath.join(dir, ".t3", "held-working-copies", id, "copy.blend");
    const recordDir = (id: string) =>
      NodePath.join(dir, "userdata", "hosted-blender", "working-copies", id);
    const stateFile = (id: string) => NodePath.join(recordDir(id), "copy.blend");
    const recordOf = (name = COPY) => {
      const root = NodePath.join(dir, "userdata", "hosted-blender", "working-copies");
      for (const id of NodeFS.existsSync(root) ? NodeFS.readdirSync(root) : []) {
        const written = JSON.parse(
          NodeFS.readFileSync(NodePath.join(root, id, "record.json"), "utf8"),
        );
        if (written.path === at(name))
          return { id, ...written, files: NodeFS.readdirSync(NodePath.join(root, id)) };
      }
      return undefined;
    };
    return {
      dir,
      layer,
      at,
      record,
      heldWhen,
      heldFile,
      recordDir,
      stateFile,
      recordOf,
      start: serviceFor(layer),
    };
  });

  it.live("settling or archiving moves the copy out of the project, and its backups go", () => {
    let archived = false;
    return Effect.gen(function* () {
      const { at, record, heldWhen, heldFile, start } = yield* heldHost("held-settle", {
        threadArchived: () => archived,
      });
      NodeFS.writeFileSync(at(`${COPY}1`), "backup");
      NodeFS.writeFileSync(at("notes.py"), "script");
      const git = (...args: ReadonlyArray<string>) =>
        NodeChildProcess.execFileSync("git", args, { cwd: at("."), encoding: "utf8" });
      git("init", "-q");
      const inode = NodeFS.statSync(at(COPY)).ino;
      const service = yield* start;
      yield* record(service);
      yield* service.closeOnSettle({ threadId });
      const [held] = yield* heldWhen(service, (list) => list.length === 1);
      expect(held).toMatchObject({ threadTitle: "Hero pass", path: at(COPY), bytes: 12 });
      expect(held!.expiresAt! - held!.heldAt).toBe(Duration.toMillis(Duration.days(30)));
      // Held on the project's own drive, in its hidden folder, by a rename: the same file.
      expect(NodeFS.statSync(heldFile(held!.id)).ino).toBe(inode);
      expect(NodeFS.readFileSync(heldFile(held!.id), "utf8")).toBe("working copy");
      // Git never sees it, and the project's own ignore rules are untouched.
      expect(git("status", "--porcelain", "--untracked-files=all")).not.toContain(".t3");
      expect(NodeFS.existsSync(at(".gitignore"))).toBe(false);
      // Nor can it be opened as a file of the project, or chosen as a master.
      const refused = yield* service
        .open({
          threadId: otherThreadId,
          relativePath: `.t3/held-working-copies/${held!.id}/copy.blend`,
        })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("notInWorkspace");
      // Only the copy and its backups leave; the master and every other file stay.
      const left = NodeFS.readdirSync(NodePath.dirname(at(COPY)));
      expect(left).toEqual(expect.arrayContaining(["cube.blend", "notes.py"]));
      expect(left.filter((name) => name.includes(".wip-"))).toEqual([]);
      // The pane offers it as the thread's kept copy, and Reopen puts it back and opens it.
      const key = `workspace:${COPY}`;
      expect(
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => "copies" in state),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        ),
      ).toMatchObject({ status: "closed", copies: [{ key, held: true, recovery: false }] });
      yield* service.reopen({ threadId, key, restore: true });
      expect(NodeFS.readFileSync(at(COPY), "utf8")).toBe("working copy");
      // Back by a link, as it left by a rename: still the same file, and nothing left held.
      expect(NodeFS.statSync(at(COPY)).ino).toBe(inode);
      expect(NodeFS.existsSync(heldFile(held!.id))).toBe(false);
      // The thread is still settled, so its Blender quitting holds the copy again.
      yield* service.quit({ threadId, save: false });
      yield* heldWhen(service, (list) => list.length === 1);
      expect(NodeFS.existsSync(at(COPY))).toBe(false);
      yield* service.putBackHeld({ threadId, path: at(COPY) });
      // Then held again when the thread is archived instead.
      yield* heldWhen(service, (list) => list.length === 0);
      archived = true;
      yield* service.closeOnSettle({ threadId });
      yield* heldWhen(service, (list) => list.length === 1);
      expect(NodeFS.existsSync(at(COPY))).toBe(false);
    }).pipe(Effect.scoped);
  });

  it.live(
    "a thread made active while its copy is being moved keeps the copy in the project",
    () => {
      let settled = true;
      return Effect.gen(function* () {
        // The hold waits once it has copied the file out, before removing it from the project.
        const copied = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { at, record, start } = yield* heldHost("held-active", {
          threadSettled: () => settled,
          holdGate: () =>
            Deferred.succeed(copied, undefined).pipe(Effect.andThen(Deferred.await(release))),
        });
        const service = yield* start;
        yield* record(service);
        yield* service.closeOnSettle({ threadId });
        yield* Deferred.await(copied);
        settled = false;
        yield* Deferred.succeed(release, undefined);
        // Waits for the move under the copy's lock: nothing was held, so nothing is put back.
        expect(yield* service.putBackHeld({ threadId, path: at(COPY) })).toBeNull();
        expect(NodeFS.readFileSync(at(COPY), "utf8")).toBe("working copy");
        expect(yield* service.heldWorkingCopies(threadId)).toEqual([]);
      }).pipe(Effect.scoped);
    },
  );

  it.live(
    "on another drive, a hold never deletes a save that lands as it copies, nor leaves a failed copy behind",
    () => {
      // Runs as each copy into T3's state finishes; a test sets what happens then.
      let afterCopy: () => Effect.Effect<void, PlatformError.PlatformError> = () => Effect.void;
      // Runs at the hold's next thread lookup, once a copy has finished.
      let atLookup: (() => void) | null = null;
      // Runs as the hold renames the project's file aside, once it has.
      let afterAside: (() => void) | null = null;
      // Told as each hold has the copy's lock, before it moves anything.
      let holding: Deferred.Deferred<void> | null = null;
      // A save as Blender makes one: a new file renamed over the old, so a new inode.
      const save = (file: string, contents: string) => {
        NodeFS.writeFileSync(`${file}.saving`, contents);
        NodeFS.renameSync(`${file}.saving`, file);
      };
      return Effect.gen(function* () {
        const { at, record, heldWhen, stateFile, recordOf, start } = yield* heldHost(
          "held-other-drive",
          {
            fileSystem: (base) => {
              const drive = otherDrive(() => afterCopy())(base);
              return {
                ...drive,
                rename: (from, to) =>
                  drive.rename(from, to).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        if (to.endsWith(".t3-hold")) afterAside?.();
                      }),
                    ),
                  ),
              };
            },
            beforeThreadLookup: () =>
              Effect.sync(() => {
                const run = atLookup;
                atLookup = null;
                run?.();
              }),
            holdGate: () => (holding === null ? Effect.void : Deferred.succeed(holding, undefined)),
          },
        );
        const service = yield* start;
        yield* record(service);
        const settleAndWait = Effect.gen(function* () {
          const gated = yield* Deferred.make<void>();
          holding = gated;
          yield* service.closeOnSettle({ threadId });
          yield* Deferred.await(gated);
          // Takes the copy's lock, so it waits for the hold, and settles nothing itself.
          yield* record(service);
        });

        // The disk fills as the copy is written: nothing is left in T3's state, and the copy is
        // still live in the project, to hold again later.
        const failed = yield* Deferred.make<void>();
        afterCopy = () =>
          Deferred.succeed(failed, undefined).pipe(
            Effect.andThen(Effect.fail(systemError("copyFile", at(COPY), "ENOSPC"))),
          );
        yield* service.closeOnSettle({ threadId });
        yield* Deferred.await(failed);
        yield* record(service);
        expect(recordOf()).toMatchObject({ state: "live", files: ["record.json"] });
        expect(NodeFS.readFileSync(at(COPY), "utf8")).toBe("working copy");

        // Desktop Blender saves the copy just after it is copied out: that save stays in the
        // project, and nothing is held.
        afterCopy = () =>
          Effect.sync(() => {
            atLookup = () => save(at(COPY), "saved on the desktop");
          });
        yield* settleAndWait;
        expect(NodeFS.readFileSync(at(COPY), "utf8")).toBe("saved on the desktop");
        expect(recordOf()).toMatchObject({ state: "live", files: ["record.json"] });
        expect(yield* service.heldWorkingCopies(threadId)).toEqual([]);

        // Saved again as the hold sets the first save aside: neither is lost, and Settings says
        // where the earlier one is.
        afterCopy = () =>
          Effect.sync(() => {
            atLookup = () => save(at(COPY), "saved on the desktop again");
            afterAside = () => {
              afterAside = null;
              save(at(COPY), "and once more");
            };
          });
        yield* settleAndWait;
        const aside = NodePath.join(NodePath.dirname(at(COPY)), `.${COPY}.t3-hold`);
        expect(NodeFS.readFileSync(at(COPY), "utf8")).toBe("and once more");
        expect(NodeFS.readFileSync(aside, "utf8")).toBe("saved on the desktop again");
        expect(yield* heldWhen(service, (list) => list.length === 1)).toMatchObject([
          { leftInProject: true, setAside: aside },
        ]);

        // Once the person moves the newer file away, the next hold puts the save back first
        // and holds that.
        afterCopy = () => Effect.void;
        NodeFS.renameSync(at(COPY), at("kept by hand.blend"));
        yield* settleAndWait;
        const [held] = yield* heldWhen(
          service,
          (list) => list.length === 1 && list[0]!.leftInProject !== true,
        );
        // Across a mount it is held in T3's own state instead.
        expect(NodeFS.readFileSync(stateFile(held!.id), "utf8")).toBe("saved on the desktop again");
        expect(NodeFS.existsSync(aside)).toBe(false);
        expect(NodeFS.existsSync(at(COPY))).toBe(false);
        expect(held!.bytes).toBe("saved on the desktop again".length);
      }).pipe(Effect.scoped);
    },
  );

  it.live("a Reopen Hosted Blender can't launch leaves the held copy held", () =>
    Effect.gen(function* () {
      const { at, record, heldWhen, start } = yield* heldHost("held-refused-reopen", {
        readiness: { status: "notSetUp", missing: ["enabled"] },
      });
      const service = yield* start;
      yield* record(service);
      yield* service.closeOnSettle({ threadId });
      yield* heldWhen(service, (list) => list.length === 1);
      const refused = yield* service
        .reopen({ threadId, key: `workspace:${COPY}`, restore: true })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("notSetUp");
      expect(NodeFS.existsSync(at(COPY))).toBe(false);
      expect(yield* heldWhen(service, () => true)).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.live("Reopen puts the held copy back first, with the unsaved work kept at settle", () =>
    Effect.gen(function* () {
      // The hold waits once it has copied the file out, before removing it from the project.
      const copied = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { service, dir, awaitStatus, awaitDirty, launches, hostedDir } = yield* standIn(
        "held-reopen",
        "",
        undefined,
        {
          holdGate: () =>
            Deferred.succeed(copied, undefined).pipe(Effect.andThen(Deferred.await(release))),
        },
      );
      const real = NodeFS.realpathSync(dir);
      NodeFS.writeFileSync(NodePath.join(real, COPY), "working copy");
      yield* service.recordWorkingCopy({
        threadId,
        master: NodePath.join(real, "cube.blend"),
        path: NodePath.join(real, COPY),
        relativePath: COPY,
      });
      yield* service.open({ threadId, relativePath: COPY });
      yield* awaitDirty(true);
      yield* service.closeOnSettle({ threadId });
      expect(yield* awaitStatus("closed")).toMatchObject({ relativePath: COPY, recovery: true });
      // Reopen while the copy is mid-move waits for the move, then puts the copy back.
      yield* Deferred.await(copied);
      const reopening = yield* service
        .reopen({ threadId, key: `workspace:${COPY}`, restore: true })
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(reopening);
      yield* awaitDirty(true);
      expect(NodeFS.readFileSync(NodePath.join(real, COPY), "utf8")).toBe("working copy");
      const reopened = launches().at(-1)!;
      expect(reopened).toContain(NodePath.join(real, COPY));
      expect(reopened[reopened.indexOf("--t3-recover") + 1]).toBe(
        recoveryOf(hostedDir, `workspace:${COPY}`)?.session,
      );
      yield* service.quit({ threadId, save: false, discard: true });
    }).pipe(Effect.scoped),
  );

  it.live("a move a crash interrupted ends with one whole copy, never none", () =>
    Effect.gen(function* () {
      let failWrites: (() => void) | null = null;
      const gated = yield* Deferred.make<void>();
      const { at, record, heldWhen, heldFile, recordDir, stateFile, start } = yield* heldHost(
        "held-crash",
        {
          holdGate: () =>
            Effect.sync(() => failWrites?.()).pipe(
              Effect.andThen(
                failWrites === null ? Effect.void : Deferred.succeed(gated, undefined),
              ),
            ),
        },
      );
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* start;
          yield* record(service);
          yield* service.closeOnSettle({ threadId });
          return (yield* heldWhen(service, (list) => list.length === 1))[0]!;
        }),
      );
      const recordPath = NodePath.join(recordDir(first.id), "record.json");
      const holding = () => {
        const written = JSON.parse(NodeFS.readFileSync(recordPath, "utf8"));
        NodeFS.writeFileSync(recordPath, JSON.stringify({ ...written, state: "holding" }));
      };
      // Copied out but not yet removed: the project's file is still the copy, and held again.
      NodeFS.copyFileSync(heldFile(first.id), at(COPY));
      holding();
      const again = yield* Effect.scoped(
        start.pipe(Effect.flatMap((service) => heldWhen(service, (list) => list.length === 1))),
      );
      expect(again[0]?.id).toBe(first.id);
      expect(NodeFS.existsSync(at(COPY))).toBe(false);
      expect(NodeFS.readFileSync(heldFile(first.id), "utf8")).toBe("working copy");
      // Removed but not yet marked held: the held copy is whole, so it stays held.
      holding();
      const held = yield* Effect.scoped(
        start.pipe(Effect.flatMap((service) => heldWhen(service, (list) => list.length === 1))),
      );
      expect(held[0]?.id).toBe(first.id);
      expect(NodeFS.readFileSync(heldFile(first.id), "utf8")).toBe("working copy");

      // On another drive, the project's file set aside to be checked once copied out: it goes
      // back, the newest the project had, and the pass at start holds it again.
      const aside = NodePath.join(NodePath.dirname(at(COPY)), `.${COPY}.t3-hold`);
      const restarted = (done: (list: HostedBlenderHeldList) => boolean) =>
        Effect.scoped(start.pipe(Effect.flatMap((service) => heldWhen(service, done))));
      NodeFS.writeFileSync(aside, "set aside");
      holding();
      yield* restarted((list) => list.length === 1);
      expect(NodeFS.readFileSync(heldFile(first.id), "utf8")).toBe("set aside");
      expect(NodeFS.existsSync(aside)).toBe(false);
      expect(NodeFS.existsSync(at(COPY))).toBe(false);
      // Set aside while another file took its place: both stay, and Settings says where.
      NodeFS.writeFileSync(aside, "set aside again");
      NodeFS.writeFileSync(at(COPY), "saved since");
      holding();
      expect(yield* restarted((list) => list.length === 1)).toMatchObject([
        { leftInProject: true, setAside: aside },
      ]);
      expect(NodeFS.readFileSync(aside, "utf8")).toBe("set aside again");
      expect(NodeFS.readFileSync(at(COPY), "utf8")).toBe("saved since");
      NodeFS.rmSync(aside);
      NodeFS.writeFileSync(at(COPY), "working copy");
      yield* restarted((list) => list.length === 1 && list[0]!.leftInProject !== true);

      // Held by an earlier build, in T3's state, its record naming no place: still put back.
      const { heldFile: _, ...earlier } = JSON.parse(NodeFS.readFileSync(recordPath, "utf8"));
      NodeFS.writeFileSync(recordPath, JSON.stringify(earlier));
      NodeFS.renameSync(heldFile(first.id), stateFile(first.id));
      expect(
        yield* Effect.scoped(
          start.pipe(
            Effect.flatMap((service) => service.putBackHeld({ threadId, path: at(COPY) })),
          ),
        ),
      ).toEqual({ masterChanged: false });
      expect(NodeFS.existsSync(stateFile(first.id))).toBe(false);
      expect(
        NodeFS.readFileSync(NodeFS.existsSync(at(COPY)) ? at(COPY) : heldFile(first.id), "utf8"),
      ).toBe("working copy");

      // No crash: the hold's last record write fails (a full disk, say) once the project's file
      // is gone. The thread's next start still gets its own copy back, not a fresh one.
      const service = yield* start;
      yield* service.putBackHeld({ threadId, path: at(COPY) });
      // Its record can't be written, though the copy can be moved in beside it.
      const blocked = `${recordPath}.partial`;
      failWrites = () => NodeFS.mkdirSync(blocked);
      yield* service.closeOnSettle({ threadId });
      yield* Deferred.await(gated);
      // Waits for the hold to let go of the copy; its own write fails the same way, and says so.
      const unkept = yield* service.keepHeld([{ id: first.id, heldAt: -1 }]).pipe(Effect.flip);
      expect(unkept.reason).toBe("heldCopyNotKept");
      failWrites = null;
      NodeFS.rmdirSync(blocked);
      expect(NodeFS.existsSync(at(COPY))).toBe(false);
      expect(yield* service.putBackHeld({ threadId, path: at(COPY) })).toEqual({
        masterChanged: false,
      });
      expect(NodeFS.readFileSync(at(COPY), "utf8")).toBe("working copy");
    }).pipe(Effect.scoped),
  );

  it.live("leaves a file it can't prove is its own copy, and says so", () =>
    Effect.gen(function* () {
      const { at, record, heldWhen, start } = yield* heldHost("held-refuse");
      // Hard-linked to the master, and a symlink to it: moving either could take the master.
      NodeFS.rmSync(at(COPY));
      NodeFS.linkSync(at("cube.blend"), at(COPY));
      const otherCopy = workingCopyName("cube.blend", otherThreadId);
      NodeFS.symlinkSync(at("cube.blend"), at(otherCopy));
      const service = yield* start;
      yield* record(service);
      yield* record(service, otherCopy, "cube.blend", otherThreadId);
      yield* service.closeOnSettle({ threadId });
      yield* service.closeOnSettle({ threadId: otherThreadId });
      const left = yield* heldWhen(service, (list) => list.length === 2);
      expect(left.map((entry) => entry.leftInProject)).toEqual([true, true]);
      expect(left.every((entry) => entry.expiresAt === undefined)).toBe(true);
      expect(NodeFS.lstatSync(at(otherCopy)).isSymbolicLink()).toBe(true);
      expect(NodeFS.statSync(at(COPY)).nlink).toBe(2);
      expect(NodeFS.readFileSync(at("cube.blend"), "utf8")).toBe("master");
    }).pipe(Effect.scoped),
  );

  it.live("asks once the master moved on: Delete removes them, Keep isn't asked again", () =>
    Effect.gen(function* () {
      const { at, record, heldWhen, heldFile, recordDir, start } = yield* heldHost("held-ask");
      NodeFS.writeFileSync(at("other.blend"), "other master");
      NodeFS.writeFileSync(at(OTHER_COPY), "other copy");
      const service = yield* start;
      yield* record(service);
      yield* record(service, OTHER_COPY, "other.blend");
      yield* service.closeOnSettle({ threadId });
      const held = yield* heldWhen(service, (list) => list.length === 2);
      const idOf = (name: string) => held.find((entry) => entry.path === at(name))!.id;
      const asked = () =>
        service.threadState(otherThreadId).pipe(
          Stream.runHead,
          Effect.map((state) => {
            const value = Option.getOrThrow(state);
            return "heldBehind" in value ? value.heldBehind : undefined;
          }),
        );
      const askedWhen = (done: (behind: unknown) => boolean) =>
        service.threadState(otherThreadId).pipe(
          Stream.map((state) => ("heldBehind" in state ? state.heldBehind : undefined)),
          Stream.filter(done),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );

      // Another thread works on cube.blend: nothing to ask until the master changes.
      yield* service.knowMaster({ threadId: otherThreadId, relativePath: "cube.blend" });
      expect(yield* asked()).toBeUndefined();
      // Saved outside T3 Code, as a desktop Blender's copy back is: the pane showing asks.
      NodeFS.writeFileSync(at("cube.blend"), "master, copied back into");
      const cube = {
        id: idOf(COPY),
        heldAt: held.find((entry) => entry.path === at(COPY))!.heldAt,
      };
      expect(yield* askedWhen((behind) => behind !== undefined)).toMatchObject({
        copies: [cube],
        threadTitles: ["Hero pass"],
        bytes: 12,
      });
      // A Delete for an earlier hold of that copy leaves this one alone.
      yield* service.deleteHeld([{ ...cube, heldAt: cube.heldAt - 1 }]);
      expect(NodeFS.existsSync(heldFile(idOf(COPY)))).toBe(true);
      // A removal that fails says so, and the copy stays listed to try again.
      const folder = NodePath.dirname(heldFile(idOf(COPY)));
      NodeFS.chmodSync(folder, 0o500);
      const refused = yield* service.deleteHeld([cube]).pipe(Effect.flip);
      NodeFS.chmodSync(folder, 0o700);
      expect(refused.reason).toBe("heldCopyNotDeleted");
      expect(yield* heldWhen(service, () => true)).toHaveLength(2);
      yield* service.deleteHeld([cube]);
      expect(yield* asked()).toBeUndefined();
      expect(NodeFS.existsSync(heldFile(idOf(COPY)))).toBe(false);

      // On other.blend, Keep: asked no more, however often the master changes again.
      yield* service.knowMaster({ threadId: otherThreadId, relativePath: "other.blend" });
      NodeFS.writeFileSync(at("other.blend"), "other master, copied back into");
      yield* service.knowMaster({ threadId: otherThreadId, relativePath: "other.blend" });
      const other = (yield* askedWhen((behind) => behind !== undefined))!.copies[0];
      // An answer that can't be saved says so, and is asked again.
      const otherFolder = recordDir(idOf(OTHER_COPY));
      NodeFS.chmodSync(otherFolder, 0o500);
      const unkept = yield* service.keepHeld([other]).pipe(Effect.flip);
      NodeFS.chmodSync(otherFolder, 0o700);
      expect(unkept.reason).toBe("heldCopyNotKept");
      expect(yield* asked()).toMatchObject({ copies: [other] });
      yield* service.keepHeld([other]);
      expect(yield* asked()).toBeUndefined();
      NodeFS.writeFileSync(at("other.blend"), "other master, changed again");
      expect(
        yield* heldWhen(service, (list) => list[0]?.kept === true && list[0].behind === true),
      ).toHaveLength(1);
      expect(yield* asked()).toBeUndefined();
      expect(NodeFS.readFileSync(heldFile(idOf(OTHER_COPY)), "utf8")).toBe("other copy");
    }).pipe(Effect.scoped),
  );

  it.effect("deletes a held copy 30 days after it was held, kept or not", () =>
    Effect.gen(function* () {
      const { record, heldWhen, heldFile, start } = yield* heldHost("held-limit");
      const service = yield* start;
      yield* record(service);
      yield* service.closeOnSettle({ threadId });
      const [held] = yield* heldWhen(service, (list) => list.length === 1);
      yield* service.keepHeld([held!]);
      for (let day = 1; day <= 30; day++) {
        yield* TestClock.adjust(Duration.days(1));
        // The day's pass takes the copy's lock as it wakes, so this waits for it.
        yield* service.keepHeld([held!]);
        expect(yield* heldWhen(service, () => true), `day ${day}`).toHaveLength(day < 30 ? 1 : 0);
      }
      expect(NodeFS.existsSync(heldFile(held!.id))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("deleting the thread deletes its held copy, and its copy still in the project", () =>
    Effect.gen(function* () {
      const { at, record, heldWhen, heldFile, start } = yield* heldHost("held-delete");
      const service = yield* start;
      yield* record(service);
      yield* service.closeOnSettle({ threadId });
      const [held] = yield* heldWhen(service, (list) => list.length === 1);
      NodeFS.writeFileSync(at("other.blend"), "other master");
      NodeFS.writeFileSync(at(OTHER_COPY), "other copy");
      NodeFS.writeFileSync(at(`${OTHER_COPY}1`), "backup");
      yield* record(service, OTHER_COPY, "other.blend");
      yield* service.forgetThread({ threadId });
      yield* heldWhen(service, (list) => list.length === 0);
      expect(NodeFS.existsSync(heldFile(held!.id))).toBe(false);
      expect(NodeFS.existsSync(at(OTHER_COPY))).toBe(false);
      expect(NodeFS.existsSync(at(`${OTHER_COPY}1`))).toBe(false);
      expect(NodeFS.readFileSync(at("other.blend"), "utf8")).toBe("other master");
    }).pipe(Effect.scoped),
  );

  it.live(
    "at start, holds a finished thread's copy, deletes a gone thread's, leaves the rest",
    () => {
      let settled = false;
      return Effect.gen(function* () {
        const { at, record, heldWhen, start } = yield* heldHost("held-start", {
          threadSettled: () => settled,
        });
        const goneThread = ThreadId.make("thread-long-gone");
        const goneCopy = workingCopyName("cube.blend", goneThread);
        const unknownCopy = workingCopyName("cube.blend", "thread-from-before");
        NodeFS.writeFileSync(at(goneCopy), "gone thread's copy");
        NodeFS.writeFileSync(at(unknownCopy), "a copy T3 has no record of");
        // Recorded while T3 ran; the thread finished, and the other was deleted, while it was stopped.
        yield* Effect.scoped(
          start.pipe(
            Effect.tap((service) => record(service)),
            Effect.tap((service) => record(service, goneCopy, "cube.blend", goneThread)),
          ),
        );
        settled = true;
        const service = yield* start;
        // Published once the pass has dealt with every copy.
        const [held] = yield* heldWhen(service, (list) => list.length === 1);
        expect(held?.path).toBe(at(COPY));
        expect(NodeFS.existsSync(at(COPY))).toBe(false);
        expect(NodeFS.existsSync(at(goneCopy))).toBe(false);
        expect(NodeFS.readFileSync(at(unknownCopy), "utf8")).toBe("a copy T3 has no record of");
      }).pipe(Effect.scoped);
    },
  );
});

describe("Endings and recovery", () => {
  it.live("settling saves a recovery copy, quits without saving, and Reopen restores it", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus, awaitDirty, saveCommands, launches, hostedDir } =
        yield* standIn("settle", "");
      yield* openReady;
      yield* service.closeOnSettle({ threadId });
      assert.deepStrictEqual(yield* awaitStatus("closed"), {
        status: "closed",
        relativePath: "cube.blend",
        recovery: true,
      });
      // Never saved over the user's file: the copy is Blender's own, in T3's private folder.
      expect(saveCommands()).toBe(0);
      const recovery = recoveryOf(hostedDir);
      expect(recovery?.contents).toMatch(/^quit copy /);
      // Moved, not copied: a large file costs no read or write.
      expect(String(NodeFS.statSync(recovery!.session).ino)).toBe(
        NodeFS.readFileSync(NodePath.join(hostedDir, "../../saves.log.quitInode"), "utf8"),
      );
      expect(NodeFS.readdirSync(NodePath.join(hostedDir, "launches"))).toEqual([]);

      yield* service.reopen({ threadId, key: CUBE, restore: true });
      yield* awaitDirty(true);
      const reopened = launches().at(-1)!;
      expect(reopened.slice(reopened.indexOf("--t3-recover"))).toEqual([
        "--t3-recover",
        recovery?.session,
        "--t3-timeline",
      ]);
      // Blender opens the user's file; the copy is restored over it, so saves still go there.
      expect(reopened).toContain(NodeFS.realpathSync(NodePath.join(hostedDir, "../../cube.blend")));

      // The person's Quit without saving discards the restored changes, and the copy they came from.
      yield* service.quit({ threadId, save: false, discard: true });
      expect(yield* awaitStatus("stopped")).toEqual({ status: "stopped" });
      expect(recoveryOf(hostedDir)).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.live(
    "a quit without saving that isn't the person's discard keeps what Blender says is unsaved, sending no window word after it",
    () =>
      Effect.gen(function* () {
        // Edited after Blender's last report, which T3 still holds as clean. The words T3 sends
        // on connecting are held until Blender has read the quit.
        const folder = { path: "" };
        const saves = () => NodePath.join(folder.path, "saves.log");
        const { service, awaitStatus, hostedDir, dir } = yield* standIn(
          "late-words",
          "quit-dirty",
          undefined,
          {
            heldWords: (word) =>
              word === "connected" ? fileAppears(folder.path, `${saves()}.quitRead`) : Effect.void,
          },
          { STANDIN_LINGER: "1" },
        );
        folder.path = dir;
        yield* service.open({ threadId, relativePath: "cube.blend" });
        yield* awaitStatus("running");
        yield* service.quit({ threadId, save: false });
        expect(yield* firstState(service)).toEqual({
          status: "closed",
          relativePath: "cube.blend",
          recovery: true,
        });
        expect(recoveryOf(hostedDir)?.contents).toMatch(/^quit copy /);
        const sent = NodeFS.readFileSync(`${saves()}.control`, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line).type);
        expect(sent.slice(sent.indexOf("quit"))).toEqual(["quit"]);
      }).pipe(Effect.scoped),
  );

  it.live("reopens the file as saved when asked, and keeps the copy until it ends again", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus, awaitDirty, launches, hostedDir } = yield* standIn(
        "fresh",
        "no-quit-copy",
      );
      yield* openReady;
      yield* service.closeOnSettle({ threadId });
      // Blender left no quit copy, so there's only the file as saved.
      expect(yield* awaitStatus("closed")).toMatchObject({ recovery: false });
      yield* service.dismiss({ threadId, key: CUBE });
      yield* awaitStatus("stopped");
      const missing = yield* service
        .reopen({ threadId, key: CUBE, restore: true })
        .pipe(Effect.flip);
      expect(missing.reason).toBe("nothingToReopen");

      NodeFS.mkdirSync(NodePath.join(hostedDir, "recovery"), { recursive: true });
      yield* openReady;
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      yield* service.reopen({ threadId, key: CUBE, restore: false });
      yield* awaitDirty(true);
      expect(launches().at(-1)).not.toContain("--t3-recover");
    }).pipe(Effect.scoped),
  );

  it.live("keeps the copy under the file Blender had open, and reopens that file", () =>
    Effect.gen(function* () {
      const { dir, service, awaitStatus, launches } = yield* standIn("opens-other", "opens-other");
      NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
      yield* service.open({ threadId, relativePath: "cube.blend" });
      yield* awaitStatus("running");
      yield* service.closeOnSettle({ threadId });
      expect(yield* awaitStatus("closed")).toEqual({
        status: "closed",
        relativePath: "other.blend",
        recovery: true,
      });
      yield* service.reopen({ threadId, key: OTHER, restore: true });
      yield* awaitStatus("running");
      expect(launches().at(-1)).toContain(NodeFS.realpathSync(NodePath.join(dir, "other.blend")));
    }).pipe(Effect.scoped),
  );

  it.live("says where a copy is once Reopen finds its file gone from the workspace", () =>
    Effect.gen(function* () {
      const { dir, service, openReady, awaitStatus, hostedDir } = yield* standIn("gone", "");
      yield* openReady;
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      expect((yield* service.keptCopies(threadId))[0]).not.toHaveProperty("copyPath");
      // A checkout removed it.
      NodeFS.rmSync(NodePath.join(dir, "cube.blend"));
      const refused = yield* service
        .reopen({ threadId, key: CUBE, restore: true })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("fileNotFound");
      expect((yield* service.keptCopies(threadId))[0]).toMatchObject({
        missing: true,
        copyPath: recoveryOf(hostedDir)?.session,
      });
      // Back again, it reopens as any copy does.
      NodeFS.writeFileSync(NodePath.join(dir, "cube.blend"), "");
      yield* service.reopen({ threadId, key: CUBE, restore: true });
      yield* awaitStatus("running");
      expect((yield* service.keptCopies(threadId))[0]).not.toHaveProperty("missing");
    }).pipe(Effect.scoped),
  );

  it.live("keeps a file outside the workspace under its own name, and says where its copy is", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus, hostedDir } = yield* standIn(
        "opens-outside",
        "opens-outside",
      );
      yield* openReady;
      yield* service.closeOnSettle({ threadId });
      expect(yield* awaitStatus("closed")).toEqual({
        status: "closed",
        outside: "/elsewhere/outside.blend",
        recovery: true,
      });
      const key = "outside:/elsewhere/outside.blend";
      const [copy] = yield* service.keptCopies(threadId);
      expect(copy?.copyPath).toBe(recoveryOf(hostedDir, key)?.session);
      expect(recoveryOf(hostedDir, key)?.contents).toMatch(/^quit copy /);
      // T3 can't check where restoring it would save, so it offers no Reopen.
      const refused = yield* service.reopen({ threadId, key, restore: true }).pipe(Effect.flip);
      expect(refused.reason).toBe("notInWorkspace");
      // Nothing was kept for the file it launched with.
      expect(recoveryOf(hostedDir)).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.live("keeps a restored copy whose save target isn't the reopened file, unsaved", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus, hostedDir } = yield* standIn(
        "restored-elsewhere",
        "restored-elsewhere",
      );
      yield* openReady;
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      const kept = recoveryOf(hostedDir)?.contents;
      yield* service.reopen({ threadId, key: CUBE, restore: true });
      // Saving would write somewhere else, so it never reaches running: the copy stays.
      expect(yield* awaitStatus("closed")).toMatchObject({ recovery: true, restoreFailed: true });
      expect(recoveryOf(hostedDir)?.contents).toBe(kept);
    }).pipe(Effect.scoped),
  );

  it.live("keeps a waiting recovery copy until it is reopened or dismissed", () =>
    Effect.gen(function* () {
      const { dir, service, openReady, awaitStatus, awaitDirty, hostedDir } = yield* standIn(
        "pending",
        "",
      );
      yield* openReady;
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      // Opening the same file would end in a newer copy of it, so its card comes first.
      const refused = yield* service
        .open({ threadId, relativePath: "cube.blend" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("recoveryPending");
      // Another file keeps a copy of its own, so it opens, and its end leaves cube's alone.
      NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
      const cube = recoveryOf(hostedDir)?.contents;
      yield* service.open({ threadId, relativePath: "other.blend" });
      yield* awaitDirty(true);
      yield* service.closeOnSettle({ threadId });
      expect(yield* awaitStatus("closed")).toMatchObject({ relativePath: "other.blend" });
      expect(recoveryOf(hostedDir)?.contents).toBe(cube);
      yield* service.dismiss({ threadId, key: OTHER });
      expect(yield* awaitStatus("closed")).toEqual({
        status: "closed",
        relativePath: "cube.blend",
        recovery: true,
      });
      // Dismissing a Blender that is running again does nothing, so a stale card can't end it.
      const shown = recoveryOf(hostedDir)?.record.keptAt;
      yield* service.reopen({ threadId, key: CUBE, restore: true });
      yield* awaitDirty(true);
      yield* service.dismiss({ threadId, key: CUBE });
      expect((yield* firstState(service)).status).toBe("running");
      expect(recoveryOf(hostedDir)?.contents).toMatch(/^quit copy /);
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      // A Discard confirmed on the copy from before the reopen leaves the one kept since.
      yield* service.dismiss({ threadId, key: CUBE, keptAt: shown });
      expect(recoveryOf(hostedDir)?.record.keptAt).toBeGreaterThan(shown ?? Infinity);
      expect((yield* firstState(service)).status).toBe("closed");
      yield* service.dismiss({ threadId, key: CUBE });
      yield* awaitStatus("stopped");
      expect(recoveryOf(hostedDir)).toBeNull();
      yield* service.open({ threadId, relativePath: "other.blend" });
    }).pipe(Effect.scoped),
  );

  it.live("a thread that settles during Save and quit ends saved, with nothing to reopen", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus, awaitDirty, saveCommands, hostedDir } =
        yield* standIn("settle-saving", "saved-then-exit");
      yield* openReady;
      const saving = yield* Effect.forkChild(service.quit({ threadId, save: true }));
      // Saved, Blender not yet gone: the thread settles in this window.
      yield* awaitDirty(false);
      yield* service.closeOnSettle({ threadId });
      yield* Fiber.join(saving);
      yield* awaitStatus("stopped");
      expect(saveCommands()).toBe(1);
      expect(recoveryOf(hostedDir)).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.live("keeps the quit copy when the file was unsaved again after Save and quit saved it", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus, hostedDir } = yield* standIn(
        "saved-then-dirty",
        "saved-then-dirty",
      );
      yield* openReady;
      yield* service.quit({ threadId, save: true });
      expect(yield* awaitStatus("closed")).toEqual({
        status: "closed",
        relativePath: "cube.blend",
        recovery: true,
      });
      expect(recoveryOf(hostedDir)?.contents).toMatch(/^quit copy /);
    }).pipe(Effect.scoped),
  );

  it.live("a shutdown leaves a slow quit copy to finish, for the next start to offer whole", () =>
    Effect.gen(function* () {
      const { dir, layer, marker } = yield* standIn("slow-quit", "slow-quit");
      const blendPath = NodePath.join(dir, "cube.blend");
      NodeFS.writeFileSync(blendPath, "the user's file");
      const started = yield* Effect.gen(function* () {
        const first = yield* serviceFor(layer);
        const states = yield* Queue.unbounded<HostedBlenderThreadState>();
        yield* first.threadState(threadId).pipe(
          Stream.runForEach((state) => Queue.offer(states, state)),
          Effect.forkScoped,
        );
        yield* first.open({ threadId, relativePath: "cube.blend" });
        yield* Queue.take(states).pipe(
          Effect.repeat({ until: (state) => state.status === "running" && state.dirty }),
        );
        return yield* Clock.currentTimeMillis;
      }).pipe(Effect.scoped);
      // The desktop app kills the server 5 seconds after asking it to stop.
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(5_000);
      // N2: Blender acknowledged the quit and was still writing its copy, the only copy of the
      // latest edits: left to finish, never stopped mid-write.
      yield* fileAppears(dir, marker);
      expect(NodeFS.readFileSync(marker, "utf8")).toBe("finished");
      expect(NodeFS.readFileSync(blendPath, "utf8")).toBe("the user's file");
      // The next start offers that copy, whole.
      const next = yield* serviceFor(layer);
      const kept = yield* next.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "closed"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(card(kept)).toEqual({ status: "closed", relativePath: "cube.blend", recovery: true });
      expect(recoveryOf(NodePath.join(dir, "userdata", "hosted-blender"))?.contents).toMatch(
        /^quit copy \d+$/,
      );
    }).pipe(Effect.scoped),
  );

  it.live("a discard released at shutdown brings nothing back after the restart", () =>
    Effect.gen(function* () {
      const { dir, layer, marker } = yield* standIn("slow-discard", "slow-quit");
      const hostedDir = NodePath.join(dir, "userdata", "hosted-blender");
      yield* Effect.gen(function* () {
        const first = yield* serviceFor(layer);
        const states = yield* Queue.unbounded<HostedBlenderThreadState>();
        yield* first.threadState(threadId).pipe(
          Stream.runForEach((state) => Queue.offer(states, state)),
          Effect.forkScoped,
        );
        const next = (until: (state: HostedBlenderThreadState) => boolean) =>
          Queue.take(states).pipe(Effect.repeat({ until }));
        yield* first.open({ threadId, relativePath: "cube.blend" });
        yield* next((state) => state.status === "running" && state.dirty);
        yield* first.closeOnSettle({ threadId });
        yield* next((state) => state.status === "closed");
        NodeFS.rmSync(marker);
        // Restored, then the person's Quit without saving, and T3 stops while Blender writes.
        yield* first.reopen({ threadId, key: CUBE, restore: true });
        yield* next((state) => state.status === "running" && state.dirty);
        yield* first
          .quit({
            threadId,
            save: false,
            discard: true,
            openFile: { kind: "workspace", relativePath: "cube.blend" },
          })
          .pipe(Effect.forkChild);
        const control = NodePath.join(dir, "saves.log.control");
        yield* fileAppears(dir, control, () =>
          NodeFS.readFileSync(control, "utf8").includes('"filepath"'),
        );
      }).pipe(Effect.scoped);
      yield* fileAppears(dir, marker);
      expect(NodeFS.readFileSync(marker, "utf8")).toBe("finished");
      // The work the person chose to lose, restored copy and quit copy alike, is gone.
      const restarted = yield* serviceFor(layer);
      expect(yield* firstState(restarted)).toEqual({ status: "stopped" });
      expect(recoveryOf(hostedDir)).toBeNull();
      expect(yield* restarted.keptCopies(threadId)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("a shutdown keeps one deadline, however late the add-on connects", () =>
    Effect.gen(function* () {
      const { dir, layer, marker } = yield* standIn("late-slow", "late-slow-quit");
      const started = yield* Effect.gen(function* () {
        const first = yield* serviceFor(layer);
        const states = yield* Queue.unbounded<HostedBlenderThreadState>();
        yield* first.threadState(threadId).pipe(
          Stream.runForEach((state) => Queue.offer(states, state)),
          Effect.forkScoped,
        );
        yield* first.open({ threadId, relativePath: "cube.blend" });
        yield* Queue.take(states).pipe(
          Effect.repeat({ until: (state) => state.status === "running" }),
        );
        // Shuts down at once: the add-on connects 3 seconds in, then takes 5 to quit.
        return yield* Clock.currentTimeMillis;
      }).pipe(Effect.scoped);
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(5_000);
      // It acknowledged the quit by the deadline, so it is left to finish.
      yield* fileAppears(dir, marker);
      expect(NodeFS.readFileSync(marker, "utf8")).toBe("finished");
    }).pipe(Effect.scoped),
  );

  it.live(
    "R3: Quit without saving ends a Blender stuck saving the file it names, and stops nothing it can't confirm",
    () =>
      Effect.gen(function* () {
        const discardStuck = Effect.fnUntraced(function* (scenario: string) {
          const { dir, service, openReady, awaitStatus } = yield* standIn(scenario, scenario);
          yield* openReady;
          const saving = yield* service
            .quit({ threadId, save: true })
            .pipe(Effect.flip, Effect.forkChild);
          yield* fileAppears(dir, NodePath.join(dir, "saves.log"));
          const openFile = { kind: "workspace" as const, relativePath: "cube.blend" };
          const discard = yield* service
            .quit({ threadId, save: false, discard: true, openFile })
            .pipe(Effect.flip, Effect.option);
          return { saving, discard, state: yield* firstState(service), awaitStatus };
        });
        const [busy, stuck] = yield* Effect.all(
          [discardStuck("busy-save"), discardStuck("stuck-saving")],
          { concurrency: "unbounded" },
        );
        // Begun, the save is of the file the dialog named, which Blender can't change mid-save.
        expect(Option.isNone(stuck.discard)).toBe(true);
        expect(yield* stuck.awaitStatus("stopped")).toEqual({ status: "stopped" });
        expect((yield* Fiber.join(stuck.saving)).reason).toBe("saveFailed");
        // Never begun, Blender never said which file it has: nothing is stopped as a discard.
        expect(Option.getOrThrow(busy.discard).reason).toBe("discardUnconfirmed");
        expect(busy.state.status).toBe("running");
      }).pipe(Effect.scoped),
  );

  it.live(
    "a second unanswered discard stops Blender as a crash, keeping its autosave; an answer between resets it",
    () =>
      Effect.gen(function* () {
        const openFile = { kind: "workspace" as const, relativePath: "cube.blend" };
        const discard = (service: HostedBlender.HostedBlender["Service"]) =>
          service
            .quit({ threadId, save: false, discard: true, openFile })
            .pipe(Effect.flip, Effect.option);
        const deaf = Effect.gen(function* () {
          const { service, openReady, awaitStatus, hostedDir } = yield* standIn(
            "deaf",
            "deaf-discard",
          );
          yield* openReady;
          expect(Option.getOrThrow(yield* discard(service)).reason).toBe("discardUnconfirmed");
          expect((yield* firstState(service)).status).toBe("running");
          expect(Option.isNone(yield* discard(service))).toBe(true);
          // Never a discard: the card offers what Blender last autosaved.
          expect(yield* awaitStatus("crashed")).toMatchObject({ recovery: true });
          expect(recoveryOf(hostedDir)?.contents).toBe("autosave");
        });
        const answered = Effect.gen(function* () {
          const { service, openReady } = yield* standIn("answered", "answers-second");
          yield* openReady;
          expect(Option.getOrThrow(yield* discard(service)).reason).toBe("discardUnconfirmed");
          expect(Option.getOrThrow(yield* discard(service)).reason).toBe("openFileChanged");
          expect(Option.getOrThrow(yield* discard(service)).reason).toBe("discardUnconfirmed");
          expect((yield* firstState(service)).status).toBe("running");
        });
        // A crash before Blender takes the discard is a crash: its autosave is kept.
        const crashed = Effect.gen(function* () {
          const { dir, service, openReady, awaitStatus, crash, hostedDir } = yield* standIn(
            "deaf-crash",
            "deaf-discard",
          );
          yield* openReady;
          const control = NodePath.join(dir, "saves.log.control");
          yield* Effect.forkChild(discard(service));
          yield* fileAppears(
            dir,
            control,
            () =>
              NodeFS.existsSync(control) &&
              NodeFS.readFileSync(control, "utf8").includes('"type":"quit"'),
          );
          crash();
          expect(yield* awaitStatus("crashed")).toMatchObject({ recovery: true });
          expect(recoveryOf(hostedDir)?.contents).toBe("autosave");
        });
        yield* Effect.all([deaf, answered, crashed], { concurrency: "unbounded" });
      }).pipe(Effect.scoped),
  );

  it.live(
    "a discard its dropped connection can't carry is unconfirmed, then stops Blender as a crash",
    () =>
      Effect.gen(function* () {
        const openFile = { kind: "workspace" as const, relativePath: "cube.blend" };
        // Busy, so a discard read before the drop goes unanswered rather than quitting it.
        const { service, openReady, awaitStatus, loseConnection, hostedDir } = yield* standIn(
          "lost-discard",
          "ignores-quit",
        );
        yield* openReady;
        // The control connection drops while the stream goes on.
        loseConnection();
        const discard = service
          .quit({ threadId, save: false, discard: true, openFile })
          .pipe(Effect.flip, Effect.option);
        expect(Option.getOrThrow(yield* discard).reason).toBe("discardUnconfirmed");
        expect((yield* firstState(service)).status).toBe("running");
        expect(Option.isNone(yield* discard)).toBe(true);
        expect(yield* awaitStatus("crashed")).toMatchObject({ recovery: true });
        expect(recoveryOf(hostedDir)?.contents).toBe("autosave");
      }).pipe(Effect.scoped),
  );

  it.live("a discard or a save Blender refuses sends the window words it held back", () =>
    Effect.gen(function* () {
      const { dir, service, openReady } = yield* standIn("held-words", "opens-during-discard");
      yield* openReady;
      const control = NodePath.join(dir, "saves.log.control");
      const expected = (generation: number) =>
        fileAppears(
          dir,
          control,
          () =>
            NodeFS.existsSync(control) &&
            NodeFS.readFileSync(control, "utf8").includes(
              `"type":"viewportExpected","generation":${generation}`,
            ),
        );
      const refused = yield* service
        .quit({
          threadId,
          save: false,
          discard: true,
          openFile: { kind: "workspace", relativePath: "cube.blend" },
        })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("openFileChanged");
      // The window announced while the discard was queued is expected after all.
      yield* expected(2);
      // So is one announced while a Save and quit that then failed was queued.
      const failed = yield* service.quit({ threadId, save: true }).pipe(Effect.flip);
      expect(failed.reason).toBe("saveFailed");
      yield* expected(3);
    }).pipe(Effect.scoped),
  );

  it.live(
    "a quit or a settle leaves a Blender with unsaved image edits open, saying so; Quit without saving still quits",
    () =>
      Effect.gen(function* () {
        const { dir, service, openReady, awaitStatus, saveCommands } = yield* standIn(
          "images",
          "unsaved-images",
        );
        yield* openReady;
        const held = NodePath.join(dir, "saves.log.held");
        const heldCount = () =>
          NodeFS.existsSync(held) ? NodeFS.readFileSync(held, "utf8").split("\n").length - 1 : 0;
        // The pane's one-click quit, an agent's blender_quit and Save and quit all say what to save.
        expect((yield* service.quit({ threadId, save: false }).pipe(Effect.flip)).reason).toBe(
          "unsavedImages",
        );
        const saving = yield* service.quit({ threadId, save: true }).pipe(Effect.flip);
        expect(saving).toMatchObject({ reason: "unsavedImages", images: ["paint"] });
        expect(saving.message).toContain("couldn't save paint,");
        expect(saveCommands()).toBe(0);
        // A settle leaves it running as it was.
        yield* service.closeOnSettle({ threadId });
        yield* fileAppears(dir, held, () => heldCount() === 3);
        expect((yield* firstState(service)).status).toBe("running");
        // The pane's quit that joins a settle's close still waiting on Blender gets its answer.
        const gate = NodePath.join(dir, "held-gate");
        NodeFS.writeFileSync(gate, "");
        const settling = yield* service.closeOnSettle({ threadId }).pipe(Effect.forkChild);
        yield* fileAppears(dir, `${gate}.asked`);
        const joined = yield* service
          .quit({ threadId, save: false })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        NodeFS.writeFileSync(`${gate}.open`, "");
        expect((yield* Fiber.join(joined)).reason).toBe("unsavedImages");
        yield* Fiber.join(settling);
        expect(heldCount()).toBe(4);
        // The person's discard doesn't ask.
        yield* service.quit({
          threadId,
          save: false,
          discard: true,
          openFile: { kind: "workspace", relativePath: "cube.blend" },
        });
        expect(yield* awaitStatus("stopped")).toEqual({ status: "stopped" });
      }).pipe(Effect.scoped),
  );

  it.live(
    "a quit or a settle Blender never answers leaves it running, past a Save and quit that never began, holding up no other thread",
    () =>
      Effect.gen(function* () {
        const running = (service: HostedBlender.HostedBlender["Service"]) =>
          Stream.runHead(service.threadState(threadId)).pipe(
            Effect.map((state) => Option.getOrThrow(state).status),
          );
        const busySave = Effect.gen(function* () {
          const { dir, service, openReady } = yield* standIn("busy-settle", "busy-save");
          NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
          yield* openReady;
          yield* service.open({ threadId: otherThreadId, relativePath: "other.blend" });
          const saving = yield* service
            .quit({ threadId, save: true })
            .pipe(Effect.flip, Effect.forkChild);
          yield* fileAppears(dir, NodePath.join(dir, "saves.log"));
          yield* service.closeOnSettle({ threadId });
          // Settled meanwhile, the other thread's Blender closes with its copy at once.
          yield* service.closeOnSettle({ threadId: otherThreadId });
          const other = yield* service.threadState(otherThreadId).pipe(
            Stream.filter((state) => state.status !== "running" && state.status !== "starting"),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
          expect(card(other)).toMatchObject({ status: "closed", relativePath: "other.blend" });
          // The pane's quit, asked as the settle was, gives up at the same deadline.
          expect((yield* service.quit({ threadId, save: false }).pipe(Effect.flip)).reason).toBe(
            "quitUnanswered",
          );
          expect(yield* running(service)).toBe("running");
          yield* Fiber.interrupt(saving);
        });
        const deaf = Effect.gen(function* () {
          const { service, openReady } = yield* standIn("deaf-quit", "ignores-quit");
          yield* openReady;
          yield* service.closeOnSettle({ threadId });
          expect((yield* service.quit({ threadId, save: false }).pipe(Effect.flip)).reason).toBe(
            "quitUnanswered",
          );
          expect(yield* running(service)).toBe("running");
        });
        yield* Effect.all([busySave, deaf], { concurrency: "unbounded" });
      }).pipe(Effect.scoped),
  );

  it.live("a late answer to an earlier quit never settles a later one", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus, hostedDir } = yield* standIn(
        "answers-late",
        "answers-late",
      );
      yield* openReady;
      // Busy past the first quit's deadline: unanswered, and Blender stays open.
      expect((yield* service.quit({ threadId, save: false }).pipe(Effect.flip)).reason).toBe(
        "quitUnanswered",
      );
      // The retry goes through, whatever Blender then says of the first, and keeps its copy.
      yield* service.quit({ threadId, save: false });
      expect(yield* awaitStatus("closed")).toMatchObject({ recovery: true });
      expect(recoveryOf(hostedDir)?.contents).toMatch(/^quit copy /);
    }).pipe(Effect.scoped),
  );

  it.live("a settle that outlasts a failing save still quits Blender with its copy", () =>
    Effect.gen(function* () {
      const { dir, service, openReady, awaitStatus } = yield* standIn(
        "late-fail",
        "late-failing-save",
      );
      yield* openReady;
      // The stand-in logs each save before it acknowledges it.
      const savesLog = NodePath.join(dir, "saves.log");
      const saving = new Promise<void>((resolve) => {
        const watcher = NodeFS.watch(dir, () => {
          if (!NodeFS.existsSync(savesLog)) return;
          watcher.close();
          resolve();
        });
      });
      const quitting = yield* service
        .quit({ threadId, save: true })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => saving);
      yield* service.closeOnSettle({ threadId });
      expect((yield* Fiber.join(quitting)).reason).toBe("saveFailed");
      expect(yield* awaitStatus("closed")).toMatchObject({ recovery: true });
    }).pipe(Effect.scoped),
  );

  it.live("a shutdown stops a Blender whose add-on never connects, within its deadline", () =>
    Effect.gen(function* () {
      const { layer } = yield* standIn("never-connects", "never-connects");
      const started = yield* Effect.gen(function* () {
        const first = yield* serviceFor(layer);
        const states = yield* Queue.unbounded<HostedBlenderThreadState>();
        yield* first.threadState(threadId).pipe(
          Stream.runForEach((state) => Queue.offer(states, state)),
          Effect.forkScoped,
        );
        yield* first.open({ threadId, relativePath: "cube.blend" });
        yield* Queue.take(states).pipe(
          Effect.repeat({ until: (state) => state.status === "running" }),
        );
        return yield* Clock.currentTimeMillis;
      }).pipe(Effect.scoped);
      // The helper ignores its quit too, so only the shutdown's fast stop ends it in time.
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(5_000);
    }).pipe(Effect.scoped),
  );

  it.live(
    "a Blender that crashes mid-save while its thread settles ends Crashed, autosave kept",
    () =>
      Effect.gen(function* () {
        const { dir, service, openReady, awaitStatus, crash, loseConnection, hostedDir } =
          yield* standIn("crash-saving", "held-save");
        yield* openReady;
        const quitting = yield* service
          .quit({ threadId, save: true })
          .pipe(Effect.flip, Effect.forkChild);
        yield* fileAppears(dir, NodePath.join(dir, "saves.log"));
        // The settle waits on the save; Blender dies before either finishes. Its connection
        // drops while the helper still runs, and the save fails before the exit is reported.
        yield* service.closeOnSettle({ threadId });
        loseConnection();
        expect((yield* Fiber.join(quitting)).reason).toBe("saveFailed");
        crash();
        expect(yield* awaitStatus("crashed")).toMatchObject({ recovery: true });
        expect(recoveryOf(hostedDir)?.contents).toBe("autosave");
      }).pipe(Effect.scoped),
  );

  it.live("changes no capture during a Save and quit, and catches up if the save fails", () =>
    Effect.gen(function* () {
      const { dir, service, openReady, helperCommands, bind } = yield* standIn(
        "saving-capture",
        "held-save",
      );
      yield* openReady;
      const attached = yield* service.attachViewer(threadId, { canOperate: false });
      assert.strictEqual(attached._tag, "attached");
      if (attached._tag !== "attached") return;
      const viewer = attached.viewer;
      yield* viewer.setVisible(false);
      /** Once at least `count` logged commands match. */
      const logged = (matches: (command: { readonly type: string }) => boolean, count = 1) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              const check = () => {
                if (helperCommands().filter(matches).length < count) return false;
                watcher.close();
                resolve();
                return true;
              };
              const watcher = NodeFS.watch(dir, check);
              check();
            }),
        );
      const savesLog = NodePath.join(dir, "saves.log");
      const saving = new Promise<void>((resolve) => {
        const watcher = NodeFS.watch(dir, () => {
          if (!NodeFS.existsSync(savesLog)) return;
          watcher.close();
          resolve();
        });
      });
      const quitting = yield* service
        .quit({ threadId, save: true })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => saving);
      yield* viewer.setVisible(true);
      // Commands reach the helper in order, so once this resize is logged a resume would be too.
      yield* viewer.resize(802, 602);
      yield* logged((command) => command.type === "resize");
      const capture = () =>
        helperCommands().filter((command) => command.type === "pause" || command.type === "resume");
      expect(capture().at(-1)?.type).toBe("pause");
      // The save fails and Blender stays open: capture follows the pane that is showing.
      const resumes = capture().filter((command) => command.type === "resume").length;
      bind();
      expect((yield* Fiber.join(quitting)).reason).toBe("saveFailed");
      yield* logged((command) => command.type === "resume", resumes + 1);
      expect(capture().at(-1)?.type).toBe("resume");
    }).pipe(Effect.scoped),
  );

  it.live(
    "never resumes capture for a Blender that is ending, and pauses it once nobody watches",
    () =>
      Effect.gen(function* () {
        const { service, openReady, awaitStatus, helperCommands } = yield* standIn(
          "ending-capture",
          "slow-quit",
        );
        yield* openReady;
        const attached = yield* service.attachViewer(threadId, { canOperate: false });
        assert.strictEqual(attached._tag, "attached");
        if (attached._tag !== "attached") return;
        yield* attached.viewer.setVisible(true);
        // The settle waits on a quit Blender acknowledged; the last pane leaving meanwhile pauses
        // capture, and one shown again stays dark.
        yield* service.closeOnSettle({ threadId });
        yield* attached.viewer.setVisible(false);
        yield* attached.viewer.setVisible(true);
        yield* awaitStatus("closed");
        const capture = helperCommands().filter(
          (command) => command.type === "pause" || command.type === "resume",
        );
        expect(capture.at(-1)?.type).toBe("pause");
      }).pipe(Effect.scoped),
  );

  it.live("a file can't start again while a settle that keeps its copy finishes", () =>
    Effect.gen(function* () {
      let hold: Deferred.Deferred<void> | null = null;
      const { service, openReady, awaitStatus } = yield* standIn("race", "", () =>
        hold === null ? Effect.void : Deferred.await(hold),
      );
      yield* openReady;
      // Opening the file again passes its first checks while it is still running...
      const gate = yield* Deferred.make<void>();
      hold = gate;
      const opening = yield* service
        .open({ threadId, relativePath: "cube.blend" })
        .pipe(Effect.flip, Effect.forkChild);
      // ...and is still validating when the settle finishes and keeps cube.blend's copy.
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      yield* Deferred.succeed(gate, undefined);
      expect((yield* Fiber.join(opening)).reason).toBe("recoveryPending");
    }).pipe(Effect.scoped),
  );

  it.live("keeps the launch folder for the next start when its copy can't be kept", () =>
    Effect.gen(function* () {
      const { layer, service, openReady, awaitStatus, hostedDir } = yield* standIn("disk", "");
      yield* openReady;
      // Stands in for a full disk: the recovery folder can't be made.
      NodeFS.mkdirSync(hostedDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(hostedDir, "recovery"), "");
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("stopped");
      expect(NodeFS.readdirSync(NodePath.join(hostedDir, "launches"))).toHaveLength(1);
      NodeFS.rmSync(NodePath.join(hostedDir, "recovery"));
      const next = yield* serviceFor(layer);
      expect(yield* firstState(next)).toEqual({
        status: "closed",
        relativePath: "cube.blend",
        recovery: true,
      });
      expect(recoveryOf(hostedDir)?.contents).toMatch(/^quit copy /);
    }).pipe(Effect.scoped),
  );

  it.live("a restore that fails is reported and keeps the copy it came from", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus, hostedDir, launches } = yield* standIn(
        "restore-fails",
        "restore-fails",
      );
      yield* openReady;
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      const kept = recoveryOf(hostedDir)?.contents;
      yield* service.reopen({ threadId, key: CUBE, restore: true });
      expect(yield* awaitStatus("closed")).toEqual({
        status: "closed",
        relativePath: "cube.blend",
        recovery: true,
        restoreFailed: true,
      });
      expect(launches()).toHaveLength(2);
      expect(recoveryOf(hostedDir)?.contents).toBe(kept);
    }).pipe(Effect.scoped),
  );

  it.live("never saves a reopened Blender before its restore is confirmed", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus, saveCommands, hostedDir } = yield* standIn(
        "restore-silent",
        "restore-silent",
      );
      yield* openReady;
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      const kept = recoveryOf(hostedDir)?.contents;
      yield* service.reopen({ threadId, key: CUBE, restore: true });
      // The add-on is connected and reporting, but hasn't said whether the copy came back.
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "starting" && state.dirty),
        Stream.runHead,
      );
      const refused = yield* service.quit({ threadId, save: true }).pipe(Effect.flip);
      expect(refused.reason).toBe("saveFailed");
      expect(saveCommands()).toBe(0);
      yield* service.quit({ threadId, save: false });
      yield* awaitStatus("closed");
      expect(recoveryOf(hostedDir)?.contents).toBe(kept);
    }).pipe(Effect.scoped),
  );

  it.live(
    "B5: deleting a thread ends its Blender and removes every copy it kept, not a master's",
    () =>
      Effect.gen(function* () {
        const { dir, layer, hostedDir } = yield* standIn("deleted", "");
        NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
        waitingCopy(hostedDir, "waiting copy", "other.blend");
        // The master's one copy, shared by every thread whose master is that file.
        const masterFile = NodePath.join(dir, "master.blend");
        const masterKey = `outside:${masterFile}`;
        const masterFolder = NodePath.join(
          hostedDir,
          "recovery",
          Buffer.from("t3:master").toString("base64url"),
          NodeCrypto.createHash("sha256").update(masterKey).digest("hex"),
        );
        NodeFS.mkdirSync(masterFolder, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(masterFolder, "session.blend"), "master copy");
        NodeFS.writeFileSync(
          NodePath.join(masterFolder, "record.json"),
          JSON.stringify({
            threadId: "t3:master",
            file: { kind: "outside", path: masterFile },
            kind: "closed",
            recovery: true,
            keptAt: 1,
          }),
        );
        const service = yield* serviceFor(layer);
        yield* service.open({ threadId, relativePath: "cube.blend" });
        // Running with unsaved changes, which its end keeps as cube.blend's copy at first.
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
        );
        yield* service.forgetThread({ threadId });
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "stopped"),
          Stream.runHead,
        );
        expect(recoveryOf(hostedDir)).toBeNull();
        expect(recoveryOf(hostedDir, OTHER)).toBeNull();
        expect(
          NodeFS.existsSync(
            NodePath.join(hostedDir, "recovery", Buffer.from(threadId).toString("base64url")),
          ),
        ).toBe(false);
        expect(recoveryOf(hostedDir, masterKey, "t3:master")?.contents).toBe("master copy");
        expect(yield* service.keptCopies(threadId)).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live("a Quit with nothing running never removes a kept copy", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus, hostedDir } = yield* standIn("stale-quit", "");
      yield* openReady;
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      yield* service.quit({ threadId, save: false });
      expect((yield* firstState(service)).status).toBe("closed");
      expect(recoveryOf(hostedDir)?.contents).toMatch(/^quit copy /);
    }).pipe(Effect.scoped),
  );

  it.live("switching Hosted Blender off closes its Blender as a settle does, copy kept", () =>
    Effect.gen(function* () {
      const switches = yield* Queue.unbounded<HostedBlenderSetup.HostedBlenderReadiness>();
      const { openReady, awaitStatus, saveCommands, hostedDir } = yield* standIn(
        "switch-off",
        "",
        undefined,
        { readinessChanges: Stream.fromQueue(switches) },
      );
      yield* openReady;
      yield* Queue.offer(switches, { status: "notSetUp", missing: ["enabled"] });
      expect(yield* awaitStatus("closed")).toEqual({
        status: "closed",
        relativePath: "cube.blend",
        recovery: true,
      });
      // Never saved over the user's file: Blender quit without saving, into its copy.
      expect(saveCommands()).toBe(0);
      expect(recoveryOf(hostedDir)?.contents).toMatch(/^quit copy /);
    }).pipe(Effect.scoped),
  );

  it.live("M18: an open still validating when Hosted Blender is switched off never launches", () =>
    Effect.gen(function* () {
      let hold: Deferred.Deferred<void> | null = null;
      const switches = yield* Queue.unbounded<HostedBlenderSetup.HostedBlenderReadiness>();
      const { dir, service, openReady, awaitStatus, launches } = yield* standIn(
        "switch-off-race",
        "",
        () => (hold === null ? Effect.void : Deferred.await(hold)),
        { readinessChanges: Stream.fromQueue(switches) },
      );
      NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
      yield* openReady;
      // Another thread's open passes its readiness check, then waits on its thread lookup...
      const gate = yield* Deferred.make<void>();
      hold = gate;
      const opening = yield* service
        .open({ threadId: otherThreadId, relativePath: "other.blend" })
        .pipe(Effect.flip, Effect.forkChild);
      // ...while Hosted Blender is switched off, which closes the Blender that was running.
      yield* Queue.offer(switches, { status: "notSetUp", missing: ["enabled"] });
      yield* awaitStatus("closed");
      yield* Deferred.succeed(gate, undefined);
      expect((yield* Fiber.join(opening)).reason).toBe("notSetUp");
      expect(launches()).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.live("an ending waits for a slow Blender's add-on, so its session is still kept", () =>
    Effect.gen(function* () {
      const { service, awaitStatus, bind } = yield* standIn("late", "late-control");
      yield* service.open({ threadId, relativePath: "cube.blend" });
      yield* awaitStatus("running");
      yield* service.closeOnSettle({ threadId });
      bind();
      expect(yield* awaitStatus("closed")).toMatchObject({ recovery: true });
    }).pipe(Effect.scoped),
  );

  it.live(
    "a settle a still-loading Blender never hears leaves it loading, and closes it once it answers",
    () =>
      Effect.gen(function* () {
        const { service, awaitStatus, bind, marker, hostedDir } = yield* standIn(
          "late-settle",
          "late-control",
        );
        yield* service.open({ threadId, relativePath: "cube.blend" });
        yield* awaitStatus("running");
        const launches = NodePath.join(hostedDir, "launches");
        const outcome = () => {
          const [launch] = NodeFS.readdirSync(launches);
          return launch === undefined ? null : NodePath.join(launches, launch, "outcome");
        };
        const closing = () => {
          const file = outcome();
          return file !== null && NodeFS.existsSync(file);
        };
        yield* service.closeOnSettle({ threadId });
        yield* fileAppears(NodePath.dirname(outcome()!), outcome()!, closing);
        // Its deadline passes unheard: the close is undone, and nothing is stopped.
        yield* fileAppears(NodePath.dirname(outcome()!), outcome()!, () => !closing());
        expect(NodeFS.existsSync(marker)).toBe(false);
        expect((yield* firstState(service)).status).toBe("running");
        // Loaded, it answers, and the close it owes runs then, keeping its copy.
        bind();
        expect(yield* awaitStatus("closed")).toMatchObject({ recovery: true });
        expect(NodeFS.readFileSync(marker, "utf8")).toBe("quit");
      }).pipe(Effect.scoped),
  );

  it.live("a T3 restart saves every Blender's copy on the way down and offers Reopen after", () =>
    Effect.gen(function* () {
      const { layer, hostedDir, marker, launches } = yield* standIn("restart", "");
      // The first server lives in a scope of its own, closed as a shutdown closes it.
      yield* Effect.gen(function* () {
        const first = yield* serviceFor(layer);
        const states = yield* Queue.unbounded<HostedBlenderThreadState>();
        yield* first.threadState(threadId).pipe(
          Stream.runForEach((state) => Queue.offer(states, state)),
          Effect.forkScoped,
        );
        yield* first.open({ threadId, relativePath: "cube.blend" });
        yield* Queue.take(states).pipe(
          Effect.repeat({ until: (state) => state.status === "running" && state.dirty }),
        );
      }).pipe(Effect.scoped);
      expect(NodeFS.readFileSync(marker, "utf8")).toBe("quit");
      expect(recoveryOf(hostedDir)?.contents).toMatch(/^quit copy /);

      const second = yield* serviceFor(layer);
      assert.deepStrictEqual(yield* firstState(second), {
        status: "closed",
        relativePath: "cube.blend",
        recovery: true,
      });
      yield* second.reopen({ threadId, key: CUBE, restore: true });
      yield* second.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && state.dirty),
        Stream.runHead,
      );
      expect(launches().at(-1)).toContain("--t3-recover");
    }).pipe(Effect.scoped),
  );

  it.live("a crashed Blender stays stopped, offers its autosave, and restarts from disk", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus, awaitDirty, crash, launches, hostedDir } =
        yield* standIn("crash", "");
      yield* openReady;
      crash();
      assert.deepStrictEqual(yield* awaitStatus("crashed"), {
        status: "crashed",
        relativePath: "cube.blend",
        recovery: true,
      });
      expect(recoveryOf(hostedDir)?.contents).toBe("autosave");
      // No restart loop: nothing launched since.
      expect(launches()).toHaveLength(1);
      expect((yield* firstState(service)).status).toBe("crashed");

      yield* service.reopen({ threadId, key: CUBE, restore: false });
      yield* awaitDirty(true);
      expect(launches()).toHaveLength(2);
      expect(launches().at(-1)).not.toContain("--t3-recover");
    }).pipe(Effect.scoped),
  );

  it.live("restores the newest autosave when asked after a crash", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus, awaitDirty, crash, launches, hostedDir } =
        yield* standIn("crash-restore", "");
      yield* openReady;
      crash();
      yield* awaitStatus("crashed");
      yield* service.reopen({ threadId, key: CUBE, restore: true });
      yield* awaitDirty(true);
      expect(launches().at(-1)).toContain(recoveryOf(hostedDir)?.session);
    }).pipe(Effect.scoped),
  );

  it.live("a close owed to a settled thread never runs once the thread is active again", () =>
    Effect.gen(function* () {
      let settled = true;
      const { service, awaitStatus, bind, marker, hostedDir } = yield* standIn(
        "unsettled",
        "late-control",
        undefined,
        { threadSettled: () => settled },
      );
      yield* service.open({ threadId, relativePath: "cube.blend" });
      yield* awaitStatus("running");
      const launches = NodePath.join(hostedDir, "launches");
      const outcome = () => {
        const [launch] = NodeFS.readdirSync(launches);
        return launch === undefined ? null : NodePath.join(launches, launch, "outcome");
      };
      const closing = () => {
        const file = outcome();
        return file !== null && NodeFS.existsSync(file);
      };
      yield* service.closeOnSettle({ threadId });
      yield* fileAppears(NodePath.dirname(outcome()!), outcome()!, closing);
      yield* fileAppears(NodePath.dirname(outcome()!), outcome()!, () => !closing());
      // The person sends a message meanwhile, so the thread is no longer settled.
      settled = false;
      bind();
      // Its words are read in order: once its first report is published, the close was weighed.
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && state.dirty),
        Stream.runHead,
      );
      // Still open, and still answering.
      expect((yield* service.captureView(threadId)).screenshot).not.toBeNull();
      expect(NodeFS.existsSync(marker)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("quits a Blender that ignores the quit, as a last resort, on shutdown", () =>
    Effect.gen(function* () {
      const { layer, hostedDir, marker } = yield* standIn("ignores", "ignores-quit");
      yield* Effect.gen(function* () {
        const first = yield* serviceFor(layer);
        const states = yield* Queue.unbounded<HostedBlenderThreadState>();
        yield* first.threadState(threadId).pipe(
          Stream.runForEach((state) => Queue.offer(states, state)),
          Effect.forkScoped,
        );
        yield* first.open({ threadId, relativePath: "cube.blend" });
        yield* Queue.take(states).pipe(
          Effect.repeat({ until: (state) => state.status === "running" && state.dirty }),
        );
      }).pipe(Effect.scoped);
      // The helper was asked to stop Blender itself once the add-on's quit went unanswered.
      expect(NodeFS.readFileSync(marker, "utf8")).toBe("quit");
      expect(recoveryOf(hostedDir)?.contents).toBeNull();
      expect(NodeFS.readdirSync(NodePath.join(hostedDir, "launches"))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("salvages the autosave of a Blender whose server died without ending it", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage");
      const leftover = NodePath.join(dir, "userdata", "hosted-blender", "launches", "dead");
      NodeFS.mkdirSync(NodePath.join(leftover, "tmp"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(leftover, "launch.json"),
        JSON.stringify({ threadId, relativePath: "models/hero.blend" }),
      );
      NodeFS.writeFileSync(NodePath.join(leftover, "tmp", "hero_77_autosave.blend"), "autosave");
      NodeFS.writeFileSync(NodePath.join(leftover, "tmp", "hero.crash.txt"), "");
      const bin = fakeTools(dir);
      const service = yield* serviceFor(
        layerFor({
          env: { PATH: bin },
          helper: NodePath.join(bin, "helper"),
          workspaceRoot: dir,
          baseDir: dir,
        }),
      );
      assert.deepStrictEqual(yield* firstState(service), {
        status: "crashed",
        relativePath: "models/hero.blend",
        recovery: true,
      });
      const hostedDir = NodePath.join(dir, "userdata", "hosted-blender");
      expect(recoveryOf(hostedDir, "workspace:models/hero.blend")?.contents).toBe("autosave");
      expect(NodeFS.readdirSync(NodePath.join(hostedDir, "launches"))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("lists every running Blender with its file and memory", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus } = yield* standIn("list", "");
      const lists = yield* Queue.unbounded<
        HostedBlender.HostedBlender["Service"] extends {
          readonly runningBlenders: Stream.Stream<infer A>;
        }
          ? A
          : never
      >();
      yield* service.runningBlenders.pipe(
        Stream.runForEach((list) => Queue.offer(lists, list)),
        Effect.forkScoped,
      );
      expect(yield* Queue.take(lists)).toEqual([]);
      yield* openReady;
      const listed = yield* Queue.take(lists).pipe(
        Effect.repeat({
          until: (list) =>
            list[0]?.status === "running" && list[0].dirty && list[0].memoryBytes !== null,
        }),
      );
      expect(listed).toEqual([
        {
          threadId,
          status: "running",
          relativePath: "cube.blend",
          dirty: true,
          openFile: { kind: "workspace", relativePath: "cube.blend" },
          memoryBytes: expect.any(Number),
        },
      ]);
      // Its unsaved changes discarded, as the person chose in Quit's dialog.
      yield* service.quit({ threadId, save: false, discard: true });
      yield* awaitStatus("stopped");
      yield* Queue.take(lists).pipe(Effect.repeat({ until: (list) => list.length === 0 }));
    }).pipe(Effect.scoped),
  );
});

describe("The viewport window", () => {
  it.live("reads its camera and casts each mark through the frozen view", () =>
    Effect.gen(function* () {
      const { service, openReady, runtime, dir } = yield* standIn("view", "");
      yield* openReady;
      const capture = yield* service.captureView(threadId);
      assert.deepStrictEqual(capture, {
        // Blender's own render of the viewport, drawn with this camera, read and then removed.
        screenshot: { dataUrl: `data:image/png;base64,${STANDIN_PNG}`, width: 1, height: 1 },
        cameraView: { position: [7, -7, 5], target: [0, 0, 1], upAxis: "z" },
        projection: {
          matrix: [2, ...Array.from({ length: 15 }, () => 0)],
          region: { x: 0.1, y: 0.05, width: 0.8, height: 0.9 },
        },
        // What the picture is of, which the annotation links to and its hits are checked against.
        scene: "launch:7",
        openFile: { kind: "workspace", relativePath: "cube.blend" },
      });
      const hits = yield* service.findHits({
        threadId,
        projection: capture.projection,
        scene: capture.scene,
        marks: [[{ x: 0.5, y: 0.25 }], []],
      });
      assert.deepStrictEqual(hits, [{ object: "m2", point: [0.5, 0.25, 2] }, null]);
      const asked = NodeFS.readFileSync(NodePath.join(dir, "saves.log.control"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((command) => command.type === "hits");
      expect(asked).toMatchObject({ scene: "launch:7" });
      expect(
        NodeFS.readdirSync(runtime, { recursive: true }).filter((name) =>
          String(name).endsWith(".png"),
        ),
      ).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("moves to a link's view", () =>
    Effect.gen(function* () {
      const { service, openReady } = yield* standIn("set-view", "");
      yield* openReady;
      yield* service.setView({
        threadId,
        relativePath: "cube.blend",
        view: { position: [1, 2, 3], target: [4, 5, 6] },
      });
      const capture = yield* service.captureView(threadId);
      assert.deepStrictEqual(capture.cameraView, {
        position: [1, 2, 3],
        target: [4, 5, 6],
        upAxis: "z",
      });
    }).pipe(Effect.scoped),
  );

  it.live("moves the master Blender's viewport window for a link to the thread's master", () =>
    Effect.gen(function* () {
      const { service } = yield* standIn("master-view", "");
      yield* service.openMaster({ threadId, relativePath: "cube.blend" });
      yield* service.masterState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && state.dirty),
        Stream.runHead,
      );
      const view = { position: [1, 2, 3], target: [0, 0, 0] } as const;
      yield* service.setView({ threadId, relativePath: "cube.blend", view, role: "master" });
      // The working side has no Blender, so the same link there has nothing to move.
      const working = yield* service
        .setView({ threadId, relativePath: "cube.blend", view })
        .pipe(Effect.flip);
      expect(working.reason).toBe("notRunning");
      yield* service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped),
  );

  it.live("refuses a link's view once Blender has another file open than the one it started", () =>
    Effect.gen(function* () {
      const { service, openReady } = yield* standIn("set-view-moved-on", "opened-other");
      yield* openReady;
      const view = { position: [1, 2, 3], target: [4, 5, 6] } as const;
      const working = yield* service
        .setView({ threadId, relativePath: "cube.blend", view })
        .pipe(Effect.flip);
      expect(working.reason).toBe("otherFileOpen");
    }).pipe(Effect.scoped),
  );

  it.live("refuses a link's view for a file other than the one open", () =>
    Effect.gen(function* () {
      const { service, openReady } = yield* standIn("set-view-other", "");
      yield* openReady;
      const refused = yield* service
        .setView({
          threadId,
          relativePath: "other.blend",
          view: { position: [1, 2, 3], target: [4, 5, 6] },
        })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("otherFileOpen");
      const capture = yield* service.captureView(threadId);
      expect(capture.cameraView.position).toEqual([7, -7, 5]);
    }).pipe(Effect.scoped),
  );

  it.live("fails when the thread has no hosted Blender", () =>
    Effect.gen(function* () {
      const { service } = yield* standIn("view-stopped", "");
      const failed = yield* service.captureView(threadId).pipe(Effect.flip);
      expect(failed.reason).toBe("notRunning");
      const refused = yield* service
        .setView({
          threadId,
          relativePath: "cube.blend",
          view: { position: [1, 0, 0], target: [0, 0, 0] },
        })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("notRunning");
    }).pipe(Effect.scoped),
  );

  it.live("sends Blender one hit request at a time", () =>
    Effect.gen(function* () {
      const { service, openReady } = yield* standIn("one-cast", "slow-hits");
      yield* openReady;
      const projection = {
        matrix: Array.from({ length: 16 }, () => 0),
        region: { x: 0, y: 0, width: 1, height: 1 },
      };
      const results = yield* Effect.all(
        Array.from({ length: 3 }, () =>
          service.findHits({ threadId, projection, scene: "s", marks: [[{ x: 0.5, y: 0.5 }]] }),
        ),
        { concurrency: "unbounded" },
      );
      expect(results.map((hits) => hits[0]?.object)).toEqual([
        "in flight 1",
        "in flight 1",
        "in flight 1",
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("keeps a hit request's slot until Blender answers, though its caller gave up", () =>
    Effect.gen(function* () {
      const { service, openReady } = yield* standIn("abandoned-cast", "slow-hits");
      yield* openReady;
      const request = {
        threadId,
        projection: {
          matrix: Array.from({ length: 16 }, () => 0),
          region: { x: 0, y: 0, width: 1, height: 1 },
        },
        scene: "s",
        marks: [[{ x: 0.5, y: 0.5 }]],
      };
      // The stand-in answers after 0.3 s; this caller stops waiting long before that.
      const abandoned = yield* service.findHits(request).pipe(Effect.timeoutOption("100 millis"));
      expect(abandoned._tag).toBe("None");
      const hits = yield* service.findHits(request);
      expect(hits[0]?.object).toBe("in flight 1");
    }).pipe(Effect.scoped),
  );

  it.live("renders one screenshot at a time, and cleans up after one its caller gave up on", () =>
    Effect.gen(function* () {
      const { service, openReady, viewRequests, runtime } = yield* standIn("one-view", "slow-view");
      yield* openReady;
      // The first caller stops waiting before Blender has written its screenshot.
      const abandoned = yield* service
        .captureView(threadId)
        .pipe(Effect.timeoutOption("50 millis"));
      expect(abandoned._tag).toBe("None");
      const capture = yield* service.captureView(threadId);
      expect(capture.screenshot.width).toBe(1);
      expect(viewRequests()).toBe(1);
      expect(
        NodeFS.readdirSync(runtime, { recursive: true }).filter((name) =>
          /\.png(\.part)?$/.test(String(name)),
        ),
      ).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "goes without a screenshot Blender can't render, that's too large, or isn't a plain file in its private folder; and says when there is no viewport or no reply",
    () =>
      Effect.gen(function* () {
        for (const [scenario, reason] of [
          ["no-render", "noScreenshot"],
          ["big-shot", "noScreenshot"],
          ["linked-shot", "noScreenshot"],
          ["no-viewport", "noViewport"],
          ["drop-on-view", "noReply"],
        ] as const) {
          const { service, openReady } = yield* standIn(scenario, scenario);
          yield* openReady;
          const failed = yield* service.captureView(threadId).pipe(Effect.flip);
          expect({ scenario, reason: failed.reason }).toEqual({ scenario, reason });
        }
      }).pipe(Effect.scoped),
  );
});

it.effect("keeps connecting to the add-on for the whole start window", () =>
  Effect.gen(function* () {
    const { service, awaitStatus, awaitDirty, bind, launches } = yield* standIn(
      "late-connect",
      "late-control",
    );
    yield* service.open({ threadId, relativePath: "cube.blend" });
    yield* awaitStatus("running");
    // Long past the old 30-second retry budget, but inside the 90-second start window.
    yield* TestClock.adjust("40 seconds");
    const t3 = launches()[0]!;
    const socketPath = t3[t3.indexOf("--t3-control") + 1]!;
    const appeared = Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          const watcher = NodeFS.watch(NodePath.dirname(socketPath), () => {
            if (!NodeFS.existsSync(socketPath)) return;
            watcher.close();
            resolve();
          });
        }),
    );
    bind();
    yield* appeared;
    yield* TestClock.adjust("1 second");
    yield* awaitDirty(true);
  }).pipe(Effect.scoped),
);

type Viewer = HostedBlender.HostedBlenderViewer;
type ViewerMessage = Extract<
  HostedBlender.HostedBlenderViewerOutput,
  { _tag: "message" }
>["message"];

const attach = (service: HostedBlender.HostedBlender["Service"], canOperate: boolean) =>
  service.attachViewer(threadId, { canOperate }).pipe(
    Effect.map((attached) => {
      assert.strictEqual(attached._tag, "attached");
      return (attached as Extract<typeof attached, { _tag: "attached" }>).viewer;
    }),
  );

/** The next message of `type`, skipping frames and other messages. */
const nextMessage = <Type extends ViewerMessage["type"]>(
  viewer: Viewer,
  type: Type,
): Effect.Effect<Extract<ViewerMessage, { type: Type }>> =>
  Queue.take(viewer.output).pipe(
    Effect.flatMap((output) =>
      output._tag === "message" && output.message.type === type
        ? Effect.succeed(output.message as Extract<ViewerMessage, { type: Type }>)
        : nextMessage(viewer, type),
    ),
  );
const controller = (viewer: Viewer) =>
  nextMessage(viewer, "control").pipe(Effect.map((message) => message.controller));

// A middle-button press makes the stand-in hide Blender's cursor, so it marks where the helper
// has every command sent before it.
const syncPoint = (viewer: Viewer) =>
  viewer
    .input({ type: "button", button: 274, pressed: true })
    .pipe(Effect.andThen(nextMessage(viewer, "cursor")));

describe("Taking control", () => {
  it.live("moves control between viewers one at a time, releasing what the last one held", () =>
    Effect.gen(function* () {
      const { service, openReady, helperInput } = yield* standIn("control", "");
      yield* openReady;
      const first = yield* attach(service, true);
      const second = yield* attach(service, true);
      const watcher = yield* attach(service, false);
      expect(yield* nextMessage(watcher, "control")).toEqual({
        type: "control",
        canOperate: false,
        controller: "unclaimed",
      });
      expect(yield* controller(first)).toBe("unclaimed");
      expect(yield* controller(second)).toBe("unclaimed");

      yield* first.input({ type: "takeControl", takeOver: false });
      expect(yield* controller(first)).toBe("you");
      expect(yield* controller(second)).toBe("another-viewer");
      expect(yield* controller(watcher)).toBe("another-viewer");

      // Only a take over moves control away from the viewer that has it.
      yield* second.input({ type: "takeControl", takeOver: false });
      yield* second.input({ type: "key", code: 16, pressed: true });
      yield* watcher.input({ type: "takeControl", takeOver: true });
      yield* first.input({ type: "key", code: 42, pressed: true });
      yield* first.input({ type: "key", code: 42, pressed: true });
      yield* first.input({ type: "pointer", x: 100, y: 50 });
      yield* syncPoint(first);
      expect(helperInput()).toEqual([
        { type: "key", code: 42, pressed: true },
        { type: "pointerPosition", x: 100, y: 50 },
        { type: "pointerButton", button: 274, pressed: true },
      ]);
      expect(yield* nextMessage(second, "cursor")).toEqual({ type: "cursor", captured: true });

      yield* second.input({ type: "takeControl", takeOver: true });
      expect(yield* controller(second)).toBe("you");
      expect(yield* controller(first)).toBe("another-viewer");
      yield* first.input({ type: "key", code: 30, pressed: true });
      yield* second.input({ type: "pointerMotion", dx: 3, dy: -2 });
      // The stand-in shows the cursor again once the held middle button is released.
      expect(yield* nextMessage(second, "cursor")).toEqual({ type: "cursor", captured: false });
      yield* syncPoint(second);
      expect(helperInput().slice(3)).toEqual([
        { type: "key", code: 42, pressed: false },
        { type: "pointerButton", button: 274, pressed: false },
        { type: "pointerMotion", dx: 3, dy: -2 },
        { type: "pointerButton", button: 274, pressed: true },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("sizes the display to the viewer in control, and answers a refused take", () =>
    Effect.gen(function* () {
      const { service, openReady, helperInput } = yield* standIn("size", "");
      yield* openReady;
      const operator = yield* attach(service, true);
      yield* operator.resize(800, 600);
      expect(yield* controller(operator)).toBe("unclaimed");
      yield* operator.input({ type: "takeControl", takeOver: false });
      expect(yield* controller(operator)).toBe("you");
      // A newer viewer opening the pane doesn't resize the controller's display...
      const newer = yield* attach(service, true);
      yield* newer.resize(1600, 900);
      expect(yield* controller(newer)).toBe("another-viewer");
      // ...and a take it lost the race for still tells it who has control.
      yield* newer.input({ type: "takeControl", takeOver: false });
      expect(yield* controller(newer)).toBe("another-viewer");
      yield* operator.resize(1024, 768);
      yield* syncPoint(operator);
      expect(yield* nextMessage(newer, "cursor")).toEqual({ type: "cursor", captured: true });
      // Taking over resizes the display to the new controller's pane.
      yield* newer.input({ type: "takeControl", takeOver: true });
      expect(yield* nextMessage(newer, "cursor")).toEqual({ type: "cursor", captured: false });
      yield* syncPoint(newer);
      expect(
        helperInput().filter((command) => (command as { type: string }).type === "resize"),
      ).toEqual([
        { type: "resize", width: 800, height: 600 },
        { type: "resize", width: 1024, height: 768 },
        { type: "resize", width: 1600, height: 900 },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("sizes the display to a pane that connected while Blender was starting", () =>
    Effect.gen(function* () {
      const { service, awaitDirty, helperInput } = yield* standIn("size-at-start", "");
      yield* service.open({ threadId, relativePath: "cube.blend" });
      // Before the helper runs there is nobody to resize; the size must not count as applied.
      const viewer = yield* attach(service, true);
      yield* viewer.resize(1046, 1336);
      yield* awaitDirty(true);
      yield* viewer.input({ type: "takeControl", takeOver: false });
      expect(yield* controller(viewer).pipe(Effect.repeat({ until: (c) => c === "you" }))).toBe(
        "you",
      );
      yield* syncPoint(viewer);
      expect(
        helperInput().filter((command) => (command as { type: string }).type === "resize"),
      ).toEqual([{ type: "resize", width: 1046, height: 1336 }]);
    }).pipe(Effect.scoped),
  );

  it.live("tells viewers when Blender captures the mouse, and frees control on leaving", () =>
    Effect.gen(function* () {
      const { service, openReady, helperInput } = yield* standIn("cursor", "");
      yield* openReady;
      const other = yield* attach(service, true);
      expect(yield* controller(other)).toBe("unclaimed");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const leaving = yield* attach(service, true);
          expect(yield* controller(leaving)).toBe("unclaimed");
          yield* leaving.input({ type: "takeControl", takeOver: false });
          expect(yield* controller(leaving)).toBe("you");
          expect(yield* syncPoint(leaving)).toEqual({ type: "cursor", captured: true });
          expect(yield* controller(other)).toBe("another-viewer");
          expect(yield* nextMessage(other, "cursor")).toEqual({ type: "cursor", captured: true });
        }),
      );
      // Leaving released the middle button it held, and nobody is in control.
      expect(yield* controller(other)).toBe("unclaimed");
      expect(yield* nextMessage(other, "cursor")).toEqual({ type: "cursor", captured: false });
      expect(helperInput()).toEqual([
        { type: "pointerButton", button: 274, pressed: true },
        { type: "pointerButton", button: 274, pressed: false },
      ]);
      // A viewer that joins late learns the cursor state with its first messages.
      yield* other.input({ type: "takeControl", takeOver: false });
      yield* syncPoint(other);
      const late = yield* attach(service, false);
      expect(yield* nextMessage(late, "cursor")).toEqual({ type: "cursor", captured: true });
    }).pipe(Effect.scoped),
  );
});

/** The next frame, skipping messages. */
const nextFrame = (viewer: Viewer): Effect.Effect<Uint8Array> =>
  Queue.take(viewer.output).pipe(
    Effect.flatMap((output) =>
      output._tag === "frame" ? Effect.succeed(output.data) : nextFrame(viewer),
    ),
  );
/** Whether a frame is waiting for `viewer`; empties its queue. */
const hasFrame = (viewer: Viewer) =>
  Queue.clear(viewer.output).pipe(
    Effect.map((outputs) => outputs.some((output) => output._tag === "frame")),
  );
const isKey = (frame: Uint8Array) => (frame[5]! & 1) === 1;
/** The next keyframe, past the deltas already on the wire before it. */
const nextKeyframe = (viewer: Viewer): Effect.Effect<Uint8Array> =>
  nextFrame(viewer).pipe(Effect.filterOrElse(isKey, () => nextKeyframe(viewer)));
const ofType = <Command extends { readonly type: string }>(
  commands: ReadonlyArray<Command>,
  ...types: ReadonlyArray<string>
) => commands.filter((command) => types.includes(command.type));

describe("B13: a file changed on disk", () => {
  /** What T3 told the add-on of the file on disk, and how often the stand-in reloaded. */
  const diskOf = (dir: string) => {
    const lines = (file: string) =>
      NodeFS.existsSync(file)
        ? NodeFS.readFileSync(file, "utf8")
            .split("\n")
            .filter((line) => line.length > 0)
        : [];
    const notices = () =>
      lines(NodePath.join(dir, "saves.log.disk")).map(
        (line) =>
          JSON.parse(line) as { type: string; reload?: boolean; path?: string; revision?: string },
      );
    const asked = () =>
      notices()
        .filter((notice) => notice.type === "diskChanged")
        .map((notice) => notice.reload);
    return {
      asked,
      notices,
      reloads: () => lines(NodePath.join(dir, "saves.log.reloads")).length,
      /** Waits for T3's `count`th word on the file. */
      awaitAsked: (count: number) => fileAppears(dir, dir, () => asked().length >= count),
      awaitReloads: (count: number) =>
        fileAppears(dir, dir, () => lines(NodePath.join(dir, "saves.log.reloads")).length >= count),
      change: (body: string) => NodeFS.writeFileSync(NodePath.join(dir, "cube.blend"), body),
    };
  };
  const reloadKept = (states: Stream.Stream<{ readonly status: string }>) =>
    states.pipe(
      Stream.filter((state) => "reloadKept" in state),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );

  it.live(
    "reloads at once while a pane shows it, and once a pane is back otherwise, never resuming capture for it",
    () =>
      Effect.gen(function* () {
        const { dir, service, openReady, helperCommands, hostedDir } = yield* standIn(
          "disk",
          "reloads",
        );
        const disk = diskOf(dir);
        yield* openReady;
        // Its first look, with no pane yet, finds nothing changed.
        yield* disk.awaitAsked(1);
        const viewer = yield* attach(service, false);
        disk.change("changed once");
        yield* disk.awaitAsked(2);
        expect(disk.asked()).toEqual([false, true]);
        // Its unsaved changes are the file's copy, which the pane offers.
        const shown = yield* reloadKept(service.threadState(threadId));
        expect(shown).toMatchObject({ status: "running", dirty: false, reloadKept: { key: CUBE } });
        expect(recoveryOf(hostedDir)).toMatchObject({
          record: { recovery: true },
          contents: "unsaved 1",
        });

        yield* viewer.setVisible(false);
        const hidden = helperCommands().length;
        disk.change("changed twice");
        yield* disk.awaitAsked(3);
        disk.change("changed three times");
        yield* disk.awaitAsked(4);
        expect(disk.asked().slice(2)).toEqual([false, false]);
        expect(disk.reloads()).toBe(1);
        expect(ofType(helperCommands().slice(hidden), "resume")).toEqual([]);
        // Back on screen: one reload, to the file as it is now.
        yield* viewer.setVisible(true);
        yield* disk.awaitReloads(2);
        expect(disk.asked()).toEqual([false, true, false, false, true]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "reloads before the agent's next call while no pane shows it, still without capture",
    () =>
      Effect.gen(function* () {
        const { dir, service, openReady, helperCommands, hostedDir, bind } = yield* standIn(
          "disk-agent",
          "reloads",
        );
        const disk = diskOf(dir);
        yield* openReady;
        yield* disk.awaitAsked(1);
        const viewer = yield* attach(service, false);
        yield* viewer.setVisible(false);
        const hidden = helperCommands().length;
        disk.change("changed by a headless script");
        yield* disk.awaitAsked(2);
        bind();
        const kept = yield* reloadKept(service.threadState(threadId));
        expect(kept).toMatchObject({ dirty: false, reloadKept: { key: CUBE } });
        expect(recoveryOf(hostedDir)).toMatchObject({
          record: { recovery: true },
          contents: "unsaved 1",
        });
        expect(disk.asked()).toEqual([false, false]);
        expect(ofType(helperCommands().slice(hidden), "resume")).toEqual([]);
        // Restore puts the kept changes back over the reloaded file, and the offer goes.
        yield* service.reopen({ threadId, key: CUBE, restore: true });
        const restored = yield* firstState(service);
        expect(restored).not.toHaveProperty("reloadKept");
      }).pipe(Effect.scoped),
  );

  it.live("refuses Save and quit over a file changed on disk, and leaves Blender running", () =>
    Effect.gen(function* () {
      const { dir, service, openReady } = yield* standIn("disk-save", "reloads");
      const disk = diskOf(dir);
      yield* openReady;
      yield* disk.awaitAsked(1);
      disk.change("changed by a checkout");
      const refused = yield* service.quit({ threadId, save: true }).pipe(Effect.flip);
      expect(refused.reason).toBe("changedOnDisk");
      expect((yield* firstState(service)).status).toBe("running");
    }).pipe(Effect.scoped),
  );

  it.live("reloads a master shared by two threads once, for both threads' Master views", () =>
    Effect.gen(function* () {
      const { dir, service } = yield* standIn("disk-master", "reloads");
      const disk = diskOf(dir);
      yield* service.openMaster({ threadId, relativePath: "cube.blend" });
      yield* service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" });
      yield* service.masterState(otherThreadId).pipe(
        Stream.filter((state) => state.status === "running" && "dirty" in state && state.dirty),
        Stream.runHead,
      );
      yield* disk.awaitAsked(1);
      for (const thread of [threadId, otherThreadId]) {
        const attached = yield* service.attachViewer(thread, { canOperate: false, role: "master" });
        expect(attached._tag).toBe("attached");
      }
      disk.change("copied back through another Blender");
      yield* disk.awaitAsked(2);
      expect(disk.asked()).toEqual([false, true]);
      for (const thread of [threadId, otherThreadId]) {
        expect(yield* reloadKept(service.masterState(thread))).toMatchObject({
          reloadKept: { key: "outside:" + NodeFS.realpathSync(NodePath.join(dir, "cube.blend")) },
        });
      }
      expect(disk.reloads()).toBe(1);
      // Quit with nothing newer to keep, the Master side offers the reload's copy as what it is.
      NodeFS.writeFileSync(NodePath.join(dir, "staged-quietly"), "");
      yield* service.quit({ threadId, save: false, role: "master" });
      const closed = yield* service.masterState(threadId).pipe(
        Stream.filter((state) => state.status === "closed"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(closed).toMatchObject({ copies: [{ recovery: true, reloaded: true }] });
    }).pipe(Effect.scoped),
  );

  it.live(
    "S5: a pane attaching hidden starts no capture and asks no reload; the last pane hiding takes a held reload back",
    () =>
      Effect.gen(function* () {
        const { dir, service, openReady, helperCommands } = yield* standIn(
          "disk-hidden",
          "reloads",
        );
        const disk = diskOf(dir);
        yield* openReady;
        yield* disk.awaitAsked(1);
        disk.change("changed while nobody watched");
        yield* disk.awaitAsked(2);
        // Nobody watched, so capture is paused; a tab reconnecting in the background attaches.
        const before = helperCommands().length;
        const attached = yield* service.attachViewer(threadId, {
          canOperate: false,
          visible: false,
        });
        assert.strictEqual(attached._tag, "attached");
        if (attached._tag !== "attached") return;
        const hidden = attached.viewer;
        expect(ofType(helperCommands().slice(before), "resume", "keyframe")).toEqual([]);
        expect(disk.asked()).toEqual([false, false]);
        // On screen it catches up; hidden again, nothing is left armed for it.
        yield* hidden.setVisible(true);
        yield* disk.awaitReloads(1);
        // Held by image edits while on screen, which the pane shows; hidden, the add-on is told
        // to hold nothing for a pane nobody can see.
        NodeFS.writeFileSync(NodePath.join(dir, "hold-reload"), "");
        disk.change("changed again");
        const held = yield* service.threadState(threadId).pipe(
          Stream.filter((state) => "reloadBlocked" in state),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(held).toMatchObject({ reloadBlocked: "images" });
        yield* hidden.setVisible(false);
        yield* fileAppears(dir, dir, () =>
          disk.notices().some((notice) => notice.type === "panesHidden"),
        );
        expect(disk.reloads()).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.live("S6: checks the file again after Save and quit is refused for a change on disk", () =>
    Effect.gen(function* () {
      const { dir, service, openReady } = yield* standIn("disk-refused", "reloads");
      const disk = diskOf(dir);
      yield* openReady;
      yield* disk.awaitAsked(1);
      const viewer = yield* attach(service, false);
      yield* viewer.setVisible(false);
      disk.change("changed by a checkout");
      yield* disk.awaitAsked(2);
      const refused = yield* service.quit({ threadId, save: true }).pipe(Effect.flip);
      expect(refused.reason).toBe("changedOnDisk");
      // Looked at again once the refusal clears, with no new disk event: a change the save's
      // attempt swallowed is still caught up with, and showing the pane reloads it.
      yield* disk.awaitAsked(3);
      yield* viewer.setVisible(true);
      yield* disk.awaitReloads(1);
    }).pipe(Effect.scoped),
  );

  /** Running, the pane on screen, after one reload that kept the unsaved work as the copy. */
  const reloadedWithCopy = (prefix: string) =>
    Effect.gen(function* () {
      const host = yield* standIn(prefix, "reloads");
      const disk = diskOf(host.dir);
      yield* host.openReady;
      yield* disk.awaitAsked(1);
      yield* attach(host.service, false);
      disk.change("changed once");
      yield* reloadKept(host.service.threadState(threadId));
      return host;
    });
  /** Triggers `trigger` in the stand-in and waits for the unsaved, then saved, report after it. */
  const saveInPane = (host: Effect.Success<ReturnType<typeof standIn>>, trigger = "ctrl-s") =>
    Effect.gen(function* () {
      const saved = yield* host.service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "running"),
        Stream.dropWhile((state) => !("dirty" in state && state.dirty)),
        Stream.filter((state) => "dirty" in state && !state.dirty),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      NodeFS.writeFileSync(NodePath.join(host.dir, trigger), "");
      yield* Fiber.join(saved);
    });

  it.live(
    "a save after a reload keeps the copy it displaced, and the pane's offer; a save after Restore changes retires it",
    () =>
      Effect.gen(function* () {
        const host = yield* reloadedWithCopy("disk-save-keeps");
        yield* saveInPane(host);
        expect(recoveryOf(host.hostedDir)?.contents).toBe("unsaved 1");
        expect(yield* firstState(host.service)).toMatchObject({ reloadKept: { key: CUBE } });
        // Restored, the copy's work is in the scene, so the next save holds it.
        yield* host.service.reopen({ threadId, key: CUBE, restore: true });
        yield* saveInPane(host);
        expect(recoveryOf(host.hostedDir)).toBeNull();
      }).pipe(Effect.scoped),
  );

  it.live(
    "S12: Save and quit after a reload leaves the copy waiting, offered by the next Blender on the file",
    () =>
      Effect.gen(function* () {
        const host = yield* reloadedWithCopy("disk-quit-keeps");
        yield* host.service.quit({ threadId, save: true });
        expect(yield* host.awaitStatus("closed")).toMatchObject({ recovery: true });
        // Opened as on disk past it, as the agent's blender_start does: offered while it runs.
        yield* host.service.reopen({ threadId, key: CUBE, restore: false });
        yield* host.awaitStatus("running");
        expect(yield* firstState(host.service)).toMatchObject({ reloadKept: { key: CUBE } });
      }).pipe(Effect.scoped),
  );

  it.live(
    "S2: a copy whose record couldn't be written stays staged, unoffered, for the run's end to keep",
    () =>
      Effect.gen(function* () {
        const { dir, service, openReady, hostedDir, awaitStatus } = yield* standIn(
          "disk-record-fails",
          "reloads",
        );
        const disk = diskOf(dir);
        yield* openReady;
        yield* disk.awaitAsked(1);
        // The record can't be written: a folder stands where it goes.
        const copyDir = NodePath.join(
          hostedDir,
          "recovery",
          Buffer.from(threadId).toString("base64url"),
          NodeCrypto.createHash("sha256").update(CUBE).digest("hex"),
        );
        NodeFS.mkdirSync(NodePath.join(copyDir, "record.json", "in-the-way"), { recursive: true });
        yield* attach(service, false);
        disk.change("changed once");
        yield* disk.awaitReloads(1);
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && !state.dirty),
          Stream.runHead,
        );
        expect(yield* firstState(service)).not.toHaveProperty("reloadKept");
        NodeFS.rmSync(NodePath.join(copyDir, "record.json"), { recursive: true });
        yield* service.closeOnSettle({ threadId });
        yield* awaitStatus("closed");
        expect(recoveryOf(hostedDir)).toMatchObject({
          record: { recovery: true, reloaded: true },
          contents: "unsaved 1",
        });
      }).pipe(Effect.scoped),
  );

  it.live(
    "S12: after a launch restore, a reload's displaced work outlives the next report and Ctrl+S",
    () =>
      Effect.gen(function* () {
        const host = yield* reloadedWithCopy("disk-launch-restore");
        const disk = diskOf(host.dir);
        yield* host.service.closeOnSettle({ threadId });
        yield* host.awaitStatus("closed");
        // Reopened with the copy restored, then the file changes under its unsaved work.
        yield* host.service.reopen({ threadId, key: CUBE, restore: true });
        yield* host.awaitStatus("running");
        yield* attach(host.service, false);
        const before = disk.reloads();
        disk.change("changed after the restore");
        yield* disk.awaitReloads(before + 1);
        // T3 has kept what it displaced, and Blender reported the file as loaded.
        yield* host.service.threadState(threadId).pipe(
          Stream.filter((state) => "reloadKept" in state && !state.dirty),
          Stream.runHead,
        );
        yield* saveInPane(host);
        expect(recoveryOf(host.hostedDir)?.contents).toBe(`unsaved ${before + 1}`);
        expect(yield* firstState(host.service)).toMatchObject({ reloadKept: { key: CUBE } });
      }).pipe(Effect.scoped),
  );

  it.live("S12: a revert saved at once, before any report of it, keeps the restored copy", () =>
    Effect.gen(function* () {
      const host = yield* reloadedWithCopy("disk-revert-save");
      yield* host.service.reopen({ threadId, key: CUBE, restore: true });
      yield* saveInPane(host, "revert-save");
      expect(recoveryOf(host.hostedDir)?.contents).toBe("unsaved 1");
    }).pipe(Effect.scoped),
  );

  it.live("S3: an agent's ask to look settles with a burst of writes, into one notice", () =>
    Effect.gen(function* () {
      const host = yield* standIn("disk-poke", "reloads");
      const disk = diskOf(host.dir);
      yield* host.openReady;
      yield* disk.awaitAsked(1);
      NodeFS.writeFileSync(NodePath.join(host.dir, "poke"), "");
      yield* fileAppears(host.dir, NodePath.join(host.dir, "poked"));
      disk.change("written");
      disk.change("written again, the burst's last");
      const info = NodeFS.statSync(NodePath.join(host.dir, "cube.blend"), { bigint: true });
      const settled = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      yield* fileAppears(host.dir, host.dir, () =>
        disk.notices().some((notice) => "revision" in notice && notice.revision === settled),
      );
      const after = disk.notices().slice(1);
      expect(after.map((notice) => ("revision" in notice ? notice.revision : null))).toEqual([
        settled,
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("S11: a restore whose caller stops waiting holds the Blender until it is done", () =>
    Effect.gen(function* () {
      const host = yield* reloadedWithCopy("disk-restore-gone");
      const restores = NodePath.join(host.dir, "saves.log.restores");
      const first = yield* host.service
        .reopen({ threadId, key: CUBE, restore: true })
        .pipe(Effect.forkScoped);
      yield* fileAppears(host.dir, restores);
      yield* Fiber.interrupt(first);
      const second = yield* host.service
        .reopen({ threadId, key: CUBE, restore: true })
        .pipe(Effect.flip);
      expect(second.reason).toBe("restoreFailed");
    }).pipe(Effect.scoped),
  );

  it.live(
    "S12: Save As retires neither the copy of the file it left nor that of its new name",
    () =>
      Effect.gen(function* () {
        const host = yield* standIn("disk-save-as", "reloads");
        const other = NodePath.join(host.dir, "other.blend");
        NodeFS.writeFileSync(other, "");
        // Each file left a copy of its unsaved work; the cube's is restored.
        for (const relativePath of ["other.blend", "cube.blend"]) {
          yield* host.service.open({ threadId, relativePath });
          yield* host.awaitDirty(true);
          yield* host.service.closeOnSettle({ threadId });
          yield* host.awaitStatus("closed");
        }
        yield* host.service.reopen({ threadId, key: CUBE, restore: true });
        yield* host.awaitDirty(true);
        NodeFS.writeFileSync(NodePath.join(host.dir, "save-as"), NodeFS.realpathSync(other));
        yield* host.service.threadState(threadId).pipe(
          Stream.filter(
            (state) =>
              "openFile" in state &&
              state.openFile?.kind === "workspace" &&
              state.openFile.relativePath === "other.blend" &&
              !state.dirty,
          ),
          Stream.runHead,
        );
        expect(recoveryOf(host.hostedDir, OTHER)?.record.recovery).toBe(true);
        expect(recoveryOf(host.hostedDir, CUBE)?.record.recovery).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.live("S12: a save right after a restore never takes the copy that restore displaced", () =>
    Effect.gen(function* () {
      const host = yield* reloadedWithCopy("disk-save-displaced");
      // Restored, then edited, so the next restore displaces that work.
      yield* host.service.reopen({ threadId, key: CUBE, restore: true });
      yield* host.awaitDirty(true);
      NodeFS.writeFileSync(NodePath.join(host.dir, "save-after-restore"), "");
      yield* host.service.reopen({ threadId, key: CUBE, restore: true, replaceUnsaved: true });
      yield* host.service.threadState(threadId).pipe(
        Stream.filter((state) => "reloadKept" in state),
        Stream.runHead,
      );
      expect(recoveryOf(host.hostedDir)?.contents).toBe("displaced by the restore");
    }).pipe(Effect.scoped),
  );

  it.live("S15: a run's end keeps staged work over an autosave older than it", () =>
    Effect.gen(function* () {
      const host = yield* standIn("disk-end-autosave", "reloads");
      yield* host.openReady;
      NodeFS.writeFileSync(NodePath.join(host.dir, "stage-quietly"), "");
      yield* fileAppears(host.dir, NodePath.join(host.dir, "staged-quietly"));
      yield* host.service.closeOnSettle({ threadId });
      yield* host.awaitStatus("closed");
      expect(recoveryOf(host.hostedDir)?.contents).toBe("staged work");
    }).pipe(Effect.scoped),
  );

  it.live(
    "S16: an older staged copy left by a failed record write never replaces a later reload's",
    () =>
      Effect.gen(function* () {
        const { dir, service, openReady, hostedDir, awaitStatus } = yield* standIn(
          "disk-older-staged",
          "reloads",
        );
        const disk = diskOf(dir);
        yield* openReady;
        yield* disk.awaitAsked(1);
        // The first reload's record can't be written, so its work stays staged for later.
        const copyDir = NodePath.join(
          hostedDir,
          "recovery",
          Buffer.from(threadId).toString("base64url"),
          NodeCrypto.createHash("sha256").update(CUBE).digest("hex"),
        );
        NodeFS.mkdirSync(NodePath.join(copyDir, "record.json", "in-the-way"), { recursive: true });
        yield* attach(service, false);
        disk.change("changed once");
        yield* disk.awaitReloads(1);
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && !state.dirty),
          Stream.runHead,
        );
        NodeFS.rmSync(NodePath.join(copyDir, "record.json"), { recursive: true });
        // Edited again, and a second reload keeps that newer work.
        NodeFS.writeFileSync(NodePath.join(dir, "edit"), "");
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
        );
        disk.change("changed twice");
        yield* reloadKept(service.threadState(threadId));
        yield* service.closeOnSettle({ threadId });
        yield* awaitStatus("closed");
        expect(recoveryOf(hostedDir)?.contents).toBe("unsaved 2");
      }).pipe(Effect.scoped),
  );

  it.live("S11: refuses a second restore while one is under way on the same Blender", () =>
    Effect.gen(function* () {
      const host = yield* reloadedWithCopy("disk-two-restores");
      const restore = host.service.reopen({ threadId, key: CUBE, restore: true }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
        Effect.orElseSucceed(() => "ok"),
      );
      const outcomes = yield* Effect.all([restore, restore], { concurrency: "unbounded" });
      expect(outcomes.toSorted()).toEqual(["ok", "restoreFailed"]);
    }).pipe(Effect.scoped),
  );

  it.live("keeps the agent's grant, the MCP proxy's gate, through a reload of the same file", () =>
    Effect.gen(function* () {
      const host = yield* standIn("disk-grant", "reloads", undefined, { agentPort: 41237 });
      const disk = diskOf(host.dir);
      yield* host.service.open(
        { threadId, relativePath: "cube.blend" },
        { agentWorkingCopy: true },
      );
      expect((yield* host.service.agentListener(threadId))?.state).toBe("ready");
      const gate = host.service.agentGrant({ threadId, role: "working", session: "session-1" });
      const before = yield* gate;
      expect(before).toMatchObject({ _tag: "granted", port: 41237 });
      yield* disk.awaitAsked(1);
      yield* attach(host.service, false);
      disk.change("changed by a headless script");
      yield* disk.awaitReloads(1);
      yield* reloadKept(host.service.threadState(threadId));
      expect(yield* gate).toEqual(before);
    }).pipe(Effect.scoped),
  );

  it.live("S10: keeps staged work under the file it names, not the file T3 last heard of", () =>
    Effect.gen(function* () {
      const { dir, service, openReady, hostedDir } = yield* standIn("disk-switched", "reloads");
      const disk = diskOf(dir);
      yield* openReady;
      yield* disk.awaitAsked(1);
      yield* attach(service, false);
      const other = NodePath.join(NodeFS.realpathSync(dir), "other.blend");
      NodeFS.writeFileSync(NodePath.join(dir, "staged-for"), other);
      disk.change("changed once");
      yield* disk.awaitReloads(1);
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && !state.dirty),
        Stream.runHead,
      );
      expect(recoveryOf(hostedDir, OTHER)?.contents).toBe("unsaved 1");
      expect(recoveryOf(hostedDir, CUBE)).toBeNull();
    }).pipe(Effect.scoped),
  );
});

describe("The stream", () => {
  it.live("stops capturing while no pane is on screen and resumes on a keyframe", () =>
    Effect.gen(function* () {
      const { service, openReady, helperCommands } = yield* standIn("visible", "");
      yield* openReady;
      const first = yield* attach(service, false);
      expect(isKey(yield* nextFrame(first))).toBe(true);
      yield* first.ack;
      yield* first.setVisible(false);
      // A second pane on screen resumes capture and joins on a keyframe; the hidden one gets
      // nothing.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const second = yield* attach(service, false);
          expect(isKey(yield* nextFrame(second))).toBe(true);
          expect(yield* hasFrame(first)).toBe(false);
        }),
      );
      // Showing the first pane again resumes capture, starting on a keyframe.
      yield* first.setVisible(true);
      expect(isKey(yield* nextFrame(first))).toBe(true);
      // Nobody watched while Blender started, so it started paused.
      expect(ofType(helperCommands(), "pause", "resume", "keyframe")).toEqual([
        { type: "pause" },
        { type: "resume" },
        { type: "keyframe" },
        { type: "pause" },
        { type: "resume" },
        { type: "keyframe" },
        { type: "pause" },
        { type: "resume" },
        { type: "keyframe" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("sizes the display to the latest pane on screen; a pane without a size keeps it", () =>
    Effect.gen(function* () {
      const { service, openReady, helperCommands } = yield* standIn("latest", "");
      yield* openReady;
      const older = yield* attach(service, false);
      yield* older.resize(800, 600);
      yield* nextMessage(older, "viewport");
      const newer = yield* attach(service, false);
      yield* newer.resize(1600, 900);
      yield* nextMessage(older, "viewport");
      // A floating player sends no size, so opening one leaves the display alone...
      yield* attach(service, false);
      // ...hiding the newest pane hands the size back to the older one, and showing it again
      // takes it back.
      yield* newer.setVisible(false);
      yield* nextMessage(older, "viewport");
      yield* newer.setVisible(true);
      expect(yield* nextMessage(older, "viewport")).toEqual({
        type: "viewport",
        width: 1600,
        height: 900,
      });
      expect(ofType(helperCommands(), "resize")).toEqual([
        { type: "resize", width: 800, height: 600 },
        { type: "resize", width: 1600, height: 900 },
        { type: "resize", width: 800, height: 600 },
        { type: "resize", width: 1600, height: 900 },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("resyncs a viewer that falls behind on a keyframe, without cutting the bitrate", () =>
    Effect.gen(function* () {
      const { service, openReady, helperCommands } = yield* standIn("bitrate", "");
      yield* openReady;
      const operator = yield* attach(service, true);
      yield* operator.input({ type: "takeControl", takeOver: false });
      const cursor = (captured: boolean): Effect.Effect<unknown> =>
        nextMessage(operator, "cursor").pipe(
          Effect.flatMap((message) =>
            message.captured === captured ? Effect.void : cursor(captured),
          ),
        );
      // F1 sends more deltas than a viewer that hasn't acked may have waiting, then Blender
      // "captures" the cursor; releasing F1 lets it go.
      yield* operator.input({ type: "key", code: 59, pressed: true });
      yield* cursor(true);
      yield* operator.input({ type: "key", code: 59, pressed: false });
      yield* cursor(false);
      // Falling behind is a slow viewer, not a congested link: it skips to a keyframe, and only
      // ack delay moves the bitrate.
      expect(ofType(helperCommands(), "bitrate")).toEqual([]);
      // Acking a frame it was stuck on lets the keyframe out, behind those already sent.
      yield* operator.ack;
      expect(isKey(yield* nextKeyframe(operator))).toBe(true);
    }).pipe(Effect.scoped),
  );
});

it.effect(
  "a stalled viewer's keyframe waits out the throttle, and comes even if Blender is idle",
  () =>
    Effect.gen(function* () {
      const { service, awaitStatus, helperCommands } = yield* standIn("deferred", "");
      yield* service.open({ threadId, relativePath: "cube.blend" });
      yield* awaitStatus("running");
      const operator = yield* attach(service, true);
      yield* operator.input({ type: "takeControl", takeOver: false });
      const cursor = (captured: boolean): Effect.Effect<unknown> =>
        nextMessage(operator, "cursor").pipe(
          Effect.flatMap((message) =>
            message.captured === captured ? Effect.void : cursor(captured),
          ),
        );
      // F1 overflows the operator's queue while its first frames are unacked; nothing more comes.
      yield* operator.input({ type: "key", code: 59, pressed: true });
      yield* cursor(true);
      yield* operator.input({ type: "key", code: 59, pressed: false });
      yield* cursor(false);
      // Its ack asks for a keyframe, but one went out at join this same instant.
      yield* operator.ack;
      yield* syncPoint(operator);
      expect(ofType(helperCommands(), "keyframe")).toHaveLength(1);
      yield* TestClock.adjust("250 millis");
      expect(isKey(yield* nextKeyframe(operator))).toBe(true);
      expect(ofType(helperCommands(), "keyframe")).toHaveLength(2);
    }).pipe(Effect.scoped),
);

it.effect("gives up on a start that never shows Blender by asking the helper to quit", () =>
  Effect.gen(function* () {
    const { service, awaitStatus, marker, runtime } = yield* standIn("timeout", "never-shows");
    yield* service.open({ threadId, relativePath: "cube.blend" });
    const attached = yield* service.attachViewer(threadId, { canOperate: false });
    assert.strictEqual(attached._tag, "attached");
    if (attached._tag !== "attached") return;
    // Stats arrive once the helper reports ready, after the start timer is set.
    yield* Queue.take(attached.viewer.output).pipe(
      Effect.repeat({
        until: (output) => output._tag === "message" && output.message.type === "stats",
      }),
    );
    yield* TestClock.adjust("91 seconds");
    yield* awaitStatus("failed");
    expect(NodeFS.readFileSync(marker, "utf8")).toBe("quit");
    expect(NodeFS.readdirSync(runtime)).toEqual([]);
  }).pipe(Effect.scoped),
);

describe("HostedBlender availability", () => {
  it.effect("passes on why setup can't host Blender, and refuses to open files", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("unavailable");
      NodeFS.writeFileSync(NodePath.join(dir, "a.blend"), "");
      for (const readiness of [
        { status: "unavailable", reason: "platform" },
        { status: "notSetUp", missing: ["enabled"] },
        { status: "notSetUp", missing: ["labwc", "encoder"] },
      ] as const) {
        const service = yield* serviceFor(
          layerFor({ readiness, env: {}, workspaceRoot: dir, baseDir: dir }),
        );
        assert.deepStrictEqual(yield* firstState(service), readiness);
        const opened = yield* service.open({ threadId, relativePath: "a.blend" }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );
        expect(opened).toBe(readiness.status);
      }
    }).pipe(Effect.scoped),
  );
});

describe("HostedBlender.open", () => {
  it.effect("opens only .blend files that really are inside the thread's workspace", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("paths");
      const bin = fakeTools(dir);
      const workspace = NodePath.join(dir, "work");
      NodeFS.mkdirSync(NodePath.join(workspace, "models"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, "outside.blend"), "");
      NodeFS.writeFileSync(NodePath.join(workspace, "notes.txt"), "");
      NodeFS.symlinkSync(
        NodePath.join(dir, "outside.blend"),
        NodePath.join(workspace, "models", "link.blend"),
      );
      const service = yield* serviceFor(
        layerFor({
          env: { PATH: bin },
          helper: NodePath.join(bin, "helper"),
          workspaceRoot: workspace,
          baseDir: dir,
        }),
      );
      const reason = (relativePath: string, thread = threadId) =>
        service.open({ threadId: thread, relativePath }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );
      expect(yield* reason("notes.txt")).toBe("notBlendFile");
      expect(yield* reason("../outside.blend")).toBe("notInWorkspace");
      expect(yield* reason("models/link.blend")).toBe("notInWorkspace");
      expect(yield* reason("models/missing.blend")).toBe("fileNotFound");
      expect(yield* reason("a.blend", ThreadId.make("other-thread"))).toBe("threadNotFound");
      assert.deepStrictEqual(yield* firstState(service), { status: "stopped" });
      // A name that merely starts with dots is still inside the workspace.
      NodeFS.writeFileSync(NodePath.join(workspace, "..draft.blend"), "");
      yield* service.open({ threadId, relativePath: "..draft.blend" });
    }).pipe(Effect.scoped),
  );

  it.live("reports a start that never shows Blender, until dismissed or opened again", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("failed");
      const bin = fakeTools(dir);
      NodeFS.writeFileSync(NodePath.join(dir, "cube.blend"), "");
      const service = yield* serviceFor(
        layerFor({
          env: { PATH: bin },
          helper: NodePath.join(bin, "helper"),
          workspaceRoot: dir,
          baseDir: dir,
        }),
      );
      const states = yield* Queue.unbounded<HostedBlenderThreadState>();
      yield* service.threadState(threadId).pipe(
        Stream.runForEach((state) => Queue.offer(states, state)),
        Effect.forkScoped,
      );
      const awaitStatus = (status: HostedBlenderThreadState["status"]) =>
        Queue.take(states).pipe(Effect.repeat({ until: (state) => state.status === status }));
      yield* awaitStatus("stopped");
      // The stand-in helper exits at once, as one does when Blender can't open the file.
      yield* service.open({ threadId, relativePath: "cube.blend" });
      yield* awaitStatus("starting");
      yield* awaitStatus("failed");
      yield* service.dismiss({ threadId });
      yield* awaitStatus("stopped");
    }).pipe(Effect.scoped),
  );

  it.live("counts a file as open where Blender has it open now, as well as where it started", () =>
    Effect.gen(function* () {
      const { dir, service, awaitDirty } = yield* standIn("switched-open", "switches");
      NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
      yield* service.open({ threadId, relativePath: "cube.blend" });
      yield* awaitDirty(true);
      const elsewhere = yield* service
        .open({ threadId: otherThreadId, relativePath: "other.blend" })
        .pipe(Effect.flip);
      expect(elsewhere.reason).toBe("openInAnotherThread");
    }).pipe(Effect.scoped),
  );

  it.live("keeps a file in one hosted Blender and never force-quits one asked to save", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("lifecycle");
      const bin = fakeTools(dir, WAITING_HELPER);
      const workspace = NodePath.join(dir, "work");
      const runtime = NodePath.join(dir, "run");
      NodeFS.mkdirSync(workspace, { recursive: true });
      NodeFS.mkdirSync(runtime);
      NodeFS.writeFileSync(NodePath.join(workspace, "cube.blend"), "");
      const service = yield* serviceFor(
        layerFor({
          env: {
            PATH: bin,
            XDG_RUNTIME_DIR: runtime,
          },
          helper: NodePath.join(bin, "helper"),
          workspaceRoot: workspace,
          baseDir: dir,
        }),
      );
      const states = yield* Queue.unbounded<HostedBlenderThreadState>();
      yield* service.threadState(threadId).pipe(
        Stream.runForEach((state) => Queue.offer(states, state)),
        Effect.forkScoped,
      );
      const awaitStatus = (status: HostedBlenderThreadState["status"]) =>
        Queue.take(states).pipe(Effect.repeat({ until: (state) => state.status === status }));
      yield* awaitStatus("stopped");
      yield* service.open({ threadId, relativePath: "cube.blend" });
      yield* awaitStatus("starting");

      const elsewhere = yield* service
        .open({ threadId: otherThreadId, relativePath: "cube.blend" })
        .pipe(Effect.flip);
      expect(elsewhere.reason).toBe("openInAnotherThread");

      // Blender can't be asked to save yet, so it keeps running instead of losing changes.
      const unsaved = yield* service.quit({ threadId, save: true }).pipe(Effect.flip);
      expect(unsaved.reason).toBe("saveFailed");
      yield* service.quit({ threadId, save: false });
      yield* awaitStatus("stopped");

      // Each launch's runtime, temporary and control folders go with it.
      const launches = NodePath.join(dir, "userdata", "hosted-blender", "launches");
      expect(NodeFS.readdirSync(runtime)).toEqual([]);
      expect(NodeFS.existsSync(launches) ? NodeFS.readdirSync(launches) : []).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

/** The stand-in add-on's 1x1 screenshot. */
const STANDIN_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** Decodes the add-on's screenshots: 8-bit RGB PNG, every row unfiltered. */
const decodePng = (dataUrl: string) => {
  const bytes = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect([bytes[24], bytes[25]]).toEqual([8, 2]);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT")
      chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = NodeZlib.inflateSync(Buffer.concat(chunks));
  const stride = width * 3 + 1;
  return {
    width,
    height,
    pixel: (x: number, y: number) => {
      const row = Math.round(y) * stride;
      expect(raw[row]).toBe(0);
      const start = row + 1 + Math.round(x) * 3;
      return [...raw.subarray(start, start + 3)];
    },
  };
};

/** Where a scene point lands in a screenshot, through a row-major perspective matrix. */
const projectToPixel = (
  matrix: ReadonlyArray<number>,
  [x, y, z]: readonly [number, number, number],
  size: { readonly width: number; readonly height: number },
) => {
  const row = (index: number) =>
    matrix[index * 4]! * x +
    matrix[index * 4 + 1]! * y +
    matrix[index * 4 + 2]! * z +
    matrix[index * 4 + 3]!;
  const w = row(3);
  return {
    x: ((row(0) / w + 1) / 2) * size.width,
    y: ((1 - row(1) / w) / 2) * size.height,
  };
};

// The file's 3D views look through a camera of their own, which isn't the scene's camera.
const LOCAL_CAMERA_SETUP = String.raw`import bpy
camera = bpy.data.objects.new("PersonCamera", bpy.data.cameras.new("PersonCamera"))
bpy.context.scene.collection.objects.link(camera)
camera.location = (3, -4, 2)
camera.rotation_euler = (1.2, 0, 0.64)
for screen in bpy.data.screens:
    for area in screen.areas:
        for space in area.spaces:
            if space.type == "VIEW_3D":
                space.use_local_camera = True
                space.camera = camera
                space.region_3d.view_perspective = "CAMERA"`;

// A real hosted Blender: only on a Linux host with Blender, labwc and a built helper.
const FAKE_MCP_MANIFEST = `schema_version = "1.0.0"
id = "mcp"
version = "0.0.1"
name = "Fake MCP"
tagline = "Stand-in for the Blender Lab MCP add-on"
maintainer = "T3 tests"
type = "add-on"
blender_version_min = "4.2.0"
license = ["SPDX:GPL-3.0-or-later"]
`;
const FAKE_MCP_ADDON = `import os
import bpy

def _start():
    port = bpy.context.preferences.addons[__package__].preferences.port
    with open(os.path.join(os.path.dirname(__file__), "started"), "w") as marker:
        marker.write(str(port))

class Preferences(bpy.types.AddonPreferences):
    bl_idname = __package__
    port: bpy.props.IntProperty(default=39999)
    use_autostart: bpy.props.BoolProperty(default=True)

def register():
    bpy.utils.register_class(Preferences)
    preferences = bpy.context.preferences.addons[__package__].preferences
    if not bpy.app.background and preferences.use_autostart:
        bpy.app.timers.register(_start, first_interval=0.0, persistent=True)

def unregister():
    if bpy.app.timers.is_registered(_start):
        bpy.app.timers.unregister(_start)
    bpy.utils.unregister_class(Preferences)
`;
const helperBuild = NodePath.resolve(
  import.meta.dirname,
  "../../../../native/hidden-display/target/release/t3-hidden-display",
);
const hostEnvironment = HostProcess.Environment.defaultValue();
const onPath = (command: string) =>
  NodeChildProcess.spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
const canHostBlender =
  HostProcess.Platform.defaultValue() === "linux" &&
  NodeFS.existsSync(helperBuild) &&
  onPath("blender") &&
  onPath("labwc");

describe.skipIf(!canHostBlender)("a real hosted Blender", () => {
  /** A hosted Blender on a file made by `setup`, a Python script run in background Blender. */
  const realBlender = Effect.fn(function* (prefix: string, setup: string) {
    const dir = yield* tempDir(prefix);
    const blendPath = NodePath.join(dir, "scene.blend");
    NodeChildProcess.execFileSync("blender", [
      "--background",
      "--factory-startup",
      "--python-expr",
      `import bpy\n${setup}\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blendPath)})`,
    ]);
    const configHome = NodePath.join(dir, "config");
    NodeFS.mkdirSync(configHome);
    const service = yield* serviceFor(
      layerFor({
        env: {
          PATH: hostEnvironment.PATH,
          XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
          XDG_CONFIG_HOME: configHome,
        },
        helper: helperBuild,
        workspaceRoot: dir,
        baseDir: dir,
      }),
    );
    yield* service.open({ threadId, relativePath: "scene.blend" });
    yield* service.threadState(threadId).pipe(
      Stream.filter((state) => state.status === "running"),
      Stream.runHead,
    );
    return service;
  });

  /** The first capture once the add-on's connection and viewport window are up. */
  const firstCapture = (service: HostedBlender.HostedBlender["Service"]) =>
    service.captureView(threadId).pipe(
      Effect.retry({
        while: (error) => error.reason === "noReply" || error.reason === "noViewport",
        schedule: Schedule.spaced("500 millis"),
        times: 40,
      }),
    );

  it("won't draw Cycles' rendered shading offscreen, which would come out blank", () => {
    // Rendered shading doesn't survive a file saved without a display, so the add-on's own
    // check runs in a background Blender against a 3D view set up in place.
    const output = NodeChildProcess.execFileSync(
      "blender",
      [
        "--background",
        "--factory-startup",
        "--python-expr",
        `${CONTROL_ADDON_SOURCE}
space = next(space for area in bpy.data.screens["Layout"].areas for space in area.spaces if space.type == "VIEW_3D")
scene = bpy.context.scene
results = []
for engine, shading in [("CYCLES", "RENDERED"), ("CYCLES", "SOLID"), ("BLENDER_EEVEE", "RENDERED"), ("BLENDER_WORKBENCH", "RENDERED")]:
    scene.render.engine = engine
    space.shading.type = shading
    results.append([engine, shading, _renders_offscreen(space, scene)])
print("T3-RESULT", json.dumps(results))`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const line = output.split("\n").find((entry) => entry.startsWith("T3-RESULT "));
    expect(JSON.parse(line!.slice("T3-RESULT ".length))).toEqual([
      ["CYCLES", "RENDERED", false],
      ["CYCLES", "SOLID", true],
      ["BLENDER_EEVEE", "RENDERED", true],
      ["BLENDER_WORKBENCH", "RENDERED", true],
    ]);
  });

  it("Save and quit saves the images it can, holds on one it can't and names it, then saves all once it is packed", () => {
    // Background Blenders of the test's own, settings and temporary files in its folder.
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hosted-blender-images-"));
    const blender = (script: string) =>
      NodeChildProcess.execFileSync(
        "blender",
        ["--background", "--factory-startup", "--python-expr", script],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          env: {
            PATH: hostEnvironment.PATH,
            HOME: dir,
            TMPDIR: NodePath.join(dir, "tmp"),
            BLENDER_USER_RESOURCES: dir,
          },
        },
      );
    const result = (output: string) => {
      const line = output.split("\n").find((entry) => entry.startsWith("T3-RESULT "));
      return JSON.parse(line!.slice("T3-RESULT ".length));
    };
    const readOnly = NodePath.join(dir, "read-only");
    try {
      NodeFS.mkdirSync(NodePath.join(dir, "tmp"));
      NodeFS.mkdirSync(readOnly);
      const blend = JSON.stringify(NodePath.join(dir, "scene.blend"));
      const fileImage = (name: string, folder: string) => `
${name} = bpy.data.images.new("${name}", 4, 4)
${name}.filepath_raw = ${JSON.stringify(NodePath.join(folder, `${name}.png`))}
${name}.file_format = "PNG"
${name}.save()
${name}.source = "FILE"
${name}.reload()`;
      const first = blender(`${CONTROL_ADDON_SOURCE}
assert bpy.app.tempdir.startswith(${JSON.stringify(dir)}), bpy.app.tempdir
bpy.ops.wm.save_as_mainfile(filepath=${blend})
${fileImage("paint", dir)}
${fileImage("locked", readOnly)}
os.chmod(${JSON.stringify(NodePath.join(readOnly, "locked.png"))}, 0o444)
os.chmod(${JSON.stringify(readOnly)}, 0o555)
generated = bpy.data.images.new("generated", 4, 4)
for image in (paint, locked, generated):
    # In use, as a material's would be, so the save keeps it.
    image.use_fake_user = True
    image.pixels[0] = 0.25
sent = []
_send = sent.append
# A background Blender has no window to save from, and quits only once its script ends.
_save = lambda: "FINISHED" in bpy.ops.wm.save_mainfile()
_handle({"type": "quit", "save": True, "hold": True})
first = list(sent)
dirty = [image.name for image in bpy.data.images if image.is_dirty]
locked.pack()
sent.clear()
_handle({"type": "quit", "save": True, "hold": True})
print("T3-RESULT", json.dumps({
    "first": [message["type"] for message in first],
    "held": [message.get("images") for message in first if message["type"] == "quitFailed"],
    "dirty": dirty,
    "second": [message["type"] for message in sent],
}))`);
      expect(result(first)).toEqual({
        first: ["saving", "quitFailed"],
        held: [["locked"]],
        dirty: ["locked"],
        second: ["saving", "saved"],
      });
      const reopened = blender(`import bpy, json
bpy.ops.wm.open_mainfile(filepath=${blend})
images = bpy.data.images
paint = images.load(${JSON.stringify(NodePath.join(dir, "paint.png"))}, check_existing=False)
print("T3-RESULT", json.dumps({
    "packed": [images["generated"].packed_file is not None, images["locked"].packed_file is not None],
    "pixels": [round(image.pixels[0], 2) for image in (paint, images["generated"], images["locked"])],
}))`);
      expect(result(reopened)).toEqual({ packed: [true, true], pixels: [0.25, 0.25, 0.25] });
    } finally {
      NodeFS.chmodSync(readOnly, 0o755);
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds a quit that asks while an image is edited, and names the scene anew once it changes or hides", () => {
    // A background Blender of the test's own, settings and temporary files in its folder.
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hosted-blender-hold-"));
    try {
      NodeFS.mkdirSync(NodePath.join(dir, "tmp"));
      const output = NodeChildProcess.execFileSync(
        "blender",
        [
          "--background",
          "--factory-startup",
          "--python-expr",
          `${CONTROL_ADDON_SOURCE}
assert bpy.app.tempdir.startswith(${JSON.stringify(dir)}), bpy.app.tempdir
sent = []
_send = sent.append
image = bpy.data.images.new("paint", 4, 4)
image.pixels[0] = 0.5
dirty = image.is_dirty
_handle({"type": "quit", "save": False, "hold": True})
scene = bpy.context.scene
# Background Blender has no window: one showing the scene and its view layer stands in.
window = type("Window", (), {"scene": scene, "view_layer": scene.view_layers[0]})()
# The image made above is still to be evaluated.
scene.view_layers[0].update()
names = [_scene_identity(window)]
scene.view_layers[0].update()
names.append(_scene_identity(window))
bpy.data.objects["Cube"].location.x += 1
scene.view_layers[0].update()
names.append(_scene_identity(window))
scene.frame_set(scene.frame_current + 1)
names.append(_scene_identity(window))
bpy.data.objects["Camera"].select_set(True)
scene.view_layers[0].update()
selected = _scene_identity(window)
bpy.data.objects["Cube"].hide_set(True)
scene.view_layers[0].update()
print("T3-RESULT", json.dumps({
    "dirty": dirty,
    "sent": sent,
    "names": [names[0] == names[1], len(set(names[1:]))],
    "selection": selected == names[-1],
    "hide": _scene_identity(window) == selected,
}))`,
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          env: {
            PATH: hostEnvironment.PATH,
            HOME: dir,
            TMPDIR: NodePath.join(dir, "tmp"),
            BLENDER_USER_RESOURCES: dir,
          },
        },
      );
      // Had either quit gone ahead, Blender would have exited before printing.
      const line = output.split("\n").find((entry) => entry.startsWith("T3-RESULT "));
      expect(JSON.parse(line!.slice("T3-RESULT ".length))).toEqual({
        dirty: true,
        sent: [{ type: "quitFailed", reason: "images" }],
        // An update with nothing changed names the same scene; an edit or another frame doesn't,
        // nor does a hide. A selection names the same scene.
        names: [true, 3],
        selection: true,
        hide: false,
      });
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["Blender's own autosave", []],
    ["the copy writer Blenders before 5.2 use", ["--", "--t3-copy-writer"]],
  ])(
    "S4: stages unsaved work with %s, which restores saving to the file, its relative paths kept",
    (_writer, extra) => {
      // A background Blender of the test's own, settings and temporary files in its folder.
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hosted-blender-stage-"));
      try {
        NodeFS.mkdirSync(NodePath.join(dir, "tmp"));
        const source = NodePath.join(dir, "hero.blend");
        const output = NodeChildProcess.execFileSync(
          "blender",
          [
            "--background",
            "--factory-startup",
            "--python-expr",
            `${CONTROL_ADDON_SOURCE}
assert bpy.app.tempdir.startswith(${JSON.stringify(dir)}), bpy.app.tempdir
source = ${JSON.stringify(source)}
bpy.ops.wm.save_as_mainfile(filepath=source)
image = bpy.data.images.new("tex", 4, 4)
image.source = "FILE"
image.filepath = "//textures/tex.png"
image.use_fake_user = True
bpy.data.objects["Cube"].location.x = 7.0
bpy.ops.ed.undo_push(message="edit")
name = _stage_unsaved()
base = os.path.dirname(os.path.normpath(bpy.app.tempdir))
note = json.load(open(os.path.join(base, name[:-len(".blend")] + ".json")))
bpy.ops.wm.open_mainfile(filepath=source)
before = bpy.data.objects["Cube"].location.x
bpy.ops.wm.recover_auto_save(filepath=os.path.join(base, name), use_scripts=False)
print("T3-RESULT", json.dumps({
    "note": note["filepath"] == source,
    "before": before,
    "after": bpy.data.objects["Cube"].location.x,
    "savesTo": bpy.data.filepath == source,
    "image": bpy.data.images["tex"].filepath,
}))`,
            ...extra,
          ],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            env: {
              PATH: hostEnvironment.PATH,
              HOME: dir,
              TMPDIR: NodePath.join(dir, "tmp"),
              BLENDER_USER_RESOURCES: dir,
            },
          },
        );
        const line = output.split("\n").find((entry) => entry.startsWith("T3-RESULT "));
        expect(JSON.parse(line!.slice("T3-RESULT ".length))).toEqual({
          note: true,
          before: 0,
          after: 7,
          savesTo: true,
          image: "//textures/tex.png",
        });
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.live("renders a large viewport scaled down, keeping its shape", () =>
    Effect.gen(function* () {
      const service = yield* realBlender("large", "pass");
      const viewer = yield* attach(service, false);
      yield* viewer.resize(3840, 2160);
      yield* nextMessage(viewer, "viewport").pipe(
        Effect.repeat({ until: (message) => message.width >= 3000 }),
      );
      // Frames at the new size mean Blender's window, and its 3D view, have grown.
      const capture = yield* firstCapture(service);
      const { width, height } = capture.screenshot;
      expect(width * height).toBeLessThanOrEqual(1920 * 1088);
      expect(width * height).toBeGreaterThan(1_800_000);
      expect(width / height).toBeGreaterThan(1.6);
      expect(width / height).toBeLessThan(2.2);
      yield* service.quit({ threadId, save: false });
    }).pipe(Effect.scoped),
  );

  it.live("starts with its own environment, streams its viewport window, and quits", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("real");
      const workspace = NodePath.join(dir, "work");
      NodeFS.mkdirSync(NodePath.join(workspace, "models"), { recursive: true });
      const blendPath = NodePath.join(workspace, "models", "cube.blend");
      NodeChildProcess.execFileSync("blender", [
        "--background",
        "--factory-startup",
        "--python-expr",
        `${LOCAL_CAMERA_SETUP}\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blendPath)})`,
      ]);
      // Settings of its own to copy, so the developer's Blender config is never read. The link
      // back out stands for one into desktop settings, which the copy must not keep.
      const configHome = NodePath.join(dir, "config");
      const settings = NodePath.join(configHome, "blender", "5.3");
      NodeFS.mkdirSync(NodePath.join(settings, "config", "nested"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(settings, "config", "nested", "note.txt"), "kept");
      NodeFS.mkdirSync(NodePath.join(dir, "desktop-scripts"));
      NodeFS.symlinkSync(NodePath.join(dir, "desktop-scripts"), NodePath.join(settings, "scripts"));
      // An enabled stand-in for Blender Lab's MCP add-on: like it, it starts its listener from a
      // persistent timer it registers when enabled, without reading `use_autostart` again.
      const fakeMcp = NodePath.join(settings, "extensions", "user_default", "mcp");
      NodeFS.mkdirSync(fakeMcp, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(fakeMcp, "blender_manifest.toml"), FAKE_MCP_MANIFEST);
      NodeFS.writeFileSync(NodePath.join(fakeMcp, "__init__.py"), FAKE_MCP_ADDON);
      NodeChildProcess.execFileSync(
        "blender",
        [
          "--background",
          "--python-expr",
          "import addon_utils, bpy; addon_utils.enable('bl_ext.user_default.mcp', default_set=True); bpy.ops.wm.save_userpref()",
        ],
        {
          env: {
            ...Object.fromEntries(
              Object.entries(hostEnvironment).filter(([key]) => !key.startsWith("BLENDER_USER_")),
            ),
            BLENDER_USER_RESOURCES: settings,
            TMPDIR: dir,
          },
          stdio: "ignore",
        },
      );
      const service = yield* serviceFor(
        layerFor({
          env: {
            PATH: hostEnvironment.PATH,
            XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
            XDG_CONFIG_HOME: configHome,
            T3CODE_THREAD_ID: "leaked-thread-id",
          },
          helper: helperBuild,
          workspaceRoot: workspace,
          baseDir: dir,
        }),
      );
      const states = yield* Queue.unbounded<HostedBlenderThreadState>();
      yield* service.threadState(threadId).pipe(
        Stream.runForEach((state) => Queue.offer(states, state)),
        Effect.forkScoped,
      );
      const awaitStatus = (status: HostedBlenderThreadState["status"]) =>
        Queue.take(states).pipe(Effect.repeat({ until: (state) => state.status === status }));

      yield* awaitStatus("stopped");
      yield* service.open({ threadId, relativePath: "models/cube.blend" });
      const running = yield* awaitStatus("running");
      const userResources = NodePath.join(dir, "userdata", "hosted-blender", "user-resources");
      expect(
        NodeFS.readFileSync(NodePath.join(userResources, "config", "nested", "note.txt"), "utf8"),
      ).toBe("kept");
      // The link to desktop scripts isn't followed; T3's own startup gate is all that's there.
      expect(NodeFS.readdirSync(NodePath.join(userResources, "scripts"))).toEqual(["startup"]);
      expect(NodeFS.readdirSync(NodePath.join(dir, "desktop-scripts"))).toEqual([]);
      // The viewport window opens after the stand-in's timer would have fired.
      expect(
        NodeFS.existsSync(
          NodePath.join(userResources, "extensions", "user_default", "mcp", "started"),
        ),
      ).toBe(false);
      assert.deepStrictEqual(running, {
        status: "running",
        relativePath: "models/cube.blend",
        dirty: false,
        openFile: { kind: "workspace", relativePath: "models/cube.blend" },
      });
      // Opening the same file again is a no-op; another file waits for this one to quit.
      yield* service.open({ threadId, relativePath: "models/cube.blend" });
      NodeFS.copyFileSync(blendPath, NodePath.join(workspace, "models", "other.blend"));
      const otherFile = yield* service
        .open({ threadId, relativePath: "models/other.blend" })
        .pipe(Effect.flip);
      expect(otherFile.reason).toBe("otherFileOpen");

      const attached = yield* service.attachViewer(threadId, { canOperate: false });
      assert.strictEqual(attached._tag, "attached");
      if (attached._tag !== "attached") return;
      const viewer = attached.viewer;
      const firstFrame = yield* Queue.take(viewer.output).pipe(
        Effect.repeat({ until: (output) => output._tag === "frame" }),
      );
      assert.strictEqual(firstFrame._tag, "frame");
      if (firstFrame._tag !== "frame") return;
      // SEMU magic, then the key flag: every viewer starts on a keyframe.
      expect(new DataView(firstFrame.data.buffer, firstFrame.data.byteOffset).getUint32(0)).toBe(
        0x53454d55,
      );
      expect(firstFrame.data[5]! & 1).toBe(1);

      // The viewport looks through its own local camera, not the scene's (until the orbit below
      // leaves camera view), and Blender renders the screenshot from that same view.
      const throughCamera = yield* service.captureView(threadId);
      const throughShot = decodePng(throughCamera.screenshot.dataUrl);
      expect([throughShot.width, throughShot.height]).toEqual([
        throughCamera.screenshot.width,
        throughCamera.screenshot.height,
      ]);
      throughCamera.cameraView.position.forEach((value, index) =>
        expect(value).toBeCloseTo([3, -4, 2][index]!, 3),
      );

      // A middle-drag orbit in the viewport: Blender hides its cursor while it holds the mouse.
      const operator = yield* attach(service, true);
      yield* operator.input({ type: "takeControl", takeOver: false });
      expect(yield* controller(operator).pipe(Effect.repeat({ until: (c) => c === "you" }))).toBe(
        "you",
      );
      yield* operator.input({ type: "pointer", x: 640, y: 400 });
      yield* operator.input({ type: "button", button: 274, pressed: true });
      expect(yield* nextMessage(operator, "cursor").pipe(Effect.timeout("20 seconds"))).toEqual({
        type: "cursor",
        captured: true,
      });
      yield* operator.input({ type: "pointerMotion", dx: 40, dy: 0 });
      yield* operator.input({ type: "button", button: 274, pressed: false });
      expect(yield* nextMessage(operator, "cursor").pipe(Effect.timeout("20 seconds"))).toEqual({
        type: "cursor",
        captured: false,
      });

      const blenderPid = NodeFS.readdirSync("/proc")
        .filter((entry) => /^\d+$/.test(entry))
        .find((pid) => {
          try {
            const argv = NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
            return NodePath.basename(argv[0] ?? "") === "blender" && argv.includes(blendPath);
          } catch {
            return false;
          }
        });
      assert.isDefined(blenderPid);
      const environ = NodeFS.readFileSync(`/proc/${blenderPid}/environ`, "utf8").split("\0");
      const variable = (name: string) =>
        environ.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
      expect(variable("T3CODE_THREAD_ID")).toBeUndefined();
      expect(variable("TMPDIR")).toContain(NodePath.join(dir, "userdata"));
      expect(variable("BLENDER_USER_RESOURCES")).toBe(
        NodePath.join(dir, "userdata", "hosted-blender", "user-resources"),
      );
      const argv = NodeFS.readFileSync(`/proc/${blenderPid}/cmdline`, "utf8").split("\0");
      expect(argv).toContain("--online-mode");
      expect(Number(argv[argv.indexOf("--t3-mcp-port") + 1])).not.toBe(9876);

      // A view link moves the person's viewport window; the frame drawn after it is what a
      // freeze would capture, so it is read back once Blender has drawn the new view.
      yield* viewer.ack;
      yield* service.setView({
        threadId,
        relativePath: "models/cube.blend",
        view: { position: [6, -6, 5], target: [0, 0, 0] },
      });
      yield* Queue.take(viewer.output).pipe(
        Effect.repeat({ until: (output) => output._tag === "frame" }),
      );
      const capture = yield* service.captureView(threadId);
      expect(capture.cameraView.upAxis).toBe("z");
      capture.cameraView.position.forEach((value, index) =>
        expect(value).toBeCloseTo([6, -6, 5][index]!, 3),
      );
      capture.cameraView.target.forEach((value) => expect(value).toBeCloseTo(0, 3));
      // The orbit and the view link moved only the view, which leaves the scene the hits are
      // cast in as it was captured.
      expect(capture.scene).toBe(throughCamera.scene);
      const { region } = capture.projection;
      // The factory scene's cube sits at the origin, in the middle of the 3D view; a corner of
      // the view looks past it at nothing.
      const hits = yield* service.findHits({
        threadId,
        projection: capture.projection,
        scene: capture.scene,
        marks: [
          [{ x: region.x + region.width / 2, y: region.y + region.height / 2 }],
          [{ x: region.x + region.width * 0.02, y: region.y + region.height * 0.02 }],
        ],
      });
      expect(hits).toHaveLength(2);
      expect(hits[0]?.object).toBe("Cube");
      // The screenshot and the camera are one view: the cube's hit point, projected through the
      // returned matrix, lands on cube pixels in the screenshot, not on the background.
      const shot = decodePng(capture.screenshot.dataUrl);
      const at = projectToPixel(capture.projection.matrix, hits[0]!.point, shot);
      expect(Math.abs(at.x - shot.width / 2)).toBeLessThan(2);
      expect(Math.abs(at.y - shot.height / 2)).toBeLessThan(2);
      expect(shot.pixel(at.x, at.y)).not.toEqual(shot.pixel(2, 2));
      expect(Math.max(...hits[0]!.point.map(Math.abs))).toBeCloseTo(1, 3);
      expect(hits[1]).toBeNull();

      // A save Blender can't write leaves it running, with the error for the pane.
      NodeFS.chmodSync(NodePath.join(workspace, "models"), 0o555);
      const refused = yield* service.quit({ threadId, save: true }).pipe(Effect.flip);
      NodeFS.chmodSync(NodePath.join(workspace, "models"), 0o755);
      expect(refused.reason).toBe("saveFailed");
      expect((yield* firstState(service)).status).toBe("running");
      yield* service.quit({ threadId, save: true });
      yield* awaitStatus("stopped");
    }).pipe(Effect.scoped),
  );
});

// Marks the file once, right after Blender first loads it, through the data API alone: like
// agent code, that leaves no undo step and doesn't mark the file unsaved. Writes its pid too.
const EDITING_STARTUP_SCRIPT = `import os
import bpy
from bpy.app.handlers import persistent

@persistent
def _edit(*_args):
    folder = os.environ.get("HB_TEST_DIR")
    if not folder or not bpy.data.filepath.endswith("cube.blend"):
        return
    with open(os.path.join(folder, "blender.pid"), "w") as pid:
        pid.write(str(os.getpid()))
    marker = os.path.join(folder, "edited")
    if os.path.exists(marker):
        return
    # Made once a 3D view has drawn: by then Blender has handled the load's notifiers, which
    # clear the file's unsaved mark and would hide an edit made before them.
    def _edit_now():
        bpy.context.scene.collection.objects.link(bpy.data.objects.new("T3Edit", None))
        open(marker, "w").close()
        # Recorded as an undo step, as an edit through Blender's UI or an agent call is, so
        # Blender reports the file unsaved.
        window = bpy.context.window_manager.windows[0]
        with bpy.context.temp_override(window=window):
            bpy.ops.ed.undo_push(message="T3 test edit")
    handle = []
    def _drawn():
        bpy.types.SpaceView3D.draw_handler_remove(handle[0], "WINDOW")
        bpy.app.timers.register(_edit_now, first_interval=0.1)
    handle.append(bpy.types.SpaceView3D.draw_handler_add(_drawn, (), "WINDOW", "POST_PIXEL"))

def register():
    bpy.app.handlers.load_post.append(_edit)

def unregister():
    bpy.app.handlers.load_post.remove(_edit)
`;

// Opens the file named in HB_TEST_DIR/open-file from inside Blender, as an agent's
// bpy.ops.wm.open_mainfile does, then edits it through undo so it reads unsaved.
const OPENING_STARTUP_SCRIPT = `import os
import bpy

def _edit():
    bpy.context.scene.collection.objects.link(bpy.data.objects.new("T3Other", None))
    with bpy.context.temp_override(window=bpy.context.window_manager.windows[0]):
        bpy.ops.ed.undo_push(message="T3 test edit")

def _poll():
    # As a build before T3 marked its viewport window saved it: a plain lone 3D view.
    unmark = os.path.join(os.environ.get("HB_TEST_DIR", ""), "unmark")
    if os.path.exists(unmark):
        os.remove(unmark)
        for window in bpy.context.window_manager.windows:
            if "t3_viewport" in window.screen:
                del window.screen["t3_viewport"]
        open(unmark + "ed", "w").close()
    trigger = os.path.join(os.environ.get("HB_TEST_DIR", ""), "open-file")
    if os.path.exists(trigger):
        target = open(trigger).read()
        os.remove(trigger)
        with bpy.context.temp_override(window=bpy.context.window_manager.windows[0]):
            bpy.ops.wm.open_mainfile(filepath=target)
        bpy.app.timers.register(_edit, first_interval=0.5)
    return 0.2

def register():
    bpy.app.timers.register(_poll, first_interval=1.0, persistent=True)

def unregister():
    pass
`;

const objectsIn = (file: string) =>
  NodeChildProcess.execFileSync(
    "blender",
    [
      "--background",
      "--factory-startup",
      file,
      "--python-expr",
      "import bpy; print('OBJECTS', sorted(o.name for o in bpy.data.objects))",
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .find((line) => line.startsWith("OBJECTS"));

// Makes every quit outlast T3's 3-second shutdown deadline: Blender runs exit_pre handlers
// before it writes its quit copy.
const SLOW_EXIT_STARTUP_SCRIPT = `import time
import bpy
from bpy.app.handlers import persistent

@persistent
def _slow(*_args):
    time.sleep(5)

def register():
    bpy.app.handlers.exit_pre.append(_slow)

def unregister():
    bpy.app.handlers.exit_pre.remove(_slow)
`;

// Counts each load after the launch's own in HB_TEST_DIR/loads, and on request edits the cube
// through undo (HB_TEST_DIR/edit) or reports what Blender has (HB_TEST_DIR/probe).
const RELOAD_PROBE_SCRIPT = `import json, os
import bpy
from bpy.app.handlers import persistent

def _write(name, text):
    path = os.path.join(os.environ["HB_TEST_DIR"], name)
    with open(path + ".part", "w") as out:
        out.write(text)
    os.replace(path + ".part", path)

@persistent
def _loaded(*_args):
    path = os.path.join(os.environ["HB_TEST_DIR"], "loads")
    _write("loads", str(int(open(path).read()) + 1) if os.path.exists(path) else "0")

def _poll():
    folder = os.environ["HB_TEST_DIR"]
    windows = bpy.context.window_manager.windows
    if os.path.exists(os.path.join(folder, "edit")):
        value = open(os.path.join(folder, "edit")).read()
        os.remove(os.path.join(folder, "edit"))
        bpy.data.objects["Cube"].location.x = float(value or 9)
        with bpy.context.temp_override(window=windows[0]):
            bpy.ops.ed.undo_push(message="T3 test edit")
    if os.path.exists(os.path.join(folder, "probe")):
        os.remove(os.path.join(folder, "probe"))
        _write("probe.json", json.dumps({
            "tempdir": bpy.app.tempdir,
            "cubeX": round(bpy.data.objects["Cube"].location.x, 3),
            "dirty": bpy.data.is_dirty,
            "viewports": len([w for i, w in enumerate(windows) if i > 0 and w.screen.get("t3_viewport")]),
        }))
    return 0.2

def register():
    bpy.app.handlers.load_post.append(_loaded)
    bpy.app.timers.register(_poll, first_interval=1.0, persistent=True)

def unregister():
    pass
`;

// Runs what the test writes to HB_TEST_DIR/command, as a person would in Blender: "edit <name>"
// adds an object through undo, "save" is Ctrl+S, "open <path>" is File > Open; ";" chains them,
// one a tick.
// Writes bpy.app.tempdir to HB_TEST_DIR/tempdir first, to show it is the launch's own.
const COMMAND_STARTUP_SCRIPT = `import os
import bpy

_queue = []

def _poll():
    folder = os.environ.get("HB_TEST_DIR", "")
    with open(os.path.join(folder, "tempdir"), "w") as out:
        out.write(bpy.app.tempdir)
    command_path = os.path.join(folder, "command")
    if os.path.exists(command_path):
        _queue.extend(open(command_path).read().split(";"))
        os.remove(command_path)
    # One a tick: a file opened frees the window the next one would run in.
    if _queue:
        verb, _, argument = _queue.pop(0).partition(" ")
        with bpy.context.temp_override(window=bpy.context.window_manager.windows[0]):
            if verb == "edit":
                bpy.context.scene.collection.objects.link(bpy.data.objects.new(argument, None))
                bpy.ops.ed.undo_push(message="T3 test edit")
            elif verb == "save":
                bpy.ops.wm.save_mainfile()
            elif verb == "open":
                bpy.ops.wm.open_mainfile(filepath=argument)
    return 0.2

def register():
    bpy.app.timers.register(_poll, first_interval=1.0, persistent=True)

def unregister():
    pass
`;

describe.skipIf(!canHostBlender)("B13: a real hosted Blender whose file changes on disk", () => {
  /** A Blender of the test's own, in the background, isolated from the developer's settings. */
  const backgroundBlender = (dir: string, args: ReadonlyArray<string>) => {
    const own = NodePath.join(dir, "background");
    NodeFS.mkdirSync(NodePath.join(own, "tmp"), { recursive: true });
    return NodeChildProcess.execFileSync(
      "blender",
      ["--background", "--factory-startup", ...args],
      {
        encoding: "utf8",
        env: {
          PATH: hostEnvironment.PATH,
          HOME: own,
          TMPDIR: NodePath.join(own, "tmp"),
          BLENDER_USER_RESOURCES: own,
        },
      },
    );
  };
  /** Another Blender saves the cube moved to `x` beside the file, then over it, as Blender does. */
  const changeOnDisk = (dir: string, blendPath: string, x: number) => {
    const next = `${blendPath}.next.blend`;
    backgroundBlender(dir, [
      blendPath,
      "--python-expr",
      `import bpy; bpy.data.objects["Cube"].location.x = ${x}; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(next)}, copy=True)`,
    ]);
    NodeFS.renameSync(next, blendPath);
  };
  const cubeXIn = (dir: string, file: string) =>
    backgroundBlender(dir, [
      file,
      "--python-expr",
      "import bpy; print('CUBE_X', round(bpy.data.objects['Cube'].location.x, 3))",
    ])
      .split("\n")
      .find((line) => line.startsWith("CUBE_X"));

  const realHost = (prefix: string) =>
    Effect.gen(function* () {
      const dir = yield* tempDir(prefix);
      const workspace = NodePath.join(dir, "work");
      NodeFS.mkdirSync(workspace, { recursive: true });
      const blendPath = NodePath.join(workspace, "cube.blend");
      backgroundBlender(dir, [
        "--python-expr",
        `import bpy; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blendPath)})`,
      ]);
      const configHome = NodePath.join(dir, "config");
      const startup = NodePath.join(configHome, "blender", "5.3", "scripts", "startup");
      NodeFS.mkdirSync(startup, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(startup, "t3_test_reload.py"), RELOAD_PROBE_SCRIPT);
      const service = yield* serviceFor(
        layerFor({
          env: {
            PATH: hostEnvironment.PATH,
            XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
            XDG_CONFIG_HOME: configHome,
            HB_TEST_DIR: dir,
          },
          helper: helperBuild,
          workspaceRoot: workspace,
          baseDir: dir,
        }),
      );
      const probe = Effect.gen(function* () {
        const out = NodePath.join(dir, "probe.json");
        NodeFS.rmSync(out, { force: true });
        NodeFS.writeFileSync(NodePath.join(dir, "probe"), "");
        yield* fileAppears(dir, out);
        return JSON.parse(NodeFS.readFileSync(out, "utf8")) as {
          tempdir: string;
          cubeX: number;
          dirty: boolean;
          viewports: number;
        };
      });
      const loadsPath = NodePath.join(dir, "loads");
      const loads = () =>
        NodeFS.existsSync(loadsPath) ? Number(NodeFS.readFileSync(loadsPath, "utf8")) : -1;
      return {
        dir,
        blendPath,
        service,
        probe,
        loads,
        awaitLoads: (count: number) => fileAppears(dir, loadsPath, () => loads() >= count),
        hostedDir: NodePath.join(dir, "userdata", "hosted-blender"),
      };
    });

  it.live(
    "shows the file as changed on disk at once while the pane is on screen, from the same view, keeping unsaved work to restore",
    () =>
      Effect.gen(function* () {
        const host = yield* realHost("real-reload");
        const { service, dir } = host;
        yield* service.open({ threadId, relativePath: "cube.blend" });
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running"),
          Stream.runHead,
        );
        const viewer = yield* attach(service, false);
        yield* Queue.take(viewer.output).pipe(
          Effect.repeat({ until: (output) => output._tag === "frame" }),
        );
        const first = yield* host.probe;
        // This Blender's temporary files are the test's, never the developer's.
        expect(first.tempdir.startsWith(dir)).toBe(true);
        expect(first).toMatchObject({ cubeX: 0, viewports: 1 });
        yield* service.setView({
          threadId,
          relativePath: "cube.blend",
          view: { position: [6, -6, 5], target: [0, 0, 0] },
        });
        NodeFS.writeFileSync(NodePath.join(dir, "edit"), "");
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
        );

        const launched = host.loads();
        changeOnDisk(dir, host.blendPath, 4);
        // Blender clears the loaded file's unsaved mark a moment after the load.
        const reloaded = yield* service.threadState(threadId).pipe(
          Stream.filter((state) => "reloadKept" in state && !state.dirty),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(reloaded).toMatchObject({ dirty: false, reloadKept: { key: CUBE } });
        expect(yield* host.probe).toMatchObject({ cubeX: 4, dirty: false, viewports: 1 });
        expect(host.loads()).toBe(launched + 1);
        // The person's view is where they left it, not the file's stored one.
        const view = yield* service.captureView(threadId);
        view.cameraView.position.forEach((value, index) =>
          expect(value).toBeCloseTo([6, -6, 5][index]!, 3),
        );
        // The work it had unsaved is the file's copy.
        const copy = recoveryOf(host.hostedDir);
        expect(copy?.record.recovery).toBe(true);
        expect(cubeXIn(dir, copy!.session)).toBe("CUBE_X 9.0");
        // S1: edited since the reload, Restore asks first rather than replacing that work...
        NodeFS.writeFileSync(NodePath.join(dir, "edit"), "2");
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
        );
        const asked = yield* service
          .reopen({ threadId, key: CUBE, restore: true })
          .pipe(Effect.flip);
        expect(asked.reason).toBe("restoreReplacesUnsaved");
        expect(yield* host.probe).toMatchObject({ cubeX: 2 });
        // ...and agreed, puts the kept work back and keeps what it replaced as the copy, which
        // the pane offers in turn: the same step undoes it.
        yield* service.reopen({ threadId, key: CUBE, restore: true, replaceUnsaved: true });
        expect(yield* host.probe).toMatchObject({ cubeX: 9, viewports: 1 });
        expect(cubeXIn(dir, recoveryOf(host.hostedDir)!.session)).toBe("CUBE_X 2.0");
        const restored = yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(restored).toMatchObject({ reloadKept: { key: CUBE } });
        yield* service.quit({ threadId, save: false, discard: true });
      }).pipe(Effect.scoped),
  );
});

// Writes T3's viewport windows to HB_TEST_DIR/layout.json each tick, and runs HB_TEST_DIR/command
// one a tick (";" chains): "strip|view <type>" switches the strip's or 3D view's editor, "open
// <path>" is File > Open, "edit|move <name>" adds or moves an object through undo, "hide|unhide
// <name>" hides one as H does, "scene <name>" shows that scene in T3's viewport window.
const LAYOUT_STARTUP_SCRIPT = `import json, os
import bpy
from bpy.app.handlers import persistent

_queue = []
_ticks = [0]

def _areas(window):
    found = []
    for area in window.screen.areas:
        regions = {region.type: region for region in area.regions}
        main = regions.get("WINDOW")
        entry = {"type": area.type, "ui": area.ui_type, "x": area.x, "y": area.y,
                 "width": area.width, "height": area.height}
        if area.type == "VIEW_3D":
            entry["sidebar"] = area.spaces.active.show_region_ui
        if main is not None:
            entry["region"] = {"x": main.x, "y": main.y, "width": main.width, "height": main.height}
            if area.type == "DOPESHEET_EDITOR":
                entry["frames"] = [main.view2d.region_to_view(0, 0)[0],
                                   main.view2d.region_to_view(main.width, 0)[0]]
        found.append(entry)
    return sorted(found, key=lambda entry: -entry["y"])

def _viewport_windows():
    windows = bpy.context.window_manager.windows
    return [window for index, window in enumerate(windows) if index > 0 and window.screen.get("t3_viewport")]

def _poll():
    folder = os.environ.get("HB_TEST_DIR", "")
    command_path = os.path.join(folder, "command")
    if os.path.exists(command_path):
        _queue.extend(open(command_path).read().split(";"))
        os.remove(command_path)
    if _queue:
        verb, _, argument = _queue.pop(0).partition(" ")
        windows = _viewport_windows()
        if verb == "open":
            with bpy.context.temp_override(window=bpy.context.window_manager.windows[0]):
                bpy.ops.wm.open_mainfile(filepath=argument)
        elif verb == "keys":
            cube = bpy.data.objects["Cube"]
            for frame, angle in ((10, 0.0), (70, 1.5)):
                cube.rotation_euler.z = angle
                cube.keyframe_insert("rotation_euler", frame=frame)
            with bpy.context.temp_override(window=bpy.context.window_manager.windows[0]):
                bpy.ops.ed.undo_push(message="T3 test keys")
        elif verb == "edit":
            bpy.context.scene.collection.objects.link(bpy.data.objects.new(argument, None))
            with bpy.context.temp_override(window=bpy.context.window_manager.windows[0]):
                bpy.ops.ed.undo_push(message="T3 test edit")
        elif verb == "move":
            bpy.data.objects[argument].location.x += 1
            with bpy.context.temp_override(window=bpy.context.window_manager.windows[0]):
                bpy.ops.ed.undo_push(message="T3 test move")
        elif verb in ("hide", "unhide"):
            bpy.data.objects[argument].hide_set(verb == "hide")
        # F12 renders a flat magenta picture this size.
        elif verb == "flat":
            scene = bpy.context.scene
            scene.render.engine = "BLENDER_WORKBENCH"
            scene.render.resolution_x, scene.render.resolution_y = (int(n) for n in argument.split("x"))
            scene.render.resolution_percentage = 100
            scene.view_settings.view_transform = "Standard"
            scene.display.shading.light = "FLAT"
            scene.display.shading.color_type = "SINGLE"
            scene.display.shading.single_color = (1.0, 0.0, 1.0)
            scene.world.color = (1.0, 0.0, 1.0)
        elif windows:
            window = windows[0]
            view = next(area for area in window.screen.areas if area.type == "VIEW_3D")
            strip = next((area for area in window.screen.areas if area.type != "VIEW_3D"), None)
            if verb == "view":
                view.type = argument
            elif verb == "strip" and strip is not None:
                strip.type = argument
            elif verb == "scene":
                window.scene = bpy.data.scenes.get(argument) or bpy.data.scenes.new(argument)
    _ticks[0] += 1
    layout = {
        "tick": _ticks[0],
        "pid": os.getpid(),
        "mark": bpy.context.scene.get("t3_mark"),
        "frame": bpy.context.scene.frame_current,
        "selected": [o.name for o in bpy.context.view_layer.objects if o.select_get()],
        "moves": bpy.data.objects["Cube"].location.x if "Cube" in bpy.data.objects else None,
        "hidden": [o.name for o in bpy.context.view_layer.objects if o.hide_get()],
        "windows": [{"pointer": window.as_pointer(), "width": window.width, "height": window.height,
                     "scene": window.scene.name, "areas": _areas(window)}
                    for window in _viewport_windows()],
        "render": "%s %dx%d" % (bpy.context.scene.render.engine, bpy.context.scene.render.resolution_x,
                                bpy.context.scene.render.resolution_y),
        "others": [{"width": window.width, "height": window.height,
                    "areas": [area.type for area in window.screen.areas]}
                   for index, window in enumerate(bpy.context.window_manager.windows)
                   if index > 0 and not window.screen.get("t3_viewport")],
    }
    with open(os.path.join(folder, "layout.json.part"), "w") as out:
        json.dump(layout, out)
    os.replace(os.path.join(folder, "layout.json.part"), os.path.join(folder, "layout.json"))
    return 0.2

# Blender's main window shows green where its Properties editor was, which T3's viewport window
# never has: a frame showing it shows green.
@persistent
def _mark_main(*_args):
    windows = bpy.context.window_manager.windows
    if not os.environ.get("HB_TEST_MARK_MAIN") or not len(windows):
        return
    for area in windows[0].screen.areas:
        if area.type == "PROPERTIES":
            area.type = "VIEW_3D"
            area.spaces.active.shading.background_type = "VIEWPORT"
            area.spaces.active.shading.background_color = (0.0, 1.0, 0.0)

def register():
    bpy.app.timers.register(_poll, first_interval=1.0, persistent=True)
    bpy.app.handlers.load_post.append(_mark_main)

def unregister():
    pass
`;

interface LayoutArea {
  readonly type: string;
  readonly ui: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly region?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly frames?: readonly [number, number];
  /** A 3D view's sidebar (N) is shown. */
  readonly sidebar?: boolean;
}
interface Layout {
  /** Blender's own count of the script's ticks. */
  readonly tick: number;
  readonly pid: number;
  /** What the last outside write marked the scene with. */
  readonly mark: number | null;
  readonly frame: number;
  readonly selected: ReadonlyArray<string>;
  /** Where the cube sits along x, which "move Cube" changes. */
  readonly moves: number | null;
  /** The objects hidden in the view layer, as H hides them. */
  readonly hidden: ReadonlyArray<string>;
  readonly windows: ReadonlyArray<{
    readonly pointer: number;
    readonly width: number;
    readonly height: number;
    readonly scene: string;
    /** Top first. */
    readonly areas: ReadonlyArray<LayoutArea>;
  }>;
  /** The scene's render engine and size, as "<engine> <width>x<height>". */
  readonly render: string;
  /** Blender's windows besides its main window and T3's viewport windows. */
  readonly others: ReadonlyArray<{
    readonly width: number;
    readonly height: number;
    readonly areas: ReadonlyArray<string>;
  }>;
}

describe.skipIf(!canHostBlender)("a real hosted Blender's Timeline strip", () => {
  const KEY_LEFTCTRL = 29;
  // The cube rises from z 0 at frame 1 to z 6 at frame 100.
  const KEYFRAMED_CUBE = `cube = bpy.data.objects["Cube"]
scene = bpy.context.scene
scene.frame_start, scene.frame_end = 1, 100
scene.frame_set(1)
cube.location.z = 0
cube.keyframe_insert("location", frame=1)
cube.location.z = 6
cube.keyframe_insert("location", frame=100)
scene.frame_set(1)`;

  const launch = Effect.fn(function* (
    prefix: string,
    viewportGate?: Effect.Effect<void>,
    options: { readonly markMain?: boolean } = {},
  ) {
    const dir = yield* tempDir(prefix);
    const workspace = NodePath.join(dir, "work");
    NodeFS.mkdirSync(workspace, { recursive: true });
    for (const name of ["cube.blend", "other.blend"]) {
      NodeChildProcess.execFileSync("blender", [
        "--background",
        "--factory-startup",
        "--python-expr",
        `import bpy\n${KEYFRAMED_CUBE}\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(NodePath.join(workspace, name))})`,
      ]);
    }
    const configHome = NodePath.join(dir, "config");
    const startup = NodePath.join(configHome, "blender", "5.3", "scripts", "startup");
    NodeFS.mkdirSync(startup, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(startup, "t3_test_layout.py"), LAYOUT_STARTUP_SCRIPT);
    const context = yield* Layer.build(
      layerFor({
        env: {
          PATH: hostEnvironment.PATH,
          XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
          XDG_CONFIG_HOME: configHome,
          HB_TEST_DIR: dir,
          ...(options.markMain === true ? { HB_TEST_MARK_MAIN: "1" } : {}),
        },
        helper: helperBuild,
        workspaceRoot: workspace,
        baseDir: dir,
        ...(viewportGate === undefined
          ? {}
          : {
              heldWords: (word: "connected" | "viewportShown") =>
                word === "viewportShown" ? viewportGate : Effect.void,
            }),
      }),
    );
    const service = Context.get(context, HostedBlender.HostedBlender);
    const settings = Context.get(context, ServerSettings.ServerSettingsService);
    yield* service.open({ threadId, relativePath: "cube.blend" });
    const command = (text: string) => NodeFS.writeFileSync(NodePath.join(dir, "command"), text);
    /** The layout once `ready` holds for it: Blender reports it each tick. */
    const layoutWhen = (ready: (layout: Layout) => boolean, ticks = 150) =>
      Effect.sync((): Layout | null => {
        try {
          return JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "layout.json"), "utf8"));
        } catch {
          return null;
        }
      }).pipe(
        Effect.filterOrFail(
          (layout): layout is Layout => layout !== null && ready(layout),
          (layout) => `not yet: ${JSON.stringify(layout)}`,
        ),
        Effect.retry({ schedule: Schedule.spaced("200 millis"), times: ticks }),
      );
    /** Another program writes the file, as #64's tests do: a copy saved, then moved over it. */
    const writeOutside = (mark: number) => {
      const own = NodePath.join(dir, "outside");
      NodeFS.mkdirSync(NodePath.join(own, "tmp"), { recursive: true });
      const blendPath = NodePath.join(workspace, "cube.blend");
      const next = `${blendPath}.next.blend`;
      NodeChildProcess.execFileSync(
        "blender",
        [
          "--background",
          "--factory-startup",
          blendPath,
          "--python-expr",
          `import bpy; bpy.context.scene["t3_mark"] = ${mark}; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(next)}, copy=True)`,
        ],
        {
          env: {
            PATH: hostEnvironment.PATH,
            HOME: own,
            TMPDIR: NodePath.join(own, "tmp"),
            BLENDER_USER_RESOURCES: own,
          },
          stdio: "ignore",
        },
      );
      NodeFS.renameSync(next, blendPath);
    };
    return { dir, workspace, service, settings, command, layoutWhen, writeOutside };
  });

  /** The first capture once the add-on's connection is up. */
  const firstCapture = (service: HostedBlender.HostedBlender["Service"]) =>
    service.captureView(threadId).pipe(
      Effect.retry({
        while: (error) => error.reason === "noReply" || error.reason === "noViewport",
        schedule: Schedule.spaced("500 millis"),
        times: 40,
      }),
    );

  /**
   * The stream as it is now, not a frame already waiting: a viewer attached now starts on a
   * keyframe of whatever the hidden display captures, at the size it says.
   */
  const freshFrame = (service: HostedBlender.HostedBlender["Service"]) =>
    Effect.gen(function* () {
      const viewer = yield* attach(service, false);
      let size: string | null = null;
      while (true) {
        const output = yield* Queue.take(viewer.output);
        if (output._tag !== "message") {
          expect(output._tag).toBe("frame");
          break;
        }
        if (output.message.type === "viewport") {
          size = `${output.message.width}x${output.message.height}`;
        }
      }
      expect(size).toBe("1280x720");
    }).pipe(Effect.scoped);

  /** One T3 viewport window: a 3D view with the Timeline under it, or a lone 3D view. */
  const withStrip = (layout: Layout) =>
    layout.windows.length === 1 &&
    layout.windows[0]!.areas.length === 2 &&
    layout.windows[0]!.areas[0]!.type === "VIEW_3D" &&
    layout.windows[0]!.areas[1]!.type === "DOPESHEET_EDITOR";
  const alone = (layout: Layout) =>
    layout.windows.length === 1 &&
    layout.windows[0]!.areas.length === 1 &&
    layout.windows[0]!.areas[0]!.type === "VIEW_3D";

  it.live(
    "S1: keeps a new viewport window whole until the hidden display has it filling the output, then adds the strip",
    () =>
      Effect.gen(function* () {
        let held = yield* Deferred.make<void>();
        const gate = Effect.suspend(() => Deferred.await(held));
        const { service, command, layoutWhen } = yield* launch("timeline-gate", gate);
        /** Held back: streamed at full size, the window stays a lone 3D view tick after tick. */
        const staysWhole = (pointer?: number) =>
          Effect.gen(function* () {
            const shown = yield* layoutWhen(
              (layout) =>
                alone(layout) &&
                layout.windows[0]!.pointer !== pointer &&
                layout.windows[0]!.width === 1280 &&
                layout.windows[0]!.height === 720,
            );
            yield* freshFrame(service);
            const later = yield* layoutWhen((layout) => layout.tick >= shown.tick + 10);
            expect(alone(later)).toBe(true);
            expect(later.windows[0]!.pointer).toBe(shown.windows[0]!.pointer);
            return shown.windows[0]!.pointer;
          });
        const first = yield* staysWhole();
        yield* Deferred.succeed(held, undefined);
        yield* layoutWhen((layout) => withStrip(layout) && layout.windows[0]!.pointer === first);
        yield* freshFrame(service);

        // A replacement window waits the same way.
        held = yield* Deferred.make<void>();
        command("view IMAGE_EDITOR");
        const replacement = yield* staysWhole(first);
        yield* Deferred.succeed(held, undefined);
        const split = yield* layoutWhen(
          (layout) => withStrip(layout) && layout.windows[0]!.pointer === replacement,
        );
        expect([split.windows[0]!.width, split.windows[0]!.height]).toEqual([1280, 720]);
        yield* freshFrame(service);
        yield* service.quit({ threadId, save: false, discard: true });
      }).pipe(Effect.scoped),
  );

  it.live(
    "shows the Timeline under the 3D view, scrubs it in control, reads and moves only the 3D view, and keeps hits through a selection but not a move",
    () =>
      Effect.gen(function* () {
        const { service, command, layoutWhen } = yield* launch("timeline-strip");
        const first = yield* layoutWhen(withStrip);
        const window = first.windows[0]!;
        const [view, strip] = window.areas as [LayoutArea, LayoutArea];
        // It still fills the display: the hidden display found it by its lone 3D view's title
        // before the strip came.
        expect([window.width, window.height]).toEqual([1280, 720]);
        // Blender's own Timeline, about as tall as in its default layout; the 3D view has the rest.
        expect(strip.ui).toBe("TIMELINE");
        expect(strip.height).toBeGreaterThan(30);
        expect(strip.height).toBeLessThan(80);
        expect(view.height).toBeGreaterThan(window.height - strip.height - 10);

        // Screenshots draw the 3D view's own region, not the whole window.
        const capture = yield* firstCapture(service);
        expect([capture.screenshot.width, capture.screenshot.height]).toEqual([
          view.region!.width,
          view.region!.height,
        ]);
        const centre = ({ projection, scene }: typeof capture) =>
          service.findHits({ threadId, projection, scene, marks: [[{ x: 0.5, y: 0.5 }]] });
        // A link's view frames the 3D view, and a mark in its middle finds the cube.
        yield* service.setView({
          threadId,
          relativePath: "cube.blend",
          view: { position: [0, -12, 1], target: [0, 0, 1] },
        });
        const framed = yield* service.captureView(threadId);
        framed.cameraView.position.forEach((value, index) =>
          expect(value).toBeCloseTo([0, -12, 1][index]!, 3),
        );
        expect((yield* centre(framed))[0]?.object).toBe("Cube");

        // In control, a drag along the strip scrubs, and the 3D view follows: the cube rises
        // out of the middle of the view.
        const operator = yield* attach(service, true);
        yield* operator.input({ type: "takeControl", takeOver: false });
        expect(yield* controller(operator).pipe(Effect.repeat({ until: (c) => c === "you" }))).toBe(
          "you",
        );
        const band = strip.region!;
        const scrubY = window.height - (band.y + band.height - 6);
        yield* operator.input({ type: "pointer", x: band.x + band.width * 0.3, y: scrubY });
        yield* operator.input({ type: "button", button: 272, pressed: true });
        yield* operator.input({ type: "pointer", x: band.x + band.width * 0.5, y: scrubY });
        yield* operator.input({ type: "pointer", x: band.x + band.width * 0.7, y: scrubY });
        yield* operator.input({ type: "button", button: 272, pressed: false });
        const scrubbed = yield* layoutWhen((layout) => layout.frame > 10);
        expect(scrubbed.frame).toBeLessThanOrEqual(100);
        const risen = yield* service.captureView(threadId);
        expect((yield* centre(risen))[0]?.object ?? null).toBeNull();

        // A selection click moves nothing a mark could hit, so the picture's scene still holds;
        // moving an object ends it.
        const area3d = view.region!;
        yield* operator.input({
          type: "pointer",
          x: area3d.x + area3d.width * 0.5,
          y: window.height - (area3d.y + 40),
        });
        yield* operator.input({ type: "button", button: 272, pressed: true });
        yield* operator.input({ type: "button", button: 272, pressed: false });
        const deselected = yield* layoutWhen((layout) => layout.selected.length === 0);
        expect((yield* service.captureView(threadId)).scene).toBe(risen.scene);
        command("move Cube");
        yield* layoutWhen((layout) => layout.moves !== deselected.moves);
        expect((yield* service.captureView(threadId)).scene).not.toBe(risen.scene);
        expect((yield* centre(risen).pipe(Effect.flip)).reason).toBe("sceneChanged");
        // Hiding an object, as H does, changes what a mark would hit; so does showing another
        // scene in the window.
        const moved = yield* service.captureView(threadId);
        command("hide Cube");
        yield* layoutWhen((layout) => layout.hidden.includes("Cube"));
        const hidden = yield* service.captureView(threadId);
        expect(hidden.scene).not.toBe(moved.scene);
        command("scene Other");
        yield* layoutWhen((layout) => layout.windows[0]?.scene === "Other");
        expect((yield* service.captureView(threadId)).scene).not.toBe(hidden.scene);
        command("scene Scene;unhide Cube");
        yield* layoutWhen(
          (layout) => layout.windows[0]?.scene === "Scene" && !layout.hidden.includes("Cube"),
        );

        // The wheel over the strip reaches the Timeline: Ctrl+wheel moves its frame range.
        const span = (layout: Layout) => layout.windows[0]!.areas[1]!.frames!;
        const before = span(scrubbed);
        yield* operator.input({ type: "pointer", x: band.x + band.width * 0.5, y: scrubY });
        yield* operator.input({ type: "key", code: KEY_LEFTCTRL, pressed: true });
        yield* operator.input({
          type: "scroll",
          axis: "vertical",
          source: "wheel",
          value: 45,
          steps: 3,
        });
        yield* operator.input({ type: "key", code: KEY_LEFTCTRL, pressed: false });
        const panned = yield* layoutWhen(
          (layout) =>
            withStrip(layout) && (span(layout)[0] !== before[0] || span(layout)[1] !== before[1]),
        );
        expect(panned.windows[0]!.pointer).toBe(window.pointer);

        // The strip is the person's to size: the window stays T3's viewport, screenshots follow
        // the 3D view's new size, and the wheel below the scrubbing band zooms the range.
        // Dragged by its top edge: Blender's screen operators refuse scripts in a temporary window.
        // A drag Blender read all at once under load is made again.
        const edge = Math.round(window.height - (strip.y + strip.height + view.y) / 2);
        const middle = Math.round(band.x + band.width * 0.5);
        const drag = Effect.gen(function* () {
          yield* operator.input({ type: "pointer", x: middle, y: edge });
          yield* operator.input({ type: "button", button: 272, pressed: true });
          for (const step of [5, 10, 20, 30, 40, 50, 60]) {
            yield* operator.input({ type: "pointer", x: middle, y: edge - step });
          }
          yield* operator.input({ type: "button", button: 272, pressed: false });
        });
        const grown = yield* drag.pipe(
          Effect.andThen(
            layoutWhen(
              (layout) =>
                withStrip(layout) && layout.windows[0]!.areas[1]!.height > strip.height + 30,
              25,
            ),
          ),
          Effect.retry({ times: 3 }),
        );
        expect(grown.windows[0]!.pointer).toBe(window.pointer);
        const shrunk = grown.windows[0]!.areas[0]!;
        const shot = yield* service.captureView(threadId);
        expect([shot.screenshot.width, shot.screenshot.height]).toEqual([
          shrunk.region!.width,
          shrunk.region!.height,
        ]);
        const tall = grown.windows[0]!.areas[1]!.region!;
        const wide = span(grown)[1] - span(grown)[0];
        yield* operator.input({
          type: "pointer",
          x: tall.x + tall.width * 0.5,
          y: window.height - (tall.y + 10),
        });
        yield* operator.input({
          type: "scroll",
          axis: "vertical",
          source: "wheel",
          value: 45,
          steps: 3,
        });
        yield* layoutWhen(
          (layout) => withStrip(layout) && Math.abs(span(layout)[1] - span(layout)[0] - wide) > 1,
        );

        // Or to switch to another animation editor.
        command("strip GRAPH_EDITOR");
        const graph = yield* layoutWhen(
          (layout) => layout.windows[0]?.areas[1]?.type === "GRAPH_EDITOR",
        );
        expect(graph.windows).toHaveLength(1);
        expect(graph.windows[0]!.pointer).toBe(window.pointer);
        expect((yield* service.captureView(threadId)).screenshot.width).toBe(shrunk.region!.width);

        // Turning the 3D view itself into another editor loses the viewport: a fresh window
        // opens, with the strip, and the stream shows it at full size.
        command("view IMAGE_EDITOR");
        const fresh = yield* layoutWhen(
          (layout) => withStrip(layout) && layout.windows[0]!.pointer !== window.pointer,
        );
        expect(fresh.windows[0]!.areas[1]!.ui).toBe("TIMELINE");
        expect(fresh.pid).toBe(first.pid);
        expect([fresh.windows[0]!.width, fresh.windows[0]!.height]).toEqual([1280, 720]);
        yield* freshFrame(service);
        yield* service.quit({ threadId, save: false, discard: true });
      }).pipe(Effect.scoped),
  );

  it.live(
    "a reload when the file changes on disk keeps one viewport window, the strip as switched and the view",
    () =>
      Effect.gen(function* () {
        const { service, settings, layoutWhen, writeOutside } = yield* launch("timeline-reload");
        // Reloads run while a pane is on screen.
        const viewer = yield* attach(service, false);
        yield* Queue.take(viewer.output).pipe(
          Effect.repeat({ until: (output) => output._tag === "frame" }),
        );
        const first = yield* layoutWhen(withStrip);
        const pointer = first.windows[0]!.pointer;
        yield* service.setView({
          threadId,
          relativePath: "cube.blend",
          view: { position: [6, -6, 5], target: [0, 0, 0] },
        });
        const same = (layout: Layout) =>
          layout.windows.length === 1 && layout.windows[0]!.pointer === pointer;
        const sameView = Effect.gen(function* () {
          const view = yield* service.captureView(threadId);
          view.cameraView.position.forEach((value, index) =>
            expect(value).toBeCloseTo([6, -6, 5][index]!, 3),
          );
        });

        writeOutside(4);
        const reloaded = yield* layoutWhen((layout) => layout.mark === 4);
        expect(withStrip(reloaded) && same(reloaded)).toBe(true);
        yield* sameView;

        // Switched off, a reload leaves it off.
        yield* settings.updateSettings({ hostedBlenderTimeline: false });
        yield* layoutWhen((layout) => alone(layout) && same(layout));
        writeOutside(-3);
        const again = yield* layoutWhen((layout) => layout.mark === -3);
        expect(alone(again) && same(again)).toBe(true);
        yield* sameView;
        yield* freshFrame(service);
        yield* service.quit({ threadId, save: false, discard: true });
      }).pipe(Effect.scoped),
  );

  it.live(
    "Save and quit with unsaved edits and a frame picked in the strip ends saved, keeping nothing",
    () =>
      Effect.gen(function* () {
        const { service, command, layoutWhen, workspace } = yield* launch("timeline-save-quit");
        const first = yield* layoutWhen(withStrip);
        const window = first.windows[0]!;
        const band = window.areas[1]!.region!;
        command("edit T3Edit;keys");
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
        );
        const operator = yield* attach(service, true);
        yield* operator.input({ type: "takeControl", takeOver: false });
        expect(yield* controller(operator).pipe(Effect.repeat({ until: (c) => c === "you" }))).toBe(
          "you",
        );
        const x = Math.round(band.x + band.width * 0.4);
        const y = Math.round(window.height - (band.y + 3));
        yield* operator.input({ type: "pointer", x: x - 20, y });
        yield* operator.input({ type: "pointer", x, y });
        yield* operator.input({ type: "button", button: 272, pressed: true });
        yield* operator.input({ type: "button", button: 272, pressed: false });
        yield* layoutWhen((layout) => layout.frame > 10);
        // The pane's menu takes focus off the stream, which gives control back.
        yield* operator.input({ type: "releaseControl" });
        expect(
          yield* controller(operator).pipe(Effect.repeat({ until: (c) => c !== "you" })),
        ).not.toBe("you");

        yield* service.quit({ threadId, save: true });
        const ended = yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status !== "running"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(card(ended)).toEqual({ status: "stopped" });
        expect(objectsIn(NodePath.join(workspace, "cube.blend"))).toContain("T3Edit");
      }).pipe(Effect.scoped),
  );

  it.live(
    "switches the strip on a running Blender without restarting it, and keeps it as switched after a load and a reopen",
    () =>
      Effect.gen(function* () {
        const { service, settings, command, layoutWhen, workspace } =
          yield* launch("timeline-switch-real");
        const first = yield* layoutWhen(withStrip);
        const pointer = first.windows[0]!.pointer;

        yield* settings.updateSettings({ hostedBlenderTimeline: false });
        const off = yield* layoutWhen(alone);
        yield* settings.updateSettings({ hostedBlenderTimeline: true });
        const on = yield* layoutWhen(withStrip);
        // The same Blender and the same window, so the stream never restarted.
        for (const layout of [off, on]) {
          expect(layout.pid).toBe(first.pid);
          expect(layout.windows[0]!.pointer).toBe(pointer);
        }
        yield* freshFrame(service);

        // After a load the fresh viewport window has the strip as the switch says.
        yield* settings.updateSettings({ hostedBlenderTimeline: false });
        yield* layoutWhen(alone);
        command(`open ${NodePath.join(workspace, "other.blend")}`);
        const loaded = yield* layoutWhen(
          (layout) => alone(layout) && layout.windows[0]!.pointer !== pointer,
        );
        expect(loaded.pid).toBe(first.pid);
        yield* settings.updateSettings({ hostedBlenderTimeline: true });
        yield* layoutWhen(
          (layout) =>
            withStrip(layout) && layout.windows[0]!.pointer === loaded.windows[0]!.pointer,
        );
        command(`open ${NodePath.join(workspace, "cube.blend")};edit T3Edit`);
        yield* layoutWhen(
          (layout) =>
            withStrip(layout) && layout.windows[0]!.pointer !== loaded.windows[0]!.pointer,
        );
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
        );

        // A reopen of its kept copy restores into a new Blender, strip and all.
        yield* service.closeOnSettle({ threadId });
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "closed"),
          Stream.runHead,
        );
        yield* service.reopen({ threadId, key: CUBE, restore: true });
        const reopened = yield* layoutWhen(
          (layout) => withStrip(layout) && layout.pid !== first.pid,
        );
        expect(reopened.windows[0]!.areas[1]!.ui).toBe("TIMELINE");
        yield* service.quit({ threadId, save: false, discard: true });
      }).pipe(Effect.scoped),
  );

  // The frames are decoded with ffmpeg.
  const canDecode = onPath("ffmpeg");
  const KEY_ESC = 1;
  const KEY_O = 24;
  const KEY_N = 49;
  const KEY_COMMA = 51;
  const KEY_F12 = 88;
  const SEMU_HEADER_BYTES = 16;
  // Frames are decoded this small: enough to tell the colours apart.
  const SMALL = { width: 160, height: 90 };
  // labwc's default title bar over a floating window, in output pixels.
  const TITLE_BAR = 28;

  /** Every frame streamed from now, as H.264 access units, acked as a client acks them. */
  const recordStream = Effect.fn(function* (service: HostedBlender.HostedBlender["Service"]) {
    const viewer = yield* attach(service, false);
    const units: Array<Uint8Array> = [];
    const arrivals = yield* Queue.unbounded<void>();
    yield* Queue.take(viewer.output).pipe(
      Effect.flatMap((output) =>
        output._tag === "frame"
          ? Effect.sync(() => units.push(output.data.subarray(SEMU_HEADER_BYTES))).pipe(
              Effect.andThen(Queue.offer(arrivals, undefined)),
              Effect.andThen(viewer.ack),
            )
          : Effect.void,
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    return { units, arrivals };
  });
  type Recording = Effect.Success<ReturnType<typeof recordStream>>;

  /**
   * The number of frames once a frame after the `count`th has come and none for a while after:
   * frames are sent only as the picture changes, and a few more once it settles.
   */
  const framesAfter = (recording: Recording, count: number) =>
    Effect.gen(function* () {
      yield* Queue.clear(recording.arrivals);
      if (recording.units.length <= count) yield* Queue.take(recording.arrivals);
      let more = yield* Queue.take(recording.arrivals).pipe(Effect.timeoutOption("500 millis"));
      while (Option.isSome(more)) {
        more = yield* Queue.take(recording.arrivals).pipe(Effect.timeoutOption("500 millis"));
      }
      return recording.units.length;
    }).pipe(Effect.timeout("30 seconds"));

  const decodeFrames = (units: ReadonlyArray<Uint8Array>) => {
    const raw = NodeChildProcess.execFileSync(
      "ffmpeg",
      [
        "-loglevel",
        "error",
        "-f",
        "h264",
        "-i",
        "pipe:0",
        "-fps_mode",
        "passthrough",
        "-vf",
        `scale=${SMALL.width}:${SMALL.height}`,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { input: Buffer.concat(units), maxBuffer: 1 << 30 },
    );
    const size = SMALL.width * SMALL.height * 3;
    return Array.from({ length: raw.length / size }, (_, index) =>
      raw.subarray(index * size, (index + 1) * size),
    );
  };
  type Rgb = readonly [number, number, number];
  const pixel = (frame: Uint8Array, x: number, y: number): Rgb => {
    const at =
      (Math.min(SMALL.height - 1, Math.floor(y * SMALL.height)) * SMALL.width +
        Math.min(SMALL.width - 1, Math.floor(x * SMALL.width))) *
      3;
    return [frame[at]!, frame[at + 1]!, frame[at + 2]!];
  };
  const isMagenta = ([r, g, b]: Rgb) => r > 170 && b > 170 && g < 90;
  const isGreen = ([r, g, b]: Rgb) => g > 170 && r < 90 && b < 90;
  /** The fraction of the frame `test` holds for, and the centre of where it holds. */
  const coverage = (frame: Uint8Array, holds: (rgb: Rgb) => boolean) => {
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    for (let y = 0; y < SMALL.height; y++) {
      for (let x = 0; x < SMALL.width; x++) {
        if (!holds(pixel(frame, (x + 0.5) / SMALL.width, (y + 0.5) / SMALL.height))) continue;
        count++;
        sumX += (x + 0.5) / SMALL.width;
        sumY += (y + 0.5) / SMALL.height;
      }
    }
    const share = count / (SMALL.width * SMALL.height);
    return { share, x: count ? sumX / count : null, y: count ? sumY / count : null };
  };
  /** Blender's main window, painted green, is in none of the frames. */
  const expectNoMainWindow = (frames: ReadonlyArray<Uint8Array>) =>
    expect(
      frames
        .map((frame, index) => [index, coverage(frame, isGreen).share] as const)
        .filter(([, share]) => share > 0.005),
    ).toEqual([]);

  /** A viewer in control, for the keys and clicks a person would send. */
  const takeControl = Effect.fn(function* (service: HostedBlender.HostedBlender["Service"]) {
    const operator = yield* attach(service, true);
    yield* operator.input({ type: "takeControl", takeOver: false });
    yield* controller(operator).pipe(Effect.repeat({ until: (c) => c === "you" }));
    const keys = (...codes: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        for (const code of codes) yield* operator.input({ type: "key", code, pressed: true });
        for (const code of codes.toReversed()) {
          yield* operator.input({ type: "key", code, pressed: false });
        }
      });
    const click = (x: number, y: number) =>
      Effect.gen(function* () {
        yield* operator.input({ type: "pointer", x, y });
        yield* operator.input({ type: "button", button: 272, pressed: true });
        yield* operator.input({ type: "button", button: 272, pressed: false });
      });
    return { operator, keys, click };
  });

  it.live.skipIf(!canDecode)(
    "F12's render view floats centred in front of the viewport, Esc closes it, keys reach the viewport again, and Blender's main window is in no frame",
    () =>
      Effect.gen(function* () {
        const { service, command, layoutWhen } = yield* launch("floating-render", undefined, {
          markMain: true,
        });
        const recording = yield* recordStream(service);
        const { units } = recording;
        const first = yield* layoutWhen(withStrip);
        command("flat 200x150");
        yield* layoutWhen((layout) => layout.render === "BLENDER_WORKBENCH 200x150");
        const { operator, keys } = yield* takeControl(service);
        // Over the 3D view, where the render view will float.
        yield* operator.input({ type: "pointer", x: 640, y: 330 });
        const viewport = yield* framesAfter(recording, 0);

        yield* keys(KEY_F12);
        yield* layoutWhen((layout) =>
          layout.others.some((window) => window.areas.includes("IMAGE_EDITOR")),
        );
        const rendered = yield* framesAfter(recording, units.length);
        // Blender's picture of the 3D view alone isn't what the pane shows now, so there is none:
        // Screenshot & annotate freezes the pane's own frame instead.
        const covered = yield* Effect.flip(service.captureView(threadId));
        expect(covered.reason).toBe("noViewport");

        // Esc reaches the render view under the pointer, as on a desktop.
        yield* keys(KEY_ESC);
        yield* layoutWhen(
          (layout) =>
            layout.others.length === 0 &&
            withStrip(layout) &&
            layout.windows[0]!.pointer === first.windows[0]!.pointer,
        );
        const closed = yield* framesAfter(recording, units.length);
        yield* service.captureView(threadId);

        // The viewport has the keyboard again without a click: N shows its sidebar.
        yield* keys(KEY_N);
        yield* layoutWhen((layout) => layout.windows[0]?.areas[0]?.sidebar === true);

        const frames = decodeFrames(units);
        expect(frames.length).toBe(units.length);
        expect(coverage(frames[viewport - 1]!, isMagenta).share).toBe(0);
        const render = coverage(frames[rendered - 1]!, isMagenta);
        // The render floats in the middle, the viewport and its Timeline strip around it.
        expect(render.share).toBeGreaterThan(0.01);
        expect(render.share).toBeLessThan(0.3);
        expect(render.x).toBeCloseTo(0.5, 1);
        expect(render.y).toBeCloseTo(0.5, 1);
        expect(coverage(frames[closed - 1]!, isMagenta).share).toBe(0);
        expectNoMainWindow(frames);
        yield* service.quit({ threadId, save: false, discard: true });
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(!canDecode)(
    "a render view larger than the pane is fitted inside it, and stays inside as the pane narrows",
    () =>
      Effect.gen(function* () {
        const { service, command, layoutWhen } = yield* launch("floating-large", undefined, {
          markMain: true,
        });
        const recording = yield* recordStream(service);
        const { units } = recording;
        yield* layoutWhen(withStrip);
        command("flat 2400x1600");
        yield* layoutWhen((layout) => layout.render === "BLENDER_WORKBENCH 2400x1600");
        const { operator, keys } = yield* takeControl(service);
        yield* operator.input({ type: "pointer", x: 640, y: 330 });
        yield* keys(KEY_F12);
        const shown = yield* layoutWhen((layout) =>
          layout.others.some((window) => window.areas.includes("IMAGE_EDITOR")),
        );
        expect(shown.others[0]!.width).toBeLessThanOrEqual(1280);
        expect(shown.others[0]!.height).toBeLessThanOrEqual(720 - TITLE_BAR);
        const fitted = yield* framesAfter(recording, units.length);

        // The person in control narrows the pane, as a phone would.
        yield* operator.resize(360, 640);
        const narrowed = yield* layoutWhen(
          (layout) =>
            layout.others[0] !== undefined &&
            layout.windows[0]?.width === 360 &&
            layout.others[0].width <= 360 &&
            layout.others[0].height <= 640 - TITLE_BAR,
        );
        expect(narrowed.others[0]!.areas).toEqual(["IMAGE_EDITOR"]);
        const small = yield* framesAfter(recording, units.length);

        const frames = decodeFrames(units);
        expect(frames.length).toBe(units.length);
        // The render fills most of the picture, its title bar and edges inside it.
        expect(coverage(frames[fitted - 1]!, isMagenta).share).toBeGreaterThan(0.5);
        expect(coverage(frames[small - 1]!, isMagenta).share).toBeGreaterThan(0.4);
        expectNoMainWindow(frames);
        yield* service.quit({ threadId, save: false, discard: true });
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(!canDecode)(
    "File > Open's browser floats in front and Esc returns, and Preferences floats and its close button closes it",
    () =>
      Effect.gen(function* () {
        const { service, layoutWhen } = yield* launch("floating-browser", undefined, {
          markMain: true,
        });
        const recording = yield* recordStream(service);
        const { units } = recording;
        const first = yield* layoutWhen(withStrip);
        const { operator, keys, click } = yield* takeControl(service);
        yield* operator.input({ type: "pointer", x: 640, y: 330 });

        yield* keys(KEY_LEFTCTRL, KEY_O);
        yield* layoutWhen((layout) =>
          layout.others.some((window) => window.areas.includes("FILE_BROWSER")),
        );
        yield* keys(KEY_ESC);
        yield* layoutWhen(
          (layout) =>
            layout.others.length === 0 &&
            withStrip(layout) &&
            layout.windows[0]!.pointer === first.windows[0]!.pointer,
        );

        yield* keys(KEY_LEFTCTRL, KEY_COMMA);
        const preferences = yield* layoutWhen((layout) =>
          layout.others.some((window) => window.areas.includes("PREFERENCES")),
        );
        // Centred, so its close button is at the right end of a title bar over it.
        const { width, height } = preferences.others[0]!;
        const left = (1280 - width) / 2;
        const top = (720 - height - TITLE_BAR) / 2;
        yield* click(left + width - 14, top + TITLE_BAR / 2);
        yield* layoutWhen((layout) => layout.others.length === 0 && withStrip(layout));
        yield* framesAfter(recording, units.length);

        const frames = decodeFrames(units);
        expect(frames.length).toBe(units.length);
        expectNoMainWindow(frames);
        yield* service.quit({ threadId, save: false, discard: true });
      }).pipe(Effect.scoped),
  );
});

describe.skipIf(!canHostBlender)("B19: a real hosted Blender's held working copy", () => {
  /** A workspace with cube.blend, and a Blender of this test's own settings. */
  const realHeld = Effect.fn(function* (prefix: string) {
    // Settled until a test makes it active again, as an agent's next turn does.
    const thread = { settled: true };
    const dir = NodeFS.realpathSync(yield* tempDir(prefix));
    const workspace = NodePath.join(dir, "work");
    NodeFS.mkdirSync(workspace, { recursive: true });
    const configHome = NodePath.join(dir, "config");
    const startup = NodePath.join(configHome, "blender", "5.3", "scripts", "startup");
    NodeFS.mkdirSync(startup, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(startup, "t3_test_command.py"), COMMAND_STARTUP_SCRIPT);
    // Its own Blender settings, never the developer's, for the files it writes and reads.
    const background = (args: ReadonlyArray<string>) =>
      NodeChildProcess.execFileSync("blender", ["--background", "--factory-startup", ...args], {
        encoding: "utf8",
        env: { ...process.env, XDG_CONFIG_HOME: configHome },
      });
    background([
      "--python-expr",
      `import bpy; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(NodePath.join(workspace, "cube.blend"))})`,
    ]);
    const objects = (file: string) =>
      background([
        file,
        "--python-expr",
        "import bpy; print('OBJECTS', sorted(o.name for o in bpy.data.objects))",
      ])
        .split("\n")
        .find((line) => line.startsWith("OBJECTS"));
    const service = yield* serviceFor(
      layerFor({
        env: {
          PATH: hostEnvironment.PATH,
          XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
          XDG_CONFIG_HOME: configHome,
          HB_TEST_DIR: dir,
        },
        helper: helperBuild,
        workspaceRoot: workspace,
        baseDir: dir,
        threadSettled: () => thread.settled,
      }),
    );
    const states = yield* Queue.unbounded<HostedBlenderThreadState>();
    yield* service.threadState(threadId).pipe(
      Stream.runForEach((state) => Queue.offer(states, state)),
      Effect.forkScoped,
    );
    const awaitState = (matches: (state: HostedBlenderThreadState) => boolean) =>
      Queue.take(states).pipe(Effect.repeat({ until: matches }));
    const command = (text: string) => {
      NodeFS.writeFileSync(NodePath.join(dir, "command.partial"), text);
      NodeFS.renameSync(NodePath.join(dir, "command.partial"), NodePath.join(dir, "command"));
    };
    // No Blender Lab in these settings, so blender_start says the agent has no access; the
    // copy is made, recorded and opened all the same.
    const blenderStart = startAgentWorkingCopy({ threadId, path: "cube.blend" }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostedBlender.HostedBlender, service),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({ worktreePath: workspace, projectId: "p" } as never),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.ignore,
    );
    const copy = NodePath.join(workspace, workingCopyName("cube.blend", threadId));
    const heldWhen = (done: (list: HostedBlenderHeldList) => boolean) =>
      service.heldCopies.pipe(Stream.filter(done), Stream.runHead, Effect.map(Option.getOrThrow));
    const heldFile = (id: string) =>
      NodePath.join(workspace, ".t3", "held-working-copies", id, "copy.blend");
    const running = (dirty: boolean) => (state: HostedBlenderThreadState) =>
      state.status === "running" && state.dirty === dirty;
    const ended = (state: HostedBlenderThreadState) =>
      state.status !== "running" && state.status !== "starting";
    return {
      thread,
      service,
      awaitState,
      command,
      blenderStart,
      copy,
      heldWhen,
      heldFile,
      objects,
      running,
      ended,
    };
  });

  it.live("a saved working copy leaves the project at settle and comes back with its edit", () =>
    Effect.gen(function* () {
      const {
        thread,
        service,
        awaitState,
        command,
        blenderStart,
        copy,
        heldWhen,
        heldFile,
        objects,
        running,
        ended,
      } = yield* realHeld("real-held-saved");
      yield* blenderStart;
      yield* awaitState(running(false));
      command("edit T3Saved;save");
      yield* awaitState(running(true));
      yield* awaitState(running(false));
      yield* service.closeOnSettle({ threadId });
      yield* awaitState(ended);
      const [held] = yield* heldWhen((list) => list.length === 1);
      expect(NodeFS.existsSync(copy)).toBe(false);
      expect(NodeFS.existsSync(`${copy}1`)).toBe(false);
      expect(objects(heldFile(held!.id))).toContain("T3Saved");

      // The agent's next turn makes the thread active, so its quit leaves the copy in place.
      thread.settled = false;
      yield* blenderStart;
      expect(NodeFS.existsSync(heldFile(held!.id))).toBe(false);
      yield* awaitState(running(false));
      yield* service.quit({ threadId, save: false });
      yield* awaitState(ended);
      expect(objects(copy)).toContain("T3Saved");
    }).pipe(Effect.scoped),
  );

  it.live("an edited working copy comes back from being held with its unsaved changes", () =>
    Effect.gen(function* () {
      const {
        thread,
        service,
        awaitState,
        command,
        blenderStart,
        copy,
        heldWhen,
        heldFile,
        objects,
        running,
        ended,
      } = yield* realHeld("real-held-unsaved");
      yield* blenderStart;
      yield* awaitState(running(false));
      command("edit T3Unsaved");
      yield* awaitState(running(true));
      yield* service.closeOnSettle({ threadId });
      expect(yield* awaitState(ended)).toMatchObject({ status: "closed" });
      const [held] = yield* heldWhen((list) => list.length === 1);
      expect(NodeFS.existsSync(copy)).toBe(false);
      // Held as last saved; the unsaved work is the recovery copy, restored over it.
      expect(objects(heldFile(held!.id))).not.toContain("T3Unsaved");

      thread.settled = false;
      yield* blenderStart;
      expect(NodeFS.existsSync(heldFile(held!.id))).toBe(false);
      yield* awaitState(running(true));
      command("save");
      yield* awaitState(running(false));
      yield* service.quit({ threadId, save: false });
      yield* awaitState(ended);
      expect(objects(copy)).toContain("T3Unsaved");
    }).pipe(Effect.scoped),
  );
});

describe.skipIf(!canHostBlender)("a real hosted Blender's endings", () => {
  it.live(
    "N1: a quit names the file Blender has open, and a discard named for another is refused",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir("real-discard-other");
        const workspace = NodePath.join(dir, "work");
        NodeFS.mkdirSync(workspace, { recursive: true });
        for (const name of ["cube.blend", "other.blend"]) {
          NodeChildProcess.execFileSync("blender", [
            "--background",
            "--factory-startup",
            "--python-expr",
            `import bpy; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(NodePath.join(workspace, name))})`,
          ]);
        }
        const configHome = NodePath.join(dir, "config");
        const startup = NodePath.join(configHome, "blender", "5.3", "scripts", "startup");
        NodeFS.mkdirSync(startup, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(startup, "t3_test_command.py"), COMMAND_STARTUP_SCRIPT);
        const service = yield* serviceFor(
          layerFor({
            env: {
              PATH: hostEnvironment.PATH,
              XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
              XDG_CONFIG_HOME: configHome,
              HB_TEST_DIR: dir,
            },
            helper: helperBuild,
            workspaceRoot: workspace,
            baseDir: dir,
          }),
        );
        const states = yield* Queue.unbounded<HostedBlenderThreadState>();
        yield* service.threadState(threadId).pipe(
          Stream.runForEach((state) => Queue.offer(states, state)),
          Effect.forkScoped,
        );
        const awaitState = (matches: (state: HostedBlenderThreadState) => boolean) =>
          Queue.take(states).pipe(Effect.repeat({ until: matches }));
        const command = (text: string) => {
          NodeFS.writeFileSync(NodePath.join(dir, "command.partial"), text);
          NodeFS.renameSync(NodePath.join(dir, "command.partial"), NodePath.join(dir, "command"));
        };
        const cube = { kind: "workspace", relativePath: "cube.blend" } as const;
        const other = { kind: "workspace", relativePath: "other.blend" } as const;

        yield* service.open({ threadId, relativePath: "cube.blend" });
        command("edit T3Edit");
        expect(
          yield* awaitState((state) => state.status === "running" && state.dirty),
        ).toMatchObject({ relativePath: "cube.blend", openFile: cube });
        expect(NodeFS.readFileSync(NodePath.join(dir, "tempdir"), "utf8")).toContain(dir);
        // File > Open in the pane, then an edit there: the pane now names other.blend.
        command(`open ${NodePath.join(workspace, "other.blend")};edit T3Other`);
        yield* awaitState(
          (state) =>
            state.status === "running" &&
            state.dirty &&
            "openFile" in state &&
            state.openFile?.kind === "workspace" &&
            state.openFile.relativePath === "other.blend",
        );
        // A dialog opened before the switch named cube.blend: its discard is refused, and so
        // is its Save and quit, which would write other.blend.
        const refused = yield* service
          .quit({ threadId, save: false, discard: true, openFile: cube })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("openFileChanged");
        const saveRefused = yield* service
          .quit({ threadId, save: true, openFile: cube })
          .pipe(Effect.flip);
        expect(saveRefused.reason).toBe("openFileChanged");
        expect(
          Option.getOrThrow(yield* Stream.runHead(service.threadState(threadId))),
        ).toMatchObject({ status: "running", openFile: other });
        // Named for the file open now, it discards that file's changes.
        yield* service.quit({ threadId, save: false, discard: true, openFile: other });
        expect(
          yield* awaitState((state) => state.status !== "running" && state.status !== "starting"),
        ).toEqual({ status: "stopped" });
        expect(objectsIn(NodePath.join(workspace, "other.blend"))).not.toContain("T3Other");
      }).pipe(Effect.scoped),
  );

  it.live(
    "R2: a save in Blender after Reopen removes the file's copy, whether it stays open or not",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir("real-save-in-blender");
        const workspace = NodePath.join(dir, "work");
        NodeFS.mkdirSync(workspace, { recursive: true });
        for (const name of ["cube.blend", "other.blend"]) {
          NodeChildProcess.execFileSync("blender", [
            "--background",
            "--factory-startup",
            "--python-expr",
            `import bpy; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(NodePath.join(workspace, name))})`,
          ]);
        }
        const configHome = NodePath.join(dir, "config");
        const startup = NodePath.join(configHome, "blender", "5.3", "scripts", "startup");
        NodeFS.mkdirSync(startup, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(startup, "t3_test_command.py"), COMMAND_STARTUP_SCRIPT);
        const service = yield* serviceFor(
          layerFor({
            env: {
              PATH: hostEnvironment.PATH,
              XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
              XDG_CONFIG_HOME: configHome,
              HB_TEST_DIR: dir,
            },
            helper: helperBuild,
            workspaceRoot: workspace,
            baseDir: dir,
          }),
        );
        const states = yield* Queue.unbounded<HostedBlenderThreadState>();
        yield* service.threadState(threadId).pipe(
          Stream.runForEach((state) => Queue.offer(states, state)),
          Effect.forkScoped,
        );
        const awaitState = (matches: (state: HostedBlenderThreadState) => boolean) =>
          Queue.take(states).pipe(Effect.repeat({ until: matches }));
        const running = (dirty: boolean) => (state: HostedBlenderThreadState) =>
          state.status === "running" && state.dirty === dirty;
        const ended = (state: HostedBlenderThreadState) =>
          state.status !== "running" && state.status !== "starting";
        const command = (text: string) => {
          NodeFS.writeFileSync(NodePath.join(dir, "command.partial"), text);
          NodeFS.renameSync(NodePath.join(dir, "command.partial"), NodePath.join(dir, "command"));
        };
        // Settling an edited cube.blend keeps its copy, which Reopen restores as unsaved work.
        const restoredCopy = Effect.fnUntraced(function* () {
          yield* service.open({ threadId, relativePath: "cube.blend" });
          yield* awaitState(running(false));
          command("edit T3Edit");
          yield* awaitState(running(true));
          yield* service.closeOnSettle({ threadId });
          expect(card(yield* awaitState(ended))).toMatchObject({
            status: "closed",
            relativePath: "cube.blend",
          });
          yield* service.reopen({ threadId, key: CUBE, restore: true });
          yield* awaitState(running(true));
        });

        // Saved in Blender and still open when it ends: nothing is left to offer.
        yield* restoredCopy();
        expect(NodeFS.readFileSync(NodePath.join(dir, "tempdir"), "utf8")).toContain(dir);
        command("edit T3More;save");
        yield* awaitState(running(false));
        yield* service.closeOnSettle({ threadId });
        expect(yield* awaitState(ended)).toEqual({ status: "stopped" });
        expect(objectsIn(NodePath.join(workspace, "cube.blend"))).toContain("T3More");

        // Saved, then another file opened and edited: only that file's copy is kept.
        yield* restoredCopy();
        command("edit T3Again;save");
        yield* awaitState(running(false));
        command(`open ${NodePath.join(workspace, "other.blend")};edit T3Other`);
        yield* awaitState(running(true));
        yield* service.closeOnSettle({ threadId });
        const last = yield* awaitState(ended);
        expect("copies" in last ? last.copies.map((copy) => copy.file) : last).toEqual([
          { kind: "workspace", relativePath: "other.blend" },
        ]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "streams one fresh viewport window, filling the pane, after Blender opens a file saved from a hosted Blender, and after Reopen of its copy",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir("real-open-stored");
        const workspace = NodePath.join(dir, "work");
        NodeFS.mkdirSync(workspace, { recursive: true });
        for (const name of ["cube.blend", "other.blend"]) {
          NodeChildProcess.execFileSync("blender", [
            "--background",
            "--factory-startup",
            "--python-expr",
            `import bpy; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(NodePath.join(workspace, name))})`,
          ]);
        }
        const configHome = NodePath.join(dir, "config");
        const startup = NodePath.join(configHome, "blender", "5.3", "scripts", "startup");
        NodeFS.mkdirSync(startup, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(startup, "t3_test_open.py"), OPENING_STARTUP_SCRIPT);
        const service = yield* serviceFor(
          layerFor({
            env: {
              PATH: hostEnvironment.PATH,
              XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
              XDG_CONFIG_HOME: configHome,
              HB_TEST_DIR: dir,
            },
            helper: helperBuild,
            workspaceRoot: workspace,
            baseDir: dir,
          }),
        );
        const states = yield* Queue.unbounded<HostedBlenderThreadState>();
        yield* service.threadState(threadId).pipe(
          Stream.runForEach((state) => Queue.offer(states, state)),
          Effect.forkScoped,
        );
        const awaitState = (matches: (state: HostedBlenderThreadState) => boolean) =>
          Queue.take(states).pipe(Effect.repeat({ until: matches }), Effect.map(card));
        // The size the stream settles at, asked for 1046x1336, after `then` runs.
        const settledSize = (then: Effect.Effect<void> = Effect.void) =>
          Effect.gen(function* () {
            const attached = yield* service.attachViewer(threadId, { canOperate: false });
            if (attached._tag !== "attached") return attached._tag;
            yield* attached.viewer.resize(1046, 1336);
            yield* then;
            const sizes = Queue.take(attached.viewer.output).pipe(
              Effect.repeat({
                until: (output) => output._tag === "message" && output.message.type === "viewport",
              }),
              Effect.map((output) =>
                output._tag === "message" && output.message.type === "viewport"
                  ? `${output.message.width}x${output.message.height}`
                  : "",
              ),
            );
            let settled = yield* sizes.pipe(Effect.timeoutOption("30 seconds"));
            while (Option.isSome(settled)) {
              const next = yield* sizes.pipe(Effect.timeoutOption("6 seconds"));
              if (Option.isNone(next)) break;
              settled = next;
            }
            return Option.getOrElse(settled, () => "no frames");
          }).pipe(Effect.scoped);

        // other.blend, saved from a hosted Blender of an earlier build, keeps T3's viewport
        // window in its UI, unmarked.
        yield* service.open({ threadId, relativePath: "other.blend" });
        yield* awaitState((state) => state.status === "running");
        NodeFS.writeFileSync(NodePath.join(dir, "unmark"), "");
        yield* fileAppears(dir, NodePath.join(dir, "unmarked"));
        yield* service.quit({ threadId, save: true });
        yield* awaitState((state) => state.status === "stopped");

        yield* service.open({ threadId, relativePath: "cube.blend" });
        yield* awaitState((state) => state.status === "running");
        expect(yield* settledSize()).toBe("1046x1336");
        const opened = Effect.sync(() =>
          NodeFS.writeFileSync(
            NodePath.join(dir, "open-file"),
            NodePath.join(workspace, "other.blend"),
          ),
        );
        expect(yield* settledSize(opened)).toBe("1046x1336");

        yield* service.closeOnSettle({ threadId });
        yield* awaitState((state) => state.status === "closed");
        yield* service.reopen({ threadId, key: OTHER, restore: true });
        expect(yield* settledSize()).toBe("1046x1336");
      }).pipe(Effect.scoped),
  );

  it.live(
    "a master's Reopen of its copy fills the pane, the viewer attached from its first frame",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir("real-master-reopen");
        const workspace = NodePath.join(dir, "work");
        NodeFS.mkdirSync(workspace, { recursive: true });
        NodeChildProcess.execFileSync("blender", [
          "--background",
          "--factory-startup",
          "--python-expr",
          `import bpy; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(NodePath.join(workspace, "cube.blend"))})`,
        ]);
        const configHome = NodePath.join(dir, "config");
        const startup = NodePath.join(configHome, "blender", "5.3", "scripts", "startup");
        NodeFS.mkdirSync(startup, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(startup, "t3_test_edit.py"), EDITING_STARTUP_SCRIPT);
        const switches = yield* Queue.unbounded<HostedBlenderSetup.HostedBlenderReadiness>();
        const host = {
          env: {
            PATH: hostEnvironment.PATH,
            XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
            XDG_CONFIG_HOME: configHome,
            HB_TEST_DIR: dir,
          },
          helper: helperBuild,
          workspaceRoot: workspace,
          baseDir: dir,
          readinessChanges: Stream.fromQueue(switches),
        };
        const service = yield* serviceFor(layerFor(host));
        const masterState = (status: string) =>
          service.masterState(threadId).pipe(
            Stream.filter((state) => state.status === status),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
        // The size the master's stream settles at, asked for 1046x1336 from its first frame.
        const settledSize = Effect.gen(function* () {
          const attached = yield* service.attachViewer(threadId, {
            canOperate: false,
            role: "master",
          });
          if (attached._tag !== "attached") return attached._tag;
          yield* attached.viewer.resize(1046, 1336);
          const sizes = Queue.take(attached.viewer.output).pipe(
            Effect.repeat({
              until: (output) => output._tag === "message" && output.message.type === "viewport",
            }),
            Effect.map((output) =>
              output._tag === "message" && output.message.type === "viewport"
                ? `${output.message.width}x${output.message.height}`
                : "",
            ),
          );
          let settled = yield* sizes.pipe(Effect.timeoutOption("30 seconds"));
          while (Option.isSome(settled)) {
            const next = yield* sizes.pipe(Effect.timeoutOption("6 seconds"));
            if (Option.isNone(next)) break;
            settled = next;
          }
          return Option.getOrElse(settled, () => "no frames");
        }).pipe(Effect.scoped);

        yield* service.openMaster({ threadId, relativePath: "cube.blend" });
        yield* service.masterState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
        );
        expect(NodeFS.existsSync(NodePath.join(dir, "edited"))).toBe(true);
        // Switched off, the master closes into its copy; switched on again, Reopen restores it.
        yield* Queue.offer(switches, { status: "notSetUp", missing: ["enabled"] });
        const closed = yield* masterState("closed");
        yield* Queue.offer(switches, readinessFor(host));
        const key = "copies" in closed ? closed.copies[0].key : "";
        yield* service.reopen({ threadId, key, restore: true, role: "master" });
        expect(yield* settledSize).toBe("1046x1336");
      }).pipe(Effect.scoped),
  );

  it.live(
    "settles into a recovery copy that Reopen restores and saves to the user's file, and crashes into Restart",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir("real-endings");
        const workspace = NodePath.join(dir, "work");
        NodeFS.mkdirSync(workspace, { recursive: true });
        const blendPath = NodePath.join(workspace, "cube.blend");
        NodeChildProcess.execFileSync("blender", [
          "--background",
          "--factory-startup",
          "--python-expr",
          `import bpy; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blendPath)})`,
        ]);
        const configHome = NodePath.join(dir, "config");
        const startup = NodePath.join(configHome, "blender", "5.3", "scripts", "startup");
        NodeFS.mkdirSync(startup, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(startup, "t3_test_edit.py"), EDITING_STARTUP_SCRIPT);
        const service = yield* serviceFor(
          layerFor({
            env: {
              PATH: hostEnvironment.PATH,
              XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
              XDG_CONFIG_HOME: configHome,
              HB_TEST_DIR: dir,
            },
            helper: helperBuild,
            workspaceRoot: workspace,
            baseDir: dir,
          }),
        );
        const states = yield* Queue.unbounded<HostedBlenderThreadState>();
        yield* service.threadState(threadId).pipe(
          Stream.runForEach((state) => Queue.offer(states, state)),
          Effect.forkScoped,
        );
        const awaitState = (matches: (state: HostedBlenderThreadState) => boolean) =>
          Queue.take(states).pipe(Effect.repeat({ until: matches }), Effect.map(card));

        yield* service.open({ threadId, relativePath: "cube.blend" });
        yield* awaitState((state) => state.status === "running" && state.dirty);
        expect(NodeFS.existsSync(NodePath.join(dir, "edited"))).toBe(true);

        // Settling quits without saving; the edit survives only in the recovery copy.
        yield* service.closeOnSettle({ threadId });
        const closed = yield* awaitState((state) => state.status === "closed");
        assert.deepStrictEqual(closed, {
          status: "closed",
          relativePath: "cube.blend",
          recovery: true,
        });
        expect(objectsIn(blendPath)).not.toContain("T3Edit");

        // Reopen restores it as unsaved changes to the user's own file, which saving writes.
        yield* service.reopen({ threadId, key: CUBE, restore: true });
        yield* awaitState((state) => state.status === "running" && state.dirty);
        yield* service.quit({ threadId, save: true });
        yield* awaitState((state) => state.status === "stopped");
        expect(objectsIn(blendPath)).toContain("T3Edit");

        // A crash leaves it stopped, with Restart opening the file as saved.
        yield* service.open({ threadId, relativePath: "cube.blend" });
        yield* awaitState((state) => state.status === "running");
        // The pid Blender itself wrote, in a folder only this test uses.
        process.kill(
          Number(NodeFS.readFileSync(NodePath.join(dir, "blender.pid"), "utf8")),
          "SIGSEGV",
        );
        const crashed = yield* awaitState((state) => state.status === "crashed");
        expect(crashed).toMatchObject({ status: "crashed", relativePath: "cube.blend" });
        yield* service.reopen({ threadId, key: CUBE, restore: false });
        // Blender's own word that the file is clean: a file saved from a restored session reads
        // unsaved as it loads, until Blender handles the load.
        yield* awaitState(
          (state) => state.status === "running" && state.openFile !== undefined && !state.dirty,
        );
        // Quitting without saving keeps nothing new and removes only by Discard.
        yield* service.quit({ threadId, save: false });
        expect(yield* awaitState((state) => state.status === "crashed")).toMatchObject({
          relativePath: "cube.blend",
        });
      }).pipe(Effect.scoped),
  );

  it.live(
    "a slow quit: settling waits for its copy, a shutdown leaves it to finish its copy for the next start; restores run no scripts, and a failed one keeps the copy",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir("real-slow-exit");
        const workspace = NodePath.join(dir, "work");
        NodeFS.mkdirSync(workspace, { recursive: true });
        const blendPath = NodePath.join(workspace, "cube.blend");
        // The file carries a script that would run on load if scripts were allowed.
        NodeChildProcess.execFileSync("blender", [
          "--background",
          "--factory-startup",
          "--python-expr",
          [
            "import bpy",
            "text = bpy.data.texts.new('t3_marker.py')",
            `text.write('import os\\nopen(os.path.join(os.environ["HB_TEST_DIR"], "script-ran"), "w").close()\\n')`,
            "text.use_module = True",
            `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blendPath)})`,
          ].join("; "),
        ]);
        const configHome = NodePath.join(dir, "config");
        const settings = NodePath.join(configHome, "blender", "5.3");
        const startup = NodePath.join(settings, "scripts", "startup");
        NodeFS.mkdirSync(startup, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(startup, "t3_test_edit.py"), EDITING_STARTUP_SCRIPT);
        NodeFS.writeFileSync(NodePath.join(startup, "t3_test_slow.py"), SLOW_EXIT_STARTUP_SCRIPT);
        // Preferences that would let it run: only T3's own setting may keep it off.
        NodeChildProcess.execFileSync(
          "blender",
          [
            "--background",
            "--factory-startup",
            "--python-expr",
            "import bpy; bpy.context.preferences.filepaths.use_scripts_auto_execute = True; bpy.ops.wm.save_userpref()",
          ],
          {
            env: {
              ...Object.fromEntries(
                Object.entries(hostEnvironment).filter(([key]) => !key.startsWith("BLENDER_USER_")),
              ),
              BLENDER_USER_RESOURCES: settings,
              TMPDIR: dir,
            },
            stdio: "ignore",
          },
        );
        const layer = layerFor({
          env: {
            PATH: hostEnvironment.PATH,
            XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
            XDG_CONFIG_HOME: configHome,
            HB_TEST_DIR: dir,
          },
          helper: helperBuild,
          workspaceRoot: workspace,
          baseDir: dir,
        });
        const watch = Effect.fn(function* (service: HostedBlender.HostedBlender["Service"]) {
          const states = yield* Queue.unbounded<HostedBlenderThreadState>();
          yield* service.threadState(threadId).pipe(
            Stream.runForEach((state) => Queue.offer(states, state)),
            Effect.forkScoped,
          );
          return (matches: (state: HostedBlenderThreadState) => boolean) =>
            Queue.take(states).pipe(Effect.repeat({ until: matches }), Effect.map(card));
        });

        const hostedDir = NodePath.join(dir, "userdata", "hosted-blender");
        const before = NodeFS.readFileSync(blendPath);

        // N2: T3 stops while Blender is still writing its quit copy, the only copy of the edit.
        // T3 exits in time; Blender is left to finish, and the user's file is as it was.
        const started = yield* Effect.gen(function* () {
          const first = yield* serviceFor(layer);
          const awaitState = yield* watch(first);
          yield* first.open({ threadId, relativePath: "cube.blend" });
          yield* awaitState((state) => state.status === "running" && state.dirty);
          return yield* Clock.currentTimeMillis;
        }).pipe(Effect.scoped);
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(5_000);
        expect(NodeFS.readFileSync(blendPath).equals(before)).toBe(true);
        expect(objectsIn(blendPath)).not.toContain("T3Edit");

        // The next start offers that copy, whole, once Blender has finished it.
        const service = yield* serviceFor(layer);
        const awaitState = yield* watch(service);
        expect(yield* awaitState((state) => state.status === "closed")).toEqual({
          status: "closed",
          relativePath: "cube.blend",
          recovery: true,
        });
        expect(objectsIn(recoveryOf(hostedDir)!.session)).toContain("T3Edit");

        // Settling waits for the same slow quit, so its copy keeps the edit.
        yield* service.dismiss({ threadId, key: CUBE });
        NodeFS.rmSync(NodePath.join(dir, "edited"), { force: true });
        yield* service.open({ threadId, relativePath: "cube.blend" });
        yield* awaitState((state) => state.status === "running" && state.dirty);
        yield* service.closeOnSettle({ threadId });
        expect(yield* awaitState((state) => state.status === "closed")).toEqual({
          status: "closed",
          relativePath: "cube.blend",
          recovery: true,
        });
        const session = recoveryOf(hostedDir)!.session;
        expect(objectsIn(session)).toContain("T3Edit");

        // Restoring it never runs the file's script.
        yield* service.reopen({ threadId, key: CUBE, restore: true });
        yield* awaitState((state) => state.status === "running" && state.dirty);
        expect(NodeFS.existsSync(NodePath.join(dir, "script-ran"))).toBe(false);

        // A copy Blender can't read is reported and kept, never replaced by the saved file.
        yield* service.closeOnSettle({ threadId });
        yield* awaitState((state) => state.status === "closed");
        NodeFS.writeFileSync(session, "not a blend file");
        yield* service.reopen({ threadId, key: CUBE, restore: true });
        expect(yield* awaitState((state) => state.status === "closed")).toEqual({
          status: "closed",
          relativePath: "cube.blend",
          recovery: true,
          restoreFailed: true,
        });
        expect(NodeFS.readFileSync(session, "utf8")).toBe("not a blend file");
      }).pipe(Effect.scoped),
  );
});

// Blender Lab's MCP add-on (its `mcp` extension folder, version 1.0.3), which a granted launch
// snapshots from the user's Blender. Its source isn't in this repo; set this to run the cases.
const blenderLabAddon = hostEnvironment.T3_TEST_BLENDER_LAB_MCP;
const canGrantAgents =
  canHostBlender &&
  blenderLabAddon !== undefined &&
  NodeFS.existsSync(NodePath.join(blenderLabAddon, "blender_manifest.toml"));

/** One call as an agent's Blender Lab MCP server makes it: JSON, then NUL, answered alike. */
const agentCall = (port: number, code: string) =>
  Effect.promise(
    () =>
      new Promise<{
        readonly status?: string;
        readonly message?: string;
        readonly result?: unknown;
      }>((resolve) => {
        const socket = NodeNet.connect(port, "127.0.0.1");
        let received = Buffer.alloc(0);
        socket.on("connect", () =>
          socket.write(`${JSON.stringify({ type: "execute", code, strict_json: false })}\0`),
        );
        socket.on("data", (chunk) => {
          received = Buffer.concat([received, chunk]);
          const end = received.indexOf(0);
          if (end < 0) return;
          socket.destroy();
          resolve(JSON.parse(received.subarray(0, end).toString("utf8")));
        });
        socket.on("error", (error) => resolve({ status: "unreachable", message: error.message }));
        socket.on("close", () => resolve({ status: "closed" }));
      }),
  );

// Rewrites the file named second with the one named first, a slice every 100 ms, as another
// program saving a large file does; "writing" and "written" in the folder named third mark it.
const SLOW_WRITER = String.raw`
import os, sys, time
source, target, folder = sys.argv[1:4]
data = open(source, "rb").read()
with open(target, "wb") as out:
    open(os.path.join(folder, "writing"), "w").close()
    step = max(1, len(data) // 30)
    for start in range(0, len(data), step):
        out.write(data[start:start + step])
        out.flush()
        time.sleep(0.1)
open(os.path.join(folder, "written"), "w").close()
`;

// Drives an asset browser in Blender's main window from HB_TEST_DIR/command, one word a tick
// ("assets", "local", "catalog", "files", "save-catalogs"), and writes what it shows to
// report.json.
const CATALOG_STARTUP_SCRIPT = `import json, os
import bpy

_queue = []

def _browser(window):
    return next((area for area in window.screen.areas if area.type == "FILE_BROWSER"), None)

def _report(folder, window):
    area = _browser(window)
    report = {"dirty": bool(bpy.data.is_dirty), "ui": area.ui_type if area else None,
              "library": None, "editable": None, "unsaved": None}
    if area is not None and area.ui_type == "ASSETS" and area.spaces.active.params is not None:
        report["library"] = area.spaces.active.params.asset_library_reference
        with bpy.context.temp_override(window=window, area=area, space_data=area.spaces.active):
            report["editable"] = bool(bpy.ops.asset.catalog_new.poll())
            report["unsaved"] = bool(bpy.ops.asset.catalogs_save.poll())
    with open(os.path.join(folder, "report.json.part"), "w") as out:
        json.dump(report, out)
    os.replace(os.path.join(folder, "report.json.part"), os.path.join(folder, "report.json"))

def _poll():
    folder = os.environ.get("HB_TEST_DIR", "")
    window = bpy.context.window_manager.windows[0]
    command_path = os.path.join(folder, "command")
    if os.path.exists(command_path):
        _queue.extend(open(command_path).read().split(";"))
        os.remove(command_path)
    if _queue:
        verb = _queue.pop(0)
        area = _browser(window)
        if verb == "assets":
            if area is None:
                area = next(area for area in window.screen.areas if area.type == "DOPESHEET_EDITOR")
                area.type = "FILE_BROWSER"
            area.ui_type = "ASSETS"
        elif verb == "files":
            area.ui_type = "FILES"
        elif verb == "local":
            area.spaces.active.params.asset_library_reference = "LOCAL"
        else:
            with bpy.context.temp_override(window=window, area=area, space_data=area.spaces.active):
                if verb == "catalog":
                    bpy.ops.asset.catalog_new()
                elif verb == "save-catalogs":
                    bpy.ops.asset.catalogs_save()
    _report(folder, window)
    return 0.2

def register():
    bpy.app.timers.register(_poll, first_interval=1.0, persistent=True)

def unregister():
    pass
`;

describe.skipIf(!canHostBlender)("a real hosted Blender's agent access and its endings", () => {
  /** A file in `work`, and a host whose settings hold `startup` scripts and Blender Lab. */
  const realHost = Effect.fn(function* (
    prefix: string,
    startup: Readonly<Record<string, string>> = {},
  ) {
    const dir = yield* tempDir(prefix);
    const workspace = NodePath.join(dir, "work");
    NodeFS.mkdirSync(workspace, { recursive: true });
    NodeChildProcess.execFileSync("blender", [
      "--background",
      "--factory-startup",
      "--python-expr",
      `import bpy; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(NodePath.join(workspace, "cube.blend"))})`,
    ]);
    const configHome = NodePath.join(dir, "config");
    const settings = NodePath.join(configHome, "blender", "5.3");
    const scripts = NodePath.join(settings, "scripts", "startup");
    NodeFS.mkdirSync(scripts, { recursive: true });
    for (const [name, source] of Object.entries(startup)) {
      NodeFS.writeFileSync(NodePath.join(scripts, name), source);
    }
    if (blenderLabAddon !== undefined) {
      NodeFS.cpSync(
        blenderLabAddon,
        NodePath.join(settings, "extensions", "lab_blender_org", "mcp"),
        { recursive: true },
      );
    }
    const agentPort = yield* Effect.flatMap(NetService.NetService, (net) =>
      net.reserveLoopbackPort(),
    ).pipe(Effect.provide(NetService.layer));
    const accessEnded = yield* Queue.unbounded<{
      readonly threadId: ThreadId;
      readonly role: HostedBlenderAgents.HostedBlenderRole;
      readonly grant: string;
    }>();
    const host = {
      env: {
        PATH: hostEnvironment.PATH,
        XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
        XDG_CONFIG_HOME: configHome,
        HB_TEST_DIR: dir,
      },
      helper: helperBuild,
      workspaceRoot: workspace,
      baseDir: dir,
      agentPort,
      accessEnded,
    };
    const command = (text: string) => {
      NodeFS.writeFileSync(NodePath.join(dir, "command.partial"), text);
      NodeFS.renameSync(NodePath.join(dir, "command.partial"), NodePath.join(dir, "command"));
    };
    return { dir, workspace, host, agentPort, accessEnded, command };
  });

  /** The agent's own Blender on the working copy, its Blender Lab listener up. */
  const agentBlender = Effect.fn(function* (service: HostedBlender.HostedBlender["Service"]) {
    yield* service.open({ threadId, relativePath: "cube.blend" }, { agentWorkingCopy: true });
    yield* service.threadState(threadId).pipe(
      Stream.filter((state) => state.status === "running"),
      Stream.runHead,
    );
    expect((yield* service.agentListener(threadId, { wait: true }))?.state).toBe("ready");
  });

  const ended = (service: HostedBlender.HostedBlender["Service"]) =>
    service.threadState(threadId).pipe(
      Stream.filter((state) => state.status !== "running" && state.status !== "starting"),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.map(card),
    );

  it.live.skipIf(!canGrantAgents)(
    "S3: refuses the agent while another program is still writing the .blend, and runs it on the file once written",
    () =>
      Effect.gen(function* () {
        const { dir, workspace, host, agentPort } = yield* realHost("real-agent-writing");
        const newer = NodePath.join(dir, "newer.blend");
        NodeChildProcess.execFileSync("blender", [
          "--background",
          "--factory-startup",
          "--python-expr",
          `import bpy; bpy.context.scene.collection.objects.link(bpy.data.objects.new("T3Outside", None)); bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(newer)})`,
        ]);
        const service = yield* serviceFor(layerFor(host));
        yield* agentBlender(service);
        const code = `import os, bpy\nopen(os.path.join(${JSON.stringify(dir)}, "ran"), "a").write("x")\nresult = {"objects": sorted(o.name for o in bpy.data.objects)}`;

        const writer = NodeChildProcess.spawn(python, [
          "-c",
          SLOW_WRITER,
          newer,
          NodePath.join(workspace, "cube.blend"),
          dir,
        ]);
        yield* Effect.addFinalizer(() => Effect.sync(() => writer.kill()));
        yield* fileAppears(dir, NodePath.join(dir, "writing"));
        const refused = yield* agentCall(agentPort, code);
        expect(NodeFS.existsSync(NodePath.join(dir, "written"))).toBe(false);
        expect(refused.status).toBe("error");
        expect(refused.message).toMatch(/still being written/);
        expect(NodeFS.existsSync(NodePath.join(dir, "ran"))).toBe(false);

        // Written and settled, the next call loads the file first and runs on it.
        yield* fileAppears(dir, NodePath.join(dir, "written"));
        const ran = yield* agentCall(agentPort, code).pipe(
          Effect.filterOrFail(
            (reply) => reply.status === "ok",
            (reply) => reply,
          ),
          Effect.retry({
            while: (reply) => reply.status === "error",
            // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- T3's word that the write settled reaches Blender in its own time, with no event here to await.
            schedule: Schedule.spaced("500 millis"),
            times: 20,
          }),
        );
        expect(ran.result).toMatchObject({ objects: expect.arrayContaining(["T3Outside"]) });
        expect(NodeFS.readFileSync(NodePath.join(dir, "ran"), "utf8")).toBe("x");
        yield* service.quit({ threadId, save: false, discard: true });
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(!canGrantAgents)(
    "ends the agent's access as revoked, never as a lost connection, when T3 closes its Blender or stops",
    () =>
      Effect.gen(function* () {
        const { host, agentPort, accessEnded } = yield* realHost("real-agent-revoked");
        /** Every `ended` the agent could read from now until Blender is gone. */
        const watchEnded = (service: HostedBlender.HostedBlender["Service"]) => {
          const seen: Array<string | null> = [];
          const done = service.agentListener(threadId, { wait: false }).pipe(
            Effect.tap((report) => Effect.sync(() => seen.push(report?.ended ?? null))),
            Effect.repeat({
              until: (report) => report === null,
              // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- T3 publishes nothing as Blender's connection drops; each tick's read is what an agent could see.
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.catchCause(() => Effect.void),
          );
          return { seen, done };
        };

        // Settled: T3 closes it.
        const service = yield* serviceFor(layerFor(host));
        yield* agentBlender(service);
        const closing = watchEnded(service);
        const watching = yield* closing.done.pipe(Effect.forkChild);
        yield* service.closeOnSettle({ threadId });
        yield* Queue.take(accessEnded);
        expect(yield* ended(service)).toEqual({ status: "stopped" });
        yield* Fiber.join(watching);
        expect(closing.seen).toContain("revoked");
        expect(closing.seen.filter((value) => value !== null && value !== "revoked")).toEqual([]);
        expect((yield* agentCall(agentPort, "result = {}")).status).not.toBe("ok");

        // T3 stops with the agent's Blender running.
        const stopping = yield* Effect.gen(function* () {
          const first = yield* serviceFor(layerFor(host));
          yield* agentBlender(first);
          const watched = watchEnded(first);
          yield* watched.done.pipe(Effect.forkDetach);
          return watched.seen;
        }).pipe(Effect.scoped);
        expect(stopping).toContain("revoked");
        expect(stopping.filter((value) => value !== null && value !== "revoked")).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(!canGrantAgents)(
    "Save and quit with the agent's call still running keeps the quit copy, and without one ends saved",
    () =>
      Effect.gen(function* () {
        const { dir, workspace, host, agentPort } = yield* realHost("real-agent-save-quit");
        const service = yield* serviceFor(layerFor(host));
        const hostedDir = NodePath.join(dir, "userdata", "hosted-blender");

        // The agent's edit, finished: Save and quit writes it and keeps nothing.
        yield* agentBlender(service);
        const edit = yield* agentCall(
          agentPort,
          `import bpy\nbpy.context.scene.collection.objects.link(bpy.data.objects.new("T3Agent", None))\nresult = {}`,
        );
        expect(edit.status).toBe("ok");
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
        );
        yield* service.quit({ threadId, save: true });
        expect(yield* ended(service)).toEqual({ status: "stopped" });
        expect(objectsIn(NodePath.join(workspace, "cube.blend"))).toContain("T3Agent");
        expect(recoveryOf(hostedDir)).toBeNull();

        // A call whose deferred part can still write when the save lands: Blender is unsaved
        // again as it quits, so its quit copy is kept.
        yield* agentBlender(service);
        const release = NodePath.join(dir, "release");
        const deferred = yield* agentCall(
          agentPort,
          `import os\nopen(os.path.join(${JSON.stringify(dir)}, "deferred"), "w").close()\ndef check_is_finished():\n    return {"status": "ok"} if os.path.exists(${JSON.stringify(release)}) else None\n`,
        ).pipe(Effect.forkChild);
        yield* fileAppears(dir, NodePath.join(dir, "deferred"));
        yield* service.quit({ threadId, save: true });
        expect(yield* ended(service)).toEqual({
          status: "closed",
          relativePath: "cube.blend",
          recovery: true,
        });
        expect(objectsIn(recoveryOf(hostedDir)!.session)).toContain("T3Agent");
        NodeFS.writeFileSync(release, "");
        expect((yield* Fiber.join(deferred)).status).not.toBe("ok");
      }).pipe(Effect.scoped),
  );

  it.live(
    "keeps the master open after a catalog edit whose asset browser became a File Browser, and quits it once they are saved",
    () =>
      Effect.gen(function* () {
        const { dir, host, command } = yield* realHost("real-master-catalogs", {
          "t3_test_catalogs.py": CATALOG_STARTUP_SCRIPT,
        });
        const service = yield* serviceFor(layerFor(host));
        type Report = {
          readonly dirty: boolean;
          readonly ui: string | null;
          readonly library: string | null;
          readonly editable: boolean | null;
          readonly unsaved: boolean | null;
        };
        const reportPath = NodePath.join(dir, "report.json");
        const read = (): Report | null =>
          NodeFS.existsSync(reportPath)
            ? JSON.parse(NodeFS.readFileSync(reportPath, "utf8"))
            : null;
        const reportWhen = (matches: (report: Report) => boolean) =>
          fileAppears(dir, reportPath, () => {
            const report = read();
            return report !== null && matches(report);
          }).pipe(Effect.map(() => read()!));
        const masterStatus = service.masterState(threadId).pipe(
          Stream.runHead,
          Effect.map((state) => Option.getOrThrow(state).status),
        );

        yield* service.openMaster({ threadId, relativePath: "cube.blend" });
        yield* service.masterState(threadId).pipe(
          Stream.filter((state) => state.status === "running"),
          Stream.runHead,
        );
        command("assets;local");
        const shown = yield* reportWhen((report) => report.editable === true).pipe(
          Effect.timeoutOption("30 seconds"),
        );
        expect(Option.getOrElse(shown, () => read())).toMatchObject({
          library: "LOCAL",
          editable: true,
          unsaved: false,
        });
        command("catalog");
        expect(yield* reportWhen((report) => report.unsaved === true)).toMatchObject({
          dirty: false,
        });
        command("files");
        yield* reportWhen((report) => report.ui === "FILES");
        yield* service.releaseMaster(threadId);
        expect(yield* masterStatus).toBe("running");

        // Back in an asset browser and saved, nothing holds it.
        command("assets");
        expect(yield* reportWhen((report) => report.editable === true)).toMatchObject({
          unsaved: true,
        });
        command("save-catalogs");
        yield* reportWhen((report) => report.editable === true && report.unsaved === false);
        yield* service.releaseMaster(threadId);
        yield* service.masterState(threadId).pipe(
          Stream.filter((state) => state.status === "none"),
          Stream.runHead,
        );
      }).pipe(Effect.scoped),
  );

  it.live("keeps a restored copy unsaved when it would save to where its workspace was", () =>
    Effect.gen(function* () {
      const { dir, workspace, host } = yield* realHost("real-restore-moved", {
        "t3_test_edit.py": EDITING_STARTUP_SCRIPT,
      });
      const hostedDir = NodePath.join(dir, "userdata", "hosted-blender");
      yield* Effect.gen(function* () {
        const service = yield* serviceFor(layerFor(host));
        yield* service.open({ threadId, relativePath: "cube.blend" });
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
        );
        yield* service.closeOnSettle({ threadId });
        expect(yield* ended(service)).toMatchObject({ status: "closed", recovery: true });
      }).pipe(Effect.scoped);
      const kept = recoveryOf(hostedDir)!;
      const keptBytes = NodeFS.readFileSync(kept.session);

      // The thread's worktree moved; the copy still names the file where it was.
      const moved = NodePath.join(dir, "moved");
      NodeFS.renameSync(workspace, moved);
      const service = yield* serviceFor(layerFor({ ...host, workspaceRoot: moved }));
      expect(yield* firstState(service)).toEqual({
        status: "closed",
        relativePath: "cube.blend",
        recovery: true,
      });
      yield* service.reopen({ threadId, key: CUBE, restore: true });
      expect(yield* ended(service)).toEqual({
        status: "closed",
        relativePath: "cube.blend",
        recovery: true,
        restoreFailed: true,
      });
      expect(NodeFS.readFileSync(recoveryOf(hostedDir)!.session).equals(keptBytes)).toBe(true);
      expect(NodeFS.existsSync(workspace)).toBe(false);
    }).pipe(Effect.scoped),
  );
});

// Records Blender's command line, then shows the viewport window and waits to be asked to quit.
const ARGS_HELPER = String.raw`
import json, os, struct, sys
with open(os.environ["STANDIN_ARGS"], "w") as log:
    log.write("\n".join(sys.argv[1:]))
with open(os.environ["STANDIN_ARGS"] + ".launches", "a") as log:
    log.write("launch\n")
def event(value):
    data = json.dumps(value).encode()
    sys.stdout.buffer.write(struct.pack(">IB", len(data) + 1, 1) + data)
    sys.stdout.buffer.flush()
event({"type": "ready", "capture": "extImageCopyCapture", "target": "window",
       "encoder": "x264enc", "width": 1280, "height": 720, "cursorTracking": True})
event({"type": "windowCaptured", "title": "3D Viewport"})
# Answers the control socket as the add-on would: its listener, and what T3 asks of it.
import socket, threading
t3 = sys.argv[sys.argv.index("--t3-control"):]
# Like the add-on: starting until T3's grant, then ready.
listener = ["starting" if "--t3-mcp-listen" in t3 else "off"]
blend = next(arg for arg in sys.argv if arg.endswith(".blend"))
def control():
    # STANDIN_CONTROL_GATE: T3 can't reach the add-on until the test creates this file.
    gate = os.environ.get("STANDIN_CONTROL_GATE")
    while gate and not os.path.exists(gate):
        threading.Event().wait(0.05)
    server = socket.socket(socket.AF_UNIX)
    server.bind(t3[1])
    server.listen(1)
    connection, _ = server.accept()
    def state(filepath, dirty=os.environ.get("STANDIN_DIRTY") == "1", **extra):
        connection.sendall((json.dumps({"type": "state", "filepath": filepath, "dirty": dirty,
                                        "agentListener": listener[0], **extra}) + "\n").encode())
    after = os.environ.get("STANDIN_AFTER")
    if after == "echoTimeline":
        # As the add-on greets T3, which sends its words on connecting once it reads this.
        connection.sendall((json.dumps({"type": "hello", "pid": os.getpid()}) + "\n").encode())
    # Another file already open by the time T3 hears, claiming its listener is ready.
    if after == "otherFileFirst":
        listener[0] = "ready"
        state(os.environ.get("STANDIN_OTHER", "/elsewhere/other.blend"))
    else:
        # As the add-on does once a restore T3 asked for has run.
        state(blend, **({"restore": "ok"} if "--t3-recover" in t3 else {}))
    if after == "viewportWords":
        # A viewport window announced after the hidden display already captured another.
        state(blend, viewport=1)
    for line in connection.makefile():
        with open(os.environ["STANDIN_ARGS"] + ".control", "a") as log:
            log.write(line)
        kind = json.loads(line).get("type")
        if kind == "grantAgentListener" and listener[0] == "starting" and after == "untested":
            # The add-on found a Blender Lab version T3 hasn't tested and never enabled it.
            listener[0] = "untested"
            state(blend, mcpVersion="1.1.0")
            continue
        if kind == "grantAgentListener" and listener[0] == "starting":
            # Blender Lab's listener: answers "pong" to anything, on the port T3 gave it.
            mcp = socket.socket()
            mcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            mcp.bind(("127.0.0.1", int(t3[t3.index("--t3-mcp-port") + 1])))
            mcp.listen(8)
            def answer():
                def serve(client):
                    if client.recv(64):
                        client.sendall(b"pong")
                    client.close()
                while True:
                    client, _ = mcp.accept()
                    threading.Thread(target=serve, args=(client,), daemon=True).start()
            threading.Thread(target=answer, daemon=True).start()
            listener[0] = "ready"
            state(blend, agentActing=after in ("acting", "staleActing"), mcpVersion="1.0.3")
            if after == "otherFile":
                # Someone opens another file through Blender's own UI.
                state(os.environ.get("STANDIN_OTHER", "/elsewhere/other.blend"))
        command = json.loads(line)
        if after == "viewportWords" and kind == "viewportExpected":
            # The window T3 now expects opens, and the hidden display captures it.
            event({"type": "windowCaptured", "title": "3D Viewport"})
        if after == "viewportWords" and kind == "viewportShown" and not os.path.exists(os.environ["STANDIN_ARGS"] + ".waited"):
            # As if the word went missing: still whole, still waiting.
            open(os.environ["STANDIN_ARGS"] + ".waited", "w").close()
            state(blend, viewport=1, viewportWaiting=True)
        if kind == "timeline" and after == "echoTimeline":
            # Answers each Timeline switch with a state T3 publishes: unsaved while it's off.
            state(blend, dirty=not command["shown"])
        if kind == "quit" and command.get("save"):
            # As Blender does: saved, then quitting, reading no more commands (T3's stop
            # included) while it writes its quit copy and exits.
            import time
            for reply in ({"type": "saving"}, {"type": "saved", "filepath": blend, "dirty": False}):
                connection.sendall((json.dumps(dict(reply, id=command.get("id"))) + "\n").encode())
            if after == "offAfterSaved":
                # The add-on ended the grant on saving; its next state says the listener is off,
                # then (dirty again) marks that T3 has read both.
                listener[0] = "off"
                state(blend)
                state(blend, dirty=True)
                while not os.path.exists(os.environ["STANDIN_ARGS"] + ".hold"):
                    time.sleep(0.02)
            time.sleep(0.3)
            event({"type": "exited", "process": "blender", "code": 0, "signal": None})
            os._exit(0)
        if kind == "stopAgentListener" and after == "holdOnStop":
            # Quitting: its connection drops at once, but it is gone only once the test says.
            connection.shutdown(socket.SHUT_RDWR)
            import time
            while not os.path.exists(os.environ["STANDIN_ARGS"] + ".hold"):
                time.sleep(0.02)
            event({"type": "exited", "process": "blender", "code": 0, "signal": None})
            os._exit(0)
        if kind == "stopAgentListener" and after == "acting":
            listener[0] = "off"
            state(blend, agentActing=False, mcpVersion="1.0.3")
            continue
        if kind == "stopAgentListener" and after == "staleActing":
            # A report Blender queued before it heard the stop, with a change T3 does publish.
            connection.sendall((json.dumps({"type": "state", "filepath": blend, "dirty": True,
                                            "agentListener": "ready", "agentActing": True}) + "\n").encode())
            continue
        if kind == "stopAgentListener" and os.environ.get("STANDIN_STAY_ON_STOP") == "1":
            # As the add-on does: access ends, Blender stays open for what T3 asks next.
            listener[0] = "off"
            continue
        if kind == "stopAgentListener":
            # Gone once it has heard the stop, so a test can wait for the stopped state; it says
            # Blender exited cleanly, as one quit from its own menu does (otherwise, a crash).
            event({"type": "exited", "process": "blender", "code": 0, "signal": None})
            os._exit(0)
        if kind == "cancelQuit":
            cancelled = json.loads(line).get("id")
            def acknowledge():
                # STANDIN_CANCEL_GATE: busy until the test creates this file.
                gate = os.environ.get("STANDIN_CANCEL_GATE")
                while gate and not os.path.exists(gate):
                    threading.Event().wait(0.05)
                if os.environ.get("STANDIN_EXIT_ON_CANCEL") == "1":
                    # The quit it was busy with goes through after all.
                    with open(os.environ["STANDIN_ARGS"] + ".exits", "a") as log:
                        log.write("exit\n")
                    os._exit(0)
                connection.sendall((json.dumps({"type": "quitCancelled", "id": cancelled}) + "\n").encode())
            threading.Thread(target=acknowledge, daemon=True).start()
        if kind == "quitIfClean" and os.environ.get("STANDIN_CRASH_ON_QUIT") == "1":
            # Busy with unsaved work it last autosaved, it crashes before reading the quit.
            state_dir = sys.argv[sys.argv.index("--state-dir") + 1]
            os.makedirs(os.path.join(state_dir, "tmp"), exist_ok=True)
            open(os.path.join(state_dir, "tmp", "cube_%d_autosave.blend" % os.getpid()), "w").write("autosave")
            event({"type": "exited", "process": "blender", "code": None, "signal": 9})
            os._exit(1)
        if kind == "quitIfClean" and os.environ.get("STANDIN_QUIT_SILENT") == "1":
            # Busy: the quit waits in Blender, unanswered, until T3 cancels it.
            continue
        if kind == "quit" and command.get("filepath") is not None and after == "holdsQuit":
            # The person opened another file just before the discard arrived, as the add-on sees.
            connection.sendall((json.dumps({"type": "discardRefused", "id": command.get("id")}) + "\n").encode())
            continue
        if kind == "quit" and not command.get("save") and command.get("hold") and after == "holdsQuit":
            # Unsaved image edits hold it, as the add-on does, and it says so until they're saved.
            connection.sendall((json.dumps({"type": "quitFailed", "reason": "images",
                                            "id": command.get("id")}) + "\n").encode())
            state(blend, quitHeld="images")
            continue
        if kind == "quit" and not command.get("save"):
            # As the add-on does: its last word on the file it has open, then Blender's quit copy.
            open_file = os.environ["STANDIN_OTHER"] if after == "otherFileFirst" else blend
            connection.sendall((json.dumps({"type": "quitting", "filepath": open_file, "id": command.get("id"),
                                            "dirty": os.environ.get("STANDIN_DIRTY") == "1"}) + "\n").encode())
            if after == "holdOnStop":
                # Its connection drops at once, but it is gone only once the test says.
                connection.shutdown(socket.SHUT_RDWR)
                import time
                while not os.path.exists(os.environ["STANDIN_ARGS"] + ".hold"):
                    time.sleep(0.02)
            state_dir = sys.argv[sys.argv.index("--state-dir") + 1]
            os.makedirs(os.path.join(state_dir, "tmp"), exist_ok=True)
            open(os.path.join(state_dir, "tmp", "quit.blend"), "w").write("quit copy %d" % os.getpid())
            event({"type": "exited", "process": "blender", "code": 0, "signal": None})
            os._exit(0)
        if kind == "quitIfClean":
            def exit_now():
                # The same last word as any quit, clean as it was found.
                connection.sendall((json.dumps({"type": "quitting", "filepath": blend, "id": asked,
                                                "dirty": False}) + "\n").encode())
                with open(os.environ["STANDIN_ARGS"] + ".exits", "a") as log:
                    log.write("exit\n")
                os._exit(0)
            asked = json.loads(line).get("id")
            def refuse():
                connection.sendall((json.dumps({"type": "quitRefused", "id": asked}) + "\n").encode())
            # STANDIN_UNSAVED: edits made after the last state T3 heard, so Blender won't quit.
            answer = refuse if os.environ.get("STANDIN_UNSAVED") == "1" else exit_now
            if os.environ.get("STANDIN_SLOW_QUIT") == "1":
                threading.Timer(0.5, answer).start()
            else:
                answer()
threading.Thread(target=control, daemon=True).start()
for line in sys.stdin:
    if '"quit"' in line:
        # Asked to stop Blender, it takes until the test says, as a slow quit does.
        if os.environ.get("STANDIN_AFTER") == "holdOnStop":
            open(os.environ["STANDIN_ARGS"] + ".stopping", "w").close()
            import time
            while not os.path.exists(os.environ["STANDIN_ARGS"] + ".hold"):
                time.sleep(0.02)
        break
`;

describe("The Timeline switch", () => {
  it.live("reaches every running hosted Blender at once, and each launch after", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("timeline-switch");
      const bin = fakeTools(dir);
      NodeFS.writeFileSync(NodePath.join(bin, "helper"), `#!${python}\n${ARGS_HELPER}`, {
        mode: 0o755,
      });
      const runtime = NodePath.join(dir, "run");
      NodeFS.mkdirSync(runtime);
      NodeFS.writeFileSync(NodePath.join(dir, "cube.blend"), "");
      const argsLog = NodePath.join(dir, "args.log");
      const context = yield* Layer.build(
        layerFor({
          env: {
            PATH: bin,
            XDG_RUNTIME_DIR: runtime,
            STANDIN_ARGS: argsLog,
            STANDIN_AFTER: "echoTimeline",
          },
          helper: NodePath.join(bin, "helper"),
          workspaceRoot: dir,
          baseDir: dir,
        }),
      );
      const service = Context.get(context, HostedBlender.HostedBlender);
      const settings = Context.get(context, ServerSettings.ServerSettingsService);
      const states = yield* Queue.unbounded<HostedBlenderThreadState>();
      yield* service.threadState(threadId).pipe(
        Stream.runForEach((state) => Queue.offer(states, state)),
        Effect.forkScoped,
      );
      const awaitShown = (shown: boolean) =>
        Queue.take(states).pipe(
          Effect.repeat({ until: (state) => state.status === "running" && state.dirty === !shown }),
        );
      const args = () => NodeFS.readFileSync(argsLog, "utf8").split("\n");
      const switches = () =>
        (NodeFS.existsSync(`${argsLog}.control`)
          ? NodeFS.readFileSync(`${argsLog}.control`, "utf8")
          : ""
        )
          .split("\n")
          .filter((line) => line.includes('"timeline"'))
          .map((line) => JSON.parse(line).shown);

      // On by default: Blender opens its viewport window with the strip, as the launch says;
      // T3 repeats the switch on connecting only if it changed since.
      yield* service.open({ threadId, relativePath: "cube.blend" });
      // Its first report, clean.
      yield* Queue.take(states).pipe(
        Effect.repeat({
          until: (state) => state.status === "running" && state.openFile !== undefined,
        }),
      );
      expect(args()).toContain("--t3-timeline");
      expect(switches()).toEqual([]);

      // Switched in Settings or the pane's menu: the running Blender hears it, no restart.
      yield* settings.updateSettings({ hostedBlenderTimeline: false });
      yield* awaitShown(false);
      yield* settings.updateSettings({ hostedBlenderTimeline: true });
      yield* awaitShown(true);
      // The pane's menu writes the same setting.
      yield* service.setTimeline(false);
      yield* awaitShown(false);
      yield* service.setTimeline(true);
      yield* awaitShown(true);
      expect(switches()).toEqual([false, true, false, true]);
      expect(NodeFS.readFileSync(`${argsLog}.launches`, "utf8")).toBe("launch\n");

      // The next launch starts as the switch was left.
      yield* service.quit({ threadId, save: false, discard: true });
      yield* service.setTimeline(false);
      yield* service.open({ threadId, relativePath: "cube.blend" });
      yield* Queue.take(states).pipe(
        Effect.repeat({ until: (state) => state.status === "running" }),
      );
      expect(args()).not.toContain("--t3-timeline");
      expect((yield* settings.getSettings).hostedBlenderTimeline).toBe(false);
    }).pipe(Effect.scoped),
  );
});

describe("The Timeline switch, one word at a time", () => {
  it.live("S6: a read overtaken by a newer switch never leaves Blender on the older one", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("timeline-order");
      const bin = fakeTools(dir);
      NodeFS.writeFileSync(NodePath.join(bin, "helper"), `#!${python}\n${ARGS_HELPER}`, {
        mode: 0o755,
      });
      const runtime = NodePath.join(dir, "run");
      NodeFS.mkdirSync(runtime);
      NodeFS.writeFileSync(NodePath.join(dir, "cube.blend"), "");
      const argsLog = NodePath.join(dir, "args.log");
      const gate = NodePath.join(dir, "control-gate");
      // Reads pass until armed; armed, the next one waits after reading until released.
      const armed = {
        hold: null as Deferred.Deferred<void> | null,
        reached: yield* Deferred.make<void>(),
      };
      const afterSettingsRead = Effect.suspend(() => {
        const hold = armed.hold;
        if (hold === null) return Effect.void;
        armed.hold = null;
        return Deferred.succeed(armed.reached, undefined).pipe(
          Effect.andThen(Deferred.await(hold)),
        );
      });
      const context = yield* Layer.build(
        layerFor({
          env: {
            PATH: bin,
            XDG_RUNTIME_DIR: runtime,
            STANDIN_ARGS: argsLog,
            STANDIN_AFTER: "echoTimeline",
            STANDIN_CONTROL_GATE: gate,
          },
          helper: NodePath.join(bin, "helper"),
          workspaceRoot: dir,
          baseDir: dir,
          afterSettingsRead,
        }),
      );
      const service = Context.get(context, HostedBlender.HostedBlender);
      const settings = Context.get(context, ServerSettings.ServerSettingsService);
      const words = () =>
        (NodeFS.existsSync(`${argsLog}.control`)
          ? NodeFS.readFileSync(`${argsLog}.control`, "utf8")
          : ""
        )
          .split("\n")
          .filter((line) => line.includes('"timeline"'))
          .map((line) => JSON.parse(line).shown);

      // Launched on; switched off before T3 reaches Blender.
      yield* service.open({ threadId, relativePath: "cube.blend" });
      yield* fileAppears(dir, argsLog);
      expect(NodeFS.readFileSync(argsLog, "utf8")).toContain("--t3-timeline");
      yield* settings.updateSettings({ hostedBlenderTimeline: false });
      // T3's read on connecting sees off, and is held there.
      const hold = yield* Deferred.make<void>();
      armed.hold = hold;
      NodeFS.writeFileSync(gate, "");
      yield* Deferred.await(armed.reached);
      // A newer switch on arrives meanwhile; then the held read goes on.
      yield* settings.updateSettings({ hostedBlenderTimeline: true });
      // A path that writes it at once does so now, ahead of the held one; one ordered path holds
      // it behind, so this wait runs out.
      yield* fileAppears(dir, `${argsLog}.control`, () => words().includes(true)).pipe(
        Effect.timeoutOption("1 second"),
      );
      yield* Deferred.succeed(hold, undefined);
      // Blender answers each word with its state; its last answer is the setting's.
      yield* fileAppears(dir, `${argsLog}.control`, () => words().at(-1) === true);
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && !state.dirty),
        Stream.runHead,
      );
      expect(words().at(-1)).toBe(true);
      expect((yield* settings.getSettings).hostedBlenderTimeline).toBe(true);
    }).pipe(Effect.scoped),
  );
});

describe("The viewport window's strip", () => {
  it.live(
    "S1: is allowed only for a capture heard after T3 expected the window, and again when the add-on still waits",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir("viewport-words");
        const bin = fakeTools(dir);
        NodeFS.writeFileSync(NodePath.join(bin, "helper"), `#!${python}\n${ARGS_HELPER}`, {
          mode: 0o755,
        });
        const runtime = NodePath.join(dir, "run");
        NodeFS.mkdirSync(runtime);
        NodeFS.writeFileSync(NodePath.join(dir, "cube.blend"), "");
        const argsLog = NodePath.join(dir, "args.log");
        const service = yield* serviceFor(
          layerFor({
            env: {
              PATH: bin,
              XDG_RUNTIME_DIR: runtime,
              STANDIN_ARGS: argsLog,
              STANDIN_AFTER: "viewportWords",
            },
            helper: NodePath.join(bin, "helper"),
            workspaceRoot: dir,
            baseDir: dir,
          }),
        );
        const words = () =>
          (NodeFS.existsSync(`${argsLog}.control`)
            ? NodeFS.readFileSync(`${argsLog}.control`, "utf8").split("\n")
            : []
          )
            .filter((line) => line.includes('"viewport'))
            .map((line) => {
              const word = JSON.parse(line);
              return `${word.type} ${word.generation}`;
            });
        yield* service.open({ threadId, relativePath: "cube.blend" });
        yield* fileAppears(dir, `${argsLog}.control`, () => words().length >= 3);
        // The capture from before T3 expected window 1 never stood for it; the one after does,
        // and a report that it still waits gets the word again.
        expect(words()).toEqual(["viewportExpected 1", "viewportShown 1", "viewportShown 1"]);
        yield* service.quit({ threadId, save: false });
      }).pipe(Effect.scoped),
  );
});

describe("Agent access at launch", () => {
  const launch = Effect.fn(function* (
    host: Pick<
      Host,
      "runtimeMode" | "interactionMode" | "agentPort" | "revocations" | "accessEnded"
    >,
    options: { readonly agentWorkingCopy?: boolean; readonly edited?: boolean } = {
      agentWorkingCopy: true,
    },
    after?:
      | "otherFile"
      | "otherFileFirst"
      | "holdOnStop"
      | "holdsQuit"
      | "offAfterSaved"
      | "untested"
      | "acting"
      | "staleActing",
    prepare?: (dir: string) => void,
  ) {
    const dir = yield* tempDir("agent-access");
    prepare?.(dir);
    const bin = fakeTools(dir);
    NodeFS.writeFileSync(NodePath.join(bin, "helper"), `#!${python}\n${ARGS_HELPER}`, {
      mode: 0o755,
    });
    const runtime = NodePath.join(dir, "run");
    NodeFS.mkdirSync(runtime);
    NodeFS.writeFileSync(NodePath.join(dir, "cube.blend"), "");
    const argsLog = NodePath.join(dir, "args.log");
    const service = yield* serviceFor(
      layerFor({
        env: {
          PATH: bin,
          XDG_RUNTIME_DIR: runtime,
          STANDIN_ARGS: argsLog,
          ...(after === undefined ? {} : { STANDIN_AFTER: after }),
          // The agent edited the working copy, so Blender reports it unsaved.
          ...(options.edited ? { STANDIN_DIRTY: "1" } : {}),
        },
        helper: NodePath.join(bin, "helper"),
        workspaceRoot: dir,
        baseDir: dir,
        ...host,
      }),
    );
    yield* service.open(
      { threadId, relativePath: "cube.blend" },
      { agentWorkingCopy: options.agentWorkingCopy === true },
    );
    yield* service.threadState(threadId).pipe(
      Stream.filter((state) => state.status === "running"),
      Stream.runHead,
    );
    const args = NodeFS.readFileSync(argsLog, "utf8").split("\n");
    const controlLog = () =>
      NodeFS.existsSync(`${argsLog}.control`)
        ? NodeFS.readFileSync(`${argsLog}.control`, "utf8")
        : "";
    const lastArgs = () => NodeFS.readFileSync(argsLog, "utf8").split("\n");
    const release = () => NodeFS.writeFileSync(`${argsLog}.hold`, "");
    return { service, args, controlLog, lastArgs, release, argsLog };
  });
  const launchArgs = Effect.fn(function* (
    host: Pick<Host, "runtimeMode" | "interactionMode" | "agentPort">,
    options?: { readonly agentWorkingCopy?: boolean },
  ) {
    const { service, args } = yield* launch(host, options);
    yield* service.quit({ threadId, save: false });
    return args;
  });
  it.live(
    "R3: the agent's blender_start after its own quit without saving restores what it kept",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir("agent-restart");
        const bin = fakeTools(dir);
        NodeFS.writeFileSync(NodePath.join(bin, "helper"), `#!${python}\n${ARGS_HELPER}`, {
          mode: 0o755,
        });
        const runtime = NodePath.join(dir, "run");
        NodeFS.mkdirSync(runtime);
        NodeFS.writeFileSync(NodePath.join(dir, "cube.blend"), "");
        const argsLog = NodePath.join(dir, "args.log");
        const service = yield* serviceFor(
          layerFor({
            env: {
              PATH: bin,
              XDG_RUNTIME_DIR: runtime,
              STANDIN_ARGS: argsLog,
              // Every agent call marks the working copy unsaved.
              STANDIN_DIRTY: "1",
              // Blender stays open when its access ends, as the add-on's does, until it quits.
              STANDIN_STAY_ON_STOP: "1",
            },
            helper: NodePath.join(bin, "helper"),
            workspaceRoot: dir,
            baseDir: dir,
            agentPort: 41234,
          }),
        );
        const blenderStart = startAgentWorkingCopy({ threadId, path: "cube.blend" }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(HostedBlender.HostedBlender, service),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadShell: () =>
                  Effect.succeed({ worktreePath: dir, projectId: "p" } as never),
              }),
              Layer.mock(ProjectService.ProjectService)({}),
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        );
        const first = yield* blenderStart;
        expect(first).not.toHaveProperty("restoredUnsavedChanges");
        // blender_quit({ save: false }): Blender says the copy is unsaved, so its work is kept.
        yield* service.quit({ threadId, save: false });
        const ended = yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "closed"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect("copies" in ended && ended.copies[0].recovery).toBe(true);

        const again = yield* blenderStart;
        expect(again).toMatchObject({ created: false, restoredUnsavedChanges: true });
        expect(NodeFS.readFileSync(argsLog, "utf8").split("\n")).toContain("--t3-recover");
        expect((yield* service.agentListener(threadId))?.state).toBe("ready");
        // A restored launch is granted like any agent launch: the session's first call reaches it.
        expect(
          yield* service.agentGrant({ threadId, role: "working", session: "session-1" }),
        ).toMatchObject({ _tag: "granted", port: 41234 });
        yield* service.quit({ threadId, save: false });
      }).pipe(Effect.scoped),
  );

  it.live("starts the Blender Lab listener on the port the thread's agent session holds", () =>
    Effect.gen(function* () {
      const args = yield* launchArgs({ agentPort: 41234 });
      expect(args).toContain("--t3-mcp-listen");
      expect(args[args.indexOf("--t3-mcp-port") + 1]).toBe("41234");
      expect(yield* launchArgs({})).not.toContain("--t3-mcp-listen");
    }).pipe(Effect.scoped),
  );

  it.live("lets embedded scripts follow the user's setting only in full-access threads", () =>
    Effect.gen(function* () {
      expect(yield* launchArgs({ runtimeMode: "full-access" })).not.toContain("--disable-autoexec");
      for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
        expect(yield* launchArgs({ runtimeMode })).toContain("--disable-autoexec");
      }
      // Plan mode is read-only whatever the runtime mode.
      expect(yield* launchArgs({ runtimeMode: "full-access", interactionMode: "plan" })).toContain(
        "--disable-autoexec",
      );
    }).pipe(Effect.scoped),
  );

  it.live("never listens for the agent in a file the pane opened, even the working copy", () =>
    Effect.gen(function* () {
      const { service, args } = yield* launch({ agentPort: 41234 }, {});
      expect(args).not.toContain("--t3-mcp-listen");
      expect((yield* service.agentListener(threadId))?.state).toBe("off");
      yield* service.quit({ threadId, save: false });
    }).pipe(Effect.scoped),
  );

  it.live(
    "keeps the listener for the launch when a session ends, and closes it when agents are switched off",
    () =>
      Effect.gen(function* () {
        const revoked =
          yield* Queue.unbounded<HostedBlenderAgents.HostedBlenderRevocation | null>();
        const accessEnded = yield* Queue.unbounded<{
          readonly threadId: ThreadId;
          readonly role: HostedBlenderAgents.HostedBlenderRole;
          readonly grant: string;
        }>();
        // Taken one at a time, so the sentinel is taken only once the revocation before it is handled.
        const handled = yield* Deferred.make<void>();
        const { service, controlLog } = yield* launch({
          agentPort: 41234,
          revocations: Stream.fromQueue(revoked).pipe(
            Stream.rechunk(1),
            Stream.tap((revocation) =>
              revocation?.threadId === otherThreadId
                ? Deferred.succeed(handled, undefined)
                : Effect.void,
            ),
          ),
          accessEnded,
        });
        expect((yield* service.agentListener(threadId))?.state).toBe("ready");
        const granted = yield* service.agentGrant({ threadId, role: "working", session: "any" });
        assert(granted._tag === "granted");
        expect(granted.port).toBe(41234);
        // The thread's session ending (an idle release, say) leaves the launch's grant: the next
        // session reaches the same Blender through its own Blender Lab server.
        yield* Queue.offer(revoked, { threadId, session: "session-1" });
        yield* Queue.offer(revoked, { threadId: otherThreadId, session: undefined });
        yield* Deferred.await(handled);
        expect((yield* service.agentListener(threadId, { wait: false }))?.state).toBe("ready");
        expect(controlLog()).not.toContain("stopAgentListener");
        expect(yield* service.agentGrant({ threadId, role: "working", session: "next" })).toEqual(
          granted,
        );
        yield* Queue.offer(revoked, null);
        // Named by this launch, so it never stops a server serving a later one.
        expect(yield* Queue.take(accessEnded)).toEqual({
          threadId,
          role: "working",
          grant: granted.grant,
        });
        expect(
          (yield* service.agentGrant({ threadId, role: "working", session: "next" }))._tag,
        ).toBe("none");
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "stopped"),
          Stream.runHead,
        );
        expect(controlLog().match(/stopAgentListener/g)).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.live("ends the agent's access when T3 closes its Blender, never as a lost connection", () =>
    Effect.gen(function* () {
      const accessEnded = yield* Queue.unbounded<{
        readonly threadId: ThreadId;
        readonly role: HostedBlenderAgents.HostedBlenderRole;
        readonly grant: string;
      }>();
      const { service, release } = yield* launch(
        { agentPort: 41234, accessEnded },
        { agentWorkingCopy: true, edited: true },
        "holdOnStop",
      );
      expect((yield* service.agentListener(threadId))?.state).toBe("ready");
      yield* service.closeOnSettle({ threadId });
      // Blender says it is quitting, which ends the agent's access, and its connection drops as
      // it closes: still revoked, never lost.
      yield* Queue.take(accessEnded);
      expect((yield* service.agentListener(threadId, { wait: false }))?.ended).toBe("revoked");
      release();
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "closed"),
        Stream.runHead,
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "a held quit leaves the agent its access to save what holds it, and the pane says why",
    () =>
      Effect.gen(function* () {
        const { service, controlLog } = yield* launch(
          { agentPort: 41234 },
          { agentWorkingCopy: true },
          "holdsQuit",
        );
        expect((yield* service.agentListener(threadId))?.state).toBe("ready");
        const held = yield* service.quit({ threadId, save: false }).pipe(Effect.flip);
        expect(held.reason).toBe("unsavedImages");
        expect(
          (yield* service.agentGrant({ threadId, role: "working", session: "any" }))._tag,
        ).toBe("granted");
        expect(controlLog()).not.toContain("stopAgentListener");
        const notice = yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && state.quitHeld !== undefined),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(notice).toMatchObject({ status: "running", quitHeld: "images" });
        // Settings' Running Blenders says so too, so its Quit asks first.
        const [listed] = yield* service.runningBlenders.pipe(
          Stream.filter((list) => list[0]?.quitHeld !== undefined),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(listed?.quitHeld).toBe("images");
        // A discard Blender refuses (another file opened meanwhile) leaves the agent its access.
        const refused = yield* service
          .quit({
            threadId,
            save: false,
            discard: true,
            openFile: { kind: "workspace", relativePath: "cube.blend" },
          })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("openFileChanged");
        expect(
          (yield* service.agentGrant({ threadId, role: "working", session: "any" }))._tag,
        ).toBe("granted");
        expect(controlLog()).not.toContain("stopAgentListener");
      }).pipe(Effect.scoped),
  );

  it.live("Save and quit of the agent's Blender ends while Blender quits without waiting", () =>
    Effect.gen(function* () {
      const { service } = yield* launch({ agentPort: 41234 });
      expect((yield* service.agentListener(threadId))?.state).toBe("ready");
      yield* service.quit({ threadId, save: true });
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "stopped"),
        Stream.runHead,
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "Save and quit with the agent's access live ends it as revoked once Blender says it saved, and ends saved, though a report after the save reads unsaved",
    () =>
      Effect.gen(function* () {
        const { service, release, argsLog } = yield* launch(
          { agentPort: 41234 },
          { agentWorkingCopy: true },
          "offAfterSaved",
        );
        expect((yield* service.agentListener(threadId))?.state).toBe("ready");
        const quitting = yield* service.quit({ threadId, save: true }).pipe(Effect.forkChild);
        // Blender still reads unsaved while it ends the agent's grant, before it handles the
        // save's notifier; the save already answered.
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
        );
        expect(yield* service.agentListener(threadId)).toMatchObject({
          state: "off",
          ended: "revoked",
        });
        release();
        yield* Fiber.join(quitting);
        const ended = yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status !== "running"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(card(ended)).toEqual({ status: "stopped" });
        expect(
          recoveryOf(NodePath.join(NodePath.dirname(argsLog), "userdata", "hosted-blender")),
        ).toBeNull();
      }).pipe(Effect.scoped),
  );

  it.live("a shutdown ends the agent's access as revoked, though the connection drops first", () =>
    Effect.gen(function* () {
      const seen = yield* Deferred.make<string | null | undefined>();
      // The shutdown's fast stop ends the held stand-in.
      yield* Effect.gen(function* () {
        const launched = yield* launch({ agentPort: 41234 }, undefined, "holdOnStop");
        expect((yield* launched.service.agentListener(threadId))?.state).toBe("ready");
        // Read once T3 has seen the connection drop and asked the helper to stop Blender.
        yield* fileAppears(NodePath.dirname(launched.argsLog), `${launched.argsLog}.stopping`).pipe(
          Effect.andThen(launched.service.agentListener(threadId, { wait: false })),
          Effect.flatMap((report) => Deferred.succeed(seen, report?.ended)),
          Effect.forkDetach,
        );
      }).pipe(Effect.scoped);
      expect(yield* Deferred.await(seen)).toBe("revoked");
    }).pipe(Effect.scoped),
  );

  it.live("gives a reopened working copy no agent access: it was the person's to reopen", () =>
    Effect.gen(function* () {
      const { service, lastArgs } = yield* launch(
        { agentPort: 41234 },
        { agentWorkingCopy: true, edited: true },
      );
      expect(lastArgs()).toContain("--t3-mcp-listen");
      yield* service.closeOnSettle({ threadId });
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "closed"),
        Stream.runHead,
      );
      yield* service.reopen({ threadId, key: CUBE, restore: true });
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "running"),
        Stream.runHead,
      );
      expect(lastArgs()).not.toContain("--t3-mcp-listen");
      expect((yield* service.agentListener(threadId, { wait: false }))?.state).toBe("off");
    }).pipe(Effect.scoped),
  );

  it.live("closes the listener once Blender opens a file other than the working copy", () =>
    Effect.gen(function* () {
      const { service, controlLog } = yield* launch({ agentPort: 41234 }, undefined, "otherFile");
      // The stand-in exits when it hears the stop.
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "stopped"),
        Stream.runHead,
      );
      expect(controlLog()).toContain("stopAgentListener");
    }).pipe(Effect.scoped),
  );

  it.live("passes on an untested Blender Lab version, which never listens", () =>
    Effect.gen(function* () {
      const { service } = yield* launch({ agentPort: 41234 }, undefined, "untested");
      expect(yield* service.agentListener(threadId)).toMatchObject({
        state: "untested",
        mcpVersion: "1.1.0",
      });
      yield* service.quit({ threadId, save: false });
    }).pipe(Effect.scoped),
  );

  it.live("shows the agent acting while the add-on says so, for the pane's badge", () =>
    Effect.gen(function* () {
      const revoked = yield* Queue.unbounded<HostedBlenderAgents.HostedBlenderRevocation | null>();
      const { service } = yield* launch(
        { agentPort: 41234, revocations: Stream.fromQueue(revoked) },
        undefined,
        "acting",
      );
      const acting = (value: boolean) =>
        service.threadState(threadId).pipe(
          Stream.filter(
            (state) => state.status === "running" && (state.agentActing === true) === value,
          ),
          Stream.runHead,
        );
      expect(Option.getOrThrow(yield* acting(true))).toMatchObject({ agentActing: true });
      // The add-on stops acting once access ends; the published state drops the flag.
      yield* Queue.offer(revoked, null);
      expect(Option.getOrThrow(yield* acting(false))).not.toHaveProperty("agentActing");
      yield* service.quit({ threadId, save: false });
    }).pipe(Effect.scoped),
  );

  it.live("never takes the agent as acting from a report Blender sent before the revoke", () =>
    Effect.gen(function* () {
      const revoked = yield* Queue.unbounded<HostedBlenderAgents.HostedBlenderRevocation | null>();
      const { service } = yield* launch(
        { agentPort: 41234, revocations: Stream.fromQueue(revoked) },
        undefined,
        "staleActing",
      );
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && state.agentActing === true),
        Stream.runHead,
      );
      yield* Queue.offer(revoked, null);
      const dirty = yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && state.dirty),
        Stream.runHead,
      );
      expect(Option.getOrThrow(dirty)).not.toHaveProperty("agentActing");
      yield* service.quit({ threadId, save: false });
    }).pipe(Effect.scoped),
  );

  // The user's own Blender Lab, and T3's settings copy from a launch before it was kept out.
  const withBlenderLab =
    (unreadable = false) =>
    (dir: string) => {
      const mine = NodePath.join(dir, ".config/blender/5.3/extensions/lab_blender_org/mcp");
      NodeFS.mkdirSync(NodePath.join(mine, "tools"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(mine, "blender_manifest.toml"), 'version = "1.0.3"\n');
      NodeFS.writeFileSync(NodePath.join(mine, "__init__.py"), "# Blender Lab\n");
      NodeFS.writeFileSync(NodePath.join(mine, "tools", "execute.py"), "# tool\n");
      if (unreadable) NodeFS.chmodSync(NodePath.join(mine, "tools", "execute.py"), 0o000);
      const resources = NodePath.join(dir, "userdata/hosted-blender/user-resources");
      NodeFS.mkdirSync(NodePath.join(resources, "extensions/lab_blender_org/mcp"), {
        recursive: true,
      });
      NodeFS.mkdirSync(NodePath.join(resources, "config"));
      NodeFS.writeFileSync(NodePath.join(resources, "config", "kept.txt"), "kept");
    };
  const snapshotArg = (args: ReadonlyArray<string>) =>
    args.includes("--t3-mcp-snapshot") ? args[args.indexOf("--t3-mcp-snapshot") + 1] : undefined;

  it.live("keeps Blender Lab out of the settings copy, behind T3's startup gate", () =>
    Effect.gen(function* () {
      let resources = "";
      const { service } = yield* launch({}, {}, undefined, (dir) => {
        withBlenderLab()(dir);
        resources = NodePath.join(dir, "userdata/hosted-blender/user-resources");
      });
      expect(NodeFS.existsSync(NodePath.join(resources, "extensions/lab_blender_org/mcp"))).toBe(
        false,
      );
      expect(NodeFS.readFileSync(NodePath.join(resources, "config", "kept.txt"), "utf8")).toBe(
        "kept",
      );
      expect(
        NodeFS.readFileSync(NodePath.join(resources, "scripts/startup/t3_hosted_gate.py"), "utf8"),
      ).toBe(HOSTED_STARTUP_GATE_SOURCE);
      yield* service.quit({ threadId, save: false });
    }).pipe(Effect.scoped),
  );

  it.live("gives a granted launch a whole private snapshot of Blender Lab, and the pane none", () =>
    Effect.gen(function* () {
      const granted = yield* launch({ agentPort: 41234 }, undefined, undefined, withBlenderLab());
      const snapshot = snapshotArg(granted.args);
      expect(snapshot).toContain(NodePath.join("hosted-blender", "launches"));
      expect(
        NodeFS.readFileSync(NodePath.join(snapshot!, "mcp", "tools", "execute.py"), "utf8"),
      ).toBe("# tool\n");
      yield* granted.service.quit({ threadId, save: false });
      const pane = yield* launch({ agentPort: 41234 }, {}, undefined, withBlenderLab());
      expect(snapshotArg(pane.args)).toBeUndefined();
      yield* pane.service.quit({ threadId, save: false });
    }).pipe(Effect.scoped),
  );

  it.live("gives no snapshot when Blender Lab can't be copied whole", () =>
    Effect.gen(function* () {
      const { service, args } = yield* launch(
        { agentPort: 41234 },
        undefined,
        undefined,
        withBlenderLab(true),
      );
      expect(snapshotArg(args)).toBeUndefined();
      yield* service.quit({ threadId, save: false });
    }).pipe(Effect.scoped),
  );

  it("waits for the control connection as long as Blender may take to start", () => {
    expect(HostedBlender.CONTROL_CONNECT_ATTEMPTS * 200).toBeGreaterThanOrEqual(90_000);
    expect(Duration.toMillis(HostedBlender.AGENT_LISTENER_TIMEOUT)).toBeGreaterThan(90_000);
  });

  it.live("never takes a listener state from a Blender that has another file open", () =>
    Effect.gen(function* () {
      const { service, controlLog } = yield* launch(
        { agentPort: 41234 },
        undefined,
        "otherFileFirst",
      );
      const report = yield* service.agentListener(threadId);
      expect(report).toEqual({
        state: "off",
        ended: "otherFile",
        openFile: "/elsewhere/other.blend",
        mcpVersion: null,
      });
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "stopped"),
        Stream.runHead,
      );
      // The grant waits for a snapshot of the launch file, which never came.
      expect(controlLog()).not.toContain("grantAgentListener");
    }).pipe(Effect.scoped),
  );
});

/** Sends a byte to the loopback port and answers what comes back, or how it failed. */
const onLinux = HostProcess.Platform.defaultValue() === "linux";

const ping = (port: number) =>
  Effect.callback<string>((resume) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    let answer = "";
    socket.on("connect", () => socket.write("x"));
    socket.on("data", (data) => {
      answer += data.toString();
    });
    socket.on("error", (error: NodeJS.ErrnoException) => resume(Effect.succeed(error.code ?? "")));
    socket.on("close", () => resume(Effect.succeed(answer)));
  });

const masterHost = Effect.fn(function* (
  host: Pick<
    Host,
    | "masterPorts"
    | "revocations"
    | "accessEnded"
    | "agentsAllowed"
    | "desktop"
    | "endedSessions"
    | "privatePort"
    | "sessions"
    | "tcpTables"
    | "readinessChanges"
    | "beforeThreadLookup"
  > & {
    /** Blender reports `other.blend` open, beside `cube.blend`, from its first word. */
    readonly otherFileFirst?: boolean;
    /** What Blender reports; T3 hears it once the control connection is up. */
    readonly dirty?: boolean;
    /** Unsaved changes when T3 asks it to quit, whatever it last reported. */
    readonly unsaved?: boolean;
    /** Blender takes a moment to quit, or refuse to, once asked. */
    readonly slowQuit?: boolean;
    /** T3 can't reach the add-on until `openControl` is called. */
    readonly controlGate?: boolean;
    /** A quit waits in Blender unanswered, until T3 cancels it. */
    readonly quitSilent?: boolean;
    /** Blender acknowledges T3's cancel only once `answerCancel` is called. */
    readonly cancelGate?: boolean;
    /** Blender exits once it hears the cancel, as if the quit it was busy with went through. */
    readonly exitOnCancel?: boolean;
    /** Blender crashes, leaving an autosave, before it reads the quit. */
    readonly crashOnQuit?: boolean;
    /** The add-on finds a Blender Lab version T3 hasn't tested and never listens. */
    readonly untested?: boolean;
    /** Lays out the home folder before the service starts, as the user's own Blender Lab. */
    readonly home?: (dir: string) => void;
    /** Blender stays open when its agent's access ends, as the add-on does. */
    readonly stayOnStop?: boolean;
  } = {},
) {
  const dir = yield* tempDir("master");
  host.home?.(dir);
  const bin = fakeTools(dir);
  NodeFS.writeFileSync(NodePath.join(bin, "helper"), `#!${python}\n${ARGS_HELPER}`, {
    mode: 0o755,
  });
  const runtime = NodePath.join(dir, "run");
  NodeFS.mkdirSync(runtime);
  NodeFS.writeFileSync(NodePath.join(dir, "cube.blend"), "");
  NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
  const argsLog = NodePath.join(dir, "args.log");
  const layer = layerFor({
    env: {
      PATH: bin,
      XDG_RUNTIME_DIR: runtime,
      STANDIN_ARGS: argsLog,
      ...(host.otherFileFirst
        ? {
            STANDIN_AFTER: "otherFileFirst",
            STANDIN_OTHER: NodeFS.realpathSync(NodePath.join(dir, "other.blend")),
          }
        : {}),
      ...(host.untested ? { STANDIN_AFTER: "untested" } : {}),
      ...(host.dirty ? { STANDIN_DIRTY: "1" } : {}),
      ...(host.unsaved ? { STANDIN_UNSAVED: "1" } : {}),
      ...(host.slowQuit ? { STANDIN_SLOW_QUIT: "1" } : {}),
      ...(host.quitSilent ? { STANDIN_QUIT_SILENT: "1" } : {}),
      ...(host.cancelGate ? { STANDIN_CANCEL_GATE: NodePath.join(dir, "cancel-gate") } : {}),
      ...(host.exitOnCancel ? { STANDIN_EXIT_ON_CANCEL: "1" } : {}),
      ...(host.crashOnQuit ? { STANDIN_CRASH_ON_QUIT: "1" } : {}),
      ...(host.stayOnStop ? { STANDIN_STAY_ON_STOP: "1" } : {}),
      ...(host.controlGate ? { STANDIN_CONTROL_GATE: NodePath.join(dir, "control-gate") } : {}),
    },
    helper: NodePath.join(bin, "helper"),
    workspaceRoot: dir,
    baseDir: dir,
    ...host,
  });
  const service = yield* serviceFor(layer);
  const read = (suffix: string) =>
    NodeFS.existsSync(`${argsLog}${suffix}`)
      ? NodeFS.readFileSync(`${argsLog}${suffix}`, "utf8")
      : "";
  const masterStatus = (id: ThreadId, status: string) =>
    service.masterState(id).pipe(
      Stream.filter((state) => state.status === status),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  return {
    service,
    layer,
    dir,
    masterStatus,
    openControl: () => NodeFS.writeFileSync(NodePath.join(dir, "control-gate"), ""),
    answerCancel: () => NodeFS.writeFileSync(NodePath.join(dir, "cancel-gate"), ""),
    exits: () => read(".exits").split("\n").length - 1,
    blendPath: NodeFS.realpathSync(NodePath.join(dir, "cube.blend")),
    launches: () => read(".launches").split("\n").length - 1,
    controlLog: () => read(".control"),
    args: () => read("").split("\n"),
  };
});

/** A viewer on the master, whose output says `stopped` once that Blender has quit. */
const watchMaster = Effect.fn(function* (
  service: HostedBlender.HostedBlender["Service"],
  id: ThreadId,
) {
  const attached = yield* service.attachViewer(id, { canOperate: false, role: "master" });
  assert(attached._tag === "attached");
  return Queue.take(attached.viewer.output).pipe(
    Effect.repeat({ until: (output) => output._tag === "stopped" }),
  );
});

describe("Master Blenders", () => {
  it.live("is shared by the threads working on a master and quits when the last one leaves", () =>
    Effect.gen(function* () {
      // It reports unsaved changes, but has none by the time it is asked to quit.
      const host = yield* masterHost({ dirty: true });
      const { service } = host;
      expect(yield* firstMaster(service, threadId)).toEqual({ status: "none" });
      yield* service.openMaster({ threadId, relativePath: "cube.blend" });
      // Its control connection is up once Blender's report arrives.
      yield* service.masterState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && state.dirty),
        Stream.runHead,
      );
      yield* service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" });
      expect(yield* host.masterStatus(otherThreadId, "running")).toEqual({
        status: "running",
        relativePath: "cube.blend",
        dirty: true,
        openFile: { kind: "workspace", relativePath: "cube.blend" },
      });
      expect(host.launches()).toBe(1);
      // A master never shows as the thread's working Blender.
      expect(yield* firstState(service)).toEqual({ status: "stopped" });
      // A master serves threads of every mode, so its embedded scripts never run.
      expect(host.args()).toContain("--disable-autoexec");

      const stopped = yield* watchMaster(service, otherThreadId);
      yield* service.releaseMaster(threadId);
      expect((yield* firstMaster(service, otherThreadId)).status).toBe("running");
      yield* service.releaseMaster(otherThreadId);
      yield* stopped;
      expect(yield* firstMaster(service, otherThreadId)).toEqual({ status: "none" });
    }).pipe(Effect.scoped),
  );

  it.live(
    "N8: a master blender_start only knows starts nothing, joins no other thread's master Blender, and settles into nothing",
    () =>
      Effect.gen(function* () {
        const host = yield* masterHost();
        const { service } = host;
        yield* service.knowMaster({ threadId, relativePath: "cube.blend" });
        // The Master side offers Open in T3 Code; no Blender started for it.
        expect(yield* firstMaster(service, threadId)).toEqual({
          status: "notOpen",
          relativePath: "cube.blend",
          desktop: null,
          desktopDirty: false,
        });
        expect(host.launches()).toBe(0);
        // Another thread's master Blender on the same file is not this thread's to keep.
        yield* service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" });
        yield* host.masterStatus(otherThreadId, "running");
        expect((yield* firstMaster(service, threadId)).status).toBe("notOpen");
        // Known is not chosen: no relay, so the thread's blender-master calls start nothing.
        expect(
          yield* service.agentGrant({ threadId, role: "master", session: "session-1" }),
        ).toMatchObject({ _tag: "none", relativePath: null });
        const stopped = yield* watchMaster(service, otherThreadId);
        yield* service.releaseMaster(otherThreadId);
        yield* stopped;
        // Settled, it was only ever known: nothing starts, and nothing is kept.
        yield* service.closeOnSettle({ threadId });
        yield* service.releaseMaster(threadId);
        expect(yield* firstMaster(service, threadId)).toEqual({ status: "none" });
        expect(host.launches()).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.live(
    "N8: Open in T3 Code on a master only known chooses it and joins the running master Blender",
    () =>
      Effect.gen(function* () {
        const host = yield* masterHost();
        const { service } = host;
        yield* service.knowMaster({ threadId, relativePath: "cube.blend" });
        yield* service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" });
        yield* host.masterStatus(otherThreadId, "running");
        // The Master side's Open in T3 Code, as the preview button and the pane's card do.
        yield* service.reopenMaster(threadId);
        expect((yield* host.masterStatus(threadId, "running")).status).toBe("running");
        expect(host.launches()).toBe(1);
        // Chosen now, it keeps the master Blender open after the other thread leaves.
        yield* service.releaseMaster(otherThreadId);
        expect((yield* firstMaster(service, threadId)).status).toBe("running");
        const stopped = yield* watchMaster(service, threadId);
        yield* service.releaseMaster(threadId);
        yield* stopped;
      }).pipe(Effect.scoped),
  );

  it.live("stays open with unsaved changes after the last thread leaves", () =>
    Effect.gen(function* () {
      const host = yield* masterHost({ dirty: true, unsaved: true });
      const { service } = host;
      yield* service.openMaster({ threadId, relativePath: "cube.blend" });
      yield* service.masterState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && state.dirty),
        Stream.runHead,
      );
      yield* service.releaseMaster(threadId);
      // Still the thread's to see and quit, so nothing is lost or left running unseen.
      expect((yield* firstMaster(service, threadId)).status).toBe("running");
      yield* service.openMaster({ threadId, relativePath: "cube.blend" });
      expect(host.launches()).toBe(1);
      yield* service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped),
  );

  it.live(
    "asks Blender itself, not its last report, before quitting the last thread's master",
    () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const ports = new Map([[threadId, yield* net.reserveLoopbackPort()]]);
        // Reported clean, then edited before T3 asks it to quit.
        const host = yield* masterHost({ masterPorts: ports, unsaved: true });
        const { service } = host;
        yield* service.openMaster(
          { threadId, relativePath: "cube.blend" },
          { agentSession: "session-1" },
        );
        // Ready only once the control connection carried the grant.
        expect((yield* service.agentListener(threadId, { role: "master" }))?.state).toBe("ready");
        expect(yield* firstMaster(service, threadId)).toMatchObject({
          status: "running",
          dirty: false,
        });
        yield* service.releaseMaster(threadId);
        expect(host.controlLog()).toContain("quitIfClean");
        expect((yield* firstMaster(service, threadId)).status).toBe("running");
        yield* service.quit({ threadId, save: false, role: "master" });
      }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );

  it.live("never shares its file with a working Blender", () =>
    Effect.gen(function* () {
      const { service } = yield* masterHost();
      yield* service.open({ threadId, relativePath: "cube.blend" });
      const refused = yield* service
        .openMaster({ threadId: otherThreadId, relativePath: "cube.blend" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("openInAnotherThread");
      yield* service.quit({ threadId, save: false });
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "stopped"),
        Stream.runHead,
      );

      yield* service.openMaster({ threadId, relativePath: "cube.blend" });
      const working = yield* service
        .open({ threadId: otherThreadId, relativePath: "cube.blend" })
        .pipe(Effect.flip);
      expect(working.reason).toBe("openInAnotherThread");
      yield* service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped),
  );

  it.live(
    "reaches each agent thread only through its own port, closing one when its access ends",
    () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const ports = new Map([
          [threadId, yield* net.reserveLoopbackPort()],
          [otherThreadId, yield* net.reserveLoopbackPort()],
        ]);
        const revoked =
          yield* Queue.unbounded<HostedBlenderAgents.HostedBlenderRevocation | null>();
        const host = yield* masterHost({
          masterPorts: ports,
          revocations: Stream.fromQueue(revoked),
        });
        const { service } = host;
        // Opened from the pane first: no agent, so nothing listens yet.
        yield* service.openMaster({ threadId, relativePath: "cube.blend" });
        expect(
          (yield* service.agentListener(threadId, { role: "master", wait: false }))?.state,
        ).not.toBe("ready");
        yield* service.openMaster(
          { threadId, relativePath: "cube.blend" },
          { agentSession: "session-1" },
        );
        yield* service.openMaster(
          { threadId: otherThreadId, relativePath: "cube.blend" },
          { agentSession: "session-1" },
        );
        expect((yield* service.agentListener(threadId, { role: "master" }))?.state).toBe("ready");
        expect((yield* service.agentListener(otherThreadId, { role: "master" }))?.state).toBe(
          "ready",
        );
        // Blender Lab listens on a private port, never on either thread's.
        const own = Number(host.args()[host.args().indexOf("--t3-mcp-port") + 1]);
        expect([...ports.values()]).not.toContain(own);
        expect(yield* ping(ports.get(threadId)!)).toBe("pong");
        expect(yield* ping(ports.get(otherThreadId)!)).toBe("pong");
        expect(host.controlLog().match(/grantAgentListener/g)).toHaveLength(1);

        yield* Queue.offer(revoked, { threadId: threadId, session: undefined });
        yield* service
          .agentListener(threadId, { role: "master" })
          .pipe(Effect.repeat({ until: (report) => report?.state === "off" }));
        expect(yield* service.agentListener(threadId, { role: "master" })).toMatchObject({
          state: "off",
          ended: "revoked",
        });
        expect(yield* ping(ports.get(threadId)!)).toBe("ECONNREFUSED");
        expect(yield* ping(ports.get(otherThreadId)!)).toBe("pong");

        // Switched off for every thread: the master's own listener closes too.
        const stopped = yield* watchMaster(service, otherThreadId);
        yield* Queue.offer(revoked, null);
        yield* stopped;
        expect(host.controlLog()).toContain("stopAgentListener");
        expect(yield* ping(ports.get(otherThreadId)!)).toBe("ECONNREFUSED");
      }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );

  it.live(
    "keeps a master's grant for its launch, each agent session reaching it by its own relay",
    () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const ports = new Map([
          [threadId, yield* net.reserveLoopbackPort()],
          [otherThreadId, yield* net.reserveLoopbackPort()],
        ]);
        const sessions = new Map<ThreadId, string>();
        const revoked =
          yield* Queue.unbounded<HostedBlenderAgents.HostedBlenderRevocation | null>();
        const host = yield* masterHost({
          masterPorts: ports,
          revocations: Stream.fromQueue(revoked),
          sessions,
        });
        const { service } = host;
        yield* service.openMaster(
          { threadId, relativePath: "cube.blend" },
          { agentSession: "session-1" },
        );
        expect((yield* service.agentListener(threadId, { role: "master" }))?.state).toBe("ready");
        expect(yield* ping(ports.get(threadId)!)).toBe("pong");

        // The thread's only agent session ends: no agent thread is left, and no relay listens.
        yield* Queue.offer(revoked, { threadId, session: "session-1" });
        yield* service
          .agentListener(threadId, { role: "master" })
          .pipe(Effect.repeat({ until: (report) => report?.state === "off" }));
        expect(yield* ping(ports.get(threadId)!)).toBe("ECONNREFUSED");
        expect(yield* ping(ports.get(otherThreadId)!)).toBe("ECONNREFUSED");

        // The same thread's next session reaches the running master through a fresh relay.
        sessions.set(threadId, "session-2");
        yield* service.openMaster(
          { threadId, relativePath: "cube.blend" },
          { agentSession: "session-2" },
        );
        expect((yield* service.agentListener(threadId, { role: "master" }))?.state).toBe("ready");
        expect(yield* ping(ports.get(threadId)!)).toBe("pong");

        // So does a second thread arriving after the first one's access ended.
        yield* Queue.offer(revoked, { threadId, session: "session-2" });
        yield* service
          .agentListener(threadId, { role: "master" })
          .pipe(Effect.repeat({ until: (report) => report?.state === "off" }));
        yield* service.openMaster(
          { threadId: otherThreadId, relativePath: "cube.blend" },
          { agentSession: "session-1" },
        );
        expect((yield* service.agentListener(otherThreadId, { role: "master" }))?.state).toBe(
          "ready",
        );
        expect(yield* ping(ports.get(otherThreadId)!)).toBe("pong");

        // One grant for the launch, never ended by a thread leaving.
        expect(host.controlLog().match(/grantAgentListener/g)).toHaveLength(1);
        expect(host.controlLog()).not.toContain("stopAgentListener");
        expect(host.launches()).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );

  // The relay checks its clients against the kernel's own tables, which only Linux has.
  it.live.skipIf(!onLinux)(
    "relays only this OS account's connections to the master, as Blender's add-on checks them",
    () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const ports = new Map([
          [threadId, yield* net.reserveLoopbackPort()],
          [otherThreadId, yield* net.reserveLoopbackPort()],
        ]);
        // This account's own connection, read from the real tables, passes.
        const owner = yield* masterHost({ masterPorts: ports });
        yield* owner.service.openMaster(
          { threadId, relativePath: "cube.blend" },
          { agentSession: "session-1" },
        );
        expect((yield* owner.service.agentListener(threadId, { role: "master" }))?.state).toBe(
          "ready",
        );
        expect(yield* ping(ports.get(threadId)!)).toBe("pong");

        // Tables that don't show the client as this account: the relay closes it unanswered.
        const dir = yield* tempDir("tcp");
        const empty = NodePath.join(dir, "tcp");
        NodeFS.writeFileSync(empty, "  sl  local_address rem_address   st\n");
        const strangerPort = yield* net.reserveLoopbackPort();
        const stranger = yield* masterHost({
          masterPorts: new Map([[otherThreadId, strangerPort]]),
          tcpTables: [empty],
        });
        yield* stranger.service.openMaster(
          { threadId: otherThreadId, relativePath: "cube.blend" },
          { agentSession: "session-1" },
        );
        expect(
          (yield* stranger.service.agentListener(otherThreadId, { role: "master" }))?.state,
        ).toBe("ready");
        expect(["", "ECONNRESET"]).toContain(yield* ping(strangerPort));
      }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );

  it.live(
    "loads Blender Lab from one snapshot per launch, which a second thread never retakes",
    () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        let installed = "";
        const host = yield* masterHost({
          masterPorts: new Map([
            [threadId, yield* net.reserveLoopbackPort()],
            [otherThreadId, yield* net.reserveLoopbackPort()],
          ]),
          home: (dir) => {
            installed = NodePath.join(dir, ".config/blender/5.3/extensions/lab_blender_org/mcp");
            NodeFS.mkdirSync(installed, { recursive: true });
            NodeFS.writeFileSync(
              NodePath.join(installed, "blender_manifest.toml"),
              'version = "1.0.3"\n',
            );
            NodeFS.writeFileSync(NodePath.join(installed, "__init__.py"), "# 1.0.3\n");
          },
        });
        const { service } = host;
        yield* service.openMaster(
          { threadId, relativePath: "cube.blend" },
          { agentSession: "session-1" },
        );
        expect((yield* service.agentListener(threadId, { role: "master" }))?.state).toBe("ready");
        const args = host.args();
        const snapshot = args[args.indexOf("--t3-mcp-snapshot") + 1]!;
        expect(NodeFS.readFileSync(NodePath.join(snapshot, "mcp", "__init__.py"), "utf8")).toBe(
          "# 1.0.3\n",
        );

        // The user updates Blender Lab while the master runs; a second agent thread joins.
        NodeFS.writeFileSync(NodePath.join(installed, "__init__.py"), "# newer\n");
        yield* service.openMaster(
          { threadId: otherThreadId, relativePath: "cube.blend" },
          { agentSession: "session-1" },
        );
        expect((yield* service.agentListener(otherThreadId, { role: "master" }))?.state).toBe(
          "ready",
        );
        expect(host.launches()).toBe(1);
        expect(NodeFS.readFileSync(NodePath.join(snapshot, "mcp", "__init__.py"), "utf8")).toBe(
          "# 1.0.3\n",
        );
        expect(host.controlLog().match(/grantAgentListener/g)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );

  it.live("tells every agent thread on a master that an untested Blender Lab refused it", () =>
    Effect.gen(function* () {
      const net = yield* NetService.NetService;
      const { service } = yield* masterHost({
        masterPorts: new Map([
          [threadId, yield* net.reserveLoopbackPort()],
          [otherThreadId, yield* net.reserveLoopbackPort()],
        ]),
        untested: true,
      });
      for (const id of [threadId, otherThreadId]) {
        yield* service.openMaster(
          { threadId: id, relativePath: "cube.blend" },
          { agentSession: "session-1" },
        );
        expect(yield* service.agentListener(id, { role: "master" })).toMatchObject({
          state: "untested",
          mcpVersion: "1.1.0",
        });
      }
    }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );

  it.live("never listens for agents while agents aren't allowed", () =>
    Effect.gen(function* () {
      const host = yield* masterHost({ agentsAllowed: false });
      yield* host.service.openMaster(
        { threadId, relativePath: "cube.blend" },
        { agentSession: "session-1" },
      );
      expect(host.args()).not.toContain("--t3-mcp-listen");
      expect((yield* host.service.agentListener(threadId, { role: "master" }))?.state).toBe("off");
      yield* host.service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped),
  );

  it.live("shows only to the threads using it", () =>
    Effect.gen(function* () {
      const { service, masterStatus } = yield* masterHost();
      yield* service.openMaster({ threadId, relativePath: "cube.blend" });
      yield* masterStatus(threadId, "running");
      expect(
        (yield* service.attachViewer(otherThreadId, { canOperate: false, role: "master" }))._tag,
      ).toBe("stopped");
      expect((yield* service.attachViewer(threadId, { canOperate: false }))._tag).toBe("stopped");
      yield* service.quit({ threadId, save: false, role: "master" });
      expect((yield* masterStatus(threadId, "notOpen")).status).toBe("notOpen");
    }).pipe(Effect.scoped),
  );
});

const firstMaster = (service: HostedBlender.HostedBlender["Service"], id: ThreadId) =>
  service.masterState(id).pipe(Stream.runHead, Effect.map(Option.getOrThrow));

/** A desktop Blender with `file` open (or nothing), recording what T3 asks of it. */
const fakeDesktop = (initial: DesktopBlender.DesktopBlenderProbe, quits = true) => {
  let probe = initial;
  const saved: Array<string> = [];
  const service = DesktopBlender.DesktopBlender.of({
    probe: Effect.sync(() => probe),
    saveAndQuit: (file) =>
      Effect.gen(function* () {
        if (probe._tag !== "open") {
          return yield* new DesktopBlender.DesktopBlenderError({ reason: "unreachable" });
        }
        saved.push(file);
        if (!quits) return yield* new DesktopBlender.DesktopBlenderError({ reason: "didNotQuit" });
        probe = { _tag: "none" };
      }),
  });
  return { service, saved };
};

const desktopHost = Effect.fn(function* (
  desktopFor: (blendPath: string) => ReturnType<typeof fakeDesktop>,
  host: Pick<Host, "masterPorts" | "revocations" | "endedSessions"> = {},
) {
  const dir = yield* tempDir("move");
  const bin = fakeTools(dir);
  NodeFS.writeFileSync(NodePath.join(bin, "helper"), `#!${python}\n${ARGS_HELPER}`, {
    mode: 0o755,
  });
  const runtime = NodePath.join(dir, "run");
  NodeFS.mkdirSync(runtime);
  NodeFS.writeFileSync(NodePath.join(dir, "cube.blend"), "");
  NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
  // Another name for cube.blend, as a desktop Blender may have it open under.
  NodeFS.linkSync(NodePath.join(dir, "cube.blend"), NodePath.join(dir, "alias.blend"));
  // And a symlink to it, whose own entry is what Blender replaces when it saves.
  NodeFS.symlinkSync(NodePath.join(dir, "cube.blend"), NodePath.join(dir, "linked.blend"));
  const argsLog = NodePath.join(dir, "args.log");
  const desktop = desktopFor(NodeFS.realpathSync(NodePath.join(dir, "cube.blend")));
  const service = yield* serviceFor(
    layerFor({
      env: { PATH: bin, XDG_RUNTIME_DIR: runtime, STANDIN_ARGS: argsLog },
      helper: NodePath.join(bin, "helper"),
      workspaceRoot: dir,
      baseDir: dir,
      desktop: desktop.service,
      ...host,
    }),
  );
  return {
    service,
    desktop,
    dir: NodeFS.realpathSync(dir),
    launched: () => NodeFS.existsSync(argsLog),
    launches: () =>
      NodeFS.existsSync(`${argsLog}.launches`)
        ? NodeFS.readFileSync(`${argsLog}.launches`, "utf8").split("\n").length - 1
        : 0,
  };
});

/** The master's one copy of cube.blend, under the master owner, and what it holds. */
const masterCopyIn = (dir: string, blendPath: string) =>
  recoveryOf(NodePath.join(dir, "userdata", "hosted-blender"), `outside:${blendPath}`, "t3:master");

describe("Master Blenders' endings", () => {
  const openRunning = Effect.fn(function* (
    service: HostedBlender.HostedBlender["Service"],
    id: ThreadId,
  ) {
    yield* service.openMaster({ threadId: id, relativePath: "cube.blend" });
    // Its control connection is up once Blender's report arrives.
    yield* service.masterState(id).pipe(
      Stream.filter((state) => state.status === "running" && state.dirty),
      Stream.runHead,
    );
  });

  it.live(
    "switching off closes a master into one copy, which every thread sees on its Master side, and a restart keeps",
    () =>
      Effect.gen(function* () {
        const switches = yield* Queue.unbounded<HostedBlenderSetup.HostedBlenderReadiness>();
        const host = yield* masterHost({
          stayOnStop: true,
          dirty: true,
          readinessChanges: Stream.fromQueue(switches),
        });
        const { service, blendPath, dir } = host;
        yield* openRunning(service, threadId);
        yield* service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" });
        yield* Queue.offer(switches, { status: "notSetUp", missing: ["enabled"] });
        // Never saved over the user's file: Blender quit without saving, into its copy.
        const closed = yield* host.masterStatus(threadId, "closed");
        expect(closed).toMatchObject({
          relativePath: "cube.blend",
          copies: [{ kind: "closed", recovery: true, file: { relativePath: "cube.blend" } }],
        });
        expect(yield* host.masterStatus(otherThreadId, "closed")).toEqual(closed);
        expect(masterCopyIn(dir, blendPath)?.contents).toMatch(/^quit copy /);
        // One copy, kept once: neither thread holds one of its own.
        expect(recoveryOf(NodePath.join(dir, "userdata", "hosted-blender"))).toBeNull();
        // The working side lists only working files' copies.
        expect(yield* service.keptCopies(threadId)).toEqual([]);

        // After a restart, opening the master shows its card first, for any thread.
        const next = yield* serviceFor(host.layer);
        const refused = yield* next
          .openMaster({ threadId: otherThreadId, relativePath: "cube.blend" })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("recoveryPending");
        expect((yield* firstMaster(next, otherThreadId)).status).toBe("closed");
      }).pipe(Effect.scoped),
  );

  it.live(
    "Reopen restores the master's copy in a master Blender that other threads then join",
    () =>
      Effect.gen(function* () {
        const switches = yield* Queue.unbounded<HostedBlenderSetup.HostedBlenderReadiness>();
        const host = yield* masterHost({
          stayOnStop: true,
          dirty: true,
          readinessChanges: Stream.fromQueue(switches),
        });
        const { service, blendPath, dir } = host;
        yield* openRunning(service, threadId);
        yield* Queue.offer(switches, { status: "notSetUp", missing: ["enabled"] });
        const closed = yield* host.masterStatus(threadId, "closed");
        const next = yield* serviceFor(host.layer);
        // The thread that made this file its master since sees the same card.
        yield* next
          .openMaster({ threadId: otherThreadId, relativePath: "cube.blend" })
          .pipe(Effect.flip);
        const key = "copies" in closed ? closed.copies[0].key : "";
        yield* next.reopen({ threadId: otherThreadId, key, restore: true, role: "master" });
        yield* next.masterState(otherThreadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
        );
        expect(host.args()).toContain("--t3-recover");
        expect(host.args()).toContain(masterCopyIn(dir, blendPath)?.session);
        // Not a working Blender: the thread's working side is untouched.
        expect((yield* firstState(next)).status).toBe("stopped");
        // Another thread just joins the running master, its copy live there.
        yield* next.openMaster({ threadId, relativePath: "cube.blend" });
        expect((yield* firstMaster(next, threadId)).status).toBe("running");
        expect(host.launches()).toBe(2);
      }).pipe(Effect.scoped),
  );

  it.live(
    "a master closed with another file open offers that file's copy on its Master side, after a restart too",
    () =>
      Effect.gen(function* () {
        const switches = yield* Queue.unbounded<HostedBlenderSetup.HostedBlenderReadiness>();
        const host = yield* masterHost({
          stayOnStop: true,
          dirty: true,
          otherFileFirst: true,
          readinessChanges: Stream.fromQueue(switches),
        });
        const { service, dir } = host;
        const other = NodeFS.realpathSync(NodePath.join(dir, "other.blend"));
        yield* service.openMaster({ threadId, relativePath: "cube.blend" });
        yield* service.masterState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && "openFile" in state),
          Stream.runHead,
        );
        yield* Queue.offer(switches, { status: "notSetUp", missing: ["enabled"] });
        // Named by its own file, which isn't this master: where the copy is, not a Reopen.
        const closed = yield* service.masterState(threadId).pipe(
          Stream.filter((state) => state.status !== "running" && state.status !== "starting"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(closed).toMatchObject({
          relativePath: "cube.blend",
          copies: [{ kind: "closed", recovery: true, file: { kind: "outside", path: other } }],
        });
        const key = "copies" in closed ? closed.copies[0].key : "";
        const refused = yield* service
          .reopen({ threadId, key, restore: true, role: "master" })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("notInWorkspace");
        // After a restart, a thread whose master is that file finds it the same way.
        const next = yield* serviceFor(host.layer);
        yield* next.knowMaster({ threadId: otherThreadId, relativePath: "cube.blend" });
        expect(yield* firstMaster(next, otherThreadId)).toMatchObject({
          status: "closed",
          copies: [{ key, file: { path: other } }],
        });
        yield* next.dismiss({ threadId: otherThreadId, key, role: "master" });
        expect((yield* firstMaster(next, otherThreadId)).status).toBe("notOpen");
      }).pipe(Effect.scoped),
  );

  it.live("Discard from any thread removes the master's one copy", () =>
    Effect.gen(function* () {
      const switches = yield* Queue.unbounded<HostedBlenderSetup.HostedBlenderReadiness>();
      const host = yield* masterHost({
        stayOnStop: true,
        dirty: true,
        readinessChanges: Stream.fromQueue(switches),
      });
      const { service, blendPath, dir } = host;
      yield* openRunning(service, threadId);
      yield* service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" });
      yield* Queue.offer(switches, { status: "notSetUp", missing: ["enabled"] });
      const closed = yield* host.masterStatus(otherThreadId, "closed");
      const key = "copies" in closed ? closed.copies[0].key : "";
      yield* service.dismiss({ threadId: otherThreadId, key, role: "master" });
      expect(masterCopyIn(dir, blendPath)).toBeNull();
      expect((yield* firstMaster(service, threadId)).status).toBe("notOpen");
    }).pipe(Effect.scoped),
  );

  it.live(
    "a master that quits clean when its last thread leaves keeps nothing; a refusal records nothing",
    () =>
      Effect.gen(function* () {
        const switches = yield* Queue.unbounded<HostedBlenderSetup.HostedBlenderReadiness>();
        const clean = yield* masterHost({ stayOnStop: true, dirty: true });
        yield* openRunning(clean.service, threadId);
        const stopped = yield* watchMaster(clean.service, threadId);
        yield* clean.service.releaseMaster(threadId);
        yield* stopped;
        expect(masterCopyIn(clean.dir, clean.blendPath)).toBeNull();

        // Refused for unsaved changes, it stays open; a later close still keeps its copy.
        const kept = yield* masterHost({
          stayOnStop: true,
          dirty: true,
          unsaved: true,
          readinessChanges: Stream.fromQueue(switches),
        });
        yield* openRunning(kept.service, threadId);
        yield* kept.service.releaseMaster(threadId);
        expect((yield* firstMaster(kept.service, threadId)).status).toBe("running");
        yield* Queue.offer(switches, { status: "notSetUp", missing: ["enabled"] });
        yield* kept.masterStatus(threadId, "closed");
        expect(masterCopyIn(kept.dir, kept.blendPath)?.contents).toMatch(/^quit copy /);
      }).pipe(Effect.scoped),
  );

  it.live("Running Blenders lists a master by its key, which Quit takes with no thread", () =>
    Effect.gen(function* () {
      const host = yield* masterHost({ stayOnStop: true, dirty: true });
      const { service } = host;
      yield* openRunning(service, threadId);
      const [listed] = yield* service.runningBlenders.pipe(
        Stream.filter((list) => list.length === 1),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(listed?.master).toBe(`master:${host.blendPath}`);
      const stopped = yield* watchMaster(service, threadId);
      // Asked by a thread that never used it: the key alone names it.
      yield* service.quit({
        threadId: ThreadId.make("thread-elsewhere"),
        save: false,
        role: "master",
        ...(listed?.master === undefined ? {} : { master: listed.master }),
      });
      yield* stopped;
    }).pipe(Effect.scoped),
  );

  it.live(
    "an open waiting in a master's queue when Hosted Blender is switched off never launches",
    () =>
      Effect.gen(function* () {
        let hold: Deferred.Deferred<void> | null = null;
        const switches = yield* Queue.unbounded<HostedBlenderSetup.HostedBlenderReadiness>();
        const host = yield* masterHost({
          dirty: true,
          readinessChanges: Stream.fromQueue(switches),
          beforeThreadLookup: () => (hold === null ? Effect.void : Deferred.await(hold)),
        });
        const { service } = host;
        yield* openRunning(service, threadId);
        const gate = yield* Deferred.make<void>();
        hold = gate;
        const opening = yield* service
          .openMaster({ threadId: otherThreadId, relativePath: "other.blend" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Queue.offer(switches, { status: "notSetUp", missing: ["enabled"] });
        yield* host.masterStatus(threadId, "closed");
        yield* Deferred.succeed(gate, undefined);
        expect((yield* Fiber.join(opening)).reason).toBe("notSetUp");
        expect(host.launches()).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect("restart salvage keeps a master's launch as the master's one copy", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage-master");
      const blendPath = NodePath.join(NodeFS.realpathSync(dir), "cube.blend");
      const { hostedDir } = leftover(dir, {
        owner: "t3:master",
        facts: { restore: "none", saved: false, changed: true, path: blendPath },
      });
      yield* firstState(yield* idleService(dir));
      expect(recoveryOf(hostedDir, `outside:${blendPath}`, "t3:master")?.contents).toBe(
        "left behind",
      );
      // No thread holds a copy of its own.
      expect(recoveryOf(hostedDir)).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect(
    "S14: restart salvage keeps work staged after the run's last save, which that save never held",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir("salvage-saved-staged");
        // Saved with no copy waiting, then edited and staged for a reload; T3 died before its
        // facts were written again.
        const { hostedDir } = leftover(dir, {
          facts: { restore: "none", saved: true, changed: false, retires: null },
        });
        const launchDir = NodePath.join(hostedDir, "launches", "left");
        NodeFS.writeFileSync(
          NodePath.join(launchDir, "launch.json"),
          JSON.stringify({
            threadId,
            relativePath: "cube.blend",
            role: "working",
            workspaceRoot: NodeFS.realpathSync(dir),
          }),
        );
        NodeFS.writeFileSync(NodePath.join(launchDir, "tmp", "t3-reload-1.blend"), "staged work");
        NodeFS.writeFileSync(
          NodePath.join(launchDir, "tmp", "t3-reload-1.json"),
          JSON.stringify({ filepath: NodePath.join(NodeFS.realpathSync(dir), "cube.blend") }),
        );
        yield* firstState(yield* idleService(dir));
        expect(recoveryOf(hostedDir)?.contents).toBe("staged work");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "S15: restart salvage keeps staged work over an autosave older than it, though newer than the load",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir("salvage-staged-autosave");
        const { hostedDir } = leftover(dir, {
          facts: { restore: "none", saved: false, changed: true, retires: null },
        });
        const launchDir = NodePath.join(hostedDir, "launches", "left");
        NodeFS.writeFileSync(
          NodePath.join(launchDir, "launch.json"),
          JSON.stringify({
            threadId,
            relativePath: "cube.blend",
            role: "working",
            workspaceRoot: NodeFS.realpathSync(dir),
          }),
        );
        // No quit copy: Blender crashed. Its autosave predates the staged work.
        const tmp = NodePath.join(launchDir, "tmp");
        NodeFS.rmSync(NodePath.join(tmp, "quit.blend"), { force: true });
        const now = NodeFS.statSync(launchDir).mtimeMs / 1000;
        const autosave = NodePath.join(tmp, "cube_4242_autosave.blend");
        NodeFS.writeFileSync(autosave, "older autosave");
        NodeFS.utimesSync(autosave, now - 10, now - 10);
        NodeFS.writeFileSync(NodePath.join(tmp, "t3-reload-1.blend"), "staged work");
        NodeFS.utimesSync(NodePath.join(tmp, "t3-reload-1.blend"), now - 5, now - 5);
        NodeFS.writeFileSync(
          NodePath.join(tmp, "t3-reload-1.json"),
          JSON.stringify({ filepath: NodePath.join(NodeFS.realpathSync(dir), "cube.blend") }),
        );
        yield* firstState(yield* idleService(dir));
        expect(recoveryOf(hostedDir)?.contents).toBe("staged work");
      }).pipe(Effect.scoped),
  );

  it.effect("S2: a record whose copy never arrived isn't offered after a start", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage-orphan-record");
      const hostedDir = NodePath.join(dir, "userdata", "hosted-blender");
      const copyDir = NodePath.join(
        hostedDir,
        "recovery",
        Buffer.from(threadId).toString("base64url"),
        NodeCrypto.createHash("sha256").update(CUBE).digest("hex"),
      );
      NodeFS.mkdirSync(copyDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(copyDir, "record.json"),
        JSON.stringify({
          threadId,
          file: { kind: "workspace", relativePath: "cube.blend" },
          kind: "closed",
          recovery: true,
          keptAt: 1,
          reloaded: true,
        }),
      );
      const service = yield* idleService(dir);
      expect(yield* firstState(service)).toEqual({ status: "stopped" });
      expect(yield* service.keptCopies(threadId)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "S2: restart salvage keeps work a reload staged and T3 never kept, as its file's copy, before the run's own",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir("salvage-staged");
        const { hostedDir } = leftover(dir, {
          facts: { restore: "none", saved: false, changed: false },
        });
        const launchDir = NodePath.join(hostedDir, "launches", "left");
        NodeFS.writeFileSync(
          NodePath.join(launchDir, "launch.json"),
          JSON.stringify({
            threadId,
            relativePath: "cube.blend",
            role: "working",
            workspaceRoot: NodeFS.realpathSync(dir),
          }),
        );
        // Staged before a reload of other.blend; T3 wrote its record, then died before moving it.
        NodeFS.writeFileSync(NodePath.join(launchDir, "tmp", "t3-reload-1.blend"), "staged work");
        const copyDir = NodePath.join(
          hostedDir,
          "recovery",
          Buffer.from(threadId).toString("base64url"),
          NodeCrypto.createHash("sha256").update(OTHER).digest("hex"),
        );
        NodeFS.mkdirSync(copyDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(copyDir, "record.json"),
          JSON.stringify({
            threadId,
            file: { kind: "workspace", relativePath: "other.blend" },
            kind: "closed",
            recovery: true,
            keptAt: 1,
            reloaded: true,
          }),
        );
        NodeFS.writeFileSync(
          NodePath.join(launchDir, "tmp", "t3-reload-1.json"),
          JSON.stringify({ filepath: NodePath.join(NodeFS.realpathSync(dir), "other.blend") }),
        );
        const service = yield* idleService(dir);
        yield* firstState(service);
        expect(recoveryOf(hostedDir, OTHER)).toMatchObject({
          record: { recovery: true, reloaded: true },
          contents: "staged work",
        });
        expect(NodeFS.existsSync(launchDir)).toBe(false);
      }).pipe(Effect.scoped),
  );
});

describe("Move into T3", () => {
  it.live("leaves a master the desktop Blender has open there, then moves it on request", () =>
    Effect.gen(function* () {
      const { service, desktop, launched } = yield* desktopHost((file) =>
        fakeDesktop({ _tag: "open", filepath: file, dirty: true }),
      );
      expect(yield* service.openMaster({ threadId, relativePath: "cube.blend" })).toEqual({
        _tag: "desktop",
      });
      expect(yield* firstMaster(service, threadId)).toEqual({
        status: "notOpen",
        relativePath: "cube.blend",
        desktop: "open",
        desktopDirty: true,
      });
      expect(launched()).toBe(false);

      yield* service.moveIntoT3({ threadId, relativePath: "cube.blend" });
      expect(desktop.saved).toHaveLength(1);
      yield* service.masterState(threadId).pipe(
        Stream.filter((state) => state.status === "running"),
        Stream.runHead,
      );
      yield* service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped),
  );

  it.live("starts one master Blender when two threads open the master at once", () =>
    Effect.gen(function* () {
      const { service, launches } = yield* desktopHost(() => {
        const desktop = fakeDesktop({ _tag: "none" });
        // Asking the desktop Blender takes a while, as a real round trip does.
        return {
          ...desktop,
          service: {
            ...desktop.service,
            // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- the second open must arrive mid-probe; a second open waiting its turn marks nothing to await.
            probe: Effect.sleep("100 millis").pipe(Effect.andThen(desktop.service.probe)),
          },
        };
      });
      yield* Effect.all(
        [
          service.openMaster({ threadId, relativePath: "cube.blend" }),
          service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" }),
        ],
        { concurrency: "unbounded" },
      );
      for (const id of [threadId, otherThreadId]) {
        yield* service.masterState(id).pipe(
          Stream.filter((state) => state.status === "running"),
          Stream.runHead,
        );
      }
      // One Blender: quitting it through one thread quits it for the other.
      yield* service.quit({ threadId, save: false, role: "master" });
      expect((yield* firstMaster(service, otherThreadId)).status).toBe("notOpen");
      expect(launches()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.live("ignores a desktop Blender with another file open", () =>
    Effect.gen(function* () {
      const { service } = yield* desktopHost(() =>
        fakeDesktop({ _tag: "open", filepath: "/elsewhere/other.blend", dirty: false }),
      );
      expect(yield* service.openMaster({ threadId, relativePath: "cube.blend" })).toEqual({
        _tag: "hosted",
        desktopUnchecked: false,
      });
      yield* service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped),
  );

  it.live(
    "only warns every thread on the master about a desktop Blender it can't ask, and can't move from it",
    () =>
      Effect.gen(function* () {
        const { service, desktop } = yield* desktopHost(() => fakeDesktop({ _tag: "noAddon" }));
        expect(yield* service.openMaster({ threadId, relativePath: "cube.blend" })).toEqual({
          _tag: "hosted",
          desktopUnchecked: true,
        });
        yield* service.masterState(threadId).pipe(
          Stream.filter((state) => state.status === "running"),
          Stream.runHead,
        );
        // A thread joining the running master is told too.
        expect(
          yield* service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" }),
        ).toEqual({ _tag: "hosted", desktopUnchecked: true });
        expect(yield* firstMaster(service, otherThreadId)).toMatchObject({
          desktopUnchecked: true,
        });
        yield* service.quit({ threadId, save: false, role: "master" });
        const refused = yield* service
          .moveIntoT3({ threadId, relativePath: "cube.blend" })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("desktopUnreachable");
        expect(desktop.saved).toEqual([]);
        // Asked again after the failed move: still a desktop Blender T3 can't ask.
        expect(yield* firstMaster(service, threadId)).toMatchObject({ desktop: "noAddon" });
      }).pipe(Effect.scoped),
  );

  it.live("keeps the master where it is when the desktop Blender doesn't quit", () =>
    Effect.gen(function* () {
      const { service, launched } = yield* desktopHost((file) =>
        fakeDesktop({ _tag: "open", filepath: file, dirty: false }, false),
      );
      yield* service.openMaster({ threadId, relativePath: "cube.blend" });
      const refused = yield* service
        .moveIntoT3({ threadId, relativePath: "cube.blend" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("desktopDidNotQuit");
      expect(launched()).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("stops a Blender quit straight after it was opened", () =>
    Effect.gen(function* () {
      const { service } = yield* desktopHost(() => fakeDesktop({ _tag: "none" }));
      yield* service.open({ threadId: otherThreadId, relativePath: "cube.blend" });
      yield* service.quit({ threadId: otherThreadId, save: false });
      expect(
        (yield* service
          .threadState(otherThreadId)
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow))).status,
      ).toBe("stopped");
      yield* service.openMaster({ threadId, relativePath: "cube.blend" });
      yield* service.quit({ threadId, save: false, role: "master" });
      expect(yield* firstMaster(service, threadId)).toMatchObject({ status: "notOpen" });
    }).pipe(Effect.scoped),
  );

  it.live("needs a master to move", () =>
    Effect.gen(function* () {
      const { service } = yield* desktopHost(() => fakeDesktop({ _tag: "none" }));
      expect(
        (yield* service.moveIntoT3({ threadId, relativePath: "cube.blend" }).pipe(Effect.flip))
          .reason,
      ).toBe("noMaster");
      expect((yield* service.reopenMaster(threadId).pipe(Effect.flip)).reason).toBe("noMaster");
    }).pipe(Effect.scoped),
  );

  it.live("refuses a Move for a master other than the one the user saw", () =>
    Effect.gen(function* () {
      const { service, desktop } = yield* desktopHost((file) =>
        fakeDesktop({ _tag: "open", filepath: file, dirty: false }),
      );
      yield* service.openMaster({ threadId, relativePath: "cube.blend" });
      const refused = yield* service
        .moveIntoT3({ threadId, relativePath: "models/older.blend" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("masterChanged");
      expect(desktop.saved).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("moves every thread that chose the master, and only current agents get access", () =>
    Effect.gen(function* () {
      const net = yield* NetService.NetService;
      const ports = new Map([
        [threadId, yield* net.reserveLoopbackPort()],
        [otherThreadId, yield* net.reserveLoopbackPort()],
      ]);
      // The first thread's session ended while its request waited on the desktop Blender.
      const { service } = yield* desktopHost(
        (file) => fakeDesktop({ _tag: "open", filepath: file, dirty: false }),
        { masterPorts: ports, endedSessions: new Set([threadId]) },
      );
      const agent = { agentSession: "session-1" };
      yield* service.openMaster({ threadId, relativePath: "cube.blend" }, agent);
      yield* service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" }, agent);
      yield* service.moveIntoT3({ threadId, relativePath: "cube.blend" });
      for (const id of [threadId, otherThreadId]) {
        yield* service.masterState(id).pipe(
          Stream.filter((state) => state.status === "running"),
          Stream.runHead,
        );
      }
      expect((yield* service.agentListener(otherThreadId, { role: "master" }))?.state).toBe(
        "ready",
      );
      expect(yield* ping(ports.get(otherThreadId)!)).toBe("pong");
      expect((yield* service.agentListener(threadId, { role: "master" }))?.state).toBe("off");
      expect(yield* ping(ports.get(threadId)!)).toBe("ECONNREFUSED");
      yield* service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );

  it.live("keeps a working open from claiming the master's file while the desktop is asked", () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<void>();
      const { service } = yield* desktopHost(() => {
        const desktop = fakeDesktop({ _tag: "none" });
        return {
          ...desktop,
          service: {
            ...desktop.service,
            probe: Deferred.succeed(asked, undefined).pipe(
              Effect.andThen(Deferred.await(answer)),
              Effect.andThen(desktop.service.probe),
            ),
          },
        };
      });
      const master = yield* service
        .openMaster({ threadId, relativePath: "cube.blend" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(asked);
      // The file is held while the desktop Blender is asked: a working open is refused at once,
      // without waiting on the probe.
      const working = yield* service
        .open({ threadId: otherThreadId, relativePath: "cube.blend" })
        .pipe(Effect.flip);
      expect(working.reason).toBe("openInAnotherThread");
      yield* Deferred.succeed(answer, undefined);
      yield* Fiber.join(master);
      yield* service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped),
  );
});

describe("Master file claims", () => {
  it.live("knows a hard link to an open file is that file", () =>
    Effect.gen(function* () {
      const host = yield* masterHost();
      NodeFS.linkSync(
        NodePath.join(host.dir, "cube.blend"),
        NodePath.join(host.dir, "linked.blend"),
      );
      yield* host.service.open({ threadId, relativePath: "cube.blend" });
      const refused = yield* host.service
        .openMaster({ threadId: otherThreadId, relativePath: "linked.blend" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("openInAnotherThread");
      yield* host.service.quit({ threadId, save: false });
    }).pipe(Effect.scoped),
  );

  it.live("counts the file a Blender has open now, not only the one it started with", () =>
    Effect.gen(function* () {
      const host = yield* masterHost({ otherFileFirst: true, dirty: true });
      yield* host.service.open({ threadId, relativePath: "cube.blend" });
      // Its report of other.blend arrives with its unsaved changes.
      yield* host.service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && state.dirty),
        Stream.runHead,
      );
      const refused = yield* host.service
        .openMaster({ threadId: otherThreadId, relativePath: "other.blend" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("openInAnotherThread");
      yield* host.service.quit({ threadId, save: false });
    }).pipe(Effect.scoped),
  );

  it.live("won't switch a thread away from a master with unsaved changes it alone can reach", () =>
    Effect.gen(function* () {
      const host = yield* masterHost({ dirty: true, unsaved: true });
      yield* host.service.openMaster({ threadId, relativePath: "cube.blend" });
      yield* host.service.masterState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && state.dirty),
        Stream.runHead,
      );
      const refused = yield* host.service
        .openMaster({ threadId, relativePath: "other.blend" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("masterUnsaved");
      expect(yield* firstMaster(host.service, threadId)).toMatchObject({
        relativePath: "cube.blend",
      });
      yield* host.service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped),
  );

  it.live("listens on a port from the threads' registry, and never for an ended session", () =>
    Effect.gen(function* () {
      const net = yield* NetService.NetService;
      const privatePort = yield* net.reserveLoopbackPort();
      const ports = new Map([[threadId, yield* net.reserveLoopbackPort()]]);
      const host = yield* masterHost({
        privatePort,
        masterPorts: ports,
        endedSessions: new Set([threadId]),
      });
      yield* host.service.openMaster(
        { threadId, relativePath: "cube.blend" },
        { agentSession: "session-1" },
      );
      yield* host.masterStatus(threadId, "running");
      expect(Number(host.args()[host.args().indexOf("--t3-mcp-port") + 1])).toBe(privatePort);
      expect(
        (yield* host.service.agentListener(threadId, { role: "master", wait: false }))?.state,
      ).not.toBe("ready");
      expect(yield* ping(ports.get(threadId)!)).toBe("ECONNREFUSED");
      yield* host.service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );

  it.live("starts a new master, not a dying one, when a thread joins as the last one leaves", () =>
    Effect.gen(function* () {
      const net = yield* NetService.NetService;
      const ports = new Map([[threadId, yield* net.reserveLoopbackPort()]]);
      const host = yield* masterHost({ masterPorts: ports, slowQuit: true });
      yield* host.service.openMaster(
        { threadId, relativePath: "cube.blend" },
        { agentSession: "session-1" },
      );
      // Ready only once the control connection is up, so the quit reaches Blender.
      expect((yield* host.service.agentListener(threadId, { role: "master" }))?.state).toBe(
        "ready",
      );
      // Started now: the master is quitting before the other thread asks for it.
      const leaving = yield* host.service
        .releaseMaster(threadId)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* host.service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" });
      yield* Fiber.join(leaving);
      // The other thread has a Blender of its own, alive after the first one quit.
      yield* host.masterStatus(otherThreadId, "running");
      expect(host.launches()).toBe(2);
      yield* host.service.quit({ threadId: otherThreadId, save: false, role: "master" });
    }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );
});

describe("A master's lifecycle", () => {
  const waitDirty = (service: HostedBlender.HostedBlender["Service"], id: ThreadId) =>
    service.masterState(id).pipe(
      Stream.filter((state) => state.status === "running" && state.dirty),
      Stream.runHead,
    );

  it.live(
    "asks a master to quit again once T3 can reach it, if it couldn't when the last thread left",
    () =>
      Effect.gen(function* () {
        const host = yield* masterHost({ controlGate: true });
        yield* host.service.openMaster({ threadId, relativePath: "cube.blend" });
        yield* host.masterStatus(threadId, "running");
        // No control connection yet: the release can't ask, so the master stays the thread's.
        yield* host.service.releaseMaster(threadId);
        expect((yield* firstMaster(host.service, threadId)).status).toBe("running");
        const stopped = yield* watchMaster(host.service, threadId);
        host.openControl();
        yield* stopped;
        expect(host.exits()).toBe(1);
        expect(yield* firstMaster(host.service, threadId)).toEqual({ status: "none" });
      }).pipe(Effect.scoped),
  );

  it.live("changes a thread's master one open at a time", () =>
    Effect.gen(function* () {
      const host = yield* masterHost({ dirty: true });
      yield* Effect.all(
        [
          host.service.openMaster({ threadId, relativePath: "cube.blend" }).pipe(Effect.exit),
          host.service.openMaster({ threadId, relativePath: "other.blend" }).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      );
      yield* waitDirty(host.service, threadId);
      yield* host.service.releaseMaster(threadId);
      // Only the master it ended with counted it, so leaving quits every Blender it started.
      expect(host.exits()).toBe(host.launches());
    }).pipe(Effect.scoped),
  );

  it.live("doesn't hold other opens while it asks a slow desktop Blender", () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<void>();
      const { service } = yield* desktopHost(() => {
        const desktop = fakeDesktop({ _tag: "none" });
        return {
          ...desktop,
          service: {
            ...desktop.service,
            probe: Deferred.succeed(asked, undefined).pipe(
              Effect.andThen(Deferred.await(answer)),
              Effect.andThen(desktop.service.probe),
            ),
          },
        };
      });
      const master = yield* service
        .openMaster({ threadId, relativePath: "cube.blend" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(asked);
      // An unrelated file opens while the desktop Blender still hasn't answered.
      yield* service.open({ threadId: otherThreadId, relativePath: "other.blend" });
      yield* Deferred.succeed(answer, undefined);
      yield* Fiber.join(master);
      yield* service.quit({ threadId: otherThreadId, save: false });
      yield* service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped),
  );

  it.live(
    "keeps a dirty master's thread through a second release while the first is deciding",
    () =>
      Effect.gen(function* () {
        const host = yield* masterHost({ dirty: true, unsaved: true, slowQuit: true });
        yield* host.service.openMaster({ threadId, relativePath: "cube.blend" });
        yield* waitDirty(host.service, threadId);
        const first = yield* host.service
          .releaseMaster(threadId)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* host.service.releaseMaster(threadId);
        yield* Fiber.join(first);
        expect((yield* firstMaster(host.service, threadId)).status).toBe("running");
        yield* host.service.quit({ threadId, save: false, role: "master" });
      }).pipe(Effect.scoped),
  );

  it.live("finishes a quit decision its caller stopped waiting for, and lets joins through", () =>
    Effect.gen(function* () {
      const host = yield* masterHost({ dirty: true, unsaved: true, slowQuit: true });
      yield* host.service.openMaster({ threadId, relativePath: "cube.blend" });
      yield* waitDirty(host.service, threadId);
      const leaving = yield* host.service
        .releaseMaster(threadId)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Fiber.interrupt(leaving);
      // Refused, so the master is kept, and the other thread joins it rather than waiting.
      expect(
        yield* host.service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" }),
      ).toEqual({ _tag: "hosted", desktopUnchecked: false });
      expect(host.launches()).toBe(1);
      yield* host.service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped),
  );

  it.live(
    "never listens for an agent whose session ended before Blender could hear the grant",
    () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const ports = new Map([[threadId, yield* net.reserveLoopbackPort()]]);
        const ended = new Set<ThreadId>();
        const host = yield* masterHost({
          masterPorts: ports,
          endedSessions: ended,
          controlGate: true,
          dirty: true,
        });
        yield* host.service.openMaster(
          { threadId, relativePath: "cube.blend" },
          { agentSession: "session-1" },
        );
        ended.add(threadId);
        host.openControl();
        yield* waitDirty(host.service, threadId);
        expect(host.controlLog()).not.toContain("grantAgentListener");
        yield* host.service.quit({ threadId, save: false, role: "master" });
      }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );

  it.live("closes a thread's relay once its session is no longer the one that asked", () =>
    Effect.gen(function* () {
      const net = yield* NetService.NetService;
      const ports = new Map([
        [threadId, yield* net.reserveLoopbackPort()],
        [otherThreadId, yield* net.reserveLoopbackPort()],
      ]);
      const ended = new Set<ThreadId>();
      const host = yield* masterHost({ masterPorts: ports, endedSessions: ended });
      const agent = { agentSession: "session-1" };
      yield* host.service.openMaster({ threadId, relativePath: "cube.blend" }, agent);
      expect((yield* host.service.agentListener(threadId, { role: "master" }))?.state).toBe(
        "ready",
      );
      expect(yield* ping(ports.get(threadId)!)).toBe("pong");
      // Its credential was replaced; the next change to the master's relays drops its own.
      ended.add(threadId);
      yield* host.service.openMaster(
        { threadId: otherThreadId, relativePath: "cube.blend" },
        agent,
      );
      expect(yield* ping(ports.get(threadId)!)).toBe("ECONNREFUSED");
      expect(yield* ping(ports.get(otherThreadId)!)).toBe("pong");
      yield* host.service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );
});

describe("A relay outliving its agent session", () => {
  /** Connects through a relay and stays connected, saying nothing, until the far end closes. */
  const hold = (port: number) =>
    Effect.callback<{ readonly closed: Promise<void> }>((resume) => {
      const socket = NodeNet.connect(port, "127.0.0.1");
      const closed = new Promise<void>((done) => socket.on("close", () => done()));
      socket.on("error", () => undefined);
      socket.on("connect", () => resume(Effect.succeed({ closed })));
    });

  it.live(
    "closes the old session's connection once its revocation arrives after the new grant",
    () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const ports = new Map([[threadId, yield* net.reserveLoopbackPort()]]);
        const sessions = new Map([[threadId, "session-1"]]);
        const revoked =
          yield* Queue.unbounded<HostedBlenderAgents.HostedBlenderRevocation | null>();
        const host = yield* masterHost({
          masterPorts: ports,
          sessions,
          revocations: Stream.fromQueue(revoked),
        });
        yield* host.service.openMaster(
          { threadId, relativePath: "cube.blend" },
          { agentSession: "session-1" },
        );
        expect((yield* host.service.agentListener(threadId, { role: "master" }))?.state).toBe(
          "ready",
        );
        const old = yield* hold(ports.get(threadId)!);
        // The credential is replaced: the new session's grant is recorded before the old
        // session's revocation is handled.
        sessions.set(threadId, "session-2");
        yield* host.service.openMaster(
          { threadId, relativePath: "cube.blend" },
          { agentSession: "session-2" },
        );
        yield* Queue.offer(revoked, { threadId, session: "session-1" });
        yield* Effect.promise(() => old.closed);
        expect(yield* ping(ports.get(threadId)!)).toBe("pong");
        yield* host.service.quit({ threadId, save: false, role: "master" });
      }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );
});

describe("Move into T3, round three", () => {
  it.live("refuses a Move whose thread left the master while it waited its turn", () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<void>();
      let probes = 0;
      const host = yield* desktopHost((file) => {
        const desktop = fakeDesktop({ _tag: "open", filepath: file, dirty: false });
        return {
          ...desktop,
          service: {
            ...desktop.service,
            // The second ask holds the master's queue until the test lets it answer.
            probe: Effect.suspend(() => {
              probes += 1;
              return probes === 2
                ? Deferred.succeed(asked, undefined).pipe(
                    Effect.andThen(Deferred.await(answer)),
                    Effect.andThen(desktop.service.probe),
                  )
                : desktop.service.probe;
            }),
          },
        };
      });
      yield* host.service.openMaster({ threadId, relativePath: "cube.blend" });
      const joining = yield* host.service
        .openMaster({ threadId: otherThreadId, relativePath: "cube.blend" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(asked);
      const leaving = yield* host.service
        .releaseMaster(threadId)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const move = yield* host.service
        .moveIntoT3({ threadId, relativePath: "cube.blend" })
        .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(answer, undefined);
      yield* Fiber.join(joining);
      yield* Fiber.join(leaving);
      expect((yield* Fiber.join(move)).reason).toBe("masterChanged");
      expect(host.desktop.saved).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "shows the desktop Blender's path and unsaved changes as they are after a failed Move",
    () =>
      Effect.gen(function* () {
        const { service } = yield* desktopHost((file) => {
          let probe: DesktopBlender.DesktopBlenderProbe = {
            _tag: "open",
            filepath: file,
            dirty: true,
          };
          return {
            saved: [],
            service: DesktopBlender.DesktopBlender.of({
              probe: Effect.sync(() => probe),
              // The user saved there meanwhile, and the move didn't go through.
              saveAndQuit: () =>
                Effect.sync(() => {
                  probe = { _tag: "open", filepath: file, dirty: false };
                }).pipe(
                  Effect.andThen(
                    Effect.fail(new DesktopBlender.DesktopBlenderError({ reason: "didNotQuit" })),
                  ),
                ),
            }),
          };
        });
        yield* service.openMaster({ threadId, relativePath: "cube.blend" });
        expect(yield* firstMaster(service, threadId)).toMatchObject({ desktopDirty: true });
        yield* service.moveIntoT3({ threadId, relativePath: "cube.blend" }).pipe(Effect.flip);
        expect(yield* firstMaster(service, threadId)).toMatchObject({
          desktop: "open",
          desktopDirty: false,
        });
      }).pipe(Effect.scoped),
  );
});

describe("A quit still unresolved in a busy Blender", () => {
  it.live(
    "ends the leave, keeps the master unavailable, and lets joins in once Blender drops it",
    () =>
      Effect.gen(function* () {
        const host = yield* masterHost({ dirty: true, quitSilent: true, cancelGate: true });
        const other = yield* masterHost({ dirty: true });
        yield* host.service.openMaster({ threadId, relativePath: "cube.blend" });
        yield* other.service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" });
        for (const [service, id] of [
          [host.service, threadId],
          [other.service, otherThreadId],
        ] as const) {
          yield* service.masterState(id).pipe(
            Stream.filter((state) => state.status === "running" && state.dirty),
            Stream.runHead,
          );
        }
        // Busy, it never answers the quit or the cancel; the leave still ends on its deadline.
        yield* host.service.releaseMaster(threadId);
        // An unrelated master settles at once meanwhile.
        yield* other.service.releaseMaster(otherThreadId);
        expect(other.exits()).toBe(1);
        // Until Blender drops the quit, the master isn't handed to anyone.
        const busy = yield* host.service
          .openMaster({ threadId: otherThreadId, relativePath: "cube.blend" })
          .pipe(Effect.flip);
        expect(busy.reason).toBe("masterBusy");
        expect(
          (yield* host.service.attachViewer(threadId, { canOperate: false, role: "master" }))._tag,
        ).toBe("stopped");
        host.answerCancel();
        yield* host.service.masterState(threadId).pipe(
          Stream.filter((state) => state.status === "running"),
          Stream.runHead,
        );
        expect(
          yield* host.service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" }),
        ).toEqual({ _tag: "hosted", desktopUnchecked: false });
        expect(host.exits()).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.live("reuses an unresolved quit for a second leave, asking Blender only once", () =>
    Effect.gen(function* () {
      const host = yield* masterHost({ dirty: true, quitSilent: true, cancelGate: true });
      yield* host.service.openMaster({ threadId, relativePath: "cube.blend" });
      yield* host.service.masterState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && state.dirty),
        Stream.runHead,
      );
      // Archived, then deleted, before Blender acknowledges the first quit's cancel.
      yield* host.service.releaseMaster(threadId);
      yield* host.service.releaseMaster(threadId);
      expect(host.controlLog().match(/"quitIfClean"/g)).toHaveLength(1);
      host.answerCancel();
      yield* host.service.masterState(threadId).pipe(
        Stream.filter((state) => state.status === "running"),
        Stream.runHead,
      );
      expect(
        yield* host.service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" }),
      ).toEqual({ _tag: "hosted", desktopUnchecked: false });
      expect(host.exits()).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.live("treats Blender exiting while the quit is unresolved as the quit going through", () =>
    Effect.gen(function* () {
      const host = yield* masterHost({ dirty: true, quitSilent: true, exitOnCancel: true });
      yield* host.service.openMaster({ threadId, relativePath: "cube.blend" });
      yield* host.service.masterState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && state.dirty),
        Stream.runHead,
      );
      const stopped = yield* watchMaster(host.service, threadId);
      yield* host.service.releaseMaster(threadId);
      yield* stopped;
      expect(host.exits()).toBe(1);
      // Gone: the next open starts a Blender of its own.
      yield* host.service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" });
      yield* host.masterStatus(otherThreadId, "running");
      expect(host.launches()).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.live("ends a master that crashes before it reads the quit as crashed, its autosave kept", () =>
    Effect.gen(function* () {
      const host = yield* masterHost({ dirty: true, crashOnQuit: true });
      yield* host.service.openMaster({ threadId, relativePath: "cube.blend" });
      yield* host.service.masterState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && state.dirty),
        Stream.runHead,
      );
      const stopped = yield* watchMaster(host.service, threadId);
      yield* host.service.releaseMaster(threadId);
      yield* stopped;
      expect(masterCopyIn(host.dir, host.blendPath)?.contents).toBe("autosave");
      // The next open of the master shows its card first.
      const refused = yield* host.service
        .openMaster({ threadId: otherThreadId, relativePath: "cube.blend" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("recoveryPending");
      expect(yield* firstMaster(host.service, otherThreadId)).toMatchObject({
        status: "crashed",
      });
    }).pipe(Effect.scoped),
  );
});

describe("A quit Blender never answered", () => {
  it.live("is cancelled before anyone joins the master again, so a late quit can't close it", () =>
    Effect.gen(function* () {
      const host = yield* masterHost({ dirty: true, quitSilent: true });
      yield* host.service.openMaster({ threadId, relativePath: "cube.blend" });
      yield* host.service.masterState(threadId).pipe(
        Stream.filter((state) => state.status === "running" && state.dirty),
        Stream.runHead,
      );
      yield* host.service.releaseMaster(threadId);
      // Available again once Blender has dropped the quit.
      yield* host.service.masterState(threadId).pipe(
        Stream.filter((state) => state.status === "running"),
        Stream.runHead,
      );
      expect(
        yield* host.service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" }),
      ).toEqual({ _tag: "hosted", desktopUnchecked: false });
      const sent = host
        .controlLog()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const quit = sent.find((command) => command.type === "quitIfClean");
      // The join came only after the quit it outlived was cancelled in Blender.
      expect(sent).toContainEqual({ type: "cancelQuit", id: quit.id });
      expect(host.exits()).toBe(0);
    }).pipe(Effect.scoped),
  );
});

describe("Agent access to a master, by session", () => {
  it.live("ends only what the ended session was granted, and its relay at once", () =>
    Effect.gen(function* () {
      const net = yield* NetService.NetService;
      const ports = new Map([
        [threadId, yield* net.reserveLoopbackPort()],
        [otherThreadId, yield* net.reserveLoopbackPort()],
      ]);
      const revoked = yield* Queue.unbounded<HostedBlenderAgents.HostedBlenderRevocation | null>();
      const accessEnded = yield* Queue.unbounded<{
        readonly threadId: ThreadId;
        readonly role: HostedBlenderAgents.HostedBlenderRole;
        readonly grant: string;
      }>();
      const host = yield* masterHost({
        masterPorts: ports,
        revocations: Stream.fromQueue(revoked),
        accessEnded,
      });
      const agent = { agentSession: "session-1" };
      yield* host.service.openMaster({ threadId, relativePath: "cube.blend" }, agent);
      yield* host.service.openMaster(
        { threadId: otherThreadId, relativePath: "cube.blend" },
        agent,
      );
      expect((yield* host.service.agentListener(threadId, { role: "master" }))?.state).toBe(
        "ready",
      );
      // A relay serves the session it was opened for, on the thread's own port.
      const relay = yield* host.service.agentGrant({
        threadId: otherThreadId,
        role: "master",
        session: "session-1",
      });
      expect(relay).toMatchObject({ _tag: "granted", port: ports.get(otherThreadId) });
      expect(
        (yield* host.service.agentGrant({ threadId, role: "master", session: "session-2" }))._tag,
      ).toBe("none");
      // A credential replaced before this one was granted: nothing of this session's ends.
      yield* Queue.offer(revoked, { threadId, session: "session-0" });
      yield* Queue.offer(revoked, { threadId: otherThreadId, session: "session-1" });
      yield* host.service
        .agentListener(otherThreadId, { role: "master" })
        .pipe(Effect.repeat({ until: (report) => report?.state === "off" }));
      expect(yield* ping(ports.get(threadId)!)).toBe("pong");
      expect(yield* ping(ports.get(otherThreadId)!)).toBe("ECONNREFUSED");
      // Its relay's closing stops that session's Blender Lab server too, and no other.
      expect(yield* Queue.take(accessEnded)).toEqual({
        threadId: otherThreadId,
        role: "master",
        grant: relay._tag === "granted" ? relay.grant : "",
      });
      expect(yield* Queue.size(accessEnded)).toBe(0);
      yield* host.service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );
});

describe("Move into T3, round two", () => {
  it.live(
    "knows the desktop Blender has the master open under another name for it, a hard link or a symlink",
    () =>
      Effect.gen(function* () {
        // Saved under either, Blender would replace that entry and leave the master as it was.
        for (const alias of ["alias.blend", "linked.blend"]) {
          const seen: Array<string> = [];
          const host = yield* desktopHost((file) => {
            const desktop = fakeDesktop({
              _tag: "open",
              filepath: NodePath.join(NodePath.dirname(file), alias),
              dirty: false,
            });
            return {
              ...desktop,
              service: {
                ...desktop.service,
                saveAndQuit: (target: string) =>
                  Effect.sync(() => seen.push(target)).pipe(
                    Effect.andThen(desktop.service.saveAndQuit(target)),
                  ),
              },
            };
          });
          expect(yield* host.service.openMaster({ threadId, relativePath: "cube.blend" })).toEqual({
            _tag: "desktop",
          });
          const refused = yield* host.service
            .moveIntoT3({ threadId, relativePath: "cube.blend" })
            .pipe(Effect.flip);
          expect({ alias, reason: refused.reason }).toEqual({ alias, reason: "desktopAlias" });
          expect(seen).toEqual([]);
        }
      }).pipe(Effect.scoped),
  );

  it.live("offers opening it here when the desktop Blender exited without the save recorded", () =>
    Effect.gen(function* () {
      const { service } = yield* desktopHost((file) => {
        const desktop = fakeDesktop({ _tag: "open", filepath: file, dirty: false });
        let gone = false;
        return {
          ...desktop,
          service: {
            probe: Effect.suspend(() =>
              gone ? Effect.succeed({ _tag: "none" as const }) : desktop.service.probe,
            ),
            saveAndQuit: () =>
              Effect.sync(() => {
                gone = true;
              }).pipe(
                Effect.andThen(
                  Effect.fail(new DesktopBlender.DesktopBlenderError({ reason: "didNotQuit" })),
                ),
              ),
          },
        };
      });
      yield* service.openMaster({ threadId, relativePath: "cube.blend" });
      const refused = yield* service
        .moveIntoT3({ threadId, relativePath: "cube.blend" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("desktopDidNotQuit");
      expect(yield* firstMaster(service, threadId)).toMatchObject({ desktop: null });
    }).pipe(Effect.scoped),
  );

  it.live("takes every thread still on the master along when a failed open is retried", () =>
    Effect.gen(function* () {
      let hide = (): void => undefined;
      const host = yield* desktopHost((file) => {
        const desktop = fakeDesktop({ _tag: "open", filepath: file, dirty: false });
        return {
          ...desktop,
          service: {
            ...desktop.service,
            // The file is briefly unreadable once saved, so the hosted open after it fails.
            saveAndQuit: (target: string) =>
              desktop.service.saveAndQuit(target).pipe(Effect.tap(() => Effect.sync(hide))),
          },
        };
      });
      const cube = NodePath.join(host.dir, "cube.blend");
      hide = () => NodeFS.renameSync(cube, `${cube}.away`);
      yield* host.service.openMaster({ threadId, relativePath: "cube.blend" });
      yield* host.service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" });
      yield* host.service.moveIntoT3({ threadId, relativePath: "cube.blend" }).pipe(Effect.flip);
      NodeFS.renameSync(`${cube}.away`, cube);
      yield* host.service.reopenMaster(threadId);
      for (const id of [threadId, otherThreadId]) {
        yield* host.service.masterState(id).pipe(
          Stream.filter((state) => state.status === "running"),
          Stream.runHead,
        );
      }
      yield* host.service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped),
  );

  it.live("leaves a thread on the master it switched to while the desktop Blender saved", () =>
    Effect.gen(function* () {
      const saving = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const host = yield* desktopHost((file) => {
        const desktop = fakeDesktop({ _tag: "open", filepath: file, dirty: false });
        return {
          ...desktop,
          service: {
            ...desktop.service,
            saveAndQuit: (target: string) =>
              Deferred.succeed(saving, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
                Effect.andThen(desktop.service.saveAndQuit(target)),
              ),
          },
        };
      });
      yield* host.service.openMaster({ threadId, relativePath: "cube.blend" });
      yield* host.service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" });
      const move = yield* host.service
        .moveIntoT3({ threadId, relativePath: "cube.blend" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(saving);
      // The thread that asked for the move picks another master while the desktop Blender saves.
      const switching = yield* host.service
        .openMaster({ threadId, relativePath: "other.blend" })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(move);
      yield* Fiber.join(switching);
      expect(yield* firstMaster(host.service, threadId)).toMatchObject({
        relativePath: "other.blend",
      });
      yield* host.service.quit({ threadId, save: false, role: "master" });
      yield* host.service.quit({ threadId: otherThreadId, save: false, role: "master" });
    }).pipe(Effect.scoped),
  );
});
