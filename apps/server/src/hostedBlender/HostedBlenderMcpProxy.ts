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
import * as Option from "effect/Option";
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
  type BlenderMcpBuild,
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
    /**
     * Why the session's Blender servers can't take calls now whatever its Blenders' listeners
     * say: setup has no current read of the official server. Null when they can.
     */
    readonly unavailable: (caller: BlenderMcpCaller) => Effect.Effect<string | null>;
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

// Blender Lab's own wording for a call whose Blender isn't listening, naming its address.
const CANNOT_CONNECT = /^Error executing tool \S+: Cannot connect to Blender at \S+:\d+\./;
const UNREACHABLE =
  "Blender Lab's MCP server could not reach this thread's hosted Blender: it isn't listening for you now. Call blender_status to see why and how to get it back.";

/** A failed call's connection diagnostic, told as what to do; everything else as it came. */
const withAgentDiagnostic = (message: JsonObject): JsonObject => {
  const result = message.result;
  if (!Predicate.isReadonlyObject(result) || result.isError !== true) return message;
  const original: unknown = result.content;
  if (!Array.isArray(original)) return message;
  const content = original.map((item: unknown) =>
    Predicate.isReadonlyObject(item) &&
    item.type === "text" &&
    typeof item.text === "string" &&
    CANNOT_CONNECT.test(item.text)
      ? { ...item, text: UNREACHABLE }
      : item,
  );
  return content.some((item, index) => item !== original[index])
    ? { ...message, result: { ...result, content } }
    : message;
};

/** Why a gate refused a call, and whether that also ends the server it was for. */
interface Refusal {
  readonly reason: string;
  readonly endsChild: boolean;
}

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
  /** The installed build setup had read when it was admitted. */
  readonly build: BlenderMcpBuild;
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

/** A tool call the client hasn't cancelled, from its arrival until its answer. */
interface Request {
  readonly key: string;
  cancelled: boolean;
}

const ACCESS_ENDED =
  "Your access to this thread's hosted Blender ended, so T3 stopped its Blender Lab MCP server. Call blender_status to see why and how to get it back.";
const SESSION_ENDED = "This agent session ended, so T3 stopped its Blender Lab MCP server.";
const AGENTS_OFF =
  'The user switched off "Allow agents to start hosted Blenders" in Settings → Blender, so T3 stopped its Blender Lab MCP server.';
const CAPTURE_MISSING =
  "T3 Code has not read Blender Lab's MCP server's tools. Ask the user to press Check again in Settings → Blender.";
const CAPTURE_STALE =
  "Blender Lab's MCP server changed since T3 Code checked it. Ask the user to press Check again in Settings → Blender.";
