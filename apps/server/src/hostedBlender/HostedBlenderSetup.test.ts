// @effect-diagnostics nodeBuiltinImport:off - the tests write stand-in tools and a fake /etc and /dev to a temp folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  type HostedBlenderSetupState,
  type ServerSettings as ServerSettingsValue,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
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
import * as ServerConfig from "../config.ts";
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

/**
 * Blender Lab's `blmcp`, as far as setup sees it: it answers `initialize` and `tools/list` over
 * stdio, and logs each start and the port it was given beside itself. A marker file beside it
 * breaks one answer: `silent` exits, `noinit` fails `initialize`, `toolserror` fails the tool
 * list and `notools` lists none.
 */
const FAKE_BLMCP = `import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
def main():
    with open(os.path.join(HERE, "starts.log"), "a") as log:
        log.write(os.environ.get("BLENDER_MCP_PORT", "none") + "\\n")
    broken = lambda name: os.path.exists(os.path.join(HERE, name))
    if broken("silent"):
        return 1
    for line in sys.stdin:
        message = json.loads(line)
        reply = {"jsonrpc": "2.0", "id": message.get("id")}
        if message.get("method") == "initialize":
            if broken("noinit"):
                reply["error"] = {"code": -32603, "message": "broken"}
            else:
                reply["result"] = {"protocolVersion": message["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "blender-mcp", "version": "1.30.0"}}
        elif message.get("method") == "tools/list":
            if broken("toolserror"):
                reply["error"] = {"code": -32603, "message": "broken"}
            else:
                reply["result"] = {"tools": [] if broken("notools") else [{"name": "get_objects_summary", "inputSchema": {"type": "object"}}]}
        else:
            continue
        print(json.dumps(reply), flush=True)
    return 0
`;

/**
 * A pip console script, as `uv tool install` and `pipx` write it, importing `module`. Blender
 * Lab's gets its environment's `blender_mcp-*.dist-info` too, beside a stray file under `lib`.
 */
/** Where setup keeps the official server's answers, under the test's state folder. */
const keptCapture = (home: string): string => {
  const found = NodeFS.readdirSync(home, { recursive: true, encoding: "utf8" }).find((entry) =>
    entry.endsWith("blender-mcp-capture.json"),
  );
  if (found === undefined) throw new Error("no kept capture");
  return NodePath.join(home, found);
};

const consoleScript = (file: string, module: string) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  if (module === "blmcp") {
    NodeFS.writeFileSync(NodePath.join(NodePath.dirname(file), "blmcp.py"), FAKE_BLMCP);
    const lib = NodePath.join(NodePath.dirname(NodePath.dirname(file)), "lib");
    const distInfo = NodePath.join(
      lib,
      "python3.12",
      "site-packages",
      "blender_mcp-1.0.3.dist-info",
    );
    NodeFS.mkdirSync(distInfo, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(distInfo, "METADATA"),
      "Name: blender-mcp\nVersion: 1.0.3\n",
    );
    NodeFS.writeFileSync(NodePath.join(lib, "README"), "not a Python\n");
  }
  NodeFS.writeFileSync(
    file,
    `#!/usr/bin/python3\n# -*- coding: utf-8 -*-\nimport sys\nfrom ${module} import main\nif __name__ == "__main__":\n    sys.exit(main())\n`,
    { mode: 0o755 },
  );
  return file;
};

interface Options {
  readonly host: ReturnType<typeof fakeHost>;
  readonly home: string;
  readonly platform?: NodeJS.Platform;
  readonly enabled?: boolean;
  readonly defaultModel?: boolean;
  readonly launched?: Queue.Queue<ThreadLaunch.ThreadLaunchInput>;
  readonly agentDone?: Deferred.Deferred<void>;
  readonly blenderMcpPath?: string;
  /** T3 ships no hidden display helper for this host, as on a musl or riscv64 Linux. */
  readonly helperUnsupported?: boolean;
  /** Settings written while the service runs, as the Settings page's switch does. */
  readonly settingsChanges?: Queue.Queue<Partial<ServerSettingsValue>>;
}

