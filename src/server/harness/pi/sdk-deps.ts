import type {
  AgentSessionEvent,
  CreateAgentSessionFromServicesOptions,
  PromptOptions,
  AgentSessionRuntime,
  AgentSessionServices,
  CreateAgentSessionRuntimeFactory,
  ModelRuntime,
  AgentSession as VendorSession,
  SessionManager as VendorSessionManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { sdkSubprocessEnv } from "../claude/sdk-deps.ts";
import { PiSdkError, redact } from "./sdk-errors.ts";
import type {
  PiAssistantSummary,
  PiModelRef,
  PiRuntime,
  PiRuntimeOptions,
  PiSdk,
  PiSdkDeps,
  PiSession,
  PiSessionEvent,
  PiUsage,
} from "./sdk-types.ts";

/**
 * Pi's own model object, derived from the runtime that hands them out.
 *
 * Named from `ModelRuntime` rather than imported from `@earendil-works/pi-ai`, which is a
 * TRANSITIVE dependency of the pinned package rather than one this repository declares -
 * reaching for it directly would make the driver depend on a package `npm ls` says we do
 * not have, and which a future Pi release is free to move.
 */
type PiVendorModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** One image attachment, in the exact shape Pi's `prompt` accepts. */
type PiVendorImage = NonNullable<PromptOptions["images"]>[number];

// The ONE module that imports `@earendil-works/pi-coding-agent`.
//
// Everything else in the Pi driver is written against `sdk-types.ts`, so this file is
// where the vendor's surface meets ours and where a version bump that moves that surface
// fails to compile. It is deliberately thin: no turn accounting, no event policy, nothing
// a test would want to exercise - all of that is in `sdk.ts`, which a test drives on a
// scripted `PiSdk` with these deps replaced.
//
// Pi differs from Claude and Codex in one structural way that shapes this whole file: its
// SDK runs IN THIS PROCESS. There is no `pi` subprocess to point at a fake binary and no
// stdio to script, which is why the seam has to be the module import rather than the
// executable - and why `toolEnv` exists at all (see below).

/** How much of a tool's argument crosses this seam. A display bound; see `toolCommand`. */
const TOOL_COMMAND_CAP = 4096;

/**
 * Redirect the Pi SDK at another module, the way `MISSION_PI_BIN` redirects the CLI.
 *
 * The two are the SAME override wearing different clothes, and Pi needs both because its
 * managed runtime has no subprocess: for Claude and Codex the fake is a binary the driver
 * spawns, and pointing `MISSION_<AGENT>_BIN` at one is what makes the browser suite free to
 * run. Pi's SDK is imported into this process instead, so a fake `pi` on disk cannot stand
 * in for it and the module specifier is the only seam of the same shape.
 *
 * It is no wider a door than the binary overrides are: a process that can set the daemon's
 * environment has already replaced the daemon. Unset - which is every ordinary run - this
 * resolves nothing and the pinned package is used.
 *
 * The module must export `createPiSdk(): PiSdk | Promise<PiSdk>`. See
 * `e2e/fixtures/fake-pi-sdk.mjs`.
 */
export const PI_SDK_MODULE_ENV = "MISSION_PI_SDK_MODULE";

/**
 * Load the vendor package.
 *
 * Imported lazily, for the reason Claude's driver gives: the bundle is several megabytes
 * and a daemon whose operator never turns the managed Pi runtime on should not pay for it
 * at boot, nor should the test suite pay for it on every file that reaches the harness
 * registry. esbuild still inlines it into `dist/server/index.mjs`, so this resolves nothing
 * at runtime in a packaged build - `npm run smoke` proves that the inlined copy loads.
 */
async function importPi(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
  try {
    return await import("@earendil-works/pi-coding-agent");
  } catch (err) {
    throw new PiSdkError(
      "sdk-unavailable",
      `Pi's SDK could not be loaded (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
}

/** `${provider}/${id}`, the exact spelling the model catalog and the picker use. */
function qualified(model: PiVendorModel | undefined): string | null {
  return model ? `${model.provider}/${model.id}` : null;
}

function usageOf(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  cost: { total: number };
}): PiUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: typeof usage.reasoning === "number" ? usage.reasoning : null,
    // Pi prices every request it can price, and a zero is a real answer (a subscription
    // turn), so only an absent figure becomes null.
    costUsd: typeof usage.cost?.total === "number" ? usage.cost.total : null,
  };
}

/** Everything the driver reads off one finished assistant message, or null if it is not one. */
function assistantSummary(message: unknown): PiAssistantSummary | null {
  if (!message || typeof message !== "object") return null;
  const m = message as {
    role?: unknown;
    provider?: unknown;
    model?: unknown;
    responseModel?: unknown;
    usage?: Parameters<typeof usageOf>[0];
    stopReason?: unknown;
    errorMessage?: unknown;
  };
  if (m.role !== "assistant") return null;
  // `responseModel` is what the provider says it actually served, which can differ from the
  // alias that was requested. Preferred for exactly that reason, with the request's own id
  // as the fallback - a card must never show a model nobody selected, and must never blank.
  const id = typeof m.responseModel === "string" ? m.responseModel : m.model;
  return {
    modelId:
      typeof m.provider === "string" && typeof id === "string" ? `${m.provider}/${id}` : null,
    usage: m.usage ? usageOf(m.usage) : null,
    stopReason: typeof m.stopReason === "string" ? m.stopReason : null,
    errorMessage: typeof m.errorMessage === "string" ? redact(m.errorMessage) : null,
  };
}

/** Our encoded attachment, in Pi's own content-part spelling. */
function vendorImage(image: { data: string; mimeType: string }): PiVendorImage {
  return { type: "image", data: image.data, mimeType: image.mimeType };
}

/**
 * A bash-shaped tool call's command line, when that is what this tool takes.
 *
 * Bounded, because the only thing downstream of it is the card's activity line - which
 * `toolActivity` clips to eighty characters anyway. It briefly carried the WHOLE command so
 * that `opensPullRequest` could not miss a `gh pr create` at the end of a long chain; that
 * reader is gone with the pull-request provenance it served (Phase 1 excludes it), and with
 * it the reason to let an arbitrary vendor string cross this seam unbounded.
 */
function toolCommand(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command.slice(0, TOOL_COMMAND_CAP) : null;
}


/**
 * Project one vendor event into the closed union the adapter switches on, or drop it.
 *
 * The explicit switch is the point: it is what makes THIS module the place a Pi release
 * that renames an event or moves a field fails, rather than a normalizer that silently
 * stops recognizing something. `null` means "an event this build has no answer for", which
 * covers the ten or so Pi emits that a managed Mission Control session does not consume -
 * queue updates, session-info renames, bash-execution deltas, summarization retries.
 */
export function narrowPiEvent(event: AgentSessionEvent): PiSessionEvent | null {
  switch (event.type) {
    case "agent_start":
      return { type: "agent_start" };
    case "agent_end":
      return { type: "agent_end", willRetry: event.willRetry };
    case "agent_settled":
      return { type: "agent_settled" };
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end" };
    case "message_start":
      return { type: "message_start" };
    case "message_end":
      return { type: "message_end", assistant: assistantSummary(event.message) };
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        command: toolCommand(event.args),
      };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };
    case "compaction_start":
      return { type: "compaction_start", reason: event.reason };
    case "compaction_end":
      return {
        type: "compaction_end",
        aborted: event.aborted,
        willRetry: event.willRetry,
        errorMessage: event.errorMessage ? redact(event.errorMessage) : null,
      };
    case "auto_retry_start":
      return {
        type: "auto_retry_start",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        errorMessage: redact(event.errorMessage),
      };
    case "auto_retry_end":
      return { type: "auto_retry_end", success: event.success, attempt: event.attempt };
    case "thinking_level_changed":
      return { type: "thinking_level_changed", level: event.level };
    default:
      return null;
  }
}

/** Wrap one vendor `AgentSession` in the narrow surface the adapter drives. */
function projectSession(session: VendorSession, runtime: ModelRuntime): PiSession {
  return {
    get sessionId() {
      return session.sessionId;
    },
    get sessionFile() {
      return session.sessionFile ?? null;
    },
    get modelId() {
      return qualified(session.model);
    },
    get idle() {
      return session.isIdle;
    },
    get streaming() {
      return session.isStreaming;
    },
    subscribe(listener) {
      return session.subscribe((event) => {
        const narrowed = narrowPiEvent(event);
        if (narrowed) listener(narrowed);
      });
    },
    prompt(text, options) {
      return session.prompt(text, {
        ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
        ...(options.images?.length ? { images: options.images.map(vendorImage) } : {}),
        preflightResult: options.preflightResult,
      });
    },
    abort() {
      return session.abort();
    },
    async setModel(ref) {
      await session.setModel(await requireModel(runtime, ref));
    },
    setThinkingLevel(level) {
      session.setThinkingLevel(level);
    },
  };
}

/**
 * Resolve a provider/model pair against Pi's own catalog, or refuse.
 *
 * REFUSES rather than falls back, per `SdkSpec.launch`: a card that looks dispatched while
 * running a model nobody selected is the outcome that rule exists to prevent, and on a paid
 * provider it is also a bill nobody agreed to. The auth probe mirrors Pi's own preflight
 * exactly - a configured credential, or a live `checkAuth` - so a provider whose key lives
 * in the environment is not refused for lacking an `auth.json` entry.
 */
async function requireModel(runtime: ModelRuntime, ref: PiModelRef): Promise<PiVendorModel> {
  const model = runtime.getModel(ref.provider, ref.id);
  if (!model) {
    throw new PiSdkError(
      "model-unavailable",
      `Pi does not offer the model ${ref.provider}/${ref.id}`,
    );
  }
  let authorized = runtime.hasConfiguredAuth(ref.provider);
  if (!authorized) {
    try {
      authorized = (await runtime.checkAuth(ref.provider)) !== undefined;
    } catch {
      authorized = false;
    }
  }
  if (!authorized) {
    throw new PiSdkError(
      "provider-signed-out",
      `Pi has no credential for ${ref.provider} - open a Pi session and run /login ${ref.provider}`,
    );
  }
  return model;
}

/** Wrap the vendor runtime, keeping `AgentSessionRuntime` itself out of the adapter. */
function projectRuntime(runtime: AgentSessionRuntime, models: () => ModelRuntime): PiRuntime {
  return {
    get session() {
      return projectSession(runtime.session, models());
    },
    onSessionReplaced(handler) {
      // Pi calls this after the replacement session exists and before `newSession`
      // resolves, which is what lets the adapter re-subscribe and rebind its identity
      // without a window where events from the new conversation reach nobody.
      runtime.setRebindSession(async (session) => {
        handler(projectSession(session, models()));
      });
    },
    async newSession() {
      const result = await runtime.newSession();
      if (result.cancelled) {
        throw new PiSdkError("provider-error", "Pi refused to start a new session");
      }
    },
    dispose() {
      return runtime.dispose();
    },
  };
}

/**
 * Build one managed Pi runtime for one Mission Control session.
 *
 * Exported for `test/pi-sdk-adapter.test.ts`, which drives it with a stand-in vendor to pin
 * the ordering below: the real one cannot be made to fail a SECOND factory invocation
 * without failing the first.
 */
export async function createRuntime(
  pi: typeof import("@earendil-works/pi-coding-agent"),
  options: PiRuntimeOptions,
): Promise<PiRuntime> {
  const agentDir = pi.getAgentDir();
  // Held so the projection above can reach the CURRENT services' model runtime after a
  // clear replaces them, rather than closing over the one this launch happened to build.
  let services: AgentSessionServices | null = null;
  const factory: CreateAgentSessionRuntimeFactory = async (target) => {
    const created = await pi.createAgentSessionServices({
      cwd: target.cwd,
      agentDir: target.agentDir,
      // Phase 1 has no surface to ask trust on, so this NEVER prompts: it replays a durable
      // decision Pi already holds, and `false` keeps project-local executable resources out
      // while user and global configuration still load. See `PiRuntimeOptions.trusted`.
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => options.trusted },
      resourceLoaderOptions: {
        // The operator's standing instructions, through the option `--append-system-prompt`
        // itself routes into (`main.ts` hands the flag straight to this field). Passed on
        // EVERY runtime creation rather than only the first, so the rules survive a clear:
        // `newSession` rebuilds services through this same factory.
        ...(options.appendSystemPrompt.length > 0
          ? { appendSystemPrompt: [...options.appendSystemPrompt] }
          : {}),
      },
    });
    const model = options.model ? await requireModel(created.modelRuntime, options.model) : undefined;
    const session = await pi.createAgentSessionFromServices({
      services: created,
      sessionManager: target.sessionManager,
      ...(target.sessionStartEvent ? { sessionStartEvent: target.sessionStartEvent } : {}),
      ...(model ? { model } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      // The bash tool, rebuilt with Mission Control's own environment. A custom tool of the
      // same name replaces the built-in in Pi's registry, which is the only seam its public
      // composition offers - and it is needed because this SDK runs in the DAEMON's process,
      // so there is no spawn boundary where `agentSubprocessEnv` would otherwise apply.
      customTools: [
        // ONE cast, and it is a variance quirk in Pi's own types rather than a claim of
        // ours: `createBashToolDefinition` returns a `ToolDefinition` parameterised by the
        // bash argument schema, while `customTools` is declared with the default
        // `ToolDefinition<TSchema, unknown, any>`, whose renderer parameter is
        // contravariant in exactly that schema. Pi's own tool factory produces the value
        // this field is for; nothing here is asserting a shape we invented.
        pi.createBashToolDefinition(target.cwd, {
          spawnHook: (context) => ({
            ...context,
            env: { ...options.toolEnv, ...piVariables(context.env) },
          }),
        }) as unknown as NonNullable<CreateAgentSessionFromServicesOptions["customTools"]>[number],
      ],
    });
    // Published only now that this invocation has a session to show for it. A clear
    // re-enters this factory while the OLD session is still live, and `requireModel` above
    // throws for a model that went away between turns - so assigning on the way in would
    // leave `models()` resolving the still-running session against services it never used.
    // Nothing is leaked by dropping `created` on that path: measured against 0.85.1,
    // `AgentSessionServices` is a plain record of `cwd`, `agentDir`, `modelRuntime`,
    // `settingsManager`, `resourceLoader` and `diagnostics`, with no dispose, close or
    // destroy on it or on any of its members, and no timer or watcher outliving its
    // construction.
    services = created;
    return { ...session, services: created, diagnostics: created.diagnostics };
  };
  const sessionManager = openSessionManager(pi.SessionManager, options);
  const runtime = await pi.createAgentSessionRuntime(factory, {
    cwd: options.cwd,
    agentDir,
    sessionManager,
  });
  return projectRuntime(runtime, () => {
    if (!services) throw new PiSdkError("provider-error", "this Pi session has no model runtime");
    return services.modelRuntime;
  });
}

/** Pi's own `PI_*` session variables, preserved across the environment replacement above. */
function piVariables(env: NodeJS.ProcessEnv): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("PI_") && typeof value === "string") kept[name] = value;
  }
  return kept;
}

/** A brand-new durable conversation, or the exact stored one - never a look-alike. */
function openSessionManager(
  manager: typeof VendorSessionManager,
  options: PiRuntimeOptions,
): VendorSessionManager {
  if (!options.sessionPath) return manager.create(options.cwd);
  // Checked BEFORE the vendor is asked, because the vendor does not check: measured against
  // 0.85.1, `SessionManager.open` on a path that does not exist returns a manager for a NEW
  // conversation rather than throwing. Relying on the catch below would therefore have
  // turned a session whose file vanished into a fresh conversation wearing the old Mission
  // Control id - the note, the goal and the work episode all still pointing at it - which is
  // the single outcome `resumeTarget` exists to prevent. The catch stays as the backstop for
  // a file that exists and cannot be parsed.
  if (!existsSync(options.sessionPath)) {
    throw new PiSdkError(
      "resume-unavailable",
      `Pi's session file ${options.sessionPath} is gone, so there is no conversation to continue`,
    );
  }
  try {
    return manager.open(options.sessionPath, undefined, options.cwd);
  } catch (err) {
    throw new PiSdkError(
      "resume-unavailable",
      `Pi could not reopen ${options.sessionPath} (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
}

/**
 * The module named by `MISSION_PI_SDK_MODULE`, or null when nothing redirects the SDK.
 *
 * The specifier is not statically analyzable, so esbuild leaves this as a real runtime
 * import rather than inlining it - which is what an override pointing at a file outside the
 * bundle needs, and what keeps the ordinary path resolving the inlined package instead.
 */
async function loadOverride(): Promise<PiSdk | null> {
  const path = process.env[PI_SDK_MODULE_ENV];
  if (!path) return null;
  let module: { createPiSdk?: () => PiSdk | Promise<PiSdk> };
  try {
    module = (await import(pathToFileURL(path).href)) as typeof module;
  } catch (err) {
    throw new PiSdkError(
      "sdk-unavailable",
      `${PI_SDK_MODULE_ENV} names ${path}, which could not be loaded (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  if (typeof module.createPiSdk !== "function") {
    throw new PiSdkError(
      "sdk-unavailable",
      `${PI_SDK_MODULE_ENV} names ${path}, which exports no createPiSdk function`,
    );
  }
  return await module.createPiSdk();
}

/** What the shipped driver uses. Tests replace the whole object. */
export const defaultPiSdkDeps: PiSdkDeps = {
  async load(): Promise<PiSdk> {
    const override = await loadOverride();
    if (override) return override;
    const pi = await importPi();
    return {
      agentDir: () => pi.getAgentDir(),
      hasTrustRequiringProjectResources: (cwd) => pi.hasTrustRequiringProjectResources(cwd),
      projectTrust: (cwd) => new pi.ProjectTrustStore(pi.getAgentDir()).get(cwd),
      async findSessionFile(cwd, sessionId) {
        // Pi's own listing rather than a directory walk of our own: it honours
        // `$PI_CODING_AGENT_DIR`, its cwd encoding, and its session-file naming, none of
        // which this daemon should be re-deriving. An EXACT id match only - a prefix match
        // is what `pi --session` offers a human at a keyboard, not what a restart may use.
        const sessions = await pi.SessionManager.list(cwd);
        return sessions.find((session) => session.id === sessionId)?.path ?? null;
      },
      createRuntime: (options) => createRuntime(pi, options),
    };
  },
  toolEnv(cwd, stateHome) {
    // `sdkSubprocessEnv` for exactly the reasons it documents, shared with Claude's and
    // Codex's drivers rather than restated: it is a fact about the DAEMON's environment,
    // not about any one harness. What it removes matters more here than anywhere else,
    // because nothing else stands between this process and the agent's shell.
    return sdkSubprocessEnv(process.env, cwd, stateHome) as Record<string, string>;
  },
};
