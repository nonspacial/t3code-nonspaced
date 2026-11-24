// @effect-diagnostics nodeBuiltinImport:off - the real-Blender fixture probes the host and reads Blender's /proc entries.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { type HostedBlenderThreadState, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as HiddenDisplayBinary from "./HiddenDisplayBinary.ts";
import * as HostedBlender from "./HostedBlender.ts";

const threadId = ThreadId.make("thread-hosted-blender");
const otherThreadId = ThreadId.make("thread-same-workspace");

interface Host {
  readonly platform?: NodeJS.Platform;
  readonly helper?: string | null;
  readonly env: NodeJS.ProcessEnv;
  readonly workspaceRoot: string;
  readonly baseDir: string;
}

const layerFor = (host: Host) =>
  HostedBlender.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HiddenDisplayBinary.HiddenDisplayBinary, {
          resolve:
            host.helper === null || host.helper === undefined
              ? Effect.fail(new HiddenDisplayBinary.HiddenDisplayBinaryNotFound({ candidates: [] }))
              : Effect.succeed(host.helper),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(
              id === threadId || id === otherThreadId
                ? ({ worktreePath: host.workspaceRoot, projectId: "project" } as never)
                : null,
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        WorkspacePaths.layer,
        NetService.layer,
        ServerConfig.layerTest(host.workspaceRoot, host.baseDir),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, host.platform ?? "linux"),
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
 * and SIGUSR1 crashes it leaving an autosave. STANDIN_* files record what it was asked to do.
 */
const STANDIN_HELPER = String.raw`
import json, os, signal, socket, struct, sys, threading
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
def crash(*_args):
    open(os.path.join(tmp, "cube_4242_autosave.blend"), "w").write("autosave")
    event({"type": "exited", "process": "blender", "code": None, "signal": 11})
    if state["connection"] is not None:
        state["connection"].close()
signal.signal(signal.SIGUSR1, crash)
server = socket.socket(socket.AF_UNIX)
server.bind(t3[t3.index("--t3-control") + 1])
server.listen(1)
event({"type": "ready", "capture": "extImageCopyCapture", "target": "window",
       "encoder": "x264enc", "width": 1280, "height": 720, "cursorTracking": True})
if scenario != "never-shows":
    event({"type": "windowCaptured", "title": "3D Viewport"})
def control():
    connection, _ = server.accept()
    state["connection"] = connection
    connection.sendall(b'{"type": "hello", "pid": %d}\n' % os.getpid())
    connection.sendall(b'{"type": "state", "filepath": "cube.blend", "dirty": true}\n')
    saves = 0
    for line in connection.makefile():
        command = json.loads(line)
        if command.get("type") == "quit" and not command.get("save"):
            if scenario == "ignores-quit":
                continue
            if scenario != "no-quit-copy":
                open(os.path.join(tmp, "quit.blend"), "w").write("quit copy")
            event({"type": "exited", "process": "blender", "code": 0, "signal": None})
            connection.close()
            return
        if command.get("type") != "quit" or not command.get("save"):
            continue
        saves += 1
        with open(os.environ["STANDIN_SAVES"], "a") as log:
            log.write("save\n")
        connection.sendall(b'{"type": "saving"}\n')
        if scenario == "exit-while-saving":
            os._exit(0)
        if scenario == "drop-socket":
            connection.close()
            server.close()
            return
        if scenario == "saved-then-exit":
            # Saved, then a moment before Blender is gone; "clean" marks the moment.
            connection.sendall(b'{"type": "saved"}\n')
            connection.sendall(b'{"type": "state", "filepath": "cube.blend", "dirty": false}\n')
            connection.close()
            threading.Timer(1.0, lambda: os._exit(0)).start()
            return
        if scenario == "slow-failing-save" and saves == 1:
            threading.Timer(1.0, lambda: connection.sendall(
                b'{"type": "quitFailed", "reason": "saveFailed"}\n')).start()
threading.Thread(target=control, daemon=True).start()
for line in sys.stdin:
    if '"quit"' in line:
        marker = os.environ.get("STANDIN_MARKER")
        if marker:
            open(marker, "w").write("quit")
        os._exit(0)
os._exit(0)
`;
const python = NodeChildProcess.execFileSync("sh", ["-c", "command -v python3"], {
  encoding: "utf8",
}).trim();

/** A workspace with cube.blend, served by the stand-in helper in `scenario`. */
const standIn = Effect.fn(function* (prefix: string, scenario: string) {
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
  const launchesLog = NodePath.join(dir, "launches.log");
  const pidFile = NodePath.join(dir, "helper.pid");
  const layer = layerFor({
    env: {
      PATH: bin,
      XDG_RUNTIME_DIR: runtime,
      STANDIN_SCENARIO: scenario,
      STANDIN_MARKER: marker,
      STANDIN_SAVES: savesLog,
      STANDIN_LAUNCHES: launchesLog,
      STANDIN_PID: pidFile,
    },
    helper: NodePath.join(bin, "helper"),
    workspaceRoot: dir,
    baseDir: dir,
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
  const saveCommands = () =>
    NodeFS.existsSync(savesLog) ? NodeFS.readFileSync(savesLog, "utf8").split("\n").length - 1 : 0;
  /** Every launch's Blender arguments, oldest first. */
  const launches = (): ReadonlyArray<ReadonlyArray<string>> =>
    NodeFS.existsSync(launchesLog)
      ? NodeFS.readFileSync(launchesLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const hostedDir = NodePath.join(dir, "userdata", "hosted-blender");
  return {
    dir,
    layer,
    service,
    awaitStatus,
    awaitDirty,
    openReady,
    saveCommands,
    marker,
    runtime,
    launches,
    hostedDir,
    /** Crashes the stand-in Blender, by the pid it wrote itself at spawn. */
    crash: () => process.kill(Number(NodeFS.readFileSync(pidFile, "utf8")), "SIGUSR1"),
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
      expect(recovery?.contents).toBe("quit copy");
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
      yield* service.quit({ threadId, save: false });
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
      expect(recoveryOf(hostedDir)?.contents).toBe("quit copy");
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
      expect(recoveryOf(hostedDir)?.contents).toBe("quit copy");

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

it.effect("gives up on a start that never shows Blender by asking the helper to quit", () =>
  Effect.gen(function* () {
    const { service, awaitStatus, marker, runtime } = yield* standIn("timeout", "never-shows");
    yield* service.open({ threadId, relativePath: "cube.blend" });
    const attached = yield* service.attachViewer(threadId);
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
  it.effect("is not available on hosts other than Linux", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("unavailable");
      const service = yield* serviceFor(
        layerFor({ platform: "darwin", env: {}, workspaceRoot: dir, baseDir: dir }),
      );
      assert.deepStrictEqual(yield* firstState(service), { status: "unavailable" });
      const opened = yield* service.open({ threadId, relativePath: "a.blend" }).pipe(Effect.exit);
      assert.isTrue(Exit.hasFails(opened));
    }).pipe(Effect.scoped),
  );

  it.effect("lists what a Linux host is missing", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir("missing");
      const service = yield* serviceFor(
        layerFor({ env: { PATH: "" }, workspaceRoot: dir, baseDir: dir }),
      );
      assert.deepStrictEqual(yield* firstState(service), {
        status: "notSetUp",
        missing: ["helper", "blender", "labwc"],
      });
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

  it.live("reports a start that never shows Blender, until quit or another open clears it", () =>
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
      yield* service.quit({ threadId, save: false });
      yield* awaitStatus("stopped");
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
        `import bpy; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blendPath)})`,
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

      const attached = yield* service.attachViewer(threadId);
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

describe.skipIf(!canHostBlender)("a real hosted Blender's endings", () => {
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
});
