import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import type * as Semaphore from "effect/Semaphore";

/**
 * Takes a permit of `slot` and sends, freeing the permit once `settled` (the add-on may still be
 * working after its caller gives up). A never-interrupted taker hands the permit over; if the
 * caller gave up first, the taker frees it. False when no permit came within `timeout`.
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
      const handoff = { owner: "waiting" as "waiting" | "caller" | "abandoned" };
      const handedOver = yield* Deferred.make<void>();
      yield* input.slot.take(1).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (handoff.owner === "abandoned") return Effect.asVoid(input.slot.release(1));
            handoff.owner = "caller";
            return Deferred.succeed(handedOver, undefined).pipe(Effect.asVoid);
          }),
        ),
        Effect.forkIn(input.scope),
      );
      const waited = yield* restore(
        Deferred.await(handedOver).pipe(Effect.timeoutOption(input.timeout)),
      ).pipe(Effect.exit);
      if (handoff.owner !== "caller") {
        handoff.owner = "abandoned";
        return Exit.isFailure(waited) ? yield* Effect.failCause(waited.cause) : false;
      }
      if (Exit.isFailure(waited)) {
        yield* input.slot.release(1);
        return yield* Effect.failCause(waited.cause);
      }
      yield* input.settled.pipe(Effect.ensuring(input.slot.release(1)), Effect.forkIn(input.scope));
      yield* input.send;
      return true;
    }),
  );
