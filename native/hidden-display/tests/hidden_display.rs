//! Runs the helper on a real headless labwc with the pixman renderer and x264, so no GPU is
//! needed, against the GPU-free test client in `examples/test_client.rs`.

mod support;

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::h264;

const TITLE: &str = "t3-test-window";
/// Guards against hangs only; every wait below ends on the event it is waiting for.
const HANG_GUARD: Duration = Duration::from_secs(20);
/// Settle frames go out 150 and 300 ms after the last change.
const QUIET: Duration = Duration::from_millis(700);
/// How long the display must stay silent to count as idle.
const IDLE: Duration = Duration::from_millis(1000);

#[derive(Debug, Clone)]
enum Packet {
    Event(Value),
    Video { key: bool, access_unit: Vec<u8> },
}

fn read_packet(input: &mut impl Read) -> Option<Packet> {
    let mut length = [0u8; 4];
    input.read_exact(&mut length).ok()?;
    let mut body = vec![0u8; u32::from_be_bytes(length) as usize];
    input.read_exact(&mut body).ok()?;
    match body[0] {
        1 => Some(Packet::Event(
            serde_json::from_slice(&body[1..]).expect("event JSON"),
        )),
        2 => {
            let semu = &body[1..];
            assert_eq!(&semu[0..4], b"SEMU");
            Some(Packet::Video {
                key: semu[5] & 1 == 1,
                access_unit: semu[16..].to_vec(),
            })
        }
        kind => panic!("unknown packet kind {kind}"),
    }
}

fn which(program: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(program).is_file()))
}

fn has_x264() -> bool {
    gstreamer::init().is_ok() && gstreamer::ElementFactory::find("x264enc").is_some()
}

fn test_client() -> PathBuf {
    // `cargo test` builds examples into `examples/` beside the binary it tests.
    let helper = PathBuf::from(env!("CARGO_BIN_EXE_t3-hidden-display"));
    helper
        .parent()
        .unwrap()
        .join("examples")
        .join("test_client")
}

struct Helper {
    child: Child,
    stdin: ChildStdin,
    packets: Receiver<Packet>,
    log: Receiver<String>,
    seen: Vec<Packet>,
    mark: usize,
    _state: tempfile::TempDir,
}

impl Helper {
    fn start(capture: &str) -> Helper {
        Helper::start_with(capture, "x264enc", false)
    }

