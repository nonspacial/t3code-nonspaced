// @effect-diagnostics nodeBuiltinImport:off - runs the add-on under python3 with stand-in Blender modules.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { HOSTED_STARTUP_GATE_SOURCE } from "./agentGuard.ts";
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
    def __init__(self, module): self.module = module; self.preferences = Prefs()
# Like Blender's collection: iterating gives Addon entries, each with its module name.
class Addons(dict):
    def keys(self): return list(super().keys())
    def __iter__(self): return iter(list(self.values()))
    def remove(self, addon): self.pop(addon.module)
addons = Addons({name: Addon(name) for name in state["enabled"]})
context = types.SimpleNamespace(
    preferences=types.SimpleNamespace(
        addons=addons, is_dirty=True, edit=types.SimpleNamespace(undo_steps=state.get("undoSteps", 32))
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
def _undo_push(message):
    import bpy, addon_utils
    addon_utils.log("undo_push", message)
    if bpy.state.get("undoPushFails"):
        return {"CANCELLED"}
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
  "t3_hosted_gate.py": HOSTED_STARTUP_GATE_SOURCE,
  // 1.0.3's accept and execute path, which poll() looks up by name on each call.
  "bl_ext/user_default/mcp/mcp_to_blender_server.py": String.raw`
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
    for conn, check in deferred_tool.pending[:]:
        done = check()
        if done is not None:
            deferred_tool.pending.remove((conn, check))
            conn.sendall((json.dumps({"status": "ok", "result": done, **{k: v for k, v in done.items() if k == "t3UndoWarning"}}) + "\0").encode())
            conn.close()
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
            deferred_tool.pending.append((client.conn, result.check_fn))
            continue
        client.conn.sendall((json.dumps(result.response) + "\0").encode())
        client.conn.close()
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
    if _scenario.get("manifestBeforeGrant") is not None:
        with open(os.path.join(os.environ["PYTHONPATH"], "bl_ext/user_default/mcp/blender_manifest.toml"), "w") as _m:
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
        # uid, state and inode as asked) and the row of Blender's own end.
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
        _rows = ["  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"]
        for _ in range(_table.get("clientRows", 1)):
            _rows.append(_row(_peer, _ours, _table.get("state", "01"),
                              os.getuid() + _table.get("uidOffset", 0), _table.get("inode", 4242)))
        if _table.get("ownRow", True):
            _rows.append(_row(_ours, _peer, _table.get("ownState", "01"), os.getuid(), 4243))
        _fake = os.path.join(os.path.dirname(SOCKET_PATH), "tcp")
        with open(_fake, "w") as _out:
            _out.write("\n".join(_rows) + "\n")
        PROC_NET_TCP = (_fake,)
    _client.sendall((json.dumps({
        "type": "execute",
        "code": _call.get("code", "result = {'cube': 1}"),
        "strict_json": _call.get("strictJson", False),
    }) + "\0").encode())
    _server().poll()
    _dirty_first = bpy.data.is_dirty
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
        "dirtyAfterFirstPoll": _dirty_first,
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
    const granted = { installed: [MCP], enabled: [MCP], listen: true } as const;
    const withTable = (
      table: NonNullable<NonNullable<Parameters<typeof runAddon>[0]["call"]>["table"]>,
    ) => runAddon({ ...granted, call: { table } }).call.reply;

    it("takes a call from this account, found by its real loopback connection", () => {
      expect(runAddon({ ...granted, call: {} }).call.reply).toEqual(ok);
    });

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

    it("pushes a deferred call's undo step when its work finishes, not before", () => {
      const result = runAddon({
        ...granted,
        call: { code: "def check_is_finished():\n    return {'rendered': 1}\nresult = {}" },
      });
      expect(result.call).toMatchObject({
        reply: { status: "ok", result: { rendered: 1 } },
        dirtyAfterFirstPoll: false,
        dirty: true,
      });
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
    ] as const)("tells the agent when %s", (_name, options, says) => {
      const result = runAddon({ ...granted, ...options, call: {} });
      expect(result.call.reply.t3UndoWarning).toContain(says);
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
    it("drops Blender Lab from the settings before Blender enables add-ons, and nothing else", () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-gate-"));
      dirs.push(dir);
      NodeFS.mkdirSync(NodePath.join(dir, "bpy"));
      NodeFS.writeFileSync(
        NodePath.join(dir, "bpy/__init__.py"),
        String.raw`
import types
class Addons(list):
    def remove(self, addon): list.remove(self, addon)
context = types.SimpleNamespace(preferences=types.SimpleNamespace(addons=Addons(
    types.SimpleNamespace(module=name)
    for name in ["bl_ext.lab_blender_org.mcp", "bl_ext.user_default.mcp", "node_wrangler", "bl_ext.x.mcp_tools"]
)))
`,
      );
      NodeFS.writeFileSync(
        NodePath.join(dir, "gate.py"),
        `${HOSTED_STARTUP_GATE_SOURCE}\nimport json\nprint(json.dumps([a.module for a in bpy.context.preferences.addons]))\n`,
      );
      const out = NodeChildProcess.execFileSync("python3", [NodePath.join(dir, "gate.py")], {
        env: { ...process.env, PYTHONPATH: dir },
        encoding: "utf8",
      });
      expect(JSON.parse(out)).toEqual(["node_wrangler", "bl_ext.x.mcp_tools"]);
    });
  });
});
