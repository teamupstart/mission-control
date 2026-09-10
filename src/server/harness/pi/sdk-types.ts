import type { ThinkingLevel } from "@shared/types.ts";

// The ONLY shape of Pi the driver is allowed to know.
//
// `sdk-deps.ts` is where these meet `@earendil-works/pi-coding-agent`, and it is the one
// module that imports the vendor at all. Everything in `sdk.ts` is written against this
// file, which is what lets a test drive the REAL adapter - the real event normalization,
// the real turn accounting, the real controls - with no Pi installed, no credentials read
// and no model spent.
//
// Narrow on purpose. Pi's public entrypoint exports well over two hundred names; the eight
// interfaces below are what a managed session needs, and a vendor bump that moves one of
// them fails to compile in `sdk-deps.ts` rather than at some call site months later.

/**
 * Pi's own thinking vocabulary, which is WIDER than the app's `ThinkingLevel`.
 *
 * `off` and `minimal` have no name in `THINKING_LEVELS`, so they can arrive from Pi and can
 * never be requested by Mission Control - the same asymmetry `pi/meta.ts` already handles
 * when it reads a `thinking_level_change` record back off the transcript.
 */
export type PiThinkingLevel = "off" | "minimal" | ThinkingLevel;

/** A provider-qualified model id, split exactly once at its first `/`. */
export interface PiModelRef {
  /** The part before the first `/` - `amazon-bedrock`, `anthropic`, `openai`. */
  provider: string;
  /** Everything after it, slashes included - `deepseek.v3.2`, `openrouter/some/model`. */
  id: string;
}

/** Per-turn token and cost accounting, as Pi's assistant messages carry it. */
export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** A SUBSET of `output`, when the provider reports a reasoning breakdown. */
  reasoning: number | null;
  /** Pi's own dollar figure for the request, or null when it priced nothing. */
  costUsd: number | null;
}

/** One assistant turn, reduced to the four things the driver reads off it. */
export interface PiAssistantSummary {
  /** The model that actually served the request, provider-qualified. */
  modelId: string | null;
  usage: PiUsage | null;
  /** Pi's stop reason: `stop`, `aborted`, `error`, `length`, `toolUse`, `deferred`. */
  stopReason: string | null;
  /** Present only on a turn that failed. Never a credential value - see `redact`. */
  errorMessage: string | null;
}

/**
 * The Pi session events this driver consumes, and nothing else.
 *
 * A CLOSED union rather than Pi's own open one, so the normalizer's switch is exhaustive
 * and a vendor event this build has no answer for is dropped in `sdk-deps.ts` instead of
 * reaching the adapter as an unhandled shape. See `narrowPiEvent`.
 */
export type PiSessionEvent =
  | { type: "agent_start" }
  /** One agent run ended. `willRetry` means Pi is about to run again, so it is NOT a turn. */
  | { type: "agent_end"; willRetry: boolean }
  /** The prompt call has fully unwound: exactly one of these per accepted idle turn. */
  | { type: "agent_settled" }
  | { type: "turn_start" }
  | { type: "turn_end" }
  /** An assistant message began streaming. The ONE activity event per message. */
  | { type: "message_start" }
  /** An assistant message is final. Carries the turn's usage and any provider error. */
  | { type: "message_end"; assistant: PiAssistantSummary | null }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; command: string | null }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      /** Text the tool returned, already clipped. Read only for `gh pr create` evidence. */
      output: string | null;
    }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; aborted: boolean; willRetry: boolean; errorMessage: string | null }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number }
  | { type: "thinking_level_changed"; level: PiThinkingLevel };

/** One image attachment, already read and encoded. Pi takes bytes, not paths. */
export interface PiImage {
  /** base64, without a data-url prefix. */
  data: string;
  mimeType: string;
}

/** How a busy session's turn is queued. Pi's own two words. */
export type PiStreamingBehavior = "steer" | "followUp";

export interface PiPromptOptions {
  /** Required when the session is streaming; omitted starts a fresh turn. */
  streamingBehavior?: PiStreamingBehavior;
  images?: readonly PiImage[];
  /**
   * Pi's acceptance boundary, and the whole reason `send` can ack at all.
   *
   * `prompt()` resolves when the TURN finishes, which is far too late for a caller that
   * has to know whether the harness took the message. Pi calls this the moment it has -
   * `true` once the turn is queued or started, `false` on a preflight refusal, which is
   * then followed by the rejection itself.
   */
  preflightResult(accepted: boolean): void;
}

