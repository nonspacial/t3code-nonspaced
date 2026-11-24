import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  HostedBlenderSetupCheck,
  HostedBlenderSetupItem,
  HostedBlenderSetupResult,
  ThreadId,
} from "@t3tools/contracts";
import { resolvePastedPath } from "@t3tools/shared/path";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import { useRef, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { hostedBlenderEnvironment, useHostedBlenderSetupState } from "~/state/hostedBlender";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

type CheckedSetup = Extract<HostedBlenderSetupResult, { status: "checked" }>;

const canInstall = (result: CheckedSetup) =>
  result.checks.some((check) => check.status === "missing" || check.status === "outdated");

/**
 * Hosted Blender's setup steps: the switch, what this server has, how to install the rest, and
 * whether agents may start hosted Blenders. T3 shows commands; it never runs them itself.
 */
export function HostedBlenderSetupSettings(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const enabled = settings.hostedBlenderEnabled;
  // Only a switched-on Hosted Blender is checked, so the subscription waits for the switch.
  const state = useHostedBlenderSetupState(enabled ? props.environmentId : null);
  const result = state?.result ?? null;
  const ready = result?.status === "checked" && result.ready;
  const mcpFound =
    result?.status === "checked" &&
    result.checks.some((check) => check.item === "blenderMcp" && check.status === "ok");

  return (
    <>
      <SettingsRow
        {...setting("hosted-blender")}
        serverScoped
        settingKeys={["hostedBlenderEnabled"]}
        description={gt(
          "Let T3 Code run its own Blender on this server, on a hidden display, so you can watch and steer it in the Blender pane. Linux only. Your desktop Blender is never touched.",
        )}
        control={
          <ScopedSwitch
            settingKeys={["hostedBlenderEnabled"]}
            checked={enabled}
            onCheckedChange={(checked) =>
              updateSettings({ hostedBlenderEnabled: Boolean(checked) })
            }
            aria-label={gt("Hosted Blender")}
          />
        }
      />
      {enabled ? <SetupStatus environmentId={props.environmentId} state={state} /> : null}
      {enabled ? (
        <SettingsRow
          {...setting("hosted-blender-allow-agents")}
          serverScoped
          settingKeys={["hostedBlenderAllowAgents"]}
          description={
            ready && mcpFound
              ? gt("Agents in Claude and Codex threads may start this server's hosted Blenders.")
              : gt(
                  "Finish setup first, including the official Blender MCP server. Agents use it to work in hosted Blenders.",
                )
          }
          control={
            <ScopedSwitch
              settingKeys={["hostedBlenderAllowAgents"]}
              checked={settings.hostedBlenderAllowAgents}
              // Turning it off is always allowed.
              disabled={!settings.hostedBlenderAllowAgents && !(ready && mcpFound)}
              onCheckedChange={(checked) =>
                updateSettings({ hostedBlenderAllowAgents: Boolean(checked) })
              }
              aria-label={gt("Allow agents to start hosted Blenders")}
            />
          }
        />
      ) : null}
      {enabled ? <BlenderMcpPathRow /> : null}
    </>
  );
}

function SetupStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly state: ReturnType<typeof useHostedBlenderSetupState>;
}) {
  const result = props.state?.result ?? null;
  if (result === null) {
    return (
      <SettingsRow
        title={<T>Checking this server…</T>}
        description={
          <T>T3 Code looks for Blender, labwc, GStreamer and the GPU, and runs a test encode.</T>
        }
        control={<Spinner />}
      />
    );
  }
  if (result.status === "unavailable") {
    return (
      <>
        <SettingsRow
          title={<T>Not available on this host</T>}
          description={<UnavailableReason result={result} />}
        />
        <CheckAgainRow environmentId={props.environmentId} checking={props.state!.checking} />
      </>
    );
  }
  return (
    <>
      {result.checks.map((check) => (
        <CheckRow key={check.item} check={check} capture={result.capture} />
      ))}
      <CheckAgainRow environmentId={props.environmentId} checking={props.state!.checking} />
      {canInstall(result) || props.state!.installThreadId !== null ? (
        <InstallRow
          environmentId={props.environmentId}
          result={result}
          installThreadId={props.state!.installThreadId}
        />
      ) : null}
    </>
  );
}

function UnavailableReason(props: {
  readonly result: Extract<HostedBlenderSetupResult, { status: "unavailable" }>;
}) {
  switch (props.result.reason) {
    case "platform":
      return <T>Hosted Blender needs a Linux server. 3D file previews still work on this one.</T>;
    case "distro":
      return (
        <T>
          <Var>{props.result.distro ?? ""}</Var> ships labwc and GStreamer too old for hosted
          Blender. Ubuntu 24.04, Debian 13, Fedora 43 and Arch work.
        </T>
      );
    case "sandboxedBlender":
      return (
        <T>
          Flatpak and Snap builds of Blender aren't supported yet. Install Blender from blender.org
          or your distro, or set its path in Settings › General › 3D previews, then check again.
        </T>
      );
  }
}

