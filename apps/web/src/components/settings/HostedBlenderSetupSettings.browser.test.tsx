import "../../index.css";

import {
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  AuthSettingsWriteScope,
  EnvironmentId,
  type HostedBlenderSetupCheck,
  type HostedBlenderSetupState,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { ScopedSettingsPatch } from "./scopedSettings";

// The real Settings rows, on a connection holding only the scopes a test grants.
const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  setup: null as HostedBlenderSetupState | null,
  grants: new Set<string>(),
  setTimeline: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
  install: vi.fn(async () => ({ _tag: "Success", value: { threadId: "thread-install" } })),
  check: vi.fn(async () => ({ _tag: "Success", value: undefined })),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({ ...DEFAULT_UNIFIED_SETTINGS, ...state.settings })) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.updateSettings,
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
vi.mock(import("~/state/hostedBlender"), async (original) => {
  const actual = await original();
  const allowed = () => Atom.make(state.grants.has(AuthOrchestrationOperateScope));
  return {
    ...actual,
    useHostedBlenderSetupState: (() => state.setup) as never,
    hostedBlenderEnvironment: {
      ...actual.hostedBlenderEnvironment,
      checkSetup: { ...actual.hostedBlenderEnvironment.checkSetup, permissionAtom: allowed },
      installWithAgent: {
        ...actual.hostedBlenderEnvironment.installWithAgent,
        permissionAtom: allowed,
      },
      setTimeline: {
        ...actual.hostedBlenderEnvironment.setTimeline,
        permissionAtom: allowed,
      },
    } as never,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label: string }) =>
    command.label.includes("install")
      ? state.install
      : command.label.includes("timeline")
        ? state.setTimeline
        : state.check) as never,
}));

import { HostedBlenderSetupSettings } from "./HostedBlenderSetupSettings";

const environmentId = EnvironmentId.make("environment-1");
const BOTH = [AuthOrchestrationOperateScope, AuthSettingsWriteScope];
const timelineSwitch = () =>
  document.querySelector<HTMLElement>('[aria-label="Timeline in the Blender pane"]');
const agentsSwitch = () =>
  document.querySelector<HTMLElement>('[aria-label="Allow agents to start hosted Blenders"]');

const checked = (
  checks: ReadonlyArray<HostedBlenderSetupCheck>,
  extra: Partial<HostedBlenderSetupState> = {},
): HostedBlenderSetupState => ({
  result: {
    status: "checked",
    ready: checks.every(
      (check) => check.status === "ok" || check.item === "gpu" || check.item === "blenderMcp",
    ),
    checks,
    distro: "Arch Linux",
    packageManager: "pacman",
    capture: "wlr-screencopy",
    commands: ["sudo pacman -S --needed labwc"],
    checkedAt: 0,
  },
  checking: false,
  installThreadId: null,
  ...extra,
});

const OK: ReadonlyArray<HostedBlenderSetupCheck> = [
  { item: "helper", status: "ok" },
  { item: "blender", status: "ok", found: "5.0.1" },
  { item: "labwc", status: "ok", found: "0.8.4" },
  { item: "gstreamer", status: "ok", found: "1.26.5" },
  { item: "encoder", status: "ok", found: "x264enc" },
  { item: "gpu", status: "ok" },
  { item: "blenderMcp", status: "ok", found: "/home/me/.local/bin/blender-mcp" },
];

