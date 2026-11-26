import "../../index.css";

import {
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  AuthSettingsWriteScope,
  EnvironmentId,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

// The real Settings row, on a connection holding only the scopes a test grants.
const state = vi.hoisted(() => ({
  grants: new Set<string>(),
  setTimeline: vi.fn(async () => ({ _tag: "Success", value: undefined })),
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((_environmentId: unknown, scope: AuthEnvironmentScope) =>
    state.grants.has(scope)) as never,
  useEnvironmentsWithScope: ((
    environments: ReadonlyArray<{ readonly environmentId: string }>,
    scope: AuthEnvironmentScope,
  ) =>
    new Set(
      state.grants.has(scope) ? environments.map((environment) => environment.environmentId) : [],
    )) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  usePrimarySettingsAvailable: () => true,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => EnvironmentId.make("environment-1")) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({ ...DEFAULT_UNIFIED_SETTINGS, hostedBlenderEnabled: true })) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => () => undefined,
}));
vi.mock(import("~/state/hostedBlender"), async (original) => {
  const actual = await original();
  const operates = () => Atom.make(state.grants.has(AuthOrchestrationOperateScope));
  return {
    ...actual,
    useHostedBlenderSetupState: (() => null) as never,
    hostedBlenderEnvironment: {
      ...actual.hostedBlenderEnvironment,
      checkSetup: { ...actual.hostedBlenderEnvironment.checkSetup, permissionAtom: operates },
      setTimeline: { ...actual.hostedBlenderEnvironment.setTimeline, permissionAtom: operates },
    } as never,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label: string }) =>
    command.label.includes("timeline") ? state.setTimeline : async () => undefined) as never,
}));

import { HostedBlenderSetupSettings } from "./HostedBlenderSetupSettings";

const environmentId = EnvironmentId.make("environment-1");
const timelineSwitch = () =>
  document.querySelector<HTMLElement>('[aria-label="Timeline in the Blender pane"]');
const agentsSwitch = () =>
  document.querySelector<HTMLElement>('[aria-label="Allow agents to start hosted Blenders"]');

describe("Settings › Blender's Timeline row", () => {
  it("S2: works for a connection that may operate hosted Blender but not change settings", async () => {
    state.grants = new Set([AuthOrchestrationOperateScope]);
    state.setTimeline.mockClear();
    await using _screen = await render(
      <HostedBlenderSetupSettings environmentId={environmentId} />,
    );
    await expect.poll(() => timelineSwitch()).not.toBeNull();
    expect(timelineSwitch()!.closest("[inert]")).toBeNull();
    // Rows written as settings stay out of its reach.
    expect(agentsSwitch()!.closest("[inert]")).not.toBeNull();
    await userEvent.click(timelineSwitch()!);
    expect(state.setTimeline).toHaveBeenCalledWith({ environmentId, input: { shown: false } });
  });

  it("S2: is out of reach for a connection that may change settings but not operate Blender", async () => {
    state.grants = new Set([AuthSettingsWriteScope]);
    await using _screen = await render(
      <HostedBlenderSetupSettings environmentId={environmentId} />,
    );
    await expect.poll(() => timelineSwitch()).not.toBeNull();
    expect(timelineSwitch()!.closest("[inert]")).not.toBeNull();
    expect(agentsSwitch()!.closest("[inert]")).toBeNull();
  });
});
