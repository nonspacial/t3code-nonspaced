import type { HostedBlenderThreadState } from "@t3tools/contracts";

/** The thread's hosted Blender, when there is one to watch; watching needs only read access. */
export function watchableHostedBlender(
  state: HostedBlenderThreadState | null,
): { readonly fileName: string } | null {
  if (state?.status !== "running" && state?.status !== "starting") return null;
  return { fileName: state.relativePath.slice(state.relativePath.lastIndexOf("/") + 1) };
}
