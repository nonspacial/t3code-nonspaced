# How can T3 talk to a running Blender?

Research for issue #6. Feeds #10 (handoff in both directions) and #14 (what agents can do in the Blender pane).

Checked against Blender 5.3.0 (build `02f0899d78e3`, `/usr/bin/blender`) and blender-lab-mcp 1.0.3 (server in `~/.local/share/blender-lab-mcp/1.0.3/`, add-on in `~/.config/blender/5.3/extensions/lab_blender_org/mcp/`). Blender source links point at the `blender-v5.3-release` branch. Claims marked **(tested)** were checked on throwaway Blenders that used their own `TMPDIR`, user directory and port. The desktop Blender was never contacted.

## Answer

The only way into a running Blender is code running inside it. Blender has no outside control API, and SIGTERM simply kills it. The Blender MCP add-on gives us that code: a TCP socket on `127.0.0.1:9876` that runs any Python sent to it, with no authentication. There is no discovery. Whichever Blender binds the port first owns it. A second Blender with the add-on fails to bind and shows the error only in its preferences panel.

- **(a) Hosted Blender.** Launch it with its own `TMPDIR`, its own `BLENDER_USER_RESOURCES` (or `BLENDER_USER_CONFIG`), and `--factory-startup --online-mode`. Pass a `--python` startup script that enables the add-on and sets its port to one T3 chose. Then talk to that port. **(tested)**, using a GUI Blender in a headless `cage`.
- **(b) Detecting a desktop Blender's file.** If the desktop Blender's add-on is listening, one request returns `bpy.data.filepath`, `is_dirty`, `is_saved` and `os.getpid()`. The MCP server already does this itself (`synced_blend_for_cli`). Without the add-on there are only weak signals: the window title (`* name` when unsaved), the `<name>_<pid>_autosave.blend` file in the temp dir, and `recent-files.txt`.
- **(c) Save and quit.** Send `bpy.ops.wm.save_mainfile(exit=True)`. It saves, replies, and then exits cleanly with no prompt. **(tested)** `wm.quit_blender` is blocked by the add-on's sandbox.
- **(d) Pointing the MCP at the hosted Blender.** Start the agent's `blender-mcp` process with `BLENDER_MCP_PORT=<hosted port>`, plus `BLENDER_PATH` and `TMPDIR` for its `*_for_cli` tools. Before trusting any socket, confirm the PID behind it.

Two traps matter for handoff. First, **edits made by scripts, which includes every agent edit, do not mark the file dirty and leave no undo step unless the script pushes one (tested)**, so Blender will not prompt to save them and will not autosave them. Second, `quit.blend` is written to the shared base temp directory on every normal GUI quit, so a hosted Blender must have its own temp directory. Undo history never survives a close and reopen, so a handoff always loses it.

## 1. How the Blender MCP connects

**Two processes.** `blender-mcp` is the MCP server that the agent launches over stdio, or over HTTP on port 8000 if asked (`blmcp/__init__.py:33-105`). It is a thin client. Every tool sends Python source to the add-on inside Blender (`blmcp/__init__.py:5-10`).

**Wire protocol.** A new TCP connection for each call. The request is JSON, `{"type":"execute","code":...,"strict_json":bool}`, ended by a `\0` byte. The reply is JSON ending in `\0`, with `status`, `result`, `message` and optional `stdout`/`stderr` (`blmcp/tools_helpers/connection.py:138-200`, add-on `mcp_to_blender_server.py:307-357`). The client waits up to 300 s (`connection.py:128`). The add-on drops a client that has not sent a complete request within 10 s (`mcp_to_blender_server.py:133`).

**Address.** The client reads `BLENDER_MCP_HOST` (default `localhost`) and `BLENDER_MCP_PORT` (default `9876`) from its environment on every call (`connection.py:126-135`). The add-on takes host and port from its add-on preferences, with the same defaults (`__init__.py:89-101`, `mcp_to_blender_server.py:39-40`). The desktop Blender's saved preferences have port 9876 and autostart on, and `ss -ltnp` shows it listening on `127.0.0.1:9876`.

**When requests run.** In a GUI Blender, a persistent `bpy.app.timers` callback polls the socket every 0.05 s while busy and every 1 s while idle, and runs requests on the main thread (`execute_interactive.py`, `mcp_to_blender_server.py:42-47`). A request waits while Blender is busy. In `--background` mode, timers do not fire, so the add-on offers a blocking loop through `blender -b file.blend -c blender_mcp --port N` instead (`cli.py`, `execute_blocking.py`). That mode cannot handle deferred replies (`mcp_to_blender_server.py:138-142`).

