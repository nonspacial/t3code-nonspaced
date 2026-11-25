import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ModelAnnotationEditor, type ModelAnnotationResult } from "./ModelAnnotationEditor";

const WIDTH = 400;
const HEIGHT = 300;
const GREY = [128, 128, 128];
const RED = [0xef, 0x44, 0x44];

type At = [number, number];

function setup() {
  const image = document.createElement("canvas");
  image.width = WIDTH;
  image.height = HEIGHT;
  const context = image.getContext("2d")!;
  context.fillStyle = "rgb(128, 128, 128)";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  const onSubmit = vi.fn<(result: ModelAnnotationResult) => void>();
  const outside = vi.fn();
  const container = document.createElement("div");
  // The size of the snapshot, so a point on the surface is the same point on the snapshot.
  container.className = "relative h-[300px] w-[400px]";
  const element = (
    <div onKeyDown={(event) => outside(event.key)}>
      <ModelAnnotationEditor
        image={image}
        width={WIDTH}
        height={HEIGHT}
        environmentId={null}
        ownerKey="model-annotation-test"
        onCancel={() => {}}
        onSubmit={onSubmit}
      />
    </div>
  );
  return { element, container, onSubmit, outside };
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

it("draws lines and arrows, and Shift straightens each tool, even pressed mid-drag", async () => {
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

  await pickTool(screen, "Draw");
  drag(
    surface,
    [
      [20, 250],
      [60, 220],
      [90, 280],
      [130, 240],
    ],
    { shiftKey: true },
  );
  await pickTool(screen, "Mark a region");
  drag(
    surface,
    [
      [250, 200],
      [330, 230],
    ],
    { shiftKey: true },
  );

  const result = await submit(screen, onSubmit);
  const [line, arrow, pen] = result.strokes;
  expect(line?.points).toEqual([
    { x: 40, y: 40 },
    { x: 160, y: 70 },
  ]);
  // The arrow snapped flat, and is sent from its tip so what it points at is found first.
  expect(arrow?.points[0]?.x).toBeCloseTo(300, 6);
  expect(arrow?.points[0]?.y).toBeCloseTo(150, 6);
  expect(arrow?.points[1]).toEqual({ x: 100, y: 150 });
  expect(pen?.points).toEqual([
    { x: 20, y: 250 },
    { x: 130, y: 240 },
  ]);
  expect(result.regions[0]?.rect).toEqual({ x: 250, y: 200, width: 80, height: 80 });

  // The screenshot shows the arrowhead at the drag's end, and not at its start.
  const at = await pixels(result.screenshot);
  expect(at([294, 150])).not.toEqual(GREY);
  expect(at([290, 145])).not.toEqual(GREY);
  expect(at([105, 145])).toEqual(GREY);
  expect(at([100, 55])).not.toEqual(GREY);
});

it("undoes and redoes marks, erasing included, from the keyboard and the toolbar", async () => {
  const { element, container, onSubmit, outside } = setup();
  await using screen = await render(element, { container });
  const surface = surfaceOf(screen);
  const comment = screen.getByRole("textbox", { name: "Annotation comment" });
  await expect.element(comment).toHaveFocus();
  const marks = () => paths(screen).length;

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
  await userEvent.keyboard("{Control>}z{/Control}");
  expect(marks()).toBe(1);
  await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
  expect(marks()).toBe(2);

  await pickTool(screen, "Erase a mark");
  drag(surface, [
    [200, 102],
    [200, 102],
  ]);
  await vi.waitFor(() => expect(marks()).toBe(1));
  await userEvent.keyboard("{Control>}z{/Control}");
  expect(marks()).toBe(2);
  await userEvent.keyboard("{Control>}y{/Control}");
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
  await userEvent.keyboard("{Control>}z{/Control}");
  expect(marks()).toBe(2);
  expect(outside).not.toHaveBeenCalledWith("z");

  const result = await submit(screen, onSubmit);
  expect(result.strokes).toHaveLength(1);
  expect(result.regions).toHaveLength(1);
});

it("draws new marks in the picked color and fill; earlier marks keep theirs", async () => {
  const { element, container, onSubmit } = setup();
  await using screen = await render(element, { container });
  const surface = surfaceOf(screen);
  await expect
    .element(screen.getByRole("button", { name: "Theme color" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(screen.getByRole("button", { name: "Fill regions" }))
    .toHaveAttribute("aria-pressed", "true");

  await pickTool(screen, "Mark a region");
  drag(surface, [
    [20, 20],
    [120, 120],
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Red", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Fill regions" }));
  drag(surface, [
    [200, 20],
    [300, 120],
  ]);
  await pickTool(screen, "Arrow");
  drag(surface, [
    [50, 200],
    [350, 200],
  ]);

  const [themed, outlined] = paths(screen);
  expect(themed?.getAttribute("stroke")).not.toBe("#ef4444");
  expect(themed?.getAttribute("fill")).toBe(themed?.getAttribute("stroke"));
  expect(outlined?.getAttribute("stroke")).toBe("#ef4444");
  expect(outlined?.getAttribute("fill")).toBe("none");

  const result = await submit(screen, onSubmit);
  expect(result.strokes[0]?.color).toBe("#ef4444");
  const at = await pixels(result.screenshot);
  // The first region is outlined and lightly filled in the theme's color.
  expect(at([20, 70])).not.toEqual(GREY);
  expect(at([20, 70])).not.toEqual(RED);
  expect(at([70, 70])).not.toEqual(GREY);
  // The second is outlined in red and left clear.
  expect(at([200, 70])).toEqual(RED);
  expect(at([250, 70])).toEqual(GREY);
  // The red arrow's head is at the drag's end.
  expect(at([345, 200])).toEqual(RED);
  expect(at([340, 196])).toEqual(RED);
  expect(at([55, 196])).toEqual(GREY);
});

it("fits its toolbar on one row of a 400 px pane in a desktop window", async () => {
  await page.viewport(1280, 800);
  const { element, container } = setup();
  await using screen = await render(element, { container });
  const toolbar = screen.getByRole("group", { name: "Annotation tool" }).element().parentElement!;
  const pane = container.getBoundingClientRect();
  const box = toolbar.getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(pane.left);
  expect(box.right).toBeLessThanOrEqual(pane.right);
  expect(box.height).toBeLessThan(40);
});
