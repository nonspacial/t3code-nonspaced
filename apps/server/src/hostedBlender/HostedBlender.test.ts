// @effect-diagnostics nodeBuiltinImport:off - the real-Blender fixture probes the host and reads Blender's /proc entries.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { type HostedBlenderThreadState, type RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CONTROL_ADDON_SOURCE } from "./controlAddon.ts";
import * as HostedBlender from "./HostedBlender.ts";
import * as HostedBlenderAgents from "./HostedBlenderAgents.ts";
import * as HostedBlenderSetup from "./HostedBlenderSetup.ts";

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
  readonly revocations?: Stream.Stream<ThreadId | null>;
}

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
    : { status: "ok", helper: host.helper, blender, blenderMcp: null };
};

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
            installWithAgent: Effect.die("not used"),
            readiness: Stream.concat(Stream.succeed(readinessFor(host)), Stream.never),
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
                    } as never)
                  : null,
              ),
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(HostedBlenderAgents.HostedBlenderAgents)({
          listenerPort: () => Effect.succeed(host.agentPort ?? null),
          revocations: host.revocations ?? Stream.never,
        }),
        WorkspacePaths.layer,
        NetService.layer,
        ServerConfig.layerTest(host.workspaceRoot, host.baseDir),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(HostProcess.Environment, host.env),
        Layer.succeed(HostProcess.HomeDirectory, host.baseDir),
      ),
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
  service.threadState(threadId).pipe(Stream.runHead, Effect.map(Option.getOrThrow));

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
        sys.stdout.buffer.write(struct.pack(">IB", len(data) + 1, 1) + data)
        sys.stdout.buffer.flush()
state = {"connection": None}
def lose_connection(*_args):
    # Blender dies: its autosave stays, and the add-on's connection really drops (shutdown, as
    # close leaves it open while the reader holds it), though the helper is still running.
    open(os.path.join(tmp, "cube_4242_autosave.blend"), "w").write("autosave")
    if state["connection"] is not None:
        try:
            state["connection"].shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
def crash(*_args):
    lose_connection()
    event({"type": "exited", "process": "blender", "code": None, "signal": 11})
