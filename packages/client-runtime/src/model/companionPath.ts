import { mediaFileReference } from "../mediaReference.ts";

export type ModelCompanionPath =
  /** A `data:` or `blob:` URL the loader reads itself. */
  | { readonly _tag: "embedded" }
  | { readonly _tag: "file"; readonly path: string; readonly name: string }
  | { readonly _tag: "rejected"; readonly name: string };

/**
 * Resolves a file a model references (a glTF buffer or image, an OBJ material library, a
 * texture) against the model's folder. Only files in that folder or below resolve, and only when
 * the model is inside the workspace: URLs, absolute paths and `..` escapes are rejected, so a
 * model can never make the client fetch an arbitrary file or origin.
 */
export function resolveModelCompanionPath(input: {
  readonly reference: string;
  /** Absolute host path of the model. */
  readonly modelPath: string;
  readonly workspaceRoot: string | null;
}): ModelCompanionPath {
  const reference = input.reference.trim();
  if (/^(?:data|blob):/i.test(reference)) return { _tag: "embedded" };
  const name = decodeReference(reference).replaceAll("\\", "/");
  const rejected = { _tag: "rejected", name } as const;
  // A URL scheme or drive letter (`https:`, `file:`, `C:`), a rooted path or a UNC share.
  if (/^[a-z][a-z\d+.-]*:/i.test(name) || name.startsWith("/")) return rejected;
  if (
    input.workspaceRoot === null ||
    mediaFileReference(input.modelPath, input.workspaceRoot).relativePath === undefined
  )
    return rejected;
  const segments: string[] = [];
  for (const segment of name.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return rejected;
  }
  if (segments.length === 0) return rejected;
  const folderEnd = Math.max(input.modelPath.lastIndexOf("/"), input.modelPath.lastIndexOf("\\"));
  const separator = input.modelPath.includes("/") ? "/" : "\\";
  return {
    _tag: "file",
    path: `${input.modelPath.slice(0, folderEnd + 1)}${segments.join(separator)}`,
    name: segments.join("/"),
  };
}

// glTF URIs are percent-encoded; OBJ, MTL and FBX names are literal and rarely contain `%`.
function decodeReference(reference: string) {
  try {
    return decodeURIComponent(reference);
  } catch {
    return reference;
  }
}
