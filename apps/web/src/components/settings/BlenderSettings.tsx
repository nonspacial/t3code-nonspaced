import { useGT } from "gt-react";

import { HostedBlenderSetupSettings } from "./HostedBlenderSetupSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export function BlenderSettingsPanel() {
  const gt = useGT();
  const { environment } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.hostedBlenderSetup === true
      ? environment.environmentId
      : null;
  return (
    <SettingsPageContainer>
      <SettingsSection id="blender" title={gt("Blender")}>
        {environmentId === null ? null : (
          <HostedBlenderSetupSettings environmentId={environmentId} />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
