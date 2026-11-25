import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";
import { create } from "zustand";

import { useQuitHostedBlender } from "./useQuitHostedBlender";

interface QuitRequest {
  readonly id: number;
  readonly threadRef: ScopedThreadRef;
  readonly name: string;
  readonly dirty: boolean;
}

// The command palette closes as its action runs, so the quit and its dialog live outside it.
const useQuitRequestStore = create<{ readonly request: QuitRequest | null }>(() => ({
  request: null,
}));

/** Quits the thread's hosted Blender as the pane's Quit Blender does, asking first if unsaved. */
export function requestHostedBlenderQuit(
  threadRef: ScopedThreadRef,
  name: string,
  dirty: boolean,
): void {
  useQuitRequestStore.setState((state) => ({
    request: { id: (state.request?.id ?? 0) + 1, threadRef, name, dirty },
  }));
}

/** Where the palette's Quit hosted Blender asks and runs; mounted beside the palette. */
export function HostedBlenderQuitRequests() {
  const request = useQuitRequestStore((state) => state.request);
  return request === null ? null : <PaletteQuit key={request.id} {...request} />;
}

function PaletteQuit(props: QuitRequest) {
  const quit = useQuitHostedBlender(props.threadRef, props.name);
  const start = useEffectEvent(() => quit.request(props.dirty));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the quit the palette asked for once this, which outlives the palette, is mounted
  useEffect(() => {
    start();
  }, []);
  return quit.dialog;
}
