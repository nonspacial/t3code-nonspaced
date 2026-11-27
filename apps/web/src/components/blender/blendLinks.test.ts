import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type HostedBlenderThreadState, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { hostedBlenderOpensLink, openBlendLink } from "./blendLinks";
import { blenderRoleFor } from "./blenderRole";

const running = { status: "running", relativePath: "models/hero.blend", dirty: false } as const;

describe("hostedBlenderOpensLink", () => {
  const copy = (status: "closed" | "crashed", relativePath: string) => ({
    key: `workspace:${relativePath}`,
    kind: status,
    file: { kind: "workspace" as const, relativePath },
    recovery: true,
  });
  const ended = (status: "closed" | "crashed"): HostedBlenderThreadState => ({
    status,
    copies: [copy(status, "models/hero.blend"), copy(status, "models/older.blend")],
  });

  it.each<{
    label: string;
    path: string;
    root?: string;
    state: HostedBlenderThreadState | null;
    opens: boolean;
  }>([
    { label: "the open file", path: "models/hero.blend", state: running, opens: true },
    { label: "the open file as ./", path: "./models/hero.blend", state: running, opens: true },
    {
      label: "the open file by absolute path",
      path: "/work/models/hero.blend",
      root: "/work/",
      state: running,
      opens: true,
    },
    {
      label: "a starting Blender's file",
      path: "models/hero.blend",
      state: { ...running, status: "starting" },
      opens: true,
    },
    ...(["closed", "crashed"] as const).flatMap((status) => [
      {
        label: `a ${status} Blender's copy`,
        path: "models/hero.blend",
        state: ended(status),
        opens: true,
      },
      {
        label: `a ${status} Blender's other copy`,
        path: "/work/models/older.blend",
        state: ended(status),
        opens: true,
      },
      {
        label: `a file a ${status} Blender kept nothing of`,
        path: "models/other.blend",
        state: ended(status),
        opens: false,
      },
    ]),
    { label: "another file", path: "models/other.blend", state: running, opens: false },
    {
      label: "a file outside the workspace",
      path: "/elsewhere/models/hero.blend",
      state: running,
      opens: false,
    },
    {
      label: "a stopped Blender",
      path: "models/hero.blend",
      state: { status: "stopped" },
      opens: false,
    },
    { label: "no Blender", path: "models/hero.blend", state: null, opens: false },
  ])("opens the pane only for a file the thread's Blender has open or kept: $label", (row) => {
    expect(hostedBlenderOpensLink(row.path, row.root ?? "/work", row.state)).toBe(row.opens);
  });
});

