import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  PaneOption,
  PermissionMode,
  SessionRequestQuestion,
  ThinkingLevel,
} from "@shared/types.ts";
import { opensPullRequest, pullRequestUrlIn } from "@shared/pr-command.mjs";
import type {
  SdkEvent,
  SdkLaunchOptions,
  SdkSessionHandle,
  SdkSpec,
  SdkTurn,
  SessionRequest,
  SessionRequestAnswer,
} from "../types.ts";
import type {
  ClaudeSdkDeps,
  ClaudeSdkQuery,
  ClaudeSdkMessage,
  ClaudeSdkPermissionMode,
  ClaudeSdkPermissionResult,
  ClaudeSdkPermissionUpdate,
  ClaudeSdkUserMessage,
} from "./sdk-types.ts";
import { defaultClaudeSdkDeps } from "./sdk-deps.ts";
import { EventStream } from "../../sdk/event-stream.ts";

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
  const path = join(projectsDir, cwd.replace(/[/.]/g, "-"), `${agentSessionId}.jsonl`);
  return existsSync(path) ? path : null;
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
 * generator over a fixed list - and its `push` resolving is what makes `send()` an ACK
 * rather than a hope.
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
  private readonly turns = new TurnStream();
  private query: ClaudeSdkQuery | null = null;
  private agentSessionId: string | null = null;
  /** The actual model reported by Claude's init frame, retained across a /clear rebind. */
  private modelId: string | null = null;
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
  private stopped = false;

  constructor(private readonly cwd: string) {}

  get events(): AsyncIterable<SdkEvent> {
    return this.out;
  }

  async send(turn: SdkTurn): Promise<void> {
    if (this.stopped) throw new Error("this session's driver has stopped");
    this.turns.push({
      type: "user",
      message: { role: "user", content: turnContent(turn) },
      parent_tool_use_id: null,
      ...(this.agentSessionId ? { session_id: this.agentSessionId } : {}),
    });
    // Accepting a turn IS the transition to working, and saying so here rather than waiting
    // for the first assistant frame is what keeps the card honest during the seconds a
    // model spends thinking before it emits anything. `turn_done` is the other end.
    this.out.emit({ kind: "state", state: "working", activity: null });
  }

  async interrupt(): Promise<void> {
    await this.query?.interrupt();
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

  // ---- wiring, called only by `launch` ----------------------------------------------

  /** The first turn, queued before the query starts consuming - it is turn one by construction. */
  seed(prompt: string): void {
    this.turns.push({
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
    });
    this.out.emit({ kind: "state", state: "working", activity: null });
  }

  input(): AsyncIterable<ClaudeSdkUserMessage> {
    return this.turns;
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
      const url = pullRequestUrlIn(text);
      if (url) this.out.emit({ kind: "pr_created", url });
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
        this.consume(message);
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    } finally {
      this.stopped = true;
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
  }

  private consume(message: ClaudeSdkMessage): void {
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
    // Every message carries the session id, `init` first and then every frame after it -
    // and `/clear` is the case that makes the second half matter: the CLI mints a NEW id
    // and reports it on an ordinary message rather than on a second `init`. Re-binding
    // whenever it changes is what keeps the note, queue, goal and work episode following
    // the conversation instead of stranding them on a dead key.
    if (typeof message.session_id === "string") this.bind(message.session_id);
    if (message.type === "assistant") {
      this.out.emit({ kind: "state", state: "working", activity: assistantActivity(message) });
      return;
    }
    if (message.type === "result") {
      this.out.emit({ kind: "turn_done", usage: null });
      return;
    }
  }

  private bind(agentSessionId: string): void {
    if (!agentSessionId || agentSessionId === this.agentSessionId) return;
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

/**
 * Claude's `SdkSpec`: start (or resume) an embedded session.
 *
 * `deps` is the transport seam - a test hands in a scripted `query` and drives this exact
 * code with no `claude` on the machine. Production takes the default, which is the only
 * importer of the vendor package.
 */
export function claudeSdkSpec(deps: ClaudeSdkDeps = defaultClaudeSdkDeps): SdkSpec {
  return {
    async launch(opts: SdkLaunchOptions): Promise<SdkSessionHandle> {
      const session = new ClaudeSdkSession(opts.cwd);
      // Turn one is queued before the query is constructed, so the first thing the CLI
      // reads is the intent - there is no separate "type the prompt" step to race.
      if (opts.prompt) session.seed(opts.prompt);
      const permissionMode = sdkPermissionMode(opts.permissionMode);
      const query = await deps.query({
        prompt: session.input(),
        options: {
          cwd: opts.cwd,
          pathToClaudeCodeExecutable: await deps.executable(),
          env: deps.env(),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(opts.resume ? { resume: opts.resume } : {}),
          ...(opts.mcp
            ? {
                mcpServers: {
                  [opts.mcp.serverName]: {
                    type: "stdio",
                    command: opts.mcp.command,
                    args: opts.mcp.args,
                    env: opts.mcp.env,
                  },
                },
              }
            : {}),
          // The ask channel's disallow + redirect are deliberately NOT rendered here. They
          // exist because a menu on a child's screen is unreadable to the dashboard; a
          // driver request IS the dashboard's own control, so the native tool is better
          // than the MCP stand-in it was approximating. The MCP server still rides along
          // above, because `report_status` and the rest are not about asking questions.
          canUseTool: session.canUseTool,
          hooks: session.hooks(),
          // CLAUDE.md, skills and the operator's settings - the same sources an
          // interactive session loads. Without this the SDK starts with none of them,
          // which would make an embedded session a different agent from a dispatched pane.
          settingSources: ["user", "project", "local"],
          // Mission Control decides when a session is over (a task settles it, or a human
          // kills it). A turn ceiling here would end one mid-work with no way to say so.
          includePartialMessages: false,
        },
      });
      void session.pump(query);
      return session;
    },
  };
}

/** The shipped driver. See `HARNESSES.claude.sdk`. */
export const claudeSdk: SdkSpec = claudeSdkSpec();
