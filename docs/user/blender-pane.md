# Blender pane

A hosted Blender is a Blender that T3 Code runs for a thread on the computer it's connected to. It draws to a hidden display rather than your screen, and the Blender pane shows it live in the side panel. It's separate from any Blender you run yourself: T3 Code never opens, closes or changes your own Blender or its settings.

## Open a file

Open a `.blend` from the file tree or a file link, then choose **Open in hosted Blender** above the preview. T3 Code starts Blender with that file and the Blender pane opens. The pane shows a 3D Viewport window of its own, with its header and menus, so whatever happens in Blender's main window stays out of it.

If Blender can't open the file, the pane says Blender didn't start. Check that the file opens in Blender, then try again.

Each thread has one hosted Blender with one file open. To open a different file, quit Blender first. A file open in another thread's hosted Blender can't be opened again until that one quits. Only files inside the thread's project or worktree can be opened.

Once a file is open, a link to that `.blend` in the chat opens the Blender pane, as it does after that Blender closes or crashes. Links to other `.blend` files open the file preview.

## Watching

The pane is view-only for now. The status strip shows the stream's size, frame rate, bitrate and encoder, and how much memory Blender is using. While nobody is watching, the stream pauses, though Blender itself keeps running.

Closing the pane leaves Blender running; open it again from the file preview or a link. To stop Blender, choose **Quit Blender** from the pane's menu. If the file has unsaved changes, you can save them first or quit without saving. If the save fails, Blender keeps running so nothing is lost.

## When Blender closes

When a thread settles, is archived or is deleted, its hosted Blender closes, and so does every hosted Blender when T3 Code stops or restarts. Before closing, Blender keeps a copy of the session, unsaved changes included, in T3 Code's own folder. Your file is never saved over.

The pane then offers **Reopen**, which opens the file with those unsaved changes restored, ready to save or discard as you would in Blender. **Open as last saved** opens the file as it is on disk instead. The copy stays until you reopen the file and quit, or choose **Discard**. Reopen is still there after T3 Code restarts.

If Blender crashes, it stays stopped and the pane says so. **Restart** opens the file as last saved; if Blender autosaved since your last save, **Restore autosave** opens that instead. Blender autosaves on the schedule in its own settings (every 2 minutes by default). If T3 Code itself stops without closing Blender, the pane shows the crash the next time it starts.

## Running Blenders

**Settings → Blender** lists every hosted Blender running on the connected environment under **Running Blenders**, with its thread, file and memory use. **Quit** stops one, asking first whether to save a file with unsaved changes.

## Its settings

The first time a hosted Blender starts, T3 Code copies your newest Blender settings (from `~/.config/blender`) into a copy of its own, so your preferences and add-ons come along. Links in your settings folder aren't copied, and changes a hosted Blender makes stay in its copy. Each hosted Blender keeps its own temporary files (even if your settings name a temporary folder) and add-on ports, so it never clashes with a Blender you're running. Python scripts embedded in `.blend` files don't run in a hosted Blender.

## What it needs

Hosted Blender works when T3 Code runs on Linux, with Blender and the labwc compositor installed. The pane says what's missing if any of them isn't there. On macOS and Windows the pane says it isn't available; the [3D preview](3d-previews.md) still works there.

The pane works on web and desktop, including over a remote connection or T3 Connect. The mobile app doesn't show it yet.
