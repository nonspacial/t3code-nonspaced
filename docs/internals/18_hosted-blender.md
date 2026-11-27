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
Deleting a thread ends its Blender, then removes the copies it kept, which
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

## A finished thread's working copy is held, never left

`blender_start` records each working copy it makes (its thread, its master by real path, its
place) in T3's state, beside the recovery copies but not as one: a recovery copy is unsaved work
over a file, a held copy is the file itself, so neither's lifecycle fits the other. Only a copy
T3 recorded is ever moved or deleted, and only while it is still a regular file with one name,
named and placed as that thread's copy of that master; anything else stays, and Settings says
so. T3 can't tell a file the person saved under that name from Blender's own save of the copy.
Copies made before the record existed are never imported.

Its thread settling or being archived holds it once the thread's Blender has really ended,
and so does any later end of a Blender of a thread still finished (however long a held close
keeps it open, and never while a Blender released at shutdown may still write it), then its
`.blend1` backups removed. The record stays in T3's state, but the file is held in the
workspace's own `.t3/held-working-copies` (so T3 creates `.t3/` in a person's project root; its
`.gitignore` of `*` keeps it out of git, and out of file search only in a git repository: the
Files panel lists it dimmed, and `git clean -fdx` deletes it), never on the OS drive the state is
on. Storage cleanup keeps a worktree whose held folder has anything but
that `.gitignore`, under every keep rule, since git status can't see it. A scene can be
gigabytes, kept 30 days per finished thread. The record names where it is; one with no place is
beside the record, as earlier builds held them. T3's lock doesn't stop another program (a
desktop Blender) saving that path, so the copy is never deleted by name: it is renamed into the
held folder, which takes whatever is there at that instant, and put back by hard link, the
record staying `returning` until the held name is gone (a second name would make the copy
"linked" and never held again). Only across a mount inside the workspace (EXDEV), with no known
workspace, or with a `.t3` or held folder that is a symlink out of the workspace, is it held in
T3's state instead: copied through a synced temporary name, then the project's file renamed aside
in its own folder (the record names the aside, and only a named one is ever put back) and removed
only if it is still the file that was copied. Removing a held copy removes its file and partial,
then its folder only if empty. A save that slipped in goes
back to its place, never over a file there, and nothing is held; with a file there, it stays
aside and Settings says where. The record says which way a move was going, and whatever acts
on a copy next (a start, an open, a hold, an answer) first finishes it from the side that is
whole, removing only T3's own files: a file set aside goes back first, as the newest the
project had, and the copy is held again later. Under the copy's lock nothing is mid-move, so a
state left between two is a write that failed. Each copy's moves run under a lock of its own, by path,
which every open of a recorded copy takes too, so an open during a move waits for it and acts on
what it left. Opening the thread's Blender (the pane shows its held copy as a kept one) puts it
back by hard link, which never replaces a file that took its name. Delete and Keep name a hold
by when it was held, so an answer to an earlier hold never reaches a later one. The master "moving on" is its revision (as the
reload watcher reads one) differing from the one recorded at hold, read only when it costs
nothing (start, a thread opening or saving that master, Settings, the daily pass); nothing
watches it. The daily pass, the only timer, also deletes what is past 30 days and what a
deleted or missing thread left, and forgets a copy whose file is gone only while its workspace
root and master are there: a drive not mounted looks like a removed worktree, and an empty mount
point like an emptied folder, so those records wait for the drive or the 30 days. A held file
can't be opened, chosen as a master or started by an agent. Agents can't delete held copies.

## A quit is one record

Every quit T3 sends the add-on (the person's discard, a held or plain close, Save and quit, a
master's quit-if-clean) carries a request id, and the add-on names that id on every answer about
it. The server keeps one record per quit (`QuitRequest` in
[`HostedBlender.ts`](../../apps/server/src/hostedBlender/HostedBlender.ts)): its kind, who asked,
the file it named, its deadline, its phase and what Blender has said of it. An answer to a quit
no path still waits on changes nothing, so Blender refusing an earlier quit as expired never
settles a retry. Whether Blender stays open, a close is owed, a discard counts, and whether the
run ended closed (its copy kept) or stopped (nothing kept) are read from those records, in one
place each; a flag beside them is how the paths drifted apart before.

Only the person's own Quit without saving, a discard, ends a run without keeping its unsaved
work, and a discard of changes restored from a copy removes that copy too; every other quit without saving (an agent's, or a one-click quit of a file the client last
saw clean) is a close, so what Blender reports as it quits decides what is kept. What is kept is
the .blend alone, so closes the person or a settle asks for are held while Blender has unsaved
image or asset catalog edits: Blender stays open, the quit says which, and the running state
keeps saying so until they are saved, so a held settle isn't silent. The agent keeps its access
through a held quit, to save what holds it: the add-on ends the grant itself as it begins to
quit. Save and quit first saves the images as Blender's own quit does (and the save writes the
catalogs), and is held only by an image it couldn't save, which it names. Only the discard, a
deleted thread and T3 stopping don't ask.