describe("openBlendLink", () => {
  const surfaces = (ref: ReturnType<typeof scopeThreadRef>) =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces.map(
      (surface) => surface.kind,
    );
  const view = { position: [6, -6, 5], target: [0, 0, 1] } as const;

  it("N7: opens the file preview at once, asking for no Blender state, with Hosted Blender off", async () => {
    const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-blend-off"));
    const openFile = vi.fn();
    const readState = vi.fn(async () => running);
    const readMasterState = vi.fn(async () => null);
    await openBlendLink({
      hostedBlenderEnabled: false,
      threadRef,
      path: "models/hero.blend",
      workspaceRoot: "/work",
      openFile,
      readState,
      readMasterState,
    });
    expect(openFile).toHaveBeenCalledOnce();
    expect(readState).not.toHaveBeenCalled();
    expect(readMasterState).not.toHaveBeenCalled();
  });

  it("gives way to whatever the user opened in the panel while it looked or moved the view", async () => {
    const looking = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-blend-2"));
    const lookup = Promise.withResolvers<HostedBlenderThreadState | null>();
    const openFile = vi.fn();
    const opening = openBlendLink({
      hostedBlenderEnabled: true,
      threadRef: looking,
      path: "models/hero.blend",
      workspaceRoot: "/work",
      openFile,
      readState: () => lookup.promise,
      readMasterState: async () => null,
    });
    useRightPanelStore.getState().openFile(looking, "notes.md");
    lookup.resolve(running);
    await opening;
    expect(surfaces(looking), "while it looked up the state").not.toContain("blender");

    const moving = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-blend-6"));
    const moved = Promise.withResolvers<"moved" | "otherFile" | "failed">();
    const asked = Promise.withResolvers<void>();
    const movingOpen = openBlendLink({
      hostedBlenderEnabled: true,
      threadRef: moving,
      path: "models/hero.blend",
      workspaceRoot: "/work",
      view,
      openFile,
      readState: async () => running,
      readMasterState: async () => null,
      setView: () => {
        asked.resolve();
        return moved.promise;
      },
    });
    await asked.promise;
    useRightPanelStore.getState().openFile(moving, "notes.md");
    moved.resolve("otherFile");
    await movingOpen;
    expect(surfaces(moving), "while the view was moving").not.toContain("blender");
    expect(openFile).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "moves the person's viewport window to the link's camera, in the pane",
      path: "models/hero.blend",
      answer: "moved",
      pane: true,
    },
    {
      label: "leaves a link on another file to the 3D preview",
      path: "models/other.blend",
      answer: "moved",
      pane: false,
    },
    {
      label: "opens the 3D preview when the Blender has since moved on to another file",
      path: "models/hero.blend",
      // The cached state still names the file; the server knows it's no longer open.
      answer: "otherFile",
      pane: false,
    },
  ] as const)("with a view link, $label", async ({ label, path, answer, pane }) => {
    const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make(`thread-${label}`));
    const setView = vi.fn(async () => answer);
    const openFile = vi.fn();
    await openBlendLink({
      hostedBlenderEnabled: true,
      threadRef,
      path,
      workspaceRoot: "/work",
      view,
      openFile,
      readState: async () => running,
      readMasterState: async () => null,
      setView,
    });
    expect(surfaces(threadRef).includes("blender"), "the Blender pane").toBe(pane);
    expect(openFile.mock.calls.length > 0, "the 3D preview").toBe(!pane);
    expect(setView.mock.calls, "the viewport window moved").toEqual(
      path === "models/other.blend" ? [] : [[threadRef, path, view, "working"]],
    );
  });
});

describe("openBlendLink to a master", () => {
  it("opens the Blender pane on its Master side for the file the thread's master Blender has", async () => {
    const threadRef = scopeThreadRef(
      "env-1" as EnvironmentId,
      ThreadId.make("thread-blend-master"),
    );
    const openFile = vi.fn();
    const setView = vi.fn(async () => "moved" as const);
    const view = { position: [6, -6, 5], target: [0, 0, 1] } as const;
    await openBlendLink({
      hostedBlenderEnabled: true,
      threadRef,
      path: "/work/models/hero.blend",
      workspaceRoot: "/work",
      view,
      openFile,
      readState: async () => ({ ...running, relativePath: "models/hero.wip-1a2b3c4d.blend" }),
      readMasterState: async () => running,
      setView,
    });
    expect(openFile).not.toHaveBeenCalled();
    expect(
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      ).surfaces.map((surface) => surface.kind),
    ).toContain("blender");
    expect(blenderRoleFor(threadRef)).toBe("master");
    // The person's viewport window in the master Blender moves, not the working one's.
    expect(setView).toHaveBeenCalledWith(threadRef, "models/hero.blend", view, "master");

    const working = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-blend-wip"));
    await openBlendLink({
      hostedBlenderEnabled: true,
      threadRef: working,
      path: "models/hero.blend",
      workspaceRoot: "/work",
      openFile: vi.fn(),
      readState: async () => running,
      readMasterState: async () => ({ ...running, relativePath: "models/other.blend" }),
    });
    expect(blenderRoleFor(working), "a link to the working copy opens its side").toBe("working");
  });
});
