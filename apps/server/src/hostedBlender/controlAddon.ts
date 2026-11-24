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
RECOVER_PATH = _option("--t3-recover")
TICK = 0.1


class _State:
    server = None
    client = None
    buffer = b""
    sent = None
    # A restored session until it is marked unsaved or saved.
    restored = False


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


def _handle(command):
    kind = command.get("type")
    if kind == "quit":
        if not command.get("save"):
            _push_undo_step()
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


def _use_private_temp():
    # Copied settings may name a temporary folder shared with the desktop Blender; this session
    # keeps its quit copy and autosaves in the private TMPDIR T3 gave it, where T3 finds them.
    filepaths = bpy.context.preferences.filepaths
    if filepaths.temporary_directory:
        filepaths.temporary_directory = ""


def _recover():
    # Restores a recovery copy or autosave over the file Blender opened. Blender recovers its
    # own session files with their original path, so saving still writes the user's file.
    window = _main_window()
    try:
        with bpy.context.temp_override(window=window):
            _State.restored = "FINISHED" in bpy.ops.wm.recover_auto_save(filepath=RECOVER_PATH)
    except Exception as error:  # noqa: BLE001 - the file as saved stays open
        print("T3 control add-on: recovery failed:", error, file=sys.stderr)
    return None


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
def _on_save_post(*_args):
    _State.restored = False


@persistent
def _on_load_post(*_args):
    bpy.app.timers.register(_open_viewport_window, first_interval=0.2)


def register():
    _disable_mcp_addon()
    _use_private_temp()
    try:
        bpy.context.preferences.is_dirty = False
    except AttributeError:
        pass
    if SOCKET_PATH is not None:
        _State.server = _listen()
        bpy.app.timers.register(_tick, first_interval=TICK, persistent=True)
    bpy.app.handlers.load_post.append(_on_load_post)
    bpy.app.handlers.save_post.append(_on_save_post)
    if RECOVER_PATH is not None:
        bpy.app.timers.register(_recover, first_interval=0.1)
    bpy.app.timers.register(_open_viewport_window, first_interval=0.5)


register()
`;
