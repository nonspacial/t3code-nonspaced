import type * as Path from "effect/Path";

/** Where converted `.blend` GLBs are cached, inside T3's cache folder and never the project. */
export const blendCacheDir = (path: Path.Path, cacheRoot: string) =>
  path.join(cacheRoot, "blend-glb");

/** A cache entry is named by its key, so a signed URL can only ever name one of these. */
export const isBlendCacheFileName = (name: string) => /^[0-9a-f]{64}\.glb$/.test(name);
