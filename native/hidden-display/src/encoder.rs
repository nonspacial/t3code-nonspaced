//! H.264 encoding with GStreamer: the encoder order, the startup probe, and the live pipeline.

use std::io::Write;
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::glib;
use gstreamer::prelude::*;
use gstreamer_allocators as gst_alloc;
use gstreamer_allocators::prelude::*;
use gstreamer_app as gst_app;
use gstreamer_video as gst_video;

use crate::control;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderKind {
    Nvidia,
    VaApi,
    X264,
    OpenH264,
}

/// Fastest first: NVENC, then VA-API, then the two software encoders.
pub const ENCODER_ORDER: [EncoderKind; 4] = [
    EncoderKind::Nvidia,
    EncoderKind::VaApi,
    EncoderKind::X264,
    EncoderKind::OpenH264,
];

/// Frames arrive only on change, but a variable frame rate (0/1) makes x264 hold every frame
/// back until the next one arrives, hiding the last change of a burst. A nominal rate avoids it.
const NOMINAL_FPS: u32 = 60;
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

impl EncoderKind {
    pub fn element(self) -> &'static str {
        match self {
            EncoderKind::Nvidia => "nvh264enc",
            EncoderKind::VaApi => "vah264enc",
            EncoderKind::X264 => "x264enc",
            EncoderKind::OpenH264 => "openh264enc",
        }
    }

    pub fn from_name(name: &str) -> Option<EncoderKind> {
        let alias = match name {
            "nv" | "nvidia" => "nvh264enc",
            "va" | "vaapi" => "vah264enc",
            "x264" => "x264enc",
            "openh264" => "openh264enc",
            other => other,
        };
        ENCODER_ORDER
            .into_iter()
            .find(|kind| kind.element() == alias)
    }

    /// Only NVENC takes captured DMABufs directly (through `glupload`).
    pub fn wants_dmabuf(self) -> bool {
        self == EncoderKind::Nvidia
    }

    fn bitrate_value(self, kbps: u32) -> u32 {
        match self {
            EncoderKind::OpenH264 => kbps.saturating_mul(1000),
            _ => kbps,
        }
    }

    /// Low latency, no B-frames, an endless GOP (keyframes come on request).
    fn encoder_description(self, kbps: u32) -> String {
        let bitrate = self.bitrate_value(kbps);
        match self {
            EncoderKind::Nvidia => format!(
                "nvh264enc name=enc preset=p4 tune=ultra-low-latency zerolatency=true bframes=0 \
                 gop-size=-1 rc-mode=cbr bitrate={bitrate}"
            ),
            EncoderKind::VaApi => format!(
                // 1024 is vah264enc's longest GOP.
                "vah264enc name=enc b-frames=0 key-int-max=1024 rate-control=cbr target-usage=6 \
                 bitrate={bitrate}"
            ),
            EncoderKind::X264 => format!(
                "x264enc name=enc tune=zerolatency speed-preset=superfast bframes=0 \
                 key-int-max=2147483647 sliced-threads=true bitrate={bitrate}"
            ),
            EncoderKind::OpenH264 => format!(
                "openh264enc name=enc usage-type=screen rate-control=bitrate gop-size=4294967295 \
                 bitrate={bitrate}"
            ),
        }
    }

    /// 4:2:0 input is what keeps every encoder off the 4:4:4 profiles.
    fn raw_upload(self) -> &'static str {
        match self {
            EncoderKind::Nvidia | EncoderKind::VaApi => "videoconvert ! video/x-raw,format=NV12",
            EncoderKind::X264 | EncoderKind::OpenH264 => "videoconvert ! video/x-raw,format=I420",
        }
    }

    fn output_caps(self) -> &'static str {
        match self {
            EncoderKind::OpenH264 => {
                "video/x-h264,stream-format=byte-stream,alignment=au,profile=constrained-baseline"
            }
            _ => "video/x-h264,stream-format=byte-stream,alignment=au,profile=high",
        }
    }

    /// The pipeline between `appsrc` and `appsink`. NVENC gets `glupload`, which imports
    /// captured DMABufs without a CPU copy (and uploads shared memory when that is all there is).
    /// There is deliberately no queue or `glcolorconvert` in front of it: together they took
    /// encode latency from 7.6 ms to 71 ms in the spike. `appsrc` holds at most one frame,
    /// replacing it with a newer one, which also bounds how many capture buffers GStreamer can
    /// hold at once (see `CAPTURE_BUFFERS`).
    pub fn pipeline_description(self, kbps: u32) -> String {
        format!(
            "appsrc name=src is-live=true format=time do-timestamp=false max-buffers=1 \
             leaky-type=downstream ! {} ! {} ! {} ! h264parse config-interval=-1 ! \
             appsink name=sink sync=false",
            self.upload(),
            self.encoder_description(kbps),
            self.output_caps(),
        )
    }

    fn upload(self) -> &'static str {
        if self.wants_dmabuf() {
            "glupload"
        } else {
            self.raw_upload()
        }
    }

    fn probe_description(self) -> String {
        format!(
            "videotestsrc num-buffers=3 ! video/x-raw,format=BGRx,width=320,height=240,framerate=30/1 ! \
             {} ! {} ! {} ! fakesink",
            self.upload(),
            self.encoder_description(2000),
            self.output_caps(),
        )
    }
}

