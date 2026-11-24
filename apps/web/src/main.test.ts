import { expect, it, vi } from "vite-plus/test";

vi.mock("./appInit", () => ({ startAppServices: () => ({ load: async () => {} }) }));
vi.mock("./AppRoot", () => ({ AppRoot: () => null }));
vi.mock("./i18n/runtime", () => ({ whenLocaleReady: async () => {} }));
vi.mock("react-dom/client", () => ({ default: { createRoot: () => ({ render: () => {} }) } }));

// Boots the entry in a fresh page that shares the tab's sessionStorage, as a reload does.
async function bootThenFailLazyChunk(sessionStorage: Map<string, string>) {
  vi.resetModules();
  const reload = vi.fn().mockName("location.reload");
  const page = Object.assign(new EventTarget(), {
    sessionStorage: {
      getItem: (key: string) => sessionStorage.get(key) ?? null,
      setItem: (key: string, value: string) => sessionStorage.set(key, value),
      removeItem: (key: string) => sessionStorage.delete(key),
    },
    location: { reload },
  });
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", { getElementById: () => ({}) });
  try {
    const { boot } = await import("./bootstrap");
    await boot;
    page.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    return reload;
  } finally {
    vi.unstubAllGlobals();
  }
}

it("reloads only once when a lazy chunk fails after every boot", async () => {
  const sessionStorage = new Map<string, string>();

  expect(await bootThenFailLazyChunk(sessionStorage)).toHaveBeenCalledTimes(1);
  expect(await bootThenFailLazyChunk(sessionStorage)).not.toHaveBeenCalled();
});

it("installs keyboard capture when it boots without HMR, as production builds do", async () => {
  vi.resetModules();
  const page = new EventTarget();
  const install = vi.spyOn(page, "addEventListener");
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", { getElementById: () => ({}) });
  try {
    // Vitest has no `import.meta.hot`, so this is the path a production bundle takes.
    await import("./main");
    expect(install).toHaveBeenCalledWith("keydown", expect.any(Function), true);
    expect(install).toHaveBeenCalledWith("keyup", expect.any(Function), true);
  } finally {
    vi.unstubAllGlobals();
  }
});
