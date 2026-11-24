import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  HOSTED_BLENDER_STREAM_FULL_CLOSE_CODE,
  HOSTED_BLENDER_STREAM_PATH,
  HOSTED_BLENDER_STREAM_STOPPED_CLOSE_CODE,
  HostedBlenderStreamClientMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest, failEnvironmentInternal } from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { requestUrl } from "../requestUrl.ts";
import * as HostedBlender from "./HostedBlender.ts";

const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const textDecoder = new TextDecoder();
const decodeClientMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(HostedBlenderStreamClientMessage),
);

// Request middleware owns tracing, including long-lived WebSocket sessions.
const makeHandler = Effect.fnUntraced(function* (blender: HostedBlender.HostedBlender["Service"]) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (
    Option.isNone(url) ||
    url.value.pathname !== `${HOSTED_BLENDER_STREAM_PATH}/ws` ||
    request.headers.upgrade?.toLowerCase() !== "websocket"
  ) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  // Watching needs only read access; guest links have no session and never reach this.
  const session = yield* authenticateMediaRequest(AuthOrchestrationReadScope);
  // Taking control is a shell's worth of power: Blender's Python console runs anything.
  const canOperate = session.scopes.includes(AuthTerminalOperateScope);
  const threadId = url.value.searchParams.get("threadId") ?? "";
  if (threadId.length === 0) return HttpServerResponse.text("Not Found", { status: 404 });
  const sessions = yield* SessionStore.SessionStore;
  const stream = Effect.scoped(
    Effect.gen(function* () {
      const attached = yield* blender.attachViewer(threadId, { canOperate });
      const incoming = NodeHttpServerRequest.toIncomingMessage(request);
      // H.264 is already compressed; without deflate every pending write stays in the socket
      // buffer bounded below.
      delete incoming.headers["sec-websocket-extensions"];
      const transport = incoming.socket;
      const socket = yield* request.upgrade;
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      // A refused upgrade reads as an auth failure to ticket clients, so these are close codes.
      const stopped = writer.write(
        new Socket.CloseEvent(HOSTED_BLENDER_STREAM_STOPPED_CLOSE_CODE, "stopped"),
      );
      if (attached._tag === "stopped") {
        yield* stopped;
        return HttpServerResponse.empty();
      }
      if (attached._tag === "full") {
        yield* writer.write(new Socket.CloseEvent(HOSTED_BLENDER_STREAM_FULL_CLOSE_CODE, "full"));
        return HttpServerResponse.empty();
      }
      const viewer = attached.viewer;
      const write = (data: Uint8Array | string) =>
        Effect.suspend(() => {
          const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
          if (transport.writableLength + bytes + 14 > MAX_SOCKET_BUFFER_BYTES) {
            return Effect.sync(() => transport.destroy()).pipe(Effect.andThen(Effect.interrupt));
          }
          return writer.write(data);
        });
      const sendOutput = Queue.take(viewer.output).pipe(
        Effect.flatMap((output) => {
          switch (output._tag) {
            case "frame":
              return write(output.data);
            case "message":
              return write(JSON.stringify(output.message));
            case "stopped":
              return stopped.pipe(Effect.andThen(Effect.interrupt));
          }
        }),
      );
      // Acks and input arrive for every frame and pointer move; they share the session span.
      const receive = Effect.fnUntraced(function* (chunk: Uint8Array | string) {
        const message = decodeClientMessage(
          typeof chunk === "string" ? chunk : textDecoder.decode(chunk),
        );
        if (Option.isNone(message)) return;
        if (message.value.type === "ack") return yield* viewer.ack;
        if (message.value.type === "resize") {
          return yield* viewer.resize(message.value.width, message.value.height);
        }
        // In order and one at a time, so a flood of input waits on the socket, not in memory.
        return yield* viewer.input(message.value);
      });
      const receiveInput = reader.pull.pipe(
        Effect.flatMap((chunks) => Effect.forEach(chunks, receive, { discard: true })),
      );
      return yield* Effect.raceFirst(Effect.forever(sendOutput), Effect.forever(receiveInput)).pipe(
        Effect.onInterrupt(() => Effect.sync(() => transport.destroy())),
      );
    }),
  ).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty()));
  return yield* Effect.raceFirst(
    stream,
    sessions.awaitInvalidation(session.sessionId).pipe(
      Effect.as(HttpServerResponse.empty()),
      Effect.catchTags({
        SessionCredentialVerificationError: (error) =>
          failEnvironmentInternal("internal_error", error),
      }),
    ),
  );
});

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const blender = yield* HostedBlender.HostedBlender;
    yield* router.add("GET", `${HOSTED_BLENDER_STREAM_PATH}/*`, makeHandler(blender));
  }),
);
