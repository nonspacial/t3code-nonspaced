import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

/** One connection to T3's control add-on. It never reopens once closed. */
export interface ControlConnection {
  readonly write: (line: string) => Effect.Effect<void>;
  readonly closed: Deferred.Deferred<void>;
}

export type SaveReply = "saving" | "saved" | "quitFailed";

/**
 * Asks the add-on to save and quit. True only once it confirms the file is written. The add-on
 * answers `saving` before a save that can take as long as a big file needs, so only the write
 * and that first answer are timed; losing the connection or Blender at any point fails it.
 */
export const requestSave = Effect.fn("HostedBlender.requestSave")(function* (input: {
  readonly connection: ControlConnection;
  readonly replies: Queue.Dequeue<SaveReply>;
  readonly ended: Effect.Effect<void>;
  readonly command: string;
  readonly replyTimeout: Duration.Input;
}) {
  const lost = Effect.raceFirst(Deferred.await(input.connection.closed), input.ended).pipe(
    Effect.as("lost" as const),
  );
  const next = Effect.raceFirst(Queue.take(input.replies), lost);
  const started = yield* input.connection
    .write(input.command)
    .pipe(Effect.andThen(next), Effect.raceFirst(lost), Effect.timeoutOption(input.replyTimeout));
  if (Option.isNone(started) || started.value !== "saving") return false;
  return (yield* next) === "saved";
});
