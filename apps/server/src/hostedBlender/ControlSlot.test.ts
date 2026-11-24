import { assert, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";

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

/**
 * A real semaphore whose takes yield once after granting, before returning: the moment a
 * cancellation can land with the permit already counted. `waiting` counts takes still queued.
 */
const yieldingSlot = (permits: Semaphore.Semaphore) => {
  const counts = { waiting: 0 };
  const granted = <A, E, R>(take: Effect.Effect<A, E, R>) =>
    Effect.sync(() => {
      counts.waiting += 1;
    }).pipe(
      Effect.andThen(
        take.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              counts.waiting -= 1;
            }),
          ),
        ),
      ),
      Effect.tap(() => Effect.yieldNow),
    );
  const slot = {
    take: (n: number) => granted(permits.take(n)),
    takeScoped: (n: number) => granted(permits.takeScoped(n)),
    release: (n: number) => permits.release(n),
    withPermitsIfAvailable: permits.withPermitsIfAvailable.bind(permits),
  } as unknown as Semaphore.Semaphore;
  return { slot, counts };
};

it.effect("frees the permit of a caller cancelled as the permit reaches it", () =>
  // The caller is cancelled at each scheduler step around the handoff in turn.
  Effect.forEach(
    Array.from({ length: 10 }, (_, steps) => steps),
    (steps) =>
      Effect.gen(function* () {
        const permits = yield* Semaphore.make(1);
        const { slot } = yieldingSlot(permits);
        const settled = yield* Deferred.make<void>();
        let sent = false;
        yield* permits.take(1);
        const caller = yield* sendHoldingSlot({
          slot,
          send: Effect.sync(() => {
            sent = true;
          }),
          settled: Deferred.await(settled),
          scope: yield* Effect.scope,
          timeout: "5 seconds",
        }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* permits.release(1);
        for (let step = 0; step < steps; step += 1) yield* Effect.yieldNow;
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(settled, undefined);
        yield* Effect.yieldNow;
        // Either the request went out and its permit freed once settled, or neither happened.
        expect({ steps, sent, free: yield* hasFreePermit(permits) }).toEqual({
          steps,
          sent,
          free: true,
        });
      }).pipe(Effect.scoped),
    { discard: true },
  ),
);

it.effect("leaves no taker waiting behind callers that timed out on a busy slot", () =>
  Effect.gen(function* () {
    const permits = yield* Semaphore.make(1);
    const { slot, counts } = yieldingSlot(permits);
    // Blender is working on a request that holds the slot and never answers.
    yield* permits.take(1);
    const scope = yield* Effect.scope;
    const callers = yield* Effect.forEach(Array.from({ length: 3 }), () =>
      sendHoldingSlot({
        slot,
        send: Effect.void,
        settled: Effect.never,
        scope,
        timeout: "1 second",
      }).pipe(Effect.forkChild),
    );
    yield* TestClock.adjust("1 second");
    for (const caller of callers) expect(yield* Fiber.join(caller)).toBe(false);
    expect(counts.waiting).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("sends nothing, and keeps no permit, once the slot's owner has shut down", () =>
  Effect.gen(function* () {
    const permits = yield* Semaphore.make(1);
    const owner = yield* Scope.make();
    let sent = false;
    yield* permits.take(1);
    const caller = yield* sendHoldingSlot({
      slot: permits,
      send: Effect.sync(() => {
        sent = true;
      }),
      settled: Effect.never,
      scope: owner,
      timeout: "5 seconds",
    }).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    // The service shuts down while the caller still waits for the permit.
    yield* Scope.close(owner, Exit.void);
    yield* permits.release(1);
    expect(yield* Fiber.join(caller)).toBe(false);
    expect({ sent, free: yield* hasFreePermit(permits) }).toEqual({ sent: false, free: true });
  }),
);
