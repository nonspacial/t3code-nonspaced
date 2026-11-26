import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  type HostedBlenderControl,
  type HostedBlenderFrameRate,
  VIEW_ONLY,
} from "@t3tools/client-runtime/hosted-blender/stream";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  blendFileName,
  type HeldQuit,
  heldQuitOf,
  isDiscardUnconfirmed,
  isRestoreReplacingUnsaved,
  quitFileOf,
} from "@t3tools/client-runtime/state/hosted-blender";
import {
  EnvironmentId,
  type HostedBlenderKeptCopy,
  type HostedBlenderRunningState,
  type HostedBlenderThreadState,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { msg, useGT, useMessages } from "gt-react-native";
import { type ReactNode, type RefObject, useEffect, useReducer, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { ControlPill } from "../../components/ui/ControlPill";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import { SheetCloseButton } from "../../components/ui/SheetHeader";
import { useAppForeground } from "../../lib/appState";
import { uuidv4 } from "../../lib/uuid";
import { m } from "../../i18n/messages";
import {
  hostedBlenderEnvironment,
  useHostedBlenderState,
  useHostedBlenderStreamAccess,
} from "../../state/hostedBlender";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  type BlenderStreamMessage,
  blenderViewerReducer,
  initialBlenderViewer,
} from "./blender-stream-document";
import { BlenderStreamWebView, type BlenderStreamRef } from "./BlenderStreamWebView";
import { notSetUpDetail } from "./hostedBlenderSetupText";

type BlenderRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

const fileName = (relativePath: string) => relativePath.slice(relativePath.lastIndexOf("/") + 1);
const keptName = (copy: HostedBlenderKeptCopy, untitled: string) =>
  copy.file.kind === "workspace"
    ? fileName(copy.file.relativePath)
    : copy.file.kind === "outside"
      ? fileName(copy.file.path)
      : untitled;

/** The thread's hosted Blender: watched live, and controlled by touch once taken. */
export function BlenderRouteScreen({ route }: BlenderRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = () => navigation.goBack();
  const { environmentId, threadId } = route.params;
  const isBlankLink = environmentId.trim().length === 0 || threadId.trim().length === 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops a deep-linked route with a blank environment or thread off the navigator
  useEffect(() => {
    if (isBlankLink) onClose();
  }, [isBlankLink, onClose]);
  if (isBlankLink) return null;
  return (
    <BlenderScreen
      environmentId={EnvironmentId.make(environmentId)}
      threadId={ThreadId.make(threadId)}
      onClose={onClose}
    />
  );
}

function BlenderScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const state = useHostedBlenderState(props);
  const [control, setControl] = useState<HostedBlenderControl>(VIEW_ONLY);
  const streamRef = useRef<BlenderStreamRef>(null);
  const blender = state.data;
  const running = blender?.status === "running" ? blender : null;
  const background = themeVariables["--color-sheet-solid"];
  const { canOperate, controller } = running ? control : VIEW_ONLY;
  const canQuit = useAtomValue(hostedBlenderEnvironment.quit.permissionAtom(props.environmentId));
  const quit = useAtomCommand(hostedBlenderEnvironment.quit, { reportFailure: false });
  const [quitting, setQuitting] = useState(false);
  // `discard` only from the dialog's Quit without saving, naming the file it showed; see
  // useQuitHostedBlender on web. Refused once Blender has another file open, which the next
  // Quit Blender names.
  const quitBlender = async (save: boolean, discard = false) => {
    setQuitting(true);
    const openFile =
      blender?.status === "running" || blender?.status === "starting"
        ? blender.openFile
        : undefined;
    const result = await quit({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        save,
        ...(discard ? { discard, ...(openFile === undefined ? {} : { openFile }) } : {}),
      },
    }).finally(() => setQuitting(false));
    // Held for edits a recovery copy can't keep: the same choice again, saying which.
    const held = result._tag === "Failure" && !discard ? heldQuitOf(result.cause) : null;
    if (held !== null) return askToQuit(held);
    if (result._tag === "Failure") {
      Dialog.alert(
        m(msg("Couldn't quit Blender")),
        isDiscardUnconfirmed(result.cause)
          ? m(
              msg(
                "Blender didn't answer, so it stays open with its changes. If it still doesn't answer, choosing Quit without saving again stops it and keeps what Blender last autosaved.",
              ),
            )
          : formatEnvironmentQueryError(result.cause),
      );
    }
  };
  const askToQuit = (heldBy?: HeldQuit) => {
    if (blender?.status !== "running" && blender?.status !== "starting") return;
    const held =
      heldBy ?? (blender.quitHeld === undefined ? null : { edits: blender.quitHeld, images: [] });
    if (!blender.dirty && held === null) return void quitBlender(false);
    Dialog.alert(
      gt("Save changes to {name} before quitting?", {
        name: blendFileName(quitFileOf(blender), gt("Untitled scene")),
      }),
      held === null
        ? gt("Changes Blender hasn't saved are lost if you quit without saving.")
        : held.edits === "catalogs"
          ? gt("Blender has unsaved asset catalog edits, which quitting without saving discards.")
          : held.images.length > 0
            ? gt(
                "Blender couldn't save {images}, so quitting without saving discards their edits.",
                { images: held.images.join(", ") },
              )
            : gt("Blender has unsaved image edits, which quitting without saving discards."),
      [
        { text: gt("Cancel"), style: "cancel" },
        {
          text: gt("Quit without saving"),
          style: "destructive",
          onPress: () => void quitBlender(false, true),
        },
        { text: gt("Save and quit"), onPress: () => void quitBlender(true) },
      ],
    );
  };
  return (
    <View className="flex-1" style={{ backgroundColor: background }}>
      <View className="px-3" style={{ paddingTop: Math.max(insets.top, 12) }}>
        <GlassSurface className="flex-row items-center gap-1 p-1">
          <SheetCloseButton accessibilityLabel={gt("Close Blender")} onClose={props.onClose} />
          <AppText numberOfLines={1} className="flex-1 px-1 font-t3-medium text-base">
            {blender?.status === "running" || blender?.status === "starting"
              ? blendFileName(quitFileOf(blender), gt("Untitled scene"))
              : // oxlint-disable-next-line t3code/no-untranslated-copy -- a product name
                "Blender"}
          </AppText>
          {controller === "you" ? (
            <>
              <ControlPill
                variant="pill"
                label="Z"
                accessibilityLabel={gt("Shading pie")}
                onPress={() => streamRef.current?.command({ type: "shadingPie" })}
              />
              <ControlPill
                variant="pill"
                label={gt("Done", { $context: "stops controlling hosted Blender" })}
                accessibilityLabel={gt("Give back control")}
                onPress={() => streamRef.current?.command({ type: "releaseControl" })}
              />
            </>
          ) : canOperate ? (
            <ControlPill
              variant="pill"
              label={controller === "another-viewer" ? gt("Take over") : gt("Take control")}
              onPress={() =>
                streamRef.current?.command({
                  type: "takeControl",
                  takeOver: controller === "another-viewer",
                })
              }
            />
          ) : null}
          {canQuit && (blender?.status === "running" || blender?.status === "starting") ? (
            <Menu
              actions={[
                {
                  id: "quit",
                  title: gt("Quit Blender"),
                  image: "power",
                  attributes: quitting ? { disabled: true } : { destructive: true },
                },
              ]}
              isAnchoredToRight
              title={gt("Blender options")}
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === "quit" && !quitting) askToQuit();
              }}
            >
              <ControlPill icon="ellipsis" accessibilityLabel={gt("Blender options")} />
            </Menu>
          ) : null}
        </GlassSurface>
      </View>
      {running ? (
        <ReloadNotices
          environmentId={props.environmentId}
          threadId={props.threadId}
          state={running}
        />
      ) : null}
      {blender === null ? (
        <StateMessage>
          {state.error ? (
            <>
              <AppText selectable className="text-center text-sm text-foreground-muted">
                {state.error}
              </AppText>
              <View className="items-center">
                <Button label={gt("Retry")} tone="secondary" onPress={state.refresh} />
              </View>
            </>
          ) : (
            <AppActivityIndicator color={themeVariables["--color-icon"]} />
          )}
        </StateMessage>
      ) : running && focused && foreground ? (
        // With nobody watching, the server stops capturing, so a hidden screen disconnects.
        <BlenderStream
          key={`${props.environmentId}:${props.threadId}`}
          environmentId={props.environmentId}
          threadId={props.threadId}
          muted={themeVariables["--color-foreground-muted"]}
          bottomInset={insets.bottom}
          streamRef={streamRef}
          onControl={setControl}
          agentActing={running?.agentActing === true}
        />
      ) : running ? (
        <View className="flex-1" />
      ) : (
        <BlenderStateCard state={blender} />
      )}
    </View>
  );
}

