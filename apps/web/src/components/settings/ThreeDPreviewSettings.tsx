import { resolvePastedPath } from "@t3tools/shared/path";
import { useGT } from "gt-react";
import { useRef } from "react";

import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** The Blender that converts `.blend` previews; empty finds it on PATH or where it installs. */
export function ThreeDPreviewSettingsSection() {
  const setting = useSearchableSetting();
  const gt = useGT();
  const { connectedEnvironments, targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["blenderPath"]);
  const edited = useRef(false);
  const draft = useRef("");
  if (
    connectedEnvironments.length === 0 ||
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.blendConversion !== true,
    )
  )
    return null;
  const scopeKey = targets.map((target) => target.environmentId).join(",");

  return (
    <SettingsSection id="3d-previews" title={gt("3D previews")}>
      <SettingsRow
        {...setting("blender-path")}
        description={gt(
          "The Blender that turns .blend files into 3D previews, such as /usr/bin/blender or C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe. Leave empty to find it on PATH or where Blender installs.",
        )}
        serverScoped
        settingKeys={["blenderPath"]}
        resetAction={
          mixed || settings.blenderPath !== "" ? (
            <SettingResetButton
              ariaLabel={gt("Reset Blender path to default")}
              onClick={() => updateSettings({ blenderPath: "" })}
            />
          ) : null
        }
        control={
          <Input
            key={`${scopeKey}:${mixed}:${settings.blenderPath}`}
            aria-label={gt("Blender path")}
            autoCapitalize="none"
            spellCheck={false}
            placeholder={mixed ? gt("Mixed") : gt("Find automatically")}
            defaultValue={mixed ? "" : settings.blenderPath}
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
              if (edited.current && (mixed || value !== settings.blenderPath))
                updateSettings({ blenderPath: value });
              edited.current = false;
            }}
          />
        }
      />
    </SettingsSection>
  );
}
