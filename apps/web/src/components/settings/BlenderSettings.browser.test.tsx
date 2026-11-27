import "../../index.css";

import { EnvironmentId, type HostedBlenderHeldList, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  held: [] as HostedBlenderHeldList,
  commands: [] as Array<{ readonly label: string; readonly value: unknown }>,
  // Told when `held` changes, as the server's list would tell the page.
  listeners: new Set<() => void>(),
}));

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    environment: {
      environmentId: EnvironmentId.make("environment-1"),
      connection: { phase: "connected" },
      serverConfig: null,
    },
  })) as never,
}));
vi.mock(import("~/state/hostedBlender"), async (original) => {
  const actual = await original();
  const { useSyncExternalStore } = await import("react");
  return {
    ...actual,
    useHeldWorkingCopies: (() =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => state.held,
      )) as never,
    useRunningHostedBlenders: (() => []) as never,
    hostedBlenderEnvironment: {
      ...actual.hostedBlenderEnvironment,
      deleteHeld: {
        ...actual.hostedBlenderEnvironment.deleteHeld,
        permissionAtom: () => Atom.make(true),
      },
    } as never,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { readonly label: string }) => async (value: unknown) => {
    state.commands.push({ label: command.label, value });
    return { _tag: "Success", value: undefined };
  }) as never,
}));

import { BlenderSettingsPanel } from "./BlenderSettings";

it("B19: lists held working copies with their thread, master, size and expiry, and deletes one once confirmed", async () => {
  state.held = [
    {
      id: "held-a",
      threadId: ThreadId.make("thread-a"),
      threadTitle: "Hero pass",
      master: "/home/user/acme/app/models/hero.blend",
      path: "/home/user/acme/app/models/hero.wip-3c4d5e6f.blend",
      bytes: 2048,
      heldAt: new Date(2026, 10, 20).getTime(),
      expiresAt: new Date(2026, 11, 20).getTime(),
      behind: true,
    },
    {
      id: "left-b",
      threadId: ThreadId.make("thread-b"),
      threadTitle: "Rig fix",
      master: "/home/user/acme/app/models/rig.blend",
      path: "/home/user/acme/app/models/rig.wip-0a1b2c3d.blend",
      bytes: 0,
      heldAt: new Date(2026, 10, 21).getTime(),
      leftInProject: true,
    },
  ];
  state.commands = [];
  await using screen = await render(<BlenderSettingsPanel />);
  await screen.getByText("Held working copies (2)").click();
  // The thread, where the copy comes back from, is a link to it.
  await expect
    .element(screen.getByRole("link", { name: "Hero pass" }))
    .toHaveAttribute("href", "/environment-1/thread-a");
  await expect
    .element(
      screen.getByText(
        /^Copy of hero\.blend, 2(\.0+)? KB\. The master has changed since\. Kept until [^.]*20[^.]*\.$/,
      ),
    )
    .toBeInTheDocument();
  // A copy T3 Code couldn't prove its own stays where it is, and can't be deleted from here.
  await expect
    .element(
      screen.getByText(
        "Left in the project at /home/user/acme/app/models/rig.wip-0a1b2c3d.blend: T3 Code couldn't be sure it is its own working copy, so it didn't move it.",
      ),
    )
    .toBeInTheDocument();
  const deletes = screen.getByRole("button", { name: "Delete" });
  expect(deletes.elements()).toHaveLength(1);
  await deletes.click();
  // Nothing is deleted until the person confirms.
  const confirm = screen.getByRole("alertdialog");
  await expect.element(confirm.getByText("Delete this held working copy?")).toBeInTheDocument();
  await expect.element(confirm.getByText("From Hero pass.", { exact: false })).toBeInTheDocument();
  await expect
    .element(confirm.getByText("Deleting the copy can't be undone.", { exact: false }))
    .toBeInTheDocument();
  expect(state.commands).toEqual([]);
  // Reopened and held again from another client while it is open: it still deletes the hold
  // it showed, which the server then leaves alone.
  state.held = [{ ...state.held[0]!, heldAt: new Date(2026, 10, 25).getTime() }, state.held[1]!];
  for (const listener of state.listeners) listener();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect.element(confirm).not.toBeInTheDocument();
  expect(state.commands).toEqual([
    {
      label: "environment-data:hosted-blender:delete-held",
      value: {
        environmentId: "environment-1",
        input: { copies: [{ id: "held-a", heldAt: new Date(2026, 10, 20).getTime() }] },
      },
    },
  ]);
});
