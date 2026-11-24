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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
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

interface StreamStats {
  readonly frameSize: { readonly width: number; readonly height: number } | null;
  readonly rate: HostedBlenderFrameRate | null;
  readonly server: HostedBlenderStreamStats | null;
}

const fileName = (relativePath: string) => relativePath.slice(relativePath.lastIndexOf("/") + 1);

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
    case "starting":
    case "running":
      return <RunningBlender {...props} state={state} />;
  }
}

function StateCard(props: { readonly title: ReactNode; readonly description?: ReactNode }) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.description ? <EmptyDescription>{props.description}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
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
  const m = useMessages();
  const quit = useAtomCommand(hostedBlenderEnvironment.quit, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const name = fileName(props.state.relativePath);
  const quitBlender = async (save: boolean) => {
    setQuitting(true);
    const result = await quit({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, save },
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
            <MenuItem
              disabled={quitting}
              onClick={() => (props.state.dirty ? setConfirming(true) : void quitBlender(false))}
            >
              <T>Quit Blender</T>
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
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
