// @effect-diagnostics nodeBuiltinImport:off - fixtures make a symlinked workspace root.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type HostedBlenderMasterState,
  type HostedBlenderOpenInput,
  type HostedBlenderQuitInput,
  type HostedBlenderKeptCopy,
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
  readonly plan?: boolean;
  /** Shell reads after the first in each call, which the live-caller check makes, return null. */
  readonly shellReads?: { count: number };
  readonly listener?: HostedBlender.AgentListenerState;
  readonly ended?: HostedBlender.AgentAccessEnded;
  readonly openFile?: string | null;
  readonly workspace?: string;
  /** The thread's kept copies; by default those of a closed or crashed `state`. */
  readonly copies?: ReadonlyArray<HostedBlenderKeptCopy>;
  readonly master?: HostedBlenderMasterState;
  readonly opened?:
    | { readonly _tag: "desktop" }
    | { readonly _tag: "hosted"; readonly desktopUnchecked: boolean };
  readonly opens?: Array<readonly [HostedBlenderOpenInput, unknown]>;
}) =>
  McpHttpServer.layerHostedBlenderToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(HostedBlender.HostedBlender)({
          threadState: () => Stream.succeed(input.state),
          keptCopies: () =>
            Effect.succeed(input.copies ?? ("copies" in input.state ? input.state.copies : [])),
          masterState: () => Stream.succeed(input.master ?? { status: "none" }),
          openMaster: (open, options) =>
            Effect.sync(() => {
              input.opens?.push([open, options]);
              return input.opened ?? { _tag: "hosted", desktopUnchecked: false };
            }),
          agentListener: () =>
            Effect.succeed({
              state: input.listener ?? "ready",
              ended: input.ended ?? null,
              openFile: input.openFile,
              mcpVersion: "1.0.3",
            }),
          quit: (quit) =>
            Effect.sync(() => {
              input.quits?.push(quit);
            }),
        }),
        Layer.mock(HostedBlenderAgents.HostedBlenderAgents)({
          agentsAllowed: Effect.succeed(input.allowed ?? true),
          revocations: Stream.never,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            input.shellReads !== undefined && ++input.shellReads.count > 1
              ? Effect.succeed(null)
              : Effect.succeed({
                  ...McpToolAccessTestkit.liveThreadShell(
                    id,
                    input.plan === true ? { interactionMode: "plan" } : {},
                  ),
                  worktreePath: input.workspace ?? workspace,
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
  it.effect("registers blender_start, blender_master_open, blender_status and blender_quit", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
        "blender_master_open",
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

  it.effect.each(["blender_start", "blender_master_open", "blender_status", "blender_quit"])(
    "refuses %s to an MCP client from outside a thread, and to a thread without the MCP",
    (name) => {
      const quits: Array<HostedBlenderQuitInput> = [];
      const args =
        name === "blender_start" || name === "blender_master_open"
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
      expect(yield* visibleTo(threadCaller(["hosted-blender"]))).toHaveLength(4);
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

  it.effect("reports no agent access until Blender Lab's listener is ready", () =>
    Effect.gen(function* () {
      const status = yield* call("blender_status", {}, threadCaller(["hosted-blender"]));
      expect(status.structuredContent).toMatchObject({ blenders: [{ agentAccess: false }] });
    }).pipe(Effect.provide(layerFor({ state: running, listener: "starting" }))),
  );

  it.effect(
    "keeps Plan mode read-only: status works; start, master open and quit are refused",
    () => {
      const quits: Array<HostedBlenderQuitInput> = [];
      return Effect.gen(function* () {
        const scope = threadCaller(["hosted-blender"]);
        expect((yield* call("blender_status", {}, scope)).isError).toBe(false);
        for (const [name, args] of [
          ["blender_start", { path: "hero.blend" }],
          ["blender_master_open", { path: "hero.blend" }],
          ["blender_quit", { save: true }],
        ] as const) {
          const refused = yield* call(name, args, scope);
          expect(refused.isError).toBe(true);
          expect(JSON.stringify(refused.content)).toContain("Plan mode is read-only");
        }
        expect(quits).toEqual([]);
      }).pipe(Effect.provide(layerFor({ state: running, quits, plan: true })));
    },
  );

  it.effect("refuses start and quit when the thread's mode can't be read", () => {
    const quits: Array<HostedBlenderQuitInput> = [];
    const shellReads = { count: 0 };
    return Effect.gen(function* () {
      for (const [name, args] of [
        ["blender_start", { path: "hero.blend" }],
        ["blender_quit", { save: true }],
      ] as const) {
        shellReads.count = 0;
        const refused = yield* call(name, args, threadCaller(["hosted-blender"]));
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused.content)).toContain("could not read");
      }
      expect(quits).toEqual([]);
    }).pipe(Effect.provide(layerFor({ state: running, quits, shellReads })));
  });

  it.effect("reports the file Blender has open and why access ended", () =>
    Effect.gen(function* () {
      const status = yield* call("blender_status", {}, threadCaller(["hosted-blender"]));
      expect(status.structuredContent).toMatchObject({
        blenders: [
          {
            file: "/home/user/acme/app/models/bracket-4.blend",
            agentAccess: false,
            agentAccessEnded: "otherFile",
          },
        ],
      });
    }).pipe(
      Effect.provide(
        layerFor({
          state: running,
          listener: "off",
          ended: "otherFile",
          openFile: "/home/user/acme/app/models/bracket-4.blend",
        }),
      ),
    ),
  );

  it.effect.each(["crashed", "closed"] as const)(
    "reports a %s working Blender, and whether its recovery copy can be restored",
    (status) =>
      Effect.gen(function* () {
        const result = yield* call("blender_status", {}, threadCaller(["hosted-blender"]));
        expect(result.structuredContent).toEqual({
          blenders: [
            {
              role: "working",
              status,
              file: `${workspace}/models/hero.wip-41cbc0de.blend`,
              recovery: true,
            },
          ],
        });
      }).pipe(
        Effect.provide(
          layerFor({
            state: {
              status,
              copies: [
                {
                  key: "workspace:models/hero.wip-41cbc0de.blend",
                  kind: status,
                  file: { kind: "workspace", relativePath: "models/hero.wip-41cbc0de.blend" },
                  recovery: true,
                },
              ],
            },
          }),
        ),
      ),
  );

  it.effect(
    "lists the master's one copy under the master role, and working copies under theirs",
    () =>
      Effect.gen(function* () {
        const result = yield* call("blender_status", {}, threadCaller(["hosted-blender"]));
        expect((result.structuredContent as { blenders: ReadonlyArray<object> }).blenders).toEqual([
          {
            role: "working",
            status: "closed",
            file: `${workspace}/models/part.blend`,
            recovery: true,
          },
          {
            role: "master",
            status: "crashed",
            file: `${workspace}/models/hero.blend`,
            recovery: true,
          },
        ]);
      }).pipe(
        Effect.provide(
          layerFor({
            state: {
              status: "closed",
              copies: [
                {
                  key: "workspace:models/part.blend",
                  kind: "closed",
                  file: { kind: "workspace", relativePath: "models/part.blend" },
                  recovery: true,
                },
              ],
            },
            master: {
              status: "crashed",
              relativePath: "models/hero.blend",
              copies: [
                {
                  key: "outside:/real/models/hero.blend",
                  kind: "crashed",
                  file: { kind: "workspace", relativePath: "models/hero.blend" },
                  recovery: true,
                },
              ],
            },
          }),
        ),
      ),
  );

  it.effect("lists each file's waiting copy under its own file, beside the running Blender", () =>
    Effect.gen(function* () {
      const result = yield* call("blender_status", {}, threadCaller(["hosted-blender"]));
      const blenders = (result.structuredContent as { blenders: ReadonlyArray<object> }).blenders;
      expect(blenders.slice(1)).toEqual([
        {
          role: "working",
          status: "crashed",
          file: `${workspace}/models/other.blend`,
          recovery: true,
        },
        { role: "working", status: "closed", file: "/elsewhere/outside.blend", recovery: true },
        { role: "working", status: "closed", recovery: false },
      ]);
    }).pipe(
      Effect.provide(
        layerFor({
          state: running,
          copies: [
            {
              key: "workspace:models/other.blend",
              kind: "crashed",
              file: { kind: "workspace", relativePath: "models/other.blend" },
              recovery: true,
            },
            {
              key: "outside:/elsewhere/outside.blend",
              kind: "closed",
              file: { kind: "outside", path: "/elsewhere/outside.blend" },
              recovery: true,
              copyPath: "/state/copy.blend",
            },
            { key: "untitled", kind: "closed", file: { kind: "untitled" }, recovery: false },
          ],
        }),
      ),
    ),
  );

  it.effect("leaves the file out for an untitled scene", () =>
    Effect.gen(function* () {
      const status = yield* call("blender_status", {}, threadCaller(["hosted-blender"]));
      const [blender] = (status.structuredContent as { blenders: ReadonlyArray<object> }).blenders;
      expect(blender).not.toHaveProperty("file");
    }).pipe(Effect.provide(layerFor({ state: running, listener: "off", openFile: null }))),
  );

  it.effect(
    "reports Blender's file under the workspace as configured, through a symlinked root",
    () =>
      Effect.gen(function* () {
        const real = NodeFS.realpathSync(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-status-")),
        );
        const linked = `${real}-link`;
        NodeFS.symlinkSync(real, linked);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            NodeFS.rmSync(linked);
            NodeFS.rmSync(real, { recursive: true, force: true });
          }),
        );
        const status = yield* call("blender_status", {}, threadCaller(["hosted-blender"])).pipe(
          Effect.provide(
            layerFor({
              state: running,
              openFile: NodePath.join(real, "models", "hero.wip-41cbc0de.blend"),
              workspace: linked,
            }),
          ),
        );
        expect(status.structuredContent).toMatchObject({
          blenders: [{ file: NodePath.join(linked, "models", "hero.wip-41cbc0de.blend") }],
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "copies back through the desktop Blender's own entry when it has the master open",
    () => {
      const opens: Array<readonly [HostedBlenderOpenInput, unknown]> = [];
      return Effect.gen(function* () {
        const opened = yield* call(
          "blender_master_open",
          { path: `${workspace}/models/hero.blend` },
          threadCaller(["hosted-blender"]),
        );
        expect(opened.structuredContent).toEqual({
          master: `${workspace}/models/hero.blend`,
          status: "desktop",
          mcpServer: "blender",
        });
        // Tied to the session that asked, so its access ends with it.
        expect(opens).toEqual([
          [
            { threadId, relativePath: "models/hero.blend" },
            { agentSession: "provider-session-hosted-blender-test" },
          ],
        ]);
      }).pipe(Effect.provide(layerFor({ state: running, opens, opened: { _tag: "desktop" } })));
    },
  );

  it.effect(
    "names blender-master for a master Blender, and a desktop Blender it couldn't ask",
    () =>
      Effect.gen(function* () {
        const opened = yield* call(
          "blender_master_open",
          { path: "models/hero.blend" },
          threadCaller(["hosted-blender"]),
        );
        expect(opened.structuredContent).toEqual({
          master: `${workspace}/models/hero.blend`,
          status: "running",
          mcpServer: "blender-master",
          desktopUnchecked: true,
        });
      }).pipe(
        Effect.provide(
          layerFor({
            state: running,
            opened: { _tag: "hosted", desktopUnchecked: true },
            master: { status: "running", relativePath: "models/hero.blend", dirty: false },
          }),
        ),
      ),
  );

  it.effect("refuses to open the agent's working copy as a master", () => {
    const opens: Array<readonly [HostedBlenderOpenInput, unknown]> = [];
    return Effect.gen(function* () {
      const refused = yield* call(
        "blender_master_open",
        { path: "models/hero.wip-ndertest.blend" },
        threadCaller(["hosted-blender"]),
      );
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("working copy");
      expect(opens).toEqual([]);
    }).pipe(Effect.provide(layerFor({ state: running, opens })));
  });

  it.effect("tells the agent when the master Blender doesn't take its calls", () =>
    Effect.gen(function* () {
      const refused = yield* call(
        "blender_master_open",
        { path: "models/hero.blend" },
        threadCaller(["hosted-blender"]),
      );
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("quit it from the Blender pane");
    }).pipe(Effect.provide(layerFor({ state: running, listener: "off" }))),
  );

  it.effect("tells the agent an untested Blender Lab version refused its master access", () =>
    Effect.gen(function* () {
      const refused = yield* call(
        "blender_master_open",
        { path: "models/hero.blend" },
        threadCaller(["hosted-blender"]),
      );
      expect(refused.isError).toBe(true);
      const text = JSON.stringify(refused.content);
      expect(text).toContain("refused you access");
      expect(text).toContain("blender_master_open again");
      expect(text).not.toContain("blender_start");
    }).pipe(Effect.provide(layerFor({ state: running, listener: "untested" }))),
  );

  it.effect("reports an untested Blender Lab version's refusal in blender_status", () =>
    Effect.gen(function* () {
      const status = yield* call("blender_status", {}, threadCaller(["hosted-blender"]));
      expect(status.structuredContent).toMatchObject({
        blenders: [
          { role: "working", agentAccess: false, agentAccessRefused: "untestedBlenderLab" },
          { role: "master", agentAccess: false, agentAccessRefused: "untestedBlenderLab" },
        ],
      });
    }).pipe(
      Effect.provide(
        layerFor({
          state: running,
          listener: "untested",
          master: { status: "running", relativePath: "models/hero.blend", dirty: false },
        }),
      ),
    ),
  );

  it.effect("lists the master Blender beside the working one", () =>
    Effect.gen(function* () {
      const status = yield* call("blender_status", {}, threadCaller(["hosted-blender"]));
      expect(status.structuredContent).toMatchObject({
        blenders: [
          { role: "working", status: "running" },
          {
            role: "master",
            status: "running",
            file: `${workspace}/models/hero.blend`,
            unsavedChanges: true,
            agentAccess: true,
          },
        ],
      });
    }).pipe(
      Effect.provide(
        layerFor({
          state: running,
          master: { status: "running", relativePath: "models/hero.blend", dirty: true },
        }),
      ),
    ),
  );

  it.effect("refuses a link that leads to the agent's working copy as a master", () => {
    const opens: Array<readonly [HostedBlenderOpenInput, unknown]> = [];
    return Effect.gen(function* () {
      const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-master-link-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      NodeFS.writeFileSync(NodePath.join(root, "hero.wip-ndertest.blend"), "");
      NodeFS.symlinkSync(
        NodePath.join(root, "hero.wip-ndertest.blend"),
        NodePath.join(root, "master.blend"),
      );
      const refused = yield* call(
        "blender_master_open",
        { path: "master.blend" },
        threadCaller(["hosted-blender"]),
      ).pipe(Effect.provide(layerFor({ state: running, opens, workspace: root })));
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("working copy");
      expect(opens).toEqual([]);
    }).pipe(Effect.scoped);
  });
});
