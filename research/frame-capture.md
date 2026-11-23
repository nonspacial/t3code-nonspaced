# How should T3 get frames out of the hidden display?

Research for nonspacial/t3code-nonspaced#18 (map: #1). Feeds #13 (detect and set up what a hosted Blender needs) and #17 (spike). Builds on #2 (`headless-compositor.md`), #3 (`input-fidelity.md`) and #4 (`capture-encode.md`).
Checked on 2026-11-23 against labwc `master` @ `7541ba3` (0.20.3), gst-wayland-display `stable` @ `1c274e9`, wayvnc `master` @ `54a775f`, gamescope `master` @ `7d957c5`, xdg-desktop-portal-wlr `master` @ `8388b8a` (v0.9.0), wayland-rs `master`, and local GStreamer 1.28.9 on Arch (RTX 4090).

## Answer

**Build a small T3-owned helper that is a Wayland client of labwc. It reads frames with `ext-image-copy-capture-v1` and pushes them into GStreamer through `appsrc`, as DMABuf where the GPU allows it. The same process also runs the virtual pointer and keyboard from #3.** Keep labwc as the compositor. #2's pick does not change.

- **Language:** Rust, using `wayland-client` plus the `wayland-protocols` (feature `staging`), `wayland-protocols-wlr` and `wayland-protocols-misc` crates, with `gstreamer`, `gstreamer-app` and `gstreamer-allocators`. These crates already cover every protocol the helper needs. C, as in wayvnc, also works.
- **Size:** wayvnc's client for the same protocol is about 800 lines of C, and its buffer allocator is about 700 more. Expect roughly 1,500 to 2,500 lines for capture, buffers, the GStreamer glue and input together.
- **Shipping:** link system GStreamer dynamically, and install the binary on demand per architecture, the way T3 already installs its device tools.

**Runner-up: `waylanddisplaysrc` (gst-wayland-display).** It is the only option that removes capture code, and its input handling is good. It loses for four reasons:

1. **Every window goes fullscreen.** Each new top-level window is forced to fill the screen. Blender's Preferences and F12 render windows would cover the main window, and the compositor's only way to switch between windows is Ctrl+Shift+Tab. This is the cage problem again, which #2 rejected.
2. **It is not packaged anywhere.** No distro packages it, it has no releases or tags, it depends on a pinned fork of Smithay, and it now needs GStreamer 1.28 to build. T3 would have to build and ship a GStreamer plugin and compositor for every distro and GStreamer version.
3. **It renders every frame, even when nothing changes.** It produces a frame at the negotiated rate whether or not the screen changed. #4 asked for capture only on change.
4. **It fixes some behaviour in code.** It intercepts Ctrl+Shift+Tab and Ctrl+Shift+Q itself, and it has no Xwayland, no fractional scaling and no window rules.

**Ruled out:**

- **gamescope's PipeWire output:** it has no virtual input, it has an open crash on exit when running headless on NVIDIA (the same crash we saw), and it adds a PipeWire daemon.
- **xdg-desktop-portal-wlr ScreenCast:** four extra daemons per hidden display (session D-Bus, the portal frontend, PipeWire, WirePlumber), and T3 still needs its own Wayland client for input.
- **wf-recorder and wl-screenrec:** each is a whole recorder. wf-recorder reads only the deprecated `wlr-screencopy` and has no keyframe control. wl-screenrec encodes only through VA-API, so it can't use NVENC.

