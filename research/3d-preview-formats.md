# What can the 3D file preview show without Blender, and at what cost?

Research for nonspacial/t3code-nonspaced#5 (feeds #9, "How does a .blend become a 3D preview?").
Researched 2026-11-23 against three.js r180 (the version pinned in `packages/client-runtime/package.json`), Blender `main` (5.3 era) on projects.blender.org, and a local Blender 5.3.0.

## Answer

- **Client-side formats.** three.js r180 can render GLB/glTF, STL, PLY, OBJ (+MTL), 3MF and FBX in the browser. Each loader is small next to three.js itself: three.js core plus `GLTFLoader` and `OrbitControls` comes to about **148 KB gzip**, and STL, PLY, OBJ, MTL, 3MF and FBX **all together add about 31 KB gzip** on top. Lazy-load all of it behind the 3D preview, as the device viewer already does. Leave out **USDZ** at r180: its binary (USDC) parser is an empty stub, so most real `.usdz` files render as nothing. The parser landed in r183. Draco and KTX2 decoders are opt-in extras costing roughly 75 KB and 260 KB gzip, so add them only when a file needs them.
- **Single file vs sibling files.** Signed asset URLs grant **exactly one file**. Self-contained formats (GLB, STL, PLY, 3MF, binary FBX) work with one URL. glTF with a separate `.bin` or textures, and OBJ with MTL and textures, need the client to mint a URL for each sibling, through three's `LoadingManager.setURLModifier`. Without that they render untextured or fail.
- **.blend without Blender.** Reading a .blend in plain TypeScript is easy and cheap for the **embedded thumbnail** and the **scene/frame range** (both sit at the very start of the file), and for **counts of each datablock type** (objects, meshes, materials, …). **Names and mesh vertex/face counts** take moderate work, because you have to parse the SDNA type catalogue at the end of the file. I prototyped both in about 70 lines of JS against Blender 5.3 files. **Real geometry** is not realistic: the file stores only un-evaluated data (no modifiers, no geometry nodes), in layouts that change between versions. That part belongs to Blender (#9).
- **Thumbnails.** The thumbnail is a 128×128 RGBA block *inside the .blend*, so it works on every OS without any thumbnailer installed. It is **optional** (users can turn it off), and it **can be stale**: background or scripted saves carry the previous thumbnail forward. Blender's own `blender-thumbnailer` (Linux CLI) and its Windows and macOS siblings only read this same block.
- **Mobile.** The realistic path is the one the app already uses for the device stream: a Vite-built IIFE script injected into `react-native-webview` that runs the same three.js code. That costs about 150–180 KB gzip in the app bundle. expo-gl and three.js native (expo-three, react-three-fiber native) are not installed, expo-three is stale (pins three ^0.166), and three's loaders depend on browser image and blob APIs. A thumbnail-only fallback (server-extracted .blend PNG) works everywhere at no client cost.

## 1. Client-side formats with three.js r180

### Measured lazy-loaded cost

Measured with esbuild 0.25.10 (`--bundle --minify --format=esm`, then `gzip -9`) against `three@0.180.0` in a scratch directory (`.scratch/research/3d-measure/`). The base entry imports `WebGLRenderer`, `Scene`, `PerspectiveCamera`, lights, `Box3` and `OrbitControls`. Each loader row is the delta over "base + GLTFLoader".

| Bundle | min | gzip | Δ gzip vs base+GLTF |
| --- | ---: | ---: | ---: |
| three core + OrbitControls (minimal viewer) | 507 KB | 126.3 KB | — |
| + GLTFLoader | 588 KB | 148.2 KB | (+21.9 KB over core) |
| + STLLoader | | | +1.1 KB |
| + MTLLoader | | | +1.5 KB |
| + DRACOLoader (JS shim only) | | | +2.1 KB |
| + PLYLoader | | | +2.2 KB |
| + OBJLoader | | | +2.7 KB |
| + USDLoader (includes fflate) | | | +5.1 KB |
| + MeshoptDecoder | | | +5.9 KB |
| + 3MFLoader (includes fflate) | | | +7.1 KB |
| + ColladaLoader | | | +11.7 KB |
| + FBXLoader (includes fflate, NURBS) | | | +19.1 KB |
| + KTX2Loader (JS incl. zstddec) | | | +23.6 KB |
| **+ OBJ, MTL, STL, PLY, FBX, 3MF together** | 686 KB | 179.0 KB | **+30.8 KB** |

Decoder payloads that load at runtime (from `three/examples/jsm/libs`, raw → gzip):
- Draco: `draco_decoder.wasm` 192 KB → 63 KB, plus `draco_wasm_wrapper.js` 58 KB → 12 KB.
- Basis (needed by KTX2): `basis_transcoder.wasm` 527 KB → 245 KB, plus `basis_transcoder.js` 58 KB → 15 KB.

fflate is shared by FBX, 3MF and USD, so bundling them together costs less than the sum of their rows.

How the repo already does it: three.js is only in `packages/client-runtime`, and the web app loads the device viewer through a dynamic import (`apps/web/src/components/device/DeviceDuoViewport.tsx`: `import("@t3tools/client-runtime/device/duo-viewer")`). `packages/client-runtime/src/device/modelScene.ts` already uses `GLTFLoader` and has a `disposeDeviceModel` helper for freeing geometry, materials and textures. A model-preview chunk that imports `three` lets Vite share the core chunk with the device viewer.

### What each loader handles (r180 source)

All under https://github.com/mrdoob/three.js/tree/r180/examples/jsm/loaders

- **GLTFLoader**: glTF 2.0, JSON or binary GLB. It uses `ImageBitmapLoader` where `createImageBitmap` exists, with Safari <17 and Firefox <98 falling back (`GLTFLoader.js` lines ~2655–2682). Embedded images are decoded through `URL.createObjectURL(blob)` (~line 3390). Draco, Meshopt and KTX2 extensions only work if the caller wires up those decoders.
- **STLLoader**: binary and ASCII. It returns a non-indexed `BufferGeometry` with no materials (header comment, lines 13–26).
- **PLYLoader**: ASCII and binary PLY, giving geometry and vertex colours.
- **OBJLoader / MTLLoader**: plain text. Materials and textures need the MTL file and image files next to the OBJ.
- **3MFLoader**: meshes, components and base materials, and partly the materials extension: Texture 2D, colour groups, metallic PBR (header comment, lines 27–41). The file is a zip unpacked with fflate.
- **FBXLoader**: rejects files with FBX `FileVersion` < 7000 (line 161–163). It warns on and drops layered textures, some map types and orthographic cameras (lines 358, 726, 743, 1138).
- **USDLoader / USDZLoader**: `USDZLoader` is deprecated in r179 and now just wraps `USDLoader` (`USDZLoader.js`). **In r180 `usd/USDCParser.js` is a 17-line stub whose `parse()` returns an empty `Group` with `// TODO`**, so only text (USDA) content renders. The crate parser shipped in r183 (`usd/USDCParser.js` is 1,852 lines at the `r183` tag and 1,878 at `r184`). npm `three` latest is 0.187.0.

### Constraints from the T3 Code side

- **One URL, one file.** "Signed asset URLs are bearer credentials for a single canonical file … They never grant access to sibling files" (`docs/internals/04_environment-auth.md`, lines 70–73). `AttachmentFilePreview.tsx` fetches one asset URL per previewed file. Multi-file models therefore need a sibling-resolution step (mint URLs for `foo.bin`, `foo.mtl` and textures relative to the model's path, and map them in `LoadingManager.setURLModifier`), or the preview has to say "textures not loaded".
- **Rendering policy.** AGENTS.md forbids continuously repainting animations. The viewer should render on demand, on OrbitControls `change` and on resize, not in a `requestAnimationFrame` loop. Parsing runs on the main thread, so a size cap with an "open externally" fallback is prudent for very large STL/OBJ files.

## 2. Reading a .blend in TypeScript

### File layout (Blender source)

- **Compression.** A .blend starts with `BLENDER` (uncompressed), the gzip magic (Blender < 3.0), or the zstd magic. See `BLO_file_reader_uncompressed` in [`source/blender/blenloader_core/intern/blo_core_file_reader.cc`](https://projects.blender.org/blender/blender/src/branch/main/source/blender/blenloader_core/intern/blo_core_file_reader.cc).
- **zstd layout.** Blender compresses at level 3 in independent frames of about 1 MB uncompressed (`ZSTD_CHUNK_SIZE (1 << 20)`, `ZSTD_COMPRESSION_LEVEL 3`). It appends a seek table in the upstream "seekable format" as a skippable frame at the end (`write_seekable_frames`). Both are in [`source/blender/blenloader/intern/writefile.cc`](https://projects.blender.org/blender/blender/src/branch/main/source/blender/blenloader/intern/writefile.cc) (lines ~167–170, ~294–415).
- **File header, two variants.** Defined in [`BLO_core_blend_header.hh`](https://projects.blender.org/blender/blender/src/branch/main/source/blender/blenloader_core/BLO_core_blend_header.hh) and decoded in [`blo_core_blend_header.cc`](https://projects.blender.org/blender/blender/src/branch/main/source/blender/blenloader_core/intern/blo_core_blend_header.cc):
  - Legacy, 12 bytes: `BLENDER` + `-`/`_` (8- or 4-byte pointers) + `v`/`V` (endianness) + 3-digit version, for example `BLENDER-v405`.
  - Format 1, 17 bytes: `BLENDER` + `17` + `-` + `01` + `v` + 4-digit version, for example `BLENDER17-01v0503` (verified: the first bytes of a file saved by Blender 5.3 are `BLENDER17-01v0503`). This is what 5.x writes unless a developer option forces the legacy format (`get_blend_file_header` in `writefile.cc`).
- **Block headers.** Three variants: `BHead4` (20 bytes), `SmallBHead8` (24 bytes, 32-bit `len`), and `LargeBHead8` (32 bytes: `code`, `SDNAnr`, `uint64 old`, `int64 len`, `int64 nr`). Format 1 always uses `LargeBHead8`. See [`BLO_core_bhead.hh`](https://projects.blender.org/blender/blender/src/branch/main/source/blender/blenloader_core/BLO_core_bhead.hh) and [`blo_core_bhead.cc`](https://projects.blender.org/blender/blender/src/branch/main/source/blender/blenloader_core/intern/blo_core_bhead.cc).
- **Release notes.** The [Blender 5.0 core release notes](https://developer.blender.org/docs/release_notes/5.0/core/) say "The .blend file format has been changed to support larger buffers. … This change affects the structure of the file header as well as the header of each block … any code that is parsing .blend files has to be updated. Blender 4.5 LTS is able to load files stored in this new format, but older Blender versions are not." Data-block names went from 63 to 255 bytes (`ID.name` is `name[258]` in the 5.3 SDNA, verified).
- **Write order.** The header comes first, then `REND` blocks, then `TEST` (thumbnail), then `GLOB`, followed by a flush before any datablocks (`writefile.cc` lines ~1847–1854). The ID blocks come after that, then `DNA1` (the struct catalogue), then `ENDB`.

### What is cheap, what is not

| Fact | Where it lives | Cost in TS | Verified |
| --- | --- | --- | --- |
| Is it a .blend, which version, compressed? | first 7–17 bytes | trivial | yes |
| Scene name, start/end frame | `REND` block right after header (`RenderInfo {int sfra, efra; char scene_name[MAX_ID_NAME-2]}`, `writefile.cc` ~1205–1237; Blender's own reader [`scripts/modules/blend_render_info.py`](https://projects.blender.org/blender/blender/src/branch/main/scripts/modules/blend_render_info.py) handles 24/64/256-byte name sizes) | trivial | yes: `{sfra:1, efra:250, scene:"Scene"}` |
| Thumbnail | `TEST` block: `int width, int height`, then RGBA bytes, bottom-up (`write_thumb`, `writefile.cc` ~1618–1627; reader `blendthumb_extract.cc`) | trivial; needs a PNG encode or canvas `putImageData` | yes: 128×128, at byte offset 313 |
| Count of each datablock type (OB, ME, MA, CA, LA, IM, GR …) | `code` of every BHead | easy, but must walk the whole file (and decompress all of it) | yes: `OB:4, ME:2, MA:1, CA:1, LA:1 …` |
| Object/mesh/material names | `ID.name` at an offset given by SDNA | moderate: parse `DNA1` (names, types, lengths, structs) | yes, ~25 lines |
| Mesh vertex/face counts | `Mesh.totvert`, `Mesh.totpoly` (SDNA keeps legacy names, not `verts_num`) | moderate, as above | yes: `Sphere verts 482 faces 512` |
| Actual geometry | 5.x keeps attributes in a new `AttributeStorage`, alongside legacy `CustomData vdata/pdata…`; pointer fix-ups via `BHead.old` | **hard and version-fragile**; it is a mini Blender loader | not attempted |

Two caveats from the prototype:

1. **Data is un-evaluated.** The sphere in the test file has a Subdivision modifier, yet the mesh still reports its base 482 vertices. Modifiers, geometry nodes, instancing and curves-to-mesh are only computed by Blender at runtime, so a pure-TS geometry reader would show something different from what the user sees in Blender. This is the strongest reason to leave geometry to Blender (#9).
2. **Reading from a zstd .blend.** Only the first frame needs decompressing for header, REND and thumbnail. In the test file the first frame was 1,778 bytes compressed and 67,137 bytes uncompressed, and held the header, REND, TEST and GLOB, matching the flush after `write_global`. Counts and names need the whole file, because `DNA1` is written last. Decompress options:
   - On the server, Node's `zlib.zstdDecompressSync` works on Node 26 (verified). It is Experimental, added v23.8.0 / v22.15.0 ([Node zlib docs](https://nodejs.org/api/zlib.html#zstd-constants)), and the server's `engines` allows `^22.16`.
   - In the browser, `DecompressionStream("zstd")` is now in the spec ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream/DecompressionStream)), but support varies.
   - `fzstd` 0.1.1 (MIT) is 3.4 KB gzip (measured) and decoded Blender's seekable zstd output correctly (verified).

The prototype scripts are in `.scratch/research/blend-proto/read.mjs` (header, blocks, TEST, REND, counts, first-frame zstd) and `.scratch/research/blend-proto/sdna.mjs` (SDNA, names, mesh counts). Together they are about 70 lines.

**Recommendation for #9.** Do the .blend metadata read on the **server** (Node, streaming the head of the file, zstd built in) and return a small JSON summary plus a PNG thumbnail. Clients then pay nothing, mobile gets it for free, and the bytes over the wire are tiny (a 64 KB raw thumbnail becomes a few KB of PNG). Use Blender itself only to export geometry.

## 3. Thumbnail availability per OS

- **The thumbnail is in the file**, so reading it ourselves works on any OS, including servers without Blender. Blender's extractors all read the same `TEST` block:
  - Linux: `blender-thumbnailer <in.blend> <out.png>` CLI (`blender_thumbnailer.cc`).
  - Windows: `BlendThumb.dll`, an `IThumbnailProvider` shell extension (`blendthumb_win32.cc`).
  - macOS: a QuickLook thumbnail app extension `blender-thumbnailer.appex` (`thumbnail_provider.mm`).
  - All three are built from [`source/blender/blendthumb/CMakeLists.txt`](https://projects.blender.org/blender/blender/src/branch/main/source/blender/blendthumb/CMakeLists.txt). The extractor reads only the `REND` and `TEST` blocks at the start and gives up early otherwise (`blendthumb_extract.cc`).
- **Linux packaging.** On this machine `/usr/bin/blender-thumbnailer` comes from Arch's `blender 17:5.3.0-1` package. There is **no** `blender.thumbnailer` entry in `/usr/share/thumbnailers` and Blender's `release/freedesktop/` ships none, so desktop file-manager integration depends on the distro. That does not matter for T3 Code.
- **The thumbnail is optional.** With `Preferences › Save & Load › File Preview Type = None` (`U.file_preview_type == USER_FILE_PREVIEW_NONE`, `wm_files.cc` ~2250) no `TEST` block is written. Verified: `blender-thumbnailer` exits with code 6 (`BT_INVALID_THUMB`, `blendthumb.hh`). Files older than 2.50 never have one (`BT_EARLY_VERSION`).
- **The thumbnail can be stale.** Camera and screenshot thumbnails are not generated in background mode (`blend_file_thumb_from_camera` returns early on `G.background`, `wm_files.cc` ~2017). A save then reuses `bmain->blen_thumb`, the thumbnail of the file that was loaded (`wm_files.cc` ~2257–2262). Verified: a background save of a file containing only a monkey still carries the factory startup cube thumbnail. Agent-written .blend files (scripted, `blender -b`) will often have a missing or outdated thumbnail. The UI should label it "saved preview", and #9 should consider re-rendering one with Blender.
- **Size.** In-file thumbnails are `BLEN_THUMB_SIZE` = 128×128 (`wm_files.cc` ~2105). Blender's larger cache thumbnail is not in the file.

## 4. Mobile options

What's installed (`apps/mobile/package.json`): Expo 58, React Native 0.88.1, React 19.3, `react-native-webview` 14.0.1, `react-native-svg`, `expo-image`, `react-native-pdf-jsi`. **No `expo-gl`, `expo-three`, `three` or `@react-three/fiber`.**

1. **WebView running the shared three.js viewer (recommended if mobile gets 3D).** There is already a pattern for this. `apps/mobile/scripts/generate-device-stream.mts` builds `src/features/<feature>/*-stream.browser.ts` with Vite as a minified IIFE, writes it to `.generated/<stem>/index.js` as a string, and `device-stream-document.ts` injects it into an HTML document for `react-native-webview`. A model viewer could reuse `packages/client-runtime` three.js code unchanged. The cost is roughly 150–180 KB gzip (the measured three.js + loaders numbers) added to the app's JS bundle as a string, plus WebView start-up time. Current iOS WKWebView and Android System WebView expose WebGL, and GLTFLoader falls back from `createImageBitmap` to `TextureLoader` where needed (`GLTFLoader.js` ~2676), so the web code path applies; verify on device.
2. **expo-gl + three.js native.** [expo-gl](https://docs.expo.dev/versions/latest/sdk/gl-view/) gives a WebGL2-like context, but some methods are not implemented (`getUniform`, `getBufferSubData`, sync objects). Invalid arguments can crash the native app, and it does not work with remote debugging. Expo's docs point to `expo-three` for three.js, but npm `expo-three` 8.0.0 was last published 2024-07-28 with peer `three ^0.166.0`. `@react-three/fiber` 9.8.2 supports native via expo-gl (peers `react >=19 <19.4`, `expo-gl`, `expo-asset`, `expo-file-system`). Loaders also expect browser image and blob APIs (`ImageBitmapLoader`, `URL.createObjectURL` in `GLTFLoader.js`), which RN lacks without polyfills. Overall this means a new native dependency, a separate render path from web, and polyfill risk.
3. **react-native-filament** (npm 1.11.0, Filament-based, glTF only) is a capable native glTF renderer, but it is another engine and does not share code with web.
4. **Thumbnail or metadata only.** Show the server-extracted .blend PNG and summary, or for other formats a server-rendered still if #9 adds Blender/headless rendering. There is no client cost and it works on every surface and connection mode. This is a sensible first step for mobile.

## Sources

- three.js r180 loaders: https://github.com/mrdoob/three.js/tree/r180/examples/jsm/loaders (local copy `three@0.180.0`; USDC stub `usd/USDCParser.js`, compared with tags r181–r184).
- Blender source (branch `main`): `source/blender/blenloader_core/` (header, bhead, file reader), `source/blender/blenloader/intern/writefile.cc`, `source/blender/blenloader/BLO_readfile.hh`, `source/blender/windowmanager/intern/wm_files.cc`, `source/blender/blendthumb/`, `scripts/modules/blend_render_info.py`. All at https://projects.blender.org/blender/blender.
- Blender 5.0 core release notes: https://developer.blender.org/docs/release_notes/5.0/core/
- Expo GLView: https://docs.expo.dev/versions/latest/sdk/gl-view/
- Node zlib zstd: https://nodejs.org/api/zlib.html ; MDN DecompressionStream: https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream/DecompressionStream
- npm registry metadata for `three`, `expo-three`, `expo-gl`, `@react-three/fiber`, `react-native-filament`, `fzstd` (queried 2026-11-23).
- Repo: `packages/client-runtime/src/device/modelScene.ts`, `apps/web/src/components/device/DeviceDuoViewport.tsx`, `apps/web/src/components/files/AttachmentFilePreview.tsx`, `packages/shared/src/filePreview.ts`, `docs/internals/04_environment-auth.md`, `apps/mobile/package.json`, `apps/mobile/scripts/generate-device-stream.mts`, `apps/mobile/metro.config.js`.
- Local experiments (Blender 5.3.0 `-b --factory-startup`, `blender-thumbnailer`, esbuild measurements) are in `.scratch/research/{3d-measure,blend-test,blend-proto}/`.
