import type { BlendPreview } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { formatAttachmentSize } from "../state/attachments.ts";

export interface BlendFactRow {
  readonly label: string;
  /** One value, or one per linked file. */
  readonly values: ReadonlyArray<string>;
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
    rows.push(
      row(
        resolve(msg("Linked files")),
        // `//` starts a path relative to the .blend.
        ...preview.libraries.map((library) => fileBasename(library.replace(/^\/\//, ""))),
      ),
    );
  rows.push(
    row(
      resolve(msg("Size", { $context: "file size" })),
      formatAttachmentSize(preview.byteLength, resolve),
    ),
  );
  return rows;
}
