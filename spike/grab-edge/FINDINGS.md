# Spike #17: grabs past the window edge, on labwc headless

Ran on 2026-11-24 on Arch/CachyOS with an RTX 4090 (driver 620.73), labwc 0.20.3 (wlroots 0.20.2), Blender 5.3.0 and GStreamer 1.28.9.

**Setup.** labwc ran on the wlroots headless backend with a private `XDG_RUNTIME_DIR`, so it could never touch the desktop session. Blender ran natively on Wayland with Vulkan. One small Rust helper (`helper/src/main.rs`, about 1,000 lines) opened **one** Wayland connection and did all of the following:
- virtual pointer and virtual keyboard;
- output, toplevel and cursor capture;
- wlr-screencopy;
- output resizing;
- frames into GStreamer.

`driver.py` drove each check and read Blender's own state from `probe.py`, which reports every 0.1 s.

## Results

| # | Check | Result | Key numbers |
|---|---|---|---|
| 1 | labwc headless + Blender on Wayland/Vulkan, protocols advertised | **Pass** | Blender reports `windowing: WAYLAND`, `backend: VULKAN`, RTX 4090. All six protocols are advertised: pointer-constraints v1, relative-pointer v1, wlr-virtual-pointer v2, virtual-keyboard v1, ext-image-copy-capture v1, wlr-screencopy v3. Also present: foreign-toplevel capture source, wlr-output-management v4, linux-dmabuf v4. |
| 2 | One connection does pointer, keyboard and capture | **Pass** | One `wl_display` carried everything listed above. GStreamer's GL runs on surfaceless EGL (`GST_GL_WINDOW=surfaceless`, confirmed as `GstGLDisplayEGL` with no Wayland socket), which is not a second Wayland client. |
| 3 | Grabs continue past the edge | **Pass (relative motion)** | Pushing 2,400 px right from x=768 on a 1920-wide display: G moved the cube from x=7.0 at the edge to 16.3 at the end, changing in 13 of 13 samples after the edge. R and S also kept changing after the edge. MMB orbit kept turning. **Absolute motion during a lock moves nothing at all**: the cube stayed at 0.0 and the orbit froze. Input to captured frame during G was 15–46 ms (an upper bound, because the driver polls). |
| 4 | Can T3 see Blender hide its cursor? | **Yes** | ext-image-copy-capture **cursor session**: `leave` arrives 5–11 ms after G, R or MMB-down. `enter`, `position` (Blender's warp target) and a new cursor image arrive 8–15 ms after release. With output capture running too, these took 24–113 ms, and once 0.7 s. |
| 5 | Frames only on change, screencopy fallback | **Pass** | ext session: **0 frames in 10 s idle**. While animating: 60 fps on DMABuf, 20–24 fps on SHM. wlr-screencopy `copy_with_damage`: 279 frames in 5 s animating (56 fps), 0 frames in 5 s idle, and stills capture fine. |
| 6 | NVIDIA zero-copy into NVENC | **Pass** | DMABuf → `glupload` (DirectDmabuf EGL import) → `nvh264enc`: **60.3 fps at 1080p**, 7.6 ms median encode (p95 9 ms), helper CPU 17–32% of one core, GPU 13–22%, NVENC 5–6%. The SHM path is capped at **20 fps** at 1080p by readback (35 ms present-to-ready), with 7.5% CPU and 4.5 ms encode. x264 on SHM: 24 fps, 187% CPU. |
| 7 | Extra windows float | **Pass, with one caveat** | Preferences opens as a centred floating window with a labwc title bar. The F12 render window also floats, but Blender sizes it to the render resolution (1918×1052), so it covers the whole display. Closing the extra windows returns to 1 window. |
| 8 | Live resize without restarting | **Pass on DMABuf, fail on SHM** | `wlr-output-management` custom mode: 1920→1280→1600→1920. The new `buffer_size` arrives in 2–6 ms, Blender relays out within one probe tick (≤0.1 s), DMABuf capture stays at 60 fps, and the encoder renegotiates caps with no errors. Each resize costs 1 failed frame. **SHM capture at 1280×720 is killed by the compositor** ("Invalid stride (5120)"), even from a cold start with no resize. |
| 9 | Keyboard (GB keymap) and viewing input | **Pass** | GB keymap uploaded. Tab toggles Edit Mode (66–104 ms). G X 2 Enter followed by Ctrl+Z undoes (97–111 ms). The Z pie opens and the W/E/S picks give WIREFRAME/SOLID/MATERIAL (in the viewer window the very first pick was missed; later ones worked). Numpad 7/1/3 give top/front/right. Home frames all. Wheel zooms. Shift+MMB pans. Right-click opens the Object context menu. |
| 10 | Dedicated viewer window | **Pass** | `wm.window_new()` gives a one-area full 3D Viewport with header, toolbar and sidebar ("3D Viewport" toplevel). Driving it with pie, numpad, wheel, pan, Home and orbit changed its `rot`, `dist`, `loc` and `shading`; the main window's four values were **identical** before and after. A Blender screenshot of the main window shows only the main view. Stream it either by fullscreening the viewer (`wm.window_fullscreen_toggle`) or with the **foreign-toplevel capture source**, which returns only that window at its own size and kept streaming at 60 fps while fully covered by the main window. |

## What the spec should say

**Input mode: use hidden-cursor detection. It works.**
- Open an `ext_image_copy_capture` cursor session on the output, on the helper's one connection. Treat cursor-session `leave` as "Blender holds the lock": switch the client to Pointer Lock and send relative `motion`. Treat `enter` as "released": exit Pointer Lock. The `position` that arrives with `enter` is where Blender put the cursor.
- Capture the output **without** `paint_cursors`. A `paint_cursors` session makes the cursor session send `leave` and never come back. Without it, frames contain no compositor cursor, and pointer moves alone cause no frames. The client draws the cursor itself, from the cursor session's image or with a CSS cursor. During a lock, Blender draws its own crosshair inside its frame.
- Relative motion is **required** while locked. On labwc, absolute motion during a lock does nothing at all; it is not the "runaway delta" the research predicted. Relative-only-while-in-control remains a fallback, but it isn't needed on labwc.
- The helper sends the virtual-keyboard `modifiers` request itself after modifier keys. I didn't test whether wlroots would derive them without it.
- Keep a Blender-side backup in mind. `window.modal_operators` lists `TRANSFORM_OT_*` and `VIEW3D_OT_rotate` during grabs, if an add-on ever needs to confirm.

**NVIDIA path: capture into DMABuf, then `glupload ! nvh264enc`. No CPU copy.**
- The helper allocates capture buffers with GBM on the session's `dmabuf_device`, using a modifier the session offers. On this driver every offer was NVIDIA block-linear; LINEAR was not offered.
- It wraps the fd as `memory:DMABuf` `DMA_DRM` caps on `appsrc`.
- Pipeline: `glupload ! nvh264enc zerolatency=true tune=ultra-low-latency bframes=0`, with GL on surfaceless EGL, and **no leaky queue or `glcolorconvert` in front**. With those two elements the encode latency was 71 ms; without them it was 7.6 ms.
- Treat SHM as the fallback only. On NVIDIA it tops out around 20 fps at 1080p, and on this labwc it breaks outright at some sizes (1280×720).

**Other spec changes**
- Resize the hidden display with `wlr-output-management` custom modes. Neither the helper nor Blender needs restarting, but the helper must reallocate buffers on the new `buffer_size` and drop the one frame that fails with `buffer_constraints`.
- For a dedicated viewer window, the **foreign-toplevel capture source** is the cleanest stream: exact window size, no decorations, and it streams even while covered. Input still goes to whatever is on top under the pointer, so keep the viewer fullscreen or on top while the user drives it.
- The F12 render window opens at render resolution and covers everything. Decide whether T3 shrinks it with a labwc window rule or lets it cover the screen.
- labwc's `-S` command runs without a shell **and drops `TMPDIR`** from the environment. Pass the isolation variables on the command itself, for example `env TMPDIR=… BLENDER_USER_RESOURCES=… blender …`. The probe also sets Blender's temp-directory preference.
- labwc starts Xwayland lazily and sets `DISPLAY` for its child. Blender still chose Wayland, but T3 should not rely on `DISPLAY` being unset.
- The minimal `rc.xml` needs one inert keybind (`W-F24` → `None`), or labwc loads its defaults, including Alt+F4. Set `maximizedDecoration none` so the maximized main window has no title bar.

## Surprises

- **Absolute motion during a lock is silently dropped** by labwc, not turned into runaway deltas.
- **`paint_cursors` breaks the cursor session**, and in our run it never recovered.
- **SHM capture fails at 1280×720** with a compositor-side "Invalid stride (5120)" protocol error. My buffer was valid: 1280×720, stride 5120, pool 3,686,400 bytes, XBGR8888. The same path works at 1920×1080 and 1824×972. This looks like a labwc/wlroots bug and is worth reporting upstream. DMABuf is unaffected.
- labwc's ext session offers SHM as **XBGR8888** only, and wlr-screencopy offers **BGR888** (24-bit) only. Neither offers XRGB8888.
- My first encode-latency numbers were dominated by a leaky `queue` plus `glcolorconvert` (71 ms). Without them it was 7.6 ms.
- An orbit test of exactly 1,800 px looked like "no orbit". At Blender's default 0.4°/px that is exactly 720°, so the view comes back to the same place. Orbit works after numpad keys, Home and pan.
- `wm.window_new()` in Blender 5.3 already gives a single-area window, so no `screen_full_area` is needed.

## Not covered

- AMD/Intel `vah264enc`: no such GPU on this machine.
- Browser-side Pointer Lock round trip and Esc handling (input-fidelity checks 4, 6 and 7).
- Real end-to-end glass-to-glass latency. The measured pieces are input to captured frame (15–46 ms upper bound) plus 7.6 ms encode; network and decode were not measured.

## Housekeeping

- The **first** smoke run wrote `/tmp/quit.blend` before I found that labwc drops `TMPDIR`. That overwrote any existing "Recover Last Session" file. Every later run kept `quit.blend` in `03-labwc-spike/tmp/`.
- An empty `/tmp/blender_AJVL02` directory is probably from a one-off `blender -b` check and was left alone.
- No spike processes remain.

## Files

- `start-labwc.sh` and `labwc/rc.xml`: the hidden display.
- `probe.py`: Blender state reporter and command runner.
- `driver.py`: the checks, one `phase_*` each.
- `helper/`: the Rust one-connection helper.
- Screenshots are in `shots/`. Key ones:
  - `01-setup-1080p.png`
  - `04-c3-grab-paintcursors0-crop.png` (Blender's own crosshair during a grab)
  - `07-preferences-floating.png`, `07-render-and-prefs-floating.png`
  - `08-resize-1280x720.png`
  - `09-main-z-pie-open.png`, `09-main-rmb-menu.png`
  - `10-viewer-floating-output.png`, `10-viewer-fullscreen-after-interaction.png`, `10-main-window-blender-screenshot.png`, `10-viewer-toplevel-capture-while-occluded.png`
