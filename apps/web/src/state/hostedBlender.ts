import { useAtomValue } from "@effect/atom-react";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import { createHostedBlenderEnvironmentAtoms } from "@t3tools/client-runtime/state/hosted-blender";
import {
  type EnvironmentId,
  HOSTED_BLENDER_STREAM_PATH,
  type HostedBlenderRunningList,
  type HostedBlenderThreadState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useMessages } from "gt-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery } from "./query";
import { environmentSession } from "./session";

export const hostedBlenderEnvironment = createHostedBlenderEnvironmentAtoms(connectionAtomRuntime);

/** The thread's hosted Blender, or null until the server answers. */
export function useHostedBlenderState(
  threadRef: ScopedThreadRef | null,
): HostedBlenderThreadState | null {
  const resolve = useMessages();
  return useEnvironmentQuery(
    threadRef === null
      ? null
      : hostedBlenderEnvironment.threadState({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
    resolve,
  ).data;
}

/** Every hosted Blender on the environment, or null until the server answers. */
export function useRunningHostedBlenders(
  environmentId: EnvironmentId | null,
): HostedBlenderRunningList | null {
  const resolve = useMessages();
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : hostedBlenderEnvironment.runningBlenders({ environmentId, input: {} }),
    resolve,
  ).data;
}

const streamAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: HOSTED_BLENDER_STREAM_PATH });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`hosted-blender-stream-access:${environmentId}`)),
);

export function useHostedBlenderStreamAccess(environmentId: EnvironmentId): DeviceHubAccess | null {
  const result = useAtomValue(streamAccessAtom(environmentId));
  return AsyncResult.isSuccess(result) ? result.value : null;
}

/** A refused upgrade means the ticket expired; this mints a fresh one. */
export function refreshHostedBlenderStreamAccess(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(streamAccessAtom(environmentId));
}

/** Reads the thread's hosted Blender once, for a click; null when the server doesn't answer. */
export function readHostedBlenderState(
  threadRef: ScopedThreadRef,
): Promise<HostedBlenderThreadState | null> {
  const atom = hostedBlenderEnvironment.threadState({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}
