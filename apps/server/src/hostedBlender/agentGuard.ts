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
      : "the MCP extension in their Blender (Edit > Preferences > Get Extensions)";
  return `${name} is open, but T3 Code refused you access: the user's Blender has Blender Lab's ${installed}, and T3 Code has tested only ${tested}. Tell the user to update ${update}, then call blender_quit and blender_start again.`;
};

// Part of the control add-on. It replaces Blender Lab's `_accept_clients`, to drop clients another
// OS account owns (loopback TCP has no peer credentials), and `_execute_code`, to push an undo step
// after the agent's own code (`strict_json` false): data edits alone leave the file clean.
// See docs/internals/18_hosted-blender.md.
export const AGENT_GUARD_SOURCE = String.raw`
TESTED_MCP_VERSIONS = ${JSON.stringify(TESTED_BLENDER_LAB_MCP_VERSIONS)}
PROC_NET_TCP = ("/proc/net/tcp", "/proc/net/tcp6")
# A quick call still shows on the pane.
AGENT_ACTING_LINGER = 1.5
_IPV4_MAPPED = b"\0" * 10 + b"\xff\xff"


class _Guard:
    acting_until = 0.0
    accept = None


def _mcp_version(module_file):
    import re

    manifest = os.path.join(os.path.dirname(module_file or ""), "blender_manifest.toml")
    try:
        with open(manifest, encoding="utf-8") as file:
            found = re.search(r'^version\s*=\s*"([^"]+)"', file.read(), re.MULTILINE)
    except OSError:
        return None
    return found.group(1) if found else None


def _unmapped(raw):
    return raw[12:] if raw[:12] == _IPV4_MAPPED else raw


def _proc_address(text):
    # "0100007F:1F90": the address as the kernel's 32-bit words in host byte order, then the port.
    address, port = text.split(":")
    raw = b"".join(struct.pack("=I", int(address[i:i + 8], 16)) for i in range(0, len(address), 8))
    return _unmapped(raw), int(port, 16)


def _address(family, sockaddr):
    return _unmapped(socket.inet_pton(family, sockaddr[0])), sockaddr[1]


def _peer_uid(connection):
    # The client's end: its local address is our peer, its remote address is us.
    peer = _address(connection.family, connection.getpeername())
    ours = _address(connection.family, connection.getsockname())
    for path in PROC_NET_TCP:
        try:
            with open(path, encoding="ascii") as file:
                rows = file.read().splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            fields = row.split()
            try:
                if _proc_address(fields[1]) == peer and _proc_address(fields[2]) == ours:
                    return int(fields[7])
            except (IndexError, ValueError, struct.error):
                continue
    return None


def _same_account(connection):
    try:
        return _peer_uid(connection) == os.getuid()
    except OSError:
        return False


def _is_guarded(server):
    # Reload Scripts runs Blender Lab's module again, putting its own functions back.
    return server is not None and getattr(server, "_accept_clients", None) is _Guard.accept


def _guard_mcp_server(server):
    # Fails closed: a module without the functions this wraps gets no listener.
    if _is_guarded(server):
        return True
    original_execute = getattr(server, "_execute_code", None)
    if original_execute is None or not all(
        hasattr(server, name) for name in ("_accept_clients", "_Client", "_state")
    ):
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
        _Guard.acting_until = time.monotonic() + AGENT_ACTING_LINGER
        try:
            return original_execute(code, strict_json)
        finally:
            if not strict_json:
                _push_agent_undo()
            _Guard.acting_until = time.monotonic() + AGENT_ACTING_LINGER

    server._accept_clients = accept_clients
    server._execute_code = execute_code
    _Guard.accept = accept_clients
    return True


def _push_agent_undo():
    window = _main_window()
    try:
        if window is None:
            bpy.ops.ed.undo_push(message="Agent edit")
        else:
            with bpy.context.temp_override(window=window):
                bpy.ops.ed.undo_push(message="Agent edit")
    except Exception as error:  # noqa: BLE001 - a failed undo push is reported, never a crash
        print("T3 control add-on: undo push failed:", error, file=sys.stderr)


def _agent_acting(server):
    if not _is_guarded(server) or not server.is_running():
        return False
    if time.monotonic() < _Guard.acting_until:
        return True
    deferred = sys.modules.get(_State.mcp_name + ".deferred_tool") if _State.mcp_name else None
    return bool(deferred is not None and deferred.has_pending())
`;
