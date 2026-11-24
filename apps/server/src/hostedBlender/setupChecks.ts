import type {
  HostedBlenderPackageManager,
  HostedBlenderSetupCheck,
  HostedBlenderSetupItem,
  HostedBlenderSetupResult,
} from "@t3tools/contracts";

// The oldest Blender LTS still supported; raise it when that LTS reaches end of life.
const MIN_BLENDER = "4.5";
const MIN_GSTREAMER = "1.24";
// labwc 0.9 added ext-image-copy-capture; older releases only offer wlr-screencopy.
const EXT_CAPTURE_LABWC = "0.9";
const BLENDER_MCP_PACKAGE = "git+https://projects.blender.org/lab/blender_mcp.git#subdirectory=mcp";

/** What the pane cannot run without. The GPU and the Blender MCP only warn. */
const BLOCKING: ReadonlySet<HostedBlenderSetupItem> = new Set([
  "helper",
  "blender",
  "labwc",
  "gstreamer",
  "encoder",
  "glupload",
]);

export interface OsRelease {
  readonly id: string;
  readonly idLike: ReadonlyArray<string>;
  readonly versionId: string | null;
  readonly prettyName: string | null;
}

/** Everything the setup check found on the host, before it is judged. */
export interface SetupFacts {
  readonly platform: NodeJS.Platform;
  /** The helper's path, null when it is missing, `unsupported` when T3 ships none for this host. */
  readonly helper: string | null | "unsupported";
  readonly osRelease: OsRelease | null;
  readonly blender: {
    readonly path: string;
    readonly realPath: string;
    readonly version: string;
  } | null;
  readonly labwcVersion: string | null;
  readonly gstreamerVersion: string | null;
  /** The encoder the helper's test encode kept, null when none worked or it couldn't run. */
  readonly encoder: string | null;
  readonly nvidia: boolean;
  readonly glupload: boolean;
  readonly renderNodes: { readonly total: number; readonly accessible: number };
  readonly blenderMcp: string | null;
}

export type CheckedSetup = Extract<HostedBlenderSetupResult, { status: "checked" }>;

const versionPattern = (prefix: string) =>
  new RegExp(`(?:^|\\n)${prefix} (\\d+\\.\\d+(?:\\.\\d+)?)`);

export const parseLabwcVersion = (stdout: string): string | null =>
  versionPattern("labwc").exec(stdout)?.[1] ?? null;

/** `gst-inspect-1.0 --version` prints its own version, then a "GStreamer x.y.z" line. */
export const parseGstreamerVersion = (stdout: string): string | null =>
  versionPattern("GStreamer").exec(stdout)?.[1] ?? null;

