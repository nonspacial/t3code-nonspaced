import { useAtomValue } from "@effect/atom-react";
import { stillSavingText } from "@t3tools/client-runtime/state/hosted-blender";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { HostedBlenderError, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { BoxIcon } from "lucide-react";
import { useGT, useMessages } from "gt-react";
import { useState } from "react";

import { PreviewAction } from "~/components/files/previewChrome";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  hostedBlenderEnvironment,
  useHostedBlenderMasterState,
  useHostedBlenderState,
} from "~/state/hostedBlender";
import { keptCopyOf, showKeptCopy } from "./keptCopies";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { useBlenderRoleStore } from "./blenderRole";
import { fileName } from "./useQuitHostedBlender";

const isHostedBlenderError = Schema.is(HostedBlenderError);

/** Opens a workspace `.blend` in the thread's hosted Blender, then shows the Blender pane. */
export function OpenInHostedBlender(props: {
  readonly threadRef: ScopedThreadRef;
  readonly relativePath: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const state = useHostedBlenderState(props.threadRef);
  const master = useHostedBlenderMasterState(props.threadRef);
  const canOpen = useAtomValue(
    hostedBlenderEnvironment.open.permissionAtom(props.threadRef.environmentId),
  );
  const canOpenMaster = useAtomValue(
    hostedBlenderEnvironment.openMaster.permissionAtom(props.threadRef.environmentId),
  );
  const open = useAtomCommand(hostedBlenderEnvironment.open, { reportFailure: false });
  const openMaster = useAtomCommand(hostedBlenderEnvironment.openMaster, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  if (!canOpen || state === null || state.status === "unavailable") return null;

  const showPane = () => useRightPanelStore.getState().open(props.threadRef, "blender");
  // The thread's master file belongs to its master Blender, as a chat link to it shows.
  const isMaster =
    master !== null && master.status !== "none" && master.relativePath === props.relativePath;
  const showMaster = async () => {
    useBlenderRoleStore.getState().setRole(props.threadRef, "master");
    // As the Master side's Open in T3 Code; one on the desktop is left for that side to move.
    if (
      canOpenMaster &&
      (master?.status === "failed" || (master?.status === "notOpen" && master.desktop !== "open"))
    ) {
      setPending(true);
      const result = await openMaster({
        environmentId: props.threadRef.environmentId,
        input: { threadId: props.threadRef.threadId },
      });
      setPending(false);
      const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
      // A copy of the master was kept meanwhile: the Master side shows its card first.
      if (
        result._tag === "Failure" &&
        !(isHostedBlenderError(error) && error.reason === "recoveryPending")
      ) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Couldn't open the master"),
            description:
              stillSavingText(result.cause, fileName(props.relativePath), m) ??
              formatEnvironmentQueryError(result.cause, m),
          }),
        );
      }
    }
    showPane();
  };
  const openFile = async () => {
    if (isMaster) return showMaster();
    // Switched off, the pane says so. Otherwise opening checks the server, the first time or
    // again once when it wasn't ready (a busy GPU fails the test encode); it needs the same
    // permission.
    if (state.status === "notSetUp" && state.missing.includes("enabled")) return showPane();
    // The pane offers the unsaved changes a closed Blender kept of this file first.
    if (keptCopyOf(state, props.relativePath)?.recovery === true) {
      showKeptCopy(props.threadRef, state, props.relativePath);
      return showPane();
    }
    setPending(true);
    const result = await open({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, relativePath: props.relativePath },
    });
    setPending(false);
    if (result._tag === "Success") return showPane();
    // The first open checked the server and found something missing: the pane shows what.
    const error = squashAtomCommandFailure(result);
    if (
      isHostedBlenderError(error) &&
      (error.reason === "notSetUp" || error.reason === "unavailable")
    )
      return showPane();
    // A copy of this file was kept meanwhile: its card comes first.
    if (isHostedBlenderError(error) && error.reason === "recoveryPending") {
      showKeptCopy(props.threadRef, state, props.relativePath);
      return showPane();
    }
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: gt("Couldn't open in hosted Blender"),
        description:
          stillSavingText(result.cause, fileName(props.relativePath), m) ??
          formatEnvironmentQueryError(result.cause, m),
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
