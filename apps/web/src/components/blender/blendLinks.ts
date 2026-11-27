import type {
  HostedBlenderMasterState,
  HostedBlenderThreadState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { ModelView } from "@t3tools/shared/modelView";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { rightPanelHostRef, useRightPanelStore } from "~/rightPanelStore";
import { readEnvironmentHostedBlenderEnabled } from "~/state/entities";
import {
  readHostedBlenderMasterState,
  readHostedBlenderState,
  setHostedBlenderView,
} from "~/state/hostedBlender";

import { useBlenderRoleStore } from "./blenderRole";

import { keptCopyOf, showKeptCopy } from "./keptCopies";

export const isBlendFile = (relativePath: string) => relativePath.toLowerCase().endsWith(".blend");

const workspaceRelative = (path: string, workspaceRoot: string | undefined) => {
  const root = workspaceRoot?.replace(/\/+$/, "");
  const relative =
    root !== undefined && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  return relative.replace(/^(\.\/)+/, "");
};

/**
 * A `.blend` link shows the Blender pane only when that file is open in the thread's Blender, or
 * a closed or crashed one kept a copy of it, whose card the pane then shows.
 */
export const hostedBlenderOpensLink = (
  path: string,
  workspaceRoot: string | undefined,
  state: HostedBlenderThreadState | HostedBlenderMasterState | null,
): boolean => {
  if (state === null) return false;
  const relativePath = workspaceRelative(path, workspaceRoot);
  if (state.status === "starting" || state.status === "running") {
    return state.relativePath === relativePath;
  }
  return keptCopyOf(state, relativePath) !== undefined;
};

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
  readonly readMasterState?: (
    threadRef: ScopedThreadRef,
  ) => Promise<HostedBlenderMasterState | null>;
  readonly setView?: typeof setHostedBlenderView;
  readonly hostedBlenderEnabled?: boolean;
}): Promise<void> {
  // Without Hosted Blender on, no Blender can have the file: no state is asked for.
  if (
    !(
      input.hostedBlenderEnabled ??
      readEnvironmentHostedBlenderEnabled(input.threadRef.environmentId)
    )
  ) {
    input.openFile();
    return;
  }
  const panels = useRightPanelStore.getState();
  const panelRef = rightPanelHostRef(input.threadRef);
  const panelKey = scopedThreadKey(panelRef);
  const revision = panels.markUserAction(panelRef);
  // Each round trip gives the panel time to move on; a newer action there wins.
  const superseded = () =>
    scopedThreadKey(rightPanelHostRef(input.threadRef)) !== panelKey ||
    useRightPanelStore.getState().getUserActionRevision(panelRef) !== revision;
  const [state, master] = await Promise.all([
    (input.readState ?? readHostedBlenderState)(input.threadRef),
    (input.readMasterState ?? readHostedBlenderMasterState)(input.threadRef),
  ]);
  if (superseded()) return;
  // The working copy's own side first; a link to the master's file opens the Master side.
  const role = hostedBlenderOpensLink(input.path, input.workspaceRoot, state)
    ? "working"
    : hostedBlenderOpensLink(input.path, input.workspaceRoot, master)
      ? "master"
      : null;
  if (role === null) {
    input.openFile();
    return;
  }
  showKeptCopy(input.threadRef, state, workspaceRelative(input.path, input.workspaceRoot));
  const moved = input.view
    ? await (input.setView ?? setHostedBlenderView)(
        input.threadRef,
        workspaceRelative(input.path, input.workspaceRoot),
        input.view,
        role,
      )
    : "moved";
  if (superseded()) return;
  // The state read may be from before a reconnect; the server has the last word on the file.
  if (moved === "otherFile") {
    input.openFile();
    return;
  }
  useBlenderRoleStore.getState().setRole(input.threadRef, role);
  useRightPanelStore.getState().open(input.threadRef, "blender");
}
