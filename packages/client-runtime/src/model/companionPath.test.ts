import { describe, expect, it } from "vite-plus/test";

import { resolveModelCompanionPath } from "./companionPath.ts";

const workspaceRoot = "/work/project";
const modelPath = "/work/project/models/crate/crate.gltf";
const inCrate = (name: string) => ({
  _tag: "file",
  path: `/work/project/models/crate/${name}`,
  name,
});

describe("resolveModelCompanionPath", () => {
  it.each([
    { reference: "crate.bin", expected: inCrate("crate.bin") },
    { reference: "./textures/crate_diffuse.png", expected: inCrate("textures/crate_diffuse.png") },
    { reference: "textures\\wood.jpg", expected: inCrate("textures/wood.jpg") },
    { reference: "textures/../crate.bin", expected: inCrate("crate.bin") },
    { reference: "My%20Crate%20%231.png", expected: inCrate("My Crate #1.png") },
    { reference: "100%.png", expected: inCrate("100%.png") },
    { reference: "data:image/png;base64,AAAA", expected: { _tag: "embedded" } },
    { reference: "blob:http://localhost/1234", expected: { _tag: "embedded" } },
    {
      reference: "textures/wood.png",
      modelPath: "C:\\Projects\\shop\\models\\chair.obj",
      workspaceRoot: "C:\\Projects\\shop",
      expected: {
        _tag: "file",
        path: "C:\\Projects\\shop\\models\\textures\\wood.png",
        name: "textures/wood.png",
      },
    },
  ])(
    "resolves $reference inside the model's folder, leaving embedded data to the loader",
    ({ expected, ...input }) => {
      expect(resolveModelCompanionPath({ modelPath, workspaceRoot, ...input })).toEqual(expected);
    },
  );

  it.each([
    { label: "a sibling folder", reference: "../truck/wood.png" },
    { label: "a .. escape", reference: "../../../etc/passwd" },
    { label: "an encoded .. escape", reference: "%2e%2e/%2E%2E/secret.png" },
    { label: "an absolute path", reference: "/etc/passwd" },
    { label: "a Windows absolute path", reference: "C:\\Users\\sam\\Desktop\\wood.png" },
    { label: "a UNC share", reference: "\\\\server\\share\\wood.png" },
    { label: "a protocol-relative URL", reference: "//example.com/wood.png" },
    { label: "a remote URL", reference: "https://example.com/wood.png" },
    { label: "a file URL", reference: "file:///etc/passwd" },
    { label: "the model's own folder", reference: "textures/.." },
    {
      label: "a backslash escape, named as the model wrote it",
      reference: "..\\shared\\wood%20grain.png",
      name: "../shared/wood grain.png",
    },
    {
      label: "any file of a model with no workspace",
      reference: "crate.bin",
      workspaceRoot: null,
      name: "crate.bin",
    },
    {
      label: "any file of a model outside the workspace",
      reference: "crate.bin",
      workspaceRoot: "/work/other",
      name: "crate.bin",
    },
  ])("rejects $label", ({ label: _label, name, ...input }) => {
    const result = resolveModelCompanionPath({ modelPath, workspaceRoot, ...input });
    expect(result).toEqual(
      name === undefined
        ? expect.objectContaining({ _tag: "rejected" })
        : { _tag: "rejected", name },
    );
  });
});
