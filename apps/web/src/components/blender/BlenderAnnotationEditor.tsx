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

/** A frame held still to draw on, with the camera it was drawn from. */
export interface FrozenBlenderFrame {
  readonly image: HTMLCanvasElement;
  /** The frame's size in CSS pixels; marks are measured in it. */
  readonly width: number;
  readonly height: number;
  /** Null for a stream frame, which can't be tied to a camera. */
  readonly capture: HostedBlenderViewCapture | null;
}

const hasFrame = (canvas: HTMLCanvasElement | null): canvas is HTMLCanvasElement => {
  const box = canvas?.getBoundingClientRect();
  return !!canvas && !!box && canvas.width > 0 && canvas.height > 0 && box.width > 0;
};

/** Copies the stream's current frame, which keeps changing underneath while the person draws. */
function freezeStreamFrame(canvas: HTMLCanvasElement | null): FrozenBlenderFrame | null {
  if (!hasFrame(canvas)) return null;
  const { width, height } = canvas.getBoundingClientRect();
  const image = document.createElement("canvas");
  image.width = canvas.width;
  image.height = canvas.height;
  image.getContext("2d")?.drawImage(canvas, 0, 0);
  return { image, width, height, capture: null };
}

/** Blender's own render of the viewport region, drawn with the capture's camera. */
async function renderedFrame(
  capture: HostedBlenderViewCapture,
): Promise<FrozenBlenderFrame | null> {
  const rendered = new Image();
  rendered.src = capture.screenshot.dataUrl;
  try {
    await rendered.decode();
  } catch {
    return null;
  }
  const image = document.createElement("canvas");
  image.width = rendered.naturalWidth;
  image.height = rendered.naturalHeight;
  image.getContext("2d")?.drawImage(rendered, 0, 0);
  const ratio = globalThis.devicePixelRatio || 1;
  return { image, width: image.width / ratio, height: image.height / ratio, capture };
}

/**
 * Screenshot & annotate for the Blender pane. Blender renders the viewport and reports the
 * camera it rendered with, so the frozen image and the camera are one view; if it can't, the
 * stream's frame is frozen instead, without camera or hits.
 */
export function useBlenderAnnotation(input: {
  readonly threadRef: ScopedThreadRef;
  readonly relativePath: string;
  readonly composerTarget: ComposerThreadTarget;
  readonly projectId?: ProjectId | undefined;
  readonly onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
    const rendered = result._tag === "Success" ? await renderedFrame(result.value) : null;
    setCapturing(false);
    setFrozen(rendered ?? freezeStreamFrame(canvasRef.current));
  };

  const editor = frozen ? (
    <BlenderAnnotationEditor
      frozen={frozen}
      relativePath={input.relativePath}
      composerTarget={input.composerTarget}
      environmentId={environmentId}
      projectId={input.projectId}
      findHits={async (request) => {
        const result = await findHits({ environmentId, input: { threadId, ...request } });
        return result._tag === "Success" ? result.value : null;
      }}
      onClose={() => {
        setFrozen(null);
        input.onClose();
      }}
    />
  ) : null;

  return {
    canvasRef,
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