function CheckRow(props: {
  readonly check: HostedBlenderSetupCheck;
  readonly capture: CheckedSetup["capture"];
}) {
  const gt = useGT();
  const { check } = props;
  const names: Record<HostedBlenderSetupItem, string> = {
    helper: gt("Hidden display helper"),
    blender: "Blender",
    labwc: "labwc",
    gstreamer: "GStreamer",
    encoder: gt("H.264 encoder"),
    glupload: gt("GStreamer OpenGL upload (NVIDIA)"),
    gpu: gt("GPU"),
    blenderMcp: gt("Blender MCP server"),
  };
  return (
    <SettingsRow
      title={names[check.item]}
      description={<CheckDescription check={check} capture={props.capture} />}
      control={<CheckBadge check={check} />}
    />
  );
}

function CheckBadge(props: { readonly check: HostedBlenderSetupCheck }) {
  switch (props.check.status) {
    case "ok":
      return (
        <Badge variant="success">
          <T>Found</T>
        </Badge>
      );
    case "missing":
      return (
        <Badge variant={props.check.item === "blenderMcp" ? "warning" : "error"}>
          <T>Missing</T>
        </Badge>
      );
    case "outdated":
      return (
        <Badge variant="error">
          <T>Too old</T>
        </Badge>
      );
    case "warning":
      return (
        <Badge variant="warning">
          <T>Slow</T>
        </Badge>
      );
  }
}

function CheckDescription(props: {
  readonly check: HostedBlenderSetupCheck;
  readonly capture: CheckedSetup["capture"];
}) {
  const { check } = props;
  const found = check.found ?? "";
  switch (check.item) {
    case "helper":
      return check.status === "ok" ? (
        <T>Runs Blender on the hidden display and streams it.</T>
      ) : (
        <T>T3 Code's own helper is missing from this install. Update or reinstall T3 Code.</T>
      );
    case "blender":
      return check.status === "ok" ? (
        <T>
          Version <Var>{found}</Var>.
        </T>
      ) : check.status === "outdated" ? (
        <T>
          Version <Var>{found}</Var>. Hosted Blender needs Blender 4.5 or later.
        </T>
      ) : (
        <T>Install Blender 4.5 or later, or set its path in Settings › General › 3D previews.</T>
      );
    case "labwc":
      return check.status !== "ok" ? (
        <T>The compositor behind the hidden display.</T>
      ) : props.capture === "wlr-screencopy" ? (
        <T>
          Version <Var>{found}</Var>, captured with wlr-screencopy. labwc 0.9 or later captures
          Blender's window alone.
        </T>
      ) : (
        <T>
          Version <Var>{found}</Var>.
        </T>
      );
    case "gstreamer":
      return check.status === "ok" ? (
        <T>
          Version <Var>{found}</Var>.
        </T>
      ) : check.status === "outdated" ? (
        <T>
          Version <Var>{found}</Var>. Hosted Blender needs GStreamer 1.24 or later.
        </T>
      ) : (
        <T>GStreamer 1.24 or later encodes the stream.</T>
      );
    case "encoder":
      return check.status === "ok" ? (
        <T>
          The one-second test encode used <Var>{found}</Var>.
        </T>
      ) : (
        <T>
          No H.264 encoder passed the test encode. Install GStreamer's plugins: one of nvh264enc,
          vah264enc, x264enc or openh264enc.
        </T>
      );
    case "glupload":
      return check.status === "ok" ? (
        <T>NVIDIA's encoder reads Blender's frames straight from the GPU.</T>
      ) : (
        <T>NVIDIA's encoder needs GStreamer's OpenGL plugin.</T>
      );
    case "gpu":
      return check.status === "ok" ? (
        <T>Blender draws with the GPU.</T>
      ) : check.status === "missing" ? (
        <T>
          This server has a GPU, but T3 Code can't open it. Add your user to the render and video
          groups. Until then, Blender will be slow.
        </T>
      ) : (
        <T>No GPU found. Hosted Blender still works, but Blender will be slow.</T>
      );
    case "blenderMcp":
      return check.status === "ok" ? (
        <T>
          <Var>{found}</Var>
        </T>
      ) : (
        <T>Agents need the official Blender Lab MCP server. The pane works without it.</T>
      );
  }
}

