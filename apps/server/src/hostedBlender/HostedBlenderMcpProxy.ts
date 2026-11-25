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
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { ChildProcessSpawner } from "effect/process";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { BLENDER_MCP_READ_ONLY_TOOLS } from "../provider/hostedBlenderMcp.ts";
import { masterAccessHelp } from "./agentMaster.ts";
import { workingAccessHelp } from "./agentWorkingCopy.ts";
import {
  type BlenderMcpAnswer,
  type BlenderMcpConnection,
  blenderMcpBuild,
  capturedAnswersFor,
  encodeJson,
  initializeParams,
  LIST_METHODS,
  openBlenderMcp,
  roleEnvironment,
  sameBuild,
  START_TIMEOUT,
} from "./blenderMcpStdio.ts";
import * as HostedBlender from "./HostedBlender.ts";
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
 * server's own answers, read by setup; a tool call goes to one `blender-mcp` per session, role
 * and grant, started only while that grant is live and stopped when it, or the session, ends.
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
// Past any client's own tool timeout (Codex 5 minutes, T3's longest tool an hour), so only a
// server that has stopped answering reaches it.
const CALL_TIMEOUT = Duration.minutes(65);
// The protocol a client that sends no version header speaks.
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const READ_ONLY: ReadonlySet<string> = new Set(BLENDER_MCP_READ_ONLY_TOOLS);

const errorMessage = (id: JsonRpcId | null, message: string, code = -32603) =>
  encodeJson({ jsonrpc: "2.0", id, error: { code, message } });

const isJsonRpcId = (value: unknown): value is JsonRpcId =>
  typeof value === "string" || typeof value === "number";

const progressTokenOf = (params: unknown): unknown =>
  Predicate.isReadonlyObject(params) && Predicate.isReadonlyObject(params._meta)
    ? params._meta.progressToken
    : undefined;

/** The agent never learns the port: its only route is the server T3 runs for it. */
const withoutPort = (encoded: string, port: number) =>
  encoded.replace(
    new RegExp(
      `(?:localhost|127\\.0\\.0\\.1|\\[::1\\]|::1):${port}(?!\\d)|port ${port}(?!\\d)`,
      "g",
    ),
    "this thread's hosted Blender",
  );

interface Call {
  readonly clientId: JsonRpcId;
  readonly progressToken: unknown;
  readonly queue: Queue.Queue<string, Cause.Done>;
  /** Done once the call has its answer, a failure, or a cancel. */
  readonly done: Deferred.Deferred<void>;
}

interface Child {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly session: string;
  readonly role: HostedBlenderAgents.HostedBlenderRole;
  /** The grant it serves: a working Blender's launch, or this session's master relay. */
  readonly grant: string;
  readonly port: number;
  readonly scope: Scope.Closeable;
  readonly ready: Deferred.Deferred<BlenderMcpConnection, string>;
  connection: BlenderMcpConnection | undefined;
  readonly calls: Map<number, Call>;
  readonly byClientId: Map<string, number>;
  nextId: number;
  lastActive: number;
  /** Why it stopped, once it has. */
  stopped: string | null;
}

const clientIdKey = (id: JsonRpcId) => `${typeof id}:${id}`;

const ACCESS_ENDED =
  "Your access to this thread's hosted Blender ended, so T3 stopped its Blender Lab MCP server. Call blender_status to see why and how to get it back.";
const SESSION_ENDED = "This agent session ended, so T3 stopped its Blender Lab MCP server.";
const NOT_ANSWERING =
  "Blender Lab's MCP server for this thread stopped answering, so T3 stopped it. Call the tool again to start it again.";

