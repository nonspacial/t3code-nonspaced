# Writes the .blend fixtures for blendFile.test.ts. Run through make-fixtures.sh, which
# isolates Blender's settings and temp folder: make-fixtures.sh <blender> <suffix>.
import os
import sys

import bpy

out_dir = os.path.dirname(os.path.abspath(__file__))
suffix = sys.argv[sys.argv.index("--") + 1]


def fresh_scene(name, frame_start, frame_end):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = name
    scene.frame_start = frame_start
    scene.frame_end = frame_end
    return scene


def add_mesh(name, material_name, location):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.active_object
    obj.name = name
    material = bpy.data.materials.new(material_name)
    material.diffuse_color = (0.8, 0.3, 0.1, 1.0)
    obj.data.materials.append(material)
    return obj


def add_camera():
    bpy.ops.object.camera_add(location=(3.0, -3.0, 2.5), rotation=(1.1, 0.0, 0.8))
    bpy.context.scene.camera = bpy.context.active_object
    bpy.ops.object.light_add(type="SUN", location=(0.0, 0.0, 4.0))


def save(name, thumbnail):
    bpy.context.preferences.filepaths.file_preview_type = "CAMERA" if thumbnail else "NONE"
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, name), compress=True)


fresh_scene("Bracket", 10, 120)
add_mesh("Bracket", "Steel", (0.0, 0.0, 0.0))
add_mesh("Bolt", "Brass", (1.5, 0.0, 0.0))
add_camera()
save(f"bracket-{suffix}.blend", thumbnail=True)

fresh_scene("Parts", 1, 48)
add_mesh("Wheel", "Rubber", (0.0, 0.0, 0.0))
save(f"parts-{suffix}.blend", thumbnail=False)

fresh_scene("Assembly", 1, 24)
library = os.path.join(out_dir, f"parts-{suffix}.blend")
# Saving remaps the library to a path relative to the file, as Blender does by default.
with bpy.data.libraries.load(library, link=True) as (src, dst):
    dst.objects = ["Wheel"]
for obj in dst.objects:
    bpy.context.scene.collection.objects.link(obj)
add_mesh("Frame", "Paint", (0.0, 0.0, 1.0))
save(f"assembly-{suffix}.blend", thumbnail=False)
