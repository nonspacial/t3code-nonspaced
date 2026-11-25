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
export const untestedBlenderLabReason = (name: string, version: string | null): string => {
  const tested = TESTED_BLENDER_LAB_MCP_VERSIONS.join(", ");
  const installed =
    version === null ? "an MCP extension whose version T3 can't read" : `MCP ${version}`;
  const update =
    version !== null && TESTED_BLENDER_LAB_MCP_VERSIONS.every((known) => isNewer(version, known))
      ? "T3 Code, which hasn't tested this newer version yet"
      : "Blender Lab's MCP extension in their own Blender (Edit > Preferences > Get Extensions); T3 Code copies the new version into the hosted Blender when it next starts";
  return `${name} is open, but T3 Code refused you access: the hosted Blender has Blender Lab's ${installed}, and T3 Code has tested only ${tested}. Tell the user to update ${update}. Then call blender_quit and blender_start again.`;
};

// Written into T3's copy of the user's settings as a startup script, which Blender runs before it
// enables add-ons, at launch and on Reload Scripts. Blender Lab's add-on then never registers from
// those settings; only the control add-on's grant enables it.
export const HOSTED_STARTUP_GATE_SOURCE = String.raw`
import bpy


def _strip_blender_lab():
    addons = bpy.context.preferences.addons
    for addon in [addon for addon in addons if addon.module.startswith("bl_ext.") and addon.module.endswith(".mcp")]:
        addons.remove(addon)


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
PROC_NET_TCP = ("/proc/net/tcp", "/proc/net/tcp6")
# A quick call still shows on the pane.
AGENT_ACTING_LINGER = 1.5
_IPV4_MAPPED = b"\0" * 10 + b"\xff\xff"
_TCP_ESTABLISHED = "01"


class _Guard:
    acting_until = 0.0
    accept = None
    execute = None


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


def _unmapped(raw):
    return raw[12:] if raw[:12] == _IPV4_MAPPED else raw


def _proc_address(text):
    # "0100007F:1F90": the address as the kernel's 32-bit words in host byte order, then the port.
    address, port = text.split(":")
    raw = b"".join(struct.pack("=I", int(address[i:i + 8], 16)) for i in range(0, len(address), 8))
    return _unmapped(raw), int(port, 16)


def _address(family, sockaddr):
    return _unmapped(socket.inet_pton(family, sockaddr[0])), sockaddr[1]


def _tcp_rows():
    rows = []
    for path in PROC_NET_TCP:
        try:
            with open(path, encoding="ascii") as file:
                lines = file.read().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            try:
                rows.append({
                    "local": _proc_address(fields[1]),
                    "remote": _proc_address(fields[2]),
                    "state": fields[3],
                    "uid": int(fields[7]),
                    "inode": int(fields[9]),
                })
            except (IndexError, ValueError, struct.error):
                continue
    return rows


def _live_row(rows, local, remote):
    # One established socket with an inode: an orphaned or closing one lists uid and inode 0.
    matches = [row for row in rows if row["local"] == local and row["remote"] == remote]
    if len(matches) != 1:
        return None
    row = matches[0]
    return row if row["state"] == _TCP_ESTABLISHED and row["inode"] != 0 else None


def _peer_uid(connection):
    peer = _address(connection.family, connection.getpeername())
    ours = _address(connection.family, connection.getsockname())
    client = _live_row(_tcp_rows(), peer, ours)
    if client is None:
        return None
    # Read again: with our end still established, the row read was this connection's client.
    again = _tcp_rows()
    if _live_row(again, ours, peer) is None or _live_row(again, peer, ours) != client:
        return None
    return client["uid"]


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


def _guard_mcp_server(server):
    # Fails closed: a module without the functions this wraps gets no listener.
    if _is_guarded(server):
        return True
    original_execute = getattr(server, "_execute_code", None)
    if not callable(original_execute) or not callable(getattr(server, "_accept_clients", None)):
        return False
    if not all(hasattr(server, name) for name in ("_Client", "_state")):
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
        try:
            result = original_execute(code, strict_json)
        except BaseException:
            if not strict_json:
                _push_agent_undo()
            raise
        finally:
            _Guard.acting_until = time.monotonic() + AGENT_ACTING_LINGER
        if strict_json:
            return result
        check = getattr(result, "check_fn", None)
        if check is None:
            _with_undo_warning(result.response, _push_agent_undo())
            return result

        # Deferred work (a render) changes the scene later: its undo step waits for it.
        def check_then_undo():
            done = check()
            if isinstance(done, dict):
                _with_undo_warning(done, _push_agent_undo())
            return done

        return result._replace(check_fn=check_then_undo)

    server._accept_clients = accept_clients
    server._execute_code = execute_code
    _Guard.accept = accept_clients
    _Guard.execute = execute_code
    return True


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
    if bpy.context.preferences.edit.undo_steps < 1:
        return "Undo is off in this Blender (Undo Steps is 0), so Ctrl+Z can't undo this edit."
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
    if "FINISHED" not in outcome:
        return "T3 couldn't record an undo step for this edit, so Ctrl+Z can't undo it."
    return None


def _agent_acting(server):
    if not _is_guarded(server) or not server.is_running():
        return False
    if time.monotonic() < _Guard.acting_until:
        return True
    deferred = sys.modules.get(_State.mcp_name + ".deferred_tool") if _State.mcp_name else None
    return bool(deferred is not None and deferred.has_pending())
`;
