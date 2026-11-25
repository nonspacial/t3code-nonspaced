import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import type { HostedBlenderMcpLaunch } from "@t3tools/provider-core/server/mcpSession";
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

class HostedBlenderPortError extends Schema.TaggedError<HostedBlenderPortError>()(
  "HostedBlenderPortError",
  {},
) {}

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
     * For the thread's hosted Blender starting now: the port the official add-on listens on for
     * the thread's agent, or null to keep it off. It listens only while the thread's session
     * holds the MCP and agents are allowed. Until T3's wrapper drops other OS users'
     * connections, any local process could reach this port.
     */
    readonly listenerPort: (threadId: ThreadId) => Effect.Effect<number | null>;
    /** The port the thread's `blender-master` entry dials, on the same terms as `listenerPort`. */
    readonly masterListenerPort: (threadId: ThreadId) => Effect.Effect<number | null>;
    /**
     * Threads whose agents lost access to their hosted Blender: the thread's session ended, or
     * null when "Allow agents" was switched off for every thread.
     */
    readonly revocations: Stream.Stream<ThreadId | null>;
    /** The thread's provider session ended and its MCP config is gone. */
    readonly sessionEnded: (threadId: ThreadId) => Effect.Effect<void>;
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

  const ports = new Map<ThreadId, { readonly hosted: number; readonly master: number }>();
  // Every port handed out, so two threads or roles never share one.
  const assignedPorts = new Set<number>();
  const revoked = yield* PubSub.unbounded<ThreadId | null>();
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
        const assigned = { hosted: yield* freshPort, master: yield* freshPort };
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
      const assigned = yield* portsFor(threadId);
      yield* fileSystem.makeDirectory(tmpDir, { recursive: true });
      yield* fileSystem.chmod(tmpDir, 0o700);
      return {
        command: ready.blenderMcp,
        blenderPath: ready.blender,
        hostedPort: assigned.hosted,
        masterPort: assigned.master,
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
    const port =
      session?.hostedBlender !== undefined && (yield* agentsAllowed)
        ? session.hostedBlender.hostedPort
        : null;
    return port;
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
    Stream.runForEach(() => PubSub.publish(revoked, null)),
    Effect.forkScoped,
  );

  return HostedBlenderAgents.of({
    sessionLaunch,
    listenerPort,
    masterListenerPort,
    revocations: Stream.fromPubSub(revoked),
    sessionEnded: Effect.fn("HostedBlenderAgents.sessionEnded")(function* (threadId) {
      yield* PubSub.publish(revoked, threadId);
    }),
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
