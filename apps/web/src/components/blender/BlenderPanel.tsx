import { useAtomValue } from "@effect/atom-react";
import { createCanvasFrameSink } from "@t3tools/client-runtime/device/frame";
import {
  createHostedBlenderStreamClient,
  type HostedBlenderFrameRate,
  type HostedBlenderStreamStats,
  type HostedBlenderStreamStatus,
} from "@t3tools/client-runtime/hosted-blender/stream";
import type {
  EnvironmentId,
  HostedBlenderRequirement,
  HostedBlenderRunningState,
  HostedBlenderThreadState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { MoreVertical } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { formatBytes } from "~/lib/formatBytes";
import { observeResize } from "~/lib/observeResize";
import {
  hostedBlenderEnvironment,
  refreshHostedBlenderStreamAccess,
  useHostedBlenderState,
  useHostedBlenderStreamAccess,
} from "~/state/hostedBlender";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { fileName, useQuitHostedBlender } from "./useQuitHostedBlender";

interface StreamStats {
  readonly frameSize: { readonly width: number; readonly height: number } | null;
  readonly rate: HostedBlenderFrameRate | null;
  readonly server: HostedBlenderStreamStats | null;
}

/** The thread's hosted Blender, live and view-only. Closing the pane leaves Blender running. */
export function BlenderPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
}) {
  const state = useHostedBlenderState(props.threadRef);
  if (state === null) return <StateCard title={<Spinner />} />;
  switch (state.status) {
    case "unavailable":
      return (
        <StateCard
          title={<T>Not available on this host</T>}
          description={
            <T>
              Hosted Blender needs a Linux server. You can still open 3D files in the file preview.
            </T>
          }
        />
      );
    case "notSetUp":
      return (
        <StateCard
          title={<T>Hosted Blender isn't set up</T>}
          description={<MissingRequirements missing={state.missing} />}
        />
      );
    case "stopped":
      return (
        <StateCard
          title={<T>No hosted Blender running</T>}
          description={
            <T>Open a .blend file in the file preview and choose Open in hosted Blender.</T>
          }
        />
      );
    case "failed":
      return (
        <StateCard
          title={<T>Blender didn't start</T>}
          description={
            <T>
              Blender couldn't open the file on the hidden display. Check that Blender opens it and
              that GStreamer has an H.264 encoder, then open it in hosted Blender again.
            </T>
          }
        />
      );
    case "closed":
    case "crashed":
      return <ReopenCard threadRef={props.threadRef} state={state} />;
    case "starting":
    case "running":
      return <RunningBlender {...props} state={state} />;
  }
}

function StateCard(props: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.description ? <EmptyDescription>{props.description}</EmptyDescription> : null}
      </EmptyHeader>
      {props.actions ? (
        <EmptyContent className="flex-row flex-wrap justify-center">{props.actions}</EmptyContent>
      ) : null}
    </Empty>
  );
}

