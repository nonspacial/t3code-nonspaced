import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type HostedBlenderQuitInput,
  type HostedBlenderThreadState,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as HostedBlender from "../hostedBlender/HostedBlender.ts";
import * as HostedBlenderAgents from "../hostedBlender/HostedBlenderAgents.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment-hosted-blender-test");
const threadId = ThreadId.make("thread-hosted-blender-test");
const workspace = "/home/user/acme/app";

const threadCaller = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-hosted-blender-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-hosted-blender-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
// An MCP client signed in from outside T3, with every capability a thread could hold.
const outsideClient: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "outside-client",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Desktop", access: "full-access" },
  capabilities: new Set(["orchestration", "hosted-blender"]),
  issuedAt: 1,
};
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const layerFor = (input: {
  readonly state: HostedBlenderThreadState;
  readonly allowed?: boolean;
  readonly quits?: Array<HostedBlenderQuitInput>;
}) =>
  McpHttpServer.layerHostedBlenderToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(HostedBlender.HostedBlender)({
          threadState: () => Stream.succeed(input.state),
          quit: (quit) =>
            Effect.sync(() => {
              input.quits?.push(quit);
            }),
        }),
        Layer.mock(HostedBlenderAgents.HostedBlenderAgents)({
          agentsAllowed: Effect.succeed(input.allowed ?? true),
          listening: () => Effect.succeed(true),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed({
              ...McpToolAccessTestkit.liveThreadShell(id),
              worktreePath: workspace,
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const call = (
  name: string,
  args: Record<string, unknown>,
  scope: McpInvocationContext.McpInvocationScope,
) =>
  Effect.flatMap(McpServer.McpServer, (server) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      ),
  );

const running: HostedBlenderThreadState = {
  status: "running",
  relativePath: "models/hero.wip-41cbc0de.blend",
  dirty: true,
};

describe("hosted Blender MCP tools", () => {
  it.effect("registers blender_start, blender_status and blender_quit", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
        "blender_quit",
        "blender_start",
        "blender_status",
      ]);
    }).pipe(Effect.provide(layerFor({ state: running }))),
  );

  it.effect("reports the thread's working Blender", () =>
    Effect.gen(function* () {
      const status = yield* call("blender_status", {}, threadCaller(["hosted-blender"]));
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toEqual({
        blenders: [
          {
            role: "working",
            status: "running",
            file: `${workspace}/models/hero.wip-41cbc0de.blend`,
            unsavedChanges: true,
            agentAccess: true,
          },
        ],
      });
    }).pipe(Effect.provide(layerFor({ state: running }))),
  );

  it.effect("quits the working Blender, saving first when asked", () => {
    const quits: Array<HostedBlenderQuitInput> = [];
    return Effect.gen(function* () {
      const quit = yield* call("blender_quit", { save: true }, threadCaller(["hosted-blender"]));
      expect(quit.isError).toBe(false);
      expect(quits).toEqual([{ threadId, save: true }]);
    }).pipe(Effect.provide(layerFor({ state: running, quits })));
  });

  it.effect.each(["blender_start", "blender_status", "blender_quit"])(
    "refuses %s to an MCP client from outside a thread, and to a thread without the MCP",
    (name) => {
      const quits: Array<HostedBlenderQuitInput> = [];
      const args =
        name === "blender_start"
          ? { path: "hero.blend" }
          : name === "blender_quit"
            ? { save: false }
            : {};
      return Effect.gen(function* () {
        for (const scope of [outsideClient, threadCaller(["orchestration"])]) {
          const refused = yield* Effect.flip(call(name, args, scope));
          expect(refused.message).toContain("not found");
        }
        expect(quits).toEqual([]);
      }).pipe(Effect.provide(layerFor({ state: running, quits })));
    },
  );

  it.effect("hides the tools from outside clients and threads without the hosted Blender MCP", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      // EnabledWhen reads the caller from the fiber, as it does for each /mcp request.
      const visibleTo = (scope: McpInvocationContext.McpInvocationScope) =>
        Effect.sync(() =>
          server.tools
            .filter(({ annotations }) => {
              const enabledWhen = Context.getOrUndefined(annotations, McpSchema.EnabledWhen);
              return enabledWhen?.({ protocolVersion: "", capabilities: {} }) ?? true;
            })
            .map(({ tool }) => tool.name),
        ).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope));
      expect(yield* visibleTo(threadCaller(["hosted-blender"]))).toHaveLength(3);
      expect(yield* visibleTo(threadCaller(["orchestration"]))).toEqual([]);
      expect(yield* visibleTo(outsideClient)).toEqual([]);
    }).pipe(Effect.provide(layerFor({ state: running }))),
  );

  it.effect("stops once the user switches agents off", () =>
    Effect.gen(function* () {
      const result = yield* call("blender_status", {}, threadCaller(["hosted-blender"]));
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("switched off");
    }).pipe(Effect.provide(layerFor({ state: running, allowed: false }))),
  );
});
