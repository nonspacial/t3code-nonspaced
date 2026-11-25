import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { HostedBlenderMcpLaunch } from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HostedBlenderAgents from "./HostedBlenderAgents.ts";
import * as HostedBlenderSetup from "./HostedBlenderSetup.ts";

const threadId = ThreadId.make("thread-hosted-blender-agents");
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");

const READY: HostedBlenderSetup.HostedBlenderReadiness = {
  status: "ok",
  helper: "/opt/t3/hidden-display",
  blender: "/usr/bin/blender",
  blenderMcp: "/home/user/.local/bin/blender-mcp",
};

/** Test settings whose writes reach `subscribeChanges`, which `layerTest` never streams. */
const changingSettings = (initial: {
  readonly hostedBlenderEnabled: boolean;
  readonly hostedBlenderAllowAgents: boolean;
}) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettings.ServerSettingsService;
      const changes = yield* PubSub.unbounded<Effect.Success<typeof base.getSettings>>();
      let current = { ...(yield* base.getSettings), ...initial };
      return {
        ...base,
        getSettings: Effect.sync(() => current),
        updateSettings: (patch) =>
          Effect.gen(function* () {
            current = { ...current, ...patch } as typeof current;
            yield* PubSub.publish(changes, current);
            return current;
          }),
        subscribeChanges: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
      };
    }),
  ).pipe(Layer.provide(ServerSettings.ServerSettingsService.layerTest()));

const layerFor = (input: {
  readonly enabled?: boolean;
  readonly allowAgents?: boolean;
  readonly readiness?: HostedBlenderSetup.HostedBlenderReadiness;
  readonly checks?: Array<"check">;
  /** What the loopback probe answers, in turn, instead of real free ports. */
  readonly probes?: Array<number>;
}) =>
  HostedBlenderAgents.layerFollowSetup.pipe(
    Layer.provideMerge(HostedBlenderAgents.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        changingSettings({
          hostedBlenderEnabled: input.enabled ?? true,
          hostedBlenderAllowAgents: input.allowAgents ?? true,
        }),
        Layer.succeed(
          HostedBlenderSetup.HostedBlenderSetup,
          HostedBlenderSetup.HostedBlenderSetup.of({
            state: Stream.never,
            check: Effect.void,
            ensureChecked: Effect.sync(() => {
              input.checks?.push("check");
            }),
            installWithAgent: Effect.die("not used"),
            readiness: Stream.concat(Stream.succeed(input.readiness ?? READY), Stream.never),
          }),
        ),
        McpProviderSessions.layer,
        input.probes === undefined
          ? NetService.layer
          : Layer.mock(NetService.NetService)({
              reserveLoopbackPort: () => Effect.sync(() => input.probes!.shift() ?? 0),
            }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-hosted-blender-agents-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const startSession = Effect.fnUntraced(function* (launch: HostedBlenderMcpLaunch | undefined) {
  yield* (yield* McpProviderSessions.McpProviderSessions).set({
    environmentId: EnvironmentId.make("environment-hosted-blender"),
    threadId,
    providerSessionId: "provider-session-hosted-blender",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer secret",
    browserToolsAvailable: true,
    ...(launch === undefined ? {} : { hostedBlender: launch }),
  });
});

describe("HostedBlenderAgents.sessionLaunch", () => {
  it.effect("gives Claude and Codex the official MCP with the thread's own ports", () =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      const forClaude = yield* agents.sessionLaunch({ threadId, driver: claude });
      assert.isDefined(forClaude);
      assert.equal(forClaude.command, READY.status === "ok" ? READY.blenderMcp : "");
      assert.equal(forClaude.blenderPath, "/usr/bin/blender");
      assert.notEqual(forClaude.hostedPort, forClaude.masterPort);
      assert.notInclude([forClaude.hostedPort, forClaude.masterPort], 9876);
      // The ports belong to the thread, so a later session reuses them.
      const forCodex = yield* agents.sessionLaunch({ threadId, driver: codex });
      assert.deepEqual(forCodex, forClaude);
      const other = yield* agents.sessionLaunch({
        threadId: ThreadId.make("thread-other"),
        driver: claude,
      });
      assert.notEqual(other?.hostedPort, forClaude.hostedPort);
    }).pipe(Effect.provide(layerFor({}))),
  );

  it.effect("gives other providers nothing yet", () =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      for (const driver of ["pi", "cursor", "opencode", "acp"]) {
        assert.isUndefined(
          yield* agents.sessionLaunch({ threadId, driver: ProviderDriverKind.make(driver) }),
        );
      }
    }).pipe(Effect.provide(layerFor({}))),
  );

  it.effect.each([
    { name: "Hosted Blender is off", enabled: false, allowAgents: true },
    { name: "agents are not allowed", enabled: true, allowAgents: false },
  ])("gives nothing when $name", ({ enabled, allowAgents }) =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      assert.isUndefined(yield* agents.sessionLaunch({ threadId, driver: claude }));
    }).pipe(Effect.provide(layerFor({ enabled, allowAgents }))),
  );

  it.effect("gives nothing without setup's official Blender MCP", () =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      assert.isUndefined(yield* agents.sessionLaunch({ threadId, driver: claude }));
    }).pipe(Effect.provide(layerFor({ readiness: { ...READY, blenderMcp: null } }))),
  );
});