/** A Blender T3 closed, or one that crashed: it stays stopped until someone reopens it. */
function ReopenCard(props: {
  readonly threadRef: ScopedThreadRef;
  readonly state: Extract<HostedBlenderThreadState, { status: "closed" | "crashed" }>;
}) {
  const gt = useGT();
  const m = useMessages();
  const environmentId = props.threadRef.environmentId;
  const canOperate = useAtomValue(hostedBlenderEnvironment.reopen.permissionAtom(environmentId));
  const reopen = useAtomCommand(hostedBlenderEnvironment.reopen, { reportFailure: false });
  const dismiss = useAtomCommand(hostedBlenderEnvironment.dismiss, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const name = fileName(props.state.relativePath);
  const crashed = props.state.status === "crashed";
  const run = async (action: "restore" | "fresh" | "dismiss") => {
    setPending(true);
    const input = { threadId: props.threadRef.threadId };
    const result =
      action === "dismiss"
        ? await dismiss({ environmentId, input })
        : await reopen({ environmentId, input: { ...input, restore: action === "restore" } });
    setPending(false);
    setConfirmingDiscard(false);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: crashed ? gt("Couldn't restart Blender") : gt("Couldn't reopen Blender"),
          description: formatEnvironmentQueryError(result.cause, m),
        }),
      );
    }
  };
  const { recovery } = props.state;
  return (
    <>
      <StateCard
        title={crashed ? <T>Blender crashed</T> : <T>Blender was closed</T>}
        description={
          crashed ? (
            recovery ? (
              <T>
                <Var>{name}</Var> stopped unexpectedly. Restart opens the file as last saved, or
                restore its newest autosave.
              </T>
            ) : (
              <T>
                <Var>{name}</Var> stopped unexpectedly. Restart opens the file as last saved.
              </T>
            )
          ) : recovery ? (
            <T>
              T3 Code closed <Var>{name}</Var> when this thread settled or T3 Code stopped, and kept
              its unsaved changes. Reopen restores them.
            </T>
          ) : (
            <T>
              T3 Code closed <Var>{name}</Var> when this thread settled or T3 Code stopped.
            </T>
          )
        }
        actions={
          canOperate ? (
            <>
              {crashed ? (
                <>
                  <Button size="sm" disabled={pending} onClick={() => void run("fresh")}>
                    <T>Restart</T>
                  </Button>
                  {recovery ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => void run("restore")}
                    >
                      <T>Restore autosave</T>
                    </Button>
                  ) : null}
                </>
              ) : (
                <>
                  <Button size="sm" disabled={pending} onClick={() => void run("restore")}>
                    <T>Reopen</T>
                  </Button>
                  {recovery ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => void run("fresh")}
                    >
                      <T>Open as last saved</T>
                    </Button>
                  ) : null}
                </>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => (recovery ? setConfirmingDiscard(true) : void run("dismiss"))}
              >
                {recovery ? <T>Discard</T> : <T>Dismiss</T>}
              </Button>
            </>
          ) : null
        }
      />
      <AlertDialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {crashed
                ? gt("Discard the autosave of {name}?", { name })
                : gt("Discard the unsaved changes to {name}?", { name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>The file as last saved is kept. This can't be undone.</T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() => void run("dismiss")}
            >
              <T>Discard</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function MissingRequirements(props: { readonly missing: ReadonlyArray<HostedBlenderRequirement> }) {
  const gt = useGT();
  const names: Record<HostedBlenderRequirement, string> = {
    blender: "Blender",
    labwc: "labwc",
    helper: gt("T3 Code's hidden display helper"),
  };
  const list = props.missing.map((requirement) => names[requirement]).join(", ");
  return (
    <T>
      This server is missing: <Var>{list}</Var>. Install them on the server, then open this pane
      again.
    </T>
  );
}

function RunningBlender(props: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
  readonly state: HostedBlenderRunningState;
}) {
  const [stats, setStats] = useState<StreamStats>({ frameSize: null, rate: null, server: null });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BlenderToolbar threadRef={props.threadRef} state={props.state} />
      {props.state.status === "starting" ? (
        <StateCard
          title={<T>Starting Blender…</T>}
          description={
            <T>
              Opening <Var>{fileName(props.state.relativePath)}</Var> on the hidden display.
            </T>
          }
        />
      ) : props.visible ? (
        // With nobody watching, the server stops capturing, so a hidden pane disconnects.
        <BlenderStream
          environmentId={props.threadRef.environmentId}
          threadId={props.threadRef.threadId}
          onStats={setStats}
        />
      ) : (
        <div className="min-h-0 flex-1" />
      )}
      <BlenderStatusStrip {...stats} />
    </div>
  );
}

function BlenderToolbar(props: {
  readonly threadRef: ScopedThreadRef;
  readonly state: HostedBlenderRunningState;
}) {
  const gt = useGT();
  const canQuit = useAtomValue(
    hostedBlenderEnvironment.quit.permissionAtom(props.threadRef.environmentId),
  );
  const name = fileName(props.state.relativePath);
  const quit = useQuitHostedBlender(props.threadRef, name);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
      <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold">{name}</span>
      {canQuit ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                aria-label={gt("Blender menu")}
              />
            }
          >
            <MoreVertical />
          </MenuTrigger>
          <MenuPopup align="end" sideOffset={6}>
            <MenuItem disabled={quit.quitting} onClick={() => quit.request(props.state.dirty)}>
              <T>Quit Blender</T>
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
      {quit.dialog}
    </div>
  );
}

