import {
  HostedBlenderToolError,
  type HostedBlenderToolStatusResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { startAgentWorkingCopy } from "../../../hostedBlender/agentWorkingCopy.ts";
import * as HostedBlender from "../../../hostedBlender/HostedBlender.ts";
import * as HostedBlenderAgents from "../../../hostedBlender/HostedBlenderAgents.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import { isWithinRoot } from "../../../workspace/KnownWorkspaces.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HostedBlenderToolkit } from "./tools.ts";

// The session's capability is fixed when it starts; the switch is read on every call.
const requireHostedBlender = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("hosted-blender").pipe(
    Effect.mapError(
      () =>
        new HostedBlenderToolError({
          reason:
            'Hosted Blender is not available to this agent. T3 adds it to Claude and Codex threads while Hosted Blender and "Allow agents to start hosted Blenders" are on in Settings → Blender; other providers are not supported yet. It applies when the agent session next starts.',
        }),
    ),
  );
  const agents = yield* HostedBlenderAgents.HostedBlenderAgents;
  if (!(yield* agents.agentsAllowed)) {
    return yield* new HostedBlenderToolError({
      reason:
        'The user switched off "Allow agents to start hosted Blenders" in Settings → Blender.',
    });
  }
  return scope.thread.threadId;
});

const underConfiguredRoot = Effect.fnUntraced(function* (file: string, root: string | undefined) {
  if (root === undefined) return file;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
  return isWithinRoot(path, file, realRoot) ? path.join(root, path.relative(realRoot, file)) : file;
});

// Plan mode is read-only: it may look at Blender, never start or quit it.
const refuseInPlanMode = Effect.fnUntraced(function* (threadId: ThreadId, tool: string) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // A mode that can't be read counts as Plan: refusing is the safe answer.
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
  if (shell === null) {
    return yield* new HostedBlenderToolError({
      reason: `${tool} needs this thread's mode, which T3 could not read. Try again.`,
    });
  }
  if (shell.interactionMode === "plan") {
    return yield* new HostedBlenderToolError({
      reason: `${tool} changes this thread's hosted Blender, and Plan mode is read-only. blender_status still works; ask the user to leave Plan mode first.`,
    });
  }
});

const handlers = {
  blender_start: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* requireHostedBlender;
      yield* refuseInPlanMode(threadId, "blender_start");
      return yield* startAgentWorkingCopy({ threadId, path: input.path });
    }),
  ),
  blender_status: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const threadId = yield* requireHostedBlender;
      const hostedBlender = yield* HostedBlender.HostedBlender;
      const path = yield* Path.Path;
      const state = Option.getOrUndefined(
        yield* Stream.runHead(hostedBlender.threadState(threadId)),
      );
      if (state?.status === "failed") {
        return { blenders: [{ role: "working", status: "failed" }] };
      }
      const root = yield* threadWorkspaceRoot(threadId);
      if (state?.status === "closed" || state?.status === "crashed") {
        return {
          blenders: [
            {
              role: "working",
              status: state.status,
              file: root === undefined ? state.relativePath : path.join(root, state.relativePath),
              recovery: state.recovery,
            },
          ],
        } satisfies HostedBlenderToolStatusResult;
      }
      if (state?.status !== "starting" && state?.status !== "running") return { blenders: [] };
      const listener = yield* hostedBlender.agentListener(threadId, { wait: false });
      const reported = listener?.openFile;
      // The file Blender has open now, which may no longer be the one it started with, under
      // the workspace as configured, as chat links are matched against it. None if untitled.
      const file =
        reported === null
          ? undefined
          : reported === undefined
            ? root === undefined
              ? state.relativePath
              : path.join(root, state.relativePath)
            : yield* underConfiguredRoot(reported, root);
      return {
        blenders: [
          {
            role: "working",
            status: state.status,
            ...(file === undefined ? {} : { file }),
            unsavedChanges: state.dirty,
            // Only a listener that came up on the thread's port takes `blender-hosted` calls.
            agentAccess: listener?.state === "ready",
            ...(listener?.ended == null ? {} : { agentAccessEnded: listener.ended }),
          },
        ],
      } satisfies HostedBlenderToolStatusResult;
    }),
  ),
  blender_quit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* requireHostedBlender;
      yield* refuseInPlanMode(threadId, "blender_quit");
      const hostedBlender = yield* HostedBlender.HostedBlender;
      yield* hostedBlender
        .quit({ threadId, save: input.save })
        .pipe(Effect.mapError((error) => new HostedBlenderToolError({ reason: error.message })));
      return {};
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof HostedBlenderToolkit.tools>;

export const layer = McpToolAccess.toLayer(HostedBlenderToolkit, handlers);
