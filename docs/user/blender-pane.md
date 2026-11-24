# Blender pane

A hosted Blender is a Blender that T3 Code runs for a thread on the computer it's connected to. It draws to a hidden display rather than your screen, and the Blender pane shows it live in the side panel. It's separate from any Blender you run yourself: T3 Code never opens, closes or changes your own Blender or its settings.

## Open a file

Open a `.blend` from the file tree or a file link, then choose **Open in hosted Blender** above the preview. T3 Code starts Blender with that file and the Blender pane opens. The pane shows a 3D Viewport window of its own, with its header and menus, so whatever happens in Blender's main window stays out of it.

If Blender can't open the file, the pane says Blender didn't start. Check that the file opens in Blender, then try again.

Each thread has one hosted Blender with one file open. To open a different file, quit Blender first. A file open in another thread's hosted Blender can't be opened again until that one quits. Only files inside the thread's project or worktree can be opened.

Once a file is open, a link to that `.blend` in the chat opens the Blender pane. Links to other `.blend` files open the file preview.

## Watching

The pane opens view-only. The status strip shows who's in control, the stream's size, frame rate, bitrate and encoder, and how much memory Blender is using.

The stream costs nothing while nobody can see it. When no open pane is on screen, because it's closed, Settings or Usage covers it, its tab is in the background or the window is minimized, Blender stops being captured and encoded, though it keeps running. It picks up again the moment a pane is back on screen. Hiding a pane doesn't give up control.

Blender's display is sized to the pane of whoever is in control, or else to the pane opened or brought back most recently, at your screen's real pixel size so it stays sharp on high-resolution screens. Resizing that pane resizes Blender. The bitrate adjusts to how quickly that device's frames arrive, so a slow connection gets a smoother, softer picture instead of a stalled one. Up to four devices can watch one hosted Blender at a time.

### While the agent works

If **Auto-show floating preview** is on in Settings → Browser, a hosted Blender pops up floating over the chat when a turn starts in its thread, the way a device the agent opens does. The floating player only watches: choose **Open in right panel** to take control. Close it and it stays closed until the next turn. It doesn't appear if the Blender pane is already the panel's open tab or something else is already floating, and it closes when Blender quits. With the setting off, the pane opens only when you or a link opens it.

## Taking control

Click the stream, or choose **Take control**, to use the viewport window with your own mouse and keyboard, just as in Blender. What you do there stays in that window: orbiting or changing the shading never moves the agent's view, and taking control never pauses the agent.

To give control back, click anywhere outside the stream or press F6 (Ctrl+F6 and Ctrl+Shift+F6 work too, as does any key you've bound to moving focus). Shift+F6 goes to Blender.

- **Mouse.** Grabs and orbits keep going past the edge of the pane, because the pointer is locked while Blender holds it. If the browser ends that lock when you press Esc, Esc still reaches Blender.
- **Keyboard.** Every key goes to Blender as the physical key you pressed, typed with your keyboard layout. The layout is detected in the desktop app and in Chromium browsers; elsewhere, or if it's wrong, choose it under **Keyboard layout** in the pane's menu. Held keys and buttons are let go when the pane loses focus.
- **Scrolling.** Whether a scroll comes from a mouse wheel or a trackpad is worked out from how it moves. If it guesses wrong, choose under **Scrolling** in the pane's menu.
- **Browser shortcuts.** The desktop app passes its own shortcuts, like Ctrl+N, to Blender while you're in control. In a browser, Ctrl+W, Ctrl+T, Ctrl+N and Ctrl+Tab belong to the browser; choose **Fullscreen** to send them to Blender too (Chromium browsers only). Hold Esc to leave fullscreen.

The layout and scrolling choices are saved on each device.

Taking control needs permission to use terminals, because Blender's Python console can run anything. Anyone who can see the thread can watch.

One device is in control at a time. While someone else is, the pane offers **Take over**, and the device that lost control is told.

Closing the pane leaves Blender running; open it again from the file preview or a link. To stop Blender, choose **Quit Blender** from the pane's menu. If the file has unsaved changes, you can save them first or quit without saving. If the save fails, Blender keeps running so nothing is lost.

## Its settings

The first time a hosted Blender starts, T3 Code copies your newest Blender settings (from `~/.config/blender`) into a copy of its own, so your preferences and add-ons come along. Links in your settings folder aren't copied, and changes a hosted Blender makes stay in its copy. Each hosted Blender keeps its own temporary files and add-on ports, so it never clashes with a Blender you're running. Python scripts embedded in `.blend` files don't run in a hosted Blender.

## What it needs

Hosted Blender works when T3 Code runs on Linux, with Blender and the labwc compositor installed. The pane says what's missing if any of them isn't there. On macOS and Windows the pane says it isn't available; the [3D preview](3d-previews.md) still works there.

The pane works on web and desktop, including over a remote connection or T3 Connect. The mobile app doesn't show it yet.
