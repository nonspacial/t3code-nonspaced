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
# Set once T3 lets the helper go, as it does to a Blender still writing at shutdown.
detached = threading.Event()
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
             "dirty": scenario not in ("switches", "matrix", "quit-dirty")}
    if "--t3-recover" in t3:
        first["restore"] = matrix.get("restore", "ok")
    send(connection, first)
    if scenario == "matrix":
        # Ends on the file asked for, clean or dirty; a dirty state first tells the test T3 has
        # read everything before it.
        end = {"same": opened, "other": os.path.join(os.path.dirname(opened), "other.blend"),
               "outside": "/elsewhere/outside.blend", "untitled": ""}[matrix["end"]]
        state["stem"] = os.path.basename(end)[:-len(".blend")] if end else ""
        last = {"type": "state", "filepath": end, "dirty": True}
        send(connection, last)
        if not matrix["dirty"]:
            send(connection, dict(last, dirty=False))
    if scenario == "opens-outside":
        # The person opens a file from outside the workspace and edits it.
        send(connection, dict(first, filepath="/elsewhere/outside.blend"))
    if scenario == "switches":
        # Opens another file and edits it: once T3 sees it dirty, it has seen the switch.
        other = os.path.join(os.path.dirname(opened), "other.blend")
        send(connection, dict(first, filepath=other, dirty=True))
    view = {"position": [7, -7, 5], "target": [0, 0, 1]}
    # "reloads": as the add-on tells Blender's own file from a change on disk, by its revision.
    def revision():
        info = os.stat(opened)
        return (info.st_ino, info.st_size, info.st_mtime_ns)
    disk = [revision()]
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
                              "filepath": opened})
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
            if revision() != disk[0] and command["reload"]:
                reload_now()
            elif revision() != disk[0]:
                send(connection, {"type": "state", "filepath": opened,
                                  "dirty": state.get("dirty", True), "stale": True})
            continue
        if command.get("type") == "restore":
            # Puts the copy back, unsaved, as recover_auto_save does: a load, taking its time.
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
            send(connection, {"type": "state", "filepath": opened, "dirty": True, "loadedAt": loaded})
            continue
        if command.get("type") == "quit" and command.get("hold") and scenario == "unsaved-images":
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
        if command.get("type") == "quit" and not command.get("save"):
            if scenario == "ignores-quit":
                continue
            # As the add-on does: the file and its unsaved bit as they are as it begins to quit.
            # "quit-dirty" was edited since it last said.
            quitting = {"type": "quitting", "filepath": state.get("open", opened),
                        "dirty": state.get("dirty", True)}
            if scenario == "quit-dirty":
                quitting["dirty"] = True
            send(connection, quitting)
            # Its quit pushes an undo step, so its next report is unsaved.
            send(connection, {"type": "state", "filepath": state.get("open", opened), "dirty": True})
            state["finishing"].clear()
            slow = os.path.join(os.path.dirname(os.environ["STANDIN_SAVES"]), "slow-quit")
            if os.path.exists(slow):
                # Still writing its quit copy past T3's shutdown deadline, until T3 lets it go.
                detached.wait()
            open(os.path.join(tmp, "quit.blend"), "w").write("quit copy %d" % os.getpid())
            open(os.environ["STANDIN_SAVES"] + ".quitInode", "w").write(str(os.stat(os.path.join(tmp, "quit.blend")).st_ino))
            event({"type": "exited", "process": "blender", "code": 0, "signal": None})
            connection.close()
            state["finishing"].set()
            return
        kind = command.get("type")
        if kind == "view" and scenario == "drop-on-view":
            connection.close()
            return
        if kind == "view":
            result = None if scenario == "no-viewport" else {
                "screenshot": view_reply(command),
                # The file it has open, by its path as given, and the scene it drew.
                "filepath": opened, "scene": "launch:7",
                "cameraView": {**view, "upAxis": "z"},
                "projection": {"matrix": [2] + [0] * 15,
                               "region": {"x": 0.1, "y": 0.05, "width": 0.8, "height": 0.9}}}
            connection.sendall((json.dumps({"type": "reply", "id": command["id"], "result": result}) + "\n").encode())
            continue
        if kind != "quit" or not command.get("save"):
            continue
        with open(os.environ["STANDIN_SAVES"], "a") as log:
            log.write("save\n")
        send(connection, {"type": "saving", "filepath": opened})
        if scenario == "exit-while-saving":
            os._exit(0)
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
  const { dir, layer, hostedDir, crash, launches } = yield* standIn(name, "matrix");
  NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
  NodeFS.writeFileSync(
    NodePath.join(dir, "matrix.json"),
    JSON.stringify({
      restore: cell.restore,
      dirty: cell.dirty,
      end: cell.end,
      autosave: cell.autosave ?? true,
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
    launches,
    dir,
    before,
    misfiled,
    copies: new Map(copies.map((copy) => [copy.key, copy])),
    cube: recoveryOf(hostedDir),
    end: recoveryOf(hostedDir, END_KEYS[cell.end]),
  };
});

const GRID: ReadonlyArray<Cell> = [false, true].flatMap((waiting) =>
  (waiting ? (["none", "ok", "failed"] as const) : (["none"] as const)).flatMap((restore) =>
    [false, true].flatMap((dirty) =>
      (["same", "other", "untitled"] as const).flatMap((end) =>
        (["settle", "crash"] as const).map((ending) => ({
          waiting,
          restore,
          dirty,
          end,
          ending,
        })),
      ),
    ),
  ),
);

const CELLS: ReadonlyArray<Cell> = [
  ...GRID,
  // M9: a crash on a file outside the workspace before Blender's first autosave.
  {
    waiting: true,
    restore: "none",
    dirty: true,
    end: "outside",
    ending: "crash",
    autosave: false,
  },
];

const cellIs = (cell: Cell, like: Cell) => JSON.stringify(cell) === JSON.stringify(like);

