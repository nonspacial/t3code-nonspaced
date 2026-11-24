//! Throwaway spike helper for #17: ONE Wayland connection to the hidden labwc display that
//! drives a virtual pointer + virtual keyboard, captures frames (ext-image-copy-capture,
//! wlr-screencopy fallback, cursor session), resizes the output (wlr-output-management) and
//! optionally pushes frames into GStreamer (SHM copy or zero-copy DMABuf).
//! Line commands on stdin, JSON lines on stdout. Not production code.

use std::collections::VecDeque;
use std::io::{BufRead, Write};
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_allocators as gst_alloc;
use gstreamer_allocators::prelude::*;
use gstreamer_app as gst_app;
use gstreamer_video as gst_video;
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{
    wl_buffer, wl_output, wl_pointer, wl_registry, wl_seat, wl_shm, wl_shm_pool,
};
use wayland_client::{delegate_noop, event_created_child, Connection, Dispatch, QueueHandle, WEnum};
use wayland_protocols::ext::foreign_toplevel_list::v1::client::{
    ext_foreign_toplevel_handle_v1 as tl_handle, ext_foreign_toplevel_list_v1 as tl_list,
};
use wayland_protocols::ext::image_capture_source::v1::client::{
    ext_foreign_toplevel_image_capture_source_manager_v1 as tl_src_mgr, ext_image_capture_source_v1 as ext_src,
    ext_output_image_capture_source_manager_v1 as ext_src_mgr,
};
use wayland_protocols::ext::image_copy_capture::v1::client::{
    ext_image_copy_capture_cursor_session_v1 as cur_sess, ext_image_copy_capture_frame_v1 as cap_frame,
    ext_image_copy_capture_manager_v1 as cap_mgr, ext_image_copy_capture_session_v1 as cap_sess,
};
use wayland_protocols::wp::linux_dmabuf::zv1::client::{
    zwp_linux_buffer_params_v1 as dmaparams, zwp_linux_dmabuf_v1 as dmabuf,
};
use wayland_protocols_misc::zwp_virtual_keyboard_v1::client::{
    zwp_virtual_keyboard_manager_v1 as vk_mgr, zwp_virtual_keyboard_v1 as vk,
};
use wayland_protocols_wlr::output_management::v1::client::{
    zwlr_output_configuration_head_v1 as om_cfg_head, zwlr_output_configuration_v1 as om_cfg,
    zwlr_output_head_v1 as om_head, zwlr_output_manager_v1 as om, zwlr_output_mode_v1 as om_mode,
};
use wayland_protocols_wlr::screencopy::v1::client::{
    zwlr_screencopy_frame_v1 as sc_frame, zwlr_screencopy_manager_v1 as sc_mgr,
};
use wayland_protocols_wlr::virtual_pointer::v1::client::{
    zwlr_virtual_pointer_manager_v1 as vp_mgr, zwlr_virtual_pointer_v1 as vp,
};

const DRM_FORMAT_XRGB8888: u32 = 0x3432_5258;
const DRM_FORMAT_ARGB8888: u32 = 0x3432_5241;
const DRM_FORMAT_MOD_INVALID: u64 = 0x00ff_ffff_ffff_ffff;
const NBUF: usize = 4;

// ---- minimal libgbm FFI (enough to allocate a capture target) ----
#[repr(C)]
struct GbmDevice(u8);
#[repr(C)]
struct GbmBo(u8);
#[link(name = "gbm")]
unsafe extern "C" {
    fn gbm_create_device(fd: i32) -> *mut GbmDevice;
    fn gbm_bo_create_with_modifiers2(d: *mut GbmDevice, w: u32, h: u32, f: u32, m: *const u64, n: u32, flags: u32) -> *mut GbmBo;
    fn gbm_bo_create(d: *mut GbmDevice, w: u32, h: u32, f: u32, flags: u32) -> *mut GbmBo;
    fn gbm_bo_get_fd(bo: *mut GbmBo) -> i32;
    fn gbm_bo_get_stride_for_plane(bo: *mut GbmBo, p: i32) -> u32;
    fn gbm_bo_get_offset(bo: *mut GbmBo, p: i32) -> u32;
    fn gbm_bo_get_modifier(bo: *mut GbmBo) -> u64;
    fn gbm_bo_get_plane_count(bo: *mut GbmBo) -> i32;
    fn gbm_bo_destroy(bo: *mut GbmBo);
}
const GBM_BO_USE_RENDERING: u32 = 1 << 2;

fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64()
}
fn out(s: String) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{s}");
    let _ = o.flush();
}
fn cpu_secs() -> f64 {
    let s = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let rest = s.rsplit(')').next().unwrap_or("");
    let f: Vec<&str> = rest.split_whitespace().collect();
    let tick = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64;
    (f.get(11).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0)
        + f.get(12).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0))
        / tick
}
fn memfd(size: usize) -> OwnedFd {
    let fd = unsafe { libc::memfd_create(c"spike".as_ptr(), libc::MFD_CLOEXEC) };
    assert!(fd >= 0);
    unsafe { libc::ftruncate(fd, size as i64) };
    unsafe { OwnedFd::from_raw_fd(fd) }
}

