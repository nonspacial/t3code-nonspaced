// T3's control add-on, written beside each hosted Blender and loaded with `--python`. It is
// never installed, so desktop Blenders never see it. Kept as a string so it ships inside the
// server bundle.
export const CONTROL_ADDON_SOURCE = String.raw`
import json
import os
import socket
import struct
import sys

import bpy
from bpy.app.handlers import persistent


def _option(name):
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return argv[argv.index(name) + 1] if name in argv[:-1] else None


SOCKET_PATH = _option("--t3-control")
MCP_PORT = _option("--t3-mcp-port")
MCP_LISTEN = "--t3-mcp-listen" in (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
TICK = 0.1


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


def _handle(command):
    kind = command.get("type")
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


def _is_mcp_addon(name):
    return name.startswith("bl_ext.") and name.endswith(".mcp")


def _setup_mcp_addon():
    # The official MCP add-on runs agent code, so it listens only for a thread whose agent
    # session uses it (--t3-mcp-listen), on the port T3 assigned. Otherwise disabling it for
    # the session (not in the settings) runs its unregister, which cancels the autostart timer
    # it registered before this script ran. T3's wrapper for the listener belongs here.
    import addon_utils

    preferences = bpy.context.preferences
    names = [name for name in preferences.addons.keys() if _is_mcp_addon(name)]
    if MCP_LISTEN and not names:
        installed = [module.__name__ for module in addon_utils.modules() if _is_mcp_addon(module.__name__)]
        for name in installed[:1]:
            addon_utils.enable(name, default_set=False)
            names.append(name)
    for name in names:
        addon = preferences.addons.get(name)
        if addon is not None and MCP_PORT is not None and addon.preferences is not None:
            if hasattr(addon.preferences, "port"):
                addon.preferences.port = int(MCP_PORT)
                addon.preferences.host = "localhost"
        if not MCP_LISTEN:
            addon_utils.disable(name, default_set=False)
    try:
        preferences.is_dirty = False
    except AttributeError:
        pass


def _has_viewport_window():
    windows = bpy.context.window_manager.windows
    return any(
        index > 0 and len(window.screen.areas) == 1 and window.screen.areas[0].type == "VIEW_3D"
        for index, window in enumerate(windows)
    )


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
    _setup_mcp_addon()
    if SOCKET_PATH is not None:
        _State.server = _listen()
        bpy.app.timers.register(_tick, first_interval=TICK, persistent=True)
    bpy.app.handlers.load_post.append(_on_load_post)
    bpy.app.timers.register(_open_viewport_window, first_interval=0.5)


register()
`;
