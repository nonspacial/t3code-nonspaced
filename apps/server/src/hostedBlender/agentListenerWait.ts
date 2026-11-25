import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** `untested`: the installed Blender Lab extension is a version T3 hasn't tested, so never enabled. */
export type AgentListenerState = "off" | "starting" | "ready" | "failed" | "untested";

/**
 * Waits for a starting agent listener to settle. One still starting at the deadline is revoked
 * before the caller hears "failed", so nothing can start listening after the agent was told it
 * didn't.
 */
export const awaitAgentListener = Effect.fn("HostedBlender.awaitAgentListener")(function* (input: {
  readonly settled: Effect.Effect<void>;
  readonly current: () => AgentListenerState;
  readonly timeout: Duration.Input;
  readonly revoke: Effect.Effect<void>;
}) {
  const done = yield* input.settled.pipe(Effect.timeoutOption(input.timeout));
  if (Option.isNone(done) && input.current() === "starting") {
    yield* input.revoke;
    return "failed" as const;
  }
  const state = input.current();
  return state === "starting" ? ("failed" as const) : state;
});
