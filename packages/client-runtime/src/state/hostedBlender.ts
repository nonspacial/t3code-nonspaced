import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

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
    masterState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:hosted-blender:master-state",
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
