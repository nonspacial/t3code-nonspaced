# 3D previews

GLB, glTF, STL, PLY, OBJ, 3MF and FBX files open as a 3D view in the file pane on web and desktop. Open one from the file tree, the file picker, a file link in a chat, or a file you attached to the composer. Drag to orbit, right-drag or two-finger drag to pan, and scroll or pinch to zoom. Reset view puts the camera back, and Refresh reads the file again after it changes. The Model details box lists the triangle and mesh counts and the model's size.

The model is drawn in your browser. Nothing is converted or uploaded, and the view only redraws while you move it.

A glTF can keep its buffers and textures in separate files, and an OBJ its materials (`.mtl`) and textures. T3 Code loads those from the model's folder and the folders below it, as long as the model is inside the project. A model opened from outside the project, or from an attachment, shows its shapes without them. When a referenced file can't be found, the model still opens without it, and the status chip says how many files are missing. Tap or hover the chip to see their names.

STL and 3MF files are turned upright, because those formats point Z up. Their sizes show in millimetres, and glTF sizes in metres. Other formats have no fixed unit, so their sizes have none.

Models over 100 MB ask before loading, because a big model can slow the window down while it is read. Models over 1 GB don't open; save the file and open it in a 3D app instead. Compressed glTF (Draco and KTX2) and USDZ files aren't supported yet. The 3D view needs WebGL, and says so when your browser has it turned off.

## Blender files

A `.blend` file, or a `.blend1` backup, opens to the thumbnail Blender saved with it and its scene facts: the scene and frame range, object, mesh and material counts, and the files it links in. T3 Code reads these straight from the file without Blender, so it works on any machine and never runs the file's scripts, including for `.blend` files outside the project.

Blender only updates the thumbnail when you save from its window. A file saved by a script, or with thumbnails turned off, can show an old picture or none. A 3D view of `.blend` files isn't available yet.

## On mobile

The mobile app shows a `.blend` file's thumbnail and scene details. Other 3D files show their name and size; open them on web or desktop to see them in 3D.
