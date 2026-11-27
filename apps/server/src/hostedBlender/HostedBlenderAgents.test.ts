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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

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
  blenderMcpCapture: null,
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
  /** What setup reports after its first readiness, as checks run. */
  readonly readinessChanges?: Queue.Queue<HostedBlenderSetup.HostedBlenderReadiness>;
  /** A check is running as the layer starts; `progressChanges` says what follows. */
  readonly checking?: boolean;
  readonly progressChanges?: Queue.Queue<HostedBlenderSetup.HostedBlenderSetupProgress>;
  readonly checks?: Array<"check">;
  readonly checked?: Deferred.Deferred<void>;
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
            }).pipe(
              Effect.andThen(
                input.checked === undefined
                  ? Effect.void
                  : Deferred.succeed(input.checked, undefined),
              ),
            ),
            ensureCheckedForOpen: Effect.void,
            installWithAgent: Effect.die("not used"),
            readiness: Stream.never,
            progress: Stream.concat(
              Stream.succeed({
                readiness: input.readiness ?? READY,
                checking: input.checking ?? false,
              }),
              input.progressChanges !== undefined
                ? Stream.fromQueue(input.progressChanges)
                : input.readinessChanges === undefined
                  ? Stream.never
                  : Stream.fromQueue(input.readinessChanges).pipe(
                      Stream.map((readiness) => ({ readiness, checking: false })),
                    ),
            ),
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
      assert.notEqual(forClaude.masterPort, 9876);
      // The ports belong to the thread, so a later session reuses them.
      const forCodex = yield* agents.sessionLaunch({ threadId, driver: codex });
      assert.deepEqual(forCodex, forClaude);
      const other = yield* agents.sessionLaunch({
        threadId: ThreadId.make("thread-other"),
        driver: claude,
      });
      assert.notEqual(other?.masterPort, forClaude.masterPort);

      for (const driver of ["pi", "cursor", "opencode", "acp"]) {
        assert.isUndefined(
          yield* agents.sessionLaunch({ threadId, driver: ProviderDriverKind.make(driver) }),
          `${driver} gets nothing yet`,
        );
      }
    }).pipe(Effect.provide(layerFor({}))),
  );

  it.effect.each([
    { name: "Hosted Blender is off", enabled: false, allowAgents: true },
    { name: "agents are not allowed", enabled: true, allowAgents: false },
    {
      name: "setup found no official Blender MCP",
      readiness: { ...READY, blenderMcp: null } as HostedBlenderSetup.HostedBlenderReadiness,
    },
  ])("gives nothing when $name", ({ enabled, allowAgents, readiness }) =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      assert.isUndefined(yield* agents.sessionLaunch({ threadId, driver: claude }));
    }).pipe(
      Effect.provide(
        layerFor({
          ...(enabled === undefined ? {} : { enabled }),
          ...(allowAgents === undefined ? {} : { allowAgents }),
          ...(readiness === undefined ? {} : { readiness }),
        }),
      ),
    ),
  );

  it.effect(
    "waits briefly for a setup check under way at its start, then decides on its answer",
    () => {
      const unchecked: HostedBlenderSetup.HostedBlenderReadiness = {
        status: "notSetUp",
        missing: ["check"],
      };
      const missing: HostedBlenderSetup.HostedBlenderReadiness = {
        status: "notSetUp",
        missing: ["blender"],
      };
      return Effect.gen(function* () {
        const changes = yield* Queue.unbounded<HostedBlenderSetup.HostedBlenderSetupProgress>();
        yield* Effect.gen(function* () {
          const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
          const launch = (id: string) =>
            agents
              .sessionLaunch({ threadId: ThreadId.make(id), driver: claude })
              .pipe(Effect.forkChild);
          // The check finds Blender missing: nothing, once it says so.
          const notReady = yield* launch("thread-not-ready");
          yield* TestClock.adjust("1 second");
          assert.isUndefined(notReady.pollUnsafe());
          yield* Queue.offer(changes, { readiness: missing, checking: false });
          assert.isUndefined(yield* Fiber.join(notReady));
          // A check that outlasts the wait: decided as it stands.
          yield* Queue.offer(changes, { readiness: unchecked, checking: true });
          const outlasted = yield* launch("thread-outlasted");
          yield* TestClock.adjust("15 seconds");
          assert.isUndefined(yield* Fiber.join(outlasted));
          // The check finds it ready: the session gets Blender.
          const ready = yield* launch("thread-ready");
          yield* TestClock.adjust("1 second");
          assert.isUndefined(ready.pollUnsafe());
          yield* Queue.offer(changes, { readiness: READY, checking: false });
          assert.strictEqual((yield* Fiber.join(ready))?.command, READY.blenderMcp);
        }).pipe(
          Effect.provide(
            layerFor({ readiness: unchecked, checking: true, progressChanges: changes }),
          ),
        );
      });
    },
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
      // Each launch gets a port of its own, which no session's config names.
      const first = yield* agents.listenerPort(threadId);
      const second = yield* agents.listenerPort(threadId);
      assert.isNotNull(first);
      assert.notEqual(first, second);
      assert.notInclude([first, second], launch?.masterPort);
      assert.equal(yield* agents.masterListenerPort(threadId), launch?.masterPort);
    }).pipe(Effect.provide(layerFor({}))),
  );

  it.effect("keeps the listener off once agents are no longer allowed", () =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      assert.isNull(yield* agents.currentSession(threadId), "no session holds it yet");
      yield* startSession(yield* agents.sessionLaunch({ threadId, driver: claude }));
      assert.equal(
        yield* agents.currentSession(threadId),
        "provider-session-hosted-blender",
        "the session holding the thread's Blender MCP, while agents are allowed",
      );
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        hostedBlenderAllowAgents: false,
      });
      assert.isNull(yield* agents.listenerPort(threadId));
      assert.isNull(yield* agents.masterListenerPort(threadId));
      assert.isNull(yield* agents.currentSession(threadId), "no holder once agents aren't allowed");
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
      assert.deepEqual([first?.masterPort, second?.masterPort], [41000, 41001]);

      // The probe keeps offering the threads' ports, idle since their sessions took them.
      const privatePort = yield* agents.reservePrivatePort;
      assert.notInclude(
        [first?.masterPort, second?.masterPort],
        privatePort,
        "a thread's port is never handed out as a master's private one",
      );
      assert.equal(privatePort, 41002);
    }).pipe(Effect.provide(layerFor({ probes: [41000, 41000, 41001, 41000, 41001, 41002] }))),
  );
});

