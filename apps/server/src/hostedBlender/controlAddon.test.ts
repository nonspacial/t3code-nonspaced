// @effect-diagnostics nodeBuiltinImport:off - runs the add-on under python3 with stand-in Blender modules.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { HOSTED_STARTUP_GATE_SOURCE } from "./agentGuard.ts";
import { CONTROL_ADDON_SOURCE } from "./controlAddon.ts";

// The launch snapshot's module, as the control add-on enables it.
const MCP = "bl_ext.t3_blender_lab.mcp";

// Blender and Blender Lab's MCP 1.0.3, stood in for: its server binds a real socket. As in
// Blender's addon_utils, `default_set=False` leaves the preference entry that Reload Scripts
// registers again, and the extension's operators exist only while it is registered.
const STUBS = {
  "bpy/__init__.py": String.raw`
import json, os, types
state = json.loads(os.environ["STUB_STATE"])
class Prefs:
    def __init__(self): self.port = 9876; self.host = "0.0.0.0"; self.use_autostart = True
class Addon:
    def __init__(self, module): self.module = module; self.preferences = Prefs()
# Like Blender's collection: iterating gives Addon entries, each with its module name.
class Addons(dict):
    def keys(self): return list(super().keys())
    def __iter__(self): return iter(list(self.values()))
    def remove(self, addon): self.pop(addon.module)
addons = Addons({name: Addon(name) for name in state["enabled"]})
class Repos(list):
    def new(self, name, module, custom_directory, source):
        import addon_utils
        addon_utils.log("repo", module, custom_directory)
        repo = types.SimpleNamespace(name=name, module=module, directory=custom_directory)
        self.append(repo)
        return repo
import contextlib
# The main window's screen; assetBrowser adds an asset browser, shown or out of view.
class _Spaces(list):
    active = None
_view3d = types.SimpleNamespace(type="VIEW_3D")
_assets = types.SimpleNamespace(type="FILE_BROWSER", browse_mode="ASSETS", params=types.SimpleNamespace(asset_library_reference="lib"))
# Blender's unsaved-catalog state, which only catalogs_save's poll reads.
world = {"unsaved": state.get("unsavedCatalogs", False)}
_spaces = _Spaces([_view3d] + ([_assets] if state.get("assetBrowser") else []))
_spaces.active = _assets if state.get("assetBrowser") == "shown" else _view3d
_area = types.SimpleNamespace(width=800, height=600, spaces=_spaces)
_screen = types.SimpleNamespace(areas=[_area])
_windows = [] if state.get("noWindow") else [types.SimpleNamespace(screen=_screen)]
context = types.SimpleNamespace(
    preferences=types.SimpleNamespace(
        addons=addons,
        is_dirty=True,
        filepaths=types.SimpleNamespace(temporary_directory=""),
        edit=types.SimpleNamespace(
            undo_steps=state.get("undoSteps", 32), use_global_undo=state.get("globalUndo", True)
        ),
        extensions=types.SimpleNamespace(repos=Repos()),
    ),
    window_manager=types.SimpleNamespace(windows=_windows),
    temp_override=lambda **_kwargs: contextlib.nullcontext(),
    mode="OBJECT",
)
images = [types.SimpleNamespace(name=name, is_dirty=True) for name in state.get("dirtyImages", [])]
data = types.SimpleNamespace(filepath=state.get("filepath", "/work/hero.wip-1a2b3c4d.blend"), is_dirty=False, images=images, screens=[_screen])
from . import app, ops
# Blender runs startup scripts (T3's gate), then registers the enabled add-ons, then --python.
if not state.get("gateSkipped"):
    import t3_hosted_gate
import addon_utils
for name in [addon.module for addon in addons]:
    addon_utils.register(name)
`,
  "bpy/app/__init__.py": String.raw`
import types
registered = []
def _register(function, **kwargs): registered.append(function)
def _unregister(function): registered.remove(function)
timers = types.SimpleNamespace(
    register=_register,
    unregister=_unregister,
    is_registered=lambda function: function in registered,
)
from . import handlers
`,
  "bpy/app/handlers.py":
    "load_post = []\nsave_post = []\ndepsgraph_update_post = []\ndef persistent(function):\n    return function\n",
  "bpy/ops.py": String.raw`
import sys, types
NAME = "${MCP}"
def _operator(run):
    def call():
        import addon_utils
        if NAME not in addon_utils.registered:
            raise AttributeError("bpy.ops.blmcp has no such operator")
        return run()
    return call
def _start():
    import bpy
    prefs = bpy.context.preferences.addons[NAME].preferences
    try:
        sys.modules[NAME + ".mcp_to_blender_server"].start(prefs.host, prefs.port)
    except Exception:
        return {"CANCELLED"}
    return {"FINISHED"}
def _stop():
    sys.modules[NAME + ".mcp_to_blender_server"].stop()
    return {"FINISHED"}
blmcp = types.SimpleNamespace(server_start=_operator(_start), server_stop=_operator(_stop))
def _quit(*args):
    import addon_utils
    addon_utils.log("quit_blender", *args)
    return {"FINISHED"}
wm = types.SimpleNamespace(quit_blender=_quit)
def _catalogs_poll():
    import bpy
    # Blender's own unsaved-catalog state, read through an asset browser; on a library whose
    # catalogs can't be edited, as All, it answers False whatever is unsaved.
    # An unavailable or read-only library (here "missing") answers False too.
    return bpy.world["unsaved"] and bpy._assets.params.asset_library_reference not in ("ALL", "ESSENTIALS", "missing")
import json as _json, os as _os
state = _json.loads(_os.environ["STUB_STATE"])
asset = types.SimpleNamespace(catalogs_save=types.SimpleNamespace(poll=_catalogs_poll))
def _undo_push(message):
    import bpy, addon_utils
    addon_utils.log("undo_push", message)
    if bpy.state.get("undoPushFails"):
        return {"CANCELLED"}
    # As in Blender: data edits leave the file clean; an undo push marks it modified.
    if not bpy.state.get("undoPushLeavesClean"):
        bpy.data.is_dirty = True
    return {"FINISHED"}
ed = types.SimpleNamespace(undo_push=_undo_push)
`,
  // Imported at the top for the capture and hit tests, which register() never runs.
  "gpu.py": "",
  "mathutils.py": "class Matrix: pass\nclass Vector: pass\n",
  "bl_ext/__init__.py": "",
  "bl_ext/t3_blender_lab/__init__.py": "",
  "bl_ext/t3_blender_lab/mcp/__init__.py": String.raw`
import bpy
from . import mcp_to_blender_server
def _autostart_timer(): mcp_to_blender_server.start("localhost", 9876)
def register():
    # Like 1.0.3, it reads its preferences, which must exist.
    if bpy.context.preferences.addons[__package__].preferences.use_autostart:
        bpy.app.timers.register(_autostart_timer)
def unregister():
    if bpy.app.timers.is_registered(_autostart_timer):
        bpy.app.timers.unregister(_autostart_timer)
    mcp_to_blender_server.stop()
`,
  // Like 1.0.3's: it drops a client that disconnects or times out without asking its checker again.
  "bl_ext/t3_blender_lab/mcp/deferred_tool.py": String.raw`
class _DeferredClient:
    def __init__(self, conn, check_fn): self.conn = conn; self.check_fn = check_fn
_deferred_clients = []
def has_pending(): return bool(_deferred_clients)
`,
  "t3_hosted_gate.py": HOSTED_STARTUP_GATE_SOURCE,
  // 1.0.3's accept and execute path, which poll() looks up by name on each call.
  "bl_ext/t3_blender_lab/mcp/mcp_to_blender_server.py": String.raw`
import json, socket, types
from typing import NamedTuple
from . import deferred_tool
class _Client:
    def __init__(self, conn): self.conn = conn; self.buffer = bytearray()
class _ExecResult(NamedTuple):
    response: dict
    check_fn: object = None
_state = types.SimpleNamespace(sock=None, clients=[])
def is_running(): return _state.sock is not None
def _execute_code(code, strict_json):
    namespace = {"result": {}}
    exec(code, namespace)
    check = namespace.get("check_is_finished")
    if callable(check):
        return _ExecResult({}, check)
    return _ExecResult({"status": "ok", "result": namespace["result"]})
def _accept_clients():
    while True:
        try:
            conn, _addr = _state.sock.accept()
        except OSError:
            break
        conn.setblocking(False)
        _state.clients.append(_Client(conn))
def poll():
    # Deferred work first, so a call made in this poll finishes in a later one, as in Blender.
    for client in deferred_tool._deferred_clients[:]:
        try:
            done = client.check_fn()
        except Exception as error:
            # Like 1.0.3's _remove_deferred, a client already closed by stop() is fine.
            if client in deferred_tool._deferred_clients:
                deferred_tool._deferred_clients.remove(client)
            _reply(client.conn, {"status": "error", "message": str(error)})
            continue
        if done is not None:
            if client in deferred_tool._deferred_clients:
                deferred_tool._deferred_clients.remove(client)
            _reply(client.conn, {"status": "ok", "result": done})
    _accept_clients()
    for client in _state.clients[:]:
        try:
            client.buffer.extend(client.conn.recv(65536))
        except BlockingIOError:
            continue
        if b"\0" not in client.buffer:
            continue
        request = json.loads(bytes(client.buffer[:client.buffer.index(b"\0")]))
        result = _execute_code(request["code"], request["strict_json"])
        _state.clients.remove(client)
        if result.check_fn is not None:
            deferred_tool._deferred_clients.append(deferred_tool._DeferredClient(client.conn, result.check_fn))
            continue
        _reply(client.conn, result.response)
def _reply(conn, response):
    try:
        conn.sendall((json.dumps(response) + "\0").encode())
    except OSError:
        pass
    conn.close()
def start(host, port):
    import addon_utils
    addon_utils.log("start", port)
    if "_accept_clients" not in globals():
        # 1.0.3's poll() would fail on every tick without it; a guard must never let this start.
        addon_utils.log("start without _accept_clients")
    if is_running(): raise RuntimeError("Server is already running")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1" if host == "localhost" else host, port))
    sock.listen(1)
    sock.setblocking(False)
    _state.sock = sock
def stop():
    if _state.sock is not None: _state.sock.close()
    _state.sock = None
    # Like 1.0.3's stop: deferred_tool.close_all(), so no checker is asked again.
    for client in deferred_tool._deferred_clients:
        client.conn.close()
    deferred_tool._deferred_clients.clear()
import os as _os
if json.loads(_os.environ["STUB_STATE"]).get("brokenServer"):
    del _accept_clients
`,
  "addon_utils.py": String.raw`
import importlib, json, os, types
state = json.loads(os.environ["STUB_STATE"])
registered = set()
def modules():
    def module(name):
        package = os.path.join(os.environ["PYTHONPATH"], *name.split("."))
        return types.SimpleNamespace(__name__=name, __file__=os.path.join(package, "__init__.py"))
    return [module(name) for name in state["installed"]]
def register(name):
    importlib.import_module(name).register()
    registered.add(name)
def enable(name, default_set=False):
    import bpy
    if default_set and name not in bpy.context.preferences.addons:
        bpy.context.preferences.addons[name] = bpy.Addon(name)
    log("enable", name, default_set)
    register(name)
def disable(name, default_set=False):
    import bpy
    if name in registered:
        importlib.import_module(name).unregister()
        registered.discard(name)
    if default_set:
        bpy.context.preferences.addons.pop(name, None)
    log("disable", name, default_set)
def reload_scripts():
    import bpy
    for name in bpy.context.preferences.addons.keys():
        if name not in registered:
            register(name)
def log(*entry):
    with open(os.environ["STUB_LOG"], "a") as out:
        out.write(json.dumps(entry) + "\n")
`,
};

