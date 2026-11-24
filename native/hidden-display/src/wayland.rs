//! One Wayland connection to the hidden display that does capture, cursor tracking, virtual
//! pointer and keyboard input, and output resizing.

use std::io::Write;
use std::os::fd::{AsFd, FromRawFd, OwnedFd};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use wayland_client::globals::{GlobalList, GlobalListContents};
use wayland_client::protocol::{
    wl_buffer, wl_output, wl_pointer, wl_registry, wl_seat, wl_shm, wl_shm_pool,
};
use wayland_client::{
    Connection, Dispatch, QueueHandle, WEnum, delegate_noop, event_created_child,
};
use wayland_protocols::ext::foreign_toplevel_list::v1::client::{
    ext_foreign_toplevel_handle_v1 as toplevel_handle,
    ext_foreign_toplevel_list_v1 as toplevel_list,
};
use wayland_protocols::ext::image_capture_source::v1::client::{
    ext_foreign_toplevel_image_capture_source_manager_v1 as toplevel_sources,
    ext_image_capture_source_v1 as source,
    ext_output_image_capture_source_manager_v1 as output_sources,
};
use wayland_protocols::ext::image_copy_capture::v1::client::{
    ext_image_copy_capture_cursor_session_v1 as cursor_session,
    ext_image_copy_capture_frame_v1 as capture_frame,
    ext_image_copy_capture_manager_v1 as capture_manager,
    ext_image_copy_capture_session_v1 as capture_session,
};
use wayland_protocols::wp::linux_dmabuf::zv1::client::{
    zwp_linux_buffer_params_v1 as dmabuf_params, zwp_linux_dmabuf_v1 as dmabuf,
};
use wayland_protocols_misc::zwp_virtual_keyboard_v1::client::{
    zwp_virtual_keyboard_manager_v1 as keyboard_manager,
    zwp_virtual_keyboard_v1 as virtual_keyboard,
};
use wayland_protocols_wlr::output_management::v1::client::{
    zwlr_output_configuration_head_v1 as configuration_head,
    zwlr_output_configuration_v1 as configuration, zwlr_output_head_v1 as output_head,
    zwlr_output_manager_v1 as output_manager, zwlr_output_mode_v1 as output_mode,
};
use wayland_protocols_wlr::screencopy::v1::client::{
    zwlr_screencopy_frame_v1 as screencopy_frame, zwlr_screencopy_manager_v1 as screencopy_manager,
};
use wayland_protocols_wlr::virtual_pointer::v1::client::{
    zwlr_virtual_pointer_manager_v1 as pointer_manager, zwlr_virtual_pointer_v1 as virtual_pointer,
};

use crate::control::{Axis, AxisSource, CaptureBackend, CaptureTarget, Command, Event};
use crate::encoder::{Encoder, Frame, SETTLE_DELAY, SETTLE_FRAMES, Settle};
use crate::gbm;
use crate::keyboard::Keyboard;

const DRM_FORMAT_XRGB8888: u32 = 0x3432_5258;
const DRM_FORMAT_MOD_INVALID: u64 = 0x00ff_ffff_ffff_ffff;
/// Enough for GStreamer to hold three (queued in `appsrc`, encoding, kept for settle frames)
/// while the compositor fills a fourth; `capture_next` skips any it still holds.
const CAPTURE_BUFFERS: usize = 4;
const CAPTURE_RETRY: Duration = Duration::from_millis(4);
const XKB_V1: u32 = 1;

/// The first buffer at or after `start`, round-robin, that GStreamer is not still reading.
fn next_free(start: usize, count: usize, busy: impl Fn(usize) -> bool) -> Option<usize> {
    (0..count)
        .map(|offset| (start + offset) % count)
        .find(|index| !busy(*index))
}

/// GStreamer's name for a `wl_shm` format, by byte order in memory.
pub fn shm_gst_format(format: u32) -> Option<&'static str> {
    use wl_shm::Format;
    let format = Format::try_from(format).ok()?;
    Some(match format {
        Format::Xrgb8888 => "BGRx",
        Format::Argb8888 => "BGRA",
        Format::Xbgr8888 => "RGBx",
        Format::Abgr8888 => "RGBA",
        Format::Bgr888 => "RGB",
        Format::Rgb888 => "BGR",
        _ => return None,
    })
}

/// The display size to use for a requested one: 4:2:0 encoders need even dimensions, so odd
/// ones round down. `None` when the request is unusable.
pub fn even_size(width: u32, height: u32) -> Option<(u32, u32)> {
    let valid = |n: u32| (2..=8192).contains(&n);
    (valid(width) && valid(height)).then_some((width & !1, height & !1))
}

fn bytes_per_pixel(format: u32) -> u32 {
    if matches!(shm_gst_format(format), Some("RGB" | "BGR")) {
        3
    } else {
        4
    }
}

