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
  it.each([
    { name: "mcp__blender-hosted__execute_blender_code", hosted: true },
    { name: "blender-master.get_objects_summary", hosted: true },
    { name: "mcp__blender__execute_blender_code", hosted: false },
    { name: "mcp__t3-code__blender_start", hosted: false },
    { name: null, hosted: false },
  ])(
    "matches the hosted Blender servers as Claude and Codex name them: $name",
    ({ name, hosted }) => {
      expect(isHostedBlenderToolName(name)).toBe(hosted);
    },
  );
});

describe("agentWorkingInBlender", () => {
  it("is on only while one of the running turn's Blender calls is in progress", () => {
    expect(
      agentWorkingInBlender(
        [toolEntry("mcp__blender-hosted__execute_blender_code", "inProgress")],
        run,
      ),
    ).toBe(true);

    const done = toolEntry("blender-hosted.execute_blender_code", "completed");
    expect(agentWorkingInBlender([done], run), "between calls").toBe(false);
    expect(
      agentWorkingInBlender([toolEntry("mcp__blender-hosted__x", "inProgress")], null),
      "outside a turn",
    ).toBe(false);
    expect(agentWorkingInBlender([toolEntry("Bash", "inProgress")], run), "another tool").toBe(
      false,
    );
    expect(
      agentWorkingInBlender(
        [
          toolEntry("mcp__blender-hosted__x", "inProgress", earlier),
          toolEntry("Bash", "completed"),
        ],
        run,
      ),
      "a call an earlier turn left in progress",
    ).toBe(false);
    // Outside a turn, or with Hosted Blender off, the timeline isn't read at all.
    const unread = new Proxy<TimelineEntry[]>([], {
      get: () => {
        throw new Error("scanned");
      },
    });
    expect(agentWorkingInBlender(unread, null)).toBe(false);
  });
});
