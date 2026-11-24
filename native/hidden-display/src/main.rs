//! t3-hidden-display: runs a program (Blender) on a private headless labwc, streams one of its
//! windows as H.264, and forwards input. Driven over stdin/stdout; see `control.rs`.

mod control;
mod display;
mod encoder;
mod gbm;
mod keyboard;
mod wayland;

use std::ffi::OsString;
use std::io::{self, BufRead, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, ExitCode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use gstreamer as gst;
use wayland_client::Connection;
use wayland_client::globals::registry_queue_init;

use control::{ChildProcess, Command, Event};
use encoder::{ENCODER_ORDER, Encoder, EncoderKind, SharedOutput};

const USAGE: &str = "usage:
  t3-hidden-display --state-dir DIR [options] -- COMMAND [ARGS...]
      --state-dir DIR        private runtime, tmp and labwc config live here
      --user-resources DIR   BLENDER_USER_RESOURCES (default DIR/blender-user)
      --window-title TEXT    stream only the first window whose title contains TEXT
                             (default: the whole display)
      --width PX --height PX initial display size (default 1280x720)
      --encoder NAME         auto, nvh264enc, vah264enc, x264enc or openh264enc (default auto)
      --bitrate KBPS         initial bitrate (default 8000)
      --capture KIND         auto or screencopy (forces the wlr-screencopy fallback)
      --labwc PATH           the labwc binary (default labwc)
  t3-hidden-display probe    prints the encoder the probe picks
  t3-hidden-display demux [--h264 FILE]
                             reads the packet stream on stdin and prints it as JSON lines";

const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq)]
struct RunArgs {
    state_dir: PathBuf,
    user_resources: Option<PathBuf>,
    window_title: Option<String>,
    width: u32,
    height: u32,
    encoder: Option<EncoderKind>,
    bitrate: u32,
    force_screencopy: bool,
    labwc: OsString,
    command: Vec<OsString>,
}

#[derive(Debug, PartialEq)]
enum Cli {
    Run(RunArgs),
    Probe,
    /// The labwc watchdog; see `display::spawn_labwc`.
    Watch {
        helper: libc::pid_t,
        labwc: libc::pid_t,
    },
    Demux {
        h264: Option<PathBuf>,
    },
}

fn parse_args(args: Vec<OsString>) -> Result<Cli, String> {
    let mut args = args.into_iter();
    let mut first = args.next();
    match first.as_ref().and_then(|arg| arg.to_str()) {
        Some("probe") => return Ok(Cli::Probe),
        Some("watch") => {
            let mut pid = || args.next().and_then(|pid| pid.to_str()?.parse().ok());
            return match (pid(), pid()) {
                (Some(helper), Some(labwc)) => Ok(Cli::Watch { helper, labwc }),
                _ => Err("watch takes the helper's and labwc's pids".into()),
            };
        }
        Some("demux") => {
            let rest: Vec<OsString> = args.collect();
            return match rest.as_slice() {
                [] => Ok(Cli::Demux { h264: None }),
                [flag, file] if flag == "--h264" => Ok(Cli::Demux {
                    h264: Some(file.into()),
                }),
                _ => Err("demux takes only --h264 FILE".into()),
            };
        }
        _ => {}
    }
    let mut run = RunArgs {
        state_dir: PathBuf::new(),
        user_resources: None,
        window_title: None,
        width: 1280,
        height: 720,
        encoder: None,
        bitrate: 8000,
        force_screencopy: false,
        labwc: "labwc".into(),
        command: Vec::new(),
    };
    while let Some(arg) = first.take().or_else(|| args.next()) {
        if arg == "--" {
            run.command = args.by_ref().collect();
            break;
        }
        let flag = arg.to_str().ok_or("arguments must be UTF-8")?.to_string();
        let mut value = || args.next().ok_or_else(|| format!("{flag} needs a value"));
        let number = |value: OsString| -> Result<u32, String> {
            value
                .to_str()
                .and_then(|value| value.parse().ok())
                .ok_or_else(|| format!("{flag} needs a number"))
        };
        match flag.as_str() {
            "--state-dir" => run.state_dir = value()?.into(),
            "--user-resources" => run.user_resources = Some(value()?.into()),
            "--window-title" => run.window_title = Some(value()?.to_string_lossy().into_owned()),
            "--width" => run.width = number(value()?)?,
            "--height" => run.height = number(value()?)?,
            "--bitrate" => run.bitrate = number(value()?)?,
            "--labwc" => run.labwc = value()?,
            "--encoder" => {
                let name = value()?.to_string_lossy().into_owned();
                run.encoder = match name.as_str() {
                    "auto" => None,
                    _ => Some(
                        EncoderKind::from_name(&name)
                            .ok_or_else(|| format!("unknown encoder {name}"))?,
                    ),
                }
            }
            "--capture" => {
                run.force_screencopy = match value()?.to_str() {
                    Some("auto") => false,
                    Some("screencopy") => true,
                    _ => return Err("--capture is auto or screencopy".into()),
                }
            }
            _ => return Err(format!("unknown option {flag}")),
        }
    }
    if run.state_dir.as_os_str().is_empty() {
        return Err("--state-dir is required".into());
    }
    if run.command.is_empty() {
        return Err("a command to run is required after --".into());
    }
    if run.width == 0 || run.height == 0 {
        return Err("the display size must be positive".into());
    }
    Ok(Cli::Run(run))
}

