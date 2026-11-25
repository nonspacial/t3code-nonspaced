import { useAtomValue } from "@effect/atom-react";
import type {
  HostedBlenderMasterState,
  HostedBlenderReloadBlocker,
  HostedBlenderRole,
  HostedBlenderThreadState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import { hostedBlenderEnvironment, isRestoreReplacingUnsaved } from "~/state/hostedBlender";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

type Dot = "running" | "starting" | "failed" | "off";

const dotFor = (state: HostedBlenderThreadState | HostedBlenderMasterState | null): Dot => {
  switch (state?.status) {
    case "running":
    case "starting":
    case "failed":
      return state.status;
    default:
      return "off";
  }
};

function StatusDot(props: { readonly dot: Dot }) {
  return (
    <span
      aria-hidden
      className={cn(
        "me-1.5 size-1.5 shrink-0 rounded-full",
        props.dot === "running"
          ? "bg-success"
          : props.dot === "starting"
            ? "bg-warning"
            : props.dot === "failed"
              ? "bg-destructive"
              : "bg-muted-foreground/40",
      )}
    />
  );
}

/** Working copy / Master, each with a dot for whether its Blender runs. */
export function BlenderRoleSwitch(props: {
  readonly role: HostedBlenderRole;
  readonly onRole: (role: HostedBlenderRole) => void;
  readonly working: HostedBlenderThreadState | null;
  readonly master: HostedBlenderMasterState | null;
}) {
  const gt = useGT();
  return (
    <ToggleGroup
      aria-label={gt("Which Blender to show")}
      className="shrink-0"
      value={[props.role]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "working" || value === "master") props.onRole(value);
      }}
    >
      <Toggle value="working">
        <StatusDot dot={dotFor(props.working)} />
        <T>Working copy</T>
      </Toggle>
      <Toggle value="master">
        <StatusDot dot={dotFor(props.master)} />
        <T context="the master .blend file">Master</T>
      </Toggle>
    </ToggleGroup>
  );
}

/** Over a running master: a desktop Blender T3 Code couldn't ask may have the file open too. */
export function DesktopUncheckedNotice() {
  return (
    <div className="shrink-0 border-b border-border bg-warning/8 px-3 py-1.5 text-warning-foreground text-xs">
      <T>
        A desktop Blender T3 Code couldn't check may also have this file open. Save and close it
        there so the two don't overwrite each other.
      </T>
    </div>
  );
}

/**
 * Over a running Blender that reloaded its file after it changed on disk: its unsaved changes
 * are that file's copy, which Restore puts back over the reloaded file.
 */
