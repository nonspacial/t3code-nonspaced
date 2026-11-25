import type { ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { HostedBlenderMcpLaunch } from "@t3tools/provider-core/server/mcpSession";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { helperEnvironment } from "./BlenderLaunch.ts";
import * as HostedBlenderAgents from "./HostedBlenderAgents.ts";

type JsonRpcId = string | number;
type JsonObject = Readonly<Record<string, unknown>>;

/** The agent's thread and provider session, as the MCP credential it presented says. */
export interface BlenderMcpCaller {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
}

/** What answers one MCP message: nothing (202), one JSON-RPC message, or a call's messages. */
export type BlenderMcpReply =
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "Message"; readonly message: string }
  | { readonly _tag: "Stream"; readonly messages: Stream.Stream<string> };

/**
 * A thread's `blender-hosted` and `blender-master`. `initialize` and the lists are the official
 * `blender-mcp`'s own answers, captured per command and protocol version; anything else goes to
 * one `blender-mcp` per session and role, started on its first call and stopped when that role's
 * access or the session ends, after `IDLE_TIMEOUT`, or when T3 stops.
 */
export class HostedBlenderMcpProxy extends Context.Service<
  HostedBlenderMcpProxy,
  {
    readonly handle: (input: {
      readonly caller: BlenderMcpCaller;
      readonly role: HostedBlenderAgents.HostedBlenderRole;
      /** The `MCP-Protocol-Version` header, sent on every request after `initialize`. */
      readonly protocolVersion: string | undefined;
      readonly message: unknown;
    }) => Effect.Effect<BlenderMcpReply>;
  }
>()("t3/hostedBlender/HostedBlenderMcpProxy") {}

const IDLE_TIMEOUT = Duration.minutes(10);
// Long enough for a cold Python start that imports Blender Lab's docs search.
const START_TIMEOUT = Duration.seconds(30);
// The protocol a client that sends no version header speaks.
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
// Answered without Blender, so a session that never calls a tool starts no server.
const LIST_METHODS: ReadonlyArray<readonly [method: string, capability: string]> = [
  ["tools/list", "tools"],
  ["prompts/list", "prompts"],
  ["resources/list", "resources"],
  ["resources/templates/list", "resources"],
];

const INTERNAL_ERROR = -32603;

// Every value written comes from parsed JSON or T3's own literals, so encoding can't fail.
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const isJsonRpcId = (value: unknown): value is JsonRpcId =>
  typeof value === "string" || typeof value === "number";

const errorMessage = (id: JsonRpcId | null, message: string, code = INTERNAL_ERROR) =>
  encodeJson({ jsonrpc: "2.0", id, error: { code, message } });

const progressTokenOf = (params: unknown): unknown =>
  Predicate.isReadonlyObject(params) && Predicate.isReadonlyObject(params._meta)
    ? params._meta.progressToken
    : undefined;

interface Answer {
  readonly result?: unknown;
  readonly error?: unknown;
}

/** One `blender-mcp` over stdio: newline-delimited JSON-RPC both ways. */
interface Connection {
  readonly send: (message: JsonObject) => Effect.Effect<void>;
}

interface Call {
  readonly clientId: JsonRpcId;
  readonly progressToken: unknown;
  readonly queue: Queue.Queue<string, Cause.Done>;
}

interface Child {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly session: string;
  readonly role: HostedBlenderAgents.HostedBlenderRole;
  readonly scope: Scope.Closeable;
  readonly ready: Deferred.Deferred<Connection, string>;
  /** Set once the server has answered `initialize`. */
  connection: Connection | undefined;
  readonly calls: Map<number, Call>;
  readonly byClientId: Map<string, number>;
  nextId: number;
  lastActive: number;
  /** Why it stopped, once it has. */
  stopped: string | null;
}

const clientIdKey = (id: JsonRpcId) => `${typeof id}:${id}`;

