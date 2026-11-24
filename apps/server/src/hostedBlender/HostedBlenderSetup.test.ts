// @effect-diagnostics nodeBuiltinImport:off - the tests write stand-in tools and a fake /etc and /dev to a temp folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { type HostedBlenderSetupState, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as BlenderDetection from "../blend/BlenderDetection.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HiddenDisplayBinary from "./HiddenDisplayBinary.ts";
import * as HostedBlenderSetup from "./HostedBlenderSetup.ts";

const scratchProjectId = ProjectId.make("project-scratch");
const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const tempDir = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hosted-setup-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

const script = (file: string, body: string) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
};

/**
 * An Arch host with a GPU, labwc 0.9 and GStreamer 1.26. The helper's probe logs each run to
 * `probes` and answers x264enc; `labwc` is removable to show "Check again" seeing the change.
 */
const fakeHost = (dir: string) => {
  const bin = NodePath.join(dir, "bin");
  const root = NodePath.join(dir, "root");
  const probes = NodePath.join(dir, "probes");
  script(NodePath.join(bin, "labwc"), 'echo "labwc 0.9.2 (+xwayland)"');
  script(
    NodePath.join(bin, "gst-inspect-1.0"),
    'echo "gst-inspect-1.0 version 1.26.5"; echo "GStreamer 1.26.5"',
  );
  const helper = script(
    NodePath.join(dir, "helper"),
    `[ "$1" = probe ] || exit 2\necho run >> "${probes}"\necho '{"encoder":"x264enc"}'`,
  );
  NodeFS.mkdirSync(NodePath.join(root, "etc"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(root, "etc", "os-release"),
    'ID=arch\nPRETTY_NAME="Arch Linux"\n',
  );
  NodeFS.mkdirSync(NodePath.join(root, "dev", "dri"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "dev", "dri", "renderD128"), "");
  const blender = script(NodePath.join(dir, "blender"), "exit 0");
  return {
    bin,
    root,
    helper,
    blender,
    probeCount: () =>
      NodeFS.existsSync(probes) ? NodeFS.readFileSync(probes, "utf8").split("\n").length - 1 : 0,
  };
};

interface Options {
  readonly host: ReturnType<typeof fakeHost>;
  readonly home: string;
  readonly platform?: NodeJS.Platform;
  readonly enabled?: boolean;
  readonly defaultModel?: boolean;
  readonly launched?: Queue.Queue<ThreadLaunch.ThreadLaunchInput>;
  readonly agentDone?: Deferred.Deferred<void>;
}

const setupFor = (options: Options) =>
  Layer.effect(
    HostedBlenderSetup.HostedBlenderSetup,
    HostedBlenderSetup.makeWith({ systemRoot: options.host.root }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ProcessRunner.layer,
        ServerSettings.ServerSettingsService.layerTest({
          hostedBlenderEnabled: options.enabled ?? true,
          defaultModelSelection: options.defaultModel === false ? null : model,
        }),
        Layer.succeed(BlenderDetection.BlenderDetection, {
          find: Effect.succeed({ path: options.host.blender, version: "5.0.1" }),
        }),
        Layer.succeed(HiddenDisplayBinary.HiddenDisplayBinary, {
          resolve: Effect.succeed(options.host.helper),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/unused",
          ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (projectId) =>
            Effect.succeedSome({
              id: projectId,
              workspaceRoot: options.home,
              title: "No project",
            } as never),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            (options.launched ? Queue.offer(options.launched, input) : Effect.void).pipe(
              Effect.as({ threadId: input.threadId!, resumed: false } as never),
            ),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          waitForThread: (input) =>
            (options.agentDone ? Deferred.await(options.agentDone) : Effect.never).pipe(
              Effect.as({ threadId: input.threadId, run: null, timedOut: false }),
            ),
        }),
        SecureRandom.layerWebCrypto,
        Layer.succeed(HostProcess.Platform, options.platform ?? "linux"),
        Layer.succeed(HostProcess.Environment, { PATH: options.host.bin }),
        Layer.succeed(HostProcess.HomeDirectory, options.home),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const serviceFor = (options: Options) =>
  Layer.build(setupFor(options)).pipe(
    Effect.map((context) => Context.get(context, HostedBlenderSetup.HostedBlenderSetup)),
  );

/** Collects the service's state into a queue, and waits for a state matching `until`. */
const watch = (service: HostedBlenderSetup.HostedBlenderSetup["Service"]) =>
  Effect.gen(function* () {
    const states = yield* Queue.unbounded<HostedBlenderSetupState>();
    yield* service.state.pipe(
      Stream.runForEach((state) => Queue.offer(states, state)),
      Effect.forkScoped,
    );
    return (until: (state: HostedBlenderSetupState) => boolean) =>
      Queue.take(states).pipe(Effect.repeat({ until }));
  });

const checkedResult = (state: HostedBlenderSetupState) => {
  if (state.result?.status !== "checked") throw new Error("expected a checked result");
  return state.result;
};

describe("HostedBlenderSetup", () => {
  it.live("checks on first use, with a test encode through the helper, and remembers it", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      const service = yield* serviceFor({ host, home: dir });
      // Nothing runs until something asks.
      expect(host.probeCount()).toBe(0);
      const next = yield* watch(service);
      const result = checkedResult(yield* next((state) => state.result !== null));
      expect(result.ready).toBe(true);
      expect(result.distro).toBe("Arch Linux");
      expect(result.capture).toBe("ext-image-copy-capture");
      expect(result.checks).toContainEqual({ item: "encoder", status: "ok", found: "x264enc" });
      expect(result.checks).toContainEqual({ item: "labwc", status: "ok", found: "0.9.2" });
      expect(result.checks).toContainEqual({ item: "gpu", status: "ok" });
      expect(result.checks).toContainEqual({ item: "blenderMcp", status: "missing" });
      expect(host.probeCount()).toBe(1);

      // labwc goes away, but the remembered result stands until "Check again".
      NodeFS.rmSync(NodePath.join(host.bin, "labwc"));
      const again = yield* watch(service);
      expect(checkedResult(yield* again((state) => state.result !== null)).ready).toBe(true);
      expect(host.probeCount()).toBe(1);

      // Two "Check again"s at once run one check.
      yield* Effect.all([service.check, service.check], { concurrency: "unbounded" });
      const rechecked = checkedResult(yield* next((state) => !state.checking));
      expect(rechecked.ready).toBe(false);
      expect(rechecked.checks).toContainEqual({ item: "labwc", status: "missing" });
      expect(host.probeCount()).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.live("finds the official Blender MCP in ~/.local/bin, where uv and pipx put it", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      const mcp = script(NodePath.join(dir, ".local", "bin", "blender-mcp"), "exit 0");
      const service = yield* serviceFor({ host, home: dir });
      const next = yield* watch(service);
      expect(checkedResult(yield* next((state) => state.result !== null)).checks).toContainEqual({
        item: "blenderMcp",
        status: "ok",
        found: mcp,
      });
    }).pipe(Effect.scoped),
  );

  it.live("keeps the pane at setup needed while switched off, without checking anything", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      const off = yield* serviceFor({ host, home: dir, enabled: false });
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(off.readiness)), {
        status: "notSetUp",
        missing: ["enabled"],
      });
      expect(host.probeCount()).toBe(0);

      const on = yield* serviceFor({ host, home: dir });
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(on.readiness)), {
        status: "ok",
        helper: host.helper,
        blender: host.blender,
      });

      NodeFS.rmSync(NodePath.join(host.bin, "gst-inspect-1.0"));
      const missing = yield* serviceFor({ host, home: dir });
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(missing.readiness)), {
        status: "notSetUp",
        missing: ["gstreamer", "encoder"],
      });
    }).pipe(Effect.scoped),
  );

  it.live("is not available off Linux, whatever the switch says", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const service = yield* serviceFor({ host: fakeHost(dir), home: dir, platform: "darwin" });
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(service.readiness)), {
        status: "unavailable",
        reason: "platform",
      });
    }).pipe(Effect.scoped),
  );

  it.live("starts a No project thread with the default agent, then checks again when it ends", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      NodeFS.rmSync(NodePath.join(host.bin, "labwc"));
      const launched = yield* Queue.unbounded<ThreadLaunch.ThreadLaunchInput>();
      const agentDone = yield* Deferred.make<void>();
      const service = yield* serviceFor({ host, home: dir, launched, agentDone });
      const next = yield* watch(service);

      const { threadId } = yield* service.installWithAgent;
      const input = yield* Queue.take(launched);
      expect(input.projectId).toBe(scratchProjectId);
      expect(input.threadId).toBe(threadId);
      expect(input.modelSelection).toEqual(model);
      expect(input.workspaceStrategy).toEqual({ type: "root" });
      expect(input.initialMessage?.text).toContain("sudo pacman -S --needed labwc");
      expect(input.initialMessage?.text).toContain("blender_mcp");
      expect(input.initialMessage?.text).toContain("request_secret");
      yield* next((state) => state.installThreadId === threadId);
      expect(host.probeCount()).toBe(1);
      // Asking again, from any device, gets the same thread rather than a second agent.
      expect((yield* service.installWithAgent).threadId).toBe(threadId);
      expect(yield* Queue.size(launched)).toBe(0);

      // The agent installed labwc; T3 checks again once its turn ends.
      script(NodePath.join(host.bin, "labwc"), 'echo "labwc 0.9.2"');
      yield* Deferred.succeed(agentDone, undefined);
      yield* next(
        (state) =>
          state.installThreadId === null &&
          state.result?.status === "checked" &&
          state.result.ready,
      );
      expect(host.probeCount()).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.live("refuses to start an install thread with nothing to install or no default agent", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      script(NodePath.join(dir, ".local", "bin", "blender-mcp"), "exit 0");
      const complete = yield* serviceFor({ host, home: dir });
      expect((yield* Effect.flip(complete.installWithAgent)).reason).toBe("nothingToInstall");

      NodeFS.rmSync(NodePath.join(host.bin, "labwc"));
      const noModel = yield* serviceFor({ host, home: dir, defaultModel: false });
      expect((yield* Effect.flip(noModel.installWithAgent)).reason).toBe("noDefaultModel");

      const elsewhere = yield* serviceFor({ host, home: dir, platform: "win32" });
      expect((yield* Effect.flip(elsewhere.installWithAgent)).reason).toBe("unavailable");
    }).pipe(Effect.scoped),
  );
});
