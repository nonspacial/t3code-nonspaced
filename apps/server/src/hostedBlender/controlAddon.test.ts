// @effect-diagnostics nodeBuiltinImport:off - runs the add-on under python3 with stand-in Blender modules.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { CONTROL_ADDON_SOURCE } from "./controlAddon.ts";

// Just enough of `bpy` and `addon_utils` for the add-on's register(): a user config with the
// official MCP extension installed, enabled or not, and a record of what the add-on did to it.
const STUBS = {
  "bpy/__init__.py": String.raw`
import json, os, types
state = json.loads(os.environ["STUB_STATE"])
class Prefs:
    def __init__(self): self.port = 9876; self.host = "0.0.0.0"
class Addon:
    def __init__(self): self.preferences = Prefs()
class Addons(dict):
    def keys(self): return list(super().keys())
addons = Addons({name: Addon() for name in state["enabled"]})
context = types.SimpleNamespace(
    preferences=types.SimpleNamespace(addons=addons, is_dirty=True),
    window_manager=types.SimpleNamespace(windows=[]),
)
data = types.SimpleNamespace(filepath="", is_dirty=False)
from . import app
`,
  "bpy/app/__init__.py":
    "import types\ntimers = types.SimpleNamespace(register=lambda *a, **k: None)\nfrom . import handlers\n",
  "bpy/app/handlers.py": "load_post = []\ndef persistent(function):\n    return function\n",
  "addon_utils.py": String.raw`
import json, os, types, bpy
state = json.loads(os.environ["STUB_STATE"])
def modules():
    return [types.SimpleNamespace(__name__=name) for name in state["installed"]]
def enable(name, default_set=True):
    bpy.context.preferences.addons[name] = bpy.Addon()
    log("enable", name, default_set)
def disable(name, default_set=True):
    bpy.context.preferences.addons.pop(name, None)
    log("disable", name, default_set)
def log(*entry):
    with open(os.environ["STUB_LOG"], "a") as out:
        out.write(json.dumps(entry) + "\n")
`,
};

const MCP = "bl_ext.user_default.mcp";
let dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs) NodeFS.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Runs register() and reports the MCP add-on's calls and its port afterwards. */
const runAddon = (input: {
  readonly installed: ReadonlyArray<string>;
  readonly enabled: ReadonlyArray<string>;
  readonly listen: boolean;
}) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-control-addon-"));
  dirs.push(dir);
  for (const [file, body] of Object.entries(STUBS)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, file), body);
  }
  const addon = NodePath.join(dir, "t3_control.py");
  NodeFS.writeFileSync(
    addon,
    `${CONTROL_ADDON_SOURCE}\nimport json as _j\nprint(_j.dumps({n: a.preferences.port for n, a in bpy.context.preferences.addons.items()}))\n`,
  );
  const log = NodePath.join(dir, "calls.log");
  const stdout = NodeChildProcess.execFileSync(
    "python3",
    [addon, "--", "--t3-mcp-port", "41234", ...(input.listen ? ["--t3-mcp-listen"] : [])],
    {
      env: {
        ...process.env,
        PYTHONPATH: dir,
        STUB_STATE: JSON.stringify(input),
        STUB_LOG: log,
      },
      encoding: "utf8",
    },
  );
  const calls = NodeFS.existsSync(log)
    ? NodeFS.readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return { calls, ports: JSON.parse(stdout.trim().split("\n").at(-1)!) };
};

describe("T3's control add-on and the official MCP add-on", () => {
  it("keeps the official listener off without --t3-mcp-listen, for this session only", () => {
    const { calls, ports } = runAddon({ installed: [MCP], enabled: [MCP], listen: false });
    expect(calls).toEqual([["disable", MCP, false]]);
    expect(ports).toEqual({});
  });

  it("listens on T3's port, never 9876, for a thread whose agent uses it", () => {
    const { calls, ports } = runAddon({ installed: [MCP], enabled: [MCP], listen: true });
    expect(calls).toEqual([]);
    expect(ports).toEqual({ [MCP]: 41234 });
  });

  it("turns the installed add-on on for this session when the user's settings had it off", () => {
    const { calls, ports } = runAddon({ installed: [MCP], enabled: [], listen: true });
    expect(calls).toEqual([["enable", MCP, false]]);
    expect(ports).toEqual({ [MCP]: 41234 });
  });

  it("leaves other add-ons alone", () => {
    const { calls } = runAddon({
      installed: ["bl_ext.user_default.node_wrangler"],
      enabled: ["bl_ext.user_default.node_wrangler"],
      listen: false,
    });
    expect(calls).toEqual([]);
  });
});