/// Returns the first encoder in `order` that `works`.
pub fn pick_encoder(
    order: &[EncoderKind],
    mut works: impl FnMut(EncoderKind) -> bool,
) -> Option<EncoderKind> {
    order.iter().copied().find(|kind| works(*kind))
}

/// Encodes three test frames with `kind`; true when they reach the sink.
pub fn probe(kind: EncoderKind) -> bool {
    if gst::ElementFactory::find(kind.element()).is_none() {
        return false;
    }
    let Ok(pipeline) = gst::parse::launch(&kind.probe_description()) else {
        return false;
    };
    let Some(bus) = pipeline.bus() else {
        return false;
    };
    if pipeline.set_state(gst::State::Playing).is_err() {
        let _ = pipeline.set_state(gst::State::Null);
        return false;
    }
    let message = bus.timed_pop_filtered(
        gst::ClockTime::from_mseconds(PROBE_TIMEOUT.as_millis() as u64),
        &[gst::MessageType::Eos, gst::MessageType::Error],
    );
    let _ = pipeline.set_state(gst::State::Null);
    matches!(
        message.as_ref().map(|message| message.view()),
        Some(gst::MessageView::Eos(_))
    )
}

/// One captured frame, in the memory the capture filled.
pub enum Frame<'a> {
    System {
        data: &'a [u8],
        format: &'static str,
        width: u32,
        height: u32,
        stride: u32,
    },
    DmaBuf {
        fd: &'a OwnedFd,
        /// Set while GStreamer holds this capture buffer; see `clear_when_freed`.
        busy: &'a Arc<AtomicBool>,
        size: usize,
        offset: u32,
        stride: u32,
        modifier: u64,
        width: u32,
        height: u32,
    },
}

const DRM_FORMAT_XRGB8888: u32 = 0x3432_5258;

/// Marks a capture buffer busy until GStreamer frees the memory that wraps it, so the compositor
/// is never handed a buffer `glupload` may still be reading.
pub fn clear_when_freed(memory: &gst::MemoryRef, busy: Arc<AtomicBool>) {
    unsafe extern "C" fn freed(data: glib::ffi::gpointer, _: *mut gst::ffi::GstMiniObject) {
        let busy = unsafe { Box::from_raw(data.cast::<Arc<AtomicBool>>()) };
        busy.store(false, Ordering::Release);
    }
    busy.store(true, Ordering::Release);
    unsafe {
        gst::ffi::gst_mini_object_weak_ref(
            memory.as_ptr().cast_mut().cast(),
            Some(freed),
            Box::into_raw(Box::new(busy)).cast(),
        );
    }
}

/// GStreamer writes a linear buffer as plain `XR24` and rejects `XR24:0x0000000000000000`.
fn dmabuf_caps(modifier: u64, width: u32, height: u32) -> String {
    let drm_format = gst_video::dma_drm_fourcc_to_string(DRM_FORMAT_XRGB8888, modifier);
    format!(
        "video/x-raw(memory:DMABuf),format=DMA_DRM,drm-format={drm_format},\
         width={width},height={height},framerate={NOMINAL_FPS}/1"
    )
}

