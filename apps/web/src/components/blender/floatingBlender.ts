import type { HostedBlenderThreadState } from "@t3tools/contracts";

import type { PreviewMiniPlayerSource } from "../../previewMiniPlayerStore";

export interface FloatingBlenderInput {
  readonly runningTurnId: string | null;
  /** The turn this was last decided for; each turn floats the pane at most once. */
  readonly decidedTurnId: string | null;
  readonly state: HostedBlenderThreadState | null;
  /** Null until the saved settings have loaded. */
  readonly autoShowFloatingPreview: boolean | null;
  /** What already floats over this thread's chat. */
  readonly floating: PreviewMiniPlayerSource | null;
  /** The Blender pane is the right panel's shown tab. */
  readonly panelShown: boolean;
}

const isUp = (
  state: HostedBlenderThreadState | null,
): state is Extract<HostedBlenderThreadState, { readonly status: "starting" | "running" }> =>
  state?.status === "starting" || state?.status === "running";

const agentActs = (state: HostedBlenderThreadState | null) =>
  isUp(state) && state.agentActing === true;

/**
 * Once the agent acts in a thread's hosted Blender during a turn, the Blender pane floats over chat,
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
    !agentActs(input.state) ||
    input.autoShowFloatingPreview === null
  ) {
    return { action: "none", decidedTurnId: input.decidedTurnId };
  }
  const float = input.autoShowFloatingPreview && input.floating === null && !input.panelShown;
  return { action: float ? "float" : "none", decidedTurnId: input.runningTurnId };
}

// Per scoped thread, so a float the user closed stays closed while they visit other threads.
const decidedTurns = new Map<string, string>();

/** `floatingBlenderAction` for `threadKey`, remembering which turn it last decided. */
export function decideFloatingBlender(
  threadKey: string,
  input: Omit<FloatingBlenderInput, "decidedTurnId">,
): "float" | "close" | "none" {
  const { action, decidedTurnId } = floatingBlenderAction({
    ...input,
    decidedTurnId: decidedTurns.get(threadKey) ?? null,
  });
  if (decidedTurnId !== null) decidedTurns.set(threadKey, decidedTurnId);
  return action;
}

export function resetFloatingBlenderDecisionsForTests(): void {
  decidedTurns.clear();
}
