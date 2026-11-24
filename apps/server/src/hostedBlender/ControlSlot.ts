import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as Semaphore from "effect/Semaphore";

/**
 * Takes one of `slot`'s permits and sends; the permit is freed only once `settled` completes,
 * since the add-on keeps working on a request its caller stopped waiting for. Taking the permit
 * and sending are one step a cancelled caller can't split, so no permit is ever held for a
 * request that was never sent. False when no permit came within `timeout`.
 */
export const sendHoldingSlot = (input: {
  readonly slot: Semaphore.Semaphore;
  readonly send: Effect.Effect<void>;
  readonly settled: Effect.Effect<unknown>;
  readonly scope: Scope.Scope;
  readonly timeout: Duration.Input;
}): Effect.Effect<boolean> =>
  Effect.uninterruptibleMask((restore) =>
    restore(input.slot.take(1).pipe(Effect.timeoutOption(input.timeout))).pipe(
      Effect.flatMap((taken) =>
        Option.isNone(taken)
          ? Effect.succeed(false)
          : input.settled.pipe(
              Effect.ensuring(input.slot.release(1)),
              Effect.forkIn(input.scope),
              Effect.andThen(input.send),
              Effect.as(true),
            ),
      ),
    ),
  );
