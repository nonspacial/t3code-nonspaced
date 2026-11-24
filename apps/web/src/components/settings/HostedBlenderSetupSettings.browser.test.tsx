import "../../index.css";

import {
  EnvironmentId,
  type HostedBlenderSetupCheck,
  type HostedBlenderSetupState,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  setup: null as HostedBlenderSetupState | null,
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
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({ title, description, control, children }: Record<string, ReactNode>) => (
    <div role="group" aria-label={typeof title === "string" ? title : undefined}>
      <div>{title}</div>
      <div>{description}</div>
      <div>{control}</div>
      {children}
    </div>
  )) as never,
}));
vi.mock(import("~/state/hostedBlender"), async (original) => {
  const actual = await original();
  const allowed = () => Atom.make(true);
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
    } as never,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label: string }) =>
    command.label.includes("install") ? state.install : state.check) as never,
}));

import { HostedBlenderSetupSettings } from "./HostedBlenderSetupSettings";

const environmentId = EnvironmentId.make("environment-1");

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
    state.settings = {};
    state.setup = checked(OK);
    await using screen = await render(<HostedBlenderSetupSettings environmentId={environmentId} />);
    const toggle = screen.getByRole("switch", { name: "Hosted Blender" });
    await expect.element(toggle).not.toBeChecked();
    await expect.element(screen.getByText("Check again")).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(state.updateSettings).toHaveBeenCalledWith({ hostedBlenderEnabled: true });
  });

  it("lists each check, the capture path and the encoder from the test encode", async () => {
    state.settings = { hostedBlenderEnabled: true };
    state.setup = checked(OK);
    await using screen = await render(<HostedBlenderSetupSettings environmentId={environmentId} />);
    await expect
      .element(screen.getByText("Version 0.8.4, captured with wlr-screencopy.", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("The one-second test encode used x264enc."))
      .toBeInTheDocument();
    // Nothing is missing, so there is nothing to install.
    await expect.element(screen.getByText("Install with an agent")).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("switch", { name: "Allow agents to start hosted Blenders" }))
      .toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(state.check).toHaveBeenCalledWith({ environmentId, input: {} });
  });

  it("offers an agent or the commands for what is missing, and warns about the GPU", async () => {
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
    await expect
      .element(
        screen.getByText("No GPU found. Hosted Blender still works, but Blender will be slow."),
      )
      .toBeInTheDocument();
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
  });

  it("points at the install thread while its agent works", async () => {
    state.settings = { hostedBlenderEnabled: true };
    state.setup = checked([{ item: "labwc", status: "missing" }], {
      installThreadId: ThreadId.make("thread-install"),
    });
    await using screen = await render(<HostedBlenderSetupSettings environmentId={environmentId} />);
    await expect
      .element(screen.getByText("T3 Code checks again when the agent finishes."))
      .toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Open thread" })).toBeInTheDocument();
    await expect.element(screen.getByText("Install with an agent")).not.toBeInTheDocument();
  });

  it("says why a host can't run hosted Blender", async () => {
    state.settings = { hostedBlenderEnabled: true };
    state.setup = {
      result: { status: "unavailable", reason: "distro", distro: "Ubuntu 22.04.5 LTS" },
      checking: false,
      installThreadId: null,
    };
    await using screen = await render(<HostedBlenderSetupSettings environmentId={environmentId} />);
    await expect.element(screen.getByText("Not available on this host")).toBeInTheDocument();
    await expect
      .element(screen.getByText("Ubuntu 22.04.5 LTS", { exact: false }))
      .toBeInTheDocument();
  });
});