    /// `gpu` leaves labwc on its GPU renderer, so NVENC captures into DMABufs.
    fn start_with(capture: &str, encoder: &str, gpu: bool) -> Helper {
        let state = tempfile::tempdir().unwrap();
        // Deeper than a Unix socket path may be, as T3's real state directories can be.
        let state_dir = state.path().join("a-state-directory-nested-deep".repeat(4));
        std::fs::create_dir(&state_dir).unwrap();
        let log_path = state_dir.join("client.log");
        let fifo = std::ffi::CString::new(log_path.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);

        let mut command = Command::new(env!("CARGO_BIN_EXE_t3-hidden-display"));
        command
            .args([
                "--state-dir",
                state_dir.to_str().unwrap(),
                "--window-title",
                TITLE,
            ])
            .args([
                "--width",
                "640",
                "--height",
                "480",
                "--encoder",
                encoder,
                "--capture",
                capture,
                "--",
            ])
            .arg(test_client())
            .args([TITLE, log_path.to_str().unwrap()])
            .env("T3CODE_THREAD_ID", "must-not-leak")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        if !gpu {
            command.env("WLR_RENDERER", "pixman");
        }
        let mut child = command.spawn().expect("start the helper");
        let stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (packet_sender, packets) = channel();
        std::thread::spawn(move || {
            while let Some(packet) = read_packet(&mut stdout) {
                if packet_sender.send(packet).is_err() {
                    break;
                }
            }
        });
        let (log_sender, log) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(std::fs::File::open(&log_path).unwrap()).lines() {
                let Ok(line) = line else { break };
                if log_sender.send(line).is_err() {
                    break;
                }
            }
        });
        Helper {
            child,
            stdin,
            packets,
            log,
            seen: Vec::new(),
            mark: 0,
            _state: state,
        }
    }

    fn send(&mut self, command: Value) {
        writeln!(self.stdin, "{command}").unwrap();
        self.stdin.flush().unwrap();
    }

    fn receive(&mut self, timeout: Duration) -> Option<Packet> {
        match self.packets.recv_timeout(timeout) {
            Ok(packet) => {
                if let Packet::Event(event) = &packet {
                    assert_ne!(event["type"], "error", "helper error: {event}");
                }
                self.seen.push(packet.clone());
                Some(packet)
            }
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => panic!("the helper closed its output"),
        }
    }

    /// Starts a new step: later waits only look at packets from here on.
    fn mark(&mut self) {
        self.mark = self.seen.len();
    }

    fn wait(&mut self, what: &str, matches: impl Fn(&Packet) -> bool) -> Packet {
        let index = self.wait_index(what, matches);
        self.seen[index].clone()
    }

    fn wait_index(&mut self, what: &str, matches: impl Fn(&Packet) -> bool) -> usize {
        let deadline = Instant::now() + HANG_GUARD;
        let mut checked = self.mark;
        loop {
            if let Some(offset) = self.seen[checked..].iter().position(&matches) {
                return checked + offset;
            }
            checked = self.seen.len();
            let left = deadline
                .checked_duration_since(Instant::now())
                .unwrap_or_else(|| panic!("never saw {what}"));
            self.receive(left);
        }
    }

    fn event(&mut self, kind: &str) -> Value {
        match self.wait(
            kind,
            |packet| matches!(packet, Packet::Event(event) if event["type"] == kind),
        ) {
            Packet::Event(event) => event,
            Packet::Video { .. } => unreachable!(),
        }
    }

    fn video(&mut self) -> (bool, Vec<u8>) {
        match self.wait("a video packet", |packet| {
            matches!(packet, Packet::Video { .. })
        }) {
            Packet::Video { key, access_unit } => (key, access_unit),
            Packet::Event(_) => unreachable!(),
        }
    }

    /// Waits for frames of this size; later waits look only after it.
    fn frame_size(&mut self, width: u64, height: u64) {
        let index = self.wait_index(&format!("frameSize {width}x{height}"), |packet| {
            matches!(packet, Packet::Event(event) if event["type"] == "frameSize"
                && event["width"] == width && event["height"] == height)
        });
        self.mark = index + 1;
    }

    fn videos_since_mark(&self) -> usize {
        self.seen[self.mark..]
            .iter()
            .filter(|packet| matches!(packet, Packet::Video { .. }))
            .count()
    }

    /// Reads until nothing has arrived for `QUIET`, i.e. motion and its settle frames are over.
    fn quiet(&mut self) {
        let deadline = Instant::now() + HANG_GUARD;
        while self.receive(QUIET).is_some() {
            assert!(Instant::now() < deadline, "the display never went quiet");
        }
    }

    fn assert_idle(&mut self, why: &str) {
        let before = self.seen.len();
        let until = Instant::now() + IDLE;
        while let Some(left) = until.checked_duration_since(Instant::now()) {
            if self.receive(left).is_none() {
                break;
            }
        }
        let frames = self.seen[before..]
            .iter()
            .filter(|packet| matches!(packet, Packet::Video { .. }))
            .count();
        assert_eq!(frames, 0, "{why}");
    }

    fn client_logs(&mut self, expected: &str) {
        self.client_logs_any(&[expected]);
    }

    fn client_logs_any(&mut self, expected: &[&str]) {
        let deadline = Instant::now() + HANG_GUARD;
        loop {
            let left = deadline
                .checked_duration_since(Instant::now())
                .unwrap_or_else(|| panic!("client never logged {expected:?}"));
            match self.log.recv_timeout(left) {
                Ok(line) if expected.contains(&line.as_str()) => return,
                Ok(_) => {}
                Err(_) => panic!("client never logged {expected:?}"),
            }
        }
    }

    fn key(&mut self, code: u32, pressed: bool) {
        self.send(json!({"type": "key", "code": code, "pressed": pressed}));
    }
}

/// Every access unit is 4:2:0 H.264 without B-frames.
fn assert_stream_shape(packets: &[Packet]) {
    let mut sps_seen = 0;
    for packet in packets {
        let Packet::Video { access_unit, .. } = packet else {
            continue;
        };
        for nal in h264::nal_units(access_unit) {
            match h264::nal_type(nal) {
                7 => {
                    sps_seen += 1;
                    assert_eq!(h264::sps_profile_and_chroma(nal).1, 1, "4:2:0 chroma");
                }
                1 | 5 => assert_ne!(h264::slice_type(nal), 1, "no B slices"),
                _ => {}
            }
        }
    }
    assert!(sps_seen > 0);
}

