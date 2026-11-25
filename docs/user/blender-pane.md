# Blender pane

A hosted Blender is a Blender that T3 Code runs for a thread on the computer it's connected to. It draws to a hidden display rather than your screen, and the Blender pane shows it live in the side panel. It's separate from any Blender you run yourself: T3 Code never opens, closes or changes your own Blender or its settings, except when you choose [Move into T3 Code](#move-into-t3-code).

Hosted Blender is off until you set it up. Until then, the pane says **Setup needed**.

## Set it up

1. Open **Settings › Blender** and switch on **Hosted Blender**.
2. When you switch it on, T3 Code checks the server for Blender 4.5 or later, labwc, GStreamer 1.24 or later with an H.264 encoder (and its OpenGL plugin on NVIDIA), access to the GPU, and the official Blender Lab MCP server. It also runs a one-second test encode and keeps the first encoder that works. The result stays until you choose **Check again**, so check again after you install or change something. Only someone who may run programs on the server starts a check; after a restart, the first **Open in hosted Blender** or **Check again** does.
3. If something is missing, choose either:
   - **Install with an agent**, which starts a thread in No project with your default agent and tells it what to install for your Linux distribution. When a command needs your password, the agent asks for it in a private card, never in the chat. T3 Code checks again when the agent finishes.
   - **Show me the commands**, which shows `pacman`, `apt` or `dnf` commands you can copy and run yourself.

   T3 Code never installs system packages itself.

4. Switch on **Allow agents to start hosted Blenders**. It needs the setup finished, including the Blender MCP server. If T3 Code doesn't find `blender-mcp` on your PATH or in `~/.local/bin`, set **Blender MCP path** (a path starting with `~/` means the server's home folder). An unrelated project on PyPI is also called `blender-mcp`; T3 Code says so if that's the one it finds.

Without a GPU, or without access to it, hosted Blender still works, but Blender is slow; Settings and the pane's status strip say so.

Switching Hosted Blender off stops new hosted Blenders from starting and closes the ones running, as a settled thread does: each keeps a copy of its unsaved changes, which the pane offers once you switch it on again.

## Open a file

Open a `.blend` from the file tree or a file link, then choose **Open in hosted Blender** above the preview. T3 Code starts Blender with that file and the Blender pane opens. The pane shows a 3D Viewport window of its own, with its header and menus, so whatever happens in Blender's main window stays out of it.

If Blender can't open the file, the pane says Blender didn't start. Check that the file opens in Blender, then try again.

Each thread has one hosted Blender with one file open. To open a different file, quit Blender first. A file open in another thread's hosted Blender can't be opened again until that one quits. Only files inside the thread's project or worktree can be opened.

Once a file is open, a link to that `.blend` in the chat opens the Blender pane, as it does for any file a closed or crashed Blender kept a copy of. Links to other `.blend` files open the file preview.

## Agents in a hosted Blender

With **Allow agents to start hosted Blenders** on, Claude and Codex threads can work in a hosted Blender. Other providers aren't supported yet. A thread picks it up when its agent session next starts, such as in a new thread.

Ask the agent to change a `.blend`, say `models/hero.blend`. It doesn't edit that file: T3 Code copies it to `models/hero.wip-<id>.blend` beside it, where links to other files still work, and opens the copy in the thread's hosted Blender. The agent edits the copy, and posts a link to it when it's done or when you ask to watch; the link opens the Blender pane, and a link with a view moves your viewport window to what it points at. The copy stays in your project after the thread ends. To have the agent work in your own Blender instead, say so.

What the agent may do without asking follows the thread's access mode. In **Full access** it uses every Blender tool freely. In the other modes it reads the scene, takes screenshots and searches the docs freely, and asks before it runs code or writes files. In Plan mode it can only look: it can't start or quit Blender, and embedded scripts stay off. Changing the mode applies from the next turn.

While the agent is running something in Blender, the composer says **Working in Blender**, with **Stop** to stop the turn, and the pane's status bar shows **Agent editing**.

Each piece of code the agent runs in Blender is one undo step, plus one more when it leaves work running in the background that can change the file, such as a bake. Its edits count as unsaved changes, so Blender autosaves them, asks before quitting, and **Ctrl+Z** in the pane undoes them step by step. Renders the agent takes only to look at the scene add no step.

Only programs running under your own account on the server can reach the agent's connection to Blender; T3 Code drops any other. If your Blender's MCP extension is a version T3 Code hasn't tested, the agent gets no access and tells you whether to update the extension or T3 Code. Update the extension in your own Blender: T3 Code copies it into hosted Blenders the next time one starts. If undo is off in your Blender (Undo Steps set to 0, or Global Undo off for edits in Object Mode), the agent's edits can't be undone, and the agent is told so.

