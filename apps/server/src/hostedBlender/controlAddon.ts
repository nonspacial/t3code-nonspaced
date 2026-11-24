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
from bpy.app.handlers import persistent
from mathutils import Matrix, Vector


def _option(name):
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return argv[argv.index(name) + 1] if name in argv[:-1] else None


SOCKET_PATH = _option("--t3-control")
MCP_PORT = _option("--t3-mcp-port")
TICK = 0.1
# Casting a mark's samples stops after this long, as the 3D preview's does.
HIT_BUDGET = 0.1


class _State:
    server = None
    client = None
    buffer = b""
    sent = None


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
    _State.client = None
    _State.buffer = b""
    _State.sent = None


def _snapshot():
    return {"type": "state", "filepath": bpy.data.filepath, "dirty": bool(bpy.data.is_dirty)}


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
            return window, area, region, area.spaces.active.region_3d
    return None


def _camera_view(rv3d):
    camera = bpy.context.scene.camera
    if rv3d.view_perspective == "CAMERA" and camera is not None:
        position = camera.matrix_world.translation
        forward = camera.matrix_world.to_quaternion() @ Vector((0.0, 0.0, -1.0))
        target = position + forward * rv3d.view_distance
    else:
        target = rv3d.view_location
        position = target + rv3d.view_rotation @ Vector((0.0, 0.0, rv3d.view_distance))
    return {"position": list(position), "target": list(target), "upAxis": "z"}


def _view():
    found = _viewport()
    if found is None:
        return None
    window, _area, region, rv3d = found
    width, height = window.width, window.height
    # The matrix the last frame was drawn with, which is the frame the person froze.
    matrix = [value for row in rv3d.perspective_matrix for value in row]
    return {
        "cameraView": _camera_view(rv3d),
        "projection": {
            "matrix": matrix,
            "region": {
                "x": region.x / width,
                "y": 1 - (region.y + region.height) / height,
                "width": region.width / width,
                "height": region.height / height,
            },
        },
    }


def _hits(command):
    inverse = Matrix([command["matrix"][row * 4:row * 4 + 4] for row in range(4)]).inverted()
    region = command["region"]
    depsgraph = bpy.context.evaluated_depsgraph_get()
    scene = bpy.context.scene
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
    _window, area, _region, rv3d = found
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
    requests = {"view": _view, "hits": lambda: _hits(command), "setView": lambda: _set_view(command)}
    if kind in requests:
        try:
            result = requests[kind]()
        except Exception as error:  # noqa: BLE001 - a failed request answers null, never a crash
            print("T3 control add-on:", kind, "failed:", error, file=sys.stderr)
            result = None
        _send({"type": "reply", "id": command.get("id"), "result": result})
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
        while b"\n" in _State.buffer:
            line, _State.buffer = _State.buffer.split(b"\n", 1)
            try:
                _handle(json.loads(line))
            except Exception as error:  # noqa: BLE001 - a bad command must not stop the add-on
                print("T3 control add-on:", error, file=sys.stderr)
        snapshot = _snapshot()
        if snapshot != _State.sent:
            _State.sent = snapshot
            _send(snapshot)
    return TICK


def _disable_mcp_addon():
    # The copied settings may enable the official MCP add-on, whose code-execution listener
    # stays off until T3 can turn away other OS users. Its saved port becomes T3's for this
    # instance, and disabling it for the session (not in the settings) runs its unregister,
    # which cancels the autostart timer it registered before this script ran.
    import addon_utils

    preferences = bpy.context.preferences
    names = [
        name
        for name in preferences.addons.keys()
        if name.startswith("bl_ext.") and name.endswith(".mcp")
    ]
    for name in names:
        addon = preferences.addons[name]
        if MCP_PORT is not None and addon.preferences is not None:
            if hasattr(addon.preferences, "port"):
                addon.preferences.port = int(MCP_PORT)
                addon.preferences.host = "localhost"
        addon_utils.disable(name, default_set=False)
    try:
        preferences.is_dirty = False
    except AttributeError:
        pass


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
def _on_load_post(*_args):
    bpy.app.timers.register(_open_viewport_window, first_interval=0.2)


def register():
    _disable_mcp_addon()
    if SOCKET_PATH is not None:
        _State.server = _listen()
        bpy.app.timers.register(_tick, first_interval=TICK, persistent=True)
    bpy.app.handlers.load_post.append(_on_load_post)
    bpy.app.timers.register(_open_viewport_window, first_interval=0.5)


register()
`;