fn memfd(name: &std::ffi::CStr, size: usize) -> std::io::Result<OwnedFd> {
    let fd = unsafe { libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    std::fs::File::from(fd.try_clone()?).set_len(size as u64)?;
    Ok(fd)
}

enum Memory {
    Shm {
        map: memmap2::MmapMut,
        format: u32,
        _fd: OwnedFd,
    },
    DmaBuf {
        plane: gbm::Plane,
        _bo: gbm::Bo,
        busy: Arc<AtomicBool>,
    },
}

struct Buffer {
    wl: wl_buffer::WlBuffer,
    memory: Memory,
    width: u32,
    height: u32,
    stride: u32,
}

impl Drop for Buffer {
    fn drop(&mut self) {
        self.wl.destroy();
    }
}

impl Buffer {
    fn busy(&self) -> bool {
        matches!(&self.memory, Memory::DmaBuf { busy, .. } if busy.load(Ordering::Acquire))
    }

    fn matches(&self, width: u32, height: u32, stride: u32, format: u32) -> bool {
        (self.width, self.height, self.stride) == (width, height, stride)
            && matches!(self.memory, Memory::Shm { format: current, .. } if current == format)
    }

    fn same_pixels(&self, other: &Buffer) -> bool {
        match (&self.memory, &other.memory) {
            (
                Memory::Shm {
                    map: a, format: fa, ..
                },
                Memory::Shm {
                    map: b, format: fb, ..
                },
            ) => {
                fa == fb
                    && (self.width, self.height, self.stride)
                        == (other.width, other.height, other.stride)
                    && a[..] == b[..]
            }
            _ => false,
        }
    }

    fn frame(&self) -> Frame<'_> {
        match &self.memory {
            Memory::Shm { map, format, .. } => Frame::System {
                data: map,
                format: shm_gst_format(*format).unwrap_or("BGRx"),
                width: self.width,
                height: self.height,
                stride: self.stride,
            },
            Memory::DmaBuf { plane, busy, .. } => Frame::DmaBuf {
                fd: &plane.fd,
                busy,
                size: plane.size,
                offset: plane.offset,
                stride: plane.stride,
                modifier: plane.modifier,
                width: self.width,
                height: self.height,
            },
        }
    }
}

#[derive(Default)]
struct Constraints {
    width: u32,
    height: u32,
    shm_formats: Vec<u32>,
    dmabuf_device: Option<u64>,
    dmabuf_modifiers: Vec<u64>,
}

enum Target {
    Output,
    Toplevel(toplevel_handle::ExtForeignToplevelHandleV1),
}

struct ExtCapture {
    session: capture_session::ExtImageCopyCaptureSessionV1,
    pending: Constraints,
    constraints: Option<Constraints>,
    /// Bumped on every `done`; a frame that fails for its constraints only retries once newer
    /// constraints have arrived.
    generation: u32,
    stale: bool,
    buffers: Vec<Buffer>,
    next: usize,
    in_flight: Option<(capture_frame::ExtImageCopyCaptureFrameV1, usize, u32)>,
}

impl Drop for ExtCapture {
    fn drop(&mut self) {
        if let Some((frame, ..)) = self.in_flight.take() {
            frame.destroy();
        }
        self.session.destroy();
    }
}

struct Screencopy {
    frame: screencopy_frame::ZwlrScreencopyFrameV1,
    offer: Option<(u32, u32, u32, u32)>,
    full: bool,
}

struct Toplevel {
    handle: toplevel_handle::ExtForeignToplevelHandleV1,
    title: String,
    closed: bool,
}

struct ExtGlobals {
    manager: capture_manager::ExtImageCopyCaptureManagerV1,
    output_sources: output_sources::ExtOutputImageCaptureSourceManagerV1,
    toplevel_sources: Option<toplevel_sources::ExtForeignToplevelImageCaptureSourceManagerV1>,
}

pub struct State {
    pub events: Vec<Event>,
    pub encoder: Encoder,
    pub settle: Settle,
    shm: wl_shm::WlShm,
    output: wl_output::WlOutput,
    output_size: (u32, u32),
    pending_output_size: (u32, u32),
    pointer: virtual_pointer::ZwlrVirtualPointerV1,
    keyboard: virtual_keyboard::ZwpVirtualKeyboardV1,
    xkb: Keyboard,
    output_manager: Option<output_manager::ZwlrOutputManagerV1>,
    output_serial: u32,
    heads: Vec<output_head::ZwlrOutputHeadV1>,
    ext: Option<ExtGlobals>,
    screencopy_manager: Option<screencopy_manager::ZwlrScreencopyManagerV1>,
    dmabuf: Option<dmabuf::ZwpLinuxDmabufV1>,
    gbm: Option<gbm::Device>,
    toplevels: Vec<Toplevel>,
    window_title: Option<String>,
    target: Option<Target>,
    ext_capture: Option<ExtCapture>,
    screencopy: Option<Screencopy>,
    /// Two buffers: the next copy lands in `screencopy_target`, the other holds the last frame
    /// sent. Older wlroots reports damage for pointer moves the copy never shows, so the
    /// fallback drops copies identical to the last frame sent.
    screencopy_buffers: [Option<Buffer>; 2],
    screencopy_target: usize,
    _cursor: Option<(
        cursor_session::ExtImageCopyCaptureCursorSessionV1,
        capture_session::ExtImageCopyCaptureSessionV1,
    )>,
    cursor_position: (i32, i32),
    cursor_entered: bool,
    paused: bool,
    capture_waiting: bool,
    t0: Instant,
}

