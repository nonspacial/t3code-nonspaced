// @effect-diagnostics nodeBuiltinImport:off - fixtures write real .blend stand-ins into a temp workspace.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  HostedBlenderError,
  type HostedBlenderOpenInput,
  type HostedBlenderThreadState,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { startAgentWorkingCopy, workingCopyName } from "./agentWorkingCopy.ts";
import * as HostedBlender from "./HostedBlender.ts";
import * as HostedBlenderAgents from "./HostedBlenderAgents.ts";

const threadId = ThreadId.make("thread-6f1c2a9e-0b7d-4c55-9e1a-1a2b3c4d5e6f");

describe("workingCopyName", () => {
  it("names the copy after the master and the thread", () => {
    expect(workingCopyName("hero.blend", threadId)).toBe("hero.wip-3c4d5e6f.blend");
    expect(workingCopyName("Hero Final.BLEND", threadId)).toBe("Hero Final.wip-3c4d5e6f.blend");
  });
});

const tempWorkspace = Effect.acquireRelease(
  Effect.sync(() =>
    NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wip-"))),
  ),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

const layerFor = (input: {
  readonly root: string;
  readonly state?: HostedBlenderThreadState;
  readonly listening?: boolean;
  readonly opened: Array<HostedBlenderOpenInput>;
  readonly openError?: HostedBlenderError;
}) =>
  Layer.mergeAll(
    Layer.mock(HostedBlender.HostedBlender)({
      open: (open) =>
        input.openError === undefined
          ? Effect.sync(() => {
              input.opened.push(open);
            })
          : Effect.fail(input.openError),
      threadState: () => Stream.succeed(input.state ?? { status: "stopped" }),
    }),
    Layer.mock(HostedBlenderAgents.HostedBlenderAgents)({
      listening: () => Effect.succeed(input.listening ?? true),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () => Effect.succeed({ worktreePath: input.root, projectId: "p" } as never),
    }),
    Layer.mock(ProjectService.ProjectService)({}),
    WorkspacePaths.layer,
  ).pipe(Layer.provideMerge(NodeServices.layer));

const writeMaster = (root: string, relative: string, body = "master") => {
  const file = NodePath.join(root, relative);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, body);
  return file;
};

describe("startAgentWorkingCopy", () => {
  it.effect("copies the master beside itself and opens the copy in the thread's Blender", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      const master = writeMaster(root, "models/hero.blend");
      const opened: Array<HostedBlenderOpenInput> = [];
      const result = yield* startAgentWorkingCopy({ threadId, path: "models/hero.blend" }).pipe(
        Effect.provide(layerFor({ root, opened })),
      );
      const copy = NodePath.join(root, "models", "hero.wip-3c4d5e6f.blend");
      assert.deepEqual(result, {
        workingCopy: copy,
        master,
        created: true,
        status: "starting",
        mcpServer: "blender-hosted",
      });
      assert.equal(NodeFS.readFileSync(copy, "utf8"), "master");
      assert.deepEqual(opened, [{ threadId, relativePath: "models/hero.wip-3c4d5e6f.blend" }]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the thread's earlier working copy, and takes an absolute path", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      const master = writeMaster(root, "hero.blend", "new master");
      writeMaster(root, "hero.wip-3c4d5e6f.blend", "agent edits");
      const opened: Array<HostedBlenderOpenInput> = [];
      const result = yield* startAgentWorkingCopy({ threadId, path: master }).pipe(
        Effect.provide(layerFor({ root, opened })),
      );
      assert.isFalse(result.created);
      assert.equal(
        NodeFS.readFileSync(NodePath.join(root, "hero.wip-3c4d5e6f.blend"), "utf8"),
        "agent edits",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("opens the working copy itself when the agent names it", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      writeMaster(root, "hero.wip-3c4d5e6f.blend");
      const opened: Array<HostedBlenderOpenInput> = [];
      const result = yield* startAgentWorkingCopy({
        threadId,
        path: "hero.wip-3c4d5e6f.blend",
      }).pipe(Effect.provide(layerFor({ root, opened })));
      assert.isFalse(result.created);
      assert.deepEqual(opened, [{ threadId, relativePath: "hero.wip-3c4d5e6f.blend" }]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { path: "/etc/hero.blend", reason: "workspace" },
    { path: "../outside.blend", reason: "workspace" },
    { path: "notes.txt", reason: ".blend" },
    { path: "missing.blend", reason: "not found" },
  ])("refuses $path", ({ path, reason }) =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      writeMaster(root, "notes.txt");
      const error = yield* Effect.flip(
        startAgentWorkingCopy({ threadId, path }).pipe(
          Effect.provide(layerFor({ root, opened: [] })),
        ),
      );
      expect(error.reason).toContain(reason);
    }).pipe(Effect.scoped),
  );

  it.effect("asks for a restart when the copy is open without agent access", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      writeMaster(root, "hero.blend");
      const opened: Array<HostedBlenderOpenInput> = [];
      const error = yield* Effect.flip(
        startAgentWorkingCopy({ threadId, path: "hero.blend" }).pipe(
          Effect.provide(
            layerFor({
              root,
              opened,
              listening: false,
              state: { status: "running", relativePath: "hero.wip-3c4d5e6f.blend", dirty: false },
            }),
          ),
        ),
      );
      expect(error.reason).toContain("blender_quit");
      assert.deepEqual(opened, []);
    }).pipe(Effect.scoped),
  );

  it.effect("reports what blocked the hosted Blender", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      writeMaster(root, "hero.blend");
      const error = yield* Effect.flip(
        startAgentWorkingCopy({ threadId, path: "hero.blend" }).pipe(
          Effect.provide(
            layerFor({
              root,
              opened: [],
              openError: new HostedBlenderError({ reason: "otherFileOpen" }),
            }),
          ),
        ),
      );
      expect(error.reason).toContain("already has another file open");
    }).pipe(Effect.scoped),
  );
});
