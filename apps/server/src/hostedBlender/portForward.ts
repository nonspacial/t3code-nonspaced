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
  function* (input: { readonly listenPort: number; readonly targetPort: number }) {
    const sockets = new Set<NodeNet.Socket>();
    const server = NodeNet.createServer((incoming) => {
      const outgoing = NodeNet.connect(input.targetPort, "127.0.0.1");
      sockets.add(incoming).add(outgoing);
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