pub struct Options {
    pub window_title: Option<String>,
    pub force_screencopy: bool,
}

impl State {
    pub fn new(
        globals: &GlobalList,
        qh: &QueueHandle<State>,
        encoder: Encoder,
        options: Options,
    ) -> Result<State, String> {
        fn bind_error(name: &'static str) -> impl Fn(wayland_client::globals::BindError) -> String {
            move |error| format!("{name}: {error}")
        }
        let seat: wl_seat::WlSeat = globals.bind(qh, 1..=7, ()).map_err(bind_error("wl_seat"))?;
        let output: wl_output::WlOutput = globals
            .bind(qh, 1..=4, ())
            .map_err(bind_error("wl_output"))?;
        let shm: wl_shm::WlShm = globals.bind(qh, 1..=1, ()).map_err(bind_error("wl_shm"))?;
        let pointers: pointer_manager::ZwlrVirtualPointerManagerV1 = globals
            .bind(qh, 2..=2, ())
            .map_err(bind_error("zwlr_virtual_pointer_manager_v1"))?;
        let pointer =
            pointers.create_virtual_pointer_with_output(Some(&seat), Some(&output), qh, ());
        let keyboards: keyboard_manager::ZwpVirtualKeyboardManagerV1 = globals
            .bind(qh, 1..=1, ())
            .map_err(bind_error("zwp_virtual_keyboard_manager_v1"))?;
        let keyboard = keyboards.create_virtual_keyboard(&seat, qh, ());

        let ext = (!options.force_screencopy)
            .then(|| {
                Some(ExtGlobals {
                    manager: globals.bind(qh, 1..=1, ()).ok()?,
                    output_sources: globals.bind(qh, 1..=1, ()).ok()?,
                    toplevel_sources: globals.bind(qh, 1..=1, ()).ok(),
                })
            })
            .flatten();
        let screencopy_manager = globals.bind(qh, 3..=3, ()).ok();
        if ext.is_none() && screencopy_manager.is_none() {
            return Err(
                "the compositor offers neither ext-image-copy-capture nor wlr-screencopy".into(),
            );
        }
        let toplevels_wanted = options.window_title.is_some()
            && ext
                .as_ref()
                .is_some_and(|ext| ext.toplevel_sources.is_some());
        if toplevels_wanted {
            let _list: toplevel_list::ExtForeignToplevelListV1 = globals
                .bind(qh, 1..=1, ())
                .map_err(bind_error("ext_foreign_toplevel_list_v1"))?;
        }

        let cursor = ext.as_ref().map(|ext| {
            let source = ext.output_sources.create_source(&output, qh, ());
            let seat_pointer = seat.get_pointer(qh, ());
            let cursor = ext
                .manager
                .create_pointer_cursor_session(&source, &seat_pointer, qh, ());
            // wlroots only reports enter/leave once the cursor's capture session exists.
            let session = cursor.get_capture_session(qh, CaptureKind::Cursor);
            (cursor, session)
        });

        let xkb = Keyboard::new("us", "", "", "")?;
        let mut state = State {
            events: Vec::new(),
            encoder,
            settle: Settle::new(SETTLE_DELAY, SETTLE_FRAMES),
            shm,
            output,
            output_size: (0, 0),
            pending_output_size: (0, 0),
            pointer,
            keyboard,
            xkb,
            output_manager: globals.bind(qh, 1..=4, ()).ok(),
            output_serial: 0,
            heads: Vec::new(),
            ext,
            screencopy_manager,
            dmabuf: globals.bind(qh, 3..=4, ()).ok(),
            gbm: None,
            toplevels: Vec::new(),
            window_title: if toplevels_wanted {
                options.window_title
            } else {
                None
            },
            target: None,
            ext_capture: None,
            screencopy: None,
            screencopy_buffers: [None, None],
            screencopy_target: 0,
            _cursor: cursor,
            cursor_position: (0, 0),
            cursor_entered: false,
            paused: false,
            capture_waiting: false,
            t0: Instant::now(),
        };
        state.send_keymap()?;
        if state.window_title.is_none() {
            state.target = Some(Target::Output);
        }
        Ok(state)
    }

    pub fn capture_backend(&self) -> CaptureBackend {
        if self.ext.is_some() {
            CaptureBackend::ExtImageCopyCapture
        } else {
            CaptureBackend::WlrScreencopy
        }
    }

    /// `window_title` survives only when the compositor can capture a single window.
    pub fn capture_target(&self) -> CaptureTarget {
        if self.window_title.is_some() {
            CaptureTarget::Window
        } else {
            CaptureTarget::Output
        }
    }

    pub fn cursor_tracking(&self) -> bool {
        self._cursor.is_some()
    }

    pub fn output_size(&self) -> (u32, u32) {
        self.output_size
    }

    /// Starts capturing once the target is known; call after the first roundtrip.
    pub fn start(&mut self, qh: &QueueHandle<State>) {
        self.restart_capture(qh);
    }

    fn time(&self) -> u32 {
        self.t0.elapsed().as_millis() as u32
    }

