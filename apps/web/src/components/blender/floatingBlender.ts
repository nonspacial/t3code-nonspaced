import type { HostedBlenderThreadState } from "@t3tools/contracts";

import type { PreviewMiniPlayerSource } from "../../previewMiniPlayerStore";

export interface FloatingBlenderInput {
  readonly runningTurnId: string | null;
  /** The turn this was last decided for; each turn floats the pane at most once. */
  readonly decidedTurnId: string | null;
  readonly state: HostedBlenderThreadState | null;
  readonly autoShowFloatingPreview: boolean;
  /** What already floats over this thread's chat. */
  readonly floating: PreviewMiniPlayerSource | null;
  /** The Blender pane is the right panel's shown tab. */
  readonly panelShown: boolean;
}

const isUp = (state: HostedBlenderThreadState | null) =>
  state?.status === "starting" || state?.status === "running";

/**
 * While an agent works in a thread with a hosted Blender, the Blender pane floats over chat,
 * as an agent-opened device does. Each turn decides once, so a pane the user closed stays closed
 * until the next turn, and a browser or device already floating keeps its place. A floating pane
 * whose Blender stopped closes.
 */
export function floatingBlenderAction(input: FloatingBlenderInput): {
  readonly action: "float" | "close" | "none";
  readonly decidedTurnId: string | null;
} {
  if (input.floating?.kind === "blender" && input.state !== null && !isUp(input.state)) {
    return { action: "close", decidedTurnId: input.decidedTurnId };
  }
  if (
    input.runningTurnId === null ||
    input.runningTurnId === input.decidedTurnId ||
    !isUp(input.state)
  ) {
    return { action: "none", decidedTurnId: input.decidedTurnId };
  }
  const float = input.autoShowFloatingPreview && input.floating === null && !input.panelShown;
  return { action: float ? "float" : "none", decidedTurnId: input.runningTurnId };
}
