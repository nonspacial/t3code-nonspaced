import type { HostedBlenderThreadState, ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";
import { readHostedBlenderState } from "~/state/hostedBlender";

const workspaceRelative = (path: string, workspaceRoot: string | undefined) => {
  const root = workspaceRoot?.replace(/\/+$/, "");
  const relative =
    root !== undefined && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  return relative.replace(/^(\.\/)+/, "");
};

/** A `.blend` link shows the Blender pane only when that file is open in the thread's Blender. */
export const hostedBlenderOpensLink = (
  path: string,
  workspaceRoot: string | undefined,
  state: HostedBlenderThreadState | null,
): boolean =>
  state !== null &&
  (state.status === "starting" || state.status === "running") &&
  state.relativePath === workspaceRelative(path, workspaceRoot);

/** Opens a chat link to a `.blend` in the Blender pane, or in the file preview otherwise. */
export async function openBlendLink(
  threadRef: ScopedThreadRef,
  path: string,
  workspaceRoot: string | undefined,
  openFile: () => void,
): Promise<void> {
  const state = await readHostedBlenderState(threadRef);
  if (hostedBlenderOpensLink(path, workspaceRoot, state)) {
    useRightPanelStore.getState().open(threadRef, "blender");
  } else {
    openFile();
  }
}
