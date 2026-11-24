import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { blendFactRows } from "@t3tools/client-runtime/model/blend-facts";
import { type EnvironmentId, isBlendPreviewError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, useMessages } from "gt-react";
import { BoxIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { projectEnvironment } from "~/state/projects";
import { revisionedQuery } from "~/state/revisionedQuery";

import { filePreviewReadErrorMessage } from "./filePreviewMode";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import { PreviewAction, PreviewFacts, PreviewStatusChip } from "./previewChrome";

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

/** A `.blend`'s saved thumbnail and scene facts, read on its environment without Blender. */
export function BlendFilePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly source: BlendFileSource;
  /** More actions for the top-right group, before Reload. */
  readonly actions?: ReactNode;
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
  const refresh = useAtomRefresh(atom);
  const preview = AsyncResult.getOrElse(result, () => null);
  const cause = result._tag === "Failure" ? Cause.squash(result.cause) : null;

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
            onRetry={refresh}
          />
        </div>
      ) : (
        <FileSurfaceLoading className="absolute inset-0" />
      )}
      {preview ? (
        <div className="absolute start-2 top-2 flex max-w-[calc(100%-4rem)]">
          <Popover>
            <PopoverTrigger
              openOnHover
              render={<button type="button" className="flex min-w-0 rounded-full" />}
            >
              <PreviewStatusChip tone="info">
                {preview.thumbnail
                  ? gt("Saved thumbnail · Blender {version}", { version: preview.blenderVersion })
                  : gt("Saved by Blender {version}", { version: preview.blenderVersion })}
              </PreviewStatusChip>
            </PopoverTrigger>
            <PopoverPopup side="bottom" align="start" padding="compact" tooltipStyle>
              {gt(
                "Blender saves this picture with the file, so it can be out of date when a script saved the file.",
              )}
            </PopoverPopup>
          </Popover>
        </div>
      ) : null}
      <div className="absolute end-2 top-2 flex gap-1">
        {props.actions}
        <PreviewAction label={gt("Reload file")} onPress={refresh}>
          <RefreshIcon />
        </PreviewAction>
      </div>
      {preview ? (
        <PreviewFacts
          title={<T>Scene details</T>}
          rows={blendFactRows(preview, messages).map(
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
      ) : null}
    </div>
  );
}
