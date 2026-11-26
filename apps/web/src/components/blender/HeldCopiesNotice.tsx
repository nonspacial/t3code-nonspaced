import { useAtomValue } from "@effect/atom-react";
import type { HostedBlenderHeldBehind, ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

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
 * Asked once the master has changed since other threads' working copies of it were held: they
 * are of an edition the person has moved past. Delete removes them; Keep stops the question.
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
  const answer = async (keep: boolean) => {
    setPending(true);
    const input = { environmentId, input: { copies: props.behind.copies } };
    const result = await (keep ? keepHeld(input) : deleteHeld(input));
    setPending(false);
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
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-info/8 px-3 py-1.5 text-info-foreground text-xs">
      <span className="min-w-0 flex-1">
        {gt(
          "{count, plural, =1 {{master} has changed since T3 Code held the working copy of it from {threads} ({size}). That copy holds an edition you've moved past. Delete it now, or keep it until {date}.} other {{master} has changed since T3 Code held {count} working copies of it from {threads} ({size}). They hold an edition you've moved past. Delete them now, or keep them until {date}.}}",
          {
            count: props.behind.copies.length,
            master: fileName(props.behind.master),
            threads,
            size: formatBytes(props.behind.bytes),
            date: heldExpiryDate(props.behind.expiresAt),
          },
        )}
      </span>
      {canAnswer ? (
        <span className="flex gap-2">
          <Button size="xs" variant="outline" disabled={pending} onClick={() => void answer(false)}>
            <T context="deletes held working copies">Delete</T>
          </Button>
          <Button size="xs" variant="ghost" disabled={pending} onClick={() => void answer(true)}>
            <T context="keeps held working copies">Keep</T>
          </Button>
        </span>
      ) : null}
    </div>
  );
}
