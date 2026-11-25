import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

type JsonObject = Readonly<Record<string, unknown>>;

// Every value written comes from parsed JSON or T3's own literals, so encoding can't fail.
export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const BlenderMcpAnswer = Schema.Struct({
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
});
export type BlenderMcpAnswer = typeof BlenderMcpAnswer.Type;

/** What is run: the console script's real path, and the installed distribution it imports. */
export const BlenderMcpBuild = Schema.Struct({
  realPath: Schema.String,
  size: Schema.Number,
  modifiedMs: Schema.Number,
  version: Schema.NullOr(Schema.String),
  versionModifiedMs: Schema.NullOr(Schema.Number),
});
export type BlenderMcpBuild = typeof BlenderMcpBuild.Type;

/**
 * The official server's answers to `initialize` and its lists, by the protocol version asked
 * for; `*` is its answer to a version it doesn't know.
 */
export const BlenderMcpCapture = Schema.Struct({
  command: Schema.String,
  build: BlenderMcpBuild,
  answers: Schema.Record(Schema.String, Schema.Record(Schema.String, BlenderMcpAnswer)),
});
export type BlenderMcpCapture = typeof BlenderMcpCapture.Type;

// The MCP spec's published versions, and one no server knows.
const CAPTURED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const UNKNOWN_PROTOCOL_VERSION = "0000-00-00";

export const capturedAnswersFor = (capture: BlenderMcpCapture, protocolVersion: string) =>
  capture.answers[protocolVersion] ?? capture.answers["*"];

/** Answered from a capture, never by Blender: listed only when `initialize` advertised them. */
export const LIST_METHODS: ReadonlyArray<readonly [method: string, capability: string]> = [
  ["tools/list", "tools"],
  ["prompts/list", "prompts"],
  ["resources/list", "resources"],
  ["resources/templates/list", "resources"],
];

/** T3's environment without its own variables or any Blender setting a user's shell carries. */
const inherited = (environment: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith("T3CODE_") &&
        !entry[0].startsWith("BLENDER_"),
    ),
  );

/**
 * For a server that only answers `initialize` and lists: no Blender to reach (nothing ever
 * listens on port 0) and no Blender binary to run.
 */
export const discoveryEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  tmpDir: string,
): Record<string, string> => ({
  ...inherited(environment),
  BLENDER_MCP_HOST: "localhost",
  BLENDER_MCP_PORT: "0",
  BLENDER_PATH: "/dev/null",
  TMPDIR: tmpDir,
});

/**
 * For a session's server: only the port T3 granted. `localhost` is Blender Lab's own default and
 * what its add-on listens on, so both ends resolve it alike.
 */
export const roleEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  target: { readonly port: number; readonly blenderPath: string; readonly tmpDir: string },
): Record<string, string> => ({
  ...inherited(environment),
  BLENDER_MCP_HOST: "localhost",
  BLENDER_MCP_PORT: String(target.port),
  BLENDER_PATH: target.blenderPath,
  TMPDIR: target.tmpDir,
});

export class BlenderMcpTransportError extends Schema.TaggedError<BlenderMcpTransportError>()(
  "BlenderMcpTransportError",
  {},
) {}

/** One `blender-mcp` over stdio: newline-delimited JSON-RPC both ways. */
export interface BlenderMcpConnection {
  readonly send: (message: JsonObject) => Effect.Effect<void, BlenderMcpTransportError>;
}

// A server that takes no input for this long is wedged.
const WRITE_TIMEOUT = Duration.seconds(10);

/**
 * Starts `blender-mcp` in `scope` and hands every message it writes to `onMessage`. `onExit` runs
 * once if it exits on its own.
 */
export const openBlenderMcp = Effect.fnUntraced(function* (input: {
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
  readonly scope: Scope.Scope;
  readonly onMessage: (message: JsonObject) => Effect.Effect<void>;
  readonly onExit: (exitCode: number | null) => Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(input.command, [], {
        env: input.env,
        extendEnv: false,
        stdin: { stream: "pipe", endOnDone: false },
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: Duration.seconds(2),
      }),
    )
    .pipe(Scope.provide(input.scope));
  // Its log goes to stderr; unread, the pipe would fill and stop it.
  yield* Stream.runDrain(handle.stderr).pipe(Effect.ignore, Effect.forkIn(input.scope));
  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => {
      const parsed = decodeJson(line);
      return Option.isSome(parsed) && Predicate.isReadonlyObject(parsed.value)
        ? input.onMessage(parsed.value)
        : Effect.void;
    }),
    Effect.ignore,
    Effect.andThen(handle.exitCode.pipe(Effect.option)),
    Effect.flatMap((code) => input.onExit(Option.isSome(code) ? Number(code.value) : null)),
    Effect.forkIn(input.scope),
  );
  const encoder = new TextEncoder();
  return {
    send: (message) =>
      Stream.run(Stream.make(encoder.encode(`${encodeJson(message)}\n`)), handle.stdin).pipe(
        Effect.timeoutOrElse({
          duration: WRITE_TIMEOUT,
          orElse: () => Effect.fail(new BlenderMcpTransportError()),
        }),
        Effect.mapError(() => new BlenderMcpTransportError()),
      ),
  } satisfies BlenderMcpConnection;
});

