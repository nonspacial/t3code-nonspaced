import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  type HostedBlenderControl,
  type HostedBlenderFrameRate,
  type HostedBlenderStreamStatus,
  VIEW_ONLY,
} from "@t3tools/client-runtime/hosted-blender/stream";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  EnvironmentId,
  type HostedBlenderRequirement,
  type HostedBlenderThreadState,
  ThreadId,
} from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ControlPill } from "../../components/ui/ControlPill";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { Notice } from "../../components/ui/Notice";
import { SheetCloseButton } from "../../components/ui/SheetHeader";
import { useAppForeground } from "../../lib/appState";
import { uuidv4 } from "../../lib/uuid";
import { useHostedBlenderState, useHostedBlenderStreamAccess } from "../../state/hostedBlender";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { BlenderStreamMessage } from "./blender-stream-document";
import { BlenderStreamWebView, type BlenderStreamRef } from "./BlenderStreamWebView";

type BlenderRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

const fileName = (relativePath: string) => relativePath.slice(relativePath.lastIndexOf("/") + 1);

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
  return (
    <View className="flex-1" style={{ backgroundColor: background }}>
      <View className="px-3" style={{ paddingTop: Math.max(insets.top, 12) }}>
        <GlassSurface className="flex-row items-center gap-1 p-1">
          <SheetCloseButton accessibilityLabel={gt("Close Blender")} onClose={props.onClose} />
          <AppText numberOfLines={1} className="flex-1 px-1 font-t3-medium text-base">
            {blender?.status === "running" || blender?.status === "starting"
              ? fileName(blender.relativePath)
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
        </GlassSurface>
      </View>
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
        />
      ) : running ? (
        <View className="flex-1" />
      ) : (
        <BlenderStateCard state={blender} />
      )}
    </View>
  );
}

function StateMessage(props: { readonly children: ReactNode }) {
  return <View className="flex-1 items-center justify-center gap-4 px-6">{props.children}</View>;
}

function BlenderStateCard(props: { readonly state: HostedBlenderThreadState }) {
  const gt = useGT();
  const names: Record<HostedBlenderRequirement, string> = {
    blender: "Blender",
    labwc: "labwc",
    helper: gt("T3 Code's hidden display helper"),
  };
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
        return [
          gt("Hosted Blender isn't set up"),
          gt("This server is missing: {list}. Install them on the server, then open this again.", {
            list: props.state.missing.map((requirement) => names[requirement]).join(", "),
          }),
        ];
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
}) {
  const gt = useGT();
  const messages = useMessages();
  const [viewer, setViewer] = useState(uuidv4);
  const { access, error, refresh } = useHostedBlenderStreamAccess(props.environmentId, viewer);
  const [status, setStatus] = useState<HostedBlenderStreamStatus | "error">("connecting");
  const [control, setControl] = useState<HostedBlenderControl>(VIEW_ONLY);
  const [rate, setRate] = useState<HostedBlenderFrameRate | null>(null);
  const [memoryBytes, setMemoryBytes] = useState<number | null>(null);
  const [takenOver, setTakenOver] = useState(false);
  // A new viewer mints a fresh ticket and starts a new WebView.
  const restart = () => {
    setStatus("connecting");
    setViewer(uuidv4());
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
        return setStatus(message.status);
      case "control":
        return changeControl({ canOperate: message.canOperate, controller: message.controller });
      case "rate":
        return setRate(message);
      case "stats":
        return setMemoryBytes(message.memoryBytes);
      case "unauthorized":
        return restart();
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
            onFailed={() => setStatus("error")}
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
                  <Button label={gt("Reconnect")} tone="secondary" onPress={restart} />
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
        {stats ? (
          <AppText className="font-mono text-xs text-foreground-muted">{stats}</AppText>
        ) : null}
      </View>
    </View>
  );
}
