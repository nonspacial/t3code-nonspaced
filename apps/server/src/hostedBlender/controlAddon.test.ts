// @effect-diagnostics nodeBuiltinImport:off - runs the add-on under python3 with stand-in Blender modules.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { CONTROL_ADDON_SOURCE } from "./controlAddon.ts";

const MCP = "bl_ext.user_default.mcp";

// Just enough of Blender for the add-on's register(), and a stand-in for Blender Lab's MCP
// extension (checked against version 1.0.3) whose server binds a real loopback socket.
const STUBS = {
  "bpy/__init__.py": String.raw`
import importlib, json, os, types
state = json.loads(os.environ["STUB_STATE"])
class Prefs:
    def __init__(self): self.port = 9876; self.host = "0.0.0.0"; self.use_autostart = True
class Addon:
    def __init__(self): self.preferences = Prefs()
class Addons(dict):
    def keys(self): return list(super().keys())
addons = Addons({name: Addon() for name in state["enabled"]})
context = types.SimpleNamespace(
    preferences=types.SimpleNamespace(addons=addons, is_dirty=True),
    window_manager=types.SimpleNamespace(windows=[]),
)
data = types.SimpleNamespace(filepath=state.get("filepath", "/work/hero.wip-1a2b3c4d.blend"), is_dirty=False)
from . import app, ops
# Blender registers enabled add-ons before --python scripts run.
for name in state["enabled"]:
    importlib.import_module(name)
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
  "bpy/app/handlers.py": "load_post = []\ndef persistent(function):\n    return function\n",
  "bpy/ops.py": String.raw`
import sys, types
NAME = "${MCP}"
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
blmcp = types.SimpleNamespace(server_start=_start, server_stop=_stop)
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
bpy.app.timers.register(_autostart_timer)
`,
  "bl_ext/user_default/mcp/mcp_to_blender_server.py": String.raw`
import socket, types
_state = types.SimpleNamespace(sock=None)
def is_running(): return _state.sock is not None
def start(host, port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1" if host == "localhost" else host, port))
    sock.listen(1)
    _state.sock = sock
def stop():
    if _state.sock is not None: _state.sock.close()
    _state.sock = None
`,
  "addon_utils.py": String.raw`
import importlib, json, os, types, bpy
state = json.loads(os.environ["STUB_STATE"])
def modules():
    return [types.SimpleNamespace(__name__=name) for name in state["installed"]]
def enable(name, default_set=True):
    bpy.context.preferences.addons[name] = bpy.Addon()
    importlib.import_module(name)
    log("enable", name, default_set)
def disable(name, default_set=True):
    bpy.context.preferences.addons.pop(name, None)
    log("disable", name, default_set)
def log(*entry):
    with open(os.environ["STUB_LOG"], "a") as out:
        out.write(json.dumps(entry) + "\n")
`,
};

// Plays T3's side of the control socket: connect, then end the grant one way or another.
const AFTER_REGISTER = String.raw`
import json as _j
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
        "enabled": "${MCP}" in bpy.context.preferences.addons,
    }
_steps = [_report()]
_t3 = None
if _scenario.get("connect", True):
    _t3 = socket.socket(socket.AF_UNIX)
    _t3.connect(SOCKET_PATH)
    _tick()
    _steps.append(_report())
_then = _scenario.get("then")
if _then == "revoke":
    _handle({"type": "stopAgentListener"})
elif _then == "drop":
    _t3.close()
    _tick()
elif _then == "otherFile":
    bpy.data.filepath = "/work/other.blend"
    _on_load_post()
if _then is not None:
    _steps.append(_report())
    # The extension's own Start button, pressed after the grant ended.
    _addon = bpy.context.preferences.addons.get("${MCP}")
    if _addon is not None:
        bpy.ops.blmcp.server_start()
    _steps.append(_report())
_addon = bpy.context.preferences.addons.get("${MCP}")
print(_j.dumps({
    "steps": _steps,
    "autostart": any(getattr(f, "__name__", "") == "_autostart_timer" for f in bpy.app.registered),
    "useAutostart": None if _addon is None else _addon.preferences.use_autostart,
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
  readonly then?: "revoke" | "drop" | "otherFile";
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
const ended = { listener: "off", listening: null, enabled: false };

describe("T3's control add-on and Blender Lab's MCP add-on", () => {
  it("keeps the official listener off without --t3-mcp-listen, for this session only", () => {
    const result = runAddon({ installed: [MCP], enabled: [MCP], listen: false });
    expect(result.calls).toEqual([["disable", MCP, false]]);
    expect(result.steps).toEqual([ended, ended]);
  });

  it("starts nothing until T3 connects, then starts it on T3's port with its autostart off", () => {
    const result = runAddon({ installed: [MCP], enabled: [MCP], listen: true });
    expect(result.calls).toEqual([]);
    expect(result.steps).toEqual([
      { listener: "starting", listening: null, enabled: true },
      { listener: "ready", listening: result.port, enabled: true },
    ]);
    expect(result.autostart).toBe(false);
    expect(result.useAutostart).toBe(false);
  });

  it("never starts it while T3 isn't connected", () => {
    const result = runAddon({ installed: [MCP], enabled: [MCP], listen: true, connect: false });
    expect(result.steps).toEqual([{ listener: "starting", listening: null, enabled: true }]);
  });

  it("enables an installed but disabled extension with its preferences, then starts it", () => {
    const result = runAddon({ installed: [MCP], enabled: [], listen: true });
    expect(result.calls).toEqual([["enable", MCP, true]]);
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

  it.each(["revoke", "drop", "otherFile"] as const)(
    "closes the listener and disables the extension when the grant ends by %s, for good",
    (then) => {
      const result = runAddon({ installed: [MCP], enabled: [MCP], listen: true, then });
      expect(result.steps.slice(-2)).toEqual([ended, ended]);
      expect(result.calls).toContainEqual(["disable", MCP, false]);
    },
  );

  it("leaves other add-ons alone", () => {
    const result = runAddon({
      installed: ["bl_ext.user_default.node_wrangler"],
      enabled: [],
      listen: false,
    });
    expect(result.calls).toEqual([]);
  });
});