const make = Effect.gen(function* () {
  const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* HostProcess.Environment;
  const serviceScope = yield* Effect.scope;

  const captures = new Map<string, Deferred.Deferred<ReadonlyMap<string, Answer>, string>>();
  const children = new Map<string, Child>();

  /**
   * Starts `blender-mcp` in `scope` and hands every message it writes to `onMessage`. `onExit`
   * runs once if it exits on its own.
   */
  const spawn = Effect.fnUntraced(function* (input: {
    readonly launch: HostedBlenderMcpLaunch;
    readonly port: number | null;
    readonly scope: Scope.Scope;
    readonly onMessage: (message: JsonObject) => Effect.Effect<void>;
    readonly onExit: (exitCode: number | null) => Effect.Effect<void>;
  }) {
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(input.launch.command, [], {
          env: {
            ...helperEnvironment(environment),
            ...(input.port === null ? {} : { BLENDER_MCP_PORT: String(input.port) }),
            BLENDER_PATH: input.launch.blenderPath,
            TMPDIR: input.launch.tmpDir,
          },
          extendEnv: false,
          stdin: { stream: "pipe", endOnDone: false },
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: Duration.seconds(2),
        }),
      )
      .pipe(Scope.provide(input.scope));
    // Its log goes to stderr; unread, the pipe would fill and stop it.
    yield* Stream.runDrain(handle.stderr).pipe(Effect.ignore, Effect.forkIn(input.scope));
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        const parsed = decodeJson(line);
        return parsed._tag === "Some" && Predicate.isReadonlyObject(parsed.value)
          ? input.onMessage(parsed.value)
          : Effect.void;
      }),
      Effect.ignore,
      Effect.andThen(handle.exitCode.pipe(Effect.option)),
      Effect.flatMap((code) => input.onExit(code._tag === "Some" ? Number(code.value) : null)),
      Effect.forkIn(input.scope),
    );
    const encoder = new TextEncoder();
    return {
      send: (message) =>
        Stream.run(Stream.make(encoder.encode(`${encodeJson(message)}\n`)), handle.stdin).pipe(
          Effect.ignore,
        ),
    } satisfies Connection;
  });

  const initializeParams = (protocolVersion: string) => ({
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "t3-code", version: "1" },
  });

  /** The official server's answers to `initialize` and its lists, for one protocol version. */
  const capture = (launch: HostedBlenderMcpLaunch, protocolVersion: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const answers = new Map<string, Answer>();
        const waiting = new Map<number, Deferred.Deferred<Answer>>();
        const exited = yield* Deferred.make<void>();
        const connection = yield* spawn({
          launch,
          port: null,
          scope,
          onMessage: (message) => {
            const waiter = isJsonRpcId(message.id) ? waiting.get(Number(message.id)) : undefined;
            return waiter === undefined
              ? Effect.void
              : Deferred.succeed(waiter, { result: message.result, error: message.error });
          },
          onExit: () => Deferred.succeed(exited, undefined),
        });
        let nextId = 0;
        const ask = Effect.fnUntraced(function* (method: string, params?: JsonObject) {
          const id = nextId++;
          const answer = yield* Deferred.make<Answer>();
          waiting.set(id, answer);
          yield* connection.send({
            jsonrpc: "2.0",
            id,
            method,
            ...(params === undefined ? {} : { params }),
          });
          const settled = yield* Deferred.await(answer).pipe(
            Effect.raceFirst(Deferred.await(exited).pipe(Effect.as(undefined))),
          );
          if (settled === undefined) return yield* Effect.fail("it exited while answering");
          return settled;
        });
        const initialized = yield* ask("initialize", initializeParams(protocolVersion));
        answers.set("initialize", initialized);
        if (initialized.error !== undefined) return answers;
        yield* connection.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        const capabilities = Predicate.isReadonlyObject(initialized.result)
          ? initialized.result.capabilities
          : undefined;
        for (const [method, capability] of LIST_METHODS) {
          if (Predicate.isReadonlyObject(capabilities) && capability in capabilities) {
            answers.set(method, yield* ask(method));
          }
        }
        return answers as ReadonlyMap<string, Answer>;
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: START_TIMEOUT,
        orElse: () => Effect.fail("it did not answer in time"),
      }),
      Effect.mapError((reason) => (typeof reason === "string" ? reason : "it could not start")),
    );

  const capturedAnswers = Effect.fnUntraced(function* (
    launch: HostedBlenderMcpLaunch,
    protocolVersion: string,
  ) {
    // The real path names the installed version: uv and pipx install each into its own folder.
    const real = yield* fileSystem
      .realPath(launch.command)
      .pipe(Effect.orElseSucceed(() => launch.command));
    const key = `${launch.command}\0${real}\0${protocolVersion}`;
    const known = captures.get(key);
    if (known !== undefined) return yield* Deferred.await(known);
    // Recorded before anything yields, so concurrent requests share one capture.
    const pending = Deferred.makeUnsafe<ReadonlyMap<string, Answer>, string>();
    captures.set(key, pending);
    const exit = yield* Effect.exit(capture(launch, protocolVersion));
    // A failed capture is tried again by the next request.
    if (Exit.isFailure(exit)) captures.delete(key);
    yield* Deferred.done(pending, exit);
    return yield* exit;
  });

  const respond = (call: Call, message: string) => {
    Queue.offerUnsafe(call.queue, message);
    Queue.endUnsafe(call.queue);
  };

  const finish = (child: Child, id: number) => {
    const call = child.calls.get(id);
    if (call === undefined) return undefined;
    child.calls.delete(id);
    child.byClientId.delete(clientIdKey(call.clientId));
    return call;
  };

  const failCalls = (child: Child, reason: string) => {
    for (const id of child.calls.keys()) {
      const call = finish(child, id);
      if (call !== undefined) respond(call, errorMessage(call.clientId, reason));
    }
  };

  /**
   * Ends a child: its calls fail with `reason`, and the process is stopped, in the background
   * unless T3 is stopping.
   */
  const stop = (child: Child, reason: string, options?: { readonly wait: boolean }) =>
    Effect.suspend(() => {
      if (child.stopped !== null) return Effect.void;
      child.stopped = reason;
      if (children.get(child.key) === child) children.delete(child.key);
      failCalls(child, reason);
      const close = Scope.close(child.scope, Exit.void);
      return Deferred.fail(child.ready, reason).pipe(
        Effect.andThen(options?.wait === true ? close : close.pipe(Effect.forkIn(serviceScope))),
        Effect.asVoid,
      );
    });

  const onChildMessage = (child: Child) =>
    Effect.fnUntraced(function* (message: JsonObject) {
      const isResponse = "result" in message || "error" in message;
      if (isResponse && typeof message.id === "number") {
        const call = finish(child, message.id);
        if (call === undefined) return;
        child.lastActive = yield* Clock.currentTimeMillis;
        respond(call, encodeJson({ ...message, id: call.clientId }));
        return;
      }
      if (typeof message.method !== "string") return;
      // T3 answers no requests for the agent's client, so none are passed on.
      if (isJsonRpcId(message.id)) {
        if (child.connection !== undefined) {
          yield* child.connection.send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          });
        }
        return;
      }
      if (message.method !== "notifications/progress") return;
      const token = Predicate.isReadonlyObject(message.params)
        ? message.params.progressToken
        : undefined;
      for (const call of child.calls.values()) {
        if (call.progressToken !== undefined && call.progressToken === token) {
          Queue.offerUnsafe(call.queue, encodeJson(message));
        }
      }
    });

  /** The session's server for the role, started now unless it is running. */
  const childFor = Effect.fnUntraced(function* (input: {
    readonly caller: BlenderMcpCaller;
    readonly role: HostedBlenderAgents.HostedBlenderRole;
    readonly launch: HostedBlenderMcpLaunch;
    readonly protocolVersion: string;
  }) {
    const key = `${input.caller.providerSessionId}\0${input.role}`;
    const now = yield* Clock.currentTimeMillis;
    const known = children.get(key);
    if (known !== undefined) return known;
    // Recorded before anything yields, so concurrent first calls share one server.
    const child: Child = {
      key,
      threadId: input.caller.threadId,
      session: input.caller.providerSessionId,
      role: input.role,
      scope: Scope.makeUnsafe(),
      ready: Deferred.makeUnsafe<Connection, string>(),
      connection: undefined,
      calls: new Map(),
      byClientId: new Map(),
      nextId: 1,
      lastActive: now,
      stopped: null,
    };
    children.set(key, child);
    const start = Effect.gen(function* () {
      const initialized = yield* Deferred.make<Answer>();
      const open = yield* spawn({
        launch: input.launch,
        port: input.role === "working" ? input.launch.hostedPort : input.launch.masterPort,
        scope: child.scope,
        onMessage: (message) =>
          message.id === 0 && ("result" in message || "error" in message)
            ? Deferred.succeed(initialized, { result: message.result, error: message.error })
            : onChildMessage(child)(message),
        onExit: (exitCode) =>
          stop(
            child,
            `Blender Lab's MCP server for this thread stopped unexpectedly${exitCode === null ? "" : ` (exit code ${exitCode})`}. Call the tool again to start it again.`,
          ),
      });
      yield* open.send({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: initializeParams(input.protocolVersion),
      });
      const answer = yield* Deferred.await(initialized).pipe(
        Effect.timeoutOrElse({
          duration: START_TIMEOUT,
          orElse: () => Effect.fail("it did not answer in time"),
        }),
      );
      if (answer.error !== undefined) return yield* Effect.fail("it refused to initialize");
      yield* open.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      child.connection = open;
      return open;
    });
    yield* start.pipe(
      Effect.matchEffect({
        onFailure: (reason) =>
          stop(
            child,
            `T3 could not start Blender Lab's MCP server (${input.launch.command}): ${typeof reason === "string" ? reason : "it could not start"}.`,
          ),
        onSuccess: (open) => Deferred.succeed(child.ready, open),
      }),
      Effect.forkIn(child.scope),
    );
    // Stops a child nobody has called for a while; a call in flight keeps it.
    yield* Effect.gen(function* () {
      while (true) {
        const now = yield* Clock.currentTimeMillis;
        const due = child.lastActive + Duration.toMillis(IDLE_TIMEOUT) - now;
        if (child.calls.size === 0 && due <= 0) return yield* stop(child, "idle");
        yield* Effect.sleep(Duration.millis(due > 0 ? due : Duration.toMillis(IDLE_TIMEOUT)));
      }
    }).pipe(Effect.forkIn(child.scope));
    return child;
  });

  /**
   * The call's messages. It is sent only once the client reads them, and a client that stops
   * reading before the answer has given up on it, so the server is told to cancel.
   */
  const forward = (child: Child, message: JsonObject, id: JsonRpcId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (child.stopped !== null) return Stream.make(errorMessage(id, child.stopped));
        const childId = child.nextId++;
        const queue = yield* Queue.unbounded<string, Cause.Done>();
        const call: Call = { clientId: id, progressToken: progressTokenOf(message.params), queue };
        child.calls.set(childId, call);
        child.byClientId.set(clientIdKey(id), childId);
        child.lastActive = yield* Clock.currentTimeMillis;
        yield* Effect.addFinalizer(() =>
          finish(child, childId) === undefined ? Effect.void : cancel(child, childId),
        );
        yield* Deferred.await(child.ready).pipe(
          Effect.flatMap((connection) =>
            child.calls.get(childId) === call
              ? connection.send({ ...message, id: childId })
              : Effect.void,
          ),
          Effect.catch((reason) =>
            Effect.sync(() => {
              if (finish(child, childId) !== undefined) respond(call, errorMessage(id, reason));
            }),
          ),
          Effect.forkIn(child.scope),
        );
        return Stream.fromQueue(queue);
      }),
    );

  const cancel = (child: Child, childId: number, params?: JsonObject) =>
    child.connection === undefined
      ? Effect.void
      : child.connection.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { ...params, requestId: childId },
        });

  const handle: HostedBlenderMcpProxy["Service"]["handle"] = Effect.fn(
    "HostedBlenderMcpProxy.handle",
  )(function* ({ caller, role, protocolVersion, message }) {
    if (!Predicate.isReadonlyObject(message) || Array.isArray(message)) {
      return { _tag: "Message", message: errorMessage(null, "Invalid Request", -32600) } as const;
    }
    const id = isJsonRpcId(message.id) ? message.id : undefined;
    const method = typeof message.method === "string" ? message.method : undefined;
    // Answers to requests T3 never sent, and notifications other than a cancel, need nothing.
    if (method === undefined) return { _tag: "Accepted" } as const;
    if (id === undefined) {
      if (method === "notifications/cancelled" && Predicate.isReadonlyObject(message.params)) {
        const child = children.get(`${caller.providerSessionId}\0${role}`);
        const requestId = message.params.requestId;
        const childId =
          child === undefined || !isJsonRpcId(requestId)
            ? undefined
            : child.byClientId.get(clientIdKey(requestId));
        if (child !== undefined && childId !== undefined) {
          const call = finish(child, childId);
          if (call !== undefined) Queue.endUnsafe(call.queue);
          yield* cancel(child, childId, message.params);
        }
      }
      return { _tag: "Accepted" } as const;
    }
    // The credential picks the session; the thread's ports come only from T3's record of it.
    const session = yield* mcpSessions.read(caller.threadId);
    const launch =
      session?.providerSessionId === caller.providerSessionId ? session.hostedBlender : undefined;
    if (launch === undefined) {
      return {
        _tag: "Message",
        message: errorMessage(id, "Hosted Blender is not available to this agent session."),
      } as const;
    }
    if (method === "ping") {
      return { _tag: "Message", message: encodeJson({ jsonrpc: "2.0", id, result: {} }) } as const;
    }
    const version =
      method === "initialize" &&
      Predicate.isReadonlyObject(message.params) &&
      typeof message.params.protocolVersion === "string"
        ? message.params.protocolVersion
        : (protocolVersion ?? DEFAULT_PROTOCOL_VERSION);
    const paged = Predicate.isReadonlyObject(message.params) && "cursor" in message.params;
    if (method === "initialize" || (!paged && LIST_METHODS.some(([listed]) => listed === method))) {
      const answers = yield* Effect.result(capturedAnswers(launch, version));
      if (answers._tag === "Failure") {
        return {
          _tag: "Message",
          message: errorMessage(
            id,
            `T3 could not start Blender Lab's MCP server (${launch.command}): ${answers.failure}.`,
          ),
        } as const;
      }
      const answer = answers.success.get(method);
      if (answer !== undefined) {
        return {
          _tag: "Message",
          message: encodeJson({ jsonrpc: "2.0", id, ...answer }),
        } as const;
      }
      // Not advertised, so the server itself answers, as it would have.
    }
    if (!(yield* agents.agentsAllowed)) {
      return {
        _tag: "Message",
        message: errorMessage(
          id,
          'The user switched off "Allow agents to start hosted Blenders" in Settings → Blender.',
        ),
      } as const;
    }
    const child = yield* childFor({ caller, role, launch, protocolVersion: version });
    return { _tag: "Stream", messages: forward(child, message, id) } as const;
  });

  const ACCESS_ENDED =
    "Your access to this thread's hosted Blender ended, so T3 stopped its Blender Lab MCP server. Call blender_status to see why and how to get it back.";
  const SESSION_ENDED = "This agent session ended, so T3 stopped its Blender Lab MCP server.";

  const routeEnds = yield* agents.routeEnds;
  yield* routeEnds.pipe(
    Stream.runForEach((ended) =>
      Effect.forEach(
        [...children.values()].filter(
          (child) =>
            ended === null ||
            (child.threadId === ended.threadId &&
              (ended.session === undefined || ended.session === child.session) &&
              (ended.role === undefined || ended.role === child.role)),
        ),
        (child) =>
          stop(child, ended !== null && ended.role === undefined ? SESSION_ENDED : ACCESS_ENDED),
        { discard: true },
      ),
    ),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...children.values()],
      (child) => stop(child, "T3 is stopping.", { wait: true }),
      { discard: true, concurrency: "unbounded" },
    ),
  );

  return HostedBlenderMcpProxy.of({ handle });
});

export const layer = Layer.effect(HostedBlenderMcpProxy, make);
