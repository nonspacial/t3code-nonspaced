//! The hidden display: private directories, a T3-owned labwc config, and the two children.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const SOCKET_TIMEOUT: Duration = Duration::from_secs(10);

/// Everything a hidden display owns: the runtime directory (see `RuntimeDir`) and the rest
/// under one state directory.
#[derive(Debug, Clone, PartialEq)]
pub struct Paths {
    pub runtime: PathBuf,
    pub tmp: PathBuf,
    pub labwc_config: PathBuf,
    pub user_resources: PathBuf,
}

/// Unix socket paths are capped at 108 bytes, and T3's state directories can be longer, so the
/// private runtime directory that holds labwc's socket lives under a short parent instead:
/// `$XDG_RUNTIME_DIR` when that is short, else `/tmp`. Removed when dropped.
pub struct RuntimeDir(PathBuf);

const MAX_RUNTIME_PARENT: usize = 64;

impl RuntimeDir {
    pub fn create(xdg_runtime_dir: Option<&std::ffi::OsStr>) -> io::Result<RuntimeDir> {
        let parent = xdg_runtime_dir
            .map(Path::new)
            .filter(|dir| dir.is_absolute() && dir.as_os_str().len() <= MAX_RUNTIME_PARENT)
            .unwrap_or(Path::new("/tmp"));
        let template = std::ffi::CString::new(
            parent
                .join("t3-hidden-display-XXXXXX")
                .into_os_string()
                .into_encoded_bytes(),
        )
        .map_err(io::Error::other)?;
        let mut template = template.into_bytes_with_nul();
        // mkdtemp creates the directory 0700.
        if unsafe { libc::mkdtemp(template.as_mut_ptr().cast()) }.is_null() {
            return Err(io::Error::last_os_error());
        }
        template.pop();
        Ok(RuntimeDir(PathBuf::from(
            <OsString as std::os::unix::ffi::OsStringExt>::from_vec(template),
        )))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for RuntimeDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Paths {
    pub fn new(state: &Path, runtime: &Path, user_resources: Option<&Path>) -> Paths {
        Paths {
            runtime: runtime.to_path_buf(),
            tmp: state.join("tmp"),
            labwc_config: state.join("labwc"),
            user_resources: user_resources
                .map(Path::to_path_buf)
                .unwrap_or_else(|| state.join("blender-user")),
        }
    }

    /// Creates the directories (private to this user) and writes labwc's `rc.xml`.
    pub fn prepare(&self, window_title: Option<&str>) -> io::Result<()> {
        for directory in [
            &self.runtime,
            &self.tmp,
            &self.labwc_config,
            &self.user_resources,
        ] {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(directory)?;
        }
        fs::write(self.labwc_config.join("rc.xml"), labwc_config(window_title))
    }
}

/// One inert keybind stops labwc loading its defaults (Alt+F4, Alt+Tab...), which would steal
/// Blender's keys. The captured window is made fullscreen so stream pixels are output pixels.
pub fn labwc_config(window_title: Option<&str>) -> String {
    let window_rule = window_title
        .map(|title| {
            format!(
                "\n  <windowRules>\n    <windowRule title=\"*{}*\" serverDecoration=\"no\">\n      \
                 <action name=\"ToggleFullscreen\"/>\n    </windowRule>\n  </windowRules>",
                xml_escape(title)
            )
        })
        .unwrap_or_default();
    format!(
        "<?xml version=\"1.0\"?>\n<labwc_config>\n  <core><decoration>server</decoration></core>\n  \
         <theme><maximizedDecoration>none</maximizedDecoration></theme>\n  <keyboard>\n    \
         <keybind key=\"W-F24\"><action name=\"None\"/></keybind>\n  </keyboard>\n  \
         <mouse><default/></mouse>{window_rule}\n</labwc_config>\n"
    )
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

type Env = Vec<(OsString, OsString)>;

/// Nothing from T3's own environment (thread ids, tokens) reaches the hidden display, and nothing
/// may point it at the user's desktop session.
fn isolated(parent: impl IntoIterator<Item = (OsString, OsString)>) -> Env {
    parent
        .into_iter()
        .filter(|(key, _)| {
            let key = key.to_string_lossy();
            !key.starts_with("T3CODE_")
                && !matches!(
                    key.as_ref(),
                    "WAYLAND_DISPLAY" | "WAYLAND_SOCKET" | "DISPLAY" | "XDG_RUNTIME_DIR" | "TMPDIR"
                )
        })
        .collect()
}

fn with(mut env: Env, pairs: &[(&str, &Path)]) -> Env {
    for (key, value) in pairs {
        env.push((key.into(), value.as_os_str().to_owned()));
    }
    env
}

pub fn labwc_env(
    parent: impl IntoIterator<Item = (OsString, OsString)>,
    paths: &Paths,
    has_gpu: bool,
) -> Env {
    let mut env = with(
        isolated(parent),
        &[("XDG_RUNTIME_DIR", &paths.runtime), ("TMPDIR", &paths.tmp)],
    );
    env.retain(|(key, _)| !key.to_string_lossy().starts_with("WLR_BACKENDS"));
    for (key, value) in [
        ("WLR_BACKENDS", "headless"),
        ("WLR_HEADLESS_OUTPUTS", "1"),
        ("WLR_LIBINPUT_NO_DEVICES", "1"),
    ] {
        env.push((key.into(), value.into()));
    }
    let renderer_chosen = env.iter().any(|(key, _)| key == "WLR_RENDERER");
    if !has_gpu && !renderer_chosen {
        env.push(("WLR_RENDERER".into(), "pixman".into()));
    }
    env
}

/// labwc drops `TMPDIR` from programs it starts, so Blender is started by the helper instead,
/// with its private `TMPDIR` (never the desktop Blender's `quit.blend`) set explicitly.
pub fn blender_env(
    parent: impl IntoIterator<Item = (OsString, OsString)>,
    paths: &Paths,
    socket: &Path,
) -> Env {
    with(
        isolated(parent),
        &[
            ("XDG_RUNTIME_DIR", &paths.runtime),
            ("WAYLAND_DISPLAY", socket),
            ("TMPDIR", &paths.tmp),
            ("BLENDER_USER_RESOURCES", &paths.user_resources),
        ],
    )
}

pub fn has_render_node() -> bool {
    fs::read_dir("/dev/dri")
        .map(|entries| {
            entries
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().starts_with("renderD"))
        })
        .unwrap_or(false)
}

/// Starts labwc and a watchdog that stops it if the helper dies without doing so.
/// `PR_SET_PDEATHSIG` cannot: labwc usually carries `cap_sys_nice`, and executing it clears
/// the death signal.
pub fn spawn_labwc(labwc: &OsString, paths: &Paths, env: Env, cwd: &Path) -> io::Result<Child> {
    let args = ["-C".into(), paths.labwc_config.clone().into_os_string()];
    let mut child = spawn(labwc, &args, env, cwd)?;
    // No death signal for the watchdog: it has to outlive the helper.
    let watchdog = std::env::current_exe().and_then(|helper| {
        Command::new(helper)
            .args([
                "watch".to_string(),
                std::process::id().to_string(),
                child.id().to_string(),
            ])
            .arg(&paths.runtime)
            .stdin(Stdio::null())
            .stdout(io::stderr())
            .stderr(io::stderr())
            .spawn()
    });
    if let Err(error) = watchdog {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(child)
}

/// The watchdog: once `helper` exits, stops labwc (a no-op if it already exited) and removes
/// the runtime directory, which a killed helper cannot.
pub fn watch(helper: libc::pid_t, labwc: libc::pid_t, runtime: &Path) {
    let Some(labwc) = pidfd(labwc) else { return };
    if let Some(helper) = pidfd(helper) {
        wait_exit(&helper);
    }
    unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            labwc.as_raw_fd(),
            libc::SIGTERM,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    wait_exit(&labwc);
    let _ = fs::remove_dir_all(runtime);
}

fn wait_exit(pidfd: &OwnedFd) {
    let mut exited = libc::pollfd {
        fd: pidfd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    while unsafe { libc::poll(&mut exited, 1, -1) } < 0 {}
}

pub fn pidfd(pid: libc::pid_t) -> Option<OwnedFd> {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    (fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd as i32) })
}

/// Spawns a child that dies with the helper. Its output goes to the helper's stderr, because
/// stdout carries the binary packet stream.
pub fn spawn(program: &OsString, args: &[OsString], env: Env, cwd: &Path) -> io::Result<Child> {
    let mut command = Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(env)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(io::stderr())
        .stderr(io::stderr());
    unsafe {
        command.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn()
}

/// Waits for labwc to create its Wayland socket in the private runtime directory.
pub fn wait_for_socket(runtime: &Path, labwc: &mut Child) -> io::Result<PathBuf> {
    let started = Instant::now();
    loop {
        if let Some(socket) = find_socket(runtime) {
            return Ok(socket);
        }
        if let Some(status) = labwc.try_wait()? {
            return Err(io::Error::other(format!(
                "labwc exited before it was ready: {status}"
            )));
        }
        if started.elapsed() > SOCKET_TIMEOUT {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "labwc did not create a Wayland socket",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn find_socket(runtime: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::FileTypeExt;
    fs::read_dir(runtime).ok()?.flatten().find_map(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_socket = entry.file_type().is_ok_and(|kind| kind.is_socket());
        (name.starts_with("wayland-") && is_socket).then(|| entry.path())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn parent() -> Env {
        [
            ("PATH", "/usr/bin"),
            ("HOME", "/home/u"),
            ("TMPDIR", "/tmp"),
            ("T3CODE_THREAD_ID", "thread-1"),
            ("T3CODE_AUTH_TOKEN", "secret"),
            ("WAYLAND_DISPLAY", "wayland-1"),
            ("WAYLAND_SOCKET", "5"),
            ("DISPLAY", ":0"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect()
    }

    fn get<'a>(env: &'a Env, key: &str) -> Vec<&'a str> {
        env.iter()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.to_str().unwrap())
            .collect()
    }

    fn paths() -> Paths {
        Paths::new(Path::new("/state"), Path::new("/state/run"), None)
    }

    #[test]
    fn everything_but_the_runtime_lives_under_the_state_directory() {
        assert_eq!(
            paths(),
            Paths {
                runtime: "/state/run".into(),
                tmp: "/state/tmp".into(),
                labwc_config: "/state/labwc".into(),
                user_resources: "/state/blender-user".into(),
            }
        );
        assert_eq!(
            Paths::new(
                Path::new("/state"),
                Path::new("/run"),
                Some(Path::new("/copy"))
            )
            .user_resources,
            PathBuf::from("/copy")
        );
    }

    #[test]
    fn the_runtime_directory_keeps_the_wayland_socket_path_short() {
        let long = format!("/run/user/1000/{}", "deep/".repeat(20));
        for xdg in [None, Some(long.as_str()), Some("relative"), Some("/tmp")] {
            let runtime = RuntimeDir::create(xdg.map(std::ffi::OsStr::new)).unwrap();
            let socket = runtime.path().join("wayland-0");
            assert!(socket.as_os_str().len() < 108, "{}", socket.display());
            let mode = fs::metadata(runtime.path()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
            let kept = runtime.path().to_path_buf();
            drop(runtime);
            assert!(!kept.exists(), "removed when dropped");
        }
    }

    #[test]
    fn blender_gets_its_private_tmpdir_and_config_and_never_t3_variables() {
        let env = blender_env(parent(), &paths(), Path::new("/state/run/wayland-0"));
        assert_eq!(get(&env, "TMPDIR"), ["/state/tmp"]);
        assert_eq!(get(&env, "BLENDER_USER_RESOURCES"), ["/state/blender-user"]);
        assert_eq!(get(&env, "XDG_RUNTIME_DIR"), ["/state/run"]);
        assert_eq!(get(&env, "WAYLAND_DISPLAY"), ["/state/run/wayland-0"]);
        assert!(get(&env, "T3CODE_THREAD_ID").is_empty());
        assert!(get(&env, "T3CODE_AUTH_TOKEN").is_empty());
        assert!(get(&env, "DISPLAY").is_empty());
        assert!(get(&env, "WAYLAND_SOCKET").is_empty());
        assert_eq!(get(&env, "PATH"), ["/usr/bin"]);
    }

    #[test]
    fn labwc_runs_headless_and_never_on_the_desktop_session() {
        let env = labwc_env(parent(), &paths(), true);
        assert_eq!(get(&env, "WLR_BACKENDS"), ["headless"]);
        assert_eq!(get(&env, "XDG_RUNTIME_DIR"), ["/state/run"]);
        assert!(get(&env, "WAYLAND_DISPLAY").is_empty());
        assert!(get(&env, "DISPLAY").is_empty());
        assert!(get(&env, "T3CODE_THREAD_ID").is_empty());
        assert!(
            get(&env, "WLR_RENDERER").is_empty(),
            "the GPU renderer by default"
        );
        assert_eq!(
            get(&labwc_env(parent(), &paths(), false), "WLR_RENDERER"),
            ["pixman"]
        );
    }

    #[test]
    fn labwc_config_clears_default_keybinds_and_fullscreens_the_captured_window() {
        let config = labwc_config(Some("3D \"Viewport\" & <more>"));
        assert!(config.contains(r#"<keybind key="W-F24"><action name="None"/></keybind>"#));
        assert!(config.contains("<maximizedDecoration>none</maximizedDecoration>"));
        assert!(
            config.contains(r#"<windowRule title="*3D &quot;Viewport&quot; &amp; &lt;more&gt;*""#)
        );
        assert!(config.contains(r#"<action name="ToggleFullscreen"/>"#));
        assert!(!labwc_config(None).contains("windowRule"));
    }
}
