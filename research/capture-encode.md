# Which frame capture and encoding stack works across GPUs?

Research for nonspacial/t3code-nonspaced#4 (map: #1, feeds #12). Researched 2026-11-23 on Arch Linux, NVIDIA RTX 4090, GStreamer 1.28.9, FFmpeg 9.1, cage 0.3.1 (wlroots 0.20), wayvnc 0.10.2 / neatvnc 1.0.3.

## Answer

Use **H.264, 8-bit 4:2:0, no B-frames, Annex B access units**. Every client can decode it with WebCodecs, which T3's device stream already does. Encode with **GStreamer**, trying encoders in a fixed order and keeping the first one that starts:

1. **NVIDIA:** `nvh264enc`, fed CUDA or GL memory.
2. **AMD and Intel:** `vah264enc` (or `vah264lpenc`), fed DMABuf or VA memory.
3. **No usable hardware encoder:** `x264enc tune=zerolatency`, then `openh264enc` as a last resort.

Games-on-Whales' Wolf ships this same ordered list, and Sunshine ships the same vendor split.

**Capture should follow damage.** Copy a frame only when the screen changed, cap the rate at 30–60 fps, and send nothing while Blender sits idle. Keep the buffers on the GPU (DMABuf) where the vendor path allows it. Two cases need extra frames:

- When motion stops, send one or two "settle" frames of the final image, because the frames sent during motion were soft.
- When a viewer joins, send a keyframe on demand.

**Run encoding in a separate helper process, not inside Node.** T3 already works this way for the device hub, which is a separate process T3 proxies. A plain `gst-launch-1.0` command works for a prototype. The shipped version needs a small helper that links GStreamer as a library, so the server can ask for keyframes, change bitrate and pause the stream.

**The capture protocol depends on the compositor chosen for the hidden display:**

| Compositor | How frames come out | Notes |
| --- | --- | --- |
| gamescope | PipeWire into `pipewiresrc` | Already proven on the 4090 |
| cage | Only `wlr-screencopy` v3, which is deprecated | Needs a custom wayvnc-style capture client; GStreamer and FFmpeg have no source for it |
| `waylanddisplaysrc` | The compositor *is* a GStreamer source, emitting DMABuf, CUDA or system memory | Worth adding to the compositor ticket |

**Keeping text sharp:**

- Stream at the pane's real pixel size, so nothing gets rescaled.
- Use settle frames after motion.
- Do not rely on 4:4:4 chroma. NVENC can encode it, but VA-API on AMD and Intel cannot, and browser or phone decoding of it is unproven.

## 1. How T3 streams frames today

T3 has two frame paths. In both, the T3 server mostly relays bytes. Clients render the stream with code in `packages/client-runtime`, and mobile runs that same code inside a WebView.

### Device stream (simulators and emulators)

- **Producer:** the device hub, which is the `expo-device-hub` npm package pinned in `apps/server/src/device/deviceToolVersions.json` and installed by `apps/server/src/device/DeviceToolchain.ts`. It runs serve-sim for iOS and serve-emu for Android. T3 does not encode anything itself. `apps/server/src/device/DeviceHubProxy.ts` forwards an allow-list of hub paths over HTTP and WebSocket:
  - `stream.mjpeg`
  - `stream.avcc`
  - `webrtc/offer|close`
  - `/vendor/serve-emu/ws`

  For long-lived MJPEG and AVCC bodies it streams the response through without buffering or compression (`HttpServerResponse.stream`).
- **iOS (serve-sim):** the client tries transports in order. First it fetches `stream.avcc`, which is a length-prefixed, tagged stream:
  - `1` = description (codec setup)
  - `2` = keyframe
  - `3` = delta
  - `4` = a JPEG "seed" frame painted before the first keyframe decodes
  - `7` = end

  It decodes this with `VideoDecoder`, configured with `optimizeForLatency: true`. If that fails, it falls back to MJPEG in an `<img>`, then to WebRTC H.264, where it orders H.264 first in the codec list. Sources: `packages/client-runtime/src/device/stream.ts`, `AvccDemuxer` around lines 264–310, `configureDecoder` around lines 643–668, `switchToWebRtc` around lines 1083–1100, and the codec ordering around lines 999–1004.
