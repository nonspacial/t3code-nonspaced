import type { HostedBlenderMcpLaunch } from "@t3tools/provider-core/server/mcpSession";
import type * as Schema from "effect/Schema";

/**
 * Each thread's session gets the official Blender Lab MCP twice beside `t3-code`, the way
 * upstream attaches agentcast: `blender-hosted` for its working Blender and `blender-master` for
 * its master Blender. The user's own `blender` entry, for their desktop Blender, is never touched.
 */
export const BLENDER_HOSTED_MCP_SERVER = "blender-hosted";
export const BLENDER_MASTER_MCP_SERVER = "blender-master";

/** Scene summaries, screenshots and doc search: the tools pre-approved outside full access. */
export const BLENDER_MCP_READ_ONLY_TOOLS = [
  "get_blendfile_summary_datablocks",
  "get_blendfile_summary_missing_files",
  "get_blendfile_summary_of_linked_libraries",
  "get_blendfile_summary_path_info",
  "get_blendfile_summary_usage_guess",
  "get_object_detail_summary",
  "get_objects_summary",
  "get_python_api_docs",
  "get_screenshot_of_area_as_image",
  "get_screenshot_of_window_as_image",
  "get_screenshot_of_window_as_json",
  "search_api_docs",
  "search_manual_docs",
] as const;

/**
 * The official server's other tools, refused in plan mode where Claude has no per-server
 * allowlist. Codex lists `enabled_tools` instead, so a tool added upstream stays off there.
 */
const BLENDER_MCP_WRITE_TOOLS = [
  "execute_blender_code",
  "execute_blender_code_for_cli",
  "get_blendfile_summary_datablocks_for_cli",
  "get_blendfile_summary_missing_files_for_cli",
  "get_blendfile_summary_of_linked_libraries_for_cli",
  "get_blendfile_summary_path_info_for_cli",
  "get_blendfile_summary_usage_guess_for_cli",
  "jump_to_tab_by_name",
  "jump_to_tab_by_space_type",
  "jump_to_view3d_object_by_name",
  "jump_to_view3d_object_data_by_name",
  "render_thumbnail_to_path",
  "render_viewport_to_path",
] as const;

// Code and renders can take a while in a big scene.
const CODEX_BLENDER_TOOL_TIMEOUT_SEC = 300;

