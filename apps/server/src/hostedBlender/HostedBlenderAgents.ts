import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import type { HostedBlenderMcpLaunch } from "@t3tools/provider-core/server/mcpSession";
import type { BlenderMcpCapture } from "./blenderMcpStdio.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NetService from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HostedBlenderSetup from "./HostedBlenderSetup.ts";

export class HostedBlenderPortError extends Schema.TaggedError<HostedBlenderPortError>()(
  "HostedBlenderPortError",
  {},
) {}

/**
 * One thread's agent losing its hosted Blenders: the provider session (MCP credential) that
 * ended, so a newer one keeps what it was granted since. No session ends the thread's access.
 */
export interface HostedBlenderRevocation {
  readonly threadId: ThreadId;
  readonly session: string | undefined;
}

/** A hosted Blender's role: the thread's own working one, or the master it copies back into. */
export type HostedBlenderRole = "working" | "master";

/**
 * A thread's agent losing a way to its hosted Blenders: one role's access ended (`role`), a
 * provider session ended (`session`), or every thread's when agents are switched off (null).
 */
export interface HostedBlenderRouteEnd {
  readonly threadId: ThreadId;
  readonly session?: string;
  readonly role?: HostedBlenderRole;
  /** With `role`: the grant that ended (a working Blender's launch, or a master relay). */
  readonly grant?: string;
}

/** The providers T3 adds the hosted Blender MCP to, the same two that get agentcast upstream. */
const SUPPORTED_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/**
 * What agents get from hosted Blenders: the per-thread official Blender MCP that a Claude or Codex
 * session starts with, and whether a hosted Blender that starts now listens for it.
 */
