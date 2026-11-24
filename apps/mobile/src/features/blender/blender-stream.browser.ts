import { createCanvasFrameSink } from "@t3tools/client-runtime/device/frame";
import { keymapForLayout } from "@t3tools/client-runtime/hosted-blender/input";
import {
  createHostedBlenderStreamClient,
  type HostedBlenderControl,
  type HostedBlenderStreamClient,
  VIEW_ONLY,
} from "@t3tools/client-runtime/hosted-blender/stream";
import {
  createHostedBlenderTouch,
  type HostedBlenderTouch,
} from "@t3tools/client-runtime/hosted-blender/touch";

import type { BlenderStreamCommand, BlenderStreamConfiguration } from "./blender-stream-document";

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
  }
}

const KEY_Z = 44;
// How far a finger moves, in CSS pixels, before a touch becomes a drag.
const SLOP_CSS_PIXELS = 10;
const MAX_STREAM_COORDINATE = 7680;

interface Viewer {
  readonly stream: HostedBlenderStreamClient;
  readonly control: () => HostedBlenderControl;
  /** The middle of the stream, in stream pixels. */
  readonly centre: () => { readonly x: number; readonly y: number };
  readonly dispose: () => void;
}

let active: Viewer | null = null;

export function stop() {
  active?.dispose();
  active = null;
}

export function command(next: BlenderStreamCommand) {
  if (active === null) return;
  switch (next.type) {
    case "takeControl":
      return active.stream.send({ type: "takeControl", takeOver: next.takeOver });
    case "releaseControl":
      return active.stream.send({ type: "releaseControl" });
    case "shadingPie":
      if (active.control().controller !== "you") return;
      // Blender opens the pie only over the 3D viewport, and the tap that took control never
      // moved the pointer there.
      active.stream.send({ type: "pointer", ...active.centre() });
      active.stream.send({ type: "key", code: KEY_Z, pressed: true });
      active.stream.send({ type: "key", code: KEY_Z, pressed: false });
  }
}

/** Shows a thread's hosted Blender in the native WebView, controlled by touch. */
export function start(configuration: BlenderStreamConfiguration) {
  stop();
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- The native WebView bridge takes one string.
  const post = (message: object) => window.ReactNativeWebView.postMessage(JSON.stringify(message));
  const { colors } = configuration;
  Object.assign(document.documentElement.style, { height: "100%", overflow: "hidden" });
  Object.assign(document.body.style, {
    margin: "0",
    height: "100%",
    overflow: "hidden",
    background: colors.background,
  });
  const surface = document.createElement("div");
  surface.setAttribute("role", "application");
  surface.setAttribute("aria-label", configuration.labels.viewport);
  // Explicit sides, not `inset`, and the canvas placed by `fit`: a WebView that drops either
  // shrinks the surface to the canvas at the top-left and never reports the viewer's size.
  Object.assign(surface.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100%",
    height: "100%",
    touchAction: "none",
    userSelect: "none",
    webkitUserSelect: "none",
    webkitTouchCallout: "none",
  });
  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, { position: "absolute", pointerEvents: "none" });
  surface.append(canvas);
  document.body.replaceChildren(surface);

  let control = VIEW_ONLY;
  let captured = false;
  let touch: HostedBlenderTouch | null = null;
  /** Letterboxes the frame in the viewer: as large as fits, centred. */
  const fit = () => {
    const viewerWidth = window.innerWidth;
    const viewerHeight = window.innerHeight;
    if (canvas.width <= 0 || canvas.height <= 0 || viewerWidth <= 0 || viewerHeight <= 0) return;
    const ratio = Math.min(viewerWidth / canvas.width, viewerHeight / canvas.height);
    const width = canvas.width * ratio;
    const height = canvas.height * ratio;
    Object.assign(canvas.style, {
      width: `${width}px`,
      height: `${height}px`,
      left: `${(viewerWidth - width) / 2}px`,
      top: `${(viewerHeight - height) / 2}px`,
    });
  };
  const sink = createCanvasFrameSink(canvas, fit);
  const client = createHostedBlenderStreamClient(
    { access: configuration.access, threadId: configuration.threadId },
    sink,
    {
      onStatus: (status) => post({ type: "status", status }),
      onStats: (stats) => post(stats),
      onFrameRate: (rate) => post({ type: "rate", ...rate }),
      onUnauthorized: () => post({ type: "unauthorized" }),
      onControl: (next) => {
        control = next;
        if (next.controller === "you" && touch === null) {
          // Blender keeps the previous controller's layout; touch input and Z assume US.
          client.send({ type: "keymap", ...keymapForLayout("us") });
          touch = createHostedBlenderTouch({
            send: client.send,
            slop: () => SLOP_CSS_PIXELS * scale(),
          });
          touch.setCaptured(captured);
        } else if (next.controller !== "you" && touch !== null) {
          touch.dispose();
          touch = null;
        }
        post({ type: "control", canOperate: next.canOperate, controller: next.controller });
      },
      onCursor: (next) => {
        captured = next;
        touch?.setCaptured(next);
      },
    },
  );

  /** Stream pixels per CSS pixel. */
  const scale = () => {
    const width = canvas.getBoundingClientRect().width;
    return width > 0 && canvas.width > 0 ? canvas.width / width : globalThis.devicePixelRatio || 1;
  };
  const toStream = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const ratio = scale();
    const clamp = (value: number, limit: number) => Math.round(Math.max(0, Math.min(limit, value)));
    return {
      x: clamp((event.clientX - rect.left) * ratio, Math.min(canvas.width, MAX_STREAM_COORDINATE)),
      y: clamp((event.clientY - rect.top) * ratio, Math.min(canvas.height, MAX_STREAM_COORDINATE)),
    };
  };

  surface.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (touch !== null) return touch.down(event.pointerId, toStream(event));
    // The tap that takes control stays out of Blender, so it selects nothing there.
    if (control.canOperate && control.controller === "unclaimed") {
      client.send({ type: "takeControl", takeOver: false });
    }
  });
  surface.addEventListener("pointermove", (event) => touch?.move(event.pointerId, toStream(event)));
  surface.addEventListener("pointerup", (event) => touch?.up(event.pointerId));
  surface.addEventListener("pointercancel", (event) => touch?.cancel(event.pointerId));
  surface.addEventListener("contextmenu", (event) => event.preventDefault());

  // The viewer's own size, which the display follows while this device is in control.
  const resize = () => {
    const ratio = globalThis.devicePixelRatio || 1;
    client.resize(window.innerWidth * ratio, window.innerHeight * ratio);
    fit();
  };
  resize();
  window.addEventListener("resize", resize);

  active = {
    stream: client,
    control: () => control,
    centre: () => ({
      x: Math.round(Math.min(canvas.width, MAX_STREAM_COORDINATE) / 2),
      y: Math.round(Math.min(canvas.height, MAX_STREAM_COORDINATE) / 2),
    }),
    dispose: () => {
      window.removeEventListener("resize", resize);
      touch?.dispose();
      touch = null;
      client.stop();
    },
  };
  window.addEventListener("pagehide", stop, { once: true });
}
