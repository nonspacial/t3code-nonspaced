import { expect, it } from "@effect/vitest";

import { BLEND_EXPORT_SCRIPT } from "./blendExportScript.ts";

// Without these, Blender's glTF exporter quietly drifts from the saved scene.
it.each([
  ['"export_current_frame": True,', "keeps the frame the file was saved at instead of frame 0"],
  [
    '"export_rest_position_armature": False,',
    "keeps objects on bones where the saved pose puts them",
  ],
  [
    '"export_gn_mesh": uses_geometry_nodes,',
    "keeps Geometry Nodes instances, such as Instance on Points",
  ],
  [
    /uses_geometry_nodes = any\(\s*modifier\.type == "NODES" and modifier\.show_viewport\s*for obj in bpy\.context\.scene\.objects/,
    // The scan costs seconds per thousand objects, so a scene without Geometry Nodes skips it.
    "scans for Geometry Nodes instances only when the scene has an enabled Geometry Nodes modifier",
  ],
] as Array<[string | RegExp, string]>)(
  "asks the exporter for %s, which %s",
  (option: string | RegExp, _why: string) => {
    expect(BLEND_EXPORT_SCRIPT).toMatch(option);
    expect(BLEND_EXPORT_SCRIPT).not.toContain('"export_gn_mesh": True');
  },
);