- **Android (serve-emu):** raw H.264 Annex B access units arrive over a WebSocket. Each one is wrapped in a 16-byte "SEMU" header (magic, version, key flag, 64-bit pts), defined by `parseSemuPacket` in `stream.ts` around lines 207–225. The client reads the SPS from the bitstream to build the codec string (`scanAccessUnit` and `avcCodecString`). When the queue backs up (`SOFT_DECODE_QUEUE = 8`), it asks for a new keyframe with a `reset-video` message.
- **Rendering:** decoded frames are painted onto a 2D canvas (`packages/client-runtime/src/device/frame.ts`). Mobile loads this same client inside a WebView (`apps/mobile/src/features/devices/device-stream.browser.ts`).
- **A lesson already in the code:** the hub only writes an MJPEG part when the screen changes, and browsers paint a part only after the next one starts. So T3 re-sends the last part after 100 ms of quiet, or the final frame of a change never shows (`apps/server/src/device/mjpegStillFrame.ts`). A damage-driven H.264 stream has the same trap, covered in section 5.

### Browser-preview stream (the server-side Chromium tab)

- **Producer:** Chromium's DevTools Protocol `Page.startScreencast` with `format: "jpeg"`, quality 70 by default (`apps/server/src/preview/ServerBrowser.ts` around lines 3269–3284, and `ServerBrowserStream.ts` line 33).
- **During motion:** after 4 frames within 300 ms, it restarts the screencast at a smaller scale and quality 50. When the page settles, it sends one sharp still frame (`ServerBrowser.ts` lines 112–114 and 3262–3266). This is the same "soft while moving, sharp when still" policy this report recommends for H.264.
- **Delivery:** one binary JPEG per WebSocket message on `/api/preview-stream/ws`, with compression disabled. Only one frame is in flight at a time. The viewer acknowledges each frame, only the newest pending frame is kept, older ones are released, and a viewer more than 8 MB behind is disconnected (`ServerBrowserStream.ts` lines 108–200). The stream pauses and resumes by stopping and restarting the screencast (`ServerBrowser.ts` lines 3309–3319).

**How the Blender stream fits:** the encoder's output, H.264 Annex B access units with keyframe flags and timestamps, is exactly what the Android/SEMU WebSocket path and the AVCC path already consume. Section 7 covers the plug-in points; the transport choice belongs to #12.

## 2. Capture protocols

