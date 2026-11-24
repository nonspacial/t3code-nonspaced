import {
  HostedBlenderToolError,
  HostedBlenderToolQuitInput,
  HostedBlenderToolStartInput,
  HostedBlenderToolStartResult,
  HostedBlenderToolStatusResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as HostedBlender from "../../../hostedBlender/HostedBlender.ts";
import * as HostedBlenderAgents from "../../../hostedBlender/HostedBlenderAgents.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  HostedBlender.HostedBlender,
  HostedBlenderAgents.HostedBlenderAgents,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  FileSystem.FileSystem,
  Path.Path,
];

const HostedBlenderToolFailure = Schema.Union([HostedBlenderToolError, OrchestratorMcpFailure]);

const BlenderStartTool = Tool.make("blender_start", {
  description:
    "Open a working copy of a `.blend` in this thread's hosted Blender, which the user can watch in the Blender pane. Pass the master, the file the user wants changed, as `path` relative to the thread's workspace root or absolute inside it; a name the user gave is usually enough, without searching the disk. T3 copies it to `<name>.wip-<id>.blend` beside it, keeping an earlier copy, and starts Blender on the copy. Edit it with the `blender-hosted` MCP tools. Call again to restart after a crash.",
  parameters: HostedBlenderToolStartInput,
  success: HostedBlenderToolStartResult,
  failure: HostedBlenderToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Start hosted Blender")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutHostedBlender);

const BlenderStatusTool = Tool.make("blender_status", {
  description:
    "List this thread's hosted Blenders: the open file, whether it is starting, running or failed, unsaved changes, and whether `blender-hosted` reaches it.",
  // No `parameters`: an explicit empty struct is not a valid MCP input schema.
  success: HostedBlenderToolStatusResult,
  failure: HostedBlenderToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Hosted Blender status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutHostedBlender);

const BlenderQuitTool = Tool.make("blender_quit", {
  description: "Quit this thread's working Blender. `save: true` saves the working copy first.",
  parameters: HostedBlenderToolQuitInput,
  success: Schema.Record(Schema.String, Schema.Never),
  failure: HostedBlenderToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Quit hosted Blender")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutHostedBlender);

export const HostedBlenderToolkit = Toolkit.make(
  BlenderStartTool,
  BlenderStatusTool,
  BlenderQuitTool,
);