// Plays T3's side of the control socket, then whatever ends or tests the grant.
const AFTER_REGISTER = String.raw`
import json as _j
import addon_utils as _addons
_scenario = _j.loads(os.environ["STUB_STATE"])
_held = None
if _scenario.get("portTaken"):
    _held = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    _held.bind(("127.0.0.1", int(MCP_PORT)))
    _held.listen(1)
_server = lambda: sys.modules.get("${MCP}.mcp_to_blender_server")
def _report():
    server = _server()
    return {
        "listener": _snapshot()["agentListener"],
        "listening": None if server is None or server._state.sock is None else server._state.sock.getsockname()[1],
        "enabled": "${MCP}" in _addons.registered,
    }
def _press_start():
    # The extension's own Start button, and Blender's Reload Scripts.
    try:
        bpy.ops.blmcp.server_start()
    except AttributeError:
        pass
    _addons.reload_scripts()
    try:
        bpy.ops.blmcp.server_start()
    except AttributeError:
        pass
_steps = [_report()]
_t3 = None
if _scenario.get("connect", True):
    _t3 = socket.socket(socket.AF_UNIX)
    _t3.connect(SOCKET_PATH)
    _tick()
    _steps.append(_report())
    if _scenario.get("pressStartBeforeGrant"):
        _press_start()
        _steps.append(_report())
    if _scenario.get("fileBeforeGrant"):
        bpy.data.filepath = "/work/other.blend"
    bpy.data.is_dirty = bool(_scenario.get("dirty"))
    # What a person does in Blender before T3 asks, a tick after each step.
    for _step in _scenario.get("catalogSteps", []):
        _browser = _step.get("browser")
        bpy._spaces[:] = [bpy._view3d] + ([bpy._assets] if _browser else [])
        bpy._assets.browse_mode = "FILES" if _browser == "files" else "ASSETS"
        bpy._assets.params.asset_library_reference = _step.get("library", "lib")
        bpy._spaces.active = bpy._assets if _browser in ("shown", "files") else bpy._view3d
        if "unsaved" in _step:
            bpy.world["unsaved"] = _step["unsaved"]
        if _step.get("save"):
            bpy.world["unsaved"] = False
            _on_save_post()
        _tick()
    if _scenario.get("listeningBeforeGrant"):
        # Blender Lab already listening, however it got there, when T3's grant arrives.
        _addons.enable("${MCP}", default_set=True)
        _server().start("localhost", int(MCP_PORT))
    if _scenario.get("manifestBeforeGrant") is not None:
        with open(os.path.join(os.environ["PYTHONPATH"], "bl_ext/t3_blender_lab/mcp/blender_manifest.toml"), "w") as _m:
            _m.write(_scenario["manifestBeforeGrant"])
    _t3.sendall("".join(json.dumps({"type": kind}) + "\n" for kind in _scenario.get("send", ["grantAgentListener"])).encode())
    _tick()
    _steps.append(_report())
_then = _scenario.get("then")
if _then == "revoke":
    _t3.sendall(b'{"type": "stopAgentListener"}\n')
    _tick()
elif _then == "drop":
    _t3.close()
    _tick()
elif _then == "otherFile":
    bpy.data.filepath = "/work/other.blend"
    _on_load_post()
elif _then == "saveAs":
    bpy.data.filepath = "/work/hero-final.blend"
    _on_save_post()
elif _then == "revert":
    _on_load_post()
elif _then == "loadTime":
    # Any load, a revert of the same file included, says when it happened.
    _before = _snapshot().get("loadedAt")
    _on_load_post()
    _steps.append(dict(loadedBefore=_before, loadedAfter=type(_snapshot().get("loadedAt")).__name__))
elif _then == "saveInBlender":
    # Ctrl+S in the pane, then a copy saved elsewhere, which leaves the open file as it was.
    _on_save_post(bpy.data.filepath)
    bpy.data.is_dirty = True
    _on_save_post("/work/hero-copy.blend")
    _t3.setblocking(False)
    _heard = b""
    try:
        while True:
            _chunk = _t3.recv(65536)
            if not _chunk:
                break
            _heard += _chunk
    except BlockingIOError:
        pass
    _addons.log("heard", [
        [message["type"], message.get("filepath"), message.get("dirty"), message.get("quit")]
        for message in map(json.loads, _heard.decode().splitlines())
        if message["type"] == "saved"
    ])
elif _then in (
    "saveAndQuit", "failedSaveAndQuit", "pendingSaveAndQuit", "quitWithoutSaving", "discardOther",
):
    # Save and quit as T3 asks for it: Blender's own operators stood in for.
    import contextlib, types
    if _then == "pendingSaveAndQuit":
        # The agent's deferred call that can write is still pending when Save and quit saves.
        _Guard.deferred.append({"writes": True, "check": None})
    _windows = bpy.context.window_manager.windows
    _windows[:] = [types.SimpleNamespace(as_pointer=lambda: 0)]
    bpy.context.temp_override = lambda **_kwargs: contextlib.nullcontext()
    def _save_mainfile():
        if _then == "failedSaveAndQuit":
            raise RuntimeError("cannot write")
        # As Blender does, with the path it saved.
        _on_save_post(bpy.data.filepath)
        return {"FINISHED"}
    def _quit_blender():
        # What the agent's listener was when Blender began to quit, and what T3 had heard.
        _addons.log("quit", _snapshot()["agentListener"], "${MCP}" in _addons.registered)
        _t3.setblocking(False)
        heard = b""
        try:
            while True:
                chunk = _t3.recv(65536)
                if not chunk:
                    break
                heard += chunk
        except BlockingIOError:
            pass
        _addons.log("heard", [
            [message["type"], message.get("filepath"), message.get("dirty")]
            for message in map(json.loads, heard.decode().splitlines())
            if message["type"] in ("saved", "quitting")
        ])
    def _undo_push(message):
        # A real undo step marks the file unsaved.
        bpy.data.is_dirty = True
        _addons.log("undo_push", message)
        return {"FINISHED"}
    bpy.ops.wm = types.SimpleNamespace(save_mainfile=_save_mainfile, quit_blender=_quit_blender)
    bpy.ops.ed = types.SimpleNamespace(undo_push=_undo_push)
    _t3.sendall(
        b'{"type": "quit", "save": false}\n'
        if _then == "quitWithoutSaving"
        # The person's discard of a file Blender no longer has open.
        else b'{"type": "quit", "save": false, "filepath": "/work/other.blend"}\n'
        if _then == "discardOther"
        else b'{"type": "quit", "save": true}\n'
    )
    _tick()
    if _then == "discardOther":
        _t3.setblocking(False)
        try:
            _addons.log("heard", [json.loads(line)["type"] for line in _t3.recv(65536).decode().splitlines()])
        except BlockingIOError:
            _addons.log("heard", [])
elif _then in (
    "replaceViewport", "stuckViewport", "ownChanged", "lateMarked", "loadInSession", "ownClosed",
    "childClosed", "reusedAddress",
):
    # The file was saved with T3's viewport window open, one from a build before T3 marked it
    # (a plain lone 3D view), and the user's own window of another editor: after any load the
    # add-on swaps T3's for its own, and leaves the user's alone.
    import contextlib, types
    class _Area:
        def __init__(self, kind):
            self.type = kind; self.width = 100; self.height = 100
            self.regions = [types.SimpleNamespace(type="WINDOW")]
            self.spaces = types.SimpleNamespace(active=None)
    class _Screen(dict):
        def __init__(self, kind):
            super().__init__(); self.areas = [_Area(kind)]
    class _Window:
        def __init__(self, kind, marked=False, pointer=None):
            self.screen = _Screen(kind)
            self.pointer = pointer
            if marked:
                self.screen["t3_viewport"] = True
        def as_pointer(self): return id(self) if self.pointer is None else self.pointer
    _windows = bpy.context.window_manager.windows
    _users = _Window("IMAGE_EDITOR")
    _saved = _Window("VIEW_3D", marked=True)
    _legacy = _Window("VIEW_3D")
    _windows[:] = [_Window("VIEW_3D"), _users, _saved, _legacy]
    _opened = []
    _closes = []
    _current = [None]
    def _override(**kwargs):
        _current[0] = kwargs.get("window")
        return contextlib.nullcontext()
    def _close():
        _closes.append(_current[0])
        if _then != "stuckViewport":
            _windows.remove(_current[0])
        if _then == "childClosed" and _current[0] is _saved:
            # Its child window closes with it.
            _windows.remove(_legacy)
    def _dupli(_mode):
        window = _Window("VIEW_3D"); _windows.append(window); _opened.append(window)
    bpy.context.temp_override = _override
    bpy.ops.wm = types.SimpleNamespace(
        window_close=_close, recover_auto_save=lambda **_kwargs: {"FINISHED"}
    )
    bpy.ops.screen = types.SimpleNamespace(area_dupli=_dupli)
    if RECOVER_PATH is not None:
        _recover()
    # The timer runs until it returns None; a stuck close must not keep it going.
    _runs = 0
    _late = _Window("VIEW_3D", marked=True)
    while _open_viewport_window() is not None and _runs < 10:
        _runs += 1
        if _then == "lateMarked" and _runs == 1:
            # A marked window seen only after the first pass isn't the copy's to replace.
            _windows.append(_late)
    if _then == "lateMarked":
        _steps.append(dict(lateKept=_late in _windows))
    if _then == "reusedAddress":
        # A later load brings back a marked window at an address a closed one had.
        _windows[:] = [_Window("VIEW_3D"), _Window("VIEW_3D", marked=True, pointer=id(_saved))]
        _opened.clear()
        _on_load_post()
        _runs = 0
        while _open_viewport_window() is not None and _runs < 10:
            _runs += 1
        _steps.append(dict(
            viewports=len([window for window in _windows[1:] if _lone_3d_view(window)]),
            fresh=len(_opened),
        ))
    if _then == "loadInSession":
        # The person (or the agent) opens a file saved from a hosted Blender: Blender gives
        # every window a new struct with the file's screens.
        _users = _Window("IMAGE_EDITOR")
        _windows[:] = [_Window("VIEW_3D"), _Window("VIEW_3D", marked=True), _Window("VIEW_3D"), _users]
        _opened.clear()
        _closes.clear()
        _on_load_post()
        _runs = 0
        while _open_viewport_window() is not None and _runs < 10:
            _runs += 1
        lone = [window for window in _windows[1:] if _lone_3d_view(window)]
        _steps.append(dict(
            viewports=len(lone),
            tracked=_viewport() is not None and _viewport()[0] is lone[0],
            fresh=len(_opened),
        ))
    if _then in ("ownChanged", "ownClosed"):
        # The person turns T3's window into another editor, or closes it: it's no longer T3's
        # viewport, and Blender's own tick, with nothing else asking, replaces it.
        _first = _opened[0]
        if _then == "ownChanged":
            _first.screen.areas[0].type = "IMAGE_EDITOR"
        else:
            _windows.remove(_first)
        _changed = _viewport()
        bpy.app.registered.clear()
        _tick()
        _scheduled = [function for function in bpy.app.registered if function is _open_viewport_window]
        for function in _scheduled:
            bpy.app.registered.remove(function)
            _passes = 0
            while function() is not None and _passes < 10:
                _passes += 1
        _steps.append(dict(
            stillOwn=_changed is not None and _changed[0] is _first,
            scheduled=len(_scheduled),
            reopened=_viewport() is not None and _viewport()[0] is _opened[-1],
            fresh=len(_opened),
            # One T3 viewport window, the one streamed: the old one is gone.
            oldGone=_first not in _windows,
            marked=len([window for window in _windows if window.screen.get("t3_viewport")]),
        ))
    _steps.append(dict(
        _report(),
        windows=len(_windows),
        fresh=len(_opened),
        usersKept=_users in _windows,
        closes=len(_closes),
        runs=_runs,
        marked=all(window.screen.get("t3_viewport") for window in _opened),
    ))
    _tick()
    _steps.append(_report())
    # A file opened after that still ends the agent's access.
    bpy.data.filepath = "/work/other.blend"
    _on_load_post()
if _then is not None:
    _steps.append(_report())
    _press_start()
    _steps.append(_report())
_reloaded = None
if _scenario.get("reload"):
    # Blender 5.3's Reload Scripts: startup scripts (T3's gate) run again, then reset_all reloads
    # each loaded add-on package and disables the ones no longer in the preferences.
    import importlib as _importlib
    import t3_hosted_gate as _gate
    _importlib.reload(_gate)
    _top = sys.modules.get("${MCP}")
    if _top is not None:
        _importlib.reload(_top)
        if "${MCP}" not in bpy.context.preferences.addons and "${MCP}" in _addons.registered:
            _addons.disable("${MCP}")
    _tick()
    _steps.append(_report())
if _scenario.get("unguardedListener"):
    # Blender Lab's own functions back in place on a running listener.
    _server()._accept_clients = lambda: None
    _tick()
    _steps.append(_report())
if _scenario.get("startedOutsideGrant"):
    _addons.enable("${MCP}", default_set=True)
    _server().start("localhost", int(MCP_PORT))
    _tick()
    _steps.append(_report())
_call = _scenario.get("call")
_called = None
if _call is not None:
    import struct as _st
    _client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    _client.connect(("127.0.0.1", int(MCP_PORT)))
    _table = _call.get("table")
    if _table is not None:
        # A /proc/net/tcp of the test's making, in the kernel's format: the client's row (its
        # uid, state and inode as asked) and the row of Blender's own end, written once Blender
        # has accepted, so it can carry that socket's real inode.
        def _hex(address):
            raw = socket.inet_aton(address[0])
            if _table.get("mapped"):
                raw = b"\0" * 10 + b"\xff\xff" + raw
            words = (_st.unpack("=I", raw[i:i + 4])[0] for i in range(0, len(raw), 4))
            return "".join("%08X" % word for word in words) + ":%04X" % address[1]
        def _row(local, remote, state, uid, inode):
            return "   0: %s %s %s 00000000:00000000 00:00000000 00000000 %5d        0 %d 1" % (
                _hex(local), _hex(remote), state, uid, inode)
        _peer = _client.getsockname()
        _ours = ("127.0.0.1", int(MCP_PORT))
        _fake = os.path.join(os.path.dirname(SOCKET_PATH), "tcp")
        def _write_table(accepted):
            rows = ["  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"]
            for _ in range(_table.get("clientRows", 1)):
                rows.append(_row(_peer, _ours, _table.get("state", "01"),
                                 os.getuid() + _table.get("uidOffset", 0), _table.get("inode", 4242)))
            if _table.get("ownRow", True):
                own_inode = os.fstat(accepted.fileno()).st_ino + _table.get("ownInodeOffset", 0)
                rows.append(_row(_ours, _peer, _table.get("ownState", "01"), os.getuid(), own_inode))
            if _table.get("malformed"):
                rows.append("   1: 0100007F:ZZZZ 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000 0 1 1")
            with open(_fake, "w") as out:
                out.write("\n".join(rows) + "\n")
        class _Listening:
            # Blender Lab's listening socket, writing the table at accept.
            def __init__(self, sock): self._sock = sock
            def accept(self):
                connection, address = self._sock.accept()
                _write_table(connection)
                return connection, address
            def __getattr__(self, name): return getattr(self._sock, name)
        _server()._state.sock = _Listening(_server()._state.sock)
        PROC_NET_TCP = (_fake,)
    if _call.get("controlBreaks"):
        # T3's end of the control connection fails on the next write: the acting report.
        class _Broken:
            def sendall(self, data): raise BrokenPipeError()
            def close(self): pass
        _State.client = _Broken()
    _client.sendall((json.dumps({
        "type": "execute",
        "code": _call.get("code", "result = {'cube': 1}"),
        "strict_json": _call.get("strictJson", False),
    }) + "\0").encode())
    _server().poll()
    _dirty_first = bpy.data.is_dirty
    if _call.get("savedBetween"):
        # The user saves while the deferred part runs: the file is clean again.
        bpy.data.is_dirty = False
    if _call.get("userStepBetween"):
        # The user edits while the deferred part runs, which pushes their own undo step.
        bpy.ops.ed.undo_push(message="User edit")
    if _call.get("revokeBeforeCheck"):
        # T3's stop, sent while the deferred part runs; no tick has read it yet.
        _t3.sendall(b'{"type": "stopAgentListener"}\n')
    _deferred = sys.modules.get("${MCP}.deferred_tool")
    if _call.get("deferredDropped") and _deferred is not None:
        # Blender Lab dropping a call whose client went away, without asking its checker again.
        _deferred._deferred_clients.clear()
        _tick()
    if _server() is not None and _server().is_running():
        _server().poll()
    _ending = _call.get("endWhilePending")
    if _ending == "revoke":
        # Allow agents switched off, or the session ending: T3's stop.
        _t3.sendall(b'{"type": "stopAgentListener"}\n')
        _tick()
    elif _ending == "controlLost":
        _t3.close()
        _tick()
    elif _ending == "otherFile":
        bpy.data.filepath = "/work/other.blend"
        _on_load_post()
    _checks_at_end = getattr(bpy.data, "checks", 0)
    if _ending is not None and _server() is not None and _server().is_running():
        _server().poll()
    _client.settimeout(5)
    try:
        _reply = _client.recv(65536)
    except OSError:
        _reply = b""
    _acting = _snapshot()["agentActing"]
    if _call.get("closeT3ThenSecondCall"):
        # T3 gone during the acting linger, with everything read and the state already sent,
        # so the second call's report has nothing new to write.
        _publish_state()
        _t3.setblocking(False)
        try:
            while _t3.recv(65536):
                pass
        except BlockingIOError:
            pass
        _t3.close()
        _second = socket.create_connection(("127.0.0.1", int(MCP_PORT)))
        _second.sendall((json.dumps({"type": "execute", "strict_json": False,
            "code": "import bpy\nbpy.data.ran_second = True\nresult = {}"}) + "\0").encode())
        if _server().is_running():
            _server().poll()
    _Guard.acting_until = 0.0
    _called = {
        "reply": json.loads(_reply.rstrip(b"\0")) if _reply else None,
        "dirtyAfterFirstPoll": _dirty_first,
        "ran": getattr(bpy.data, "ran", False),
        "ranSecond": getattr(bpy.data, "ran_second", False),
        "checked": getattr(bpy.data, "checked", False),
        "checksAfterEnd": getattr(bpy.data, "checks", 0) - _checks_at_end,
        "listenerAfter": _snapshot()["agentListener"],
        "undoPushes": sum(1 for line in open(os.environ["STUB_LOG"]) if '"Agent edit"' in line) if os.path.exists(os.environ["STUB_LOG"]) else 0,
        "dirty": bpy.data.is_dirty,
        "acting": _acting,
        "actingAfter": _snapshot()["agentActing"],
    }
for _kind in _scenario.get("sendAfterCall", []):
    # T3's next request, once the agent's call has run and before any other tick.
    _t3.sendall((json.dumps({"type": _kind}) + "\n").encode())
    _tick()
_received = []
if _t3 is not None:
    try:
        _t3.settimeout(0.2)
        _received = [_j.loads(line) for line in _t3.recv(65536).decode().splitlines()]
    except OSError:
        pass
print(_j.dumps({
    "received": [message["type"] for message in _received],
    "call": _called,
    "mcpVersion": _snapshot()["mcpVersion"],
    "steps": _steps,
    "inPrefs": "${MCP}" in bpy.context.preferences.addons,
    "autostart": any(getattr(f, "__name__", "") == "_autostart_timer" for f in bpy.app.registered),
}))
`;

let dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs) NodeFS.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const freePort = () =>
  Number(
    NodeChildProcess.execFileSync(
      "python3",
      [
        "-c",
        "import socket; s = socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1])",
      ],
      { encoding: "utf8" },
    ).trim(),
  );

const runAddon = (input: {
  readonly installed: ReadonlyArray<string>;
  readonly enabled: ReadonlyArray<string>;
  readonly listen: boolean;
  readonly portTaken?: boolean;
  readonly connect?: boolean;
  /** What T3 sends once connected; a grant by default. */
  readonly send?: ReadonlyArray<
    "grantAgentListener" | "stopAgentListener" | "quitIfClean" | "cancelQuit"
  >;
  /** Asset catalogs edited and not saved, which only Blender's catalog poll can tell. */
  readonly unsavedCatalogs?: boolean;
  /** No window to check catalogs through. */
  readonly noWindow?: boolean;
  /** An asset browser in the main window, as its area's editor or out of view behind another. */
  readonly assetBrowser?: "shown" | "hidden";
  /** Steps a person takes before T3 asks, each followed by the add-on's tick. */
  readonly catalogSteps?: ReadonlyArray<{
    readonly browser?: "shown" | "files" | "hidden";
    readonly library?: string;
    readonly unsaved?: boolean;
    readonly save?: boolean;
  }>;
  /** Blender has unsaved changes when T3's commands arrive. */
  readonly dirty?: boolean;
  /** Images edited and not saved, which saving the .blend leaves behind. */
  readonly dirtyImages?: ReadonlyArray<string>;
  readonly pressStartBeforeGrant?: boolean;
  /** Another file is open by the time T3's grant arrives. */
  readonly fileBeforeGrant?: boolean;
  /** Launched to restore a recovery copy, as Reopen does. */
  readonly recover?: boolean;
  readonly then?:
    | "stuckViewport"
    | "ownChanged"
    | "lateMarked"
    | "loadInSession"
    | "revoke"
    | "drop"
    | "otherFile"
    | "saveAs"
    | "revert"
    | "replaceViewport"
    | "saveAndQuit"
    | "saveInBlender"
    | "pendingSaveAndQuit"
    | "quitWithoutSaving"
    | "discardOther"
    | "loadTime"
    | "ownClosed"
    | "childClosed"
    | "reusedAddress"
    | "failedSaveAndQuit";
  /** The installed extension's manifest version; 1.0.3 by default. */
  readonly mcpVersion?: string;
  /** Its whole manifest, in place of one with `mcpVersion`. */
  readonly manifest?: string;
  /** The manifest the grant finds, written after launch. */
  readonly manifestBeforeGrant?: string;
  /** Blender 5.3's Reload Scripts, with T3's startup gate, after the grant. */
  readonly reload?: boolean;
  /** Blender Lab's own functions back on its running listener. */
  readonly unguardedListener?: boolean;
  /** Blender Lab enabled and listening without T3's grant. */
  readonly startedOutsideGrant?: boolean;
  /** Blender Lab's server module lacks a function the guard wraps. */
  readonly brokenServer?: boolean;
  readonly undoSteps?: number;
  readonly undoPushFails?: boolean;
  /**
   * An MCP call over real loopback TCP. With `table`, the add-on reads a /proc/net/tcp of
   * the test's making: the client's row, or none, owned by this account plus `uidOffset`.
   */
  readonly call?: {
    readonly strictJson?: boolean;
    readonly code?: string;
    readonly table?: {
      readonly clientRows?: number;
      readonly uidOffset?: number;
      readonly mapped?: boolean;
      readonly state?: string;
      readonly inode?: number;
      readonly ownRow?: boolean;
      readonly ownState?: string;
      /** Blender's own row carries another socket's inode: a reused address and port. */
      readonly ownInodeOffset?: number;
      /** One more row that doesn't parse. */
      readonly malformed?: boolean;
    };
    /** T3's control connection fails when the add-on reports the agent acting. */
    readonly controlBreaks?: boolean;
    /** Blender Lab drops the deferred call after its first poll, as on a disconnect. */
    readonly deferredDropped?: boolean;
    /** The grant ends while the deferred part still waits for more work. */
    readonly endWhilePending?: "revoke" | "controlLost" | "otherFile";
    /** The user saves while the deferred part runs. */
    readonly savedBetween?: boolean;
    /** The user edits (and pushes an undo step) while the deferred part runs. */
    readonly userStepBetween?: boolean;
    /** T3 sends its stop while the deferred part runs. */
    readonly revokeBeforeCheck?: boolean;
    /** T3's connection closes after this call, and a second call follows. */
    readonly closeT3ThenSecondCall?: boolean;
  };
  /** What T3 sends once `call` has run, each followed by a tick. */
  readonly sendAfterCall?: ReadonlyArray<"quitIfClean">;
  /** Blender skipped T3's startup gate, so enabled add-ons registered from the settings. */
  readonly gateSkipped?: boolean;
  /** Blender Lab is listening already when the grant arrives. */
  readonly listeningBeforeGrant?: boolean;
  readonly undoPushLeavesClean?: boolean;
  readonly globalUndo?: boolean;
}) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-control-addon-"));
  dirs.push(dir);
  for (const [file, body] of Object.entries(STUBS)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, file), body);
  }
  NodeFS.writeFileSync(
    NodePath.join(dir, "bl_ext/t3_blender_lab/mcp/blender_manifest.toml"),
    input.manifest ?? `id = "mcp"\nversion = "${input.mcpVersion ?? "1.0.3"}"\n`,
  );
  const addon = NodePath.join(dir, "t3_control.py");
  NodeFS.writeFileSync(addon, `${CONTROL_ADDON_SOURCE}\n${AFTER_REGISTER}`);
  const log = NodePath.join(dir, "calls.log");
  const port = freePort();
  const stdout = NodeChildProcess.execFileSync(
    "python3",
    [
      addon,
      "--",
      "--t3-control",
      NodePath.join(dir, "control.sock"),
      "--t3-mcp-port",
      String(port),
      ...(input.listen ? ["--t3-mcp-listen"] : []),
      ...(input.recover ? ["--t3-recover", NodePath.join(dir, "session.blend")] : []),
      ...(input.installed.includes(MCP)
        ? ["--t3-mcp-snapshot", NodePath.join(dir, "bl_ext/t3_blender_lab")]
        : []),
    ],
    {
      env: { ...process.env, PYTHONPATH: dir, STUB_STATE: JSON.stringify(input), STUB_LOG: log },
      encoding: "utf8",
    },
  );
  const calls = NodeFS.existsSync(log)
    ? NodeFS.readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return {
    port,
    calls,
    snapshot: NodePath.join(dir, "bl_ext/t3_blender_lab"),
    ...JSON.parse(stdout.trim().split("\n").at(-1)!),
  };
};

