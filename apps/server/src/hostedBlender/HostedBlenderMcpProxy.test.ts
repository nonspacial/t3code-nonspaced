// @effect-diagnostics nodeBuiltinImport:off -- Skips the official-server cases where Blender Lab is not installed.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  type BlenderMcpCapture,
  captureBlenderMcp,
  discoveryEnvironment,
  openBlenderMcp,
} from "./blenderMcpStdio.ts";
import * as HostedBlender from "./HostedBlender.ts";
import * as HostedBlenderAgents from "./HostedBlenderAgents.ts";
import * as HostedBlenderMcpProxy from "./HostedBlenderMcpProxy.ts";

/**
 * A stand-in for Blender Lab's `blender-mcp`: newline-delimited JSON-RPC over stdio, logging each
 * start, call and cancel it receives to `log`.
 */
const FAKE_SERVER = `
const fs = require("node:fs");
const log = (line) => fs.appendFileSync(process.env.FAKE_LOG, line + "\\n");
log("start " + process.pid + " host=" + process.env.BLENDER_MCP_HOST + " port=" + (process.env.BLENDER_MCP_PORT ?? "none") + " blender=" + process.env.BLENDER_PATH + " t3=" + (process.env.T3CODE_SECRET ?? "none"));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
let pendingAsk;
function handle(message) {
  if (message.id === "server-1" && message.error && pendingAsk !== undefined) {
    send({ jsonrpc: "2.0", id: pendingAsk, result: { content: [{ type: "text", text: "refused " + message.error.code }] } });
    pendingAsk = undefined;
    return;
  }
  if (message.method === "initialize") {
    const asked = message.params.protocolVersion;
    const answer = () => send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: ["2025-06-18", "2025-11-25"].includes(asked) ? asked : "2025-11-25",
      capabilities: { prompts: { listChanged: false }, tools: { listChanged: false } },
      serverInfo: { name: "blender-mcp", version: "1.30.0" },
      instructions: "Fake Blender \\u2014 \\u201cinspect\\u201d first.\\nLine two.",
    } });
    // With "hold" beside its log, it answers only once that file is gone.
    const hold = require("node:path").join(require("node:path").dirname(process.env.FAKE_LOG), "hold");
    if (!fs.existsSync(hold)) return answer();
    const timer = setInterval(() => { if (!fs.existsSync(hold)) { clearInterval(timer); answer(); } }, 20);
    return;
  }
  if (message.method === "tools/list") {
    return send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "get_objects_summary", description: "\\nSummary.\\n", inputSchema: { type: "object", properties: {} } },
    ] } });
  }
  if (message.method === "prompts/list") return send({ jsonrpc: "2.0", id: message.id, result: { prompts: [] } });
  if (message.method === "notifications/cancelled") return log("cancelled " + message.params.requestId);
  if (message.method !== "tools/call") return;
  const { name, arguments: args } = message.params;
  log("call " + name);
  const text = (value) => send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: value }] } });
  if (name === "echo" || name === "execute_blender_code" || name === "get_objects_summary") return text(JSON.stringify(args));
  if (name === "screenshot") {
    return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }, { type: "text", text: "1920x1080" }] } });
  }
  if (name === "render") {
    send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: message.params._meta.progressToken, progress: 1, total: 2 } });
    send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "unrouted" } });
    return text("rendered");
  }
  if (name === "named") return text("Object named port 41000, near localhost:41000.");
  if (name === "held") {
    // Answers once "release" beside its log is gone.
    send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: message.params._meta.progressToken, progress: 0 } });
    const release = require("node:path").join(require("node:path").dirname(process.env.FAKE_LOG), "release");
    const timer = setInterval(() => { if (!fs.existsSync(release)) { clearInterval(timer); text("held done"); } }, 20);
    return;
  }
  if (name === "unreachable") {
    // Blender Lab's own wording when nothing listens on its port.
    return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "Error executing tool unreachable: Cannot connect to Blender at localhost:" + process.env.BLENDER_MCP_PORT + ". Ensure Blender is running with the MCP addon enabled and the server started." }], isError: true } });
  }
  if (name === "invalid") {
    return send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown tool: invalid" } });
  }
  if (name === "ask") {
    // A request to the client, which T3 refuses for it; the answer comes once that refusal does.
    send({ jsonrpc: "2.0", id: "server-1", method: "roots/list" });
    pendingAsk = message.id;
    return;
  }
  if (name === "deaf") {
    // Stays alive but takes no more input.
    process.stdin.removeAllListeners("end");
    process.stdin.destroy();
    fs.closeSync(0);
    // Gone with its parent, so a test run that dies leaves nothing behind.
    const parent = process.ppid;
    setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 50);
    return text("deaf");
  }
  if (name === "crash") process.exit(3);
  // "wait" says it started, and is never answered.
  if (name === "wait") {
    send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: message.params._meta.progressToken, progress: 0 } });
  }
}
`;

const environmentId = EnvironmentId.make("environment-blender-proxy");
const threadA = ThreadId.make("thread-blender-proxy-a");
const threadB = ThreadId.make("thread-blender-proxy-b");
const a = { threadId: threadA, providerSessionId: "session-a" };
const b = { threadId: threadB, providerSessionId: "session-b" };

interface Spawned {
  readonly env: Readonly<Record<string, unknown>>;
  readonly exitCode: Effect.Effect<Exit.Exit<unknown, unknown>>;
}

interface Grant {
  readonly grant: string;
  readonly port: number;
  /** A master relay serves only the session it was opened for. */
  readonly session?: string;
}

