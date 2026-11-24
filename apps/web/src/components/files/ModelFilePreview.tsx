// @effect-diagnostics globalFetch:off - The model's bytes stream from its signed URL outside an Effect runtime, like the other file previews.
import {
  createModelViewer,
  isModelPreviewError,
  type ModelPreviewErrorCode,
  type ModelPreviewFacts,
  type ModelSnapshot,
  type ModelViewer,
} from "@t3tools/client-runtime/model/preview-scene";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import type { AssetResource, EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { ModelPreviewFormat } from "@t3tools/shared/filePreview";
import type { ModelView as ModelCameraView } from "@t3tools/shared/modelView";
import { msg, T, useGT, useLocale, useMessages } from "gt-react";
import { CameraIcon, FocusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAssetUrlMinter } from "~/assets/assetUrls";
import type { ComposerThreadTarget } from "~/composerDraftStore";
import { randomUUID } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import { modelCompanionResource } from "./filePreviewMode";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import { ModelAnnotationEditor, type ModelAnnotationResult } from "./ModelAnnotationEditor";
import { modelAnnotationPayload } from "./modelAnnotation";
import { PreviewAction, PreviewFacts, PreviewStatusChip } from "./previewChrome";
import { useAttachModelAnnotation } from "./useAttachModelAnnotation";

/** Models parse on the main thread; past this size the window can stall for seconds, so we ask first. */
export const MODEL_CONFIRM_BYTES = 100 * 1024 * 1024;
const MODEL_MAX_BYTES = 1024 * 1024 * 1024;

const FORMAT_LABELS: Record<ModelPreviewFormat, string> = {
  glb: "GLB",
  gltf: "glTF",
  stl: "STL",
  ply: "PLY",
  obj: "OBJ",
  "3mf": "3MF",
  fbx: "FBX",
};

// glTF is defined in metres; STL and 3MF are millimetres by convention and by default.
const SIZE_UNITS: Partial<Record<ModelPreviewFormat, string>> = {
  glb: "m",
  gltf: "m",
  stl: "mm",
  "3mf": "mm",
};

type FailureCode = ModelPreviewErrorCode | "context-lost" | "file-load-failed" | "model-too-large";

const FAILURE_MESSAGES = {
  "webgl-unavailable": msg(
    "3D previews need WebGL, which this browser has turned off or does not support.",
  ),
  "context-lost": msg("The 3D view stopped responding."),
  "model-unreadable": msg("This 3D file is damaged or uses features the preview does not support."),
  "model-empty": msg("This 3D file has no geometry to show."),
  "companion-missing": msg("A file this model needs could not be found."),
  "file-load-failed": msg("The model could not be loaded."),
  "model-too-large": msg(
    "This model is over 1 GB, too large to preview. Save it to open it in a 3D app.",
  ),
} satisfies Record<FailureCode, string>;

type ModelView =
  | { readonly phase: "loading" }
  | { readonly phase: "confirm"; readonly bytes: number | null }
  | {
      readonly phase: "ready";
      readonly facts: ModelPreviewFacts;
      readonly missing: ReadonlyArray<string>;
    }
  | {
      readonly phase: "failed";
      readonly code: FailureCode;
      readonly missing: ReadonlyArray<string>;
    };

type ModelBytes =
  | { readonly data: ArrayBuffer }
  | { readonly confirm: number | null }
  | { readonly tooLarge: true };

async function readModelBytes(
  src: string,
  allowLarge: boolean,
  signal: AbortSignal,
): Promise<ModelBytes> {
  const response = await fetch(src, { signal });
  if (!response.ok || !response.body) throw new Error(`Model request failed: ${response.status}`);
  const length = Number(response.headers.get("content-length")) || null;
  const limit = allowLarge ? MODEL_MAX_BYTES : MODEL_CONFIRM_BYTES;
  if (length !== null && length > limit) {
    await response.body.cancel();
    return length > MODEL_MAX_BYTES ? { tooLarge: true } : { confirm: length };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return allowLarge ? { tooLarge: true } : { confirm: null };
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return { data: await new Blob(chunks).arrayBuffer() };
}

function failedView(cause: unknown): ModelView {
  return isModelPreviewError(cause)
    ? { phase: "failed", code: cause.code, missing: cause.missing }
    : { phase: "failed", code: "file-load-failed", missing: [] };
}

export interface ModelPreviewCompanions {
  readonly environmentId: EnvironmentId;
  /** The model's own resource; each file it references is signed the same way. */
  readonly resource: Extract<AssetResource, { _tag: "media-file" | "draft-workspace-file" }>;
  readonly workspaceRoot: string;
}

/** Where Screenshot & annotate sends what it captures. */
export interface ModelAnnotationTarget {
  readonly composerTarget: ComposerThreadTarget;
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId | null | undefined;
  /** The model's path, for a link back to the annotated view; null for an attachment. */
  readonly linkPath: string | null;
}

/** A view link's camera. Each click is a new request, so the same link moves the camera back. */
export interface ModelViewRequest {
  readonly view: ModelCameraView;
  readonly requestId: number;
}

/** A workspace model can load the files beside it; an attachment or a local file cannot. */
export function ModelFilePreview(props: {
  readonly src: string;
  readonly name: string;
  readonly format: ModelPreviewFormat;
  /** Zero when unknown; the response's length decides then. */
  readonly sizeBytes: number;
  readonly companions: ModelPreviewCompanions | null;
  readonly onRefresh: () => void;
  readonly view?: ModelViewRequest | null;
  readonly annotation?: ModelAnnotationTarget | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const locale = useLocale();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ModelViewer | null>(null);
  const [allowLarge, setAllowLarge] = useState(false);
  // Each result belongs to the load that produced it, so a new source shows loading, not the last model.
  const [result, setResult] = useState<{
    readonly attempt: string;
    readonly view: ModelView;
  } | null>(null);
  const [snapshot, setSnapshot] = useState<ModelSnapshot | null>(null);
  const attachAnnotationToComposer = useAttachModelAnnotation();
  const mint = useAssetUrlMinter(props.companions?.environmentId ?? null);
  const companionModel = props.companions?.resource ?? null;
  const mintCompanion = useStableCallback(async (path: string, signal: AbortSignal) =>
    companionModel ? mint(modelCompanionResource(companionModel, path), signal) : null,
  );
  const modelPath = props.companions?.resource.path ?? null;
  const workspaceRoot = props.companions?.workspaceRoot ?? null;
  const awaitingConfirm = !allowLarge && props.sizeBytes > MODEL_CONFIRM_BYTES;
  const { src, format } = props;
  const attempt = `${allowLarge}:${format}:${src}`;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- creates the WebGL viewer on a canvas, streams and parses the model into it, and disposes both on cleanup
  useEffect(() => {
    const host = hostRef.current;
    if (awaitingConfirm || !host) return;
    // Disposing forces the context lost, so every viewer needs a canvas of its own.
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 size-full";
    host.append(canvas);
    const controller = new AbortController();
    let viewer: ModelViewer | null = null;
    let stopResize = () => {};
    const setView = (view: ModelView) => setResult({ attempt, view });
    void (async () => {
      viewer = createModelViewer({
        canvas,
        onContextLost: () => setView({ phase: "failed", code: "context-lost", missing: [] }),
      });
      viewerRef.current = viewer;
      const resize = () => {
        const { width, height } = host.getBoundingClientRect();
        viewer?.resize(width, height, window.devicePixelRatio);
      };
      resize();
      stopResize = observeResize(host, resize);
      const bytes = await readModelBytes(src, allowLarge, controller.signal);
      if ("confirm" in bytes) {
        setView({ phase: "confirm", bytes: bytes.confirm });
        return;
      }
      if ("tooLarge" in bytes) {
        setView({ phase: "failed", code: "model-too-large", missing: [] });
        return;
      }
      const loaded = await viewer.load({
        format,
        data: bytes.data,
        companions: modelPath === null ? null : { modelPath, workspaceRoot, mint: mintCompanion },
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setView({ phase: "ready", ...loaded });
    })().catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("3D preview could not load", cause);
      setView(failedView(cause));
    });
    return () => {
      controller.abort();
      stopResize();
      viewerRef.current = null;
      viewer?.dispose();
      canvas.remove();
    };
  }, [attempt, src, format, allowLarge, awaitingConfirm, modelPath, workspaceRoot, mintCompanion]);

  const shown: ModelView = awaitingConfirm
    ? { phase: "confirm", bytes: props.sizeBytes }
    : result?.attempt === attempt
      ? result.view
      : { phase: "loading" };
  const ready = shown.phase === "ready";
  const linkedView = props.view?.view ?? null;
  const linkedViewRequest = props.view?.requestId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the WebGL camera to a view link's camera once the model is in the scene
  useEffect(() => {
    if (ready && linkedView) viewerRef.current?.setView(linkedView);
  }, [
    ready,
    linkedView,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Clicking the same view link again is a new request, which moves the camera back.
    linkedViewRequest,
  ]);

  const startAnnotation = () => {
    const host = hostRef.current;
    const background =
      (host && getComputedStyle(host).getPropertyValue("--background").trim()) || "#ffffff";
    const captured = viewerRef.current?.snapshot(background) ?? null;
    if (captured) setSnapshot(captured);
  };

  const attachAnnotation = async (captured: ModelSnapshot, result: ModelAnnotationResult) => {
    const target = props.annotation;
    setSnapshot(null);
    if (!target) return;
    const id = `model_${randomUUID()}`;
    const payload = modelAnnotationPayload({
      id,
      name: props.name,
      linkPath: target.linkPath,
      comment: result.comment,
      regions: result.regions,
      strokes: result.strokes,
      size: captured,
      hitAt: captured.hitAt,
      screenshot: {
        dataUrl: result.screenshot,
        width: captured.image.width,
        height: captured.image.height,
      },
      cameraView: captured.cameraView,
      createdAt: new Date().toISOString(),
    });
    await attachAnnotationToComposer(target.composerTarget, payload);
  };

  const missing = shown.phase === "ready" || shown.phase === "failed" ? shown.missing : [];
  const missingList = new Intl.ListFormat(locale, { type: "conjunction" }).format(missing);
  const texturesOnly = missing.every((file) =>
    /\.(?:png|jpe?g|webp|gif|bmp|tga|tiff?|ktx2|dds|exr|hdr)$/i.test(file),
  );

  const statusChip = (
    <PreviewStatusChip
      tone={
        shown.phase === "failed"
          ? "error"
          : shown.phase === "confirm" || missing.length > 0
            ? "warning"
            : shown.phase === "loading"
              ? "info"
              : "success"
      }
    >
      {shown.phase === "loading"
        ? gt("Loading 3D model…")
        : shown.phase === "confirm"
          ? gt("Large model")
          : shown.phase === "failed"
            ? gt("Preview failed")
            : missing.length === 0
              ? gt("{format} · rendered in the browser", { format: FORMAT_LABELS[format] })
              : texturesOnly
                ? gt(
                    "{count, plural, one {{count} texture not found} other {{count} textures not found}}",
                    { count: missing.length },
                  )
                : gt(
                    "{count, plural, one {{count} file not found} other {{count} files not found}}",
                    { count: missing.length },
                  )}
    </PreviewStatusChip>
  );

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-radial from-background to-muted to-90%">
      <div
        ref={hostRef}
        role="img"
        aria-label={gt("3D view of {name}", { name: props.name })}
        className={cn(
          "absolute inset-0 cursor-grab touch-none active:cursor-grabbing",
          shown.phase !== "ready" && "invisible",
        )}
      />
      {shown.phase === "loading" ? <FileSurfaceLoading className="absolute inset-0" /> : null}
      {shown.phase === "failed" ? (
        <div className="absolute inset-0 flex">
          <FileSurfaceFailure
            message={
              shown.code === "companion-missing" && missing.length > 0
                ? gt("{files} could not be found next to {model}.", {
                    files: missingList,
                    model: props.name,
                  })
                : messages(FAILURE_MESSAGES[shown.code])
            }
            {...(shown.code === "webgl-unavailable" ? {} : { onRetry: props.onRefresh })}
          />
        </div>
      ) : null}
      {shown.phase === "confirm" ? (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-lg border bg-popover px-5 py-4 text-center text-xs leading-relaxed text-popover-foreground shadow-lg">
            <p>
              {shown.bytes === null
                ? gt(
                    "This model is over {size}. Loading it can slow this window down for a while.",
                    {
                      size: formatAttachmentSize(MODEL_CONFIRM_BYTES, messages),
                    },
                  )
                : gt("This model is {size}. Loading it can slow this window down for a while.", {
                    size: formatAttachmentSize(shown.bytes, messages),
                  })}
            </p>
            <Button size="sm" variant="outline" onClick={() => setAllowLarge(true)}>
              <T>Load model</T>
            </Button>
          </div>
        </div>
      ) : null}
      <div className="absolute start-2 top-2 flex max-w-[calc(100%-6rem)]">
        {missing.length > 0 ? (
          <Popover>
            <PopoverTrigger
              openOnHover
              render={<button type="button" className="flex min-w-0 rounded-full" />}
            >
              {statusChip}
            </PopoverTrigger>
            <PopoverPopup side="bottom" align="start" padding="compact" tooltipStyle>
              {gt("{files} not found next to {model}", { files: missingList, model: props.name })}
            </PopoverPopup>
          </Popover>
        ) : (
          statusChip
        )}
      </div>
      <div className="absolute end-2 top-2 flex gap-1">
        {ready && props.annotation ? (
          <PreviewAction label={gt("Screenshot & annotate")} onPress={startAnnotation}>
            <CameraIcon />
          </PreviewAction>
        ) : null}
        {ready ? (
          <PreviewAction label={gt("Reset view")} onPress={() => viewerRef.current?.resetView()}>
            <FocusIcon />
          </PreviewAction>
        ) : null}
        <PreviewAction label={gt("Reload model")} onPress={props.onRefresh}>
          <RefreshIcon />
        </PreviewAction>
      </div>
      {shown.phase === "ready" ? (
        <PreviewFacts
          title={<T>Model details</T>}
          rows={modelFactRows(shown.facts, SIZE_UNITS[format], gt)}
        />
      ) : null}
      {snapshot && ready && props.annotation ? (
        <ModelAnnotationEditor
          image={snapshot.image}
          width={snapshot.width}
          height={snapshot.height}
          environmentId={props.annotation.environmentId}
          projectId={props.annotation.projectId}
          ownerKey={JSON.stringify(["model-annotation", props.src])}
          onCancel={() => setSnapshot(null)}
          onSubmit={(result) => void attachAnnotation(snapshot, result)}
        />
      ) : null}
    </div>
  );
}

function modelFactRows(
  facts: ModelPreviewFacts,
  unit: string | undefined,
  gt: ReturnType<typeof useGT>,
): Array<readonly [string, string]> {
  const length = (value: number) =>
    value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 2 : 1 });
  const [x, y, z] = facts.size;
  const [width, height, depth] = [length(x), length(y), length(z)];
  const rows: Array<readonly [string, string]> = [];
  if (facts.triangles > 0) rows.push([gt("Triangles"), facts.triangles.toLocaleString()]);
  if (facts.points > 0)
    rows.push([
      gt("Points", { $context: "vertices in a point cloud" }),
      facts.points.toLocaleString(),
    ]);
  if (facts.meshes > 0) rows.push([gt("Meshes"), facts.meshes.toLocaleString()]);
  rows.push([
    gt("Size", { $context: "bounding box of a 3D model" }),
    unit === undefined
      ? gt("{width} × {height} × {depth}", { width, height, depth })
      : gt("{width} × {height} × {depth} {unit}", { width, height, depth, unit }),
  ]);
  return rows;
}
