import { useAtomValue } from "@effect/atom-react";
import { createCanvasFrameSink } from "@t3tools/client-runtime/device/frame";
import {
  detectKeymap,
  HOSTED_BLENDER_KEYBOARD_LAYOUTS,
  type HostedBlenderKeyboardLayout,
  type HostedBlenderScrollPreference,
  keymapForLayout,
} from "@t3tools/client-runtime/hosted-blender/input";
import {
  createHostedBlenderStreamClient,
  type HostedBlenderControl,
  type HostedBlenderFrameRate,
  type HostedBlenderStreamClient,
  type HostedBlenderStreamStats,
  type HostedBlenderStreamStatus,
  VIEW_ONLY,
} from "@t3tools/client-runtime/hosted-blender/stream";
import type {
  EnvironmentId,
  HostedBlenderKeptCopy,
  HostedBlenderMasterState,
  HostedBlenderRequirement,
  HostedBlenderRole,
  HostedBlenderRunningState,
  ProjectId,
  HostedBlenderThreadState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { blendFileName, quitFileOf } from "@t3tools/client-runtime/state/hosted-blender";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CameraIcon, MoreVertical } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { ComposerThreadTarget } from "~/composerDraftStore";
import { isElectron } from "~/env";
import { getLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";
import { resolveShortcutCommand } from "~/keybindings";
import { getKeyboardLayoutMap } from "~/keyboardLayout";
import { formatBytes } from "~/lib/formatBytes";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import {
  hostedBlenderEnvironment,
  refreshHostedBlenderStreamAccess,
  useHostedBlenderMasterState,
  useHostedBlenderSetupState,
  useHostedBlenderState,
  useHostedBlenderStreamAccess,
} from "~/state/hostedBlender";
import { formatEnvironmentQueryError } from "~/state/query";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { HiddenThreadContext } from "../chat/backgroundThread";

import { useBlenderAnnotation } from "./BlenderAnnotationEditor";
import {
  BlenderRoleSwitch,
  DesktopUncheckedNotice,
  MasterCard,
  ReloadBlockedNotice,
  ReloadedNotice,
} from "./BlenderMaster";
import { useBlenderRoleStore } from "./blenderRole";
import { attachBlenderInput, type BlenderInput, type TakePress } from "./blenderInput";
import { useKeptCopySelection } from "./keptCopies";
import { fileName, useQuitHostedBlender } from "./useQuitHostedBlender";

interface StreamStats {
  readonly frameSize: { readonly width: number; readonly height: number } | null;
  readonly rate: HostedBlenderFrameRate | null;
  readonly server: HostedBlenderStreamStats | null;
}

// Per device: the keyboard and mouse belong to the device, not the account.
const KEYBOARD_LAYOUT_KEY = "t3code:hosted-blender:keyboard-layout";
const SCROLLING_KEY = "t3code:hosted-blender:scrolling";
const KeyboardLayoutSetting = Schema.Literals(["auto", ...HOSTED_BLENDER_KEYBOARD_LAYOUTS]);
type KeyboardLayoutSetting = typeof KeyboardLayoutSetting.Type;
const ScrollingSetting = Schema.Literals(["auto", "wheel", "trackpad"]);

const readSetting = <T,>(key: string, schema: Schema.Codec<T, T>, fallback: T): T => {
  try {
    return getLocalStorageItem(key, schema) ?? fallback;
  } catch {
    return fallback;
  }
};

/** The device's layout, or the one the browser reports, falling back to US. */
const currentKeymap = () => {
  const setting = readSetting(KEYBOARD_LAYOUT_KEY, KeyboardLayoutSetting, "auto");
  if (setting !== "auto") return keymapForLayout(setting);
  return detectKeymap(getKeyboardLayoutMap()) ?? keymapForLayout("us");
};

const isPlainShiftF6 = (event: KeyboardEvent) =>
  event.code === "F6" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;

/** T3's focus shortcuts leave Blender; Shift+F6 is Blender's own, so it goes there. */
const leavesBlender = (event: KeyboardEvent) => {
  if (event.type !== "keydown" || isPlainShiftF6(event)) return false;
  const command = resolveShortcutCommand(event, appAtomRegistry.get(primaryServerKeybindingsAtom));
  return command === "workspace.focusNext" || command === "workspace.focusPrevious";
};

interface BlenderStreamHandle {
  readonly takeControl: (takeOver: boolean) => void;
  readonly fullscreen: () => void;
  readonly focus: () => void;
}

const canUseFullscreen = () =>
  !isElectron && typeof document !== "undefined" && document.fullscreenEnabled;

/** The thread's hosted Blender, live; clicking it takes control. Closing the pane leaves Blender running. */
interface BlenderPanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
  /** Where Screenshot & annotate puts what it captures. */
  readonly composerTarget: ComposerThreadTarget;
  readonly projectId?: ProjectId | undefined;
}