describe("HostedBlenderAgents.listenerPort", () => {
  it.effect("opens the Blender Lab listener only for a thread whose agent session uses it", () =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      assert.isNull(yield* agents.listenerPort(threadId));
      assert.isNull(yield* agents.masterListenerPort(threadId));

      const launch = yield* agents.sessionLaunch({ threadId, driver: claude });
      yield* startSession(launch);
      assert.equal(yield* agents.listenerPort(threadId), launch?.hostedPort);
      assert.equal(yield* agents.masterListenerPort(threadId), launch?.masterPort);
    }).pipe(Effect.provide(layerFor({}))),
  );

  it.effect("keeps the listener off once agents are no longer allowed", () =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      yield* startSession(yield* agents.sessionLaunch({ threadId, driver: claude }));
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        hostedBlenderAllowAgents: false,
      });
      assert.isNull(yield* agents.listenerPort(threadId));
      assert.isNull(yield* agents.masterListenerPort(threadId));
    }).pipe(Effect.provide(layerFor({}))),
  );

  it.effect("never hands a port out twice, even when the probe repeats one", () =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      const first = yield* agents.sessionLaunch({ threadId, driver: claude });
      const second = yield* agents.sessionLaunch({
        threadId: ThreadId.make("thread-second"),
        driver: codex,
      });
      assert.deepEqual(
        [first?.hostedPort, first?.masterPort, second?.hostedPort, second?.masterPort],
        [41000, 41001, 41002, 41003],
      );
    }).pipe(
      Effect.provide(layerFor({ probes: [41000, 41000, 41001, 41001, 41000, 41002, 41003] })),
    ),
  );
});

describe("HostedBlenderAgents.revocations", () => {
  it.effect("revokes every thread when Allow agents is switched off", () =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      const next = yield* agents.revocations.pipe(Stream.runHead, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        hostedBlenderAllowAgents: false,
      });
      assert.deepEqual(yield* Fiber.join(next), Option.some(null));
    }).pipe(Effect.scoped, Effect.provide(layerFor({}))),
  );

  it.effect("revokes a thread whose session ended", () =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      const next = yield* agents.revocations.pipe(Stream.runHead, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* agents.sessionEnded(threadId, "provider-session-1");
      // Scoped to the credential that ended, so a newer session keeps what it was granted.
      assert.deepEqual(
        yield* Fiber.join(next),
        Option.some({ threadId, session: "provider-session-1" }),
      );
    }).pipe(Effect.scoped, Effect.provide(layerFor({}))),
  );
});

describe("HostedBlenderAgents.routeEnds", () => {
  it.effect("reports every way a thread's agent loses its Blenders, from subscribing on", () =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      const ends = yield* agents.routeEnds;
      const taken = yield* ends.pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped);
      yield* agents.sessionEnded(threadId, "provider-session-1");
      yield* agents.agentAccessEnded(threadId, "master");
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        hostedBlenderAllowAgents: false,
      });
      assert.deepEqual(Array.from(yield* Fiber.join(taken)), [
        { threadId, session: "provider-session-1" },
        { threadId, role: "master" },
        null,
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerFor({}))),
  );
});

describe("HostedBlenderAgents.layerFollowSetup", () => {
  it.effect.each([
    { allowAgents: true, checks: ["check"] },
    { allowAgents: false, checks: [] },
  ])(
    "checks setup after a restart only with agents allowed ($allowAgents)",
    ({ allowAgents, checks: expected }) => {
      const checks: Array<"check"> = [];
      return Effect.gen(function* () {
        yield* HostedBlenderAgents.HostedBlenderAgents;
        yield* Effect.yieldNow;
        assert.deepEqual(checks, expected);
      }).pipe(Effect.provide(layerFor({ allowAgents, checks })));
    },
  );
});

describe("HostedBlenderAgents private ports", () => {
  it.effect("never hands a master's private port out as a thread's, or a thread's as one", () =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      const launch = yield* agents.sessionLaunch({ threadId, driver: claude });
      // The probe keeps offering the thread's ports, idle since the session took them.
      const own = yield* agents.reservePrivatePort;
      assert.notInclude([launch?.hostedPort, launch?.masterPort], own);
      assert.equal(own, 41002);
    }).pipe(Effect.provide(layerFor({ probes: [41000, 41001, 41000, 41001, 41002] }))),
  );
});

describe("HostedBlenderAgents.currentSession", () => {
  it.effect(
    "names the agent session holding the thread's Blender MCP, while agents are allowed",
    () =>
      Effect.gen(function* () {
        const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
        assert.isNull(yield* agents.currentSession(threadId));
        yield* startSession(yield* agents.sessionLaunch({ threadId, driver: claude }));
        assert.equal(yield* agents.currentSession(threadId), "provider-session-hosted-blender");
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
          hostedBlenderAllowAgents: false,
        });
        assert.isNull(yield* agents.currentSession(threadId));
      }).pipe(Effect.provide(layerFor({}))),
  );
});
