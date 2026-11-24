/**
 * Run by `blender -b <file> --python <this> -- <out.glb>`. It exports the active scene at its
 * current frame: visible objects only, modifiers and geometry nodes applied, materials as glTF
 * PBR, textures embedded, and no cameras, lights or animation. Options an older exporter lacks
 * are left out rather than failing the export.
 */
export const BLEND_EXPORT_SCRIPT = String.raw`import sys

import bpy

output = sys.argv[sys.argv.index("--") + 1]
export = bpy.ops.export_scene.gltf
supported = set(export.get_rna_type().properties.keys())
options = {
    "filepath": output,
    "export_format": "GLB",
    "use_active_scene": True,
    "use_visible": True,
    "export_apply": True,
    "export_cameras": False,
    "export_lights": False,
    "export_animations": False,
    "export_skins": False,
    "export_morph": False,
    "export_materials": "EXPORT",
    "export_image_format": "AUTO",
    "export_yup": True,
    "export_extras": False,
    "will_save_settings": False,
}
result = export(**{key: value for key, value in options.items() if key in supported})
if "FINISHED" not in result:
    raise SystemExit("glTF export did not finish: %s" % (result,))
`;