describe("HostedBlenderSetupSettings", () => {
  it("is off by default and shows only its switch until switched on", async () => {
    state.grants = new Set(BOTH);
    state.settings = {};
    state.setup = checked(OK);
    await using screen = await render(<HostedBlenderSetupSettings environmentId={environmentId} />);
    const toggle = screen.getByRole("switch", { name: "Hosted Blender" });
    await expect.element(toggle).not.toBeChecked();
    await expect.element(screen.getByText("Check again")).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(state.updateSettings).toHaveBeenCalledWith({ hostedBlenderEnabled: true });
  });

  it("lets only a session that may run programs here switch it on, and anyone switch it off", async () => {
    state.grants = new Set([AuthSettingsWriteScope]);
    state.settings = {};
    state.setup = null;
    await using off = await render(<HostedBlenderSetupSettings environmentId={environmentId} />);
    await expect.element(off.getByRole("switch", { name: "Hosted Blender" })).toBeDisabled();
    await off.unmount();
    state.settings = { hostedBlenderEnabled: true };
    state.setup = checked(OK);
    await using on = await render(<HostedBlenderSetupSettings environmentId={environmentId} />);
    await expect.element(on.getByRole("switch", { name: "Hosted Blender" })).toBeEnabled();
  });

  it("S2: the Timeline switch, on by default, is reached by operating hosted Blender, not by changing settings, as the pane's menu is", async () => {
    state.grants = new Set([AuthOrchestrationOperateScope]);
    state.settings = { hostedBlenderEnabled: true };
    state.setup = null;
    state.setTimeline.mockClear();
    state.updateSettings.mockClear();
    await using screen = await render(<HostedBlenderSetupSettings environmentId={environmentId} />);
    await expect
      .element(screen.getByRole("switch", { name: "Timeline in the Blender pane" }))
      .toBeChecked();
    expect(timelineSwitch()!.closest("[inert]")).toBeNull();
    // Rows written as settings stay out of its reach.
    expect(agentsSwitch()!.closest("[inert]")).not.toBeNull();
    await userEvent.click(timelineSwitch()!);
    // The operate-gated command, never a plain settings write.
    expect(state.setTimeline).toHaveBeenCalledWith({ environmentId, input: { shown: false } });
    expect(state.updateSettings).not.toHaveBeenCalledWith({ hostedBlenderTimeline: false });
    await screen.unmount();

    // A connection that may change settings but not operate Blender can't reach it.
    state.grants = new Set([AuthSettingsWriteScope]);
    await using settingsOnly = await render(
      <HostedBlenderSetupSettings environmentId={environmentId} />,
    );
    await expect
      .element(settingsOnly.getByRole("switch", { name: "Timeline in the Blender pane" }))
      .toBeInTheDocument();
    expect(timelineSwitch()!.closest("[inert]"), "settings-only: Timeline").not.toBeNull();
    expect(agentsSwitch()!.closest("[inert]"), "settings-only: settings rows").toBeNull();
  });

  it("offers an agent or the commands for what is missing, keeping agents off, and one install at a time", async () => {
    state.grants = new Set(BOTH);
    state.settings = { hostedBlenderEnabled: true };
    state.setup = checked(
      OK.map((check) =>
        check.item === "labwc"
          ? { item: "labwc", status: "missing" }
          : check.item === "gpu"
            ? { item: "gpu", status: "warning" }
            : check.item === "blenderMcp"
              ? { item: "blenderMcp", status: "missing" }
              : check,
      ),
    );
    await using screen = await render(<HostedBlenderSetupSettings environmentId={environmentId} />);
    // Agents need setup finished and the Blender MCP.
    await expect
      .element(screen.getByRole("switch", { name: "Allow agents to start hosted Blenders" }))
      .toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Show me the commands" }));
    await expect
      .element(page.getByLabelText("Install commands"))
      .toHaveTextContent("sudo pacman -S --needed labwc");
    await userEvent.click(screen.getByRole("button", { name: "Install with an agent" }));
    expect(state.install).toHaveBeenCalledWith({ environmentId, input: {} });

    // While the install's agent works, the section points at its thread instead.
    state.setup = checked([{ item: "labwc", status: "missing" }], {
      installThreadId: ThreadId.make("thread-install"),
    });
    await screen.rerender(<HostedBlenderSetupSettings environmentId={environmentId} />);
    await expect.element(screen.getByRole("button", { name: "Open thread" })).toBeInTheDocument();
    await expect.element(screen.getByText("Install with an agent")).not.toBeInTheDocument();
  });

  it("waits for someone allowed to run programs before checking", async () => {
    state.grants = new Set(BOTH);
    state.settings = { hostedBlenderEnabled: true };
    state.setup = { result: null, checking: false, installThreadId: null };
    state.check.mockClear();
    await using screen = await render(<HostedBlenderSetupSettings environmentId={environmentId} />);
    await expect.element(screen.getByText("Not checked yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(state.check).toHaveBeenCalledWith({ environmentId, input: {} });
  });

  it("says when the blender-mcp found isn't Blender Lab's, and keeps agents off", async () => {
    state.grants = new Set(BOTH);
    state.settings = { hostedBlenderEnabled: true };
    state.setup = checked(
      OK.map((check) =>
        check.item === "blenderMcp"
          ? { item: "blenderMcp", status: "unrecognized", found: "/usr/bin/blender-mcp" }
          : check,
      ),
    );
    await using screen = await render(<HostedBlenderSetupSettings environmentId={environmentId} />);
    await expect.element(screen.getByText("Not Blender Lab's")).toBeInTheDocument();
    await expect
      .element(screen.getByText("is a different project with the same name", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("switch", { name: "Allow agents to start hosted Blenders" }))
      .toBeDisabled();
    await expect.element(screen.getByText("Install with an agent")).toBeInTheDocument();
  });
});
