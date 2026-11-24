import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogToolLifecycleStatus } from "../../session-logic";
import { agentWorkingInBlender, isHostedBlenderToolName } from "./workingInBlender";

const run = RunId.make("run-blender");
const earlier = RunId.make("run-earlier");

const toolEntry = (
  toolName: string,
  status: WorkLogToolLifecycleStatus,
  runId = run,
): TimelineEntry => ({
  id: `entry-${toolName}-${status}-${runId}`,
  kind: "work",
  createdAt: "2026-11-24T00:00:00Z",
  entry: {
    id: `work-${toolName}`,
    createdAt: "2026-11-24T00:00:00Z",
    runId,
    label: toolName,
    tone: "tool",
    toolLifecycleStatus: status,
    structuredPayload: {
      type: "dynamic_tool",
      toolName,
      input: {},
    } as never,
  },
});

describe("isHostedBlenderToolName", () => {
  it("matches the hosted Blender servers as Claude and Codex name them", () => {
    expect(isHostedBlenderToolName("mcp__blender-hosted__execute_blender_code")).toBe(true);
    expect(isHostedBlenderToolName("blender-master.get_objects_summary")).toBe(true);
  });

  it("leaves the user's own blender entry and T3's lifecycle tools alone", () => {
    expect(isHostedBlenderToolName("mcp__blender__execute_blender_code")).toBe(false);
    expect(isHostedBlenderToolName("mcp__t3-code__blender_start")).toBe(false);
    expect(isHostedBlenderToolName(null)).toBe(false);
  });
});

describe("agentWorkingInBlender", () => {
  it("is on while one of the running turn's Blender calls is in progress", () => {
    expect(
      agentWorkingInBlender(
        [toolEntry("mcp__blender-hosted__execute_blender_code", "inProgress")],
        run,
      ),
    ).toBe(true);
  });

  it("is off between calls, outside a turn, and for other tools", () => {
    const done = toolEntry("blender-hosted.execute_blender_code", "completed");
    expect(agentWorkingInBlender([done], run)).toBe(false);
    expect(agentWorkingInBlender([toolEntry("mcp__blender-hosted__x", "inProgress")], null)).toBe(
      false,
    );
    expect(agentWorkingInBlender([toolEntry("Bash", "inProgress")], run)).toBe(false);
  });

  it("ignores a call an earlier turn left in progress", () => {
    expect(
      agentWorkingInBlender(
        [
          toolEntry("mcp__blender-hosted__x", "inProgress", earlier),
          toolEntry("Bash", "completed"),
        ],
        run,
      ),
    ).toBe(false);
  });
});
