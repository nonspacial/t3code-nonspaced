# 3D previews

GLB, glTF, STL, PLY, OBJ, 3MF and FBX files open as a 3D view in the file pane on web and desktop. Open one from the file tree, the file picker, a file link in a chat, or a file you attached to the composer. Drag to orbit, right-drag or two-finger drag to pan, and scroll or pinch to zoom. Reset view puts the camera back, and Refresh reads the file again after it changes. The Model details box lists the triangle and mesh counts and the model's size.

The model is drawn in your browser. Nothing is converted or uploaded, and the view only redraws while you move it.

A glTF can keep its buffers and textures in separate files, and an OBJ its materials (`.mtl`) and textures. T3 Code loads those from the model's folder and the folders below it, as long as the model is inside the project. A model opened from outside the project, or from an attachment, shows its shapes without them. When a referenced file can't be found, the model still opens without it, and the status chip says how many files are missing. Tap or hover the chip to see their names.

## Point the agent at part of a model

Screenshot & annotate freezes the view so you can draw on it, mark regions, erase marks, and write or dictate a comment. Add to chat (or Enter) puts it in the composer with the screenshot, like an annotation from the browser preview. The agent also gets the camera position and, for each mark, the name of the object under it and the 3D point it covers. Esc puts the view back without adding anything.

## View links

A file link can open a model at a particular camera by ending in `#view=` and six numbers: the camera position, then the point it looks at, in the file's own coordinates (Z up for STL and 3MF). For example `models/bracket.stl#view=120,80,-40,0,0,0`. An annotation carries a link to its view, so the agent can send you back to it, and clicking the link again moves the camera back. The format comes from StiensWout's annotatable 3D previews.

## Units and limits

STL and 3MF files are turned upright, because those formats point Z up. Their sizes show in millimetres, and glTF sizes in metres. Other formats have no fixed unit, so their sizes have none.

Models over 100 MB ask before loading, because a big model can slow the window down while it is read. Models over 1 GB don't open; save the file and open it in a 3D app instead. Compressed glTF (Draco and KTX2) and USDZ files aren't supported yet. The 3D view needs WebGL, and says so when your browser has it turned off.

The mobile app doesn't show 3D views yet; use web or desktop for them.
