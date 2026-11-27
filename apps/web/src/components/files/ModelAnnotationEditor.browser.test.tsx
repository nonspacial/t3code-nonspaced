import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { isMacPlatform } from "~/lib/utils";

import { render } from "../../../test/render";
import { ModelAnnotationEditor, type ModelAnnotationResult } from "./ModelAnnotationEditor";

const WIDTH = 400;
const HEIGHT = 300;
const GREY = [128, 128, 128];
const RED = [0xef, 0x44, 0x44];

type At = [number, number];

/** The platform's command key, as the editor reads it. */
const MOD = isMacPlatform(navigator.platform) ? "Meta" : "Control";

function setup(pane = "relative h-[300px] w-[400px]") {
  const image = document.createElement("canvas");
  image.width = WIDTH;
  image.height = HEIGHT;
  const context = image.getContext("2d")!;
  context.fillStyle = "rgb(128, 128, 128)";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  const onSubmit = vi.fn<(result: ModelAnnotationResult) => void>();
  const onCancel = vi.fn();
  const outside = vi.fn();
  const container = document.createElement("div");
  // The size of the snapshot, so a point on the surface is the same point on the snapshot.
  container.className = pane;
  const element = (
    <div onKeyDown={(event) => outside(event.key)}>
      <ModelAnnotationEditor
        image={image}
        width={WIDTH}
        height={HEIGHT}
        environmentId={null}
        ownerKey="model-annotation-test"
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    </div>
  );
  return { element, container, onSubmit, onCancel, outside };
}

type Screen = Awaited<ReturnType<typeof render>>;

const surfaceOf = (screen: Screen) =>
  screen.getByRole("img", { name: "Frozen 3D view to annotate" }).element();

function pointer(target: Element, type: string, [x, y]: At, init: PointerEventInit = {}) {
  const box = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, {
      clientX: box.left + (x / WIDTH) * box.width,
      clientY: box.top + (y / HEIGHT) * box.height,
      pointerId: 1,
      button: 0,
      bubbles: true,
      ...init,
    }),
  );
}

function drag(target: Element, path: ReadonlyArray<At>, init: PointerEventInit = {}) {
  pointer(target, "pointerdown", path[0]!, init);
  for (const point of path.slice(1)) pointer(target, "pointermove", point, init);
  pointer(target, "pointerup", path.at(-1)!, init);
}

const paths = (screen: Screen) => Array.from(surfaceOf(screen).querySelectorAll("path"));
const numbers = (path: SVGPathElement) =>
  (path.getAttribute("d")?.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

async function pickTool(screen: Screen, name: string) {
  await userEvent.click(screen.getByRole("button", { name, exact: true }));
}

async function submit(screen: Screen, onSubmit: ReturnType<typeof setup>["onSubmit"]) {
  await userEvent.click(screen.getByRole("button", { name: "Add to chat" }));
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  return onSubmit.mock.calls[0]![0];
}

async function pixels(dataUrl: string) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  return ([x, y]: At) => Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3));
}

