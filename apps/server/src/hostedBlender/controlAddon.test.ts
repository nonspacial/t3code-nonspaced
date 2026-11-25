// @effect-diagnostics nodeBuiltinImport:off - runs the add-on under python3 with stand-in Blender modules.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { CONTROL_ADDON_SOURCE } from "./controlAddon.ts";

const MCP = "bl_ext.user_default.mcp";

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
    def __init__(self): self.preferences = Prefs()
class Addons(dict):
    def keys(self): return list(super().keys())
addons = Addons({name: Addon() for name in state["enabled"]})
context = types.SimpleNamespace(
    preferences=types.SimpleNamespace(
        addons=addons, is_dirty=True, filepaths=types.SimpleNamespace(temporary_directory="")
    ),
    window_manager=types.SimpleNamespace(windows=[]),
)
data = types.SimpleNamespace(filepath=state.get("filepath", "/work/hero.wip-1a2b3c4d.blend"), is_dirty=False)
from . import app, ops
# Blender registers the enabled add-ons before --python scripts run.
import addon_utils
for name in state["enabled"]:
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
    "load_post = []\nsave_post = []\ndef persistent(function):\n    return function\n",
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
`,
  // Imported at the top for the capture and hit tests, which register() never runs.
  "gpu.py": "",
  "mathutils.py": "class Matrix: pass\nclass Vector: pass\n",
  "bl_ext/__init__.py": "",
  "bl_ext/user_default/__init__.py": "",
  "bl_ext/user_default/mcp/__init__.py": String.raw`
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
  "bl_ext/user_default/mcp/mcp_to_blender_server.py": String.raw`
import socket, types
_state = types.SimpleNamespace(sock=None)
def is_running(): return _state.sock is not None
def start(host, port):
    import addon_utils
    addon_utils.log("start", port)
    if is_running(): raise RuntimeError("Server is already running")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1" if host == "localhost" else host, port))
    sock.listen(1)
    _state.sock = sock
def stop():
    if _state.sock is not None: _state.sock.close()
    _state.sock = None
`,
  "addon_utils.py": String.raw`
import importlib, json, os, types
state = json.loads(os.environ["STUB_STATE"])
registered = set()
def modules():
    return [types.SimpleNamespace(__name__=name) for name in state["installed"]]
def register(name):
    importlib.import_module(name).register()
    registered.add(name)
def enable(name, default_set=False):
    import bpy
    if default_set and name not in bpy.context.preferences.addons:
        bpy.context.preferences.addons[name] = bpy.Addon()
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
elif _then in ("saveAndQuit", "failedSaveAndQuit"):
    # Save and quit as T3 asks for it: Blender's own operators stood in for.
    import contextlib, types
    _windows = bpy.context.window_manager.windows
    _windows[:] = [types.SimpleNamespace(as_pointer=lambda: 0)]
    bpy.context.temp_override = lambda **_kwargs: contextlib.nullcontext()
    def _save_mainfile():
        if _then == "failedSaveAndQuit":
            raise RuntimeError("cannot write")
        return {"FINISHED"}
    def _quit_blender():
        # What the agent's listener was when Blender began to quit.
        _addons.log("quit", _snapshot()["agentListener"], "${MCP}" in _addons.registered)
    bpy.ops.wm = types.SimpleNamespace(save_mainfile=_save_mainfile, quit_blender=_quit_blender)
    _t3.sendall(b'{"type": "quit", "save": true}\n')
    _tick()
elif _then in ("replaceViewport", "stuckViewport", "ownChanged", "lateMarked"):
    # The file was saved with T3's viewport window open, and the user's own second 3D view:
    # after a recovery the add-on swaps T3's for its own, and always leaves the user's alone.
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
        def __init__(self, kind, marked=False):
            self.screen = _Screen(kind)
            if marked:
                self.screen["t3_viewport"] = True
        def as_pointer(self): return id(self)
    _windows = bpy.context.window_manager.windows
    _users = _Window("VIEW_3D")
    _saved = _Window("VIEW_3D", marked=True)
    _windows[:] = [_Window("VIEW_3D"), _users, _saved]
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
    if _then == "ownChanged":
        # The person turns T3's window into another editor: it's no longer T3's viewport, and
        # Blender's own tick, with nothing else asking, opens a fresh one.
        _opened[0].screen.areas[0].type = "IMAGE_EDITOR"
        _changed = _viewport()
        bpy.app.registered.clear()
        _tick()
        _scheduled = [function for function in bpy.app.registered if function is _open_viewport_window]
        for function in _scheduled:
            bpy.app.registered.remove(function)
            function()
        _steps.append(dict(
            stillOwn=_changed is not None and _changed[0] is _opened[0],
            scheduled=len(_scheduled),
            reopened=_viewport() is not None and _viewport()[0] is _opened[-1],
            fresh=len(_opened),
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
print(_j.dumps({
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
  readonly send?: ReadonlyArray<"grantAgentListener" | "stopAgentListener">;
  readonly pressStartBeforeGrant?: boolean;
  /** Another file is open by the time T3's grant arrives. */
  readonly fileBeforeGrant?: boolean;
  /** Launched to restore a recovery copy, as Reopen does. */
  readonly recover?: boolean;
  readonly then?:
    | "stuckViewport"
    | "ownChanged"
    | "lateMarked"
    | "revoke"
    | "drop"
    | "otherFile"
    | "saveAs"
    | "revert"
    | "replaceViewport"
    | "saveAndQuit"
    | "failedSaveAndQuit";
}) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-control-addon-"));
  dirs.push(dir);
  for (const [file, body] of Object.entries(STUBS)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, file), body);
  }
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
  return { port, calls, ...JSON.parse(stdout.trim().split("\n").at(-1)!) };
};

const after = (result: { readonly steps: ReadonlyArray<unknown> }) => result.steps.at(-1);
const off = { listener: "off", listening: null, enabled: false };
const pending = { listener: "starting", listening: null, enabled: false };

describe("T3's control add-on and Blender Lab's MCP add-on", () => {
  it("keeps it off without --t3-mcp-listen, and out of these settings so a reload can't start it", () => {
    const result = runAddon({ installed: [MCP], enabled: [MCP], listen: false, then: "revert" });
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
    // agent's listener untouched.
    expect(result.steps.slice(-4)).toEqual([
      { ...ready, windows: 3, fresh: 1, usersKept: true, closes: 1, runs: 1, marked: true },
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
    expect(result.steps.at(-4)).toMatchObject({ closes: 1, usersKept: true, fresh: 1 });
    expect(result.steps.at(-4).runs).toBeLessThan(10);
  });

  it("leaves a marked window an ordinary file brought back, and opens its own", () => {
    const result = runAddon({
      installed: [MCP],
      enabled: [MCP],
      listen: true,
      then: "replaceViewport",
    });
    // A file saved from a hosted Blender keeps the mark, but only a recovery copy is T3's own.
    expect(result.steps.at(-4)).toMatchObject({ windows: 4, fresh: 1, closes: 0, usersKept: true });
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
});