export interface HostedBlenderStdioServer {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export function hostedBlenderStdioServers(
  launch: HostedBlenderMcpLaunch,
): ReadonlyArray<HostedBlenderStdioServer> {
  const server = (name: string, port: number): HostedBlenderStdioServer => ({
    name,
    command: launch.command,
    args: [],
    env: {
      BLENDER_MCP_PORT: String(port),
      BLENDER_PATH: launch.blenderPath,
      TMPDIR: launch.tmpDir,
    },
  });
  return [
    server(BLENDER_HOSTED_MCP_SERVER, launch.hostedPort),
    server(BLENDER_MASTER_MCP_SERVER, launch.masterPort),
  ];
}

interface ModePolicy {
  readonly runtimeMode: string;
  readonly interactionMode?: string;
  readonly sandboxPolicy?: unknown;
}

/**
 * `all`: full access pre-approves everything. `readOnly`: plan mode, or a read-only sandbox,
 * offers read-only tools alone. `ask`: every other mode pre-approves read-only tools and leaves
 * the rest to the provider's own approval.
 */
type BlenderToolAccess = "all" | "ask" | "readOnly";

const accessFor = (policy: ModePolicy | undefined): BlenderToolAccess => {
  const sandbox = policy?.sandboxPolicy;
  const readOnlySandbox =
    typeof sandbox === "object" &&
    sandbox !== null &&
    "type" in sandbox &&
    sandbox.type === "readOnly";
  if (policy?.interactionMode === "plan" || readOnlySandbox) return "readOnly";
  return policy?.runtimeMode === "full-access" ? "all" : "ask";
};

export function claudeHostedBlenderOverrides(
  launch: HostedBlenderMcpLaunch | undefined,
  policy: ModePolicy,
): {
  readonly mcpServers: Record<
    string,
    {
      readonly type: "stdio";
      readonly command: string;
      readonly args: Array<string>;
      readonly env: Record<string, string>;
    }
  >;
  readonly allowedTools: ReadonlyArray<string>;
  readonly disallowedTools: ReadonlyArray<string>;
} {
  if (launch === undefined) return { mcpServers: {}, allowedTools: [], disallowedTools: [] };
  const servers = hostedBlenderStdioServers(launch);
  const access = accessFor(policy);
  const named = (tools: ReadonlyArray<string>) =>
    servers.flatMap((server) => tools.map((tool) => `mcp__${server.name}__${tool}`));
  return {
    mcpServers: Object.fromEntries(
      servers.map((server) => [
        server.name,
        {
          type: "stdio" as const,
          command: server.command,
          args: [...server.args],
          env: { ...server.env },
        },
      ]),
    ),
    allowedTools:
      access === "all"
        ? servers.map((server) => `mcp__${server.name}__*`)
        : named(BLENDER_MCP_READ_ONLY_TOOLS),
    disallowedTools: access === "readOnly" ? named(BLENDER_MCP_WRITE_TOOLS) : [],
  };
}

const codexApprovals = (access: BlenderToolAccess): Record<string, Schema.Json> => {
  if (access === "all") return { default_tools_approval_mode: "approve" };
  const readOnly = Object.fromEntries(
    BLENDER_MCP_READ_ONLY_TOOLS.map((tool) => [tool, { approval_mode: "approve" }]),
  );
  // Codex runs a "prompt" tool unasked under `on-request`, so plan mode lists only read-only ones.
  return access === "readOnly"
    ? {
        enabled_tools: [...BLENDER_MCP_READ_ONLY_TOOLS],
        default_tools_approval_mode: "prompt",
        tools: readOnly,
      }
    : { default_tools_approval_mode: "prompt", tools: readOnly };
};

export function codexHostedBlenderConfig(
  launch: HostedBlenderMcpLaunch | undefined,
  policy: ModePolicy | undefined,
): Record<string, Schema.Json> {
  if (launch === undefined) return {};
  const approvals = codexApprovals(accessFor(policy));
  return Object.fromEntries(
    hostedBlenderStdioServers(launch).map((server) => [
      `mcp_servers.${server.name}`,
      {
        command: server.command,
        args: [...server.args],
        env: { ...server.env },
        tool_timeout_sec: CODEX_BLENDER_TOOL_TIMEOUT_SEC,
        ...approvals,
      },
    ]),
  );
}

/**
 * What a Codex thread loads its Blender servers with, or undefined without them. Codex reads MCP
 * config only when it loads a thread, so a turn whose key differs must load the thread again.
 */
export function codexHostedBlenderApprovalsKey(
  launch: HostedBlenderMcpLaunch | undefined,
  policy: ModePolicy | undefined,
): string | undefined {
  return launch === undefined
    ? undefined
    : JSON.stringify(codexHostedBlenderConfig(launch, policy));
}

const HOSTED_BLENDER_SERVERS: ReadonlySet<string> = new Set([
  BLENDER_HOSTED_MCP_SERVER,
  BLENDER_MASTER_MCP_SERVER,
]);
const READ_ONLY: ReadonlySet<string> = new Set(BLENDER_MCP_READ_ONLY_TOOLS);

/**
 * What T3 decides when Claude forwards a Blender call for a permission decision. `ask`: outside
 * full access a tool off the read-only list goes through the approval flow, even in a mode where
 * Claude would otherwise be allowed through. `deny`: plan mode refuses everything off that list,
 * so a tool Blender Lab adds later is refused too. `default`: T3's usual handling.
 */
export function claudeHostedBlenderToolDecision(
  toolName: string,
  policy: ModePolicy,
): "default" | "ask" | "deny" {
  const match = /^mcp__([^_]+(?:-[^_]+)*)__(.+)$/.exec(toolName);
  if (match === null || !HOSTED_BLENDER_SERVERS.has(match[1]!)) return "default";
  if (READ_ONLY.has(match[2]!)) return "default";
  const access = accessFor(policy);
  return access === "all" ? "default" : access === "readOnly" ? "deny" : "ask";
}
