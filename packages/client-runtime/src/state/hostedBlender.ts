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
      tag: WS_METHODS.hostedBlenderSubscribeRunning,
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