A held close or a discard carries T3's deadline, and the add-on refuses one it reads after it: a
Blender busy past it (a render, a long load) is left running, never stopped, and nothing T3 gave
up on runs later. The add-on answers a quit it takes at once, before ending the grant (which can
record agent work as undo steps, slow on a large scene), so T3 never reports as unanswered a
quit Blender goes on to carry out. A settle, archive or switch-off left unanswered is owed: it
runs again, still held, once that Blender answers anything (at once if it already answered while
T3 was giving up), unless a pane shows it or the agent acts in it by then. The retry first checks
that the thread is still settled or archived, or Hosted Blender still off; opening or reopening
that Blender, switching Hosted Blender back on, or granting an agent access to it cancels the
owed close. A quit that leaves Blender open sends again the window words it held back while it
was queued: the viewport handshake, the Timeline and the display. No agent tool can reopen or
discard a copy, so the agent's next `blender_start` of a working copy with a waiting copy
restores it rather than refusing.

Both choices of the save/discard dialog carry the file it named, and the add-on refuses either if
Blender has another open by then, so a file opened from Blender's own menu is never discarded or
written under another's name; the dialog keeps the file and Blender it opened for, and asks
afresh when either changes. A discard runs beside the client's per-thread command lane, so a
Save and quit stuck in a busy Blender can't hold it. At its deadline it stops Blender only once
Blender has said it is quitting that file, or is saving it; unheard, or unsendable because the
control connection dropped, Blender stays open and the discard is reported unconfirmed. A run
counts as discarded only once Blender has taken the discard; an exit before that, a crash or a
second unheard discard that stops it, ends as a crash: its last autosave is kept, and only
Discard on that card, naming the file, removes it. A settle waits on a Save and quit Blender has
begun however long it takes; one still queued by the deadline is left to run. Only T3 stopping
and a deleted thread stop a Blender that doesn't answer.

At shutdown, a Blender that has said it is saving or quitting is released, never killed while it
writes what may be the only copy of its latest work: the helper is told to `detach` (Blender dies
with the helper, so the helper stays until Blender exits, whatever T3 does), its handle is
unref'd so the server's exit signals nothing in its process group, and its launch folder stays
for the next start. That start never signals it for two hours: its salvage waits for it to exit,
beside the service, reading only its processes' own `/proc` entries every few seconds and
walking `/proc` again only when one of them is gone. Meanwhile the file it has open stays claimed,
by its real path, for every thread and the master: an open of it, or a Reopen of the copy it is
writing, fails at once saying Blender is still saving, rather than waiting or starting a second
Blender on the file. One still running after two hours is stuck: it is stopped then, and its
salvage keeps whatever copy or autosave it left.

## The viewport window is found by its title

The hidden display helper makes fullscreen every window whose title contains "3D Viewport"
([`BlenderLaunch.ts`](../../apps/server/src/hostedBlender/BlenderLaunch.ts)) and streams the
display while the first of them fills it. It streams the display, not that window, so Blender's
own windows (render view, file browser, Preferences) float centred in front of the viewport and
take input, as on a desktop: labwc's config gives them a close button, fits them inside the
display again whenever the pane resizes, and never raises the undecorated viewport over them on a
click ([`display.rs`](../../native/hidden-display/src/display.rs)). Blender's main window, the
first window it maps, must never show: the helper keeps it minimized and streams nothing while
it isn't. With a window in front, Blender's picture of the 3D view alone isn't what the pane
shows, so the add-on makes none and Screenshot & annotate freezes the pane's own frame, without
hits. Blender gives the viewport's title only to a window holding a lone 3D view; split, it may become "Blender"
(on 4.5 even a split made before the window is shown does, so it is never made fullscreen), and
removing the strip doesn't give it back. So the control add-on opens each viewport window as a
lone 3D view and adds the Timeline strip only once the helper has it. Every window with that
title is made fullscreen, selected or not, so the window's size alone can't say the helper chose
it. While T3 is connected, the add-on closes every other viewport window, announces the new
one's number and opens it only once T3 answers `viewportExpected`, so the next `windowCaptured`
T3 hears is that window's; without T3 it opens at once. T3 answers `viewportShown` once it has
that capture, and the add-on splits only once T3 has also said the capture's mode with
`display`: an output size its window fills, or the whole output. Unknown, it waits; a window
that never fills the output stays whole and capturable. T3's words that shape the window go out
one at a time, the Timeline's read as it is written, and none once a quit is queued: a Blender
that closes with a command unread can make T3's end of the socket drop its last report. A quit
that leaves it open sends again what it held back. Once captured, the helper keeps the
window whatever its title becomes. Screenshots, marks, view capture and view links read the 3D
view's own area and region, never the strip's; the stream and the pane's size follow the whole
window.

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