    fn send_keymap(&mut self) -> Result<(), String> {
        let mut text = self.xkb.keymap_text().as_bytes().to_vec();
        text.push(0);
        let fd = memfd(c"t3-keymap", text.len()).map_err(|error| error.to_string())?;
        std::fs::File::from(fd.try_clone().map_err(|error| error.to_string())?)
            .write_all(&text)
            .map_err(|error| error.to_string())?;
        self.keyboard.keymap(XKB_V1, fd.as_fd(), text.len() as u32);
        Ok(())
    }

    pub fn handle(&mut self, command: Command, qh: &QueueHandle<State>) {
        let time = self.time();
        match command {
            Command::Keyframe => {
                self.encoder.request_keyframe();
                if !self.paused {
                    self.encoder.repeat_last();
                }
            }
            Command::Bitrate { kbps } => self.encoder.set_bitrate(kbps),
            Command::Pause => {
                self.paused = true;
                self.settle.cancel();
                self.ext_capture = None;
                if let Some(copy) = self.screencopy.take() {
                    copy.frame.destroy();
                }
            }
            Command::Resume => {
                if self.paused {
                    self.paused = false;
                    self.encoder.request_keyframe();
                    self.restart_capture(qh);
                }
            }
            Command::Resize { width, height } => self.resize(width, height, qh),
            Command::PointerMotion { dx, dy } => {
                self.pointer.motion(time, dx, dy);
                self.pointer.frame();
            }
            Command::PointerPosition { x, y } => {
                let (width, height) = self.output_size;
                if width > 0 && height > 0 {
                    let x = x.clamp(0.0, (width - 1) as f64) as u32;
                    let y = y.clamp(0.0, (height - 1) as f64) as u32;
                    self.pointer.motion_absolute(time, x, y, width, height);
                    self.pointer.frame();
                }
            }
            Command::PointerButton { button, pressed } => {
                let state = if pressed {
                    wl_pointer::ButtonState::Pressed
                } else {
                    wl_pointer::ButtonState::Released
                };
                self.pointer.button(time, button, state);
                self.pointer.frame();
            }
            Command::PointerAxis {
                axis,
                value,
                discrete,
                source,
            } => {
                let axis = match axis {
                    Axis::Vertical => wl_pointer::Axis::VerticalScroll,
                    Axis::Horizontal => wl_pointer::Axis::HorizontalScroll,
                };
                self.pointer.axis_source(match source {
                    AxisSource::Wheel => wl_pointer::AxisSource::Wheel,
                    AxisSource::Finger => wl_pointer::AxisSource::Finger,
                    AxisSource::Continuous => wl_pointer::AxisSource::Continuous,
                });
                match discrete {
                    Some(steps) => self.pointer.axis_discrete(time, axis, value, steps),
                    None if value == 0.0 => self.pointer.axis_stop(time, axis),
                    None => self.pointer.axis(time, axis, value),
                }
                self.pointer.frame();
            }
            Command::Key { code, pressed } => {
                self.keyboard.key(time, code, u32::from(pressed));
                if let Some(modifiers) = self.xkb.key(code, pressed) {
                    self.keyboard.modifiers(
                        modifiers.depressed,
                        modifiers.latched,
                        modifiers.locked,
                        modifiers.group,
                    );
                }
            }
            Command::Keymap {
                layout,
                variant,
                model,
                options,
            } => match Keyboard::new(&layout, &variant, &model, &options) {
                Ok(xkb) => {
                    self.xkb = xkb;
                    if let Err(message) = self.send_keymap() {
                        self.events.push(Event::Error { message });
                    }
                }
                Err(message) => self.events.push(Event::Error { message }),
            },
            Command::Detach | Command::Quit => {}
        }
    }

    pub fn resize(&mut self, width: u32, height: u32, qh: &QueueHandle<State>) {
        let (Some(manager), Some(head)) = (self.output_manager.as_ref(), self.heads.first()) else {
            self.events.push(Event::Error {
                message: "the compositor cannot resize its output".into(),
            });
            return;
        };
        let Some((width, height)) = even_size(width, height) else {
            self.events.push(Event::Error {
                message: format!("invalid size {width}x{height}"),
            });
            return;
        };
        let config = manager.create_configuration(self.output_serial, qh, ());
        let head = config.enable_head(head, qh, ());
        head.set_custom_mode(width as i32, height as i32, 0);
        config.apply();
    }

    /// Reports a cursor `enter` once the batch it arrived in, which may move it, is dispatched.
    pub fn flush_cursor(&mut self) {
        if std::mem::take(&mut self.cursor_entered) {
            let (x, y) = self.cursor_position;
            self.events.push(Event::CursorEnter { x, y });
        }
    }

    /// Sends a settle frame when one is due.
    pub fn tick(&mut self, now: Instant, qh: &QueueHandle<State>) {
        if !self.paused && self.settle.poll(now) {
            self.encoder.repeat_last();
        }
        if std::mem::take(&mut self.capture_waiting) {
            self.capture_next(qh);
        }
    }

    /// How soon the loop must call `tick` again.
    pub fn next_tick(&self, now: Instant) -> Option<Duration> {
        let settle = self
            .settle
            .deadline()
            .map(|deadline| deadline.saturating_duration_since(now));
        let retry = self.capture_waiting.then_some(CAPTURE_RETRY);
        settle.into_iter().chain(retry).min()
    }