signal.signal(signal.SIGUSR2, lose_connection)
signal.signal(signal.SIGUSR1, crash)
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
def send(connection, value):
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
             "dirty": scenario not in ("clean", "clean-opens-other", "switches")}
    if "--t3-recover" in t3 and scenario != "restore-silent":
        first["restore"] = "failed" if scenario == "restore-fails" else "ok"
        if scenario == "restored-elsewhere":
            # The copy brings back the path it was saved from, which isn't where it reopened.
            first["filepath"] = "/elsewhere/cube.blend"
    send(connection, first)
    if scenario == "opens-other" and "--t3-recover" not in t3:
        # The person opens another file of the workspace from Blender's own File menu.
        send(connection, dict(first, filepath=os.path.join(os.path.dirname(opened), "other.blend")))
    if scenario == "opens-outside":
        # The person opens a file from outside the workspace and edits it.
        send(connection, dict(first, filepath="/elsewhere/outside.blend"))
    if scenario == "switches":
        # Opens another file and edits it: once T3 sees it dirty, it has seen the switch.
        other = os.path.join(os.path.dirname(opened), "other.blend")
        send(connection, dict(first, filepath=other, dirty=True))
    if scenario == "clean-opens-other" and os.path.exists(os.environ["STANDIN_BIND"]):
        # Once the test creates STANDIN_BIND, the person switches files without editing either.
        send(connection, dict(first, filepath=os.path.join(os.path.dirname(opened), "other.blend")))
    saves = 0
    view = {"position": [7, -7, 5], "target": [0, 0, 1]}
    outstanding = [0]
    def slow_hits(command):
        # Answers later, saying how many hit requests were waiting when this one arrived.
        result = [{"object": "in flight %d" % outstanding[0], "point": [0, 0, 0]}]
        time.sleep(0.3)
        outstanding[0] -= 1
        connection.sendall((json.dumps({"type": "reply", "id": command["id"], "result": result}) + "\n").encode())
    for line in connection.makefile():
        command = json.loads(line)
        if command.get("type") == "quit" and not command.get("save"):
            if scenario == "ignores-quit":
                continue
            send(connection, {"type": "quitting"})
            state["finishing"].clear()
            if scenario in ("slow-quit", "late-slow-quit"):
                # Still writing its quit copy past T3's shutdown deadline.
                time.sleep(5)
            if scenario != "no-quit-copy":
                open(os.path.join(tmp, "quit.blend"), "w").write("quit copy %d" % os.getpid())
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
                reply = {"screenshot": shot, "cameraView": {**view, "upAxis": "z"},
                         "projection": {"matrix": [1] * 16,
                                        "region": {"x": 0, "y": 0, "width": 1, "height": 1}}}
                connection.sendall((json.dumps({"type": "reply", "id": command["id"], "result": reply}) + "\n").encode())
            threading.Thread(target=slow_view, args=(command,), daemon=True).start()
            continue
        elif kind == "view":
            result = {"screenshot": view_reply(command),
                      "cameraView": {**view, "upAxis": "z"},
                      "projection": {"matrix": [2] + [0] * 15,
                                     "region": {"x": 0.1, "y": 0.05, "width": 0.8, "height": 0.9}}}
        elif kind == "hits":
            # Echoes what it was sent: the matrix's first entry and each mark's first sample.
            result = [{"object": "m%g" % command["matrix"][0],
                       "point": [mark[0]["x"], mark[0]["y"], len(command["marks"])]}
                      if mark else None for mark in command["marks"]]
        elif kind == "setView":
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
        connection.sendall(b'{"type": "saving"}\n')
        if scenario == "held-save":
            # Acknowledged, then fails once the test creates STANDIN_BIND.
            def fail_when_released():
                while not os.path.exists(os.environ["STANDIN_BIND"]):
                    time.sleep(0.05)
                connection.sendall(b'{"type": "quitFailed", "reason": "saveFailed"}\n')
            threading.Thread(target=fail_when_released, daemon=True).start()
            continue
        if scenario == "late-failing-save":
            # Acknowledged, then fails only after T3's 20-second settle deadline.
            threading.Timer(21.0, lambda: connection.sendall(
                b'{"type": "quitFailed", "reason": "saveFailed"}\n')).start()
            continue
        if scenario == "exit-while-saving":
            os._exit(0)
        if scenario == "drop-socket":
            connection.close()
            server.close()
            return
        if scenario == "saved-then-exit":
            # Saved, then a moment before Blender is gone; "clean" marks the moment.
            connection.sendall(b'{"type": "saved"}\n')
            send(connection, {"type": "state", "filepath": opened, "dirty": False})
            connection.close()
            threading.Timer(1.0, lambda: os._exit(0)).start()
            return
        if scenario == "slow-failing-save" and saves == 1:
            threading.Timer(1.0, lambda: connection.sendall(
                b'{"type": "quitFailed", "reason": "saveFailed"}\n')).start()
threading.Thread(target=control, daemon=True).start()
def stopped(how):
    marker = os.environ.get("STANDIN_MARKER")
    if marker:
        open(marker, "w").write(how)
    os._exit(0)
for line in sys.stdin:
    command = json.loads(line)
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
            for _ in range(12):
                video(False)
        event({"type": "cursorLeave"} if command["pressed"] else {"type": "cursorEnter", "x": 1, "y": 2})
    # A middle-drag orbit: Blender hides its cursor while the button is down.
    if command.get("type") == "pointerButton" and command.get("button") == 274:
        event({"type": "cursorLeave"} if command["pressed"] else {"type": "cursorEnter", "x": 1, "y": 2})
    if '"quit"' in line and scenario == "never-connects":
        continue  # A helper stuck stopping Blender.
    if '"quit"' in line:
        stopped("quit" if state["finishing"].is_set() else "killed")
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
    },
    helper: NodePath.join(bin, "helper"),
    workspaceRoot: dir,
    baseDir: dir,
    ...(beforeThreadLookup === undefined ? {} : { beforeThreadLookup }),
  });
  const service = yield* serviceFor(layer);
  const states = yield* Queue.unbounded<HostedBlenderThreadState>();
  yield* service.threadState(threadId).pipe(
    Stream.runForEach((state) => Queue.offer(states, state)),
    Effect.forkScoped,
  );
  const awaitStatus = (status: HostedBlenderThreadState["status"]) =>
    Queue.take(states).pipe(Effect.repeat({ until: (state) => state.status === status }));
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