export function ReloadedNotice(props: {
  readonly threadRef: ScopedThreadRef;
  /** The kept copy's key, which names its file: `workspace:<path>` or `outside:<path>`. */
  readonly copyKey: string;
  readonly master: boolean;
  readonly onDismiss: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { environmentId, threadId } = props.threadRef;
  const canRestore = useAtomValue(hostedBlenderEnvironment.reopen.permissionAtom(environmentId));
  const reopen = useAtomCommand(hostedBlenderEnvironment.reopen, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const name = fileName(props.copyKey.slice(props.copyKey.indexOf(":") + 1));
  // Unsaved work since the reload is replaced only once the person agrees; it becomes the copy.
  const restore = async (replaceUnsaved: boolean) => {
    setPending(true);
    const result = await reopen({
      environmentId,
      input: {
        threadId,
        key: props.copyKey,
        restore: true,
        ...(replaceUnsaved ? { replaceUnsaved: true } : {}),
        ...(props.master ? { role: "master" as const } : {}),
      },
    });
    setPending(false);
    setConfirming(false);
    if (result._tag === "Failure" && !replaceUnsaved && isRestoreReplacingUnsaved(result.cause)) {
      setConfirming(true);
      return;
    }
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Couldn't restore the changes"),
          description: formatEnvironmentQueryError(result.cause, m),
        }),
      );
    }
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-info/8 px-3 py-1.5 text-info-foreground text-xs">
      <span className="min-w-0 flex-1">
        <T>
          <Var>{name}</Var> changed on disk, so Blender reloaded it. Its unsaved changes are kept as
          a recovery copy.
        </T>
      </span>
      {canRestore ? (
        <Button size="xs" variant="outline" disabled={pending} onClick={() => void restore(false)}>
          <T>Restore changes</T>
        </Button>
      ) : null}
      <Button size="xs" variant="ghost" onClick={props.onDismiss}>
        <T>Dismiss</T>
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {gt("Replace the unsaved changes to {name}?", { name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                Blender has changes since it reloaded the file. Restoring puts the kept changes back
                and keeps these as the recovery copy instead, so you can restore them again.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button size="sm" disabled={pending} onClick={() => void restore(true)}>
              <T>Restore changes</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/** Over a running Blender whose file changed on disk but isn't loaded yet, and what holds it. */
export function ReloadBlockedNotice(props: {
  readonly name: string;
  readonly blocker: HostedBlenderReloadBlocker;
}) {
  const name = props.name;
  return (
    <div className="shrink-0 border-b border-border bg-warning/8 px-3 py-1.5 text-warning-foreground text-xs">
      {props.blocker === "agentWork" ? (
        <T>
          <Var>{name}</Var> changed on disk. Blender loads it once the agent's work running in it
          has finished.
        </T>
      ) : props.blocker === "images" ? (
        <T>
          <Var>{name}</Var> changed on disk. Blender loads it once its unsaved image edits are saved
          or discarded, since a recovery copy can't keep them.
        </T>
      ) : props.blocker === "catalogs" ? (
        <T>
          <Var>{name}</Var> changed on disk. Blender loads it once its unsaved asset catalog edits
          are saved or discarded, since a recovery copy can't keep them.
        </T>
      ) : props.blocker === "copyFailed" ? (
        <T>
          <Var>{name}</Var> changed on disk, but Blender couldn't keep its unsaved changes first, so
          it hasn't loaded the new version.
        </T>
      ) : (
        <T>
          <Var>{name}</Var> changed on disk, but Blender couldn't load the new version. It tries
          again when the file changes.
        </T>
      )}
    </div>
  );
}

const fileName = (relativePath: string) => relativePath.slice(relativePath.lastIndexOf("/") + 1);

/** The Master side while no master Blender shows it: open it, or move it from the desktop. */
export function MasterCard(props: {
  readonly threadRef: ScopedThreadRef;
  readonly state: Extract<HostedBlenderMasterState, { status: "notOpen" | "failed" }>;
}) {
  const gt = useGT();
  const m = useMessages();
  const { environmentId, threadId } = props.threadRef;
  const canOpen = useAtomValue(hostedBlenderEnvironment.openMaster.permissionAtom(environmentId));
  const canMove = useAtomValue(hostedBlenderEnvironment.moveIntoT3.permissionAtom(environmentId));
  const openMaster = useAtomCommand(hostedBlenderEnvironment.openMaster, { reportFailure: false });
  const moveIntoT3 = useAtomCommand(hostedBlenderEnvironment.moveIntoT3, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const name = fileName(props.state.relativePath);
  const run = async (action: "open" | "move") => {
    setBusy(true);
    // Move names the master shown, so a stale click can't move a different one.
    const result =
      action === "open"
        ? await openMaster({ environmentId, input: { threadId } })
        : await moveIntoT3({
            environmentId,
            input: { threadId, relativePath: props.state.relativePath },
          });
    setBusy(false);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title:
            action === "open" ? gt("Couldn't open the master") : gt("Couldn't move into T3 Code"),
          description: formatEnvironmentQueryError(result.cause, m),
        }),
      );
    }
  };
  const onDesktop = props.state.status === "notOpen" && props.state.desktop === "open";
  const action = onDesktop ? (
    canMove ? (
      <Button size="sm" disabled={busy} onClick={() => void run("move")}>
        <T>Move into T3 Code</T>
      </Button>
    ) : null
  ) : canOpen ? (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void run("open")}>
      <T>Open in T3 Code</T>
    </Button>
  ) : null;
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>
          {props.state.status === "failed" ? (
            <T>Blender didn't start</T>
          ) : onDesktop ? (
            <T>Open in your desktop Blender</T>
          ) : (
            <T>Master not open in T3 Code</T>
          )}
        </EmptyTitle>
        <EmptyDescription>
          <MasterDescription state={props.state} name={name} />
        </EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

function MasterDescription(props: {
  readonly state: Extract<HostedBlenderMasterState, { status: "notOpen" | "failed" }>;
  readonly name: string;
}) {
  const { state, name } = props;
  if (state.status === "failed") {
    return (
      <T>
        Blender couldn't open <Var>{name}</Var> on the hidden display. Check that Blender opens it,
        then open it again.
      </T>
    );
  }
  if (state.desktop === "open") {
    return state.desktopDirty ? (
      <T>
        Move into T3 Code saves <Var>{name}</Var> in your desktop Blender, with its unsaved changes,
        quits that Blender and opens the file here. Its undo history is lost.
      </T>
    ) : (
      <T>
        Move into T3 Code saves <Var>{name}</Var> in your desktop Blender, quits that Blender and
        opens the file here. Its undo history is lost.
      </T>
    );
  }
  if (state.desktop === "noAddon") {
    return (
      <T>
        A desktop Blender is running, but T3 Code can't reach its MCP add-on to see whether it has{" "}
        <Var>{name}</Var> open. Save and close the file there before opening it here.
      </T>
    );
  }
  return (
    <T>
      <Var>{name}</Var> isn't open in a master Blender. Agents copy their proven changes into it
      there.
    </T>
  );
}
