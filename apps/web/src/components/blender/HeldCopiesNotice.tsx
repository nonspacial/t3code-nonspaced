import { useAtomValue } from "@effect/atom-react";
import type { HostedBlenderHeldBehind, ScopedThreadRef } from "@t3tools/contracts";
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
import { formatBytes } from "~/lib/formatBytes";
import { fileName } from "./useQuitHostedBlender";
import { hostedBlenderEnvironment } from "~/state/hostedBlender";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

/** The date a held copy goes anyway, in the host's regional format. */
export const heldExpiryDate = (expiresAt: number) =>
  new Date(expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" });

/**
 * Asks before held working copies are deleted for good, naming them. `behind`: their master has
 * changed since, and T3 Code can't tell whether their threads' work reached it.
 */
export function ConfirmHeldDelete(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly count: number;
  readonly threads: string;
  readonly master: string;
  readonly behind: boolean;
  readonly pending: boolean;
  readonly onDelete: () => void;
}) {
  const gt = useGT();
  const { count, threads, master } = props;
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {gt(
              "{count, plural, =1 {Delete the working copy from {threads}?} other {Delete {count} working copies from {threads}?}}",
              { count, threads },
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {props.behind
              ? gt(
                  "{count, plural, =1 {{master} has changed since T3 Code held this copy, but T3 Code can't tell whether that thread's work reached it. Deleting the copy can't be undone.} other {{master} has changed since T3 Code held these copies, but T3 Code can't tell whether those threads' work reached it. Deleting them can't be undone.}}",
                  { count, master },
                )
              : gt(
                  "The thread can't pick this copy up again once it's deleted. This can't be undone.",
                )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button variant="destructive" size="sm" disabled={props.pending} onClick={props.onDelete}>
            <T context="deletes held working copies">Delete</T>
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/**
 * Asked once the master has changed since other threads' working copies of it were held: T3 Code
 * can't tell whether their work reached the master. Delete asks first; Keep stops the question.
 */
export function HeldCopiesNotice(props: {
  readonly threadRef: ScopedThreadRef;
  readonly behind: HostedBlenderHeldBehind;
}) {
  const gt = useGT();
  const m = useMessages();
  const environmentId = props.threadRef.environmentId;
  const canAnswer = useAtomValue(hostedBlenderEnvironment.deleteHeld.permissionAtom(environmentId));
  const deleteHeld = useAtomCommand(hostedBlenderEnvironment.deleteHeld, { reportFailure: false });
  const keepHeld = useAtomCommand(hostedBlenderEnvironment.keepHeld, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const answer = async (keep: boolean) => {
    setPending(true);
    const input = { environmentId, input: { copies: props.behind.copies } };
    const result = await (keep ? keepHeld(input) : deleteHeld(input));
    setPending(false);
    setConfirming(false);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Couldn't change the held working copies"),
          description: formatEnvironmentQueryError(result.cause, m),
        }),
      );
    }
  };
  const threads =
    props.behind.threadTitles.length > 0
      ? props.behind.threadTitles.join(", ")
      : gt("Unknown thread");
  const count = props.behind.copies.length;
  const master = fileName(props.behind.master);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-info/8 px-3 py-1.5 text-info-foreground text-xs">
      <span className="min-w-0 flex-1">
        {gt(
          "{count, plural, =1 {{master} has changed since T3 Code held the working copy of it from {threads} ({size}). T3 Code can't tell whether that thread's work reached the master. Delete it, or keep it until {date}.} other {{master} has changed since T3 Code held {count} working copies of it from {threads} ({size}). T3 Code can't tell whether those threads' work reached the master. Delete them, or keep them until {date}.}}",
          {
            count,
            master,
            threads,
            size: formatBytes(props.behind.bytes),
            date: heldExpiryDate(props.behind.expiresAt),
          },
        )}
      </span>
      {canAnswer ? (
        <span className="flex gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            <T context="deletes held working copies">Delete</T>
          </Button>
          <Button size="xs" variant="ghost" disabled={pending} onClick={() => void answer(true)}>
            <T context="keeps held working copies">Keep</T>
          </Button>
        </span>
      ) : null}
      <ConfirmHeldDelete
        open={confirming}
        onOpenChange={setConfirming}
        count={count}
        threads={threads}
        master={master}
        behind
        pending={pending}
        onDelete={() => void answer(false)}
      />
    </div>
  );
}
