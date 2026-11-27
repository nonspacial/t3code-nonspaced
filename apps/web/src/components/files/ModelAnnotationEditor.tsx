import type {
  EnvironmentId,
  PreviewAnnotationPoint,
  PreviewAnnotationRegionTarget,
  PreviewAnnotationStrokeTarget,
  ProjectId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import {
  EraserIcon,
  MoveUpRightIcon,
  PaintBucketIcon,
  PencilIcon,
  Redo2Icon,
  SlashIcon,
  SquareDashedIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Toggle as StandaloneToggle } from "~/components/ui/toggle";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { isMacPlatform } from "~/lib/utils";
import {
  SpeechTextField,
  TextFieldSpeechControls,
  type TextFieldSpeech,
} from "~/speech/useTextFieldSpeech";
import { textDirection } from "~/textDirection";

import {
  type DrawTool,
  type MarkColorId,
  type MarkDrag,
  type MarkDrawing,
  MARK_COLORS,
  dragDrawing,
  isTooSmall,
  markPaint,
  markTargets,
  touchesMark,
} from "./annotationMarks";

export interface ModelAnnotationResult {
  readonly comment: string;
  readonly regions: ReadonlyArray<PreviewAnnotationRegionTarget>;
  readonly strokes: ReadonlyArray<PreviewAnnotationStrokeTarget>;
  /** The snapshot with the marks drawn on, as a PNG data URL at the snapshot's pixels. */
  readonly screenshot: string;
}

type Tool = DrawTool | "erase";
const TOOLS: ReadonlyArray<Tool> = ["draw", "line", "arrow", "region", "erase"];
interface Mark {
  readonly id: string;
  readonly drawing: MarkDrawing;
}
/** Every list of marks the person has had, newest last; `at` is the one showing. */
interface MarkHistory {
  readonly lists: ReadonlyArray<ReadonlyArray<Mark>>;
  readonly at: number;
}

/** Draws the marks onto a copy of the snapshot, from the same paint the editor shows. */
function annotatedScreenshot(
  image: HTMLCanvasElement,
  size: { readonly width: number; readonly height: number },
  marks: ReadonlyArray<Mark>,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) return image.toDataURL("image/png");
  context.drawImage(image, 0, 0);
  context.scale(image.width / size.width, image.height / size.height);
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const paint of marks.flatMap((mark) => markPaint(mark.drawing))) {
    const path = new Path2D(paint.path);
    context.strokeStyle = paint.color;
    context.fillStyle = paint.color;
    if (paint.fill > 0) {
      context.globalAlpha = paint.fill;
      // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- a canvas fill, not Array#fill
      context.fill(path);
      context.globalAlpha = 1;
    }
    if (paint.line > 0) {
      context.lineWidth = paint.line;
      context.stroke(path);
    }
  }
  return canvas.toDataURL("image/png");
}

/** Undo or redo from the platform's shortcut: Ctrl (Cmd on macOS) with Z, Shift+Z or Y. */
function historyShortcut(event: ReactKeyboardEvent): "undo" | "redo" | null {
  const mac = isMacPlatform(navigator.platform);
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!command || event.altKey || event.nativeEvent.isComposing) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  return key === "y" && !event.shiftKey ? "redo" : null;
}

const hasOwnText = (target: EventTarget) =>
  (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) &&
  target.value !== "";

/**
 * Draws on a frozen 3D view: pen, lines, arrows, regions and a comment that can be dictated. The
 * browser preview's editor lives inside its Electron guest page, so the 3D preview draws its own
 * with the same tools and hands back the same annotation shape.
 */
