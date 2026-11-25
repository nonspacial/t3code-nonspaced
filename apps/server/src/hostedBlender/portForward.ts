// @effect-diagnostics nodeBuiltinImport:off - a byte-for-byte TCP relay needs node:net's sockets.
import * as NodeNet from "node:net";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PortForwardError extends Schema.TaggedError<PortForwardError>()("PortForwardError", {
  port: Schema.Number,
}) {}

/**
 * Relays loopback connections on `listenPort` to `targetPort` until the scope closes, which also
 * ends every connection it carried. A master Blender is shared, so each thread reaches it
 * through its own port, and taking one thread's access back closes only that thread's.
 */
export const forwardLoopbackPort = Effect.fn("HostedBlender.forwardLoopbackPort")(
  function* (input: {
    readonly listenPort: number;
    readonly targetPort: number;
    /**
     * Whether to relay this connection, decided before anything it sent is passed on. B7's
     * same-account check goes here, as Blender only ever sees T3 connect.
     */
    readonly accept?: (socket: NodeNet.Socket) => boolean | Promise<boolean>;
  }) {
    const sockets = new Set<NodeNet.Socket>();
    const relay = (incoming: NodeNet.Socket) => {
      const outgoing = NodeNet.connect(input.targetPort, "127.0.0.1");
      sockets.add(outgoing);
      const end = () => {
        incoming.destroy();
        outgoing.destroy();
        sockets.delete(incoming);
        sockets.delete(outgoing);
      };
      for (const socket of [incoming, outgoing]) {
        socket.on("error", end);
        socket.on("close", end);
      }
      incoming.pipe(outgoing);
      outgoing.pipe(incoming);
    };
    const server = NodeNet.createServer({ pauseOnConnect: true }, (incoming) => {
      sockets.add(incoming);
      incoming.on("error", () => incoming.destroy());
      incoming.on("close", () => sockets.delete(incoming));
      // Called inside the chain, so a check that throws closes the socket rather than the server.
      void Promise.resolve()
        .then(() => input.accept?.(incoming) ?? true)
        .then(
          (accepted) => (accepted && !incoming.destroyed ? relay(incoming) : incoming.destroy()),
          () => incoming.destroy(),
        );
    });
    yield* Effect.acquireRelease(
      Effect.callback<void, PortForwardError>((resume) => {
        server.once("error", () =>
          resume(Effect.fail(new PortForwardError({ port: input.listenPort }))),
        );
        server.listen(input.listenPort, "127.0.0.1", () => resume(Effect.void));
      }),
      () =>
        Effect.sync(() => {
          server.close();
          for (const socket of sockets) socket.destroy();
          sockets.clear();
        }),
    );
  },
);
