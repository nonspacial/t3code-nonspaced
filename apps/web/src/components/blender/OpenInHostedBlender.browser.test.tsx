import "~/index.css";

import {
  EnvironmentId,
  HostedBlenderError,
  type HostedBlenderMasterState,
  type HostedBlenderThreadState,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  thread: null as HostedBlenderThreadState | null,
  master: { status: "none" } as HostedBlenderMasterState | null,
  open: vi.fn(async (): Promise<unknown> => ({ _tag: "Success", value: undefined })),
}));

vi.mock(import("~/state/hostedBlender"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useHostedBlenderState: (() => state.thread) as never,
    useHostedBlenderMasterState: (() => state.master) as never,
    hostedBlenderEnvironment: {
      ...actual.hostedBlenderEnvironment,
      open: { ...actual.hostedBlenderEnvironment.open, permissionAtom: () => Atom.make(true) },
      openMaster: {
        ...actual.hostedBlenderEnvironment.openMaster,
        permissionAtom: () => Atom.make(true),
      },
    } as never,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.open) as never,
}));

import { useRightPanelStore } from "~/rightPanelStore";
import { blenderRoleFor, useBlenderRoleStore } from "./blenderRole";
import { OpenInHostedBlender } from "./OpenInHostedBlender";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

it("opens the file on a server nobody has checked, so the open runs the first check", async () => {
  state.thread = { status: "notSetUp", missing: ["check"] };
  await using _screen = await render(
    <OpenInHostedBlender threadRef={threadRef} relativePath="models/hero.blend" />,
  );
  await userEvent.click(page.getByRole("button", { name: "Open in hosted Blender" }));
  expect(state.open).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, relativePath: "models/hero.blend" },
  });
});

it("opens the file on a server whose check wasn't ready, so the open checks it again", async () => {
  state.open.mockClear();
  state.thread = { status: "notSetUp", missing: ["encoder"] };
  await using _screen = await render(
    <OpenInHostedBlender threadRef={threadRef} relativePath="models/hero.blend" />,
  );
  await userEvent.click(page.getByRole("button", { name: "Open in hosted Blender" }));
  expect(state.open).toHaveBeenCalledTimes(1);
});

it("only shows the pane while Hosted Blender is switched off", async () => {
  state.open.mockClear();
  state.thread = { status: "notSetUp", missing: ["enabled"] };
  await using _screen = await render(
    <OpenInHostedBlender threadRef={threadRef} relativePath="models/hero.blend" />,
  );
  await userEvent.click(page.getByRole("button", { name: "Open in hosted Blender" }));
  expect(state.open).not.toHaveBeenCalled();
});

it("shows the pane with the fresh result when opening finds setup incomplete", async () => {
  state.thread = { status: "notSetUp", missing: ["check"] };
  state.open.mockImplementationOnce(async () => ({
    _tag: "Failure",
    cause: Cause.fail(new HostedBlenderError({ reason: "notSetUp" })),
  }));
  const showPane = vi.spyOn(useRightPanelStore.getState(), "open");
  await using _screen = await render(
    <OpenInHostedBlender threadRef={threadRef} relativePath="models/hero.blend" />,
  );
  await userEvent.click(page.getByRole("button", { name: "Open in hosted Blender" }));
  await vi.waitFor(() => expect(showPane).toHaveBeenCalledWith(threadRef, "blender"));
  showPane.mockRestore();
});

const workingOnCopy: HostedBlenderThreadState = {
  status: "running",
  relativePath: "models/hero.wip-1a2b3c4d.blend",
  dirty: false,
};

it("shows the master's own Blender for the thread's running master, opening nothing", async () => {
  state.open.mockClear();
  state.thread = workingOnCopy;
  state.master = { status: "running", relativePath: "models/hero.blend", dirty: false };
  useBlenderRoleStore.getState().setRole(threadRef, "working");
  const showPane = vi.spyOn(useRightPanelStore.getState(), "open");
  await using _screen = await render(
    <OpenInHostedBlender threadRef={threadRef} relativePath="models/hero.blend" />,
  );
  await userEvent.click(page.getByRole("button", { name: "Open in hosted Blender" }));
  await vi.waitFor(() => expect(showPane).toHaveBeenCalledWith(threadRef, "blender"));
  expect(blenderRoleFor(threadRef)).toBe("master");
  expect(state.open).not.toHaveBeenCalled();
  showPane.mockRestore();
  state.master = { status: "none" };
});

it("opens the thread's known master in its master Blender when none has it open", async () => {
  state.open.mockClear();
  state.thread = workingOnCopy;
  state.master = {
    status: "notOpen",
    relativePath: "models/hero.blend",
    desktop: null,
    desktopDirty: false,
  };
  useBlenderRoleStore.getState().setRole(threadRef, "working");
  const showPane = vi.spyOn(useRightPanelStore.getState(), "open");
  await using _screen = await render(
    <OpenInHostedBlender threadRef={threadRef} relativePath="models/hero.blend" />,
  );
  await userEvent.click(page.getByRole("button", { name: "Open in hosted Blender" }));
  await vi.waitFor(() => expect(showPane).toHaveBeenCalledWith(threadRef, "blender"));
  // As the Master side's Open in T3 Code: the thread's master, not a working open of it.
  expect(state.open).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  expect(blenderRoleFor(threadRef)).toBe("master");
  showPane.mockRestore();
  state.master = { status: "none" };
});
