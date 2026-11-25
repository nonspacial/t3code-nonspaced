import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
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
  query = "",
) =>
  Effect.gen(function* () {
    const blender = HostedBlender.HostedBlender.of({
      open: () => Effect.void,
      quit: () => Effect.void,
      reopen: () => Effect.void,
      agentGrant: () => Effect.die("unused"),
      dismiss: () => Effect.void,
      keptCopies: () => Effect.succeed([]),
      closeOnSettle: () => Effect.void,
      forgetThread: () => Effect.void,
      agentListener: () => Effect.succeed(null),
      threadState: () => Stream.empty,
      runningBlenders: Stream.empty,
      attachViewer,
      captureView: () => Effect.die("unused"),
      findHits: () => Effect.die("unused"),
      setView: () => Effect.die("unused"),
      openMaster: () => Effect.die("unused"),
      reopenMaster: () => Effect.die("unused"),
      knowMaster: () => Effect.die("unused"),
      releaseMaster: () => Effect.void,
      moveIntoT3: () => Effect.die("unused"),
      masterState: () => Stream.empty,
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
          `${origin}/api/hosted-blender-stream/ws?threadId=thread-1&wsTicket=ticket${query}`,
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
      const attached: unknown[] = [];
      const resized = Promise.withResolvers<readonly [number, number]>();
      const acked = Promise.withResolvers<void>();
      const socket = yield* serve([AuthOrchestrationReadScope], (threadId, options) =>
        Effect.sync(() => {
          attached.push([threadId, options]);
          return {
            _tag: "attached" as const,
            viewer: {
              output,
              ack: Effect.sync(() => acked.resolve()),
              resize: (width, height) => Effect.sync(() => resized.resolve([width, height])),
              setVisible: () => Effect.void,
              input: () => Effect.void,
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
      expect(attached).toEqual([["thread-1", { canOperate: false, role: "working" }]]);
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

it.effect("watches the thread's master Blender when the pane asks for it", () =>
  Effect.gen(function* () {
    const roles = Promise.withResolvers<unknown>();
    yield* serve(
      [AuthOrchestrationReadScope],
      (_threadId, options) =>
        Effect.sync(() => {
          roles.resolve(options.role);
          return { _tag: "stopped" as const };
        }),
      "&role=master",
    );
    expect(yield* Effect.promise(() => roles.promise)).toBe("master");
  }),
);

it.effect("lets a session that can operate terminals take control and send input", () =>
  Effect.gen(function* () {
    const output = yield* Queue.make<HostedBlender.HostedBlenderViewerOutput>();
    const inputs: unknown[] = [];
    const received = Promise.withResolvers<void>();
    let canOperate: boolean | undefined;
    const socket = yield* serve(
      [AuthOrchestrationReadScope, AuthTerminalOperateScope],
      (_threadId, options) =>
        Effect.sync(() => {
          canOperate = options.canOperate;
          return {
            _tag: "attached" as const,
            viewer: {
              output,
              ack: Effect.void,
              resize: () => Effect.void,
              setVisible: () => Effect.void,
              input: (message) =>
                Effect.sync(() => {
                  inputs.push(message);
                  if (inputs.length === 3) received.resolve();
                }),
            },
          };
        }),
    );
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "takeControl", takeOver: true }));
      // Out of range and unknown input never reaches the service.
      socket.send(JSON.stringify({ type: "key", code: 99_999, pressed: true }));
      socket.send(JSON.stringify({ type: "keymap", layout: "us;rm", variant: "" }));
      socket.send(JSON.stringify({ type: "key", code: 30, pressed: true }));
      socket.send(JSON.stringify({ type: "releaseControl" }));
    });
    yield* Effect.promise(() => received.promise);
    expect(canOperate).toBe(true);
    expect(inputs).toEqual([
      { type: "takeControl", takeOver: true },
      { type: "key", code: 30, pressed: true },
      { type: "releaseControl" },
    ]);
  }),
);

it.effect("passes visibility on, and handles a viewer's messages one at a time", () =>
  Effect.gen(function* () {
    const output = yield* Queue.make<HostedBlender.HostedBlenderViewerOutput>();
    const seen: unknown[] = [];
    const done = Promise.withResolvers<void>();
    let running = 0;
    let mostAtOnce = 0;
    // Each message takes a while, as input does while the helper's stdin is full.
    const handle = (message: unknown) =>
      Effect.gen(function* () {
        running += 1;
        mostAtOnce = Math.max(mostAtOnce, running);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        running -= 1;
        seen.push(message);
        if (seen.length === 202) done.resolve();
      });
    const socket = yield* serve([AuthOrchestrationReadScope, AuthTerminalOperateScope], () =>
      Effect.succeed({
        _tag: "attached" as const,
        viewer: {
          output,
          ack: handle("ack"),
          resize: () => Effect.void,
          setVisible: (visible) => handle({ visible }),
          input: (message) => handle(message),
        },
      }),
    );
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "visibility", visible: false }));
      for (let code = 1; code <= 100; code++) {
        socket.send(JSON.stringify({ type: "key", code, pressed: true }));
        socket.send(JSON.stringify({ type: "ack" }));
      }
      socket.send(JSON.stringify({ type: "visibility", visible: true }));
    });
    yield* Effect.promise(() => done.promise);
    expect(mostAtOnce).toBe(1);
    expect(seen[0]).toEqual({ visible: false });
    expect(seen[1]).toEqual({ type: "key", code: 1, pressed: true });
    expect(seen[2]).toBe("ack");
    expect(seen.at(-1)).toEqual({ visible: true });
  }),
);