export class HostedBlenderAgents extends Context.Service<
  HostedBlenderAgents,
  {
    /**
     * At session start: the official MCP for a Claude or Codex thread, while Hosted Blender and
     * "Allow agents" are on and setup found Blender Lab's package. Assigns the thread's ports,
     * which stay its own for the server's life.
     */
    readonly sessionLaunch: (input: {
      readonly threadId: ThreadId;
      readonly driver: ProviderDriverKind;
    }) => Effect.Effect<HostedBlenderMcpLaunch | undefined>;
    /**
     * For the thread's hosted Blender starting now: a private port, its own, that the official
     * add-on listens on for the thread's agents, or null to keep it off. It listens only while the
     * thread's session holds the MCP and agents are allowed. T3's guard on the listener drops any
     * connection from another OS user's process (see `agentGuard.ts`).
     */
    readonly listenerPort: (threadId: ThreadId) => Effect.Effect<number | null>;
    /** The official server's own answers, as setup read them from `command`. */
    readonly blenderMcpCapture: (command: string) => Effect.Effect<BlenderMcpCapture | null>;
    /**
     * A loopback port for a master Blender's own listener, from the same registry as the threads'
     * ports, so no relay's port is ever also a listener's.
     */
    readonly reservePrivatePort: Effect.Effect<
      number,
      HostedBlenderPortError | NetService.NetError
    >;
    /** The provider session holding the thread's Blender MCP while agents are allowed, or null. */
    readonly currentSession: (threadId: ThreadId) => Effect.Effect<string | null>;
    /** The port the thread's `blender-master` entry dials, on the same terms as `listenerPort`. */
    readonly masterListenerPort: (threadId: ThreadId) => Effect.Effect<number | null>;
    /**
     * Threads whose agents lost access to their hosted Blender: the thread's session ended, or
     * null when "Allow agents" was switched off for every thread.
     */
    readonly revocations: Stream.Stream<HostedBlenderRevocation | null>;
    /** The thread's provider session ended and its MCP config is gone. */
    readonly sessionEnded: (threadId: ThreadId, session?: string) => Effect.Effect<void>;
    /** One grant of the thread's Blender in this role ended: a working launch's, or a relay's. */
    readonly agentAccessEnded: (
      threadId: ThreadId,
      role: HostedBlenderRole,
      grant: string,
    ) => Effect.Effect<void>;
    /**
     * Every way a thread's agent loses its hosted Blenders, from the moment of subscribing: each
     * revocation, and each role's access ending.
     */
    readonly routeEnds: Effect.Effect<
      Stream.Stream<HostedBlenderRouteEnd | null>,
      never,
      Scope.Scope
    >;
    /** "Allow agents to start hosted Blenders", read now. */
    readonly agentsAllowed: Effect.Effect<boolean>;
    /**
     * Keeps setup's readiness for `sessionLaunch`. Setup sits above provider sessions (its install
     * agent starts a thread), so it is followed here rather than depended on.
     */
    readonly followSetup: (
      readiness: Stream.Stream<HostedBlenderSetup.HostedBlenderReadiness>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/hostedBlender/HostedBlenderAgents") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const net = yield* NetService.NetService;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const ports = new Map<ThreadId, number>();
  // Every port handed out, so two threads or roles never share one.
  const assignedPorts = new Set<number>();
  const revoked = yield* PubSub.unbounded<HostedBlenderRevocation | null>();
  const routeEnded = yield* PubSub.unbounded<HostedBlenderRouteEnd | null>();
  let readiness: HostedBlenderSetup.HostedBlenderReadiness | null = null;
  const portLock = yield* Semaphore.make(1);
  const tmpDir = path.join(config.stateDir, "hosted-blender", "mcp-tmp");

  // Unreadable settings count as switched off.
  const agentsAllowed = settings.getSettings.pipe(
    Effect.map((value) => value.hostedBlenderEnabled && value.hostedBlenderAllowAgents),
    Effect.orElseSucceed(() => false),
  );

  const freshPort = net.reserveLoopbackPort().pipe(
    Effect.repeat({ until: (port) => !assignedPorts.has(port), times: 20 }),
    Effect.filterOrFail(
      (port) => !assignedPorts.has(port),
      () => new HostedBlenderPortError(),
    ),
    Effect.tap((port) => Effect.sync(() => assignedPorts.add(port))),
  );

  const portsFor = (threadId: ThreadId) =>
    portLock.withPermits(1)(
      Effect.gen(function* () {
        const known = ports.get(threadId);
        if (known !== undefined) return known;
        const assigned = yield* freshPort;
        ports.set(threadId, assigned);
        return assigned;
      }),
    );

  const sessionLaunch: HostedBlenderAgents["Service"]["sessionLaunch"] = Effect.fn(
    "HostedBlenderAgents.sessionLaunch",
  )(
    function* ({ threadId, driver }) {
      if (!SUPPORTED_DRIVERS.has(driver) || !(yield* agentsAllowed)) return undefined;
      // Passive: a session start never runs the setup check.
      const ready = readiness;
      if (ready?.status !== "ok" || ready.blenderMcp === null) return undefined;
      const masterPort = yield* portsFor(threadId);
      yield* fileSystem.makeDirectory(tmpDir, { recursive: true });
      yield* fileSystem.chmod(tmpDir, 0o700);
      return {
        command: ready.blenderMcp,
        blenderPath: ready.blender,
        masterPort,
        tmpDir,
      } satisfies HostedBlenderMcpLaunch;
    },
    // A thread whose session cannot get Blender still starts, without it.
    Effect.catch((cause) =>
      Effect.logWarning("Could not give the thread the hosted Blender MCP", { cause }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

  const listenerPort: HostedBlenderAgents["Service"]["listenerPort"] = Effect.fn(
    "HostedBlenderAgents.listenerPort",
  )(function* (threadId) {
    const session = yield* mcpSessions.read(threadId);
    if (session?.hostedBlender === undefined || !(yield* agentsAllowed)) return null;
    // Nothing outside T3 learns it: only the session's own Blender Lab server dials it.
    return yield* portLock
      .withPermits(1)(freshPort)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not reserve a hosted Blender's agent port", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
  });

  const masterListenerPort: HostedBlenderAgents["Service"]["masterListenerPort"] = Effect.fn(
    "HostedBlenderAgents.masterListenerPort",
  )(function* (threadId) {
    const session = yield* mcpSessions.read(threadId);
    return session?.hostedBlender !== undefined && (yield* agentsAllowed)
      ? session.hostedBlender.masterPort
      : null;
  });

  // Setup answers its current readiness on subscribe; sessions after this see it.
  const followSetup: HostedBlenderAgents["Service"]["followSetup"] = Effect.fnUntraced(
    function* (stream) {
      const first = yield* Deferred.make<void>();
      yield* stream.pipe(
        Stream.runForEach((next) =>
          Effect.sync(() => {
            readiness = next;
          }).pipe(Effect.andThen(Deferred.succeed(first, undefined))),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(first);
    },
  );

  // Switching "Allow agents" off revokes every thread's listener at once.
  const changes = yield* settings.subscribeChanges;
  yield* changes.pipe(
    Stream.map((value) => value.hostedBlenderEnabled && value.hostedBlenderAllowAgents),
    Stream.changes,
    Stream.filter((allowed) => !allowed),
    Stream.runForEach(() =>
      PubSub.publish(revoked, null).pipe(Effect.andThen(PubSub.publish(routeEnded, null))),
    ),
    Effect.forkScoped,
  );

  return HostedBlenderAgents.of({
    reservePrivatePort: portLock.withPermits(1)(freshPort),
    currentSession: Effect.fn("HostedBlenderAgents.currentSession")(function* (threadId) {
      const session = yield* mcpSessions.read(threadId);
      return session?.hostedBlender !== undefined && (yield* agentsAllowed)
        ? session.providerSessionId
        : null;
    }),
    sessionLaunch,
    listenerPort,
    masterListenerPort,
    revocations: Stream.fromPubSub(revoked),
    sessionEnded: Effect.fn("HostedBlenderAgents.sessionEnded")(function* (threadId, session) {
      yield* PubSub.publish(revoked, { threadId, session });
      yield* PubSub.publish(routeEnded, {
        threadId,
        ...(session === undefined ? {} : { session }),
      });
    }),
    agentAccessEnded: Effect.fn("HostedBlenderAgents.agentAccessEnded")(
      function* (threadId, role, grant) {
        yield* PubSub.publish(routeEnded, { threadId, role, grant });
      },
    ),
    blenderMcpCapture: Effect.fn("HostedBlenderAgents.blenderMcpCapture")(function* (command) {
      const ready = readiness;
      return ready?.status === "ok" && ready.blenderMcp === command
        ? ready.blenderMcpCapture
        : null;
    }),
    routeEnds: PubSub.subscribe(routeEnded).pipe(Effect.map(Stream.fromSubscription)),
    agentsAllowed,
    followSetup,
  });
});

export const layer = Layer.effect(HostedBlenderAgents, make);

/**
 * Feeds setup's readiness to the agents service; built beside the hosted Blender service. With
 * agents allowed, the user has opted in to T3 starting Blender, so a restart checks setup again
 * rather than leaving every session without the MCP until someone opens Settings.
 */
export const layerFollowSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const agents = yield* HostedBlenderAgents;
    const setup = yield* HostedBlenderSetup.HostedBlenderSetup;
    yield* agents.followSetup(setup.readiness);
    if (yield* agents.agentsAllowed) yield* setup.ensureChecked.pipe(Effect.forkScoped);
  }),
);
