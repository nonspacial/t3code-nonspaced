import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { blendFactRows } from "@t3tools/client-runtime/model/blend-facts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  type BlendConversionStatus,
  type BlendPreview,
  type EnvironmentId,
  isBlendPreviewError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, useMessages } from "gt-react";
import { BoxIcon } from "lucide-react";
import { lazy, type ReactNode, Suspense, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useNowSecond } from "~/hooks/useNowSecond";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { revisionedQuery } from "~/state/revisionedQuery";
import { serverEnvironment } from "~/state/server";
import { usePreparedConnection } from "~/state/session";

import { filePreviewReadErrorMessage } from "./filePreviewMode";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import type { ModelAnnotationTarget, ModelViewRequest } from "./ModelFilePreview";
import { PreviewAction, PreviewFacts, PreviewStatusChip } from "./previewChrome";

// three.js loads only once a conversion is ready, never for the thumbnail.
const ModelFilePreview = lazy(() =>
  import("./ModelFilePreview").then((module) => ({ default: module.ModelFilePreview })),
);

export type BlendFileSource =
  | {
      readonly kind: "file";
      readonly cwd: string;
      /** Workspace-relative, or an absolute host path, as for a file read. */
      readonly relativePath: string;
      readonly workspaceMutationId: string | null;
      readonly refreshRevision: number;
    }
  | { readonly kind: "attachment"; readonly attachmentId: string };

type ReadyStatus = Extract<BlendConversionStatus, { readonly status: "ready" }>;

/** What the next subscription asks for; a change of either starts a new conversion. */
interface ConversionRequest {
  readonly keepTrying: boolean;
  readonly refresh: boolean;
  readonly cancelled: boolean;
}

const INITIAL_REQUEST: ConversionRequest = { keepTrying: false, refresh: false, cancelled: false };

/**
 * A `.blend`'s saved thumbnail and scene facts, read on its environment without Blender, then
 * its 3D view once the environment's Blender has converted a workspace file.
 */