impl Frame<'_> {
    fn caps(&self) -> gst::Caps {
        match self {
            Frame::System { format, width, height, .. } => {
                format!("video/x-raw,format={format},width={width},height={height},framerate={NOMINAL_FPS}/1")
            }
            Frame::DmaBuf { modifier, width, height, .. } => dmabuf_caps(*modifier, *width, *height),
        }
        .parse()
        .expect("frame caps")
    }

    fn size(&self) -> (u32, u32) {
        match self {
            Frame::System { width, height, .. } | Frame::DmaBuf { width, height, .. } => {
                (*width, *height)
            }
        }
    }
}

pub type SharedOutput = Arc<Mutex<Box<dyn Write + Send>>>;

pub struct Encoder {
    pub kind: EncoderKind,
    pipeline: gst::Pipeline,
    src: gst_app::AppSrc,
    encoder: gst::Element,
    t0: Instant,
    caps: Option<gst::Caps>,
    last: Option<gst::Buffer>,
}

impl Encoder {
    pub fn new(
        kind: EncoderKind,
        kbps: u32,
        output: SharedOutput,
        output_closed: Arc<AtomicBool>,
        errors: impl Fn(String) + Send + 'static,
    ) -> Result<Encoder, String> {
        let pipeline = gst::parse::launch(&kind.pipeline_description(kbps))
            .map_err(|error| error.to_string())?
            .downcast::<gst::Pipeline>()
            .map_err(|_| "not a pipeline".to_string())?;
        let src = pipeline
            .by_name("src")
            .and_then(|element| element.downcast::<gst_app::AppSrc>().ok())
            .ok_or("missing appsrc")?;
        let sink = pipeline
            .by_name("sink")
            .and_then(|element| element.downcast::<gst_app::AppSink>().ok())
            .ok_or("missing appsink")?;
        let encoder = pipeline.by_name("enc").ok_or("missing encoder")?;
        sink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    let Some(buffer) = sample.buffer() else {
                        return Ok(gst::FlowSuccess::Ok);
                    };
                    let key = !buffer.flags().contains(gst::BufferFlags::DELTA_UNIT);
                    let pts_us = buffer.pts().map(|pts| pts.useconds()).unwrap_or(0);
                    let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                    let mut out = output.lock().unwrap();
                    if control::write_video(&mut *out, key, pts_us, &map).is_err() {
                        output_closed.store(true, Ordering::Relaxed);
                        return Err(gst::FlowError::Eos);
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        let bus = pipeline.bus().ok_or("missing bus")?;
        std::thread::spawn(move || {
            for message in bus.iter_timed(gst::ClockTime::NONE) {
                match message.view() {
                    gst::MessageView::Error(error) => {
                        errors(format!("{}: {:?}", error.error(), error.debug()))
                    }
                    gst::MessageView::Eos(_) => break,
                    _ => {}
                }
            }
        });
        pipeline
            .set_state(gst::State::Playing)
            .map_err(|error| error.to_string())?;
        Ok(Encoder {
            kind,
            pipeline,
            src,
            encoder,
            t0: Instant::now(),
            caps: None,
            last: None,
        })
    }

    /// Queues a captured frame. Returns true when its caps (size or format) changed.
    pub fn push(&mut self, frame: &Frame) -> bool {
        let caps = frame.caps();
        let resized = self.caps.as_ref() != Some(&caps);
        if resized {
            self.src.set_caps(Some(&caps));
            self.caps = Some(caps);
        }
        let mut buffer = match frame {
            Frame::System {
                data,
                stride,
                height,
                ..
            } => {
                let mut buffer =
                    gst::Buffer::from_slice(data[..(*stride * *height) as usize].to_vec());
                let (width, _) = frame.size();
                gst_video::VideoMeta::add_full(
                    buffer.get_mut().unwrap(),
                    gst_video::VideoFrameFlags::empty(),
                    video_format(frame),
                    width,
                    *height,
                    &[0],
                    &[*stride as i32],
                )
                .unwrap();
                buffer
            }
            Frame::DmaBuf {
                fd,
                busy,
                size,
                offset,
                stride,
                width,
                height,
                ..
            } => {
                let allocator = gst_alloc::DmaBufAllocator::new();
                let Ok(dup) = fd.try_clone() else {
                    return resized;
                };
                let Ok(memory) = (unsafe { allocator.alloc_dmabuf(dup, *size) }) else {
                    return resized;
                };
                clear_when_freed(&memory, Arc::clone(busy));
                let mut buffer = gst::Buffer::new();
                let buffer_mut = buffer.get_mut().unwrap();
                buffer_mut.append_memory(memory);
                gst_video::VideoMeta::add_full(
                    buffer_mut,
                    gst_video::VideoFrameFlags::empty(),
                    gst_video::VideoFormat::DmaDrm,
                    *width,
                    *height,
                    &[*offset as usize],
                    &[*stride as i32],
                )
                .unwrap();
                buffer
            }
        };
        self.stamp(&mut buffer);
        self.last = Some(buffer.clone());
        let _ = self.src.push_buffer(buffer);
        resized
    }

    /// Encodes the last frame again: a settle frame, or the carrier for a requested keyframe.
    pub fn repeat_last(&mut self) -> bool {
        let Some(last) = self.last.as_ref() else {
            return false;
        };
        let mut buffer = last.copy();
        self.stamp(&mut buffer);
        let _ = self.src.push_buffer(buffer);
        true
    }

    /// The next encoded frame will be a keyframe with SPS/PPS.
    pub fn request_keyframe(&self) {
        let event = gst_video::UpstreamForceKeyUnitEvent::builder()
            .all_headers(true)
            .build();
        if let Some(pad) = self.encoder.static_pad("src") {
            pad.send_event(event);
        }
    }

    pub fn set_bitrate(&self, kbps: u32) {
        self.encoder
            .set_property("bitrate", self.kind.bitrate_value(kbps.max(1)));
    }

    fn stamp(&self, buffer: &mut gst::Buffer) {
        let pts = gst::ClockTime::from_nseconds(self.t0.elapsed().as_nanos() as u64);
        buffer.get_mut().unwrap().set_pts(pts);
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn video_format(frame: &Frame) -> gst_video::VideoFormat {
    match frame {
        Frame::System { format, .. } => gst_video::VideoFormat::from_string(format),
        Frame::DmaBuf { .. } => gst_video::VideoFormat::DmaDrm,
    }
}

/// Settle frames: after the screen stops changing, encode the final image again so the soft
/// frames sent during motion are replaced by a sharp one.
pub struct Settle {
    delay: Duration,
    frames: u8,
    remaining: u8,
    deadline: Option<Instant>,
}

pub const SETTLE_DELAY: Duration = Duration::from_millis(150);
pub const SETTLE_FRAMES: u8 = 2;

impl Settle {
    pub fn new(delay: Duration, frames: u8) -> Settle {
        Settle {
            delay,
            frames,
            remaining: 0,
            deadline: None,
        }
    }

    /// A new captured frame (re)starts the countdown.
    pub fn on_frame(&mut self, now: Instant) {
        self.remaining = self.frames;
        self.deadline = (self.frames > 0).then_some(now + self.delay);
    }

    pub fn cancel(&mut self) {
        self.remaining = 0;
        self.deadline = None;
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    /// True when a settle frame is due now.
    pub fn poll(&mut self, now: Instant) -> bool {
        match self.deadline {
            Some(deadline) if now >= deadline => {
                self.remaining -= 1;
                self.deadline = (self.remaining > 0).then_some(now + self.delay);
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_buffer_stays_busy_until_gstreamer_frees_every_copy() {
        gst::init().unwrap();
        let busy = Arc::new(AtomicBool::new(false));
        let memory = gst::Memory::from_slice(vec![0u8; 16]);
        clear_when_freed(&memory, Arc::clone(&busy));
        let mut buffer = gst::Buffer::new();
        buffer.get_mut().unwrap().append_memory(memory);
        let settle_copy = buffer.copy();
        assert!(busy.load(Ordering::Acquire));
        drop(buffer);
        assert!(busy.load(Ordering::Acquire), "a settle copy still reads it");
        drop(settle_copy);
        assert!(!busy.load(Ordering::Acquire));
    }

    #[test]
    fn dmabuf_caps_name_linear_and_tiled_buffers_the_way_gstreamer_parses_them() {
        gst::init().unwrap();
        for (modifier, drm_format) in [
            (0, "drm-format=(string)XR24,"),
            (
                0x0300_0000_0060_6014,
                "drm-format=(string)XR24:0x0300000000606014,",
            ),
        ] {
            let caps: gst::Caps = dmabuf_caps(modifier, 64, 32)
                .parse()
                .expect("caps GStreamer parses");
            assert!(caps.to_string().contains(drm_format), "{caps}");
        }
    }

    #[test]
    fn tries_nvidia_then_vaapi_then_x264_then_openh264() {
        let mut tried = Vec::new();
        let picked = pick_encoder(&ENCODER_ORDER, |kind| {
            tried.push(kind);
            kind == EncoderKind::X264
        });
        assert_eq!(picked, Some(EncoderKind::X264));
        assert_eq!(
            tried,
            vec![EncoderKind::Nvidia, EncoderKind::VaApi, EncoderKind::X264]
        );
        assert_eq!(
            pick_encoder(&ENCODER_ORDER, |kind| kind == EncoderKind::OpenH264),
            Some(EncoderKind::OpenH264)
        );
        assert_eq!(pick_encoder(&ENCODER_ORDER, |_| false), None);
    }

    #[test]
    fn nvidia_dmabuf_goes_straight_from_glupload_to_nvh264enc() {
        let description = EncoderKind::Nvidia.pipeline_description(8000);
        assert!(
            description.contains("leaky-type=downstream ! glupload ! nvh264enc"),
            "{description}"
        );
        assert!(!description.contains("glcolorconvert"));
        assert!(!description.contains(" queue"));
        assert!(description.contains("bframes=0"));
        assert!(description.contains("bitrate=8000"));
    }

    #[test]
    fn every_encoder_is_420_without_b_frames() {
        for kind in ENCODER_ORDER {
            let description = kind.pipeline_description(4000);
            assert!(
                description.contains("format=NV12")
                    || description.contains("format=I420")
                    || kind == EncoderKind::Nvidia,
                "{description}"
            );
            assert!(
                description.contains("profile=high ")
                    || description.contains("profile=constrained-baseline "),
                "a 4:2:0 profile: {description}"
            );
            assert!(
                description.contains("bframes=0")
                    || description.contains("b-frames=0")
                    || kind == EncoderKind::OpenH264,
                "{description}"
            );
            assert!(!description.contains("4:4:4"));
            assert!(description.contains("stream-format=byte-stream,alignment=au"));
        }
    }

    #[test]
    fn openh264_bitrate_is_in_bits_per_second() {
        assert!(
            EncoderKind::OpenH264
                .pipeline_description(3)
                .contains("bitrate=3000")
        );
        assert!(
            EncoderKind::X264
                .pipeline_description(3)
                .contains("bitrate=3")
        );
    }

    #[test]
    fn encoder_names_parse() {
        assert_eq!(EncoderKind::from_name("x264enc"), Some(EncoderKind::X264));
        assert_eq!(EncoderKind::from_name("x264"), Some(EncoderKind::X264));
        assert_eq!(EncoderKind::from_name("nv"), Some(EncoderKind::Nvidia));
        assert_eq!(EncoderKind::from_name("va"), Some(EncoderKind::VaApi));
        assert_eq!(
            EncoderKind::from_name("openh264"),
            Some(EncoderKind::OpenH264)
        );
        assert_eq!(EncoderKind::from_name("ffmpeg"), None);
    }

    #[test]
    fn settle_sends_frames_after_motion_stops() {
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        let mut settle = Settle::new(Duration::from_millis(100), 2);
        assert_eq!(settle.deadline(), None);

        settle.on_frame(ms(0));
        settle.on_frame(ms(50));
        assert!(!settle.poll(ms(149)), "motion restarts the countdown");
        assert!(settle.poll(ms(150)));
        assert!(!settle.poll(ms(200)));
        assert!(settle.poll(ms(250)));
        assert_eq!(settle.deadline(), None, "two settle frames, then idle");
        assert!(!settle.poll(ms(10_000)));

        settle.on_frame(ms(20_000));
        settle.cancel();
        assert!(!settle.poll(ms(30_000)));
    }
}
