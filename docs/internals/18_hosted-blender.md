# Hosted Blender

A hosted Blender is a Blender the server runs on a hidden display for one thread, streamed to the
Blender pane and reachable by that thread's agent. Three decisions span the server, the provider
adapters and the Blender process, and are easy to undo by accident.

## Threads own them

A working Blender belongs to one thread: it quits when that thread settles or is archived, when T3
shuts down, or when the user or agent quits it. A master Blender is the one exception, shared by
the threads that chose its master file and kept until the last of them leaves (and then only if
it has nothing unsaved). `blender_start` only makes the thread's master known, so the pane can offer it: a
known master is not a member of, moved with, or relayed to any master Blender until an open
chooses it, so it never keeps one running or counts at settle. Every other ending (T3 stopping, Hosted Blender switched off, a crash)
ends it like a working one, and its recovery copy belongs to the master, not a thread: one copy,
under the master file's real path, that any thread whose master is that file reopens or discards.
Only the person's own Quit without saving, which the quit request marks as a discard, ends a run
without keeping its unsaved work; every other quit without saving (an agent's, or a one-click quit
of a file the client last saw clean) ends as a settle does, so what Blender reports as it quits
decides what is kept. No agent tool can reopen or discard a copy, so the agent's next
`blender_start` of a working copy with a waiting copy restores it rather than refusing. A discard
carries the file its dialog named, and the add-on refuses it if Blender has another open by then,
so a file opened from Blender's own menu is never discarded under another's name. It runs beside
the client's per-thread command lane, so a Save and quit stuck in a busy Blender can't hold it,
and it stops Blender at its deadline even mid-save. A settle waits on a Save and quit only once
Blender has begun it; one still queued by the deadline is stopped like any unanswered quit.
At shutdown, a Blender that has said it is saving or quitting is released, never killed while
it writes what may be the only copy of its latest work: the helper is told to `detach` (Blender
dies with the helper, so the helper stays until Blender exits, whatever T3 does), its handle is
unref'd so the server's exit signals nothing in its process group, and its launch folder stays
for the next start's salvage, which waits for it before stopping anything. Deleting a thread ends its Blender, then removes the copies it kept, which
nothing could show again; a master's copy is never the thread's. Agent access is narrower still: it lasts only while T3 holds the control
connection, Allow agents is on, and the launch file (the working copy, or the master) is still the
open file. Once any of those ends, access stays ended until that Blender restarts
([`controlAddon.ts`](../../apps/server/src/hostedBlender/controlAddon.ts)). Do not add a path that
grants access again in place; every such path was a way to hand the agent a file the user opened.
A grant lasts for its launch, not for the session that asked: provider sessions end whenever a
thread idles, and the thread's next session must reach the same Blender. The gate per session is
T3's own: a working copy's agent reaches it only through the Blender Lab server T3 runs for that
session, and a master's only through relays, one per agent thread and session, opened for a
current session and closed when that session's access ends. With no agent thread, nothing listens
for a master's agents.

## A change on disk Blender didn't make

The add-on, not the server, decides whether the open file changed. T3's watcher only says the
file, by its real path, settled at a revision (as previews read one, never the bytes); the add-on
compares that with the revision it recorded itself, before reading the file (`load_pre`) and after
its own save (`save_post`), and checks the disk again right before it loads. It answers on
Blender's main thread, so a save in progress has finished and recorded its revision first; a
timing guess either reloads over live work or misses a change. A copy restored over the same file
keeps that baseline, since the file wasn't read again, and a file deleted since it was read is a
conflict for saves T3 starts, which refuse rather than write an older state over the file.

Reloads run only while a pane is on screen (the server takes a held one back once none is, and
a pane attaching in a background tab says so before capture starts) or right before an agent's
call. A stale scene that can't reload yet answers the agent's call with why, and runs nothing.
A reload keeps the session's windows (`load_ui=False`), so the viewport window and its view stay.

Unsaved work goes first to Blender's own autosave, which carries the file's path so restoring it
saves to the file. Blenders before 5.2 have no operator for that: their copy is saved as-is and
the path set in its FileGlobal, found through the file's own SDNA. Either is staged in the
launch's TMPDIR beside a note naming its file, before the load, so a server that dies first
leaves it for salvage; the server writes its record, moves it, then drops the note, and offers
it only once all three are done. A save retires a copy only once the scene holds its work: one
a reload or a restore displaced never did, until it is restored and not reloaded since.

## The stream's window and acks change together

The server keeps a few frames per viewer unacked and sends nothing after a keyframe until that
keyframe is acked ([`ViewerFlow.ts`](../../apps/server/src/hostedBlender/ViewerFlow.ts)); the
client, web and mobile alike, acks every frame it receives once its decoder can take more
([`stream.ts`](../../packages/client-runtime/src/hostedBlender/stream.ts)). Change one only with
the other: an ack the client folds into another takes a slot out of the window for good, and a
delta it drops smears the picture until the next keyframe, which the encoders send only on request.

## Agents use only the official Blender Lab MCP

Agents reach a hosted Blender only through Blender Lab's own `blender-mcp`, added per session as
`blender-hosted` and `blender-master` ([`hostedBlenderMcp.ts`](../../apps/server/src/provider/hostedBlenderMcp.ts)).
T3 serves both over its own authenticated MCP endpoint
([`HostedBlenderMcpProxy.ts`](../../apps/server/src/hostedBlender/HostedBlenderMcpProxy.ts)), so a
session that never touches Blender starts no Python: `initialize` and the lists are the official
server's own answers, read by setup when it checks the server (kept per installed build, never
edited). A tool call starts the session's own `blender-mcp` only while the session holds a live
grant for that role, and that server ends with the grant or the session. The credential picks
the session, and T3's records the port; nothing a caller sends selects a Blender, and no port
reaches the agent: a working Blender listens on a private port of its own launch.
T3's own tools cover lifecycle (`blender_start`, `blender_master_open`, `blender_status`,
`blender_quit`) and never run
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