export function BlendFilePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly source: BlendFileSource;
  /** More actions for the top-right group, before Reload. */
  readonly actions?: ReactNode;
  readonly view?: ModelViewRequest | null;
  readonly annotation?: ModelAnnotationTarget | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, source, name } = props;
  const atom =
    source.kind === "file"
      ? revisionedQuery(
          projectEnvironment.readBlendPreview({
            environmentId,
            input: { cwd: source.cwd, relativePath: source.relativePath },
          }),
          source.workspaceMutationId,
          { detail: String(source.refreshRevision) },
        )
      : projectEnvironment.readBlendAttachmentPreview({
          environmentId,
          input: { attachmentId: source.attachmentId },
        });
  const result = useAtomValue(atom);
  const refreshFacts = useAtomRefresh(atom);
  const preview = AsyncResult.getOrElse(result, () => null);
  const cause = result._tag === "Failure" ? Cause.squash(result.cause) : null;

  const supportsConversion =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .blendConversion === true;
  const [request, setRequest] = useState(INITIAL_REQUEST);
  const conversion = useEnvironmentQuery(
    source.kind === "file" && supportsConversion && preview !== null && !request.cancelled
      ? projectEnvironment.convertBlend({
          environmentId,
          input: {
            cwd: source.cwd,
            relativePath: source.relativePath,
            ...(request.keepTrying ? { keepTrying: true } : {}),
            ...(request.refresh ? { refresh: true } : {}),
          },
        })
      : null,
    messages,
  );
  const status = request.cancelled ? null : conversion.data;
  // The last converted view stays up while a refresh converts again.
  const [shown, setShown] = useState<ReadyStatus | null>(null);
  if (
    status?.status === "ready" &&
    (shown === null ||
      shown.convertedAt !== status.convertedAt ||
      shown.byteLength !== status.byteLength)
  ) {
    setShown(status);
  }
  const connection = usePreparedConnection(environmentId);
  const glbUrl =
    shown !== null && connection._tag === "Some"
      ? resolveAssetUrl(connection.value.httpBaseUrl, shown.relativeUrl)
      : null;

  const convert = (next: Partial<ConversionRequest>) => {
    const target = { ...request, cancelled: false, ...next };
    if (
      target.keepTrying === request.keepTrying &&
      target.refresh === request.refresh &&
      !request.cancelled
    ) {
      conversion.refresh();
    } else {
      setRequest(target);
    }
  };
  const refresh = () => {
    refreshFacts();
    if (source.kind === "file" && supportsConversion) convert({ refresh: true });
  };

  const facts = preview ? <BlendFacts preview={preview} /> : null;
  const reload = (
    <PreviewAction label={gt("Reload file")} onPress={refresh}>
      <RefreshIcon />
    </PreviewAction>
  );

  if (glbUrl !== null && shown !== null && preview !== null) {
    const updating = status !== null && status !== shown && status.status !== "ready";
    return (
      <Suspense fallback={<FileSurfaceLoading />}>
        <ModelFilePreview
          key={glbUrl}
          src={glbUrl}
          name={name}
          format="glb"
          sizeBytes={shown.byteLength}
          companions={null}
          blenderSource
          onRefresh={refresh}
          refreshLabel={gt("Reload file")}
          actions={props.actions}
          view={props.view ?? null}
          annotation={props.annotation ?? null}
          readyChip={
            updating ? (
              <PreviewStatusChip tone="info">
                {gt("{name} changed · updating…", { name })}
              </PreviewStatusChip>
            ) : (
              <ConvertedChip ready={shown} />
            )
          }
          facts={facts}
        />
      </Suspense>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-radial from-background to-muted to-90%">
      {preview ? (
        <div className="absolute inset-0 flex items-center justify-center p-10">
          {preview.thumbnail ? (
            <img
              src={preview.thumbnail.dataUrl}
              alt={gt("Saved thumbnail of {name}", { name })}
              width={preview.thumbnail.width}
              height={preview.thumbnail.height}
              className="size-full max-h-128 max-w-128 object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-xs text-muted-foreground">
              <BoxIcon aria-hidden className="size-10 stroke-1" />
              <T>No thumbnail saved in this file</T>
            </div>
          )}
        </div>
      ) : cause !== null ? (
        <div className="absolute inset-0 flex">
          <FileSurfaceFailure
            message={
              isBlendPreviewError(cause)
                ? filePreviewReadErrorMessage(cause, messages)
                : (thrownErrorMessage(cause, messages) ?? gt("The file could not be read."))
            }
            onRetry={refreshFacts}
          />
        </div>
      ) : (
        <FileSurfaceLoading className="absolute inset-0" />
      )}
      {preview ? (
        <div className="absolute start-2 top-2 flex max-w-[calc(100%-4rem)]">
          <ConversionChip
            preview={preview}
            status={status}
            cancelled={request.cancelled}
            error={conversion.error}
          />
        </div>
      ) : null}
      <div className="absolute end-2 top-2 flex gap-1">
        {props.actions}
        {reload}
      </div>
      {preview ? (
        <ConversionAction
          status={status}
          cancelled={request.cancelled}
          failed={conversion.error !== null}
          onCancel={() => setRequest({ ...request, cancelled: true })}
          onKeepTrying={() => convert({ keepTrying: true })}
          onRetry={() => convert({})}
        />
      ) : null}
      {facts}
    </div>
  );
}

function BlendFacts(props: { readonly preview: BlendPreview }) {
  const messages = useMessages();
  return (
    <PreviewFacts
      title={<T>Scene details</T>}
      rows={blendFactRows(props.preview, messages).map(
        ({ label, values, paths }) =>
          [
            label,
            !paths ? (
              values[0]
            ) : (
              <ul
                key="paths"
                className="flex flex-col gap-0.5 text-start whitespace-normal break-all"
              >
                {values.map((value) => (
                  // Blender keeps one library per path, so saved paths are unique.
                  <li key={value}>{value}</li>
                ))}
              </ul>
            ),
          ] as const,
      )}
    />
  );
}

function secondsSince(now: number, at: number) {
  return Math.max(0, Math.round((now - at) / 1000));
}

function ConvertedChip(props: { readonly ready: ReadyStatus }) {
  const gt = useGT();
  const now = useNowSecond();
  const seconds = secondsSince(now, props.ready.convertedAt);
  return (
    <PreviewStatusChip tone="success">
      {props.ready.cached
        ? gt("Converted with Blender {version} · cached", { version: props.ready.blenderVersion })
        : seconds < 60
          ? gt("Converted {seconds} s ago", { seconds })
          : gt("Converted with Blender {version}", { version: props.ready.blenderVersion })}
    </PreviewStatusChip>
  );
}

function ConvertingChip(props: { readonly version: string; readonly startedAt: number }) {
  const gt = useGT();
  const seconds = secondsSince(useNowSecond(), props.startedAt);
  return (
    <PreviewStatusChip tone="info">
      {gt("Converting with Blender {version}… {seconds} s", {
        version: props.version,
        seconds,
      })}
    </PreviewStatusChip>
  );
}