/** The one recovery folder a thread's ended Blender leaves, and what its copy holds. */
const recoveryOf = (hostedDir: string) => {
  const root = NodePath.join(hostedDir, "recovery");
  const folders = NodeFS.existsSync(root) ? NodeFS.readdirSync(root) : [];
  if (folders.length === 0) return null;
  const session = NodePath.join(root, folders[0]!, "session.blend");
  return {
    folders,
    session,
    contents: NodeFS.existsSync(session) ? NodeFS.readFileSync(session, "utf8") : null,
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
const leftover = (
  dir: string,
  input: {
    readonly facts?: {
      readonly restore: string;
      readonly saved: boolean;
      readonly changed: boolean;
      readonly relativePath?: string;
    };
    readonly waiting?: string;
    readonly helperPid?: number;
    readonly name?: string;
  },
) => {
  const hostedDir = NodePath.join(dir, "userdata", "hosted-blender");
  const launchDir = NodePath.join(hostedDir, "launches", input.name ?? "left");
  NodeFS.mkdirSync(NodePath.join(launchDir, "tmp"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(launchDir, "launch.json"),
    JSON.stringify({ threadId, relativePath: "cube.blend", helperPid: input.helperPid }),
  );
  NodeFS.writeFileSync(NodePath.join(launchDir, "outcome"), "closing");
  if (input.facts)
    NodeFS.writeFileSync(NodePath.join(launchDir, "run.json"), JSON.stringify(input.facts));
  NodeFS.writeFileSync(NodePath.join(launchDir, "tmp", "quit.blend"), "left behind");
  if (input.waiting !== undefined) {
    const recovery = NodePath.join(
      hostedDir,
      "recovery",
      Buffer.from(threadId).toString("base64url"),
    );
    NodeFS.mkdirSync(recovery, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(recovery, "session.blend"), input.waiting);
    NodeFS.writeFileSync(
      NodePath.join(recovery, "record.json"),
      JSON.stringify({ threadId, kind: "closed", relativePath: "cube.blend", recovery: true }),
    );
  }
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

describe("Salvaging what a stopped server left", () => {
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
        .open({ threadId, relativePath: "other.blend" })
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
      const stat = NodeFS.existsSync(`/proc/${childPid}/stat`)
        ? NodeFS.readFileSync(`/proc/${childPid}/stat`, "utf8")
        : "";
      expect(stat === "" || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")).toBe(true);
      expect((yield* firstState(service)).status).toBe("closed");
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
      yield* idleService(dir);
      expect(stranger.exitCode).toBeNull();
      expect(stranger.signalCode).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the waiting copy for a run that changed nothing", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("salvage-unchanged");
      const { hostedDir } = leftover(dir, {
        facts: { restore: "none", saved: false, changed: false },
        waiting: "waiting copy",
      });
      expect((yield* firstState(yield* idleService(dir))).status).toBe("closed");
      expect(recoveryOf(hostedDir)?.contents).toBe("waiting copy");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps the waiting copy of a run that never restored it, whatever file it ended on",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir("salvage-switched");
        const { hostedDir } = leftover(dir, {
          facts: { restore: "none", saved: false, changed: false, relativePath: "other.blend" },
          waiting: "waiting copy",
        });
        expect(yield* firstState(yield* idleService(dir))).toEqual({
          status: "closed",
          relativePath: "cube.blend",
          recovery: true,
        });
        expect(recoveryOf(hostedDir)?.contents).toBe("waiting copy");
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
      expect(NodeFS.readdirSync(NodePath.join(hostedDir, "launches"))).toEqual([]);

      yield* service.reopen({ threadId, restore: true });
      yield* awaitDirty(true);
      const reopened = launches().at(-1)!;
      expect(reopened.slice(reopened.indexOf("--t3-recover"))).toEqual([
        "--t3-recover",
        recovery?.session,
      ]);
      // Blender opens the user's file; the copy is restored over it, so saves still go there.
      expect(reopened).toContain(NodeFS.realpathSync(NodePath.join(hostedDir, "../../cube.blend")));

      // Quitting it is the user's choice, so nothing is left to reopen.
      yield* service.quit({ threadId, save: false });
      yield* awaitStatus("stopped");
      expect(recoveryOf(hostedDir)).toBeNull();
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
      yield* service.dismiss({ threadId });
      yield* awaitStatus("stopped");
      const missing = yield* service.reopen({ threadId, restore: true }).pipe(Effect.flip);
      expect(missing.reason).toBe("nothingToReopen");

      NodeFS.mkdirSync(NodePath.join(hostedDir, "recovery"), { recursive: true });
      yield* openReady;
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      yield* service.reopen({ threadId, restore: false });
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
      yield* service.reopen({ threadId, restore: true });
      yield* awaitStatus("running");
      expect(launches().at(-1)).toContain(NodeFS.realpathSync(NodePath.join(dir, "other.blend")));
    }).pipe(Effect.scoped),
  );

  it.live("names a file Blender had open outside the workspace", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus } = yield* standIn("opens-outside", "opens-outside");
      yield* openReady;
      yield* service.closeOnSettle({ threadId });
      expect(yield* awaitStatus("closed")).toEqual({
        status: "closed",
        relativePath: "cube.blend",
        recovery: true,
        fileName: "outside.blend",
      });
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
      yield* service.reopen({ threadId, restore: true });
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
      // Another file would replace this thread's only copy, so it waits for the copy first.
      NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
      for (const relativePath of ["other.blend", "cube.blend"]) {
        const refused = yield* service.open({ threadId, relativePath }).pipe(Effect.flip);
        expect(refused.reason).toBe("recoveryPending");
      }
      // Dismissing a Blender that is running again does nothing, so a stale card can't end it.
      yield* service.reopen({ threadId, restore: true });
      yield* awaitDirty(true);
      yield* service.dismiss({ threadId });
      expect((yield* firstState(service)).status).toBe("running");
      expect(recoveryOf(hostedDir)?.contents).toMatch(/^quit copy /);
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      yield* service.dismiss({ threadId });
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

  it.live("a shutdown stops a slow quit within its deadline, never touching the user's file", () =>
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
      // Blender acknowledged the quit, but was still writing its copy: stopped, not waited for.
      expect(NodeFS.readFileSync(marker, "utf8")).toBe("killed");
      expect(NodeFS.readFileSync(blendPath, "utf8")).toBe("the user's file");
    }).pipe(Effect.scoped),
  );

  it.live("a shutdown keeps one deadline, however late the add-on connects", () =>
    Effect.gen(function* () {
      const { layer, marker } = yield* standIn("late-slow", "late-slow-quit");
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
      expect(NodeFS.readFileSync(marker, "utf8")).toBe("killed");
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

  it.live("never resumes capture for a Blender that is ending", () =>
    Effect.gen(function* () {
      const { service, openReady, awaitStatus, helperCommands } = yield* standIn(
        "ending-capture",
        "slow-quit",
      );
      yield* openReady;
      const attached = yield* service.attachViewer(threadId, { canOperate: false });
      assert.strictEqual(attached._tag, "attached");
      if (attached._tag !== "attached") return;
      yield* attached.viewer.setVisible(false);
      // The settle waits on a quit Blender acknowledged; a pane shown meanwhile stays dark.
      yield* service.closeOnSettle({ threadId });
      yield* attached.viewer.setVisible(true);
      yield* awaitStatus("closed");
      const capture = helperCommands().filter(
        (command) => command.type === "pause" || command.type === "resume",
      );
      expect(capture.at(-1)?.type).toBe("pause");
    }).pipe(Effect.scoped),
  );

  it.live("a different file can't start while a settle that keeps a copy finishes", () =>
    Effect.gen(function* () {
      let hold: Deferred.Deferred<void> | null = null;
      const { dir, service, openReady, awaitStatus } = yield* standIn("race", "", () =>
        hold === null ? Effect.void : Deferred.await(hold),
      );
      NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
      yield* openReady;
      // Opening the other file passes its first checks while cube.blend is still running...
      const gate = yield* Deferred.make<void>();
      hold = gate;
      const opening = yield* service
        .open({ threadId, relativePath: "other.blend" })
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
      yield* service.reopen({ threadId, restore: true });
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
      yield* service.reopen({ threadId, restore: true });
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

  it.live("a file opened as last saved and left unchanged keeps the waiting copy", () =>
    Effect.gen(function* () {
      const { service, awaitStatus, hostedDir } = yield* standIn("unchanged", "clean");
      yield* service.open({ threadId, relativePath: "cube.blend" });
      yield* awaitStatus("running");
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      const kept = recoveryOf(hostedDir)?.contents;
      yield* service.reopen({ threadId, restore: false });
      yield* awaitStatus("running");
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      expect(recoveryOf(hostedDir)?.contents).toBe(kept);
    }).pipe(Effect.scoped),
  );

  it.live("a file opened as last saved keeps the waiting copy, though another file was open", () =>
    Effect.gen(function* () {
      const { dir, service, awaitStatus, hostedDir, bind } = yield* standIn(
        "unchanged-switched",
        "clean-opens-other",
      );
      NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
      yield* service.open({ threadId, relativePath: "cube.blend" });
      yield* awaitStatus("running");
      yield* service.closeOnSettle({ threadId });
      yield* awaitStatus("closed");
      const kept = recoveryOf(hostedDir)?.contents;
      bind();
      yield* service.reopen({ threadId, restore: false });
      yield* awaitStatus("running");
      yield* service.closeOnSettle({ threadId });
      expect(yield* awaitStatus("closed")).toEqual({
        status: "closed",
        relativePath: "cube.blend",
        recovery: true,
      });
      expect(recoveryOf(hostedDir)?.contents).toBe(kept);
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
      yield* second.reopen({ threadId, restore: true });
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

      yield* service.reopen({ threadId, restore: false });
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
      yield* service.reopen({ threadId, restore: true });
      yield* awaitDirty(true);
      expect(launches().at(-1)).toContain(recoveryOf(hostedDir)?.session);
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
      expect(recoveryOf(hostedDir)?.contents).toBe("autosave");
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
          memoryBytes: expect.any(Number),
        },
      ]);
      yield* service.quit({ threadId, save: false });
      yield* awaitStatus("stopped");
      yield* Queue.take(lists).pipe(Effect.repeat({ until: (list) => list.length === 0 }));
    }).pipe(Effect.scoped),
  );
});

describe("The viewport window", () => {
  it.live("reads its camera and casts each mark through the frozen view", () =>
    Effect.gen(function* () {
      const { service, openReady, runtime } = yield* standIn("view", "");
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
      });
      const hits = yield* service.findHits({
        threadId,
        projection: capture.projection,
        marks: [[{ x: 0.5, y: 0.25 }], []],
      });
      assert.deepStrictEqual(hits, [{ object: "m2", point: [0.5, 0.25, 2] }, null]);
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
          service.findHits({ threadId, projection, marks: [[{ x: 0.5, y: 0.5 }]] }),
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

  it.live("goes without a screenshot Blender can't render or that's too large to send", () =>
    Effect.gen(function* () {
      for (const scenario of ["no-render", "big-shot"]) {
        const { service, openReady } = yield* standIn(scenario, scenario);
        yield* openReady;
        const failed = yield* service.captureView(threadId).pipe(Effect.flip);
        expect({ scenario, reason: failed.reason }).toEqual({ scenario, reason: "noScreenshot" });
      }
    }).pipe(Effect.scoped),
  );

  it.live("reads a screenshot only as a plain file in Blender's private folder", () =>
    Effect.gen(function* () {
      const { service, openReady } = yield* standIn("linked-shot", "linked-shot");
      yield* openReady;
      const failed = yield* service.captureView(threadId).pipe(Effect.flip);
      expect(failed.reason).toBe("noScreenshot");
    }).pipe(Effect.scoped),
  );

  it.live("fails when Blender has no viewport window to read", () =>
    Effect.gen(function* () {
      const { service, openReady } = yield* standIn("no-viewport", "no-viewport");
      yield* openReady;
      const failed = yield* service.captureView(threadId).pipe(Effect.flip);
      expect(failed.reason).toBe("noViewport");
    }).pipe(Effect.scoped),
  );

  it.live("fails when Blender's control connection closes before answering", () =>
    Effect.gen(function* () {
      const { service, openReady } = yield* standIn("view-dropped", "drop-on-view");
      yield* openReady;
      const failed = yield* service.captureView(threadId).pipe(Effect.flip);
      expect(failed.reason).toBe("noReply");
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
const ofType = <Command extends { readonly type: string }>(
  commands: ReadonlyArray<Command>,
  ...types: ReadonlyArray<string>
) => commands.filter((command) => types.includes(command.type));

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
      // Acking the frame it was stuck on lets the keyframe out.
      yield* operator.ack;
      expect(isKey(yield* nextFrame(operator))).toBe(true);
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
      // F1 overflows the operator's queue while its first frame is unacked; nothing more comes.
      yield* operator.input({ type: "key", code: 59, pressed: true });
      yield* cursor(true);
      yield* operator.input({ type: "key", code: 59, pressed: false });
      yield* cursor(false);
      // Its ack asks for a keyframe, but one went out at join this same instant.
      yield* operator.ack;
      yield* syncPoint(operator);
      expect(ofType(helperCommands(), "keyframe")).toHaveLength(1);
      yield* TestClock.adjust("250 millis");
      expect(isKey(yield* nextFrame(operator))).toBe(true);
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

  it.live("counts a file as open where Blender has it open now, not where it started", () =>
    Effect.gen(function* () {
      const { dir, service, awaitDirty } = yield* standIn("switched-open", "switches");
      NodeFS.writeFileSync(NodePath.join(dir, "other.blend"), "");
      yield* service.open({ threadId, relativePath: "cube.blend" });
      yield* awaitDirty(true);
      const elsewhere = yield* service
        .open({ threadId: otherThreadId, relativePath: "other.blend" })
        .pipe(Effect.flip);
      expect(elsewhere.reason).toBe("openInAnotherThread");
      yield* service.open({ threadId: otherThreadId, relativePath: "cube.blend" });
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
      expect(NodeFS.existsSync(NodePath.join(userResources, "scripts"))).toBe(false);
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
      const { region } = capture.projection;
      // The factory scene's cube sits at the origin, in the middle of the 3D view; a corner of
      // the view looks past it at nothing.
      const hits = yield* service.findHits({
        threadId,
        projection: capture.projection,
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
    bpy.context.scene.collection.objects.link(bpy.data.objects.new("T3Edit", None))
    open(marker, "w").close()

def register():
    bpy.app.handlers.load_post.append(_edit)

def unregister():
    bpy.app.handlers.load_post.remove(_edit)
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

describe.skipIf(!canHostBlender)("a real hosted Blender's endings", () => {
  it.live("a reopened Blender's viewport window fills the pane size asked for, and keeps it", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("real-reopen-size");
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
        Queue.take(states).pipe(Effect.repeat({ until: matches }));
      // The viewport window fills the size asked for while Blender was starting, and stays that
      // size: a window that later leaves fullscreen shrinks the stream a moment after.
      const fillsPane = Effect.gen(function* () {
        const attached = yield* service.attachViewer(threadId, { canOperate: false });
        assert.strictEqual(attached._tag, "attached");
        if (attached._tag !== "attached") return;
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
        // The size it settles at: the last one before 6 seconds pass with no change.
        let settled = yield* sizes.pipe(Effect.timeoutOption("30 seconds"));
        while (Option.isSome(settled)) {
          const next = yield* sizes.pipe(Effect.timeoutOption("6 seconds"));
          if (Option.isNone(next)) break;
          settled = next;
        }
        expect(Option.getOrNull(settled)).toBe("1046x1336");
      }).pipe(Effect.scoped);

      yield* service.open({ threadId, relativePath: "cube.blend" });
      yield* fillsPane;
      yield* awaitState((state) => state.status === "running");
      yield* service.closeOnSettle({ threadId });
      yield* awaitState((state) => state.status === "closed");
      yield* service.reopen({ threadId, restore: true });
      yield* fillsPane;
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
          Queue.take(states).pipe(Effect.repeat({ until: matches }));

        yield* service.open({ threadId, relativePath: "cube.blend" });
        yield* awaitState((state) => state.status === "running");
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
        yield* service.reopen({ threadId, restore: true });
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
        yield* service.reopen({ threadId, restore: false });
        yield* awaitState((state) => state.status === "running");
        yield* service.quit({ threadId, save: false });
        yield* awaitState((state) => state.status === "stopped");
      }).pipe(Effect.scoped),
  );

  it.live(
    "a slow quit: settling waits for its copy, a shutdown stops it in time; restores run no scripts, and a failed one keeps the copy",
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
            Queue.take(states).pipe(Effect.repeat({ until: matches }));
        });

        const hostedDir = NodePath.join(dir, "userdata", "hosted-blender");
        const before = NodeFS.readFileSync(blendPath);

        // T3 stops while Blender is still writing its quit copy: it is stopped in time, and
        // the user's file is as it was.
        const started = yield* Effect.gen(function* () {
          const first = yield* serviceFor(layer);
          const awaitState = yield* watch(first);
          yield* first.open({ threadId, relativePath: "cube.blend" });
          yield* awaitState((state) => state.status === "running");
          return yield* Clock.currentTimeMillis;
        }).pipe(Effect.scoped);
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(5_000);
        expect(NodeFS.readFileSync(blendPath).equals(before)).toBe(true);
        expect(objectsIn(blendPath)).not.toContain("T3Edit");

        // Settling waits for the same slow quit, so its copy keeps the edit.
        const service = yield* serviceFor(layer);
        const awaitState = yield* watch(service);
        yield* service.dismiss({ threadId });
        NodeFS.rmSync(NodePath.join(dir, "edited"), { force: true });
        yield* service.open({ threadId, relativePath: "cube.blend" });
        yield* awaitState((state) => state.status === "running");
        yield* service.closeOnSettle({ threadId });
        expect(yield* awaitState((state) => state.status === "closed")).toEqual({
          status: "closed",
          relativePath: "cube.blend",
          recovery: true,
        });
        const session = recoveryOf(hostedDir)!.session;
        expect(objectsIn(session)).toContain("T3Edit");

        // Restoring it never runs the file's script.
        yield* service.reopen({ threadId, restore: true });
        yield* awaitState((state) => state.status === "running" && state.dirty);
        expect(NodeFS.existsSync(NodePath.join(dir, "script-ran"))).toBe(false);

        // A copy Blender can't read is reported and kept, never replaced by the saved file.
        yield* service.closeOnSettle({ threadId });
        yield* awaitState((state) => state.status === "closed");
        NodeFS.writeFileSync(session, "not a blend file");
        yield* service.reopen({ threadId, restore: true });
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

// Records Blender's command line, then shows the viewport window and waits to be asked to quit.
const ARGS_HELPER = String.raw`
import json, os, struct, sys
with open(os.environ["STANDIN_ARGS"], "w") as log:
    log.write("\n".join(sys.argv[1:]))
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
    def state(filepath, dirty=False):
        connection.sendall((json.dumps({"type": "state", "filepath": filepath, "dirty": dirty,
                                        "agentListener": listener[0]}) + "\n").encode())
    after = os.environ.get("STANDIN_AFTER")
    # Another file already open by the time T3 hears, claiming its listener is ready.
    if after == "otherFileFirst":
        listener[0] = "ready"
        state("/elsewhere/other.blend")
    else:
        state(blend)
    for line in connection.makefile():
        with open(os.environ["STANDIN_ARGS"] + ".control", "a") as log:
            log.write(line)
        kind = json.loads(line).get("type")
        if kind == "grantAgentListener" and listener[0] == "starting":
            listener[0] = "ready"
            state(blend)
            if after == "otherFile":
                # Someone opens another file through Blender's own UI.
                state("/elsewhere/other.blend")
        command = json.loads(line)
        if kind == "quit" and command.get("save"):
            # As Blender does: saved, then quitting, reading no more commands (T3's stop
            # included) while it writes its quit copy and exits.
            import time
            for reply in ({"type": "saving"}, {"type": "saved"}):
                connection.sendall((json.dumps(reply) + "\n").encode())
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
        if kind == "stopAgentListener":
            # Gone once it has heard the stop, so a test can wait for the stopped state; it says
            # Blender exited cleanly, as one quit from its own menu does (otherwise, a crash).
            event({"type": "exited", "process": "blender", "code": 0, "signal": None})
            os._exit(0)
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

describe("Agent access at launch", () => {
  const launch = Effect.fn(function* (
    host: Pick<Host, "runtimeMode" | "interactionMode" | "agentPort" | "revocations">,
    options: { readonly agentWorkingCopy?: boolean } = { agentWorkingCopy: true },
    after?: "otherFile" | "otherFileFirst" | "holdOnStop" | "offAfterSaved",
  ) {
    const dir = yield* tempDir("agent-access");
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
        },
        helper: NodePath.join(bin, "helper"),
        workspaceRoot: dir,
        baseDir: dir,
        ...host,
      }),
    );
    yield* service.open({ threadId, relativePath: "cube.blend" }, options);
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

  it.live("reports the listener as Blender's add-on does, and closes it when access ends", () =>
    Effect.gen(function* () {
      const revoked = yield* Queue.unbounded<ThreadId | null>();
      const { service, controlLog } = yield* launch({
        agentPort: 41234,
        revocations: Stream.fromQueue(revoked),
      });
      expect((yield* service.agentListener(threadId))?.state).toBe("ready");
      // Another thread's session ending leaves this one alone.
      yield* Queue.offer(revoked, otherThreadId);
      yield* Queue.offer(revoked, threadId);
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "stopped"),
        Stream.runHead,
      );
      expect(controlLog().match(/stopAgentListener/g)).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.live("ends the agent's access when T3 closes its Blender, never as a lost connection", () =>
    Effect.gen(function* () {
      const { service, controlLog, release, argsLog } = yield* launch(
        { agentPort: 41234 },
        undefined,
        "holdOnStop",
      );
      expect((yield* service.agentListener(threadId))?.state).toBe("ready");
      yield* service.closeOnSettle({ threadId });
      // The stop goes out first; Blender's connection drops as it closes, and T3, which has
      // seen that by the time it asks the helper to stop Blender, still calls it revoked.
      yield* fileAppears(NodePath.dirname(argsLog), `${argsLog}.stopping`);
      expect(controlLog()).toContain("stopAgentListener");
      expect((yield* service.agentListener(threadId, { wait: false }))?.ended).toBe("revoked");
      release();
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "closed"),
        Stream.runHead,
      );
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

  it.live("Save and quit ends the agent's access as revoked once Blender says it saved", () =>
    Effect.gen(function* () {
      const { service, release } = yield* launch(
        { agentPort: 41234 },
        { agentWorkingCopy: true },
        "offAfterSaved",
      );
      expect((yield* service.agentListener(threadId))?.state).toBe("ready");
      const quitting = yield* service.quit({ threadId, save: true }).pipe(Effect.forkChild);
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
      const { service, lastArgs } = yield* launch({ agentPort: 41234 });
      expect(lastArgs()).toContain("--t3-mcp-listen");
      yield* service.closeOnSettle({ threadId });
      yield* service.threadState(threadId).pipe(
        Stream.filter((state) => state.status === "closed"),
        Stream.runHead,
      );
      yield* service.reopen({ threadId, restore: true });
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