fn skip_without_labwc_and_x264() -> bool {
    let missing = !which("labwc") || !has_x264();
    if missing {
        eprintln!("skipping: needs labwc and GStreamer's x264enc on this machine");
    }
    missing
}

fn exercise(capture: &str) {
    let mut helper = Helper::start(capture);
    let ready = helper.event("ready");
    assert_eq!(ready["encoder"], "x264enc");
    assert_eq!(
        (ready["width"].as_u64(), ready["height"].as_u64()),
        (Some(640), Some(480))
    );
    let ext = ready["capture"] == "extImageCopyCapture";
    if capture == "screencopy" {
        assert_eq!(ready["capture"], "wlrScreencopy");
    }
    assert_eq!(ready["cursorTracking"], json!(ext));
    if ext {
        assert!(
            helper.event("windowCaptured")["title"]
                .as_str()
                .unwrap()
                .contains(TITLE)
        );
    }

    let (key, _) = helper.video();
    assert!(key, "the stream starts with a keyframe");
    // The client maps at 320x240; labwc's window rule then makes it fullscreen.
    helper.frame_size(640, 480);
    helper.quiet();
    helper.assert_idle("no frames while nothing changes");

    // Absolute motion reaches the window, and moving the pointer alone paints nothing.
    helper.send(json!({"type": "pointerPosition", "x": 100, "y": 120}));
    // The pointer may already be over the fullscreen window, so this is an enter or a motion.
    helper.client_logs_any(&["enter 100 120", "motion 100 120"]);
    helper.send(json!({"type": "pointerPosition", "x": 200, "y": 220}));
    helper.client_logs("motion 200 220");
    if ext {
        helper.assert_idle("the cursor is not painted into frames");
    } else {
        // wlroots before 0.18 composites its software cursor into screencopy frames.
        helper.quiet();
    }

    // A grab: the client hides its cursor and locks the pointer, as Blender does.
    helper.mark();
    helper.send(json!({"type": "pointerButton", "button": 272, "pressed": true}));
    helper.client_logs("button 272 1");
    helper.client_logs("locked");
    helper.video();
    if ext {
        helper.event("cursorLeave");
    }
    helper.send(json!({"type": "pointerMotion", "dx": 30, "dy": -10}));
    helper.client_logs("relative 30 -10");
    helper.mark();
    helper.send(json!({"type": "pointerButton", "button": 272, "pressed": false}));
    helper.client_logs("button 272 0");
    if ext {
        let enter = helper.event("cursorEnter");
        assert_eq!(
            (enter["x"].as_i64(), enter["y"].as_i64()),
            (Some(200), Some(220)),
            "where the grab left it"
        );
    }

    helper.send(json!({"type": "pointerAxis", "axis": "vertical", "value": 15, "discrete": 1, "source": "wheel"}));
    helper.client_logs("axis VerticalScroll 15");

    // Keys use the requested layout, with modifiers the helper derives itself.
    helper.send(json!({"type": "keymap", "layout": "gb"}));
    helper.key(43, true);
    helper.client_logs("key 43 1 numbersign");
    helper.key(43, false);
    helper.key(42, true);
    helper.key(30, true);
    helper.client_logs("key 30 1 A");
    helper.key(30, false);
    helper.key(42, false);

    helper.quiet();
    helper.mark();
    helper.send(json!({"type": "keyframe"}));
    assert!(helper.video().0, "a keyframe on request, even while idle");

    helper.send(json!({"type": "bitrate", "kbps": 2000}));
    helper.quiet();
    helper.mark();
    helper.send(json!({"type": "pause"}));
    helper.key(30, true);
    helper.client_logs("key 30 1 a");
    helper.key(30, false);
    helper.assert_idle("nothing is captured while paused");
    assert_eq!(helper.videos_since_mark(), 0);
    helper.send(json!({"type": "resume"}));
    assert!(helper.video().0, "resuming starts with a keyframe");

    helper.quiet();
    helper.mark();
    helper.send(json!({"type": "resize", "width": 800, "height": 600}));
    let resized = helper.event("resized");
    assert_eq!(
        (resized["width"].as_u64(), resized["height"].as_u64()),
        (Some(800), Some(600))
    );
    helper.client_logs("draw 800x600");
    helper.frame_size(800, 600);
    assert!(
        helper.video().0,
        "the first frame at a new size is a keyframe"
    );

    assert_stream_shape(&helper.seen);

    helper.send(json!({"type": "quit"}));
    let status = helper.child.wait().unwrap();
    assert!(status.success(), "{status}");
}

