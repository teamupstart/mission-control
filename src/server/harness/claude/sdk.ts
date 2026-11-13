import { cumulativeUsageBaseline, cumulativeUsageDelta as claudeUsageDelta } from "../../sdk/cumulative-usage.ts";
export { cumulativeUsageDelta as claudeUsageDelta } from "../../sdk/cumulative-usage.ts";
import { resolveTranscriptPath } from "./transcript.ts";
import { CompactionCompletion } from "../compaction.ts";
import { defaultWindowForModel } from "@shared/model.ts";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  PaneOption,
  PermissionMode,
  RateLimits,
  RateLimitWindow,
  SdkSendDisposition,
  SessionRequestQuestion,
  ThinkingLevel,
} from "@shared/types.ts";
import { opensPullRequest, pullRequestUrlsIn } from "@shared/pr-command.mjs";
import type {
  SdkEvent,
  ResidentMcpEntry,
  SdkLaunchOptions,
  SdkSessionHandle,
  SdkSpec,
  SdkTurn,
  SdkTurnFailure,
  SdkUsage,
  SessionRequest,
  SessionRequestAnswer,
} from "../types.ts";
import { isProviderCapacityMessage } from "../../llm/provider-failure.ts";
import type { LlmSpendModelUsage } from "@shared/llm-spend.ts";
import { claudeEnvelopeModels, claudeEnvelopeTurnId } from "./envelope.ts";
import type {
  ClaudeSdkDeps,
  ClaudeSdkQuery,
  ClaudeSdkQueryOptions,
  ClaudeSdkMessage,
  ClaudeSdkPermissionMode,
  ClaudeSdkPermissionResult,
  ClaudeSdkPermissionUpdate,
  ClaudeSdkUsageResponse,
  ClaudeSdkUsageWindow,
  ClaudeSdkUserMessage,
} from "./sdk-types.ts";
import { defaultClaudeSdkDeps } from "./sdk-deps.ts";
import { withAgentTraceContext } from "../../agent-trace-context.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { EventStream } from "../../sdk/event-stream.ts";
import { sdkAskChannel } from "../../ask-channel-prompt.ts";
import { SubagentEmitter } from "../../sdk/subagent-emitter.ts";
import {
  claudeSubagentSummary,
  emptyClaudeSubagents,
  foldClaudeSubagents,
  isClaudeSubagentFrame,
  observeClaudeSubagentFrame,
  type ClaudeSubagentState,
} from "./subagents.ts";

// Claude Code, driven EMBEDDED - the `@anthropic-ai/claude-agent-sdk` behind `SdkSpec`.
//
// This is the write path and the state path for a session the daemon RUNS. The read path
// is untouched: the subprocess writes the same `~/.claude/projects/<cwd>/<id>.jsonl` the
// interactive CLI writes, so `claudeTranscript` and the transcript SSE stream keep working
// through `transcriptPath` with no arm of their own. That is the whole reason `bound` carries
// a path at all.
//
// ## What this module is allowed to know
//
// The SDK's vocabulary stops here. Everything above `SdkSessionHandle` speaks `SdkEvent`
// and `SessionRequest`, which is what lets the supervisor, the registry and the routes stay
// harness-neutral - the same split `transcript.ts` makes between "which file" and "what a
// line means". A second driver (Codex's app-server, pi's JSONL) is another module of this
// shape, not a branch inside this one.
//
// ## The seam
//
// `ClaudeSdkDeps.query` is this file's `PaneDeps.pane`: a factory a test replaces with a
// scripted message stream, so the REAL adapter - every projection, every answer mapping,
// the pending-request bookkeeping - is exercised without a `claude` binary on the machine.
// The default (`sdk-deps.ts`) is the only place that imports the vendor package, so a test
// never pays its 4MB load either.

/**
 * A permission ask, as three rows.
 *
 * These labels are the wire contract of the answer: `/select-option` echoes the label back
 * and the supervisor verifies it with the same `optionRowMiss` rule the pane path uses, so
 * changing a spelling here invalidates an ask that is already on someone's screen. That is
 * survivable (the answer is refused with a 409 and the human clicks again) but it is not
 * free, so they are named once, here.
 */
const ALLOW_LABEL = "Yes";
const ALLOW_ALWAYS_LABEL = "Yes, and don't ask again";
const DENY_LABEL = "No";

/** The plan-approval rows. `ExitPlanMode` is a permission ask with a different question. */
const PLAN_APPROVE_LABEL = "Yes, proceed";
const PLAN_KEEP_LABEL = "No, keep planning";

/**
 * The tools whose permission callback is NOT a permission question.
 *
 * `AskUserQuestion` is the agent asking its human something, and `ExitPlanMode` is it
 * asking to start work - both arrive through `canUseTool` because that is the only channel
 * the SDK has, and both would read as "Claude wants to use a tool" if this file did not
 * say otherwise.
 */
const ASK_USER_QUESTION = "AskUserQuestion";
const EXIT_PLAN_MODE = "ExitPlanMode";

function sdkUsageWindow(window: ClaudeSdkUsageWindow | null | undefined): RateLimitWindow | null {
  if (
    !window ||
    typeof window.utilization !== "number" ||
    !Number.isFinite(window.utilization) ||
    window.utilization < 0 ||
    window.utilization > 100 ||
    typeof window.resets_at !== "string"
  ) return null;
  const resetMs = Date.parse(window.resets_at);
  if (!Number.isFinite(resetMs)) return null;
  return {
    usedPercentage: window.utilization,
    resetsAt: Math.floor(resetMs / 1000),
  };
}

/** Structured SDK `/usage` response -> the same two-window shape statusLine reports. */
export function claudeSdkRateLimits(
  usage: ClaudeSdkUsageResponse,
  now = Date.now(),
): RateLimits | null {
  if (!usage.rate_limits_available || !usage.rate_limits) return null;
  const fiveHour = sdkUsageWindow(usage.rate_limits.five_hour);
  const sevenDay = sdkUsageWindow(usage.rate_limits.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, updatedAt: now };
}

/** Root of Claude's per-project transcript store, mirrored from `transcript.ts`. */
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * The permission modes this driver can ask the SDK for.
 *
 * Claude's six, and not the four Codex profiles that share our `PermissionMode` union: a
 * mode this CLI has never heard of is dropped rather than passed through, because the SDK
 * validates the value and a rejected launch is a dispatch that fails for a reason no
 * operator typed. Spelled as Claude's OWN tokens, which is why `default` is `default` here
 * and `manual` in `PermissionModeSpec.launchArgs` - the flag and the control protocol
 * disagree about that one word, and both spellings are the vendor's.
 */
const SDK_PERMISSION_MODES: readonly ClaudeSdkPermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
];

export function sdkPermissionMode(mode: PermissionMode | null): ClaudeSdkPermissionMode | null {
  const known = SDK_PERMISSION_MODES.find((m) => m === mode);
  return known ?? null;
}

/**
 * Where a bound session's transcript is, derived rather than reported.
 *
 * The SDK does not hand back the path it writes, so this reconstructs Claude's documented
 * layout - the same derivation `resolveTranscriptPath` falls back to for a session whose
 * hook predates transcript reporting. It is a DERIVATION, so it returns null when the file
 * is not there yet rather than a path that might never exist: `resolveTranscriptPath` will
 * find it from `agentSessionId` on the next read either way, and a wrong path recorded on
 * the session is one the fallback can never correct.
 */
export function claudeSdkTranscriptPath(
  cwd: string,
  agentSessionId: string,
  projectsDir: string = PROJECTS_DIR,
): string | null {
  return resolveTranscriptPath({ cwd, agentSessionId, transcriptPath: null }, projectsDir);
}

/**
 * A pending `canUseTool` call: the rows we showed, and the resolver holding the tool.
 *
 * Held rather than answered inline because that IS the feature - the SDK blocks the agent
 * until this promise settles, which is what turns "a menu is on a screen somewhere" into
 * "the turn is waiting for a human". Nothing times it out: a permission prompt has no park
 * deadline in the CLI either, and inventing one here would resume an agent on a decision
 * nobody made.
 */
interface Pending {
  request: SessionRequest;
  /** The tool's own input, so a question answer can be returned as `updatedInput`. */
  input: Record<string, unknown>;
  /** `suggestions` from the SDK - what "don't ask again" would actually persist. */
  suggestions: readonly ClaudeSdkPermissionUpdate[];
  resolve: (result: ClaudeSdkPermissionResult) => void;
}

