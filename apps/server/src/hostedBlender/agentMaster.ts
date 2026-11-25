import {
  HostedBlenderToolError,
  type HostedBlenderToolMasterOpenResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { threadWorkspaceRoot } from "../project/threadWorkspaceRoot.ts";
import { BLENDER_MASTER_MCP_SERVER } from "../provider/hostedBlenderMcp.ts";
import { untestedBlenderLabReason } from "./agentGuard.ts";
import { threadTag } from "./agentWorkingCopy.ts";
import * as HostedBlender from "./HostedBlender.ts";

/** The user's own MCP entry for their desktop Blender, which T3 never changes. */
const DESKTOP_MCP_SERVER = "blender";

/** A master this thread can't reach: a session joins it through `blender_master_open`. */
export const masterAccessHelp = (
  name: string,
  listener: HostedBlender.AgentListenerReport | null,
): string =>
  listener?.state === "untested"
    ? untestedBlenderLabReason(
        name,
        listener.mcpVersion,
        "Then ask the user to quit the master Blender from the Blender pane's Master view, and call blender_master_open again.",
      )
    : `Call blender_master_open with ${name} to reach the master Blender from this session. If that says your access ended, ask the user to quit the master Blender from the Blender pane's Master view, then call blender_master_open again.`;

/**
 * `blender_master_open`: names the master the agent copies back into and says which Blender has
 * it: the user's desktop Blender, or the master Blender this thread shares, started if needed.
 */
export const openAgentMaster = Effect.fn("HostedBlender.openAgentMaster")(function* (input: {
  readonly threadId: ThreadId;
  readonly path: string;
  /** The provider session asking; its access to the master ends with it. */
  readonly agentSession: string;
}) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const hostedBlender = yield* HostedBlender.HostedBlender;
  const root = yield* threadWorkspaceRoot(input.threadId);
  if (root === undefined) {
    return yield* new HostedBlenderToolError({
      reason: "This thread has no workspace to open files from.",
    });
  }
  const requested = path.resolve(root, input.path);
  // Checked on the file a link leads to as well, so no link can pass the copy off as a master.
  const resolved = yield* fileSystem
    .realPath(requested)
    .pipe(Effect.orElseSucceed(() => requested));
  const copySuffix = `.wip-${threadTag(input.threadId)}.blend`;
  if ([requested, resolved].some((file) => path.basename(file).endsWith(copySuffix))) {
    return yield* new HostedBlenderToolError({
      reason: `${input.path} is your working copy. Pass the master it was copied from.`,
    });
  }
  // The hosted Blender checks the workspace, the extension and links out of it.
  const relativePath = path.relative(root, requested);
  const opened = yield* hostedBlender
    .openMaster({ threadId: input.threadId, relativePath }, { agentSession: input.agentSession })
    .pipe(Effect.mapError((error) => new HostedBlenderToolError({ reason: error.message })));
  const master = path.join(root, relativePath);
  if (opened._tag === "desktop") {
    return {
      master,
      status: "desktop",
      mcpServer: DESKTOP_MCP_SERVER,
    } satisfies HostedBlenderToolMasterOpenResult;
  }
  const name = path.basename(master);
  const listener = yield* hostedBlender.agentListener(input.threadId, { role: "master" });
  if (listener?.state === "off") {
    return yield* new HostedBlenderToolError({
      reason: `The master Blender with ${name} doesn't take your calls: your access ended or agents were off when it started. Ask the user to quit it from the Blender pane's Master view, then call blender_master_open again.`,
    });
  }
  if (listener?.state === "untested") {
    return yield* new HostedBlenderToolError({
      reason: untestedBlenderLabReason(
        name,
        listener.mcpVersion,
        "Then ask the user to quit the master Blender from the Blender pane's Master view, and call blender_master_open again.",
      ),
    });
  }
  if (listener?.state !== "ready") {
    return yield* new HostedBlenderToolError({
      reason: `${name} is open in a master Blender, but Blender Lab's MCP add-on did not start listening for you. Check that the MCP extension is installed in the user's Blender, then ask the user to quit the master Blender and call blender_master_open again.`,
    });
  }
  const state = Option.getOrUndefined(
    yield* Stream.runHead(hostedBlender.masterState(input.threadId)),
  );
  return {
    master,
    status: state?.status === "running" ? "running" : "starting",
    mcpServer: BLENDER_MASTER_MCP_SERVER,
    ...(opened.desktopUnchecked ? { desktopUnchecked: true } : {}),
  } satisfies HostedBlenderToolMasterOpenResult;
});
