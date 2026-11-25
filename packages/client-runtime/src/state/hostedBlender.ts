import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

// Unwatched Blender state lets go at once, as a conversion's does: a thread opened and left
// holds no stream.
const STATE_IDLE_TTL_MS = 1_000;

/**
 * The thread a chat view watches for a hosted Blender: none where the environment hasn't
 * switched Hosted Blender on, or before its settings are known, so nobody who never uses
 * Blender pays for a stream per thread opened.
 */
export const chatHostedBlenderThread = <T>(
  serverConfig:
    | { readonly settings: { readonly hostedBlenderEnabled: boolean } }
    | null
    | undefined,
  thread: T | null,
): T | null => (serverConfig?.settings.hostedBlenderEnabled === true ? thread : null);

export function createHostedBlenderEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  // Opening and quitting one thread's Blender run in order; other threads don't wait.
  const concurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: { readonly threadId: string };
    }) => JSON.stringify([environmentId, input.threadId]),
  };
  return {
    threadState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:hosted-blender:thread-state",
      idleTtlMs: STATE_IDLE_TTL_MS,
      tag: WS_METHODS.hostedBlenderSubscribeThread,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hosted-blender:open",
      tag: WS_METHODS.hostedBlenderOpen,
      scheduler,
      concurrency,
    }),
    quit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hosted-blender:quit",
      tag: WS_METHODS.hostedBlenderQuit,
      scheduler,
      concurrency,
    }),
    reopen: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hosted-blender:reopen",
      tag: WS_METHODS.hostedBlenderReopen,
      scheduler,
      concurrency,
    }),
    dismiss: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hosted-blender:dismiss",
      tag: WS_METHODS.hostedBlenderDismiss,
      scheduler,
      concurrency,
    }),
    runningBlenders: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:hosted-blender:running",
      idleTtlMs: STATE_IDLE_TTL_MS,
      tag: WS_METHODS.hostedBlenderSubscribeRunning,
    }),
    masterState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:hosted-blender:master-state",
      idleTtlMs: STATE_IDLE_TTL_MS,
      tag: WS_METHODS.hostedBlenderSubscribeMaster,
    }),
    openMaster: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hosted-blender:open-master",
      tag: WS_METHODS.hostedBlenderOpenMaster,
      scheduler,
      concurrency,
    }),
    moveIntoT3: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hosted-blender:move-into-t3",
      tag: WS_METHODS.hostedBlenderMoveIntoT3,
      scheduler,
      concurrency,
    }),
    captureView: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hosted-blender:capture-view",
      tag: WS_METHODS.hostedBlenderCaptureView,
    }),
    findHits: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hosted-blender:find-hits",
      tag: WS_METHODS.hostedBlenderFindHits,
    }),
    setView: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hosted-blender:set-view",
      tag: WS_METHODS.hostedBlenderSetView,
    }),
    setupState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:hosted-blender:setup-state",
      tag: WS_METHODS.hostedBlenderSubscribeSetup,
    }),
    checkSetup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hosted-blender:check-setup",
      tag: WS_METHODS.hostedBlenderCheckSetup,
    }),
    installWithAgent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hosted-blender:install-with-agent",
      tag: WS_METHODS.hostedBlenderInstallWithAgent,
    }),
  };
}
