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
A connection passes only when exactly one row is its client end, that row is established with a
nonzero inode, and its uid is ours, and a second read still shows our own end established. Anything
in doubt is refused: an orphaned or closing socket lists uid 0 and inode 0, which would otherwise
read as root's.

Blender Lab never registers from the hosted settings: T3 writes a startup script into its settings
copy, and Blender runs startup scripts before it enables add-ons, at launch and on Reload Scripts.
Only the control add-on's grant enables it, after replacing two functions its `poll()` looks up by
name: accepting a connection applies the check above, and running the agent's own code is followed
by an undo push, which is what marks the file unsaved (Blender's data API alone leaves it clean), and
reports when the agent is acting. Any listener without a live grant and that guard in place is
stopped, so Reload Scripts ends access.

Because the guard reaches into Blender Lab's internals, the add-on reads the extension's manifest
(a top-level string `version`, parsed as TOML) when it grants, and enables nothing unless the
version is in `TESTED_BLENDER_LAB_MCP_VERSIONS`. When Blender Lab releases a version, check that
`_accept_clients`, `_Client`, `_state` and `_execute_code(code, strict_json)` still mean what the
guard assumes, and only then add it. T3's settings copy is made once, so the user's own copy of the
extension is copied in again whenever its manifest changes.