/** Settings whose changes reach `subscribeChanges`, which `layerTest` never streams. */
const changingSettings = (
  initial: Partial<ServerSettingsValue>,
  changes: Queue.Queue<Partial<ServerSettingsValue>>,
) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettings.ServerSettingsService;
      let current = { ...(yield* base.getSettings), ...initial };
      return {
        ...base,
        getSettings: Effect.sync(() => current),
        subscribeChanges: Effect.succeed(
          Stream.fromQueue(changes).pipe(
            Stream.map((patch) => {
              current = { ...current, ...patch };
              return current;
            }),
          ),
        ),
      };
    }),
  ).pipe(Layer.provide(ServerSettings.ServerSettingsService.layerTest()));

const setupFor = (options: Options) =>
  Layer.effect(
    HostedBlenderSetup.HostedBlenderSetup,
    HostedBlenderSetup.makeWith({ systemRoot: options.host.root }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ProcessRunner.layer,
        options.settingsChanges
          ? changingSettings(
              { hostedBlenderEnabled: options.enabled ?? true },
              options.settingsChanges,
            )
          : ServerSettings.ServerSettingsService.layerTest({
              hostedBlenderEnabled: options.enabled ?? true,
              defaultModelSelection: options.defaultModel === false ? null : model,
              blenderMcpPath: options.blenderMcpPath ?? "",
            }),
        Layer.succeed(BlenderDetection.BlenderDetection, {
          find: Effect.succeed({ path: options.host.blender, version: "5.0.1" }),
        }),
        Layer.succeed(HiddenDisplayBinary.HiddenDisplayBinary, {
          resolve: options.helperUnsupported
            ? Effect.fail(
                new HiddenDisplayBinary.HiddenDisplayBinaryUnsupported({
                  platform: "linux",
                  architecture: "riscv64",
                }),
              )
            : Effect.succeed(options.host.helper),
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
        ServerConfig.layerTest(options.home, NodePath.join(options.home, "t3")),
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
  it.live("never runs anything for someone who only watches", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      const service = yield* serviceFor({ host, home: dir });
      const next = yield* watch(service);
      assert.deepStrictEqual(yield* next(() => true), {
        result: null,
        checking: false,
        installThreadId: null,
      });
      // Switched on but never checked: the pane says so instead of waiting.
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(service.readiness)), {
        status: "notSetUp",
        missing: ["check"],
      });
      expect(host.probeCount()).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.live("checks when Hosted Blender is switched on", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      const settingsChanges = yield* Queue.unbounded<Partial<ServerSettingsValue>>();
      const service = yield* serviceFor({ host, home: dir, enabled: false, settingsChanges });
      const next = yield* watch(service);
      expect(host.probeCount()).toBe(0);
      yield* Queue.offer(settingsChanges, { hostedBlenderEnabled: true });
      expect(checkedResult(yield* next((state) => state.result !== null)).ready).toBe(true);
      expect(host.probeCount()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.live("checks on first use, with a test encode through the helper, and remembers it", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      const service = yield* serviceFor({ host, home: dir });
      const next = yield* watch(service);
      yield* service.ensureChecked;
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
      yield* service.ensureChecked;
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
      const mcp = consoleScript(NodePath.join(dir, ".local", "bin", "blender-mcp"), "blmcp");
      const service = yield* serviceFor({ host, home: dir });
      yield* service.ensureChecked;
      const next = yield* watch(service);
      expect(checkedResult(yield* next((state) => state.result !== null)).checks).toContainEqual({
        item: "blenderMcp",
        status: "ok",
        found: mcp,
      });
    }).pipe(Effect.scoped),
  );

  it.live("reads the official server's tools as it checks it, once per installed build", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      const mcp = consoleScript(NodePath.join(dir, ".local", "bin", "blender-mcp"), "blmcp");
      const starts = () =>
        NodeFS.readFileSync(NodePath.join(dir, ".local", "bin", "starts.log"), "utf8")
          .split("\n")
          .filter(Boolean);
      const readiness = Effect.fnUntraced(function* (check: "ensure" | "again") {
        const service = yield* serviceFor({ host, home: dir });
        yield* check === "ensure" ? service.ensureChecked : service.check;
        return Option.getOrThrow(yield* Stream.runHead(service.readiness));
      });
      const first = yield* readiness("ensure");
      assert(first.status === "ok" && first.blenderMcpCapture !== null);
      expect(first.blenderMcp).toBe(mcp);
      expect(first.blenderMcpCapture.answers["2025-11-25"]?.["tools/list"]).toEqual({
        result: { tools: [{ name: "get_objects_summary", inputSchema: { type: "object" } }] },
      });
      // One process per protocol version, none with a Blender to reach.
      expect(starts()).toEqual(["0", "0", "0", "0", "0"]);
      // A restart, and Check again, of an unchanged install start nothing.
      expect(yield* readiness("ensure")).toEqual(first);
      expect(yield* readiness("again")).toEqual(first);
      expect(starts()).toHaveLength(5);
      // Reinstalled in place: read again.
      NodeFS.appendFileSync(mcp, "# reinstalled\n");
      const reread = yield* readiness("again");
      expect(starts()).toHaveLength(10);
      assert(reread.status === "ok");
      expect(reread.blenderMcpCapture?.build).not.toEqual(first.blenderMcpCapture.build);
    }).pipe(Effect.scoped),
  );

  it.live("reports a server whose answers agents couldn't use as failed, however it fails", () =>
    Effect.gen(function* () {
      for (const marker of ["noinit", "toolserror", "notools"]) {
        const dir = yield* tempDir;
        const host = fakeHost(dir);
        const mcp = consoleScript(NodePath.join(dir, ".local", "bin", "blender-mcp"), "blmcp");
        NodeFS.writeFileSync(NodePath.join(dir, ".local", "bin", marker), "");
        const service = yield* serviceFor({ host, home: dir });
        yield* service.ensureChecked;
        const result = checkedResult(
          yield* (yield* watch(service))((state) => state.result !== null),
        );
        expect.soft(result.checks, marker).toContainEqual({
          item: "blenderMcp",
          status: "failed",
          found: mcp,
        });
      }
    }).pipe(Effect.scoped),
  );

  it.live("reads the server again when its kept answers couldn't serve agents", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      consoleScript(NodePath.join(dir, ".local", "bin", "blender-mcp"), "blmcp");
      const starts = () =>
        NodeFS.readFileSync(NodePath.join(dir, ".local", "bin", "starts.log"), "utf8")
          .split("\n")
          .filter(Boolean).length;
      yield* (yield* serviceFor({ host, home: dir })).ensureChecked;
      expect(starts()).toBe(5);
      // Kept for this very build, but with nothing agents could be shown.
      const kept = keptCapture(dir);
      const capture = JSON.parse(NodeFS.readFileSync(kept, "utf8"));
      NodeFS.writeFileSync(kept, JSON.stringify({ ...capture, answers: {} }));
      const service = yield* serviceFor({ host, home: dir });
      yield* service.ensureChecked;
      expect(starts()).toBe(10);
      expect(Option.getOrThrow(yield* Stream.runHead(service.readiness))).toMatchObject({
        status: "ok",
        blenderMcpCapture: { answers: { "*": { "tools/list": { result: { tools: [{}] } } } } },
      });
    }).pipe(Effect.scoped),
  );

  it.live("never reuses kept answers for a build it can't identify", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      consoleScript(NodePath.join(dir, ".local", "bin", "blender-mcp"), "blmcp");
      NodeFS.rmSync(NodePath.join(dir, ".local", "lib", "python3.12"), { recursive: true });
      const starts = () =>
        NodeFS.readFileSync(NodePath.join(dir, ".local", "bin", "starts.log"), "utf8")
          .split("\n")
          .filter(Boolean).length;
      yield* (yield* serviceFor({ host, home: dir })).ensureChecked;
      yield* (yield* serviceFor({ host, home: dir })).ensureChecked;
      expect(starts()).toBe(10);
    }).pipe(Effect.scoped),
  );

  it.live("reports an official server that doesn't answer as failed, giving agents nothing", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      const mcp = consoleScript(NodePath.join(dir, ".local", "bin", "blender-mcp"), "blmcp");
      NodeFS.writeFileSync(NodePath.join(dir, ".local", "bin", "silent"), "");
      const service = yield* serviceFor({ host, home: dir });
      yield* service.ensureChecked;
      const result = checkedResult(
        yield* (yield* watch(service))((state) => state.result !== null),
      );
      expect(result.checks).toContainEqual({ item: "blenderMcp", status: "failed", found: mcp });
      expect(Option.getOrThrow(yield* Stream.runHead(service.readiness))).toMatchObject({
        status: "ok",
        blenderMcp: null,
        blenderMcpCapture: null,
      });
    }).pipe(Effect.scoped),
  );

  it.live("hands agents the official Blender MCP, never the third-party one", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      const official = consoleScript(NodePath.join(dir, "tools", "blender-mcp"), "blmcp");
      const lookalike = consoleScript(
        NodePath.join(dir, "other", "blender-mcp"),
        "blender_mcp.server",
      );
      const readinessWith = Effect.fnUntraced(function* (blenderMcpPath: string) {
        const service = yield* serviceFor({ host, home: dir, blenderMcpPath });
        yield* service.ensureChecked;
        return Option.getOrThrow(yield* Stream.runHead(service.readiness));
      });
      expect(yield* readinessWith(official)).toMatchObject({ status: "ok", blenderMcp: official });
      expect(yield* readinessWith(lookalike)).toMatchObject({ status: "ok", blenderMcp: null });
    }).pipe(Effect.scoped),
  );

  it.live("tells the third-party blender-mcp from Blender Lab's", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      // PyPI's unrelated `blender-mcp` installs the same command name.
      const lookalike = consoleScript(
        NodePath.join(dir, ".local", "bin", "blender-mcp"),
        "blender_mcp.server",
      );
      const service = yield* serviceFor({ host, home: dir });
      yield* service.ensureChecked;
      const result = checkedResult(
        yield* (yield* watch(service))((state) => state.result !== null),
      );
      expect(result.checks).toContainEqual({
        item: "blenderMcp",
        status: "unrecognized",
        found: lookalike,
      });
      expect(result.commands.join("\n")).toContain("projects.blender.org/lab/blender_mcp");
    }).pipe(Effect.scoped),
  );

  it.live("expands ~ in the Blender MCP path", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      const mcp = consoleScript(NodePath.join(dir, "tools", "blender-mcp"), "blmcp");
      const service = yield* serviceFor({ host, home: dir, blenderMcpPath: "~/tools/blender-mcp" });
      yield* service.ensureChecked;
      expect(
        checkedResult(yield* (yield* watch(service))((state) => state.result !== null)).checks,
      ).toContainEqual({ item: "blenderMcp", status: "ok", found: mcp });
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
      yield* on.ensureChecked;
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(on.readiness)), {
        status: "ok",
        helper: host.helper,
        blender: host.blender,
        blenderMcp: null,
        blenderMcpCapture: null,
      });

      NodeFS.rmSync(NodePath.join(host.bin, "gst-inspect-1.0"));
      const missing = yield* serviceFor({ host, home: dir });
      yield* missing.ensureChecked;
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

  it.live("says a host is unsupported before anyone checks, where that needs no probe", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const host = fakeHost(dir);
      const unavailable: HostedBlenderSetupState = {
        result: { status: "unavailable", reason: "platform", distro: null },
        checking: false,
        installThreadId: null,
      };
      for (const options of [{ platform: "win32" as const }, { helperUnsupported: true }]) {
        const service = yield* serviceFor({ host, home: dir, ...options });
        assert.deepStrictEqual(yield* (yield* watch(service))(() => true), unavailable);
        assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(service.readiness)), {
          status: "unavailable",
          reason: "platform",
        });
      }
      expect(host.probeCount()).toBe(0);
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
      consoleScript(NodePath.join(dir, ".local", "bin", "blender-mcp"), "blmcp");
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