| Option | What it is | Damage-driven? | Zero-copy | Who offers it |
| --- | --- | --- | --- | --- |
| `ext-image-copy-capture-v1` with `ext-image-capture-source-v1` | Standard (staging) protocol. A session advertises buffer constraints: SHM formats, a DMABuf device, and DMABuf formats with modifiers. Each frame returns damage, transform and presentation time. | Yes. After the first frame, the compositor "may wait an indefinite amount of time for the source content to change" before copying. | Yes. The client allocates a DMABuf on the advertised device. | Sway, Hyprland, labwc, river, COSMIC, Mir and others. **Not Cage, not gamescope.** [wayland.app/protocols/ext-image-copy-capture-v1](https://wayland.app/protocols/ext-image-copy-capture-v1) |
| `wlr-screencopy-unstable-v1` | The older wlroots protocol. Its page says it is deprecated and points to ext-image-copy-capture. | Yes. `copy_with_damage` (v2+) "waits until the screen has changed" and reports damage rectangles. | Yes. v3 adds a `linux_dmabuf` buffer type. | **Cage (v3)**, Sway, Hyprland, labwc, niri and others; not gamescope. [wayland.app/protocols/wlr-screencopy-unstable-v1](https://wayland.app/protocols/wlr-screencopy-unstable-v1) |
| PipeWire video node | The compositor publishes a PipeWire stream, read with GStreamer `pipewiresrc`. | Depends on the compositor. `pipewiresrc` also has `keepalive-time`, which re-sends the last buffer periodically (local `gst-inspect-1.0 pipewiresrc`). | DMABuf, when negotiated | **gamescope** (headless), plus desktop portals |
| `waylanddisplaysrc` (gst-wayland-display) | A small Smithay-based Wayland compositor that *is* a GStreamer source element; clients connect to its socket. | The compositor and the encoder sit in one pipeline. | DMABuf; CUDA memory (with the `cuda` build feature); Vulkan images (GStreamer 1.28 plus patches); software rendering via `render_node=software` | MIT licence; used by Wolf. [github.com/games-on-whales/gst-wayland-display](https://github.com/games-on-whales/gst-wayland-display) |

What I checked locally:

- The installed `cage` binary only creates a `wlr_screencopy_manager_v1` (from `strings /usr/bin/cage`). `pacman -Qi cage` shows it built against `wlroots0.20`.
- wayvnc supports both protocols and prefers ext-image-copy-capture when the compositor has it (`wayvnc/src/screencopy-interface.c` lines 26–49).

**What this means:** if #2 (headless compositor) picks Cage, T3 needs its own capture client speaking `wlr-screencopy` v3, which is deprecated. It would need to move to ext-image-copy-capture when Cage gets it, as wayvnc already has. Neither GStreamer nor FFmpeg can capture `wlr-screencopy`. FFmpeg's `kmsgrab` needs a real KMS plane and `CAP_SYS_ADMIN`; Sunshine documents the capability requirement for its `kms` capture ([Sunshine configuration](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html)). gamescope's PipeWire node and `waylanddisplaysrc` both avoid writing any capture code.

## 3. Encoders per GPU vendor

| Vendor | First choice | Input path | Fallbacks | Evidence |
| --- | --- | --- | --- | --- |
| NVIDIA (proprietary) | `nvh264enc` (GStreamer nvcodec), or FFmpeg `h264_nvenc` | `nvh264enc` accepts `memory:CUDAMemory`, `memory:GLMemory` or system memory, in NV12, Y444, BGRx and others (local `gst-inspect-1.0 nvh264enc`). GL-memory input was added in 1.24 ([1.24 notes](https://gstreamer.freedesktop.org/releases/1.24/)). DMABuf gets there through `glupload` (EGL import, accepts `memory:DMABuf` `DMA_DRM`) and then CUDA/GL interop, or through `cudaupload`. | `vulkanh264enc` (new in 1.28); x264 | VA-API has no encode path on NVIDIA. nvidia-vaapi-driver says "Hardware decoding only, encoding is not supported" ([README](https://github.com/elFarto/nvidia-vaapi-driver)). Sunshine's NVIDIA path imports DMABuf planes into GL and then CUDA by hand (`src/platform/linux/cuda.cpp`, around lines 679–886 in [LizardByte/Sunshine](https://github.com/LizardByte/Sunshine)). |
| AMD (Mesa radeonsi) | `vah264enc` (GStreamer `va`), or FFmpeg `h264_vaapi` | All `va` elements negotiate `DMA_DRM` DMABuf caps with explicit modifiers ([1.24 notes](https://gstreamer.freedesktop.org/releases/1.24/)). `vapostproc` converts RGB to NV12 on the GPU ([vapostproc docs](https://gstreamer.freedesktop.org/documentation/va/vapostproc.html)). | `vah264lpenc`; x264 | neatvnc maps DRM PRIME DMABufs straight into VA-API: `hwmap=mode=direct:derive_device=vaapi,scale_vaapi=format=nv12`, then `h264_vaapi` (`neatvnc/src/enc/h264/ffmpeg-impl.c` lines 284–289 and 394–418). |
| Intel (iHD / Mesa) | `vah264enc` / `vah264lpenc` | Same as AMD | `qsvh264enc`; x264 | Wolf orders `vah264enc`, then `vah264lpenc`, then `qsvh264enc` (see below) |
| No usable encoder | `x264enc tune=zerolatency speed-preset=superfast bframes=0` | System memory | `openh264enc` (constrained baseline only) | Sunshine's software default is `superfast` + `zerolatency` ([Sunshine configuration](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html)) |

**Vulkan Video** would give one API across all three vendors, but it is not ready to be the baseline:

- GStreamer's `vulkanh264enc` only arrived in 1.28 and accepts only `memory:VulkanImage` NV12 ([docs](https://gstreamer.freedesktop.org/documentation/vulkan/vulkanh264enc.html), [1.28 notes](https://gstreamer.freedesktop.org/releases/1.28/)).
- FFmpeg added Vulkan H.264/HEVC encoding in 7.1 and AV1 in 8.0 ([ffmpeg.org news](https://ffmpeg.org/index.html)).
- Mesa support is uneven. RADV encoding was opt-in when it landed ([Phoronix](https://Phoronix.com/news/RADV-Vulkan-VIdeo-H265-H264)), Mesa 26.0 lists a RADV H.264 corruption issue ([26.0.0 notes](https://docs.mesa3d.org/relnotes/26.0.0.html)), and ANV encoding was disabled on newer Intel GPUs for a while. I could not confirm the default state of encoding in current Mesa from Mesa's own notes.
- Sunshine does ship a Vulkan encoder: "DMA-BUF -> Vulkan compute (RGB->YUV) -> Vulkan Video encode" (`src/platform/linux/vulkan_encode.cpp`).

Treat Vulkan as a later improvement, not the fallback.

**Real-world ordered lists:**

- **Wolf** tries H.264 encoders in this order and keeps "the first one that's not failing", probing with `check_elements` (`src/moonlight-server/state/default/config.include.toml` on the `stable` branch of [games-on-whales/wolf](https://github.com/games-on-whales/wolf)):
  1. `nvh264enc preset=low-latency-hq zerolatency=true rc-mode=cbr-ld-hq`, behind `cudaupload ! cudaconvertscale`
  2. `vah264enc b-frames=0 ref-frames=1 rate-control=cbr target-usage=6`, behind `vapostproc`
  3. `vah264lpenc`
  4. `qsvh264enc`
  5. `x264enc tune=zerolatency speed-preset=superfast bframes=0 sliced-threads=true`

  The `*_zero_copy` variants keep frames in CUDA or VA memory the whole way.
- **Sunshine's** encoder options are `nvenc`, `quicksync`, `amdvce`, `vaapi` ("for AMD and Intel"), `vulkan` and `software` ([configuration](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html)).
- **neatvnc** only uses H.264 for GPU (GBM) buffers ("h264 is useless for sw frames", `neatvnc/src/server.c` lines 3002–3009). Its backends are VA-API and V4L2 M2M only, with no NVENC and no software encoder (`neatvnc/src/enc/h264/encoder.c`, `meson.build`). So wayvnc is **not** a cross-vendor H.264 solution. It is a useful reference for capture and for the VA-API path.

**On this machine** (NVIDIA): FFmpeg lists `h264_nvenc`, `h264_vaapi`, `h264_vulkan`, `h264_qsv`, `h264_amf`, `libx264` and the HEVC/AV1 equivalents. GStreamer has `nvh264enc`, `vulkanh264enc`, `x264enc` and `openh264enc`. GStreamer's `va` plugin is not installed: `gst-inspect-1.0 va` gives "No such element". So packaging varies even within one distro, and the helper must probe at runtime rather than assume.

## 4. Codec choice and text sharpness

- **H.264 4:2:0 is the only codec every client decodes.**
  - `VideoDecoder` is supported in Chrome 94+, Firefox 130+ (desktop) and Safari 16.4+. Firefox for Android has none ([MDN browser-compat-data `api/VideoDecoder.json`](https://github.com/mdn/browser-compat-data/blob/main/api/VideoDecoder.json)).
  - Electron is Chromium.
  - The mobile app decodes inside a WebView, as the device stream does today.
  - HEVC and AV1 decode support varies with hardware, especially on iOS. They would also need a second encoder matrix.
- **4:4:4 chroma:** `nvh264enc` advertises `profile=high-4:4:4` and Y444 input (local `gst-inspect-1.0`). AMD and Intel VA-API H.264 encoders take NV12 only ([vah264enc docs](https://gstreamer.freedesktop.org/documentation/va/vah264enc.html)). I found no source confirming browser decoding of H.264 High 4:4:4. There is a WPT test (`webcodecs/videoDecoder-444-h264.https.any.js`), but whether it passes is unknown, and phone hardware decoders generally lack the profile. **Do not depend on 4:4:4.** If it is tried later, gate it on NVIDIA plus `VideoDecoder.isConfigSupported({codec: "avc1.F4…"})`.
- **What actually keeps text sharp:**
  1. **Don't rescale.** Size the hidden display to the pane's CSS size times `devicePixelRatio`. Scaling a 1080p stream into a different pane size blurs text more than chroma subsampling does. This affects the compositor and pane-resize tickets.
  2. **Settle frames.** Encode one or two more frames of the unchanged image about 100–200 ms after the last damage. With CBR, or with a quality floor (`min-qp`), each extra P-frame cleans up the residual left from frames sent during motion. The server already uses this idea for the browser preview (a still frame after motion) and for MJPEG (re-sending the last part).
  3. **No B-frames, no lookahead.** neatvnc: "B-frames are bad for latency", `max_b_frames = 0`, `async_depth = 1`, manual keyframes with `gop_size = INT32_MAX` (`ffmpeg-impl.c` lines 324–326 and 418).
  4. Blender's interface is mostly grey text on grey, which is luma detail, so 4:2:0 hurts it less than it hurts coloured text.
- **The gamescope measurement** (about 24 fps and 1.2 Mbps for an almost static Blender interface) shows that frames kept coming without changes on screen. With damage-driven capture, an idle Blender should cost close to 0 bytes per second.

## 5. Damage-driven frame rate and latency

- **Capture loop:** ask for the next frame with `copy_with_damage` (wlr) or a capture on an ext-image-copy-capture session. Both block until something changes. Cap the rate with a timer the way wayvnc does: default 30 fps (`--max-fps`), with the capture limiter at `max_rate * 2` (`wayvnc/src/main.c` around lines 2193 and 2563; `wayvnc/src/screencopy.c` lines 293–315).
- **Encoders must not hold frames back.** With sparse frames, an encoder or decoder that keeps one frame in reserve hides the *last* change until the next damage arrives. This is the H.264 version of the MJPEG still-frame trap above. Use zero-latency or low-delay modes (`nvh264enc zerolatency=true`, `x264enc tune=zerolatency`, VA with `b-frames=0`, `async_depth=1`) and keep WebCodecs' `optimizeForLatency: true` (already set in `stream.ts`). Verify with a test that sends one change and then goes idle.
- **Keyframes:** use an endless GOP plus a keyframe on demand when a viewer joins, when a decoder resets, or after frames are dropped for backpressure. This is how the Android path's `reset-video` works and how neatvnc picks keyframes by hand. A bare `gst-launch-1.0` cannot take a force-key-unit request from outside, which is one reason the shipped helper should link GStreamer as a library.
- **Latency budget:**
  - Hardware encoders take a few milliseconds per 1080p frame.
  - `x264 superfast/zerolatency` with sliced threads is usable at 1080p30 but uses real CPU cores while Blender is moving. Idle costs nothing.
  - Copying a 1080p BGRx frame through system memory (8 MB) costs roughly 250 MB/s of memory traffic at 30 fps. This is fine for software encoding, but avoidable on GPU paths with DMABuf.

## 6. Library or subprocess

- **Node bindings:** there are no maintained GStreamer bindings for Node, and libavcodec bindings would mean a native addon in the Electron and `t3` builds. That cuts against T3's portable server.
- **T3's existing pattern:** the device hub is an npm-installed tool that T3 starts and proxies. It is not linked into the server (`DeviceToolchain.ts`, `DeviceHubProxy.ts`).
- **Recommendation:** a **helper subprocess** that owns capture (or the compositor, if `waylanddisplaysrc` is chosen) and encoding. It sends access units on stdout or a local socket and takes control messages on stdin: keyframe, bitrate, pause, resize.
  - **Prototype:** `gst-launch-1.0` with a fixed pipeline, for example `pipewiresrc ! … ! nvh264enc zerolatency=true ! h264parse ! video/x-h264,stream-format=byte-stream,alignment=au ! fdsink`.
  - **Shipped:** a small program using GStreamer as a library, written in C or with gstreamer-rs. It probes for encoders like Wolf's `check_elements`.
- **Licences:** T3 should rely on the system's GStreamer and plugins and not bundle them:
  - GStreamer core and plugin sets are LGPL-2.1+
  - x264 is GPL-2.0
  - openh264 is BSD-2
  - Arch's FFmpeg build is GPL-3.0

  (from `pacman -Qi`). A missing encoder should show up as a setup error, the way the browser preview reports `hostSetup`.

## 7. Plugging into T3

- **Producer side:** add a new Effect service that supervises the helper. It is shaped like `DeviceService` / `DeviceHubProxy`, but it is a stream T3 owns rather than a proxied third party.
- **Wire format:** pass through the helper's access units with a small header (key flag and pts), as the SEMU packet does.
  - Over WebSocket, the client can reuse the Android decode path: `parseSemuPacket`, `scanAccessUnit` for the SPS, `configureDecoder`, and the canvas sink.
  - Over HTTP streaming, it can reuse `AvccDemuxer`, including the JPEG **seed** frame for an instant first paint.
  - Over WebRTC, the same access units go into an RTP H.264 payloader.

  #12 decides which of these.
- **Backpressure:** video cannot drop arbitrary frames the way the JPEG preview stream does. On a slow viewer, drop until the next keyframe and request one.
- **Pausing:** when the pane is hidden, stop capturing. That is free with damage-driven capture, because no requests means no frames.

## Open risks and things for other tickets

- **#2 (compositor):** Cage means writing a `wlr-screencopy` client, a deprecated protocol T3 must later move to ext-image-copy-capture. gamescope gives PipeWire for free. `waylanddisplaysrc` (compositor and source in one) is a strong third candidate and should be weighed there.
- **#2 / #15 — pane resize:** streaming at the pane's real pixel size needs the hidden display's output to resize live.
- **NVIDIA zero-copy:** DMABuf into NVENC goes through GL or CUDA interop. It works in GStreamer (`glupload` then GL memory into `nvh264enc`) but is the most fragile path. A copy through system memory is an acceptable v1 fallback.
- **Untested here:** VA-API encoding on real AMD and Intel hardware, and whether decoders release the last frame of a sparse stream promptly. Both need real tests before v1.
- **#13 (setup) — distro packaging:** the `va` plugin, `x264enc` and `openh264enc` ship in different packages, and some distros keep them in extra repositories. The helper needs a "doctor" probe.