/**
 * One live Pi conversation - what `AgentSessionRuntime.session` currently points at.
 *
 * Replaced wholesale by a clear (`newSession`), which is why nothing above this holds one:
 * the adapter reaches it through `PiRuntime.session` every time.
 */
export interface PiSession {
  /** Pi's durable session id - the uuid `pi --session <id>` reopens. */
  readonly sessionId: string;
  /** The JSONL file Pi is writing, or null when this session is not persisted. */
  readonly sessionFile: string | null;
  /** The provider-qualified model this session is bound to, or null if none resolved. */
  readonly modelId: string | null;
  /** No agent run, compaction, branch summary, retry, or queued continuation. */
  readonly idle: boolean;
  /** An agent run is in progress. The negation of "a fresh prompt would start a turn". */
  readonly streaming: boolean;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  prompt(text: string, options: PiPromptOptions): Promise<void>;
  /** Stop the running turn and wait for the agent to be idle. */
  abort(): Promise<void>;
  /** Session-local model change. Rejects when the provider has no configured auth. */
  setModel(model: PiModelRef): Promise<void>;
  /** Session-local thinking change, clamped by Pi to what the model supports. */
  setThinkingLevel(level: PiThinkingLevel): void;
}

/** Pi's session-owning runtime: the thing a clear replaces and a stop disposes. */
export interface PiRuntime {
  readonly session: PiSession;
  /** Called with the REPLACEMENT session after `newSession` swaps it in. */
  onSessionReplaced(handler: (session: PiSession) => void): void;
  /** Pi's `/new`: tear the current session down and start a fresh one in the same cwd. */
  newSession(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PiRuntimeOptions {
  cwd: string;
  /**
   * An existing Pi session FILE to reopen exactly, or null to create a durable new one.
   *
   * A path rather than an id because that is what Pi's `SessionManager.open` takes; the
   * adapter resolves the id it persisted through `findSessionFile` first, so a missing
   * conversation is an explicit failure before any runtime exists.
   */
  sessionPath: string | null;
  /** The explicit model, or null to let Pi follow its own configured default. */
  model: PiModelRef | null;
  thinkingLevel: PiThinkingLevel | null;
  /**
   * Whether Pi may load this checkout's project-local executable resources.
   *
   * Answered from Pi's OWN durable trust store before the runtime is built, and never by
   * prompting - Phase 1 has no surface to ask on. False keeps project-local extensions,
   * packages and `SYSTEM.md` out while user and global configuration still load.
   */
  trusted: boolean;
  /**
   * The operator's REPOSITORY STANDING INSTRUCTIONS, as Pi's own system-prompt append.
   *
   * The same channel `pi --append-system-prompt <value>` spends on the terminal runtime:
   * the flag is the CLI spelling of the resource loader's `appendSystemPrompt`, so the two
   * runtimes deliver one operator instruction the same way rather than one out of band and
   * one as turn-one prose.
   *
   * Empty means send nothing, which is what a launch with no standing instructions gets.
   */
  appendSystemPrompt: readonly string[];
  /**
   * The environment Pi's shell tools run under, replacing the daemon's own.
   *
   * A managed Pi session runs IN THIS PROCESS, so unlike Claude and Codex there is no
   * subprocess boundary to isolate at spawn time - the bash tool would otherwise inherit
   * the daemon's `MISSION_HOME`, its loopback bearer and its terminal pane identity. This
   * is that isolation moved to the only place Pi offers one.
   */
  toolEnv: Record<string, string>;
}

/** Everything the Pi driver reaches for outside itself. Tests replace the whole object. */
export interface PiSdk {
  /** Pi's own agent directory - `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. Never re-derived. */
  agentDir(): string;
  /** Whether `cwd` holds project-local resources Pi gates behind a trust decision. */
  hasTrustRequiringProjectResources(cwd: string): boolean;
  /** Pi's DURABLE decision for `cwd`: true, false, or null when nobody has decided. */
  projectTrust(cwd: string): boolean | null;
  /** The session file for an exact Pi session id under `cwd`, or null when it is gone. */
  findSessionFile(cwd: string, sessionId: string): Promise<string | null>;
  /** Build the managed runtime. Rejects rather than degrading - see `SdkSpec.launch`. */
  createRuntime(options: PiRuntimeOptions): Promise<PiRuntime>;
}

export interface PiSdkDeps {
  /** Load the vendor package and project it. Rejects when Pi's SDK cannot be loaded. */
  load(): Promise<PiSdk>;
  /** The environment Pi's in-process shell tools should run under. */
  toolEnv(cwd: string, stateHome: string): Record<string, string>;
}
