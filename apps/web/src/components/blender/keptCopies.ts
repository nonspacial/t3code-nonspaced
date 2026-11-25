import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  HostedBlenderKeptCopy,
  HostedBlenderMasterState,
  HostedBlenderThreadState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { create } from "zustand";

/** Which kept copy each thread's card shows; the newest until someone picks another. */
export const useKeptCopySelection = create<{
  readonly byThread: Readonly<Record<string, string>>;
  readonly select: (threadRef: ScopedThreadRef, key: string) => void;
}>((set) => ({
  byThread: {},
  select: (threadRef, key) =>
    set((state) => ({ byThread: { ...state.byThread, [scopedThreadKey(threadRef)]: key } })),
}));

/** The kept copy of a workspace file, if the thread's Blender left one for it. */
export const keptCopyOf = (
  state: HostedBlenderThreadState | HostedBlenderMasterState | null,
  relativePath: string,
): HostedBlenderKeptCopy | undefined =>
  state !== null && "copies" in state
    ? state.copies.find(
        (copy) => copy.file.kind === "workspace" && copy.file.relativePath === relativePath,
      )
    : undefined;

/** Shows that file's card first, when the thread keeps a copy of it. */
export const showKeptCopy = (
  threadRef: ScopedThreadRef,
  state: HostedBlenderThreadState | HostedBlenderMasterState | null,
  relativePath: string,
): boolean => {
  const copy = keptCopyOf(state, relativePath);
  if (copy === undefined) return false;
  useKeptCopySelection.getState().select(threadRef, copy.key);
  return true;
};