/** Shows the saved thumbnail's chip until a conversion has something to say. */
function ConversionChip(props: {
  readonly preview: BlendPreview;
  readonly status: BlendConversionStatus | null;
  readonly cancelled: boolean;
  readonly error: string | null;
}) {
  const gt = useGT();
  const { preview, status } = props;
  const withNote = (chip: ReactNode, note: ReactNode) => (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<button type="button" className="flex min-w-0 rounded-full" />}
      >
        {chip}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" padding="compact" tooltipStyle>
        {note}
      </PopoverPopup>
    </Popover>
  );
  if (props.error !== null) {
    return withNote(
      <PreviewStatusChip tone="error">{gt("Conversion failed")}</PreviewStatusChip>,
      props.error,
    );
  }
  if (props.cancelled) {
    return <PreviewStatusChip tone="warning">{gt("Conversion cancelled")}</PreviewStatusChip>;
  }
  switch (status?.status) {
    case "waiting":
      return (
        <PreviewStatusChip tone="info">
          {gt("Waiting: {ahead} ahead", { ahead: status.ahead })}
        </PreviewStatusChip>
      );
    case "converting":
      return <ConvertingChip version={status.blenderVersion} startedAt={status.startedAt} />;
    case "slow":
      return withNote(
        <PreviewStatusChip tone="warning">{gt("Too slow to preview")}</PreviewStatusChip>,
        gt("Converting took over a minute, so it was stopped. Keep trying converts with no limit."),
      );
    case "failed":
      return <PreviewStatusChip tone="error">{gt("Conversion failed")}</PreviewStatusChip>;
    case "unavailable":
      if (status.reason === "noBlender") {
        return withNote(
          <PreviewStatusChip tone="warning">{gt("No Blender on this server")}</PreviewStatusChip>,
          gt(
            "Install Blender from blender.org on the machine running T3 Code, or set its path in Settings under General, to see this file in 3D.",
          ),
        );
      }
      if (status.reason === "newerBlender") {
        return (
          <PreviewStatusChip tone="warning">
            {gt("Saved by Blender {file} · server has {server}", {
              file: preview.blenderVersion,
              server: status.blenderVersion ?? "",
            })}
          </PreviewStatusChip>
        );
      }
      break;
  }
  return withNote(
    <PreviewStatusChip tone="info">
      {preview.thumbnail
        ? gt("Saved thumbnail · Blender {version}", { version: preview.blenderVersion })
        : gt("Saved by Blender {version}", { version: preview.blenderVersion })}
    </PreviewStatusChip>,
    gt(
      "Blender saves this picture with the file, so it can be out of date when a script saved the file.",
    ),
  );
}

/** The bottom-left action for the conversion's state, if it has one. */
function ConversionAction(props: {
  readonly status: BlendConversionStatus | null;
  readonly cancelled: boolean;
  readonly failed: boolean;
  readonly onCancel: () => void;
  readonly onKeepTrying: () => void;
  readonly onRetry: () => void;
}) {
  const gt = useGT();
  const [logOpen, setLogOpen] = useState(false);
  const { status } = props;
  const buttons: ReactNode = props.cancelled ? (
    <Button size="xs" variant="glass" onClick={props.onRetry}>
      <T>Convert</T>
    </Button>
  ) : props.failed ? (
    <Button size="xs" variant="glass" onClick={props.onRetry}>
      <T>Try again</T>
    </Button>
  ) : status?.status === "waiting" || status?.status === "converting" ? (
    <Button size="xs" variant="glass" onClick={props.onCancel}>
      <T>Cancel</T>
    </Button>
  ) : status?.status === "slow" ? (
    <Button size="xs" variant="glass" onClick={props.onKeepTrying}>
      <T>Keep trying</T>
    </Button>
  ) : status?.status === "failed" ? (
    <>
      <Button size="xs" variant="glass" onClick={props.onRetry}>
        <T>Try again</T>
      </Button>
      <Button size="xs" variant="glass" onClick={() => setLogOpen(true)}>
        <T>Show log</T>
      </Button>
    </>
  ) : null;
  if (buttons === null) return null;
  return (
    <div className="absolute start-2 bottom-2 flex gap-1">
      {buttons}
      {status?.status === "failed" ? (
        <Dialog open={logOpen} onOpenChange={setLogOpen}>
          <DialogPopup className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{gt("Blender's log")}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-2xs whitespace-pre-wrap break-all">
                {status.log || gt("Blender wrote nothing to its log.")}
              </pre>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
}
