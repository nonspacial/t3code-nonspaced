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
  /** Null when Blender couldn't say. */
  readonly capture: Promise<HostedBlenderViewCapture | null>;
}

/** Copies the stream's current frame, which keeps changing underneath while the person draws. */
function freezeBlenderFrame(
  canvas: HTMLCanvasElement,
  capture: Promise<HostedBlenderViewCapture | null>,
): FrozenBlenderFrame | null {
  const { width, height } = canvas.getBoundingClientRect();
  if (canvas.width === 0 || canvas.height === 0 || width === 0 || height === 0) return null;
  const image = document.createElement("canvas");
  image.width = canvas.width;
  image.height = canvas.height;
  image.getContext("2d")?.drawImage(canvas, 0, 0);
  return { image, width, height, capture };
}

/**
 * Screenshot & annotate for the Blender pane: freezes the stream's canvas and reads the
 * viewport window's camera at the same moment, then hands the editor's marks to Blender to find
 * what each one covers. `editor` covers the stream while open.
 */
export function useBlenderAnnotation(input: {
  readonly threadRef: ScopedThreadRef;
  readonly relativePath: string;
  readonly composerTarget: ComposerThreadTarget;
  readonly projectId?: ProjectId | undefined;
  /** The stream shows the whole display, so a point on it isn't a point in the viewport window. */
  readonly wholeDisplay: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frozen, setFrozen] = useState<FrozenBlenderFrame | null>(null);
  const captureView = useAtomCommand(hostedBlenderEnvironment.captureView, {
    reportFailure: false,
  });
  const findHits = useAtomCommand(hostedBlenderEnvironment.findHits, { reportFailure: false });
  const { environmentId, threadId } = input.threadRef;

  const start = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const capture = captureView({ environmentId, input: { threadId } }).then((result) =>
      result._tag === "Success" ? result.value : null,
    );
    setFrozen(freezeBlenderFrame(canvas, capture));
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
      onClose={() => setFrozen(null)}
    />
  ) : null;

  return { canvasRef, start, editor };
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
            capture: await frozen.capture,
            findHits: props.findHits,
            createdAt: new Date().toISOString(),
          });
          await attach(props.composerTarget, payload);
        })();
      }}
    />
  );
}
