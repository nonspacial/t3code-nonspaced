import "~/index.css";

import {
  EnvironmentId,
  HostedBlenderError,
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
  open: vi.fn(async (): Promise<unknown> => ({ _tag: "Success", value: undefined })),
}));

vi.mock(import("~/state/hostedBlender"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useHostedBlenderState: (() => state.thread) as never,
    hostedBlenderEnvironment: {
      ...actual.hostedBlenderEnvironment,
      open: { ...actual.hostedBlenderEnvironment.open, permissionAtom: () => Atom.make(true) },
    } as never,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.open) as never,
}));

import { useRightPanelStore } from "~/rightPanelStore";
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

it("only shows the pane while something else is missing", async () => {
  state.open.mockClear();
  state.thread = { status: "notSetUp", missing: ["labwc"] };
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
