import { create } from "zustand";

/**
 * The large `.blend` files someone chose Show 3D view for, this session. Kept here, not in the
 * preview, which unmounts whenever the panel shows something else.
 */
export const useBlendConversionAsks = create<{
  readonly asked: Readonly<Record<string, true>>;
  readonly ask: (file: string) => void;
}>((set) => ({
  asked: {},
  ask: (file) => set((state) => ({ asked: { ...state.asked, [file]: true } })),
}));

export const blendConversionAskKey = (environmentId: string, cwd: string, relativePath: string) =>
  JSON.stringify([environmentId, cwd, relativePath]);
