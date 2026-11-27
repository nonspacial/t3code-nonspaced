// @effect-diagnostics nodeBuiltinImport:off - fixtures write real .blend stand-ins into a temp workspace.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  HostedBlenderError,
  type HostedBlenderKeptCopy,
  type HostedBlenderOpenInput,
  type HostedBlenderReopenInput,
  type HostedBlenderThreadState,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { startAgentWorkingCopy } from "./agentWorkingCopy.ts";
import * as HostedBlender from "./HostedBlender.ts";
import { workingCopyName } from "./workingCopies.ts";

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
  readonly listener?: HostedBlender.AgentListenerState;
  readonly ended?: HostedBlender.AgentAccessEnded;
  readonly openFile?: string;
  readonly mcpVersion?: string | null;
  readonly opened: Array<HostedBlenderOpenInput & { readonly agentWorkingCopy?: boolean }>;
  readonly openError?: HostedBlenderError;
  /** The masters `blender_start` made known to the thread. */
  readonly known?: Array<HostedBlenderOpenInput>;
  /** The copies the thread keeps, and the reopens `blender_start` asked for. */
  readonly kept?: ReadonlyArray<HostedBlenderKeptCopy>;
  readonly reopened?: Array<HostedBlenderReopenInput>;
}) =>
  Layer.mergeAll(
    Layer.mock(HostedBlender.HostedBlender)({
      open: (open, options) =>
        input.openError === undefined
          ? Effect.sync(() => {
              input.opened.push({ ...open, ...options });
            })
          : Effect.fail(input.openError),
      threadState: () => Stream.succeed(input.state ?? { status: "stopped" }),
      keptCopies: () => Effect.succeed(input.kept ?? []),
      reopen: (reopen) => Effect.sync(() => void input.reopened?.push(reopen)),
      knowMaster: (master) => Effect.sync(() => void input.known?.push(master)),
      putBackHeld: () => Effect.succeed(null),
      recordWorkingCopy: () => Effect.void,
      agentListener: () =>
        Effect.succeed({
          state: input.listener ?? "ready",
          ended: input.ended ?? null,
          openFile: input.openFile ?? null,
          mcpVersion: input.mcpVersion === undefined ? "1.0.3" : input.mcpVersion,
        }),
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
  it.effect(
    "B13: opens the file as on disk past a copy a reload kept, leaving the copy for the person",
    () =>
      Effect.gen(function* () {
        const root = yield* tempWorkspace;
        writeMaster(root, "hero.blend");
        writeMaster(root, "hero.wip-3c4d5e6f.blend", "agent edits");
        const relativePath = "hero.wip-3c4d5e6f.blend";
        const copy = (reloaded: boolean): HostedBlenderKeptCopy => ({
          key: `workspace:${relativePath}`,
          kind: "closed",
          file: { kind: "workspace", relativePath },
          recovery: true,
          ...(reloaded ? { reloaded: true } : {}),
        });
        const start = (reloaded: boolean) =>
          Effect.gen(function* () {
            const reopened: Array<HostedBlenderReopenInput> = [];
            const result = yield* startAgentWorkingCopy({ threadId, path: "hero.blend" }).pipe(
              Effect.provide(layerFor({ root, opened: [], kept: [copy(reloaded)], reopened })),
            );
            return { reopened, result };
          });
        // The work a reload kept is older than the file on disk, so the agent gets the file.
        const afterReload = yield* start(true);
        assert.deepEqual(afterReload.reopened, [
          { threadId, key: `workspace:${relativePath}`, restore: false },
        ]);
        assert.notProperty(afterReload.result, "restoredUnsavedChanges");
        // Its own quit without saving keeps work only it can get back, which it gets.
        const afterQuit = yield* start(false);
        assert.deepEqual(afterQuit.reopened, [
          { threadId, key: `workspace:${relativePath}`, restore: true },
        ]);
        assert.propertyVal(afterQuit.result, "restoredUnsavedChanges", true);
      }).pipe(Effect.scoped),
  );

  it.effect("copies the master beside itself and opens the copy in the thread's Blender", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      const master = writeMaster(root, "models/hero.blend");
      const opened: Array<HostedBlenderOpenInput & { readonly agentWorkingCopy?: boolean }> = [];
      const known: Array<HostedBlenderOpenInput> = [];
      const result = yield* startAgentWorkingCopy({ threadId, path: "models/hero.blend" }).pipe(
        Effect.provide(layerFor({ root, opened, known })),
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
      assert.deepEqual(opened, [
        { threadId, relativePath: "models/hero.wip-3c4d5e6f.blend", agentWorkingCopy: true },
      ]);
      // N8: the copy's master is the thread's master from now on, so the pane can switch to it.
      assert.deepEqual(known, [{ threadId, relativePath: "models/hero.blend" }]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the thread's earlier working copy, and takes an absolute path", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      const master = writeMaster(root, "hero.blend", "new master");
      writeMaster(root, "hero.wip-3c4d5e6f.blend", "agent edits");
      const opened: Array<HostedBlenderOpenInput & { readonly agentWorkingCopy?: boolean }> = [];
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
      writeMaster(root, "hero.blend");
      writeMaster(root, "hero.wip-3c4d5e6f.blend", "agent edits");
      const opened: Array<HostedBlenderOpenInput & { readonly agentWorkingCopy?: boolean }> = [];
      const result = yield* startAgentWorkingCopy({
        threadId,
        path: "hero.wip-3c4d5e6f.blend",
      }).pipe(Effect.provide(layerFor({ root, opened })));
      assert.isFalse(result.created);
      assert.deepEqual(opened, [
        { threadId, relativePath: "hero.wip-3c4d5e6f.blend", agentWorkingCopy: true },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { path: "/etc/hero.blend", reason: "workspace" },
    { path: "../outside.blend", reason: "workspace" },
    { path: "notes.txt", reason: ".blend" },
    { path: "missing.blend", reason: "not found" },
    // Another thread's held working copy, which an agent listing the workspace can see.
    { path: ".t3/held-working-copies/copy-id/copy.blend", reason: "Settings › Blender" },
  ])("refuses $path", ({ path, reason }) =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      writeMaster(root, "notes.txt");
      const held = writeMaster(root, ".t3/held-working-copies/copy-id/copy.blend", "held");
      const error = yield* Effect.flip(
        startAgentWorkingCopy({ threadId, path }).pipe(
          Effect.provide(layerFor({ root, opened: [] })),
        ),
      );
      expect(error.reason).toContain(reason);
      expect(NodeFS.readdirSync(NodePath.dirname(held))).toEqual(["copy.blend"]);
    }).pipe(Effect.scoped),
  );

  it.effect("asks for a restart when the copy is open without agent access", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      writeMaster(root, "hero.blend");
      const opened: Array<HostedBlenderOpenInput & { readonly agentWorkingCopy?: boolean }> = [];
      const error = yield* Effect.flip(
        startAgentWorkingCopy({ threadId, path: "hero.blend" }).pipe(
          Effect.provide(
            layerFor({
              root,
              opened,
              listener: "off",
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

  it.effect("fails clearly when Blender Lab's listener never comes up", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      writeMaster(root, "hero.blend");
      const error = yield* Effect.flip(
        startAgentWorkingCopy({ threadId, path: "hero.blend" }).pipe(
          Effect.provide(layerFor({ root, opened: [], listener: "failed" })),
        ),
      );
      expect(error.reason).toContain("did not start listening");
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { mcpVersion: "1.1.0", says: ["MCP 1.1.0", "tested only 1.0.3", "update T3 Code"] },
    { mcpVersion: "1.1.0-beta", says: ["update T3 Code"] },
    {
      mcpVersion: "1.0.1",
      says: ["MCP 1.0.1", "in their own Blender", "copies the new version into the hosted Blender"],
    },
    { mcpVersion: null, says: ["can't read", "MCP extension in their own Blender"] },
  ])(
    "refuses an untested Blender Lab $mcpVersion and says what to update",
    ({ mcpVersion, says }) =>
      Effect.gen(function* () {
        const root = yield* tempWorkspace;
        writeMaster(root, "hero.blend");
        const error = yield* Effect.flip(
          startAgentWorkingCopy({ threadId, path: "hero.blend" }).pipe(
            Effect.provide(layerFor({ root, opened: [], listener: "untested", mcpVersion })),
          ),
        );
        for (const part of says) expect(error.reason).toContain(part);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { kind: "symlink", make: (master: string, copy: string) => NodeFS.symlinkSync(master, copy) },
    { kind: "hard link", make: (master: string, copy: string) => NodeFS.linkSync(master, copy) },
  ])("never opens the master through a $kind in the working copy's place", ({ make }) =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      const master = writeMaster(root, "hero.blend");
      make(master, NodePath.join(root, "hero.wip-3c4d5e6f.blend"));
      const opened: Array<HostedBlenderOpenInput> = [];
      const error = yield* Effect.flip(
        startAgentWorkingCopy({ threadId, path: "hero.blend" }).pipe(
          Effect.provide(layerFor({ root, opened })),
        ),
      );
      expect(error.reason).toContain("not a separate copy");
      assert.deepEqual(opened, []);
      assert.equal(NodeFS.readFileSync(master, "utf8"), "master");
    }).pipe(Effect.scoped),
  );

  it.effect("makes one copy when two starts race, and replaces nothing", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      writeMaster(root, "hero.blend");
      const results = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          startAgentWorkingCopy({ threadId, path: "hero.blend" }).pipe(
            Effect.provide(layerFor({ root, opened: [] })),
          ),
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((result) => result.created).length, 1);
      assert.deepEqual(NodeFS.readdirSync(root).toSorted(), [
        "hero.blend",
        "hero.wip-3c4d5e6f.blend",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("answers with paths under the workspace as configured, through a symlinked root", () =>
    Effect.gen(function* () {
      const real = yield* tempWorkspace;
      writeMaster(real, "models/hero.blend");
      const root = `${real}-link`;
      NodeFS.symlinkSync(real, root);
      yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.rmSync(root)));
      const result = yield* startAgentWorkingCopy({ threadId, path: "models/hero.blend" }).pipe(
        Effect.provide(layerFor({ root, opened: [] })),
      );
      assert.equal(result.workingCopy, NodePath.join(root, "models", "hero.wip-3c4d5e6f.blend"));
      assert.equal(result.master, NodePath.join(root, "models", "hero.blend"));
    }).pipe(Effect.scoped),
  );

  it.effect("checks a working copy named directly the same way", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      const master = writeMaster(root, "hero.blend");
      NodeFS.linkSync(master, NodePath.join(root, "hero.wip-3c4d5e6f.blend"));
      const opened: Array<HostedBlenderOpenInput> = [];
      const error = yield* Effect.flip(
        startAgentWorkingCopy({ threadId, path: "hero.wip-3c4d5e6f.blend" }).pipe(
          Effect.provide(layerFor({ root, opened })),
        ),
      );
      expect(error.reason).toContain("not a separate copy");
      assert.deepEqual(opened, []);
    }).pipe(Effect.scoped),
  );

  it.effect("reopens an existing copy without copying the master again", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      writeMaster(root, "hero.blend");
      writeMaster(root, "hero.wip-3c4d5e6f.blend", "agent edits");
      // No room for another copy: a staging folder can't be made beside the master.
      NodeFS.chmodSync(root, 0o555);
      yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.chmodSync(root, 0o755)));
      const result = yield* startAgentWorkingCopy({ threadId, path: "hero.blend" }).pipe(
        Effect.provide(layerFor({ root, opened: [] })),
      );
      assert.isFalse(result.created);
    }).pipe(Effect.scoped),
  );

  it.effect("checks a direct working copy against its master whatever the extension's case", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      const master = writeMaster(root, "Hero.BLEND");
      NodeFS.linkSync(master, NodePath.join(root, "Hero.wip-3c4d5e6f.blend"));
      const error = yield* Effect.flip(
        startAgentWorkingCopy({ threadId, path: "Hero.wip-3c4d5e6f.blend" }).pipe(
          Effect.provide(layerFor({ root, opened: [] })),
        ),
      );
      expect(error.reason).toContain("not a separate copy");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a direct working copy whose master can't be found", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      writeMaster(root, "hero.wip-3c4d5e6f.blend");
      const error = yield* Effect.flip(
        startAgentWorkingCopy({ threadId, path: "hero.wip-3c4d5e6f.blend" }).pipe(
          Effect.provide(layerFor({ root, opened: [] })),
        ),
      );
      expect(error.reason).toContain("not a separate copy");
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { ended: "connectionLost" as const, says: "Ask the user to save in the Blender pane" },
    { ended: "otherFile" as const, says: "has another file open" },
    { ended: "revoked" as const, says: "blender_quit with save: true" },
  ])("says how to get access back after $ended", ({ ended, says }) =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      writeMaster(root, "hero.blend");
      const error = yield* Effect.flip(
        startAgentWorkingCopy({ threadId, path: "hero.blend" }).pipe(
          Effect.provide(layerFor({ root, opened: [], listener: "off", ended })),
        ),
      );
      expect(error.reason).toContain(says);
      if (ended === "connectionLost") expect(error.reason).toContain("save: false");
    }).pipe(Effect.scoped),
  );

  it.effect("doesn't take a folder by the master's name as the master", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      NodeFS.mkdirSync(NodePath.join(root, "hero.BLEND"));
      writeMaster(root, "hero.wip-3c4d5e6f.blend");
      const error = yield* Effect.flip(
        startAgentWorkingCopy({ threadId, path: "hero.wip-3c4d5e6f.blend" }).pipe(
          Effect.provide(layerFor({ root, opened: [] })),
        ),
      );
      expect(error.reason).toContain("not a separate copy");
    }).pipe(Effect.scoped),
  );

  it.effect("tells a lost connection apart from a pane-opened copy when it says how to save", () =>
    Effect.gen(function* () {
      const root = yield* tempWorkspace;
      writeMaster(root, "hero.blend");
      // A copy the pane opened, whose connection then dropped.
      const error = yield* Effect.flip(
        startAgentWorkingCopy({ threadId, path: "hero.blend" }).pipe(
          Effect.provide(
            layerFor({
              root,
              opened: [],
              listener: "off",
              ended: HostedBlender.agentAccessEndedFor(true, null) ?? "revoked",
            }),
          ),
        ),
      );
      expect(error.reason).toContain("Ask the user to save in the Blender pane");
      expect(error.reason).not.toContain("save: true");
      assert.equal(HostedBlender.agentAccessEndedFor(true, "otherFile"), "connectionLost");
      assert.equal(HostedBlender.agentAccessEndedFor(false, "otherFile"), "otherFile");
    }).pipe(Effect.scoped),
  );
});
