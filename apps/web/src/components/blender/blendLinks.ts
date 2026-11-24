import type { HostedBlenderThreadState, ScopedThreadRef } from "@t3tools/contracts";
import type { ModelView } from "@t3tools/shared/modelView";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { rightPanelHostRef, useRightPanelStore } from "~/rightPanelStore";
import { readHostedBlenderState, setHostedBlenderView } from "~/state/hostedBlender";

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
 * the thread's Blender takes a round trip, so a newer action in the panel meanwhile wins. A
 * `#view=` link moves the person's viewport window there; `openFile` carries it to the preview.
 */
export async function openBlendLink(input: {
  readonly threadRef: ScopedThreadRef;
  readonly path: string;
  readonly workspaceRoot: string | undefined;
  readonly view?: ModelView | undefined;
  readonly openFile: () => void;
  readonly readState?: (threadRef: ScopedThreadRef) => Promise<HostedBlenderThreadState | null>;
  readonly setView?: typeof setHostedBlenderView;
}): Promise<void> {
  const panels = useRightPanelStore.getState();
  const panelRef = rightPanelHostRef(input.threadRef);
  const panelKey = scopedThreadKey(panelRef);
  const revision = panels.markUserAction(panelRef);
  // Each round trip gives the panel time to move on; a newer action there wins.
  const superseded = () =>
    scopedThreadKey(rightPanelHostRef(input.threadRef)) !== panelKey ||
    useRightPanelStore.getState().getUserActionRevision(panelRef) !== revision;
  const state = await (input.readState ?? readHostedBlenderState)(input.threadRef);
  if (superseded()) return;
  if (!hostedBlenderOpensLink(input.path, input.workspaceRoot, state)) {
    input.openFile();
    return;
  }
  const moved = input.view
    ? await (input.setView ?? setHostedBlenderView)(
        input.threadRef,
        workspaceRelative(input.path, input.workspaceRoot),
        input.view,
      )
    : "moved";
  if (superseded()) return;
  // The state read may be from before a reconnect; the server has the last word on the file.
  if (moved === "otherFile") input.openFile();
  else useRightPanelStore.getState().open(input.threadRef, "blender");
}
