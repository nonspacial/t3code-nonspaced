import "~/index.css";

import { type BlendPreview, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  preview: null as unknown,
  queries: [] as unknown[],
  atoms: null as Map<unknown, unknown> | null,
  config: null as unknown,
}));

vi.mock(import("~/state/projects"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      // One atom per preview: a new one each render would never settle.
      readBlendPreview: (() => {
        const atoms = (state.atoms ??= new Map<unknown, unknown>());
        if (!atoms.has(state.preview)) {
          atoms.set(state.preview, Atom.make(AsyncResult.success(state.preview)));
        }
        return atoms.get(state.preview);
      }) as never,
      convertBlend: ((request: unknown) => ({ convertBlend: request })) as never,
    },
  };
});
vi.mock(import("~/state/revisionedQuery"), () => ({
  revisionedQuery: ((atom: unknown) => atom) as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((query: unknown) => {
    state.queries.push(query);
    return { data: null, error: null, refresh: () => undefined };
  }) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: (() =>
        (state.config ??= Atom.make({
          environment: { capabilities: { blendConversion: true } },
        }))) as never,
    },
  };
});

import { BlendFilePreview } from "./BlendFilePreview";

const previewOf = (byteLength: number): BlendPreview => ({
  relativePath: "scene.blend",
  byteLength,
  blenderVersion: "5.0",
  thumbnail: null,
  scene: null,
  scenes: 1,
  objects: 1,
  meshes: 1,
  materials: 0,
  libraries: [],
});

const preview = () => (
  <div className="flex h-100 w-150 flex-col">
    <BlendFilePreview
      environmentId={EnvironmentId.make("environment-1")}
      name="scene.blend"
      source={{
        kind: "file",
        cwd: "/work",
        relativePath: "scene.blend",
        workspaceMutationId: null,
        refreshRevision: 0,
      }}
    />
  </div>
);

const conversions = () => state.queries.filter((query) => query !== null);

it("converts a large .blend only when asked, once, saying it runs Blender", async () => {
  state.preview = previewOf(6 * 1024 * 1024 * 1024);
  state.queries = [];
  await using screen = await render(preview());
  await expect
    .element(screen.getByText("with Blender on the server", { exact: false }))
    .toBeInTheDocument();
  expect(conversions()).toEqual([]);
  await screen.getByRole("button", { name: "Show 3D view" }).click();
  expect(conversions().at(-1)).toMatchObject({
    convertBlend: { input: { relativePath: "scene.blend", once: true } },
  });
});

it("converts a smaller .blend as soon as its preview opens, watching it for changes", async () => {
  state.preview = previewOf(20 * 1024 * 1024);
  state.queries = [];
  await using screen = await render(preview());
  await expect.element(screen.getByText("Scene details")).toBeInTheDocument();
  expect(conversions().at(-1)).toEqual({
    convertBlend: {
      environmentId: "environment-1",
      input: { cwd: "/work", relativePath: "scene.blend" },
    },
  });
  await expect
    .element(screen.getByRole("button", { name: "Show 3D view" }))
    .not.toBeInTheDocument();
});