it("draws marks in the picked colour and fill, and Shift straightens a drag even pressed mid-drag", async () => {
  const { element, container, onSubmit } = setup();
  await using screen = await render(element, { container });
  const surface = surfaceOf(screen);

  await pickTool(screen, "Line");
  drag(surface, [
    [40, 40],
    [160, 70],
  ]);
  await pickTool(screen, "Arrow");
  // Shift pressed and let go mid-drag takes effect before the pointer moves again.
  pointer(surface, "pointerdown", [100, 150]);
  pointer(surface, "pointermove", [300, 170]);
  // Where the arrow's shaft ends, just short of its tip.
  const shaftEnd = () => numbers(paths(screen)[1]!).slice(2, 4);
  await vi.waitFor(() => expect(shaftEnd()[1]).toBeCloseTo(168.2, 1));
  const shift = (type: string) =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent(type, { key: "Shift", shiftKey: type === "keydown", bubbles: true }),
    );
  shift("keydown");
  await vi.waitFor(() => expect(shaftEnd()).toEqual([282, 150]));
  shift("keyup");
  await vi.waitFor(() => expect(shaftEnd()[1]).toBeCloseTo(168.2, 1));
  pointer(surface, "pointerup", [300, 170], { shiftKey: true });

  // New marks take the picked colour and fill; earlier marks keep theirs.
  await expect
    .element(screen.getByRole("button", { name: "Theme color" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(screen.getByRole("button", { name: "Fill regions" }))
    .toHaveAttribute("aria-pressed", "true");
  await pickTool(screen, "Mark a region");
  drag(surface, [
    [20, 200],
    [120, 290],
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Red", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Fill regions" }));
  drag(surface, [
    [200, 200],
    [300, 290],
  ]);
  await vi.waitFor(() => expect(paths(screen).at(-1)?.getAttribute("stroke")).toBe("#ef4444"));
  const [themed, outlined] = paths(screen).slice(-2);
  expect(themed?.getAttribute("stroke")).not.toBe("#ef4444");
  expect(themed?.getAttribute("fill")).toBe(themed?.getAttribute("stroke"));
  expect(outlined?.getAttribute("fill")).toBe("none");

  const result = await submit(screen, onSubmit);
  // The screenshot shows the arrowhead at the drag's end, and not at its start.
  const at = await pixels(result.screenshot);
  expect(at([294, 150])).not.toEqual(GREY);
  expect(at([290, 145])).not.toEqual(GREY);
  expect(at([105, 145])).toEqual(GREY);
  expect(at([100, 55])).not.toEqual(GREY);
  expect(at([100, 55]), "an earlier mark keeps its colour").not.toEqual(RED);
  // The first region is outlined and lightly filled in the theme's colour.
  expect(at([20, 245])).not.toEqual(GREY);
  expect(at([20, 245])).not.toEqual(RED);
  expect(at([70, 245])).not.toEqual(GREY);
  // The second is outlined in red and left clear.
  expect(at([200, 245])).toEqual(RED);
  expect(at([250, 245])).toEqual(GREY);
});

it("undoes and redoes marks, erasing included, from the keyboard and the toolbar", async () => {
  const { element, container, onSubmit, outside } = setup();
  await using screen = await render(element, { container });
  const surface = surfaceOf(screen);
  const comment = screen.getByRole("textbox", { name: "Annotation comment" });
  await expect.element(comment).toHaveFocus();
  const marks = () => paths(screen).length;
  const undoKey = () => userEvent.keyboard(`{${MOD}>}z{/${MOD}}`);
  const redoKey = () => userEvent.keyboard(`{${MOD}>}{Shift>}z{/Shift}{/${MOD}}`);

  // A drag ends where it is let go, not at its last move.
  await pickTool(screen, "Line");
  pointer(surface, "pointerdown", [40, 40]);
  pointer(surface, "pointermove", [100, 40]);
  pointer(surface, "pointerup", [160, 70]);
  await vi.waitFor(() => expect(marks()).toBe(1));
  expect(numbers(paths(screen)[0]!), "the drag's end").toEqual([40, 40, 160, 70]);

  // The history keys stay in the editor when a focused button they disable runs out.
  const button = (name: string) =>
    screen.getByRole("button", { name, exact: true }).element() as HTMLElement;
  button("Undo").focus();
  await undoKey();
  expect(marks(), "undo focused, run out").toBe(0);
  await redoKey();
  expect(marks(), "undo focused, run out").toBe(1);
  await undoKey();
  button("Redo").focus();
  await redoKey();
  expect(marks(), "redo focused, run out").toBe(1);
  await undoKey();
  expect(marks(), "redo focused, run out").toBe(0);
  // Any focused button the undo leaves disabled, such as Add to chat with no comment.
  await redoKey();
  button("Add to chat").focus();
  await undoKey();
  expect(marks(), "Add to chat focused, disabled").toBe(0);
  await redoKey();
  expect(marks(), "Add to chat focused, disabled").toBe(1);
  await userEvent.click(screen.getByRole("button", { name: "Undo", exact: true }));
  expect(marks()).toBe(0);

  await pickTool(screen, "Line");
  drag(surface, [
    [40, 100],
    [360, 100],
  ]);
  await pickTool(screen, "Mark a region");
  drag(surface, [
    [100, 180],
    [200, 260],
  ]);
  await vi.waitFor(() => expect(marks()).toBe(2));

  await userEvent.click(comment);
  await userEvent.keyboard(`{${MOD}>}z{/${MOD}}`);
  expect(marks()).toBe(1);
  await userEvent.keyboard(`{${MOD}>}{Shift>}z{/Shift}{/${MOD}}`);
  expect(marks()).toBe(2);

  await pickTool(screen, "Erase a mark");
  drag(surface, [
    [200, 102],
    [200, 102],
  ]);
  await vi.waitFor(() => expect(marks()).toBe(1));
  await userEvent.keyboard(`{${MOD}>}z{/${MOD}}`);
  expect(marks()).toBe(2);
  await userEvent.keyboard(`{${MOD}>}y{/${MOD}}`);
  expect(marks()).toBe(1);
  await userEvent.click(screen.getByRole("button", { name: "Undo", exact: true }));
  expect(marks()).toBe(2);
  await userEvent.click(screen.getByRole("button", { name: "Redo", exact: true }));
  expect(marks()).toBe(1);
  await userEvent.click(screen.getByRole("button", { name: "Undo", exact: true }));
  // None of it reached what sits behind the editor.
  expect(outside).not.toHaveBeenCalledWith("z");
  expect(outside).not.toHaveBeenCalledWith("y");

  // With text of its own, the comment box keeps Ctrl+Z for its text.
  await userEvent.click(comment);
  await userEvent.keyboard("Bevel");
  await userEvent.keyboard(`{${MOD}>}z{/${MOD}}`);
  expect(marks()).toBe(2);
  expect(outside).not.toHaveBeenCalledWith("z");

  const result = await submit(screen, onSubmit);
  expect(result.strokes).toHaveLength(1);
  expect(result.regions).toHaveLength(1);
});

it("keeps marks inside the snapshot when the pane letterboxes it", async () => {
  await page.viewport(1280, 800);
  const { element, container } = setup("relative h-[300px] w-[600px]");
  await using screen = await render(element, { container });
  const surface = surfaceOf(screen);
  const box = surface.getBoundingClientRect();
  // The snapshot is centred: its right edge is 100 px from the pane's.
  const at = (x: number, y: number) => ({
    clientX: box.left + 100 + x,
    clientY: box.top + y,
    pointerId: 1,
    button: 0,
    bubbles: true,
  });
  await pickTool(screen, "Line");
  surface.dispatchEvent(new PointerEvent("pointerdown", at(300, 150)));
  surface.dispatchEvent(new PointerEvent("pointermove", at(420, 150)));
  surface.dispatchEvent(new PointerEvent("pointerup", at(420, 150)));
  await vi.waitFor(() => expect(paths(screen)).toHaveLength(1));
  // The line's round end reaches past the snapshot's edge, where the screenshot cuts it off.
  expect(document.elementFromPoint(box.left + 100 + 399, box.top + 150)).toBe(paths(screen)[0]);
  expect(document.elementFromPoint(box.left + 100 + 401, box.top + 150)).not.toBe(paths(screen)[0]);

  // A press in the margin is not on the snapshot: it neither erases the edge mark nor draws.
  surface.dispatchEvent(new PointerEvent("pointerdown", at(480, 150)));
  surface.dispatchEvent(new PointerEvent("pointermove", at(480, 250)));
  surface.dispatchEvent(new PointerEvent("pointerup", at(480, 250)));
  await pickTool(screen, "Erase a mark");
  surface.dispatchEvent(new PointerEvent("pointerdown", at(480, 150)));
  surface.dispatchEvent(new PointerEvent("pointerup", at(480, 150)));
  expect(paths(screen)).toHaveLength(1);
  surface.dispatchEvent(new PointerEvent("pointerdown", at(398, 150)));
  surface.dispatchEvent(new PointerEvent("pointerup", at(398, 150)));
  await vi.waitFor(() => expect(paths(screen)).toHaveLength(0));
});

it("leaves an IME's Escape to the composition, in the comment and on the surface", async () => {
  const { element, container, onCancel } = setup();
  await using screen = await render(element, { container });
  const escape = (target: Element, isComposing: boolean) =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", isComposing, bubbles: true, cancelable: true }),
    );
  const comment = screen.getByRole("textbox", { name: "Annotation comment" }).element();
  escape(comment, true);
  escape(surfaceOf(screen), true);
  expect(onCancel).not.toHaveBeenCalled();
  escape(comment, false);
  expect(onCancel).toHaveBeenCalledTimes(1);
});
