// @effect-diagnostics nodeBuiltinImport:off - Blender Lab's add-on speaks NUL-delimited JSON over a raw TCP socket.
import * as NodeNet from "node:net";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/** Where Blender Lab's add-on listens in the user's own Blender unless they changed it. */
export const DESKTOP_BLENDER_MCP_PORT = 9876;
const PROBE_TIMEOUT = Duration.seconds(5);
// A big file takes a while to save before Blender exits.
const QUIT_TIMEOUT = Duration.seconds(60);
const QUIT_POLL = Duration.millis(250);

/**
 * What the user's desktop Blender has open, read through Blender Lab's add-on: `none` when no
 * desktop Blender runs, `noAddon` when one runs but its add-on doesn't answer. An untitled scene
 * has an empty `filepath`.
 */
export type DesktopBlenderProbe =
  | { readonly _tag: "none" }
  | { readonly _tag: "noAddon" }
  | { readonly _tag: "open"; readonly filepath: string; readonly dirty: boolean };

export class DesktopBlenderError extends Schema.TaggedError<DesktopBlenderError>()(
  "DesktopBlenderError",
  { reason: Schema.Literals(["unreachable", "otherFile", "didNotQuit", "badReply"]) },
) {}

class AddonUnreachable extends Schema.TaggedError<AddonUnreachable>()("AddonUnreachable", {}) {}

/**
 * The user's desktop Blender, reached only for "Move into T3": T3 reads what it has open, then
 * has it save and quit so a master Blender can open the file. Nothing else ever talks to it.
 */
export class DesktopBlender extends Context.Service<
  DesktopBlender,
  {
    readonly probe: Effect.Effect<DesktopBlenderProbe>;
    /** Saves and quits the desktop Blender, if it still has `filepath` (a real path) open. */
    readonly saveAndQuit: (filepath: string) => Effect.Effect<void, DesktopBlenderError>;
  }
>()("t3/hostedBlender/DesktopBlender") {}

const AddonReply = Schema.Struct({
  status: Schema.String,
  result: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.String),
});
const decodeAddonReply = Schema.decodeUnknownOption(Schema.fromJsonString(AddonReply));

// The developer's own Blender is on this port while tests run, with their work open.
const refuseDesktopPortInTests = (port: number) =>
  port === DESKTOP_BLENDER_MCP_PORT && globalThis.process?.env.VITEST !== undefined
    ? Effect.die(new Error("Tests must never reach the desktop Blender on its add-on's port."))
    : undefined;

/** Whether anything accepts connections on loopback `port`; nothing is sent. */
const portOpen = (port: number) =>
  refuseDesktopPortInTests(port) ??
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    const settle = (open: boolean) => {
      socket.destroy();
      resume(Effect.succeed(open));
    };
    socket.setTimeout(Duration.toMillis(PROBE_TIMEOUT), () => settle(true));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    return Effect.sync(() => socket.destroy());
  });

/**
 * Runs `code` in the Blender whose add-on listens on loopback `port`; its `result` dict is the
 * answer. Fails with `AddonUnreachable` when nothing answers there.
 */
export const executeOnAddon = (port: number, code: string, timeout: Duration.Input) =>
  refuseDesktopPortInTests(port) ??
  Effect.callback<unknown, AddonUnreachable | DesktopBlenderError>((resume) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    let buffer = "";
    let settled = false;
    const settle = (effect: Effect.Effect<unknown, AddonUnreachable | DesktopBlenderError>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(effect);
    };
    socket.setTimeout(Duration.toMillis(Duration.fromInputUnsafe(timeout)), () =>
      settle(Effect.fail(new AddonUnreachable())),
    );
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ type: "execute", code, strict_json: true })}\0`),
    );
    socket.on("data", (data) => {
      buffer += data.toString();
      const end = buffer.indexOf("\0");
      if (end < 0) return;
      const reply = decodeAddonReply(buffer.slice(0, end));
      settle(
        Option.isSome(reply) && reply.value.status === "ok"
          ? Effect.succeed(reply.value.result)
          : Effect.fail(new DesktopBlenderError({ reason: "badReply" })),
      );
    });
    socket.on("error", () => settle(Effect.fail(new AddonUnreachable())));
    socket.on("close", () => settle(Effect.fail(new AddonUnreachable())));
    return Effect.sync(() => socket.destroy());
  });

const PROBE_CODE = `import bpy
result = {"filepath": bpy.data.filepath, "dirty": bool(bpy.data.is_dirty)}`;

// Checked and scheduled in one request, so the file can't change in between. Quitting waits for
// a timer, so the add-on still answers; save_mainfile(exit=True) quits only once it has saved.
const saveAndQuitCode = (filepath: string) => `import bpy, os
current = os.path.realpath(bpy.data.filepath) if bpy.data.filepath else ""
if current != ${JSON.stringify(filepath)}:
    result = {"moved": False, "filepath": bpy.data.filepath}
