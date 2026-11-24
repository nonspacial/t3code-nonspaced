//! The control channel: JSON-line commands on stdin, framed packets on stdout.
//!
//! Every stdout packet is `u32 BE length | u8 kind | payload`. Kind 1 is a JSON event; kind 2 is
//! a SEMU video packet (the device stream's framing) carrying one H.264 Annex B access unit.

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

pub const PACKET_EVENT: u8 = 1;
pub const PACKET_VIDEO: u8 = 2;
const SEMU_MAGIC: u32 = 0x5345_4d55;
const SEMU_VERSION: u8 = 1;
const SEMU_FLAG_KEY: u8 = 1;
pub const SEMU_HEADER_BYTES: usize = 16;
const MAX_PACKET_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Axis {
    Vertical,
    Horizontal,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AxisSource {
    Wheel,
    Finger,
    Continuous,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Keyframe,
    Bitrate {
        kbps: u32,
    },
    Pause,
    Resume,
    /// Report the next freshly captured frame (never a repeat of cached pixels) as `id`.
    MarkNextFrame {
        id: u32,
    },
    Resize {
        width: u32,
        height: u32,
    },
    /// Relative motion, for while Blender holds the pointer.
    PointerMotion {
        dx: f64,
        dy: f64,
    },
    /// Absolute position in stream pixels.
    PointerPosition {
        x: f64,
        y: f64,
    },
    /// `button` is a Linux evdev code, e.g. 272 for BTN_LEFT.
    PointerButton {
        button: u32,
        pressed: bool,
    },
    PointerAxis {
        axis: Axis,
        value: f64,
        #[serde(default)]
        discrete: Option<i32>,
        source: AxisSource,
    },
    /// `code` is a Linux evdev key code, e.g. 30 for KEY_A.
    Key {
        code: u32,
        pressed: bool,
    },
    Keymap {
        layout: String,
        #[serde(default)]
        variant: String,
        #[serde(default)]
        model: String,
        #[serde(default)]
        options: String,
    },
    Quit,
}

impl Command {
    pub fn parse(line: &str) -> Result<Command, String> {
        serde_json::from_str(line).map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureBackend {
    ExtImageCopyCapture,
    WlrScreencopy,
}

/// The window matched by `--window-title`, or the whole display when there is no title or the
/// compositor cannot capture a single window.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureTarget {
    Window,
    Output,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChildProcess {
    Labwc,
    Blender,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    Ready {
        capture: CaptureBackend,
        /// What the stream shows. With `output`, other windows (an F12 render, Preferences) can
        /// cover the viewport.
        target: CaptureTarget,
        encoder: String,
        width: u32,
        height: u32,
        /// Whether `cursorEnter`/`cursorLeave` will be reported.
        cursor_tracking: bool,
    },
    /// The hidden display's output mode changed.
    Resized {
        width: u32,
        height: u32,
    },
    /// The captured frames changed size. Advisory: it is written from another thread than the
    /// video, so it may land a packet early or late; the SPS in the stream is authoritative.
    FrameSize {
        width: u32,
        height: u32,
    },
    WindowCaptured {
        title: String,
    },
    WindowClosed,
    /// The cursor disappeared from the display: Blender captured the mouse.
    CursorLeave,
    /// The cursor is back, at `x`,`y` in display pixels (where Blender warped it, if it did).
    CursorEnter {
        x: i32,
        y: i32,
    },
    Exited {
        process: ChildProcess,
        code: Option<i32>,
        signal: Option<i32>,
    },
    Error {
        message: String,
    },
    /// `markNextFrame` is in effect: any frame captured from now on can carry the mark.
    MarkArmed {
        id: u32,
    },
    /// The frame marked `id` goes out with this presentation time.
    FrameMarked {
        id: u32,
        pts_us: u64,
    },
}

pub fn write_packet(out: &mut impl Write, kind: u8, payload: &[&[u8]]) -> io::Result<()> {
    let length: usize = 1 + payload.iter().map(|part| part.len()).sum::<usize>();
    let length = u32::try_from(length).map_err(|_| io::Error::other("packet too large"))?;
    out.write_all(&length.to_be_bytes())?;
    out.write_all(&[kind])?;
    for part in payload {
        out.write_all(part)?;
    }
    out.flush()
}

pub fn write_event(out: &mut impl Write, event: &Event) -> io::Result<()> {
    let json = serde_json::to_vec(event).map_err(io::Error::other)?;
    write_packet(out, PACKET_EVENT, &[&json])
}

pub fn semu_header(key: bool, pts_us: u64) -> [u8; SEMU_HEADER_BYTES] {
    let mut header = [0u8; SEMU_HEADER_BYTES];
    header[0..4].copy_from_slice(&SEMU_MAGIC.to_be_bytes());
    header[4] = SEMU_VERSION;
    header[5] = if key { SEMU_FLAG_KEY } else { 0 };
    header[8..16].copy_from_slice(&pts_us.to_be_bytes());
    header
}

pub fn write_video(
    out: &mut impl Write,
    key: bool,
    pts_us: u64,
    access_unit: &[u8],
) -> io::Result<()> {
    write_packet(out, PACKET_VIDEO, &[&semu_header(key, pts_us), access_unit])
}

#[derive(Debug, PartialEq)]
pub enum Packet {
    Event(serde_json::Value),
    Video {
        key: bool,
        pts_us: u64,
        access_unit: Vec<u8>,
    },
}

/// Reads one packet; `Ok(None)` at a clean end of stream.
pub fn read_packet(input: &mut impl Read) -> io::Result<Option<Packet>> {
    let mut length = [0u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_PACKET_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bad packet length",
        ));
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body)?;
    let payload = &body[1..];
    match body[0] {
        PACKET_EVENT => serde_json::from_slice(payload)
            .map(|value| Some(Packet::Event(value)))
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
        PACKET_VIDEO
            if payload.len() >= SEMU_HEADER_BYTES && payload[0..4] == SEMU_MAGIC.to_be_bytes() =>
        {
            Ok(Some(Packet::Video {
                key: payload[5] & SEMU_FLAG_KEY != 0,
                pts_us: u64::from_be_bytes(payload[8..16].try_into().unwrap()),
                access_unit: payload[SEMU_HEADER_BYTES..].to_vec(),
            }))
        }
        _ => Err(io::Error::new(io::ErrorKind::InvalidData, "unknown packet")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_command() {
        let cases = [
            (r#"{"type":"keyframe"}"#, Command::Keyframe),
            (
                r#"{"type":"bitrate","kbps":4000}"#,
                Command::Bitrate { kbps: 4000 },
            ),
            (r#"{"type":"pause"}"#, Command::Pause),
            (r#"{"type":"resume"}"#, Command::Resume),
            (
                r#"{"type":"markNextFrame","id":7}"#,
                Command::MarkNextFrame { id: 7 },
            ),
            (
                r#"{"type":"resize","width":1280,"height":720}"#,
                Command::Resize {
                    width: 1280,
                    height: 720,
                },
            ),
            (
                r#"{"type":"pointerMotion","dx":-3.5,"dy":2}"#,
                Command::PointerMotion { dx: -3.5, dy: 2.0 },
            ),
            (
                r#"{"type":"pointerPosition","x":10,"y":20.5}"#,
                Command::PointerPosition { x: 10.0, y: 20.5 },
            ),
            (
                r#"{"type":"pointerButton","button":274,"pressed":true}"#,
                Command::PointerButton {
                    button: 274,
                    pressed: true,
                },
            ),
            (
                r#"{"type":"pointerAxis","axis":"vertical","value":15,"discrete":1,"source":"wheel"}"#,
                Command::PointerAxis {
                    axis: Axis::Vertical,
                    value: 15.0,
                    discrete: Some(1),
                    source: AxisSource::Wheel,
                },
            ),
            (
                r#"{"type":"pointerAxis","axis":"horizontal","value":-2.25,"source":"finger"}"#,
                Command::PointerAxis {
                    axis: Axis::Horizontal,
                    value: -2.25,
                    discrete: None,
                    source: AxisSource::Finger,
                },
            ),
            (
                r#"{"type":"key","code":30,"pressed":false}"#,
                Command::Key {
                    code: 30,
                    pressed: false,
                },
            ),
            (
                r#"{"type":"keymap","layout":"gb"}"#,
                Command::Keymap {
                    layout: "gb".into(),
                    variant: String::new(),
                    model: String::new(),
                    options: String::new(),
                },
            ),
            (r#"{"type":"quit"}"#, Command::Quit),
        ];
        for (line, expected) in cases {
            assert_eq!(Command::parse(line), Ok(expected), "{line}");
        }
    }

    #[test]
    fn rejects_malformed_commands() {
        for line in [
            "",
            "keyframe",
            r#"{"type":"teleport"}"#,
            r#"{"type":"resize","width":-1,"height":2}"#,
            r#"{"type":"key","code":30}"#,
            r#"{"type":"bitrate","kbps":1,"extra":true}"#,
        ] {
            assert!(Command::parse(line).is_err(), "{line}");
        }
    }

    #[test]
    fn events_serialize_as_tagged_camel_case() {
        let json = serde_json::to_value(Event::Ready {
            capture: CaptureBackend::ExtImageCopyCapture,
            target: CaptureTarget::Window,
            encoder: "x264enc".into(),
            width: 640,
            height: 480,
            cursor_tracking: true,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "ready",
                "capture": "extImageCopyCapture",
                "target": "window",
                "encoder": "x264enc",
                "width": 640,
                "height": 480,
                "cursorTracking": true,
            })
        );
        assert_eq!(
            serde_json::to_value(Event::Exited {
                process: ChildProcess::Blender,
                code: Some(0),
                signal: None
            })
            .unwrap(),
            serde_json::json!({"type": "exited", "process": "blender", "code": 0, "signal": null})
        );
        assert_eq!(
            serde_json::to_value(Event::MarkArmed { id: 7 }).unwrap(),
            serde_json::json!({"type": "markArmed", "id": 7})
        );
        assert_eq!(
            serde_json::to_value(Event::FrameMarked {
                id: 7,
                pts_us: 66_000
            })
            .unwrap(),
            serde_json::json!({"type": "frameMarked", "id": 7, "ptsUs": 66_000})
        );
    }

    #[test]
    fn packets_round_trip() {
        let mut stream = Vec::new();
        write_event(&mut stream, &Event::CursorLeave).unwrap();
        write_video(&mut stream, true, 33_000, &[0, 0, 0, 1, 0x65, 0xaa]).unwrap();
        write_video(&mut stream, false, 66_000, &[0, 0, 0, 1, 0x41]).unwrap();

        let mut reader = stream.as_slice();
        assert_eq!(
            read_packet(&mut reader).unwrap(),
            Some(Packet::Event(serde_json::json!({"type": "cursorLeave"})))
        );
        assert_eq!(
            read_packet(&mut reader).unwrap(),
            Some(Packet::Video {
                key: true,
                pts_us: 33_000,
                access_unit: vec![0, 0, 0, 1, 0x65, 0xaa]
            })
        );
        assert_eq!(
            read_packet(&mut reader).unwrap(),
            Some(Packet::Video {
                key: false,
                pts_us: 66_000,
                access_unit: vec![0, 0, 0, 1, 0x41]
            })
        );
        assert_eq!(read_packet(&mut reader).unwrap(), None);
    }

    #[test]
    fn video_payload_is_a_device_stream_semu_packet() {
        let mut stream = Vec::new();
        write_video(&mut stream, true, 0x0102_0304_0506, &[9]).unwrap();
        let semu = &stream[5..];
        assert_eq!(&semu[0..4], b"SEMU");
        assert_eq!(semu[4], 1, "version");
        assert_eq!(semu[5] & 1, 1, "key flag");
        assert_eq!(
            u64::from_be_bytes(semu[8..16].try_into().unwrap()),
            0x0102_0304_0506
        );
        assert_eq!(&semu[16..], &[9]);
    }
}
