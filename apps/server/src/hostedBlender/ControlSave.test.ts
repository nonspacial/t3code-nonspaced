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
    replyTimeout: "5 seconds",
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

  it.effect("times the write together with the first answer", () =>
    Effect.gen(function* () {
      const { request } = yield* setup(() => Effect.never);
      const fiber = yield* Effect.forkChild(request);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toBe(false);
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
});