    fn restart_capture(&mut self, qh: &QueueHandle<State>) {
        if self.paused {
            return;
        }
        if let Some(ext) = self.ext.as_ref() {
            let source = match self.target.as_ref() {
                Some(Target::Output) => ext.output_sources.create_source(&self.output, qh, ()),
                Some(Target::Toplevel(handle)) => match ext.toplevel_sources.as_ref() {
                    Some(sources) => sources.create_source(handle, qh, ()),
                    None => return,
                },
                None => return,
            };
            // No paint_cursors: with it the cursor session reports leave and never comes back.
            let session = ext.manager.create_session(
                &source,
                capture_manager::Options::empty(),
                qh,
                CaptureKind::Main,
            );
            source.destroy();
            self.ext_capture = Some(ExtCapture {
                session,
                pending: Constraints::default(),
                constraints: None,
                generation: 0,
                stale: true,
                buffers: Vec::new(),
                next: 0,
                in_flight: None,
            });
        } else {
            self.request_screencopy(true, qh);
        }
    }

    fn request_screencopy(&mut self, full: bool, qh: &QueueHandle<State>) {
        if self.paused || self.screencopy.is_some() {
            return;
        }
        let Some(manager) = self.screencopy_manager.as_ref() else {
            return;
        };
        let frame = manager.capture_output(0, &self.output, qh, ());
        self.screencopy = Some(Screencopy {
            frame,
            offer: None,
            full,
        });
    }

    fn allocate(&mut self, constraints: &Constraints, qh: &QueueHandle<State>) -> Vec<Buffer> {
        let dmabuf = if self.encoder.kind.wants_dmabuf() {
            self.allocate_dmabuf(constraints, qh)
        } else {
            None
        };
        dmabuf.unwrap_or_else(|| {
            let preferred = [
                wl_shm::Format::Xrgb8888,
                wl_shm::Format::Xbgr8888,
                wl_shm::Format::Argb8888,
                wl_shm::Format::Abgr8888,
            ]
            .into_iter()
            .map(|format| format as u32)
            .find(|format| constraints.shm_formats.contains(format))
            .or_else(|| {
                constraints
                    .shm_formats
                    .iter()
                    .copied()
                    .find(|format| shm_gst_format(*format).is_some())
            });
            let Some(format) = preferred else {
                return Vec::new();
            };
            let stride = constraints.width * bytes_per_pixel(format);
            (0..CAPTURE_BUFFERS)
                .filter_map(|_| {
                    self.shm_buffer(constraints.width, constraints.height, stride, format, qh)
                })
                .collect()
        })
    }

    fn allocate_dmabuf(
        &mut self,
        constraints: &Constraints,
        qh: &QueueHandle<State>,
    ) -> Option<Vec<Buffer>> {
        let dmabuf = self.dmabuf.as_ref()?;
        if self.gbm.is_none() {
            self.gbm = gbm::Device::open(constraints.dmabuf_device?);
        }
        let device = self.gbm.as_ref()?;
        let mut buffers = Vec::new();
        for _ in 0..CAPTURE_BUFFERS {
            let (bo, plane) = device.allocate(
                constraints.width,
                constraints.height,
                DRM_FORMAT_XRGB8888,
                &constraints.dmabuf_modifiers,
            )?;
            let params = dmabuf.create_params(qh, ());
            params.add(
                plane.fd.as_fd(),
                0,
                plane.offset,
                plane.stride,
                (plane.modifier >> 32) as u32,
                plane.modifier as u32,
            );
            let wl = params.create_immed(
                constraints.width as i32,
                constraints.height as i32,
                DRM_FORMAT_XRGB8888,
                dmabuf_params::Flags::empty(),
                qh,
                (),
            );
            params.destroy();
            let stride = plane.stride;
            buffers.push(Buffer {
                wl,
                memory: Memory::DmaBuf {
                    plane,
                    _bo: bo,
                    busy: Arc::new(AtomicBool::new(false)),
                },
                width: constraints.width,
                height: constraints.height,
                stride,
            });
        }
        Some(buffers)
    }

    fn shm_buffer(
        &self,
        width: u32,
        height: u32,
        stride: u32,
        format: u32,
        qh: &QueueHandle<State>,
    ) -> Option<Buffer> {
        let size = (stride * height) as usize;
        let fd = memfd(c"t3-capture", size).ok()?;
        let map = unsafe { memmap2::MmapMut::map_mut(&std::fs::File::from(fd.try_clone().ok()?)) }
            .ok()?;
        let pool = self.shm.create_pool(fd.as_fd(), size as i32, qh, ());
        let wl = pool.create_buffer(
            0,
            width as i32,
            height as i32,
            stride as i32,
            wl_shm::Format::try_from(format).ok()?,
            qh,
            (),
        );
        pool.destroy();
        Some(Buffer {
            wl,
            memory: Memory::Shm {
                map,
                format,
                _fd: fd,
            },
            width,
            height,
            stride,
        })
    }

