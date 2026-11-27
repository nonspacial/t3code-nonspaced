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
import type * as Scope from "effect/Scope";

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

const AddonReply = Schema.Struct({
  status: Schema.String,
  result: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.String),
});
const decodeAddonReply = Schema.decodeUnknownOption(Schema.fromJsonString(AddonReply));
const ProbeResult = Schema.Struct({ filepath: Schema.String, dirty: Schema.Boolean });
const SaveResult = Schema.Struct({ moved: Schema.Boolean, pid: Schema.optional(Schema.Int) });
const MoveState = Schema.Struct({ state: Schema.NullOr(Schema.String) });
const decodeMoveState = Schema.decodeUnknownEffect(MoveState);
const decodeProbeResult = Schema.decodeUnknownEffect(ProbeResult);
const decodeSaveResult = Schema.decodeUnknownEffect(SaveResult);

/**
 * The user's desktop Blender. Opening a master reads what it has open, so T3 never opens that
 * file a second time; Move into T3 has it save and quit so a master Blender can open the file.
 */
export class DesktopBlender extends Context.Service<
  DesktopBlender,
  {
    readonly probe: Effect.Effect<DesktopBlenderProbe>;
    /** Saves and quits the desktop Blender, if it still has `filepath` (a real path) open. */
    readonly saveAndQuit: (filepath: string) => Effect.Effect<void, DesktopBlenderError>;
  }
>()("t3/hostedBlender/DesktopBlender") {}

// The developer's own Blender is on this port while tests run, with their work open.
const refuseDesktopPortInTests = (port: number) =>
  port === DESKTOP_BLENDER_MCP_PORT && globalThis.process?.env.VITEST !== undefined
    ? Effect.die(new Error("Tests must never reach the desktop Blender on its add-on's port."))
    : undefined;

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

// Checked as the request arrives and again in the timer just before saving, so a Save As in
// between is refused. `filepath` is the entry Blender will write: the master's own name. Quitting waits for that timer, so the add-on still answers first;
// save_mainfile(exit=True) quits only once it has saved. The state says what the timer did.
export const saveAndQuitCode = (filepath: string, token: string) => `import bpy, os
expected = ${JSON.stringify(filepath)}
def _t3_current():
    # The directory entry a save replaces: a symlink's own name, not the file it points at.
    path = bpy.data.filepath
    if not path:
        return ""
    return os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path))
if _t3_current() != expected:
    result = {"moved": False, "filepath": bpy.data.filepath}
else:
    def _t3_save_and_quit():
        if _t3_current() != expected:
            bpy.app.driver_namespace["t3_move_state"] = "otherFile"
            return None
        bpy.app.driver_namespace["t3_move_state"] = "saving"
        try:
            with bpy.context.temp_override(window=bpy.context.window_manager.windows[0]):
                saved = "FINISHED" in bpy.ops.wm.save_mainfile(exit=True)
        except Exception:
            saved = False
        # The operator saves, then quits once it returns; the token proves this request saved.
        if saved:
            with open(${JSON.stringify(token)}, "w") as proof:
                proof.write("saved")
        bpy.app.driver_namespace["t3_move_state"] = "saved" if saved else "failed"
        return None
    bpy.app.driver_namespace["t3_move_state"] = "scheduled"
    bpy.app.timers.register(_t3_save_and_quit, first_interval=0.1)
    result = {"moved": True, "pid": os.getpid()}`;

const MOVE_STATE_CODE = `import bpy
result = {"state": bpy.app.driver_namespace.get("t3_move_state")}`;

export const make = (options: {
  readonly port: number;
  /** Whether any desktop Blender is running, add-on or not. */
  readonly desktopBlenderRunning: Effect.Effect<boolean>;
  /** Whether the process with this pid still runs. */
  readonly processAlive: (pid: number) => Effect.Effect<boolean>;
  /**
   * A fresh file path the desktop Blender writes once this request's save succeeded, and whether
   * it has been written.
   */
  readonly saveToken: Effect.Effect<
    { readonly path: string; readonly written: Effect.Effect<boolean> },
    never,
    Scope.Scope
  >;
  readonly quitTimeout?: Duration.Input;
}): DesktopBlender["Service"] => {
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

  /**
   * Waits for the save to finish and Blender to exit: the add-on stops answering, and the process
   * that took the request is gone. A refusal or failure the timer recorded answers sooner.
   */
  const awaitQuit = (pid: number) =>
    executeOnAddon(options.port, MOVE_STATE_CODE, PROBE_TIMEOUT).pipe(
      Effect.flatMap(decodeMoveState),
      Effect.map(({ state }) => state),
      // Its add-on stopped answering: gone only once the process that took the save has.
      Effect.catchTags({
        AddonUnreachable: () =>
          options.processAlive(pid).pipe(Effect.map((alive) => (alive ? null : "gone"))),
      }),
      Effect.orElseSucceed(() => null),
      Effect.repeat({
        schedule: Schedule.spaced(QUIT_POLL),
        until: (state) => state === "gone" || state === "otherFile" || state === "failed",
      }),
      Effect.timeoutOption(options.quitTimeout ?? QUIT_TIMEOUT),
    );

  const saveAndQuit: DesktopBlender["Service"]["saveAndQuit"] = Effect.fn(
    "DesktopBlender.saveAndQuit",
  )(function* (filepath) {
    const token = yield* options.saveToken;
    const result = yield* executeOnAddon(
      options.port,
      saveAndQuitCode(filepath, token.path),
      PROBE_TIMEOUT,
    ).pipe(
      Effect.catchTags({
        AddonUnreachable: () => Effect.fail(new DesktopBlenderError({ reason: "unreachable" })),
      }),
      Effect.flatMap((value) =>
        decodeSaveResult(value).pipe(
          Effect.mapError(() => new DesktopBlenderError({ reason: "badReply" })),
        ),
      ),
    );
    if (!result.moved) return yield* new DesktopBlenderError({ reason: "otherFile" });
    if (result.pid === undefined) return yield* new DesktopBlenderError({ reason: "badReply" });
    const ended = yield* awaitQuit(result.pid);
    if (Option.isSome(ended) && ended.value === "otherFile") {
      return yield* new DesktopBlenderError({ reason: "otherFile" });
    }
    // A closed port alone proves nothing: the process must be gone, and this save recorded.
    if (Option.isNone(ended) || ended.value !== "gone" || !(yield* token.written)) {
      return yield* new DesktopBlenderError({ reason: "didNotQuit" });
    }
  }, Effect.scoped);

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
      processAlive: (pid) =>
        fileSystem.exists(`/proc/${pid}`).pipe(Effect.orElseSucceed(() => false)),
      saveToken: fileSystem.makeTempDirectoryScoped({ prefix: "t3-move-" }).pipe(
        Effect.map((dir) => {
          const path = `${dir}/saved`;
          return { path, written: fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false)) };
        }),
        Effect.orDie,
      ),
      desktopBlenderRunning: desktopBlenderRunning.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      ),
    });
  }),
);
