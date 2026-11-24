import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import type * as Semaphore from "effect/Semaphore";

/**
 * Takes a permit of `slot` and sends, freeing it once `settled` (the add-on may still be working
 * after its caller gives up). The permit's release is tied to a scope from the moment it's
 * granted; a caller that gives up closes it. False when no permit came within `timeout`.
 */
export const sendHoldingSlot = (input: {
  readonly slot: Semaphore.Semaphore;
  readonly send: Effect.Effect<void>;
  readonly settled: Effect.Effect<unknown>;
  readonly scope: Scope.Scope;
  readonly timeout: Duration.Input;
}): Effect.Effect<boolean> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const permit = yield* Scope.make();
      const taken = yield* restore(
        input.slot
          .takeScoped(1)
          .pipe(Effect.provideService(Scope.Scope, permit), Effect.timeoutOption(input.timeout)),
      ).pipe(Effect.exit);
      if (Exit.isFailure(taken) || Option.isNone(taken.value)) {
        yield* Scope.close(permit, Exit.void);
        return Exit.isFailure(taken) ? yield* Effect.failCause(taken.cause) : false;
      }
      yield* input.settled.pipe(
        Effect.ensuring(Scope.close(permit, Exit.void)),
        Effect.forkIn(input.scope),
      );
      yield* input.send;
      return true;
    }),
  );
