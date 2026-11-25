import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { AsyncResult } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { showThreadUndoNotice } from "../hooks/showThreadUndoNotice";
import { ModelAnnotationEditor } from "./files/ModelAnnotationEditor";

vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
    { key: "mod+z", command: "thread.undo", when: "!terminalFocus && !editableFocus" },
  ]);
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
// The thread list needs live environments; the shortcut lives in the shell around it.
vi.mock(import("./Sidebar"), () => ({ default: (() => null) as never }));

import { AppSidebarLayout } from "./AppSidebarLayout";

describe("sidebar toggle shortcut", () => {
  it("leaves the key to a focused terminal when its rule excludes terminalFocus", async () => {
    await page.viewport(1280, 800);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(
      <AppSidebarLayout>
        <div data-terminal-owner="drawer">
          <textarea aria-label="Terminal input" />
        </div>
        <button type="button">Outside</button>
      </AppSidebarLayout>,
    );
    const wrapper = screen.container.querySelector('[data-slot="sidebar-wrapper"]')!;

    await userEvent.click(screen.getByRole("textbox", { name: "Terminal input" }));
    await userEvent.keyboard("{Control>}b{/Control}");
    expect(wrapper.getAttribute("data-sidebar-state")).toBe("expanded");

    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    await userEvent.keyboard("{Control>}b{/Control}");
    await vi.waitFor(() => expect(wrapper.getAttribute("data-sidebar-state")).toBe("collapsed"));
  });
});

describe("thread undo shortcut", () => {
  it("leaves mod+z to an open annotation editor while a thread undo notice shows", async () => {
    await page.viewport(1280, 800);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const image = document.createElement("canvas");
    image.width = 400;
    image.height = 300;
    await using screen = await render(
      <AppSidebarLayout>
        <div className="relative h-[300px] w-[400px]">
          <ModelAnnotationEditor
            image={image}
            width={400}
            height={300}
            environmentId={null}
            ownerKey="thread-undo-test"
            onCancel={() => {}}
            onSubmit={() => {}}
          />
        </div>
        <button type="button">Outside</button>
      </AppSidebarLayout>,
    );
    const undoThread = vi.fn(async () => AsyncResult.success(undefined));
    const settle = (thread: string) => {
      const claim = ThreadUndo.begin("settle", thread);
      showThreadUndoNotice({
        action: "Settled",
        failureTitle: "Undo failed",
        undo: undoThread,
        claim,
      });
      return { [Symbol.dispose]: () => ThreadUndo.invalidate("settle", thread) };
    };
    const surface = screen.getByRole("img", { name: "Frozen 3D view to annotate" }).element();
    const box = surface.getBoundingClientRect();
    const at = (x: number, y: number) => ({
      clientX: box.left + x,
      clientY: box.top + y,
      pointerId: 1,
      button: 0,
      bubbles: true,
    });
    surface.dispatchEvent(new PointerEvent("pointerdown", at(40, 100)));
    surface.dispatchEvent(new PointerEvent("pointermove", at(300, 140)));
    surface.dispatchEvent(new PointerEvent("pointerup", at(300, 140)));
    const marks = () => surface.querySelectorAll("path").length;
    await vi.waitFor(() => expect(marks()).toBe(1));

    // The notice only claims mod+z from text fields while the sidebar shows it.
    const wrapper = screen.container.querySelector('[data-slot="sidebar-wrapper"]')!;
    if (wrapper.getAttribute("data-sidebar-state") !== "expanded") {
      await userEvent.click(screen.getByRole("button", { name: "Outside" }));
      await userEvent.keyboard("{Control>}b{/Control}");
      await vi.waitFor(() => expect(wrapper.getAttribute("data-sidebar-state")).toBe("expanded"));
    }
    await userEvent.click(screen.getByRole("textbox", { name: "Annotation comment" }));
    using _settled = settle("env/thread-a");
    const comment = screen.getByRole("textbox", { name: "Annotation comment" });
    await expect.element(comment).toHaveFocus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(marks()).toBe(0);
    expect(undoThread).not.toHaveBeenCalled();

    // A comment with text keeps mod+z for its text, even when a new notice claims the key.
    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    await userEvent.type(comment, "Bevel");
    using _next = settle("env/thread-b");
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(marks()).toBe(1);
    expect(undoThread).not.toHaveBeenCalled();

    // Outside the editor, the same key undoes the thread action.
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    await userEvent.keyboard("{Control>}z{/Control}");
    await vi.waitFor(() => expect(undoThread).toHaveBeenCalled());
  });
});
