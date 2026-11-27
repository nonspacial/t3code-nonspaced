import type { RunId } from "@t3tools/contracts";
import { msg } from "gt-react";
import { BoxIcon } from "lucide-react";

import { m, type MessageResolver } from "../../i18n/messages";
import type { TimelineEntry } from "../../session-logic";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";

// Claude names MCP tools `mcp__<server>__<tool>`, Codex `<server>.<tool>`. The user's own
// `blender` entry drives their desktop Blender and doesn't count.
const HOSTED_BLENDER_TOOL = /^(?:mcp__blender-(?:hosted|master)__|blender-(?:hosted|master)\.)/;

export const isHostedBlenderToolName = (name: string | null | undefined): boolean =>
  name != null && HOSTED_BLENDER_TOOL.test(name);

/** Whether the running turn's agent is in the middle of a call to a hosted Blender. */
export function agentWorkingInBlender(
  entries: ReadonlyArray<TimelineEntry>,
  runningRunId: RunId | null,
): boolean {
  if (runningRunId === null) return false;
  // Newest first, and only as far back as the running turn.
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.kind !== "work") continue;
    if (entry.entry.runId != null && entry.entry.runId !== runningRunId) return false;
    const payload = entry.entry.structuredPayload;
    if (
      entry.entry.toolLifecycleStatus === "inProgress" &&
      payload?.type === "dynamic_tool" &&
      isHostedBlenderToolName(payload.toolName)
    ) {
      return true;
    }
  }
  return false;
}

/** "Working in Blender" while the agent's Blender call runs, with Stop for whoever may stop it. */
export function workingInBlenderBannerItem(
  input: { readonly onStop: (() => void) | null },
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  const onStop = input.onStop;
  return {
    id: "working-in-blender",
    variant: "info",
    icon: <BoxIcon aria-hidden="true" />,
    title: resolve(msg("Working in Blender")),
    ...(onStop === null
      ? {}
      : {
          actions: (
            <Button size="xs" variant="ghost" onClick={onStop}>
              {resolve(msg("Stop"))}
            </Button>
          ),
        }),
  };
}
