import { assert, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
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

it.effect("frees the permit of a caller cancelled as the permit reaches it", () =>
  // A slot that grants its permit the moment it frees, as a semaphore does; the caller is
  // cancelled at each scheduler step around that handoff in turn.
  Effect.forEach(
    Array.from({ length: 8 }, (_, steps) => steps),
    (steps) =>
      Effect.gen(function* () {
        let held = 0;
        const frees = yield* Deferred.make<void>();
        const slot = {
          take: () =>
            Deferred.await(frees).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  held += 1;
                  return 1;
                }),
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
        yield* Effect.yieldNow;
        yield* Deferred.succeed(frees, undefined);
        for (let step = 0; step < steps; step += 1) yield* Effect.yieldNow;
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(settled, undefined);
        yield* Effect.yieldNow;
        // Either the request went out and its permit freed once settled, or neither happened.
        expect({ steps, sent, held }).toEqual({ steps, sent, held: 0 });
      }).pipe(Effect.scoped),
    { discard: true },
  ),
);

it.effect("leaves no taker waiting behind callers that timed out on a busy slot", () =>
  Effect.gen(function* () {
    const permits = yield* Semaphore.make(1);
    let waiting = 0;
    const slot = {
      take: (n: number) =>
        Effect.sync(() => {
          waiting += 1;
        }).pipe(
          Effect.andThen(permits.take(n)),
          Effect.ensuring(
            Effect.sync(() => {
              waiting -= 1;
            }),
          ),
        ),
      release: (n: number) => permits.release(n),
    } as unknown as Semaphore.Semaphore;
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
    expect(waiting).toBe(0);
  }).pipe(Effect.scoped),
);
