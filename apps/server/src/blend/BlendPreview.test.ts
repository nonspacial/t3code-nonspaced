import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as BlendPreview from "./BlendPreview.ts";

const layerTest = BlendPreview.layer.pipe(
  Layer.provide(
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
      ),
      Layer.provide(Layer.mock(WorkspaceEntries.WorkspaceEntries)({})),
      Layer.provide(WorkspacePaths.layer),
    ),
  ),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-blend-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const workspaceWithFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-blend-workspace-" });
  const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-blend-outside-" });
  const fixture = path.join(import.meta.dirname, "fixtures", "bracket-5.blend");
  yield* fileSystem.makeDirectory(path.join(root, "models"));
  yield* fileSystem.copyFile(fixture, path.join(root, "models", "bracket.blend"));
  yield* fileSystem.copyFile(fixture, path.join(outside, "bracket.blend"));
  yield* fileSystem.writeFileString(path.join(root, "notes.blend"), "not a blend file");
  return { root, outside, path };
});

describe("BlendPreview", () => {
  it.layer(layerTest)((it) => {
    it.effect("reads a workspace file, or a host file in place, with its thumbnail as a PNG", () =>
      Effect.gen(function* () {
        const { root, outside, path } = yield* workspaceWithFixture;
        const blendPreview = yield* BlendPreview.BlendPreview;
        for (const relativePath of ["models/bracket.blend", path.join(outside, "bracket.blend")]) {
          const preview = yield* blendPreview.read({ cwd: root, relativePath });
          expect(preview).toMatchObject({
            blenderVersion: "5.3",
            scene: { name: "Bracket", frameStart: 10, frameEnd: 120 },
            thumbnail: { width: 128, height: 128 },
          });
          const png = Buffer.from(preview.thumbnail?.dataUrl.split(",")[1] ?? "", "base64");
          expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
          expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([128, 128]);
        }
      }).pipe(Effect.scoped),
    );

    it.effect("refuses paths that leave the workspace, and files that are not .blend", () =>
      Effect.gen(function* () {
        const { root } = yield* workspaceWithFixture;
        const blendPreview = yield* BlendPreview.BlendPreview;
        const escape = yield* blendPreview
          .read({ cwd: root, relativePath: "../bracket.blend" })
          .pipe(Effect.flip);
        expect(escape._tag).toBe("WorkspacePathOutsideRootError");
        const unreadable = yield* blendPreview
          .read({ cwd: root, relativePath: "notes.blend" })
          .pipe(Effect.flip);
        expect(unreadable._tag).toBe("BlendFileFormatError");
        const missing = yield* blendPreview
          .read({ cwd: root, relativePath: "gone.blend" })
          .pipe(Effect.flip);
        expect(missing._tag).toBe("WorkspaceFileSystemOperationError");
      }).pipe(Effect.scoped),
    );
  });
});
