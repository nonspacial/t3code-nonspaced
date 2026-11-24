// @effect-diagnostics nodeBuiltinImport:off - one native watch per folder, filtered by name in its callback.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** Blender saves to `name.blend@` and renames it over the file, so one save is several events. */
const SETTLE = Duration.millis(250);

// Libraries can sit outside the workspace, where no workspace change event would report them.
export class BlendFileWatcher extends Context.Service<
  BlendFileWatcher,
  {
    /**
     * Emits once watching has started, then whenever any of these files may have changed.
     * Files are watched through their folders, so a save that replaces a file is still seen;
     * a folder that cannot be watched is skipped.
     */
    readonly changes: (files: ReadonlyArray<string>) => Stream.Stream<void>;
  }
>()("t3/blend/BlendFileWatcher") {}

const changes = (files: ReadonlyArray<string>) => {
  const namesByFolder = new Map<string, Set<string>>();
  for (const file of files) {
    const folder = NodePath.dirname(file);
    const names = namesByFolder.get(folder) ?? new Set<string>();
    names.add(NodePath.basename(file));
    namesByFolder.set(folder, names);
  }
  const events = Stream.callback<void>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const watchers: Array<NodeFS.FSWatcher> = [];
          for (const [folder, names] of namesByFolder) {
            try {
              const watcher = NodeFS.watch(folder, { persistent: false }, (_, name) => {
                if (name === null || names.has(name)) Queue.offerUnsafe(queue, undefined);
              });
              // A folder that goes away ends its watch; the other files are still watched.
              watcher.on("error", () => watcher.close());
              watchers.push(watcher);
            } catch {
              // Missing or unreadable: its files can't be seen changing, so they don't count.
            }
          }
          // Compared once now, for any change made before the watches began.
          Queue.offerUnsafe(queue, undefined);
          return watchers;
        }),
        (watchers) => Effect.sync(() => watchers.forEach((watcher) => watcher.close())),
      ),
    { bufferSize: 1, strategy: "sliding" },
  );
  return events.pipe(Stream.debounce(SETTLE));
};

export const layer = Layer.succeed(BlendFileWatcher, BlendFileWatcher.of({ changes }));
