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
import type * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as HostedBlender from "../hostedBlender/HostedBlender.ts";
import * as HostedBlenderAgents from "../hostedBlender/HostedBlenderAgents.ts";
import * as HostedBlenderMcpProxy from "../hostedBlender/HostedBlenderMcpProxy.ts";
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
  /** Why the session's Blender servers take no calls, as the proxy says; none by default. */
  readonly unavailable?: string;
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
  /** The thread's working copies held outside the project. */
  readonly held?: ReadonlyArray<string>;
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
          heldWorkingCopies: () => Effect.succeed(input.held ?? []),
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
        Layer.mock(HostedBlenderMcpProxy.HostedBlenderMcpProxy)({
          unavailable: () => Effect.succeed(input.unavailable ?? null),
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

type LayerInput = Parameters<typeof layerFor>[0];
const master = { status: "running", relativePath: "models/hero.blend", dirty: false } as const;
const blendersOf = (result: { readonly structuredContent?: unknown }) =>
  (result.structuredContent as { blenders: ReadonlyArray<object> }).blenders;

/** A workspace path reached through a symlinked root, removed with the test's scope. */
const symlinkedWorkspace = Effect.acquireRelease(
  Effect.sync(() => {
    const real = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-status-")),
    );
    const linked = `${real}-link`;
    NodeFS.symlinkSync(real, linked);
    return { real, linked };
  }),
  ({ real, linked }) =>
    Effect.sync(() => {
      NodeFS.rmSync(linked);
      NodeFS.rmSync(real, { recursive: true, force: true });
    }),
);

const statusRows: ReadonlyArray<{
  readonly name: string;
  readonly given: Effect.Effect<LayerInput & { readonly linked?: string }, never, Scope.Scope>;
  readonly check: (
    result: { readonly structuredContent?: unknown },
    given: { readonly linked?: string },
  ) => void;
}> = [
  {
    name: "the thread's working Blender",
    given: Effect.succeed({ state: running }),
    check: (result) =>
      expect(result.structuredContent).toEqual({
        blenders: [
          {
            role: "working",
            status: "running",
            file: `${workspace}/models/hero.wip-41cbc0de.blend`,
            unsavedChanges: true,
            agentAccess: true,
          },
        ],
      }),
  },
  {
    name: "no agent access until Blender Lab's listener is ready",
    given: Effect.succeed({ state: running, listener: "starting" }),
    check: (result) => {
      expect(result.structuredContent).toMatchObject({ blenders: [{ agentAccess: false }] });
      // Nothing to do yet but wait.
      expect(JSON.stringify(result.structuredContent)).not.toContain("agentAccessHelp");
    },
  },
  {
    name: "no agent access, and why, while setup has no current read of the server",
    given: Effect.succeed({ state: running, master, unavailable: "No current read." }),
    check: (result) =>
      expect(result.structuredContent).toMatchObject({
        blenders: [
          { role: "working", agentAccess: false, agentAccessHelp: "No current read." },
          { role: "master", agentAccess: false, agentAccessHelp: "No current read." },
        ],
      }),
  },
  {
    name: "a working copy held outside the project, which blender_start puts back",
    given: Effect.succeed({
      state: { status: "stopped" },
      held: [`${workspace}/models/hero.wip-3c4d5e6f.blend`],
    }),
    check: (result) =>
      expect(result.structuredContent).toEqual({
        blenders: [
          { role: "working", status: "held", file: `${workspace}/models/hero.wip-3c4d5e6f.blend` },
        ],
      }),
  },
  {
    name: "the file Blender has open and why access ended",
    given: Effect.succeed({
      state: running,
      listener: "off",
      ended: "otherFile",
      openFile: "/home/user/acme/app/models/bracket-4.blend",
    }),
    check: (result) =>
      expect(result.structuredContent).toMatchObject({
        blenders: [
          {
            file: "/home/user/acme/app/models/bracket-4.blend",
            agentAccess: false,
            agentAccessEnded: "otherFile",
            // What blender_start would say, so an agent that only asks for status knows the way back.
            agentAccessHelp: expect.stringContaining(
              "call blender_quit with save: true, then blender_start",
            ),
          },
        ],
      }),
  },
  ...(["crashed", "closed"] as const).map((status) => ({
    name: `a ${status} working Blender, and whether its recovery copy can be restored`,
    given: Effect.succeed({
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
    } satisfies LayerInput),
    check: (result: { readonly structuredContent?: unknown }) =>
      expect(result.structuredContent).toEqual({
        blenders: [
          {
            role: "working",
            status,
            file: `${workspace}/models/hero.wip-41cbc0de.blend`,
            recovery: true,
          },
        ],
      }),
  })),
  {
    name: "the master's one copy under the master role, and working copies under theirs",
    given: Effect.succeed({
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
    check: (result) =>
      expect(blendersOf(result)).toEqual([
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
      ]),
  },
  {
    name: "each file's waiting copy under its own file, beside the running Blender",
    given: Effect.succeed({
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
    check: (result) =>
      expect(blendersOf(result).slice(1)).toEqual([
        {
          role: "working",
          status: "crashed",
          file: `${workspace}/models/other.blend`,
          recovery: true,
        },
        { role: "working", status: "closed", file: "/elsewhere/outside.blend", recovery: true },
        { role: "working", status: "closed", recovery: false },
      ]),
  },
  {
    name: "no file for an untitled scene",
    given: Effect.succeed({ state: running, listener: "off", openFile: null }),
    check: (result) => expect(blendersOf(result)[0]).not.toHaveProperty("file"),
  },
  {
    name: "Blender's file under the workspace as configured, through a symlinked root",
    given: Effect.map(symlinkedWorkspace, ({ real, linked }) => ({
      state: running,
      openFile: NodePath.join(real, "models", "hero.wip-41cbc0de.blend"),
      workspace: linked,
      linked,
    })),
    check: (result, { linked }) =>
      expect(result.structuredContent).toMatchObject({
        blenders: [{ file: NodePath.join(linked!, "models", "hero.wip-41cbc0de.blend") }],
      }),
  },
  {
    name: "an untested Blender Lab version's refusal",
    given: Effect.succeed({ state: running, listener: "untested", master }),
    check: (result) =>
      expect(result.structuredContent).toMatchObject({
        blenders: [
          {
            role: "working",
            agentAccess: false,
            agentAccessRefused: "untestedBlenderLab",
            agentAccessHelp: expect.stringContaining("blender_start"),
          },
          {
            role: "master",
            agentAccess: false,
            agentAccessRefused: "untestedBlenderLab",
            agentAccessHelp: expect.stringContaining("blender_master_open again"),
          },
        ],
      }),
  },
  {
    name: "the master Blender beside the working one",
    given: Effect.succeed({ state: running, master: { ...master, dirty: true } }),
    check: (result) =>
      expect(result.structuredContent).toMatchObject({
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
      }),
  },
];

describe("hosted Blender MCP tools", () => {
  it.effect.each(statusRows)("blender_status reports $name", ({ given, check }) =>
    Effect.gen(function* () {
      const input = yield* given;
      const status = yield* call("blender_status", {}, threadCaller(["hosted-blender"])).pipe(
        Effect.provide(layerFor(input)),
      );
      expect(status.isError).toBe(false);
      check(status, input);
    }).pipe(Effect.scoped),
  );

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

  it.effect(
    "shows its four tools only to threads with the hosted Blender MCP, never to outside clients",
    () =>
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
        expect((yield* visibleTo(threadCaller(["hosted-blender"]))).toSorted()).toEqual([
          "blender_master_open",
          "blender_quit",
          "blender_start",
          "blender_status",
        ]);
        expect(yield* visibleTo(threadCaller(["orchestration"]))).toEqual([]);
        expect(yield* visibleTo(outsideClient)).toEqual([]);
      }).pipe(Effect.provide(layerFor({ state: running }))),
  );

  it.effect(
    "shows its four tools only to threads with the hosted Blender MCP, never to outside clients",
    () =>
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
        expect((yield* visibleTo(threadCaller(["hosted-blender"]))).toSorted()).toEqual([
          "blender_master_open",
          "blender_quit",
          "blender_start",
          "blender_status",
        ]);
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

  it.effect(
    "keeps Plan mode read-only: status works; start, master open and quit are refused",
    () => {
      const quits: Array<HostedBlenderQuitInput> = [];
      const shellReads = { count: 0 };
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const scope = threadCaller(["hosted-blender"]);
          expect((yield* call("blender_status", {}, scope)).isError).toBe(false);
          for (const [name, args] of [
            ["blender_start", { path: "hero.blend" }],
            ["blender_master_open", { path: "hero.blend" }],
            ["blender_quit", { save: true }],
          ] as const) {
            const refused = yield* call(name, args, scope);
            expect(refused.isError, `${name} in Plan`).toBe(true);
            expect(JSON.stringify(refused.content)).toContain("Plan mode is read-only");
          }
        }).pipe(Effect.provide(layerFor({ state: running, quits, plan: true })));

        // Fails closed: with the thread's mode unreadable, start and quit are refused too.
        yield* Effect.gen(function* () {
          for (const [name, args] of [
            ["blender_start", { path: "hero.blend" }],
            ["blender_quit", { save: true }],
          ] as const) {
            shellReads.count = 0;
            const refused = yield* call(name, args, threadCaller(["hosted-blender"]));
            expect(refused.isError, `${name} with the mode unreadable`).toBe(true);
            expect(JSON.stringify(refused.content)).toContain("could not read");
          }
        }).pipe(Effect.provide(layerFor({ state: running, quits, shellReads })));
        expect(quits).toEqual([]);
      });
    },
  );

  it.effect.each([
    {
      name: "names blender-master for a master Blender, and a desktop Blender it couldn't ask",
      given: {
        state: running,
        opened: { _tag: "hosted", desktopUnchecked: true },
        master,
      } satisfies LayerInput,
      check: (opened: {
        readonly isError?: boolean | undefined;
        readonly structuredContent?: unknown;
        readonly content: unknown;
      }) =>
        expect(opened.structuredContent).toEqual({
          master: `${workspace}/models/hero.blend`,
          status: "running",
          mcpServer: "blender-master",
          desktopUnchecked: true,
        }),
    },
    {
      name: "tells the agent when the master Blender doesn't take its calls",
      given: { state: running, listener: "off" } satisfies LayerInput,
      check: (opened: { readonly isError?: boolean | undefined; readonly content: unknown }) =>
        expect(opened.isError).toBe(true),
    },
    {
      name: "tells the agent an untested Blender Lab version refused its master access",
      given: { state: running, listener: "untested" } satisfies LayerInput,
      check: (opened: { readonly isError?: boolean | undefined; readonly content: unknown }) => {
        expect(opened.isError).toBe(true);
        const text = JSON.stringify(opened.content);
        expect(text).toContain("blender_master_open");
        expect(text).not.toContain("blender_start");
      },
    },
  ])("blender_master_open $name", ({ given, check }) =>
    Effect.gen(function* () {
      const opened = yield* call(
        "blender_master_open",
        { path: "models/hero.blend" },
        threadCaller(["hosted-blender"]),
      );
      check(opened);
    }).pipe(Effect.provide(layerFor(given))),
  );

  it.effect(
    "refuses to open the agent's working copy as a master, or a link that leads to it",
    () => {
      const opens: Array<readonly [HostedBlenderOpenInput, unknown]> = [];
      return Effect.gen(function* () {
        const refused = yield* call(
          "blender_master_open",
          { path: "models/hero.wip-ndertest.blend" },
          threadCaller(["hosted-blender"]),
        ).pipe(Effect.provide(layerFor({ state: running, opens })));
        expect(refused.isError, "the working copy itself").toBe(true);
        expect(JSON.stringify(refused.content)).toContain("working copy");

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
        const linked = yield* call(
          "blender_master_open",
          { path: "master.blend" },
          threadCaller(["hosted-blender"]),
        ).pipe(Effect.provide(layerFor({ state: running, opens, workspace: root })));
        expect(linked.isError, "a link to the working copy").toBe(true);
        expect(JSON.stringify(linked.content)).toContain("working copy");
        expect(opens).toEqual([]);
      }).pipe(Effect.scoped);
    },
  );
});
