import type { HostedBlenderRole, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";

/** Which of a thread's Blenders its pane shows: a link to the master's file picks the master. */
export const useBlenderRoleStore = create<{
  readonly roles: Readonly<Record<string, HostedBlenderRole>>;
  readonly setRole: (threadRef: ScopedThreadRef, role: HostedBlenderRole) => void;
}>()((set) => ({
  roles: {},
  setRole: (threadRef, role) =>
    set((state) => ({ roles: { ...state.roles, [scopedThreadKey(threadRef)]: role } })),
}));

export const blenderRoleFor = (threadRef: ScopedThreadRef): HostedBlenderRole =>
  useBlenderRoleStore.getState().roles[scopedThreadKey(threadRef)] ?? "working";