export const initializeParams = (protocolVersion: string) => ({
  protocolVersion,
  capabilities: {},
  clientInfo: { name: "t3-code", version: "1" },
});

// Long enough for a cold Python start that imports Blender Lab's docs search.
export const START_TIMEOUT = Duration.seconds(30);

/** One process's answers to `initialize` and the lists it advertises, for one version. */
const answersOnce = (command: string, env: Record<string, string>, protocolVersion: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const waiting = new Map<number, Deferred.Deferred<BlenderMcpAnswer>>();
      const exited = yield* Deferred.make<void>();
      const connection = yield* openBlenderMcp({
        command,
        env,
        scope,
        onMessage: (message) => {
          const waiter = typeof message.id === "number" ? waiting.get(message.id) : undefined;
          return waiter === undefined
            ? Effect.void
            : Deferred.succeed(waiter, {
                ...("result" in message ? { result: message.result } : {}),
                ...("error" in message ? { error: message.error } : {}),
              });
        },
        onExit: () => Deferred.succeed(exited, undefined),
      });
      let nextId = 0;
      const ask = Effect.fnUntraced(function* (method: string, params?: JsonObject) {
        const id = nextId++;
        const answer = yield* Deferred.make<BlenderMcpAnswer>();
        waiting.set(id, answer);
        yield* connection.send({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
        const settled = yield* Deferred.await(answer).pipe(
          Effect.raceFirst(Deferred.await(exited).pipe(Effect.as(undefined))),
        );
        if (settled === undefined) return yield* Effect.fail("it exited while answering");
        return settled;
      });
      const answers: Record<string, BlenderMcpAnswer> = {};
      const initialized = yield* ask("initialize", initializeParams(protocolVersion));
      answers.initialize = initialized;
      if (initialized.error !== undefined) return yield* Effect.fail("it refused to initialize");
      yield* connection.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const capabilities = Predicate.isReadonlyObject(initialized.result)
        ? initialized.result.capabilities
        : undefined;
      for (const [method, capability] of LIST_METHODS) {
        if (Predicate.isReadonlyObject(capabilities) && capability in capabilities) {
          answers[method] = yield* ask(method);
        }
      }
      return answers;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: START_TIMEOUT,
      orElse: () => Effect.fail("it did not answer in time"),
    }),
    Effect.mapError((reason) => (typeof reason === "string" ? reason : "it could not start")),
  );

const millisOf = (time: Option.Option<{ readonly getTime: () => number }>) =>
  Option.match(time, { onNone: () => 0, onSome: (value) => value.getTime() });

/**
 * The installed build `command` runs. uv and pipx give each version its own environment, whose
 * `<name>.dist-info` names the version; a reinstall in place changes the times.
 */
export const blenderMcpBuild = Effect.fnUntraced(function* (command: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realPath = yield* fileSystem.realPath(command);
  const info = yield* fileSystem.stat(realPath);
  const libDir = path.join(path.dirname(path.dirname(realPath)), "lib");
  const distInfo = yield* Effect.gen(function* () {
    for (const python of yield* fileSystem.readDirectory(libDir)) {
      const sitePackages = path.join(libDir, python, "site-packages");
      for (const entry of yield* fileSystem.readDirectory(sitePackages)) {
        const match = /^blender_mcp-(.+)\.dist-info$/.exec(entry);
        if (match === null) continue;
        const metadata = yield* fileSystem.stat(path.join(sitePackages, entry, "METADATA"));
        return {
          version: match[1]!,
          versionModifiedMs: millisOf(metadata.mtime),
        };
      }
    }
    return null;
  }).pipe(Effect.orElseSucceed(() => null));
  return {
    realPath,
    size: Number(info.size),
    modifiedMs: millisOf(info.mtime),
    version: distInfo?.version ?? null,
    versionModifiedMs: distInfo?.versionModifiedMs ?? null,
  } satisfies BlenderMcpBuild;
});

/** Runs the official server once per protocol version, with nothing for it to reach. */
export const captureBlenderMcp = Effect.fnUntraced(function* (input: {
  readonly command: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly tmpDir: string;
}) {
  const build = yield* blenderMcpBuild(input.command).pipe(
    Effect.mapError(() => "it could not be read"),
  );
  const env = discoveryEnvironment(input.environment, input.tmpDir);
  const versions = [...CAPTURED_PROTOCOL_VERSIONS, UNKNOWN_PROTOCOL_VERSION];
  const answers = yield* Effect.forEach(
    versions,
    (version) => answersOnce(input.command, env, version),
    { concurrency: "unbounded" },
  );
  return {
    command: input.command,
    build,
    answers: Object.fromEntries(
      versions.map((version, index) => [
        version === UNKNOWN_PROTOCOL_VERSION ? "*" : version,
        answers[index]!,
      ]),
    ),
  } satisfies BlenderMcpCapture;
});

export const sameBuild = (a: BlenderMcpBuild, b: BlenderMcpBuild) =>
  a.realPath === b.realPath &&
  a.size === b.size &&
  a.modifiedMs === b.modifiedMs &&
  a.version === b.version &&
  a.versionModifiedMs === b.versionModifiedMs;
