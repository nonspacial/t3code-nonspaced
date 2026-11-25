import type { ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

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
import { hostedBlenderEnvironment } from "~/state/hostedBlender";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

export const fileName = (relativePath: string) =>
  relativePath.slice(relativePath.lastIndexOf("/") + 1);

/**
 * Quitting a thread's hosted Blender, asking first whether to save a file with changes. `target`
 * picks its master Blender, or a master by its key when no thread uses it.
 */
export function useQuitHostedBlender(
  threadRef: ScopedThreadRef,
  name: string,
  target: { readonly role?: "master"; readonly master?: string } = {},
) {
  const gt = useGT();
  const m = useMessages();
  const quit = useAtomCommand(hostedBlenderEnvironment.quit, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const quitBlender = async (save: boolean) => {
    setQuitting(true);
    const result = await quit({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, save, ...target },
    });
    setQuitting(false);
    setConfirming(false);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Couldn't quit Blender"),
          description: formatEnvironmentQueryError(result.cause, m),
        }),
      );
    }
  };
  return {
    quitting,
    request: (dirty: boolean) => (dirty ? setConfirming(true) : void quitBlender(false)),
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
            <Button
              variant="outline"
              size="sm"
              disabled={quitting}
              onClick={() => void quitBlender(false)}
            >
              <T>Quit without saving</T>
            </Button>
            <Button size="sm" disabled={quitting} onClick={() => void quitBlender(true)}>
              <T>Save and quit</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    ),
  };
}