describe("HostedBlenderAgents.revocations", () => {
  it.effect("revokes every thread when Allow agents is switched off", () =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      // Started at once, so it subscribes before the change below.
      const next = yield* agents.revocations.pipe(
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        hostedBlenderAllowAgents: false,
      });
      assert.deepEqual(yield* Fiber.join(next), Option.some(null));
    }).pipe(Effect.scoped, Effect.provide(layerFor({}))),
  );

  it.effect("revokes a thread whose session ended", () =>
    Effect.gen(function* () {
      const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
      // Started at once, so it subscribes before the change below.
      const next = yield* agents.revocations.pipe(
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
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
      yield* agents.agentAccessEnded(threadId, "master", "relay-1");
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        hostedBlenderAllowAgents: false,
      });
      assert.deepEqual(Array.from(yield* Fiber.join(taken)), [
        { threadId, session: "provider-session-1" },
        { threadId, role: "master", grant: "relay-1" },
        null,
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerFor({}))),
  );
});

describe("HostedBlenderAgents.routeEnds on setup", () => {
  const capture = (modifiedMs: number) => ({
    command: "/home/user/.local/bin/blender-mcp",
    build: {
      realPath: "/home/user/.local/share/uv/tools/blender-mcp/bin/blender-mcp",
      size: 1,
      modifiedMs,
      version: "1.0.3",
      versionModifiedMs: 1,
    },
    answers: {},
  });
  const readyWith = (modifiedMs: number | null): HostedBlenderSetup.HostedBlenderReadiness => ({
    ...(READY as Extract<HostedBlenderSetup.HostedBlenderReadiness, { status: "ok" }>),
    blenderMcpCapture: modifiedMs === null ? null : capture(modifiedMs),
  });

  it.effect("ends every session's server when setup reads another build, or none", () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<HostedBlenderSetup.HostedBlenderReadiness>();
      return yield* Effect.gen(function* () {
        const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
        const ends = yield* agents.routeEnds;
        const taken = yield* ends.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
        yield* Queue.offer(changes, readyWith(2));
        yield* Queue.offer(changes, readyWith(null));
        // Each names the build it took back, so a server already on the new one is left alone.
        assert.deepEqual(Array.from(yield* Fiber.join(taken)), [
          { staleBuild: capture(1).build },
          { staleBuild: capture(2).build },
        ]);
      }).pipe(Effect.provide(layerFor({ readiness: readyWith(1), readinessChanges: changes })));
    }).pipe(Effect.scoped),
  );
});

describe("HostedBlenderAgents.layerFollowSetup", () => {
  it.effect.each([
    { allowAgents: true, checks: ["check"] },
    { allowAgents: false, checks: [] },
  ])(
    "checks setup after a restart only with agents allowed ($allowAgents)",
    ({ allowAgents, checks: expected }) =>
      Effect.gen(function* () {
        const checked = yield* Deferred.make<void>();
        const checks: Array<"check"> = [];
        yield* Effect.gen(function* () {
          yield* HostedBlenderAgents.HostedBlenderAgents;
          const answered = yield* Deferred.await(checked).pipe(
            Effect.timeoutOption("1 second"),
            Effect.forkChild,
          );
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(answered);
          assert.deepEqual(checks, expected);
        }).pipe(Effect.provide(layerFor({ allowAgents, checks, checked })));
      }),
  );
});
