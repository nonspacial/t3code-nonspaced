import type { RuntimeMode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BLENDER_MCP_READ_ONLY_TOOLS,
  claudeHostedBlenderOverrides,
  claudeHostedBlenderToolDecision,
  codexHostedBlenderApprovalsKey,
  codexHostedBlenderConfig,
  hostedBlenderHttpServers,
} from "./hostedBlenderMcp.ts";

const session = {
  endpoint: "http://127.0.0.1:3773/mcp",
  authorizationHeader: "Bearer session-token",
  hostedBlender: {
    command: "/home/user/.local/bin/blender-mcp",
    blenderPath: "/usr/bin/blender",
    masterPort: 41002,
    tmpDir: "/tmp/t3hb-mcp",
  },
};
const otherSession = { ...session, authorizationHeader: "Bearer later-token" };

const policy = (runtimeMode: RuntimeMode, interactionMode: "default" | "plan" = "default") => ({
  runtimeMode,
  interactionMode,
  cwd: "/home/user/acme/app",
});

const ASKING_MODES = ["approval-required", "auto-accept-edits", "auto"] as const;
const readOnlyFor = (server: string) =>
  BLENDER_MCP_READ_ONLY_TOOLS.map((tool) => `mcp__${server}__${tool}`);

describe("hostedBlenderHttpServers", () => {
  it("serves both roles from T3's own MCP endpoint, with the session's credential and no port", () => {
    expect(hostedBlenderHttpServers(session)).toEqual([
      {
        name: "blender-hosted",
        url: "http://127.0.0.1:3773/mcp/blender-hosted",
        authorizationHeader: "Bearer session-token",
      },
      {
        name: "blender-master",
        url: "http://127.0.0.1:3773/mcp/blender-master",
        authorizationHeader: "Bearer session-token",
      },
    ]);
  });

  it("never names the user's own `blender` entry", () => {
    expect(hostedBlenderHttpServers(session).map((server) => server.name)).not.toContain("blender");
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
    const overrides = claudeHostedBlenderOverrides(session, policy("full-access"));
    expect(Object.keys(overrides.mcpServers)).toEqual(["blender-hosted", "blender-master"]);
    expect(overrides.mcpServers["blender-hosted"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:3773/mcp/blender-hosted",
      headers: { Authorization: "Bearer session-token" },
    });
    expect(overrides.allowedTools).toEqual(["mcp__blender-hosted__*", "mcp__blender-master__*"]);
    expect(overrides.disallowedTools).toEqual([]);
  });

  it.each(ASKING_MODES)("pre-approves only read-only tools in %s", (mode) => {
    const overrides = claudeHostedBlenderOverrides(session, policy(mode));
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
      const overrides = claudeHostedBlenderOverrides(session, policy(mode, "plan"));
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
    const overrides = claudeHostedBlenderOverrides(session, {
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
    const config = codexHostedBlenderConfig(session, policy("full-access"));
    expect(config["mcp_servers.blender-hosted"]).toEqual({
      url: "http://127.0.0.1:3773/mcp/blender-hosted",
      http_headers: { Authorization: "Bearer session-token" },
      tool_timeout_sec: 300,
      default_tools_approval_mode: "approve",
    });
    expect(config["mcp_servers.blender-master"]).toMatchObject({
      url: "http://127.0.0.1:3773/mcp/blender-master",
      default_tools_approval_mode: "approve",
    });
    expect(config["mcp_servers.blender-hosted"]).not.toHaveProperty("enabled_tools");
  });

  it.each(ASKING_MODES)("asks before tools that are not read-only in %s", (mode) => {
    const server = codexHostedBlenderConfig(session, policy(mode))["mcp_servers.blender-hosted"];
    expect(server).toMatchObject({ default_tools_approval_mode: "prompt" });
    expect(server).not.toHaveProperty("enabled_tools");
    expect(server).toHaveProperty(["tools", "get_objects_summary", "approval_mode"], "approve");
    expect(server).not.toHaveProperty(["tools", "execute_blender_code"]);
  });

  it.each([...ASKING_MODES, "full-access" as const])(
    "offers only read-only tools in plan mode, even in %s",
    (mode) => {
      const server = codexHostedBlenderConfig(session, policy(mode, "plan"))[
        "mcp_servers.blender-master"
      ];
      expect(server).toMatchObject({ enabled_tools: [...BLENDER_MCP_READ_ONLY_TOOLS] });
      expect(server).not.toHaveProperty("default_tools_approval_mode", "approve");
    },
  );

  it("treats an unknown mode as one that asks", () => {
    const server = codexHostedBlenderConfig(session, undefined)["mcp_servers.blender-hosted"];
    expect(server).toMatchObject({ default_tools_approval_mode: "prompt" });
  });

  it("changes its reload key only when the mode crosses full access or plan", () => {
    const keys = (["approval-required", "auto-accept-edits", "auto", "full-access"] as const).map(
      (mode) => codexHostedBlenderApprovalsKey(session, policy(mode)),
    );
    expect(new Set(keys.slice(0, 3)).size).toBe(1);
    expect(keys[3]).not.toBe(keys[0]);
    expect(codexHostedBlenderApprovalsKey(session, policy("full-access", "plan"))).not.toBe(
      keys[3],
    );
  });

  it("changes its reload key with the session's credential, which the servers carry", () => {
    expect(codexHostedBlenderApprovalsKey(otherSession, policy("auto"))).not.toBe(
      codexHostedBlenderApprovalsKey(session, policy("auto")),
    );
  });
});

describe("Claude decisions for forwarded Blender calls", () => {
  it.each(ASKING_MODES)(
    "asks before a Blender write in %s, even when Claude would allow it",
    (mode) => {
      expect(
        claudeHostedBlenderToolDecision("mcp__blender-hosted__execute_blender_code", policy(mode)),
      ).toBe("ask");
      expect(
        claudeHostedBlenderToolDecision("mcp__blender-master__get_objects_summary", policy(mode)),
      ).toBe("default");
    },
  );

  it("leaves everything to Claude in full access", () => {
    expect(
      claudeHostedBlenderToolDecision(
        "mcp__blender-hosted__execute_blender_code",
        policy("full-access"),
      ),
    ).toBe("default");
  });

  it("refuses every tool off the read-only list in plan mode, including ones added upstream later", () => {
    const plan = policy("full-access", "plan");
    expect(claudeHostedBlenderToolDecision("mcp__blender-hosted__execute_blender_code", plan)).toBe(
      "deny",
    );
    expect(claudeHostedBlenderToolDecision("mcp__blender-hosted__a_new_writer", plan)).toBe("deny");
    expect(claudeHostedBlenderToolDecision("mcp__blender-hosted__get_objects_summary", plan)).toBe(
      "default",
    );
  });

  it("ignores other servers, including the user's own blender entry", () => {
    expect(
      claudeHostedBlenderToolDecision("mcp__blender__execute_blender_code", policy("auto")),
    ).toBe("default");
    expect(claudeHostedBlenderToolDecision("Bash", policy("auto", "plan"))).toBe("default");
  });
});