const decode = (message: string) => JSON.parse(message) as Record<string, any>;

const PATH = process.env.PATH;

const setup = Effect.fnUntraced(function* (options?: { readonly command?: string }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-blender-proxy-" });
  const log = path.join(dir, "log");
  yield* fileSystem.writeFileString(log, "");
  const script = path.join(dir, "blender-mcp");
  yield* fileSystem.writeFileString(script, `#!${process.execPath}\n${FAKE_SERVER}`);
  yield* fileSystem.chmod(script, 0o755);
  const command = options?.command ?? script;
  // As setup reads it: in a discovery environment, before any session.
  const capture: { value: BlenderMcpCapture | null } = {
    value: yield* captureBlenderMcp({ command, environment: { PATH, FAKE_LOG: log }, tmpDir: dir }),
  };
  yield* fileSystem.writeFileString(log, "");

  const ends = yield* PubSub.unbounded<HostedBlenderAgents.HostedBlenderRouteEnded>();
  const allowed = { value: true };
  const mode: { value: "default" | "plan" | "unreadable" } = { value: "default" };
  const grants = new Map<string, Grant>();
  // While on, each grant read waits for the test to release it, handing it a release here.
  const holdGrants = { value: false };
  const grantReads = yield* Queue.unbounded<Deferred.Deferred<void>>();
  // The same for the thread's mode, which the gates read from the database.
  const holdModes = { value: false };
  const modeReads = yield* Queue.unbounded<Deferred.Deferred<void>>();
  const spawned: Array<Spawned> = [];
  // Each spawn as it happens, for a test that acts once a server is starting.
  const spawns = yield* Queue.unbounded<Spawned>();
  const real = yield* ChildProcessSpawner.ChildProcessSpawner;
  const recording = ChildProcessSpawner.make((spawnCommand) =>
    real.spawn(spawnCommand).pipe(
      Effect.tap((handle) =>
        Effect.sync(() => {
          const entry = {
            env:
              (spawnCommand._tag === "StandardCommand" ? spawnCommand.options.env : undefined) ??
              {},
            exitCode: Effect.exit(handle.exitCode),
          };
          spawned.push(entry);
          Queue.offerUnsafe(spawns, entry);
        }),
      ),
    ),
  );
  const layerScope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(
    HostedBlenderMcpProxy.layer.pipe(
      Layer.provideMerge(McpProviderSessions.layer),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(HostedBlenderAgents.HostedBlenderAgents)({
            agentsAllowed: Effect.sync(() => allowed.value),
            routeEnds: Effect.map(PubSub.subscribe(ends), Stream.fromSubscription),
            blenderMcpCapture: () => Effect.sync(() => capture.value),
          }),
          Layer.mock(HostedBlender.HostedBlender)({
            agentGrant: ({ threadId, role, session }) =>
              Effect.gen(function* () {
                if (holdGrants.value) {
                  const release = Deferred.makeUnsafe<void>();
                  Queue.offerUnsafe(grantReads, release);
                  yield* Deferred.await(release);
                }
                const grant = grants.get(`${threadId}:${role}`);
                return grant !== undefined &&
                  (grant.session === undefined || grant.session === session)
                  ? { _tag: "granted", grant: grant.grant, port: grant.port }
                  : ({
                      _tag: "none",
                      relativePath: role === "working" ? "models/hero.wip-a1.blend" : null,
                      listener: {
                        state: "off",
                        ended: "revoked",
                        openFile: undefined,
                        mcpVersion: null,
                      },
                    } as const);
              }),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () =>
              Effect.gen(function* () {
                if (holdModes.value) {
                  const release = Deferred.makeUnsafe<void>();
                  Queue.offerUnsafe(modeReads, release);
                  yield* Deferred.await(release);
                }
                return mode.value === "unreadable"
                  ? yield* Effect.fail(new Error("unreadable") as never)
                  : ({ interactionMode: mode.value } as never);
              }),
          }),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, recording),
          Layer.succeed(HostProcess.Environment, {
            PATH,
            FAKE_LOG: log,
            T3CODE_SECRET: "must not reach blender-mcp",
            // A user's shell may carry Blender Lab's own settings; none of them may steer it.
            BLENDER_MCP_HOST: "elsewhere.example",
            BLENDER_MCP_PORT: "9876",
          }),
        ),
      ),
    ),
    layerScope,
  );
  const proxy = Context.get(context, HostedBlenderMcpProxy.HostedBlenderMcpProxy);
  const sessions = Context.get(context, McpProviderSessions.McpProviderSessions);

  /** A session holding the Blender servers, granted both roles on `port` and `port + 1`. */
  const startSession = Effect.fnUntraced(function* (
    caller: HostedBlenderMcpProxy.BlenderMcpCaller,
    port: number,
  ) {
    yield* sessions.set({
      environmentId,
      threadId: caller.threadId,
      providerSessionId: caller.providerSessionId,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1:1/mcp",
      authorizationHeader: "Bearer unused",
      browserToolsAvailable: false,
      hostedBlender: { command, blenderPath: "/usr/bin/blender", masterPort: 1, tmpDir: dir },
    });
    grants.set(`${caller.threadId}:working`, { grant: `launch-${port}`, port });
    grants.set(`${caller.threadId}:master`, {
      grant: `relay-${port}`,
      port: port + 1,
      session: caller.providerSessionId,
    });
  });

  let nextId = 1;
  const send = (
    caller: HostedBlenderMcpProxy.BlenderMcpCaller,
    role: HostedBlenderAgents.HostedBlenderRole,
    message: Record<string, unknown>,
    protocolVersion = "2025-06-18",
  ) => proxy.handle({ caller, role, protocolVersion, message: { jsonrpc: "2.0", ...message } });
  const collect = Effect.fnUntraced(function* (reply: HostedBlenderMcpProxy.BlenderMcpReply) {
    if (reply._tag === "Accepted") return [];
    if (reply._tag === "Message") return [decode(reply.message)];
    return Array.from(yield* Stream.runCollect(reply.messages), decode);
  });
  /** Every message the request is answered with, in order. */
  const ask = Effect.fnUntraced(function* (
    caller: HostedBlenderMcpProxy.BlenderMcpCaller,
    role: HostedBlenderAgents.HostedBlenderRole,
    message: Record<string, unknown>,
    protocolVersion?: string,
  ) {
    return yield* collect(yield* send(caller, role, { id: nextId++, ...message }, protocolVersion));
  });
  const callTool = (
    caller: HostedBlenderMcpProxy.BlenderMcpCaller,
    role: HostedBlenderAgents.HostedBlenderRole,
    name: string,
    extra: Record<string, unknown> = {},
  ) =>
    ask(caller, role, {
      method: "tools/call",
      params: { name, arguments: { from: caller.providerSessionId }, ...extra },
    });
  /** A call to "wait", once the server has it: its messages after the first, as they come. */
  const startWait = Effect.fnUntraced(function* (
    caller: HostedBlenderMcpProxy.BlenderMcpCaller,
    callId: string | number,
  ) {
    const reply = yield* send(caller, "working", {
      id: callId,
      method: "tools/call",
      params: { name: "wait", arguments: {}, _meta: { progressToken: `wait-${callId}` } },
    });
    if (reply._tag !== "Stream") return yield* Effect.die("expected a call");
    const messages = yield* Queue.unbounded<Record<string, any>, Cause.Done>();
    const reading = yield* reply.messages.pipe(
      Stream.runForEach((message) => Queue.offer(messages, decode(message))),
      Effect.andThen(Queue.end(messages)),
      Effect.forkChild,
    );
    const started = yield* Queue.take(messages);
    assert.strictEqual(started.method, "notifications/progress");
    return { rest: Queue.collect(messages), reading };
  });
  const logLines = fileSystem
    .readFileString(log)
    .pipe(Effect.map((text) => text.split("\n").filter((line) => line.length > 0)));
  const starts = logLines.pipe(
    Effect.map((lines) => lines.filter((line) => line.startsWith("start"))),
  );
  const calls = logLines.pipe(
    Effect.map((lines) => lines.filter((line) => line.startsWith("call"))),
  );

  return {
    script,
    capture,
    ends,
    allowed,
    mode,
    grants,
    holdGrants,
    grantReads,
    holdModes,
    modeReads,
    sessions,
    hold: path.join(dir, "hold"),
    release: path.join(dir, "release"),
    spawned,
    spawns,
    layerScope,
    startSession,
    send,
    collect,
    ask,
    callTool,
    startWait,
    logLines,
    starts,
    calls,
  };
});

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("HostedBlenderMcpProxy", () => {
  it.live("answers initialize and the lists from setup's capture, starting nothing", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        yield* t.startSession(b, 42000);
        for (const caller of [a, b]) {
          for (const role of ["working", "master"] as const) {
            const [init] = yield* t.ask(caller, role, {
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "x" },
              },
            });
            assert.strictEqual(init?.result.protocolVersion, "2025-06-18");
            assert.strictEqual(
              init?.result.instructions,
              "Fake Blender — “inspect” first.\nLine two.",
            );
            const [tools] = yield* t.ask(caller, role, { method: "tools/list" });
            assert.deepStrictEqual(
              tools?.result.tools.map((tool: { name: string }) => tool.name),
              ["get_objects_summary"],
            );
            assert.deepStrictEqual((yield* t.ask(caller, role, { method: "prompts/list" }))[0], {
              jsonrpc: "2.0",
              id: tools!.id + 1,
              result: { prompts: [] },
            });
          }
        }
        // A version the server doesn't know gets the answer it gave one it didn't know.
        const [unknown] = yield* t.ask(a, "working", {
          method: "initialize",
          params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "x" } },
        });
        assert.strictEqual(unknown?.result.protocolVersion, "2025-11-25");
        // Neither discovery nor a method the server doesn't offer starts anything.
        const [prompt] = yield* t.ask(a, "working", {
          method: "prompts/get",
          params: { name: "x" },
        });
        assert.strictEqual(prompt?.error.code, -32601);
        assert.deepStrictEqual(t.spawned, []);
      }),
    ),
  );

  it.live("refuses discovery when setup has no capture, or the installed build changed", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        const kept = t.capture.value;
        t.capture.value = null;
        const [missing] = yield* t.ask(a, "working", { method: "tools/list" });
        assert.include(missing?.error.message, "Check again");
        t.capture.value = kept;
        // Upgraded in place since setup read it: the old list would describe another server.
        NodeFS.appendFileSync(t.script, "\n// a newer build\n");
        const [changed] = yield* t.ask(a, "working", { method: "tools/list" });
        assert.include(changed?.error.message, "changed since T3 Code checked it");
        const [call] = yield* t.callTool(a, "working", "echo");
        assert.include(call?.error.message, "changed since T3 Code checked it");
        assert.deepStrictEqual(t.spawned, []);
      }),
    ),
  );

  it.live(
    "starts one server per session and role on its grant's port, and nothing else steers it",
    () =>
      run(
        Effect.gen(function* () {
          const t = yield* setup();
          yield* t.startSession(a, 41000);
          yield* t.startSession(b, 42000);
          // Concurrent first calls share one server.
          const [[first]] = yield* Effect.all(
            [t.callTool(a, "working", "echo"), t.callTool(a, "working", "echo")],
            { concurrency: "unbounded" },
          );
          assert.deepStrictEqual(first?.result.content, [
            { type: "text", text: '{"from":"session-a"}' },
          ]);
          yield* t.callTool(a, "working", "echo");
          yield* t.callTool(a, "master", "echo");
          yield* t.callTool(b, "working", "echo");
          const starts = yield* t.starts;
          assert.strictEqual(starts.length, 3);
          assert.match(
            starts[0]!,
            /host=localhost port=41000 blender=\/usr\/bin\/blender t3=none$/,
          );
          assert.match(starts[1]!, /host=localhost port=41001 /);
          assert.match(starts[2]!, /host=localhost port=42000 /);
        }),
      ),
  );

  it.live(
    "routes by the credential's session alone, never by a thread or port the caller names",
    () =>
      run(
        Effect.gen(function* () {
          const t = yield* setup();
          const current = { threadId: threadA, providerSessionId: "session-a-2" };
          yield* t.startSession(current, 41000);
          // An ended session's credential (or another thread's id with it) reaches nothing.
          for (const caller of [
            { threadId: threadA, providerSessionId: "session-a-1" },
            { threadId: threadB, providerSessionId: "session-a-2" },
          ]) {
            const [refused] = yield* t.callTool(caller, "working", "echo");
            assert.strictEqual(
              refused?.error.message,
              "Hosted Blender is not available to this agent session.",
            );
          }
          yield* t.callTool(current, "working", "echo", {
            _meta: { threadId: threadB, port: 42000 },
            BLENDER_MCP_PORT: 42000,
          });
          assert.deepStrictEqual(
            (yield* t.starts).map((line) => /port=(\d+)/.exec(line)?.[1]),
            ["41000"],
          );
        }),
      ),
  );

  it.live("starts nothing without a live grant for the session and role, and says what to do", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        // A working Blender whose grant ended, and a master relay opened for another session.
        t.grants.delete(`${threadA}:working`);
        t.grants.set(`${threadA}:master`, { grant: "relay-old", port: 41001, session: "older" });
        const [working] = yield* t.callTool(a, "working", "echo");
        assert.include(working?.error.message, "blender_quit with save: true");
        const [master] = yield* t.callTool(a, "master", "echo");
        assert.include(master?.error.message, "blender_master_open");
        assert.deepStrictEqual(t.spawned, []);
      }),
    ),
  );

  it.live("checks the grant again before a call reaches the server", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        NodeFS.writeFileSync(t.hold, "");
        const reply = yield* t
          .send(a, "working", {
            id: 1,
            method: "tools/call",
            params: { name: "echo", arguments: {} },
          })
          .pipe(Effect.flatMap(t.collect), Effect.forkChild);
        // The grant ends after the call was admitted, while its server starts and before the
        // call is written; its ending hasn't been processed yet.
        yield* Queue.take(t.spawns);
        t.grants.delete(`${threadA}:working`);
        NodeFS.rmSync(t.hold);
        const [refused] = yield* Fiber.join(reply);
        assert.include(refused?.error.message, "blender_quit with save: true");
        assert.deepStrictEqual(yield* t.calls, []);
        // And a new launch's grant is not the one the server was started for.
        t.grants.set(`${threadA}:working`, { grant: "launch-next", port: 41000 });
        const [answered] = yield* t.callTool(a, "working", "echo");
        assert.strictEqual(answered?.result.content[0].text, '{"from":"session-a"}');
        assert.strictEqual((yield* t.starts).length, 2);
      }),
    ),
  );

  it.live("stops the server an ending reaches while its registration still waits", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        t.holdGrants.value = true;
        const calling = yield* t.callTool(a, "working", "echo").pipe(Effect.forkChild);
        // Registration holds the lock while it reads the grant; the session ends meanwhile.
        const registering = yield* Queue.take(t.grantReads);
        yield* PubSub.publish(t.ends, { threadId: threadA, session: "session-a" });
        t.holdGrants.value = false;
        yield* Deferred.succeed(registering, undefined);
        const [ended] = yield* Fiber.join(calling);
        assert.include(ended?.error.message, "This agent session ended");
        yield* t.spawned[0]!.exitCode;
        assert.deepStrictEqual(yield* t.calls, []);
      }),
    ),
  );

  it.live("reads the credential again after the slower gates, just before the write", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        yield* t.callTool(a, "working", "echo");
        t.holdGrants.value = true;
        const calling = yield* t.callTool(a, "working", "echo").pipe(Effect.forkChild);
        yield* Deferred.succeed(yield* Queue.take(t.grantReads), undefined);
        // The write's own read of the grant: the session's credential is gone by its end.
        const writing = yield* Queue.take(t.grantReads);
        yield* t.sessions.clear(threadA);
        t.holdGrants.value = false;
        yield* Deferred.succeed(writing, undefined);
        const [refused] = yield* Fiber.join(calling);
        assert.strictEqual(
          refused?.error.message,
          "Hosted Blender is not available to this agent session.",
        );
        assert.deepStrictEqual(yield* t.calls, ["call echo"]);
      }),
    ),
  );

  it.live("never writes a call cancelled while its gates were read", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        yield* t.callTool(a, "working", "echo");
        t.holdGrants.value = true;
        const reply = yield* t
          .send(a, "working", {
            id: "late",
            method: "tools/call",
            params: { name: "echo", arguments: {} },
          })
          .pipe(Effect.flatMap(t.collect), Effect.forkChild);
        yield* Deferred.succeed(yield* Queue.take(t.grantReads), undefined);
        const reading = reply;
        const writing = yield* Queue.take(t.grantReads);
        yield* t.send(a, "working", {
          method: "notifications/cancelled",
          params: { requestId: "late" },
        });
        t.holdGrants.value = false;
        yield* Deferred.succeed(writing, undefined);
        assert.deepStrictEqual(yield* Fiber.join(reading), []);
        // Ordered after the cancel on the server's stdin.
        yield* t.callTool(a, "working", "echo");
        assert.deepStrictEqual(yield* t.calls, ["call echo", "call echo"]);
      }),
    ),
  );

  it.live("withdraws a call cancelled during its first admission", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        yield* t.callTool(a, "working", "echo");
        t.holdModes.value = true;
        const reply = yield* t
          .send(a, "working", {
            id: "early",
            method: "tools/call",
            params: { name: "echo", arguments: {} },
          })
          .pipe(Effect.flatMap(t.collect), Effect.forkChild);
        // Before any server is chosen for it, the client cancels and goes on reading.
        const admitting = yield* Queue.take(t.modeReads);
        yield* t.send(a, "working", {
          method: "notifications/cancelled",
          params: { requestId: "early" },
        });
        t.holdModes.value = false;
        yield* Deferred.succeed(admitting, undefined);
        assert.deepStrictEqual(yield* Fiber.join(reply), []);
        yield* t.callTool(a, "working", "echo");
        assert.deepStrictEqual(yield* t.calls, ["call echo", "call echo"]);
      }),
    ),
  );

  it.live("starts no server for a first call cancelled during its admission", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        t.holdModes.value = true;
        const reply = yield* t
          .send(a, "working", {
            id: "first",
            method: "tools/call",
            params: { name: "echo", arguments: {} },
          })
          .pipe(Effect.flatMap(t.collect), Effect.forkChild);
        const admitting = yield* Queue.take(t.modeReads);
        yield* t.send(a, "working", {
          method: "notifications/cancelled",
          params: { requestId: "first" },
        });
        t.holdModes.value = false;
        yield* Deferred.succeed(admitting, undefined);
        assert.deepStrictEqual(yield* Fiber.join(reply), []);
        // A server started for it would be spawned before one a later call starts.
        yield* t.callTool(a, "master", "echo");
        const [first] = Array.from(yield* Queue.takeAll(t.spawns));
        assert.strictEqual(first?.env.BLENDER_MCP_PORT, "41001");
        assert.strictEqual(t.spawned.length, 1);
      }),
    ),
  );

  it.live("leaves the server started since for a newer build when a stale read is refused", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        yield* t.callTool(a, "working", "echo");
        // A call reads the installed build, then waits on its mode read.
        t.holdModes.value = true;
        const stale = yield* t.callTool(a, "working", "echo").pipe(Effect.forkChild);
        const resuming = yield* Queue.take(t.modeReads);
        t.holdModes.value = false;
        // Meanwhile setup reads a newer build and another call starts its server, still busy.
        NodeFS.appendFileSync(t.script, "\n// a newer build\n");
        t.capture.value = yield* captureBlenderMcp({
          command: t.script,
          environment: { PATH, FAKE_LOG: `${t.hold}.log` },
          tmpDir: NodeOS.tmpdir(),
        });
        NodeFS.writeFileSync(t.release, "");
        const busy = yield* t.send(a, "working", {
          id: "on-new",
          method: "tools/call",
          params: { name: "held", arguments: {}, _meta: { progressToken: "held" } },
        });
        if (busy._tag !== "Stream") return assert.fail("expected a call");
        const messages = yield* Queue.unbounded<Record<string, any>, Cause.Done>();
        yield* busy.messages.pipe(
          Stream.runForEach((message) => Queue.offer(messages, decode(message))),
          Effect.andThen(Queue.end(messages)),
          Effect.forkChild,
        );
        assert.strictEqual((yield* Queue.take(messages)).method, "notifications/progress");
        const replacement = t.spawned[1]!;
        yield* Deferred.succeed(resuming, undefined);
        const [refused] = yield* Fiber.join(stale);
        assert.include(refused?.error.message, "changed since T3 Code checked it");
        // The newer server's call completes, and the server keeps running.
        NodeFS.rmSync(t.release);
        assert.strictEqual((yield* Queue.take(messages)).result.content[0].text, "held done");
        const [answered] = yield* t.callTool(a, "working", "echo");
        assert.strictEqual(answered?.result.content[0].text, '{"from":"session-a"}');
        assert.strictEqual(t.spawned.length, 2);
        assert.isFalse(
          yield* replacement.exitCode.pipe(
            Effect.timeoutOption("0 millis"),
            Effect.map((exit) => exit._tag === "Some"),
          ),
        );
      }),
    ),
  );

  it.live("reads setup's capture in the final gate, after the mode read it waited on", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        yield* t.callTool(a, "working", "echo");
        const old = t.spawned[0]!;
        t.holdModes.value = true;
        const calling = yield* t.callTool(a, "working", "echo").pipe(Effect.forkChild);
        yield* Deferred.succeed(yield* Queue.take(t.modeReads), undefined);
        // The write's own mode read: setup's check fails while it waits, before any ending.
        const writing = yield* Queue.take(t.modeReads);
        t.capture.value = null;
        t.holdModes.value = false;
        yield* Deferred.succeed(writing, undefined);
        const [refused] = yield* Fiber.join(calling);
        assert.include(refused?.error.message, "Check again");
        yield* old.exitCode;
        assert.deepStrictEqual(yield* t.calls, ["call echo"]);
      }),
    ),
  );

  it.live("stops only the servers on the build setup took back", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        yield* t.callTool(a, "working", "echo");
        const before = t.capture.value!.build;
        NodeFS.appendFileSync(t.script, "\n// a newer build\n");
        t.capture.value = yield* captureBlenderMcp({
          command: t.script,
          environment: { PATH, FAKE_LOG: `${t.hold}.log` },
          tmpDir: NodeOS.tmpdir(),
        });
        yield* t.callTool(a, "working", "echo");
        assert.strictEqual(t.spawned.length, 2);
        // The old build's late ending leaves the server already on its successor.
        yield* PubSub.publish(t.ends, { staleBuild: before });
        yield* t.callTool(a, "working", "echo");
        assert.strictEqual(t.spawned.length, 2);
        const replacement = t.spawned[1]!;
        const waiting = yield* t.startWait(a, "on-new");
        yield* PubSub.publish(t.ends, { staleBuild: t.capture.value!.build });
        const [failed] = Array.from(yield* waiting.rest);
        assert.include(failed?.error.message, "reinstalled");
        yield* replacement.exitCode;
      }),
    ),
  );

  it.live("stops a server whose session ends while it is still starting", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        NodeFS.writeFileSync(t.hold, "");
        const calling = yield* t.callTool(a, "working", "echo").pipe(Effect.forkChild);
        const starting = yield* Queue.take(t.spawns);
        yield* PubSub.publish(t.ends, { threadId: threadA, session: "session-a" });
        const [ended] = yield* Fiber.join(calling);
        assert.include(ended?.error.message, "This agent session ended");
        yield* starting.exitCode;
        NodeFS.rmSync(t.hold);
      }),
    ),
  );

  it.live("refuses a write when the thread entered Plan mode while it waited for its server", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        NodeFS.writeFileSync(t.hold, "");
        const reply = yield* t.send(a, "working", {
          id: 1,
          method: "tools/call",
          params: { name: "execute_blender_code", arguments: { code: "x" } },
        });
        // Admitted in Default mode; the server is still starting when the user switches.
        const reading = yield* t.collect(reply).pipe(Effect.forkChild);
        yield* Queue.take(t.spawns);
        t.mode.value = "plan";
        NodeFS.rmSync(t.hold);
        const [refused] = yield* Fiber.join(reading);
        assert.include(refused?.error.message, "Plan mode is read-only");
        assert.deepStrictEqual(yield* t.calls, []);
      }),
    ),
  );

  it.live("replaces the server when setup reads a new build, and stops it when a check fails", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        yield* t.callTool(a, "working", "echo");
        // Reinstalled in place and checked again: the old server is not the one now described.
        NodeFS.appendFileSync(t.script, "\n// a newer build\n");
        t.capture.value = yield* captureBlenderMcp({
          command: t.script,
          environment: { PATH, FAKE_LOG: `${t.hold}.log` },
          tmpDir: NodeOS.tmpdir(),
        });
        const [answered] = yield* t.callTool(a, "working", "echo");
        assert.strictEqual(answered?.result.content[0].text, '{"from":"session-a"}');
        yield* t.spawned[0]!.exitCode;
        assert.strictEqual(t.spawned.length, 2);
        // A check that failed takes the server with it, not just later calls.
        t.capture.value = null;
        const [refused] = yield* t.callTool(a, "working", "echo");
        assert.include(refused?.error.message, "Check again");
        yield* t.spawned[1]!.exitCode;
      }),
    ),
  );

  it.live("refuses Blender's write tools in Plan mode, and when the mode can't be read", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        for (const mode of ["plan", "unreadable"] as const) {
          t.mode.value = mode;
          const [refused] = yield* t.callTool(a, "working", "execute_blender_code");
          assert.include(refused?.error.message, "Plan mode is read-only");
          const [read] = yield* t.callTool(a, "working", "get_objects_summary");
          assert.strictEqual(read?.result.content[0].text, '{"from":"session-a"}');
        }
        assert.deepStrictEqual(yield* t.calls, [
          "call get_objects_summary",
          "call get_objects_summary",
        ]);
        t.mode.value = "default";
        yield* t.callTool(a, "working", "execute_blender_code");
        assert.strictEqual((yield* t.calls).at(-1), "call execute_blender_code");
      }),
    ),
  );

  it.live(
    "passes results, progress, errors and refused server requests through, without the port",
    () =>
      run(
        Effect.gen(function* () {
          const t = yield* setup();
          yield* t.startSession(a, 41000);
          const [image] = yield* t.callTool(a, "working", "screenshot");
          assert.deepStrictEqual(image?.result, {
            content: [
              { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
              { type: "text", text: "1920x1080" },
            ],
          });
          const render = yield* t.callTool(a, "working", "render", {
            _meta: { progressToken: "render-1" },
          });
          assert.deepStrictEqual(
            render.map((message) => message.method ?? "result"),
            ["notifications/progress", "result"],
          );
          assert.deepStrictEqual(render[0]?.params, {
            progressToken: "render-1",
            progress: 1,
            total: 2,
          });
          const [invalid] = yield* t.callTool(a, "working", "invalid");
          assert.deepStrictEqual(invalid?.error, {
            code: -32602,
            message: "Unknown tool: invalid",
          });
          const [asked] = yield* t.callTool(a, "working", "ask");
          assert.strictEqual(asked?.result.content[0].text, "refused -32601");
          // Blender Lab's connection diagnostic is told as what to do, without its address.
          const [unreachable] = yield* t.callTool(a, "working", "unreachable");
          assert.deepStrictEqual(unreachable?.result, {
            content: [
              {
                type: "text",
                text: "Blender Lab's MCP server could not reach this thread's hosted Blender: it isn't listening for you now. Call blender_status to see why and how to get it back.",
              },
            ],
            isError: true,
          });
          // Everything else passes untouched: a scene's own text, the client's id and token.
          const named = yield* t.collect(
            yield* t.send(a, "working", {
              id: "localhost:41000",
              method: "tools/call",
              params: { name: "named", arguments: {}, _meta: { progressToken: "port 41000" } },
            }),
          );
          assert.strictEqual(named[0]?.id, "localhost:41000");
          assert.strictEqual(
            named[0]?.result.content[0].text,
            "Object named port 41000, near localhost:41000.",
          );
          const [message] = yield* t.collect(
            yield* t.send(a, "working", {
              id: "client-string-id",
              method: "tools/call",
              params: { name: "echo", arguments: {} },
            }),
          );
          assert.strictEqual(message?.id, "client-string-id");
        }),
      ),
  );

  it.live("passes a client's cancel on, and cancels a call the client stopped reading", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        const cancelled = yield* t.startWait(a, 70);
        yield* t.send(a, "working", {
          method: "notifications/cancelled",
          params: { requestId: 70, reason: "user interrupted" },
        });
        // Cancelled calls get no answer.
        assert.deepStrictEqual(Array.from(yield* cancelled.rest), []);
        const abandoned = yield* t.startWait(a, 71);
        yield* Fiber.interrupt(abandoned.reading);
        // Ordered after both cancels on the server's stdin.
        yield* t.callTool(a, "working", "echo");
        const cancels = (yield* t.logLines).filter((line) => line.startsWith("cancelled"));
        assert.strictEqual(cancels.length, 2);
      }),
    ),
  );

  it.live("stops the server for the grant that ended, and fails its calls in flight", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        const ends: ReadonlyArray<readonly [HostedBlenderAgents.HostedBlenderRouteEnded, string]> =
          [
            [
              { threadId: threadA, role: "working", grant: "launch-41000" },
              "Your access to this thread's hosted Blender ended",
            ],
            [{ threadId: threadA, session: "session-a" }, "This agent session ended"],
            [{ threadId: threadA }, "This agent session ended"],
            [null, 'switched off "Allow agents to start hosted Blenders"'],
          ];
        for (const [index, [ended, reason]] of ends.entries()) {
          yield* t.callTool(a, "working", "echo");
          const child = t.spawned.at(-1)!;
          const inFlight = yield* t.startWait(a, `wait-${index}`);
          yield* PubSub.publish(t.ends, ended);
          const [failed] = Array.from(yield* inFlight.rest);
          assert.include(failed?.error.message, reason);
          yield* child.exitCode;
        }
        assert.strictEqual(t.spawned.length, 4);
        // Another thread's, role's, session's or launch's ending leaves the server alone: a
        // late listener-off from the launch before this one names that launch.
        yield* t.callTool(a, "working", "echo");
        for (const ended of [
          { threadId: threadB },
          { threadId: threadA, role: "master" as const, grant: "relay-41000" },
          { threadId: threadA, session: "session-older" },
          { threadId: threadA, role: "working" as const, grant: "launch-before" },
        ]) {
          yield* PubSub.publish(t.ends, ended);
        }
        yield* t.callTool(a, "working", "echo");
        assert.strictEqual(t.spawned.length, 5);
      }),
    ),
  );

  it.live("restarts a crashed server on the next call", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        const [crashed] = yield* t.callTool(a, "working", "crash");
        assert.include(crashed?.error.message, "stopped unexpectedly (exit code 3)");
        const [answered] = yield* t.callTool(a, "working", "echo");
        assert.strictEqual(answered?.result.content[0].text, '{"from":"session-a"}');
        assert.strictEqual(t.spawned.length, 2);
      }),
    ),
  );

  it.live("stops a server that takes no more input, and starts a fresh one", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        yield* t.callTool(a, "working", "deaf");
        const deaf = t.spawned.at(-1)!;
        const [failed] = yield* t.callTool(a, "working", "echo");
        assert.include(failed?.error.message, "stopped answering");
        yield* deaf.exitCode;
        const [answered] = yield* t.callTool(a, "working", "echo");
        assert.strictEqual(answered?.result.content[0].text, '{"from":"session-a"}');
      }),
    ),
  );

  it.live("refuses calls while agents are switched off, starting nothing", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        t.allowed.value = false;
        const [refused] = yield* t.callTool(a, "working", "echo");
        assert.include(refused?.error.message, "Allow agents to start hosted Blenders");
        assert.deepStrictEqual(t.spawned, []);
      }),
    ),
  );

  it.live("stops every server when T3 stops, including one already being stopped", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        yield* t.callTool(a, "working", "echo");
        yield* t.callTool(a, "master", "echo");
        // Its stop is under way in the background as the service closes.
        const inFlight = yield* t.startWait(a, "w");
        yield* PubSub.publish(t.ends, {
          threadId: threadA,
          role: "working",
          grant: "launch-41000",
        });
        yield* inFlight.rest;
        yield* Scope.close(t.layerScope, Exit.void);
        for (const child of t.spawned) yield* child.exitCode;
        assert.strictEqual(t.spawned.length, 2);
      }),
    ),
  );

  it.effect("stops a server nobody has called for the idle period", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        yield* t.callTool(a, "working", "echo");
        yield* TestClock.adjust("9 minutes");
        yield* t.callTool(a, "working", "echo");
        yield* TestClock.adjust("9 minutes");
        assert.strictEqual(t.spawned.length, 1);
        yield* TestClock.adjust("1 minute");
        yield* t.spawned[0]!.exitCode;
        yield* t.callTool(a, "working", "echo");
        assert.strictEqual(t.spawned.length, 2);
      }),
    ),
  );

  it.effect("gives up on a call the server never answers, and stops that server", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(a, 41000);
        const waiting = yield* t.startWait(a, "never");
        // Far past any client's own timeout, so a render still running is not cut short.
        yield* TestClock.adjust("64 minutes");
        yield* TestClock.adjust("2 minutes");
        const [failed] = Array.from(yield* waiting.rest);
        assert.include(failed?.error.message, "stopped answering");
        yield* t.spawned[0]!.exitCode;
      }),
    ),
  );

  const official = `${NodeOS.homedir()}/.local/share/blender-lab-mcp/1.0.3/.venv/bin/blender-mcp`;
  it.live.skipIf(!NodeFS.existsSync(official))(
    "answers byte for byte as the installed official server does",
    () =>
      run(
        Effect.gen(function* () {
          const t = yield* setup({ command: official });
          yield* t.startSession(a, 1);
          const proxied = new Map<string, unknown>();
          for (const method of ["initialize", "tools/list"]) {
            const reply = yield* t.send(a, "working", {
              id: 1,
              method,
              ...(method === "initialize"
                ? {
                    params: {
                      protocolVersion: "2025-11-25",
                      capabilities: {},
                      clientInfo: { name: "t3-code", version: "1" },
                    },
                  }
                : {}),
            });
            if (reply._tag !== "Message") return assert.fail("expected an answer");
            proxied.set(method, reply.message);
          }
          const direct = yield* officialAnswers(official);
          for (const [method, line] of direct) {
            // The official line with the request id the proxy answered, byte for byte.
            assert.strictEqual(
              proxied.get(method),
              line.replace(/^\{"jsonrpc":"2.0","id":\d+,/, '{"jsonrpc":"2.0","id":1,'),
            );
          }
          assert.deepStrictEqual(t.spawned, []);
        }),
      ),
  );

  it.live.skipIf(!NodeFS.existsSync(official))(
    "gives the discovery server nothing to reach: no Blender listener and no Blender to run",
    () =>
      run(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const tmpDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-discovery-" });
          const env = discoveryEnvironment(
            { PATH, HOME: NodeOS.homedir(), BLENDER_MCP_PORT: "9876" },
            tmpDir,
          );
          assert.deepInclude(env, {
            BLENDER_MCP_HOST: "localhost",
            BLENDER_MCP_PORT: "0",
            BLENDER_PATH: "/dev/null",
          });
          const answers = yield* Queue.unbounded<Record<string, any>>();
          const exited = yield* Deferred.make<void>();
          const scope = yield* Effect.scope;
          const connection = yield* openBlenderMcp({
            command: official,
            env,
            scope,
            onMessage: (message) => Queue.offer(answers, message).pipe(Effect.asVoid),
            onExit: () => Deferred.succeed(exited, undefined),
          });
          yield* connection.send({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x" } },
          });
          yield* Queue.take(answers);
          yield* connection.send({ jsonrpc: "2.0", method: "notifications/initialized" });
          const blend = `${tmpDir}/scene.blend`;
          yield* fileSystem.writeFileString(blend, "");
          for (const [id, name, args] of [
            [2, "execute_blender_code", { code: "result = {}" }],
            [3, "get_blendfile_summary_path_info_for_cli", { blend_file: blend }],
          ] as const) {
            yield* connection.send({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name, arguments: args },
            });
            const answer = yield* Queue.take(answers);
            assert.strictEqual(answer.result.isError, true, JSON.stringify(answer));
          }
        }),
      ),
  );
});

/** The official server's raw stdout lines, as Claude or Codex read them over stdio. */
const officialAnswers = Effect.fnUntraced(function* (command: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const tmpDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-official-" });
  const handle = yield* spawner.spawn(
    ChildProcess.make(command, [], {
      env: discoveryEnvironment({ PATH, HOME: NodeOS.homedir() }, tmpDir),
      extendEnv: false,
      stdin: { stream: "pipe", endOnDone: false },
      stdout: "pipe",
      stderr: "ignore",
    }),
  );
  const lines = yield* Queue.unbounded<string>();
  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Queue.offer(lines, line)),
    Effect.forkScoped,
  );
  const write = (message: unknown) =>
    Stream.run(Stream.make(new TextEncoder().encode(`${JSON.stringify(message)}\n`)), handle.stdin);
  yield* write({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "t3-code", version: "1" },
    },
  });
  const initialize = yield* Queue.take(lines);
  yield* write({ jsonrpc: "2.0", method: "notifications/initialized" });
  yield* write({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = yield* Queue.take(lines);
  return new Map([
    ["initialize", initialize],
    ["tools/list", tools],
  ]);
});
