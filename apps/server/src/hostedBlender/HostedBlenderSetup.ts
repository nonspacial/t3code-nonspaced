import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type HostedBlenderInstallResult,
  type HostedBlenderRequirement,
  HostedBlenderSetupError,
  type HostedBlenderSetupResult,
  type HostedBlenderSetupState,
  type HostedBlenderThreadState,
  type ProjectId,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { CommandResolutionCache, resolveCommandPath } from "@t3tools/shared/shell";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as BlenderDetection from "../blend/BlenderDetection.ts";
import { expandHome } from "../blend/BlenderDetection.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HiddenDisplayBinary from "./HiddenDisplayBinary.ts";
import {
  type CheckedSetup,
  evaluateSetup,
  installPrompt,
  needsInstall,
  type OsRelease,
  parseGstreamerVersion,
  parseLabwcVersion,
  parseOsRelease,
  type SetupFacts,
} from "./setupChecks.ts";

// A console script is a few lines; anything bigger is not one.
const MAX_CONSOLE_SCRIPT_BYTES = 64 * 1024;
// Blender Lab's package declares `blender-mcp = blmcp:main`.
const OFFICIAL_MCP_ENTRY_POINT = /^from blmcp import main$/m;

// The install agent may wait on the user's password card for a long time.
const INSTALL_WAIT_MS = 6 * 60 * 60 * 1000;

/** What the pane needs to start a hosted Blender, or why it can't. */
export type HostedBlenderReadiness =
  | { readonly status: "ok"; readonly helper: string; readonly blender: string }
  | Extract<HostedBlenderThreadState, { status: "unavailable" | "notSetUp" }>;

/**
 * Hosted Blender's setup: the check of what the host has (remembered until "Check again"),
 * the Hosted Blender switch, and "Install with an agent". T3 never installs system packages.
 */
export class HostedBlenderSetup extends Context.Service<
  HostedBlenderSetup,
  {
    /** Passive: watching never runs a check, which starts programs on the host. */
    readonly state: Stream.Stream<HostedBlenderSetupState>;
    /** "Check again". A check already running is joined, not repeated. */
    readonly check: Effect.Effect<void>;
    /** Checks unless a result is already kept: first use by a caller allowed to run programs. */
    readonly ensureChecked: Effect.Effect<void>;
    readonly installWithAgent: Effect.Effect<HostedBlenderInstallResult, HostedBlenderSetupError>;
    /** Follows the switch and the last check; passive, like `state`. */
    readonly readiness: Stream.Stream<HostedBlenderReadiness>;
  }
>()("t3/hostedBlender/HostedBlenderSetup") {}

interface Internal {
  readonly state: HostedBlenderSetupState;
  readonly tools: { readonly helper: string; readonly blender: string } | null;
  /** From the last check, for the install prompt. */
  readonly osRelease: OsRelease | null;
}

const ProbeOutput = Schema.fromJsonString(Schema.Struct({ encoder: Schema.NullOr(Schema.String) }));
const decodeProbe = Schema.decodeUnknownOption(ProbeOutput);

const BLOCKING_REQUIREMENTS: ReadonlyArray<HostedBlenderRequirement> = [
  "helper",
  "blender",
  "labwc",
  "gstreamer",
  "encoder",
  "glupload",
];

const readinessOf = (enabled: boolean, internal: Internal): HostedBlenderReadiness => {
  const result = internal.state.result;
  if (result?.status === "unavailable") return { status: "unavailable", reason: result.reason };
  if (!enabled) return { status: "notSetUp", missing: ["enabled"] };
  if (result === null) return { status: "notSetUp", missing: ["check"] };
  if (result.ready && internal.tools !== null) return { status: "ok", ...internal.tools };
  return {
    status: "notSetUp",
    missing: BLOCKING_REQUIREMENTS.filter((requirement) =>
      result.checks.some((entry) => entry.item === requirement && entry.status !== "ok"),
    ),
  };
};