/**
 * The pane: the thread's working Blender, or, once the thread has a master, either one through
 * the Working copy / Master switch.
 */
export function BlenderPanel(props: BlenderPanelProps) {
  const working = useHostedBlenderState(props.threadRef);
  const master = useHostedBlenderMasterState(props.threadRef);
  // A link to the master's file picks the Master side, so the choice lives outside the pane.
  const role = useBlenderRoleStore(
    (store) => store.roles[scopedThreadKey(props.threadRef)] ?? "working",
  );
  const setRole = (next: HostedBlenderRole) =>
    useBlenderRoleStore.getState().setRole(props.threadRef, next);
  const hasMaster = master !== null && master.status !== "none";
  const switcher = hasMaster ? (
    <BlenderRoleSwitch role={role} onRole={setRole} working={working} master={master} />
  ) : null;
  const shown = hasMaster ? role : "working";
  const live = shown === "master" ? master : working;
  const running = live?.status === "running" || live?.status === "starting";
  const body =
    shown === "working" ? (
      <WorkingBlender {...props} state={working} switcher={switcher} />
    ) : master?.status === "running" || master?.status === "starting" ? (
      <RunningBlender
        {...props}
        state={master}
        switcher={switcher}
        master
        notice={master.desktopUnchecked === true ? <DesktopUncheckedNotice /> : null}
      />
    ) : master?.status === "closed" || master?.status === "crashed" ? (
      <ReopenCard threadRef={props.threadRef} state={master} master />
    ) : master?.status === "notOpen" || master?.status === "failed" ? (
      <MasterCard threadRef={props.threadRef} state={master} />
    ) : (
      <StateCard title={<Spinner />} />
    );
  if (switcher === null || running) return body;
  // A card has no toolbar, so the switch sits above it.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b border-border px-3">{switcher}</div>
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}

function WorkingBlender(
  props: BlenderPanelProps & {
    readonly state: HostedBlenderThreadState | null;
    readonly switcher: ReactNode;
  },
) {
  const state = props.state;
  if (state === null) return <StateCard title={<Spinner />} />;
  switch (state.status) {
    case "unavailable":
      return (
        <StateCard
          title={<T>Not available on this host</T>}
          description={<UnavailableReason reason={state.reason ?? "platform"} />}
          action={<OpenBlenderSettings environmentId={props.threadRef.environmentId} />}
        />
      );
    case "notSetUp":
      return (
        <StateCard
          title={<T>Setup needed</T>}
          description={<MissingRequirements missing={state.missing} />}
          action={<OpenBlenderSettings environmentId={props.threadRef.environmentId} />}
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
      return <RunningBlender {...props} state={state} switcher={props.switcher} />;
  }
}

/** The pane floating over chat while the agent works: watch-only, scaled to fit. */
export function FloatingBlender(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onFrameSize: (size: { readonly width: number; readonly height: number }) => void;
}) {
  const state = useHostedBlenderState(props.threadRef);
  const handleRef = useRef<BlenderStreamHandle | null>(null);
  if (state?.status !== "running") {
    return (
      <div className="flex size-full items-center justify-center bg-black">
        {state?.status === "starting" || state === null ? <Spinner /> : null}
      </div>
    );
  }
  return (
    <BlenderStream
      environmentId={props.threadRef.environmentId}
      threadId={props.threadRef.threadId}
      onStats={ignoreStats}
      onControl={ignoreControl}
      onFrameSize={props.onFrameSize}
      handleRef={handleRef}
      floating
    />
  );
}

const ignoreStats = () => {};
const ignoreControl = () => {};

