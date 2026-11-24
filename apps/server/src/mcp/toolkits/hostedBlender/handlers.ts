import {
  HostedBlenderToolError,
  type HostedBlenderToolStatusResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { startAgentWorkingCopy } from "../../../hostedBlender/agentWorkingCopy.ts";
import * as HostedBlender from "../../../hostedBlender/HostedBlender.ts";
import * as HostedBlenderAgents from "../../../hostedBlender/HostedBlenderAgents.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
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

// Plan mode is read-only: it may look at Blender, never start or quit it.
const refuseInPlanMode = Effect.fnUntraced(function* (threadId: ThreadId, tool: string) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
  if (shell?.interactionMode === "plan") {
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
      if (state?.status !== "starting" && state?.status !== "running") return { blenders: [] };
      const root = yield* threadWorkspaceRoot(threadId);
      return {
        blenders: [
          {
            role: "working",
            status: state.status,
            file: root === undefined ? state.relativePath : path.join(root, state.relativePath),
            unsavedChanges: state.dirty,
            // Only a listener that came up on the thread's port takes `blender-hosted` calls.
            agentAccess:
              (yield* hostedBlender.agentListener(threadId, { wait: false })) === "ready",
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
