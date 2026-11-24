import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type HostedBlenderThreadState, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { hostedBlenderOpensLink, openBlendLink } from "./blendLinks";

const running = { status: "running", relativePath: "models/hero.blend", dirty: false } as const;

describe("hostedBlenderOpensLink", () => {
  it("opens the pane for the file the thread's Blender has open, however the link spells it", () => {
    expect(hostedBlenderOpensLink("models/hero.blend", "/work", running)).toBe(true);
    expect(hostedBlenderOpensLink("./models/hero.blend", "/work", running)).toBe(true);
    expect(hostedBlenderOpensLink("/work/models/hero.blend", "/work/", running)).toBe(true);
    expect(
      hostedBlenderOpensLink("models/hero.blend", "/work", { ...running, status: "starting" }),
    ).toBe(true);
  });

  it("opens the 3D preview for any other file, or when no Blender has it open", () => {
    expect(hostedBlenderOpensLink("models/other.blend", "/work", running)).toBe(false);
    expect(hostedBlenderOpensLink("/elsewhere/models/hero.blend", "/work", running)).toBe(false);
    expect(hostedBlenderOpensLink("models/hero.blend", "/work", { status: "stopped" })).toBe(false);
    expect(hostedBlenderOpensLink("models/hero.blend", "/work", null)).toBe(false);
  });
});

describe("openBlendLink", () => {
  const surfaces = (ref: ReturnType<typeof scopeThreadRef>) =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces.map(
      (surface) => surface.kind,
    );

  it("opens the Blender pane once the thread's Blender is known to have the file", async () => {
    const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-blend-1"));
    const openFile = vi.fn();
    await openBlendLink({
      threadRef,
      path: "models/hero.blend",
      workspaceRoot: "/work",
      openFile,
      readState: async () => running,
    });
    expect(surfaces(threadRef)).toContain("blender");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("gives way to whatever the user opened in the panel while it looked", async () => {
    const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-blend-2"));
    const lookup = Promise.withResolvers<HostedBlenderThreadState | null>();
    const openFile = vi.fn();
    const opening = openBlendLink({
      threadRef,
      path: "models/hero.blend",
      workspaceRoot: "/work",
      openFile,
      readState: () => lookup.promise,
    });
    useRightPanelStore.getState().openFile(threadRef, "notes.md");
    lookup.resolve(running);
    await opening;
    expect(surfaces(threadRef)).not.toContain("blender");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("moves the person's viewport window to a view link's camera", async () => {
    const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-blend-3"));
    const setView = vi.fn(async () => "moved" as const);
    const view = { position: [6, -6, 5], target: [0, 0, 1] } as const;
    await openBlendLink({
      threadRef,
      path: "models/hero.blend",
      workspaceRoot: "/work",
      view,
      openFile: vi.fn(),
      readState: async () => running,
      setView,
    });
    expect(surfaces(threadRef)).toContain("blender");
    expect(setView).toHaveBeenCalledWith(threadRef, "models/hero.blend", view);
  });

  it("leaves a view link on another file to the 3D preview", async () => {
    const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-blend-4"));
    const setView = vi.fn(async () => "moved" as const);
    const openFile = vi.fn();
    await openBlendLink({
      threadRef,
      path: "models/other.blend",
      workspaceRoot: "/work",
      view: { position: [6, -6, 5], target: [0, 0, 1] },
      openFile,
      readState: async () => running,
      setView,
    });
    expect(openFile).toHaveBeenCalled();
    expect(setView).not.toHaveBeenCalled();
  });

  it("opens the file preview when the Blender has since moved on to another file", async () => {
    const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-blend-5"));
    const openFile = vi.fn();
    await openBlendLink({
      threadRef,
      path: "models/hero.blend",
      workspaceRoot: "/work",
      view: { position: [6, -6, 5], target: [0, 0, 1] },
      openFile,
      // The cached state still names the file; the server knows it's no longer open.
      readState: async () => running,
      setView: async () => "otherFile",
    });
    expect(openFile).toHaveBeenCalled();
    expect(surfaces(threadRef)).not.toContain("blender");
  });
});