const BUILD_CHANGED =
  "Blender Lab's MCP server was reinstalled, so T3 stopped the one this session used. Call the tool again to use the new one.";
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
  // Each tool call from its arrival, so a cancel during its first admission still withdraws it.
  const requests = new Map<string, Request>();
  const requestKey = (caller: BlenderMcpCaller, role: string, id: JsonRpcId) =>
    `${caller.providerSessionId}\0${role}\0${clientIdKey(id)}`;
  const forget = (request: Request) => {
    if (requests.get(request.key) === request) requests.delete(request.key);
  };

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

  /** The build `launch` runs now, read from the disk; none when it can't be read. */
  const installedBuild = (launch: HostedBlenderMcpLaunch) =>
    blenderMcpBuild(launch.command).pipe(Effect.provideContext(processContext), Effect.option);

  /** Setup's capture, held in memory, if it describes `build`, the one installed now. */
  const captureFor = Effect.fnUntraced(function* (
    launch: HostedBlenderMcpLaunch,
    build: Option.Option<BlenderMcpBuild>,
  ) {
    const capture = yield* agents.blenderMcpCapture(launch.command);
    if (capture === null) return yield* Effect.fail(CAPTURE_MISSING);
    if (Option.isNone(build) || !sameBuild(build.value, capture.build)) {
      return yield* Effect.fail(CAPTURE_STALE);
    }
    return capture;
  });

  const currentCapture = (launch: HostedBlenderMcpLaunch) =>
    installedBuild(launch).pipe(Effect.flatMap((build) => captureFor(launch, build)));

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

  const refuse = (reason: string, endsChild = true) => Effect.fail<Refusal>({ reason, endsChild });

  /**
   * The gates that wait on the disk and the database, the installed build and the thread's mode,
   * read immediately before the lock is taken.
   */
  const prepare = Effect.fnUntraced(function* (caller: BlenderMcpCaller, tool: unknown) {
    const launch = yield* currentLaunch(caller);
    if (launch === undefined) {
      return yield* refuse("Hosted Blender is not available to this agent session.");
    }
    const build = yield* installedBuild(launch);
    if (!(yield* allowedByMode(caller.threadId, tool))) {
      return yield* refuse(
        `${String(tool)} can change the file, and Plan mode is read-only. Scene summaries, screenshots and doc search still work; ask the user to leave Plan mode first.`,
        false,
      );
    }
    return { launch, build };
  });

  /**
   * Every other gate, all held in memory: setup's capture of that build, the switch, the grant,
   * and last the credential. Run under the lock immediately before a call is written or a
   * server registered, so nothing admitted earlier is trusted.
   */
  const admit = Effect.fnUntraced(function* (
    caller: BlenderMcpCaller,
    role: HostedBlenderAgents.HostedBlenderRole,
    prepared: Effect.Success<ReturnType<typeof prepare>>,
  ) {
    const capture = yield* captureFor(prepared.launch, prepared.build).pipe(
      Effect.mapError((reason): Refusal => ({ reason, endsChild: true })),
    );
    if (!(yield* agents.agentsAllowed)) {
      return yield* refuse(
        'The user switched off "Allow agents to start hosted Blenders" in Settings → Blender.',
      );
    }
    const grant = yield* hostedBlender.agentGrant({
      threadId: caller.threadId,
      role,
      session: caller.providerSessionId,
    });
    if (grant._tag === "none") return yield* refuse(noGrantReason(role, grant));
    const launch = yield* currentLaunch(caller);
    if (launch === undefined) {
      return yield* refuse("Hosted Blender is not available to this agent session.");
    }
    return { launch, grant: grant.grant, port: grant.port, build: capture.build };
  });

  const onChildMessage = (child: Child) =>
    Effect.fnUntraced(function* (message: JsonObject) {
      const isResponse = "result" in message || "error" in message;
      if (isResponse && typeof message.id === "number") {
        const call = finish(child, message.id);
        if (call === undefined) return;
        child.lastActive = yield* Clock.currentTimeMillis;
        respond(call, encodeJson({ ...withAgentDiagnostic(message), id: call.clientId }));
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
          Queue.offerUnsafe(call.queue, encodeJson(message));
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
    readonly build: BlenderMcpBuild;
    readonly protocolVersion: string;
  }) {
    const child: Child = {
      key: `${input.caller.providerSessionId}\0${input.role}`,
      threadId: input.caller.threadId,
      session: input.caller.providerSessionId,
      role: input.role,
      grant: input.grant,
      build: input.build,
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

  /** The child serves the grant and build the gates admitted now. */
  const serves = (child: Child, admitted: Effect.Success<ReturnType<typeof admit>>) =>
    child.grant === admitted.grant && sameBuild(child.build, admitted.build);

  /**
   * The child for the caller's grant, started now if needed. A refusal that ends access, or a
   * new grant or build, stops the one the session had.
   */
  const childFor = Effect.fnUntraced(function* (input: {
    readonly caller: BlenderMcpCaller;
    readonly role: HostedBlenderAgents.HostedBlenderRole;
    readonly tool: unknown;
    readonly protocolVersion: string;
    readonly request: Request;
  }) {
    const key = `${input.caller.providerSessionId}\0${input.role}`;
    // Only the server this call saw before its slow reads: one started since is another's.
    const observed = children.get(key);
    const endsKnown = (refusal: Refusal) =>
      refusal.endsChild && observed !== undefined ? stop(observed, refusal.reason) : Effect.void;
    const build = yield* prepare(input.caller, input.tool).pipe(Effect.tapError(endsKnown));
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const admitted = yield* admit(input.caller, input.role, build).pipe(
          Effect.tapError(endsKnown),
        );
        const known = children.get(key);
        if (known !== undefined && serves(known, admitted)) return known;
        // Cancelled while it was admitted: no server is started for it.
        if (input.request.cancelled) return yield* refuse("cancelled", false);
        if (known !== undefined) {
          yield* stop(known, known.grant === admitted.grant ? BUILD_CHANGED : ACCESS_ENDED);
        }
        return yield* startChild({ ...input, ...admitted });
      }),
    );
  });

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
  const forward = (
    child: Child,
    caller: BlenderMcpCaller,
    message: JsonObject,
    id: JsonRpcId,
    tool: unknown,
    request: Request,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (request.cancelled) return Stream.empty;
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
          const pending = () =>
            !request.cancelled && child.stopped === null && child.calls.get(childId) === call;
          const refused = (reason: string) =>
            Effect.sync(() => {
              if (finish(child, childId) !== undefined) respond(call, errorMessage(id, reason));
            });
          const build = yield* prepare(caller, tool).pipe(Effect.result);
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (!pending()) return;
              const admitted = yield* (
                build._tag === "Failure"
                  ? Effect.fail(build.failure)
                  : admit(caller, child.role, build.success)
              ).pipe(Effect.result);
              if (admitted._tag === "Failure") {
                yield* refused(admitted.failure.reason);
                if (admitted.failure.endsChild) yield* stop(child, admitted.failure.reason);
                return;
              }
              if (!serves(child, admitted.success)) {
                const reason =
                  child.grant === admitted.success.grant ? BUILD_CHANGED : ACCESS_ENDED;
                yield* refused(reason);
                return yield* stop(child, reason);
              }
              // A cancel or disconnect while the gates were read has withdrawn the call.
              if (!pending()) return;
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
        const request = isJsonRpcId(requestId)
          ? requests.get(requestKey(caller, role, requestId))
          : undefined;
        if (request !== undefined) request.cancelled = true;
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
    // Registered on arrival and removed with the response, however it ends, disconnects included.
    const messages = Stream.unwrap(
      Effect.gen(function* () {
        const request: Request = { key: requestKey(caller, role, id), cancelled: false };
        requests.set(request.key, request);
        yield* Effect.addFinalizer(() => Effect.sync(() => forget(request)));
        const child = yield* childFor({
          caller,
          role,
          tool,
          protocolVersion: version,
          request,
        }).pipe(Effect.result);
        if (request.cancelled) return Stream.empty;
        if (child._tag === "Failure") return Stream.make(errorMessage(id, child.failure.reason));
        return forward(child.success, caller, message, id, tool, request);
      }),
    );
    return { _tag: "Stream", messages } as const;
  });

  const routeEnds = yield* agents.routeEnds;
  yield* routeEnds.pipe(
    Stream.runForEach((ended) =>
      // Read under the lock, so a child registered while this waited is among them.
      lock.withPermits(1)(
        Effect.suspend(() =>
          Effect.forEach(
            [...children.values()].filter((child) =>
              ended === null
                ? true
                : "staleBuild" in ended
                  ? // Only the servers on the build setup took back, not one already on its successor.
                    sameBuild(child.build, ended.staleBuild)
                  : child.threadId === ended.threadId &&
                    (ended.session === undefined || ended.session === child.session) &&
                    (ended.role === undefined || ended.role === child.role) &&
                    (ended.grant === undefined || ended.grant === child.grant),
            ),
            (child) =>
              stop(
                child,
                ended === null
                  ? AGENTS_OFF
                  : "staleBuild" in ended
                    ? BUILD_CHANGED
                    : ended.role === undefined
                      ? SESSION_ENDED
                      : ACCESS_ENDED,
              ),
            { discard: true },
          ),
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

  const unavailable: HostedBlenderMcpProxy["Service"]["unavailable"] = Effect.fn(
    "HostedBlenderMcpProxy.unavailable",
  )(function* (caller) {
    const launch = yield* currentLaunch(caller);
    if (launch === undefined) return "Hosted Blender is not available to this agent session.";
    return yield* currentCapture(launch).pipe(
      Effect.as(null),
      Effect.catch((reason) => Effect.succeed(reason)),
    );
  });

  return HostedBlenderMcpProxy.of({ handle, unavailable });
});

export const layer = Layer.effect(HostedBlenderMcpProxy, make);