export const parseOsRelease = (text: string): OsRelease => {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) fields.set(match[1]!, match[2]!.replace(/^(["'])(.*)\1$/, "$2"));
  }
  return {
    id: fields.get("ID") ?? "",
    idLike: (fields.get("ID_LIKE") ?? "").split(/\s+/).filter(Boolean),
    versionId: fields.get("VERSION_ID") ?? null,
    prettyName: fields.get("PRETTY_NAME") ?? null,
  };
};

const atLeast = (version: string, minimum: string) => {
  const parts = version.split(".").map(Number);
  const floor = minimum.split(".").map(Number);
  for (let index = 0; index < floor.length; index++) {
    const part = parts[index] ?? 0;
    if (part !== floor[index]) return part > floor[index]!;
  }
  return true;
};

const family = (release: OsRelease) => [release.id, ...release.idLike];

const packageManagerFor = (release: OsRelease | null): HostedBlenderPackageManager | null => {
  if (release === null) return null;
  const ids = family(release);
  if (ids.includes("arch")) return "pacman";
  if (ids.some((id) => id === "fedora" || id === "rhel")) return "dnf";
  if (ids.some((id) => id === "debian" || id === "ubuntu")) return "apt";
  return null;
};

/** Ubuntu 22.04 and Debian 12 ship a labwc and GStreamer too old to run a hosted Blender. */
const tooOldDistro = (release: OsRelease | null) => {
  if (release?.versionId == null) return false;
  if (release.id === "ubuntu") return !atLeast(release.versionId, "24.04");
  if (release.id === "debian") return !atLeast(release.versionId, "13");
  return false;
};

const isSandboxed = (blender: NonNullable<SetupFacts["blender"]>) =>
  [blender.path, blender.realPath].some(
    (path) => path.startsWith("/snap/") || path.includes("/flatpak/"),
  );

const check = (
  item: HostedBlenderSetupItem,
  status: HostedBlenderSetupCheck["status"],
  found?: string | null,
): HostedBlenderSetupCheck => (found == null ? { item, status } : { item, status, found });

const PACKAGES: Record<
  HostedBlenderPackageManager,
  { readonly install: string; readonly packages: Partial<Record<string, ReadonlyArray<string>>> }
> = {
  pacman: {
    install: "sudo pacman -S --needed",
    packages: {
      blender: ["blender"],
      labwc: ["labwc"],
      gstreamer: [
        "gstreamer",
        "gst-plugins-base",
        "gst-plugins-good",
        "gst-plugins-bad",
        "gst-plugins-ugly",
        "gst-plugin-va",
      ],
      glupload: ["gst-plugins-base"],
    },
  },
  apt: {
    install: "sudo apt install",
    packages: {
      blender: ["blender"],
      labwc: ["labwc"],
      gstreamer: [
        "gstreamer1.0-tools",
        "gstreamer1.0-plugins-base",
        "gstreamer1.0-plugins-good",
        "gstreamer1.0-plugins-bad",
        "gstreamer1.0-plugins-ugly",
      ],
      glupload: ["gstreamer1.0-gl"],
    },
  },
  dnf: {
    install: "sudo dnf install",
    packages: {
      blender: ["blender"],
      labwc: ["labwc"],
      gstreamer: [
        "gstreamer1",
        "gstreamer1-plugins-base",
        "gstreamer1-plugins-good",
        "gstreamer1-plugins-bad-free",
        "gstreamer1-plugin-openh264",
      ],
      glupload: ["gstreamer1-plugins-base"],
    },
  },
};

/** Copyable commands for what is missing. T3 shows them; it never runs them. */
const installCommands = (
  packageManager: HostedBlenderPackageManager | null,
  checks: ReadonlyArray<HostedBlenderSetupCheck>,
): ReadonlyArray<string> => {
  const needs = (item: HostedBlenderSetupItem, ...statuses: HostedBlenderSetupCheck["status"][]) =>
    checks.some((entry) => entry.item === item && statuses.includes(entry.status));
  const commands: string[] = [];
  if (needs("helper", "missing")) {
    commands.push(
      "# T3 Code's hidden display helper ships with T3 Code: update or reinstall T3 Code.",
      "# In a T3 Code checkout, build it with: vp run build:hidden-display",
    );
  }
  if (packageManager !== null) {
    const { install, packages } = PACKAGES[packageManager];
    const wanted = new Set<string>();
    if (needs("blender", "missing")) for (const name of packages.blender ?? []) wanted.add(name);
    if (needs("labwc", "missing")) for (const name of packages.labwc ?? []) wanted.add(name);
    if (needs("gstreamer", "missing", "outdated") || needs("encoder", "missing")) {
      for (const name of packages.gstreamer ?? []) wanted.add(name);
    }
    if (needs("glupload", "missing")) for (const name of packages.glupload ?? []) wanted.add(name);
    if (wanted.size > 0) commands.push(`${install} ${[...wanted].join(" ")}`);
  }
  if (
    needs("blender", "outdated") ||
    (needs("blender", "missing") && packageManager !== "pacman")
  ) {
    commands.push(
      `# If your distro's Blender is older than ${MIN_BLENDER}, download Blender from https://www.blender.org/download/`,
      "# and set its path in Settings › General › 3D previews.",
    );
  }
  if (needs("gpu", "missing")) {
    commands.push(
      'sudo usermod -aG render,video "$USER"',
      "# Then log out and back in, and restart T3 Code.",
    );
  }
  if (needs("blenderMcp", "missing")) {
    commands.push(
      "# The official Blender Lab MCP server (needs uv; `pipx install` works too):",
      `uv tool install "${BLENDER_MCP_PACKAGE}"`,
    );
  }
  return commands;
};

export const evaluateSetup = (
  facts: SetupFacts,
): Exclude<HostedBlenderSetupResult, CheckedSetup> | Omit<CheckedSetup, "checkedAt"> => {
  const distro = facts.osRelease?.prettyName ?? (facts.osRelease?.id || null);
  if (facts.platform !== "linux" || facts.helper === "unsupported") {
    return { status: "unavailable", reason: "platform", distro: null };
  }
  if (tooOldDistro(facts.osRelease)) return { status: "unavailable", reason: "distro", distro };
  if (facts.blender !== null && isSandboxed(facts.blender)) {
    return { status: "unavailable", reason: "sandboxedBlender", distro };
  }

  const gstreamerOk =
    facts.gstreamerVersion !== null && atLeast(facts.gstreamerVersion, MIN_GSTREAMER);
  const checks: HostedBlenderSetupCheck[] = [
    check("helper", facts.helper === null ? "missing" : "ok"),
    facts.blender === null
      ? check("blender", "missing")
      : check(
          "blender",
          atLeast(facts.blender.version, MIN_BLENDER) ? "ok" : "outdated",
          facts.blender.version,
        ),
    check("labwc", facts.labwcVersion === null ? "missing" : "ok", facts.labwcVersion),
    facts.gstreamerVersion === null
      ? check("gstreamer", "missing")
      : check("gstreamer", gstreamerOk ? "ok" : "outdated", facts.gstreamerVersion),
    check("encoder", facts.encoder === null ? "missing" : "ok", facts.encoder),
    ...(facts.nvidia ? [check("glupload", facts.glupload ? "ok" : "missing")] : []),
    facts.renderNodes.total === 0
      ? check("gpu", "warning")
      : check("gpu", facts.renderNodes.accessible > 0 ? "ok" : "missing"),
    check("blenderMcp", facts.blenderMcp === null ? "missing" : "ok", facts.blenderMcp),
  ];
  const packageManager = packageManagerFor(facts.osRelease);
  return {
    status: "checked",
    ready: checks.every((entry) => !BLOCKING.has(entry.item) || entry.status === "ok"),
    checks,
    distro,
    packageManager,
    capture:
      facts.labwcVersion === null
        ? null
        : atLeast(facts.labwcVersion, EXT_CAPTURE_LABWC)
          ? "ext-image-copy-capture"
          : "wlr-screencopy",
    commands: installCommands(packageManager, checks),
  };
};

/** Something "Install with an agent" could fix. */
export const needsInstall = (result: Pick<CheckedSetup, "checks">) =>
  result.checks.some((entry) => entry.status === "missing" || entry.status === "outdated");

const ITEM_NAMES: Record<HostedBlenderSetupItem, string> = {
  helper: "T3 Code's hidden display helper",
  blender: `Blender ${MIN_BLENDER} or later (not a Flatpak or Snap build)`,
  labwc: "labwc (0.9 or later is best; older versions use wlr-screencopy)",
  gstreamer: `GStreamer ${MIN_GSTREAMER} or later with gst-inspect-1.0`,
  encoder:
    "a working GStreamer H.264 encoder: nvh264enc, vah264enc, x264enc or openh264enc (the plugin packages)",
  glupload: "GStreamer's OpenGL plugin (glupload), for the NVIDIA encoder",
  gpu: "access to the GPU's render node (/dev/dri/renderD*), usually the render and video groups",
  blenderMcp: `the official Blender Lab MCP server, \`blender-mcp\` (${BLENDER_MCP_PACKAGE})`,
};

/** The first message of the "Install with an agent" thread. */
export const installPrompt = (result: Omit<CheckedSetup, "checkedAt">): string => {
  const missing = result.checks.filter(
    (entry) => entry.status === "missing" || entry.status === "outdated",
  );
  const lines = [
    "Set up this machine so T3 Code can run hosted Blenders.",
    "",
    `Distro: ${result.distro ?? "unknown"}${result.packageManager === null ? "" : ` (${result.packageManager})`}.`,
    "",
    "T3 Code's setup check found these missing or too old:",
    ...missing.map(
      (entry) =>
        `- ${ITEM_NAMES[entry.item]}${entry.status === "outdated" && entry.found ? `: found ${entry.found}` : ""}`,
    ),
    "",
    ...(result.commands.length > 0
      ? [
          "Suggested commands (check them against this machine before running them):",
          "```sh",
          ...result.commands,
          "```",
          "",
        ]
      : ["T3 Code has no package commands for this distro; find the right packages for it.", ""]),
    "Rules:",
    '- When a command needs sudo, ask for the password with T3 Code\'s private secret card (the `request_secret` tool, with `delivery: "file"`), then run `sudo -S -p \'\' <command> < "$file"`. Never ask for a password in chat.',
    "- Install only what is listed. Do not edit any provider's MCP configuration: T3 Code adds the Blender MCP to each thread itself.",
    "- Do not touch a desktop Blender the user is running, its settings, or anything on port 9876.",
    "- Explain any step you could not finish. T3 Code checks the setup again when you are done.",
  ];
  return lines.join("\n");
};
