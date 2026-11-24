import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import { readLatest } from "./hostedBlender";

it("reads a live subscription's latest value, though its stream never ends", async () => {
  const registry = AtomRegistry.make();
  const live = Atom.make(Stream.concat(Stream.make("running"), Stream.never));
  await expect(readLatest(registry, live, "1 second")).resolves.toBe("running");
});
