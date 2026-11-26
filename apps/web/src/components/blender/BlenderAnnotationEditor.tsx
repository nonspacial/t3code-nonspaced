import type {
  HostedBlenderHits,
  HostedBlenderKeptFile,
  HostedBlenderViewCapture,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { isSceneChanged } from "@t3tools/client-runtime/state/hosted-blender";
import { useGT } from "gt-react";
import { useRef, useState } from "react";

import type { ComposerThreadTarget } from "~/composerDraftStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
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
  /** The file the frame is of, as it froze. */
  readonly file: HostedBlenderKeptFile;
}

const hasFrame = (canvas: HTMLCanvasElement | null): canvas is HTMLCanvasElement => {
  const box = canvas?.getBoundingClientRect();
  return !!canvas && !!box && canvas.width > 0 && canvas.height > 0 && box.width > 0;
};

/** Copies the stream's current frame, which keeps changing underneath while the person draws. */
function freezeStreamFrame(
  canvas: HTMLCanvasElement | null,
  file: HostedBlenderKeptFile,
): FrozenBlenderFrame | null {
  if (!hasFrame(canvas)) return null;
  const { width, height } = canvas.getBoundingClientRect();
  const image = document.createElement("canvas");
  image.width = canvas.width;
  image.height = canvas.height;
  image.getContext("2d")?.drawImage(canvas, 0, 0);
  return { image, width, height, capture: null, file };
}

/** Blender's own render of the viewport region, drawn with the capture's camera. */
async function renderedFrame(
  capture: HostedBlenderViewCapture,
  file: HostedBlenderKeptFile,
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
  return {
    image,
    width: image.width / ratio,
    height: image.height / ratio,
    capture,
    file: capture.openFile ?? file,
  };
}

/**
 * Screenshot & annotate for the Blender pane. Blender renders the viewport and reports the
 * camera it rendered with, so the frozen image and the camera are one view; if it can't, the
 * stream's frame is frozen instead, without camera or hits.
 */
export function useBlenderAnnotation(input: {
  readonly threadRef: ScopedThreadRef;
  /** The file the pane last heard Blender has open, for a frame Blender didn't render. */
  readonly openFile: HostedBlenderKeptFile;
  readonly composerTarget: ComposerThreadTarget;
  readonly projectId?: ProjectId | undefined;
  /** The thread's master Blender rather than its working Blender. */
  readonly master?: boolean;
  readonly onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frozen, setFrozen] = useState<FrozenBlenderFrame | null>(null);
  const [capturing, setCapturing] = useState(false);
  const captureView = useAtomCommand(hostedBlenderEnvironment.captureView, {
    reportFailure: false,
  });
  const findHits = useAtomCommand(hostedBlenderEnvironment.findHits, { reportFailure: false });
  const gt = useGT();
  const { environmentId, threadId } = input.threadRef;
  const role = input.master === true ? ({ role: "master" } as const) : {};

  const start = async () => {
    if (!hasFrame(canvasRef.current)) return;
    const openFile = input.openFile;
    setCapturing(true);
    const result = await captureView({ environmentId, input: { threadId, ...role } });
    const rendered = result._tag === "Success" ? await renderedFrame(result.value, openFile) : null;
    setCapturing(false);
    setFrozen(rendered ?? freezeStreamFrame(canvasRef.current, openFile));
  };

  const editor = frozen ? (
    <BlenderAnnotationEditor
      frozen={frozen}
      composerTarget={input.composerTarget}
      environmentId={environmentId}
      projectId={input.projectId}
      findHits={async (request) => {
        const result = await findHits({ environmentId, input: { threadId, ...role, ...request } });
        if (result._tag === "Success") return result.value;
        if (isSceneChanged(result.cause)) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: gt("The scene changed since the picture, so the marks won't name objects."),
            }),
          );
        }
        return null;
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
      ownerKey={JSON.stringify(["blender-annotation", frozen.file])}
      onCancel={props.onClose}
      onSubmit={(result) => {
        props.onClose();
        void (async () => {
          const payload = await blenderAnnotationPayload({
            id: `model_${randomUUID()}`,
            file: frozen.file,
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