enum Mem {
    Shm { map: memmap2::MmapMut, _fd: OwnedFd },
    Dma { fd: OwnedFd, bo: *mut GbmBo, stride: u32, offset: u32, modifier: u64, size: usize },
}
struct Buf {
    wl: wl_buffer::WlBuffer,
    mem: Mem,
    w: u32,
    h: u32,
    stride: u32,
    fmt: u32,
}
impl Drop for Buf {
    fn drop(&mut self) {
        self.wl.destroy();
        if let Mem::Dma { bo, .. } = self.mem {
            unsafe { gbm_bo_destroy(bo) };
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Main,
    Cursor,
}

#[derive(Default)]
struct SessInfo {
    w: u32,
    h: u32,
    shm: Vec<u32>,
    dev: Option<u64>,
    dma: Vec<(u32, Vec<u64>)>,
    done: bool,
    stride: u32,
}

struct Capture {
    sess: cap_sess::ExtImageCopyCaptureSessionV1,
    info: SessInfo,
    use_dma: bool,
    bufs: Vec<Buf>,
    next: usize,
    in_flight: Option<(cap_frame::ExtImageCopyCaptureFrameV1, usize)>,
    frames: u64,
    failed: u64,
    damage_px: u64,
    started: Instant,
    cpu0: f64,
    last_ready: f64,
    pres_lat_ms: Vec<f64>,
    want_save: Option<String>,
    enc: Option<Encoder>,
    enc_kind: Option<String>,
    alpha_log: bool,
}

struct Encoder {
    pipeline: gst::Pipeline,
    src: gst_app::AppSrc,
    t0: Instant,
    stats: Arc<EncStats>,
    dma: bool,
    caps_wh: (u32, u32),
    desc: String,
}
#[derive(Default)]
struct EncStats {
    pushed: Mutex<VecDeque<Instant>>,
    pushes: AtomicU64,
    encoded: AtomicU64,
    bytes: AtomicU64,
    lat: Mutex<VecDeque<f64>>,
}

struct ScShot {
    frame: sc_frame::ZwlrScreencopyFrameV1,
    buf: Option<Buf>,
    fmt: u32,
    w: u32,
    h: u32,
    stride: u32,
    path: Option<String>,
    looping: bool,
    overlay: bool,
    t_req: f64,
}

struct State {
    shm: wl_shm::WlShm,
    seat: wl_seat::WlSeat,
    output: wl_output::WlOutput,
    out_w: i32,
    out_h: i32,
    ptr: vp::ZwlrVirtualPointerV1,
    kb: vk::ZwpVirtualKeyboardV1,
    mods: u32,
    src_mgr: ext_src_mgr::ExtOutputImageCaptureSourceManagerV1,
    cap: cap_mgr::ExtImageCopyCaptureManagerV1,
    sc: sc_mgr::ZwlrScreencopyManagerV1,
    dmabuf: dmabuf::ZwpLinuxDmabufV1,
    om: om::ZwlrOutputManagerV1,
    om_serial: u32,
    heads: Vec<om_head::ZwlrOutputHeadV1>,
    gbm: *mut GbmDevice,
    main: Option<Capture>,
    cursor: Option<Capture>,
    cursor_sess: Option<cur_sess::ExtImageCopyCaptureCursorSessionV1>,
    shots: Vec<ScShot>,
    sc_loop_frames: u64,
    sc_stop: bool,
    tl_src: tl_src_mgr::ExtForeignToplevelImageCaptureSourceManagerV1,
    _tl_list: tl_list::ExtForeignToplevelListV1,
    toplevels: Vec<(tl_handle::ExtForeignToplevelHandleV1, String, bool)>,
    t0: Instant,
    quit: bool,
}

fn ms_now(st: &State) -> u32 {
    st.t0.elapsed().as_millis() as u32
}

impl State {
    fn alloc(&mut self, qh: &QueueHandle<State>, info: &SessInfo, use_dma: bool) -> Vec<Buf> {
        let (w, h) = (info.w, info.h);
        let mut v = Vec::new();
        for _ in 0..NBUF {
            if use_dma {
                let mods = info
                    .dma
                    .iter()
                    .find(|(f, _)| *f == DRM_FORMAT_XRGB8888)
                    .map(|(_, m)| m.clone())
                    .unwrap_or_default();
                let mods: Vec<u64> = mods.into_iter().filter(|m| *m != DRM_FORMAT_MOD_INVALID).collect();
                let bo = unsafe {
                    if mods.is_empty() {
                        gbm_bo_create(self.gbm, w, h, DRM_FORMAT_XRGB8888, GBM_BO_USE_RENDERING)
                    } else {
                        gbm_bo_create_with_modifiers2(self.gbm, w, h, DRM_FORMAT_XRGB8888, mods.as_ptr(), mods.len() as u32, GBM_BO_USE_RENDERING)
                    }
                };
                assert!(!bo.is_null(), "gbm_bo_create failed");
                let planes = unsafe { gbm_bo_get_plane_count(bo) };
                assert_eq!(planes, 1, "multi-plane bo not handled");
                let fd = unsafe { OwnedFd::from_raw_fd(gbm_bo_get_fd(bo)) };
                let stride = unsafe { gbm_bo_get_stride_for_plane(bo, 0) };
                let offset = unsafe { gbm_bo_get_offset(bo, 0) };
                let modifier = unsafe { gbm_bo_get_modifier(bo) };
                let size = unsafe { libc::lseek(fd.as_raw_fd(), 0, libc::SEEK_END) } as usize;
                let params = self.dmabuf.create_params(qh, ());
                params.add(fd.as_fd(), 0, offset, stride, (modifier >> 32) as u32, modifier as u32);
                let wl = params.create_immed(w as i32, h as i32, DRM_FORMAT_XRGB8888, dmaparams::Flags::empty(), qh, ());
                params.destroy();
                v.push(Buf { wl, mem: Mem::Dma { fd, bo, stride, offset, modifier, size }, w, h, stride, fmt: DRM_FORMAT_XRGB8888 });
            } else {
                // Use exactly what the compositor offered (labwc offers XBGR8888 here, not XRGB).
                let pick = [wl_shm::Format::Xrgb8888 as u32, wl_shm::Format::Xbgr8888 as u32, wl_shm::Format::Argb8888 as u32, wl_shm::Format::Abgr8888 as u32]
                    .into_iter()
                    .find(|f| info.shm.contains(f))
                    .unwrap_or(info.shm[0]);
                let fmt = wl_shm::Format::try_from(pick).unwrap();
                let stride = if info.stride > 0 { info.stride } else { w * 4 };
                let size = (stride * h) as usize;
                let fd = memfd(size.max(4));
                let map = unsafe { memmap2::MmapMut::map_mut(&std::fs::File::from(fd.try_clone().unwrap())).unwrap() };
                let pool = self.shm.create_pool(fd.as_fd(), size.max(4) as i32, qh, ());
                let wl = pool.create_buffer(0, w as i32, h as i32, stride as i32, fmt, qh, ());
                pool.destroy();
                v.push(Buf { wl, mem: Mem::Shm { map, _fd: fd }, w, h, stride, fmt: pick });
            }
        }
        v
    }

    fn capture_next(&mut self, kind: Kind, qh: &QueueHandle<State>) {
        let need_alloc = {
            let c = match kind { Kind::Main => self.main.as_ref(), Kind::Cursor => self.cursor.as_ref() };
            let Some(c) = c else { return };
            if c.in_flight.is_some() || !c.info.done || c.info.w == 0 || c.info.h == 0 {
                return;
            }
            c.bufs.is_empty() || c.bufs[0].w != c.info.w || c.bufs[0].h != c.info.h
        };
        if need_alloc {
            let (info, use_dma) = {
                let c = match kind { Kind::Main => self.main.as_mut(), Kind::Cursor => self.cursor.as_mut() }.unwrap();
                c.bufs.clear();
                (std::mem::take(&mut c.info), c.use_dma)
            };
            let bufs = self.alloc(qh, &info, use_dma);
            let c = match kind { Kind::Main => self.main.as_mut(), Kind::Cursor => self.cursor.as_mut() }.unwrap();
            out(format!(r#"{{"ev":"alloc","kind":"{kind:?}","w":{},"h":{},"dma":{use_dma},"t":{:.4}}}"#, info.w, info.h, now()));
            c.info = info;
            c.bufs = bufs;
            if let Some(e) = c.enc.as_mut() {
                if e.caps_wh != (c.info.w, c.info.h) {
                    e.set_caps(&c.bufs[0]);
                }
            }
        }
        let c = match kind { Kind::Main => self.main.as_mut(), Kind::Cursor => self.cursor.as_mut() }.unwrap();
        let idx = c.next;
        c.next = (c.next + 1) % c.bufs.len();
        let fr = c.sess.create_frame(qh, kind);
        fr.attach_buffer(&c.bufs[idx].wl);
        fr.damage_buffer(0, 0, c.info.w as i32, c.info.h as i32);
        fr.capture();
        c.in_flight = Some((fr, idx));
    }
}

impl Encoder {
    fn new(kind: &str, first: &Buf) -> Encoder {
        let dma = matches!(first.mem, Mem::Dma { .. });
        let enc = match kind {
            "nv" => "nvh264enc preset=p4 tune=ultra-low-latency zerolatency=true bframes=0 gop-size=-1 rc-mode=cbr bitrate=12000",
            "x264" => "videoconvert ! x264enc tune=zerolatency speed-preset=superfast key-int-max=600 bitrate=12000",
            "openh264" => "videoconvert ! openh264enc",
            _ => "fakesink",
        };
        let up_default = if dma { "glupload ! glcolorconvert ! video/x-raw(memory:GLMemory),format=BGRx ! " } else { "" };
        let up = std::env::var("SPIKE_DMA_UP").ok().filter(|_| dma).map(|v| format!("{v} ! ")).unwrap_or(up_default.to_string());
        let q = std::env::var("SPIKE_QUEUE").unwrap_or("queue max-size-buffers=2 leaky=downstream ! ".into());
        let desc = format!("appsrc name=src is-live=true format=time do-timestamp=false ! {q}{up}{enc} ! h264parse ! appsink name=sink sync=false");
        let pipeline = gst::parse::launch(&desc).expect("pipeline").downcast::<gst::Pipeline>().unwrap();
        let src = pipeline.by_name("src").unwrap().downcast::<gst_app::AppSrc>().unwrap();
        let sink = pipeline.by_name("sink").unwrap().downcast::<gst_app::AppSink>().unwrap();
        let stats = Arc::new(EncStats::default());
        let t0 = Instant::now();
        let st2 = stats.clone();
        sink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |s| {
                    let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    if let Some(b) = sample.buffer() {
                        st2.encoded.fetch_add(1, Ordering::Relaxed);
                        st2.bytes.fetch_add(b.size() as u64, Ordering::Relaxed);
                        // FIFO match: no B-frames, one AU per input, so the nth output is the nth push.
                        if let Some(t_push) = st2.pushed.lock().unwrap().pop_front() {
                            let mut l = st2.lat.lock().unwrap();
                            l.push_back(t_push.elapsed().as_secs_f64() * 1000.0);
                            if l.len() > 600 {
                                l.pop_front();
                            }
                        }
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        let bus = pipeline.bus().unwrap();
        std::thread::spawn(move || {
            for msg in bus.iter_timed(gst::ClockTime::NONE) {
                use gst::MessageView;
                match msg.view() {
                    MessageView::Error(e) => out(format!(r#"{{"ev":"gst_error","msg":{:?},"dbg":{:?}}}"#, e.error().to_string(), format!("{:?}", e.debug()))),
                    MessageView::Warning(e) => out(format!(r#"{{"ev":"gst_warning","msg":{:?}}}"#, e.error().to_string())),
                    MessageView::Eos(_) => break,
                    _ => {}
                }
            }
        });
        let mut e = Encoder { pipeline, src, t0, stats, dma, caps_wh: (0, 0), desc };
        e.set_caps(first);
        e.pipeline.set_state(gst::State::Playing).expect("playing");
        out(format!(r#"{{"ev":"enc_started","desc":{:?}}}"#, e.desc));
        e
    }
    fn set_caps(&mut self, b: &Buf) {
        let caps = match &b.mem {
            Mem::Dma { modifier, .. } => gst::Caps::from_str_compat(&format!(
                "video/x-raw(memory:DMABuf),format=DMA_DRM,drm-format=XR24:0x{modifier:016x},width={},height={},framerate=0/1",
                b.w, b.h
            )),
            Mem::Shm { .. } => gst::Caps::from_str_compat(&format!("video/x-raw,format={},width={},height={},framerate=0/1", if rgb_order(b.fmt) { "RGBx" } else { "BGRx" }, b.w, b.h)),
        };
        out(format!(r#"{{"ev":"enc_caps","caps":{:?}}}"#, caps.to_string()));
        self.src.set_caps(Some(&caps));
        self.caps_wh = (b.w, b.h);
    }
    fn push(&mut self, b: &Buf) {
        let pts = gst::ClockTime::from_nseconds(self.t0.elapsed().as_nanos() as u64);
        let buffer = match &b.mem {
            Mem::Shm { map, .. } => {
                // The SHM path: one CPU copy of the whole frame into a GstBuffer.
                let n = (b.stride * b.h) as usize;
                let mut gb = gst::Buffer::with_size(n).unwrap();
                {
                    let gbm = gb.get_mut().unwrap();
                    gbm.set_pts(pts);
                    gbm.map_writable().unwrap().copy_from_slice(&map[..n]);
                }
                gb
            }
            Mem::Dma { fd, stride, offset, size, .. } => {
                // Zero-copy path: wrap the captured dmabuf fd; no pixel touches the CPU.
                let alloc = gst_alloc::DmaBufAllocator::new();
                let dup = fd.try_clone().unwrap();
                let mem = unsafe { alloc.alloc_dmabuf(dup, *size) }.expect("dmabuf alloc");
                let mut gb = gst::Buffer::new();
                {
                    let gbm = gb.get_mut().unwrap();
                    gbm.append_memory(mem);
                    gbm.set_pts(pts);
                    gst_video::VideoMeta::add_full(
                        gbm,
                        gst_video::VideoFrameFlags::empty(),
                        gst_video::VideoFormat::DmaDrm,
                        b.w,
                        b.h,
                        &[*offset as usize],
                        &[*stride as i32],
                    )
                    .unwrap();
                }
                gb
            }
        };
        self.stats.pushed.lock().unwrap().push_back(Instant::now());
        self.stats.pushes.fetch_add(1, Ordering::Relaxed);
        let _ = self.src.push_buffer(buffer);
    }
}

trait CapsCompat {
    fn from_str_compat(s: &str) -> gst::Caps;
}
impl CapsCompat for gst::Caps {
    fn from_str_compat(s: &str) -> gst::Caps {
        s.parse::<gst::Caps>().expect("caps")
    }
}

fn rgb_order(fmt: u32) -> bool {
    fmt == wl_shm::Format::Xbgr8888 as u32 || fmt == wl_shm::Format::Abgr8888 as u32 || fmt == wl_shm::Format::Bgr888 as u32
}
fn save_ppm(path: &str, b: &Buf) {
    if let Mem::Shm { map, .. } = &b.mem {
        let mut f = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
        write!(f, "P6\n{} {}\n255\n", b.w, b.h).unwrap();
        for y in 0..b.h {
            for x in 0..b.w {
                let bpp = if b.fmt == wl_shm::Format::Bgr888 as u32 { 3 } else { 4 };
                let i = (y * b.stride + x * bpp) as usize;
                if rgb_order(b.fmt) { f.write_all(&[map[i], map[i + 1], map[i + 2]]).unwrap() } else { f.write_all(&[map[i + 2], map[i + 1], map[i]]).unwrap() }
            }
        }
    }
}
fn alpha_stats(b: &Buf) -> (u64, u64) {
    let mut nz = 0;
    let mut px = 0;
    if let Mem::Shm { map, .. } = &b.mem {
        for y in 0..b.h {
            for x in 0..b.w {
                let i = (y * b.stride + x * 4) as usize;
                px += 1;
                if map[i + 3] != 0 {
                    nz += 1;
                }
            }
        }
    }
    (nz, px)
}

// ---------------- Dispatch impls ----------------
impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(_: &mut Self, _: &wl_registry::WlRegistry, _: wl_registry::Event, _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
}
impl Dispatch<wl_output::WlOutput, ()> for State {
    fn event(st: &mut Self, _: &wl_output::WlOutput, ev: wl_output::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        if let wl_output::Event::Mode { flags, width, height, refresh } = ev {
            if let WEnum::Value(f) = flags {
                if f.contains(wl_output::Mode::Current) {
                    st.out_w = width;
                    st.out_h = height;
                    out(format!(r#"{{"ev":"output_mode","w":{width},"h":{height},"refresh_mhz":{refresh},"t":{:.4}}}"#, now()));
                }
            }
        }
    }
}
impl Dispatch<cap_sess::ExtImageCopyCaptureSessionV1, Kind> for State {
    fn event(st: &mut Self, _: &cap_sess::ExtImageCopyCaptureSessionV1, ev: cap_sess::Event, kind: &Kind, _: &Connection, qh: &QueueHandle<Self>) {
        let kind = *kind;
        let Some(c) = (match kind { Kind::Main => st.main.as_mut(), Kind::Cursor => st.cursor.as_mut() }) else { return };
        match ev {
            cap_sess::Event::BufferSize { width, height } => {
                if c.info.done {
                    c.info = SessInfo::default();
                }
                c.info.w = width;
                c.info.h = height;
                out(format!(r#"{{"ev":"buffer_size","kind":"{kind:?}","w":{width},"h":{height},"t":{:.4}}}"#, now()));
            }
            cap_sess::Event::ShmFormat { format } => {
                if c.info.done {
                    c.info = SessInfo::default();
                }
                if let WEnum::Value(f) = format {
                    c.info.shm.push(f as u32);
                }
            }
            cap_sess::Event::DmabufDevice { device } => {
                let mut b = [0u8; 8];
                b[..device.len().min(8)].copy_from_slice(&device[..device.len().min(8)]);
                c.info.dev = Some(u64::from_ne_bytes(b));
            }
            cap_sess::Event::DmabufFormat { format, modifiers } => {
                let m: Vec<u64> = modifiers.chunks_exact(8).map(|c| u64::from_ne_bytes(c.try_into().unwrap())).collect();
                c.info.dma.push((format, m));
            }
            cap_sess::Event::Done => {
                c.info.done = true;
                let xr: Vec<String> = c
                    .info
                    .dma
                    .iter()
                    .filter(|(f, _)| *f == DRM_FORMAT_XRGB8888 || *f == DRM_FORMAT_ARGB8888)
                    .map(|(f, m)| format!(r#"{{"fmt":"0x{f:08x}","mods":[{}]}}"#, m.iter().map(|x| format!("\"0x{x:016x}\"")).collect::<Vec<_>>().join(",")))
                    .collect();
                out(format!(
                    r#"{{"ev":"session_done","kind":"{kind:?}","w":{},"h":{},"shm":{:?},"dmabuf_dev":"{:?}","dmabuf_xrgb_argb":[{}],"n_dmabuf_formats":{},"t":{:.4}}}"#,
                    c.info.w, c.info.h, c.info.shm, c.info.dev.map(|d| format!("{}:{}", libc::major(d), libc::minor(d))), xr.join(","), c.info.dma.len(), now()
                ));
                st.capture_next(kind, qh);
            }
            cap_sess::Event::Stopped => out(format!(r#"{{"ev":"session_stopped","kind":"{kind:?}","t":{:.4}}}"#, now())),
            _ => {}
        }
    }
}
impl Dispatch<cap_frame::ExtImageCopyCaptureFrameV1, Kind> for State {
    fn event(st: &mut Self, fr: &cap_frame::ExtImageCopyCaptureFrameV1, ev: cap_frame::Event, kind: &Kind, _: &Connection, qh: &QueueHandle<Self>) {
        let kind = *kind;
        let Some(c) = (match kind { Kind::Main => st.main.as_mut(), Kind::Cursor => st.cursor.as_mut() }) else { return };
        match ev {
            cap_frame::Event::Damage { width, height, .. } => c.damage_px += (width as u64) * (height as u64),
            cap_frame::Event::PresentationTime { tv_sec_hi, tv_sec_lo, tv_nsec } => {
                let pres = ((tv_sec_hi as u64) << 32 | tv_sec_lo as u64) as f64 + tv_nsec as f64 / 1e9;
                let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
                unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
                let mono = ts.tv_sec as f64 + ts.tv_nsec as f64 / 1e9;
                c.pres_lat_ms.push((mono - pres) * 1000.0);
            }
            cap_frame::Event::Ready => {
                c.frames += 1;
                c.last_ready = now();
                let idx = c.in_flight.take().map(|(_, i)| i).unwrap_or(0);
                fr.destroy();
                if let Some(p) = c.want_save.take() {
                    save_ppm(&p, &c.bufs[idx]);
                    out(format!(r#"{{"ev":"saved","path":{p:?}}}"#));
                }
                if c.alpha_log {
                    let (nz, px) = alpha_stats(&c.bufs[idx]);
                    out(format!(r#"{{"ev":"cursor_frame","w":{},"h":{},"opaque_px":{nz},"px":{px},"t":{:.4}}}"#, c.info.w, c.info.h, now()));
                }
                if let Some(e) = c.enc.as_mut() {
                    e.push(&c.bufs[idx]);
                }
                st.capture_next(kind, qh);
            }
            cap_frame::Event::Failed { reason } => {
                c.failed += 1;
                c.in_flight = None;
                fr.destroy();
                out(format!(r#"{{"ev":"frame_failed","kind":"{kind:?}","reason":"{reason:?}","t":{:.4}}}"#, now()));
                if !matches!(reason, WEnum::Value(cap_frame::FailureReason::Stopped)) {
                    st.capture_next(kind, qh);
                }
            }
            _ => {}
        }
    }
}
impl Dispatch<cur_sess::ExtImageCopyCaptureCursorSessionV1, ()> for State {
    fn event(_: &mut Self, _: &cur_sess::ExtImageCopyCaptureCursorSessionV1, ev: cur_sess::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        let s = match ev {
            cur_sess::Event::Enter => "\"enter\"".to_string(),
            cur_sess::Event::Leave => "\"leave\"".to_string(),
            cur_sess::Event::Position { x, y } => format!(r#""position","x":{x},"y":{y}"#),
            cur_sess::Event::Hotspot { x, y } => format!(r#""hotspot","x":{x},"y":{y}"#),
            _ => "\"other\"".to_string(),
        };
        out(format!(r#"{{"ev":"cursor","what":{s},"t":{:.4}}}"#, now()));
    }
}
impl Dispatch<sc_frame::ZwlrScreencopyFrameV1, ()> for State {
    fn event(st: &mut Self, fr: &sc_frame::ZwlrScreencopyFrameV1, ev: sc_frame::Event, _: &(), _: &Connection, qh: &QueueHandle<Self>) {
        let Some(pos) = st.shots.iter().position(|s| &s.frame == fr) else { return };
        match ev {
            sc_frame::Event::Buffer { format, width, height, stride } => {
                let s = &mut st.shots[pos];
                if let WEnum::Value(f) = format {
                    let four = matches!(f, wl_shm::Format::Xrgb8888 | wl_shm::Format::Xbgr8888 | wl_shm::Format::Argb8888 | wl_shm::Format::Abgr8888 | wl_shm::Format::Bgr888);
                    out(format!(r#"{{"ev":"sc_buffer_offer","fmt":"{f:?}","stride":{stride}}}"#));
                    if four && (s.fmt == u32::MAX || f == wl_shm::Format::Xrgb8888) {
                        s.fmt = f as u32;
                        s.w = width;
                        s.h = height;
                        s.stride = stride;
                    }
                }
            }
            sc_frame::Event::BufferDone => {
                let (w, h) = (st.shots[pos].w, st.shots[pos].h);
                let info = SessInfo { w, h, shm: vec![st.shots[pos].fmt], done: true, stride: st.shots[pos].stride, ..Default::default() };
                let mut bufs = st.alloc(qh, &info, false);
                let b = bufs.remove(0);
                let s = &mut st.shots[pos];
                if s.looping {
                    s.frame.copy_with_damage(&b.wl);
                } else {
                    s.frame.copy(&b.wl);
                }
                s.buf = Some(b);
            }
            sc_frame::Event::Ready { .. } => {
                let s = st.shots.remove(pos);
                fr.destroy();
                let ms = (now() - s.t_req) * 1000.0;
                if let (Some(p), Some(b)) = (&s.path, &s.buf) {
                    save_ppm(p, b);
                }
                if s.looping && !st.sc_stop {
                    st.sc_loop_frames += 1;
                    let f = st.sc.capture_output(s.overlay as i32, &st.output, qh, ());
                    st.shots.push(ScShot { frame: f, buf: None, fmt: u32::MAX, w: 0, h: 0, stride: 0, path: None, looping: true, overlay: s.overlay, t_req: now() });
                } else {
                    out(format!(r#"{{"ev":"sc_ready","overlay":{},"w":{},"h":{},"ms":{ms:.1},"path":{:?},"t":{:.4}}}"#, s.overlay, s.w, s.h, s.path.clone().unwrap_or_default(), now()));
                }
            }
            sc_frame::Event::Failed => {
                st.shots.remove(pos);
                fr.destroy();
                out(format!(r#"{{"ev":"sc_failed","t":{:.4}}}"#, now()));
            }
            _ => {}
        }
    }
}
impl Dispatch<om::ZwlrOutputManagerV1, ()> for State {
    fn event(st: &mut Self, _: &om::ZwlrOutputManagerV1, ev: om::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match ev {
            om::Event::Head { head } => st.heads.push(head),
            om::Event::Done { serial } => st.om_serial = serial,
            _ => {}
        }
    }
    event_created_child!(State, om::ZwlrOutputManagerV1, [om::EVT_HEAD_OPCODE => (om_head::ZwlrOutputHeadV1, ())]);
}
impl Dispatch<om_head::ZwlrOutputHeadV1, ()> for State {
    fn event(_: &mut Self, _: &om_head::ZwlrOutputHeadV1, ev: om_head::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        if let om_head::Event::Name { name } = ev {
            out(format!(r#"{{"ev":"om_head","name":{name:?}}}"#));
        }
    }
    event_created_child!(State, om_head::ZwlrOutputHeadV1, [om_head::EVT_MODE_OPCODE => (om_mode::ZwlrOutputModeV1, ())]);
}
impl Dispatch<om_cfg::ZwlrOutputConfigurationV1, ()> for State {
    fn event(_: &mut Self, c: &om_cfg::ZwlrOutputConfigurationV1, ev: om_cfg::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        out(format!(r#"{{"ev":"om_result","result":"{ev:?}","t":{:.4}}}"#, now()));
        c.destroy();
    }
}
impl Dispatch<tl_list::ExtForeignToplevelListV1, ()> for State {
    fn event(st: &mut Self, _: &tl_list::ExtForeignToplevelListV1, ev: tl_list::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        if let tl_list::Event::Toplevel { toplevel } = ev {
            st.toplevels.push((toplevel, String::new(), false));
        }
    }
    event_created_child!(State, tl_list::ExtForeignToplevelListV1, [tl_list::EVT_TOPLEVEL_OPCODE => (tl_handle::ExtForeignToplevelHandleV1, ())]);
}
impl Dispatch<tl_handle::ExtForeignToplevelHandleV1, ()> for State {
    fn event(st: &mut Self, h: &tl_handle::ExtForeignToplevelHandleV1, ev: tl_handle::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        let Some(t) = st.toplevels.iter_mut().find(|t| &t.0 == h) else { return };
        match ev {
            tl_handle::Event::Title { title } => t.1 = title,
            tl_handle::Event::Closed => t.2 = true,
            tl_handle::Event::Done => out(format!(r#"{{"ev":"toplevel","title":{:?},"t":{:.4}}}"#, t.1, now())),
            _ => {}
        }
    }
}
delegate_noop!(State: ignore tl_src_mgr::ExtForeignToplevelImageCaptureSourceManagerV1);
delegate_noop!(State: ignore wl_shm::WlShm);
delegate_noop!(State: ignore wl_shm_pool::WlShmPool);
delegate_noop!(State: ignore wl_buffer::WlBuffer);
delegate_noop!(State: ignore wl_seat::WlSeat);
delegate_noop!(State: ignore wl_pointer::WlPointer);
delegate_noop!(State: ignore vp_mgr::ZwlrVirtualPointerManagerV1);
delegate_noop!(State: ignore vp::ZwlrVirtualPointerV1);
delegate_noop!(State: ignore vk_mgr::ZwpVirtualKeyboardManagerV1);
delegate_noop!(State: ignore vk::ZwpVirtualKeyboardV1);
delegate_noop!(State: ignore ext_src_mgr::ExtOutputImageCaptureSourceManagerV1);
delegate_noop!(State: ignore ext_src::ExtImageCaptureSourceV1);
delegate_noop!(State: ignore cap_mgr::ExtImageCopyCaptureManagerV1);
delegate_noop!(State: ignore sc_mgr::ZwlrScreencopyManagerV1);
delegate_noop!(State: ignore dmabuf::ZwpLinuxDmabufV1);
delegate_noop!(State: ignore dmaparams::ZwpLinuxBufferParamsV1);
delegate_noop!(State: ignore om_mode::ZwlrOutputModeV1);
delegate_noop!(State: ignore om_cfg_head::ZwlrOutputConfigurationHeadV1);

fn mod_bit(key: u32) -> u32 {
    match key {
        42 | 54 => 1,   // Shift
        29 | 97 => 4,   // Control
        56 | 100 => 8,  // Alt (Mod1)
        125 | 126 => 64, // Super (Mod4)
        _ => 0,
    }
}

fn handle(st: &mut State, line: &str, qh: &QueueHandle<State>) {
    let a: Vec<&str> = line.split_whitespace().collect();
    let f = |i: usize| a.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    let u = |i: usize| a.get(i).and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
    let t = ms_now(st);
    match a.first().copied().unwrap_or("") {
        "motion" => {
            st.ptr.motion(t, f(1), f(2));
            st.ptr.frame();
        }
        "abs" => {
            st.ptr.motion_absolute(t, u(1), u(2), st.out_w as u32, st.out_h as u32);
            st.ptr.frame();
        }
        "btn" => {
            let s = if u(2) == 1 { wl_pointer::ButtonState::Pressed } else { wl_pointer::ButtonState::Released };
            st.ptr.button(t, u(1), s);
            st.ptr.frame();
        }
        "wheel" => {
            let n = f(1) as i32;
            st.ptr.axis_source(wl_pointer::AxisSource::Wheel);
            st.ptr.axis_discrete(t, wl_pointer::Axis::VerticalScroll, 15.0 * n as f64, n);
            st.ptr.frame();
        }
        "keymap" => {
            let mut data = std::fs::read(a[1]).expect("keymap file");
            data.push(0);
            let fd = memfd(data.len());
            let mut file = std::fs::File::from(fd.try_clone().unwrap());
            file.write_all(&data).unwrap();
            st.kb.keymap(1, fd.as_fd(), data.len() as u32);
            out(format!(r#"{{"ev":"keymap_sent","bytes":{}}}"#, data.len()));
        }
        "key" => {
            let (k, s) = (u(1), u(2));
            st.kb.key(t, k, s);
            let b = mod_bit(k);
            if b != 0 {
                // wlroots' virtual keyboard does not derive modifiers from keys; send them.
                if s == 1 { st.mods |= b } else { st.mods &= !b }
                st.kb.modifiers(st.mods, 0, 0, 0);
            }
        }
        "cap" => match a.get(1).copied() {
            Some("start") => {
                let use_dma = a.get(2) == Some(&"dmabuf");
                let cursors = a.get(3) == Some(&"1");
                let enc = a.get(4).map(|s| s.to_string()).filter(|s| s != "none");
                let source = match a.get(5).and_then(|v| v.strip_prefix("tl:")).and_then(|v| v.parse::<i64>().ok()) {
                    Some(i) => {
                        let live: Vec<_> = st.toplevels.iter().filter(|t| !t.2).collect();
                        let idx = if i < 0 { (live.len() as i64 + i) as usize } else { i as usize };
                        out(format!(r#"{{"ev":"capture_toplevel","index":{idx},"title":{:?}}}"#, live[idx].1));
                        st.tl_src.create_source(&live[idx].0, qh, ())
                    }
                    None => st.src_mgr.create_source(&st.output, qh, ()),
                };
                let opts = if cursors { cap_mgr::Options::PaintCursors } else { cap_mgr::Options::empty() };
                let sess = st.cap.create_session(&source, opts, qh, Kind::Main);
                st.main = Some(Capture::new(sess, use_dma, false));
                if let Some(e) = enc {
                    st.main.as_mut().unwrap().enc_kind = Some(e);
                }
            }
            Some("stop") => {
                if let Some(mut c) = st.main.take() {
                    if let Some((fr, _)) = c.in_flight.take() {
                        fr.destroy();
                    }
                    if let Some(e) = c.enc.take() {
                        let _ = e.src.end_of_stream();
                        std::thread::sleep(Duration::from_millis(200));
                        let _ = e.pipeline.set_state(gst::State::Null);
                    }
                    c.sess.destroy();
                }
            }
            Some("reset") => {
                if let Some(c) = st.main.as_mut() {
                    c.frames = 0;
                    c.failed = 0;
                    c.damage_px = 0;
                    c.started = Instant::now();
                    c.cpu0 = cpu_secs();
                    c.pres_lat_ms.clear();
                    if let Some(e) = c.enc.as_ref() {
                        e.stats.encoded.store(0, Ordering::Relaxed);
                        e.stats.pushes.store(0, Ordering::Relaxed);
                        e.stats.bytes.store(0, Ordering::Relaxed);
                        e.stats.lat.lock().unwrap().clear();
                    }
                }
            }
            Some("stats") => {
                if let Some(c) = st.main.as_ref() {
                    let el = c.started.elapsed().as_secs_f64();
                    let cpu = cpu_secs() - c.cpu0;
                    let med = |v: &mut Vec<f64>| {
                        if v.is_empty() { return -1.0 }
                        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
                        v[v.len() / 2]
                    };
                    let p95 = |v: &Vec<f64>| if v.is_empty() { -1.0 } else { v[(v.len() * 95 / 100).min(v.len() - 1)] };
                    let mut pres = c.pres_lat_ms.clone();
                    let pm = med(&mut pres);
                    let pp = p95(&pres);
                    let (enc_n, enc_bytes, mut el_lat) = c
                        .enc
                        .as_ref()
                        .map(|e| (e.stats.encoded.load(Ordering::Relaxed), e.stats.bytes.load(Ordering::Relaxed), e.stats.lat.lock().unwrap().iter().copied().collect::<Vec<_>>()))
                        .unwrap_or((0, 0, vec![]));
                    let em = med(&mut el_lat);
                    let ep = p95(&el_lat);
                    out(format!(
                        r#"{{"ev":"stats","label":{:?},"secs":{el:.2},"frames":{},"fps":{:.1},"failed":{},"damage_mpx":{:.2},"cpu_pct":{:.1},"present_to_ready_ms_med":{pm:.2},"present_to_ready_ms_p95":{pp:.2},"encoded":{enc_n},"pushed":{},"enc_fps":{:.1},"enc_kbps":{:.0},"ready_to_encoded_ms_med":{em:.2},"ready_to_encoded_ms_p95":{ep:.2},"w":{},"h":{},"dma":{}}}"#,
                        a.get(2).copied().unwrap_or(""),
                        c.frames,
                        c.frames as f64 / el,
                        c.failed,
                        c.damage_px as f64 / 1e6,
                        cpu / el * 100.0,
                        c.enc.as_ref().map(|e| e.stats.pushes.load(Ordering::Relaxed)).unwrap_or(0),
                        enc_n as f64 / el,
                        enc_bytes as f64 * 8.0 / 1000.0 / el,
                        c.info.w,
                        c.info.h,
                        c.use_dma
                    ));
                }
            }
            Some("save") => {
                if let Some(c) = st.main.as_mut() {
                    c.want_save = Some(a[2].to_string());
                }
            }
            _ => {}
        },
        "curs" => {
            // Cursor session: needs a wl_pointer of our own seat to name "the" pointer.
            let pointer = st.seat.get_pointer(qh, ());
            let source = st.src_mgr.create_source(&st.output, qh, ());
            let cs = st.cap.create_pointer_cursor_session(&source, &pointer, qh, ());
            let sess = cs.get_capture_session(qh, Kind::Cursor);
            st.cursor = Some(Capture::new(sess, false, true));
            st.cursor_sess = Some(cs);
        }
        "sc" => {
            // sc shot <overlay 0|1> <path>   |   sc loop <overlay>   |   sc count
            match a.get(1).copied() {
                Some("stop") => st.sc_stop = true,
                Some("count") => out(format!(r#"{{"ev":"sc_count","frames":{},"t":{:.4}}}"#, st.sc_loop_frames, now())),
                Some(m) => {
                    let overlay = a.get(2) == Some(&"1");
                    let f = st.sc.capture_output(overlay as i32, &st.output, qh, ());
                    if m == "loop" { st.sc_stop = false; }
                    st.shots.push(ScShot { frame: f, buf: None, fmt: u32::MAX, w: 0, h: 0, stride: 0, path: a.get(3).map(|s| s.to_string()), looping: m == "loop", overlay, t_req: now() });
                }
                None => {}
            }
        }
        "resize" => {
            let Some(head) = st.heads.first() else { return };
            let cfg = st.om.create_configuration(st.om_serial, qh, ());
            let ch = cfg.enable_head(head, qh, ());
            ch.set_custom_mode(u(1) as i32, u(2) as i32, 60000);
            cfg.apply();
            out(format!(r#"{{"ev":"resize_sent","w":{},"h":{},"t":{:.4}}}"#, u(1), u(2), now()));
        }
        "toplevels" => {
            let l: Vec<String> = st.toplevels.iter().filter(|t| !t.2).map(|t| format!("{:?}", t.1)).collect();
            out(format!(r#"{{"ev":"toplevels","list":[{}]}}"#, l.join(",")));
        }
        "sync" => out(format!(r#"{{"ev":"synced","tag":{:?},"t":{:.4}}}"#, a.get(1).copied().unwrap_or(""), now())),
        "quit" => st.quit = true,
        _ => out(format!(r#"{{"ev":"unknown","line":{line:?}}}"#)),
    }
}

impl Capture {
    fn new(sess: cap_sess::ExtImageCopyCaptureSessionV1, use_dma: bool, alpha_log: bool) -> Capture {
        Capture {
            sess,
            info: SessInfo::default(),
            use_dma,
            bufs: vec![],
            next: 0,
            in_flight: None,
            frames: 0,
            failed: 0,
            damage_px: 0,
            started: Instant::now(),
            cpu0: cpu_secs(),
            last_ready: 0.0,
            pres_lat_ms: vec![],
            want_save: None,
            enc: None,
            enc_kind: None,
            alpha_log,
        }
    }
}

fn main() {
    gst::init().unwrap();
    let conn = Connection::connect_to_env().expect("WAYLAND_DISPLAY");
    let (globals, mut queue) = registry_queue_init::<State>(&conn).unwrap();
    let qh = queue.handle();
    let list = globals.contents().clone_list();
    let names: Vec<String> = list.iter().map(|g| format!("\"{} v{}\"", g.interface, g.version)).collect();
    out(format!(r#"{{"ev":"globals","list":[{}]}}"#, names.join(",")));

    let seat: wl_seat::WlSeat = globals.bind(&qh, 1..=7, ()).unwrap();
    let output: wl_output::WlOutput = globals.bind(&qh, 1..=4, ()).unwrap();
    let vpm: vp_mgr::ZwlrVirtualPointerManagerV1 = globals.bind(&qh, 1..=2, ()).unwrap();
    let ptr = vpm.create_virtual_pointer_with_output(Some(&seat), Some(&output), &qh, ());
    let vkm: vk_mgr::ZwpVirtualKeyboardManagerV1 = globals.bind(&qh, 1..=1, ()).unwrap();
    let kb = vkm.create_virtual_keyboard(&seat, &qh, ());
    let dev = std::fs::OpenOptions::new().read(true).write(true).open("/dev/dri/renderD128").unwrap();
    let gbm = unsafe { gbm_create_device(dev.as_raw_fd()) };
    std::mem::forget(dev);
    let mut st = State {
        shm: globals.bind(&qh, 1..=1, ()).unwrap(),
        seat,
        output,
        out_w: 0,
        out_h: 0,
        ptr,
        kb,
        mods: 0,
        src_mgr: globals.bind(&qh, 1..=1, ()).unwrap(),
        cap: globals.bind(&qh, 1..=1, ()).unwrap(),
        sc: globals.bind(&qh, 3..=3, ()).unwrap(),
        dmabuf: globals.bind(&qh, 3..=4, ()).unwrap(),
        om: globals.bind(&qh, 1..=4, ()).unwrap(),
        om_serial: 0,
        heads: vec![],
        gbm,
        main: None,
        cursor: None,
        cursor_sess: None,
        shots: vec![],
        sc_loop_frames: 0,
        sc_stop: false,
        tl_src: globals.bind(&qh, 1..=1, ()).unwrap(),
        _tl_list: globals.bind(&qh, 1..=1, ()).unwrap(),
        toplevels: vec![],
        t0: Instant::now(),
        quit: false,
    };
    queue.roundtrip(&mut st).unwrap();
    out(format!(r#"{{"ev":"ready","out_w":{},"out_h":{},"one_connection":true}}"#, st.out_w, st.out_h));

    // stdin reader thread + wake pipe so the poll loop sleeps on both.
    let (tx, rx) = mpsc::channel::<String>();
    let mut pipefd = [0i32; 2];
    unsafe { libc::pipe2(pipefd.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) };
    let wake_w = pipefd[1];
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(l) = line else { break };
            let _ = tx.send(l);
            unsafe { libc::write(wake_w, b"x".as_ptr() as *const _, 1) };
        }
        let _ = tx.send("quit".into());
        unsafe { libc::write(wake_w, b"x".as_ptr() as *const _, 1) };
    });

    while !st.quit {
        // Start encoders lazily once the first buffers exist.
        if let Some(c) = st.main.as_mut() {
            if c.enc.is_none() && !c.bufs.is_empty() {
                if let Some(k) = c.enc_kind.take() {
                    c.enc = Some(Encoder::new(&k, &c.bufs[0]));
                }
            }
        }
        conn.flush().ok();
        queue.dispatch_pending(&mut st).unwrap();
        conn.flush().ok();
        if let Some(guard) = queue.prepare_read() {
            let mut fds = [
                libc::pollfd { fd: guard.connection_fd().as_raw_fd(), events: libc::POLLIN, revents: 0 },
                libc::pollfd { fd: pipefd[0], events: libc::POLLIN, revents: 0 },
            ];
            unsafe { libc::poll(fds.as_mut_ptr(), 2, 50) };
            if fds[0].revents & libc::POLLIN != 0 {
                if let Err(e) = guard.read().or_else(|e| match &e {
                    wayland_client::backend::WaylandError::Io(io) if io.kind() == std::io::ErrorKind::WouldBlock => Ok(0),
                    _ => Err(e),
                }) {
                    out(format!(r#"{{"ev":"connection_lost","err":{:?},"proto":{:?}}}"#, e.to_string(), format!("{:?}", conn.protocol_error())));
                    break;
                }
            } else {
                drop(guard);
            }
            if fds[1].revents & libc::POLLIN != 0 {
                let mut b = [0u8; 256];
                unsafe { libc::read(pipefd[0], b.as_mut_ptr() as *mut _, b.len()) };
            }
        }
        queue.dispatch_pending(&mut st).unwrap();
        while let Ok(line) = rx.try_recv() {
            handle(&mut st, &line, &qh);
        }
    }
    if let Some(c) = st.main.as_mut() {
        if let Some(e) = c.enc.take() {
            let _ = e.pipeline.set_state(gst::State::Null);
        }
    }
    out(r#"{"ev":"bye"}"#.into());
}
