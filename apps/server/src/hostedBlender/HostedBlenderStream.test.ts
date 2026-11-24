import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthTerminalReadScope,
  HOSTED_BLENDER_STREAM_STOPPED_CLOSE_CODE,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as HostedBlender from "./HostedBlender.ts";
import { routeLayer } from "./HostedBlenderStream.ts";

const platformLayer = NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer));

const serve = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  attachViewer: HostedBlender.HostedBlender["Service"]["attachViewer"],
) =>
  Effect.gen(function* () {
    const blender = HostedBlender.HostedBlender.of({
      open: () => Effect.void,
      quit: () => Effect.void,
      reopen: () => Effect.void,
      dismiss: () => Effect.void,
      closeOnSettle: () => Effect.void,
      threadState: () => Stream.empty,
      runningBlenders: Stream.empty,
      attachViewer,
    });
    const auth = Layer.merge(
      Layer.mock(EnvironmentAuth.EnvironmentAuth, {
        authenticateWebSocketUpgrade: () =>
          Effect.succeed({
            sessionId: AuthSessionId.make("blender-stream-test"),
            subject: "blender-stream-test",
            method: "bearer-access-token",
            scopes,
          }),
      }),
      Layer.mock(SessionStore.SessionStore, {
        cookieName: "test",
        legacyCookieName: undefined,
        awaitInvalidation: () => Effect.never,
      }),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(
        routeLayer.pipe(
          Layer.provide(Layer.succeed(HostedBlender.HostedBlender, blender)),
          Layer.provide(platformLayer),
        ),
        { disableListenLog: true },
      ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(auth)),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
    return yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = new WebSocket(
          `${origin}/api/hosted-blender-stream/ws?threadId=thread-1&wsTicket=ticket`,
        );
        socket.binaryType = "arraybuffer";
        return socket;
      }),
      (socket) => Effect.sync(() => socket.close()),
    );
  });

it.effect(
  "streams a hosted Blender's frames to a thread reader and passes acks and size back",
  () =>
    Effect.gen(function* () {
      const output = yield* Queue.make<HostedBlender.HostedBlenderViewerOutput>();
      const frame = new Uint8Array([0x53, 0x45, 0x4d, 0x55, 1, 1]);
      yield* Queue.offer(output, {
        _tag: "message",
        message: { type: "viewport", width: 1280, height: 720 },
      });
      yield* Queue.offer(output, { _tag: "frame", data: frame });
      const attached: string[] = [];
      const resized = Promise.withResolvers<readonly [number, number]>();
      const acked = Promise.withResolvers<void>();
      const socket = yield* serve([AuthOrchestrationReadScope], (threadId) =>
        Effect.sync(() => {
          attached.push(threadId);
          return {
            _tag: "attached" as const,
            viewer: {
              output,
              ack: Effect.sync(() => acked.resolve()),
              resize: (width, height) => Effect.sync(() => resized.resolve([width, height])),
            },
          };
        }),
      );
      const messages: unknown[] = [];
      const frames: Uint8Array[] = [];
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") return void messages.push(JSON.parse(event.data));
        frames.push(new Uint8Array(event.data as ArrayBuffer));
        socket.send("not json");
        socket.send(JSON.stringify({ type: "resize", width: 1600, height: 900 }));
        socket.send(JSON.stringify({ type: "ack" }));
      });
      expect(yield* Effect.promise(() => resized.promise)).toEqual([1600, 900]);
      yield* Effect.promise(() => acked.promise);
      expect(messages).toEqual([{ type: "viewport", width: 1280, height: 720 }]);
      expect(frames).toEqual([frame]);
      expect(attached).toEqual(["thread-1"]);
    }),
);

it.effect("closes with the stopped code when the thread has no hosted Blender", () =>
  Effect.gen(function* () {
    const socket = yield* serve([AuthOrchestrationReadScope], () =>
      Effect.succeed({ _tag: "stopped" as const }),
    );
    const closed = yield* Effect.promise(
      () =>
        new Promise<number>((resolve) => socket.addEventListener("close", (e) => resolve(e.code))),
    );
    expect(closed).toBe(HOSTED_BLENDER_STREAM_STOPPED_CLOSE_CODE);
  }),
);

it.effect("refuses sessions that can't read threads", () =>
  Effect.gen(function* () {
    let attached = false;
    const socket = yield* serve([AuthTerminalReadScope], () =>
      Effect.sync(() => {
        attached = true;
        return { _tag: "stopped" as const };
      }),
    );
    const closed = yield* Effect.promise(
      () =>
        new Promise<number>((resolve) => socket.addEventListener("close", (e) => resolve(e.code))),
    );
    expect(closed).not.toBe(HOSTED_BLENDER_STREAM_STOPPED_CLOSE_CODE);
    expect(attached).toBe(false);
  }),
);
