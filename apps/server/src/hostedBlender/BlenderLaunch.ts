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
  // Scripts embedded in the file stay off: B5 decides when a thread may run them.
  "--disable-autoexec",
  // A file on the command line also keeps the splash screen away.
  launch.blendPath,
  "--python",
  launch.addonPath,
  "--",
  "--t3-control",
  launch.controlSocket,
  "--t3-mcp-port",
  String(launch.mcpPort),
];

/** The helper's environment: T3's own variables never reach labwc or Blender. */
export const helperEnvironment = (
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(parent).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("T3CODE_"),
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
