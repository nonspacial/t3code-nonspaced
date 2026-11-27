import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import type * as Schema from "effect/Schema";

/**
 * The official Blender Lab MCP twice beside `t3-code`: `blender-hosted` for the thread's working
 * Blender, `blender-master` for its master, both served by T3 (`HostedBlenderMcpProxy.ts`). The
 * user's own `blender` entry, for their desktop Blender, is never touched.
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

type BlenderSession = Pick<
  McpProviderSessionConfig,
  "endpoint" | "authorizationHeader" | "hostedBlender"
>;

export interface HostedBlenderHttpServer {
  readonly name: string;
  readonly url: string;
  readonly authorizationHeader: string;
}

/** The session's own credential picks the thread and its ports; the URL names only the role. */
export function hostedBlenderHttpServers(
  session: BlenderSession,
): ReadonlyArray<HostedBlenderHttpServer> {
  return [BLENDER_HOSTED_MCP_SERVER, BLENDER_MASTER_MCP_SERVER].map((name) => ({
    name,
    url: `${session.endpoint}/${name}`,
    authorizationHeader: session.authorizationHeader,
  }));
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
  session: BlenderSession | undefined,
  policy: ModePolicy,
): {
  readonly mcpServers: Record<
    string,
    {
      readonly type: "http";
      readonly url: string;
      readonly headers: Record<string, string>;
    }
  >;
  readonly allowedTools: ReadonlyArray<string>;
  readonly disallowedTools: ReadonlyArray<string>;
} {
  if (session?.hostedBlender === undefined) {
    return { mcpServers: {}, allowedTools: [], disallowedTools: [] };
  }
  const servers = hostedBlenderHttpServers(session);
  const access = accessFor(policy);
  const named = (tools: ReadonlyArray<string>) =>
    servers.flatMap((server) => tools.map((tool) => `mcp__${server.name}__${tool}`));
  return {
    mcpServers: Object.fromEntries(
      servers.map((server) => [
        server.name,
        {
          type: "http" as const,
          url: server.url,
          headers: { Authorization: server.authorizationHeader },
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
  session: BlenderSession | undefined,
  policy: ModePolicy | undefined,
): Record<string, Schema.Json> {
  if (session?.hostedBlender === undefined) return {};
  const approvals = codexApprovals(accessFor(policy));
  return Object.fromEntries(
    hostedBlenderHttpServers(session).map((server) => [
      `mcp_servers.${server.name}`,
      {
        url: server.url,
        http_headers: { Authorization: server.authorizationHeader },
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
  session: BlenderSession | undefined,
  policy: ModePolicy | undefined,
): string | undefined {
  return session?.hostedBlender === undefined
    ? undefined
    : JSON.stringify(codexHostedBlenderConfig(session, policy));
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
