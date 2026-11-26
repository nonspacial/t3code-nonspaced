import { HostedBlenderError, type HostedBlenderKeptFile, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

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

const isHostedBlenderError = Schema.is(HostedBlenderError);

/** A restore in place refused because it would replace unsaved changes nobody agreed to lose. */
export const isRestoreReplacingUnsaved = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return isHostedBlenderError(error) && error.reason === "restoreReplacesUnsaved";
};

/** A discard Blender didn't answer: it stays open, and the same discard again stops it. */
export const isDiscardUnconfirmed = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return isHostedBlenderError(error) && error.reason === "discardUnconfirmed";
};

/** A quit Blender didn't answer: it stays open, and the quit won't run later on its own. */
export const isQuitUnanswered = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return isHostedBlenderError(error) && error.reason === "quitUnanswered";
};

/**
 * An open refused while a Blender released before T3 Code restarted still writes its last copy of
 * that file, named as the person knows it; null for any other failure.
 */
export const stillSavingText = (
  cause: Cause.Cause<unknown>,
  name: string,
  resolve: MFunctionType = mFallback,
): string | null => {
  const error = Cause.squash(cause);
  return isHostedBlenderError(error) && error.reason === "stillSaving"
    ? resolve(
        msg(
          "Blender is still saving its last copy of {name} from before T3 Code restarted. Try again in a moment.",
          { name },
        ),
      )
    : null;
};

/** The scene changed since an annotation's picture, so its marks name no objects. */
export const isSceneChanged = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return isHostedBlenderError(error) && error.reason === "sceneChanged";
};

/** Unsaved edits outside the .blend held a quit; `images` names those a save couldn't write. */
export interface HeldQuit {
  readonly edits: "images" | "catalogs";
  readonly images: ReadonlyArray<string>;
}

export const heldQuitOf = (cause: Cause.Cause<unknown>): HeldQuit | null => {
  const error = Cause.squash(cause);
  if (!isHostedBlenderError(error)) return null;
  if (error.reason === "unsavedImages") return { edits: "images", images: error.images ?? [] };
  if (error.reason === "unsavedCatalogs") return { edits: "catalogs", images: [] };
  return null;
};

/** A file's name as the pane shows it; `untitled` for an unsaved scene. */
export const blendFileName = (file: HostedBlenderKeptFile, untitled: string): string => {
  if (file.kind === "untitled") return untitled;
  const path = file.kind === "workspace" ? file.relativePath : file.path;
  return path.slice(path.lastIndexOf("/") + 1);
};

/** The file a running hosted Blender has open now, which its quit names: once Blender has said. */
export const quitFileOf = (state: {
  readonly relativePath: string;
  readonly openFile?: HostedBlenderKeptFile | undefined;
}): HostedBlenderKeptFile =>
  state.openFile ?? { kind: "workspace", relativePath: state.relativePath };

/**
 * Opening and quitting one thread's Blender run in order; other threads don't wait. Quit without
 * saving must reach a Blender whose Save and quit is stuck in it, so a discard runs beside that
 * lane rather than behind it.
 */
export const hostedBlenderLane = ({
  environmentId,
  input,
}: {
  environmentId: string;
  input: { readonly threadId: string; readonly discard?: boolean | undefined };
}) =>
  JSON.stringify([environmentId, input.threadId, ...(input.discard === true ? ["discard"] : [])]);

export function createHostedBlenderEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = { mode: "serial" as const, key: hostedBlenderLane };
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
    setTimeline: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hosted-blender:set-timeline",
      tag: WS_METHODS.hostedBlenderSetTimeline,
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
