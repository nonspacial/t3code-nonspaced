/**
 * The versions of Blender Lab's MCP extension whose internals the guard below wraps. Any other
 * version gets no agent listener: its accept or execute path may have moved, and an unchecked
 * port runs code for anyone on the machine.
 */
const TESTED_BLENDER_LAB_MCP_VERSIONS: ReadonlyArray<string> = ["1.0.3"];

const isNewer = (a: string, b: string) => {
  const parts = (version: string) =>
    version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

/** Why an untested Blender Lab extension gets no agent access, and what the user updates. */
export const untestedBlenderLabReason = (
  name: string,
  version: string | null,
  retry = "Then call blender_quit and blender_start again.",
): string => {
  const tested = TESTED_BLENDER_LAB_MCP_VERSIONS.join(", ");
  const installed =
    version === null ? "an MCP extension whose version T3 can't read" : `MCP ${version}`;
  const update =
    version !== null && TESTED_BLENDER_LAB_MCP_VERSIONS.every((known) => isNewer(version, known))
      ? "T3 Code, which hasn't tested this newer version yet"
      : "Blender Lab's MCP extension in their own Blender (Edit > Preferences > Get Extensions); T3 Code copies the new version into the hosted Blender when it next starts";
  return `${name} is open, but T3 Code refused you access: the hosted Blender has Blender Lab's ${installed}, and T3 Code has tested only ${tested}. Tell the user to update ${update}. ${retry}`;
};

/** The extension repository the control add-on loads a launch's Blender Lab snapshot from. */
const SNAPSHOT_REPO_MODULE = "t3_blender_lab";

// Written into T3's copy of the user's settings as a startup script, which Blender runs before it
// enables add-ons, at launch and on Reload Scripts. Blender Lab never registers from those
// settings, and the control add-on grants nothing unless this has run.
export const HOSTED_STARTUP_GATE_SOURCE = String.raw`
import bpy

COMPLETED = False


def _strip_blender_lab():
    global COMPLETED
    preferences = bpy.context.preferences
    for addon in [addon for addon in preferences.addons if addon.module.startswith("bl_ext.") and addon.module.endswith(".mcp")]:
        preferences.addons.remove(addon)
    # A snapshot repository saved by an earlier launch points at a folder that is gone.
    for repo in [repo for repo in preferences.extensions.repos if repo.module == "${SNAPSHOT_REPO_MODULE}"]:
        preferences.extensions.repos.remove(repo)
    COMPLETED = True


_strip_blender_lab()


def register():
    _strip_blender_lab()


def unregister():
    pass
`;

// Part of the control add-on. It replaces Blender Lab's `_accept_clients`, to drop clients another
// OS account owns (loopback TCP has no peer credentials), and `_execute_code`, to push an undo step
// after the agent's own code (`strict_json` false): data edits alone leave the file clean.
// The peer rules match loopbackPeer.ts; see docs/internals/18_hosted-blender.md.
export const AGENT_GUARD_SOURCE = String.raw`
TESTED_MCP_VERSIONS = ${JSON.stringify(TESTED_BLENDER_LAB_MCP_VERSIONS)}
SNAPSHOT_REPO_MODULE = "${SNAPSHOT_REPO_MODULE}"
PROC_NET_TCP = ("/proc/net/tcp", "/proc/net/tcp6")
# A quick call still shows on the pane.
AGENT_ACTING_LINGER = 1.5
_IPV4_MAPPED = b"\0" * 10 + b"\xff\xff"
_TCP_ESTABLISHED = "01"
ACCESS_ENDED_MESSAGE = "T3 Code ended your access to this Blender before this code ran; nothing was run."


class _Guard:
    acting_until = 0.0
    accept = None
    execute = None
    # Deferred calls still running whose deferred part can write, each owing an undo step.
    deferred = []


def _mcp_version(module_file):
    # Only a top-level string version counts; anything unreadable is untested.
    try:
        import tomllib

        manifest = os.path.join(os.path.dirname(module_file or ""), "blender_manifest.toml")
        with open(manifest, "rb") as file:
            version = tomllib.load(file).get("version")
    except (ImportError, OSError, ValueError):
        return None
    return version if isinstance(version, str) else None


def _is_mcp_module(name):
    parts = name.split(".")
    return len(parts) >= 3 and parts[0] == "bl_ext" and parts[2] == "mcp"


def _gate_completed():
    return getattr(sys.modules.get("t3_hosted_gate"), "COMPLETED", False) is True


def _unmapped(raw):
    return raw[12:] if raw[:12] == _IPV4_MAPPED else raw


def _proc_address(text):
    # "0100007F:1F90": the address as the kernel's 32-bit words in host byte order, then the port.
    import re

    address, port = text.split(":")
    if not re.fullmatch(r"[0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}", address) or not re.fullmatch(r"[0-9A-Fa-f]{4}", port):
        raise ValueError(text)
    raw = b"".join(struct.pack("=I", int(address[i:i + 8], 16)) for i in range(0, len(address), 8))
    return _unmapped(raw), int(port, 16)


def _address(family, sockaddr):
    return _unmapped(socket.inet_pton(family, sockaddr[0])), sockaddr[1]


def _tcp_rows():
    # None when a table holds a row that doesn't parse: a table in doubt proves nothing.
    rows = []
    for path in PROC_NET_TCP:
        try:
            with open(path, encoding="ascii") as file:
                lines = file.read().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            if not line.strip():
                continue
            fields = line.split()
            try:
                import re

                if not re.fullmatch(r"[0-9A-Fa-f]{2}", fields[3]) or not all(
                    re.fullmatch(r"[0-9]+", fields[index]) for index in (7, 9)
                ):
                    return None
                rows.append({
                    "local": _proc_address(fields[1]),
                    "remote": _proc_address(fields[2]),
                    "state": fields[3],
                    "uid": int(fields[7]),
                    "inode": int(fields[9]),
                })
            except (IndexError, ValueError, struct.error):
                return None
    return rows


def _live_row(rows, local, remote):
    # One established socket with an inode: an orphaned or closing one lists uid and inode 0.
    matches = [row for row in rows if row["local"] == local and row["remote"] == remote]
    if len(matches) != 1:
        return None
    row = matches[0]
    return row if row["state"] == _TCP_ESTABLISHED and row["inode"] != 0 else None


def _peer_uid(connection):
    # Blender's end is found by its own socket inode, so a reused address and port can't stand in.
    inode = os.fstat(connection.fileno()).st_ino
    peer = _address(connection.family, connection.getpeername())
    ours = _address(connection.family, connection.getsockname())
    readings = []
    for _ in range(2):
        rows = _tcp_rows()
        if rows is None:
            return None
        own = _live_row(rows, ours, peer)
        client = _live_row(rows, peer, ours)
        if own is None or own["inode"] != inode or client is None:
            return None
        readings.append(client)
    # Read twice: with our end still established, the row read was this connection's client.
    return readings[0]["uid"] if readings[0] == readings[1] else None


def _same_account(connection):
    try:
        return _peer_uid(connection) == os.getuid()
    except OSError:
        return False


def _is_guarded(server):
    # Reload Scripts runs Blender Lab's module again, putting its own functions back.
    return (
        server is not None
        and _Guard.accept is not None
        and getattr(server, "_accept_clients", None) is _Guard.accept
        and getattr(server, "_execute_code", None) is _Guard.execute
    )


def _still_granted(server):
    return _State.grant == "granted" and _on_authorized_file() and _is_guarded(server) and server.is_running()


def _confirm_grant(server):
    # What T3 sent since the last tick counts first: a lost connection or a stop ends it now.
    _pump_control()
    return _still_granted(server)


# Blender Lab 1.0.3's deferred paths: render_viewport_to_path and render_thumbnail_to_path defer
# through this template checker with job "RENDER", which only waits for the render and puts back
# the output path it set. The agent's own check_is_finished (execute_blender_code) can do anything.
_RENDER_CHECKER = "_deferred_tool_check_for_file_output.<locals>.check_is_finished"


def _deferred_can_write(check, strict_json):
    # Anything not known to be read-only counts as writing, including paths a later version adds.
    if not strict_json or getattr(check, "__qualname__", None) != _RENDER_CHECKER:
        return True
    names = getattr(getattr(check, "__code__", None), "co_freevars", ())
    cells = dict(zip(names, getattr(check, "__closure__", None) or ()))
    try:
        return cells["job_type"].cell_contents != "RENDER"
    except (KeyError, ValueError):
        return True


def _guard_mcp_server(server):
    # Fails closed: a module without the functions this wraps gets no listener.
    if _is_guarded(server):
        return True
    original_execute = getattr(server, "_execute_code", None)
    if not callable(original_execute) or not callable(getattr(server, "_accept_clients", None)):
        return False
    if not all(hasattr(server, name) for name in ("_Client", "_state", "_ExecResult")):
        return False

    # Background mode's poll_blocking accepts without this; hosted Blenders always have a GUI.
    def accept_clients():
        sock = server._state.sock
        if sock is None:
            return
        while True:
            try:
                connection, _address = sock.accept()
            except OSError:
                break
            if not _same_account(connection):
                connection.close()
                continue
            connection.setblocking(False)
            server._state.clients.append(server._Client(connection))

    def execute_code(code, strict_json):
        _mark_acting()
        if not _confirm_grant(server):
            return server._ExecResult({"status": "error", "message": ACCESS_ENDED_MESSAGE})
        # A file changed on disk while no pane showed it: the agent works on what is there now.
        _reload_if_stale()
        try:
            result = original_execute(code, strict_json)
        except BaseException:
            if not strict_json:
                _push_agent_undo()
            raise
        finally:
            _Guard.acting_until = time.monotonic() + AGENT_ACTING_LINGER
        check = getattr(result, "check_fn", None)
        # The agent's own code gets its step now, so edits made while a deferred part runs never
        # fold into it. Blender Lab's own tool code only reads.
        warning = None if strict_json else _push_agent_undo()
        if check is None:
            if not strict_json:
                _with_undo_warning(result.response, warning)
            return result
        record = {"check": None, "writes": _deferred_can_write(check, strict_json)}

        def check_then_undo():
            if not _confirm_grant(server):
                if record in _Guard.deferred:
                    _Guard.deferred.remove(record)
                raise RuntimeError(ACCESS_ENDED_MESSAGE)
            try:
                done = check()
            except BaseException:
                _finish_deferred(record)
                raise
            if done is not None:
                later = _finish_deferred(record)
                if isinstance(done, dict):
                    _with_undo_warning(done, warning or later)
            return done

        record["check"] = check_then_undo
        _Guard.deferred.append(record)
        return result._replace(check_fn=check_then_undo)

    server._accept_clients = accept_clients
    server._execute_code = execute_code
    _Guard.accept = accept_clients
    _Guard.execute = execute_code
    return True


def _finish_deferred(record):
    # Deferred work that can write gets its own step when it ends, however it ends, which also
    # marks the file unsaved again if it was saved in between. A known read-only part gets none.
    if record not in _Guard.deferred:
        return None
    _Guard.deferred.remove(record)
    return _push_agent_undo() if record["writes"] else None


def _record_pending_deferred():
    # No callback runs: the step records whatever the deferred part has written so far. On a file
    # that is no longer the authorized one, nothing is pushed into it.
    for record in list(_Guard.deferred):
        _finish_deferred(record)


def _sweep_deferred():
    # Blender Lab drops a deferred call on disconnect or timeout without asking it again.
    if not _Guard.deferred:
        return
    deferred = sys.modules.get(_State.mcp_name + ".deferred_tool") if _State.mcp_name else None
    waiting = [client.check_fn for client in getattr(deferred, "_deferred_clients", [])]
    for record in list(_Guard.deferred):
        if not any(check is record["check"] for check in waiting):
            _finish_deferred(record)


def _mark_acting():
    # Sent now: the call blocks Blender's main thread, so the next tick would come too late.
    _Guard.acting_until = time.monotonic() + AGENT_ACTING_LINGER
    _publish_state()


def _with_undo_warning(response, warning):
    if warning is not None and isinstance(response, dict):
        response["t3UndoWarning"] = warning


def _push_agent_undo():
    # Only the working copy T3 granted gets steps; once access ends, nothing more is recorded.
    if _State.grant != "granted" or not _on_authorized_file():
        return None
    # Pushed even with undo off: Blender marks the file modified before it checks the limit.
    undo_off = bpy.context.preferences.edit.undo_steps < 1
    # Object Mode keeps no undo history without Global Undo; Edit Mode keeps its own.
    global_off = bpy.context.mode == "OBJECT" and not bpy.context.preferences.edit.use_global_undo
    window = _main_window()
    try:
        if window is None:
            outcome = bpy.ops.ed.undo_push(message="Agent edit")
        else:
            with bpy.context.temp_override(window=window):
                outcome = bpy.ops.ed.undo_push(message="Agent edit")
    except Exception as error:  # noqa: BLE001 - reported to the agent, never a crash
        print("T3 control add-on: undo push failed:", error, file=sys.stderr)
        outcome = set()
    # FINISHED only says the push ran; the settings say whether it can have recorded a step.
    problems = []
    if undo_off:
        problems.append("Undo is off in this Blender (Undo Steps is 0), so Ctrl+Z can't undo this edit.")
    elif global_off:
        problems.append("Global Undo is off in this Blender's preferences, so Ctrl+Z can't undo this edit.")
    elif "FINISHED" not in outcome:
        problems.append("T3 couldn't record an undo step for this edit, so Ctrl+Z can't undo it.")
    if not bpy.data.is_dirty:
        problems.append("Blender doesn't show this edit as unsaved, so it may not autosave it or ask before quitting.")
    return " ".join(problems) or None


def _agent_acting(server):
    if not _is_guarded(server) or not server.is_running():
        return False
    if time.monotonic() < _Guard.acting_until:
        return True
    deferred = sys.modules.get(_State.mcp_name + ".deferred_tool") if _State.mcp_name else None
    return bool(deferred is not None and deferred.has_pending())
`;