const after = (result: { readonly steps: ReadonlyArray<unknown> }) => result.steps.at(-1);
const off = { listener: "off", listening: null, enabled: false };
const pending = { listener: "starting", listening: null, enabled: false };

const onLinux = HostProcess.Platform.defaultValue() === "linux";

describe("T3's control add-on and Blender Lab's MCP add-on", () => {
  it("keeps it off without --t3-mcp-listen, and out of these settings so a reload can't start it", () => {
    // With the gate skipped, so the add-on's own cleanup is what keeps it out.
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: false,
      gateSkipped: true,
      then: "revert",
    });
    expect(result.calls).toContainEqual(["disable", MCP, true]);
    expect(
      result.steps.every((step: unknown) => JSON.stringify(step) === JSON.stringify(off)),
    ).toBe(true);
    expect(result.inPrefs).toBe(false);
  });

  it("starts it only on T3's grant, on T3's port, with its own autostart off", () => {
    const result = runAddon({ installed: [MCP], enabled: [MCP], listen: true });
    expect(result.steps).toEqual([
      pending,
      pending,
      { listener: "ready", listening: result.port, enabled: true },
    ]);
    expect(result.autostart).toBe(false);
  });

  it("offers no Start button and starts nothing while the grant is pending", () => {
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      pressStartBeforeGrant: true,
      send: [],
    });
    expect(result.steps).toEqual([pending, pending, pending, pending]);
  });

  it("ends the grant once Save and quit has saved, before Blender begins to quit", () => {
    const saved = runAddon({ installed: [MCP], enabled: [MCP], listen: true, then: "saveAndQuit" });
    expect(saved.calls).toContainEqual(["quit", "off", false]);
    // A save that fails leaves Blender open, and the agent's access with it.
    const failed = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      then: "failedSaveAndQuit",
    });
    expect(failed.calls.some((call: ReadonlyArray<unknown>) => call[0] === "quit")).toBe(false);
    expect(after(failed)).toEqual({ listener: "ready", listening: failed.port, enabled: true });
  });

  const heardOf = (result: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> }) =>
    result.calls.find((call) => call[0] === "heard")?.[1];

  it("says in its save result which file it saved, and that pending agent work left it unsaved", () => {
    const pending = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      then: "pendingSaveAndQuit",
    });
    expect(heardOf(pending)).toEqual([["saved", "/work/hero.wip-1a2b3c4d.blend", true]]);
    const plain = runAddon({ installed: [MCP], enabled: [MCP], listen: true, then: "saveAndQuit" });
    expect(heardOf(plain)).toEqual([["saved", "/work/hero.wip-1a2b3c4d.blend", false]]);
  });

  it("B3: tells T3 of a save made in Blender of the open file, never of a copy saved elsewhere", () => {
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      then: "saveInBlender",
    });
    expect(heardOf(result)).toEqual([["saved", "/work/hero.wip-1a2b3c4d.blend", false, false]]);
  });

  it("says which file it quits and whether it was unsaved, before its quit's own undo step", () => {
    const quit = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      then: "quitWithoutSaving",
    });
    expect(heardOf(quit)).toEqual([["quitting", "/work/hero.wip-1a2b3c4d.blend", false]]);
    expect(quit.calls).toContainEqual(["undo_push", "T3 recovery copy"]);
  });

  it("N1: refuses a discard of a file it no longer has open, and stays open", () => {
    const refused = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      dirty: true,
      then: "discardOther",
    });
    expect(heardOf(refused)).toEqual(expect.arrayContaining(["discardRefused"]));
    expect(heardOf(refused)).not.toContain("quitting");
    expect(refused.calls.some((call: Array<unknown>) => call[0] === "quit_blender")).toBe(false);
    expect(refused.calls).not.toContainEqual(["undo_push", "T3 recovery copy"]);
  });

  it("reports when Blender loaded a file, a revert of the same file included", () => {
    const result = runAddon({ installed: [MCP], enabled: [MCP], listen: true, then: "loadTime" });
    expect(result.steps.find((step: object) => "loadedAfter" in step)).toEqual({
      loadedBefore: null,
      loadedAfter: "float",
    });
  });

  it("keeps the grant when it replaces a viewport window a recovery copy brought back", () => {
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      recover: true,
      then: "replaceViewport",
    });
    const ready = { listener: "ready", listening: result.port, enabled: true };
    // T3's saved window swapped for one fresh, marked window; the user's own view kept; the
    // agent's listener untouched. A pass closes, one opens, and one more sets the strip.
    expect(result.steps.slice(-4)).toEqual([
      { ...ready, windows: 3, fresh: 1, usersKept: true, closes: 2, runs: 2, marked: true },
      ready,
      off,
      off,
    ]);
  });

  it("stops trying to close a saved viewport window that won't close", () => {
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      recover: true,
      then: "stuckViewport",
    });
    expect(result.steps.at(-4)).toMatchObject({ closes: 2, usersKept: true, fresh: 1 });
    expect(result.steps.at(-4).runs).toBeLessThan(10);
  });

  it("replaces every viewport window a file brought back, marked or from an earlier build", () => {
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      then: "replaceViewport",
    });
    // Streamed instead of T3's otherwise: the hidden display takes the first one it finds.
    expect(result.steps.at(-4)).toMatchObject({ windows: 3, fresh: 1, closes: 2, usersKept: true });
  });

  it("leaves exactly one viewport window, its own, after a file is opened in the session", () => {
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      then: "loadInSession",
    });
    expect(result.steps.find((step: { viewports?: number }) => "viewports" in step)).toEqual({
      viewports: 1,
      tracked: true,
      fresh: 1,
    });
  });

  it("stops taking a window for its viewport once it no longer holds a lone 3D view", () => {
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      then: "ownChanged",
    });
    expect(result.steps.find((step: { stillOwn?: boolean }) => "stillOwn" in step)).toEqual({
      stillOwn: false,
      scheduled: 1,
      reopened: true,
      fresh: 2,
      oldGone: true,
      marked: 1,
    });
  });

  it("goes on to open its viewport window when closing one window took another with it", () => {
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      then: "childClosed",
    });
    expect(result.steps.at(-4)).toMatchObject({ windows: 3, fresh: 1, usersKept: true });
  });

  it("replaces a window a later load brings back, at whatever address", () => {
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      then: "reusedAddress",
    });
    expect(result.steps.find((step: object) => "viewports" in step)).toEqual({
      viewports: 1,
      fresh: 1,
    });
  });

  it("replaces its viewport window when the person closes it", () => {
    const result = runAddon({ installed: [MCP], enabled: [MCP], listen: true, then: "ownClosed" });
    expect(result.steps.find((step: { stillOwn?: boolean }) => "stillOwn" in step)).toEqual({
      stillOwn: false,
      scheduled: 1,
      reopened: true,
      fresh: 2,
      oldGone: true,
      marked: 1,
    });
  });

  it("replaces only the windows a recovery copy brought back, not one marked after", () => {
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      recover: true,
      then: "lateMarked",
    });
    expect(result.steps.find((step: { lateKept?: boolean }) => "lateKept" in step)).toEqual({
      lateKept: true,
    });
  });

  it("never starts it when T3 revokes before it grants", () => {
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      send: ["stopAgentListener", "grantAgentListener"],
    });
    // Connected but not yet granted, then revoked: it was never ready.
    expect(result.steps).toEqual([pending, pending, off]);
  });

  it("never starts it while T3 isn't connected", () => {
    const result = runAddon({ installed: [MCP], enabled: [MCP], listen: true, connect: false });
    expect(result.steps).toEqual([pending]);
  });

  it("enables an installed but disabled extension with its preferences, then starts it", () => {
    const result = runAddon({ installed: [MCP], enabled: [], listen: true });
    expect(result.calls.filter((call: ReadonlyArray<unknown>) => call[0] !== "start")).toEqual([
      ["repo", "t3_blender_lab", result.snapshot],
      ["enable", MCP, true],
    ]);
    expect(after(result)).toEqual({ listener: "ready", listening: result.port, enabled: true });
  });

  it("fails closed when another process holds the port", () => {
    const result = runAddon({ installed: [MCP], enabled: [MCP], listen: true, portTaken: true });
    expect(after(result)).toMatchObject({ listener: "failed", listening: null });
  });

  it("reports failed when the extension isn't installed", () => {
    const result = runAddon({ installed: [], enabled: [], listen: true });
    expect(after(result)).toMatchObject({ listener: "failed" });
  });

  it.each(["revoke", "drop", "otherFile", "saveAs"] as const)(
    "ends the grant for good on %s: closed, disabled and out of these settings",
    (then) => {
      const result = runAddon({ installed: [MCP], enabled: [MCP], listen: true, then });
      // After the end, then after Start and Reload Scripts.
      expect(result.steps.slice(-2)).toEqual([off, off]);
      expect(result.calls.at(-1)).toEqual(["disable", MCP, true]);
      expect(result.inPrefs).toBe(false);
    },
  );

  it("keeps access when the working copy itself is reverted", () => {
    const result = runAddon({ installed: [MCP], enabled: [MCP], listen: true, then: "revert" });
    expect(result.steps.at(-2)).toEqual({
      listener: "ready",
      listening: result.port,
      enabled: true,
    });
  });

  it("leaves other add-ons alone", () => {
    const result = runAddon({
      installed: ["bl_ext.user_default.node_wrangler"],
      enabled: [],
      listen: false,
    });
    expect(result.calls).toEqual([]);
  });

  const bound = (result: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> }) =>
    result.calls.some((call) => call[0] === "start");

  it("never binds the port when a stop is queued behind the grant", () => {
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      send: ["grantAgentListener", "stopAgentListener"],
    });
    expect(result.steps).toEqual([pending, pending, off]);
    expect(bound(result)).toBe(false);
  });

  it("never binds the port when another file is open by the time the grant arrives", () => {
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      fileBeforeGrant: true,
    });
    expect(after(result)).toEqual(off);
    expect(bound(result)).toBe(false);
  });

  it("quits on quitIfClean only without unsaved changes, and says so when it won't", () => {
    const dirty = runAddon({
      installed: [],
      enabled: [],
      listen: false,
      send: ["quitIfClean"],
      dirty: true,
    });
    expect(dirty.calls.some((call: Array<unknown>) => call[0] === "quit_blender")).toBe(false);
    expect(dirty.received).toContain("quitRefused");
    // A saved .blend with an edited image is still unsaved work.
    const image = runAddon({
      installed: [],
      enabled: [],
      listen: false,
      send: ["quitIfClean"],
      dirtyImages: ["paint"],
    });
    expect(image.calls.some((call: Array<unknown>) => call[0] === "quit_blender")).toBe(false);
    expect(image.received).toContain("quitRefused");
    const quits = (result: { readonly calls: ReadonlyArray<Array<unknown>> }) =>
      result.calls.some((call) => call[0] === "quit_blender");
    // Unsaved catalogs, which Blender's own quit would ask about, are unsaved work too.
    const catalogs = runAddon({
      installed: [],
      enabled: [],
      listen: false,
      send: ["quitIfClean"],
      unsavedCatalogs: true,
      assetBrowser: "shown",
    });
    expect(quits(catalogs)).toBe(false);
    expect(catalogs.received).toContain("quitRefused");
    // An asset browser out of view can't be asked, so its catalogs aren't known to be saved.
    const unknown = runAddon({
      installed: [],
      enabled: [],
      listen: false,
      send: ["quitIfClean"],
      assetBrowser: "hidden",
    });
    expect(quits(unknown)).toBe(false);
    expect(unknown.received).toContain("quitRefused");
    // A quit T3 cancelled while it waited here is never carried out.
    const cancelled = runAddon({
      installed: [],
      enabled: [],
      listen: false,
      send: ["quitIfClean", "cancelQuit"],
    });
    expect(quits(cancelled)).toBe(false);
    expect(cancelled.received).toContain("quitCancelled");
    const clean = runAddon({ installed: [], enabled: [], listen: false, send: ["quitIfClean"] });
    // Quit directly once clean: no dialog appears where nobody can answer it.
    expect(clean.calls).toContainEqual(["quit_blender"]);
    // With an asset browser shown and nothing unsaved, it quits too.
    const shown = runAddon({
      installed: [],
      enabled: [],
      listen: false,
      send: ["quitIfClean"],
      assetBrowser: "shown",
    });
    expect(shown.calls).toContainEqual(["quit_blender"]);
    expect(clean.received).not.toContain("quitRefused");
  });

  describe("unsaved asset catalogs, remembered past their asset browser", () => {
    const quitAfter = (steps: NonNullable<Parameters<typeof runAddon>[0]["catalogSteps"]>) => {
      const result = runAddon({
        installed: [],
        enabled: [],
        listen: false,
        send: ["quitIfClean"],
        catalogSteps: steps,
      });
      return {
        quit: result.calls.some((call: Array<unknown>) => call[0] === "quit_blender"),
        refused: result.received.includes("quitRefused"),
      };
    };

    it("refuses after a catalog edit whose asset browser became a File Browser", () => {
      expect(quitAfter([{ browser: "shown", unsaved: true }, { browser: "files" }])).toEqual({
        quit: false,
        refused: true,
      });
    });

    it("refuses after a catalog edit whose asset browser moved to the All library", () => {
      expect(
        quitAfter([
          { browser: "shown", unsaved: true },
          { browser: "shown", library: "ALL" },
        ]),
      ).toEqual({ quit: false, refused: true });
    });

    it("refuses after an agent call that edits catalogs and switches the browser away at once", () => {
      // No tick runs between the edit and the switch, so the latch never sees the catalogs;
      // the call's own undo step marks the file unsaved instead.
      const result = runAddon({
        installed: [MCP],
        enabled: [MCP],
        listen: true,
        assetBrowser: "shown",
        call: {
          code: "import bpy\nbpy.world['unsaved'] = True\nbpy._spaces.active = bpy._view3d\nresult = {}",
        },
        sendAfterCall: ["quitIfClean"],
      });
      expect(result.call).toMatchObject({ reply: { status: "ok" }, undoPushes: 1 });
      expect(result.calls.some((call: Array<unknown>) => call[0] === "quit_blender")).toBe(false);
      expect(result.received).toContain("quitRefused");
    });

    it("refuses after a catalog edit whose asset browser moved to an unavailable library", () => {
      expect(
        quitAfter([
          { browser: "shown", unsaved: true },
          { browser: "shown", library: "missing" },
        ]),
      ).toEqual({ quit: false, refused: true });
    });

    it("quits once the edit is saved", () => {
      expect(
        quitAfter([
          { browser: "shown", unsaved: true },
          { browser: "files", save: true },
        ]),
      ).toEqual({ quit: true, refused: false });
    });
  });

  describe("its guard on Blender Lab's listener", () => {
    const ok = { status: "ok", result: { cube: 1 } };
    const granted = { installed: [MCP], enabled: [MCP], listen: true } as const;
    const withTable = (
      table: NonNullable<NonNullable<Parameters<typeof runAddon>[0]["call"]>["table"]>,
    ) => runAddon({ ...granted, call: { table } }).call.reply;

    // Reads the kernel's own /proc/net/tcp, which only Linux has.
    it.skipIf(!onLinux)(
      "takes a call from this account, found by its real loopback connection",
      () => {
        expect(runAddon({ ...granted, call: {} }).call.reply).toEqual(ok);
      },
    );

    it("takes a call whose client row and Blender's own end are both live", () => {
      expect(withTable({})).toEqual(ok);
      expect(withTable({ mapped: true })).toEqual(ok);
    });

    it.each([
      ["another account owns the client", { uidOffset: 1 }],
      ["no row has the client", { clientRows: 0 }],
      ["two rows claim the client", { clientRows: 2 }],
      ["the client row is orphaned, with inode 0", { inode: 0 }],
      ["the client row is closing (FIN_WAIT2)", { state: "05" }],
      ["Blender's own end is gone by the second read", { ownRow: false }],
      ["Blender's own end is no longer established", { ownState: "08" }],
      ["Blender's own row is another socket, by its inode", { ownInodeOffset: 1 }],
      ["a table holds a row that doesn't parse", { malformed: true }],
    ] as const)("drops a connection when %s", (_name, table) => {
      expect(withTable(table)).toBeNull();
    });

    it("never starts a server module missing a function the guard wraps, and disables it", () => {
      const result = runAddon({ ...granted, brokenServer: true });
      expect(after(result)).toMatchObject({ listener: "failed", listening: null, enabled: false });
      expect(bound(result)).toBe(false);
      expect(result.inPrefs).toBe(false);
    });

    it("disables the extension when its listener can't start, and stays failed", () => {
      const result = runAddon({ ...granted, portTaken: true });
      expect(after(result)).toEqual({ listener: "failed", listening: null, enabled: false });
      expect(result.inPrefs).toBe(false);
    });

    it("ends access on Blender 5.3's Reload Scripts, which T3's gate keeps Blender Lab out of", () => {
      const result = runAddon({ ...granted, reload: true });
      expect(after(result)).toEqual(off);
      expect(result.inPrefs).toBe(false);
    });

    it("ends access when Blender Lab's own functions are back on a running listener", () => {
      const result = runAddon({ ...granted, unguardedListener: true });
      expect(after(result)).toEqual(off);
    });

    it("stops a Blender Lab listener started without T3's grant", () => {
      const result = runAddon({
        installed: [MCP],
        enabled: [MCP],
        listen: false,
        startedOutsideGrant: true,
      });
      expect(after(result)).toEqual(off);
      expect(result.inPrefs).toBe(false);
    });

    it("grants nothing when Blender skipped T3's startup gate", () => {
      const result = runAddon({ ...granted, gateSkipped: true });
      expect(after(result)).toEqual({ listener: "failed", listening: null, enabled: false });
      expect(bound(result)).toBe(false);
    });

    it("grants nothing when Blender Lab is listening already when the grant arrives", () => {
      const result = runAddon({ ...granted, listeningBeforeGrant: true });
      expect(after(result)).toMatchObject({ listener: "failed", listening: null });
    });

    it("loads only the launch's snapshot, through a repository of its own", () => {
      const result = runAddon(granted);
      expect(result.calls).toContainEqual(["repo", "t3_blender_lab", result.snapshot]);
      expect(after(result)).toMatchObject({ listener: "ready" });
    });

    it("pushes an undo step after the agent's own code, which makes the file unsaved", () => {
      const result = runAddon({ ...granted, call: {} });
      expect(result.call.dirty).toBe(true);
      expect(result.calls).toContainEqual(["undo_push", "Agent edit"]);
    });

    it("pushes no undo step after Blender Lab's own read-only tool code", () => {
      const result = runAddon({ ...granted, call: { strictJson: true } });
      expect(result.call).toMatchObject({ reply: ok, dirty: false });
      expect(result.calls.some((call: ReadonlyArray<unknown>) => call[0] === "undo_push")).toBe(
        false,
      );
    });

    const deferredCode = (check: string) =>
      `import bpy\ndef check_is_finished():\n${check}\nresult = {}`;
    // Blender Lab 1.0.3's render tools defer through this template checker.
    const renderToolCode = (job: string, name = "_deferred_tool_check_for_file_output") =>
      `def ${name}(job_type, output_path, restore_attrs=None):\n    def check_is_finished():\n        # Like 1.0.3's, it waits on its job.\n        if job_type is None:\n            return None\n        return {"status": "ok", "filepath": output_path}\n    return check_is_finished\ncheck_is_finished = ${name}(${JSON.stringify(job)}, "/tmp/out.png")\nresult = {}`;

    it("gives the agent's deferred call a step now and one more when its work ends", () => {
      const result = runAddon({
        ...granted,
        call: { code: deferredCode("    return {'rendered': 1}") },
      });
      expect(result.call).toMatchObject({
        reply: { status: "ok", result: { rendered: 1 } },
        dirtyAfterFirstPoll: true,
        undoPushes: 2,
      });
    });

    it("marks the file unsaved again when deferred work writes after the user saved", () => {
      const result = runAddon({
        ...granted,
        call: {
          code: deferredCode("    bpy.data.notes = 'written'\n    return {'done': 1}"),
          savedBetween: true,
        },
      });
      expect(result.call).toMatchObject({ dirty: true, undoPushes: 2 });
    });

    it("adds no step for Blender Lab's read-only render, even with a user edit in between", () => {
      const result = runAddon({
        ...granted,
        call: { code: renderToolCode("RENDER"), strictJson: true, userStepBetween: true },
      });
      expect(result.call).toMatchObject({ reply: { status: "ok" }, undoPushes: 0 });
    });

    it.each([
      ["a deferred path it doesn't know", deferredCode("    return {'done': 1}")],
      ["the render checker on another job", renderToolCode("BAKE")],
      ["another checker shaped like it", renderToolCode("RENDER", "_some_other_checker")],
    ])("treats %s as writing, and records its step", (_name, code) => {
      const result = runAddon({ ...granted, call: { code, strictJson: true } });
      expect(result.call.undoPushes).toBe(1);
    });

    it.each([
      ["Blender Lab drops the call", { deferredDropped: true }],
      ["its checker raises", { code: deferredCode("    raise RuntimeError('bake failed')") }],
    ] as const)("still records the deferred step when %s", (_name, call) => {
      const result = runAddon({
        ...granted,
        call: { code: deferredCode("    return None"), ...call },
      });
      expect(result.call.undoPushes).toBe(2);
    });

    // Writes on its first check after the user saved, then keeps waiting for more work.
    const writesThenWaits = deferredCode(
      "    bpy.data.checks = getattr(bpy.data, 'checks', 0) + 1\n    bpy.data.notes = 'written'\n    return None",
    );

    it.each([
      ["Allow agents is switched off, or the session ends", "revoke"],
      ["T3's control connection is lost", "controlLost"],
    ] as const)(
      "records pending deferred writes as a step when %s, running no more checks",
      (_name, endWhilePending) => {
        const result = runAddon({
          ...granted,
          call: { code: writesThenWaits, savedBetween: true, endWhilePending },
        });
        expect(result.call).toMatchObject({
          dirty: true,
          undoPushes: 2,
          checksAfterEnd: 0,
          listenerAfter: "off",
        });
      },
    );

    it.each([
      ["its undo step marks the file unsaved", false],
      ["its undo step fails to mark the file unsaved", true],
    ] as const)(
      "records pending deferred writes before deciding a quit, so the master is kept, when %s",
      (_name, undoPushLeavesClean) => {
        // A departed agent's deferred part has written since the user saved, and still waits.
        const result = runAddon({
          ...granted,
          undoPushLeavesClean,
          call: { code: writesThenWaits, savedBetween: true },
          sendAfterCall: ["quitIfClean"],
        });
        expect(result.calls.some((call: Array<unknown>) => call[0] === "quit_blender")).toBe(false);
        expect(result.received).toContain("quitRefused");
      },
    );

    it("pushes nothing into another file opened while deferred work was pending", () => {
      const result = runAddon({
        ...granted,
        call: { code: writesThenWaits, savedBetween: true, endWhilePending: "otherFile" },
      });
      expect(result.call).toMatchObject({ dirty: false, undoPushes: 1, checksAfterEnd: 0 });
    });

    it("runs no deferred checker after T3's stop arrived, even before a tick", () => {
      const result = runAddon({
        ...granted,
        call: {
          code: deferredCode("    bpy.data.checked = True\n    return {'done': 1}"),
          revokeBeforeCheck: true,
        },
      });
      expect(result.call).toMatchObject({ checked: false, listenerAfter: "off" });
    });

    it("runs nothing in a later call once T3's connection closed, before a tick sees it", () => {
      const result = runAddon({ ...granted, call: { closeT3ThenSecondCall: true } });
      expect(result.call).toMatchObject({ reply: ok, ranSecond: false, listenerAfter: "off" });
    });

    it("records nothing once the agent's code opened another file", () => {
      const result = runAddon({
        ...granted,
        call: { code: "import bpy\nbpy.data.filepath = '/work/other.blend'\nresult = {}" },
      });
      expect(result.calls.some((call: ReadonlyArray<unknown>) => call[0] === "undo_push")).toBe(
        false,
      );
    });

    it.each([
      ["undo is off", { undoSteps: 0 }, "Undo Steps is 0"],
      ["Blender refuses the undo push", { undoPushFails: true }, "couldn't record an undo step"],
      ["Global Undo is off", { globalUndo: false }, "Global Undo is off"],
      [
        "the file isn't marked unsaved",
        { undoPushLeavesClean: true },
        "doesn't show this edit as unsaved",
      ],
    ] as const)("tells the agent when %s", (_name, options, says) => {
      const result = runAddon({ ...granted, ...options, call: {} });
      expect(result.call.reply.t3UndoWarning).toContain(says);
    });

    it("still marks the file unsaved with undo off, as Blender does before its limit", () => {
      const result = runAddon({ ...granted, undoSteps: 0, call: {} });
      expect(result.call.dirty).toBe(true);
    });

    it("runs nothing when telling T3 the agent is acting finds T3's connection gone", () => {
      const result = runAddon({
        ...granted,
        call: { code: "import bpy\nbpy.data.ran = True\nresult = {}", controlBreaks: true },
      });
      expect(result.call).toMatchObject({ ran: false, listenerAfter: "off" });
    });

    it("tells T3 the agent is acting before its code runs, and not once the call has passed", () => {
      const result = runAddon({
        ...granted,
        call: {
          strictJson: true,
          code: "import __main__\nresult = {'told': __main__._State.sent['agentActing']}",
        },
      });
      expect(result.call.reply.result).toEqual({ told: true });
      expect(result.call).toMatchObject({ acting: true, actingAfter: false });
    });

    it("never enables an untested version, and says which it is", () => {
      const result = runAddon({ ...granted, mcpVersion: "1.1.0" });
      expect(after(result)).toEqual({ listener: "untested", listening: null, enabled: false });
      expect(bound(result)).toBe(false);
      expect(result.mcpVersion).toBe("1.1.0");
    });

    it.each([
      ["only inside a table", '[build]\nversion = "1.0.3"\n'],
      ["missing", 'id = "mcp"\n'],
      ["not TOML", 'version = "1.0.3\n'],
      ["not a string", "version = 103\n"],
    ])("treats a manifest whose version is %s as untested", (_name, manifest) => {
      expect(after(runAddon({ ...granted, manifest }))).toMatchObject({ listener: "untested" });
    });

    it("reads a top-level version written with single quotes", () => {
      const result = runAddon({ ...granted, manifest: "  version = '1.0.3'\n" });
      expect(after(result)).toMatchObject({ listener: "ready" });
    });

    it("checks the manifest the grant finds, not the one seen at launch", () => {
      const result = runAddon({ ...granted, manifestBeforeGrant: 'version = "1.1.0"\n' });
      expect(after(result)).toMatchObject({ listener: "untested" });
    });

    it("ends an untested version's refusal like any other grant", () => {
      const result = runAddon({ ...granted, mcpVersion: "0.9.0", then: "revoke" });
      expect(result.steps.slice(-2)).toEqual([off, off]);
      expect(bound(result)).toBe(false);
    });
  });

  describe("T3's startup gate in the hosted settings", () => {
    it("drops Blender Lab and stale snapshot repositories, leaves the rest, and says it ran", () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-gate-"));
      dirs.push(dir);
      NodeFS.mkdirSync(NodePath.join(dir, "bpy"));
      NodeFS.writeFileSync(
        NodePath.join(dir, "bpy/__init__.py"),
        String.raw`
import types
class Addons(list):
    def remove(self, addon): list.remove(self, addon)
context = types.SimpleNamespace(preferences=types.SimpleNamespace(
    addons=Addons(
        types.SimpleNamespace(module=name)
        for name in ["bl_ext.lab_blender_org.mcp", "bl_ext.user_default.mcp", "node_wrangler", "bl_ext.x.mcp_tools"]
    ),
    extensions=types.SimpleNamespace(repos=Addons(
        types.SimpleNamespace(module=name) for name in ["user_default", "t3_blender_lab"]
    )),
))
`,
      );
      NodeFS.writeFileSync(
        NodePath.join(dir, "gate.py"),
        `${HOSTED_STARTUP_GATE_SOURCE}\nimport json\nprefs = bpy.context.preferences\nprint(json.dumps({"addons": [a.module for a in prefs.addons], "repos": [r.module for r in prefs.extensions.repos], "completed": COMPLETED}))\n`,
      );
      const out = NodeChildProcess.execFileSync("python3", [NodePath.join(dir, "gate.py")], {
        env: { ...process.env, PYTHONPATH: dir },
        encoding: "utf8",
      });
      expect(JSON.parse(out)).toEqual({
        addons: ["node_wrangler", "bl_ext.x.mcp_tools"],
        repos: ["user_default"],
        completed: true,
      });
    });
  });
});