    fn capture_next(&mut self, qh: &QueueHandle<State>) {
        if self.paused {
            return;
        }
        let Some(capture) = self.ext_capture.as_mut() else {
            return;
        };
        if capture.in_flight.is_some() {
            return;
        }
        if capture.stale || capture.buffers.is_empty() {
            let Some(constraints) = capture.constraints.take() else {
                return;
            };
            capture.buffers.clear();
            let buffers = self.allocate(&constraints, qh);
            let capture = self.ext_capture.as_mut().unwrap();
            capture.constraints = Some(constraints);
            capture.buffers = buffers;
            capture.next = 0;
            capture.stale = false;
            if capture.buffers.is_empty() {
                self.events.push(Event::Error {
                    message: "no usable capture buffer format".into(),
                });
                return;
            }
        }
        let capture = self.ext_capture.as_mut().unwrap();
        let Some(index) = next_free(capture.next, capture.buffers.len(), |index| {
            capture.buffers[index].busy()
        }) else {
            // Every buffer is still in GStreamer's hands; `tick` tries again shortly.
            self.capture_waiting = true;
            return;
        };
        self.capture_waiting = false;
        capture.next = (index + 1) % capture.buffers.len();
        let buffer = &capture.buffers[index];
        let frame = capture.session.create_frame(qh, CaptureKind::Main);
        frame.attach_buffer(&buffer.wl);
        frame.damage_buffer(0, 0, buffer.width as i32, buffer.height as i32);
        frame.capture();
        capture.in_flight = Some((frame, index, capture.generation));
    }

    fn encode(&mut self, frame: Frame) {
        let size = match frame {
            Frame::System { width, height, .. } | Frame::DmaBuf { width, height, .. } => {
                (width, height)
            }
        };
        if self.encoder.push(&frame) {
            self.events.push(Event::FrameSize {
                width: size.0,
                height: size.1,
            });
        }
        self.settle.on_frame(Instant::now());
    }

    fn match_toplevel(&mut self, qh: &QueueHandle<State>) {
        if self.target.is_some() {
            return;
        }
        let Some(title) = self.window_title.as_deref() else {
            return;
        };
        let Some(toplevel) = self
            .toplevels
            .iter()
            .find(|toplevel| !toplevel.closed && toplevel.title.contains(title))
        else {
            return;
        };
        self.events.push(Event::WindowCaptured {
            title: toplevel.title.clone(),
        });
        self.target = Some(Target::Toplevel(toplevel.handle.clone()));
        self.restart_capture(qh);
    }

