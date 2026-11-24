# Blender pane

A hosted Blender is a Blender that T3 Code runs for a thread on the computer it's connected to. It draws to a hidden display rather than your screen, and the Blender pane shows it live in the side panel. It's separate from any Blender you run yourself: T3 Code never opens, closes or changes your own Blender or its settings.

## Open a file

Open a `.blend` from the file tree or a file link, then choose **Open in hosted Blender** above the preview. T3 Code starts Blender with that file and the Blender pane opens. The pane shows a 3D Viewport window of its own, with its header and menus, so whatever happens in Blender's main window stays out of it.

If Blender can't open the file, the pane says Blender didn't start. Check that the file opens in Blender, then try again.

Each thread has one hosted Blender with one file open. To open a different file, quit Blender first. A file open in another thread's hosted Blender can't be opened again until that one quits. Only files inside the thread's project or worktree can be opened.

Once a file is open, a link to that `.blend` in the chat opens the Blender pane. Links to other `.blend` files open the file preview.

## Watching

The pane is view-only for now. The status strip shows the stream's size, frame rate, bitrate and encoder, and how much memory Blender is using. While nobody is watching, the stream pauses, though Blender itself keeps running.

Closing the pane leaves Blender running; open it again from the file preview or a link. To stop Blender, choose **Quit Blender** from the pane's menu. If the file has unsaved changes, you can save them first or quit without saving. If the save fails, Blender keeps running so nothing is lost.

## Point the agent at something

**Screenshot & annotate** in the pane's toolbar freezes the frame you're watching so you can draw on it, mark regions and write or dictate a comment, as in the [3D preview](3d-previews.md#point-the-agent-at-part-of-a-model). Add to chat puts it in the composer with the screenshot, titled with the file and whether it's a working copy or the master, such as "hero.wip-a1b2.blend · Working copy". The agent also gets the viewport window's camera and, for each mark, the object Blender finds under it and the 3D point it covers. When the pane shows Blender's whole display rather than its viewport window, the annotation still carries the camera, but not what the marks cover.

## View links

A link to the open `.blend` that ends in `#view=` and six numbers, such as `models/hero.blend#view=6,-6,5,0,0,0`, opens the pane and moves the viewport window to look from the first three numbers at the last three, in Blender's scene coordinates. It never moves the agent's own view. An annotation carries a link like this, so the agent can send you back to what you pointed at. A view link to a `.blend` that isn't open in the thread's hosted Blender opens the file preview instead. Only people who can control the thread move the view; others just see the pane open.

## Its settings

The first time a hosted Blender starts, T3 Code copies your newest Blender settings (from `~/.config/blender`) into a copy of its own, so your preferences and add-ons come along. Links in your settings folder aren't copied, and changes a hosted Blender makes stay in its copy. Each hosted Blender keeps its own temporary files and add-on ports, so it never clashes with a Blender you're running. Python scripts embedded in `.blend` files don't run in a hosted Blender.

## What it needs

Hosted Blender works when T3 Code runs on Linux, with Blender and the labwc compositor installed. The pane says what's missing if any of them isn't there. On macOS and Windows the pane says it isn't available; the [3D preview](3d-previews.md) still works there.

The pane works on web and desktop, including over a remote connection or T3 Connect. The mobile app doesn't show it yet.