/** `systemRoot` is where `/etc`, `/dev` and `/proc` are read from; tests point it elsewhere. */
export const makeWith = Effect.fn("HostedBlenderSetup.make")(function* (options: {
  readonly systemRoot: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const settings = yield* ServerSettings.ServerSettingsService;
  const detection = yield* BlenderDetection.BlenderDetection;
  const hiddenDisplay = yield* HiddenDisplayBinary.HiddenDisplayBinary;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const random = yield* SecureRandom.SecureRandom;
  const launchContext = yield* Effect.context<
    | ManagedProjectFolders.ManagedProjectFolders
    | ProjectService.ProjectService
    | ProviderRegistry.ProviderRegistry
    | ThreadLaunch.ThreadLaunchService
    | ThreadManagement.ThreadManagementService
  >();
  const lookupContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const serviceScope = yield* Effect.scope;
  const system = (...segments: ReadonlyArray<string>) => path.join(options.systemRoot, ...segments);

  // Hosts T3 ships no helper for are known without running anything, so they start answered.
  const knownUnavailable =
    platform !== "linux" ||
    (yield* hiddenDisplay.resolve.pipe(
      Effect.as(false),
      Effect.catchTags({
        HiddenDisplayBinaryUnsupported: () => Effect.succeed(true),
        HiddenDisplayBinaryNotFound: () => Effect.succeed(false),
        HiddenDisplayBinaryNotExecutable: () => Effect.succeed(false),
      }),
    ));
  const ref = yield* SubscriptionRef.make<Internal>({
    state: {
      result: knownUnavailable ? { status: "unavailable", reason: "platform", distro: null } : null,
      checking: false,
      installThreadId: null,
    },
    tools: null,
    osRelease: null,
  });
  const update = (change: (internal: Internal) => Internal) => SubscriptionRef.update(ref, change);

  const which = (command: string) =>
    resolveCommandPath(command).pipe(Effect.provideContext(lookupContext));

  const run = (
    command: string,
    args: ReadonlyArray<string>,
    timeout: Duration.Input = "30 seconds",
  ) =>
    runner
      .run({
        command,
        args,
        env: environment,
        replaceEnv: true,
        timeout,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
      })
      .pipe(Effect.option);

  const readOsRelease = Effect.gen(function* () {
    for (const candidate of [system("etc", "os-release"), system("usr", "lib", "os-release")]) {
      const text = yield* fileSystem.readFileString(candidate).pipe(Effect.option);
      if (Option.isSome(text)) return parseOsRelease(text.value);
    }
    return null;
  });

  // Both run inside the check's span.
  const versionOf = Effect.fnUntraced(function* (
    command: string,
    parse: (stdout: string) => string | null,
  ) {
    const resolved = yield* which(command);
    if (resolved === null) return null;
    const output = yield* run(resolved, ["--version"]);
    return Option.isSome(output) && output.value.code === 0 ? parse(output.value.stdout) : null;
  });

  const renderNodes = Effect.gen(function* () {
    const dri = system("dev", "dri");
    const nodes = (yield* fileSystem
      .readDirectory(dri)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))).filter((entry) =>
      entry.startsWith("renderD"),
    );
    let accessible = 0;
    for (const node of nodes) {
      const ok = yield* fileSystem
        .access(path.join(dri, node), { readable: true, writable: true })
        .pipe(Effect.isSuccess);
      if (ok) accessible++;
    }
    return { total: nodes.length, accessible };
  });

  const findBlenderMcpPath = Effect.fnUntraced(function* (setting: string) {
    const configured = expandHome(setting, homeDirectory, path.join);
    if (configured !== "") {
      const candidate = /[\\/]/.test(configured)
        ? path.resolve(configured)
        : yield* which(configured);
      return candidate !== null && (yield* isExecutable(candidate)) ? candidate : null;
    }
    const onPath = yield* which("blender-mcp");
    if (onPath !== null) return onPath;
    // Where `uv tool install` and `pipx` put it, which a desktop app's PATH often lacks.
    const local = path.join(homeDirectory, ".local", "bin", "blender-mcp");
    return (yield* isExecutable(local)) ? local : null;
  });

  // PyPI's unrelated `blender-mcp` installs the same command; Blender Lab's console script
  // (from uv, pipx or pip, through any symlink) imports its `blmcp` package.
  const findBlenderMcp = Effect.fnUntraced(function* (setting: string) {
    const found = yield* findBlenderMcpPath(setting);
    if (found === null) return null;
    const script = yield* fileSystem.realPath(found).pipe(
      Effect.flatMap((real) =>
        fileSystem
          .stat(real)
          .pipe(
            Effect.flatMap((info) =>
              Number(info.size) > MAX_CONSOLE_SCRIPT_BYTES
                ? Effect.succeed("")
                : fileSystem.readFileString(real),
            ),
          ),
      ),
      Effect.orElseSucceed(() => ""),
    );
    return { path: found, official: OFFICIAL_MCP_ENTRY_POINT.test(script) };
  });

  const isExecutable = (candidate: string) =>
    fileSystem.stat(candidate).pipe(
      Effect.map((info) => info.type === "File" && (info.mode & 0o111) !== 0),
      Effect.orElseSucceed(() => false),
    );

  const gather = Effect.gen(function* (): Effect.fn.Return<{
    readonly facts: SetupFacts;
    readonly helper: string | null;
  }> {
    const helper = yield* hiddenDisplay.resolve.pipe(
      Effect.map((resolved): string | null | "unsupported" => resolved),
      Effect.catchTags({
        HiddenDisplayBinaryUnsupported: () => Effect.succeed("unsupported" as const),
        HiddenDisplayBinaryNotFound: () => Effect.succeed(null),
        HiddenDisplayBinaryNotExecutable: () => Effect.succeed(null),
      }),
    );
    const base = {
      platform,
      helper,
      osRelease: null as OsRelease | null,
      blender: null,
      labwcVersion: null,
      gstreamerVersion: null,
      encoder: null,
      nvidia: false,
      glupload: false,
      renderNodes: { total: 0, accessible: 0 },
      blenderMcp: null,
    } satisfies SetupFacts;
    if (platform !== "linux" || helper === "unsupported") return { facts: base, helper: null };
    const current = yield* settings.getSettings.pipe(
      Effect.orElseSucceed(() => ({ blenderMcpPath: "" })),
    );
    const [osRelease, detected, labwcVersion, gstreamerVersion, gpu, nvidia, blenderMcp] =
      yield* Effect.all(
        [
          readOsRelease,
          detection.find,
          versionOf("labwc", parseLabwcVersion),
          versionOf("gst-inspect-1.0", parseGstreamerVersion),
          renderNodes,
          fileSystem
            .exists(system("proc", "driver", "nvidia", "version"))
            .pipe(Effect.orElseSucceed(() => false)),
          findBlenderMcp(current.blenderMcpPath),
        ],
        { concurrency: "unbounded" },
      );
    const blender =
      detected === null
        ? null
        : {
            ...detected,
            realPath: yield* fileSystem
              .realPath(detected.path)
              .pipe(Effect.orElseSucceed(() => detected.path)),
          };
    // The helper's probe encodes a second of test video with each encoder in turn.
    const encoder =
      helper === null || gstreamerVersion === null
        ? null
        : yield* run(helper, ["probe"], "60 seconds").pipe(
            Effect.map((output) =>
              Option.isSome(output)
                ? (Option.getOrNull(decodeProbe(output.value.stdout.trim()))?.encoder ?? null)
                : null,
            ),
          );
    const gstInspect = nvidia ? yield* which("gst-inspect-1.0") : null;
    const glupload =
      gstInspect === null
        ? false
        : yield* run(gstInspect, ["glupload"]).pipe(
            Effect.map((output) => Option.isSome(output) && output.value.code === 0),
          );
    return {
      facts: {
        ...base,
        osRelease,
        blender,
        labwcVersion,
        gstreamerVersion,
        encoder,
        nvidia,
        glupload,
        renderNodes: gpu,
        blenderMcp,
      },
      helper,
    };
  });

  const runCheck = Effect.gen(function* () {
    yield* update((internal) => ({ ...internal, state: { ...internal.state, checking: true } }));
    // A fresh lookup each time: the shared cache keeps misses, which would hide a new install.
    const { facts, helper } = yield* gather.pipe(
      Effect.provideService(CommandResolutionCache, new Map()),
    );
    const evaluated = evaluateSetup(facts);
    const result: HostedBlenderSetupResult =
      evaluated.status === "checked"
        ? { ...evaluated, checkedAt: yield* Clock.currentTimeMillis }
        : evaluated;
    yield* update((internal) => ({
      state: { ...internal.state, result, checking: false },
      tools:
        helper !== null && facts.blender !== null ? { helper, blender: facts.blender.path } : null,
      osRelease: facts.osRelease,
    }));
  }).pipe(
    Effect.onExit(() =>
      update((internal) => ({ ...internal, state: { ...internal.state, checking: false } })),
    ),
    Effect.withSpan("HostedBlenderSetup.runCheck"),
  );

  let pending: Deferred.Deferred<void> | null = null;
  const installLock = yield* Semaphore.make(1);
  const check: HostedBlenderSetup["Service"]["check"] = Effect.suspend(() => {
    if (pending !== null) return Deferred.await(pending);
    const done = Deferred.makeUnsafe<void>();
    pending = done;
    // Joiners get the check's own outcome, so a check that dies doesn't read as done.
    return runCheck.pipe(
      Effect.onExit((exit) =>
        Effect.suspend(() => {
          pending = null;
          return Deferred.done(done, exit);
        }),
      ),
      Effect.forkIn(serviceScope),
      Effect.andThen(Deferred.await(done)),
    );
  }).pipe(Effect.withSpan("HostedBlenderSetup.check"));

  const ensureChecked = SubscriptionRef.get(ref).pipe(
    Effect.flatMap((internal) => (internal.state.result === null ? check : Effect.void)),
  );

  const state: HostedBlenderSetup["Service"]["state"] = SubscriptionRef.changes(ref).pipe(
    Stream.map((internal) => internal.state),
    Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
  );

  const enabledChanges = Stream.unwrap(
    Effect.gen(function* () {
      const changes = yield* settings.subscribeChanges;
      // Unreadable settings count as switched off, so `open` answers instead of waiting.
      const current = yield* settings.getSettings.pipe(
        Effect.map((value) => value.hostedBlenderEnabled),
        Effect.orElseSucceed(() => false),
      );
      return Stream.concat(
        Stream.succeed(current),
        changes.pipe(Stream.map((value: ServerSettingsValue) => value.hostedBlenderEnabled)),
      );
    }),
  ).pipe(Stream.changes);

  const readiness: HostedBlenderSetup["Service"]["readiness"] =
    platform !== "linux"
      ? Stream.concat(
          Stream.succeed<HostedBlenderReadiness>({ status: "unavailable", reason: "platform" }),
          Stream.never,
        )
      : enabledChanges.pipe(
          Stream.switchMap((enabled) =>
            SubscriptionRef.changes(ref).pipe(
              Stream.map((internal) => readinessOf(enabled, internal)),
            ),
          ),
          Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        );

  // Switching Hosted Blender on (settings write access) checks the server; its starting value doesn't.
  if (platform === "linux") {
    yield* enabledChanges.pipe(
      Stream.drop(1),
      Stream.filter((enabled) => enabled),
      Stream.runForEach(() => check),
      Effect.forkIn(serviceScope),
    );
  }

  const failLaunch = () => new HostedBlenderSetupError({ reason: "launchFailed" });

  const launch = Effect.fn("HostedBlenderSetup.launch")(function* (
    result: CheckedSetup,
    release: OsRelease | null,
  ) {
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const { projectId } = yield* folders.ensureScratchProject.pipe(
      Effect.mapError(() => new HostedBlenderSetupError({ reason: "noProject" })),
    );
    const project = yield* ProjectService.ProjectService.pipe(
      Effect.flatMap((projects) => projects.getById(projectId)),
      Effect.mapError(failLaunch),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new HostedBlenderSetupError({ reason: "noProject" })),
          onSome: Effect.succeed,
        }),
      ),
    );
    const current = yield* settings.getSettings.pipe(Effect.mapError(failLaunch));
    const defaults = resolveProjectSettings(current, projectId, project).settings;
    // The user's default agent, as a new thread in the composer gets.
    const modelSelection = resolveNewThreadModelSelection({
      defaultSelection: defaults.defaultModelSelection,
      fallbackSelection: defaults.fallbackModelSelection,
      providers: yield* ProviderRegistry.ProviderRegistry.pipe(
        Effect.flatMap((registry) => registry.getProviders),
      ),
      settings: defaults,
      projectId,
      now: yield* Clock.currentTimeMillis,
    }).selection;
    if (modelSelection === null) {
      return yield* new HostedBlenderSetupError({ reason: "noDefaultModel" });
    }
    const commandId = CommandId.make(
      `hosted-blender-setup:${yield* random.uuidV4().pipe(Effect.mapError(failLaunch))}`,
    );
    const launched = yield* ThreadLaunch.ThreadLaunchService.pipe(
      Effect.flatMap((launches) =>
        launches.launch({
          commandId,
          threadId: ThreadId.make(commandId),
          projectId,
          title: "Set up hosted Blender",
          titleRenamed: true,
          modelSelection,
          runtimeMode: defaults.defaultRuntimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy: { type: "root" },
          initialMessage: { text: installPrompt(result, release), attachments: [] },
          createdBy: "user",
          creationSource: "server",
        }),
      ),
      Effect.mapError(failLaunch),
    );
    return { projectId, threadId: launched.threadId };
  });

  // When the install agent's turn ends, however it ends, T3 checks again.
  const checkAfterInstall = Effect.fn("HostedBlenderSetup.checkAfterInstall")(function* (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads
      .waitForThread({
        projectId: input.projectId,
        threadId: input.threadId,
        timeoutMs: INSTALL_WAIT_MS,
      })
      .pipe(Effect.ignore);
    yield* update((internal) =>
      internal.state.installThreadId === input.threadId
        ? { ...internal, state: { ...internal.state, installThreadId: null } }
        : internal,
    );
    yield* check;
  });

  const installWithAgent: HostedBlenderSetup["Service"]["installWithAgent"] = Effect.gen(
    function* () {
      yield* ensureChecked;
      const { state: current } = yield* SubscriptionRef.get(ref);
      // One install thread at a time: a second request, from any device, gets the running one.
      if (current.installThreadId !== null) return { threadId: current.installThreadId };
      const result = current.result;
      if (result === null || result.status === "unavailable") {
        return yield* new HostedBlenderSetupError({ reason: "unavailable" });
      }
      if (!needsInstall(result)) {
        return yield* new HostedBlenderSetupError({ reason: "nothingToInstall" });
      }
      // The browser gets only the reason; the cause stays in the server log.
      const launched = yield* launch(result, (yield* SubscriptionRef.get(ref)).osRelease).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("Could not start the hosted Blender setup thread", { cause }),
        ),
      );
      yield* update((internal) => ({
        ...internal,
        state: { ...internal.state, installThreadId: launched.threadId },
      }));
      yield* checkAfterInstall(launched).pipe(Effect.forkIn(serviceScope));
      return { threadId: launched.threadId };
    },
  ).pipe(
    installLock.withPermits(1),
    Effect.provideContext(launchContext),
    Effect.withSpan("HostedBlenderSetup.installWithAgent"),
  );

  return HostedBlenderSetup.of({ state, check, ensureChecked, installWithAgent, readiness });
});

export const layer = Layer.effect(HostedBlenderSetup, makeWith({ systemRoot: "/" }));