Only the working copy the agent started takes its calls. A file you opened from the pane, even the working copy, doesn't; the agent quits it, saving first, and starts it again. Switching **Allow agents to start hosted Blenders** off closes the agent's connection to Blender at once, and so does opening another file in that Blender or saving the copy under another name (reverting it doesn't); Blender keeps running, and you can still watch and use it in the pane. The agent gets it back by quitting and starting the working copy again. A pause between turns doesn't: when the thread's agent session ends and a new one starts, the new one reaches the same Blender, with its undo history. If the agent quits without saving, its unsaved changes are kept as a copy, as when a thread settles, and its next start of that working copy opens it with them restored. If T3 loses its connection to that Blender, save your work in the pane before the agent restarts it.

## The master and copying back

The file you asked the agent to change is the master. Once the agent's change is proven in its working copy, it copies the change back into the master itself, through whichever Blender has the master open:

- your desktop Blender, if it has the master open and runs Blender Lab's MCP add-on, through your own `blender` MCP setup;
- otherwise a master Blender: a hosted Blender T3 Code starts for the master. Threads working on the same master share it, and it quits when the last of them settles or is archived. If it has unsaved changes then, it stays open in that thread's **Master** view until you save or quit it, and that thread can't switch to another master meanwhile. When T3 Code stops or Hosted Blender is switched off, a master Blender closes like any other and keeps one copy of its unsaved changes, which every thread using that master sees on its **Master** side and can reopen or discard.

The agent replaces only the objects it changed, and stops to ask you if any of them changed in the master meanwhile, such as when another agent copied back first. Agents take turns: each marks the master while it copies back, so a second agent waits. Each copy back can be undone in that Blender, and is saved; a desktop Blender shows it straight away. The agent tells you what it copied back.

As soon as the agent starts its working copy, or the thread opens a master, the pane's toolbar has a **Working copy** / **Master** switch, with a dot on each for whether its Blender is running. **Master** shows the master Blender, or, if none has the master open, offers **Open in T3 Code**. Quitting the master Blender from its menu quits it for every thread sharing it. Embedded scripts never run in a master Blender. On a phone, only the working copy shows for now.

### Move into T3 Code

If your desktop Blender has the master open, the pane's **Master** side offers **Move into T3 Code**. T3 Code has your desktop Blender save the file, with any unsaved changes, and quit, then opens the file in a master Blender. Undo history from your desktop Blender is lost. T3 Code opens the file only once your desktop Blender has saved it and quit; if you save it under another name first, nothing moves. Every thread that chose that master moves with it. This needs Blender Lab's MCP add-on running in your desktop Blender on its usual port; without it, T3 Code can't tell what your Blender has open, so it only warns you, before opening the file and above a master Blender it opened that way. A desktop Blender with a different file open is left alone.

## Watching

The pane opens view-only. The status strip shows who's in control, the stream's size, frame rate, bitrate and encoder, and how much memory Blender is using.

The stream costs nothing while nobody can see it. When no open pane is on screen, because it's closed, Settings or Usage covers it, its tab is in the background or the window is minimized, Blender stops being captured and encoded, though it keeps running. It picks up again the moment a pane is back on screen. Hiding a pane doesn't give up control.

Blender's display is sized to the pane of whoever is in control, or else to the pane opened or brought back most recently, at your screen's real pixel size so it stays sharp on high-resolution screens. Resizing that pane resizes Blender. The bitrate adjusts to how quickly that device's frames arrive, so a slow connection gets a smoother, softer picture instead of a stalled one. Up to four devices can watch one hosted Blender at a time.

### While the agent works

If **Auto-show floating preview** is on in Settings → Browser, a hosted Blender pops up floating over the chat when a turn starts in its thread, the way a device the agent opens does. The floating player only watches: choose **Open in right panel** to take control. Close it and it stays closed until the next turn. It doesn't appear if the Blender pane is already the panel's open tab or something else is already floating, and it closes when Blender quits. With the setting off, the pane opens only when you or a link opens it.

## Taking control

Click the stream, or choose **Take control**, to use the viewport window with your own mouse and keyboard, just as in Blender. A left click only takes control; a middle or right press takes control and goes on to Blender, so you can go straight to the pane and orbit or open a menu in one motion. What you do there stays in that window: orbiting or changing the shading never moves the agent's view, and taking control never pauses the agent.

To give control back, click anywhere outside the stream or press F6 (Ctrl+F6 and Ctrl+Shift+F6 work too, as does any key you've bound to moving focus). Shift+F6 goes to Blender.

- **Mouse.** Scrolling over the pane takes control and zooms, like a middle or right press, and the page behind it never scrolls. Grabs and orbits keep going past the edge of the pane, because the pointer is locked while Blender holds it. If the browser ends that lock when you press Esc, Esc still reaches Blender.
- **Keyboard.** Every key goes to Blender as the physical key you pressed, typed with your keyboard layout. The layout is detected in the desktop app and in Chromium browsers; elsewhere, or if it's wrong, choose it under **Keyboard layout** in the pane's menu. Held keys and buttons are let go when the pane loses focus.
- **Scrolling.** Whether a scroll comes from a mouse wheel or a trackpad is worked out from how it moves. If it guesses wrong, choose under **Scrolling** in the pane's menu.
- **Browser shortcuts.** The desktop app passes its own shortcuts, like Ctrl+N, to Blender while you're in control. In a browser, Ctrl+W, Ctrl+T, Ctrl+N and Ctrl+Tab belong to the browser; choose **Fullscreen** to send them to Blender too (Chromium browsers only). Hold Esc to leave fullscreen.

The layout and scrolling choices are saved on each device.

Taking control needs permission to use terminals, because Blender's Python console can run anything. Anyone who can see the thread can watch.

One device is in control at a time. While someone else is, the pane offers **Take over**, and the device that lost control is told.

Closing the pane leaves Blender running; open it again from the file preview, a link or **Open hosted Blender** in the command palette. To stop Blender, choose **Quit Blender** from the pane's menu or **Quit hosted Blender** in the command palette. If the file has unsaved changes, you can save them first or quit without saving. The question names the file Blender has open now, even one you opened from Blender's own File menu; if Blender opens another file before you choose, it asks again for that one. If the save fails, Blender keeps running so nothing is lost. If Blender is too busy to save, **Quit without saving** still stops it. Only **Quit without saving** discards unsaved changes: any other quit, such as the agent's or one made just as an edit arrived, keeps them as a close does.

## When the file changes on disk

A hosted Blender shows the file as it is on disk. When something else changes the `.blend` it has open, such as an agent's script, a copy back through another Blender or a checkout, Blender reloads it: straight away while its pane is on screen, otherwise the next time a pane shows it or the agent next works in it, once however many times the file changed. Your viewport window keeps its view, and undo history starts again, as after any reload. Saving in that Blender, by you or the agent, isn't a change on disk and reloads nothing.

If Blender had unsaved changes, they're kept first as that file's copy, and the pane says so: **Restore changes** puts them back over the reloaded file, unsaved, so you can choose what to keep. If you've changed anything since the reload, it asks first, and what it replaces becomes the copy instead, so restoring again swaps back. Saving the file doesn't remove such a copy, since what you saved never had that work, unless you restored it first; **Discard** on its card removes it once Blender has closed. A Blender that opens the file while the copy waits, such as the agent's next start of its working copy, opens the file as it is on disk and offers the copy the same way.

Blender doesn't reload over unsaved edits to images or asset catalogs, which a copy of the `.blend` can't hold; the pane says the file changed and what is holding the reload, and it reloads once you save or discard them. While a reload waits, the agent's calls into that Blender are refused with the reason, so it never works on the old file. **Save and quit** never writes over a file that changed on disk, or one deleted since Blender opened it: it says so and leaves Blender running.

## When Blender closes

When a thread settles, is archived or is deleted, its hosted Blender closes, and so does every hosted Blender when T3 Code stops or restarts. Deleting a thread also removes every copy it kept; a master's copy stays for the threads still using that master. If the file Blender has open then has unsaved changes, Blender keeps a copy of the session, those changes included, in T3 Code's own folder, as the copy of that file; a file you only looked at keeps nothing. Your file is never saved over.

The pane then offers **Reopen**, which opens the file with those unsaved changes restored, ready to save or discard as you would in Blender. **Open as last saved** opens the file as it is on disk instead. A thread keeps one copy per file: a later session of the same file replaces it only if that session ends with unsaved changes, saving that file (with Ctrl+S in the pane, or Save and quit) removes it, and **Discard** removes it; nothing you do in another file touches it. An edit that Blender doesn't mark as unsaved, such as one by a script of your own that bypasses undo, isn't kept (the agent's edits are always marked). While a file's copy waits, opening that file in hosted Blender shows its copy first, and other files open as usual. If the thread kept copies of several files, the pane lists them under **Also kept**; choose one to see it. Copies are still there after T3 Code restarts. A copy of a file outside the project, or of an untitled scene, can't be reopened from T3 Code: the pane says where the copy is, so you can open it in your own Blender, and offers **Discard**. When T3 Code stops, it gives each Blender a few seconds to begin keeping its copy. One that is already writing its copy is left to finish it, and the pane offers that copy the next time T3 Code starts; one that hasn't begun is stopped. Your file is never damaged that way, but that session's unsaved changes can be lost. If the file is missing afterwards, its previous version is beside it as `.blend1`. If Blender can't restore the copy, the pane says so and keeps it.

If Blender crashes, it stays stopped and the pane says so. **Restart** opens the file as last saved; if Blender autosaved since your last save, **Restore autosave** opens that instead. Blender autosaves on the schedule in its own settings (every 2 minutes by default). If T3 Code itself stops without closing Blender, the pane shows the crash the next time it starts.

## Running Blenders

**Settings → Blender** lists every hosted Blender running on the connected environment under **Running Blenders**, with its thread, file and memory use. **Quit** stops one, asking first whether to save a file with unsaved changes.

## Point the agent at something

**Screenshot & annotate** in the pane's toolbar has Blender take a picture of the 3D view in its viewport window and freezes it so you can draw on it, mark regions and write or dictate a comment, as in the [3D preview](3d-previews.md#point-the-agent-at-part-of-a-model). Add to chat puts it in the composer with the screenshot, titled with the file and whether it's a working copy or the master, such as "hero.wip-a1b2.blend · Working copy". The agent also gets the camera the picture was taken from and, for each mark, the object Blender finds under it and the 3D point it covers. If Blender can't take the picture, as in Cycles' rendered view, the frame you were watching is frozen instead, without the camera or what the marks cover. Very large viewports are pictured at a smaller size.

## View links

A link to the open `.blend` that ends in `#view=` and six numbers, such as `models/hero.blend#view=6,-6,5,0,0,0`, opens the pane and moves the viewport window to look from the first three numbers at the last three, in Blender's scene coordinates. It never moves the agent's own view. An annotation carries a link like this, so the agent can send you back to what you pointed at. A view link to a `.blend` that isn't open in the thread's hosted Blender opens the file preview instead. Only people who can control the thread move the view; others just see the pane open.

## On a phone

In the mobile app, open a `.blend` from the thread's files and choose **Open in hosted Blender** from the file's menu. While a hosted Blender is running, the thread also shows a Blender button beside its device and browser previews, so anyone who can see the thread can watch it. Blender opens full screen, view-only, with the same permissions as on desktop: anyone who can see the thread can watch, and taking control needs permission to use terminals.

Tap the stream, or choose **Take control** (**Take over** while another device has it), to control the viewport window by touch:

| Gesture              | Does        |
| -------------------- | ----------- |
| Tap                  | Click       |
| One-finger drag      | Orbit       |
| Two-finger drag      | Pan         |
| Pinch                | Zoom        |
| Long-press           | Right-click |
| **Z** in the toolbar | Shading pie |

Choose **Done** to give control back. Closing Blender's screen gives it back too and leaves Blender running; **Quit Blender** in its ⋯ menu quits it, offering to save first. Typing on a phone isn't supported yet.

Setting up hosted Blender happens in **Settings › Blender** on the web or desktop. If it's switched off, not yet checked or missing something, the phone says so.

## Its settings

The first time a hosted Blender starts, T3 Code copies your newest Blender settings (from `~/.config/blender`) into a copy of its own, so your preferences and add-ons come along. Links in your settings folder aren't copied, and changes a hosted Blender makes stay in its copy. Each hosted Blender keeps its own temporary files (even if your settings name a temporary folder) and add-on ports, so it never clashes with a Blender you're running. Python scripts embedded in `.blend` files follow your **Auto Run Python Scripts** preference only in Full access threads; in every other mode they never run.

## Where it works

Hosted Blender works when T3 Code runs on Arch, Fedora 43 or later, Ubuntu 24.04 or later, or Debian 13 or later. Ubuntu 22.04 and Debian 12 ship labwc and GStreamer too old for it, and Flatpak and Snap builds of Blender aren't supported yet, so the pane and Settings say it isn't available there. On macOS and Windows it isn't available either; the [3D preview](3d-previews.md) still works there.

The pane works on web, desktop and mobile, including over a remote connection or T3 Connect.
