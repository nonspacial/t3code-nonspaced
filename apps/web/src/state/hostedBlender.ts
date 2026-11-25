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
  HostedBlenderError,
  type HostedBlenderMasterState,
  type HostedBlenderRole,
  type HostedBlenderSetupState,
  type HostedBlenderThreadState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { ModelView } from "@t3tools/shared/modelView";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useMessages } from "gt-react";
import type * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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

/** The thread's master file and where it is open, or null until the server answers. */
export function useHostedBlenderMasterState(
  threadRef: ScopedThreadRef | null,
): HostedBlenderMasterState | null {
  const resolve = useMessages();
  return useEnvironmentQuery(
    threadRef === null
      ? null
      : hostedBlenderEnvironment.masterState({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
    resolve,
  ).data;
}

/** The environment's hosted Blender setup; subscribing starts the first check. */
export function useHostedBlenderSetupState(
  environmentId: EnvironmentId | null,
): HostedBlenderSetupState | null {
  const resolve = useMessages();
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : hostedBlenderEnvironment.setupState({ environmentId, input: {} }),
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
  return readLatest(appAtomRegistry, atom, "5 seconds");
}

/** Reads the thread's master once, for a click; null when the server doesn't answer. */
export function readHostedBlenderMasterState(
  threadRef: ScopedThreadRef,
): Promise<HostedBlenderMasterState | null> {
  const atom = hostedBlenderEnvironment.masterState({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  return readLatest(appAtomRegistry, atom, "5 seconds");
}

/**
 * An atom's latest value, or null when it fails or none comes in time. A subscription's
 * values stay `waiting` for as long as its stream runs, so waiting values count.
 */
export function readLatest<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  timeout: Duration.Input,
): Promise<A | null> {
  return Effect.runPromise(
    AtomRegistry.getResult(registry, atom).pipe(
      Effect.timeout(timeout),
      Effect.orElseSucceed(() => null),
    ),
  );
}

const isHostedBlenderError = Schema.is(HostedBlenderError);

/** A restore in place refused because it would replace unsaved changes nobody agreed to lose. */
export const isRestoreReplacingUnsaved = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return isHostedBlenderError(error) && error.reason === "restoreReplacesUnsaved";
};

/** A discard refused because Blender has another file open than the one its dialog named. */
export const isOpenFileChanged = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return isHostedBlenderError(error) && error.reason === "openFileChanged";
};

/**
 * Moves the person's viewport window to a view link's camera on `relativePath`. A Blender still
 * starting, or a person who may only watch, leaves the view where it is; `otherFile` means the
 * Blender no longer has that file open.
 */
export async function setHostedBlenderView(
  threadRef: ScopedThreadRef,
  relativePath: string,
  view: ModelView,
  role: HostedBlenderRole = "working",
): Promise<"moved" | "otherFile" | "failed"> {
  const result = await runAtomCommand(
    appAtomRegistry,
    hostedBlenderEnvironment.setView,
    {
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        relativePath,
        view,
        ...(role === "master" ? { role } : {}),
      },
    },
    { reportFailure: false },
  );
  if (result._tag === "Success") return "moved";
  const error = Cause.squash(result.cause);
  return isHostedBlenderError(error) && error.reason === "otherFileOpen" ? "otherFile" : "failed";
}
