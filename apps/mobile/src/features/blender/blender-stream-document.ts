import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import { HostedBlenderController } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface BlenderStreamConfiguration {
  readonly access: DeviceHubAccess;
  readonly threadId: string;
  readonly colors: { readonly background: string; readonly muted: string };
  /** Translated in React Native: the WebView cannot load the catalogs. */
  readonly labels: { readonly viewport: string };
}

/** What React Native asks of the WebView's stream. */
export type BlenderStreamCommand =
  | { readonly type: "takeControl"; readonly takeOver: boolean }
  | { readonly type: "releaseControl" }
  /** Z, which opens Blender's shading pie. */
  | { readonly type: "shadingPie" };

const BlenderStreamMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("status"),
    // `error` is the document's own bootstrap failure.
    status: Schema.Literals(["connecting", "live", "stopped", "full", "unsupported", "error"]),
  }),
  Schema.Struct({
    type: Schema.Literal("rate"),
    framesPerSecond: Schema.Number,
    bitsPerSecond: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal("unauthorized") }),
  /** The size of the frames shown, in stream pixels. */
  Schema.Struct({ type: Schema.Literal("frameSize"), width: Schema.Number, height: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("control"),
    canOperate: Schema.Boolean,
    controller: HostedBlenderController,
  }),
  Schema.Struct({
    type: Schema.Literal("stats"),
    encoder: Schema.String,
    target: Schema.Literals(["window", "output"]),
    memoryBytes: Schema.NullOr(Schema.Number),
  }),
]);
export type BlenderStreamMessage = typeof BlenderStreamMessage.Type;

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(BlenderStreamMessage));

/** A message the WebView posted, or null when it isn't one. */
export const blenderStreamMessage = (data: string): BlenderStreamMessage | null =>
  Option.getOrNull(decodeMessage(data));

export type BlenderViewerStatus = Extract<
  BlenderStreamMessage,
  { readonly type: "status" }
>["status"];

/** One WebView's stream: `viewer` keys the WebView and its single-use ticket. */
export interface BlenderViewer {
  readonly viewer: string;
  readonly status: BlenderViewerStatus;
  /** Tickets refreshed since the stream was last live. */
  readonly refreshes: number;
}

export type BlenderViewerEvent =
  | { readonly type: "status"; readonly status: BlenderViewerStatus }
  /** The upgrade was refused: try a fresh ticket in a new viewer. */
  | { readonly type: "unauthorized"; readonly viewer: string }
  | { readonly type: "reconnect"; readonly viewer: string };

// A refusal that keeps coming back is not an expired ticket; stop and offer Reconnect.
const MAX_TICKET_REFRESHES = 3;

export const initialBlenderViewer = (viewer: string): BlenderViewer => ({
  viewer,
  status: "connecting",
  refreshes: 0,
});

export function blenderViewerReducer(
  state: BlenderViewer,
  event: BlenderViewerEvent,
): BlenderViewer {
  switch (event.type) {
    case "status":
      return {
        ...state,
        status: event.status,
        refreshes: event.status === "live" ? 0 : state.refreshes,
      };
    case "unauthorized":
      return state.refreshes >= MAX_TICKET_REFRESHES
        ? { ...state, status: "error" }
        : { viewer: event.viewer, status: "connecting", refreshes: state.refreshes + 1 };
    case "reconnect":
      return initialBlenderViewer(event.viewer);
  }
}
