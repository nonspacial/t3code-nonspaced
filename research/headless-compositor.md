# Which headless compositor should run a hosted Blender?

Research for issue #2 (map: #1). Feeds #13 (detection and setup) and #17 (grabs past the window edge).
Checked on 2026-11-23 against cage 0.3.1, sway 1.12, labwc 0.20.3, weston 15.0.1, gamescope 3.17.0, wlroots 0.20, and Blender `main`.

## Answer

**Use labwc, running on the wlroots headless backend, started by T3 with T3's own config folder:**
`WLR_BACKENDS=headless labwc -C <t3-config-dir> -S "blender --window-maximized ..."`

**Runner-up: sway headless.** Choose it if labwc's packaging floor is too high (labwc is missing from Ubuntu 22.04 and Debian 12), or if T3 wants sway's IPC.

**cage is ruled out for now.** It has no `pointer-constraints` support. Blender's own code refuses every cursor grab unless the compositor offers both `relative-pointer` and `pointer-constraints`. This is the real reason G/R/S stopped at the window edge in the earlier test. Absolute pointer events alone do not explain it. A cage patch adding the protocol (cage-kiosk/cage#300) has been open since 2023.

The deciding reasons:

1. **Grabs.** Blender needs `pointer-constraints` and `relative-pointer`. labwc, sway, weston and gamescope have both. cage does not.
2. **Input injection from T3.** T3 needs `wlr-virtual-pointer`, which carries both relative and absolute motion, plus `virtual-keyboard`. labwc, sway and cage have them. weston and gamescope do not.
3. **Extra windows.** Blender opens Preferences and the F12 render window as separate top-level windows with *no parent*. On a stacking compositor like labwc they appear as normal floating windows above the maximized main window, with no rules needed. sway is a tiling compositor, so it splits the screen for each new window unless T3 adds floating rules (matched on window titles, which change with language) or manages windows over IPC. cage maximizes each one over the main window.
4. **Lifetime.** `labwc -S <cmd>` exits when Blender exits, as cage does. sway needs T3 to stop it.
5. **No NVIDIA nag.** sway shows a "Proprietary GPU drivers are not supported" swaynag bar on nvidia-drm unless it is started with `--unsupported-gpu`. labwc uses the same wlroots renderer without that bar.

## Comparison

"Yes (vX)" means the feature is in the source or release notes from that version on. "✗" means it is absent.

| | **labwc** (pick) | **sway** (runner-up) | cage | weston | gamescope | own helper (wlroots/Smithay) |
|---|---|---|---|---|---|---|
| Licence | GPL-2.0 | MIT | MIT | MIT | BSD-2/3 (+ReShade) | MIT / MIT |
| Arch | 0.20.3 | 1.12 | 0.3.1 | 15.0.1 | 3.17.0 | build it |
| Debian 12 / 13 / sid | ✗ / 0.8.3 / 0.20.3 | 1.7 / 1.10.1 / 1.12 | 0.1.4 / 0.2.0 / 0.3.1 | 10 / 14 / 16 | 3.11 / bpo 3.16 / 3.16 | build it |
| Ubuntu 22.04 / 24.04 / 26.04 | ✗ / 0.7.1 / 0.9.3 | 1.7 / 1.9 / 1.11 | 0.1.4 / 0.1.5 / 0.2.1 | 9 / 13 / 14 | ✗ / ✗ / 3.16 | build it |
| Fedora 43 / 44 | 0.9.6 / 0.9.6 | 1.11 / 1.11 | 0.2.0 / 0.3.1 | 14 / 15 | 3.16 / 3.16 | build it |
| Headless mode | wlroots `WLR_BACKENDS=headless` | same, plus `create_output` | same | `--backend=headless` / `pipewire` / `vnc` / `rdp` | `--backend headless` | yours |
| Renderer on NVIDIA / AMD / Intel | wlroots gles2/vulkan/pixman on a render node | same (nags on nvidia-drm) | same (tested working on RTX 4090) | GL / pixman | Vulkan only (ran, crashed on exit) | yours |
| `wlr-screencopy` | yes | yes | yes | ✗ | ✗ (own PipeWire node) | yours |
| `ext-image-copy-capture` | yes (0.9.0) | yes (1.11) | ✗ | ✗ | ✗ | yours |
| `wlr-virtual-pointer` (rel + abs) | yes (0.6.0) | yes | yes | ✗ | ✗ | not needed (in-process) |
| `virtual-keyboard` | yes (0.6.0) | yes | yes | ✗ | ✗ | not needed |
| `relative-pointer` | yes (0.4.0) | yes | yes | yes | yes | must add |
| `pointer-constraints` | yes (0.4.0) | yes | **✗** | yes | yes | must add |
| Runtime resize | `wlr-output-management` (0.2.0) | same + `swaymsg output … mode --custom` | `wlr-output-management` | restart / backend flags | flags | yours |
| Fractional scale | yes (0.7.0) | yes | ✗ | yes | ✗ | must add |
| Xwayland | yes | yes | yes | `--xwayland` | yes (X-centric) | must add |
| Blender's extra windows | float above main window | tiled split unless T3 adds rules | maximized on top | desktop-shell floats them | one focused window | yours |
| Exits with the app | `-S` | ✗ (T3 stops it) | yes | ✗ | yes | yours |

