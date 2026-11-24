import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, HostedBlenderRunningBlender } from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { fileName, useQuitHostedBlender } from "~/components/blender/useQuitHostedBlender";
import { Button } from "~/components/ui/button";
import { formatBytes } from "~/lib/formatBytes";
import { useThreadShell } from "~/state/entities";
import { hostedBlenderEnvironment, useRunningHostedBlenders } from "~/state/hostedBlender";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { HostedBlenderSetupSettings } from "./HostedBlenderSetupSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export function BlenderSettingsPanel() {
  const gt = useGT();
  const { environment } = useSettingsScope();
  const connected = environment?.connection.phase === "connected" ? environment : null;
  const setupEnvironmentId =
    connected?.serverConfig?.environment.capabilities.hostedBlenderSetup === true
      ? connected.environmentId
      : null;
  return (
    <SettingsPageContainer>
      <SettingsSection id="blender" title={gt("Blender")}>
        {setupEnvironmentId === null ? null : (
          <HostedBlenderSetupSettings environmentId={setupEnvironmentId} />
        )}
      </SettingsSection>
      {/* A card of its own, spaced from the setup card as settings sections are. */}
      <RunningBlenders environmentId={connected?.environmentId ?? null} />
    </SettingsPageContainer>
  );
}

/** Every hosted Blender on the environment, folded away until asked for. */
function RunningBlenders(props: { readonly environmentId: EnvironmentId | null }) {
  const gt = useGT();
  const { environmentId } = props;
  const blenders = useRunningHostedBlenders(environmentId) ?? [];
  return (
    <FoldedSettingsSection
      id="running-blenders"
      title={gt("Running Blenders ({count})", { count: blenders.length })}
    >
      {environmentId === null || blenders.length === 0 ? (
        <SettingsRow
          title={<T>No hosted Blenders are running</T>}
          description={<T>Each thread's hosted Blender shows here while it runs.</T>}
        />
      ) : (
        blenders.map((blender) => (
          <RunningBlenderRow
            key={blender.threadId}
            environmentId={environmentId}
            blender={blender}
          />
        ))
      )}
    </FoldedSettingsSection>
  );
}

function RunningBlenderRow(props: {
  readonly environmentId: EnvironmentId;
  readonly blender: HostedBlenderRunningBlender;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.blender.threadId);
  const thread = useThreadShell(threadRef);
  const canQuit = useAtomValue(hostedBlenderEnvironment.quit.permissionAtom(props.environmentId));
  const quit = useQuitHostedBlender(threadRef, fileName(props.blender.relativePath));
  const details = [
    props.blender.relativePath,
    props.blender.memoryBytes === null ? null : formatBytes(props.blender.memoryBytes),
  ].filter((part) => part !== null);
  return (
    <SettingsRow
      title={thread?.title ?? <T>Unknown thread</T>}
      description={<span className="font-mono">{details.join(" · ")}</span>}
      control={
        canQuit ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={quit.quitting}
              onClick={() => quit.request(props.blender.dirty)}
            >
              <T>Quit</T>
            </Button>
            {quit.dialog}
          </>
        ) : null
      }
    />
  );
}
