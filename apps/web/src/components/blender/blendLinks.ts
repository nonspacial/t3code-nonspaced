import type { HostedBlenderThreadState, ScopedThreadRef } from "@t3tools/contracts";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { rightPanelHostRef, useRightPanelStore } from "~/rightPanelStore";
import { readHostedBlenderState } from "~/state/hostedBlender";

export const isBlendFile = (relativePath: string) => relativePath.toLowerCase().endsWith(".blend");

const workspaceRelative = (path: string, workspaceRoot: string | undefined) => {
  const root = workspaceRoot?.replace(/\/+$/, "");
  const relative =
    root !== undefined && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  return relative.replace(/^(\.\/)+/, "");
};

/**
 * A `.blend` link shows the Blender pane only when that file is open in the thread's Blender, or
 * was open in one that closed or crashed, whose pane offers to reopen it.
 */
export const hostedBlenderOpensLink = (
  path: string,
  workspaceRoot: string | undefined,
  state: HostedBlenderThreadState | null,
): boolean =>
  state !== null &&
  "relativePath" in state &&
  state.relativePath === workspaceRelative(path, workspaceRoot);

/**
 * Opens a chat link to a `.blend` in the Blender pane, or in the file preview otherwise. Reading
 * the thread's Blender takes a round trip, so a newer action in the panel meanwhile wins.
 */
export async function openBlendLink(input: {
  readonly threadRef: ScopedThreadRef;
  readonly path: string;
  readonly workspaceRoot: string | undefined;
  readonly openFile: () => void;
  readonly readState?: (threadRef: ScopedThreadRef) => Promise<HostedBlenderThreadState | null>;
}): Promise<void> {
  const panels = useRightPanelStore.getState();
  const panelRef = rightPanelHostRef(input.threadRef);
  const panelKey = scopedThreadKey(panelRef);
  const revision = panels.markUserAction(panelRef);
  const state = await (input.readState ?? readHostedBlenderState)(input.threadRef);
  const latest = useRightPanelStore.getState();
  if (
    scopedThreadKey(rightPanelHostRef(input.threadRef)) !== panelKey ||
    latest.getUserActionRevision(panelRef) !== revision
  ) {
    return;
  }
  if (hostedBlenderOpensLink(input.path, input.workspaceRoot, state)) {
    latest.open(input.threadRef, "blender");
  } else {
    input.openFile();
  }
}
