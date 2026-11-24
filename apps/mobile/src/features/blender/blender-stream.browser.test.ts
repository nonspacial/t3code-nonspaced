import { describe, expect, it, vi } from "vite-plus/test";

import { command, start, stop } from "./blender-stream.browser";

class FakeSocket {
  static OPEN = 1;
  readonly sent: unknown[] = [];
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readyState = 0;
  binaryType = "blob";
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }
  serverSays(message: object) {
    this.emit("message", { data: JSON.stringify(message) });
  }
}

function viewer() {
  const sockets: FakeSocket[] = [];
  vi.stubGlobal(
    "WebSocket",
    class extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    },
  );
  vi.stubGlobal("VideoDecoder", vi.fn());
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  // A portrait phone: 400×800 CSS pixels at 2× density.
  vi.stubGlobal("innerWidth", 400);
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("devicePixelRatio", 2);
  const posted: Array<Record<string, unknown>> = [];
  vi.stubGlobal("ReactNativeWebView", {
    postMessage: (message: string) => posted.push(JSON.parse(message)),
  });
  start({
    threadId: "thread-1",
    access: {
      httpBase: "https://environment.test/api/hosted-blender-stream",
      wsBase: "wss://environment.test/api/hosted-blender-stream",
      credentials: false,
      query: {},
    },
    colors: { background: "black", muted: "gray" },
    labels: { viewport: "Blender viewport" },
  });
  const socket = sockets[0]!;
  socket.open();
  // The stream is 800×400 stream pixels, shown at 400×200 CSS pixels.
  const canvas = document.querySelector("canvas")!;
  canvas.width = 800;
  canvas.height = 400;
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200);
  const surface = document.querySelector<HTMLElement>("[role=application]")!;
  const touch = (type: string, pointerId: number, x: number, y: number) =>
    surface.dispatchEvent(
      Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        pointerId,
        clientX: x,
        clientY: y,
        button: 0,
      }),
    );
  const input = () =>
    socket.sent.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type !== "resize",
    );
  const resizes = () =>
    socket.sent.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "resize",
    );
  return {
    socket,
    posted,
    touch,
    input,
    resizes,
    canvas,
    [Symbol.dispose]: () => {
      stop();
      vi.unstubAllGlobals();
    },
  };
}

describe("mobile Blender stream", () => {
  it("watches the thread's stream and tells the app who is in control", () => {
    using fixture = viewer();
    const { socket, posted } = fixture;
    expect(new URL(socket.url).searchParams.get("threadId")).toBe("thread-1");
    socket.serverSays({ type: "control", canOperate: true, controller: "another-viewer" });
    expect(posted).toContainEqual({
      type: "control",
      canOperate: true,
      controller: "another-viewer",
    });
  });

  it("sizes the hidden display to the phone's viewer, in device pixels", () => {
    using fixture = viewer();
    expect(fixture.resizes().at(-1)).toEqual({ type: "resize", width: 800, height: 1600 });
    vi.stubGlobal("innerWidth", 800);
    vi.stubGlobal("innerHeight", 400);
    window.dispatchEvent(new Event("resize"));
    expect(fixture.resizes().at(-1)).toEqual({ type: "resize", width: 1600, height: 800 });
  });

  it("fits the frame inside the viewer and centres it", () => {
    using fixture = viewer();
    // An 800×400 frame in a 400×800 viewer: full width, centred vertically.
    window.dispatchEvent(new Event("resize"));
    const { style } = fixture.canvas;
    expect([style.width, style.height, style.left, style.top]).toEqual([
      "400px",
      "200px",
      "0px",
      "300px",
    ]);
  });

  it("takes control on the first tap without clicking in Blender", () => {
    using fixture = viewer();
    const { socket, touch, input } = fixture;
    socket.serverSays({ type: "control", canOperate: true, controller: "unclaimed" });
    touch("pointerdown", 1, 10, 10);
    touch("pointerup", 1, 10, 10);
    expect(input()).toEqual([{ type: "takeControl", takeOver: false }]);
  });

  it("sends nothing from touches when this device may only watch", () => {
    using fixture = viewer();
    const { socket, touch, input } = fixture;
    socket.serverSays({ type: "control", canOperate: false, controller: "unclaimed" });
    touch("pointerdown", 1, 10, 10);
    touch("pointermove", 1, 100, 100);
    touch("pointerup", 1, 100, 100);
    command({ type: "shadingPie" });
    expect(input()).toEqual([]);
  });

  it("orbits in stream pixels while in control", () => {
    using fixture = viewer();
    const { socket, touch, input } = fixture;
    socket.serverSays({ type: "control", canOperate: true, controller: "you" });
    touch("pointerdown", 1, 100, 50);
    touch("pointermove", 1, 150, 60);
    touch("pointerup", 1, 150, 60);
    expect(input()).toEqual([
      { type: "keymap", layout: "us", variant: "" },
      { type: "pointer", x: 200, y: 100 },
      { type: "button", button: 274, pressed: true },
      { type: "pointer", x: 300, y: 120 },
      { type: "button", button: 274, pressed: false },
    ]);
  });

  it("opens the shading pie with Z, takes over and gives control back on command", () => {
    using fixture = viewer();
    const { socket, input } = fixture;
    command({ type: "takeControl", takeOver: true });
    socket.serverSays({ type: "control", canOperate: true, controller: "you" });
    command({ type: "shadingPie" });
    command({ type: "releaseControl" });
    expect(input()).toEqual([
      { type: "takeControl", takeOver: true },
      // The previous controller's layout stays until replaced; Z must arrive as Z.
      { type: "keymap", layout: "us", variant: "" },
      // The pie opens where the pointer is, so Z first moves it to the middle of the viewport.
      { type: "pointer", x: 400, y: 200 },
      { type: "key", code: 44, pressed: true },
      { type: "key", code: 44, pressed: false },
      { type: "releaseControl" },
    ]);
  });

  it("lets go of a held orbit when control is taken over", () => {
    using fixture = viewer();
    const { socket, touch, input } = fixture;
    socket.serverSays({ type: "control", canOperate: true, controller: "you" });
    touch("pointerdown", 1, 100, 50);
    touch("pointermove", 1, 150, 60);
    socket.serverSays({ type: "control", canOperate: true, controller: "another-viewer" });
    expect(input().at(-1)).toEqual({ type: "button", button: 274, pressed: false });
    touch("pointermove", 1, 200, 60);
    expect(input().at(-1)).toEqual({ type: "button", button: 274, pressed: false });
  });
});