describe("One recovery copy per file", () => {
  it.live(
    "no run loses a copy, overwrites one with another file's, or names it after another file",
    () =>
      Effect.forEach(
        CELLS,
        (cell) =>
          Effect.gen(function* () {
            const label = JSON.stringify(cell);
            const { before, copies, cube, end, misfiled, service, launches, dir } =
              yield* runCell(cell);
            const snapshot = cell.ending === "settle" ? /^quit copy / : /^autosave$/;
            // Every record is in its own file's folder, labelled with that file.
            expect(misfiled, label).toEqual([]);
            if (cell.waiting && cell.restore === "none") {
              // Open as last saved never restores the waiting copy.
              expect(launches().at(-1), label).not.toContain("--t3-recover");
            }
            if (cell.autosave === false) {
              // The crash is told under the file it happened in, with nothing of it to restore.
              expect(cube, label).toEqual(before);
              expect(cube?.contents, label).toBe("waiting copy");
              expect(end?.record, label).toMatchObject({
                file: { kind: "outside", path: "/elsewhere/outside.blend" },
                kind: "crashed",
                recovery: false,
              });
              expect([...copies.keys()], label).toEqual([END_KEYS.outside, CUBE]);
              return;
            }
            const fresh = {
              waiting: false,
              restore: "none",
              dirty: true,
              ending: "settle",
            } as const;
            if (cellIs(cell, { ...fresh, dirty: false, end: "same" })) {
              // A clean look keeps nothing, and the file opens normally after.
              expect((yield* firstState(service)).status, label).toBe("stopped");
              yield* service.open({ threadId, relativePath: "cube.blend" });
            }
            if (cellIs(cell, { ...fresh, end: "same" })) {
              // Discarded, the copy leaves nothing to reopen.
              yield* service.dismiss({ threadId, key: CUBE });
              const missing = yield* service
                .reopen({ threadId, key: CUBE, restore: true })
                .pipe(Effect.flip);
              expect(missing.reason, label).toBe("nothingToReopen");
            }
            if (cellIs(cell, { ...fresh, end: "other" })) {
              // Reopen of the file Blender ended on launches that file.
              yield* service.reopen({ threadId, key: OTHER, restore: false });
              yield* service.threadState(threadId).pipe(
                Stream.filter((state) => state.status === "running"),
                Stream.runHead,
              );
              expect(launches().at(-1), label).toContain(
                NodeFS.realpathSync(NodePath.join(dir, "other.blend")),
              );
            }
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
});

/** A leftover launch's record as today's T3 writes it, for a thread's working Blender. */
const workingLaunch = (dir: string, hostedDir: string) =>
  NodeFS.writeFileSync(
    NodePath.join(hostedDir, "launches", "left", "launch.json"),
    JSON.stringify({
      threadId,
      relativePath: "cube.blend",
      role: "working",
      workspaceRoot: NodeFS.realpathSync(dir),
    }),
  );

/** Work the add-on staged before a reload of `relativePath`, as it names it. */
const staged = (dir: string, hostedDir: string, relativePath = "cube.blend") => {
  const tmp = NodePath.join(hostedDir, "launches", "left", "tmp");
  NodeFS.writeFileSync(NodePath.join(tmp, "t3-reload-1.blend"), "staged work");
  NodeFS.writeFileSync(
    NodePath.join(tmp, "t3-reload-1.json"),
    JSON.stringify({ filepath: NodePath.join(NodeFS.realpathSync(dir), relativePath) }),
  );
};

/** A record T3 wrote for `key` before it moved the copy in, as after a reload. */
const reloadRecord = (hostedDir: string, key: string, relativePath: string) => {
  const copyDir = NodePath.join(
    hostedDir,
    "recovery",
    Buffer.from(threadId).toString("base64url"),
    NodeCrypto.createHash("sha256").update(key).digest("hex"),
  );
  NodeFS.mkdirSync(copyDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(copyDir, "record.json"),
    JSON.stringify({
      threadId,
      file: { kind: "workspace", relativePath },
      kind: "closed",
      recovery: true,
      keptAt: 1,
      reloaded: true,
    }),
  );
};

/** The quit copy of a leftover run, its mtime moved by `shift` seconds. */
const shiftQuitCopy = (launchDir: string, shift: number) => {
  const quitCopy = NodePath.join(launchDir, "tmp", "quit.blend");
  const at = NodeFS.statSync(quitCopy).mtimeMs / 1000 + shift;
  NodeFS.utimesSync(quitCopy, at, at);
};

/** The record of a leftover run's copy, written as of its quit copy; T3 stopped before the move. */
const recordFirst = (hostedDir: string, launchDir: string, older: boolean) => {
  const recordPath = recoveryOf(hostedDir)!.session.replace(/session\.blend$/, "record.json");
  const captured = Math.floor(
    NodeFS.statSync(NodePath.join(launchDir, "tmp", "quit.blend")).mtimeMs,
  );
  NodeFS.writeFileSync(
    recordPath,
    JSON.stringify({ ...JSON.parse(NodeFS.readFileSync(recordPath, "utf8")), keptAt: captured }),
  );
  if (!older) NodeFS.rmSync(recordPath.replace(/record\.json$/, "session.blend"));
};

const status = (service: HostedBlender.HostedBlender["Service"]) =>
  firstState(service).pipe(Effect.map((state) => state.status));

const CHANGED = { restore: "none", saved: false, changed: true } as const;
const CLEAN = { restore: "none", saved: false, changed: false } as const;

/**
 * What a stopped server left, and what the next start makes of it: the same one-copy-per-file
 * rules a live ending applies, read from T3's own launch records.
 */
const SALVAGE_ROWS: ReadonlyArray<{
  readonly name: string;
  readonly left: (dir: string, hostedDir: string) => void;
  readonly check: (
    service: HostedBlender.HostedBlender["Service"],
    dir: string,
    hostedDir: string,
  ) => Effect.Effect<void>;
}> = [
  {
    name: "a changed run's copy replaces the waiting one",
    left: (dir) => void leftover(dir, { facts: CHANGED, waiting: "waiting copy" }),
    check: (service, _dir, hostedDir) =>
      Effect.gen(function* () {
        expect(yield* status(service)).toBe("closed");
        expect(recoveryOf(hostedDir)?.contents).toBe("left behind");
      }),
  },
  {
    name: "a run that ended with its file clean keeps nothing",
    left: (dir) => void leftover(dir, { facts: CLEAN }),
    check: (service, _dir, hostedDir) =>
      Effect.gen(function* () {
        expect(yield* status(service)).toBe("stopped");
        expect(recoveryOf(hostedDir)).toBeNull();
      }),
  },
  ...[0, -120].map((shift) => ({
    name: `a clean run keeps the waiting copy it didn't restore, its snapshot shifted ${shift} s`,
    left: (dir: string) =>
      shiftQuitCopy(leftover(dir, { facts: CLEAN, waiting: "waiting copy" }).launchDir, shift),
    check: (service: HostedBlender.HostedBlender["Service"], _dir: string, hostedDir: string) =>
      Effect.gen(function* () {
        expect(yield* status(service)).toBe("closed");
        expect(recoveryOf(hostedDir)?.contents).toBe("waiting copy");
      }),
  })),
  {
    name: "a run that ended on another file is kept under that file, this one's untouched",
    left: (dir) =>
      void leftover(dir, {
        facts: { ...CHANGED, relativePath: "other.blend" },
        waiting: "waiting copy",
      }),
    check: (service, _dir, hostedDir) =>
      Effect.gen(function* () {
        expect(yield* firstState(service)).toEqual({
          status: "closed",
          relativePath: "other.blend",
          recovery: true,
          alsoKept: [CUBE],
        });
        expect(recoveryOf(hostedDir)?.contents).toBe("waiting copy");
        expect(recoveryOf(hostedDir, OTHER)?.contents).toBe("left behind");
      }),
  },
  ...["failed", "pending"].map((restore) => ({
    name: `a restore that ${restore === "failed" ? "failed" : "never finished"} keeps the waiting copy`,
    left: (dir: string) =>
      void leftover(dir, { facts: { ...CHANGED, restore }, waiting: "waiting copy" }),
    check: (service: HostedBlender.HostedBlender["Service"], _dir: string, hostedDir: string) =>
      Effect.gen(function* () {
        expect(yield* status(service)).toBe("closed");
        expect(recoveryOf(hostedDir)?.contents).toBe("waiting copy");
      }),
  })),
  {
    name: "a confirmed save as the run's last word clears an older copy",
    left: (dir) =>
      void leftover(dir, { facts: { ...CHANGED, saved: true }, waiting: "waiting copy" }),
    check: (service, _dir, hostedDir) =>
      Effect.gen(function* () {
        expect(yield* status(service)).toBe("stopped");
        expect(recoveryOf(hostedDir)).toBeNull();
      }),
  },
  ...[true, false].map((older) => ({
    name: `a copy whose record was written before T3 stopped is finished, ${older ? "with" : "without"} an older copy there`,
    left: (dir: string, hostedDir: string) =>
      recordFirst(
        hostedDir,
        leftover(dir, { facts: CHANGED, waiting: "older copy" }).launchDir,
        older,
      ),
    check: (service: HostedBlender.HostedBlender["Service"], _dir: string, hostedDir: string) =>
      Effect.gen(function* () {
        expect(yield* status(service)).toBe("closed");
        expect(recoveryOf(hostedDir)?.contents).toBe("left behind");
        expect(NodeFS.existsSync(NodePath.join(hostedDir, "launches", "left"))).toBe(false);
      }),
  })),
  {
    name: "a dead server's crashed Blender offers its autosave",
    left: (_dir, hostedDir) => {
      const dead = NodePath.join(hostedDir, "launches", "dead");
      NodeFS.mkdirSync(NodePath.join(dead, "tmp"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(dead, "launch.json"),
        JSON.stringify({ threadId, relativePath: "models/hero.blend" }),
      );
      NodeFS.writeFileSync(NodePath.join(dead, "tmp", "hero_77_autosave.blend"), "autosave");
      NodeFS.writeFileSync(NodePath.join(dead, "tmp", "hero.crash.txt"), "");
    },
    check: (service, _dir, hostedDir) =>
      Effect.gen(function* () {
        expect(yield* firstState(service)).toEqual({
          status: "crashed",
          relativePath: "models/hero.blend",
          recovery: true,
        });
        expect(recoveryOf(hostedDir, "workspace:models/hero.blend")?.contents).toBe("autosave");
        expect(NodeFS.readdirSync(NodePath.join(hostedDir, "launches"))).toEqual([]);
      }),
  },
  {
    name: "a master's launch is the master's one copy, no thread's",
    left: (dir) =>
      void leftover(dir, {
        owner: "t3:master",
        facts: { ...CHANGED, path: NodePath.join(NodeFS.realpathSync(dir), "cube.blend") },
      }),
    check: (service, dir, hostedDir) =>
      Effect.gen(function* () {
        yield* firstState(service);
        const blendPath = NodePath.join(NodeFS.realpathSync(dir), "cube.blend");
        expect(recoveryOf(hostedDir, `outside:${blendPath}`, "t3:master")?.contents).toBe(
          "left behind",
        );
        expect(recoveryOf(hostedDir)).toBeNull();
      }),
  },
  {
    name: "S14: work staged after the run's last save, which that save never held, is kept",
    left: (dir, hostedDir) => {
      leftover(dir, { facts: { ...CLEAN, saved: true, retires: null } });
      workingLaunch(dir, hostedDir);
      staged(dir, hostedDir);
    },
    check: (service, _dir, hostedDir) =>
      Effect.gen(function* () {
        yield* firstState(service);
        expect(recoveryOf(hostedDir)?.contents).toBe("staged work");
      }),
  },
  {
    name: "S2: a record whose copy never arrived isn't offered",
    left: (_dir, hostedDir) => reloadRecord(hostedDir, CUBE, "cube.blend"),
    check: (service) =>
      Effect.gen(function* () {
        expect(yield* firstState(service)).toEqual({ status: "stopped" });
        expect(yield* service.keptCopies(threadId)).toEqual([]);
      }),
  },
  {
    name: "S2: work a reload staged and T3 never kept is its file's copy, before the run's own",
    left: (dir, hostedDir) => {
      leftover(dir, { facts: CLEAN });
      workingLaunch(dir, hostedDir);
      staged(dir, hostedDir, "other.blend");
      reloadRecord(hostedDir, OTHER, "other.blend");
    },
    check: (service, _dir, hostedDir) =>
      Effect.gen(function* () {
        yield* firstState(service);
        expect(recoveryOf(hostedDir, OTHER)).toMatchObject({
          record: { recovery: true, reloaded: true },
          contents: "staged work",
        });
        expect(NodeFS.existsSync(NodePath.join(hostedDir, "launches", "left"))).toBe(false);
      }),
  },
];

describe("Salvaging what a stopped server left", () => {
  it.live("B4: a garbage recovery folder is skipped, and a good copy listed", () =>
    Effect.gen(function* () {
      const { layer, hostedDir } = yield* standIn("bad-folders", "");
      waitingCopy(hostedDir, "waiting copy");
      const recovery = NodePath.join(hostedDir, "recovery");
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

      // A leftover leading its own group, whose Blender ignores SIGTERM and outlives it: the
      // service is ready at once, an open waits for the salvage, and the files are collected
      // only once nothing of that launch is still running.
      const groupDir = yield* tempDir("salvage-group");
      const group = leftover(groupDir, {});
      const childPidFile = NodePath.join(groupDir, "child.pid");
      const leader = NodeChildProcess.spawn(
        python,
        [
          "-c",
          [
            "import subprocess, sys, time",
            "subprocess.Popen([sys.executable, '-c', 'import os, signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], \"w\").write(str(os.getpid())); time.sleep(600)', sys.argv[1], '--state-dir', sys.argv[2]])",
            "time.sleep(600)",
          ].join("\n"),
          childPidFile,
          group.launchDir,
        ],
        { cwd: group.launchDir, stdio: "ignore", detached: true },
      );
      yield* fileAppears(
        groupDir,
        childPidFile,
        () => NodeFS.existsSync(childPidFile) && NodeFS.readFileSync(childPidFile, "utf8") !== "",
      );
      const childPid = Number(NodeFS.readFileSync(childPidFile, "utf8"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const pid of [childPid, leader.pid!]) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        }),
      );
      const running = () => {
        const stat = NodeFS.existsSync(`/proc/${childPid}/stat`)
          ? NodeFS.readFileSync(`/proc/${childPid}/stat`, "utf8")
          : "";
        return stat !== "" && !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
      };
      leftover(groupDir, { helperPid: leader.pid! });
      const beside = yield* idleService(groupDir);
      expect(running(), "ready while the stubborn leftover still runs").toBe(true);
      const waited = yield* beside.open({ threadId, relativePath: "cube.blend" }).pipe(Effect.flip);
      expect(waited.reason, "an open waits for the salvage").toBe("recoveryPending");
      expect(running(), "collected only once the whole group is gone").toBe(false);
      expect(recoveryOf(group.hostedDir)?.contents).toBe("left behind");
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
        expect((yield* firstState(service)).status).toBe("stopped");
        // Its file is its own until it exits: an open of it, from any thread, says so at once.
        for (const id of [threadId, otherThreadId]) {
          const refused = yield* service
            .open({ threadId: id, relativePath: "cube.blend" })
            .pipe(Effect.flip);
          expect(refused.reason).toBe("stillSaving");
        }
        // Nor is the copy it writes discarded, which would only come back once it exits.
        const discard = yield* service.dismiss({ threadId, key: CUBE }).pipe(Effect.flip);
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

  it.effect.each(SALVAGE_ROWS)("salvage at start: $name", (row) =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage");
      const hostedDir = NodePath.join(dir, "userdata", "hosted-blender");
      row.left(dir, hostedDir);
      yield* row.check(yield* idleService(dir), dir, hostedDir);
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
    // The workspace's folder under the test's, which is T3's base folder too.
    project = ".",
  ) {
    const dir = NodeFS.realpathSync(yield* tempDir(prefix));
    const workspace = NodePath.join(dir, project);
    NodeFS.mkdirSync(workspace, { recursive: true });
    // A Blender that stays starting until it is quit, never launching anything.
    const bin = fakeTools(dir, WAITING_HELPER);
    NodeFS.writeFileSync(NodePath.join(workspace, "cube.blend"), "master");
    NodeFS.writeFileSync(NodePath.join(workspace, COPY), "working copy");
    const layer = layerFor({
      env: { PATH: bin },
      helper: NodePath.join(bin, "helper"),
      workspaceRoot: workspace,
      baseDir: dir,
      ...host,
    });
    const at = (name: string) => NodePath.join(workspace, name);
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
      NodePath.join(workspace, ".t3", "held-working-copies", id, "copy.blend");
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
      workspace,
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

  it.live("holds a copy in T3's state when the held folder leads out of the workspace", () =>
    Effect.gen(function* () {
      const { dir, workspace, at, record, heldWhen, stateFile, start } = yield* heldHost(
        "held-symlinked",
        {},
        "project",
      );
      const elsewhere = NodePath.join(dir, "elsewhere");
      NodeFS.mkdirSync(elsewhere);
      NodeFS.symlinkSync(elsewhere, NodePath.join(workspace, ".t3"));
      const service = yield* start;
      yield* record(service);
      yield* service.closeOnSettle({ threadId });
      const [held] = yield* heldWhen(service, (list) => list.length === 1);
      expect(NodeFS.readFileSync(stateFile(held!.id), "utf8")).toBe("working copy");
      expect(NodeFS.readdirSync(elsewhere)).toEqual([]);
      yield* service.putBackHeld({ threadId, path: at(COPY) });
      expect(NodeFS.readFileSync(at(COPY), "utf8")).toBe("working copy");

      // A symlink to a folder inside the workspace holds nothing there either: a held file
      // there would be named by a path the guards against opening it don't know.
      const inside = at("assets");
      NodeFS.mkdirSync(inside);
      NodeFS.rmSync(NodePath.join(workspace, ".t3"));
      NodeFS.symlinkSync(inside, NodePath.join(workspace, ".t3"));
      yield* service.closeOnSettle({ threadId });
      yield* heldWhen(service, (list) => list.length === 1 && list[0]!.heldAt > held!.heldAt);
      expect(NodeFS.readFileSync(stateFile(held!.id), "utf8")).toBe("working copy");
      expect(NodeFS.readdirSync(inside)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "a Reopen or an agent's start Hosted Blender can't launch leaves the held copy held",
    () =>
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
        // blender_start puts the copy back before it opens it, and is refused the same way.
        const unstarted = yield* service
          .putBackHeld({ threadId, path: at(COPY) })
          .pipe(Effect.flip);
        expect(unstarted.reason).toBe("notSetUp");
        expect(NodeFS.existsSync(at(COPY))).toBe(false);
        expect(yield* heldWhen(service, () => true)).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.live("a move a crash interrupted ends with one whole copy, never none", () => {
    let settled = true;
    return Effect.gen(function* () {
      let failWrites: (() => void) | null = null;
      // Holds a hold once it has copied the file out, before removing it from the project.
      let paused: {
        readonly copied: Deferred.Deferred<void>;
        readonly release: Deferred.Deferred<void>;
      } | null = null;
      const gated = yield* Deferred.make<void>();
      const { at, record, heldWhen, heldFile, recordDir, stateFile, start } = yield* heldHost(
        "held-crash",
        {
          threadSettled: () => settled,
          holdGate: () =>
            Effect.sync(() => failWrites?.()).pipe(
              Effect.andThen(
                failWrites === null ? Effect.void : Deferred.succeed(gated, undefined),
              ),
              Effect.andThen(
                paused === null
                  ? Effect.void
                  : Deferred.succeed(paused.copied, undefined).pipe(
                      Effect.andThen(Deferred.await(paused.release)),
                    ),
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
      const holding = (aside?: string) => {
        const written = JSON.parse(NodeFS.readFileSync(recordPath, "utf8"));
        NodeFS.writeFileSync(recordPath, JSON.stringify({ ...written, state: "holding", aside }));
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
      holding(aside);
      yield* restarted((list) => list.length === 1);
      expect(NodeFS.readFileSync(heldFile(first.id), "utf8")).toBe("set aside");
      expect(NodeFS.existsSync(aside)).toBe(false);
      expect(NodeFS.existsSync(at(COPY))).toBe(false);
      // Set aside while another file took its place: both stay, and Settings says where.
      NodeFS.writeFileSync(aside, "set aside again");
      NodeFS.writeFileSync(at(COPY), "saved since");
      holding(aside);
      expect(yield* restarted((list) => list.length === 1)).toMatchObject([
        { leftInProject: true, setAside: aside },
      ]);
      expect(NodeFS.readFileSync(aside, "utf8")).toBe("set aside again");
      expect(NodeFS.readFileSync(at(COPY), "utf8")).toBe("saved since");
      NodeFS.rmSync(aside);
      NodeFS.writeFileSync(at(COPY), "working copy");
      yield* restarted((list) => list.length === 1 && list[0]!.leftInProject !== true);
      // A file at that name the record doesn't name is the person's: left where it is.
      NodeFS.writeFileSync(aside, "the person's own");
      holding();
      yield* restarted((list) => list.length === 1 && list[0]!.leftInProject !== true);
      expect(NodeFS.readFileSync(heldFile(first.id), "utf8")).toBe("working copy");
      expect(NodeFS.readFileSync(aside, "utf8")).toBe("the person's own");
      NodeFS.rmSync(aside);

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

      // No crash: the thread is made active while its copy is mid-move. The move waits under
      // the copy's lock and leaves the copy in the project: nothing held, nothing to put back.
      paused = { copied: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      yield* service.closeOnSettle({ threadId });
      yield* Deferred.await(paused.copied);
      settled = false;
      yield* Deferred.succeed(paused.release, undefined);
      expect(
        yield* service.putBackHeld({ threadId, path: at(COPY) }),
        "an active thread's copy is never held",
      ).toBeNull();
      expect(NodeFS.readFileSync(at(COPY), "utf8")).toBe("working copy");
      expect(yield* service.heldWorkingCopies(threadId)).toEqual([]);
    }).pipe(Effect.scoped);
  });

  it.live("a put-back stopped after its link finishes, and the copy can be held again", () => {
    let settled = true;
    // A held name whose removal fails, as on a folder the person can't write.
    let stuck: string | null = null;
    return Effect.gen(function* () {
      const { at, record, heldWhen, heldFile, recordDir, recordOf, start } = yield* heldHost(
        "held-link-back",
        {
          threadSettled: () => settled,
          fileSystem: (base) => ({
            ...base,
            remove: (path, options) =>
              path === stuck
                ? Effect.fail(systemError("remove", path, "EACCES"))
                : base.remove(path, options),
          }),
        },
      );
      const held = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* start;
          yield* record(service);
          yield* service.closeOnSettle({ threadId });
          return (yield* heldWhen(service, (list) => list.length === 1))[0]!;
        }),
      );
      // T3 stopped once the copy was linked back, before the held name was removed.
      const recordPath = NodePath.join(recordDir(held.id), "record.json");
      const written = JSON.parse(NodeFS.readFileSync(recordPath, "utf8"));
      NodeFS.writeFileSync(recordPath, JSON.stringify({ ...written, state: "returning" }));
      NodeFS.linkSync(heldFile(held.id), at(COPY));
      // Made active again meanwhile, so the pass at start doesn't hold it again at once.
      settled = false;
      const service = yield* start;
      expect(recordOf()).toMatchObject({ state: "live" });
      expect(NodeFS.existsSync(heldFile(held.id))).toBe(false);
      expect(NodeFS.statSync(at(COPY)).nlink).toBe(1);
      settled = true;
      yield* service.closeOnSettle({ threadId });
      const [again] = yield* heldWhen(service, (list) => list.length === 1);
      expect(again?.leftInProject).toBeUndefined();

      // The held name can't be removed as it goes back: the copy stays returning, and the
      // next try finishes it, so it can be held again.
      stuck = heldFile(held.id);
      const refused = yield* service.putBackHeld({ threadId, path: at(COPY) }).pipe(Effect.flip);
      stuck = null;
      expect(refused.reason).toBe("restoreFailed");
      expect(recordOf()).toMatchObject({ state: "returning" });
      yield* service.putBackHeld({ threadId, path: at(COPY) });
      expect(recordOf()).toMatchObject({ state: "live" });
      expect(NodeFS.statSync(at(COPY)).nlink).toBe(1);
      yield* service.closeOnSettle({ threadId });
      const [third] = yield* heldWhen(
        service,
        (list) => list.length === 1 && list[0]!.heldAt > again!.heldAt,
      );
      expect(third?.leftInProject).toBeUndefined();
      expect(NodeFS.existsSync(at(COPY))).toBe(false);
    }).pipe(Effect.scoped);
  });

  it.live(
    "on a drive with no hard links a held copy goes back as it left, never over a file there",
    () =>
      Effect.gen(function* () {
        // exFAT, FAT32 and many SMB mounts: every link fails, and a test may act just before.
        let beforeLink: ((to: string) => void) | null = null;
        const copied: Array<string> = [];
        const { at, record, heldWhen, heldFile, recordDir, recordOf, stateFile, start } =
          yield* heldHost("held-no-links", {
            fileSystem: (base) => ({
              ...base,
              link: (from, to) =>
                Effect.sync(() => beforeLink?.(to)).pipe(
                  Effect.andThen(Effect.fail(systemError("link", from, "EPERM"))),
                ),
              copyFile: (from, to) =>
                Effect.sync(() => copied.push(to)).pipe(Effect.andThen(base.copyFile(from, to))),
            }),
          });
        const withService = <A, E>(
          use: (service: HostedBlender.HostedBlender["Service"]) => Effect.Effect<A, E>,
        ) => Effect.scoped(start.pipe(Effect.flatMap(use)));
        const isHeld = (list: HostedBlenderHeldList) =>
          list.length === 1 && list[0]!.leftInProject !== true && recordOf()?.state === "held";
        const inode = NodeFS.statSync(at(COPY)).ino;
        const held = yield* withService((service) =>
          Effect.gen(function* () {
            yield* record(service);
            yield* service.closeOnSettle({ threadId });
            const [first] = yield* heldWhen(service, isHeld);

            // A file that takes the copy's name as it goes back is never replaced.
            beforeLink = (to) => {
              beforeLink = null;
              NodeFS.writeFileSync(to, "the person's own");
            };
            const refused = yield* service
              .putBackHeld({ threadId, path: at(COPY) })
              .pipe(Effect.flip);
            expect(refused.reason).toBe("heldCopyInTheWay");
            expect(NodeFS.readFileSync(at(COPY), "utf8")).toBe("the person's own");
            expect(NodeFS.readFileSync(heldFile(first!.id), "utf8")).toBe("working copy");
            expect(recordOf()).toMatchObject({ state: "held" });

            // Once it is gone the copy goes back by a rename, the same file, nothing copied.
            NodeFS.rmSync(at(COPY));
            expect(yield* service.putBackHeld({ threadId, path: at(COPY) })).toEqual({
              masterChanged: false,
            });
            expect(NodeFS.statSync(at(COPY)).ino).toBe(inode);
            expect(NodeFS.statSync(at(COPY)).nlink).toBe(1);
            expect(NodeFS.existsSync(heldFile(first!.id))).toBe(false);
            expect(copied).toEqual([]);
            expect(recordOf()).toMatchObject({ state: "live" });
            // And it can be held again.
            yield* service.closeOnSettle({ threadId });
            yield* heldWhen(service, (list) => isHeld(list) && list[0]!.heldAt > first!.heldAt);
            expect(NodeFS.existsSync(at(COPY))).toBe(false);
            return first!;
          }),
        );

        // T3 stopped after claiming the name with an empty file, before the rename: the empty
        // file is T3's, so the copy stays held, never in the way, and the next Reopen has it.
        const recordPath = NodePath.join(recordDir(held.id), "record.json");
        const rewrite = (change: object) =>
          NodeFS.writeFileSync(
            recordPath,
            JSON.stringify({ ...JSON.parse(NodeFS.readFileSync(recordPath, "utf8")), ...change }),
          );
        rewrite({ state: "returning" });
        NodeFS.writeFileSync(at(COPY), "");
        yield* withService((service) =>
          Effect.gen(function* () {
            yield* heldWhen(service, isHeld);
            expect(NodeFS.existsSync(at(COPY))).toBe(false);
            yield* service.putBackHeld({ threadId, path: at(COPY) });
            expect(NodeFS.readFileSync(at(COPY), "utf8")).toBe("working copy");
            yield* service.closeOnSettle({ threadId });
            yield* heldWhen(service, (list) => list.length === 1 && !NodeFS.existsSync(at(COPY)));
          }),
        );

        // A file a hold across drives set aside goes back the same way, over its empty claim,
        // and the pass at start holds it again.
        const aside = NodePath.join(NodePath.dirname(at(COPY)), `.${COPY}.t3-hold`);
        NodeFS.writeFileSync(aside, "set aside");
        NodeFS.writeFileSync(at(COPY), "");
        rewrite({ state: "holding", aside });
        yield* withService((service) =>
          heldWhen(service, (list) => isHeld(list) && !NodeFS.existsSync(at(COPY))),
        );
        expect(NodeFS.existsSync(aside)).toBe(false);
        expect(NodeFS.readFileSync(heldFile(held.id), "utf8")).toBe("set aside");

        // Held in T3's state by an earlier build: copied back whole, then renamed into place.
        const {
          heldFile: _,
          aside: __,
          ...earlier
        } = JSON.parse(NodeFS.readFileSync(recordPath, "utf8"));
        NodeFS.writeFileSync(recordPath, JSON.stringify(earlier));
        NodeFS.renameSync(heldFile(held.id), stateFile(held.id));
        yield* withService((service) => service.putBackHeld({ threadId, path: at(COPY) }));
        expect(NodeFS.readFileSync(at(COPY), "utf8")).toBe("set aside");
        expect(NodeFS.existsSync(stateFile(held.id))).toBe(false);
        expect(
          NodeFS.readdirSync(NodePath.dirname(at(COPY))).filter((name) =>
            name.startsWith(".t3-wip-"),
          ),
        ).toEqual([]);
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
      // Only T3's own file goes: anything else put in its folder stays, and the folder with it.
      NodeFS.writeFileSync(NodePath.join(folder, "notes.txt"), "the person's");
      yield* service.deleteHeld([cube]);
      expect(yield* asked()).toBeUndefined();
      expect(NodeFS.readdirSync(folder)).toEqual(["notes.txt"]);

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

  it.effect(
    "keeps a copy whose workspace isn't there, as a drive not mounted, until it is back",
    () =>
      Effect.gen(function* () {
        const { workspace, at, record, heldWhen, heldFile, recordDir, recordOf, start } =
          yield* heldHost("held-unmounted", {}, "drive/project");
        const unmount = () => NodeFS.renameSync(workspace, `${workspace}.away`);
        const mount = () => NodeFS.renameSync(`${workspace}.away`, workspace);
        // Each day's pass takes the copy's lock as it wakes, so a call taking it waits for it.
        const nextPass = (service: HostedBlender.HostedBlender["Service"], id: string) =>
          TestClock.adjust(Duration.days(1)).pipe(
            Effect.andThen(service.deleteHeld([{ id, heldAt: -1 }])),
          );
        const held = yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* start;
            yield* record(service);
            // Live, its drive gone at the day's pass for its settled thread: nothing to hold yet,
            // and nothing forgotten.
            unmount();
            yield* nextPass(service, recordOf()!.id);
            expect(recordOf()).toMatchObject({ state: "live" });
            mount();
            yield* service.closeOnSettle({ threadId });
            const [held] = yield* heldWhen(service, (list) => list.length === 1);
            // Held, its drive gone at the day's pass, then only its empty mount point there.
            unmount();
            yield* nextPass(service, held!.id);
            NodeFS.mkdirSync(workspace);
            yield* nextPass(service, held!.id);
            expect(yield* heldWhen(service, () => true)).toHaveLength(1);
            NodeFS.rmdirSync(workspace);
            return held!;
          }),
        );

        // Mid-move as T3 stopped, its drive gone at the next start: still recorded.
        const recordPath = NodePath.join(recordDir(held.id), "record.json");
        const written = JSON.parse(NodeFS.readFileSync(recordPath, "utf8"));
        NodeFS.writeFileSync(recordPath, JSON.stringify({ ...written, state: "holding" }));
        yield* Effect.scoped(start.pipe(Effect.flatMap((service) => nextPass(service, held.id))));
        expect(recordOf()).toMatchObject({ state: "holding" });

        // Back: the move finishes, and Reopen puts the copy back.
        mount();
        const service = yield* start;
        expect(yield* service.putBackHeld({ threadId, path: at(COPY) })).toEqual({
          masterChanged: false,
        });
        expect(NodeFS.readFileSync(at(COPY), "utf8")).toBe("working copy");
        // Removed by hand with its workspace there: forgotten at the next pass.
        yield* service.closeOnSettle({ threadId });
        const [again] = yield* heldWhen(service, (list) => list.length === 1);
        NodeFS.rmSync(heldFile(again!.id));
        // Two days: the first pass of a service just started may not have finished to set the next.
        yield* nextPass(service, again!.id);
        yield* nextPass(service, again!.id);
        yield* heldWhen(service, (list) => list.length === 0);
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

  it.live("keeps a waiting recovery copy until it is reopened or dismissed", () =>
    Effect.gen(function* () {
      const {
        dir,
        service,
        openReady,
        awaitStatus,
        awaitDirty,
        saveCommands,
        launches,
        hostedDir,
      } = yield* standIn("pending", "");
      yield* openReady;
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      // Never saved over the user's file: the copy is Blender's own, moved (not copied, so a
      // large file costs no read or write) into T3's private folder, with no launch folder left.
      expect(saveCommands()).toBe(0);
      expect(String(NodeFS.statSync(recoveryOf(hostedDir)!.session).ino), "moved").toBe(
        NodeFS.readFileSync(NodePath.join(dir, "saves.log.quitInode"), "utf8"),
      );
      expect(NodeFS.readdirSync(NodePath.join(hostedDir, "launches"))).toEqual([]);
      // A Quit with nothing running never removes it.
      yield* service.quit({ threadId, save: false });
      expect((yield* firstState(service)).status, "a Quit with nothing running").toBe("closed");
      expect(recoveryOf(hostedDir)?.contents).toMatch(/^quit copy /);
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
      const session = recoveryOf(hostedDir)?.session;
      yield* service.reopen({ threadId, key: CUBE, restore: true });
      yield* awaitDirty(true);
      // Blender opens the user's file and the copy is restored over it, so saves still go there.
      const reopened = launches().at(-1)!;
      expect(reopened.slice(reopened.indexOf("--t3-recover"))).toEqual([
        "--t3-recover",
        session,
        "--t3-timeline",
      ]);
      expect(reopened).toContain(NodeFS.realpathSync(NodePath.join(dir, "cube.blend")));
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
      // The person's Quit without saving discards restored changes, and the copy they came from.
      yield* service.open({ threadId, relativePath: "other.blend" });
      yield* awaitDirty(true);
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      yield* service.reopen({ threadId, key: OTHER, restore: true });
      yield* awaitDirty(true);
      yield* service.quit({ threadId, save: false, discard: true });
      expect(yield* awaitStatus("stopped")).toEqual({ status: "stopped" });
      expect(recoveryOf(hostedDir, OTHER), "discarded with its restored changes").toBeNull();
    }).pipe(Effect.scoped),
  );

  it.live("a discard released at shutdown brings nothing back after the restart", () =>
    Effect.gen(function* () {
      const { dir, layer, marker } = yield* standIn("slow-discard", "");
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
        // From here a quit outlasts T3's shutdown deadline.
        NodeFS.writeFileSync(NodePath.join(dir, "slow-quit"), "");
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

  it.live(
    "B5: deleting a thread ends its Blender and removes every copy it kept, not a master's",
    () =>
      Effect.gen(function* () {
        const { dir, layer, hostedDir } = yield* standIn("deleted", "");
        const at = (name: string) => NodePath.join(NodeFS.realpathSync(dir), name);
        NodeFS.writeFileSync(at("other.blend"), "other master");
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
        // Its working copies: one of cube.blend held at settle, one of other.blend still in the
        // project with its backup.
        const copy = workingCopyName("cube.blend", threadId);
        const otherCopy = workingCopyName("other.blend", threadId);
        const recordCopy = (name: string, master: string) =>
          service.recordWorkingCopy({
            threadId,
            master: at(master),
            path: at(name),
            relativePath: name,
          });
        NodeFS.writeFileSync(at(copy), "working copy");
        yield* recordCopy(copy, "cube.blend");
        yield* service.closeOnSettle({ threadId });
        const heldWhen = (done: (list: HostedBlenderHeldList) => boolean) =>
          service.heldCopies.pipe(
            Stream.filter(done),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
        const [held] = yield* heldWhen((list) => list.length === 1);
        const heldFile = at(NodePath.join(".t3", "held-working-copies", held!.id, "copy.blend"));
        NodeFS.writeFileSync(at(otherCopy), "other copy");
        NodeFS.writeFileSync(at(`${otherCopy}1`), "backup");
        yield* recordCopy(otherCopy, "other.blend");
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
        // Its held copy and its copy still in the project go with their backups; masters stay.
        yield* heldWhen((list) => list.length === 0);
        expect(NodeFS.existsSync(heldFile), "held copy").toBe(false);
        expect(NodeFS.existsSync(at(otherCopy)), "copy in the project").toBe(false);
        expect(NodeFS.existsSync(at(`${otherCopy}1`)), "its backup").toBe(false);
        expect(NodeFS.readFileSync(at("other.blend"), "utf8")).toBe("other master");
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

  it.live("restores the newest autosave when asked after a crash", () =>
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
      expect(launches(), "no relaunch after a crash").toHaveLength(1);
      expect((yield* firstState(service)).status).toBe("crashed");
      // Restart opens the file from disk.
      yield* service.reopen({ threadId, key: CUBE, restore: false });
      yield* awaitDirty(true);
      expect(launches()).toHaveLength(2);
      expect(launches().at(-1), "Restart").not.toContain("--t3-recover");
      // Crashed again, Restore autosave reopens the newest autosave.
      crash();
      yield* awaitStatus("crashed");
      yield* service.reopen({ threadId, key: CUBE, restore: true });
      yield* awaitDirty(true);
      expect(launches().at(-1), "Restore autosave").toContain(recoveryOf(hostedDir)?.session);
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
      // Nobody watched while Blender started, so it started paused; each pane coming back on
      // screen resumed it, and nothing else did.
      expect(ofType(helperCommands(), "pause", "resume").map((command) => command.type)).toEqual([
        "pause",
        "resume",
        "pause",
        "resume",
        "pause",
        "resume",
      ]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "sizes the display to the viewer in control, else the latest pane on screen with a size",
    () =>
      Effect.gen(function* () {
        const { service, awaitDirty, helperCommands } = yield* standIn("display-size", "");
        // Read once the helper has every command sent before, so the last ones are the latest.
        const resizes = () => ofType(helperCommands(), "resize");
        const size = (width: number, height: number) => ({ type: "resize", width, height });

        // A pane that connected while Blender was starting is sized once the helper runs: a size
        // sent before there is a helper to resize doesn't count as applied.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* service.open({ threadId, relativePath: "cube.blend" });
            const early = yield* attach(service, true);
            yield* early.resize(1046, 1336);
            yield* awaitDirty(true);
            yield* early.input({ type: "takeControl", takeOver: false });
            yield* controller(early).pipe(Effect.repeat({ until: (c) => c === "you" }));
            yield* syncPoint(early);
            expect(resizes(), "a pane sized while Blender was starting").toEqual([
              size(1046, 1336),
            ]);
          }),
        );

        // The viewer in control sizes the display: a newer pane doesn't, a take it lost the race
        // for still tells it who has control, and a take over resizes to the new controller.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const operator = yield* attach(service, true);
            yield* operator.resize(800, 600);
            expect(yield* controller(operator)).toBe("unclaimed");
            yield* operator.input({ type: "takeControl", takeOver: false });
            expect(yield* controller(operator)).toBe("you");
            const newer = yield* attach(service, true);
            yield* newer.resize(1600, 900);
            expect(yield* controller(newer)).toBe("another-viewer");
            yield* newer.input({ type: "takeControl", takeOver: false });
            expect(yield* controller(newer), "a refused take").toBe("another-viewer");
            yield* operator.resize(1024, 768);
            yield* syncPoint(operator);
            // Told the cursor's state as it joined, then that the controller's press captured it.
            expect(
              yield* nextMessage(newer, "cursor").pipe(
                Effect.repeat({ until: (message) => message.captured }),
              ),
            ).toEqual({ type: "cursor", captured: true });
            yield* newer.input({ type: "takeControl", takeOver: true });
            expect(yield* nextMessage(newer, "cursor")).toEqual({
              type: "cursor",
              captured: false,
            });
            yield* syncPoint(newer);
            expect(resizes().slice(-3), "sized to the viewer in control").toEqual([
              size(800, 600),
              size(1024, 768),
              size(1600, 900),
            ]);
          }),
        );

        // With nobody in control, the latest pane on screen with a size: a floating player sends
        // none and leaves the display alone, and hiding the newest pane hands the size back.
        const older = yield* attach(service, false);
        yield* older.resize(800, 600);
        yield* nextMessage(older, "viewport").pipe(
          Effect.repeat({ until: (message) => message.width === 800 }),
        );
        const newer = yield* attach(service, false);
        yield* newer.resize(1600, 900);
        yield* nextMessage(older, "viewport");
        yield* attach(service, false);
        yield* newer.setVisible(false);
        yield* nextMessage(older, "viewport");
        yield* newer.setVisible(true);
        expect(yield* nextMessage(older, "viewport")).toEqual({
          type: "viewport",
          width: 1600,
          height: 900,
        });
        expect(resizes().slice(-4), "sized to the latest pane on screen").toEqual([
          size(800, 600),
          size(1600, 900),
          size(800, 600),
          size(1600, 900),
        ]);
      }).pipe(Effect.scoped),
  );
});

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
    // Reported until dismissed.
    yield* service.dismiss({ threadId });
    yield* awaitStatus("stopped");
    // A helper that exits at once, as one does when Blender can't open the file, fails too.
    const exits = yield* idleService(yield* tempDir("failed"));
    yield* exits.open({ threadId, relativePath: "cube.blend" });
    yield* exits.threadState(threadId).pipe(
      Stream.filter((state) => state.status === "failed"),
      Stream.runHead,
    );
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

      // A file counts as open where Blender has it open now, as well as where it started.
      const switched = yield* standIn("switched-open", "switches");
      NodeFS.writeFileSync(NodePath.join(switched.dir, "other.blend"), "");
      yield* switched.service.open({ threadId, relativePath: "cube.blend" });
      yield* switched.awaitDirty(true);
      const switchedTo = yield* switched.service
        .open({ threadId: otherThreadId, relativePath: "other.blend" })
        .pipe(Effect.flip);
      expect(switchedTo.reason, "a file Blender switched to").toBe("openInAnotherThread");
    }).pipe(Effect.scoped),
  );
});

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
  /** The first capture once the add-on's connection and viewport window are up. */
  const firstCapture = (service: HostedBlender.HostedBlender["Service"]) =>
    service.captureView(threadId).pipe(
      Effect.retry({
        while: (error) => error.reason === "noReply" || error.reason === "noViewport",
        schedule: Schedule.spaced("500 millis"),
        times: 40,
      }),
    );

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
second = list(sent)
# Edited again, a quit that asks without saving is held too: had it gone ahead, Blender would
# have exited before printing.
paint.pixels[0] = 0.5
sent.clear()
_handle({"type": "quit", "save": False, "hold": True})
print("T3-RESULT", json.dumps({
    "first": [message["type"] for message in first],
    "held": [message.get("images") for message in first if message["type"] == "quitFailed"],
    "dirty": dirty,
    "second": [message["type"] for message in second],
    "unsaved": sent,
}))`);
      expect(result(first)).toEqual({
        first: ["saving", "quitFailed"],
        held: [["locked"]],
        dirty: ["locked"],
        second: ["saving", "saved"],
        unsaved: [{ type: "quitFailed", reason: "images" }],
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

      // A large viewport's screenshot comes back scaled down, keeping its shape. Frames at the
      // new size mean Blender's window, and its 3D view, have grown.
      yield* viewer.resize(3840, 2160);
      yield* nextMessage(viewer, "viewport").pipe(
        Effect.repeat({ until: (message) => message.width >= 3000 }),
      );
      // The viewport looks through its own local camera, not the scene's (until the orbit below
      // leaves camera view), and Blender renders the screenshot from that same view.
      const throughCamera = yield* firstCapture(service);
      const { width, height } = throughCamera.screenshot;
      expect(width * height, "scaled down").toBeLessThanOrEqual(1920 * 1088);
      expect(width * height).toBeGreaterThan(1_800_000);
      expect(width / height, "its shape kept").toBeGreaterThan(1.6);
      expect(width / height).toBeLessThan(2.2);
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
      // Each screenshot is read, then removed from the control socket's private folder.
      const pngs = () =>
        NodeFS.readdirSync(NodePath.dirname(argv[argv.indexOf("--t3-control") + 1]!)).filter(
          (name) => name.endsWith(".png"),
        );
      expect(pngs()).toEqual([]);

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
// bpy.ops.wm.open_mainfile does, then edits it through undo so it reads unsaved. On
// HB_TEST_DIR/viewports, writes how many viewport windows it has to viewports.count.
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
    # How many of T3's viewport windows Blender has, besides its main window.
    probe = os.path.join(os.environ.get("HB_TEST_DIR", ""), "viewports")
    if os.path.exists(probe):
        os.remove(probe)
        windows = bpy.context.window_manager.windows
        count = len([w for i, w in enumerate(windows) if i > 0 and w.screen.get("t3_viewport")])
        with open(probe + ".part", "w") as out:
            out.write(str(count))
        os.replace(probe + ".part", probe + ".count")
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
            entry["shading"] = area.spaces.active.shading.type
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
            elif verb == "shading":
                # "<engine> <shading>": Cycles on the CPU at one sample, so the view costs little.
                engine, shading = argument.split(" ")
                scene = window.scene
                scene.render.engine = engine
                if engine == "CYCLES":
                    scene.cycles.device = "CPU"
                    scene.cycles.preview_samples = 1
                view.spaces.active.shading.type = shading
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
  /** A 3D view's shading, such as SOLID or RENDERED. */
  readonly shading?: string;
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
        const { service, command, layoutWhen, workspace } = yield* launch("timeline-strip");
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
        // Never a blank picture: Cycles' rendered shading can't be drawn offscreen, so it has no
        // screenshot; every other engine and shading can.
        const engine = first.render.split(" ")[0]!;
        for (const [shownWith, drawn] of [
          ["CYCLES RENDERED", false],
          ["CYCLES SOLID", true],
          ["BLENDER_EEVEE RENDERED", true],
          ["BLENDER_WORKBENCH RENDERED", true],
          [`${engine} SOLID`, true],
        ] as const) {
          command(`shading ${shownWith}`);
          const [shownEngine, shading] = shownWith.split(" ");
          yield* layoutWhen(
            (layout) =>
              layout.render.startsWith(`${shownEngine} `) &&
              layout.windows[0]?.areas[0]?.shading === shading,
          );
          const shot = yield* service.captureView(threadId).pipe(
            Effect.as(true),
            Effect.catchIf(
              (error) => error.reason === "noScreenshot",
              () => Effect.succeed(false),
            ),
          );
          expect(shot, shownWith).toBe(drawn);
        }
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
        // Another frame is another scene to a mark: the earlier picture's hits are refused.
        expect(risen.scene, "a frame change names a new scene").not.toBe(framed.scene);
        expect((yield* centre(framed).pipe(Effect.flip)).reason).toBe("sceneChanged");

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
        // Each step waits for a tick of Blender's, so it reads the drag as motion, not all at once.
        const edge = Math.round(window.height - (strip.y + strip.height + view.y) / 2);
        const middle = Math.round(band.x + band.width * 0.5);
        const tick = Effect.gen(function* () {
          const now = yield* layoutWhen(() => true);
          yield* layoutWhen((layout) => layout.tick > now.tick);
        });
        yield* operator.input({ type: "pointer", x: middle, y: edge });
        yield* operator.input({ type: "button", button: 272, pressed: true });
        yield* tick;
        for (const step of [5, 10, 20, 30, 40, 50, 60]) {
          yield* operator.input({ type: "pointer", x: middle, y: edge - step });
          yield* tick;
        }
        yield* operator.input({ type: "button", button: 272, pressed: false });
        const grown = yield* layoutWhen(
          (layout) => withStrip(layout) && layout.windows[0]!.areas[1]!.height > strip.height + 30,
          25,
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

        // Save and quit with unsaved edits and the frame picked in the strip ends saved,
        // keeping nothing, with the edit on disk.
        command("edit T3Edit");
        yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
        );
        yield* operator.input({ type: "releaseControl" });
        yield* service.quit({ threadId, save: true });
        const ended = yield* service.threadState(threadId).pipe(
          Stream.filter((state) => state.status !== "running"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(card(ended), "Save and quit after a frame pick").toEqual({ status: "stopped" });
        expect(objectsIn(NodePath.join(workspace, "cube.blend"))).toContain("T3Edit");
      }).pipe(Effect.scoped),
  );

  it.live(
    "switches the strip on a running Blender without restarting it, and keeps it as switched after a load and a reopen",
    () =>
      Effect.gen(function* () {
        const { service, settings, command, layoutWhen, workspace, writeOutside } =
          yield* launch("timeline-switch-real");
        const first = yield* layoutWhen(withStrip);
        const pointer = first.windows[0]!.pointer;
        yield* settings.updateSettings({ hostedBlenderTimeline: false });
        const off = yield* layoutWhen(alone);
        // The pane's menu writes the same setting.
        yield* service.setTimeline(true);
        const on = yield* layoutWhen(withStrip);
        expect((yield* settings.getSettings).hostedBlenderTimeline).toBe(true);
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
        // In it, a reload when the file changes on disk keeps the one viewport window, the strip
        // as switched and the view. Reloads run while a pane is on screen.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const viewer = yield* attach(service, false);
            yield* Queue.take(viewer.output).pipe(
              Effect.repeat({ until: (output) => output._tag === "frame" }),
            );
            // The window the copy brought back has been replaced by now, as the stream shows.
            const shown = yield* layoutWhen(
              (layout) => withStrip(layout) && layout.pid === reopened.pid,
            );
            const same = (layout: Layout) =>
              layout.windows.length === 1 &&
              layout.windows[0]!.pointer === shown.windows[0]!.pointer;
            yield* service.setView({
              threadId,
              relativePath: "cube.blend",
              view: { position: [6, -6, 5], target: [0, 0, 0] },
            });
            const sameView = Effect.gen(function* () {
              const view = yield* service.captureView(threadId);
              view.cameraView.position.forEach((value, index) =>
                expect(value).toBeCloseTo([6, -6, 5][index]!, 3),
              );
            });
            writeOutside(4);
            const reloaded = yield* layoutWhen((layout) => layout.mark === 4);
            expect(withStrip(reloaded) && same(reloaded), "a reload with the strip on").toBe(true);
            yield* sameView;
            // Switched off from the pane's menu, a reload leaves it off.
            yield* service.setTimeline(false);
            yield* layoutWhen((layout) => alone(layout) && same(layout));
            writeOutside(-3);
            const again = yield* layoutWhen((layout) => layout.mark === -3);
            expect(alone(again) && same(again), "a reload with the strip off").toBe(true);
            yield* sameView;
          }),
        );
        yield* service.quit({ threadId, save: false, discard: true });

        // A launch while it is off starts without the strip (of the other file: the reload
        // kept cube.blend's unsaved work as its copy).
        yield* service.open({ threadId, relativePath: "other.blend" });
        const launchedOff = yield* layoutWhen(
          (layout) => alone(layout) && layout.pid !== reopened.pid,
        );
        expect(
          NodeFS.readFileSync(`/proc/${launchedOff.pid}/cmdline`, "utf8").split("\0"),
        ).not.toContain("--t3-timeline");
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
  // The title bar over a floating window, in output pixels: as tall as the helper's close button.
  const TITLE_BAR = 40;

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
        yield* click(left + width - TITLE_BAR / 2, top + TITLE_BAR / 2);
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
      const saved = NodeFS.statSync(copy).ino;
      yield* service.closeOnSettle({ threadId });
      yield* awaitState(ended);
      const [held] = yield* heldWhen((list) => list.length === 1);
      expect(NodeFS.existsSync(copy)).toBe(false);
      expect(NodeFS.existsSync(`${copy}1`)).toBe(false);
      expect(objects(heldFile(held!.id))).toContain("T3Saved");
      // Renamed into the workspace's own folder, the same file, which git ignores.
      expect(NodeFS.statSync(heldFile(held!.id)).ino).toBe(saved);
      const git = (...args: ReadonlyArray<string>) =>
        NodeChildProcess.execFileSync("git", args, {
          cwd: NodePath.dirname(copy),
          encoding: "utf8",
        });
      git("init", "-q");
      expect(git("check-ignore", heldFile(held!.id)).trim()).toBe(heldFile(held!.id));

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
        // Every reader of setup's readiness hears each switch, as Settings' changes reach them.
        const switches = yield* PubSub.unbounded<HostedBlenderSetup.HostedBlenderReadiness>();
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
          readinessChanges: Stream.fromPubSub(switches),
        };
        const service = yield* serviceFor(layerFor(host));
        const states = yield* Queue.unbounded<HostedBlenderThreadState>();
        yield* service.threadState(threadId).pipe(
          Stream.runForEach((state) => Queue.offer(states, state)),
          Effect.forkScoped,
        );
        const awaitState = (matches: (state: HostedBlenderThreadState) => boolean) =>
          Queue.take(states).pipe(Effect.repeat({ until: matches }), Effect.map(card));
        // How many of T3's viewport windows the running Blender has.
        const viewports = Effect.gen(function* () {
          const count = NodePath.join(dir, "viewports.count");
          NodeFS.rmSync(count, { force: true });
          NodeFS.writeFileSync(NodePath.join(dir, "viewports"), "");
          yield* fileAppears(dir, count);
          return Number(NodeFS.readFileSync(count, "utf8"));
        });
        // The size the stream settles at, asked for 1046x1336, after `then` runs.
        const settledSize = (then: Effect.Effect<void> = Effect.void, role?: "master") =>
          Effect.gen(function* () {
            const attached = yield* service.attachViewer(threadId, {
              canOperate: false,
              ...(role === undefined ? {} : { role }),
            });
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

        expect(yield* viewports, "after File > Open").toBe(1);

        yield* service.closeOnSettle({ threadId });
        yield* awaitState((state) => state.status === "closed");
        yield* service.reopen({ threadId, key: OTHER, restore: true });
        expect(yield* settledSize()).toBe("1046x1336");
        // The copy brings T3's viewport window back with it: it is replaced, never a second.
        expect(yield* viewports, "after Reopen of a copy").toBe(1);
        yield* service.quit({ threadId, save: false, discard: true });
        yield* awaitState((state) => state.status === "stopped");

        // A master the same: edited, switched off it closes into its copy, and switched on
        // again its Reopen fills the pane, the viewer attached from its first frame.
        yield* service.openMaster({ threadId, relativePath: "cube.blend" });
        yield* service.masterState(threadId).pipe(
          Stream.filter((state) => state.status === "running"),
          Stream.runHead,
        );
        NodeFS.writeFileSync(
          NodePath.join(dir, "open-file"),
          NodePath.join(workspace, "cube.blend"),
        );
        yield* service.masterState(threadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
        );
        yield* PubSub.publish(switches, { status: "notSetUp", missing: ["enabled"] });
        const closed = yield* service.masterState(threadId).pipe(
          Stream.filter((state) => state.status === "closed"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        yield* PubSub.publish(switches, readinessFor(host));
        const key = "copies" in closed ? closed.copies[0].key : "";
        yield* service.reopen({ threadId, key, restore: true, role: "master" });
        expect(yield* settledSize(Effect.void, "master"), "a master's Reopen").toBe("1046x1336");
        expect(yield* viewports, "after a master's Reopen").toBe(1);
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
        yield* Effect.gen(function* () {
          const first = yield* serviceFor(layer);
          const awaitState = yield* watch(first);
          yield* first.open({ threadId, relativePath: "cube.blend" });
          yield* awaitState((state) => state.status === "running" && state.dirty);
        }).pipe(Effect.scoped);
        // T3 is gone while Blender, by the pid it wrote itself, still writes.
        const stat = NodeFS.readFileSync(
          `/proc/${NodeFS.readFileSync(NodePath.join(dir, "blender.pid"), "utf8")}/stat`,
          "utf8",
        );
        expect(stat.slice(stat.lastIndexOf(")") + 2)[0], "T3 never waited for it").not.toBe("Z");
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
    server = socket.socket(socket.AF_UNIX)
    server.bind(t3[1])
    server.listen(1)
    connection, _ = server.accept()
    def state(filepath, dirty=os.environ.get("STANDIN_DIRTY") == "1", **extra):
        connection.sendall((json.dumps({"type": "state", "filepath": filepath, "dirty": dirty,
                                        "agentListener": listener[0], **extra}) + "\n").encode())
    after = os.environ.get("STANDIN_AFTER")
    # Another file already open by the time T3 hears, claiming its listener is ready.
    if after == "otherFileFirst":
        listener[0] = "ready"
        state(os.environ.get("STANDIN_OTHER", "/elsewhere/other.blend"))
    else:
        # As the add-on does once a restore T3 asked for has run.
        state(blend, **({"restore": "ok"} if "--t3-recover" in t3 else {}))
    for line in connection.makefile():
        with open(os.environ["STANDIN_ARGS"] + ".control", "a") as log:
            log.write(line)
        kind = json.loads(line).get("type")
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
            state(blend, agentActing=after == "acting", mcpVersion="1.0.3")
            if after == "otherFile":
                # Someone opens another file through Blender's own UI.
                state(os.environ.get("STANDIN_OTHER", "/elsewhere/other.blend"))
        command = json.loads(line)
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
        if kind == "stopAgentListener" and after == "acting":
            # The add-on stops acting as access ends; then Blender is gone, as below.
            state(blend, agentActing=False, mcpVersion="1.0.3")
        if kind == "stopAgentListener" and os.environ.get("STANDIN_STAY_ON_STOP") == "1":
            # As the add-on does: access ends, Blender stays open for what T3 asks next.
            listener[0] = "off"
            continue
        if kind == "stopAgentListener":
            # Gone once it has heard the stop, so a test can wait for the stopped state; it says
            # Blender exited cleanly, as one quit from its own menu does (otherwise, a crash).
            event({"type": "exited", "process": "blender", "code": 0, "signal": None})
            os._exit(0)
        if kind == "quit" and not command.get("save") and command.get("hold") and after == "holdsQuit":
            # Unsaved image edits hold it, as the add-on does, and it says so until they're saved.
            connection.sendall((json.dumps({"type": "quitFailed", "reason": "images",
                                            "id": command.get("id")}) + "\n").encode())
            state(blend, quitHeld="images")
            continue
        if kind == "quit" and not command.get("save"):
            # As the add-on does: its last word on the file it has open, unsaved as it is now
            # (STANDIN_UNSAVED: edited since its last report), then Blender's quit copy.
            open_file = os.environ["STANDIN_OTHER"] if after == "otherFileFirst" else blend
            dirty = os.environ.get("STANDIN_DIRTY") == "1" or os.environ.get("STANDIN_UNSAVED") == "1"
            connection.sendall((json.dumps({"type": "quitting", "filepath": open_file, "id": command.get("id"),
                                            "dirty": dirty}) + "\n").encode())
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
                os._exit(0)
            asked = json.loads(line).get("id")
            def refuse():
                connection.sendall((json.dumps({"type": "quitRefused", "id": asked}) + "\n").encode())
            # STANDIN_UNSAVED: edits made after the last state T3 heard, so Blender won't quit.
            (refuse if os.environ.get("STANDIN_UNSAVED") == "1" else exit_now)()
threading.Thread(target=control, daemon=True).start()
for line in sys.stdin:
    if '"quit"' in line:
        break
`;

describe("Agent access at launch", () => {
  const launch = Effect.fn(function* (
    host: Pick<
      Host,
      "runtimeMode" | "interactionMode" | "agentPort" | "revocations" | "accessEnded"
    >,
    options: { readonly agentWorkingCopy?: boolean; readonly edited?: boolean } = {
      agentWorkingCopy: true,
    },
    after?: "otherFile" | "otherFileFirst" | "holdsQuit" | "offAfterSaved" | "acting",
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
      expect(yield* launchArgs({}), "no agent session").not.toContain("--t3-mcp-listen");
      // Never in a file the pane opened, even the working copy.
      const pane = yield* launch({ agentPort: 41234 }, {});
      expect(pane.args, "opened by the pane").not.toContain("--t3-mcp-listen");
      expect((yield* pane.service.agentListener(threadId))?.state).toBe("off");
      yield* pane.service.quit({ threadId, save: false });
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
        const { service, controlLog } = yield* launch(
          {
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
          },
          undefined,
          "acting",
        );
        expect((yield* service.agentListener(threadId))?.state).toBe("ready");
        // The pane's badge follows the add-on: the agent shows as acting while it says so.
        const acting = (value: boolean) =>
          service.threadState(threadId).pipe(
            Stream.filter(
              (state) => state.status === "running" && (state.agentActing === true) === value,
            ),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
        expect(yield* acting(true)).toMatchObject({ agentActing: true });
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
        const dropped = yield* acting(false).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Queue.offer(revoked, null);
        // Access ended, the badge goes.
        expect(yield* Fiber.join(dropped), "the badge once access ends").not.toHaveProperty(
          "agentActing",
        );
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

      // Another file open from Blender's first report: no listener state is taken from it.
      const first = yield* launch({ agentPort: 41234 }, undefined, "otherFileFirst");
      expect(yield* first.service.agentListener(threadId)).toEqual({
        state: "off",
        ended: "otherFile",
        openFile: "/elsewhere/other.blend",
        mcpVersion: null,
      });
      yield* first.service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "stopped"),
        Stream.runHead,
      );
      // The grant waits for a snapshot of the launch file, which never came.
      expect(first.controlLog(), "nothing granted").not.toContain("grantAgentListener");
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
      expect(snapshotArg(pane.args), "the pane's launch").toBeUndefined();
      yield* pane.service.quit({ threadId, save: false });
      // None when Blender Lab can't be copied whole.
      const partial = yield* launch(
        { agentPort: 41234 },
        undefined,
        undefined,
        withBlenderLab(true),
      );
      expect(snapshotArg(partial.args), "a partial copy").toBeUndefined();
      yield* partial.service.quit({ threadId, save: false });
    }).pipe(Effect.scoped),
  );
});

/** Sends a byte to the loopback port and answers what comes back, or how it failed. */
const onLinux = HostProcess.Platform.defaultValue() === "linux";

/** Connects through a relay and stays connected, saying nothing, until the far end closes. */
const holdOpen = (port: number) =>
  Effect.callback<{ readonly closed: Promise<void> }>((resume) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    const closed = new Promise<void>((done) => socket.on("close", () => done()));
    socket.on("error", () => undefined);
    socket.on("connect", () => resume(Effect.succeed({ closed })));
  });

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
      ...(host.dirty ? { STANDIN_DIRTY: "1" } : {}),
      ...(host.unsaved ? { STANDIN_UNSAVED: "1" } : {}),
      ...(host.stayOnStop ? { STANDIN_STAY_ON_STOP: "1" } : {}),
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
      expect(masterCopyIn(host.dir, host.blendPath), "a clean quit keeps nothing").toBeNull();
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

        // Open in T3 Code on the Master side, as the preview button and the pane's card do,
        // chooses it and joins the running master Blender.
        yield* service.knowMaster({ threadId, relativePath: "cube.blend" });
        yield* service.openMaster({ threadId: otherThreadId, relativePath: "cube.blend" });
        yield* host.masterStatus(otherThreadId, "running");
        yield* service.reopenMaster(threadId);
        expect((yield* host.masterStatus(threadId, "running")).status).toBe("running");
        expect(host.launches(), "joined, not started").toBe(2);
        // Chosen now, it keeps the master Blender open after the other thread leaves.
        yield* service.releaseMaster(otherThreadId);
        expect((yield* firstMaster(service, threadId)).status, "chosen").toBe("running");
        const left = yield* watchMaster(service, threadId);
        yield* service.releaseMaster(threadId);
        yield* left;
      }).pipe(Effect.scoped),
  );

  it.live("stays open with unsaved changes after the last thread leaves", () =>
    Effect.gen(function* () {
      const net = yield* NetService.NetService;
      const switches = yield* Queue.unbounded<HostedBlenderSetup.HostedBlenderReadiness>();
      // Reported clean, then edited before T3 asks it to quit: only Blender itself can say.
      const host = yield* masterHost({
        masterPorts: new Map([[threadId, yield* net.reserveLoopbackPort()]]),
        unsaved: true,
        stayOnStop: true,
        readinessChanges: Stream.fromQueue(switches),
      });
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
      expect(host.controlLog(), "asks Blender, not its last report").toContain("quitIfClean");
      // Still the thread's to see and quit, so nothing is lost or left running unseen.
      expect((yield* firstMaster(service, threadId)).status).toBe("running");
      yield* service.openMaster({ threadId, relativePath: "cube.blend" });
      expect(host.launches()).toBe(1);
      // Nor does the thread switch to another master, leaving it where no thread can reach it.
      const refused = yield* service
        .openMaster({ threadId, relativePath: "other.blend" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("masterUnsaved");
      expect(yield* firstMaster(service, threadId)).toMatchObject({ relativePath: "cube.blend" });
      // A refusal records nothing: a later close still keeps its copy.
      yield* Queue.offer(switches, { status: "notSetUp", missing: ["enabled"] });
      yield* host.masterStatus(threadId, "closed");
      expect(masterCopyIn(host.dir, host.blendPath)?.contents).toMatch(/^quit copy /);
    }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );

  it.live("never shares its file with a working Blender", () =>
    Effect.gen(function* () {
      const { service, dir } = yield* masterHost();
      NodeFS.linkSync(NodePath.join(dir, "cube.blend"), NodePath.join(dir, "linked.blend"));
      yield* service.open({ threadId, relativePath: "cube.blend" });
      const refused = yield* service
        .openMaster({ threadId: otherThreadId, relativePath: "cube.blend" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("openInAnotherThread");
      // A hard link to the open file is that file.
      const linked = yield* service
        .openMaster({ threadId: otherThreadId, relativePath: "linked.blend" })
        .pipe(Effect.flip);
      expect(linked.reason, "a hard link").toBe("openInAnotherThread");
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
        const privatePort = yield* net.reserveLoopbackPort();
        const ended = new Set<ThreadId>();
        const host = yield* masterHost({
          masterPorts: ports,
          revocations: Stream.fromQueue(revoked),
          privatePort,
          endedSessions: ended,
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
        // Blender Lab listens on a private port from the threads' registry, never on either
        // thread's.
        const own = Number(host.args()[host.args().indexOf("--t3-mcp-port") + 1]);
        expect(own).toBe(privatePort);
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
        // Asked again for a session that has since ended, it never listens for that thread.
        ended.add(threadId);
        yield* service.openMaster(
          { threadId, relativePath: "cube.blend" },
          { agentSession: "session-1" },
        );
        expect(
          (yield* service.agentListener(threadId, { role: "master", wait: false }))?.state,
          "an ended session",
        ).not.toBe("ready");
        expect(yield* ping(ports.get(threadId)!)).toBe("ECONNREFUSED");

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
        const ended = new Set<ThreadId>();
        const revoked =
          yield* Queue.unbounded<HostedBlenderAgents.HostedBlenderRevocation | null>();
        const accessEnded = yield* Queue.unbounded<{
          readonly threadId: ThreadId;
          readonly role: HostedBlenderAgents.HostedBlenderRole;
          readonly grant: string;
        }>();
        let installed = "";
        const host = yield* masterHost({
          masterPorts: ports,
          revocations: Stream.fromQueue(revoked),
          sessions,
          endedSessions: ended,
          accessEnded,
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
        const offWhen = (id: ThreadId) =>
          service
            .agentListener(id, { role: "master" })
            .pipe(Effect.repeat({ until: (report) => report?.state === "off" }));
        const join = (id: ThreadId, session: string) =>
          Effect.gen(function* () {
            sessions.set(id, session);
            yield* service.openMaster(
              { threadId: id, relativePath: "cube.blend" },
              { agentSession: session },
            );
            expect((yield* service.agentListener(id, { role: "master" }))?.state).toBe("ready");
          });
        yield* join(threadId, "session-1");
        expect(yield* ping(ports.get(threadId)!)).toBe("pong");
        // Blender Lab loads from a snapshot taken for this launch.
        const snapshot = host.args()[host.args().indexOf("--t3-mcp-snapshot") + 1]!;
        const snapshotted = () =>
          NodeFS.readFileSync(NodePath.join(snapshot, "mcp", "__init__.py"), "utf8");
        expect(snapshotted()).toBe("# 1.0.3\n");

        // The thread's only agent session ends: no agent thread is left, and no relay listens.
        yield* Queue.offer(revoked, { threadId, session: "session-1" });
        yield* offWhen(threadId);
        expect(yield* ping(ports.get(threadId)!)).toBe("ECONNREFUSED");
        expect(yield* ping(ports.get(otherThreadId)!)).toBe("ECONNREFUSED");

        // The same thread's next session reaches the running master through a fresh relay.
        yield* join(threadId, "session-2");
        expect(yield* ping(ports.get(threadId)!)).toBe("pong");

        // So does a second thread arriving after the first one's access ended, though the
        // user updated Blender Lab meanwhile: the launch's snapshot is never retaken.
        yield* Queue.offer(revoked, { threadId, session: "session-2" });
        yield* offWhen(threadId);
        NodeFS.writeFileSync(NodePath.join(installed, "__init__.py"), "# newer\n");
        yield* join(otherThreadId, "session-1");
        expect(yield* ping(ports.get(otherThreadId)!)).toBe("pong");
        expect(snapshotted(), "one snapshot per launch").toBe("# 1.0.3\n");

        // A relay serves only the session it was opened for, and a revocation ends only what
        // that session was granted: one for a session replaced before this one ends nothing.
        yield* join(threadId, "session-3");
        yield* Queue.takeAll(accessEnded);
        const relay = yield* service.agentGrant({
          threadId: otherThreadId,
          role: "master",
          session: "session-1",
        });
        expect(relay).toMatchObject({ _tag: "granted", port: ports.get(otherThreadId) });
        expect(
          (yield* service.agentGrant({ threadId, role: "master", session: "session-9" }))._tag,
          "another session",
        ).toBe("none");
        yield* Queue.offer(revoked, { threadId, session: "session-0" });
        yield* Queue.offer(revoked, { threadId: otherThreadId, session: "session-1" });
        yield* offWhen(otherThreadId);
        expect(yield* ping(ports.get(threadId)!), "an older session's revocation").toBe("pong");
        expect(yield* ping(ports.get(otherThreadId)!)).toBe("ECONNREFUSED");
        // Its relay's closing stops that session's Blender Lab server too, and no other.
        expect(yield* Queue.take(accessEnded)).toEqual({
          threadId: otherThreadId,
          role: "master",
          grant: relay._tag === "granted" ? relay.grant : "",
        });
        expect(yield* Queue.size(accessEnded)).toBe(0);

        // A session that is no longer the one that asked loses its relay at the next change.
        ended.add(threadId);
        yield* join(otherThreadId, "session-2");
        expect(yield* ping(ports.get(threadId)!), "a replaced session's relay").toBe(
          "ECONNREFUSED",
        );
        expect(yield* ping(ports.get(otherThreadId)!)).toBe("pong");

        // A connection still open on a replaced session closes once its revocation arrives,
        // though the new session's grant came first.
        ended.delete(threadId);
        yield* join(threadId, "session-4");
        const old = yield* holdOpen(ports.get(threadId)!);
        yield* join(threadId, "session-5");
        yield* Queue.offer(revoked, { threadId, session: "session-4" });
        yield* Effect.promise(() => old.closed);
        expect(yield* ping(ports.get(threadId)!)).toBe("pong");

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
  return {
    service,
    saved,
    /** What the desktop Blender has open from now on. */
    set: (next: DesktopBlender.DesktopBlenderProbe) => {
      probe = next;
    },
  };
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

        // Reopen restores the copy in a master Blender, which other threads then join.
        const key = "copies" in closed ? closed.copies[0].key : "";
        yield* next.reopen({ threadId: otherThreadId, key, restore: true, role: "master" });
        yield* next.masterState(otherThreadId).pipe(
          Stream.filter((state) => state.status === "running" && state.dirty),
          Stream.runHead,
        );
        expect(host.args()).toContain("--t3-recover");
        expect(host.args()).toContain(masterCopyIn(dir, blendPath)?.session);
        expect((yield* firstState(next)).status, "not a working Blender").toBe("stopped");
        yield* next.openMaster({ threadId, relativePath: "cube.blend" });
        expect((yield* firstMaster(next, threadId)).status, "joined").toBe("running");
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
        // Discard from any thread removes the master's one copy.
        yield* next.dismiss({ threadId: otherThreadId, key, role: "master" });
        expect((yield* firstMaster(next, otherThreadId)).status).toBe("notOpen");
        expect(masterCopyIn(dir, other), "discarded from another thread").toBeNull();
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
      // A Move for a master other than the one the person saw saves nothing.
      const refused = yield* service
        .moveIntoT3({ threadId, relativePath: "models/older.blend" })
        .pipe(Effect.flip);
      expect(refused.reason, "another master").toBe("masterChanged");
      expect(desktop.saved).toEqual([]);

      yield* service.moveIntoT3({ threadId, relativePath: "cube.blend" });
      expect(desktop.saved).toHaveLength(1);
      yield* service.masterState(threadId).pipe(
        Stream.filter((state) => state.status === "running"),
        Stream.runHead,
      );
      yield* service.quit({ threadId, save: false, role: "master" });

      // A desktop Blender with another file open is no reason to wait: the master opens here.
      desktop.set({ _tag: "open", filepath: "/elsewhere/other.blend", dirty: false });
      expect(
        yield* service.openMaster({ threadId, relativePath: "cube.blend" }),
        "another file open on the desktop",
      ).toEqual({ _tag: "hosted", desktopUnchecked: false });
      yield* service.quit({ threadId, save: false, role: "master" });
    }).pipe(Effect.scoped),
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
});
