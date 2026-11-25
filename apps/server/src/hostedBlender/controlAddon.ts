// T3's control add-on, written beside each hosted Blender and loaded with `--python`. It is
// never installed, so desktop Blenders never see it. Kept as a string so it ships inside the
// server bundle.
import { AGENT_GUARD_SOURCE } from "./agentGuard.ts";

export const CONTROL_ADDON_SOURCE = String.raw`
import json
import os
import socket
import struct
import sys
import time

import bpy
import gpu
from bpy.app.handlers import persistent
from mathutils import Matrix, Vector


def _option(name):
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return argv[argv.index(name) + 1] if name in argv[:-1] else None


SOCKET_PATH = _option("--t3-control")
MCP_PORT = _option("--t3-mcp-port")
RECOVER_PATH = _option("--t3-recover")
# The launch's own copy of Blender Lab: a folder holding its "mcp" package.
MCP_SNAPSHOT = _option("--t3-mcp-snapshot")
MCP_LISTEN = "--t3-mcp-listen" in (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
# The file's revision as T3 saw it before Blender read it at launch.
LAUNCH_REVISION = _option("--t3-revision")
# Embedded scripts follow the user's setting only when T3 didn't turn them off at launch.
AUTOEXEC = "--disable-autoexec" not in sys.argv
# Tests take the copy writer Blenders without wm.save_auto_save use.
FORCE_COPY_WRITER = "--t3-copy-writer" in sys.argv
TICK = 0.1
# Casting a mark's samples stops after this long, as the 3D preview's does.
HIT_BUDGET = 0.1


class _State:
    # "off", "starting", "ready" or "failed": whether Blender Lab's listener takes agent calls.
    agent_listener = "starting" if MCP_LISTEN else "off"
    # The agent may use Blender Lab only while T3 holds this connection, for this one file. Once
    # that ends it stays ended until Blender restarts.
    grant = "pending" if MCP_LISTEN else "ended"
    authorized_file = None
    mcp_name = None
    mcp_version = None
    mcp_file = None
    # Blender Lab modules already imported when this add-on loaded: T3's gate didn't hold.
    startup_mcp = []
    server = None
    client = None
    buffer = b""
    sent = None
    # A restored session until it is marked unsaved or saved.
    restored = False
    # "ok" or "failed" once a restore T3 asked for has run; T3 waits for it.
    restore = None
    # The viewport window this session opened, by pointer: one a loaded file brings back is not.
    viewport_window = None
    # When Blender last loaded a file (open, revert, recover), epoch ms; T3 ignores autosaves
    # from before it.
    loaded_at = None
    # The file just loaded (at launch, opened, reverted or recovered) may bring viewport windows
    # back, to be replaced.
    replace_loaded = True
    # Quit requests T3 gave up on; one still waiting here is never carried out.
    cancelled_quits = set()
    # Seen with unsaved asset catalogs, until a save or a browser that can answer says otherwise.
    catalogs_unsaved = False
    # Save and quit is saving: its own result answers T3, not save_post's.
    quit_saving = False
    # The open file as Blender last read or saved it; anything else on disk is a change Blender
    # didn't make. Revisions are identity, size and nanosecond times, as T3's previews tell.
    disk_revision = None
    # The real path disk_revision is of.
    disk_path = None
    # What load_pre saw of the file it was about to read: its real path and revision.
    loading = None
    # The revision on disk once T3 saw it settle, while it isn't the one Blender has.
    stale = None
    # Why a stale Blender hasn't reloaded, for the pane: one of RELOAD_BLOCKERS.
    blocked = None
    # A pane shows this Blender, so T3 asked for the reload now; T3 takes it back once none does.
    reload_wanted = False
    # A revision that didn't load, never tried again.
    reload_failed = None
    reload_copies = 0


def _listen():
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    previous = os.umask(0o177)
    try:
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(SOCKET_PATH)
    finally:
        os.umask(previous)
    os.chmod(SOCKET_PATH, 0o600)
    server.listen(1)
    server.setblocking(False)
    return server


def _same_user(connection):
    credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    _pid, uid, _gid = struct.unpack("3i", credentials)
    return uid == os.getuid()


def _send(message):
    if _State.client is None:
        return
    try:
        _State.client.sendall((json.dumps(message) + "\n").encode())
    except OSError:
        _drop_client()


def _drop_client():
    if _State.client is not None:
        try:
            _State.client.close()
        except OSError:
            pass
        # Fail closed: without T3 on the other end, nothing may grant the agent Blender.
        _end_grant()
    _State.client = None
    _State.buffer = b""
    _State.sent = None


def _snapshot():
    snapshot = {
        "type": "state",
        "filepath": bpy.data.filepath,
        "dirty": bool(bpy.data.is_dirty),
        "agentListener": _State.agent_listener,
        "agentActing": _agent_acting(_mcp_server()),
        "mcpVersion": _State.mcp_version,
    }
    if _State.restore is not None:
        snapshot["restore"] = _State.restore
    if _State.loaded_at is not None:
        snapshot["loadedAt"] = _State.loaded_at
    if _State.stale is not None:
        snapshot["stale"] = True
        if _State.blocked is not None:
            snapshot["staleBlocked"] = _State.blocked
    return snapshot


def _main_window():
    windows = bpy.context.window_manager.windows
    return windows[0] if len(windows) else None


def _save():
    window = _main_window()
    if not bpy.data.filepath or window is None:
        return False
    try:
        with bpy.context.temp_override(window=window):
            return "FINISHED" in bpy.ops.wm.save_mainfile()
    except Exception as error:  # noqa: BLE001 - a failed save is reported, never a crash
        print("T3 control add-on: save failed:", error, file=sys.stderr)
        return False


def _push_undo_step():
    # Blender's quit copy (quit.blend, which T3 keeps to reopen) is its newest undo step, so
    # changes made without one, such as by a script (which leaves the file looking clean), are
    # recorded first.
    window = _main_window()
    try:
        with bpy.context.temp_override(window=window):
            bpy.ops.ed.undo_push(message="T3 recovery copy")
    except Exception as error:  # noqa: BLE001 - quitting matters more than the extra step
        print("T3 control add-on: undo step failed:", error, file=sys.stderr)
def _lone_3d_view(window):
    return len(window.screen.areas) == 1 and window.screen.areas[0].type == "VIEW_3D"


def _viewport_lost():
    # T3's viewport window closed, or turned into another editor.
    if _State.viewport_window is None:
        return False
    tracked = [
        window
        for window in bpy.context.window_manager.windows
        if window.as_pointer() == _State.viewport_window
    ]
    return not tracked or not _lone_3d_view(tracked[0])


def _viewport():
    # The person's viewport window: the one _open_viewport_window made this launch, never the
    # main window or one a file brought back.
    candidates = [
        window
        for window in _viewport_windows()
        if window.as_pointer() == _State.viewport_window and _lone_3d_view(window)
    ]
    for window in candidates:
        area = window.screen.areas[0]
        region = next((region for region in area.regions if region.type == "WINDOW"), None)
        if region is not None:
            return window, area, region, area.spaces.active
    return None


def _camera_view(view_matrix, distance):
    # From the matrix the screenshot is drawn with, so the camera and the pixels always agree;
    # a viewport looking through a camera has that camera's matrix here.
    inverse = view_matrix.inverted()
    position = inverse.translation
    forward = (inverse.to_3x3() @ Vector((0.0, 0.0, -1.0))).normalized()
    target = position + forward * distance
    return {"position": list(position), "target": list(target), "upAxis": "z"}


def _write_png(path, width, height, rgba):
    import numpy
    import zlib

    # GPU rows run bottom-up; PNG rows top-down, each led by filter byte 0 (none).
    pixels = numpy.asarray(rgba, dtype=numpy.uint8).reshape(height, width, 4)[::-1, :, :3]
    rows = numpy.zeros((height, width * 3 + 1), dtype=numpy.uint8)
    rows[:, 1:] = pixels.reshape(height, width * 3)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows.tobytes(), 3))
        + chunk(b"IEND", b"")
    )
    partial = path + ".part"
    with open(partial, "wb") as file:
        file.write(png)
    os.replace(partial, path)


# Offscreen drawing has no draw context, so an external engine's rendered shading (Cycles)
# draws nothing; EEVEE and Workbench draw as the viewport does.
OFFSCREEN_ENGINES = {"BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "BLENDER_WORKBENCH"}
# About 1920x1088: a screenshot is sent whole over the shared connection.
MAX_SCREENSHOT_PIXELS = 1920 * 1088


def _renders_offscreen(space, scene):
    return space.shading.type != "RENDERED" or scene.render.engine in OFFSCREEN_ENGINES


def _screenshot_size(width, height):
    # Larger regions render scaled down; marks are fractions of the picture, so they still map.
    scale = min(1.0, (MAX_SCREENSHOT_PIXELS / (width * height)) ** 0.5)
    return max(1, int(width * scale)), max(1, int(height * scale))


def _view(command):
    # The screenshot goes beside the control socket, in T3's private folder for this Blender.
    name = command["screenshot"]
    if os.path.basename(name) != name or not name.endswith(".png"):
        return None
    found = _viewport()
    if found is None:
        return None
    window, area, region, space = found
    rv3d = space.region_3d
    if not _renders_offscreen(space, window.scene):
        # The camera is still right; only the picture can't be had.
        return _view_result(rv3d.view_matrix, rv3d.window_matrix, rv3d, None)
    view_matrix = rv3d.view_matrix.copy()
    window_matrix = rv3d.window_matrix.copy()
    width, height = _screenshot_size(region.width, region.height)
    # One draw: the pixels and the camera come from the same matrices.
    offscreen = gpu.types.GPUOffScreen(width, height)
    try:
        with bpy.context.temp_override(window=window, area=area, region=region):
            offscreen.draw_view3d(
                window.scene,
                window.view_layer,
                space,
                region,
                view_matrix,
                window_matrix,
                do_color_management=True,
            )
        with offscreen.bind():
            framebuffer = gpu.state.active_framebuffer_get()
            rgba = framebuffer.read_color(0, 0, width, height, 4, 0, "UBYTE")
    finally:
        offscreen.free()
    _write_png(os.path.join(os.path.dirname(SOCKET_PATH), name), width, height, rgba)
    return _view_result(view_matrix, window_matrix, rv3d, {"width": width, "height": height})


def _view_result(view_matrix, window_matrix, rv3d, screenshot):
    perspective = window_matrix @ view_matrix
    return {
        "screenshot": screenshot,
        "cameraView": _camera_view(view_matrix, rv3d.view_distance),
        "projection": {
            "matrix": [value for row in perspective for value in row],
            # The screenshot is the 3D view's drawing region, so marks on it cover it whole.
            "region": {"x": 0, "y": 0, "width": 1, "height": 1},
        },
    }


def _hits(command):
    found = _viewport()
    if found is None:
        return None
    window, area, view_region, _space = found
    inverse = Matrix([command["matrix"][row * 4:row * 4 + 4] for row in range(4)]).inverted()
    region = command["region"]
    # Timers run in the main window's context; the marks are on the person's window, whose
    # scene and view layer can differ from the agent's.
    with bpy.context.temp_override(window=window, area=area, region=view_region):
        depsgraph = bpy.context.evaluated_depsgraph_get()
    scene = window.scene
    deadline = time.perf_counter() + HIT_BUDGET
    hits = []
    for samples in command["marks"]:
        hit = None
        for sample in samples:
            if time.perf_counter() >= deadline:
                break
            # The window fraction, inside the 3D view's drawing region, as clip coordinates.
            x = (sample["x"] - region["x"]) / region["width"]
            y = (sample["y"] - region["y"]) / region["height"]
            if not (0 <= x <= 1 and 0 <= y <= 1):
                continue
            near = inverse @ Vector((x * 2 - 1, 1 - y * 2, -1.0, 1.0))
            far = inverse @ Vector((x * 2 - 1, 1 - y * 2, 1.0, 1.0))
            near, far = near.xyz / near.w, far.xyz / far.w
            ray = far - near
            found, location, _normal, _index, obj, _matrix = scene.ray_cast(
                depsgraph, near, ray.normalized(), distance=ray.length
            )
            if found:
                hit = {"object": obj.name if obj else None, "point": list(location)}
                break
        hits.append(hit)
    return hits


def _set_view(command):
    # The link names the file it was made for; Blender may have another open by now.
    current = os.path.realpath(bpy.data.filepath) if bpy.data.filepath else ""
    if current != command.get("filepath"):
        return "otherFile"
    found = _viewport()
    if found is None:
        return None
    _window, area, _region, space = found
    rv3d = space.region_3d
    position, target = Vector(command["position"]), Vector(command["target"])
    offset = position - target
    if rv3d.view_perspective == "CAMERA":
        rv3d.view_perspective = "PERSP"
    rv3d.view_location = target
    rv3d.view_distance = offset.length
    rv3d.view_rotation = offset.to_track_quat("Z", "Y")
    area.tag_redraw()
    return True


def _handle(command):
    kind = command.get("type")
    requests = {
        "view": lambda: _view(command),
        "hits": lambda: _hits(command),
        "setView": lambda: _set_view(command),
        "restore": lambda: _restore_copy(command),
    }
    if kind in requests:
        try:
            result = requests[kind]()
        except Exception as error:  # noqa: BLE001 - a failed request answers null, never a crash
            print("T3 control add-on:", kind, "failed:", error, file=sys.stderr)
            result = None
        _send({"type": "reply", "id": command.get("id"), "result": result})
        return
    if kind == "stopAgentListener":
        _end_grant()
        return
    if kind == "diskChanged":
        _check_disk(command)
        return
    if kind == "panesHidden":
        _State.reload_wanted = False
        return
    if kind == "grantAgentListener":
        _grant_agent_listener()
        return
    if kind == "cancelQuit":
        _State.cancelled_quits.add(command.get("id"))
        _send({"type": "quitCancelled", "id": command.get("id")})
        return
    if kind == "quitIfClean":
        if command.get("id") in _State.cancelled_quits:
            return
        # Decided here, at the moment of quitting, with no dialog nobody could answer: T3's last
        # word on unsaved changes may be stale. Pending agent work that can write keeps it open,
        # whether or not its undo step manages to mark the file unsaved.
        pending_writes = any(record["writes"] for record in _Guard.deferred)
        _record_pending_deferred()
        if pending_writes or not _session_is_clean():
            _send({"type": "quitRefused", "id": command.get("id")})
            return
        # The same last word as any quit: what its end keeps is judged by the same facts.
        _send({"type": "quitting", "filepath": bpy.data.filepath, "dirty": bool(bpy.data.is_dirty)})
        with bpy.context.temp_override(window=_main_window()):
            bpy.ops.wm.quit_blender()
        return
    if kind == "quit":
        expected = command.get("filepath")
        if not command.get("save") and expected is not None and expected != bpy.data.filepath:
            # The person's discard named the file T3 last heard of; another is open now, whose
            # changes they never chose to lose.
            _send({"type": "discardRefused"})
            return
        if not command.get("save"):
            # T3 waits on this rather than stopping a Blender still writing its quit copy. It
            # carries the file and its unsaved bit as they are now, before the undo step below
            # (which always reads unsaved), as the run's last word on them.
            _send({
                "type": "quitting",
                "filepath": bpy.data.filepath,
                "dirty": bool(bpy.data.is_dirty),
            })
            _push_undo_step()
        else:
            if _changed_on_disk():
                # What Blender read would be written over the newer file; nothing is saved.
                _send({"type": "quitFailed", "reason": "changedOnDisk"})
                return
            # Answered before the save, which blocks Blender for as long as a big file takes.
            _send({"type": "saving"})
            _State.quit_saving = True
            try:
                saved = _save()
            finally:
                _State.quit_saving = False
            if not saved:
                _send({"type": "quitFailed", "reason": "saveFailed"})
                return
            # Saved, so Blender quits next: the agent's grant ends now, as T3's stop would
            # come too late once quitting begins. Ending it records the agent's pending work
            # that can write as a step after the save, leaving the file unsaved; the result
            # says so with the file saved, and T3 then keeps the quit copy.
            pending = (
                _State.grant == "granted"
                and _on_authorized_file()
                and any(record["writes"] for record in _Guard.deferred)
            )
            _end_grant()
            _send({"type": "saved", "filepath": bpy.data.filepath, "dirty": pending})
        window = _main_window()
        with bpy.context.temp_override(window=window):
            bpy.ops.wm.quit_blender()


def _catalog_state():
    # Blender's own quit check also covers asset catalogs, which Python can read only through
    # catalogs_save's poll, in an asset browser. It answers for every loaded library at once, and
    # means something only where catalog_new's poll holds too: a browser whose library is loaded
    # and editable. True or False from those; "unknown" when browsers exist but none can answer;
    # "none" without any.
    unknown = False
    answers = []
    for screen in bpy.data.screens:
        for area in screen.areas:
            for space in area.spaces:
                if space.type != "FILE_BROWSER" or getattr(space, "browse_mode", "") != "ASSETS":
                    continue
                window = next(
                    (window for window in bpy.context.window_manager.windows if window.screen == screen),
                    None,
                )
                if window is None or space != area.spaces.active:
                    unknown = True
                    continue
                with bpy.context.temp_override(window=window, area=area, space_data=space):
                    if not bpy.ops.asset.catalog_new.poll():
                        unknown = True
                        continue
                    answers.append(bool(bpy.ops.asset.catalogs_save.poll()))
    if answers:
        return any(answers)
    return "unknown" if unknown else "none"


def _watch_catalogs():
    # Asked every tick, so an edit is remembered after its asset browser is gone or switched. A
    # browser that can answer sets or clears the mark (catalogs saved or discarded); with none,
    # it stands.
    try:
        state = _catalog_state()
    except Exception:  # noqa: BLE001 - a failed look leaves the last answer standing
        return
    if isinstance(state, bool):
        _State.catalogs_unsaved = state


def _session_is_clean():
    # The .blend, edited images and asset catalogs, as Blender's quit checks; unknown is unclean.
    try:
        if bpy.data.is_dirty or any(image.is_dirty for image in bpy.data.images):
            return False
        _watch_catalogs()
        if _State.catalogs_unsaved:
            return False
        # Seen clean, or never edited: no browser to ask. One that can't be asked can't tell.
        return _catalog_state() != "unknown"
    except Exception as error:  # noqa: BLE001 - can't tell is not clean
        print("T3 control add-on: could not check for unsaved catalogs:", error, file=sys.stderr)
        return False


def _tick():
    if _State.server is None:
        return None
    _watch_catalogs()
    try:
        connection, _address = _State.server.accept()
        if _same_user(connection):
            _drop_client()
            connection.setblocking(False)
            _State.client = connection
            _send({"type": "hello", "pid": os.getpid()})
        else:
            connection.close()
    except BlockingIOError:
        pass
    if _State.restored and not bpy.data.is_dirty:
        # Blender clears the unsaved mark it gives a recovered file once loading finishes;
        # an undo step sets it again, so the user is still asked to save the restored work.
        _State.restored = False
        _push_undo_step()
    # T3's viewport window turned into another editor is no longer its viewport: a fresh one
    # opens, as on a first open.
    if _viewport_lost() and not bpy.app.timers.is_registered(_open_viewport_window):
        bpy.app.timers.register(_open_viewport_window, first_interval=0.2)
    _pump_control()
    if _State.client is not None:
        while b"\n" in _State.buffer:
            line, _State.buffer = _State.buffer.split(b"\n", 1)
            try:
                command = json.loads(line)
                _handle(command)
            except Exception as error:  # noqa: BLE001 - a bad command must not stop the add-on
                print("T3 control add-on:", error, file=sys.stderr)
                continue
            # Casting blocks Blender's UI; the next request waits for the next tick.
            if command.get("type") == "hits":
                break
        if _State.reload_wanted:
            # Images and catalogs saved, or the agent's work done: a visible pane catches up.
            _State.reload_wanted = _reload_if_stale() in RETRY_RELOAD
        _check_authorized_file()
    _check_guard()
    _sweep_deferred()
    _publish_state()
    return TICK


def _pump_control():
    # Reads what T3 sent, so a lost connection or a waiting stop ends the grant now. Also run
    # right before agent code, which can't wait for the next tick.
    if _State.client is None:
        return
    try:
        while True:
            chunk = _State.client.recv(65536)
            if not chunk:
                _drop_client()
                return
            _State.buffer += chunk
    except BlockingIOError:
        pass
    except OSError:
        _drop_client()
        return
    # A stop already waiting wins over a grant queued before it, and a cancel over its quit.
    stopped = False
    for queued in _State.buffer.split(b"\n")[:-1]:
        try:
            waiting = json.loads(queued)
        except ValueError:
            continue
        if waiting.get("type") == "cancelQuit":
            _State.cancelled_quits.add(waiting.get("id"))
        # The agent's next call must not run on a file T3 already said changed.
        if waiting.get("type") == "diskChanged":
            _check_disk(waiting)
        if waiting.get("type") == "stopAgentListener" and not stopped:
            stopped = True
            _end_grant()


def _publish_state():
    snapshot = _snapshot()
    if snapshot != _State.sent:
        _State.sent = snapshot
        _send(snapshot)


${AGENT_GUARD_SOURCE}

def _is_mcp_addon(name):
    return name.startswith("bl_ext.") and name.endswith(".mcp")


def _setup_mcp_addon():
    # The official MCP add-on runs agent code. However the copied settings left it, it starts
    # disabled, with no Start button and no autostart, and comes back only when T3 grants this
    # Blender's thread its agent (see _grant_agent_listener). Disabling with default_set also
    # drops it from these settings (T3's own copy), so Reload Scripts can't bring it back.
    import addon_utils

    _State.startup_mcp = sorted(name for name in sys.modules if _is_mcp_module(name))
    preferences = bpy.context.preferences
    for name in [name for name in preferences.addons.keys() if _is_mcp_addon(name)]:
        addon_utils.disable(name, default_set=True)
    if MCP_SNAPSHOT is not None:
        _State.mcp_name = "bl_ext." + SNAPSHOT_REPO_MODULE + ".mcp"
        _State.mcp_file = os.path.join(MCP_SNAPSHOT, "mcp", "__init__.py")
    if MCP_LISTEN:
        _State.authorized_file = os.path.realpath(bpy.data.filepath) if bpy.data.filepath else None
    try:
        preferences.is_dirty = False
    except AttributeError:
        pass


def _keep_recovery_files():
    # Copied settings may name a temporary folder shared with the desktop Blender; this session
    # keeps its quit copy and autosaves in the private TMPDIR T3 gave it, where T3 finds them.
    filepaths = bpy.context.preferences.filepaths
    if filepaths.temporary_directory:
        filepaths.temporary_directory = ""


def _recover():
    # Restores a recovery copy or autosave over the file Blender opened. Blender recovers its
    # own session files with their original path, so saving still writes the user's file, and
    # an agent's working copy stays the file T3 authorized.
    # Scripts stay off as --disable-autoexec says; left out, recovering reads the preference.
    window = _main_window()
    try:
        with bpy.context.temp_override(window=window):
            result = bpy.ops.wm.recover_auto_save(filepath=RECOVER_PATH, use_scripts=False)
            _State.restored = "FINISHED" in result
            _State.replace_loaded = True
    except Exception as error:  # noqa: BLE001 - reported to T3, which keeps the copy
        print("T3 control add-on: recovery failed:", error, file=sys.stderr)
    _State.restore = "ok" if _State.restored else "failed"
    return None


def _grant_agent_listener():
    # Only once, and never after the grant ended: a revoke T3 sent first wins.
    if _State.grant != "pending":
        return
    _State.grant = "granted"
    # Checked again now: the file may have changed since T3 saw it.
    _check_authorized_file()
    if _State.grant != "granted":
        return
    # Blender Lab must have stayed out of startup, behind T3's gate, with nothing listening yet.
    if not _gate_completed() or _State.startup_mcp or _any_mcp_listening():
        _State.agent_listener = "failed"
        _disable_mcp()
        return
    # Read now, from the manifest beside the module that will be enabled.
    _State.mcp_version = _mcp_version(_State.mcp_file) if _State.mcp_name else None
    if _State.mcp_name is not None and _State.mcp_version not in TESTED_MCP_VERSIONS:
        # Never enabled: the guard may not hold on a version T3 hasn't tested.
        _State.agent_listener = "untested"
        return
    if _State.mcp_name is not None:
        import addon_utils

        preferences = bpy.context.preferences
        try:
            _use_snapshot_repo()
            # Its register() reads its preferences, which Blender creates only with default_set.
            addon_utils.enable(_State.mcp_name, default_set=True)
            addon = preferences.addons.get(_State.mcp_name)
            if addon is not None and addon.preferences is not None:
                addon.preferences.port = int(MCP_PORT)
                addon.preferences.host = "localhost"
                addon.preferences.use_autostart = False
            _cancel_mcp_autostart()
        except Exception as error:  # noqa: BLE001 - reported as failed, never a crash
            print("T3 control add-on: Blender Lab MCP did not enable:", error, file=sys.stderr)
        try:
            preferences.is_dirty = False
        except AttributeError:
            pass
    _start_agent_listener()


def _use_snapshot_repo():
    # Only this launch's snapshot loads: a repository of its own, pointing at nothing else.
    repos = bpy.context.preferences.extensions.repos
    for repo in [repo for repo in repos if repo.module == SNAPSHOT_REPO_MODULE]:
        repos.remove(repo)
    repos.new(name="T3 Blender Lab", module=SNAPSHOT_REPO_MODULE, custom_directory=MCP_SNAPSHOT, source="USER")


def _any_mcp_listening():
    return any(
        name.endswith(".mcp_to_blender_server") and _is_mcp_module(name) and module.is_running()
        for name, module in list(sys.modules.items())
        if module is not None and callable(getattr(module, "is_running", None))
    )


def _mcp_server():
    return sys.modules.get(_State.mcp_name + ".mcp_to_blender_server") if _State.mcp_name else None


def _cancel_mcp_autostart():
    module = sys.modules.get(_State.mcp_name) if _State.mcp_name else None
    autostart = getattr(module, "_autostart_timer", None)
    if autostart is not None and bpy.app.timers.is_registered(autostart):
        bpy.app.timers.unregister(autostart)


def _start_agent_listener():
    # Fails closed: a port another process holds, or a listener on any other port, is "failed".
    server = _mcp_server()
    try:
        guarded = server is not None and _guard_mcp_server(server)
        if guarded and not server.is_running():
            bpy.ops.blmcp.server_start()
        sock = getattr(getattr(server, "_state", None), "sock", None)
        ready = (
            guarded
            and server.is_running()
            and sock is not None
            and sock.getsockname()[1] == int(MCP_PORT)
        )
    except Exception as error:  # noqa: BLE001 - a listener that can't start is reported, never a crash
        print("T3 control add-on: Blender Lab MCP did not start:", error, file=sys.stderr)
        ready = False
    if not ready:
        _stop_agent_listener()
        _disable_mcp()
    _State.agent_listener = "ready" if ready else "failed"
    return None


def _on_authorized_file():
    current = os.path.realpath(bpy.data.filepath) if bpy.data.filepath else None
    return current is not None and current == _State.authorized_file


def _check_authorized_file():
    # Another file opened, or the copy saved under another name, is not what T3 authorized.
    if _State.grant == "granted" and not _on_authorized_file():
        _end_grant()


def _check_guard():
    # Blender Lab listens only for a live grant, guarded. Reload Scripts (which runs its module
    # again, unguarded) ends access; a listener started any other way is stopped.
    server = _mcp_server()
    running = server is not None and server.is_running()
    if _State.agent_listener == "ready" and not (running and _is_guarded(server)):
        _end_grant()
    elif running and not (_State.grant == "granted" and _State.agent_listener == "ready"):
        _stop_agent_listener()
        _disable_mcp()


def _end_grant():
    if _State.grant == "ended":
        return
    # Every ending passes here: deferred work that may already have written gets its step while
    # the grant still covers the file, so it isn't left looking saved.
    _record_pending_deferred()
    _State.grant = "ended"
    _stop_agent_listener()
    _disable_mcp()


def _disable_mcp():
    # Disabled and dropped from these settings, so neither its own Start button nor Reload
    # Scripts can reopen the port.
    if _State.mcp_name is not None:
        import addon_utils

        try:
            addon_utils.disable(_State.mcp_name, default_set=True)
        except Exception as error:  # noqa: BLE001 - reported, never a crash
            print("T3 control add-on: Blender Lab MCP did not disable:", error, file=sys.stderr)


def _stop_agent_listener():
    # Its stop closes the listening socket and every client connection.
    server = _mcp_server()
    try:
        if server is not None and server.is_running():
            bpy.ops.blmcp.server_stop()
    except Exception as error:  # noqa: BLE001 - reported, never a crash
        print("T3 control add-on: Blender Lab MCP did not stop:", error, file=sys.stderr)
    if server is not None and server.is_running():
        server.stop()
    _cancel_mcp_autostart()
    _State.agent_listener = "off"


def _has_viewport_window():
    return _viewport() is not None


# Marks T3's viewport window on its screen, which a saved file keeps, so a file brings it back
# recognisably while a second 3D view the person made is never mistaken for it.
VIEWPORT_MARKER = "t3_viewport"


def _viewport_windows():
    # T3's viewport windows: this session's, and any a loaded file brought back.
    windows = bpy.context.window_manager.windows
    return [
        window
        for index, window in enumerate(windows)
        if index > 0 and window.screen.get(VIEWPORT_MARKER)
    ]


def _open_viewport_window():
    # The pane streams this window alone, so the agent's own view in the main window never moves.
    window = _main_window()
    if window is None:
        return None
    found = _viewport_windows()
    own = [
        other
        for other in found
        if other.as_pointer() == _State.viewport_window and _lone_3d_view(other)
    ]
    # The hidden display streams the first lone 3D view window it finds, so a file's own (T3's
    # from an earlier session, marked or from a build before the mark, in its saved fullscreen
    # state, which the compositor's toggle undoes) would be streamed instead. After any load,
    # every one T3 didn't open this launch is replaced by a fresh one, on the first pass only.
    # T3's own turned into another editor goes too: it would go on being streamed.
    windows = bpy.context.window_manager.windows
    restored = [
        other
        for index, other in enumerate(windows)
        if index > 0
        and other.as_pointer() not in {kept.as_pointer() for kept in own}
        and (
            other.as_pointer() == _State.viewport_window
            or _State.replace_loaded
            and (other.screen.get(VIEWPORT_MARKER) or _lone_3d_view(other))
        )
    ]
    _State.replace_loaded = False
    if not own:
        _State.viewport_window = None
    if restored:
        for other in restored:
            # Closing one can take its child windows with it.
            if other.as_pointer() not in {left.as_pointer() for left in windows}:
                continue
            with bpy.context.temp_override(window=other):
                bpy.ops.wm.window_close()
        return 0.2
    if own:
        return None
    areas = [area for area in window.screen.areas if area.type == "VIEW_3D"]
    if not areas:
        area = max(window.screen.areas, key=lambda area: area.width * area.height)
        area.type = "VIEW_3D"
        areas = [area]
    area = max(areas, key=lambda area: area.width * area.height)
    region = next(region for region in area.regions if region.type == "WINDOW")
    before = {other.as_pointer() for other in bpy.context.window_manager.windows}
    with bpy.context.temp_override(window=window, screen=window.screen, area=area, region=region):
        bpy.ops.screen.area_dupli("INVOKE_DEFAULT")
    opened = [
        other for other in bpy.context.window_manager.windows if other.as_pointer() not in before
    ]
    if opened:
        opened[-1].screen[VIEWPORT_MARKER] = True
        _State.viewport_window = opened[-1].as_pointer()
    return None


def _revision(path):
    try:
        info = os.stat(path)
    except OSError:
        return None
    return "%d:%d:%d:%d:%d" % (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _record_disk(path, revision):
    _State.disk_path = os.path.realpath(path) if path else None
    _State.disk_revision = revision


def _same_disk_file():
    # What Blender last read or saved is of the file it has open now.
    current = bpy.data.filepath
    return bool(current) and _State.disk_path == os.path.realpath(current) and _State.disk_revision is not None


def _changed_on_disk():
    # Saving would write what Blender read over whatever replaced it, or bring back a file that
    # was deleted. A file Blender never read or saved has nothing to conflict with.
    return _same_disk_file() and _revision(bpy.data.filepath) != _State.disk_revision


def _check_disk(command):
    # T3 says the file at this real path settled at this revision. A notice for another file, or
    # a revision Blender read or saved itself, is no change.
    current = bpy.data.filepath
    if not current or command.get("path") != os.path.realpath(current):
        return
    revision = command.get("revision")
    _State.stale = revision if revision is not None and revision != _State.disk_revision else None
    if _State.stale is None:
        _State.blocked = None
    if command.get("reload"):
        _State.reload_wanted = True


# Why a stale Blender hasn't reloaded yet. The first three clear by themselves, so a pane on
# screen tries again each tick until they do.
RETRY_RELOAD = ("agentWork", "images", "catalogs")
RELOAD_BLOCKERS = RETRY_RELOAD + ("copyFailed", "loadFailed")
# FileGlobal.filepath, which recovering a file takes as where it saves.
FILE_MAX = 1024


def _blend_blocks(view):
    # Block headers of an uncompressed little-endian .blend, in the format before Blender 5.0
    # ("BLENDER-v405": code, int32 length, pointer, int32 SDNA index, int32 count) or after it
    # ("BLENDER17-01v0500": code, int32 SDNA index, uint64 pointer, int64 length, int64 count).
    # Yields (code, SDNA index, data start, data end) and the pointer size, or nothing.
    if view[:7] != b"BLENDER":
        return [], 0
    if view[7:9] == b"17" and view[9:10] == b"-" and view[12:13] == b"v":
        offset, legacy, pointer = 17, False, 8
    elif view[7:8] in (b"_", b"-") and view[8:9] == b"v":
        offset, legacy, pointer = 12, True, 8 if view[7:8] == b"-" else 4
    else:
        return [], 0
    blocks = []
    while offset + 4 <= len(view):
        code = bytes(view[offset:offset + 4])
        if legacy:
            (length,) = struct.unpack_from("<i", view, offset + 4)
            (sdna,) = struct.unpack_from("<i", view, offset + 8 + pointer)
            header = 4 + 4 + pointer + 4 + 4
        else:
            (sdna,) = struct.unpack_from("<i", view, offset + 4)
            (length,) = struct.unpack_from("<q", view, offset + 16)
            header = 32
        if code == b"ENDB" or length < 0 or offset + header + length > len(view):
            break
        blocks.append((code, sdna, offset + header, offset + header + length))
        offset += header + length
    return blocks, pointer


def _struct_member(view, dna, struct_index, wanted, pointer):
    # Where a member of an SDNA struct starts and how long it is, read from the file's own DNA1
    # block, so any version's layout is taken as written.
    start, end = dna
    data = bytes(view[start:end])
    if data[:4] != b"SDNA" or data[4:8] != b"NAME":
        return None
    position = 8

    def strings(count):
        nonlocal position
        found = []
        for _ in range(count):
            stop = data.index(b"\0", position)
            found.append(data[position:stop].decode("latin-1"))
            position = stop + 1
        position = (position + 3) & ~3
        return found

    (count,) = struct.unpack_from("<i", data, position)
    position += 4
    names = strings(count)
    if data[position:position + 4] != b"TYPE":
        return None
    (count,) = struct.unpack_from("<i", data, position + 4)
    position += 8
    types = strings(count)
    if data[position:position + 4] != b"TLEN":
        return None
    lengths = struct.unpack_from("<%dh" % len(types), data, position + 4)
    position = (position + 4 + 2 * len(types) + 3) & ~3
    if data[position:position + 4] != b"STRC":
        return None
    (count,) = struct.unpack_from("<i", data, position + 4)
    position += 8
    for index in range(count):
        _type, fields = struct.unpack_from("<hh", data, position)
        position += 4
        offset = 0
        for _ in range(fields):
            field_type, field_name = struct.unpack_from("<hh", data, position)
            position += 4
            if index != struct_index:
                continue
            name = names[field_name]
            size = pointer if name.startswith("*") or name.startswith("(*") else lengths[field_type]
            for dimension in name.split("[")[1:]:
                size *= int(dimension.rstrip("]"))
            if name.split("[")[0] in wanted:
                return offset, size
            offset += size
        if index == struct_index:
            return None
    return None


def _fileglobal_path_field(view):
    # The byte range of FileGlobal.filepath (filename before 2.93) in the copy's GLOB block.
    blocks, pointer = _blend_blocks(view)
    glob = next((block for block in blocks if block[0] == b"GLOB"), None)
    dna = next((block for block in blocks if block[0] == b"DNA1"), None)
    if glob is None or dna is None:
        return None
    member = _struct_member(view, dna[2:], glob[1], ("filepath", "filename"), pointer)
    if member is None or member[1] != FILE_MAX or glob[2] + member[0] + FILE_MAX > glob[3]:
        return None
    return glob[2] + member[0], glob[2] + member[0] + FILE_MAX


def _write_copy_keeping_path(target, filepath):
    # For Blenders without wm.save_auto_save (before 5.2): a copy saved as it is, then the path in
    # its FileGlobal set to the open file's, as an autosave carries it, so restoring it saves to
    # the file. A copy leaves that path empty. Relative paths stay relative to the file's folder.
    import mmap

    part = target + ".part.blend"
    with bpy.context.temp_override(window=_main_window()):
        result = bpy.ops.wm.save_as_mainfile(
            filepath=part, copy=True, compress=False, relative_remap=False, check_existing=False
        )
    if "FINISHED" not in result:
        raise RuntimeError("the copy wasn't saved")
    wanted = filepath.encode()
    if len(wanted) >= FILE_MAX:
        raise RuntimeError("path too long")
    with open(part, "r+b") as file, mmap.mmap(file.fileno(), 0) as view:
        field = _fileglobal_path_field(view)
        # Anything else is a layout this doesn't know, so nothing is staged.
        if field is None or view[field[0]:field[1]].strip(b"\0"):
            raise RuntimeError("no empty file path in the copy's FileGlobal")
        view[field[0]:field[1]] = wanted + b"\0" * (FILE_MAX - len(wanted))
        view.flush()
    os.replace(part, target)


def _stage_unsaved():
    # Blender's unsaved work, written beside the launch's other recovery files with a note of the
    # file it is of, so T3, or its next start if it dies first, keeps it as that file's copy.
    base = os.path.dirname(os.path.normpath(bpy.app.tempdir))
    filepath = bpy.data.filepath
    _State.reload_copies += 1
    name = "t3-reload-%d.blend" % _State.reload_copies
    target = os.path.join(base, name)
    try:
        if "save_auto_save" in dir(bpy.ops.wm) and not FORCE_COPY_WRITER:
            # Blender's own autosave, which keeps the file's path; renamed at once, so its next
            # autosave can't overwrite it.
            stem = os.path.basename(filepath)[:-len(".blend")]
            autosave = os.path.join(base, "%s_%d_autosave.blend" % (stem, os.getpid()))
            with bpy.context.temp_override(window=_main_window()):
                if "FINISHED" not in bpy.ops.wm.save_auto_save():
                    return None
            os.replace(autosave, target)
        else:
            _write_copy_keeping_path(target, filepath)
        note = target[:-len(".blend")] + ".json"
        with open(note + ".part", "w") as out:
            json.dump({"filepath": filepath}, out)
        os.replace(note + ".part", note)
    except Exception as error:  # noqa: BLE001 - without a copy nothing is replaced
        print("T3 control add-on: could not keep unsaved changes:", error, file=sys.stderr)
        for leftover in (target, target + ".part.blend"):
            if os.path.exists(leftover):
                os.remove(leftover)
        return None
    return name


def _unstage(name):
    base = os.path.dirname(os.path.normpath(bpy.app.tempdir))
    for leftover in (name, name[:-len(".blend")] + ".json"):
        try:
            os.remove(os.path.join(base, leftover))
        except OSError:
            pass


def _reload_if_stale():
    # Jumps to the file on disk once T3 saw it settle and it hasn't moved since. Returns None once
    # current, "changing" while it is being written again, or what holds the reload.
    if _State.stale is None or not bpy.data.filepath:
        return None
    if _State.stale == _State.reload_failed:
        _State.blocked = "loadFailed"
        return _State.blocked
    if any(record["writes"] for record in _Guard.deferred):
        _State.blocked = "agentWork"
        return _State.blocked
    if _revision(bpy.data.filepath) != _State.stale:
        return "changing"
    # Edited images and asset catalogs live outside the .blend, where no copy could keep them.
    if any(image.is_dirty for image in bpy.data.images):
        _State.blocked = "images"
        return _State.blocked
    if _State.catalogs_unsaved:
        _State.blocked = "catalogs"
        return _State.blocked
    copy = None
    if bpy.data.is_dirty or _State.restored:
        copy = _stage_unsaved()
        if copy is None:
            _State.blocked = "copyFailed"
            return _State.blocked
        _send({"type": "reloading", "copy": copy, "filepath": bpy.data.filepath})
    target = _State.stale
    # Checked again right before it opens: written meanwhile, it waits for T3's next word.
    if _revision(bpy.data.filepath) != target:
        return "changing"
    # The current windows stay, T3's viewport window and its view among them.
    options = {} if AUTOEXEC else {"use_scripts": False}
    try:
        with bpy.context.temp_override(window=_main_window()):
            loaded = "FINISHED" in bpy.ops.wm.open_mainfile(
                filepath=bpy.data.filepath, load_ui=False, display_file_selector=False, **options
            )
    except Exception as error:  # noqa: BLE001 - the session as it was stays open
        print("T3 control add-on: reload failed:", error, file=sys.stderr)
        loaded = False
    if not loaded:
        _State.reload_failed = target
        _State.blocked = "loadFailed"
        return _State.blocked
    _State.restored = False
    _State.blocked = None
    # No window came from the file, so none is replaced.
    _State.replace_loaded = False
    # The file as loaded first, so T3 never shows the reload with the old unsaved mark.
    _publish_state()
    _send({"type": "reloaded", "kept": copy is not None})
    return None


STALE_REASONS = {
    "agentWork": "your earlier call is still running in it; try again once it has finished",
    "changing": "the file is still being written; try again in a moment",
    "images": "the user has unsaved image edits a recovery copy can't keep; ask them to save or discard those, then try again",
    "catalogs": "the user has unsaved asset catalog edits a recovery copy can't keep; ask them to save or discard those, then try again",
    "copyFailed": "T3 Code couldn't keep its unsaved changes first; try again in a moment",
    "loadFailed": "Blender couldn't load the file as it is on disk now; try again once the file changes",
}


def _catch_up_for_agent():
    # The agent works on the file as it is on disk. None once Blender has it; otherwise why not.
    outcome = _reload_if_stale()
    if _State.stale is None:
        # Written after Blender read it, before T3's word: T3 is asked to look now, so the retry
        # doesn't wait on a watch event that may never come. A file gone has nothing to load.
        current = _revision(bpy.data.filepath) if bpy.data.filepath else None
        if current is None or current == _State.disk_revision or not _same_disk_file():
            return None
        _send({"type": "checkDisk"})
        outcome = "changing"
    return (
        "The .blend this Blender has open changed on disk and Blender hasn't loaded it yet: "
        + STALE_REASONS.get(outcome or "changing", STALE_REASONS["changing"])
        + ". Nothing was run."
    )


def _restore_copy(command):
    # A copy T3 kept of this file, put back over it unsaved. Never over another file, and never
    # over unsaved work unasked; asked, that work is kept first as the file's copy.
    if bpy.data.filepath != command.get("filepath"):
        return {"outcome": "otherFile"}
    # Edited images and asset catalogs live outside the .blend: no copy keeps them, and the load
    # drops them.
    if _State.catalogs_unsaved or any(image.is_dirty for image in bpy.data.images):
        return {"outcome": "unkeepable"}
    unsaved = bpy.data.is_dirty or _State.restored
    if unsaved and not command.get("replace"):
        return {"outcome": "unsaved"}
    copy = None
    if bpy.data.is_dirty or _State.restored:
        copy = _stage_unsaved()
        if copy is None:
            return {"outcome": "failed"}
    try:
        with bpy.context.temp_override(window=_main_window()):
            restored = "FINISHED" in bpy.ops.wm.recover_auto_save(filepath=command["path"], use_scripts=False)
    except Exception as error:  # noqa: BLE001 - reported to T3, which keeps the copy
        print("T3 control add-on: restore failed:", error, file=sys.stderr)
        restored = False
    if not restored:
        # Blender still has what the copy would have kept.
        if copy is not None:
            _unstage(copy)
        return {"outcome": "failed"}
    _State.restored = True
    return {"outcome": "restored", "copy": copy, "filepath": bpy.data.filepath, "loadedAt": _State.loaded_at}


@persistent
def _on_save_post(*args):
    _State.restored = False
    _check_authorized_file()
    # Saving the .blend saves its asset catalogs too.
    _State.catalogs_unsaved = False
    # A save of the open file made in Blender (Ctrl+S, or code), which Blender stays open after,
    # is a confirmed save that T3 forgets the file's older copy on. A copy saved elsewhere names
    # another path than the open file's.
    target = args[0] if args and isinstance(args[0], str) else ""
    if not target or target != bpy.data.filepath:
        return
    # The one fact of this save: what is on disk now is Blender's own.
    _record_disk(target, _revision(target))
    _State.stale = None
    _State.blocked = None
    if not _State.quit_saving:
        _send({
            "type": "saved",
            "filepath": bpy.data.filepath,
            "dirty": bool(bpy.data.is_dirty),
            "quit": False,
        })


@persistent
def _on_load_pre(*args):
    target = args[0] if args and isinstance(args[0], str) else ""
    _State.loading = (os.path.realpath(target), _revision(target)) if target else None


@persistent
def _on_load_post(*_args):
    # Read before the load, so a change made while a large file loads still counts as one.
    loading, _State.loading = _State.loading, None
    current = bpy.data.filepath
    if loading is not None and current and loading[0] == os.path.realpath(current):
        _record_disk(current, loading[1])
    elif not current or os.path.realpath(current) != _State.disk_path:
        # Recovered another file's copy, which says nothing of that file as it was read.
        _record_disk(current, _revision(current) if current else None)
    # A copy recovered over the same file keeps what Blender last read of it: the file wasn't
    # read again, so a change on disk since still counts as one.
    _State.stale = None
    _State.blocked = None
    _State.reload_failed = None
    _State.loaded_at = time.time() * 1000
    _check_authorized_file()
    _State.replace_loaded = True
    bpy.app.timers.register(_open_viewport_window, first_interval=0.2)


def register():
    if bpy.data.filepath:
        _record_disk(bpy.data.filepath, LAUNCH_REVISION or _revision(bpy.data.filepath))
    _setup_mcp_addon()
    _keep_recovery_files()
    try:
        bpy.context.preferences.is_dirty = False
    except AttributeError:
        pass
    if SOCKET_PATH is not None:
        _State.server = _listen()
        bpy.app.timers.register(_tick, first_interval=TICK, persistent=True)
    bpy.app.handlers.load_pre.append(_on_load_pre)
    bpy.app.handlers.load_post.append(_on_load_post)
    # Save As to another name is another file too, checked before anything else can run.
    bpy.app.handlers.save_post.append(_on_save_post)
    if RECOVER_PATH is not None:
        bpy.app.timers.register(_recover, first_interval=0.1)
    bpy.app.timers.register(_open_viewport_window, first_interval=0.5)


register()
`;
