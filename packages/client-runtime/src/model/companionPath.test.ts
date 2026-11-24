import { describe, expect, it } from "vite-plus/test";

import { resolveModelCompanionPath } from "./companionPath.ts";

const workspaceRoot = "/work/project";
const modelPath = "/work/project/models/crate/crate.gltf";
const resolve = (reference: string) =>
  resolveModelCompanionPath({ reference, modelPath, workspaceRoot });

describe("resolveModelCompanionPath", () => {
  it.each([
    ["crate.bin", "crate.bin"],
    ["./textures/crate_diffuse.png", "textures/crate_diffuse.png"],
    ["textures\\wood.jpg", "textures/wood.jpg"],
    ["textures/../crate.bin", "crate.bin"],
    ["My%20Crate%20%231.png", "My Crate #1.png"],
    ["100%.png", "100%.png"],
  ])("resolves %s inside the model's folder", (reference, name) => {
    expect(resolve(reference)).toEqual({
      _tag: "file",
      path: `/work/project/models/crate/${name}`,
      name,
    });
  });

  it.each([
    ["a sibling folder", "../truck/wood.png"],
    ["a .. escape", "../../../etc/passwd"],
    ["an encoded .. escape", "%2e%2e/%2E%2E/secret.png"],
    ["an absolute path", "/etc/passwd"],
    ["a Windows absolute path", "C:\\Users\\sam\\Desktop\\wood.png"],
    ["a UNC share", "\\\\server\\share\\wood.png"],
    ["a protocol-relative URL", "//example.com/wood.png"],
    ["a remote URL", "https://example.com/wood.png"],
    ["a file URL", "file:///etc/passwd"],
    ["the model's own folder", "textures/.."],
  ])("rejects %s", (_label, reference) => {
    expect(resolve(reference)._tag).toBe("rejected");
  });

  it("names a rejected reference as the model wrote it", () => {
    expect(resolve("..\\shared\\wood%20grain.png")).toEqual({
      _tag: "rejected",
      name: "../shared/wood grain.png",
    });
  });

  it("leaves embedded data to the loader", () => {
    expect(resolve("data:image/png;base64,AAAA")).toEqual({ _tag: "embedded" });
    expect(resolve("blob:http://localhost/1234")).toEqual({ _tag: "embedded" });
  });

  it("rejects every file a model outside the workspace references", () => {
    for (const workspace of [null, "/work/other"]) {
      expect(
        resolveModelCompanionPath({ reference: "crate.bin", modelPath, workspaceRoot: workspace }),
      ).toEqual({ _tag: "rejected", name: "crate.bin" });
    }
  });

  it("joins Windows host paths with the model's separator", () => {
    expect(
      resolveModelCompanionPath({
        reference: "textures/wood.png",
        modelPath: "C:\\Projects\\shop\\models\\chair.obj",
        workspaceRoot: "C:\\Projects\\shop",
      }),
    ).toEqual({
      _tag: "file",
      path: "C:\\Projects\\shop\\models\\textures\\wood.png",
      name: "textures/wood.png",
    });
  });
});
