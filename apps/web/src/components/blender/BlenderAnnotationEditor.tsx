import type {
  HostedBlenderHits,
  HostedBlenderViewCapture,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import type { ComposerThreadTarget } from "~/composerDraftStore";
import { randomUUID } from "~/lib/utils";
import { hostedBlenderEnvironment } from "~/state/hostedBlender";
import { useAtomCommand } from "~/state/use-atom-command";

import { ModelAnnotationEditor } from "../files/ModelAnnotationEditor";
import { useAttachModelAnnotation } from "../files/useAttachModelAnnotation";
import { type BlenderHitsRequest, blenderAnnotationPayload } from "./blenderAnnotation";

/** A pane frame held still to draw on, with the viewport window's camera as it froze. */
export interface FrozenBlenderFrame {
  readonly image: HTMLCanvasElement;
  /** The frame's size on screen in CSS pixels; marks are measured in it. */
  readonly width: number;
  readonly height: number;
  /** Null when Blender couldn't say, or the frame can't be tied to its answer. */
  readonly capture: HostedBlenderViewCapture | null;
}

/** How long the pane waits for the frame Blender draws after reporting its camera. */
const REDRAW_WAIT_MS = 1000;

const hasFrame = (canvas: HTMLCanvasElement | null): canvas is HTMLCanvasElement => {
  const box = canvas?.getBoundingClientRect();
  return !!canvas && !!box && canvas.width > 0 && canvas.height > 0 && box.width > 0;
};

/** Copies the stream's current frame, which keeps changing underneath while the person draws. */
function freezeBlenderFrame(
  canvas: HTMLCanvasElement | null,
  capture: HostedBlenderViewCapture | null,
): FrozenBlenderFrame | null {
  if (!hasFrame(canvas)) return null;
  const { width, height } = canvas.getBoundingClientRect();
  const image = document.createElement("canvas");
  image.width = canvas.width;
  image.height = canvas.height;
  image.getContext("2d")?.drawImage(canvas, 0, 0);
  return { image, width, height, capture };
}

/**
 * Screenshot & annotate for the Blender pane. Reading the camera makes Blender redraw the
 * viewport, so a frame presented after the capture's `afterFrame` shows that camera and is the
 * one frozen; if none comes, the screenshot goes without camera and hits. The stream calls
 * `frameRef` with each frame's presentation time.
 */
export function useBlenderAnnotation(input: {
  readonly threadRef: ScopedThreadRef;
  readonly relativePath: string;
  readonly composerTarget: ComposerThreadTarget;
  readonly projectId?: ProjectId | undefined;
  /** The stream shows the whole display, so a point on it isn't a point in the viewport window. */
  readonly wholeDisplay: boolean;
  readonly onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<((pts: number | null) => void) | null>(null);
  const [frozen, setFrozen] = useState<FrozenBlenderFrame | null>(null);
  const [capturing, setCapturing] = useState(false);
  const captureView = useAtomCommand(hostedBlenderEnvironment.captureView, {
    reportFailure: false,
  });
  const findHits = useAtomCommand(hostedBlenderEnvironment.findHits, { reportFailure: false });
  const { environmentId, threadId } = input.threadRef;

  const start = async () => {
    if (!hasFrame(canvasRef.current)) return;
    setCapturing(true);
    const result = await captureView({ environmentId, input: { threadId } });
    if (result._tag !== "Success") {
      setCapturing(false);
      setFrozen(freezeBlenderFrame(canvasRef.current, null));
      return;
    }
    const capture = result.value;
    const freeze = (redrawn: boolean) => {
      if (frameRef.current !== onFrame) return;
      frameRef.current = null;
      clearTimeout(gaveUp);
      setCapturing(false);
      setFrozen(freezeBlenderFrame(canvasRef.current, redrawn ? capture : null));
    };
    // A frame already on its way when Blender answered shows an older view; skip it.
    const onFrame = (pts: number | null) => {
      if (pts !== null && pts > capture.afterFrame) freeze(true);
    };
    frameRef.current = onFrame;
    const gaveUp = setTimeout(() => freeze(false), REDRAW_WAIT_MS);
  };

  const editor = frozen ? (
    <BlenderAnnotationEditor
      frozen={frozen}
      relativePath={input.relativePath}
      composerTarget={input.composerTarget}
      environmentId={environmentId}
      projectId={input.projectId}
      findHits={
        input.wholeDisplay
          ? null
          : async (request) => {
              const result = await findHits({
                environmentId,
                input: { threadId, ...request },
              });
              return result._tag === "Success" ? result.value : null;
            }
      }
      onClose={() => {
        setFrozen(null);
        input.onClose();
      }}
    />
  ) : null;

  return {
    canvasRef,
    frameRef,
    start: capturing || frozen ? null : () => void start(),
    editor,
  };
}

function BlenderAnnotationEditor(props: {
  readonly frozen: FrozenBlenderFrame;
  readonly relativePath: string;
  readonly composerTarget: ComposerThreadTarget;
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly projectId?: ProjectId | undefined;
  readonly findHits: ((request: BlenderHitsRequest) => Promise<HostedBlenderHits | null>) | null;
  readonly onClose: () => void;
}) {
  const attach = useAttachModelAnnotation();
  const { frozen } = props;
  return (
    <ModelAnnotationEditor
      image={frozen.image}
      width={frozen.width}
      height={frozen.height}
      environmentId={props.environmentId}
      projectId={props.projectId}
      ownerKey={JSON.stringify(["blender-annotation", props.relativePath])}
      onCancel={props.onClose}
      onSubmit={(result) => {
        props.onClose();
        void (async () => {
          const payload = await blenderAnnotationPayload({
            id: `model_${randomUUID()}`,
            relativePath: props.relativePath,
            comment: result.comment,
            regions: result.regions,
            strokes: result.strokes,
            size: frozen,
            screenshot: {
              dataUrl: result.screenshot,
              width: frozen.image.width,
              height: frozen.image.height,
            },
            capture: frozen.capture,
            findHits: props.findHits,
            createdAt: new Date().toISOString(),
          });
          await attach(props.composerTarget, payload);
        })();
      }}
    />
  );
}
