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
    preferences=types.SimpleNamespace(addons=addons, is_dirty=True),
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
def _undo_push(message):
    import bpy, addon_utils
    addon_utils.log("undo_push", message)
    # As in Blender: data edits leave the file clean; an undo push marks it modified.
    bpy.data.is_dirty = True
    return {"FINISHED"}
ed = types.SimpleNamespace(undo_push=_undo_push)
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
  "bl_ext/user_default/mcp/deferred_tool.py":
    "pending = []\ndef has_pending(): return bool(pending)\n",
  // 1.0.3's accept and execute path, which poll() looks up by name on each call.
  "bl_ext/user_default/mcp/mcp_to_blender_server.py": String.raw`
import json, socket, types
class _Client:
    def __init__(self, conn): self.conn = conn; self.buffer = bytearray()
_state = types.SimpleNamespace(sock=None, clients=[])
def is_running(): return _state.sock is not None
def _execute_code(code, strict_json):
    namespace = {"result": {}}
    exec(code, namespace)
    return types.SimpleNamespace(response={"status": "ok", "result": namespace["result"]})
def _accept_clients():
    while True:
        try:
            conn, _addr = _state.sock.accept()
        except OSError:
            break
        conn.setblocking(False)
        _state.clients.append(_Client(conn))
def poll():
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
        client.conn.sendall((json.dumps(result.response) + "\0").encode())
        client.conn.close()
        _state.clients.remove(client)
def start(host, port):
    import addon_utils
    addon_utils.log("start", port)
    if is_running(): raise RuntimeError("Server is already running")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1" if host == "localhost" else host, port))
    sock.listen(1)
    sock.setblocking(False)
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
if _then is not None:
    _steps.append(_report())
    _press_start()
    _steps.append(_report())
if _scenario.get("reload"):
    # Reload Scripts runs Blender Lab's module afresh; then its own Start button.
    import importlib as _importlib
    _server().stop()
    _importlib.reload(_server())
    bpy.ops.blmcp.server_start()
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
        # A /proc/net/tcp of T3's making: the kernel's format, with the uid the scenario asks.
        def _hex(address):
            raw = socket.inet_aton(address[0])
            if _table.get("mapped"):
                raw = b"\0" * 10 + b"\xff\xff" + raw
            words = (_st.unpack("=I", raw[i:i + 4])[0] for i in range(0, len(raw), 4))
            return "".join("%08X" % word for word in words) + ":%04X" % address[1]
        _rows = ["  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"]
        if _table.get("row", True):
            _rows.append("   0: %s %s 01 00000000:00000000 00:00000000 00000000 %5d        0 1 1" % (
                _hex(_client.getsockname()),
                _hex(("127.0.0.1", int(MCP_PORT))),
                os.getuid() + _table.get("uidOffset", 0),
            ))
        _fake = os.path.join(os.path.dirname(SOCKET_PATH), "tcp")
        with open(_fake, "w") as _out:
            _out.write("\n".join(_rows) + "\n")
        PROC_NET_TCP = (_fake,)
    _client.sendall((json.dumps({
        "type": "execute",
        "code": "result = {'cube': 1}",
        "strict_json": _call.get("strictJson", False),
    }) + "\0").encode())
    _server().poll()
    _client.settimeout(5)
    try:
        _reply = _client.recv(65536)
    except OSError:
        _reply = b""
    _acting = _snapshot()["agentActing"]
    _Guard.acting_until = 0.0
    _called = {
        "reply": json.loads(_reply.rstrip(b"\0")) if _reply else None,
        "dirty": bpy.data.is_dirty,
        "acting": _acting,
        "actingAfter": _snapshot()["agentActing"],
    }
print(_j.dumps({
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
  readonly send?: ReadonlyArray<"grantAgentListener" | "stopAgentListener">;
  readonly pressStartBeforeGrant?: boolean;
  /** Another file is open by the time T3's grant arrives. */
  readonly fileBeforeGrant?: boolean;
  readonly then?: "revoke" | "drop" | "otherFile" | "saveAs" | "revert";
  /** The installed extension's manifest version; 1.0.3 by default. */
  readonly mcpVersion?: string;
  /** Reload Scripts, then the extension's own Start button, before any call. */
  readonly reload?: boolean;
  /**
   * An MCP call over real loopback TCP. With `table`, the add-on reads a /proc/net/tcp of
   * the test's making: the client's row, or none, owned by this account plus `uidOffset`.
   */
  readonly call?: {
    readonly strictJson?: boolean;
    readonly table?: {
      readonly row?: boolean;
      readonly uidOffset?: number;
      readonly mapped?: boolean;
    };
  };
}) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-control-addon-"));
  dirs.push(dir);
  for (const [file, body] of Object.entries(STUBS)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, file), body);
  }
  NodeFS.writeFileSync(
    NodePath.join(dir, "bl_ext/user_default/mcp/blender_manifest.toml"),
    `id = "mcp"\nversion = "${input.mcpVersion ?? "1.0.3"}"\n`,
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

  describe("its guard on Blender Lab's listener", () => {
    const ok = { status: "ok", result: { cube: 1 } };

    it("takes a call from this account, found by its real loopback connection", () => {
      const result = runAddon({ installed: [MCP], enabled: [MCP], listen: true, call: {} });
      expect(result.call.reply).toEqual(ok);
    });

    it("drops a connection another account owns", () => {
      const result = runAddon({
        installed: [MCP],
        enabled: [MCP],
        listen: true,
        call: { table: { uidOffset: 1 } },
      });
      expect(result.call).toMatchObject({ reply: null, dirty: false, acting: false });
    });

    it("drops a connection whose owner can't be found", () => {
      const result = runAddon({
        installed: [MCP],
        enabled: [MCP],
        listen: true,
        call: { table: { row: false } },
      });
      expect(result.call.reply).toBeNull();
    });

    it("reads an IPv4-mapped client from tcp6 rows", () => {
      const result = runAddon({
        installed: [MCP],
        enabled: [MCP],
        listen: true,
        call: { table: { mapped: true } },
      });
      expect(result.call.reply).toEqual(ok);
    });

    it("ends access when Reload Scripts and its own Start button bring back an unguarded listener", () => {
      const result = runAddon({ installed: [MCP], enabled: [MCP], listen: true, reload: true });
      expect(after(result)).toEqual(off);
      expect(result.inPrefs).toBe(false);
    });

    it("pushes an undo step after the agent's own code, which makes the file unsaved", () => {
      const result = runAddon({ installed: [MCP], enabled: [MCP], listen: true, call: {} });
      expect(result.call.dirty).toBe(true);
      expect(result.calls).toContainEqual(["undo_push", "Agent edit"]);
    });

    it("pushes no undo step after Blender Lab's own read-only tool code", () => {
      const result = runAddon({
        installed: [MCP],
        enabled: [MCP],
        listen: true,
        call: { strictJson: true },
      });
      expect(result.call).toMatchObject({ reply: ok, dirty: false });
      expect(result.calls.some((call: ReadonlyArray<unknown>) => call[0] === "undo_push")).toBe(
        false,
      );
    });

    it("says the agent is acting during a call, and not once it has passed", () => {
      const result = runAddon({
        installed: [MCP],
        enabled: [MCP],
        listen: true,
        call: { strictJson: true },
      });
      expect(result.call).toMatchObject({ acting: true, actingAfter: false });
    });

    it("never enables an untested version, and says which it is", () => {
      const result = runAddon({
        installed: [MCP],
        enabled: [MCP],
        listen: true,
        mcpVersion: "1.1.0",
      });
      expect(after(result)).toEqual({ listener: "untested", listening: null, enabled: false });
      expect(bound(result)).toBe(false);
      expect(result.mcpVersion).toBe("1.1.0");
    });

    it("ends an untested version's refusal like any other grant", () => {
      const result = runAddon({
        installed: [MCP],
        enabled: [MCP],
        listen: true,
        mcpVersion: "0.9.0",
        then: "revoke",
      });
      expect(result.steps.slice(-2)).toEqual([off, off]);
      expect(bound(result)).toBe(false);
    });
  });
});
