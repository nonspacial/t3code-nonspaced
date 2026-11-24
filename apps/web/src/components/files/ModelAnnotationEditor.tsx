import type {
  EnvironmentId,
  PreviewAnnotationPoint,
  PreviewAnnotationRect,
  PreviewAnnotationRegionTarget,
  PreviewAnnotationStrokeTarget,
  ProjectId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { PencilIcon, SquareDashedIcon, Undo2Icon, XIcon } from "lucide-react";
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  SpeechTextField,
  TextFieldSpeechControls,
  type TextFieldSpeech,
} from "~/speech/useTextFieldSpeech";
import { textDirection } from "~/textDirection";

export interface ModelAnnotationResult {
  readonly comment: string;
  readonly regions: ReadonlyArray<PreviewAnnotationRegionTarget>;
  readonly strokes: ReadonlyArray<PreviewAnnotationStrokeTarget>;
  /** The snapshot with the marks drawn on, as a PNG data URL at the snapshot's pixels. */
  readonly screenshot: string;
}

type Tool = "draw" | "region";
type Draft =
  | { readonly tool: "draw"; readonly points: ReadonlyArray<PreviewAnnotationPoint> }
  | {
      readonly tool: "region";
      readonly start: PreviewAnnotationPoint;
      readonly end: PreviewAnnotationPoint;
    };

const STROKE_WIDTH = 4;
const REGION_STROKE_WIDTH = 2;
const MIN_REGION_SIZE = 3;

function strokePath(points: ReadonlyArray<PreviewAnnotationPoint>): string {
  const [first, ...rest] = points;
  if (!first) return "";
  let path = `M ${first.x} ${first.y}`;
  let previous = first;
  for (const point of rest) {
    path += ` Q ${previous.x} ${previous.y} ${(previous.x + point.x) / 2} ${(previous.y + point.y) / 2}`;
    previous = point;
  }
  return `${path} L ${previous.x} ${previous.y}`;
}

function regionRect(
  start: PreviewAnnotationPoint,
  end: PreviewAnnotationPoint,
): PreviewAnnotationRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function strokeBounds(points: ReadonlyArray<PreviewAnnotationPoint>): PreviewAnnotationRect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const padding = STROKE_WIDTH + 3;
  const left = Math.min(...xs) - padding;
  const top = Math.min(...ys) - padding;
  return {
    x: left,
    y: top,
    width: Math.max(...xs) + padding - left,
    height: Math.max(...ys) + padding - top,
  };
}

/** Draws the marks onto a copy of the snapshot, as the browser preview's crop shows them. */
function annotatedScreenshot(
  image: HTMLCanvasElement,
  size: { readonly width: number; readonly height: number },
  regions: ReadonlyArray<PreviewAnnotationRegionTarget>,
  strokes: ReadonlyArray<PreviewAnnotationStrokeTarget>,
  color: string,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) return image.toDataURL("image/png");
  context.drawImage(image, 0, 0);
  context.scale(image.width / size.width, image.height / size.height);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const { rect } of regions) {
    context.globalAlpha = 0.1;
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
    context.globalAlpha = 1;
    context.lineWidth = REGION_STROKE_WIDTH;
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  }
  for (const stroke of strokes) {
    context.lineWidth = stroke.width;
    context.stroke(new Path2D(strokePath(stroke.points)));
  }
  return canvas.toDataURL("image/png");
}