fn main() -> ExitCode {
    let cli = match parse_args(std::env::args_os().skip(1).collect()) {
        Ok(cli) => cli,
        Err(message) => {
            eprintln!("{message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match cli {
        Cli::Demux { h264 } => demux(h264),
        Cli::Watch { helper, labwc } => {
            display::watch(helper, labwc);
            ExitCode::SUCCESS
        }
        Cli::Probe => {
            init_gstreamer();
            match pick_encoder(None) {
                Some(kind) => {
                    println!("{}", serde_json::json!({ "encoder": kind.element() }));
                    ExitCode::SUCCESS
                }
                None => {
                    println!("{}", serde_json::json!({ "encoder": null }));
                    ExitCode::FAILURE
                }
            }
        }
        Cli::Run(args) => run(args),
    }
}

/// GStreamer's GL must never open a Wayland or X connection of its own: the helper's only
/// display connection is the one to the hidden labwc.
fn init_gstreamer() {
    unsafe {
        std::env::remove_var("WAYLAND_DISPLAY");
        std::env::remove_var("WAYLAND_SOCKET");
        std::env::remove_var("DISPLAY");
        std::env::set_var("GST_GL_WINDOW", "surfaceless");
        std::env::set_var("GST_GL_PLATFORM", "egl");
    }
    gst::init().expect("GStreamer failed to initialise");
}

fn pick_encoder(forced: Option<EncoderKind>) -> Option<EncoderKind> {
    match forced {
        Some(kind) => encoder::probe(kind).then_some(kind),
        None => encoder::pick_encoder(&ENCODER_ORDER, encoder::probe),
    }
}

struct Emitter {
    output: SharedOutput,
    closed: Arc<AtomicBool>,
}

impl Emitter {
    fn emit(&self, event: &Event) {
        let mut output = self.output.lock().unwrap();
        if control::write_event(&mut *output, event).is_err() {
            self.closed.store(true, Ordering::Relaxed);
        }
    }
}

fn run(args: RunArgs) -> ExitCode {
    let parent_env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    init_gstreamer();
    let emitter = Emitter {
        output: Arc::new(Mutex::new(Box::new(io::stdout()))),
        closed: Arc::new(AtomicBool::new(false)),
    };
    let fail = |message: String| {
        emitter.emit(&Event::Error { message });
        ExitCode::FAILURE
    };

    let Some(kind) = pick_encoder(args.encoder) else {
        return fail(match args.encoder {
            Some(kind) => format!("{} does not work on this machine", kind.element()),
            None => {
                "no working H.264 encoder (tried nvh264enc, vah264enc, x264enc, openh264enc)".into()
            }
        });
    };

    let paths = display::Paths::new(&args.state_dir, args.user_resources.as_deref());
    if let Err(error) = paths.prepare(args.window_title.as_deref()) {
        return fail(format!(
            "could not prepare {}: {error}",
            args.state_dir.display()
        ));
    }
    let labwc_env = display::labwc_env(parent_env.clone(), &paths, display::has_render_node());
    let labwc = match display::spawn_labwc(&args.labwc, &paths, labwc_env, &args.state_dir) {
        Ok(child) => child,
        Err(error) => return fail(format!("could not start labwc: {error}")),
    };
    let mut children = Children {
        labwc: pidfd(&labwc).ok(),
        blender: None,
        labwc_process: labwc,
        blender_process: None,
    };
    if children.labwc.is_none() {
        let error = io::Error::last_os_error();
        children.shutdown();
        return fail(format!("pidfd_open: {error}"));
    }

    let socket = match display::wait_for_socket(&paths.runtime, &mut children.labwc_process) {
        Ok(socket) => socket,
        Err(error) => {
            children.shutdown();
            return fail(error.to_string());
        }
    };
    let result = session(
        args,
        kind,
        &paths,
        &socket,
        parent_env,
        &emitter,
        &mut children,
    );
    children.shutdown();
    match result {
        Ok(code) => code,
        Err(message) => fail(message),
    }
}

struct Children {
    labwc_process: Child,
    blender_process: Option<Child>,
    labwc: Option<OwnedFd>,
    blender: Option<OwnedFd>,
}

fn pidfd(child: &Child) -> io::Result<OwnedFd> {
    display::pidfd(child.id() as libc::pid_t).ok_or_else(io::Error::last_os_error)
}

impl Children {
    fn shutdown(&mut self) {
        if let Some(mut blender) = self.blender_process.take() {
            stop(&mut blender);
        }
        stop(&mut self.labwc_process);
    }
}

fn stop(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn exited(process: ChildProcess, child: &mut Child) -> Event {
    use std::os::unix::process::ExitStatusExt;
    let status = child.wait().ok();
    Event::Exited {
        process,
        code: status.and_then(|status| status.code()),
        signal: status.and_then(|status| status.signal()),
    }
}

fn session(
    args: RunArgs,
    kind: EncoderKind,
    paths: &display::Paths,
    socket: &std::path::Path,
    parent_env: Vec<(OsString, OsString)>,
    emitter: &Emitter,
    children: &mut Children,
) -> Result<ExitCode, String> {
    let stream = UnixStream::connect(socket)
        .map_err(|error| format!("could not connect to labwc: {error}"))?;
    let connection = Connection::from_socket(stream).map_err(|error| error.to_string())?;
    let (globals, mut queue) =
        registry_queue_init::<wayland::State>(&connection).map_err(|error| error.to_string())?;
    let qh = queue.handle();

    let error_output = Emitter {
        output: emitter.output.clone(),
        closed: emitter.closed.clone(),
    };
    let encoder = Encoder::new(
        kind,
        args.bitrate,
        emitter.output.clone(),
        emitter.closed.clone(),
        move |message| error_output.emit(&Event::Error { message }),
    )?;
    let options = wayland::Options {
        window_title: args.window_title.clone(),
        force_screencopy: args.force_screencopy,
    };
    let mut state = wayland::State::new(&globals, &qh, encoder, options)?;
    queue
        .roundtrip(&mut state)
        .map_err(|error| error.to_string())?;

    state.resize(args.width, args.height, &qh);
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while state.output_size() != (args.width, args.height) {
        let left = deadline
            .checked_duration_since(Instant::now())
            .ok_or("labwc did not apply the display size")?;
        connection.flush().map_err(|error| error.to_string())?;
        if let Some(guard) = queue.prepare_read() {
            let mut readable = poll_fd(guard.connection_fd().as_raw_fd());
            if unsafe { libc::poll(&mut readable, 1, left.as_millis() as i32) } > 0 {
                match guard.read() {
                    Ok(_) => {}
                    Err(wayland_client::backend::WaylandError::Io(error))
                        if error.kind() == io::ErrorKind::WouldBlock => {}
                    Err(error) => return Err(format!("lost the hidden display: {error}")),
                }
            }
        }
        queue
            .dispatch_pending(&mut state)
            .map_err(|error| error.to_string())?;
        if let Some(Event::Error { message }) = state
            .events
            .iter()
            .find(|event| matches!(event, Event::Error { .. }))
        {
            return Err(message.clone());
        }
    }
    state.events.clear();

    let program = &args.command[0];
    let blender_env = display::blender_env(parent_env, paths, socket);
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let blender = display::spawn(program, &args.command[1..], blender_env, &cwd)
        .map_err(|error| format!("could not start {}: {error}", program.to_string_lossy()))?;
    children.blender = Some(pidfd(&blender).map_err(|error| error.to_string())?);
    children.blender_process = Some(blender);

    let (width, height) = state.output_size();
    emitter.emit(&Event::Ready {
        capture: state.capture_backend(),
        encoder: kind.element().into(),
        width,
        height,
        cursor_tracking: state.cursor_tracking(),
    });
    state.start(&qh);

    let (commands, wake) = read_commands().map_err(|error| error.to_string())?;
    loop {
        for event in state.events.drain(..) {
            emitter.emit(&event);
        }
        if emitter.closed.load(Ordering::Relaxed) {
            return Ok(ExitCode::SUCCESS);
        }
        connection.flush().map_err(|error| error.to_string())?;
        queue
            .dispatch_pending(&mut state)
            .map_err(|error| error.to_string())?;
        connection.flush().map_err(|error| error.to_string())?;

        let timeout = state.settle.deadline().map(|deadline| {
            deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(i32::MAX as u128) as i32
        });
        let guard = queue.prepare_read();
        let wayland_fd = guard
            .as_ref()
            .map(|guard| guard.connection_fd().as_raw_fd())
            .unwrap_or(-1);
        let mut fds = [
            poll_fd(wayland_fd),
            poll_fd(wake.as_raw_fd()),
            poll_fd(children.labwc.as_ref().map_or(-1, |fd| fd.as_raw_fd())),
            poll_fd(children.blender.as_ref().map_or(-1, |fd| fd.as_raw_fd())),
        ];
        let ready = unsafe {
            libc::poll(
                fds.as_mut_ptr(),
                fds.len() as libc::nfds_t,
                timeout.unwrap_or(-1),
            )
        };
        if ready < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return Err(io::Error::last_os_error().to_string());
        }
        if let Some(guard) = guard
            && fds[0].revents != 0
        {
            match guard.read() {
                Ok(_) => {}
                Err(wayland_client::backend::WaylandError::Io(error))
                    if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => {
                    if children.labwc_process.try_wait().ok().flatten().is_none() {
                        return Err(format!("lost the hidden display: {error}"));
                    }
                }
            }
        }
        queue
            .dispatch_pending(&mut state)
            .map_err(|error| error.to_string())?;
        state.flush_cursor();

        if fds[1].revents != 0 {
            drain(&wake);
        }
        while let Ok(line) = commands.try_recv() {
            let Some(line) = line else {
                return Ok(ExitCode::SUCCESS);
            };
            if line.trim().is_empty() {
                continue;
            }
            match Command::parse(&line) {
                Ok(Command::Quit) => return Ok(ExitCode::SUCCESS),
                Ok(command) => state.handle(command, &qh),
                Err(message) => state.events.push(Event::Error {
                    message: format!("bad command: {message}"),
                }),
            }
        }
        state.tick(Instant::now());

        if fds[3].revents != 0 {
            children.blender = None;
            let event = exited(
                ChildProcess::Blender,
                children.blender_process.as_mut().unwrap(),
            );
            children.blender_process = None;
            flush_events(&mut state, emitter);
            emitter.emit(&event);
            return Ok(ExitCode::SUCCESS);
        }
        if fds[2].revents != 0 {
            children.labwc = None;
            let event = exited(ChildProcess::Labwc, &mut children.labwc_process);
            flush_events(&mut state, emitter);
            emitter.emit(&event);
            return Ok(ExitCode::FAILURE);
        }
    }
}

fn flush_events(state: &mut wayland::State, emitter: &Emitter) {
    for event in state.events.drain(..) {
        emitter.emit(&event);
    }
}

fn poll_fd(fd: RawFd) -> libc::pollfd {
    libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    }
}

/// Lines from stdin on a thread, with a pipe that wakes the poll loop. `None` is end of input.
fn read_commands() -> io::Result<(mpsc::Receiver<Option<String>>, OwnedFd)> {
    let mut pipe = [0; 2];
    if unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(pipe[0]), OwnedFd::from_raw_fd(pipe[1])) };
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let wake = || unsafe { libc::write(write.as_raw_fd(), b"x".as_ptr().cast(), 1) };
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if sender.send(Some(line)).is_err() {
                return;
            }
            wake();
        }
        let _ = sender.send(None);
        wake();
    });
    Ok((receiver, read))
}

