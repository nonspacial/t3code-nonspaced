// T3's control add-on, written beside each hosted Blender and loaded with `--python`. It is
// never installed, so desktop Blenders never see it. Kept as a string so it ships inside the
// server bundle.
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
MCP_LISTEN = "--t3-mcp-listen" in (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
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
    # Restored viewport windows already asked to close, by pointer.
    closed_viewports = set()


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
    }
    if _State.restore is not None:
        snapshot["restore"] = _State.restore
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
def _viewport():
    # The person's viewport window: the one _open_viewport_window made, never the main window.
    windows = bpy.context.window_manager.windows
    candidates = [window for window in _viewport_windows() if window.as_pointer() == _State.viewport_window]
    candidates += [
        window
        for index, window in enumerate(windows)
        if index > 0 and len(window.screen.areas) == 1 and window.screen.areas[0].type == "VIEW_3D"
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
    if kind == "grantAgentListener":
        _grant_agent_listener()
        return
    if kind == "quit":
        if not command.get("save"):
            # T3 waits on this rather than stopping a Blender still writing its quit copy.
            _send({"type": "quitting"})
            _push_undo_step()
        else:
            # Answered before the save, which blocks Blender for as long as a big file takes.
            _send({"type": "saving"})
            if not _save():
                _send({"type": "quitFailed", "reason": "saveFailed"})
                return
            # Saved, so Blender quits next: the agent's grant ends now, as T3's stop would
            # come too late once quitting begins.
            _end_grant()
            _send({"type": "saved"})
        window = _main_window()
        with bpy.context.temp_override(window=window):
            bpy.ops.wm.quit_blender()


def _tick():
    if _State.server is None:
        return None
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
    if _State.client is not None:
        try:
            while True:
                chunk = _State.client.recv(65536)
                if not chunk:
                    _drop_client()
                    break
                _State.buffer += chunk
        except BlockingIOError:
            pass
        except OSError:
            _drop_client()
        # A stop already waiting wins over a grant queued before it.
        for queued in _State.buffer.split(b"\n")[:-1]:
            try:
                if json.loads(queued).get("type") == "stopAgentListener":
                    _end_grant()
                    break
            except ValueError:
                pass
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
        _check_authorized_file()
        snapshot = _snapshot()
        if snapshot != _State.sent:
            _State.sent = snapshot
            _send(snapshot)
    return TICK


def _is_mcp_addon(name):
    return name.startswith("bl_ext.") and name.endswith(".mcp")


def _setup_mcp_addon():
    # The official MCP add-on runs agent code. However the copied settings left it, it starts
    # disabled, with no Start button and no autostart, and comes back only when T3 grants this
    # Blender's thread its agent (see _grant_agent_listener). Disabling with default_set also
    # drops it from these settings (T3's own copy), so Reload Scripts can't bring it back.
    import addon_utils

    preferences = bpy.context.preferences
    for name in [name for name in preferences.addons.keys() if _is_mcp_addon(name)]:
        addon_utils.disable(name, default_set=True)
    if MCP_LISTEN:
        installed = [module.__name__ for module in addon_utils.modules() if _is_mcp_addon(module.__name__)]
        _State.mcp_name = installed[0] if installed else None
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
    if _State.mcp_name is not None:
        import addon_utils

        preferences = bpy.context.preferences
        try:
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
        if server is not None and not server.is_running():
            bpy.ops.blmcp.server_start()
        sock = getattr(getattr(server, "_state", None), "sock", None)
        ready = (
            server is not None
            and server.is_running()
            and sock is not None
            and sock.getsockname()[1] == int(MCP_PORT)
        )
    except Exception as error:  # noqa: BLE001 - a listener that can't start is reported, never a crash
        print("T3 control add-on: Blender Lab MCP did not start:", error, file=sys.stderr)
        ready = False
    if not ready and server is not None and server.is_running():
        _stop_agent_listener()
    _State.agent_listener = "ready" if ready else "failed"
    return None


def _check_authorized_file():
    # Another file opened, or the copy saved under another name, is not what T3 authorized.
    if _State.grant != "granted":
        return
    current = os.path.realpath(bpy.data.filepath) if bpy.data.filepath else None
    if current is None or current != _State.authorized_file:
        _end_grant()


def _end_grant():
    if _State.grant == "ended":
        return
    _State.grant = "ended"
    _stop_agent_listener()
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
    own = [other for other in found if other.as_pointer() == _State.viewport_window]
    # A file saved with T3's viewport window open (a recovery copy, or a save from here) brings
    # it back in its saved fullscreen state, which the compositor's fullscreen toggle then
    # undoes. It is replaced by a fresh one, which fills the display as on a first open. One
    # that didn't close when asked is left be rather than asked again forever.
    restored = [
        other
        for other in found
        if other.as_pointer() != _State.viewport_window
        and other.as_pointer() not in _State.closed_viewports
    ]
    if restored:
        for other in restored:
            _State.closed_viewports.add(other.as_pointer())
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


@persistent
def _on_save_post(*_args):
    _State.restored = False
    _check_authorized_file()


@persistent
def _on_load_post(*_args):
    _check_authorized_file()
    bpy.app.timers.register(_open_viewport_window, first_interval=0.2)


def register():
    _setup_mcp_addon()
    _keep_recovery_files()
    try:
        bpy.context.preferences.is_dirty = False
    except AttributeError:
        pass
    if SOCKET_PATH is not None:
        _State.server = _listen()
        bpy.app.timers.register(_tick, first_interval=TICK, persistent=True)
    bpy.app.handlers.load_post.append(_on_load_post)
    # Save As to another name is another file too, checked before anything else can run.
    bpy.app.handlers.save_post.append(_on_save_post)
    if RECOVER_PATH is not None:
        bpy.app.timers.register(_recover, first_interval=0.1)
    bpy.app.timers.register(_open_viewport_window, first_interval=0.5)


register()
`;
