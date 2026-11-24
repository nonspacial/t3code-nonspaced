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
import * as HostedBlenderAgents from "./HostedBlenderAgents.ts";

// The end of the thread id: fixed prefixes such as `thread-` would make every tag alike.
const threadTag = (threadId: string) =>
  threadId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-8);

/** `<master name>.wip-<thread>.blend`, beside the master so its relative links still resolve. */
export const workingCopyName = (masterName: string, threadId: string) =>
  `${masterName.replace(/\.blend$/i, "")}.wip-${threadTag(threadId)}.blend`;

const refuse = (reason: string) => new HostedBlenderToolError({ reason });

/**
 * `blender_start`: copies the master to the thread's working copy unless one exists, and opens
 * the copy in the thread's working Blender. A copy that is already open is answered as it is.
 */
export const startAgentWorkingCopy = Effect.fn("HostedBlender.startAgentWorkingCopy")(
  function* (input: { readonly threadId: ThreadId; readonly path: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hostedBlender = yield* HostedBlender.HostedBlender;
    const agents = yield* HostedBlenderAgents.HostedBlenderAgents;

    const root = yield* threadWorkspaceRoot(input.threadId);
    if (root === undefined)
      return yield* refuse("This thread has no workspace to open files from.");
    const realRoot = yield* fileSystem
      .realPath(root)
      .pipe(Effect.mapError(() => refuse("This thread's workspace was not found.")));
    const requested = path.resolve(root, input.path);
    if (!isWithinRoot(path, requested, root) && !isWithinRoot(path, requested, realRoot)) {
      return yield* refuse(`T3 opens only files in this thread's workspace, ${root}.`);
    }
    if (!requested.toLowerCase().endsWith(".blend")) {
      return yield* refuse("Only .blend files can be opened in a hosted Blender.");
    }
    // A symlink inside the workspace must not reach a master outside it.
    const master = yield* fileSystem
      .realPath(requested)
      .pipe(Effect.mapError(() => refuse(`${input.path} was not found.`)));
    if (!isWithinRoot(path, master, realRoot)) {
      return yield* refuse(`T3 opens only files in this thread's workspace, ${root}.`);
    }
    const info = yield* fileSystem
      .stat(master)
      .pipe(Effect.mapError(() => refuse(`${input.path} was not found.`)));
    if (info.type !== "File") return yield* refuse(`${input.path} was not found.`);

    const name = workingCopyName(path.basename(master), input.threadId);
    // Named directly, the working copy is opened as it is.
    const isCopy = path.basename(master).endsWith(`.wip-${threadTag(input.threadId)}.blend`);
    const workingCopy = isCopy ? master : path.join(path.dirname(master), name);
    const exists = yield* fileSystem.exists(workingCopy).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      yield* fileSystem
        .copyFile(master, workingCopy)
        .pipe(Effect.mapError(() => refuse(`T3 could not copy ${input.path} to ${workingCopy}.`)));
    }
    const result = {
      workingCopy,
      master,
      created: !exists,
      mcpServer: BLENDER_HOSTED_MCP_SERVER,
    };

    const relativePath = path.relative(realRoot, workingCopy);
    const state = Option.getOrUndefined(
      yield* Stream.runHead(hostedBlender.threadState(input.threadId)),
    );
    if (
      (state?.status === "starting" || state?.status === "running") &&
      state.relativePath === relativePath
    ) {
      if (!(yield* agents.listening(input.threadId))) {
        return yield* refuse(
          `${name} is open in this thread's hosted Blender, but it started before your session could reach it. Call blender_quit with save: true, then blender_start again.`,
        );
      }
      return { ...result, status: state.status } satisfies HostedBlenderToolStartResult;
    }
    yield* hostedBlender
      .open({ threadId: input.threadId, relativePath })
      .pipe(Effect.mapError((error) => refuse(error.message)));
    return { ...result, status: "starting" } satisfies HostedBlenderToolStartResult;
  },
);