/**
 * Draws on a frozen 3D view: strokes, regions and a comment that can be dictated. The browser
 * preview's editor lives inside its Electron guest page, so the 3D preview draws its own with the
 * same tools and hands back the same annotation shape.
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
  const surfaceRef = useRef<SVGSVGElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [imageUrl] = useState(() => props.image.toDataURL("image/png"));
  const [tool, setTool] = useState<Tool>("draw");
  const [regions, setRegions] = useState<ReadonlyArray<PreviewAnnotationRegionTarget>>([]);
  const [strokes, setStrokes] = useState<ReadonlyArray<PreviewAnnotationStrokeTarget>>([]);
  const [order, setOrder] = useState<ReadonlyArray<"region" | "stroke">>([]);
  // Pointer events can outrun renders, so the mark being drawn is read from a ref.
  const draftRef = useRef<Draft | null>(null);
  const [draft, setDraftState] = useState<Draft | null>(null);
  const setDraft = (next: Draft | null) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const [comment, setComment] = useState("");
  const { width, height } = props;
  const hasMarks = order.length > 0;

  const markColor = () =>
    (surfaceRef.current && getComputedStyle(surfaceRef.current).color) || "#2563eb";

  const pointAt = (event: ReactPointerEvent): PreviewAnnotationPoint | null => {
    const matrix = surfaceRef.current?.getScreenCTM()?.inverse();
    if (!matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    return {
      x: Math.min(width, Math.max(0, point.x)),
      y: Math.min(height, Math.max(0, point.y)),
    };
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const point = pointAt(event);
    if (!point) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer has nothing to capture; the drag still works inside the surface.
    }
    setDraft(tool === "draw" ? { tool, points: [point] } : { tool, start: point, end: point });
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const draft = draftRef.current;
    if (!draft) return;
    const point = pointAt(event);
    if (!point) return;
    setDraft(
      draft.tool === "draw"
        ? { ...draft, points: [...draft.points, point] }
        : { ...draft, end: point },
    );
  };

  const onPointerUp = () => {
    const draft = draftRef.current;
    if (!draft) return;
    setDraft(null);
    if (draft.tool === "draw") {
      setStrokes([
        ...strokes,
        {
          id: `stroke_${strokes.length + 1}`,
          color: markColor(),
          width: STROKE_WIDTH,
          points: draft.points,
          bounds: strokeBounds(draft.points),
        },
      ]);
      setOrder([...order, "stroke"]);
      return;
    }
    const rect = regionRect(draft.start, draft.end);
    if (rect.width < MIN_REGION_SIZE || rect.height < MIN_REGION_SIZE) return;
    setRegions([...regions, { id: `region_${regions.length + 1}`, rect }]);
    setOrder([...order, "region"]);
  };

  const undo = () => {
    const last = order.at(-1);
    if (last === "region") setRegions(regions.slice(0, -1));
    if (last === "stroke") setStrokes(strokes.slice(0, -1));
    setOrder(order.slice(0, -1));
  };

  const finish = (text: string) => {
    if (!hasMarks && !text.trim()) return;
    props.onSubmit({
      comment: text.trim(),
      regions,
      strokes,
      screenshot: annotatedScreenshot(props.image, props, regions, strokes, markColor()),
    });
  };
  const submit = (speech: TextFieldSpeech | undefined) => {
    if (speech) speech.submitAfterDictation(finish);
    else finish(comment);
  };

  const draftRect = draft?.tool === "region" ? regionRect(draft.start, draft.end) : null;

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
          if (event.key === "Escape") {
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
      className="absolute inset-0 z-10 bg-background"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onCancel();
        }
      }}
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
        {[...regions, ...(draftRect ? [{ id: "draft", rect: draftRect }] : [])].map((region) => (
          <rect
            key={region.id}
            {...region.rect}
            fill="currentColor"
            fillOpacity={0.1}
            stroke="currentColor"
            strokeWidth={REGION_STROKE_WIDTH}
          />
        ))}
        {[
          ...strokes,
          ...(draft?.tool === "draw" ? [{ id: "draft", points: draft.points }] : []),
        ].map((stroke) => (
          <path
            key={stroke.id}
            d={strokePath(stroke.points)}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
      <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur-xl">
          <ToggleGroup
            aria-label={gt("Annotation tool")}
            value={[tool]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "draw" || next === "region") setTool(next);
            }}
          >
            <Toggle
              aria-label={gt("Draw", { $context: "annotation tool that draws freehand lines" })}
              value="draw"
            >
              <PencilIcon className="size-3.5" />
            </Toggle>
            <Toggle aria-label={gt("Mark a region")} value="region">
              <SquareDashedIcon className="size-3.5" />
            </Toggle>
          </ToggleGroup>
          <EditorAction label={gt("Undo")} disabled={!hasMarks} onPress={undo}>
            <Undo2Icon className="size-3.5" />
          </EditorAction>
          <EditorAction label={gt("Cancel annotation")} onPress={props.onCancel}>
            <XIcon className="size-3.5" />
          </EditorAction>
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

function EditorAction(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
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
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
