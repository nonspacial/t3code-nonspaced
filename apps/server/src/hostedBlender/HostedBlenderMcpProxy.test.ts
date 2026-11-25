// @effect-diagnostics nodeBuiltinImport:off -- Skips the official-server case where Blender Lab is not installed.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { HostedBlenderMcpLaunch } from "@t3tools/provider-core/server/mcpSession";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
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
import { ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import * as HostedBlenderAgents from "./HostedBlenderAgents.ts";
import * as HostedBlenderMcpProxy from "./HostedBlenderMcpProxy.ts";

/**
 * A stand-in for Blender Lab's `blender-mcp`: newline-delimited JSON-RPC over stdio, logging each
 * start and each cancel it receives to `log`.
 */
const FAKE_SERVER = `
const fs = require("node:fs");
const log = (line) => fs.appendFileSync(process.env.FAKE_LOG, line + "\\n");
log("start " + process.pid + " port=" + (process.env.BLENDER_MCP_PORT ?? "none") + " blender=" + process.env.BLENDER_PATH + " tmp=" + process.env.TMPDIR + " t3=" + (process.env.T3CODE_SECRET ?? "none"));
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
    return send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: ["2025-06-18", "2025-11-25"].includes(asked) ? asked : "2025-11-25",
      capabilities: { prompts: { listChanged: false }, tools: { listChanged: false } },
      serverInfo: { name: "blender-mcp", version: "1.30.0" },
      instructions: "Fake Blender \\u2014 \\u201cinspect\\u201d first.\\nLine two.",
    } });
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
  if (name === "echo") {
    return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(args) }], isError: false } });
  }
  if (name === "screenshot") {
    return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }, { type: "text", text: "1920x1080" }] } });
  }
  if (name === "render") {
    send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: message.params._meta.progressToken, progress: 1, total: 2 } });
    send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "unrouted" } });
    return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "rendered" }] } });
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

interface Spawned {
  readonly env: Readonly<Record<string, unknown>>;
  readonly exitCode: Effect.Effect<Exit.Exit<unknown, unknown>>;
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

  const ends = yield* PubSub.unbounded<HostedBlenderAgents.HostedBlenderRouteEnd | null>();
  const allowed = { value: true };
  const spawned: Array<Spawned> = [];
  const real = yield* ChildProcessSpawner.ChildProcessSpawner;
  const recording = ChildProcessSpawner.make((command) =>
    real.spawn(command).pipe(
      Effect.tap((handle) =>
        Effect.sync(() => {
          spawned.push({
            env: (command._tag === "StandardCommand" ? command.options.env : undefined) ?? {},
            exitCode: Effect.exit(handle.exitCode),
          });
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
          }),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, recording),
          Layer.succeed(HostProcess.Environment, {
            PATH,
            FAKE_LOG: log,
            T3CODE_SECRET: "must not reach blender-mcp",
          }),
        ),
      ),
    ),
    layerScope,
  );
  const proxy = Context.get(context, HostedBlenderMcpProxy.HostedBlenderMcpProxy);
  const sessions = Context.get(context, McpProviderSessions.McpProviderSessions);

  const launchFor = (port: number): HostedBlenderMcpLaunch => ({
    command,
    blenderPath: "/usr/bin/blender",
    hostedPort: port,
    masterPort: port + 1,
    tmpDir: dir,
  });
  const startSession = (threadId: ThreadId, providerSessionId: string, port: number) =>
    sessions.set({
      environmentId,
      threadId,
      providerSessionId,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1:1/mcp",
      authorizationHeader: "Bearer unused",
      browserToolsAvailable: false,
      hostedBlender: launchFor(port),
    });

  let nextId = 1;
  const send = (
    caller: HostedBlenderMcpProxy.BlenderMcpCaller,
    role: HostedBlenderAgents.HostedBlenderRole,
    message: Record<string, unknown>,
    protocolVersion = "2025-06-18",
  ) => proxy.handle({ caller, role, protocolVersion, message: { jsonrpc: "2.0", ...message } });
  /** Every message the request is answered with, in order. */
  const ask = Effect.fnUntraced(function* (
    caller: HostedBlenderMcpProxy.BlenderMcpCaller,
    role: HostedBlenderAgents.HostedBlenderRole,
    message: Record<string, unknown>,
    protocolVersion?: string,
  ) {
    const reply = yield* send(caller, role, { id: nextId++, ...message }, protocolVersion);
    if (reply._tag === "Accepted") return [];
    if (reply._tag === "Message") return [decode(reply.message)];
    return Array.from(yield* Stream.runCollect(reply.messages), decode);
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
    id: string | number,
  ) {
    const reply = yield* send(caller, "working", {
      id,
      method: "tools/call",
      params: { name: "wait", arguments: {}, _meta: { progressToken: `wait-${id}` } },
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
  const children = () => spawned.filter((entry) => entry.env.BLENDER_MCP_PORT !== undefined);

  return {
    proxy,
    ends,
    allowed,
    spawned,
    children,
    layerScope,
    startSession,
    send,
    ask,
    callTool,
    startWait,
    logLines,
    starts,
  };
});

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("HostedBlenderMcpProxy", () => {
  it.live("answers initialize and the lists from the official server's own answers, once", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(threadA, "session-a", 41000);
        yield* t.startSession(threadB, "session-b", 42000);
        const a = { threadId: threadA, providerSessionId: "session-a" };
        const b = { threadId: threadB, providerSessionId: "session-b" };
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
        // One capture for the protocol both sessions speak, and no server for either session.
        assert.strictEqual(t.spawned.length, 1);
        assert.deepStrictEqual(t.children(), []);
        // Another protocol version is the official server's own answer for that version.
        const [newer] = yield* t.ask(a, "working", {
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x" } },
        });
        assert.strictEqual(newer?.result.protocolVersion, "2025-11-25");
        assert.strictEqual(t.spawned.length, 2);
        // A list the server does not advertise is the server's own answer too.
        assert.deepStrictEqual(t.children(), []);
      }),
    ),
  );

  it.live("starts one server per session and role on the first call, on that role's port", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(threadA, "session-a", 41000);
        yield* t.startSession(threadB, "session-b", 42000);
        const a = { threadId: threadA, providerSessionId: "session-a" };
        const b = { threadId: threadB, providerSessionId: "session-b" };
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
        assert.match(starts[0]!, /port=41000 blender=\/usr\/bin\/blender tmp=\S+ t3=none$/);
        assert.match(starts[1]!, /port=41001 /);
        assert.match(starts[2]!, /port=42000 /);
      }),
    ),
  );

  it.live(
    "routes by the credential's session alone, never by a thread or port the caller names",
    () =>
      run(
        Effect.gen(function* () {
          const t = yield* setup();
          yield* t.startSession(threadA, "session-a-2", 41000);
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
          const a = { threadId: threadA, providerSessionId: "session-a-2" };
          yield* t.callTool(a, "working", "echo", {
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

  it.live("passes results with images, progress, errors and refused server requests through", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(threadA, "session-a", 41000);
        const a = { threadId: threadA, providerSessionId: "session-a" };
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
        assert.deepStrictEqual(invalid?.error, { code: -32602, message: "Unknown tool: invalid" });
        const [asked] = yield* t.callTool(a, "working", "ask");
        assert.strictEqual(asked?.result.content[0].text, "refused -32601");
        // The client's own id comes back, whatever id the server used.
        const reply = yield* t.send(a, "working", {
          id: "client-string-id",
          method: "tools/call",
          params: { name: "echo", arguments: {} },
        });
        assert.strictEqual(reply._tag, "Stream");
        if (reply._tag === "Stream") {
          const [message] = Array.from(yield* Stream.runCollect(reply.messages), decode);
          assert.strictEqual(message?.id, "client-string-id");
        }
      }),
    ),
  );

  it.live("passes a client's cancel on, and cancels a call the client stopped reading", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(threadA, "session-a", 41000);
        const a = { threadId: threadA, providerSessionId: "session-a" };
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

  it.live("stops the server and fails calls in flight however that role's access ends", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(threadA, "session-a", 41000);
        const a = { threadId: threadA, providerSessionId: "session-a" };
        const ends: ReadonlyArray<
          readonly [HostedBlenderAgents.HostedBlenderRouteEnd | null, string]
        > = [
          [
            { threadId: threadA, role: "working" },
            "Your access to this thread's hosted Blender ended",
          ],
          [{ threadId: threadA, session: "session-a" }, "This agent session ended"],
          [{ threadId: threadA }, "This agent session ended"],
          [null, "Your access to this thread's hosted Blender ended"],
        ];
        for (const [ended, reason] of ends) {
          yield* t.callTool(a, "working", "echo");
          const child = t.children().at(-1)!;
          const inFlight = yield* t.startWait(a, `wait-${t.children().length}`);
          yield* PubSub.publish(t.ends, ended);
          const [failed] = Array.from(yield* inFlight.rest);
          assert.include(failed?.error.message, reason);
          yield* child.exitCode;
        }
        // Each ending stopped its server; each next call started a fresh one.
        assert.strictEqual(t.children().length, 4);
        // Another thread's, role's or session's ending leaves the server alone.
        yield* t.callTool(a, "working", "echo");
        for (const ended of [
          { threadId: threadB },
          { threadId: threadA, role: "master" as const },
          { threadId: threadA, session: "session-older" },
        ]) {
          yield* PubSub.publish(t.ends, ended);
        }
        yield* t.callTool(a, "working", "echo");
        assert.strictEqual(t.children().length, 5);
      }),
    ),
  );

  it.live("restarts a crashed server on the next call", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(threadA, "session-a", 41000);
        const a = { threadId: threadA, providerSessionId: "session-a" };
        const [crashed] = yield* t.callTool(a, "working", "crash");
        assert.include(crashed?.error.message, "stopped unexpectedly (exit code 3)");
        const [answered] = yield* t.callTool(a, "working", "echo");
        assert.strictEqual(answered?.result.content[0].text, '{"from":"session-a"}');
        assert.strictEqual(t.children().length, 2);
      }),
    ),
  );

  it.live("refuses calls while agents are switched off, starting nothing", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(threadA, "session-a", 41000);
        t.allowed.value = false;
        const [refused] = yield* t.callTool(
          { threadId: threadA, providerSessionId: "session-a" },
          "working",
          "echo",
        );
        assert.include(refused?.error.message, "Allow agents to start hosted Blenders");
        assert.deepStrictEqual(t.children(), []);
      }),
    ),
  );

  it.live("stops every server when T3 stops", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(threadA, "session-a", 41000);
        const a = { threadId: threadA, providerSessionId: "session-a" };
        yield* t.callTool(a, "working", "echo");
        yield* t.callTool(a, "master", "echo");
        yield* Scope.close(t.layerScope, Exit.void);
        for (const child of t.children()) yield* child.exitCode;
        assert.strictEqual(t.children().length, 2);
      }),
    ),
  );

  it.effect("stops a server nobody has called for the idle period", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.startSession(threadA, "session-a", 41000);
        const a = { threadId: threadA, providerSessionId: "session-a" };
        yield* t.callTool(a, "working", "echo");
        yield* TestClock.adjust("9 minutes");
        yield* t.callTool(a, "working", "echo");
        yield* TestClock.adjust("9 minutes");
        assert.strictEqual(t.children().length, 1);
        yield* TestClock.adjust("1 minute");
        yield* t.children()[0]!.exitCode;
        yield* t.callTool(a, "working", "echo");
        assert.strictEqual(t.children().length, 2);
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
          yield* t.startSession(threadA, "session-a", 1);
          const a = { threadId: threadA, providerSessionId: "session-a" };
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
          const direct = yield* officialAnswers(official, t.spawned[0]!.env);
          for (const [method, line] of direct) {
            // The official line with the request id the proxy answered, byte for byte.
            assert.strictEqual(
              proxied.get(method),
              line.replace(/^\{"jsonrpc":"2.0","id":\d+,/, '{"jsonrpc":"2.0","id":1,'),
            );
          }
          assert.deepStrictEqual(t.children(), []);
        }),
      ),
  );
});

/** The official server's raw answers over its own stdio, as Claude or Codex would read them. */
const officialAnswers = Effect.fnUntraced(function* (
  command: string,
  env: Readonly<Record<string, unknown>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { ChildProcess } = yield* Effect.promise(() => import("effect/process"));
  const handle = yield* spawner.spawn(
    ChildProcess.make(command, [], {
      env: env as Record<string, string>,
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
