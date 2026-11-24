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
could run Python in the user's Blender. Loopback TCP has no peer credentials either. The control add-on
therefore replaces two internal functions of Blender Lab's server module
([`agentGuard.ts`](../../apps/server/src/hostedBlender/agentGuard.ts)): accepting a connection
looks up the client's end in `/proc/net/tcp` and `/proc/net/tcp6` and drops it unless its owner is
Blender's own uid (a missing row also drops it), and running the agent's own code is followed by an
undo push, which is what marks the file unsaved; Blender's data API alone leaves it clean. The same
wrapper reports when the agent is acting, which drives the pane's badge and the floating player.

Because this reaches into Blender Lab's internals, the add-on reads the installed extension's
manifest version and enables nothing unless it is in `TESTED_BLENDER_LAB_MCP_VERSIONS`. When
Blender Lab releases a version, check that `_accept_clients`, `_Client`, `_state.clients` and
`_execute_code(code, strict_json)` still mean what the guard assumes, and only then add it to the list.
Reload Scripts runs the module again without the guard, so the add-on guards it again on its next
tick or ends access.
