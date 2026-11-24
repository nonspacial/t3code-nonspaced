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

// The end of the thread id: fixed prefixes such as `thread-` would make every tag alike.
const threadTag = (threadId: string) =>
  threadId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-8);

/** `<master name>.wip-<thread>.blend`, beside the master so its relative links still resolve. */
export const workingCopyName = (masterName: string, threadId: string) =>
  `${masterName.replace(/\.blend$/i, "")}.wip-${threadTag(threadId)}.blend`;

/**
 * A working copy is opened only as a regular file that isn't its master, so neither a symlink nor
 * a hard link to the master opens the master for editing.
 */
const assertSeparateCopy = Effect.fn("HostedBlender.assertSeparateCopy")(function* (
  workingCopy: string,
  master: string,
  requested: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const notSeparate = () =>
    new HostedBlenderToolError({
      reason: `${workingCopy} exists but is not a separate copy of ${requested}. Ask the user to move it aside.`,
    });
  const existing = yield* fileSystem.lstat(workingCopy).pipe(Effect.mapError(notSeparate));
  if (existing.type !== "File") return yield* notSeparate();
  // The master of a working copy named directly may be gone; then there's nothing to be.
  const original = yield* fileSystem.stat(master).pipe(Effect.option);
  if (
    Option.isSome(original) &&
    Option.isSome(existing.ino) &&
    Option.isSome(original.value.ino) &&
    existing.ino.value === original.value.ino.value &&
    existing.dev === original.value.dev
  ) {
    return yield* notSeparate();
  }
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
    yield* assertSeparateCopy(workingCopy, master, requested);
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
  yield* assertSeparateCopy(workingCopy, master, requested);
  return false;
});

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
    // Named directly, the working copy is opened as it is.
    const isCopy = path.basename(master).endsWith(`.wip-${threadTag(input.threadId)}.blend`);
    const workingCopy = isCopy ? master : path.join(path.dirname(master), name);
    if (isCopy) {
      // Checked as named, before any link is followed, against the master it was copied from.
      yield* assertSeparateCopy(
        requested,
        path.join(
          path.dirname(requested),
          path.basename(requested).replace(/\.wip-[a-z0-9]+\.blend$/i, ".blend"),
        ),
        input.path,
      );
    }
    const created = isCopy ? false : yield* createWorkingCopy(master, workingCopy, input.path);
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
    if (!running) {
      yield* hostedBlender
        .open({ threadId: input.threadId, relativePath }, { agentWorkingCopy: true })
        .pipe(Effect.mapError((error) => new HostedBlenderToolError({ reason: error.message })));
    }
    // Answered only once Blender Lab's listener has come up on the thread's port.
    const listener = yield* hostedBlender.agentListener(input.threadId);
    if (listener === "off") {
      return yield* new HostedBlenderToolError({
        reason: `${name} is open in this thread's hosted Blender, but not for you: it was opened from the pane, or before your session could reach it. Call blender_quit with save: true, then blender_start again.`,
      });
    }
    if (listener !== "ready") {
      return yield* new HostedBlenderToolError({
        reason: `${name} is open, but Blender Lab's MCP add-on did not start listening for you. Check that the MCP extension is installed in the user's Blender and that nothing else holds its port, then call blender_quit and blender_start again.`,
      });
    }
    const status = Option.getOrUndefined(
      yield* Stream.runHead(hostedBlender.threadState(input.threadId)),
    )?.status;
    return {
      ...result,
      status: status === "running" ? "running" : "starting",
    } satisfies HostedBlenderToolStartResult;
  },
);