**Startup conditions.** The add-on starts its server only when `bpy.app.online_access` is true. Otherwise it records "Online access must be enabled" and stays off (`__init__.py:76-86`, `:320-336`). **(tested)** With `--factory-startup`, online access is false, so `--online-mode` is required.

**Weak sandbox.** While a request runs, `sys.exit` is replaced and `wm.quit_blender`, `wm.read_factory_settings`, `wm.read_factory_userpref` and `wm.read_userpref` raise an error (`weak_sandbox.py:29-71`). The error message suggests `bpy.app.quit()`, but that function does not exist in 5.3. **(tested)** `hasattr(bpy.app, "quit")` is `False`. The sandbox only patches during `exec`, so it limits mistakes rather than enforcing anything.

**Security.** Anything that can connect to `127.0.0.1:<port>` can run arbitrary Python as the user. There is no token. On a multi-user host, other local users can reach it too. The add-on binds only `localhost` by default. T3 must never ask it to bind a public interface. Remote clients reach Blender through the T3 server, never through this socket.

### Two Blenders at once

- **Linux and macOS: first come, first served.** The add-on sets `SO_REUSEADDR` before binding (`mcp_to_blender_server.py:667-672`). On Linux this does not allow a second socket to bind while one is listening ([socket(7)](https://man7.org/linux/man-pages/man7/socket.7.html), `SO_REUSEADDR`). **(tested)** A second instance on the same port failed with `[Errno 98] Address already in use`. In the GUI, the autostart timer only records the error in the preferences panel (`__init__.py:291-295`) and never retries. So:
  - the MCP keeps talking to whichever Blender started first, with no indication of which one that is;
  - if that Blender quits, the other one does not take over the port.
- **Windows: undefined.** There, `SO_REUSEADDR` lets a second socket bind to a port that is already in use, and which socket receives connections is not defined ([Microsoft: Using SO_REUSEADDR and SO_EXCLUSIVEADDRUSE](https://learn.microsoft.com/en-us/windows/win32/winsock/using-so-reuseaddr-and-so-exclusiveaddruse)). The add-on could therefore silently split or steal traffic between two Blenders. This matters for Windows desktop hosts.
- **Fix: give each Blender its own port and check who answers.** Every Blender T3 starts gets a distinct port. The first request T3 sends returns `os.getpid()`, and T3 compares it with the PID it spawned. The protocol carries no identity of its own.

### The MCP's `*_for_cli` tools also contact the GUI Blender

Every `*_for_cli` tool first runs `synced_blend_for_cli` (`blmcp/tools_helpers/blender_cli.py:110-167`):

- It asks the Blender on `BLENDER_MCP_PORT` for `bpy.data.filepath` and `is_dirty`.
- If that Blender has the same file open with unsaved changes, it saves a copy next to the file as `<name>_mcp_NNNN.blend` (`save_as_mainfile(copy=True)`) and deletes the copy afterwards.
- It then runs `blender --background <file> --python-expr ...`, taking the binary from `BLENDER_PATH` (default `blender`), with the environment it inherited and without `--factory-startup` (`blender_cli.py:31-70`).

So the MCP server's environment must also carry an isolated `TMPDIR`, and the right `BLENDER_PATH`. Because these tools write copies next to the user's file, an agent whose port points at the desktop Blender can write files beside the user's work.

## 2. Launching a hosted Blender T3 owns

**Recipe (tested in a headless `cage` with `--gpu-backend opengl`).** Environment:

- `TMPDIR=<t3 dir>/tmp`
- `BLENDER_USER_RESOURCES=<t3 dir>/user`, with the MCP add-on copied into `user/extensions/user_default/mcp`

Command:

```
blender --factory-startup --online-mode --python <t3>/hosted_start.py [file.blend]
```

`hosted_start.py`:

```python
import addon_utils, bpy
addon_utils.enable("bl_ext.user_default.mcp", default_set=True, persistent=True)
bpy.context.preferences.addons["bl_ext.user_default.mcp"].preferences.port = PORT
```

The add-on's autostart timer fires about 1 s later and reads the port then (`__init__.py:266-300`). Blender was listening on the chosen port, and `os.getpid()` came back as the PID that was spawned.

**Why each piece is needed:**

- **`--factory-startup` ignores the user's preferences entirely,** not only `startup.blend`. **(tested)** The user's add-ons, their extension repositories, their temp-dir preference and their online-access setting are all absent. It also sets `G_FLAG_USERPREF_NO_SAVE_ON_EXIT`, so a hosted session never writes preferences back ([creator_args.cc](https://projects.blender.org/blender/blender/src/branch/blender-v5.3-release/source/creator/creator_args.cc) line 1941, [wm_init_exit.cc](https://projects.blender.org/blender/blender/src/branch/blender-v5.3-release/source/blender/windowmanager/intern/wm_init_exit.cc) line 571). Without it, preference changes such as the add-on port would be saved into the user's real `userpref.blend` on quit, provided "Auto-Save Preferences" is on (same lines). The manual's description of the flag understates it ([manual: command-line arguments](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html)).
- **Extension repositories come from preferences.** Under factory startup, only `blender_org`, `user_default` and `system` exist. **(tested)** That is why the add-on must sit in `user_default`, and why its module name becomes `bl_ext.user_default.mcp`.
- **`--addons bl_ext...mcp` is broken for the GUI.** It runs the add-on's `register()` before the add-on is in `preferences.addons`, and `register()` then raises `KeyError` (`__init__.py:330`). **(tested)** It does work with `-b ... -c blender_mcp`. In GUI mode, enable the add-on from the `--python` script with `default_set=True`.
- **`BLENDER_USER_RESOURCES` puts `config/`, `extensions/` and `scripts/` directly under the given directory,** with no version folder. **(tested)** The finer `BLENDER_USER_CONFIG`/`_SCRIPTS`/`_EXTENSIONS`/`_DATAFILES` variables override parts of it ([manual: environment variables](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html#environment-variables)).
- **The temp base directory is chosen in this order:** the preference `filepaths.temporary_directory` if it is a valid directory, otherwise the OS temp directory (`TMPDIR` on Unix, `TEMP` on Windows). Inside it, Blender creates a per-session `blender_XXXXXX` folder, which `bpy.app.tempdir` points to ([appdir.cc](https://projects.blender.org/blender/blender/src/branch/blender-v5.3-release/source/blender/blenkernel/intern/appdir.cc) `where_is_temp`, `BKE_tempdir_init`, lines 1199-1288; [PreferencesFilePaths.temporary_directory](https://docs.blender.org/api/current/bpy.types.PreferencesFilePaths.html#bpy.types.PreferencesFilePaths.temporary_directory)). **(tested)** With factory startup, `TMPDIR` alone decides it. The session folder is deleted on a clean exit and left behind if the process is killed.
- **Script safety defaults are already right.** `--disable-autoexec` is the default (`blender --help`: "Disable automatic Python script execution ... (default)"). Keep it, so `.blend` files with drivers or scripts do not run code. Do not pass `--python-use-system-env`, so the T3 server's `PYTHONPATH` does not leak into Blender ([manual: Python options](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html#python-options)).
- **Other useful flags:** `--no-window-focus`, `--window-geometry`, `-noaudio`, `--gpu-backend` ([manual](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html#window-options)). On this machine the Vulkan backend hit an "unreachable" assert in `vk_common.cc:133` under `cage`'s headless pixman renderer, and OpenGL worked. That belongs to the headless-display ticket.

**Separate control channel?** The MCP socket can serve as T3's control channel, but it shares the agent's sandbox and its 10 s and 300 s timeouts. A small T3-owned startup script, using the same `bpy.app.timers` pattern, could also register `bpy.app.handlers` (`save_post`, `load_post`, `undo_post`, `depsgraph_update_post`, `exit_pre`, all with `@persistent`) and push state to T3, with no polling ([bpy.app.handlers](https://docs.blender.org/api/current/bpy.app.handlers.html)). Worth deciding in #10. The MCP socket alone is enough for a first version.

## 3. Detecting a desktop Blender, its file and unsaved changes

**With the MCP add-on running in it (reliable).** One request:

```python
import bpy, os
result = {"pid": os.getpid(), "filepath": bpy.data.filepath,
          "is_dirty": bpy.data.is_dirty, "is_saved": bpy.data.is_saved,
          "version": bpy.app.version_string}
```

`is_dirty` means "have recent edits been saved to disk" and `is_saved` means "has the current session been saved to disk as a .blend file" ([BlendData](https://docs.blender.org/api/current/bpy.types.BlendData.html#bpy.types.BlendData.is_dirty)). **(tested)** This is the same query the MCP's `synced_blend_for_cli` makes. It only reaches the Blender that owns the port (§1). With several desktop Blenders open, only the first one is visible.

**Edits made by scripts do not set `is_dirty`.** **(tested)** In a GUI Blender:

| What the script did | `is_dirty` afterwards |
| --- | --- |
| Changed data directly (`obj.location.x += 1`) | stayed `False` |
| Called an operator (`bpy.ops.transform.translate`) | stayed `False` |
| Same edit, then `bpy.ops.ed.undo_push(message=...)` | `True` |

In `--background` mode nothing made it dirty. The dirty flag (`wm->file_saved`) is cleared by undo pushes.

Autosave is also skipped while `file_saved` is set ([wm_files.cc](https://projects.blender.org/blender/blender/src/branch/blender-v5.3-release/source/blender/windowmanager/intern/wm_files.cc) `wm_autosave_write_try`, lines 2388-2418). So an agent edit without an undo push:

- is not shown as unsaved,
- is not autosaved,
- cannot be undone,
- and is lost without a prompt when the user quits.

T3, or the agent instructions for #14, should end mutating calls with `bpy.ops.ed.undo_push(message="agent: ...")`. Alternatively, T3 can treat any `execute_blender_code` call as making the file dirty.

**Without the add-on: best-effort signals.**

- **Window title.** It starts with `* ` when there are unsaved changes, followed by the file name ([wm_window.cc](https://projects.blender.org/blender/blender/src/branch/blender-v5.3-release/source/blender/windowmanager/intern/wm_window.cc) `wm_window_title_text`, lines 581-650). It can be read on X11 (`_NET_WM_NAME`) but generally not under Wayland.
- **Autosave file.** It is named `<basename>_<pid>_autosave.blend`, or `<pid>_autosave.blend` for an unsaved file, in the base temp directory. It is written every `auto_save_time` minutes (default 2), only while the file is dirty and not in a modal operator. A normal exit deletes it (`wm_files.cc` lines 2365-2386, 2475-2519). So its existence, name and modification time show that process `<pid>` had file `<basename>` with unsaved changes at that time. It gives only the basename, not the full path, and a crash leaves it behind. Observed on this machine: an autosave for the running desktop PID, plus a stale autosave from an earlier PID.
- **`/proc/<pid>/cmdline`** shows only the file given at launch. The running desktop Blender was started with no file.
- **`~/.config/blender/<ver>/config/recent-files.txt`** lists files by recency for all Blenders together, not per process.

Conclusion: T3 can only reliably detect "desktop Blender X has file F open with unsaved changes" when the desktop Blender runs the MCP add-on, or a T3 helper add-on, on a known port.

## 4. Asking a Blender to save and quit

**Save and quit in one step:** `bpy.ops.wm.save_mainfile(exit=True)`. "Exit Blender after saving" ([bpy.ops.wm.save_mainfile](https://docs.blender.org/api/current/bpy.ops.wm.html#bpy.ops.wm.save_mainfile)). The exit is scheduled after the operator finishes (`wm_files.cc` around line 4238, `wm_exit_schedule_delayed`). **(tested)**

1. The bridge replied `{"status":"ok","result":{"save":["FINISHED"]}}`.
2. Blender wrote `gui.blend` and a `gui.blend1` backup (`save_version`, default 1).
3. It wrote `quit.blend` to its own `TMPDIR`, logged "Blender quit", and exited.

The sandbox does not block this.

**Other ways to quit:**

- **`wm.quit_blender`, run as exec** (which is how Python calls it), quits straight away with no save prompt. Run as invoke from the UI, it shows the save prompt ([wm_operators.cc](https://projects.blender.org/blender/blender/src/branch/blender-v5.3-release/source/blender/windowmanager/intern/wm_operators.cc) `wm_exit_blender_exec`/`_invoke`, lines 2504-2531). The MCP sandbox blocks it. A timer registered from a request would run after the sandbox is removed, but this was not tested.
- **Signals.** Blender handles SIGSEGV, SIGABRT and SIGFPE, and SIGINT only in background mode, where the first Ctrl-C sets a break flag and the second calls `exit(2)` ([creator_signals.cc](https://projects.blender.org/blender/blender/src/branch/blender-v5.3-release/source/creator/creator_signals.cc) lines 71-85, 241-271). **(tested)** A second SIGINT is needed. There is no SIGTERM handler, so SIGTERM or the display closing ends Blender without saving, without `quit.blend`, and without removing the autosave or the session temp folder. **(tested)** That is what happened when `cage` was stopped. Use signals only as the last resort in T3's lifecycle.
- **Saving a file that was never saved.** `save_mainfile` needs a path. Use `save_as_mainfile(filepath=...)`. `copy=True` writes a snapshot without changing the open file's path.

**Safe order for the desktop-to-hosted handoff:**

1. Read state.
2. Push an undo step if agent edits might be pending.
3. Run `save_mainfile()` and check that `is_dirty` is now false.
4. Run `save_mainfile(exit=True)`, or quit.
5. Wait for the PID to exit and the port to close.
6. Open the file in the hosted Blender.

If the file has never been saved, the user must choose a path.

## 5. Recovery files and undo

- **`quit.blend`.**
  - **When:** on every normal GUI exit (exit code 0, not in background mode), Blender writes the current state to `<temp base>/quit.blend`, even if it is clean. File > Recover > Last Session (`wm.recover_last_session`) reopens it ([wm_init_exit.cc](https://projects.blender.org/blender/blender/src/branch/blender-v5.3-release/source/blender/windowmanager/intern/wm_init_exit.cc) `WM_exit`, `WM_exit_ex`, lines 519-552 and 761-764).
  - **Collision:** the name has no PID in it, so two Blenders sharing a temp base overwrite each other's file. That explains the `/tmp/quit.blend` incident.
  - **Fix:** the hosted Blender's own `TMPDIR` under factory startup **(tested)**, because then no preference can redirect it.
  - **Background:** `-b` Blenders never write it.
- **Autosave.** The file name includes the PID, so instances do not collide (§3). The hosted Blender's autosaves end up in its own `TMPDIR`. Recovery after a crash means T3 has to look there, because a desktop Blender looking in `/tmp` will not find them.
- **Undo history lives only in memory.** It is not stored in `.blend` files, so every save-close-reopen handoff starts the receiving Blender with an empty undo stack. That holds in both directions. The user cannot undo across a handoff. The only way back is the `.blend1` backup from the save, or the previous `quit.blend` and autosave.
- **Agent edits without an undo push** cannot be undone even before a handoff (§3).
- **Cleanup.** A hosted Blender that is killed leaves `blender_XXXXXX/` folders and possibly `*_autosave.blend` behind. T3 owns its temp directory, so it can sweep it when it next starts a hosted Blender.

## Sources

- blender-lab-mcp 1.0.3 server: `~/.local/share/blender-lab-mcp/1.0.3/blmcp/__init__.py`, `blmcp/tools_helpers/connection.py`, `blmcp/tools_helpers/blender_cli.py`, `blmcp/tools/execute_blender_code.py`. Upstream: https://projects.blender.org/lab/blender_mcp
- blender-lab-mcp add-on 1.0.3: `~/.config/blender/5.3/extensions/lab_blender_org/mcp/{__init__,cli,mcp_to_blender_server,execute_interactive,execute_blocking,weak_sandbox}.py` (the 5.2 copy is identical)
- Blender manual, command line: https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html (also bundled at `blmcp/data/manual/advanced/command_line/arguments.rst`), and `blender --help` from 5.3.0
- Blender Python API: https://docs.blender.org/api/current/bpy.types.BlendData.html, https://docs.blender.org/api/current/bpy.ops.wm.html, https://docs.blender.org/api/current/bpy.app.html, https://docs.blender.org/api/current/bpy.app.handlers.html, https://docs.blender.org/api/current/bpy.types.PreferencesFilePaths.html
- Blender source, branch `blender-v5.3-release`: `source/blender/windowmanager/intern/{wm_files,wm_init_exit,wm_operators,wm_window}.cc`, `source/blender/blenkernel/intern/appdir.cc`, `source/creator/{creator_args,creator_signals}.cc` at https://projects.blender.org/blender/blender/src/branch/blender-v5.3-release/
- Linux `SO_REUSEADDR`: https://man7.org/linux/man-pages/man7/socket.7.html. Windows: https://learn.microsoft.com/en-us/windows/win32/winsock/using-so-reuseaddr-and-so-exclusiveaddruse
- Experiments: `blender -b` and headless-`cage` GUI Blenders with `TMPDIR` and `BLENDER_USER_RESOURCES` under `.scratch/research/`, on ports 19877 and 19878 (not committed).
