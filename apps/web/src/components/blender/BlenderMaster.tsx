import { useAtomValue } from "@effect/atom-react";
import type {
  HostedBlenderMasterState,
  HostedBlenderRole,
  HostedBlenderThreadState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

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
import { hostedBlenderEnvironment } from "~/state/hostedBlender";
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