export function ModelAnnotationEditor(props: {
  readonly image: HTMLCanvasElement;
  /** The snapshot's size in CSS pixels; marks are measured in it. */
  readonly width: number;
  readonly height: number;
  readonly environmentId: EnvironmentId | null;
  readonly projectId?: ProjectId | null | undefined;
  readonly ownerKey: string;
  readonly onCancel: () => void;
  readonly onSubmit: (result: ModelAnnotationResult) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const rootRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const redoRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<SVGSVGElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [imageUrl] = useState(() => props.image.toDataURL("image/png"));
  const [tool, setTool] = useState<Tool>("draw");
  const [colorId, setColorId] = useState<MarkColorId>("theme");
  const [filled, setFilled] = useState(true);
  const [history, setHistory] = useState<MarkHistory>({ lists: [[]], at: 0 });
  const marks = history.lists[history.at] ?? [];
  const markCount = useRef(0);
  // Pointer and key events can outrun renders, so the mark being drawn is read from a ref.
  const draftRef = useRef<MarkDrag | null>(null);
  const [draft, setDraftState] = useState<MarkDrag | null>(null);
  const setDraft = (next: MarkDrag | null) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const [comment, setComment] = useState("");
  const { width, height } = props;
  const hasMarks = marks.length > 0;
  const canUndo = history.at > 0;
  const canRedo = history.at < history.lists.length - 1;
  const mac = isMacPlatform(navigator.platform);

  // A focused Undo or Redo that disables itself drops focus out of the editor, and the
  // history keys with it, so focus moves to the editor first.
  const updateHistory = (step: (current: MarkHistory) => MarkHistory) => {
    const next = step(history);
    const focused = document.activeElement;
    if (
      (focused === undoRef.current && next.at === 0) ||
      (focused === redoRef.current && next.at === next.lists.length - 1)
    )
      rootRef.current?.focus();
    setHistory(step);
  };
  const change = (next: (current: ReadonlyArray<Mark>) => ReadonlyArray<Mark>) =>
    updateHistory(({ lists, at }) => {
      const current = lists[at] ?? [];
      const changed = next(current);
      return changed === current
        ? { lists, at }
        : { lists: [...lists.slice(0, at + 1), changed], at: at + 1 };
    });
  const undo = () => updateHistory((current) => ({ ...current, at: Math.max(0, current.at - 1) }));
  const redo = () =>
    updateHistory((current) => ({
      ...current,
      at: Math.min(current.lists.length - 1, current.at + 1),
    }));

  const markColor = () => {
    const chosen = MARK_COLORS.find((color) => color.id === colorId)?.value;
    return (
      chosen ?? ((surfaceRef.current && getComputedStyle(surfaceRef.current).color) || "#2563eb")
    );
  };

  /** Where the pointer is on the snapshot; off it, null unless `clamp` brings it to the edge. */
  const pointAt = (event: ReactPointerEvent, clamp = true): PreviewAnnotationPoint | null => {
    const matrix = surfaceRef.current?.getScreenCTM()?.inverse();
    if (!matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    const inside = point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height;
    if (!inside && !clamp) return null;
    return {
      x: Math.min(width, Math.max(0, point.x)),
      y: Math.min(height, Math.max(0, point.y)),
    };
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const point = pointAt(event, false);
    if (!point) return;
    event.preventDefault();
    if (tool === "erase") {
      change((current) => {
        const erased = current.findLast((mark) => touchesMark(mark.drawing, point));
        return erased ? current.filter((mark) => mark !== erased) : current;
      });
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The pointer may already be gone; the drag still works while it stays on the surface.
    }
    setDraft({ tool, points: [point], straight: event.shiftKey, color: markColor(), filled });
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const draft = draftRef.current;
    if (!draft) return;
    const point = pointAt(event);
    if (!point) return;
    setDraft({
      ...draft,
      straight: event.shiftKey,
      points: draft.tool === "draw" ? [...draft.points, point] : [draft.points[0] ?? point, point],
    });
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const draft = draftRef.current;
    if (!draft) return;
    setDraft(null);
    const end = pointAt(event);
    const last = draft.points.at(-1);
    const points =
      !end || (last && last.x === end.x && last.y === end.y)
        ? draft.points
        : draft.tool === "draw"
          ? [...draft.points, end]
          : [draft.points[0] ?? end, end];
    const drawing = dragDrawing({ ...draft, points, straight: event.shiftKey }, props);
    if (isTooSmall(drawing)) return;
    markCount.current += 1;
    const id = `${drawing.kind === "region" ? "region" : "stroke"}_${markCount.current}`;
    change((current) => [...current, { id, drawing }]);
  };

  // Shift held or let go mid-drag straightens or frees the mark at once, before the pointer moves.
  const onShift = (event: ReactKeyboardEvent) => {
    const draft = draftRef.current;
    if (event.key !== "Shift" || !draft) return;
    setDraft({ ...draft, straight: event.type === "keydown" });
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    // An IME's own Escape cancels its composition, not the annotation.
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.stopPropagation();
      props.onCancel();
      return;
    }
    onShift(event);
    const shortcut = historyShortcut(event);
    if (!shortcut) return;
    event.stopPropagation();
    if (hasOwnText(event.target)) return;
    event.preventDefault();
    // The change can disable the focused button (Add to chat with nothing left), losing the keys.
    if (event.target instanceof HTMLButtonElement) rootRef.current?.focus();
    if (shortcut === "undo") undo();
    else redo();
  };

  const finish = (text: string) => {
    if (!hasMarks && !text.trim()) return;
    props.onSubmit({
      comment: text.trim(),
      ...markTargets(marks),
      screenshot: annotatedScreenshot(props.image, props, marks),
    });
  };
  const submit = (speech: TextFieldSpeech | undefined) => {
    if (speech) speech.submitAfterDictation(finish);
    else finish(comment);
  };

  const shown = [
    ...marks,
    ...(draft ? [{ id: "draft", drawing: dragDrawing(draft, props) }] : []),
  ].flatMap(({ id, drawing }) =>
    markPaint(drawing).map((paint, piece) => ({ key: `${id}:${piece}`, paint })),
  );
  const toolLabels: Record<
    Tool,
    { readonly label: string; readonly hint: string; readonly icon: ReactElement }
  > = {
    draw: {
      label: gt("Draw", { $context: "annotation tool that draws freehand lines" }),
      hint: gt("Draw freehand. Hold Shift for a straight line."),
      icon: <PencilIcon className="size-3.5" />,
    },
    line: {
      label: gt("Line", { $context: "annotation tool that draws a straight line" }),
      hint: gt("Draw a line. Hold Shift to snap to 45°."),
      icon: <SlashIcon className="size-3.5" />,
    },
    arrow: {
      label: gt("Arrow", { $context: "annotation tool that draws an arrow" }),
      hint: gt("Draw an arrow, pointing where the drag ends. Hold Shift to snap to 45°."),
      icon: <MoveUpRightIcon className="size-3.5" />,
    },
    region: {
      label: gt("Mark a region"),
      hint: gt("Mark a region. Hold Shift for a square."),
      icon: <SquareDashedIcon className="size-3.5" />,
    },
    erase: {
      label: gt("Erase a mark"),
      hint: gt("Erase a mark"),
      icon: <EraserIcon className="size-3.5" />,
    },
  };
  const undoKeys = mac ? "⌘Z" : "Ctrl+Z";
  const redoKeys = mac ? "⇧⌘Z" : "Ctrl+Shift+Z";

  const panel = (speech?: TextFieldSpeech) => (
    <div className="pointer-events-auto absolute inset-x-2 bottom-2 mx-auto flex max-w-sm flex-col gap-1.5 rounded-xl border bg-popover/96 p-2 text-popover-foreground shadow-lg backdrop-blur-xl">
      <Textarea
        ref={textareaRef}
        size="sm"
        rows={1}
        autoFocus
        value={comment}
        readOnly={speech?.freezesEditor}
        dir={textDirection(comment)}
        placeholder={gt("Describe the change…")}
        aria-label={gt("Annotation comment")}
        onChange={(event) => setComment(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            if (speech && speech.state.phase !== "idle") speech.cancel();
            else props.onCancel();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit(speech);
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-end gap-1">
        {speech ? <TextFieldSpeechControls speech={speech} /> : null}
        <Button variant="ghost-muted" size="xs" onClick={props.onCancel}>
          <T>Cancel</T>
        </Button>
        <Button
          size="xs"
          disabled={
            speech?.preparing || (!hasMarks && !comment.trim() && !speech?.blocksSubmission)
          }
          onClick={() => submit(speech)}
        >
          <T>Add to chat</T>
        </Button>
      </div>
    </div>
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-own-undo=""
      className="absolute inset-0 z-10 bg-background outline-none"
      onKeyDown={onKeyDown}
      onKeyUp={onShift}
    >
      <svg
        ref={surfaceRef}
        role="img"
        aria-label={gt("Frozen 3D view to annotate")}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 size-full cursor-crosshair touch-none text-primary select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDraft(null)}
      >
        <image href={imageUrl} width={width} height={height} />
        {/* Clipped to the snapshot, as the screenshot is, so a letterboxed pane shows no more. */}
        <svg width={width} height={height} overflow="hidden">
          {shown.map(({ key, paint }) => (
            <path
              key={key}
              d={paint.path}
              fill={paint.fill > 0 ? paint.color : "none"}
              fillOpacity={paint.fill > 0 ? paint.fill : undefined}
              stroke={paint.line > 0 ? paint.color : "none"}
              strokeWidth={paint.line > 0 ? paint.line : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </svg>
      </svg>
      <div className="pointer-events-none absolute inset-x-2 top-2 flex justify-center">
        <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-lg border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur-xl">
          <ToggleGroup
            aria-label={gt("Annotation tool")}
            size="xs"
            value={[tool]}
            onValueChange={(value) => {
              const next = TOOLS.find((candidate) => candidate === value[0]);
              if (next) setTool(next);
            }}
          >
            {TOOLS.map((value) => (
              <WithTooltip
                key={value}
                tooltip={toolLabels[value].hint}
                render={<Toggle aria-label={toolLabels[value].label} value={value} />}
              >
                {toolLabels[value].icon}
              </WithTooltip>
            ))}
          </ToggleGroup>
          <ToggleGroup
            aria-label={gt("Mark color")}
            variant="default"
            size="xs"
            value={[colorId]}
            onValueChange={(value) => {
              const next = MARK_COLORS.find((color) => color.id === value[0]);
              if (next) setColorId(next.id);
            }}
          >
            {MARK_COLORS.map((color) => (
              <WithTooltip
                key={color.id}
                tooltip={m(color.label)}
                render={<Toggle aria-label={m(color.label)} value={color.id} />}
              >
                <span
                  aria-hidden
                  className={
                    color.value === null
                      ? "size-3 rounded-full bg-primary ring-1 ring-foreground/30"
                      : "size-3 rounded-full ring-1 ring-foreground/30"
                  }
                  style={color.value === null ? undefined : { backgroundColor: color.value }}
                />
              </WithTooltip>
            ))}
          </ToggleGroup>
          <WithTooltip
            tooltip={gt("Fill new regions with their color")}
            render={
              <StandaloneToggle
                aria-label={gt("Fill regions")}
                variant="ghost"
                size="xs"
                pressed={filled}
                onPressedChange={setFilled}
              />
            }
          >
            <PaintBucketIcon className="size-3.5" />
          </WithTooltip>
          <div className="flex items-center gap-0.5">
            <EditorAction
              label={gt("Undo")}
              tooltip={gt("Undo ({keys})", { keys: undoKeys })}
              ref={undoRef}
              disabled={!canUndo}
              onPress={undo}
            >
              <Undo2Icon className="size-3.5" />
            </EditorAction>
            <EditorAction
              label={gt("Redo")}
              tooltip={gt("Redo ({keys})", { keys: redoKeys })}
              ref={redoRef}
              disabled={!canRedo}
              onPress={redo}
            >
              <Redo2Icon className="size-3.5" />
            </EditorAction>
            <EditorAction label={gt("Cancel annotation")} onPress={props.onCancel}>
              <XIcon className="size-3.5" />
            </EditorAction>
          </div>
        </div>
      </div>
      {props.environmentId ? (
        <SpeechTextField
          environmentId={props.environmentId}
          projectId={props.projectId}
          ownerKey={props.ownerKey}
          text={comment}
          textareaRef={textareaRef}
          onTextChange={setComment}
        >
          {(speech) => panel(speech)}
        </SpeechTextField>
      ) : (
        panel()
      )}
    </div>
  );
}

function WithTooltip(props: {
  readonly tooltip: string;
  readonly render: ReactElement;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.render}>{props.children}</TooltipTrigger>
      <TooltipPopup side="bottom">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function EditorAction({
  ref,
  ...props
}: {
  readonly ref?: Ref<HTMLButtonElement>;
  readonly label: string;
  readonly tooltip?: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            aria-label={props.label}
            size="icon-xs"
            variant="ghost"
            disabled={props.disabled}
            onClick={props.onPress}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.tooltip ?? props.label}</TooltipPopup>
    </Tooltip>
  );
}
