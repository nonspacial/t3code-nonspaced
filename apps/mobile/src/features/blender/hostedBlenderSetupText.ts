import type { HostedBlenderRequirement } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

/** Why a phone can't show a hosted Blender yet; setting it up happens on web or desktop. */
export function notSetUpDetail(
  missing: ReadonlyArray<HostedBlenderRequirement>,
  resolve: MessageResolver = m,
): string {
  if (missing.includes("enabled")) {
    return resolve(
      msg(
        "Hosted Blender is switched off. Switch it on in Settings › Blender in T3 Code on the web or desktop.",
      ),
    );
  }
  if (missing.includes("check")) {
    return resolve(
      msg(
        "T3 Code hasn't checked this server yet. Check it in Settings › Blender in T3 Code on the web or desktop.",
      ),
    );
  }
  const names: Record<Exclude<HostedBlenderRequirement, "enabled" | "check">, string> = {
    blender: "Blender",
    labwc: "labwc",
    helper: resolve(msg("T3 Code's hidden display helper")),
    gstreamer: "GStreamer",
    encoder: resolve(msg("an H.264 encoder")),
    glupload: resolve(msg("GStreamer's OpenGL plugin")),
  };
  const list = missing
    .filter((requirement) => requirement !== "enabled" && requirement !== "check")
    .map((requirement) => names[requirement])
    .join(", ");
  return resolve(
    msg("This server is missing: {list}. Install them on the server, then open this again.", {
      list,
    }),
  );
}
