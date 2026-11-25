// @effect-diagnostics nodeBuiltinImport:off - a stand-in for Blender Lab's add-on listens on a real loopback port.
import * as NodeNet from "node:net";

import { describe, expect, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as DesktopBlender from "./DesktopBlender.ts";

interface FakeAddon {
  readonly port: number;
  /** The code of every request, in order. */
  readonly requests: Array<string>;
  readonly close: () => void;
}

/**
 * Speaks Blender Lab's add-on protocol: a JSON request ending in a NUL byte, answered the same
 * way. `answer` gives each request's `result`; `quitAfterSave` closes the port once asked to save,
 * as Blender does when it exits.
 */
const fakeAddon = (
  answer: (code: string) => Record<string, unknown>,
  options: { readonly quitAfterSave?: boolean } = {},
) =>
  Effect.acquireRelease(
    Effect.callback<FakeAddon>((resume) => {
      const requests: Array<string> = [];
      const sockets = new Set<NodeNet.Socket>();
      const server = NodeNet.createServer((socket) => {
        sockets.add(socket);
        let buffer = "";
        socket.on("error", () => undefined);
        socket.on("data", (data) => {
          buffer += data.toString();
          if (!buffer.includes("\0")) return;
          const request = JSON.parse(buffer.slice(0, buffer.indexOf("\0")));
          requests.push(request.code);
          socket.end(`${JSON.stringify({ status: "ok", result: answer(request.code) })}\0`);
          if (options.quitAfterSave && request.code.includes("save_mainfile(exit=True)")) {
            setTimeout(() => {
              server.close();
              for (const open of sockets) open.destroy();
            }, 50);
          }
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          Effect.succeed({
            port: typeof address === "object" && address !== null ? address.port : 0,
            requests,
            close: () => {
              server.close();
              for (const open of sockets) open.destroy();
            },
          }),
        );
      });
    }),
    (addon) => Effect.sync(addon.close),
  );

const clientFor = (port: number, running = false) =>
  DesktopBlender.make({
    port,
    desktopBlenderRunning: Effect.succeed(running),
    quitTimeout: Duration.seconds(2),
  });

const master = "/home/user/acme/app/models/hero.blend";

describe("DesktopBlender.probe", () => {
  it.live("reads the open file and whether it has unsaved changes through the add-on", () =>
    Effect.gen(function* () {
      const addon = yield* fakeAddon(() => ({ filepath: master, dirty: true }));
      const desktop = clientFor(addon.port);
      expect(yield* desktop.probe).toEqual({ _tag: "open", filepath: master, dirty: true });
      // A read only: nothing is saved, nothing quits.
      expect(addon.requests[0]).toContain("bpy.data.filepath");
      expect(addon.requests[0]).not.toContain("save_mainfile");
    }).pipe(Effect.scoped),
  );

  it.live("tells a desktop Blender without the add-on from no desktop Blender at all", () =>
    Effect.gen(function* () {
      const net = yield* NetService.NetService;
      const nobody = yield* net.reserveLoopbackPort();
      expect(yield* clientFor(nobody, false).probe).toEqual({ _tag: "none" });
      expect(yield* clientFor(nobody, true).probe).toEqual({ _tag: "noAddon" });
    }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );
});

describe("DesktopBlender.saveAndQuit", () => {
  it.live("saves and quits only while the desktop Blender still has the master open", () =>
    Effect.gen(function* () {
      const addon = yield* fakeAddon(() => ({ moved: true }), { quitAfterSave: true });
      const desktop = clientFor(addon.port);
      yield* desktop.saveAndQuit(master);
      // The file is checked inside Blender, in the same request that saves it.
      expect(addon.requests).toHaveLength(1);
      expect(addon.requests[0]).toContain(JSON.stringify(master));
      expect(addon.requests[0]).toContain("save_mainfile(exit=True)");
    }).pipe(Effect.scoped),
  );

  it.live("refuses when the desktop Blender has moved on to another file", () =>
    Effect.gen(function* () {
      const addon = yield* fakeAddon(() => ({ moved: false, filepath: "/elsewhere/other.blend" }));
      const error = yield* clientFor(addon.port).saveAndQuit(master).pipe(Effect.flip);
      expect(error.reason).toBe("otherFile");
    }).pipe(Effect.scoped),
  );

  it.live("fails when the desktop Blender never quits, as when its save fails", () =>
    Effect.gen(function* () {
      const addon = yield* fakeAddon(() => ({ moved: true }));
      const error = yield* clientFor(addon.port).saveAndQuit(master).pipe(Effect.flip);
      expect(error.reason).toBe("didNotQuit");
    }).pipe(Effect.scoped),
  );

  it.live("fails without the add-on", () =>
    Effect.gen(function* () {
      const net = yield* NetService.NetService;
      const nobody = yield* net.reserveLoopbackPort();
      const error = yield* clientFor(nobody, true).saveAndQuit(master).pipe(Effect.flip);
      expect(error.reason).toBe("unreachable");
    }).pipe(Effect.scoped, Effect.provide(NetService.layer)),
  );
});

describe("the user's desktop Blender", () => {
  it.live("is never dialled from a test", () =>
    Effect.gen(function* () {
      const exit = yield* DesktopBlender.executeOnAddon(
        DesktopBlender.DESKTOP_BLENDER_MCP_PORT,
        "result = {}",
        Duration.seconds(1),
      ).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      expect(String(exit)).toContain("never reach the desktop Blender");
    }),
  );
});