/** A reload that kept Blender's unsaved changes, which Restore changes puts back, or one held. */
function ReloadNotices(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly state: HostedBlenderRunningState;
}) {
  const gt = useGT();
  const canRestore = useAtomValue(
    hostedBlenderEnvironment.reopen.permissionAtom(props.environmentId),
  );
  const reopen = useAtomCommand(hostedBlenderEnvironment.reopen, { reportFailure: false });
  const [pending, setPending] = useState(false);
  // Hidden until the next reload keeps a copy; the copy itself stays as any kept copy does.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const name = blendFileName(quitFileOf(props.state), gt("Untitled scene"));
  const kept = props.state.reloadKept;
  const blocked = props.state.reloadBlocked;
  const held = props.state.quitHeld;
  const restore = async (key: string, replaceUnsaved: boolean) => {
    setPending(true);
    const result = await reopen({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        key,
        restore: true,
        ...(replaceUnsaved ? { replaceUnsaved: true } : {}),
      },
    }).finally(() => setPending(false));
    if (result._tag === "Success") return;
    // Unsaved work since the reload is replaced only once the person agrees; it becomes the copy.
    if (!replaceUnsaved && isRestoreReplacingUnsaved(result.cause)) {
      Dialog.alert(
        gt("Replace the unsaved changes to {name}?", { name }),
        gt(
          "Blender has changes since it reloaded the file. Restoring puts the kept changes back and keeps these as the recovery copy instead, so you can restore them again.",
        ),
        [
          { text: gt("Cancel"), style: "cancel" },
          { text: gt("Restore changes"), onPress: () => void restore(key, true) },
        ],
      );
      return;
    }
    Dialog.alert(m(msg("Couldn't restore the changes")), formatEnvironmentQueryError(result.cause));
  };
  const blockedText =
    blocked === undefined
      ? null
      : blocked === "agentWork"
        ? gt(
            "{name} changed on disk. Blender loads it once the agent's work running in it has finished.",
            { name },
          )
        : blocked === "images"
          ? gt(
              "{name} changed on disk. Blender loads it once its unsaved image edits are saved or discarded, since a recovery copy can't keep them.",
              { name },
            )
          : blocked === "catalogs"
            ? gt(
                "{name} changed on disk. Blender loads it once its unsaved asset catalog edits are saved or discarded, since a recovery copy can't keep them.",
                { name },
              )
            : blocked === "copyFailed"
              ? gt(
                  "{name} changed on disk, but Blender couldn't keep its unsaved changes first, so it hasn't loaded the new version.",
                  { name },
                )
              : gt(
                  "{name} changed on disk, but Blender couldn't load the new version. It tries again when the file changes.",
                  { name },
                );
  const heldText =
    held === undefined
      ? null
      : held === "images"
        ? gt(
            "Blender stayed open: quitting would lose its unsaved image edits, which a recovery copy can't keep. Save them in Blender (Image › Save All Images), or quit without saving.",
          )
        : gt(
            "Blender stayed open: quitting would lose its unsaved asset catalog edits, which a recovery copy can't keep. Save them in Blender's asset browser, or quit without saving.",
          );
  const showKept = kept !== undefined && kept.at !== dismissed;
  if (blockedText === null && heldText === null && !showKept) return null;
  return (
    <View className="gap-2 px-3 pt-2">
      {heldText === null ? null : <Notice message={heldText} />}
      {blockedText === null ? null : <Notice message={blockedText} />}
      {kept !== undefined && showKept ? (
        <>
          <Notice
            message={gt(
              "{name} changed on disk, so Blender reloaded it. Its unsaved changes are kept as a recovery copy.",
              { name },
            )}
            onDismiss={() => setDismissed(kept.at)}
            dismissLabel={gt("Dismiss")}
          />
          {canRestore ? (
            <View className="items-start">
              <Button
                label={gt("Restore changes")}
                tone="secondary"
                disabled={pending}
                onPress={() => void restore(kept.key, false)}
              />
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function StateMessage(props: { readonly children: ReactNode }) {
  return <View className="flex-1 items-center justify-center gap-4 px-6">{props.children}</View>;
}

function BlenderStateCard(props: { readonly state: HostedBlenderThreadState }) {
  const gt = useGT();
  const messages = useMessages();
  const [title, detail] = ((): readonly [string, string] => {
    switch (props.state.status) {
      case "unavailable":
        return [
          gt("Not available on this host"),
          gt(
            "Hosted Blender needs a Linux server. You can still open 3D files in the file preview.",
          ),
        ];
      case "notSetUp":
        return [gt("Hosted Blender isn't set up"), notSetUpDetail(props.state.missing, messages)];
      case "stopped":
        return [
          gt("No hosted Blender running"),
          gt("Open a .blend file in the file preview and choose Open in hosted Blender."),
        ];
      case "failed":
        return [
          gt("Blender didn't start"),
          gt(
            "Blender couldn't open the file on the hidden display. Check that Blender opens it, then open it in hosted Blender again.",
          ),
        ];
      // Reopening and restarting happen in the Blender pane on the web or desktop.
      case "closed":
      case "crashed": {
        const [newest, ...others] = props.state.copies;
        const untitled = gt("Untitled scene");
        const name = keptName(newest, untitled);
        const detail =
          newest.missing === true && newest.copyPath !== undefined
            ? gt(
                "{name} is no longer in this project, so T3 Code can't reopen it. Its unsaved changes are kept at {path}.",
                { name, path: newest.copyPath },
              )
            : newest.reloaded === true && newest.recovery && newest.kind === "closed"
              ? gt(
                  "T3 Code kept these unsaved changes to {name} when Blender reloaded the file after it changed on disk. The file on disk is newer than them. Open it as last saved or restore them from T3 Code on the web or desktop.",
                  { name },
                )
              : newest.kind === "closed"
                ? gt(
                    "T3 Code closed {name} when this thread settled or T3 Code stopped. Reopen it from T3 Code on the web or desktop.",
                    { name },
                  )
                : gt(
                    "{name} stopped unexpectedly. Restart it from T3 Code on the web or desktop.",
                    {
                      name,
                    },
                  );
        return [
          newest.kind === "closed" ? gt("Blender was closed") : gt("Blender crashed"),
          others.length === 0
            ? detail
            : `${detail} ${gt("Also kept: {names}", {
                names: others.map((copy) => keptName(copy, untitled)).join(", "),
              })}`,
        ];
      }
      case "starting":
      case "running":
        return [
          gt("Starting Blender…"),
          gt("Opening {name} on the hidden display.", {
            name: fileName(props.state.relativePath),
          }),
        ];
    }
  })();
  return (
    <StateMessage>
      {props.state.status === "starting" || props.state.status === "running" ? (
        <AppActivityIndicator colorClassName="accent-icon" />
      ) : null}
      <AppText className="text-center font-t3-medium text-base">{title}</AppText>
      <AppText className="text-center text-sm text-foreground-muted">{detail}</AppText>
    </StateMessage>
  );
}

function BlenderStream({
  streamRef,
  onControl,
  ...props
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly muted: string;
  readonly bottomInset: number;
  readonly streamRef: RefObject<BlenderStreamRef | null>;
  readonly onControl: (control: HostedBlenderControl) => void;
  readonly agentActing: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [{ viewer, status }, dispatch] = useReducer(blenderViewerReducer, null, () =>
    initialBlenderViewer(uuidv4()),
  );
  const { access, error, refresh } = useHostedBlenderStreamAccess(props.environmentId, viewer);
  const [control, setControl] = useState<HostedBlenderControl>(VIEW_ONLY);
  const [rate, setRate] = useState<HostedBlenderFrameRate | null>(null);
  const [frameSize, setFrameSize] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const [memoryBytes, setMemoryBytes] = useState<number | null>(null);
  const [takenOver, setTakenOver] = useState(false);
  // A new viewer mints a fresh ticket and starts a new WebView.
  const restart = (cause: "unauthorized" | "reconnect") => {
    changeControl(VIEW_ONLY);
    dispatch({ type: cause, viewer: uuidv4() });
  };
  const changeControl = (next: HostedBlenderControl) => {
    if (control.controller === "you" && next.controller === "another-viewer") setTakenOver(true);
    if (next.controller === "you") setTakenOver(false);
    setControl(next);
    onControl(next);
  };
  const onMessage = (message: BlenderStreamMessage) => {
    switch (message.type) {
      case "status":
        return dispatch({ type: "status", status: message.status });
      case "control":
        return changeControl({ canOperate: message.canOperate, controller: message.controller });
      case "rate":
        return setRate(message);
      case "frameSize":
        return setFrameSize({ width: message.width, height: message.height });
      case "stats":
        return setMemoryBytes(message.memoryBytes);
      case "unauthorized":
        return restart("unauthorized");
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the toolbar lives in the parent; leaving the stream leaves this device view-only there
  useEffect(() => () => onControl(VIEW_ONLY), [onControl]);
  const statusText =
    control.controller === "you"
      ? gt("You're in control")
      : control.controller === "another-viewer"
        ? gt("Another device is in control")
        : control.canOperate
          ? gt("Watching. Tap to take control.")
          : gt("Watching", { $context: "hosted Blender pane status, viewing without control" });
  const stats = [
    frameSize ? `${frameSize.width}×${frameSize.height}` : null,
    rate ? `${rate.framesPerSecond} fps` : null,
    memoryBytes !== null ? formatAttachmentSize(memoryBytes, messages) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const overlay =
    status === "live"
      ? null
      : status === "full"
        ? gt("Too many people are watching this Blender. Try again later.")
        : status === "unsupported"
          ? gt("This device can't play the Blender stream.")
          : status === "error"
            ? gt("Blender viewer stopped unexpectedly.")
            : status === "stopped"
              ? ""
              : null;
  return (
    <View className="flex-1">
      <View className="m-2 flex-1 overflow-hidden rounded-xl">
        {access ? (
          <BlenderStreamWebView
            key={viewer}
            ref={streamRef}
            access={access}
            threadId={props.threadId}
            colors={{ background: "#000000", muted: props.muted }}
            onMessage={onMessage}
            onFailed={() => {
              // A dead page holds nothing; the server gives control back when it disconnects.
              changeControl(VIEW_ONLY);
              dispatch({ type: "status", status: "error" });
            }}
          />
        ) : null}
        {status !== "live" ? (
          <View className="absolute inset-0 items-center justify-center gap-4 bg-black px-6">
            {error ? (
              <>
                <AppText selectable className="text-center text-sm text-white/80">
                  {error}
                </AppText>
                <Button label={gt("Retry")} tone="secondary" onPress={refresh} />
              </>
            ) : overlay === null ? (
              <AppActivityIndicator color="#ffffff" />
            ) : (
              <>
                <AppText className="text-center text-sm text-white/80">{overlay}</AppText>
                {status === "error" || status === "full" ? (
                  <Button
                    label={gt("Reconnect")}
                    tone="secondary"
                    onPress={() => restart("reconnect")}
                  />
                ) : null}
              </>
            )}
          </View>
        ) : null}
      </View>
      {takenOver ? (
        <View className="px-3">
          <Notice
            message={gt("Another device took control of Blender")}
            onDismiss={() => setTakenOver(false)}
            dismissLabel={gt("Dismiss")}
          />
        </View>
      ) : null}
      <View
        className="flex-row items-center gap-3 px-4 pt-1"
        style={{ paddingBottom: Math.max(props.bottomInset, 8) }}
      >
        <AppText numberOfLines={1} className="flex-1 text-xs text-foreground-muted">
          {statusText}
        </AppText>
        {props.agentActing ? (
          <AppText className="font-t3-medium text-xs text-primary">
            {gt("Agent editing", { $context: "hosted Blender pane status badge" })}
          </AppText>
        ) : null}
        {stats ? (
          <AppText className="font-mono text-xs text-foreground-muted">{stats}</AppText>
        ) : null}
      </View>
    </View>
  );
}