const make = Effect.gen(function* () {
  const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
  const hostedBlender = yield* HostedBlender.HostedBlender;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const environment = yield* HostProcess.Environment;
  const path = yield* Path.Path;
  const processContext = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >();
  const serviceScope = yield* Effect.scope;
  // Every child's scope is in here; the finalizer below runs first, then this closes them all.
  const childScopes = yield* Scope.fork(serviceScope);
  // Children are registered and stopped one at a time, so an ending never misses one.
  const lock = yield* Semaphore.make(1);
  const children = new Map<string, Child>();

  const respond = (call: Call, message: string) => {
    Queue.offerUnsafe(call.queue, message);
    Queue.endUnsafe(call.queue);
  };

  const finish = (child: Child, id: number) => {
    const call = child.calls.get(id);
    if (call === undefined) return undefined;
    child.calls.delete(id);
    child.byClientId.delete(clientIdKey(call.clientId));
    Deferred.doneUnsafe(call.done, Effect.void);
    return call;
  };

  /** Ends a child: its calls fail with `reason`; its scope, the service's, stops the process. */
  const stop = (child: Child, reason: string) =>
    Effect.suspend(() => {
      if (child.stopped !== null) return Effect.void;
      child.stopped = reason;
      if (children.get(child.key) === child) children.delete(child.key);
      for (const id of child.calls.keys()) {
        const call = finish(child, id);
        if (call !== undefined) respond(call, errorMessage(call.clientId, reason));
      }
      return Deferred.fail(child.ready, reason).pipe(
        Effect.andThen(Scope.close(child.scope, Exit.void).pipe(Effect.forkIn(serviceScope))),
        Effect.asVoid,
      );
    });

  /** The session's credential is still the thread's current one, with Blender servers. */
  const currentLaunch = Effect.fnUntraced(function* (caller: BlenderMcpCaller) {
    const session = yield* mcpSessions.read(caller.threadId);
    return session?.providerSessionId === caller.providerSessionId
      ? session.hostedBlender
      : undefined;
  });

  /** Setup's capture of the official server, if it is still the build that runs. */
  const currentCapture = Effect.fnUntraced(function* (launch: HostedBlenderMcpLaunch) {
    const capture = yield* agents.blenderMcpCapture(launch.command);
    if (capture === null) {
      return yield* Effect.fail(
        "T3 Code has not read Blender Lab's MCP server's tools. Ask the user to press Check again in Settings → Blender.",
      );
    }
    const build = yield* blenderMcpBuild(launch.command).pipe(
      Effect.provideContext(processContext),
      Effect.option,
    );
    if (build._tag === "None" || !sameBuild(build.value, capture.build)) {
      return yield* Effect.fail(
        "Blender Lab's MCP server changed since T3 Code checked it. Ask the user to press Check again in Settings → Blender.",
      );
    }
    return capture;
  });

  /** Why the session can't reach the role's Blender now, and what gets it there. */
  const noGrantReason = (
    role: HostedBlenderAgents.HostedBlenderRole,
    none: Extract<HostedBlender.AgentGrant, { _tag: "none" }>,
  ) => {
    const name = none.relativePath === null ? null : path.basename(none.relativePath);
    if (role === "master") {
      return name === null
        ? "This thread has no master Blender open for you. Call blender_master_open with the master's path, then call this tool again."
        : masterAccessHelp(name, none.listener);
    }
    if (name === null) {
      return "No hosted Blender is open for you in this thread. Call blender_start with the .blend file's path, then call this tool again.";
    }
    return none.listener?.state === "starting"
      ? `${name} is still starting. Call blender_start with the master's path, which waits until it's ready, then call this tool again.`
      : workingAccessHelp(name, none.listener);
  };

  /**
   * The live grant the caller may use now, checked against the current credential, the
   * switch and the installed build. Runs under the lock, so no ending is processed meanwhile.
   */
  const admit = Effect.fnUntraced(function* (
    caller: BlenderMcpCaller,
    role: HostedBlenderAgents.HostedBlenderRole,
  ) {
    const launch = yield* currentLaunch(caller);
    if (launch === undefined) {
      return yield* Effect.fail("Hosted Blender is not available to this agent session.");
    }
    if (!(yield* agents.agentsAllowed)) {
      return yield* Effect.fail(
        'The user switched off "Allow agents to start hosted Blenders" in Settings → Blender.',
      );
    }
    yield* currentCapture(launch);
    const grant = yield* hostedBlender.agentGrant({
      threadId: caller.threadId,
      role,
      session: caller.providerSessionId,
    });
    if (grant._tag === "none") return yield* Effect.fail(noGrantReason(role, grant));
    return { launch, grant: grant.grant, port: grant.port };
  });

  const onChildMessage = (child: Child) =>
    Effect.fnUntraced(function* (message: JsonObject) {
      const isResponse = "result" in message || "error" in message;
      if (isResponse && typeof message.id === "number") {
        const call = finish(child, message.id);
        if (call === undefined) return;
        child.lastActive = yield* Clock.currentTimeMillis;
        respond(call, withoutPort(encodeJson({ ...message, id: call.clientId }), child.port));
        return;
      }
      if (typeof message.method !== "string") return;
      // T3 answers no requests for the agent's client, so none are passed on.
      if (isJsonRpcId(message.id)) {
        if (child.connection === undefined) return;
        yield* child.connection
          .send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          })
          .pipe(Effect.catch(() => stop(child, NOT_ANSWERING)));
        return;
      }
      if (message.method !== "notifications/progress") return;
      const token = Predicate.isReadonlyObject(message.params)
        ? message.params.progressToken
        : undefined;
      for (const call of child.calls.values()) {
        if (call.progressToken !== undefined && call.progressToken === token) {
          Queue.offerUnsafe(call.queue, withoutPort(encodeJson(message), child.port));
        }
      }
    });

  /** Starts a session's server for a grant; its scope belongs to the service until it closes. */
  const startChild = Effect.fnUntraced(function* (input: {
    readonly caller: BlenderMcpCaller;
    readonly role: HostedBlenderAgents.HostedBlenderRole;
    readonly launch: HostedBlenderMcpLaunch;
    readonly grant: string;
    readonly port: number;
    readonly protocolVersion: string;
  }) {
    const child: Child = {
      key: `${input.caller.providerSessionId}\0${input.role}`,
      threadId: input.caller.threadId,
      session: input.caller.providerSessionId,
      role: input.role,
      grant: input.grant,
      port: input.port,
      scope: Scope.forkUnsafe(childScopes),
      ready: Deferred.makeUnsafe<BlenderMcpConnection, string>(),
      connection: undefined,
      calls: new Map(),
      byClientId: new Map(),
      nextId: 1,
      lastActive: yield* Clock.currentTimeMillis,
      stopped: null,
    };
    children.set(child.key, child);
    const start = Effect.gen(function* () {
      const initialized = yield* Deferred.make<BlenderMcpAnswer>();
      const open = yield* openBlenderMcp({
        command: input.launch.command,
        env: roleEnvironment(environment, {
          port: input.port,
          blenderPath: input.launch.blenderPath,
          tmpDir: input.launch.tmpDir,
        }),
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
      }).pipe(Effect.provideContext(processContext));
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
            `T3 could not start Blender Lab's MCP server (${input.launch.command}): ${typeof reason === "string" ? reason : "it stopped answering"}.`,
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

  /** The child for the caller's grant, started now if needed; a stale grant's child is stopped. */
  const childFor = (input: {
    readonly caller: BlenderMcpCaller;
    readonly role: HostedBlenderAgents.HostedBlenderRole;
    readonly protocolVersion: string;
  }) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const admitted = yield* admit(input.caller, input.role);
        const known = children.get(`${input.caller.providerSessionId}\0${input.role}`);
        if (known !== undefined && known.grant === admitted.grant) return known;
        if (known !== undefined) yield* stop(known, ACCESS_ENDED);
        return yield* startChild({ ...input, ...admitted });
      }),
    );

  const cancel = (child: Child, childId: number, params?: JsonObject) =>
    child.connection === undefined
      ? Effect.void
      : child.connection
          .send({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { ...params, requestId: childId },
          })
          .pipe(Effect.catch(() => stop(child, NOT_ANSWERING)));

  /**
   * The call's messages. It is written only once the client reads them, and only if the grant
   * is still the session's then; a client that stops reading has given up, so the server is
   * told to cancel.
   */
  const forward = (child: Child, caller: BlenderMcpCaller, message: JsonObject, id: JsonRpcId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (child.stopped !== null) return Stream.make(errorMessage(id, child.stopped));
        const childId = child.nextId++;
        const queue = yield* Queue.unbounded<string, Cause.Done>();
        const call: Call = {
          clientId: id,
          progressToken: progressTokenOf(message.params),
          queue,
          done: Deferred.makeUnsafe<void>(),
        };
        child.calls.set(childId, call);
        child.byClientId.set(clientIdKey(id), childId);
        child.lastActive = yield* Clock.currentTimeMillis;
        yield* Effect.addFinalizer(() =>
          finish(child, childId) === undefined ? Effect.void : cancel(child, childId),
        );
        const write = Effect.gen(function* () {
          const connection = yield* Deferred.await(child.ready);
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (child.calls.get(childId) !== call) return;
              const admitted = yield* admit(caller, child.role).pipe(Effect.result);
              if (admitted._tag === "Failure" || admitted.success.grant !== child.grant) {
                if (finish(child, childId) !== undefined) {
                  respond(
                    call,
                    errorMessage(id, admitted._tag === "Failure" ? admitted.failure : ACCESS_ENDED),
                  );
                }
                if (admitted._tag === "Success") yield* stop(child, ACCESS_ENDED);
                return;
              }
              yield* connection
                .send({ ...message, id: childId })
                .pipe(Effect.catch(() => stop(child, NOT_ANSWERING)));
            }),
          );
          const answered = yield* Deferred.await(call.done).pipe(
            Effect.timeoutOption(CALL_TIMEOUT),
          );
          if (answered._tag === "None") yield* stop(child, NOT_ANSWERING);
        });
        yield* write.pipe(
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

  const answerFromCapture = Effect.fnUntraced(function* (
    launch: HostedBlenderMcpLaunch,
    method: string,
    version: string,
    id: JsonRpcId,
  ) {
    const capture = yield* currentCapture(launch).pipe(Effect.result);
    if (capture._tag === "Failure") return errorMessage(id, capture.failure);
    const answer = capturedAnswersFor(capture.success, version)?.[method];
    // Not advertised: the official server answers it as unknown.
    return answer === undefined
      ? errorMessage(id, "Method not found", -32601)
      : encodeJson({ jsonrpc: "2.0", id, ...answer });
  });

  const allowedByMode = Effect.fnUntraced(function* (threadId: ThreadId, tool: unknown) {
    if (typeof tool === "string" && READ_ONLY.has(tool)) return true;
    // A mode that can't be read counts as Plan: refusing is the safe answer.
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    return shell !== null && shell.interactionMode !== "plan";
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
    // The credential picks the session; the Blender it reaches comes only from T3's records.
    const launch = yield* currentLaunch(caller);
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
    if (method === "initialize" || LIST_METHODS.some(([listed]) => listed === method)) {
      return {
        _tag: "Message",
        message: yield* answerFromCapture(launch, method, version, id),
      } as const;
    }
    // Only tool calls reach Blender; the official server offers no prompts or resources.
    if (method !== "tools/call") {
      return { _tag: "Message", message: errorMessage(id, "Method not found", -32601) } as const;
    }
    const tool = Predicate.isReadonlyObject(message.params) ? message.params.name : undefined;
    if (!(yield* allowedByMode(caller.threadId, tool))) {
      return {
        _tag: "Message",
        message: errorMessage(
          id,
          `${String(tool)} can change the file, and Plan mode is read-only. Scene summaries, screenshots and doc search still work; ask the user to leave Plan mode first.`,
        ),
      } as const;
    }
    const child = yield* childFor({ caller, role, protocolVersion: version }).pipe(Effect.result);
    if (child._tag === "Failure") {
      return { _tag: "Message", message: errorMessage(id, child.failure) } as const;
    }
    return { _tag: "Stream", messages: forward(child.success, caller, message, id) } as const;
  });

  const routeEnds = yield* agents.routeEnds;
  yield* routeEnds.pipe(
    Stream.runForEach((ended) =>
      lock.withPermits(1)(
        Effect.forEach(
          [...children.values()].filter(
            (child) =>
              ended === null ||
              (child.threadId === ended.threadId &&
                (ended.session === undefined || ended.session === child.session) &&
                (ended.role === undefined || ended.role === child.role) &&
                (ended.grant === undefined || ended.grant === child.grant)),
          ),
          (child) =>
            stop(child, ended !== null && ended.role === undefined ? SESSION_ENDED : ACCESS_ENDED),
          { discard: true },
        ),
      ),
    ),
    Effect.forkScoped,
  );
  // Tells callers why before `childScopes` closes and stops every process.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const child of children.values()) {
        child.stopped = "T3 is stopping.";
        for (const id of child.calls.keys()) {
          const call = finish(child, id);
          if (call !== undefined) respond(call, errorMessage(call.clientId, "T3 is stopping."));
        }
      }
      children.clear();
    }),
  );

  return HostedBlenderMcpProxy.of({ handle });
});

export const layer = Layer.effect(HostedBlenderMcpProxy, make);
