import { blendFileName, quitFileOf } from "@t3tools/client-runtime/state/hosted-blender";
import type { HostedBlenderKeptFile, ScopedThreadRef } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { T, useGT, useMessages } from "gt-react";
import { useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { hostedBlenderEnvironment, isOpenFileChanged } from "~/state/hostedBlender";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

export const fileName = (relativePath: string) =>
  relativePath.slice(relativePath.lastIndexOf("/") + 1);

/** What a quit names: the running Blender's launch file and, once Blender has said, its open one. */
export interface QuitFile {
  readonly relativePath: string;
  readonly openFile?: HostedBlenderKeptFile | undefined;
}

/**
 * Quitting a thread's hosted Blender, asking first whether to save a file with changes, named
 * as the file Blender has open now. `target` picks its master Blender, or a master by its key
 * when no thread uses it.
 */
export function useQuitHostedBlender(
  threadRef: ScopedThreadRef,
  file: QuitFile,
  target: { readonly role?: "master"; readonly master?: string } = {},
) {
  const gt = useGT();
  const m = useMessages();
  const quit = useAtomCommand(hostedBlenderEnvironment.quit, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  // Chosen while a Save and quit waited in a busy Blender, which the discard then ended.
  const discarded = useRef(false);
  const name = blendFileName(quitFileOf(file), gt("Untitled scene"));
  const report = (cause: Cause.Cause<unknown>) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: gt("Couldn't quit Blender"),
        description: formatEnvironmentQueryError(cause, m),
      }),
    );
  const saveAndQuit = async () => {
    setSaving(true);
    discarded.current = false;
    const result = await quit({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, save: true, ...target },
    });
    setSaving(false);
    if (discarded.current) return;
    setConfirming(false);
    if (result._tag === "Failure") report(result.cause);
  };
  // `discard` only from the dialog's Quit without saving, naming the file it showed: a file
  // believed clean may have changed since its last report, and the server then keeps what
  // Blender says is unsaved.
  const quitWithoutSaving = async (discard: boolean) => {
    setDiscarding(true);
    discarded.current = discard;
    const result = await quit({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        save: false,
        ...(discard
          ? { discard, ...(file.openFile === undefined ? {} : { openFile: file.openFile }) }
          : {}),
        ...target,
      },
    });
    setDiscarding(false);
    // Blender has another file open now: the dialog stays, naming that one.
    if (result._tag === "Failure" && isOpenFileChanged(result.cause)) {
      discarded.current = false;
      return;
    }
    setConfirming(false);
    if (result._tag === "Failure") report(result.cause);
  };
  return {
    quitting: saving || discarding,
    request: (dirty: boolean) => (dirty ? setConfirming(true) : void quitWithoutSaving(false)),
    dialog: (
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {gt("Save changes to {name} before quitting?", { name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>Changes Blender hasn't saved are lost if you quit without saving.</T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            {/* Open while a save waits in a busy Blender: the way out of a save that never ends. */}
            <Button
              variant="outline"
              size="sm"
              disabled={discarding}
              onClick={() => void quitWithoutSaving(true)}
            >
              <T>Quit without saving</T>
            </Button>
            <Button size="sm" disabled={saving || discarding} onClick={() => void saveAndQuit()}>
              <T>Save and quit</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    ),
  };
}