function BlenderStream(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly onStats: (update: (current: StreamStats) => StreamStats) => void;
}) {
  const access = useHostedBlenderStreamAccess(props.environmentId);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<HostedBlenderStreamStatus>("connecting");
  const { environmentId, threadId, onStats } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the stream is a WebSocket and a WebCodecs decoder, owned by this view
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (access === null || container === null || canvas === null) return;
    let frameSize = { width: 0, height: 0 };
    const sink = createCanvasFrameSink(canvas, (width, height) => {
      if (width === frameSize.width && height === frameSize.height) return;
      frameSize = { width, height };
      onStats((current) => ({ ...current, frameSize }));
    });
    const client = createHostedBlenderStreamClient({ access, threadId }, sink, {
      onStatus: setStatus,
      onStats: (server) => onStats((current) => ({ ...current, server })),
      onFrameRate: (rate) => onStats((current) => ({ ...current, rate })),
      onUnauthorized: () => refreshHostedBlenderStreamAccess(environmentId),
    });
    const resize = () => {
      const ratio = globalThis.devicePixelRatio || 1;
      client.resize(container.clientWidth * ratio, container.clientHeight * ratio);
    };
    resize();
    const stopObserving = observeResize(container, resize);
    return () => {
      stopObserving();
      client.stop();
    };
  }, [access, environmentId, threadId, onStats]);

  return (
    <div
      ref={containerRef}
      className="relative m-2 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-black"
    >
      <canvas ref={canvasRef} className={status === "live" ? "max-h-full max-w-full" : "hidden"} />
      {status === "live" ? null : <StreamStatus status={status} />}
    </div>
  );
}

function StreamStatus(props: { readonly status: Exclude<HostedBlenderStreamStatus, "live"> }) {
  switch (props.status) {
    case "connecting":
      return <Spinner />;
    case "stopped":
      return null;
    case "full":
      return (
        <p className="px-4 text-center text-sm text-white/80">
          <T>Too many people are watching this Blender. Try again later.</T>
        </p>
      );
    case "unsupported":
      return (
        <p className="px-4 text-center text-sm text-white/80">
          <T>This browser can't play the Blender stream.</T>
        </p>
      );
  }
}

function BlenderStatusStrip(props: StreamStats) {
  const parts = [
    props.frameSize ? `${props.frameSize.width}×${props.frameSize.height}` : null,
    props.rate ? `${props.rate.framesPerSecond} fps` : null,
    props.rate ? `${(props.rate.bitsPerSecond / 1_000_000).toFixed(1)} Mbps` : null,
    props.server?.encoder ?? null,
  ].filter((part) => part !== null);
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-muted/40 px-3 text-xs text-muted-foreground">
      <span>
        <T context="hosted Blender pane status, viewing without control">Watching</T>
      </span>
      {props.server?.target === "output" ? (
        <span className="text-warning-foreground">
          <T>Showing the whole display</T>
        </span>
      ) : null}
      <span className="flex-1" />
      {parts.length > 0 ? <span className="font-mono">{parts.join(" · ")}</span> : null}
      {props.server?.memoryBytes != null ? (
        <span className="font-mono">{formatBytes(props.server.memoryBytes)}</span>
      ) : null}
    </div>
  );
}
