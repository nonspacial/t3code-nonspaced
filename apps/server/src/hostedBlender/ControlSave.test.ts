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
      expect(yield* Fiber.join(fiber), "Blender went away mid-save").toBe(false);

      // The writer was captured before the socket closed, so it never finishes.
      const stale = yield* setup(() => Effect.never);
      const staleWrite = yield* Effect.forkChild(stale.request);
      yield* Deferred.succeed(stale.closed, undefined);
      expect(yield* Fiber.join(staleWrite), "the connection closed while a stale write waits").toBe(
        false,
      );

      const stuck = yield* setup(() => Effect.never);
      const stuckWrite = yield* Effect.forkChild(stuck.request);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(stuckWrite), "the write is timed").toBe(false);
    }),
  );

  it.effect("counts a save confirmed just before the connection closes", () =>
    Effect.gen(function* () {
      // The close finalizer completes `closed` before the queued `saved` wakes the waiting take.
      const closing = yield* setup(() => Effect.void);
      yield* Queue.offer(closing.replies, "saving");
      const pending = yield* Effect.forkChild(closing.request, { startImmediately: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(closing.closed, undefined));
          yield* Queue.offer(closing.replies, "saved");
        }),
      );
      expect(yield* Fiber.join(pending), "saved queued as the close lands").toBe(true);

      // The write finishes, then both replies and the close arrive together.
      const written = yield* Deferred.make<void>();
      const both = yield* setup(() => Deferred.await(written));
      const bothPending = yield* Effect.forkChild(both.request, { startImmediately: true });
      yield* Deferred.succeed(written, undefined);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(both.closed, undefined));
          yield* Queue.offerAll(both.replies, ["saving", "saved"]);
        }),
      );
      expect(yield* Fiber.join(bothPending), "both replies queued as the close lands").toBe(true);
    }),
  );
});
