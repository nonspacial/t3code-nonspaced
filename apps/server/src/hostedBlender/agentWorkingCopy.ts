import {
  HostedBlenderToolError,
  type HostedBlenderToolStartResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { threadWorkspaceRoot } from "../project/threadWorkspaceRoot.ts";
import { BLENDER_HOSTED_MCP_SERVER } from "../provider/hostedBlenderMcp.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import * as HostedBlender from "./HostedBlender.ts";
import { untestedBlenderLabReason } from "./agentGuard.ts";
import { HELD_FOLDER, threadTag, workingCopyName } from "./workingCopies.ts";

/**
 * A working copy is opened only as a regular file that isn't its master, so neither a symlink nor
 * a hard link to the master opens the master for editing. A master that can't be read refuses.
 */
const assertSeparateCopy = Effect.fn("HostedBlender.assertSeparateCopy")(function* (
  workingCopy: string,
  masters: ReadonlyArray<string>,
  requested: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const notSeparate = () =>
    new HostedBlenderToolError({
      reason: `${workingCopy} exists but is not a separate copy of ${requested}. Ask the user to move it aside.`,
    });
  const existing = yield* fileSystem.lstat(workingCopy).pipe(Effect.mapError(notSeparate));
  if (existing.type !== "File") return yield* notSeparate();
  let compared = 0;
  for (const master of masters) {
    const original = yield* fileSystem.stat(master).pipe(Effect.mapError(notSeparate));
    // A folder or anything else by a master's name isn't one.
    if (original.type !== "File") continue;
    compared += 1;
    if (
      Option.isNone(existing.ino) ||
      Option.isNone(original.ino) ||
      (existing.ino.value === original.ino.value && existing.dev === original.dev)
    ) {
      return yield* notSeparate();
    }
  }
  if (compared === 0) return yield* notSeparate();
});

/**
 * Copies the master to `workingCopy` without ever replacing what is there. An existing copy is
 * checked and reused before anything is copied; otherwise the copy is made under a private name
 * and hard-linked into place, which fails if a concurrent start got there first, whose copy is
 * then checked the same way. False when the copy already existed.
 */
const createWorkingCopy = Effect.fn("HostedBlender.createWorkingCopy")(function* (
  master: string,
  workingCopy: string,
  requested: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const couldNotCopy = () =>
    new HostedBlenderToolError({ reason: `T3 could not copy ${requested} to ${workingCopy}.` });
  if (Option.isSome(yield* fileSystem.lstat(workingCopy).pipe(Effect.option))) {
    yield* assertSeparateCopy(workingCopy, [master], requested);
    return false;
  }
  const linked = yield* Effect.scoped(
    Effect.gen(function* () {
      const staging = yield* fileSystem.makeTempDirectoryScoped({
        directory: path.dirname(master),
        prefix: ".t3-wip-",
      });
      const partial = path.join(staging, "copy.blend");
      yield* fileSystem.copyFile(master, partial);
      return yield* fileSystem.link(partial, workingCopy).pipe(Effect.isSuccess);
    }),
  ).pipe(Effect.mapError(couldNotCopy));
  if (linked) return true;
  yield* assertSeparateCopy(workingCopy, [master], requested);
  return false;
});

/** Why the agent can't use an open Blender, and what gets it back. */
const noAccessReason = (name: string, ended: HostedBlender.AgentAccessEnded | null): string => {
  switch (ended) {
    case "connectionLost":
      // T3 can't save through a connection it lost, so quitting with save would fail.
      return `T3 lost its connection to the hosted Blender with ${name}, so it can no longer save it or hand it to you. Ask the user to save in the Blender pane (Ctrl+S) and tell you when it's done; then call blender_quit with save: false, and blender_start again.`;
    case "otherFile":
      return `The hosted Blender has another file open now, not ${name}, so your access ended. Ask the user before you go on; to work on ${name} again, call blender_quit with save: true, then blender_start.`;
    default:
      return `${name} is open in this thread's hosted Blender, but not for you: it was opened from the pane, before your session could reach it, or your access was switched off. Call blender_quit with save: true, then blender_start again.`;
  }
};

/**
 * Why the agent can't use the thread's working Blender with `name`, which isn't ready for it, and
 * what gets it back: what `blender_start` answers and `blender_status` repeats.
 */
export const workingAccessHelp = (
  name: string,
  listener: Pick<HostedBlender.AgentListenerReport, "state" | "ended" | "mcpVersion"> | null,
): string =>
  listener?.state === "off"
    ? noAccessReason(name, listener.ended)
    : listener?.state === "untested"
      ? untestedBlenderLabReason(name, listener.mcpVersion)
      : `${name} is open, but Blender Lab's MCP add-on did not start listening for you. Check that the MCP extension is installed in the user's Blender and that nothing else holds its port, then call blender_quit and blender_start again.`;

/**
 * `blender_start`: copies the master to the thread's working copy unless one exists, and opens
 * the copy in the thread's working Blender. A copy that is already open is answered as it is.
 */
export const startAgentWorkingCopy = Effect.fn("HostedBlender.startAgentWorkingCopy")(
  function* (input: { readonly threadId: ThreadId; readonly path: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hostedBlender = yield* HostedBlender.HostedBlender;

    const root = yield* threadWorkspaceRoot(input.threadId);
    if (root === undefined)
      return yield* new HostedBlenderToolError({
        reason: "This thread has no workspace to open files from.",
      });
    const realRoot = yield* fileSystem
      .realPath(root)
      .pipe(
        Effect.mapError(
          () => new HostedBlenderToolError({ reason: "This thread's workspace was not found." }),
        ),
      );
    const requested = path.resolve(root, input.path);
    if (!isWithinRoot(path, requested, root) && !isWithinRoot(path, requested, realRoot)) {
      return yield* new HostedBlenderToolError({
        reason: `T3 opens only files in this thread's workspace, ${root}.`,
      });
    }
    if (!requested.toLowerCase().endsWith(".blend")) {
      return yield* new HostedBlenderToolError({
        reason: "Only .blend files can be opened in a hosted Blender.",
      });
    }
    // A copy T3 held since the thread finished goes back where it was, never over a file there.
    const putBack = (copy: string) =>
      hostedBlender.putBackHeld({ threadId: input.threadId, path: copy }).pipe(
        Effect.mapError(
          (error) =>
            new HostedBlenderToolError({
              reason:
                error.reason === "heldCopyInTheWay"
                  ? `T3 held this thread's working copy outside the project since the thread finished, but another file is at ${copy} now, so T3 didn't put the copy back. Ask the user to move that file aside, then call blender_start again.`
                  : error.message,
            }),
        ),
      );
    // Named directly, the working copy is opened as it is: classified and checked as named,
    // before any link is followed, against its master whatever that one's extension casing.
    const copySuffix = `.wip-${threadTag(input.threadId)}.blend`;
    const isCopy = path.basename(requested).endsWith(copySuffix);
    let heldBack: { readonly masterChanged: boolean } | null = null;
    if (isCopy) {
      const folder = yield* fileSystem
        .realPath(path.dirname(requested))
        .pipe(Effect.orElseSucceed(() => path.dirname(requested)));
      heldBack = yield* putBack(path.join(folder, path.basename(requested)));
      if (Option.isNone(yield* fileSystem.lstat(requested).pipe(Effect.option))) {
        return yield* new HostedBlenderToolError({ reason: `${input.path} was not found.` });
      }
      const stem = path.basename(requested).slice(0, -copySuffix.length);
      const siblings = yield* fileSystem
        .readDirectory(path.dirname(requested))
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      yield* assertSeparateCopy(
        requested,
        siblings
          .filter(
            (entry) =>
              entry.startsWith(stem) && entry.slice(stem.length).toLowerCase() === ".blend",
          )
          .map((entry) => path.join(path.dirname(requested), entry)),
        input.path,
      );
    }
    // A symlink inside the workspace must not reach a master outside it.
    const master = yield* fileSystem
      .realPath(requested)
      .pipe(
        Effect.mapError(
          () => new HostedBlenderToolError({ reason: `${input.path} was not found.` }),
        ),
      );
    if (!isWithinRoot(path, master, realRoot)) {
      return yield* new HostedBlenderToolError({
        reason: `T3 opens only files in this thread's workspace, ${root}.`,
      });
    }
    if (isWithinRoot(path, master, path.join(realRoot, HELD_FOLDER))) {
      return yield* new HostedBlenderToolError({
        reason: `${input.path} is a working copy T3 holds for a finished thread, not a project file. Don't open it; the user manages held working copies in Settings › Blender.`,
      });
    }
    const info = yield* fileSystem
      .stat(master)
      .pipe(
        Effect.mapError(
          () => new HostedBlenderToolError({ reason: `${input.path} was not found.` }),
        ),
      );
    if (info.type !== "File")
      return yield* new HostedBlenderToolError({ reason: `${input.path} was not found.` });

    const name = workingCopyName(path.basename(master), input.threadId);
    const workingCopy = isCopy ? master : path.join(path.dirname(master), name);
    if (!isCopy) heldBack = yield* putBack(workingCopy);
    const created = isCopy ? false : yield* createWorkingCopy(master, workingCopy, input.path);
    // Only a copy T3 made is ever held or deleted; one already there may be the person's.
    if (created) {
      yield* hostedBlender.recordWorkingCopy({
        threadId: input.threadId,
        master,
        path: workingCopy,
        relativePath: path.relative(realRoot, workingCopy),
      });
    }
    // Paths under the workspace as configured, as the client matches file links against it.
    const relativePath = path.relative(realRoot, workingCopy);
    const result = {
      workingCopy: path.join(root, relativePath),
      master: path.join(root, path.relative(realRoot, master)),
      created,
      mcpServer: BLENDER_HOSTED_MCP_SERVER,
    };

    const state = Option.getOrUndefined(
      yield* Stream.runHead(hostedBlender.threadState(input.threadId)),
    );
    const running =
      (state?.status === "starting" || state?.status === "running") &&
      state.relativePath === relativePath;
    // The agent's own quit without saving keeps its unsaved work, which only it can get back.
    const waiting = running
      ? undefined
      : (yield* hostedBlender.keptCopies(input.threadId)).find(
          (copy) =>
            copy.recovery &&
            copy.file.kind === "workspace" &&
            copy.file.relativePath === relativePath,
        );
    if (!running) {
      yield* (
        waiting === undefined
          ? hostedBlender.open(
              { threadId: input.threadId, relativePath },
              { agentWorkingCopy: true },
            )
          : // Work a reload kept is older than the file on disk, which the agent gets; the copy
            // waits for the person to restore or discard.
            hostedBlender.reopen(
              { threadId: input.threadId, key: waiting.key, restore: waiting.reloaded !== true },
              { agentWorkingCopy: true },
            )
      ).pipe(
        Effect.mapError(
          (error) =>
            new HostedBlenderToolError({
              reason:
                error.reason === "stillSaving"
                  ? `A Blender from before T3 Code restarted is still saving its last copy of ${name}. Wait a moment, then call blender_start again.`
                  : error.message,
            }),
        ),
      );
    }
    // The copy was made from it, so the pane's Master side can offer it; nothing opens.
    if (!isCopy) {
      yield* hostedBlender
        .knowMaster({ threadId: input.threadId, relativePath: path.relative(realRoot, master) })
        .pipe(Effect.ignore);
    }
    // Answered only once Blender Lab's listener has come up on the thread's port.
    const listener = yield* hostedBlender.agentListener(input.threadId);
    if (listener?.state !== "ready") {
      return yield* new HostedBlenderToolError({ reason: workingAccessHelp(name, listener) });
    }
    const status = Option.getOrUndefined(
      yield* Stream.runHead(hostedBlender.threadState(input.threadId)),
    )?.status;
    return {
      ...result,
      ...(waiting === undefined || waiting.reloaded === true
        ? {}
        : { restoredUnsavedChanges: true }),
      ...(heldBack?.masterChanged === true ? { masterChangedSinceHeld: true } : {}),
      status: status === "running" ? "running" : "starting",
    } satisfies HostedBlenderToolStartResult;
  },
);
