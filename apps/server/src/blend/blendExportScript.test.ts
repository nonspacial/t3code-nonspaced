import { expect, it } from "@effect/vitest";

import { BLEND_EXPORT_SCRIPT } from "./blendExportScript.ts";

// Without either option, Blender's glTF exporter quietly drifts from the saved scene.
it.each([
  ["export_current_frame", "keeps the frame the file was saved at instead of frame 0"],
  ["export_gn_mesh", "keeps Geometry Nodes instances, such as Instance on Points"],
])("asks the exporter for %s, which %s", (option) => {
  expect(BLEND_EXPORT_SCRIPT).toContain(`"${option}": True,`);
});
