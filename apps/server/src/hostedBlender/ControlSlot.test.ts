import { assert, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import { sendHoldingSlot } from "./ControlSlot.ts";

const hasFreePermit = (slot: Semaphore.Semaphore) =>
  slot.withPermitsIfAvailable(1)(Effect.void).pipe(Effect.map(Option.isSome));

it.effect("sends the request it took a permit for, though its caller is cancelled meanwhile", () =>
  Effect.gen(function* () {
    const slot = yield* Semaphore.make(1);
    const sending = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const settled = yield* Deferred.make<void>();
    let sent = false;
    const caller = yield* sendHoldingSlot({
      slot,
      send: Deferred.succeed(sending, undefined).pipe(
        Effect.andThen(Deferred.await(gate)),
        Effect.andThen(
          Effect.sync(() => {
            sent = true;
          }),
        ),
      ),
      settled: Deferred.await(settled),
      scope: yield* Effect.scope,
      timeout: "5 seconds",
    }).pipe(Effect.forkChild);
    // Cancelled with the permit taken and the request on its way out.
    yield* Deferred.await(sending);
    const cancelling = yield* Fiber.interrupt(caller).pipe(Effect.forkChild);
    // Let the cancellation reach the caller before the send can finish.
    yield* Effect.yieldNow;
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(cancelling);
    assert.isTrue(sent);
    // The permit stays with the request until Blender answers it, then frees.
    expect(yield* hasFreePermit(slot)).toBe(false);
    yield* Deferred.succeed(settled, undefined);
    yield* Effect.yieldNow;
    expect(yield* hasFreePermit(slot)).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("frees the permit of a caller cancelled as the permit reaches it", () =>
  Effect.gen(function* () {
    // A slot whose take has acquired its permit but not yet returned, as a semaphore's does
    // for a moment, so the caller can be cancelled right at the handoff.
    let held = 0;
    const acquired = yield* Deferred.make<void>();
    const handOver = yield* Deferred.make<void>();
    const slot = {
      take: () =>
        Effect.uninterruptible(
          Effect.sync(() => {
            held += 1;
          }).pipe(
            Effect.andThen(Deferred.succeed(acquired, undefined)),
            Effect.andThen(Deferred.await(handOver)),
            Effect.as(1),
          ),
        ),
      release: () =>
        Effect.sync(() => {
          held -= 1;
          return 1;
        }),
    } as unknown as Semaphore.Semaphore;
    const settled = yield* Deferred.make<void>();
    let sent = false;
    const caller = yield* sendHoldingSlot({
      slot,
      send: Effect.sync(() => {
        sent = true;
      }),
      settled: Deferred.await(settled),
      scope: yield* Effect.scope,
      timeout: "5 seconds",
    }).pipe(Effect.forkChild);
    yield* Deferred.await(acquired);
    const cancelling = yield* Fiber.interrupt(caller).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(handOver, undefined);
    yield* Fiber.join(cancelling);
    yield* Deferred.succeed(settled, undefined);
    yield* Effect.yieldNow;
    // Either the request went out and its permit freed once settled, or neither happened.
    expect({ sent, held }).toEqual({ sent, held: 0 });
  }).pipe(Effect.scoped),
);
