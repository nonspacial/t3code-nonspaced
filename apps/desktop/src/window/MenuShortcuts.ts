// The web contents whose renderer gives the whole keyboard to a hosted Blender: their menu
// accelerators (Ctrl+N, Ctrl+W…) must not fire, so the keys reach Blender instead.
const ignoring = new Set<number>();

export const setIgnored = (webContentsId: number, ignored: boolean): void => {
  if (ignored) ignoring.add(webContentsId);
  else ignoring.delete(webContentsId);
};

export const isIgnored = (webContentsId: number): boolean => ignoring.has(webContentsId);