    fn target_lost(&mut self, qh: &QueueHandle<State>) {
        self.ext_capture = None;
        self.settle.cancel();
        if matches!(self.target, Some(Target::Toplevel(_))) {
            self.target = None;
            self.events.push(Event::WindowClosed);
            self.match_toplevel(qh);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CaptureKind {
    Main,
    Cursor,
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_output::WlOutput, ()> for State {
    fn event(
        state: &mut Self,
        _: &wl_output::WlOutput,
        event: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wl_output::Event::Mode {
                flags: WEnum::Value(flags),
                width,
                height,
                ..
            } if flags.contains(wl_output::Mode::Current) => {
                state.pending_output_size = (width as u32, height as u32);
            }
            wl_output::Event::Done if state.pending_output_size != state.output_size => {
                let first = state.output_size == (0, 0);
                state.output_size = state.pending_output_size;
                if !first {
                    let (width, height) = state.output_size;
                    state.events.push(Event::Resized { width, height });
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<capture_session::ExtImageCopyCaptureSessionV1, CaptureKind> for State {
    fn event(
        state: &mut Self,
        session: &capture_session::ExtImageCopyCaptureSessionV1,
        event: capture_session::Event,
        kind: &CaptureKind,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if *kind != CaptureKind::Main {
            return;
        }
        let Some(capture) = state
            .ext_capture
            .as_mut()
            .filter(|capture| &capture.session == session)
        else {
            return;
        };
        match event {
            capture_session::Event::BufferSize { width, height } => {
                capture.pending.width = width;
                capture.pending.height = height;
            }
            capture_session::Event::ShmFormat {
                format: WEnum::Value(format),
            } => capture.pending.shm_formats.push(format as u32),
            capture_session::Event::DmabufDevice { device } => {
                capture.pending.dmabuf_device = device
                    .get(..8)
                    .map(|bytes| u64::from_ne_bytes(bytes.try_into().unwrap()));
            }
            capture_session::Event::DmabufFormat { format, modifiers }
                if format == DRM_FORMAT_XRGB8888 =>
            {
                capture.pending.dmabuf_modifiers = modifiers
                    .as_chunks::<8>()
                    .0
                    .iter()
                    .map(|chunk| u64::from_ne_bytes(*chunk))
                    .filter(|modifier| *modifier != DRM_FORMAT_MOD_INVALID)
                    .collect();
            }
            capture_session::Event::Done => {
                capture.constraints = Some(std::mem::take(&mut capture.pending));
                capture.generation += 1;
                capture.stale = true;
                state.capture_next(qh);
            }
            capture_session::Event::Stopped => state.target_lost(qh),
            _ => {}
        }
    }
}

impl Dispatch<capture_frame::ExtImageCopyCaptureFrameV1, CaptureKind> for State {
    fn event(
        state: &mut Self,
        frame: &capture_frame::ExtImageCopyCaptureFrameV1,
        event: capture_frame::Event,
        _: &CaptureKind,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        let Some(capture) = state.ext_capture.as_mut() else {
            return;
        };
        let Some((index, generation)) = capture
            .in_flight
            .as_ref()
            .filter(|(current, ..)| current == frame)
            .map(|(_, index, generation)| (*index, *generation))
        else {
            return;
        };
        match event {
            capture_frame::Event::Ready => {
                capture.in_flight = None;
                frame.destroy();
                let capture = state.ext_capture.take().unwrap();
                state.encode(capture.buffers[index].frame());
                state.ext_capture = Some(capture);
                state.capture_next(qh);
            }
            capture_frame::Event::Failed { reason } => {
                capture.in_flight = None;
                frame.destroy();
                match reason {
                    // New constraints (e.g. after a resize) come with their own `done`.
                    WEnum::Value(capture_frame::FailureReason::BufferConstraints)
                        if capture.generation == generation =>
                    {
                        capture.stale = true
                    }
                    WEnum::Value(capture_frame::FailureReason::Stopped) => {}
                    _ => state.capture_next(qh),
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<cursor_session::ExtImageCopyCaptureCursorSessionV1, ()> for State {
    fn event(
        state: &mut Self,
        _: &cursor_session::ExtImageCopyCaptureCursorSessionV1,
        event: cursor_session::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            cursor_session::Event::Leave => state.events.push(Event::CursorLeave),
            cursor_session::Event::Enter => state.cursor_entered = true,
            // Only sent when it changes, possibly just after `enter`; see `flush_cursor`.
            cursor_session::Event::Position { x, y } => state.cursor_position = (x, y),
            _ => {}
        }
    }
}

impl Dispatch<screencopy_frame::ZwlrScreencopyFrameV1, ()> for State {
    fn event(
        state: &mut Self,
        frame: &screencopy_frame::ZwlrScreencopyFrameV1,
        event: screencopy_frame::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        let Some(copy) = state
            .screencopy
            .as_mut()
            .filter(|copy| &copy.frame == frame)
        else {
            return;
        };
        match event {
            screencopy_frame::Event::Buffer {
                format: WEnum::Value(format),
                width,
                height,
                stride,
            } => {
                let format = format as u32;
                if shm_gst_format(format).is_some()
                    && (copy.offer.is_none() || format == wl_shm::Format::Xrgb8888 as u32)
                {
                    copy.offer = Some((format, width, height, stride));
                }
            }
            screencopy_frame::Event::BufferDone => {
                let Some((format, width, height, stride)) = copy.offer else {
                    state.events.push(Event::Error {
                        message: "no usable screencopy format".into(),
                    });
                    return;
                };
                let full = copy.full;
                let target = state.screencopy_target;
                let reusable = state.screencopy_buffers[target]
                    .as_ref()
                    .is_some_and(|buffer| buffer.matches(width, height, stride, format));
                if !reusable {
                    state.screencopy_buffers[target] =
                        state.shm_buffer(width, height, stride, format, qh);
                }
                let Some(buffer) = state.screencopy_buffers[target].as_ref() else {
                    return;
                };
                if full {
                    frame.copy(&buffer.wl)
                } else {
                    frame.copy_with_damage(&buffer.wl)
                }
            }
            screencopy_frame::Event::Ready { .. } => {
                let full = copy.full;
                state.screencopy = None;
                frame.destroy();
                let target = state.screencopy_target;
                let [first, second] = &state.screencopy_buffers;
                let (copied, previous) = if target == 0 {
                    (first, second)
                } else {
                    (second, first)
                };
                let unchanged = !full
                    && copied
                        .as_ref()
                        .zip(previous.as_ref())
                        .is_some_and(|(copied, previous)| copied.same_pixels(previous));
                if !unchanged && let Some(buffer) = state.screencopy_buffers[target].take() {
                    state.encode(buffer.frame());
                    state.screencopy_buffers[target] = Some(buffer);
                    state.screencopy_target = 1 - target;
                }
                state.request_screencopy(false, qh);
            }
            screencopy_frame::Event::Failed => {
                state.screencopy = None;
                frame.destroy();
                state.request_screencopy(true, qh);
            }
            _ => {}
        }
    }
}

impl Dispatch<output_manager::ZwlrOutputManagerV1, ()> for State {
    fn event(
        state: &mut Self,
        _: &output_manager::ZwlrOutputManagerV1,
        event: output_manager::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            output_manager::Event::Head { head } => state.heads.push(head),
            output_manager::Event::Done { serial } => state.output_serial = serial,
            _ => {}
        }
    }
    event_created_child!(State, output_manager::ZwlrOutputManagerV1, [output_manager::EVT_HEAD_OPCODE => (output_head::ZwlrOutputHeadV1, ())]);
}

impl Dispatch<output_head::ZwlrOutputHeadV1, ()> for State {
    fn event(
        state: &mut Self,
        head: &output_head::ZwlrOutputHeadV1,
        event: output_head::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let output_head::Event::Finished = event {
            state.heads.retain(|current| current != head);
        }
    }
    event_created_child!(State, output_head::ZwlrOutputHeadV1, [output_head::EVT_MODE_OPCODE => (output_mode::ZwlrOutputModeV1, ())]);
}

impl Dispatch<configuration::ZwlrOutputConfigurationV1, ()> for State {
    fn event(
        state: &mut Self,
        config: &configuration::ZwlrOutputConfigurationV1,
        event: configuration::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            configuration::Event::Failed => state.events.push(Event::Error {
                message: "the compositor refused the resize".into(),
            }),
            configuration::Event::Cancelled => state.events.push(Event::Error {
                message: "the resize was cancelled; try again".into(),
            }),
            _ => {}
        }
        config.destroy();
    }
}

impl Dispatch<toplevel_list::ExtForeignToplevelListV1, ()> for State {
    fn event(
        state: &mut Self,
        _: &toplevel_list::ExtForeignToplevelListV1,
        event: toplevel_list::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let toplevel_list::Event::Toplevel { toplevel } = event {
            state.toplevels.push(Toplevel {
                handle: toplevel,
                title: String::new(),
                closed: false,
            });
        }
    }
    event_created_child!(State, toplevel_list::ExtForeignToplevelListV1, [toplevel_list::EVT_TOPLEVEL_OPCODE => (toplevel_handle::ExtForeignToplevelHandleV1, ())]);
}

impl Dispatch<toplevel_handle::ExtForeignToplevelHandleV1, ()> for State {
    fn event(
        state: &mut Self,
        handle: &toplevel_handle::ExtForeignToplevelHandleV1,
        event: toplevel_handle::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        let Some(toplevel) = state
            .toplevels
            .iter_mut()
            .find(|toplevel| &toplevel.handle == handle)
        else {
            return;
        };
        match event {
            toplevel_handle::Event::Title { title } => toplevel.title = title,
            toplevel_handle::Event::Done => state.match_toplevel(qh),
            toplevel_handle::Event::Closed => {
                toplevel.closed = true;
                handle.destroy();
                state.toplevels.retain(|toplevel| !toplevel.closed);
                if matches!(&state.target, Some(Target::Toplevel(current)) if current == handle) {
                    state.target_lost(qh);
                }
            }
            _ => {}
        }
    }
}

delegate_noop!(State: ignore wl_shm::WlShm);
delegate_noop!(State: ignore wl_shm_pool::WlShmPool);
delegate_noop!(State: ignore wl_buffer::WlBuffer);
delegate_noop!(State: ignore wl_seat::WlSeat);
delegate_noop!(State: ignore wl_pointer::WlPointer);
delegate_noop!(State: ignore pointer_manager::ZwlrVirtualPointerManagerV1);
delegate_noop!(State: ignore virtual_pointer::ZwlrVirtualPointerV1);
delegate_noop!(State: ignore keyboard_manager::ZwpVirtualKeyboardManagerV1);
delegate_noop!(State: ignore virtual_keyboard::ZwpVirtualKeyboardV1);
delegate_noop!(State: ignore output_sources::ExtOutputImageCaptureSourceManagerV1);
delegate_noop!(State: ignore toplevel_sources::ExtForeignToplevelImageCaptureSourceManagerV1);
delegate_noop!(State: ignore source::ExtImageCaptureSourceV1);
delegate_noop!(State: ignore capture_manager::ExtImageCopyCaptureManagerV1);
delegate_noop!(State: ignore screencopy_manager::ZwlrScreencopyManagerV1);
delegate_noop!(State: ignore dmabuf::ZwpLinuxDmabufV1);
delegate_noop!(State: ignore dmabuf_params::ZwpLinuxBufferParamsV1);
delegate_noop!(State: ignore output_mode::ZwlrOutputModeV1);
delegate_noop!(State: ignore configuration_head::ZwlrOutputConfigurationHeadV1);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_skips_buffers_gstreamer_still_holds() {
        let busy = [true, false, true, false];
        assert_eq!(next_free(0, 4, |index| busy[index]), Some(1));
        assert_eq!(next_free(2, 4, |index| busy[index]), Some(3));
        assert_eq!(next_free(3, 4, |index| busy[index]), Some(3));
        assert_eq!(next_free(0, 4, |_| true), None, "all busy: wait");
        assert_eq!(next_free(0, 0, |_| false), None);
    }

    #[test]
    fn rounds_display_sizes_down_to_even() {
        assert_eq!(even_size(801, 601), Some((800, 600)));
        assert_eq!(even_size(1280, 720), Some((1280, 720)));
        assert_eq!(even_size(3, 2), Some((2, 2)));
        assert_eq!(even_size(1, 600), None);
        assert_eq!(even_size(8193, 600), None);
    }

    #[test]
    fn maps_shm_formats_to_gstreamer_byte_order() {
        assert_eq!(
            shm_gst_format(wl_shm::Format::Xrgb8888 as u32),
            Some("BGRx")
        );
        assert_eq!(
            shm_gst_format(wl_shm::Format::Xbgr8888 as u32),
            Some("RGBx")
        );
        assert_eq!(shm_gst_format(wl_shm::Format::Bgr888 as u32), Some("RGB"));
        assert_eq!(shm_gst_format(wl_shm::Format::Nv12 as u32), None);
        assert_eq!(bytes_per_pixel(wl_shm::Format::Bgr888 as u32), 3);
        assert_eq!(bytes_per_pixel(wl_shm::Format::Xbgr8888 as u32), 4);
    }
}