**The deciding reason is that T3 needs its own Wayland client on the hidden display anyway** (#3: virtual pointer and keyboard, relative motion during grabs). Adding capture to that client costs about one protocol's worth of code. It keeps labwc's normal floating windows, keeps capture driven by screen changes, and leaves the encoder (#4) unchanged.

**What spike #17 should verify:** see the last section.

## Comparison

| | **(a) T3 helper on labwc** (pick) | (b) `waylanddisplaysrc` | (c) gamescope PipeWire | (d) xdg-desktop-portal-wlr |
|---|---|---|---|---|
| Who is the compositor | labwc (#2) | gst-wayland-display's own Smithay compositor | gamescope | labwc (portal reads its capture protocol) |
| Code T3 writes for capture | ~1–2.5k lines (Rust or C) | none | none | portal D-Bus negotiation (~hundreds of lines) |
| Capture only when the screen changes | yes: the protocol waits for damage and reports damage rectangles | no: renders a frame every frame interval | depends on gamescope | yes, via the same protocol, plus `max_fps` |
| Zero-copy on AMD/Intel | DMABuf → `vapostproc` → `vah264enc` | DMABuf, or NV12 DMABuf made by its own Vulkan shader | DMABuf via `pipewiresrc` | DMABuf via `pipewiresrc` |
| Zero-copy on NVIDIA | DMABuf → `glupload` → NVENC (GLMemory) | CUDAMemory (`cuda` build feature) or DMABuf → `glupload` | DMABuf or memfd | DMABuf or memfd |
| Input from T3 | T3's own `wlr-virtual-pointer` and `virtual-keyboard` client (needed for #3 anyway) | built in: upstream events for absolute and relative motion, buttons, keys, scroll and touch, or uinput devices through libinput | none | still needs T3's own client |
| `pointer-constraints` / `relative-pointer` | yes / yes | yes / yes | yes / yes | yes / yes (labwc) |
| Blender's extra windows | float above the main window | each forced fullscreen over the last | one focused window | float (labwc) |
| Distro packages | labwc: Debian 13+, Ubuntu 24.04+, Fedora, Arch (#2) | none | gamescope: most distros | xdpw: most distros |
| Licence | T3's own; labwc GPL-2.0 runs as a separate process | MIT | BSD-2-Clause | MIT |
| Extra processes | labwc + the helper | the helper alone (it is the compositor) | gamescope + PipeWire | labwc + D-Bus + xdg-desktop-portal + xdpw + PipeWire + WirePlumber + the helper |

## (a) A T3-owned capture client on labwc

### What labwc offers

- labwc creates `wlr_export_dmabuf_manager_v1`, `wlr_screencopy_manager_v1`, `wlr_ext_image_copy_capture_manager_v1`, `wlr_ext_output_image_capture_source_manager_v1` and the foreign-toplevel capture source manager ([src/server.c@7541ba3 L754-L760](https://github.com/labwc/labwc/blob/7541ba315b023088dd92eb19d5bd9ea9fb1cad07/src/server.c#L754-L760)). It also creates `relative-pointer` and `pointer-constraints` ([L783-L785](https://github.com/labwc/labwc/blob/7541ba315b023088dd92eb19d5bd9ea9fb1cad07/src/server.c#L783-L785)).
- `ext-image-copy-capture` arrived in labwc 0.9.0 (2025-07-11, [#2740](https://github.com/labwc/labwc/pull/2740); [NEWS.md](https://github.com/labwc/labwc/blob/7541ba315b023088dd92eb19d5bd9ea9fb1cad07/NEWS.md)). Per-window capture ("toplevel capture") arrived in 0.20.0, but only partly: xdg child-window positioning, subsurfaces and popups are not yet implemented ([NEWS.md, 0.20.0 "Added"](https://github.com/labwc/labwc/blob/7541ba315b023088dd92eb19d5bd9ea9fb1cad07/NEWS.md)). Capture the **output**, not Blender's window.
- On labwc older than 0.9 (Ubuntu 24.04 ships 0.7.1, see #2), only `wlr-screencopy` is available. The helper can fall back to it. wayvnc does this and prefers ext-image-copy-capture when both exist (`capture-encode.md`, §3).

### What the protocol gives

From the [ext-image-copy-capture-v1 spec](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/staging/ext-image-copy-capture/ext-image-copy-capture-v1.xml) ([rendered](https://wayland.app/protocols/ext-image-copy-capture-v1)):

- A session sends its buffer constraints: SHM formats, a `dmabuf_device` (the GPU to allocate on), DMABuf formats with modifiers, and a `buffer_size`.
- Each frame reports `transform`, `damage` and `presentation_time`, then `ready`.
- After the first frame, "the compositor may wait an indefinite amount of time for the source content to change" before it copies. **Capture follows screen changes for free**, which is the behaviour #4 asked for.
- `paint_cursors` composites the cursor into the frame. A separate cursor session can capture the cursor on its own instead.

### What T3 builds, and in what

- **Loop:** create a session on labwc's output, then allocate a small pool (2–3 buffers) on the advertised device with GBM. Use the first advertised format and modifier that the encoder also accepts. Then loop: attach, capture, wait for `ready`, wrap the buffer as a `GstBuffer` with `GstDmaBufMemory`, and push it into `appsrc` with DRM caps (`video/x-raw(memory:DMABuf),format=DMA_DRM,drm-format=…`). Damage rectangles can travel as metadata or be ignored. See [GStreamer's DMABuf design doc](https://gstreamer.freedesktop.org/documentation/additional/design/dmabuf.html) for DRM-format caps.
- **Encoder paths:**
  - **AMD/Intel:** DMABuf → `vapostproc` (converts RGB to NV12 on the GPU) → `vah264enc`, as #4 found.
  - **NVIDIA:** DMABuf → `glupload` → `glcolorconvert` → `nvh264enc`. The local GStreamer 1.28.9 `nvh264enc` accepts `memory:GLMemory`, and `glupload` accepts `memory:DMABuf` (`gst-inspect-1.0 nvh264enc`, `gst-inspect-1.0 glupload`). gst-wayland-display's README gives this same NVIDIA pipeline ([README](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/README.md#zero-copy-pipeline-support)).
  - **Software fallback:** SHM buffers → `x264enc`/`openh264enc`.
- **No ready-made source exists.** GStreamer has no element for either capture protocol. The Wayland plugin in GStreamer core holds only `waylandsink` ([subprojects/gst-plugins-bad/ext/wayland](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/tree/main/subprojects/gst-plugins-bad/ext/wayland)). gst-plugins-rs's video plugins have none either ([video/](https://gitlab.freedesktop.org/gstreamer/gst-plugins-rs/-/tree/main/video)). The local 1.28.9 install lists only `pipewiresrc` and `ximagesrc` as screen sources.
- **Rust coverage:**
  - `wayland-protocols` has `ext::image_capture_source` and `ext::image_copy_capture` behind the `staging` feature ([src/ext.rs](https://github.com/Smithay/wayland-rs/blob/master/wayland-protocols/src/ext.rs)).
  - `wayland-protocols-wlr` has `screencopy`, `export_dmabuf` and `virtual_pointer` ([src/lib.rs](https://github.com/Smithay/wayland-rs/blob/master/wayland-protocols-wlr/src/lib.rs)).
  - `wayland-protocols-misc` has `virtual-keyboard-unstable-v1` ([protocols/](https://github.com/Smithay/wayland-rs/tree/master/wayland-protocols-misc/protocols)).
  - All MIT.
  - GStreamer's Rust bindings (`gstreamer-app`, `gstreamer-allocators`) cover `appsrc` and the DMABuf allocator.
- **Size, using wayvnc (ISC) as the C reference:**
  - `src/ext-image-copy-capture.c`: 801 lines. This includes cursor sessions, which T3 may skip.
  - `src/buffer.c` (GBM and SHM buffers): 700 lines.
  - `src/screencopy-interface.c` (picks a protocol): 76 lines.

  Line counts are from `master` @ [`54a775f`](https://github.com/any1/wayvnc/tree/54a775f88036a8764756dde3818177af94fe3e0c/src). A Rust helper that does capture, buffers, the `appsrc` glue, the encoder fallback chain from #4, the input client from #3, and a stdin/stdout control channel (keyframe, bitrate, pause, resize) is roughly **1.5–2.5k lines**. This is an estimate, not a measurement.
- **Shipping:** T3 has no Rust or C build today; its only native code is in the mobile app. The precedent for a native dependency is `DeviceToolchain`: it installs a pinned npm package on demand into `tools/<name>/<version>` with an install-complete sentinel ([apps/server/src/device/DeviceToolchain.ts L71-L75](https://github.com/nonspacial/t3code-nonspaced/blob/main/apps/server/src/device/DeviceToolchain.ts#L71-L75), [deviceToolVersions.json](https://github.com/nonspacial/t3code-nonspaced/blob/main/apps/server/src/device/deviceToolVersions.json)).
  - A per-architecture prebuilt helper (x86_64 and aarch64 Linux) that links the system `libgstreamer-1.0` and `libwayland-client` dynamically would follow that pattern.
  - GStreamer has to come from the system anyway, because encoders load the vendor drivers at runtime.
  - The minimum version is GStreamer 1.24, for DRM-format DMABuf caps.

### Costs and risks of (a)

- **T3 owns a native binary**, with CI for two architectures. Upstream maintainers will weigh this. It is the same cost #3 already implies for the input client.
- **NVIDIA DMABuf import** through EGL into GL, then NVENC, is documented by gst-wayland-display and supported by the local `glupload`. That is not the same as proving it on a wlroots-allocated buffer with an NVIDIA modifier. This needs proving in #17.
- **Two protocol paths** (ext and wlr) if T3 supports labwc older than 0.9. Supporting only labwc 0.9 and later drops Ubuntu 24.04 (0.7.1) and Debian 12 (none) but keeps Debian 13 and later, Ubuntu 26.04 (0.9.3), Fedora and Arch (#2 table). Recommendation: ext-image-copy-capture only in v1, and report older labwc as "not available on this host".

## (b) `waylanddisplaysrc` (gst-wayland-display)

**What it is.** "A micro Wayland compositor that can be used as a Gstreamer plugin. Based on smithay" ([README](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/README.md)). It is MIT-licensed, created in 2023, and has 76 stars. The default branch is `stable`. It is actively developed: 15 commits from 2026-10-31 to 2026-11-17, mostly by two maintainers ([repo](https://github.com/games-on-whales/gst-wayland-display), [commits](https://github.com/games-on-whales/gst-wayland-display/commits/stable)). Wolf uses it (`capture-encode.md`).

**Maturity and packaging.**

- **No releases or tags** ([tags](https://github.com/games-on-whales/gst-wayland-display/tags)). The only install method is building it yourself with `cargo cinstall` ([README "Install"](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/README.md#install)).
- **No distro packages.** Repology knows no project of that name ([repology search "wayland-display"](https://repology.org/projects/?search=wayland-display) returns only `wayland-display-info`), and the AUR has nothing ([AUR RPC search "gst-wayland"](https://aur.archlinux.org/rpc/v5/search/gst-wayland?by=name) returns 0).
- **Build floor:**
  - It depends on a **pinned Smithay fork** (`games-on-whales/smithay` at one revision).
  - It needs **Rust 1.92**.
  - It requires `gstreamer-vulkan` with feature `v1_28`, which means GStreamer 1.28 or later at build time ([wayland-display-core/Cargo.toml](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/wayland-display-core/Cargo.toml)).
  - Its Vulkan-encode path also needs patches applied to GStreamer itself ([README "Vulkan encode"](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/README.md#vulkan-encode)).
  - A GStreamer plugin is tied to the GStreamer it was built against, so T3 would need one build per distro family.

**GPUs.** DMABuf output for AMD and Intel (into `vapostproc`/`vah264enc`). For NVIDIA, DMABuf → `glupload`, or `CUDAMemory` with the `cuda` build feature. It can also emit NV12 DMABufs from its own Vulkan compute shader, or Vulkan images ([README](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/README.md#zero-copy-pipeline-support)). This is good, cross-vendor and zero-copy.

**Input.** It has the best input story of the four options. The element accepts custom upstream GStreamer events:

- `MouseMoveAbsolute`, `MouseMoveRelative`, `MouseButton`, `MouseAxis`, `KeyboardKey`, and `Touch*`.
- It also accepts uinput devices announced by `VirtualDevicesReady`, which it opens through libinput.
- Standard GStreamer navigation events are also handled, but only mouse move, buttons and keys.

Sources: [imp.rs L307-L410](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/gst-plugin-wayland-display/src/waylandsrc/imp.rs#L307-L410), [L417-L465](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/gst-plugin-wayland-display/src/waylandsrc/imp.rs#L417-L465), and [lib.rs L274-L312](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/wayland-display-core/src/lib.rs#L274-L312).

Relative motion goes to `relative_pointer` clients ([input.rs ~L380-L450](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/wayland-display-core/src/comp/input.rs#L380-L450)). So no separate virtual-pointer client is needed.

Caveats:

- The keyboard uses `XkbConfig::default()` ([comp/mod.rs L452](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/wayland-display-core/src/comp/mod.rs#L452)). The layout therefore comes from `XKB_DEFAULT_*` environment variables for the whole process. #3 wants the layout to match the user.
- **Ctrl+Shift+Tab** (raise the last window) and **Ctrl+Shift+Q** (close the focused window) are intercepted in code, with no option to turn them off ([input.rs L191-L220](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/wayland-display-core/src/comp/input.rs#L191-L220)).

**Protocols.** `xdg-shell`, `pointer-constraints`, `relative-pointer`, `presentation-time`, `viewporter`, `tablet`, `data-device` (clipboard), `linux-dmabuf`, `drm-syncobj`, `single-pixel-buffer`, and colour management ([comp/mod.rs L308-L330](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/wayland-display-core/src/comp/mod.rs#L308-L330)). Blender's grab needs are met. The source has **no Xwayland, no `fractional-scale`, no `xdg-decoration` and no output management**. It resizes by renegotiating caps, which is a clean way to follow the pane size.

**Extra windows: the blocker.**

- `new_toplevel` queues every window ([xdg.rs L24-L27](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/wayland-display-core/src/wayland/handlers/xdg.rs#L24-L27)).
- Each one is then configured to the output size with state `Fullscreen` + `Activated` ([comp/mod.rs L946-L976](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/wayland-display-core/src/comp/mod.rs#L946-L976)).

Blender's Preferences and F12 render windows have no parent (#2), so each would cover the whole display. The user could only get back with Ctrl+Shift+Tab or by closing the window. That is cage's behaviour, which #2 marked as a regression against labwc's floating windows. Fixing it means patching a fast-moving fork.

**Frame pacing.** On each buffer request, the compositor waits until one frame interval has passed since the last render, then renders and returns a buffer ([comp/mod.rs L1087-L1118](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/wayland-display-core/src/comp/mod.rs#L1087-L1118)). It is a live source pulled at the negotiated frame rate ([imp.rs L873, L1905-L1940](https://github.com/games-on-whales/gst-wayland-display/blob/1c274e9b09d20487e2ba20c66d0bf1f1b75f9992/gst-plugin-wayland-display/src/waylandsrc/imp.rs#L1905-L1940)).

Whether damage occurred is used only for presentation feedback and is not put on the buffer. An idle Blender would therefore still cost a render, a colour conversion and an encode at 30–60 fps, unless T3 adds code downstream to compare frames. This suits Wolf's game streaming, which is always changing. It does not suit a mostly idle 3D editor, and it conflicts with T3's performance stance.

**Could it replace labwc?** Not without patches: fullscreen-only windows, intercepted keys, no Xwayland, and no packaging. If its window model ever gains floating top-level windows, it becomes the simplest stack: one process with no capture or input client. Worth re-checking later.

## (c) gamescope's PipeWire output

- The PipeWire node supports DMABuf and memfd buffers ([src/pipewire.cpp@7d957c5](https://github.com/ValveSoftware/gamescope/blob/7d957c518081c27e95b0f2d3501237abc62bf4f5/src/pipewire.cpp)). `pipewiresrc` reads it, as #4 showed on the 4090.
- **No virtual input.** gamescope's Wayland server creates `relative-pointer` and `pointer-constraints` ([src/wlserver.cpp L2474-L2480](https://github.com/ValveSoftware/gamescope/blob/7d957c518081c27e95b0f2d3501237abc62bf4f5/src/wlserver.cpp#L2474-L2480)), but no `virtual_pointer` or `virtual_keyboard` manager anywhere in that file (0 matches).
- **Exit crash is a known, open bug.** [gamescope#2516](https://github.com/ValveSoftware/gamescope/issues/2516) "Headless backend segfaults after bounded OpenGL primary child exits (3.16.31, NVIDIA)", opened 2026-10-23 and still open. This matches the crash in #1's evidence.
- It needs a running PipeWire (and usually WirePlumber) on the environment. It is BSD-2-Clause.

**Verdict:** rejected. There is no way to inject input, the shutdown is unreliable, and #2 already rejected it as the compositor.

## (d) Other options

- **xdg-desktop-portal-wlr ScreenCast → PipeWire → `pipewiresrc`.** xdpw reads both `wlr-screencopy` and ext-image-copy-capture ([src/screencast/ext_image_copy.c](https://github.com/emersion/xdg-desktop-portal-wlr/blob/8388b8a6214470462146840e92909aff5983eeac/src/screencast/ext_image_copy.c)). Its picker can be skipped with `chooser_type=none` and `output_name=` ([xdg-desktop-portal-wlr.5.scd](https://github.com/emersion/xdg-desktop-portal-wlr/blob/8388b8a6214470462146840e92909aff5983eeac/xdg-desktop-portal-wlr.5.scd)). It is actively released (v0.9.0 on 2026-11-12, [releases](https://github.com/emersion/xdg-desktop-portal-wlr/releases)).

  But it only works as a D-Bus service behind `xdg-desktop-portal`. Each hidden display would need its own session bus, the portal frontend, xdpw, PipeWire and WirePlumber, all isolated from the user's real desktop portal, plus T3 code to drive the ScreenCast D-Bus handshake. On a remote headless server none of these daemons are usually running. T3 would still need its own Wayland client for input. More moving parts than (a), with no gain.
- **wf-recorder.** MIT. Ships only `wlr-screencopy-unstable-v1.xml` ([proto/](https://github.com/ammen99/wf-recorder/tree/master/proto)) and encodes with FFmpeg itself. It is a whole recorder, with no keyframe-on-demand and no control channel. It would replace #4's GStreamer helper rather than feed it.
- **wl-screenrec.** Apache-2.0, Rust. Supports both capture protocols, but "vaapi encode support" is its only hardware path ([README](https://github.com/russelltg/wl-screenrec)), so it has no NVENC. It is a good Rust reference for the DMABuf → VA-API path, not something to ship.
- **FFmpeg `kmsgrab`.** Needs a real KMS plane and `CAP_SYS_ADMIN` (`capture-encode.md`). Not usable on a headless backend.

## Impact on other tickets

- **#2 (compositor):** no change. labwc stays the pick. Its capture protocols (ext-image-copy-capture from 0.9, plus `wlr-screencopy` and `export-dmabuf`) are what (a) needs. The packaging floor effectively becomes **labwc 0.9 or later** if v1 uses ext-image-copy-capture only.
- **#3 (input):** the virtual-pointer and keyboard client and the capture client should be **one helper process**. That process holds one Wayland connection to labwc, owns the GStreamer pipeline, and takes input and control messages from the T3 server.
- **#4 (encode):** unchanged, except the pipeline's head is now `appsrc` (DMABuf DRM caps). The NVIDIA path goes through `glupload` (GLMemory into `nvh264enc`) rather than CUDAMemory.
- **#13 (detect and set up):** check for:
  - `labwc` 0.9 or later;
  - GStreamer 1.24 or later with `appsrc`;
  - at least one of `nvh264enc`, `vah264enc`, `x264enc` or `openh264enc`;
  - `glupload` on NVIDIA;
  - a render node the user can access.

  Also install the prebuilt helper on demand, as `DeviceToolchain` does.
- **#12 (transport):** the helper emits damage-driven H.264 access units, so idle costs almost nothing. The "settle frame" rule from #4 still applies.

## What spike #17 should verify

1. **Damage pacing:** an ext-image-copy-capture session on `WLR_BACKENDS=headless labwc` returns no new frames while Blender is idle, and returns them at the expected rate while orbiting.
2. **NVIDIA zero-copy:** the session advertises a DMABuf device and modifiers that `glupload` imports on the RTX 4090 (proprietary driver), and `nvh264enc` encodes from GLMemory. Record GPU and CPU use against an SHM copy.
3. **AMD/Intel:** the same with `vapostproc ! vah264enc` on one AMD or Intel machine if one is available. Otherwise record it as unverified.
4. **One process for input and capture:** a single Wayland connection both captures and drives `wlr-virtual-pointer` and `virtual-keyboard`. During a G/R/S grab, relative motion moves the object past the window edge (the original #17 question).
5. **Extra windows:** opening Preferences and F12 while capturing the output shows them floating over the main window, and closing them returns the view.
6. **Resize:** changing the headless output mode (`wlr-output-management`, or restarting labwc at the new size) gives a new `buffer_size` on the session, and the encoder renegotiates without restarting the helper.
7. Optional: build `waylanddisplaysrc` once on the same machine to measure idle cost and check the fullscreen-window behaviour first-hand, so the runner-up verdict rests on observation as well as source.
