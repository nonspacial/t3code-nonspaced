import type { RuntimeMode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BLENDER_MCP_READ_ONLY_TOOLS,
  claudeHostedBlenderOverrides,
  codexHostedBlenderApprovalsKey,
  codexHostedBlenderConfig,
  hostedBlenderStdioServers,
} from "./hostedBlenderMcp.ts";

const launch = {
  command: "/home/user/.local/bin/blender-mcp",
  blenderPath: "/usr/bin/blender",
  hostedPort: 41001,
  masterPort: 41002,
  tmpDir: "/tmp/t3hb-mcp",
};

const policy = (runtimeMode: RuntimeMode, interactionMode: "default" | "plan" = "default") => ({
  runtimeMode,
  interactionMode,
  cwd: "/home/user/acme/app",
});

const ASKING_MODES = ["approval-required", "auto-accept-edits", "auto"] as const;
const readOnlyFor = (server: string) =>
  BLENDER_MCP_READ_ONLY_TOOLS.map((tool) => `mcp__${server}__${tool}`);

describe("hostedBlenderStdioServers", () => {
  it("runs the official blender-mcp once per role, each on the thread's own port", () => {
    expect(hostedBlenderStdioServers(launch)).toEqual([
      {
        name: "blender-hosted",
        command: launch.command,
        args: [],
        env: { BLENDER_MCP_PORT: "41001", BLENDER_PATH: "/usr/bin/blender", TMPDIR: launch.tmpDir },
      },
      {
        name: "blender-master",
        command: launch.command,
        args: [],
        env: { BLENDER_MCP_PORT: "41002", BLENDER_PATH: "/usr/bin/blender", TMPDIR: launch.tmpDir },
      },
    ]);
  });

  it("never names the user's own `blender` entry", () => {
    expect(hostedBlenderStdioServers(launch).map((server) => server.name)).not.toContain("blender");
  });
});

describe("Claude approvals", () => {
  it("adds nothing without a launch", () => {
    expect(claudeHostedBlenderOverrides(undefined, policy("full-access"))).toEqual({
      mcpServers: {},
      allowedTools: [],
      disallowedTools: [],
    });
  });

  it("pre-approves every Blender tool in full access", () => {
    const overrides = claudeHostedBlenderOverrides(launch, policy("full-access"));
    expect(Object.keys(overrides.mcpServers)).toEqual(["blender-hosted", "blender-master"]);
    expect(overrides.mcpServers["blender-hosted"]).toMatchObject({
      type: "stdio",
      command: launch.command,
      env: { BLENDER_MCP_PORT: "41001" },
    });
    expect(overrides.allowedTools).toEqual(["mcp__blender-hosted__*", "mcp__blender-master__*"]);
    expect(overrides.disallowedTools).toEqual([]);
  });

  it.each(ASKING_MODES)("pre-approves only read-only tools in %s", (mode) => {
    const overrides = claudeHostedBlenderOverrides(launch, policy(mode));
    expect(overrides.allowedTools).toEqual([
      ...readOnlyFor("blender-hosted"),
      ...readOnlyFor("blender-master"),
    ]);
    expect(overrides.allowedTools).not.toContain("mcp__blender-hosted__execute_blender_code");
    expect(overrides.disallowedTools).toEqual([]);
  });

  it.each([...ASKING_MODES, "full-access" as const])(
    "offers only read-only tools in plan mode, even in %s",
    (mode) => {
      const overrides = claudeHostedBlenderOverrides(launch, policy(mode, "plan"));
      expect(overrides.allowedTools).toEqual([
        ...readOnlyFor("blender-hosted"),
        ...readOnlyFor("blender-master"),
      ]);
      expect(overrides.disallowedTools).toContain("mcp__blender-hosted__execute_blender_code");
      expect(overrides.disallowedTools).toContain("mcp__blender-master__execute_blender_code");
      expect(overrides.disallowedTools.some((tool) => tool.endsWith("get_objects_summary"))).toBe(
        false,
      );
    },
  );

  it("treats a read-only sandbox like plan mode", () => {
    const overrides = claudeHostedBlenderOverrides(launch, {
      ...policy("full-access"),
      sandboxPolicy: { type: "readOnly" },
    });
    expect(overrides.allowedTools).not.toContain("mcp__blender-hosted__*");
    expect(overrides.disallowedTools).toContain("mcp__blender-hosted__execute_blender_code");
  });
});

describe("Codex approvals", () => {
  it("adds nothing without a launch", () => {
    expect(codexHostedBlenderConfig(undefined, policy("full-access"))).toEqual({});
    expect(codexHostedBlenderApprovalsKey(undefined, policy("full-access"))).toBeUndefined();
  });

  it("approves every Blender tool in full access", () => {
    const config = codexHostedBlenderConfig(launch, policy("full-access"));
    expect(config["mcp_servers.blender-hosted"]).toMatchObject({
      command: launch.command,
      args: [],
      env: { BLENDER_MCP_PORT: "41001", BLENDER_PATH: "/usr/bin/blender" },
      default_tools_approval_mode: "approve",
    });
    expect(config["mcp_servers.blender-master"]).toMatchObject({
      env: { BLENDER_MCP_PORT: "41002" },
      default_tools_approval_mode: "approve",
    });
    expect(config["mcp_servers.blender-hosted"]).not.toHaveProperty("enabled_tools");
  });

  it.each(ASKING_MODES)("asks before tools that are not read-only in %s", (mode) => {
    const server = codexHostedBlenderConfig(launch, policy(mode))["mcp_servers.blender-hosted"];
    expect(server).toMatchObject({ default_tools_approval_mode: "prompt" });
    expect(server).not.toHaveProperty("enabled_tools");
    expect(server).toHaveProperty(["tools", "get_objects_summary", "approval_mode"], "approve");
    expect(server).not.toHaveProperty(["tools", "execute_blender_code"]);
  });

  it.each([...ASKING_MODES, "full-access" as const])(
    "offers only read-only tools in plan mode, even in %s",
    (mode) => {
      const server = codexHostedBlenderConfig(launch, policy(mode, "plan"))[
        "mcp_servers.blender-master"
      ];
      expect(server).toMatchObject({ enabled_tools: [...BLENDER_MCP_READ_ONLY_TOOLS] });
      expect(server).not.toHaveProperty("default_tools_approval_mode", "approve");
    },
  );

  it("treats an unknown mode as one that asks", () => {
    const server = codexHostedBlenderConfig(launch, undefined)["mcp_servers.blender-hosted"];
    expect(server).toMatchObject({ default_tools_approval_mode: "prompt" });
  });

  it("changes its reload key only when the mode crosses full access or plan", () => {
    const keys = (["approval-required", "auto-accept-edits", "auto", "full-access"] as const).map(
      (mode) => codexHostedBlenderApprovalsKey(launch, policy(mode)),
    );
    expect(new Set(keys.slice(0, 3)).size).toBe(1);
    expect(keys[3]).not.toBe(keys[0]);
    expect(codexHostedBlenderApprovalsKey(launch, policy("full-access", "plan"))).not.toBe(keys[3]);
  });
});
