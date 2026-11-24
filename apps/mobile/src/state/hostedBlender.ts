import { resolveDeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import { createHostedBlenderEnvironmentAtoms } from "@t3tools/client-runtime/state/hosted-blender";
import { type EnvironmentId, HOSTED_BLENDER_STREAM_PATH, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { environmentSession, usePreparedConnection } from "./session";

export const hostedBlenderEnvironment = createHostedBlenderEnvironmentAtoms(connectionAtomRuntime);

/** The thread's hosted Blender, or null until the server answers. */
export function useHostedBlenderState(
  thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
) {
  return useEnvironmentQuery(
    thread === null
      ? null
      : hostedBlenderEnvironment.threadState({
          environmentId: thread.environmentId,
          input: { threadId: thread.threadId },
        }),
  );
}

// As the device hub's: each viewer resolves its own ticket, so a return to the screen never
// reuses one an earlier connection already spent.
const streamAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((_viewer: string) =>
    connectionAtomRuntime
      .atom((get) => {
        const prepared = Option.getOrNull(
          get(environmentSession.preparedConnectionValueAtom(environmentId)),
        );
        return prepared === null
          ? Effect.never
          : resolveDeviceHubAccess({ prepared, hubBasePath: HOSTED_BLENDER_STREAM_PATH });
      })
      .pipe(Atom.withLabel(`mobile-hosted-blender-stream-access:${environmentId}`)),
  ),
);

export function useHostedBlenderStreamAccess(environmentId: EnvironmentId, viewer: string) {
  const prepared = usePreparedConnection(environmentId);
  const query = useEnvironmentQuery(streamAccessAtom(environmentId)(viewer));
  const access = query.data && query.error === null && Option.isSome(prepared) ? query.data : null;
  return { access, error: query.error, refresh: query.refresh };
}
