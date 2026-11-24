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
  HostedBlenderRequirement,
  HostedBlenderRunningState,
  HostedBlenderThreadState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { MoreVertical } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import {
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
  useHostedBlenderSetupState,
  useHostedBlenderState,
  useHostedBlenderStreamAccess,
} from "~/state/hostedBlender";
import { formatEnvironmentQueryError } from "~/state/query";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { HiddenThreadContext } from "../chat/backgroundThread";

import { attachBlenderInput, type BlenderInput } from "./blenderInput";
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
}

const canUseFullscreen = () =>
  !isElectron && typeof document !== "undefined" && document.fullscreenEnabled;

/** The thread's hosted Blender, live; clicking it takes control. Closing the pane leaves Blender running. */
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
      return <RunningBlender {...props} state={state} />;
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
  const { recovery, restoreFailed } = props.state;
  return (
    <>
      <StateCard
        title={crashed ? <T>Blender crashed</T> : <T>Blender was closed</T>}
        description={
          restoreFailed ? (
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

function RunningBlender(props: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
  readonly state: HostedBlenderRunningState;
}) {
  const [stats, setStats] = useState<StreamStats>({ frameSize: null, rate: null, server: null });
  const [control, setControl] = useState<HostedBlenderControl>(VIEW_ONLY);
  const streamRef = useRef<BlenderStreamHandle | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BlenderToolbar
        threadRef={props.threadRef}
        state={props.state}
        control={control}
        streamRef={streamRef}
      />
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
          onControl={setControl}
          handleRef={streamRef}
        />
      ) : (
        <div className="min-h-0 flex-1" />
      )}
      <BlenderStatusStrip
        {...stats}
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
  const name = fileName(props.state.relativePath);
  const { canOperate, controller } = props.control;
  const quit = useQuitHostedBlender(props.threadRef, name);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
      <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold">{name}</span>
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
  readonly onStats: (update: (current: StreamStats) => StreamStats) => void;
  readonly onControl: (control: HostedBlenderControl) => void;
  readonly handleRef: RefObject<BlenderStreamHandle | null>;
  readonly onFrameSize?: (size: { readonly width: number; readonly height: number }) => void;
  readonly floating?: boolean;
}) {
  const gt = useGT();
  const access = useHostedBlenderStreamAccess(props.environmentId);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<HostedBlenderStreamClient | null>(null);
  const inputRef = useRef<BlenderInput | null>(null);
  const capturedRef = useRef(false);
  const [status, setStatus] = useState<HostedBlenderStreamStatus>("connecting");
  const [control, setControl] = useState<HostedBlenderControl>(VIEW_ONLY);
  const { environmentId, threadId, onStats, onControl, handleRef } = props;
  const floating = props.floating === true;
  const canOperate = control.canOperate && !floating;
  const inControl = control.controller === "you";
  const controllerRef = useRef<HostedBlenderControl["controller"]>("unclaimed");
  // A take sent but not yet answered; leaving before the grant arrives must still undo it.
  const takingRef = useRef(false);
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
    // A grant that lands after the user moved on in T3 would leave an unfocused pane holding
    // the keyboard; give it straight back. Leaving the window altogether keeps it.
    const container = containerRef.current;
    if (granted && document.hasFocus() && !container?.contains(document.activeElement)) {
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
    const client = createHostedBlenderStreamClient({ access, threadId }, sink, {
      onStatus: setStatus,
      onStats: (server) => onStats((current) => ({ ...current, server })),
      onFrameRate: (rate) => onStats((current) => ({ ...current, rate })),
      onUnauthorized: () => refreshHostedBlenderStreamAccess(environmentId),
      onControl: changeControl,
      onCursor: (captured) => {
        capturedRef.current = captured;
        inputRef.current?.setCaptured(captured);
      },
    });
    clientRef.current = client;
    handleRef.current = {
      takeControl: (takeOver) => {
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
  }, [access, environmentId, threadId, onStats, handleRef, floating]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the server when Settings or Usage cover or uncover the thread, without reconnecting
  useEffect(() => {
    clientRef.current?.setVisible(document.visibilityState === "visible" && !hiddenThread);
  }, [hiddenThread]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- while in control, the pane owns the DOM's pointer lock, the keyboard and the desktop app's menu shortcuts
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const client = clientRef.current;
    if (!inControl || container === null || canvas === null || client === null) return;
    const input = attachBlenderInput({
      surface: container,
      canvas,
      send: client.send,
      keymap: currentKeymap,
      scrollPreference: () => readSetting(SCROLLING_KEY, ScrollingSetting, "auto"),
      passThrough: leavesBlender,
    });
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
  }, [inControl]);

  return (
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
        // The click that takes control stays out of Blender, so it selects nothing there.
        if (inControl || !canOperate || control.controller !== "unclaimed") return;
        if (event.button !== 0 || clientRef.current === null) return;
        takingRef.current = true;
        clientRef.current.send({ type: "takeControl", takeOver: false });
        event.currentTarget.focus();
      }}
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

function BlenderStatusStrip(
  props: StreamStats & {
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
