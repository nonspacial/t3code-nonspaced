/** The title Blender gives a window holding a single 3D Viewport area. */
const VIEWPORT_WINDOW_TITLE = "3D Viewport";

export interface BlenderLaunch {
  readonly stateDir: string;
  /** T3's copy of the user's Blender settings, used as `BLENDER_USER_RESOURCES`. */
  readonly userResources: string;
  readonly blender: string;
  readonly addonPath: string;
  readonly blendPath: string;
  readonly controlSocket: string;
  readonly mcpPort: number;
  /** A recovery copy or autosave the control add-on restores over `blendPath`. */
  readonly recover?: string | null;
  /** `blendPath`'s revision before Blender reads it, to tell a later change on disk. */
  readonly revision?: string | null;
  /** The official add-on listens on `mcpPort` for the thread's agent; otherwise it stays off. */
  readonly mcpListen?: boolean;
  /** The launch's own copy of Blender Lab's extension, the only one its grant may load. */
  readonly mcpSnapshot?: string;
  /** Embedded scripts follow the user's "Auto Run Python Scripts"; otherwise they are forced off. */
  readonly autoRun?: boolean;
  readonly width: number;
  readonly height: number;
}

/**
 * The hidden display helper's command line. The helper sets Blender's private `TMPDIR` and
 * `BLENDER_USER_RESOURCES` itself, because labwc drops `TMPDIR` from programs it starts.
 */
export const helperArguments = (launch: BlenderLaunch): ReadonlyArray<string> => [
  "--state-dir",
  launch.stateDir,
  "--user-resources",
  launch.userResources,
  "--window-title",
  VIEWPORT_WINDOW_TITLE,
  "--width",
  String(launch.width),
  "--height",
  String(launch.height),
  "--",
  launch.blender,
  // The official MCP add-on only starts with online access.
  "--online-mode",
  "-noaudio",
  // Only full-access threads let scripts embedded in the file follow the user's setting.
  ...(launch.autoRun === true ? [] : ["--disable-autoexec"]),
  // A file on the command line also keeps the splash screen away.
  launch.blendPath,
  "--python",
  launch.addonPath,
  "--",
  "--t3-control",
  launch.controlSocket,
  "--t3-mcp-port",
  String(launch.mcpPort),
  ...(launch.revision ? ["--t3-revision", launch.revision] : []),
  ...(launch.recover ? ["--t3-recover", launch.recover] : []),
  ...(launch.mcpListen === true ? ["--t3-mcp-listen"] : []),
  ...(launch.mcpSnapshot === undefined ? [] : ["--t3-mcp-snapshot", launch.mcpSnapshot]),
];

/**
 * The helper's environment. T3's own variables never reach labwc or Blender, and neither do
 * `BLENDER_USER_*` overrides that could point a hosted Blender back at desktop settings.
 */
export const helperEnvironment = (
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(parent).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith("T3CODE_") &&
        !entry[0].startsWith("BLENDER_USER_"),
    ),
  );

/** The newest `<major>.<minor>` folder in `~/.config/blender`, whose settings T3 copies. */
export const newestBlenderConfigVersion = (entries: ReadonlyArray<string>): string | undefined => {
  const versions = entries
    .map((entry) => ({ entry, match: /^(\d+)\.(\d+)$/.exec(entry) }))
    .filter((version) => version.match !== null)
    .map(({ entry, match }) => ({ entry, major: Number(match![1]), minor: Number(match![2]) }))
    .toSorted((a, b) => b.major - a.major || b.minor - a.minor);
  return versions[0]?.entry;
};

const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;

/** A viewer's pane size as a display size: clamped, and even for H.264 4:2:0. */
export const displaySize = (width: number, height: number) => {
  const even = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(value))) & ~1;
  return { width: even(width, MIN_WIDTH, MAX_WIDTH), height: even(height, MIN_HEIGHT, MAX_HEIGHT) };
};

// The helper keeps its Wayland runtime beside the control socket only under a parent this short.
const HELPER_RUNTIME_PARENT_MAX = 64;
const CONTROL_DIR_NAME_LENGTH = "/t3hb-XXXXXX".length;

/** Where a launch's private control and runtime folder goes, so the helper never falls back. */
export const runtimeParent = (xdgRuntimeDir: string | undefined): string =>
  xdgRuntimeDir?.startsWith("/") &&
  // The helper and the socket path limit count UTF-8 bytes, not characters.
  Buffer.byteLength(xdgRuntimeDir) + CONTROL_DIR_NAME_LENGTH <= HELPER_RUNTIME_PARENT_MAX
    ? xdgRuntimeDir
    : "/tmp";