else:
    def _t3_save_and_quit():
        with bpy.context.temp_override(window=bpy.context.window_manager.windows[0]):
            bpy.ops.wm.save_mainfile(exit=True)
        return None
    bpy.app.timers.register(_t3_save_and_quit, first_interval=0.1)
    result = {"moved": True}`;

const ProbeResult = Schema.Struct({ filepath: Schema.String, dirty: Schema.Boolean });
const SaveResult = Schema.Struct({ moved: Schema.Boolean });
const decodeProbeResult = Schema.decodeUnknownEffect(ProbeResult);
const decodeSaveResult = Schema.decodeUnknownEffect(SaveResult);

export const make = (options: {
  readonly port: number;
  /** Whether any desktop Blender is running, add-on or not. */
  readonly desktopBlenderRunning: Effect.Effect<boolean>;
  readonly quitTimeout?: Duration.Input;
}): DesktopBlender["Service"] => {
  const badReply = () => new DesktopBlenderError({ reason: "badReply" });
  const probe: DesktopBlender["Service"]["probe"] = executeOnAddon(
    options.port,
    PROBE_CODE,
    PROBE_TIMEOUT,
  ).pipe(
    Effect.flatMap(decodeProbeResult),
    Effect.map((open) => ({ _tag: "open" as const, ...open })),
    Effect.catch(() =>
      options.desktopBlenderRunning.pipe(
        Effect.map((running) =>
          running ? { _tag: "noAddon" as const } : { _tag: "none" as const },
        ),
      ),
    ),
    Effect.withSpan("DesktopBlender.probe"),
  );

  // Blender closes the add-on's port as it exits, which it does only after saving.
  const quitObserved = portOpen(options.port).pipe(
    Effect.repeat({ schedule: Schedule.spaced(QUIT_POLL), until: (open) => !open }),
    Effect.timeoutOption(options.quitTimeout ?? QUIT_TIMEOUT),
  );

  const saveAndQuit: DesktopBlender["Service"]["saveAndQuit"] = Effect.fn(
    "DesktopBlender.saveAndQuit",
  )(function* (filepath) {
    const result = yield* executeOnAddon(
      options.port,
      saveAndQuitCode(filepath),
      PROBE_TIMEOUT,
    ).pipe(
      Effect.catchTags({
        AddonUnreachable: () => Effect.fail(new DesktopBlenderError({ reason: "unreachable" })),
      }),
      Effect.flatMap((value) => decodeSaveResult(value).pipe(Effect.mapError(badReply))),
    );
    if (!result.moved) return yield* new DesktopBlenderError({ reason: "otherFile" });
    if (Option.isNone(yield* quitObserved)) {
      return yield* new DesktopBlenderError({ reason: "didNotQuit" });
    }
  });

  return DesktopBlender.of({ probe, saveAndQuit });
};

/**
 * Any Blender with a UI that isn't one of T3's: hosted Blenders carry `--t3-control`, and T3's
 * converters run in the background.
 */
const desktopBlenderRunning = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* fileSystem.readDirectory("/proc").pipe(Effect.orElseSucceed(() => []));
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = yield* fileSystem
      .readFileString(`/proc/${entry}/cmdline`)
      .pipe(Effect.orElseSucceed(() => ""));
    const argv = cmdline.split("\0");
    const program = argv[0]?.slice(argv[0].lastIndexOf("/") + 1) ?? "";
    if (!/^blender(\.bin)?$/.test(program)) continue;
    if (argv.some((arg) => arg === "--t3-control" || arg === "-b" || arg === "--background")) {
      continue;
    }
    return true;
  }
  return false;
});

export const layer = Layer.effect(
  DesktopBlender,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return make({
      port: DESKTOP_BLENDER_MCP_PORT,
      desktopBlenderRunning: desktopBlenderRunning.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      ),
    });
  }),
);
