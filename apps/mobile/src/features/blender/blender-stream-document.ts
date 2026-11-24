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