#[test]
fn streams_a_window_from_headless_labwc() {
    if skip_without_labwc_and_x264() {
        return;
    }
    exercise("auto");
}

#[test]
fn falls_back_to_wlr_screencopy() {
    if skip_without_labwc_and_x264() {
        return;
    }
    exercise("screencopy");
}

#[test]
fn reports_when_blender_exits() {
    if skip_without_labwc_and_x264() {
        return;
    }
    let state = tempfile::Builder::new()
        .prefix("t3hd")
        .tempdir_in("/tmp")
        .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_t3-hidden-display"))
        .args([
            "--state-dir",
            state.path().to_str().unwrap(),
            "--encoder",
            "x264enc",
            "--",
        ])
        .args([
            "sh",
            "-c",
            "test -z \"$T3CODE_THREAD_ID\" && test \"$TMPDIR\" = \"$0\" && exit 7",
        ])
        .arg(state.path().join("tmp"))
        .env("WLR_RENDERER", "pixman")
        .env("T3CODE_THREAD_ID", "must-not-leak")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    // Held open so the helper stops because the program exited, not because input ended.
    let _stdin = child.stdin.take().unwrap();
    let mut stream = child.stdout.take().unwrap();
    let mut events = Vec::new();
    while let Some(packet) = read_packet(&mut stream) {
        if let Packet::Event(event) = packet {
            events.push(event);
        }
    }
    assert!(child.wait().unwrap().success());
    assert_eq!(
        events.last(),
        Some(&json!({"type": "exited", "process": "blender", "code": 7, "signal": null})),
        "{events:?}"
    );
}

/// labwc usually has `cap_sys_nice`, which clears a parent-death signal, so it must still go
/// away when the helper is killed outright.
#[test]
fn labwc_exits_when_the_helper_is_killed() {
    if skip_without_labwc_and_x264() {
        return;
    }
    let mut helper = Helper::start("auto");
    helper.event("ready");
    let pid = helper.child.id();
    let children = std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children")).unwrap();
    let labwc = children
        .split_whitespace()
        .find(|child| {
            std::fs::read_to_string(format!("/proc/{child}/comm"))
                .is_ok_and(|comm| comm.trim() == "labwc")
        })
        .expect("labwc is a child of the helper")
        .parse::<libc::pid_t>()
        .unwrap();
    let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, labwc, 0) } as i32;
    assert!(pidfd >= 0);

    helper.child.kill().unwrap();
    helper.child.wait().unwrap();
    let mut exited = libc::pollfd {
        fd: pidfd,
        events: libc::POLLIN,
        revents: 0,
    };
    let ready = unsafe { libc::poll(&mut exited, 1, HANG_GUARD.as_millis() as i32) };
    unsafe { libc::close(pidfd) };
    assert_eq!(ready, 1, "labwc outlived the helper");
}

/// Resizing reallocates the DMABuf capture buffers; quitting afterwards must still be clean.
#[test]
fn quits_cleanly_after_a_resize_on_nvenc() {
    if skip_without_labwc_and_x264() {
        return;
    }
    if !std::path::Path::new("/dev/dri").exists()
        || gstreamer::ElementFactory::find("nvh264enc").is_none()
    {
        eprintln!("skipping: needs an NVIDIA GPU with nvh264enc");
        return;
    }
    let mut helper = Helper::start_with("auto", "nvh264enc", true);
    helper.event("ready");
    helper.frame_size(640, 480);
    helper.send(json!({"type": "resize", "width": 800, "height": 600}));
    helper.frame_size(800, 600);
    helper.video();
    helper.send(json!({"type": "quit"}));
    let status = helper.child.wait().unwrap();
    assert!(status.success(), "{status}");
}