fn drain(fd: &OwnedFd) {
    let mut buffer = [0u8; 256];
    while unsafe { libc::read(fd.as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len()) } > 0 {}
}

fn demux(h264: Option<PathBuf>) -> ExitCode {
    let mut file = match h264.map(std::fs::File::create).transpose() {
        Ok(file) => file,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let mut input = io::stdin().lock();
    let mut out = io::stdout().lock();
    loop {
        match control::read_packet(&mut input) {
            Ok(None) => return ExitCode::SUCCESS,
            Ok(Some(control::Packet::Event(event))) => {
                let _ = writeln!(out, "{event}");
            }
            Ok(Some(control::Packet::Video {
                key,
                pts_us,
                access_unit,
            })) => {
                if let Some(file) = file.as_mut() {
                    let _ = file.write_all(&access_unit);
                }
                let line = serde_json::json!({"type": "video", "key": key, "ptsUs": pts_us, "bytes": access_unit.len()});
                let _ = writeln!(out, "{line}");
            }
            Err(error) => {
                eprintln!("{error}");
                return ExitCode::FAILURE;
            }
        }
        let _ = out.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_a_run() {
        let cli = parse_args(args(&[
            "--state-dir",
            "/s",
            "--window-title",
            "3D Viewport",
            "--width",
            "800",
            "--height",
            "600",
            "--encoder",
            "x264enc",
            "--bitrate",
            "4000",
            "--capture",
            "screencopy",
            "--",
            "blender",
            "--factory-startup",
            "--",
            "--extra",
        ]))
        .unwrap();
        assert_eq!(
            cli,
            Cli::Run(RunArgs {
                state_dir: "/s".into(),
                user_resources: None,
                window_title: Some("3D Viewport".into()),
                width: 800,
                height: 600,
                encoder: Some(EncoderKind::X264),
                bitrate: 4000,
                force_screencopy: true,
                labwc: "labwc".into(),
                command: args(&["blender", "--factory-startup", "--", "--extra"]),
            })
        );
    }

    #[test]
    fn defaults_to_auto_encoder_and_720p() {
        let Cli::Run(run) = parse_args(args(&["--state-dir", "/s", "--", "blender"])).unwrap()
        else {
            panic!()
        };
        assert_eq!(
            (run.width, run.height, run.encoder, run.force_screencopy),
            (1280, 720, None, false)
        );
    }

    #[test]
    fn parses_subcommands() {
        assert_eq!(parse_args(args(&["probe"])), Ok(Cli::Probe));
        assert_eq!(
            parse_args(args(&["watch", "42", "43"])),
            Ok(Cli::Watch {
                helper: 42,
                labwc: 43
            })
        );
        assert!(parse_args(args(&["watch", "42"])).is_err());
        assert_eq!(parse_args(args(&["demux"])), Ok(Cli::Demux { h264: None }));
        assert_eq!(
            parse_args(args(&["demux", "--h264", "out.h264"])),
            Ok(Cli::Demux {
                h264: Some("out.h264".into())
            })
        );
    }

    #[test]
    fn rejects_bad_arguments() {
        for bad in [
            vec![],
            vec!["--", "blender"],
            vec!["--state-dir", "/s"],
            vec!["--state-dir", "/s", "--width", "wide", "--", "blender"],
            vec!["--state-dir", "/s", "--width", "0", "--", "blender"],
            vec!["--state-dir", "/s", "--encoder", "ffmpeg", "--", "blender"],
            vec!["--state-dir", "/s", "--bogus", "--", "blender"],
            vec!["--state-dir"],
        ] {
            assert!(parse_args(args(&bad)).is_err(), "{bad:?}");
        }
    }
}
