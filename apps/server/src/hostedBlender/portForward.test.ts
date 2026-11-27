// @effect-diagnostics nodeBuiltinImport:off - the forwarder is checked against real loopback sockets.
import * as NodeNet from "node:net";

import { describe, expect, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { forwardLoopbackPort } from "./portForward.ts";

/** A loopback server that answers each line with `echo:<line>`, on a free port. */
const echoServer = Effect.acquireRelease(
  Effect.callback<{
    readonly server: NodeNet.Server;
    readonly port: number;
    readonly connections: { count: number };
  }>((resume) => {
    const connections = { count: 0 };
    const server = NodeNet.createServer((socket) => {
      connections.count += 1;
      socket.on("data", (data) => socket.write(`echo:${data.toString()}`));
      socket.on("error", () => undefined);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resume(
        Effect.succeed({
          server,
          port: typeof address === "object" ? address!.port : 0,
          connections,
        }),
      );
    });
  }),
  ({ server }) => Effect.sync(() => server.close()),
);

/** Sends `text` to the port and answers what comes back first, or how the connection ended. */
const exchange = (port: number, text: string) =>
  Effect.callback<string>((resume) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    let settled = false;
    const settle = (value: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(value));
    };
    socket.on("connect", () => socket.write(text));
    socket.on("data", (data) => settle(data.toString()));
    socket.on("error", (error: NodeJS.ErrnoException) => settle(`error:${error.code}`));
    socket.on("close", () => settle("closed"));
  });

/** Connects and waits until the far end closes the connection. */
const openConnection = (port: number) =>
  Effect.callback<{ readonly closed: Promise<void>; readonly socket: NodeNet.Socket }>((resume) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    const closed = new Promise<void>((done) => socket.on("close", () => done()));
    socket.on("error", () => undefined);
    socket.on("connect", () => resume(Effect.succeed({ closed, socket })));
  });

describe("forwardLoopbackPort", () => {
  it.live("carries a connection to the target, and ends every one when its scope closes", () =>
    Effect.gen(function* () {
      const target = yield* echoServer;
      const net = yield* NetService.NetService;
      const listenPort = yield* net.reserveLoopbackPort();
      const scope = yield* Scope.make();
      yield* forwardLoopbackPort({ listenPort, targetPort: target.port }).pipe(
        Scope.provide(scope),
      );

      expect(yield* exchange(listenPort, "hello")).toBe("echo:hello");
      const open = yield* openConnection(listenPort);

      yield* Scope.close(scope, Exit.void);
      yield* Effect.promise(() => open.closed);
      expect(yield* exchange(listenPort, "again")).toBe("error:ECONNREFUSED");

      // A target that refuses: the forwarded connection closes.
      const refusingPort = yield* net.reserveLoopbackPort();
      const nobody = yield* net.reserveLoopbackPort();
      yield* forwardLoopbackPort({ listenPort: refusingPort, targetPort: nobody });
      // Closed with bytes unread, the kernel may reset the connection rather than end it.
      expect(["closed", "error:ECONNRESET"], "a target that refuses").toContain(
        yield* exchange(refusingPort, "hello"),
      );

      const taken = yield* forwardLoopbackPort({
        listenPort: target.port,
        targetPort: target.port,
      }).pipe(Effect.flip);
      expect(taken._tag, "its port taken").toBe("PortForwardError");
    }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );

  it.live("closes a connection its check refuses before anything reaches the target", () =>
    Effect.gen(function* () {
      const target = yield* echoServer;
      const net = yield* NetService.NetService;
      const listenPort = yield* net.reserveLoopbackPort();
      const checked: Array<number | undefined> = [];
      yield* forwardLoopbackPort({
        listenPort,
        targetPort: target.port,
        accept: async (socket) => {
          checked.push(socket.remotePort);
          return false;
        },
      });
      expect(["closed", "error:ECONNRESET"]).toContain(yield* exchange(listenPort, "hello"));
      expect(checked).toHaveLength(1);
      expect(target.connections.count).toBe(0);

      // A check that throws closes that connection, and the relay keeps serving others.
      const throwingPort = yield* net.reserveLoopbackPort();
      let calls = 0;
      yield* forwardLoopbackPort({
        listenPort: throwingPort,
        targetPort: target.port,
        accept: () => {
          calls += 1;
          if (calls === 1) throw new Error("check failed");
          return true;
        },
      });
      expect(["closed", "error:ECONNRESET"], "a check that throws").toContain(
        yield* exchange(throwingPort, "hello"),
      );
      expect(yield* exchange(throwingPort, "again"), "the next connection is relayed").toBe(
        "echo:again",
      );
    }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );
});
