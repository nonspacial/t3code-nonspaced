import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { BoxIcon } from "lucide-react";
import { useGT, useMessages } from "gt-react";
import { useState } from "react";

import { PreviewAction } from "~/components/files/previewChrome";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useRightPanelStore } from "~/rightPanelStore";
import { hostedBlenderEnvironment, useHostedBlenderState } from "~/state/hostedBlender";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

export const isBlendFile = (relativePath: string) => relativePath.toLowerCase().endsWith(".blend");

/** Opens a workspace `.blend` in the thread's hosted Blender, then shows the Blender pane. */
export function OpenInHostedBlender(props: {
  readonly threadRef: ScopedThreadRef;
  readonly relativePath: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const state = useHostedBlenderState(props.threadRef);
  const canOpen = useAtomValue(
    hostedBlenderEnvironment.open.permissionAtom(props.threadRef.environmentId),
  );
  const open = useAtomCommand(hostedBlenderEnvironment.open, { reportFailure: false });
  const [pending, setPending] = useState(false);
  if (!canOpen || state === null || state.status === "unavailable") return null;

  const showPane = () => useRightPanelStore.getState().open(props.threadRef, "blender");
  const openFile = async () => {
    // The pane explains what's missing; there is nothing to start yet.
    if (state.status === "notSetUp") return showPane();
    setPending(true);
    const result = await open({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, relativePath: props.relativePath },
    });
    setPending(false);
    if (result._tag === "Success") return showPane();
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: gt("Couldn't open in hosted Blender"),
        description: formatEnvironmentQueryError(result.cause, m),
      }),
    );
  };

  return (
    <PreviewAction
      label={gt("Open in hosted Blender")}
      disabled={pending}
      onPress={() => void openFile()}
    >
      <BoxIcon />
    </PreviewAction>
  );
}
