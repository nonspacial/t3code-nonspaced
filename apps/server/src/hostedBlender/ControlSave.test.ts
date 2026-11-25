import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { requestSave, type SaveReply } from "./ControlSave.ts";

const setup = Effect.fn(function* (write: (line: string) => Effect.Effect<void>) {
  const closed = yield* Deferred.make<void>();
  const ended = yield* Deferred.make<void>();
  const replies = yield* Queue.unbounded<SaveReply>();
  const request = requestSave({
    connection: { write, closed },
    replies,
    ended: Deferred.await(ended),
    command: '{"type":"quit","save":true}\n',
    writeTimeout: "5 seconds",
  });
  return { closed, ended, replies, request };
});

describe("requestSave", () => {
  it.effect("fails when the connection closes while a stale write waits", () =>
    Effect.gen(function* () {
      // The writer was captured before the socket closed, so it never finishes.
      const { closed, request } = yield* setup(() => Effect.never);
      const fiber = yield* Effect.forkChild(request);
      yield* Deferred.succeed(closed, undefined);
      expect(yield* Fiber.join(fiber)).toBe(false);
    }),
  );

  it.effect("times the write", () =>
    Effect.gen(function* () {
      const { request } = yield* setup(() => Effect.never);
      const fiber = yield* Effect.forkChild(request);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toBe(false);
    }),
  );

  it.effect("B2: once the command is written, waits for a busy Blender's late answer", () =>
    Effect.gen(function* () {
      // Blender's main thread is busy: the command waits there, and Blender will still act on it.
      const { replies, request } = yield* setup(() => Effect.void);
      const fiber = yield* Effect.forkChild(request);
      yield* TestClock.adjust("1 minute");
      yield* Queue.offerAll(replies, ["saving", "saved"]);
      expect(yield* Fiber.join(fiber)).toBe(true);
    }),
  );

  it.effect("succeeds only on saved, and fails if Blender goes away mid-save", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const saved = yield* setup((line) => Effect.sync(() => void writes.push(line)));
      yield* Queue.offerAll(saved.replies, ["saving", "saved"]);
      expect(yield* saved.request).toBe(true);
      expect(writes).toEqual(['{"type":"quit","save":true}\n']);

      const gone = yield* setup(() => Effect.void);
      yield* Queue.offer(gone.replies, "saving");
      const fiber = yield* Effect.forkChild(gone.request);
      yield* Deferred.succeed(gone.ended, undefined);
      expect(yield* Fiber.join(fiber)).toBe(false);
    }),
  );

  const repeats = Array.from({ length: 50 }, (_, run) => run);

  // The close finalizer completes `closed` before the queued `saved` wakes the waiting take.
  it.effect.each(repeats)("counts a save confirmed just before the connection closes (%i)", () =>
    Effect.gen(function* () {
      const closing = yield* setup(() => Effect.void);
      yield* Queue.offer(closing.replies, "saving");
      const pending = yield* Effect.forkChild(closing.request, { startImmediately: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(closing.closed, undefined));
          yield* Queue.offer(closing.replies, "saved");
        }),
      );
      expect(yield* Fiber.join(pending)).toBe(true);
    }),
  );

  // The write finishes, then both replies and the close arrive together.
  it.effect.each(repeats)("counts both replies queued as the connection closes (%i)", () =>
    Effect.gen(function* () {
      const written = yield* Deferred.make<void>();
      const closing = yield* setup(() => Deferred.await(written));
      const pending = yield* Effect.forkChild(closing.request, { startImmediately: true });
      yield* Deferred.succeed(written, undefined);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(closing.closed, undefined));
          yield* Queue.offerAll(closing.replies, ["saving", "saved"]);
        }),
      );
      expect(yield* Fiber.join(pending)).toBe(true);
    }),
  );
});