## Details

### What Blender needs from the compositor

- **Grabs need two protocols.** `GHOST_SystemWayland::window_cursor_grab_set` returns early with `if (!display_->wp.relative_pointer_manager || !display_->wp.pointer_constraints) return false;`. Wrap and hide grabs (G/R/S, middle-mouse orbit) use a *locked* pointer (`use_lock = ELEM(mode, GHOST_kGrabWrap, GHOST_kGrabHide)`). The code comment says wrap "cannot be supported by positioning the cursor directly" on Wayland. Source: [GHOST_SystemWayland.cc](https://projects.blender.org/blender/blender/src/branch/main/intern/ghost/intern/GHOST_SystemWayland.cc), around lines 10673–10680 and 11426–11640.
- **What a lock does.** While a pointer is locked, `wl_pointer.motion` stops but "relative motion events will still be emitted via wp_relative_pointer objects". So Blender keeps getting deltas after the cursor stops moving ([pointer-constraints-unstable-v1](https://wayland.app/protocols/pointer-constraints-unstable-v1)).
- **Extra windows have no parent.** Blender calls `xdg_toplevel_set_parent` only when `parent_window && is_dialog` ([GHOST_WindowWayland.cc](https://projects.blender.org/blender/blender/src/branch/main/intern/ghost/intern/GHOST_WindowWayland.cc), around line 1860). Preferences opens with `dialog=false` ([screen_ops.cc](https://projects.blender.org/blender/blender/src/branch/main/source/blender/editors/screen/screen_ops.cc), around line 7408, through `ED_screen_temp_space_open` in [screen_edit.cc](https://projects.blender.org/blender/blender/src/branch/main/source/blender/editors/screen/screen_edit.cc)). The F12 render window is opened with `toplevel=true, dialog=false, temp=true` ([render_view.cc](https://projects.blender.org/blender/blender/src/branch/main/source/blender/editors/render/render_view.cc), around line 177). Every such window reaches the compositor as an independent toplevel.
- **Maximize at start.** Blender has `-M/--window-maximized`, `-W/--window-fullscreen` and `-p/--window-geometry` ([creator_args.cc](https://projects.blender.org/blender/blender/src/branch/main/source/creator/creator_args.cc), around line 3375). Use maximized, not fullscreen. On sway, a parentless window opened while another window is fullscreen tiles *behind* it, because `popup_during_fullscreen` only covers dialogs ([sway(5)](https://github.com/swaywm/sway/blob/1.12/sway/sway.5.scd)).

### labwc (recommended)

- **Protocols.** [server.c @0.20.3](https://github.com/labwc/labwc/blob/0.20.3/src/server.c) creates `wlr_screencopy_manager_v1`, `wlr_ext_image_copy_capture_manager_v1`, the output and foreign-toplevel image-capture sources, `wlr_pointer_constraints_v1`, `wlr_relative_pointer_manager_v1`, `wlr_fractional_scale_manager_v1` and `wlr_headless_backend`. [seat.c](https://github.com/labwc/labwc/blob/0.20.3/src/seat.c) creates the virtual keyboard and pointer managers.
- **Version history** ([NEWS.md](https://github.com/labwc/labwc/blob/0.20.3/NEWS.md)): pointer-constraints and relative-pointer in 0.4.0, virtual keyboard and pointer in 0.6.0, fractional-scale in 0.7.0, `ext-image-copy-capture` in 0.9.0, wlr-output-management in 0.2.0.
- **Locked pointer.** When the pointer is locked, labwc does not move the cursor (`cursor_locked`) but still sends relative motion. Virtual pointers count as `WLR_INPUT_DEVICE_POINTER` ([cursor.c](https://github.com/labwc/labwc/blob/0.20.3/src/input/cursor.c), around lines 856–990; [wlr_virtual_pointer_v1.c](https://gitlab.freedesktop.org/wlroots/wlroots/-/blob/0.20.0/types/wlr_virtual_pointer_v1.c), `wlr_pointer_init`).
- **CLI.** `-S, --session <command>` runs the command "and terminate[s] compositor on exit". `-C <dir>` sets the config folder ([labwc(1)](https://github.com/labwc/labwc/blob/0.20.3/docs/labwc.1.scd)).
- **Window placement.** New windows go to the centre of the output by default (`<placement><policy>`, [labwc-config(5)](https://github.com/labwc/labwc/blob/0.20.3/docs/labwc-config.5.scd), line 352). Server-side decorations are on by default and can be switched off per window with `windowRule serverDecoration="no"`.
- **Default keybinds.** labwc loads its default keybinds (A-Tab, W-Return, …) whenever rc.xml has no `<keybind>` entries ([labwc-config(5)](https://github.com/labwc/labwc/blob/0.20.3/docs/labwc-config.5.scd), line 880). T3's rc.xml must define at least one harmless keybind so Blender gets every key.
- **Licence.** GPL-2.0 ([repo](https://github.com/labwc/labwc)). Running a system-installed binary from MIT-licensed T3 is fine. Bundling it inside the Electron app would bring GPL source-distribution duties, which is another reason to use the system package (#13).

### sway (runner-up)

- **Protocols.** [server.c @1.12](https://github.com/swaywm/sway/blob/1.12/sway/server.c) creates screencopy, `ext-image-copy-capture` (added in [1.11](https://github.com/swaywm/sway/releases/tag/1.11)), pointer-constraints, relative-pointer, fractional-scale, output management and Xwayland. [input-manager.c](https://github.com/swaywm/sway/blob/1.12/sway/input/input-manager.c) creates the virtual keyboard and pointer managers and transient-seat.
- **Locked pointer.** `pointer_motion` sends relative motion first, then applies the constraint ([cursor.c](https://github.com/swaywm/sway/blob/1.12/sway/input/cursor.c), around line 290).
- **Headless use.** `create_output` adds a 1920×1080 output on the headless backend ([create_output.c](https://github.com/swaywm/sway/blob/1.12/sway/commands/create_output.c)). `output <name> mode --custom WxH` resizes it ([sway-output(5)](https://github.com/swaywm/sway/blob/1.12/sway/sway-output.5.scd)). The wayvnc FAQ documents `WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 sway` as the standard headless setup ([wayvnc FAQ](https://github.com/any1/wayvnc/blob/v0.10.2/FAQ.md)).
- **Why it lost: floating.** sway floats a window only if it has a parent or a fixed size (`wants_floating`, [xdg_shell.c](https://github.com/swaywm/sway/blob/1.12/sway/desktop/xdg_shell.c), line 228). Blender's Preferences and render windows would therefore tile beside the main window.
- **Why it lost: NVIDIA.** On `nvidia-drm` it sets `unsupported_gpu_detected` and shows a swaynag bar that says "Do not report issues", unless started with `--unsupported-gpu` or `SWAY_UNSUPPORTED_GPU=true` ([server.c](https://github.com/swaywm/sway/blob/1.12/sway/server.c), line 166; [main.c](https://github.com/swaywm/sway/blob/1.12/sway/main.c), line 389).
- **Why it would win.** It has the widest packaging (back to Ubuntu 22.04 and Debian 12), and its IPC socket is a ready-made control channel.

### cage (ruled out until it gains pointer-constraints)

- **What it has.** [cage.c @v0.3.1](https://github.com/cage-kiosk/cage/blob/v0.3.1/cage.c) creates screencopy, export-dmabuf, output management, virtual keyboard and pointer, relative-pointer and Xwayland.
- **What it lacks.** There is no pointer-constraints, no `ext-image-copy-capture` and no fractional-scale. master as of 2026-11-01 adds cursor-shape but still no constraints. wayland.app's table also marks cage ✗ for pointer-constraints and ext-image-copy-capture ([pointer-constraints](https://wayland.app/protocols/pointer-constraints-unstable-v1), [ext-image-copy-capture](https://wayland.app/protocols/ext-image-copy-capture-v1)).
- **Upstream status.** PR [cage-kiosk/cage#300](https://github.com/cage-kiosk/cage/pull/300) "Implement pointer constraint" has been open since 2023-12-30. A maintainer said in [#500](https://github.com/cage-kiosk/cage/issues/500) that pointer-constraints is required for mouse capture. Tracking issue: [#163](https://github.com/cage-kiosk/cage/issues/163).
- **Extra windows.** Any toplevel without a parent is "primary" and is maximized (`is_primary`, [xdg_shell.c](https://github.com/cage-kiosk/cage/blob/v0.3.1/xdg_shell.c), line 139; `view_position`, [view.c](https://github.com/cage-kiosk/cage/blob/v0.3.1/view.c), line 94). Preferences and render windows would cover Blender completely.
- **If #300 lands, cage becomes the simplest choice.** It needs no config at all and runs one app.

### weston (ruled out)

- **Protocols.** It has pointer-constraints, relative-pointer, fractional-scale and xwayland-shell. It has no wlr virtual pointer or keyboard and no screencopy or image-copy-capture ([protocol/meson.build @15.0.1](https://gitlab.freedesktop.org/wayland/weston/-/blob/15.0.1/protocol/meson.build)).
- **How input would work.** Outside clients cannot inject input. Remote input only comes through weston's own VNC backend (one client) or RDP backend ([weston(1)](https://gitlab.freedesktop.org/wayland/weston/-/blob/15.0.1/man/weston.man)). T3 would have to become an RDP or VNC client.

### gamescope (ruled out)

- **Protocols.** It creates relative-pointer and pointer-constraints but has no virtual pointer or keyboard and no screencopy. It exposes its own `gamescope_pipewire` global ([wlserver.cpp @3.17.0](https://github.com/ValveSoftware/gamescope/blob/3.17.0/src/wlserver.cpp)).
- **How input would work.** External input arrives only through libei/XTEST via Xwayland. Native Wayland clients need `--expose-wayland`.
- **Local result.** It ran Blender headless but segfaulted on exit.

### Embedding a compositor in a T3 helper (not for v1)

- **The cost.** Smithay (MIT, [repo](https://github.com/Smithay/smithay), latest release v0.7.0) or wlroots (MIT) would give full control: no virtual-input protocol hop, and direct frame access for the encoder. It would also mean T3 shipping and maintaining a native binary per architecture and reimplementing xdg-shell, pointer-constraints, relative-pointer, Xwayland and output handling.
- **When to revisit.** Only if #17 shows that the system compositor plus a protocol client cannot meet latency or input needs.

### GPU notes (wlroots, which labwc, sway and cage share)

- **Renderer choice.** Auto mode tries gles2, then vulkan, then pixman when there is no render node. `WLR_RENDERER`, `WLR_RENDER_DRM_DEVICE` and `WLR_RENDERER_FORCE_SOFTWARE` override this ([env_vars.md @0.20.0](https://gitlab.freedesktop.org/wlroots/wlroots/-/blob/0.20.0/docs/env_vars.md); [wlr_renderer.c](https://gitlab.freedesktop.org/wlroots/wlroots/-/blob/0.20.0/render/wlr_renderer.c), lines 96–270).
- **Which GPU.** The headless backend opens the *first* DRM render node that `drmGetDevices2` returns. On hybrid laptops that may not be the GPU Blender uses, so T3 may need to set `WLR_RENDER_DRM_DEVICE`.
- **Output.** The headless backend creates one 1280×720 output unless `WLR_HEADLESS_OUTPUTS` says otherwise ([backend.c](https://gitlab.freedesktop.org/wlroots/wlroots/-/blob/0.20.0/backend/backend.c), lines 124 and 221).
- **NVIDIA.** It works through GBM: the earlier cage + gles2 run on the RTX 4090 with driver 620.73 confirms this. AMD and Intel (Mesa) are wlroots' primary targets.

### Capture and input transport (inputs to #17 and the encoder ticket)

- **Capture.** `wlr-screencopy` is the common floor across every distro version above. `ext-image-copy-capture` needs labwc ≥0.9 or sway ≥1.11 (missing on Ubuntu 24.04 and Debian 13), so a capture client should support both.
- **Input.** wayvnc speaks RFB, whose pointer events are absolute. Under a pointer lock, absolute positions become deltas from a frozen cursor, which is wrong for an endless drag. #17 needs T3 to send `zwlr_virtual_pointer_v1.motion` (relative `dx`, `dy`) from browser Pointer Lock `movementX/Y` ([wlr-virtual-pointer](https://wayland.app/protocols/wlr-virtual-pointer-unstable-v1)).

## Still unknown (for #17 and #13)

1. **labwc headless start.** Not yet run on this machine (no compositor was launched for this research). #17 should confirm that `WLR_BACKENDS=headless labwc -C … -S blender` starts on the NVIDIA box, that `WLR_RENDERER` auto-select works, and that Blender draws.
2. **The grab itself.** #17 should confirm that Blender's lock activates under labwc and that relative virtual-pointer motion drives G/R/S and middle-mouse orbit past the edge. Also check that Blender's warp-back on ungrab (it sets a cursor-position hint) lands sensibly.
3. **Decorations.** With labwc's server-side decorations, does the maximized main window get a title bar? Should T3 turn decorations off for all windows (and rely on libdecor, if Blender has it), or keep them so the Preferences and render windows can be moved and closed?
4. **Resize.** Does resizing through wlr-output-management (`wlr-randr --custom-mode`) on the headless output relayout the maximized Blender window cleanly?
5. **Packaging floor.** labwc's floor (Ubuntu ≥24.04, Debian ≥13) is a #13 decision. If older LTS releases must work, sway with a T3 floating rule or IPC is the fallback.
6. **Cage.** Watch cage-kiosk/cage#300. If it merges, cage could replace labwc with less configuration.
