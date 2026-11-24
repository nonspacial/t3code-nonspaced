import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { type AgentListenerState, awaitAgentListener } from "./agentListenerWait.ts";

const harness = Effect.gen(function* () {
  const settled = yield* Deferred.make<void>();
  let state: AgentListenerState = "starting";
  let revoked = 0;
  const wait = awaitAgentListener({
    settled: Deferred.await(settled),
    current: () => state,
    timeout: "105 seconds",
    revoke: Effect.sync(() => {
      revoked += 1;
      // As HostedBlender's revoke does: a late "ready" can no longer be taken.
      state = "off";
    }),
  });
  return {
    wait,
    settle: (next: AgentListenerState) =>
      Effect.sync(() => {
        state = next;
      }).pipe(Effect.andThen(Deferred.succeed(settled, undefined))),
    revoked: () => revoked,
  };
});

describe("awaitAgentListener", () => {
  it.effect("answers what the listener settled on before the deadline", () =>
    Effect.gen(function* () {
      const listener = yield* harness;
      const waiting = yield* listener.wait.pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      yield* listener.settle("ready");
      assert.equal(yield* Fiber.join(waiting), "ready");
      assert.equal(listener.revoked(), 0);
    }),
  );

  it.effect("revokes a listener still starting at the deadline, then answers failed", () =>
    Effect.gen(function* () {
      const listener = yield* harness;
      const waiting = yield* listener.wait.pipe(Effect.forkChild);
      yield* TestClock.adjust("106 seconds");
      assert.equal(yield* Fiber.join(waiting), "failed");
      assert.equal(listener.revoked(), 1);
    }),
  );
});
