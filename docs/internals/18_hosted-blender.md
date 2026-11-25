# Hosted Blender

A hosted Blender is a Blender the server runs on a hidden display for one thread, streamed to the
Blender pane and reachable by that thread's agent. Three decisions span the server, the provider
adapters and the Blender process, and are easy to undo by accident.

## The thread owns it

A hosted Blender belongs to one thread: it quits when that thread settles or is archived, when T3
shuts down, or when the user or agent quits it. Nothing keeps one alive for another thread or
reuses one across threads. Agent access is narrower still: it lasts only while T3 holds the control
connection, Allow agents is on, the thread's session is alive and the working copy `blender_start`
opened is still the open file. Once any of those ends, access stays ended until that Blender
restarts ([`controlAddon.ts`](../../apps/server/src/hostedBlender/controlAddon.ts)). Do not add a
path that grants access again in place; every such path was a way to hand the agent a file the user
opened.

## Agents use only the official Blender Lab MCP

Agents reach a hosted Blender only through Blender Lab's own `blender-mcp`, added per session as
`blender-hosted` and `blender-master` ([`hostedBlenderMcp.ts`](../../apps/server/src/provider/hostedBlenderMcp.ts)).
T3's own tools cover lifecycle (`blender_start`, `blender_status`, `blender_quit`) and never run
Blender code. T3 does not ship its own code-running bridge: Blender Lab's tools, docs and sandbox
are what agents are tuned against, and a second bridge would be a second port to secure. The user's
own `blender` entry and their desktop Blender are never touched.

## The OS-account check, and why versions are pinned

Blender Lab's listener is plain loopback TCP with no authentication, so any process on the machine
could run Python in the user's Blender, and loopback TCP carries no peer credentials. The owner of a
connection's client end is read from `/proc/net/tcp` and `/proc/net/tcp6`, by two implementations
that must keep the same rules: the control add-on's, inside Blender
([`agentGuard.ts`](../../apps/server/src/hostedBlender/agentGuard.ts)), and the server's, for
connections T3 relays itself ([`loopbackPeer.ts`](../../apps/server/src/hostedBlender/loopbackPeer.ts)).
Our end is found by the accepted socket's own inode, so a reused address and port can't stand in
for it. The client end must be exactly one row, established, with a nonzero inode and our uid, and a
second read must show the same. A table with any row that doesn't parse proves nothing. An
orphaned or closing socket lists uid 0 and inode 0, which would otherwise read as root's.

The check covers a different account opening its own TCP connection. A socket the owner hands over
on purpose (`SCM_RIGHTS`), or a proxy the owner runs, still has an owner-uid end and is outside it.

Blender Lab is never in T3's settings copy, so Blender can't load it at startup from there. Each
launch that may grant an agent gets its own snapshot of the user's copy, in that launch's private
folder, checked to be whole and unchanged while it was copied. The snapshot is disposable: it goes
with the launch folder, and a folder left behind when T3 dies is reaped like any other launch's.
The control add-on loads only that
snapshot, as an extension repository of its own, and reads its version there. A startup script
T3 writes into the copy, which Blender runs before it enables add-ons (at launch and on Reload
Scripts), strips any Blender Lab entry from the settings and leaves proof that it ran. The add-on
grants nothing without that proof, if any Blender Lab module was already imported when it loaded,
or if a Blender Lab listener is already running.

Once granted, the add-on replaces two functions Blender Lab's `poll()` looks up by name. Accepting a
connection applies the check above. Before the agent's code runs, and before each check of a
deferred call, the add-on reads what T3 has sent and runs nothing if the connection is gone or a
stop is waiting; it doesn't wait for its own timer. After the code it pushes one undo step, which
is what marks the file unsaved; Blender's data API alone leaves it clean. A call is one step,
plus one more when its deferred part can change the file: that step comes when the part finishes,
fails or is dropped, or when access ends while it is still pending (recorded on the way out of
the grant, without asking the part again), and marks the file unsaved again if it was saved
meanwhile. If access ended because another file was opened, nothing is pushed into that file. Change detection
can't decide this (a Text or image pixel write triggers no depsgraph update), so the add-on
decides by what the deferred part is. Only Blender Lab's renders, which defer through its file
output checker with job `RENDER`, count as read-only; the agent's own deferred code and any path
it doesn't recognise count as writing. The push reports success even when it records nothing, so the add-on reads
Undo Steps and Global Undo itself and warns the agent. Any listener without a live, guarded grant
is stopped, so Reload Scripts ends access.

Because the guard reaches into Blender Lab's internals, nothing is enabled unless the snapshot's
manifest has a top-level string `version`, parsed as TOML, that is in
`TESTED_BLENDER_LAB_MCP_VERSIONS`. When Blender Lab releases a version, check that
`_accept_clients`, `_Client`, `_ExecResult`, `_state`, `_execute_code(code, strict_json)` and
`deferred_tool._deferred_clients` still mean what the guard assumes, and only then add it.