function CheckAgainRow(props: {
  readonly environmentId: EnvironmentId;
  readonly checking: boolean;
}) {
  const m = useMessages();
  const gt = useGT();
  const canCheck = useAtomValue(
    hostedBlenderEnvironment.checkSetup.permissionAtom(props.environmentId),
  );
  const check = useAtomCommand(hostedBlenderEnvironment.checkSetup, { reportFailure: false });
  if (!canCheck) return null;
  const run = async () => {
    const result = await check({ environmentId: props.environmentId, input: {} });
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Couldn't check hosted Blender's setup"),
          description: formatEnvironmentQueryError(result.cause, m),
        }),
      );
    }
  };
  return (
    <SettingsRow
      title={<T>Check again</T>}
      description={
        <T>The result is kept until you check again, such as after installing something.</T>
      }
      control={
        <Button variant="outline" size="sm" disabled={props.checking} onClick={() => void run()}>
          {props.checking ? <Spinner /> : null}
          <T>Check again</T>
        </Button>
      }
    />
  );
}

function InstallRow(props: {
  readonly environmentId: EnvironmentId;
  readonly result: CheckedSetup;
  readonly installThreadId: ThreadId | null;
}) {
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const [showCommands, setShowCommands] = useState(false);
  const canInstall = useAtomValue(
    hostedBlenderEnvironment.installWithAgent.permissionAtom(props.environmentId),
  );
  const install = useAtomCommand(hostedBlenderEnvironment.installWithAgent, {
    reportFailure: false,
  });
  const [starting, setStarting] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const commands = props.result.commands.join("\n");

  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  const startInstall = async () => {
    setStarting(true);
    const result = await install({ environmentId: props.environmentId, input: {} });
    setStarting(false);
    if (result._tag === "Success") return openThread(result.value.threadId);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: gt("Couldn't start the setup thread"),
        description: formatEnvironmentQueryError(result.cause, m),
      }),
    );
  };

  return (
    <SettingsRow
      title={
        props.installThreadId === null ? (
          <T>Install what's missing</T>
        ) : (
          <T>An agent is installing what's missing</T>
        )
      }
      description={
        props.installThreadId === null ? (
          <T>
            An agent can install it in a new thread, asking for your password in a private card,
            never in chat. Or run the commands yourself. T3 Code never installs system packages
            itself.
          </T>
        ) : (
          <T>T3 Code checks again when the agent finishes.</T>
        )
      }
      control={
        <div className="flex flex-wrap justify-end gap-2">
          {props.installThreadId !== null ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => props.installThreadId && openThread(props.installThreadId)}
            >
              <T>Open thread</T>
            </Button>
          ) : canInstall ? (
            <Button size="sm" disabled={starting} onClick={() => void startInstall()}>
              {starting ? <Spinner /> : null}
              <T>Install with an agent</T>
            </Button>
          ) : null}
          {commands !== "" ? (
            <Button variant="outline" size="sm" onClick={() => setShowCommands((shown) => !shown)}>
              {showCommands ? <T>Hide the commands</T> : <T>Show me the commands</T>}
            </Button>
          ) : null}
        </div>
      }
    >
      {showCommands ? (
        <div className="mt-3 flex flex-col gap-2">
          <pre
            aria-label={gt("Install commands")}
            className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all"
          >
            {commands}
          </pre>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => copyToClipboard(commands)}>
              {isCopied ? <T>Copied</T> : <T>Copy commands</T>}
            </Button>
          </div>
        </div>
      ) : null}
    </SettingsRow>
  );
}

/** The official `blender-mcp`; empty finds it on PATH and in `~/.local/bin`. */
function BlenderMcpPathRow() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["blenderMcpPath"]);
  const edited = useRef(false);
  const draft = useRef("");
  return (
    <SettingsRow
      {...setting("blender-mcp-path")}
      serverScoped
      settingKeys={["blenderMcpPath"]}
      description={gt(
        "The official Blender Lab MCP server, such as ~/.local/bin/blender-mcp. Leave empty to find it on PATH or in ~/.local/bin. Check again after changing it.",
      )}
      resetAction={
        mixed || settings.blenderMcpPath !== "" ? (
          <SettingResetButton
            ariaLabel={gt("Reset Blender MCP path to default")}
            onClick={() => updateSettings({ blenderMcpPath: "" })}
          />
        ) : null
      }
      control={
        <Input
          key={`${mixed}:${settings.blenderMcpPath}`}
          aria-label={gt("Blender MCP path")}
          autoCapitalize="none"
          spellCheck={false}
          placeholder={mixed ? gt("Mixed") : gt("Find automatically")}
          defaultValue={mixed ? "" : settings.blenderMcpPath}
          onFocus={(event) => {
            draft.current = event.target.value;
          }}
          onChange={(event) => {
            edited.current = true;
            draft.current = resolvePastedPath(draft.current, event.target.value);
            event.target.value = draft.current;
          }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.blenderMcpPath))
              updateSettings({ blenderMcpPath: value });
            edited.current = false;
          }}
        />
      }
    />
  );
}
