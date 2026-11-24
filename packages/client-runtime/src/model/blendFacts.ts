import type { BlendPreview } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { formatAttachmentSize } from "../state/attachments.ts";

export interface BlendFactRow {
  readonly label: string;
  /** One value, or one per linked file. */
  readonly values: ReadonlyArray<string>;
  /** Paths, shown whole one per line rather than truncated. */
  readonly paths?: true;
}

/** The scene facts web and mobile list for a `.blend`. */
export function blendFactRows(
  preview: BlendPreview,
  resolve: MFunctionType = mFallback,
): ReadonlyArray<BlendFactRow> {
  const row = (label: string, ...values: string[]) => ({ label, values });
  const rows: BlendFactRow[] = [];
  if (preview.scene) {
    rows.push(row(resolve(msg("Scene", { $context: "a Blender scene" })), preview.scene.name));
    rows.push(
      row(
        resolve(msg("Frames", { $context: "an animation's frame range" })),
        resolve(
          msg("{start}–{end}", { start: preview.scene.frameStart, end: preview.scene.frameEnd }),
        ),
      ),
    );
  }
  if (preview.scenes > 1) rows.push(row(resolve(msg("Scenes")), preview.scenes.toLocaleString()));
  rows.push(
    row(resolve(msg("Objects", { $context: "Blender objects" })), preview.objects.toLocaleString()),
  );
  rows.push(row(resolve(msg("Meshes")), preview.meshes.toLocaleString()));
  rows.push(row(resolve(msg("Materials")), preview.materials.toLocaleString()));
  if (preview.libraries.length > 0)
    rows.push({
      label: resolve(msg("Linked files")),
      // As saved: `//` starts a path relative to the .blend, as Blender shows it.
      values: preview.libraries,
      paths: true,
    });
  rows.push(
    row(
      resolve(msg("Size", { $context: "file size" })),
      formatAttachmentSize(preview.byteLength, resolve),
    ),
  );
  return rows;
}
