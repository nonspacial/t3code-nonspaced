import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as BlendFileWatcher from "./BlendFileWatcher.ts";

describe("BlendFileWatcher", () => {
  // Real OS file watches, which only report on the wall clock.
  it.live("sees Blender's save-by-rename and a linked file in another folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const project = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-blend-watch-" });
      const library = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-blend-lib-" });
      const rig = path.join(project, "rig.blend");
      const parts = path.join(library, "parts.blend");
      yield* fileSystem.writeFileString(rig, "1");
      yield* fileSystem.writeFileString(parts, "1");

      const watcher = yield* BlendFileWatcher.BlendFileWatcher;
      const changes = yield* watcher
        .changes([rig, parts, path.join(project, "missing", "gone.blend")])
        .pipe(Stream.toQueue({ capacity: "unbounded" }));
      // A folder that doesn't exist is skipped; watching still starts.
      yield* Queue.take(changes);

      // Blender writes `rig.blend@` and renames it over the file.
      yield* fileSystem.writeFileString(`${rig}@`, "2");
      yield* fileSystem.rename(`${rig}@`, rig);
      yield* Queue.take(changes);

      yield* fileSystem.writeFileString(parts, "2");
      expect(yield* Queue.take(changes)).toBeUndefined();
    }).pipe(Effect.provide(Layer.mergeAll(BlendFileWatcher.layer, NodeServices.layer))),
  );
});
