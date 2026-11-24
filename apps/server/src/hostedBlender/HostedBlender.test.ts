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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

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
