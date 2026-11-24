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
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HostedBlenderSetup from "./HostedBlenderSetup.ts";

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
    /** Whether the thread's latest hosted Blender started with its agent listener on. */
    readonly listening: (threadId: ThreadId) => Effect.Effect<boolean>;
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
  const listeners = new Map<ThreadId, boolean>();
  let readiness: HostedBlenderSetup.HostedBlenderReadiness | null = null;
  const portLock = yield* Semaphore.make(1);
  const tmpDir = path.join(config.stateDir, "hosted-blender", "mcp-tmp");

  // Unreadable settings count as switched off.
  const agentsAllowed = settings.getSettings.pipe(
    Effect.map((value) => value.hostedBlenderEnabled && value.hostedBlenderAllowAgents),
    Effect.orElseSucceed(() => false),
  );

  const portsFor = (threadId: ThreadId) =>
    portLock.withPermits(1)(
      Effect.gen(function* () {
        const known = ports.get(threadId);
        if (known !== undefined) return known;
        const assigned = {
          hosted: yield* net.reserveLoopbackPort(),
          master: yield* net.reserveLoopbackPort(),
        };
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
    listeners.set(threadId, port !== null);
    return port;
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

  return HostedBlenderAgents.of({
    sessionLaunch,
    listenerPort,
    listening: Effect.fnUntraced(function* (threadId) {
      return listeners.get(threadId) === true;
    }),
    agentsAllowed,
    followSetup,
  });
});

export const layer = Layer.effect(HostedBlenderAgents, make);

/** Feeds setup's readiness to the agents service; built beside the hosted Blender service. */
export const layerFollowSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const agents = yield* HostedBlenderAgents;
    const setup = yield* HostedBlenderSetup.HostedBlenderSetup;
    yield* agents.followSetup(setup.readiness);
  }),
);
