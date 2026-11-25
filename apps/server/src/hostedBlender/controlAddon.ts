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
# The launch's own copy of Blender Lab: a folder holding its "mcp" package.
MCP_SNAPSHOT = _option("--t3-mcp-snapshot")
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
    mcp_version = None
    mcp_file = None
    # Blender Lab modules already imported when this add-on loaded: T3's gate didn't hold.
    startup_mcp = []
    server = None
    client = None
    buffer = b""
    sent = None
    # Quit requests T3 gave up on; one still waiting here is never carried out.
    cancelled_quits = set()
    # Seen with unsaved asset catalogs, until a save or an askable asset browser says otherwise.
    catalogs_unsaved = False


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
    return {
        "type": "state",
        "filepath": bpy.data.filepath,
        "dirty": bool(bpy.data.is_dirty),
        "agentListener": _State.agent_listener,
        "agentActing": _agent_acting(_mcp_server()),
        "mcpVersion": _State.mcp_version,
    }


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


def _viewport():
    # The person's viewport window: the one _open_viewport_window made, never the main window.
    windows = bpy.context.window_manager.windows
    for index, window in enumerate(windows):
        areas = window.screen.areas
        if index == 0 or len(areas) != 1 or areas[0].type != "VIEW_3D":
            continue
        area = areas[0]
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
    if kind == "cancelQuit":
        _State.cancelled_quits.add(command.get("id"))
        _send({"type": "quitCancelled", "id": command.get("id")})
        return
    if kind == "quitIfClean":
        if command.get("id") in _State.cancelled_quits:
            return
        # Decided here, at the moment of quitting, with no dialog nobody could answer: T3's last
        # word on unsaved changes may be stale.
        if not _session_is_clean():
            _send({"type": "quitRefused", "id": command.get("id")})
            return
        with bpy.context.temp_override(window=_main_window()):
            bpy.ops.wm.quit_blender()
        return
    if kind == "quit":
        if command.get("save"):
            # Answered before the save, which blocks Blender for as long as a big file takes.
            _send({"type": "saving"})
            if not _save():
                _send({"type": "quitFailed", "reason": "saveFailed"})
                return
            _send({"type": "saved"})
        window = _main_window()
        with bpy.context.temp_override(window=window):
            bpy.ops.wm.quit_blender()


# Libraries whose catalogs can't be edited, so an asset browser on one can't tell.
READ_ONLY_LIBRARIES = {"ALL", "ESSENTIALS"}


def _catalog_state():
    # Blender's own quit check also covers asset catalogs, which Python can read only through
    # catalogs_save's poll, in an asset browser on an editable library. True or False from one
    # that can be asked; "unknown" when browsers exist but none can be; "none" without any.
    unknown = False
    for screen in bpy.data.screens:
        for area in screen.areas:
            for space in area.spaces:
                if space.type != "FILE_BROWSER" or getattr(space, "browse_mode", "") != "ASSETS":
                    continue
                window = next(
                    (window for window in bpy.context.window_manager.windows if window.screen == screen),
                    None,
                )
                params = getattr(space, "params", None)
                library = getattr(params, "asset_library_reference", None)
                if window is None or space != area.spaces.active or library in READ_ONLY_LIBRARIES or library is None:
                    unknown = True
                    continue
                with bpy.context.temp_override(window=window, area=area, space_data=space):
                    return bool(bpy.ops.asset.catalogs_save.poll())
    return "unknown" if unknown else "none"


def _watch_catalogs():
    # Asked every tick, so an edit is remembered after its asset browser is gone or switched.
    try:
        state = _catalog_state()
    except Exception:  # noqa: BLE001 - a failed look leaves the last answer standing
        return
    if state is True:
        _State.catalogs_unsaved = True
    elif state is False:
        _State.catalogs_unsaved = False


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


def _open_viewport_window():
    # The pane streams this window alone, so the agent's own view in the main window never moves.
    window = _main_window()
    if window is None or _has_viewport_window():
        return None
    areas = [area for area in window.screen.areas if area.type == "VIEW_3D"]
    if not areas:
        area = max(window.screen.areas, key=lambda area: area.width * area.height)
        area.type = "VIEW_3D"
        areas = [area]
    area = max(areas, key=lambda area: area.width * area.height)
    region = next(region for region in area.regions if region.type == "WINDOW")
    with bpy.context.temp_override(window=window, screen=window.screen, area=area, region=region):
        bpy.ops.screen.area_dupli("INVOKE_DEFAULT")
    return None


@persistent
def _on_save_post(*_args):
    _check_authorized_file()
    # Saving the .blend saves its asset catalogs too.
    _State.catalogs_unsaved = False


@persistent
def _on_load_post(*_args):
    _check_authorized_file()
    bpy.app.timers.register(_open_viewport_window, first_interval=0.2)


def register():
    _setup_mcp_addon()
    if SOCKET_PATH is not None:
        _State.server = _listen()
        bpy.app.timers.register(_tick, first_interval=TICK, persistent=True)
    bpy.app.handlers.load_post.append(_on_load_post)
    # Save As to another name is another file too, checked before anything else can run.
    bpy.app.handlers.save_post.append(_on_save_post)
    bpy.app.timers.register(_open_viewport_window, first_interval=0.5)


register()
`;