function StateCard(props: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.description ? <EmptyDescription>{props.description}</EmptyDescription> : null}
      </EmptyHeader>
      {props.action ? (
        <EmptyContent className="flex-row flex-wrap justify-center">{props.action}</EmptyContent>
      ) : null}
      {props.footer ? (
        <EmptyContent>
          <div className="flex flex-wrap items-center justify-center gap-1 text-muted-foreground text-xs">
            {props.footer}
          </div>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

const keptName = (copy: HostedBlenderKeptCopy, untitled: string) =>
  copy.file.kind === "workspace"
    ? fileName(copy.file.relativePath)
    : copy.file.kind === "outside"
      ? fileName(copy.file.path)
      : untitled;

/**
 * What a closed or crashed Blender left for one file: it stays stopped until someone reopens
 * it. The thread's copies of other files are a click away, so none is out of reach.
 */
function ReopenCard(props: {
  readonly threadRef: ScopedThreadRef;
  readonly state:
    | Extract<HostedBlenderThreadState, { status: "closed" | "crashed" }>
    | Extract<HostedBlenderMasterState, { status: "closed" | "crashed" }>;
  /** The master's one copy, which Reopen restores in the master Blender. */
  readonly master?: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const environmentId = props.threadRef.environmentId;
  const canOperate = useAtomValue(hostedBlenderEnvironment.reopen.permissionAtom(environmentId));
  const reopen = useAtomCommand(hostedBlenderEnvironment.reopen, { reportFailure: false });
  const dismiss = useAtomCommand(hostedBlenderEnvironment.dismiss, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const selected = useKeptCopySelection(
    (selection) => selection.byThread[scopedThreadKey(props.threadRef)],
  );
  const select = useKeptCopySelection((selection) => selection.select);
  const { copies } = props.state;
  const copy = copies.find((kept) => kept.key === selected) ?? copies[0];
  const untitled = gt("Untitled scene");
  const name = keptName(copy, untitled);
  const crashed = copy.kind === "crashed";
  // T3 opens only workspace files, so only there can it check where a restore would save.
  const reopenable = copy.file.kind === "workspace";
  const run = async (action: "restore" | "fresh" | "dismiss") => {
    setPending(true);
    const input = {
      threadId: props.threadRef.threadId,
      key: copy.key,
      ...(props.master ? { role: "master" as const } : {}),
    };
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
  const { recovery, restoreFailed, copyPath } = copy;
  const others = copies.filter((kept) => kept !== copy);
  return (
    <>
      <StateCard
        title={crashed ? <T>Blender crashed</T> : <T>Blender was closed</T>}
        description={
          copy.file.kind === "outside" ? (
            recovery ? (
              <T>
                <Var>{name}</Var> is outside this project, so T3 Code can't reopen it. Its unsaved
                changes are kept at <Var>{copyPath}</Var>.
              </T>
            ) : (
              <T>
                <Var>{name}</Var> is outside this project, so T3 Code can't reopen it.
              </T>
            )
          ) : copy.file.kind === "untitled" ? (
            recovery ? (
              <T>
                T3 Code kept the unsaved changes to an untitled scene at <Var>{copyPath}</Var>.
              </T>
            ) : (
              <T>Blender had an untitled scene open, which T3 Code can't reopen.</T>
            )
          ) : restoreFailed ? (
            <T>
              Blender couldn't restore the copy of <Var>{name}</Var>. The copy is kept: try again,
              open the file as last saved, or discard the copy.
            </T>
          ) : crashed ? (
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
        action={
          canOperate ? (
            <>
              {!reopenable ? null : crashed ? (
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
        footer={
          others.length > 0 ? (
            <>
              <T>Also kept:</T>
              {others.map((other) => (
                <Button
                  key={other.key}
                  size="xs"
                  variant="link"
                  onClick={() => select(props.threadRef, other.key)}
                >
                  {keptName(other, untitled)}
                </Button>
              ))}
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

function OpenBlenderSettings(props: { readonly environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() =>
        void navigate({
          to: "/settings/blender",
          search: { machine: props.environmentId },
        })
      }
    >
      <T>Open Blender settings</T>
    </Button>
  );
}

function UnavailableReason(props: {
  readonly reason: NonNullable<
    Extract<HostedBlenderThreadState, { status: "unavailable" }>["reason"]
  >;
}) {
  switch (props.reason) {
    case "platform":
      return (
        <T>Hosted Blender needs a Linux server. You can still open 3D files in the file preview.</T>
      );
    case "distro":
      return (
        <T>
          This server's Linux release ships labwc and GStreamer too old for hosted Blender. You can
          still open 3D files in the file preview.
        </T>
      );
    case "sandboxedBlender":
      return (
        <T>
          Flatpak and Snap builds of Blender aren't supported yet. Settings › Blender says how to
          use another Blender.
        </T>
      );
  }
}

function MissingRequirements(props: { readonly missing: ReadonlyArray<HostedBlenderRequirement> }) {
  const gt = useGT();
  if (props.missing.includes("enabled")) {
    return <T>Switch on Hosted Blender in Settings › Blender to watch and steer Blender here.</T>;
  }
  if (props.missing.includes("check")) {
    return (
      <T>
        T3 Code hasn't checked this server yet. Open a .blend in hosted Blender, or check it in
        Settings › Blender.
      </T>
    );
  }
  const names: Record<Exclude<HostedBlenderRequirement, "enabled" | "check">, string> = {
    blender: "Blender",
    labwc: "labwc",
    helper: gt("T3 Code's hidden display helper"),
    gstreamer: "GStreamer",
    encoder: gt("an H.264 encoder"),
    glupload: gt("GStreamer's OpenGL plugin"),
  };
  const list = props.missing
    .filter((requirement) => requirement !== "enabled" && requirement !== "check")
    .map((requirement) => names[requirement])
    .join(", ");
  return (
    <T>
      This server is missing: <Var>{list}</Var>. Settings › Blender can install them with an agent
      or show you the commands.
    </T>
  );
}

function RunningBlender(
  props: BlenderPanelProps & {
    readonly state: HostedBlenderRunningState;
    readonly switcher: ReactNode;
    /** The thread's master Blender rather than its working Blender. */
    readonly master?: boolean;
    /** Shown under the toolbar. */
    readonly notice?: ReactNode;
  },
) {
  const gt = useGT();
  const master = props.master === true;
  const [stats, setStats] = useState<StreamStats>({ frameSize: null, rate: null, server: null });
  const [control, setControl] = useState<HostedBlenderControl>(VIEW_ONLY);
  const streamRef = useRef<BlenderStreamHandle | null>(null);
  const annotation = useBlenderAnnotation({
    threadRef: props.threadRef,
    relativePath: props.state.relativePath,
    composerTarget: props.composerTarget,
    projectId: props.projectId,
    master,
    onClose: () => streamRef.current?.focus(),
  });
  const live = props.state.status === "running" && props.visible && stats.frameSize !== null;
  // Hidden until the next reload keeps a copy; the copy itself stays as any kept copy does.
  const [dismissedReload, setDismissedReload] = useState<number | null>(null);
  const reloadKept = props.state.reloadKept;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BlenderToolbar
        threadRef={props.threadRef}
        state={props.state}
        control={control}
        streamRef={streamRef}
        onAnnotate={live ? annotation.start : null}
        switcher={props.switcher}
        master={master}
      />
      {props.notice}
      {props.state.reloadBlocked === undefined ? null : (
        <ReloadBlockedNotice
          name={blendFileName(quitFileOf(props.state), gt("Untitled scene"))}
          blocker={props.state.reloadBlocked}
        />
      )}
      {reloadKept !== undefined && reloadKept.at !== dismissedReload ? (
        <ReloadedNotice
          threadRef={props.threadRef}
          copyKey={reloadKept.key}
          master={master}
          onDismiss={() => setDismissedReload(reloadKept.at)}
        />
      ) : null}
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
          // A new stream for the other Blender, not a reconnect of this one.
          key={master ? "master" : "working"}
          environmentId={props.threadRef.environmentId}
          threadId={props.threadRef.threadId}
          master={master}
          onStats={setStats}
          onControl={setControl}
          handleRef={streamRef}
          canvasRef={annotation.canvasRef}
          paused={annotation.editor !== null}
          overlay={annotation.editor}
        />
      ) : (
        <div className="min-h-0 flex-1" />
      )}
      <BlenderStatusStrip
        {...stats}
        agentActing={props.state.agentActing === true}
        control={control}
        environmentId={props.threadRef.environmentId}
      />
    </div>
  );
}

function BlenderToolbar(props: {
  readonly threadRef: ScopedThreadRef;
  readonly state: HostedBlenderRunningState;
  readonly control: HostedBlenderControl;
  readonly streamRef: RefObject<BlenderStreamHandle | null>;
  /** Null while there's no live frame to freeze. */
  readonly onAnnotate: (() => void) | null;
  readonly switcher: ReactNode;
  readonly master: boolean;
}) {
  const gt = useGT();
  const canQuit = useAtomValue(
    hostedBlenderEnvironment.quit.permissionAtom(props.threadRef.environmentId),
  );
  const m = useMessages();
  const [keyboardLayout, setKeyboardLayout] = useLocalStorage<KeyboardLayoutSetting, string>(
    KEYBOARD_LAYOUT_KEY,
    "auto",
    KeyboardLayoutSetting,
  );
  const [scrolling, setScrolling] = useLocalStorage<HostedBlenderScrollPreference, string>(
    SCROLLING_KEY,
    "auto",
    ScrollingSetting,
  );
  // The file Blender has open, which File > Open can have changed since it started.
  const name = blendFileName(quitFileOf(props.state), gt("Untitled scene"));
  const { canOperate, controller } = props.control;
  const quit = useQuitHostedBlender(
    props.threadRef,
    props.state,
    props.master ? { role: "master" } : {},
  );
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
      {props.switcher}
      <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold">{name}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label={gt("Screenshot & annotate")}
              disabled={props.onAnnotate === null}
              // Pressing it must not move focus off the stream, which would give control back.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onAnnotate?.()}
            />
          }
        >
          <CameraIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{gt("Screenshot & annotate")}</TooltipPopup>
      </Tooltip>
      {!canOperate ? null : controller !== "you" ? (
        <Button
          variant="outline"
          size="xs"
          type="button"
          onClick={() => props.streamRef.current?.takeControl(controller === "another-viewer")}
        >
          {controller === "another-viewer" ? <T>Take over</T> : <T>Take control</T>}
        </Button>
      ) : canUseFullscreen() ? (
        <Button
          variant="outline"
          size="xs"
          type="button"
          // Pressing it must not move focus off the stream, which would give control back.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.streamRef.current?.fullscreen()}
        >
          <T>Fullscreen</T>
        </Button>
      ) : null}
      {canQuit || canOperate ? (
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
            {canOperate ? (
              <>
                <MenuSub>
                  <MenuSubTrigger>
                    <T>Keyboard layout</T>
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    <MenuRadioGroup
                      value={keyboardLayout}
                      onValueChange={(value) => setKeyboardLayout(value as KeyboardLayoutSetting)}
                    >
                      <MenuRadioItem value="auto" closeOnClick>
                        <T context="keyboard layout setting">Automatic</T>
                      </MenuRadioItem>
                      {HOSTED_BLENDER_KEYBOARD_LAYOUTS.map((layout) => (
                        <MenuRadioItem key={layout} value={layout} closeOnClick>
                          {m(KEYBOARD_LAYOUT_NAMES[layout])}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuSubPopup>
                </MenuSub>
                <MenuSub>
                  <MenuSubTrigger>
                    <T>Scrolling</T>
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    <MenuRadioGroup
                      value={scrolling}
                      onValueChange={(value) =>
                        setScrolling(value as HostedBlenderScrollPreference)
                      }
                    >
                      <MenuRadioItem value="auto" closeOnClick>
                        <T context="scrolling setting">Automatic</T>
                      </MenuRadioItem>
                      <MenuRadioItem value="wheel" closeOnClick>
                        <T>Mouse wheel</T>
                      </MenuRadioItem>
                      <MenuRadioItem value="trackpad" closeOnClick>
                        <T>Trackpad</T>
                      </MenuRadioItem>
                    </MenuRadioGroup>
                  </MenuSubPopup>
                </MenuSub>
              </>
            ) : null}
            {canQuit && canOperate ? <MenuSeparator /> : null}
            {canQuit ? (
              <MenuItem disabled={quit.quitting} onClick={() => quit.request(props.state.dirty)}>
                <T>Quit Blender</T>
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      ) : null}
      {quit.dialog}
    </div>
  );
}

const KEYBOARD_LAYOUT_NAMES: Record<HostedBlenderKeyboardLayout, string> = {
  us: msg("English (US)"),
  gb: msg("English (UK)"),
  de: msg("German"),
  fr: msg("French"),
  es: msg("Spanish"),
  it: msg("Italian"),
  pt: msg("Portuguese"),
  br: msg("Portuguese (Brazil)"),
  se: msg("Swedish"),
  no: msg("Norwegian"),
  dk: msg("Danish"),
  ch: msg("Swiss German"),
  ru: msg("Russian"),
  jp: msg("Japanese"),
  "us-dvorak": msg("English (Dvorak)"),
  "us-colemak": msg("English (Colemak)"),
};

/** Calls `onChange` whenever the screen's device pixel ratio changes, as moving windows does. */
const watchDevicePixelRatio = (onChange: () => void) => {
  let query: MediaQueryList | null = null;
  const listen = () => {
    query?.removeEventListener("change", changed);
    query = globalThis.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`);
    query?.addEventListener("change", changed);
  };
  const changed = () => {
    listen();
    onChange();
  };
  listen();
  return () => query?.removeEventListener("change", changed);
};

/**
 * The stream itself. `floating` is the watch-only player over chat: it never takes control or
 * sizes the display, and just scales what the panel's size gives it.
 */
function BlenderStream(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly master?: boolean;
  readonly onStats: (update: (current: StreamStats) => StreamStats) => void;
  readonly onControl: (control: HostedBlenderControl) => void;
  readonly handleRef: RefObject<BlenderStreamHandle | null>;
  readonly onFrameSize?: (size: { readonly width: number; readonly height: number }) => void;
  readonly floating?: boolean;
  /** The pane's annotation reads the stream's canvas; the floating player has none. */
  readonly canvasRef?: RefObject<HTMLCanvasElement | null>;
  /** The annotation editor needs the keyboard and pointer; control stays with this device. */
  readonly paused?: boolean;
  /** Covers the stream, inside the same focus boundary: focus there hasn't left Blender. */
  readonly overlay?: ReactNode;
}) {
  const gt = useGT();
  const access = useHostedBlenderStreamAccess(props.environmentId);
  const containerRef = useRef<HTMLDivElement>(null);
  const boundaryRef = useRef<HTMLDivElement>(null);
  const ownCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = props.canvasRef ?? ownCanvasRef;
  const paused = props.paused === true;
  const clientRef = useRef<HostedBlenderStreamClient | null>(null);
  const inputRef = useRef<BlenderInput | null>(null);
  const capturedRef = useRef(false);
  const [status, setStatus] = useState<HostedBlenderStreamStatus>("connecting");
  const [control, setControl] = useState<HostedBlenderControl>(VIEW_ONLY);
  const { environmentId, threadId, onStats, onControl, handleRef } = props;
  const master = props.master === true;
  const floating = props.floating === true;
  const canOperate = control.canOperate && !floating;
  const inControl = control.controller === "you";
  const controllerRef = useRef<HostedBlenderControl["controller"]>("unclaimed");
  // A take sent but not yet answered; leaving before the grant arrives must still undo it.
  const takingRef = useRef(false);
  // The middle or right press that took control: Blender gets it once control arrives.
  const takePressRef = useRef<TakePress | null>(null);
  // Settings and Usage keep the thread mounted under them while the window stays visible.
  const hiddenThread = use(HiddenThreadContext);
  const onScreen = useEffectEvent(() => document.visibilityState === "visible" && !hiddenThread);
  const reportFrameSize = useEffectEvent(
    (size: { readonly width: number; readonly height: number }) => props.onFrameSize?.(size),
  );
  const changeControl = useEffectEvent((next: HostedBlenderControl) => {
    if (controllerRef.current === "you" && next.controller === "another-viewer") {
      toastManager.add(
        stackedThreadToast({ type: "info", title: gt("Another device took control of Blender") }),
      );
    }
    const granted = controllerRef.current !== "you" && next.controller === "you";
    controllerRef.current = next.controller;
    takingRef.current = false;
    // A take that didn't land leaves no press for a later grant.
    if (next.controller !== "you") takePressRef.current = null;
    // A grant that lands after the user moved on in T3 would leave an unfocused pane holding
    // the keyboard; give it straight back. Leaving the window altogether keeps it.
    const boundary = boundaryRef.current;
    if (granted && document.hasFocus() && !boundary?.contains(document.activeElement)) {
      clientRef.current?.send({ type: "releaseControl" });
    }
    setControl(next);
    onControl(next);
  });

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
      reportFrameSize(frameSize);
    });
    const client = createHostedBlenderStreamClient(
      { access, threadId, master, visible: onScreen() },
      sink,
      {
        onStatus: setStatus,
        onStats: (server) => onStats((current) => ({ ...current, server })),
        onFrameRate: (rate) => onStats((current) => ({ ...current, rate })),
        onUnauthorized: () => refreshHostedBlenderStreamAccess(environmentId),
        onControl: changeControl,
        onCursor: (captured) => {
          capturedRef.current = captured;
          inputRef.current?.setCaptured(captured);
        },
      },
    );
    clientRef.current = client;
    handleRef.current = {
      takeControl: (takeOver) => {
        takePressRef.current = null;
        takingRef.current = true;
        client.send({ type: "takeControl", takeOver });
        container.focus();
      },
      fullscreen: () => {
        // Keyboard Lock works only in fullscreen; it lets Ctrl+W, Ctrl+T and Ctrl+N through.
        void container
          .requestFullscreen()
          .then(() => (navigator as KeyboardLockNavigator).keyboard?.lock?.())
          .catch(() => undefined);
      },
      focus: () => container.focus(),
    };
    // A pane in a hidden tab or a minimized window is not on screen.
    const showVisibility = () => client.setVisible(onScreen());
    showVisibility();
    document.addEventListener("visibilitychange", showVisibility);
    // Real pixels, so HiDPI screens get a sharp stream.
    const resize = () => {
      const ratio = globalThis.devicePixelRatio || 1;
      client.resize(container.clientWidth * ratio, container.clientHeight * ratio);
    };
    if (!floating) resize();
    const stopObserving = floating ? () => {} : observeResize(container, resize);
    const stopWatchingRatio = floating ? () => {} : watchDevicePixelRatio(resize);
    return () => {
      document.removeEventListener("visibilitychange", showVisibility);
      stopObserving();
      stopWatchingRatio();
      client.stop();
      clientRef.current = null;
      handleRef.current = null;
      changeControl(VIEW_ONLY);
    };
  }, [access, environmentId, threadId, master, onStats, handleRef, floating, canvasRef]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the server when Settings or Usage cover or uncover the thread, without reconnecting
  useEffect(() => {
    clientRef.current?.setVisible(document.visibilityState === "visible" && !hiddenThread);
  }, [hiddenThread]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- while in control, the pane owns the DOM's pointer lock, the keyboard and the desktop app's menu shortcuts
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const client = clientRef.current;
    if (!inControl || paused || container === null || canvas === null || client === null) return;
    const input = attachBlenderInput({
      surface: container,
      canvas,
      send: client.send,
      keymap: currentKeymap,
      scrollPreference: () => readSetting(SCROLLING_KEY, ScrollingSetting, "auto"),
      passThrough: leavesBlender,
      ...(takePressRef.current === null ? {} : { takePress: takePressRef.current }),
    });
    takePressRef.current = null;
    input.setCaptured(capturedRef.current);
    inputRef.current = input;
    void window.desktopBridge?.setMenuShortcutsIgnored?.(true).catch(() => undefined);
    const onFullscreenChange = () => {
      if (document.fullscreenElement === null) {
        (navigator as KeyboardLockNavigator).keyboard?.unlock?.();
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      // Losing control (a take over, a disconnect) leaves fullscreen and its keyboard lock.
      if (document.fullscreenElement === container)
        void document.exitFullscreen().catch(() => undefined);
      (navigator as KeyboardLockNavigator).keyboard?.unlock?.();
      void window.desktopBridge?.setMenuShortcutsIgnored?.(false).catch(() => undefined);
      inputRef.current = null;
      input.dispose();
    };
  }, [inControl, paused, canvasRef]);

  return (
    <div
      ref={boundaryRef}
      className={floating ? "relative size-full" : "relative flex min-h-0 flex-1 flex-col"}
      onBlur={(event) => {
        // Leaving the window keeps control; clicking or tabbing elsewhere in T3 gives it back.
        if (!(inControl || takingRef.current) || !document.hasFocus()) return;
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        takingRef.current = false;
        clientRef.current?.send({ type: "releaseControl" });
      }}
    >
      <div
        ref={containerRef}
        tabIndex={canOperate ? 0 : undefined}
        aria-label={gt("Blender viewport")}
        data-in-control={inControl ? "" : undefined}
        className={cn(
          "relative flex items-center justify-center overflow-hidden bg-black",
          floating
            ? "size-full"
            : "m-2 min-h-0 flex-1 rounded-md outline-none data-[in-control]:ring-2 data-[in-control]:ring-primary",
        )}
        onPointerDown={(event) => {
          const target = event.currentTarget;
          const capture = () => {
            if (target.hasPointerCapture(event.pointerId)) return;
            try {
              target.setPointerCapture(event.pointerId);
            } catch {}
          };
          // Its release comes back here even outside the pane, where it would paste or navigate.
          if (BROWSER_BUTTONS.has(event.button)) capture();
          if (inControl || !canOperate || control.controller !== "unclaimed") return;
          if (event.button > 2 || clientRef.current === null) return;
          // A left press that takes control stays out of Blender, so it selects nothing there; a
          // middle or right one reaches it once control arrives, so a drag navigates at once.
          takePressRef.current =
            event.button === 0
              ? null
              : {
                  bit: event.button === 1 ? MIDDLE_BIT : RIGHT_BIT,
                  clientX: event.clientX,
                  clientY: event.clientY,
                  released: false,
                };
          // A press Blender gets once control arrives: its release must come back here too.
          if (takePressRef.current !== null) capture();
          takingRef.current = true;
          clientRef.current.send({ type: "takeControl", takeOver: false });
          event.currentTarget.focus();
        }}
        onPointerCancel={() => {
          if (takePressRef.current?.released === false) takePressRef.current = null;
        }}
        onLostPointerCapture={() => {
          // Its release can no longer be seen, so Blender never gets a press it can't let go.
          if (takePressRef.current?.released === false) takePressRef.current = null;
        }}
        onPointerUp={(event) => {
          const take = takePressRef.current;
          if (take !== null && event.button === (take.bit === MIDDLE_BIT ? 1 : 2)) {
            takePressRef.current = { ...take, released: true };
          }
          if (BROWSER_BUTTONS.has(event.button)) event.preventDefault();
        }}
        onMouseDown={swallowBrowserButton}
        onMouseUp={swallowBrowserButton}
        onAuxClick={swallowBrowserButton}
        onContextMenu={(event) => {
          // A right press here takes control; in control, the input swallows it.
          if (canOperate) event.preventDefault();
        }}
      >
        <canvas
          ref={canvasRef}
          className={status === "live" ? "max-h-full max-w-full" : "hidden"}
        />
        {status === "live" ? null : <StreamStatus status={status} />}
      </div>
      {props.overlay}
    </div>
  );
}

// The middle button (autoscroll, and on Linux pasting the primary selection on release) and the
// thumb buttons (history) mean something to the browser everywhere on the pane, in control or not.
const BROWSER_BUTTONS = new Set([1, 3, 4]);
const MIDDLE_BIT = 4;
const RIGHT_BIT = 2;
const swallowBrowserButton = (event: ReactMouseEvent) => {
  if (BROWSER_BUTTONS.has(event.button)) event.preventDefault();
};

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

function BlenderStatusStrip(
  props: StreamStats & {
    readonly agentActing: boolean;
    readonly control: HostedBlenderControl;
    readonly environmentId: EnvironmentId;
  },
) {
  const setup = useHostedBlenderSetupState(props.environmentId)?.result;
  const gpu =
    setup?.status === "checked"
      ? setup.checks.find((check) => check.item === "gpu")?.status
      : undefined;
  const parts = [
    props.frameSize ? `${props.frameSize.width}×${props.frameSize.height}` : null,
    props.rate ? `${props.rate.framesPerSecond} fps` : null,
    props.rate ? `${(props.rate.bitsPerSecond / 1_000_000).toFixed(1)} Mbps` : null,
    props.server?.encoder ?? null,
  ].filter((part) => part !== null);
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-border bg-muted/40 px-3 text-xs whitespace-nowrap text-muted-foreground">
      <span className="shrink-0">
        {props.control.controller === "you" ? (
          <T>You're in control</T>
        ) : props.control.controller === "another-viewer" ? (
          <T>Another device is in control</T>
        ) : (
          <T context="hosted Blender pane status, viewing without control">Watching</T>
        )}
      </span>
      {props.agentActing ? (
        <Badge variant="info" size="sm">
          <T context="hosted Blender pane status badge">Agent editing</T>
        </Badge>
      ) : null}
      {props.server?.target === "output" ? (
        <span className="min-w-0 truncate text-warning-foreground">
          <T>Showing the whole display</T>
        </span>
      ) : null}
      {gpu === "warning" ? (
        <span className="min-w-0 truncate text-warning-foreground">
          <T>No GPU: Blender will be slow</T>
        </span>
      ) : gpu === "missing" ? (
        <span className="min-w-0 truncate text-warning-foreground">
          <T>No GPU access: Blender will be slow</T>
        </span>
      ) : null}
      {/* Who's in control comes first; in a narrow pane the stats shorten instead of wrapping. */}
      {parts.length > 0 ? (
        <span className="ml-auto min-w-0 truncate font-mono">{parts.join(" · ")}</span>
      ) : null}
      {props.server?.memoryBytes != null ? (
        <span className={`shrink-0 font-mono${parts.length > 0 ? "" : " ml-auto"}`}>
          {formatBytes(props.server.memoryBytes)}
        </span>
      ) : null}
    </div>
  );
}

interface KeyboardLockNavigator extends Navigator {
  readonly keyboard?: { readonly lock?: () => Promise<void>; readonly unlock?: () => void };
}