/** Turn one `AskUserQuestion` input into the questions a card can draw. */
export function askUserQuestions(input: Record<string, unknown>): SessionRequestQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const out: SessionRequestQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const rec = q as Record<string, unknown>;
    const question = typeof rec.question === "string" ? rec.question : "";
    if (!question) continue;
    const options: PaneOption[] = [];
    for (const o of Array.isArray(rec.options) ? rec.options : []) {
      if (!o || typeof o !== "object") continue;
      const orec = o as Record<string, unknown>;
      const label = typeof orec.label === "string" ? orec.label.trim() : "";
      if (!label) continue;
      const detail = typeof orec.description === "string" ? orec.description.trim() : "";
      options.push({ number: options.length + 1, label, ...(detail ? { detail } : {}) });
    }
    if (options.length === 0) continue;
    out.push({
      question,
      ...(typeof rec.header === "string" && rec.header ? { header: rec.header } : {}),
      options,
      ...(rec.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return out;
}

/**
 * The sentence a permission ask leads with.
 *
 * The bridge's own `title` when it rendered one ("Claude wants to read foo.txt"), because
 * it is the sentence the interactive CLI would have shown and this card is standing in for
 * that screen. Reconstructed from the tool name only when it did not - never from the raw
 * input, which for a `Write` is a whole file body.
 */
export function permissionPrompt(
  toolName: string,
  input: Record<string, unknown>,
  meta: { title?: string; description?: string },
): string {
  const head = meta.title?.trim() || `Claude wants to use ${toolName}`;
  const command = typeof input.command === "string" ? input.command.trim() : "";
  const detail = meta.description?.trim() || command;
  return detail ? `${head}\n\n${detail}` : head;
}

/**
 * A `content` block list for a turn: the text, then one image block per attachment.
 *
 * Base64 rather than a path, because the subprocess is handed the CONTENT: an upload lives
 * under the daemon's state dir and a sandboxed agent has no reason to be able to read it.
 * An attachment we cannot read is dropped with a warning rather than failing the send - the
 * text is the turn, and a missing screenshot must not swallow it.
 */
function turnContent(turn: SdkTurn): unknown {
  const images = turn.images ?? [];
  if (images.length === 0) return turn.text;
  const blocks: unknown[] = [];
  for (const image of images) {
    try {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mediaType ?? "image/png",
          data: readFileSync(image.path).toString("base64"),
        },
      });
    } catch (err) {
      console.warn(
        `[sdk] could not attach ${image.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Text last, mirroring how the interactive composer sends a pasted image followed by the
  // sentence about it - the model reads the instruction after the thing it refers to.
  blocks.push({ type: "text", text: turn.text });
  return blocks;
}

/**
 * An async queue of user messages: the streaming-input side of a live session.
 *
 * `query()` takes an `AsyncIterable`, and a session that accepts follow-up turns is one
 * whose iterable never ends until we end it. This is that iterable - a mailbox, not a
 * generator over a fixed list - and `push` accepting the message without throwing is what
 * makes `send()` an ACK rather than a hope. Acceptance while a turn is active means FIFO
 * queueing, which `send()` now reports instead of pretending it is already a transcript turn.
 */
class TurnStream {
  private queued: ClaudeSdkUserMessage[] = [];
  private waiting: ((m: IteratorResult<ClaudeSdkUserMessage>) => void) | null = null;
  private closed = false;

  push(message: ClaudeSdkUserMessage): void {
    if (this.closed) throw new Error("this session's input stream is closed");
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: message, done: false });
      return;
    }
    this.queued.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ClaudeSdkUserMessage> {
    for (;;) {
      const next = this.queued.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      const message = await new Promise<IteratorResult<ClaudeSdkUserMessage>>((resolve) => {
        this.waiting = resolve;
      });
      if (message.done) return;
      yield message.value;
    }
  }
}

/**
 * One embedded Claude session.
 *
 * Everything the supervisor can do to it is a method on `SdkSessionHandle`; everything it
 * learns arrives on `events`. The class exists rather than a closure because the pending
 * request map, the turn stream and the query object all have to outlive `launch()`.
 */
class ClaudeSdkSession implements SdkSessionHandle {
  private readonly pending = new Map<string, Pending>();
  private readonly out = new EventStream();
  private turns = new TurnStream();
  private query: ClaudeSdkQuery | null = null;
  private queryPump: Promise<void> | null = null;
  /** The current query ended after an auth failure but remains the stale recovery source. */
  private queryEnded = false;
  private relaunch: (
    prompt: AsyncIterable<ClaudeSdkUserMessage>,
    resume: string,
    modelOverride: string | null,
  ) => Promise<ClaudeSdkQuery> = async () => {
    throw new Error("this Claude SDK session cannot be relaunched");
  };
  /** The stale process being drained before a fresh one resumes this conversation. */
  private recoveringQuery: ClaudeSdkQuery | null = null;
  /** Set by the provider's structured failure and spent by the next accepted user turn. */
  private authenticationFailed = false;
  /** One shared replacement boundary for every send that arrives while credentials reload. */
  private authenticationRecovery: Promise<void> | null = null;
  private agentSessionId: string | null = null;
  /** The actual model reported by Claude's init frame, retained across a /clear rebind. */
  private modelId: string | null = null;
  /** An accepted live selection must outlive the query, independently of init metadata. */
  private modelOverride: string | null = null;
  /**
   * The preceding conversation-to-date usage snapshot, used to recover one turn's delta.
   *
   * Claude's streaming-input SDK keeps one `query()` alive across turns. Every `result`
   * repeats the totals for that conversation, so sending those snapshots straight to the
   * append-only ledger makes turn two include turn one again, turn three include both, and
   * so on. Retaining the last snapshot here keeps that vendor-specific counter behavior at
   * the adapter boundary for live deltas. The Registry also receives the raw snapshot
   * so its atomic ledger checkpoint can account across driver and daemon replacements.
   */
  private cumulativeUsage: SdkUsage | null = null;
  /**
   * Tool ids whose Bash input opened a pull request, awaiting the URL its output prints.
   *
   * Two halves of one fact, and both are required: the COMMAND is the authorship evidence
   * `adoptPr` accepts (`prUrl` alone is what `gh pr view` also trips), and the URL is what
   * there is to adopt. Keyed by tool id so a `gh pr create` and an unrelated `gh pr view`
   * in the same turn cannot lend each other their halves.
   */
  private readonly prPending = new Set<string>();
  /** Armed by `clearContext`, spent by the next `bind` - see both for why it must exist. */
  private clearing = false;
  /**
   * Whether the CLI is running a turn right now.
   *
   * Deliberately a boolean rather than a count of turns owed a `result`. Claude Code does
   * not hold a mid-turn message for a separate next turn: it folds it into the turn already
   * running, as a `queued_command` attachment on that turn, and emits ONE `result` for the
   * whole thing. A counter that reserved a completion per accepted message therefore drifted
   * up by one every time a message arrived mid-turn and never came back down - which wedged
   * `sendIfIdle` closed for the life of the session, so Mission Control's outbox released
   * every human message with "The agent became busy before delivery" against a session that
   * had been idle for hours.
   *
   * With one bit there is nothing to drift. Both edges are OBSERVATIONS of the vendor stream
   * rather than predictions about it: a `result` frame means the CLI stopped, and an
   * `assistant` frame means it is going again. That second edge is what makes the value
   * self-correcting - a turn we failed to notice starting re-arms this on its first frame,
   * where the old counter had no path back to zero at all.
   */
  private turnActive = false;
  /**
   * The capacity failure the running turn's own API-error message reported, held until the
   * `result` that closes the turn. Claude Code reports the error on an assistant frame and
   * closes the turn on the next `result`, so the two have to be joined here.
   */
  private turnFailure: SdkTurnFailure | null = null;
  /** Serialize the experimental control so a slow older reading cannot land after a newer one. */
  private rateLimitRefresh: Promise<void> = Promise.resolve();
  private stopped = false;
  /**
   * This CLI process's background sub-agents, and the coalescing door their summary leaves
   * through. Per process: the CLI's live task set starts empty whenever it (re)starts.
   */
  private subagents: ClaudeSubagentState = emptyClaudeSubagents();
  private readonly subagentEvents = new SubagentEmitter((subagents) =>
    this.out.emit({ kind: "subagents", subagents }),
  );

  /**
   * Closes the turn an `authentication_failed` frame opened when no `result` follows it.
   * Armed by that frame; disarmed by the turn's `result`, a later healthy frame, or the end.
   */
  private authenticationStall: ReturnType<typeof setTimeout> | null = null;
  /**
   * The query whose auth-failed turn the driver closed itself. Its late `result`, if one
   * ever comes, describes a turn already reported done and must not be reported again.
   */
  private authenticationClosedTurn: ClaudeSdkQuery | null = null;

  constructor(
    private readonly cwd: string,
    private readonly resumedConversation: string | null,
    private readonly authTiming: ClaudeAuthTiming = DEFAULT_AUTH_TIMING,
  ) {}

  get recoveryProcessId(): number | null {
    return this.authenticationRecovery ? null : this.query?.recoveryProcessId ?? null;
  }

  get events(): AsyncIterable<SdkEvent> {
    return this.out;
  }

  /**
   * Hand a turn to the CLI, and say what it did with it.
   *
   * `steered` rather than `queued` when a turn is already running, because that is what
   * Claude Code actually does with the message - the same thing Codex reports for
   * `turn/steer`. The distinction is not cosmetic: the supervisor releases its pessimistic
   * one-completion reservation on `steered` and holds it on `queued`, so calling a steer a
   * queue leaves the supervisor waiting for a second `result` the CLI will never send.
   */
  async send(turn: SdkTurn): Promise<SdkSendDisposition> {
    if (this.stopped) throw new Error("this session's driver has stopped");
    await this.recoverIfAuthenticationFailed();
    const steering = this.turnActive;
    this.acceptTurn(turn);
    return steering ? "steered" : "started";
  }

  private readonly compaction = new CompactionCompletion();
  compact = async (focus: string) => {
    if (this.turnActive) throw new Error("Cannot compact a busy session.");
    const completed = this.compaction.begin(() => this.interrupt());
    // Not awaited, for the same reason as Codex: acceptance that never settles must not keep
    // the stall bound's rejection from the caller.
    void this.sendIfIdle({ text: `/compact ${focus}`.trim() }).then(
      (accepted) => { if (!accepted) this.compaction.fail("The driver refused compaction while busy."); },
      (error: unknown) => this.compaction.fail(String(error)),
    );
    return completed;
  };

  async sendIfIdle(turn: SdkTurn): Promise<"started" | null> {
    if (this.stopped) throw new Error("this session's driver has stopped");
    await this.recoverIfAuthenticationFailed();
    if (this.turnActive) return null;
    this.acceptTurn(turn);
    return "started";
  }

  /** Join or begin the sole process replacement caused by the current auth failure. */
  private async recoverIfAuthenticationFailed(): Promise<void> {
    let recovery = this.authenticationRecovery;
    if (!recovery) {
      if (!this.authenticationFailed) return;
      recovery = this.recoverAuthentication();
      this.authenticationRecovery = recovery;
    }
    try {
      await recovery;
    } finally {
      if (this.authenticationRecovery === recovery) this.authenticationRecovery = null;
    }
  }

  /**
   * Replace only the Claude subprocess after an authentication failure.
   *
   * Claude loads its account credentials when the process starts. A `/login` completed in
   * another terminal updates those credentials on disk, but the streaming SDK query keeps
   * the old process alive and therefore keeps the stale account state. Close that process's
   * input, wait until it has released the conversation file, then resume the SAME native
   * conversation. One failed process causes one shared relaunch, and callers that overlap
   * join that boundary before normal started/steered/idle dispatch resumes. If the operator
   * has not logged in yet, the replacement reports authentication failure again and the
   * following turn may retry without an automatic loop.
   */
  private async recoverAuthentication(): Promise<void> {
    const stale = this.requireQuery();
    const draining = this.queryPump;
    if (!this.agentSessionId) {
      const reason = "Claude authentication failed before this conversation could be resumed";
      this.finish(reason);
      throw new Error(reason);
    }

    this.recoveringQuery = stale;
    this.disarmAuthenticationStall();
    this.turns.close();
    // Closing the input is the polite ending, and the one that lets a CLI still finishing up
    // release the conversation file itself. A process that has stopped making progress - the
    // reason this recovery exists - may never act on it, so the wait is bounded and the SDK
    // is then asked to stop the subprocess outright.
    if (!(await settlesWithin(draining, this.authTiming.drainMs))) {
      console.warn(
        `[claude-sdk] stale process for ${this.agentSessionId} did not exit after its input closed; stopping it`,
      );
      // Deferred so a transport that throws synchronously (already torn down) counts as
      // settled instead of escaping and aborting the relaunch this recovery exists for.
      await settlesWithin(Promise.resolve().then(() => stale.return(undefined)), this.authTiming.drainMs);
      if (!(await settlesWithin(draining, this.authTiming.drainMs))) {
        console.warn(`[claude-sdk] stale process for ${this.agentSessionId} has not drained; resuming anyway`);
      }
    }
    if (this.stopped) throw new Error("this session's driver has stopped");

    this.turns = new TurnStream();
    this.authenticationFailed = false;
    this.turnActive = false;
    // Resuming the same conversation retains its cumulative counters and baseline.
    try {
      const fresh = await this.relaunch(this.turns, this.agentSessionId, this.modelOverride);
      if (this.stopped) {
        await fresh.return(undefined);
        throw new Error("this session's driver has stopped");
      }
      // The replacement process starts with no live tasks; the stale one's agents died with it.
      // Reset only now, in the same synchronous step as `attach`: until then the stale process
      // is still the attached query and its pump keeps feeding task frames, which would refill
      // a summary cleared any earlier.
      this.setSubagents(emptyClaudeSubagents());
      this.attach(fresh);
    } catch (error) {
      this.finish(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private acceptTurn(turn: SdkTurn): void {
    this.turns.push({
      type: "user",
      message: { role: "user", content: turnContent(turn) },
      parent_tool_use_id: null,
      ...(this.agentSessionId ? { session_id: this.agentSessionId } : {}),
    });
    this.turnActive = true;
    // Accepting a turn IS the transition to working, and saying so here rather than waiting
    // for the first assistant frame is what keeps the card honest during the seconds a
    // model spends thinking before it emits anything. `turn_done` is the other end.
    this.out.emit({ kind: "state", state: "working", activity: null });
    // The operator's turn, specifically: a finished agent's own notification can start a
    // parent turn by itself, and folding there would hide a result nobody has seen yet.
    this.setSubagents(foldClaudeSubagents(this.subagents));
  }

  private setSubagents(next: ClaudeSubagentState): void {
    if (next === this.subagents) return;
    this.subagents = next;
    this.subagentEvents.update(claudeSubagentSummary(next));
  }

  async interrupt(): Promise<void> {
    const receipt = await this.query?.interrupt();
    // Reported, never acted on - see `ClaudeSdkInterruptReceipt`. Nothing in this daemon
    // puts work into the CLI's own queue, so a survivor here means something did, and the
    // operator who pressed stop is about to watch it start anyway.
    const stillQueued = receipt?.still_queued ?? [];
    if (stillQueued.length > 0) {
      console.warn(
        `[claude-sdk] interrupt left ${stillQueued.length} queued command(s) on ${this.agentSessionId ?? "an unbound session"}: ${stillQueued.join(", ")}`,
      );
    }
  }

  /**
   * Resolve the callback a pending request is holding.
   *
   * Refuses an unknown id rather than resolving something else, and refuses a LABEL that
   * does not match the row it names - the same `optionRowMiss` rule the pane walk applies
   * before its Enter, and for the same reason: a number is a position on a list the caller
   * may have re-read since, and answering the wrong row of a permission prompt is how an
   * agent gets told to do something nobody approved.
   */
  async answer(requestId: string, answer: SessionRequestAnswer): Promise<void> {
    const held = this.pending.get(requestId);
    if (!held) throw new Error(`no pending request ${requestId} on this session`);
    const result = this.resultFor(held, answer);
    this.pending.delete(requestId);
    held.resolve(result);
    this.out.emit({ kind: "request_resolved", requestId });
  }

  private resultFor(held: Pending, answer: SessionRequestAnswer): ClaudeSdkPermissionResult {
    if (answer.kind === "text") {
      // Prose on a permission ask is a deny WITH a message, which the pane path cannot
      // express at all: a menu has no free-text row, so a human with a reason had to pick
      // "No" and then type into the composer afterwards.
      return { behavior: "deny", message: answer.text };
    }
    if (answer.kind === "form") {
      const questions = held.request.questions ?? [];
      if (questions.length === 0) throw new Error("this request is not a form");
      const answers: Record<string, string> = {};
      for (const one of answer.answers) {
        const question = questions.find((q) => q.question === one.question);
        if (!question) throw new Error(`this form has no question "${one.question}"`);
        for (const label of one.labels) {
          if (!question.options.some((o) => o.label === label)) {
            throw new Error(`"${label}" is not an option for "${one.question}"`);
          }
        }
        if (!one.text && one.labels.length === 0) {
          throw new Error(`"${one.question}" was not answered`);
        }
        if (!question.multiSelect && one.labels.length > 1) {
          throw new Error(`"${one.question}" takes one answer, not ${one.labels.length}`);
        }
        // The tool's own encoding: one string per question, several labels comma-joined.
        // Free text stands in FOR a label when the human typed instead of picking, which
        // is a shape the pane form has to refuse.
        //
        // Both at once is refused rather than reconciled, and this is the last line of
        // defence for it (the route checks the same thing against the card the operator
        // was shown). One string per question means one of them would have to be dropped,
        // and a dropped selection is the agent being told something other than what was
        // clicked - the exact failure the structured ask replaced.
        const typed = one.text?.trim() ?? "";
        if (typed && one.labels.length > 0) {
          throw new Error(
            `"${one.question}" has both a chosen option and custom text - send one or the other`,
          );
        }
        // One entry per question, checked HERE too because this map is where a duplicate
        // would do its damage: the second write silently replaces the first, so an answer
        // the caller sent would never reach Claude. The route refuses this against the card
        // the operator saw; this refuses it against the request being answered.
        if (one.question in answers) {
          throw new Error(`"${one.question}" was answered twice - send one entry per question`);
        }
        answers[one.question] = typed || one.labels.join(", ");
      }
      for (const question of questions) {
        if (!(question.question in answers)) {
          throw new Error(`"${question.question}" was not answered`);
        }
      }
      return {
        behavior: "allow",
        updatedInput: { ...held.input, answers },
      };
    }

    const row = held.request.options.find((o) => o.number === answer.number);
    if (!row) throw new Error(`this request has no option ${answer.number}`);
    if (row.label !== answer.label) {
      throw new Error(
        `option ${answer.number} on this request is "${row.label}", not "${answer.label}"`,
      );
    }
    if (held.request.kind === "question") {
      // A single-question ask still answers through the tool's `answers` map - the option
      // rows ARE that question's options, so the row's label is the answer verbatim.
      const question = held.request.questions?.[0];
      if (!question) throw new Error("this request is not a question");
      return {
        behavior: "allow",
        updatedInput: { ...held.input, answers: { [question.question]: row.label } },
      };
    }
    if (row.label === DENY_LABEL || row.label === PLAN_KEEP_LABEL) {
      return { behavior: "deny", message: `The operator answered "${row.label}".` };
    }
    if (row.label === ALLOW_ALWAYS_LABEL) {
      // The suggestions ARE what "don't ask again" means - the CLI's own rule set for this
      // exact tool call. Returning them is how the answer persists past this one prompt.
      return { behavior: "allow", updatedPermissions: [...held.suggestions] };
    }
    return { behavior: "allow" };
  }

  setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    const value = sdkPermissionMode(mode);
    if (!value) throw new Error(`Claude has no permission mode called "${mode}"`);
    await this.requireQuery().setPermissionMode(value);
  };

  setEffort = async (effort: ThinkingLevel): Promise<void> => {
    await this.requireQuery().applyFlagSettings({ effortLevel: effort });
  };

  setModel = async (model: string): Promise<void> => {
    await this.requireQuery().setModel(model);
    this.modelOverride = model;
    this.modelId = model;
  };

  /**
   * Clear the conversation, and expect a new identity for it.
   *
   * `/clear` is a user message here rather than a keystroke, but the consequence is the
   * one the pane path already has: Claude mints a NEW session id on the same card. The
   * `bound` event that re-fires when the next message carries it is what moves the note,
   * queue, goal and work episode onto the new key - the same rebind a hook drives today.
   *
   * The latch is what makes that `bound` say WHICH KIND of rotation it is. Nothing
   * downstream can tell a cleared identity from an ordinary one by looking at it, and the
   * difference decides whether a reset's pre-armed work episode transfers or times out -
   * so the only party that knows (this one, which just issued the command) has to say. It
   * is armed here and spent by the FIRST rotation after it, because that is the one the
   * command caused; a later rotation is some other event and must not inherit the claim.
   */
  clearContext = async (): Promise<void> => {
    this.clearing = true;
    try {
      await this.send({ text: "/clear" });
    } catch (err) {
      // The command never went, so no rotation is coming and the latch would sit armed
      // waiting to mislabel whatever arrives next.
      this.clearing = false;
      throw err;
    }
  };

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (!this.query || this.queryEnded) {
      this.finish("Mission Control stopped this session.");
      return;
    }
    this.stopped = true;
    // Deny what is still parked BEFORE closing the input, or the CLI shuts down with a
    // control request it will never get an answer to and the subprocess hangs on exit.
    for (const [id, held] of this.pending) {
      held.resolve({ behavior: "deny", message: "Mission Control stopped this session." });
      this.out.emit({ kind: "request_resolved", requestId: id });
    }
    this.pending.clear();
    try {
      await this.query?.interrupt();
    } catch {
      // An interrupt on a session that is not mid-turn is a no-op that some CLI versions
      // report as an error. Closing the input below is what actually ends it.
    }
    this.turns.close();
  }

  private requireQuery(): ClaudeSdkQuery {
    if (!this.query || this.stopped) throw new Error("this session's driver has stopped");
    return this.query;
  }

  /**
   * Reacquire the account's live plan windows from the pane-less SDK session.
   *
   * Refresh on init and after each result so a saved Registry reading is replaced when
   * live usage is available. This control is experimental upstream; failure keeps the
   * saved reading and must never end or degrade the conversation it observes.
   */
  private refreshRateLimits(): void {
    const query = this.query;
    if (!query) return;
    this.rateLimitRefresh = this.rateLimitRefresh
      .then(async () => {
        if (this.stopped || this.query !== query) return;
        const usage =
          await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
        const rateLimits = claudeSdkRateLimits(usage);
        if (rateLimits && !this.stopped && this.query === query) {
          this.out.emit({ kind: "rate_limits", rateLimits });
        }
      })
      .catch(() => {
        // Live enrichment only. An older CLI or a transient usage-endpoint failure leaves
        // the last Registry reading in place and must not interfere with the agent's turn.
      });
  }

  // ---- wiring, called only by `launch` ----------------------------------------------

  /** The first turn, queued before the query starts consuming - it is turn one by construction. */
  seed(prompt: string): void {
    this.turns.push({
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
    });
    this.turnActive = true;
    this.out.emit({ kind: "state", state: "working", activity: null });
  }

  input(): AsyncIterable<ClaudeSdkUserMessage> {
    return this.turns;
  }

  configureRelaunch(
    relaunch: (
      prompt: AsyncIterable<ClaudeSdkUserMessage>,
      resume: string,
      modelOverride: string | null,
    ) => Promise<ClaudeSdkQuery>,
  ): void {
    this.relaunch = relaunch;
  }

  attach(query: ClaudeSdkQuery): void {
    this.query = query;
    this.queryEnded = false;
    this.authenticationClosedTurn = null;
    const pump = this.pump(query);
    this.queryPump = pump;
    void pump.catch((error) => {
      console.error("[claude-sdk] detached query pump failed:", error);
    });
  }

  /**
   * The permission callback: everything the CLI cannot settle on its own arrives here.
   *
   * Three shapes out of one channel, because the SDK has one channel: an ordinary tool is
   * a permission ask, `AskUserQuestion` is a form, `ExitPlanMode` is a plan approval. The
   * returned promise is the agent's turn, held open until `answer` resolves it.
   */
  canUseTool = (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      suggestions?: ClaudeSdkPermissionUpdate[];
      title?: string;
      description?: string;
      requestId: string;
      signal: AbortSignal;
    },
  ): Promise<ClaudeSdkPermissionResult> => {
    const id = options.requestId || randomUUID();
    const request = this.projectRequest(id, toolName, input, options);
    return new Promise<ClaudeSdkPermissionResult>((resolve) => {
      /**
       * Give up on this ask - and RESOLVE it, which is the part that is not optional.
       *
       * The SDK documents the consequence of not doing so: a `canUseTool` that never
       * settles sends no control response, and a permission prompt has no park deadline,
       * so the tool stays blocked for ever. Clearing the card without resolving would be
       * the worst version of that - a turn hung on a question nobody can even see any
       * more. A denial is the only safe way to abandon one: it fails CLOSED, so an ask
       * nobody answered never reads as approval.
       */
      const abandon = (why: string): void => {
        // Guarded by the delete, so this cannot double-resolve a request `stop()` or
        // `answer()` already settled - both remove their entry first.
        if (!this.pending.delete(id)) return;
        this.out.emit({ kind: "request_resolved", requestId: id });
        resolve({ behavior: "deny", message: why });
      };
      // Checked BEFORE anything is registered or announced: an already-aborted signal
      // never fires its event, so a listener alone would leave this promise pending for
      // ever and put a card up for an ask that was over before it arrived.
      if (options.signal.aborted) {
        resolve({ behavior: "deny", message: "this request was cancelled before it arrived" });
        return;
      }
      this.pending.set(id, {
        request,
        input,
        suggestions: options.suggestions ?? [],
        resolve,
      });
      // A session interrupted or torn down while the CLI was mid-request: the abort is the
      // only notice there is, and a pending row left behind would be a card showing buttons
      // that resolve nothing.
      options.signal.addEventListener(
        "abort",
        () => abandon("this request was cancelled before it was answered"),
        { once: true },
      );
      this.out.emit({ kind: "request", request });
    });
  };

  private projectRequest(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
    meta: { suggestions?: ClaudeSdkPermissionUpdate[]; title?: string; description?: string },
  ): SessionRequest {
    if (toolName === ASK_USER_QUESTION) {
      const questions = askUserQuestions(input);
      if (questions.length > 0) {
        return {
          id,
          kind: "question",
          // The card draws the questions; the prompt is the heading above them, and for a
          // single ask it IS the question, so nothing is said twice.
          prompt: questions.length === 1 ? questions[0]!.question : "Claude has some questions.",
          options: questions.length === 1 ? questions[0]!.options : [],
          questions,
        };
      }
      // A malformed tool input. Falling through to the permission shape is the honest
      // degradation: the human is asked whether to allow a tool call we could not read,
      // rather than being shown an empty form that can never be submitted.
    }
    if (toolName === EXIT_PLAN_MODE) {
      const plan = typeof input.plan === "string" ? input.plan : "";
      return {
        id,
        kind: "plan",
        prompt: plan ? `Claude finished planning.\n\n${plan}` : "Claude finished planning.",
        options: [
          { number: 1, label: PLAN_APPROVE_LABEL, detail: "Approve the plan and start work" },
          { number: 2, label: PLAN_KEEP_LABEL, detail: "Send it back for more planning" },
        ],
      };
    }
    const options: PaneOption[] = [{ number: 1, label: ALLOW_LABEL }];
    if ((meta.suggestions?.length ?? 0) > 0) {
      options.push({
        number: 2,
        label: ALLOW_ALWAYS_LABEL,
        detail: "Allow this, and stop asking for the rest of this session",
      });
    }
    options.push({ number: options.length + 1, label: DENY_LABEL });
    return {
      id,
      kind: "permission",
      prompt: permissionPrompt(toolName, input, meta),
      options,
    };
  }

  /**
   * The PR-authorship hooks, in-process.
   *
   * Two events for one fact, exactly as the shell bridge does it: `PreToolUse` sees the
   * COMMAND (the strict half of the two-signal provenance rule) and `PostToolUse` sees the
   * URL the command printed. Neither alone reaches `adoptPr`; the phase file names only the
   * first, but `applyDriverEvent` ignores a `pr_created` with no url, so the pre-hook on its
   * own would be a signal nothing consumes.
   *
   * EVERY url the response carried, because one command routinely opens one pull request per
   * repository on a multi-repo task and the first-match reader left the rest unannounced.
   */
  hooks(): Record<string, unknown> {
    const pre = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      const toolUseId = typeof input.tool_use_id === "string" ? input.tool_use_id : null;
      if (input.tool_name === "Bash" && toolUseId && opensPullRequest(toolInput.command)) {
        this.prPending.add(toolUseId);
      }
      return {};
    };
    const post = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const toolUseId = typeof input.tool_use_id === "string" ? input.tool_use_id : null;
      if (!toolUseId || !this.prPending.delete(toolUseId)) return {};
      const response = input.tool_response;
      const text = typeof response === "string" ? response : JSON.stringify(response ?? "");
      const urls = pullRequestUrlsIn(text);
      if (urls.length > 0) this.out.emit({ kind: "pr_created", urls });
      return {};
    };
    return {
      PreToolUse: [{ hooks: [pre] }],
      PostToolUse: [{ hooks: [post] }],
    };
  }

  /**
   * Drive the message stream until it ends, then say why.
   *
   * Every exit converges here - a clean `result`, a thrown stream, a subprocess that died -
   * because the supervisor's eviction hangs off `exited` and a stream that simply stopped
   * would leave a card whose Send button lies. `resumable` is the useful part: a session
   * whose identity we learned can be picked up again after a restart; one that never bound
   * has nothing to resume from.
   */
  async pump(query: ClaudeSdkQuery): Promise<void> {
    this.query = query;
    let reason = "the session ended";
    try {
      for await (const message of query) {
        // Authentication recovery can resume past a stale process that never drained, so
        // this pump may outlive its query's place in the session. Once a replacement is
        // attached, nothing the stale process says describes the live conversation.
        if (this.query !== null && this.query !== query) continue;
        this.consume(message);
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    } finally {
      if (this.recoveringQuery === query && !this.stopped) {
        this.recoveringQuery = null;
        if (this.query === query) this.query = null;
      } else if (this.query !== null && this.query !== query && !this.stopped) {
        // A superseded stale process ending, possibly after a later recovery replaced
        // `recoveringQuery`. Its end is not this session's end.
      } else if (
        this.authenticationFailed &&
        this.agentSessionId !== null &&
        this.query === query &&
        !this.stopped
      ) {
        // Authentication can terminate the SDK stream before the operator finishes login.
        // Keep the ended query as the stale recovery source so the next turn can replace it;
        // stop() recognizes queryEnded and still emits the terminal session event directly.
        this.queryEnded = true;
      } else {
        this.finish(reason);
      }
    }
  }

  private finish(reason: string): void {
    this.disarmAuthenticationStall();
    this.subagentEvents.dispose();
    this.compaction.fail(reason);
    if (this.stopped && this.query === null) return;
    this.stopped = true;
    this.query = null;
    this.queryEnded = false;
    this.turns.close();
    for (const [id, held] of this.pending) {
      held.resolve({ behavior: "deny", message: "this session ended" });
      this.out.emit({ kind: "request_resolved", requestId: id });
    }
    this.pending.clear();
    this.out.emit({
      kind: "exited",
      reason,
      resumable: this.agentSessionId !== null,
    });
    this.out.end();
  }

  private consume(message: ClaudeSdkMessage): void {
    if (isClaudeSubagentFrame(message)) {
      this.setSubagents(observeClaudeSubagentFrame(this.subagents, message, Date.now()));
    }
    if (message.type === "system" && message.subtype === "compact_boundary") {
      const metadata = message.compact_metadata as { post_tokens?: number } | undefined;
      this.compaction.observe(metadata?.post_tokens ?? null, defaultWindowForModel(this.modelId));
    }
    if (message.type === "assistant" && message.error === "authentication_failed") {
      this.authenticationFailed = true;
      this.armAuthenticationStall();
    } else if (
      message.type === "assistant" &&
      !message.parent_tool_use_id &&
      (this.authenticationStall || this.authenticationClosedTurn)
    ) {
      // The CLI answered again after reporting the failure, so its credentials work after
      // all: a relaunch on the next send would only interrupt a turn that is progressing.
      // Even when the stall already reported the turn done, this frame reopens it, and the
      // `result` that follows is that turn's real completion rather than a late duplicate.
      this.disarmAuthenticationStall();
      this.authenticationFailed = false;
      this.authenticationClosedTurn = null;
    }
    // The init frame is the one authoritative answer to "which model did this launch
    // actually bind?" It is especially important on resume: the durable launch request may
    // be null ("use Claude's default"), and an idle resumed transcript may contain no fresh
    // usage record for the passive poller to learn from.
    if (
      message.type === "system" &&
      message.subtype === "init" &&
      typeof message.model === "string"
    ) {
      this.modelId = message.model || null;
    }
    const initialized = message.type === "system" && message.subtype === "init";
    // Every message carries the session id, `init` first and then every frame after it -
    // and `/clear` is the case that makes the second half matter: the CLI mints a NEW id
    // and reports it on an ordinary message rather than on a second `init`. Re-binding
    // whenever it changes is what keeps the note, queue, goal and work episode following
    // the conversation instead of stranding them on a dead key.
    if (typeof message.session_id === "string") this.bind(message.session_id);
    if (initialized) this.refreshRateLimits();
    if (message.type === "assistant") {
      // A sub-agent's own frame. A background agent keeps talking after the parent's turn
      // has ended, and reading its frames as the parent's would flip an idle card back to
      // working with no turn to close it. While the parent's turn runs they still describe
      // what the session is doing, so they update the line without arming anything.
      if (message.parent_tool_use_id) {
        if (!this.turnActive) return;
        this.out.emit({ kind: "state", state: "working", activity: assistantActivity(message) });
        return;
      }
      // Proof a turn is running, and the reason `turnActive` cannot get stuck on the wrong
      // value: a turn the CLI started for itself - a resumed stream, or a follow-up it chose
      // to dequeue after a `result` we had already read as the end of the work - re-arms the
      // flag here, on its own first frame, without the driver having to predict it.
      this.turnActive = true;
      const failure = claudeCapacityFailure(message);
      if (failure) this.turnFailure = failure;
      this.out.emit({ kind: "state", state: "working", activity: assistantActivity(message) });
      return;
    }
    if (message.type === "result") {
      this.disarmAuthenticationStall();
      if (this.authenticationClosedTurn !== null && this.authenticationClosedTurn === this.query) {
        // The late close of a turn the stall already reported done. Its usage snapshot is
        // left for the next result, which repeats the conversation totals, to account.
        this.authenticationClosedTurn = null;
        this.turnActive = false;
        this.turnFailure = null;
        return;
      }
      this.turnActive = false;
      const failure = this.turnFailure ?? claudeResultCapacityFailure(message);
      this.turnFailure = null;
      const cumulative = claudeTurnUsage(message, this.modelId);
      const usage = cumulative ? claudeUsageDelta(cumulative, this.cumulativeUsage) : null;
      // Advance only from a snapshot the ledger can actually accept. Otherwise a result
      // missing its UUID would be subtracted from the next identifiable one and disappear
      // from durable spend entirely. Keep last-known costs when this accepted snapshot has
      // only token counters: the next priced cumulative result must still subtract the last
      // priced total instead of treating the temporary unknown as zero.
      if (cumulative?.turnId && cumulative.models?.length) {
        this.cumulativeUsage = cumulativeUsageBaseline(cumulative, this.cumulativeUsage);
      }
      this.out.emit({
        kind: "turn_done", usage,
        ...(cumulative?.turnId && cumulative.models?.length
          ? { usageSnapshot: { usage: cumulative, resumed: this.agentSessionId === this.resumedConversation } } : {}),
        ...(failure ? { failure } : {}),
      });
      this.compaction.finish();
      this.refreshRateLimits();
      return;
    }
  }

  private armAuthenticationStall(): void {
    this.disarmAuthenticationStall();
    const query = this.query;
    const timer = setTimeout(() => {
      if (this.authenticationStall !== timer) return;
      this.authenticationStall = null;
      if (this.stopped || this.query !== query || !this.turnActive || !this.authenticationFailed) return;
      console.warn(
        `[claude-sdk] ${this.agentSessionId ?? "an unbound session"} reported an authentication failure without closing its turn; closing it so the next turn can reload credentials`,
      );
      // The bookkeeping a `result` would have done, minus usage: the CLI reported none, and
      // the next result's cumulative totals still carry anything this turn spent.
      this.turnActive = false;
      this.turnFailure = null;
      this.authenticationClosedTurn = query;
      this.out.emit({ kind: "turn_done", usage: null });
      this.compaction.finish();
    }, this.authTiming.turnGraceMs);
    timer.unref?.();
    this.authenticationStall = timer;
  }

  private disarmAuthenticationStall(): void {
    if (this.authenticationStall) clearTimeout(this.authenticationStall);
    this.authenticationStall = null;
  }

  private bind(agentSessionId: string): void {
    if (!agentSessionId || agentSessionId === this.agentSessionId) return;
    // A changed Claude identity is a new accounting window. `/clear` is the normal route,
    // and its next result starts its cumulative counters over. Forgetting the old baseline
    // is therefore as important as following the new transcript and note key below.
    if (this.agentSessionId !== null) this.cumulativeUsage = null;
    this.agentSessionId = agentSessionId;
    const cleared = this.clearing;
    this.clearing = false;
    this.out.emit({
      kind: "bound",
      agentSessionId,
      transcriptPath: claudeSdkTranscriptPath(this.cwd, agentSessionId),
      modelId: this.modelId,
      // The SDK owns its subprocess and reports no pid; the registry keeps 0, which is the
      // sentinel `signalProcess` already refuses.
      pid: null,
      ...(cleared ? { cleared: true as const } : {}),
    });
  }
}

/**
 * A `result` frame's query-to-date usage, in both display and ledger shapes.
 *
 * This function is why Claude session spend exists at all. The frame has always carried
 * `total_cost_usd`, `modelUsage` and a per-result `uuid`; the driver used to emit
 * `turn_done` with `usage: null` and drop all of it, on the premise that OpenTelemetry was
 * Claude's one ledger writer and would record the same turn independently. That premise is
 * what broke: a CLI whose metrics pipeline is inert - an export the daemon never receives,
 * for any reason, including reasons outside this repo - takes session spend to zero with no
 * error anywhere, because the only writer had silently stopped. Reading the figure off the
 * stream the driver already owns removes the dependency instead of monitoring it.
 *
 * `modelId` on the flat view is the BOUND model, not a model from the breakdown, and the two
 * genuinely differ: a turn that spent opus tokens and a haiku summarization is one card
 * showing one model, so the flat view names the conversation's model while `models` keeps
 * every id that actually served a request. The ledger reads `models`; the chip reads the rest.
 *
 * Returns null when the frame reports no usage. A frame without a UUID still returns the
 * display view, but omits the ledger view because its eventual delta cannot be deduplicated.
 */
export function claudeTurnUsage(
  message: ClaudeSdkMessage,
  boundModelId: string | null,
): SdkUsage | null {
  const envelope = message as unknown as Record<string, unknown>;
  const models = claudeEnvelopeModels(envelope, boundModelId ?? "");
  if (models.length === 0) return null;
  const turnId = claudeEnvelopeTurnId(envelope);
  const total = (key: keyof LlmSpendModelUsage): number =>
    models.reduce((sum, m) => sum + (typeof m[key] === "number" ? (m[key] as number) : 0), 0);
  // The query's cost is the envelope's own total when it reports one. Summing the per-model
  // figures is the fallback and not the default, because a model whose `costUSD` came back
  // null would silently make the sum read as a complete total that is short by one model.
  const reported = envelope.total_cost_usd;
  const costUsd =
    typeof reported === "number"
      ? reported
      : models.every((m) => m.reportedCostUsd !== null)
        ? models.reduce((sum, m) => sum + (m.reportedCostUsd ?? 0), 0)
        : null;
  return {
    input: total("input"),
    output: total("output"),
    cacheRead: total("cacheRead"),
    cacheWrite: total("cacheWrite"),
    modelId: boundModelId ?? models[0]?.modelId ?? null,
    costUsd,
    ...(turnId ? { turnId, models } : {}),
  };
}

/**
 * The ticker line for an assistant turn: what it is doing right now.
 *
 * A tool name when there is one (that is what the interactive spinner shows), else the
 * first line of prose. Never the whole message - this lands in `Session.activity`, which
 * every layout renders on one line.
 */
function assistantActivity(message: ClaudeSdkMessage): string | null {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === "tool_use" && typeof rec.name === "string") return rec.name;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") {
      const line = rec.text.split("\n").map((l) => l.trim()).find(Boolean);
      if (line) return line.slice(0, 120);
    }
  }
  return null;
}

/** The API-error categories Claude Code tags a capacity failure with. */
const CLAUDE_CAPACITY_ERRORS = new Set(["overloaded", "server_error", "rate_limit"]);

/**
 * The capacity failure a top-level assistant frame reports, or null.
 *
 * Claude Code retries a 529 on its own and, once those retries are spent, ends the turn with
 * a synthetic assistant message. Its `error` tag alone is not enough: "Repeated 529
 * Overloaded errors" is tagged `server_error` and the "Opus is experiencing high load"
 * off-switch is tagged `rate_limit`, tags that also cover failures waiting cannot fix. So
 * `overloaded` is trusted outright and the other two only when the text says capacity. A
 * subagent's error is ignored: it ends the subagent, not this turn.
 */
export function claudeCapacityFailure(message: ClaudeSdkMessage): SdkTurnFailure | null {
  if (message.type !== "assistant" || message.parent_tool_use_id) return null;
  const error = typeof message.error === "string" ? message.error : null;
  if (!error || !CLAUDE_CAPACITY_ERRORS.has(error)) return null;
  const text = assistantText(message);
  if (error === "overloaded" || isProviderCapacityMessage(text)) {
    return { kind: "capacity", message: text || "Claude's API is overloaded." };
  }
  return null;
}

/** The same verdict read off an error `result`, for a stream that carried no error frame. */
function claudeResultCapacityFailure(message: ClaudeSdkMessage): SdkTurnFailure | null {
  if (message.is_error !== true || typeof message.result !== "string") return null;
  const text = message.result.trim();
  return isProviderCapacityMessage(text) ? { kind: "capacity", message: text } : null;
}

function assistantText(message: ClaudeSdkMessage): string {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text"
      ? String((block as { text?: unknown }).text ?? "")
      : ""))
    .join("\n")
    .trim();
}

/**
 * Claude's `SdkSpec`: start (or resume) an embedded session.
 *
 * `deps` is the transport seam - a test hands in a scripted `query` and drives this exact
 * code with no `claude` on the machine. Production takes the default, which is the only
 * importer of the vendor package.
 */
/**
 * True: Claude's driver projects permission prompts, plan approvals and `AskUserQuestion`
 * into `SessionRequest`, and `answer()` resolves the callback the CLI is blocked on.
 */
const CLAUDE_ANSWERS_REQUESTS = true;

/**
 * Opt the embedded session in to Claude Code's `Artifact` tool, which the Files tab's
 * Publish control asks it to call.
 *
 * The CLI withholds that tool from every `sdk-ts` entrypoint unless `CLAUDE_CODE_ARTIFACT`
 * is truthy (its own withheld reason is `sdk_default_off`), while an interactive pane has
 * it on by default. Without this, Publish sends an embedded session a request it cannot
 * carry out. This removes only that SDK default: an operator's own `CLAUDE_CODE_ARTIFACT`
 * is left as they set it, and `enableArtifact: false`, plan and admin policy still decide.
 */
function withArtifactTool(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return env.CLAUDE_CODE_ARTIFACT === undefined ? { ...env, CLAUDE_CODE_ARTIFACT: "1" } : env;
}

/**
 * The task's advisor pin as session environment: `off` sets the one switch that also beats
 * an inherited user setting. Inherit (`null`) and a model pin leave the env as it was.
 */
function withAdvisorEnv(
  env: Record<string, string | undefined>,
  choice: SdkLaunchOptions["advisorModel"],
): Record<string, string | undefined> {
  const extra = choice ? capabilitiesFor("claude").advisor?.launchEnv(choice) ?? {} : {};
  return Object.keys(extra).length > 0 ? { ...env, ...extra } : env;
}

/** One resident entry as Claude Code's `mcpServers` value. */
function claudeResidentServer(entry: ResidentMcpEntry): Record<string, unknown> {
  const claude = entry.options.claude ?? {};
  const options = {
    ...(claude.timeoutMs !== undefined ? { timeout: claude.timeoutMs } : {}),
    ...(claude.alwaysLoad !== undefined ? { alwaysLoad: claude.alwaysLoad } : {}),
  };
  // Type, URL and headers exactly as configured, `{}` included: Claude Code keys a stored OAuth
  // login by the name and a hash of these three, so this is how a resident finds the operator's.
  if (entry.shape === "http") return { type: entry.transport, url: entry.url, headers: entry.headers, ...options };
  return { type: "stdio", command: entry.command, args: entry.args, env: entry.env, ...options };
}

/**
 * Mission's server, and for a resident run its snapshot under `strictMcpConfig`, so the CLI
 * reads no user, local, project or plugin MCP configuration. Called once per process start,
 * because a resident's launcher entries carry that start's single-use credentials.
 *
 * A resident whose profile imports all native sources gives the pin up on purpose
 * (`allNativeSources: "lift-strict-mcp-config"`): its snapshot is rendered the same way, but
 * without either switch, so Claude Code also loads its own configuration and connectors.
 */
function claudeMcpOptions(opts: SdkLaunchOptions): Pick<ClaudeSdkQueryOptions, "mcpServers" | "strictMcpConfig" | "settings"> {
  // No prototype, so every server name - whatever a configuration used - is an own entry.
  const servers: Record<string, unknown> = Object.create(null);
  if (opts.mcp) {
    servers[opts.mcp.serverName] = { type: "stdio", command: opts.mcp.command, args: opts.mcp.args, env: opts.mcp.env };
  }
  if (opts.residentMcp) for (const entry of opts.residentMcp.forStart()) servers[entry.name] = claudeResidentServer(entry);
  const listed = Object.keys(servers).length > 0 ? { mcpServers: servers } : {};
  if (!opts.residentMcp || opts.residentMcp.nativeSources === "all") return listed;
  return {
    ...listed,
    strictMcpConfig: true,
    // `strictMcpConfig` names configuration files; claude.ai's cloud connectors are fetched
    // for an account instead, and this is the setting that keeps them out.
    settings: { disableClaudeAiConnectors: true },
  };
}

/**
 * `claudeMcpOptions` plus the task's advisor pin, as ONE flag-layer `settings` object.
 *
 * Both write the same option, and the SDK takes a single value for it, so a resident run
 * pinned to an advisor has to carry `disableClaudeAiConnectors` and `advisorModel` together;
 * spreading the two separately would let whichever came second erase the other. Inherit adds
 * nothing, so an unpinned launch's options are exactly what they were before the pin existed.
 */
function claudeFlagOptions(opts: SdkLaunchOptions): Pick<ClaudeSdkQueryOptions, "mcpServers" | "strictMcpConfig" | "settings"> {
  const mcp = claudeMcpOptions(opts);
  const advisor = opts.advisorModel ? capabilitiesFor("claude").advisor?.sdkSettings(opts.advisorModel) ?? {} : {};
  const memory = opts.residentStateDir ? { autoMemoryDirectory: opts.residentStateDir, autoMemoryEnabled: true } : {};
  if (Object.keys(advisor).length === 0 && !opts.residentStateDir) return mcp;
  return { ...mcp, settings: { ...mcp.settings, ...advisor, ...memory } };
}

/**
 * How long a resident's start waits for Claude to report its servers and for them to stop
 * pending. Long enough for a server fetched on first use, such as an `npx` package, to come up.
 */
const RESIDENT_MCP_SETTLE_MS = 60_000;

interface ClaudeAuthTiming {
  /** How long an `authentication_failed` frame waits for the `result` that closes its turn. */
  turnGraceMs: number;
  /** How long recovery waits on a stale subprocess, before and after asking it to stop. */
  drainMs: number;
}

/**
 * Claude Code normally closes an auth-failed turn with a `result` straight after the
 * synthetic "Not logged in" frame. A turn that failed while folding in a mid-turn
 * background-task notification has been seen to emit that frame and then nothing, leaving
 * the process alive and the turn open for hours - and recovery runs only on the NEXT send,
 * which an open turn holds back. The grace is far longer than the gap between the two frames
 * and far shorter than any resident pacing interval.
 */
const DEFAULT_AUTH_TIMING: ClaudeAuthTiming = { turnGraceMs: 30_000, drainMs: 10_000 };

/** Whether `promise` settled within `ms` (nothing to wait for counts). The timer never holds the daemon open. */
async function settlesWithin(promise: Promise<unknown> | null, ms: number): Promise<boolean> {
  if (!promise) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}
const RESIDENT_MCP_POLL_MS = 200;

/**
 * What is wrong with the servers Claude reports for a resident's start, or null. Every server in
 * the set must be configured and must not have failed, be switched off, or wait on a login: a
 * resident never runs silently without one of its servers. With `exact`, a server outside the set
 * is wrong too; a resident on all native sources has those by design, and they are not checked.
 *
 * A remote server Claude Code connects to itself presents the operator's stored OAuth login. With
 * no usable login - never signed in, or a token it could not refresh - Claude reports it
 * `needs-auth` (measured on Claude Code 2.1.317), and caches that verdict by server name alone, so
 * a later start may report it again without trying. A server behind a login that is reached through the
 * launcher's bridge instead is reported `failed`, because the bridge cannot present one.
 */
function residentMcpStatusProblem(
  statuses: ReadonlyArray<{ name: string; status: string }>,
  allowed: ReadonlySet<string>,
  exact: boolean,
): string | null {
  const extra = exact ? statuses.find((status) => !allowed.has(status.name) && status.status !== "disabled") : undefined;
  if (extra) return `configured the MCP server ${extra.name}, which is not in its snapshot`;
  const reported = new Map(statuses.map((status) => [status.name, status.status]));
  for (const name of allowed) {
    const state = reported.get(name);
    if (state === undefined) return `did not configure its MCP server ${name}`;
    if (state === "disabled") return `has its MCP server ${name} switched off`;
    if (state === "needs-auth") {
      return `cannot use its MCP server ${name}, which needs a login Claude Code does not have or could not refresh; sign in to ${name} with /mcp in Claude Code, then launch again`;
    }
    if (state === "failed") return `could not connect to its MCP server ${name}`;
  }
  return null;
}

type ResidentMcpStatuses = Array<{ name: string; status: string }>;

/** The query's server statuses, or why it gave none before the deadline. */
async function statusesBefore(query: ClaudeSdkQuery, deadline: number): Promise<ResidentMcpStatuses | "rejected" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const answer = await Promise.race([
    query.mcpServerStatus!().catch((): "rejected" => "rejected"),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return answer;
}

/**
 * Why Claude's report does not confirm a resident's set, or null when it does. A server still
 * pending is asked about again until the deadline. Anything that leaves the set unconfirmed - no
 * status call, a rejected or unanswered one, or a server still starting at the deadline - is a
 * refusal: a resident never starts without knowing it has the servers its profile selected.
 */
async function residentMcpUnconfirmed(
  query: ClaudeSdkQuery,
  allowed: ReadonlySet<string>,
  exact: boolean,
  settleMs: number,
): Promise<string | null> {
  if (!query.mcpServerStatus) return "cannot report its MCP servers, so their set cannot be confirmed";
  const whole = Math.max(1, Math.round(settleMs / 1000));
  const seconds = `${whole} second${whole === 1 ? "" : "s"}`;
  const deadline = Date.now() + settleMs;
  for (;;) {
    const answer = await statusesBefore(query, deadline);
    if (answer === "rejected") return "could not report its MCP servers, so their set cannot be confirmed";
    if (answer === "timeout") return `did not report its MCP servers within ${seconds}`;
    const problem = residentMcpStatusProblem(answer, allowed, exact);
    if (problem) return problem;
    const pending = answer.find((status) => allowed.has(status.name) && status.status === "pending");
    if (!pending) return null;
    if (Date.now() + RESIDENT_MCP_POLL_MS >= deadline) return `was still starting its MCP server ${pending.name} after ${seconds}`;
    await new Promise((resolve) => setTimeout(resolve, RESIDENT_MCP_POLL_MS));
  }
}

/**
 * Confirm the CLI configured exactly Mission's server and the run's snapshot, and that each one
 * connected - the direct check behind `strictMcpConfig`, which also covers sources no fixture can
 * reach, such as managed configuration. A start that cannot be confirmed is refused.
 *
 * A resident on all native sources is not pinned, so only what Mission Control put in its set -
 * its own server and the profile's custom servers - must connect. A native server or connector
 * that fails or waits on a login is left to Claude Code, as in a terminal session.
 */
async function verifyResidentMcp(query: ClaudeSdkQuery, opts: SdkLaunchOptions, settleMs: number): Promise<void> {
  const allowed = new Set([...(opts.residentMcp?.names ?? []), ...(opts.mcp ? [opts.mcp.serverName] : [])]);
  const exact = opts.residentMcp?.nativeSources !== "all";
  const problem = await residentMcpUnconfirmed(query, allowed, exact, settleMs);
  if (!problem) return;
  await query.return(undefined).catch(() => {});
  throw new Error(`this resident's Claude Code session ${problem}`);
}

export function claudeSdkSpec(deps: ClaudeSdkDeps = defaultClaudeSdkDeps): SdkSpec {
  const settleMs = deps.residentMcpSettleMs ?? RESIDENT_MCP_SETTLE_MS;
  const authTiming: ClaudeAuthTiming = {
    turnGraceMs: deps.authFailureTurnGraceMs ?? DEFAULT_AUTH_TIMING.turnGraceMs,
    drainMs: deps.authRecoveryDrainMs ?? DEFAULT_AUTH_TIMING.drainMs,
  };
  return {
    answersRequests: CLAUDE_ANSWERS_REQUESTS,
    async launch(opts: SdkLaunchOptions): Promise<SdkSessionHandle> {
      // Every decision a Claude SDK session asks goes through `request_input` - with its
      // context and per-option tradeoffs - never the built-in `AskUserQuestion`. That needs
      // the Mission Control MCP server on this very launch, so a launch without it is
      // REFUSED rather than started: keeping the built-in would let the session ask a
      // decision with no room for its context, and removing it with no replacement would
      // leave the agent no way to ask at all. Checked before anything is started.
      const askChannel = sdkAskChannel(opts.mcp?.serverName ?? null);
      if (!askChannel) {
        throw new Error(
          "Claude sessions on the Agent SDK runtime ask every decision through Mission Control's " +
            "request_input tool, but this launch was not given Mission Control's MCP server " +
            "(is the MCP bundle built? run: npm run build)",
        );
      }
      const session = new ClaudeSdkSession(opts.cwd, opts.resume, authTiming);
      // Turn one is queued before the query is constructed, so the first thing the CLI
      // reads is the intent - there is no separate "type the prompt" step to race.
      if (opts.prompt) session.seed(opts.prompt);
      const permissionMode = sdkPermissionMode(opts.permissionMode);
      // The ask redirect leads and the operator's standing instructions follow, the order the
      // terminal launch joins them in (`systemPromptAppendArgs`).
      const systemPromptAppend = [askChannel.redirect, opts.standingInstructions]
        .filter((part): part is string => !!part)
        .join("\n\n");
      const options: ClaudeSdkQueryOptions = {
        cwd: opts.cwd,
        pathToClaudeCodeExecutable: await deps.executable(),
        // This session's trace context, which also clears any `TRACEPARENT` the daemon
        // inherited. Claude Code reads it at each interaction span in an SDK session; it
        // needs no `CLAUDE_CODE_PROPAGATE_TRACEPARENT`, which governs OUTBOUND headers.
        env: withAgentTraceContext(
          withAdvisorEnv(withArtifactTool({ ...deps.env(opts.cwd, opts.stateHome), ...(opts.residentStateDir ? { RESIDENT_STATE_DIR: opts.residentStateDir } : {}) }), opts.advisorModel),
          opts.traceContext,
        ),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        // The ask-channel redirect and the operator's repository standing instructions, as
        // a NON-DESTRUCTIVE append.
        //
        // The preset object is the only form that can do this. A bare `string` here
        // REPLACES Claude Code's own system prompt, which would turn an embedded session
        // into a different agent from the dispatched pane running the same task. Omitted
        // entirely when there is nothing to send.
        ...(systemPromptAppend
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: systemPromptAppend,
              },
            }
          : {}),
        allowedTools: askChannel.allowedTools,
        disallowedTools: askChannel.disallowedTools,
        // The secondary worktrees of a multi-repo task. Spread conditionally so an
        // ordinary session's options object is exactly what it always was.
        //
        // Launch-time is the ONLY moment this can be said. The runtime `addDirectories`
        // control request requires its argument to be a strict subdirectory of cwd or of
        // a directory named here, so a sibling checkout is unreachable to a session that
        // did not start with it.
        ...((opts.extraDirs.length > 0 || opts.residentStateDir) ? { additionalDirectories: [...opts.extraDirs, ...(opts.residentStateDir ? [opts.residentStateDir] : [])] } : {}),
        // Makes `bypassPermissions` REACHABLE for this session. It does not enter it, and
        // reading it as "skip permissions" is the mistake to avoid: the CLI has two
        // separate flags, and this option compiles to the weaker one.
        //
        //   --allow-dangerously-skip-permissions  Enable bypassing all permission checks
        //                                         as an option, WITHOUT it being enabled
        //                                         by default.
        //   --dangerously-skip-permissions        Bypass all permission checks.
        //
        // The vendor bundle emits the first (`if(b)H.push("--allow-dangerously-skip-permissions")`)
        // and emits `--permission-mode` separately, so what the operator picked still decides
        // what happens. Unconditional here for the same reason it is safe: the mode is the
        // gate, this is only the permission to reach it.
        //
        // Unconditional is also the only thing that WORKS, which is the part worth keeping.
        // `bypassPermissions` is not just a launch choice - `harness-capabilities.ts` lists
        // it in `pickable` with `liveControl: { kind: "cycle" }`, so the chip can switch a
        // running session into it through `setPermissionMode`. The vendor's live setter takes
        // the mode ALONE (`sdk.d.ts:2300`), with nowhere to carry this flag, so launch is the
        // only moment it can ever be declared. Deriving it from the launch mode would leave
        // every session that started in any other mode unable to reach bypass at all.
        allowDangerouslySkipPermissions: true,
        ...(opts.resume ? { resume: opts.resume } : {}),
        ...claudeFlagOptions(opts),
        // The ask channel's allow, disallow and redirect are rendered above on every launch
        // (`sdkAskChannel`; a launch without the Mission server is refused at the top), so a
        // decision this session asks goes through `request_input` with its context and
        // tradeoffs, as on every other runtime.
        canUseTool: session.canUseTool,
        hooks: session.hooks(),
        // CLAUDE.md, skills and the operator's settings - the same sources an
        // interactive session loads. Without this the SDK starts with none of them,
        // which would make an embedded session a different agent from a dispatched pane.
        settingSources: ["user", "project", "local"],
        // Mission Control decides when a session is over (a task settles it, or a human
        // kills it). A turn ceiling here would end one mid-work with no way to say so.
        includePartialMessages: false,
      };
      session.configureRelaunch(async (prompt, resume, modelOverride) => {
        const { resume: _previousResume, ...base } = options;
        // A resident's launcher credentials are single-use and were spent by the process being
        // replaced, so the replacement mints its own.
        const fresh = await deps.query({ prompt, options: {
          ...base,
          ...claudeFlagOptions(opts),
          // The original options predate any accepted live model change.
          ...(modelOverride ? { model: modelOverride } : {}),
          resume,
        } });
        // The replacement starts its servers again, so it is held to the same check as the first
        // start; a refusal here ends the session with its reason.
        if (opts.residentMcp) await verifyResidentMcp(fresh, opts, settleMs);
        return fresh;
      });
      const query = await deps.query({ prompt: session.input(), options });
      session.attach(query);
      if (opts.residentMcp) await verifyResidentMcp(query, opts, settleMs);
      return session;
    },
  };
}

/** The shipped driver. See `HARNESSES.claude.sdk`. */
export const claudeSdk: SdkSpec = claudeSdkSpec();
