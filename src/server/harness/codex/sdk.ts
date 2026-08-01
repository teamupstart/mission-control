import { randomUUID } from "node:crypto";
import type {
  PaneOption,
  PermissionMode,
  SdkSendDisposition,
  SessionRequestQuestion,
  ThinkingLevel,
} from "@shared/types.ts";
import { opensPullRequest, pullRequestUrlIn } from "@shared/pr-command.mjs";
import { EventStream } from "../../sdk/event-stream.ts";
import type {
  SdkEvent,
  SdkLaunchOptions,
  SdkSessionHandle,
  SdkSpec,
  SdkTurn,
  SdkUsage,
  SessionRequest,
  SessionRequestAnswer,
} from "../types.ts";
import { AppServerClient, type AppServerTransport } from "./app-server/client.ts";
import type {
  AskForApproval,
  ApprovalsReviewer,
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  ErrorNotification,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalParams,
  FileUpdateChange,
  InitializeParams,
  InitializeResponse,
  ItemCompletedNotification,
  ItemStartedNotification,
  RequestId,
  SandboxMode,
  SandboxPolicy,
  ThreadItem,
  ThreadResumeParams,
  ThreadStartedNotification,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadStatus,
  ThreadStatusChangedNotification,
  ThreadTokenUsageUpdatedNotification,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnCompletedNotification,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
  TurnStartedNotification,
  UserInput,
} from "./app-server/protocol.ts";
import { defaultCodexSdkDeps, type CodexSdkDeps } from "./sdk-deps.ts";

// Codex, driven EMBEDDED - `codex app-server` JSON-RPC behind `SdkSpec` (C10).
//
// The second driver, and the one that proves the seam: nothing above `SdkSessionHandle`
// gained an arm for it. Approvals that a pane could only show as a numbered screen arrive
// here as answerable requests with correlation ids, and the supervisor, the registry and
// the answer routes are the same ones Claude's driver already uses.
//
// ## What this module is allowed to know
//
// The app-server vocabulary stops here and in `app-server/`. Everything above speaks
// `SdkEvent` and `SessionRequest`. The READ path is untouched and keeps working for free:
// `thread/start` hands back the rollout it is about to write, so `bound` carries a real
// `transcriptPath`, and `codexTranscript.locate` / `codexUsage` go on reading the same
// `~/.codex/sessions/…` file they read for a pane-backed session (C5). A dispatched
// terminal Codex still takes `prepareCodexLaunch`'s launch-scoped hook overrides; an
// embedded one takes none, because the event stream supersedes them.
//
// ## The seam
//
// `CodexSdkDeps.connect` is this file's `PaneDeps.pane`: a test hands back a transport
// over scripted frames and drives the REAL client, the REAL projections and the REAL
// answer mapping with no `codex` on the machine. `sdk-deps.ts` is the only module that
// spawns one.

/**
 * A command or file-change approval, as three rows.
 *
 * The same three labels Claude's driver uses, and deliberately: `/select-option` echoes
 * the label back and both runtimes verify it with `optionRowMiss`, so a human answering an
 * approval and a human answering a permission prompt are doing the same thing on the same
 * card. Changing a spelling invalidates an ask already on someone's screen (a 409, and
 * they click again) so they are named once, here.
 */
const ACCEPT_LABEL = "Yes";
const ACCEPT_ALWAYS_LABEL = "Yes, and don't ask again";
const DECLINE_LABEL = "No";

/**
 * What a `permissionMode` MEANS to the app-server, and the exact inverse of what
 * `parseRolloutPermissionModeRead` (`rollout.ts`) reads back out of a rollout.
 *
 * That round trip is the point, and it is what makes this table checkable rather than
 * asserted: the card's mode chip is rendered from the rollout's `turn_context`, so a
 * posture written here that the reader cannot map back is a session whose chip goes blank
 * or, worse, reads as a mode nobody selected. `codex-sdk-modes.test.ts` drives one against
 * the other.
 *
 * `approvalsReviewer` is on this table because Codex's own four profiles are not
 * distinguishable without it: `askForApproval` and `approveForMe` are the SAME sandbox and
 * the SAME approval policy, and the only thing that separates them - in the menu, and in
 * the reader - is who the approval is routed to. Leaving it unset would make "Approve for
 * me" a row that silently applies whatever `~/.codex/config.toml` already said, which is
 * the class of lie `pastePlaceholder: null` exists to prevent.
 *
 * The phase plan proposed `never` + `workspace-write` for `approveForMe`; the repository's
 * measured reader says otherwise, and the reader wins - it was written against a real
 * rollout from codex-cli 0.145.0 and it is what the dashboard actually renders.
 */
export interface CodexPosture {
  sandbox: SandboxMode;
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
}

export const CODEX_POSTURES = {
  readOnly: { sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user" },
  askForApproval: {
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  },
  approveForMe: {
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
  },
  fullAccess: {
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    approvalsReviewer: "user",
  },
} as const satisfies Partial<Record<PermissionMode, CodexPosture>>;

/**
 * The posture for a mode, or null when this build has nothing to say about it.
 *
 * Null is what a launch with no `permissionMode` gets too, and both mean the same thing:
 * send NO overrides and let the operator's own `~/.codex/config.toml` decide, which is
 * byte-identical to what a terminal dispatch with auto mode off produces. A Claude mode
 * arriving here (they share one `PermissionMode` union) is not translated into the nearest
 * Codex profile - a mode nobody picked is worse than the operator's own default.
 */
export function codexPosture(mode: PermissionMode | null): CodexPosture | null {
  if (!mode) return null;
  return (CODEX_POSTURES as Partial<Record<PermissionMode, CodexPosture>>)[mode] ?? null;
}

/**
 * The `SandboxMode` a resolved `SandboxPolicy` corresponds to, or null when it is one this
 * table has no name for.
 *
 * Two spellings of one idea, and both are the vendor's: a thread is CREATED with a
 * kebab-case `SandboxMode` and REPORTS back a camelCase `SandboxPolicy` carrying the
 * settings that mode resolved to. Null for `externalSandbox`, which has no creation-time
 * counterpart at all - and null is load-bearing rather than tidy, because this answer is
 * what `setPermissionMode` compares against before claiming a mode change is possible.
 */
export function sandboxModeOf(policy: SandboxPolicy | null | undefined): SandboxMode | null {
  switch (policy?.type) {
    case "readOnly":
      return "read-only";
    case "workspaceWrite":
      return "workspace-write";
    case "dangerFullAccess":
      return "danger-full-access";
    default:
      return null;
  }
}

/**
 * Our `ThinkingLevel` as Codex's `model_reasoning_effort` token.
 *
 * Identity for every level the selected model offers. `levelsFor` in
 * `@shared/harness-capabilities.ts` is the single capability gate; this conversion does not
 * invent a second list that can disagree with it.
 */
export function codexEffort(effort: ThinkingLevel | null): string | null {
  return effort;
}

/** The client we identify as on the wire. Codex records it as the rollout's `originator`. */
const CLIENT_INFO = { name: "mission-control", title: "Mission Control", version: "1" };

/**
 * Notification methods we ask the server never to send.
 *
 * Every one of these is a per-token or per-chunk delta, or a payload we have no reader
 * for, on a stream this process parses line by line. `turn/moderationMetadata` alone is
 * several kilobytes of scores per turn. Opting out is not an optimisation we invented: it
 * is the capability the handshake offers for exactly this, and the frames we DO read
 * (items, turns, thread status, token usage) are complete without them.
 */
const MUTED_NOTIFICATIONS = [
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "command/exec/outputDelta",
  "process/outputDelta",
  "turn/moderationMetadata",
  "rawResponse/completed",
  "rawResponseItem/completed",
];

/** How long an activity line may be. `Session.activity` renders on one line in every layout. */
const ACTIVITY_CAP = 120;

/**
 * How much thread bookkeeping one session keeps, and why forgetting the rest is SAFE.
 *
 * Both collections would otherwise grow for the life of a card: every `/clear` retires
 * another root, and every collaboration frame can name another child. Neither is large, but
 * neither has an end either, and a long-lived session is exactly the one that accumulates
 * them.
 *
 * Bounding is only safe because BOTH degradations fall the safe way, which is a property of
 * `isOwnTree` being a positive test rather than the negation of `isRetired`:
 *
 *  - forget a RETIRED root, and a late frame from it is admitted for DISPLAY again - a
 *    stale activity line on a card, and nothing more;
 *  - forget a PARENT edge, and `rootOf` answers with the thread itself, so `isOwnTree`
 *    stops proving ownership and PR attribution SUPPRESSES rather than misfires.
 *
 * So the eviction can cost a wrong ticker line and can never cost a pull request adopted
 * onto the wrong task. The caps are generous against the real numbers - a session with
 * sixty-four context clears, or five hundred live subagents, is far outside anything the
 * dashboard produces - so in practice nothing is forgotten at all.
 */
const RETIRED_THREAD_CAP = 64;
const THREAD_PARENT_CAP = 512;

/** Insert, then drop the oldest entries past `cap`. Insertion order is Map/Set order. */
function capped<K, V>(map: Map<K, V>, cap: number): void {
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

/** A server-to-client request we are holding open, and how to answer it. */
interface Pending {
  request: SessionRequest;
  /** The JSON-RPC id to respond to. */
  id: RequestId;
  kind: "commandExecution" | "fileChange" | "userInput";
  threadId: string | null;
  /**
   * For a form: the question ids, so an answer keyed by TEXT maps back to them.
   *
   * Text-keyed, and safe to be: `userInputQuestions` refuses a payload whose questions
   * share a text before this map is built, so no id here can be overwritten by another.
   * Without that refusal the later id would silently replace the earlier one and the
   * response would answer one question twice while omitting the other.
   */
  questionIds?: Map<string, string>;
  fileChangeItemId?: string;
}

/** What a launch was configured with, kept so `clearContext` can start an identical thread. */
interface LaunchConfig {
  cwd: string;
  model: string | null;
  effort: ThinkingLevel | null;
  permissionMode: PermissionMode | null;
}

/**
 * One embedded Codex session: one `codex app-server` connection, one thread.
 *
 * Everything the supervisor can do to it is a method on `SdkSessionHandle`; everything it
 * learns arrives on `events`.
 */
class CodexSdkSession implements SdkSessionHandle {
  private readonly out = new EventStream();
  private readonly pending = new Map<string, Pending>();
  private readonly fileChanges = new Map<
    string,
    { threadId: string | null; changes: readonly FileUpdateChange[] }
  >();
  /** Retired roots, newest last. Bounded - see `RETIRED_THREAD_CAP`. */
  private readonly retiredThreads = new Map<string, true>();
  /**
   * Who each thread on this connection descends from, learned as the server mentions it.
   *
   * A connection is per session, but it does not carry ONE thread: `clearContext` leaves an
   * abandoned root behind, and a collaboration mode spawns subagent threads under whichever
   * root is running. So "is this frame mine?" is a question about a TREE, and answering it
   * with a bare id was the hole the Inspector found on #260 - a retired root's subagent is
   * not itself retired, so its late `gh pr create` completion reached the replacement card
   * and would have attached the old thread's pull request to the new session's task.
   *
   * Parentage is never guessed. It is recorded from the two places the server states it:
   * `thread/started`, whose `Thread` carries `parentThreadId`, and the `subAgentActivity` /
   * `collabAgentToolCall` items a PARENT emits about the children it spawned.
   */
  private readonly threadParents = new Map<string, string>();
  private threadId: string | null = null;
  /**
   * The turn the server says is running, or null when the thread is idle.
   *
   * This is the whole of the send decision, and it is measured rather than assumed:
   * `turn/start` on a thread that is already running ACCEPTS, returns a fresh turn id, and
   * then never starts it - no `turn/started`, no `turn/completed`, nothing. That is the
   * "probably landed" delivery the acked send exists to remove, so it must never happen:
   * while this is set, a turn is delivered by `turn/steer`, which takes the active turn id
   * as a precondition and FAILS if it has moved.
   */
  private activeTurnId: string | null = null;
  /** The most recent per-turn token usage, reported with `turn_done`. */
  private lastUsage: SdkUsage | null = null;
  private modelId: string | null = null;
  /**
   * The sandbox the RUNNING thread resolved to, read off its own start response.
   *
   * Read back rather than assumed, because the two cases where they differ are the ones
   * that matter: a launch with no `permissionMode` sends no sandbox at all and inherits
   * whatever `~/.codex/config.toml` says, and a resumed thread carries the sandbox it was
   * created with. `setPermissionMode` compares against THIS, so it refuses on what the
   * agent is actually running under rather than on what we last asked for.
   */
  private appliedSandbox: SandboxMode | null = null;
  private stopped = false;

  constructor(
    private readonly client: AppServerClient,
    private config: LaunchConfig,
  ) {}

  get events(): AsyncIterable<SdkEvent> {
    return this.out;
  }

  // ---- delivery ----------------------------------------------------------------------

  /**
   * Deliver a turn, and resolve only when the server has ACCEPTED it.
   *
   * Both arms are acked by a JSON-RPC response, which is what an embedded send buys over a
   * paste: there is no settle window, no placeholder to read back, and a rejection is
   * positive evidence that nothing landed. A steer whose `expectedTurnId` no longer matches
   * comes back as an error and rejects here - the turn moved under the caller, exactly the
   * 409 a re-read pane menu produces.
   */
  async send(turn: SdkTurn): Promise<SdkSendDisposition> {
    const threadId = this.requireThread();
    const input = turnInput(turn);
    const active = this.activeTurnId;
    if (active) {
      const params: TurnSteerParams = { threadId, input, expectedTurnId: active };
      await this.client.request<TurnSteerResponse>("turn/steer", params);
      return "steered";
    }
    await this.startTurn(threadId, input);
    return "started";
  }

  async sendIfIdle(turn: SdkTurn): Promise<"started" | null> {
    const threadId = this.requireThread();
    if (this.activeTurnId) return null;
    await this.startTurn(threadId, turnInput(turn));
    return "started";
  }

  /**
   * Begin a turn, carrying whatever overrides the operator has changed since the last one.
   *
   * Model, effort, approval policy and reviewer ride on EVERY turn rather than only the one
   * after a change, because the app-server's own wording for these fields is "for this turn
   * and subsequent turns" - which makes them thread state we are re-asserting, not a diff
   * we have to remember having applied. A restart's `thread/resume` re-asserts them here
   * too, on the first turn after it.
   *
   * The SANDBOX is deliberately not among them. `turn/start` takes a fully resolved
   * `SandboxPolicy` - writable roots, network access, tmpdir exclusions - not the
   * `SandboxMode` a thread is created with, and every one of those fields comes from the
   * operator's own config. Synthesising them here would quietly replace their sandbox with
   * one this file invented. See `setPermissionMode` for what that costs and why it is the
   * right trade.
   */
  private async startTurn(threadId: string, input: UserInput[]): Promise<void> {
    const posture = codexPosture(this.config.permissionMode);
    const effort = codexEffort(this.config.effort);
    const params: TurnStartParams = {
      threadId,
      input,
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(effort ? { effort } : {}),
      ...(posture
        ? {
            approvalPolicy: posture.approvalPolicy,
            approvalsReviewer: posture.approvalsReviewer,
          }
        : {}),
    };
    const started = await this.client.request<TurnStartResponse>("turn/start", params);
    // Recorded from the RESPONSE as well as from `turn/started`, so a second `send` racing
    // the notification cannot see an idle thread and start a turn that never runs.
    this.lastUsage = null;
    this.activeTurnId = started.turn.id;
    this.out.emit({ kind: "state", state: "working", activity: null });
  }

  async interrupt(): Promise<void> {
    const threadId = this.threadId;
    const turnId = this.activeTurnId;
    // Nothing running is not a failure: the pane path's Escape is a no-op on an idle
    // composer too, and a caller interrupting a session that just finished must not see an
    // error for having been a moment late.
    if (!threadId || !turnId) return;
    await this.client.request("turn/interrupt", { threadId, turnId });
  }

  // ---- controls ----------------------------------------------------------------------

  /**
   * Change the posture the next turn runs under - as far as this transport can.
   *
   * Two measured limits, and the refusal below is the second of them.
   *
   * The approval policy and the reviewer are per-TURN overrides, so a change lands on the
   * next `turn/start` rather than instantly. The rollout's next `turn_context` is the
   * observation that publishes the change to the card; accepting it here only schedules
   * the override and persists what a restart must re-assert.
   *
   * The SANDBOX is fixed for the life of a thread. `thread/resume` looks like the way to
   * change it and is not: against codex-cli 0.145.0, resuming a thread this connection is
   * already running REJOINS it and reports back the ORIGINAL sandbox, silently ignoring the
   * override - so a driver that used it would report a mode change that never happened,
   * which is exactly the lie `pastePlaceholder: null` exists to prevent. A mode whose
   * sandbox differs from the running thread's is therefore REFUSED. A next-thread posture
   * is not retained because it would be invisible until it took effect. Refusing beats
   * declaring the whole capability null:
   * two of Codex's four profiles differ only in who reviews approvals, and those changes
   * are real, immediate on the next turn, and visible on the chip.
   */
  setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    const posture = codexPosture(mode);
    if (!posture) throw new Error(`Codex has no permission profile called "${mode}"`);
    this.requireLive();
    const running = this.appliedSandbox;
    if (running !== posture.sandbox) {
      throw new Error(
        `this thread runs in the ${running ?? "current"} sandbox and Codex cannot move a ` +
          `running thread to ${posture.sandbox} - continue in a terminal and use /permissions`,
      );
    }
    this.config = { ...this.config, permissionMode: mode };
  };

  setEffort = async (effort: ThinkingLevel): Promise<void> => {
    this.requireLive();
    this.config = { ...this.config, effort };
  };

  setModel = async (model: string): Promise<void> => {
    this.requireLive();
    this.config = { ...this.config, model };
  };

  /**
   * Clear the conversation: a NEW thread on the same connection, and a new identity for it.
   *
   * The consequence is the one the pane path's `/clear` already has - Codex mints a new
   * thread id and a new rollout on the same card - and it reaches the dashboard through the
   * same door: the `bound` event re-fires, and the registry's rebind moves the note, queue,
   * goal and work episode onto the new key. The old thread is left alone rather than
   * archived, exactly as a `/clear` leaves the old rollout on disk.
   */
  clearContext = async (): Promise<void> => {
    this.requireLive();
    const retiring = this.requireThread();
    // The old thread is ABANDONED, not archived - so anything still running on it has to be
    // stopped first, or a turn nobody can see any more goes on spending tokens against a
    // conversation the operator just cleared. `/clear` on a pane costs the current turn too.
    //
    // A turn can finish between `interrupt` reading `activeTurnId` and the server handling
    // the call, and Codex rejects an interrupt naming a turn that has already completed.
    // That is a RACE, not a failure, and letting it escape made Clear fail on a session
    // that had just gone idle - the one moment an operator is most likely to press it.
    //
    // So the rejection is re-examined rather than swallowed: yield once to let the frame
    // pump apply whatever it has already read, and continue only if the turn is genuinely
    // gone. A still-active turn rethrows, because abandoning a thread with work running on
    // it is exactly what the interrupt above exists to prevent. Yielding too early costs
    // nothing new - the clear is refused and the operator presses again, which is the
    // behaviour this replaces - so the safe direction is the default one.
    try {
      await this.interrupt();
    } catch (err) {
      await new Promise((resolve) => setImmediate(resolve));
      if (this.activeTurnId !== null) throw err;
    }
    const started = await this.client.request<ThreadStartResponse>("thread/start", {
      ...threadStartParams(this.config),
      // Codex's own word for this case, so its analytics record a cleared context rather
      // than a second unexplained startup on one connection.
      sessionStartSource: "clear",
    } satisfies ThreadStartParams);
    this.retireThread(retiring);
    this.activeTurnId = null;
    this.lastUsage = null;
    this.bind(started, true);
  };

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.interrupt();
    } catch {
      // A turn that ended between the read and the call reports an error on some builds.
      // Closing the connection below is what actually ends the session.
    }
    // Whatever is still parked is abandoned CLOSED - a cancel, which is the decision that
    // cannot be mistaken for approval. Without it the server shuts down holding a request
    // it will never get an answer to.
    this.cancelPending();
    await this.client.close();
  }

  // ---- answering ---------------------------------------------------------------------

  /**
   * Answer a pending request.
   *
   * Refuses an id it is not holding rather than resolving something else, and refuses a
   * LABEL that does not name the row it claims - the same `optionRowMiss` rule the pane
   * walk applies before its Enter, for the same reason: a number is a position on a list
   * the caller may have re-read since, and answering the wrong row of an approval is how an
   * agent gets told to do something nobody approved.
   */
  async answer(requestId: string, answer: SessionRequestAnswer): Promise<void> {
    const held = this.pending.get(requestId);
    if (!held) throw new Error(`no pending request ${requestId} on this session`);
    const result = this.resultFor(held, answer);
    this.client.respond(held.id, result);
    this.forgetPending(requestId, held);
  }

  private resultFor(held: Pending, answer: SessionRequestAnswer): unknown {
    if (held.kind === "userInput") return this.userInputResult(held, answer);
    if (answer.kind !== "option") {
      throw new Error("an approval is answered by choosing one of its rows");
    }
    const row = held.request.options.find((o) => o.number === answer.number);
    if (!row) throw new Error(`this request has no option ${answer.number}`);
    if (row.label !== answer.label) {
      throw new Error(
        `option ${answer.number} on this request is "${row.label}", not "${answer.label}"`,
      );
    }
    const decision = approvalDecision(row.label);
    return held.kind === "commandExecution"
      ? { decision: decision satisfies CommandExecutionApprovalDecision }
      : { decision: decision satisfies FileChangeApprovalDecision };
  }

  /**
   * A `request_user_input` answer, keyed back to the ids the tool asked under.
   *
   * The card and every route speak in question TEXT (that is what `SessionRequestQuestion`
   * carries and what a human read), and Codex answers by question ID. The map is built when
   * the request is projected, so the translation cannot drift from the card that was shown.
   */
  private userInputResult(held: Pending, answer: SessionRequestAnswer): ToolRequestUserInputResponse {
    const ids = held.questionIds ?? new Map<string, string>();
    const questions = held.request.questions ?? [];
    const answers: ToolRequestUserInputResponse["answers"] = {};
    const record = (question: string, labels: readonly string[]): void => {
      const id = ids.get(question);
      if (!id) throw new Error(`this request has no question "${question}"`);
      if (id in answers) {
        throw new Error(`"${question}" was answered twice - send one entry per question`);
      }
      answers[id] = { answers: [...labels] };
    };
    if (answer.kind === "option") {
      // A single ask, answered row by row. Its rows ARE that question's options, so the
      // row's label is the answer verbatim - the same shape Claude's driver produces.
      const row = held.request.options.find((o) => o.number === answer.number);
      if (!row) throw new Error(`this request has no option ${answer.number}`);
      if (row.label !== answer.label) {
        throw new Error(
          `option ${answer.number} on this request is "${row.label}", not "${answer.label}"`,
        );
      }
      const question = questions[0];
      if (!question) throw new Error("this request is not a question");
      record(question.question, [row.label]);
      return { answers };
    }
    if (answer.kind === "text") {
      const question = questions[0];
      if (!question) throw new Error("this request is not a question");
      record(question.question, [answer.text]);
      return { answers };
    }
    for (const one of answer.answers) {
      const question = questions.find((q) => q.question === one.question);
      if (!question) throw new Error(`this form has no question "${one.question}"`);
      const typed = one.text?.trim() ?? "";
      if (typed && one.labels.length > 0) {
        throw new Error(
          `"${one.question}" has both a chosen option and custom text - send one or the other`,
        );
      }
      if (!typed && one.labels.length === 0) throw new Error(`"${one.question}" was not answered`);
      if (!question.multiSelect && one.labels.length > 1) {
        throw new Error(`"${one.question}" takes one answer, not ${one.labels.length}`);
      }
      for (const label of one.labels) {
        if (!question.options.some((o) => o.label === label)) {
          throw new Error(`"${label}" is not an option for "${one.question}"`);
        }
      }
      record(one.question, typed ? [typed] : one.labels);
    }
    for (const question of questions) {
      const id = ids.get(question.question);
      if (!id || !(id in answers)) throw new Error(`"${question.question}" was not answered`);
    }
    return { answers };
  }

  // ---- wiring, called only by `launch` -----------------------------------------------

  /** Record the thread we are driving and tell the daemon who it is. */
  bind(thread: ThreadStartResponse | ThreadResumeResponse, cleared = false): void {
    const activeTurn = [...thread.thread.turns]
      .reverse()
      .find((turn) => turn.status === "inProgress");
    if (thread.thread.status.type === "active" && !activeTurn) {
      throw new Error(`Codex reported active thread ${thread.thread.id} without an active turn`);
    }
    this.threadId = thread.thread.id;
    this.activeTurnId = activeTurn?.id ?? null;
    this.lastUsage = null;
    this.modelId = thread.model || null;
    this.appliedSandbox = sandboxModeOf(thread.sandbox);
    this.out.emit({
      kind: "bound",
      agentSessionId: thread.thread.id,
      // The rollout, reported rather than derived: `thread/start` hands back the exact path
      // it is about to write, which is what keeps `codexTranscript` and `codexUsage`
      // working on an embedded session with no arm of their own.
      transcriptPath: thread.thread.path,
      modelId: this.modelId,
      pid: this.client.pid,
      ...(cleared ? { cleared: true as const } : {}),
    });
    this.publishThreadStatus(thread.thread.status);
  }

  /** Turn one, queued as a real turn so `activeTurnId` is set before anything else runs. */
  async seed(prompt: string): Promise<void> {
    await this.startTurn(this.requireThread(), [{ type: "text", text: prompt, text_elements: [] }]);
  }

  /**
   * A server-to-client request: the whole reason this transport was chosen.
   *
   * A projection that throws is answered with an ERROR rather than allowed to escape. The
   * agent is blocked until this settles, so an exception propagating out of the frame pump
   * would take the whole session down AND leave the turn hanging - two failures for one
   * unexpected payload, on a protocol whose own docs call several of these params unstable.
   */
  onRequest = (method: string, id: RequestId, params: unknown): void => {
    const threadId = frameThreadId(params);
    const kind = pendingKind(method);
    // A retired TREE, not just the retired root: a subagent of the thread we abandoned is
    // asking on behalf of a conversation nobody is looking at any more, so it is answered
    // closed rather than put on the replacement card.
    if (this.isRetired(threadId) && kind) {
      this.client.respond(id, cancelResponse(kind));
      return;
    }
    let projected: Pending | null = null;
    try {
      projected = this.project(method, id, params);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.client.respondError(id, -32602, `Mission Control could not read ${method}: ${why}`);
      return;
    }
    if (!projected) {
      // A request kind this build has no card for. Refused rather than left hanging, for
      // the same reason: an error the agent can read beats a turn that never moves again.
      this.client.respondError(id, -32601, `Mission Control cannot answer ${method}`);
      return;
    }
    this.pending.set(projected.request.id, projected);
    this.out.emit({ kind: "request", request: projected.request });
  };

  private project(method: string, id: RequestId, params: unknown): Pending | null {
    const key = randomUUID();
    if (method === "item/commandExecution/requestApproval") {
      const p = params as CommandExecutionRequestApprovalParams;
      return {
        id,
        kind: "commandExecution",
        threadId: frameThreadId(p),
        request: {
          id: key,
          kind: "approval",
          prompt: commandApprovalPrompt(p),
          options: approvalRows(),
        },
      };
    }
    if (method === "item/fileChange/requestApproval") {
      const p = params as FileChangeRequestApprovalParams;
      const reason = p.reason?.trim() || "Codex wants to apply a file change.";
      const retained = this.fileChanges.get(p.itemId);
      const changes = fileChangeSummary(
        retained?.threadId === frameThreadId(p) ? retained.changes : undefined,
      );
      const detail = changes ? `\n\nChanges: ${changes}` : "";
      const grant = p.grantRoot ? `\n\nIt is asking to write under ${p.grantRoot}.` : "";
      return {
        id,
        kind: "fileChange",
        threadId: frameThreadId(p),
        fileChangeItemId: p.itemId,
        request: {
          id: key,
          kind: "approval",
          prompt: `${reason}${detail}${grant}`,
          options: approvalRows(),
        },
      };
    }
    if (method === "item/tool/requestUserInput") {
      const p = params as ToolRequestUserInputParams;
      const questions = userInputQuestions(p);
      if (questions.length === 0) return null;
      const questionIds = new Map<string, string>();
      for (const q of p.questions) if (q.question) questionIds.set(q.question.trim(), q.id);
      return {
        id,
        kind: "userInput",
        threadId: frameThreadId(p),
        questionIds,
        request: {
          id: key,
          kind: "question",
          // The card draws the questions; the prompt is the heading above them, and for a
          // single ask it IS the question, so nothing is said twice.
          prompt: questions.length === 1 ? questions[0]!.question : "Codex has some questions.",
          options: questions.length === 1 ? questions[0]!.options : [],
          questions,
        },
      };
    }
    return null;
  }

  /**
   * Everything the server volunteers. Silence about a method is a method we do not read.
   *
   * Guarded for the reason `onRequest` is, minus the hanging turn: a notification whose
   * shape this build did not expect is worth a line in the log, never a dead card. The
   * events that decide a session's LIFECYCLE do not come from here, so dropping one costs
   * an activity line rather than an eviction.
   */
  onNotification = (method: string, params: unknown): void => {
    try {
      this.consume(method, params);
    } catch (err) {
      console.warn(
        `[sdk] codex ${method} could not be read:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  private consume(method: string, params: unknown): void {
    const threadId = frameThreadId(params);
    // Learned BEFORE the retirement test, so a child announced by a retired root is already
    // attached to that root the first time it is asked about.
    this.learnThreadTree(method, params, threadId);
    if (this.isRetired(threadId)) return;
    switch (method) {
      case "turn/started": {
        if (!this.isCurrentThread(params)) return;
        const turnId = (params as TurnStartedNotification).turn.id;
        if (this.activeTurnId !== turnId) this.lastUsage = null;
        this.activeTurnId = turnId;
        this.out.emit({ kind: "state", state: "working", activity: null });
        return;
      }
      case "turn/completed":
        if (!this.isCurrentThread(params)) return;
        this.finishTurn((params as TurnCompletedNotification).turn.id);
        return;
      case "thread/status/changed": {
        if (!this.isCurrentThread(params)) return;
        const status = (params as ThreadStatusChangedNotification).status;
        // The backstop for an idle we would otherwise learn only from `turn/completed`.
        // Both fire today, in this order, and `finishTurn` is idempotent - but a card stuck
        // reading "working" for ever is the failure mode worth being redundant about.
        if (status.type === "idle") this.finishTurn(this.activeTurnId);
        else if (status.type === "active") {
          this.out.emit({ kind: "state", state: "working", activity: null });
        }
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = (params as ItemStartedNotification | ItemCompletedNotification).item;
        if (item.type === "fileChange") {
          if (method === "item/started") {
            this.fileChanges.set(item.id, { threadId, changes: item.changes });
          } else if (this.fileChanges.get(item.id)?.threadId === threadId) {
            this.fileChanges.delete(item.id);
          }
        }
        const activity = itemActivity(item);
        if (activity) this.out.emit({ kind: "state", state: "working", activity });
        if (method === "item/completed") this.notePullRequest(item, threadId);
        return;
      }
      case "thread/tokenUsage/updated": {
        if (!this.isCurrentThread(params)) return;
        const usage = (params as ThreadTokenUsageUpdatedNotification).tokenUsage.last;
        this.lastUsage = {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cacheRead: usage.cachedInputTokens,
          cacheWrite: usage.cacheWriteInputTokens,
          reasoningOutput: usage.reasoningOutputTokens,
          modelId: this.modelId,
          // Codex reports tokens, never money. Null rather than a figure computed here:
          // `codexPricing` owns that conversion for the ledger, and a second one would be
          // a second answer that agrees only by luck.
          costUsd: null,
        };
        return;
      }
      case "serverRequest/resolved": {
        // The server settled a request without us - an auto-review approved it, or the turn
        // that raised it was interrupted. The card has to lose the ask either way.
        const resolved = params as { requestId?: RequestId };
        for (const [key, held] of this.pending) {
          if (held.id !== resolved.requestId) continue;
          this.forgetPending(key, held);
        }
        return;
      }
      case "error": {
        const err = params as ErrorNotification;
        const message = err.error?.message?.trim();
        if (message) {
          this.out.emit({ kind: "state", state: "working", activity: clip(message) });
        }
        return;
      }
      default:
        return;
    }
  }

  private isCurrentThread(params: unknown): boolean {
    if (!params || typeof params !== "object") return false;
    return (params as { threadId?: unknown }).threadId === this.threadId;
  }

  private publishThreadStatus(status: ThreadStatus): void {
    this.out.emit({
      kind: "state",
      state: status.type === "active" ? "working" : "idle",
      activity: null,
    });
  }

  private cancelPending(): void {
    for (const [key, held] of this.pending) {
      this.client.respond(held.id, cancelResponse(held.kind));
      this.forgetPending(key, held);
    }
  }

  private forgetPending(key: string, held: Pending): void {
    this.pending.delete(key);
    if (
      held.fileChangeItemId &&
      this.fileChanges.get(held.fileChangeItemId)?.threadId === held.threadId
    ) {
      this.fileChanges.delete(held.fileChangeItemId);
    }
    this.out.emit({ kind: "request_resolved", requestId: key });
  }

  private retireThread(threadId: string): void {
    this.retiredThreads.set(threadId, true);
    capped(this.retiredThreads, RETIRED_THREAD_CAP);
    for (const [itemId, retained] of this.fileChanges) {
      if (this.isRetired(retained.threadId)) this.fileChanges.delete(itemId);
    }
    for (const [key, held] of this.pending) {
      if (!this.isRetired(held.threadId)) continue;
      this.client.respond(held.id, cancelResponse(held.kind));
      this.forgetPending(key, held);
    }
  }

  /**
   * Record whatever this frame says about who descends from whom.
   *
   * Three statements, all the server's own - nothing here infers an edge from adjacency:
   * `thread/started` carries the new thread's `parentThreadId`, and a parent's own
   * `subAgentActivity` / `collabAgentToolCall` items name the threads it spawned. Reading
   * them is what lets `rootOf` answer for a subagent at all; without it every child looks
   * like a root of its own and a retired tree keeps leaking frames.
   */
  private learnThreadTree(method: string, params: unknown, threadId: string | null): void {
    if (method === "thread/started") {
      const thread = (params as ThreadStartedNotification).thread;
      this.noteThreadParent(thread?.id ?? null, thread?.parentThreadId ?? null);
      return;
    }
    if (method !== "item/started" && method !== "item/completed") return;
    const item = (params as ItemStartedNotification | ItemCompletedNotification).item;
    if (!item) return;
    if (item.type === "subAgentActivity") {
      this.noteThreadParent(item.agentThreadId, threadId);
      return;
    }
    if (item.type === "collabAgentToolCall") {
      // The sender is the parent even when the frame arrived on another thread's stream.
      for (const child of item.receiverThreadIds ?? []) {
        this.noteThreadParent(child, item.senderThreadId ?? threadId);
      }
    }
  }

  /** Remember a parent -> child edge the server just stated. Self-edges are ignored. */
  private noteThreadParent(child: string | null, parent: string | null): void {
    if (!child || !parent || child === parent) return;
    this.threadParents.set(child, parent);
    capped(this.threadParents, THREAD_PARENT_CAP);
  }

  /**
   * The root this thread descends from, or null when we were told nothing about it.
   *
   * Bounded by the size of the map rather than trusting the server's edges to be acyclic:
   * this runs on every frame, and a cycle would otherwise hang the pump.
   */
  private rootOf(threadId: string | null): string | null {
    if (!threadId) return null;
    let current = threadId;
    for (let hops = 0; hops <= this.threadParents.size; hops++) {
      const parent = this.threadParents.get(current);
      if (!parent) return current;
      current = parent;
    }
    return current;
  }

  /** Whether this frame belongs to a tree we have abandoned. */
  private isRetired(threadId: string | null): boolean {
    if (!threadId) return false;
    const root = this.rootOf(threadId);
    return this.retiredThreads.has(threadId) || (root !== null && this.retiredThreads.has(root));
  }

  /**
   * Whether this thread is PROVABLY part of the tree the card is bound to.
   *
   * The positive counterpart of `isRetired`, and the two are deliberately not each other's
   * negation. `isRetired` decides what to DISPLAY, so it fails open: a thread we know
   * nothing about is admitted, because dropping it would silently lose a legitimate
   * subagent's activity and asks, which the phase plan asks us to project.
   *
   * This one decides PR AUTHORSHIP, so it fails closed. A pull request adopted from the
   * wrong session is the Inspector commenting on a stranger's PR under the operator's
   * GitHub identity - the failure `adoptPr`'s whole two-signal rule exists to prevent - and
   * AGENTS.md prices the asymmetry explicitly: a false negative costs one uninspected pull
   * request, a false positive writes to somebody else's. So an unknown thread proves
   * nothing and is refused here even though it is shown above.
   */
  private isOwnTree(threadId: string | null): boolean {
    if (!threadId || !this.threadId) return false;
    return threadId === this.threadId || this.rootOf(threadId) === this.threadId;
  }

  /** Close out a turn exactly once, whichever notification told us about it first. */
  private finishTurn(turnId: string | null): void {
    if (!turnId || this.activeTurnId !== turnId) return;
    this.activeTurnId = null;
    this.out.emit({ kind: "turn_done", usage: this.lastUsage });
  }

  /**
   * PR authorship, off the command stream - the same two-signal rule the hook bridge applies.
   *
   * Codex reports the command and its output on ONE completed item, so there is no pending
   * map to keep: `opensPullRequest` is the strict half (`adoptPr` accepts nothing weaker)
   * and the URL is what there is to adopt. `commandActions` is checked as well as `command`
   * because Codex wraps most commands in `/bin/zsh -lc "…"` and the parsed action is where
   * the bare `gh pr create` actually appears.
   */
  private notePullRequest(item: ThreadItem, threadId: string | null): void {
    if (item.type !== "commandExecution") return;
    // The THIRD signal, and the one this driver has to supply that a hook never did: which
    // conversation opened it. `isOwnTree` is a positive proof rather than the absence of a
    // retirement, so a completion from a thread whose parentage the server never stated -
    // the exact frame that reached the replacement card on #260 - proves nothing and is
    // dropped. See `isOwnTree` for why this one fails closed while display does not.
    if (!this.isOwnTree(threadId)) return;
    const opened =
      opensPullRequest(item.command) ||
      item.commandActions.some((a) => opensPullRequest((a as { command?: unknown }).command));
    if (!opened) return;
    const url = pullRequestUrlIn(item.aggregatedOutput ?? "");
    if (url) this.out.emit({ kind: "pr_created", url });
  }

  /**
   * Pump the connection, then say why it ended.
   *
   * Every exit converges here, because the supervisor's eviction hangs off `exited` and a
   * stream that simply stopped would leave a card whose Send button lies. `resumable` is
   * the useful part: a thread we learned the id of can be picked up by the next daemon.
   */
  async pump(): Promise<void> {
    let reason = "the session ended";
    try {
      await this.client.pump();
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    } finally {
      this.stopped = true;
      for (const [key, held] of this.pending) {
        this.forgetPending(key, held);
      }
      this.fileChanges.clear();
      this.out.emit({ kind: "exited", reason, resumable: this.threadId !== null });
      this.out.end();
    }
  }

  private requireThread(): string {
    this.requireLive();
    if (!this.threadId) throw new Error("this session has no thread yet");
    return this.threadId;
  }

  private requireLive(): void {
    if (this.stopped) throw new Error("this session's driver has stopped");
  }
}

/** The three rows an approval offers, in the order every other ask uses them. */
function approvalRows(): PaneOption[] {
  return [
    { number: 1, label: ACCEPT_LABEL },
    {
      number: 2,
      label: ACCEPT_ALWAYS_LABEL,
      detail: "Allow this, and stop asking for the rest of this session",
    },
    { number: 3, label: DECLINE_LABEL },
  ];
}

/** Which decision a row means. Shared by both approval kinds - the tokens are the same. */
function approvalDecision(label: string): "accept" | "acceptForSession" | "decline" {
  if (label === ACCEPT_ALWAYS_LABEL) return "acceptForSession";
  if (label === DECLINE_LABEL) return "decline";
  return "accept";
}

/**
 * How an abandoned request is answered.
 *
 * `cancel` rather than `decline`: the session is going away, so this is not the operator
 * refusing anything - but it is still a NEGATIVE answer, because an ask nobody answered
 * must never read as approval.
 */
function cancelResponse(kind: Pending["kind"]): unknown {
  return kind === "userInput" ? ({ answers: {} } satisfies ToolRequestUserInputResponse) : { decision: "cancel" };
}

function pendingKind(method: string): Pending["kind"] | null {
  if (method === "item/commandExecution/requestApproval") return "commandExecution";
  if (method === "item/fileChange/requestApproval") return "fileChange";
  if (method === "item/tool/requestUserInput") return "userInput";
  return null;
}

function frameThreadId(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const threadId = (params as { threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : null;
}

/** What a human is being asked to approve, in the words the interactive TUI would use. */
export function commandApprovalPrompt(p: CommandExecutionRequestApprovalParams): string {
  const head = p.reason?.trim() || "Codex wants to run a command.";
  const command = p.command?.trim();
  const where = p.cwd ? `\nin ${p.cwd}` : "";
  return command ? `${head}\n\n${command}${where}` : head;
}

export function fileChangeSummary(
  changes: readonly FileUpdateChange[] | undefined,
): string | null {
  if (!changes?.length) return null;
  return clip(
    changes
      .map((change) => {
        const moved =
          change.kind.type === "update" && change.kind.move_path
            ? ` -> ${change.kind.move_path}`
            : "";
        return `${change.kind.type} ${change.path}${moved}`;
      })
      .join("; "),
  );
}

/** One `request_user_input` payload as the questions a card can draw. */
export function userInputQuestions(p: ToolRequestUserInputParams): SessionRequestQuestion[] {
  const out: SessionRequestQuestion[] = [];
  for (const q of Array.isArray(p.questions) ? p.questions : []) {
    const question = typeof q.question === "string" ? q.question.trim() : "";
    if (!question) continue;
    // The shared form has no secret-input field. Refuse explicitly instead of rendering a
    // secret question as ordinary dashboard text.
    if (q.isSecret) throw new Error(`secret question "${question}" cannot be shown safely`);
    const options: PaneOption[] = [];
    for (const o of q.options ?? []) {
      const label = typeof o.label === "string" ? o.label.trim() : "";
      if (!label) continue;
      const detail = typeof o.description === "string" ? o.description.trim() : "";
      options.push({ number: options.length + 1, label, ...(detail ? { detail } : {}) });
    }
    // A question is IDENTIFIED BY ITS TEXT everywhere above this driver: `questions` is
    // keyed by it in `SessionRequestQuestion`, `/submit-options` matches on it, and
    // `driverFormAnswer` (`sdk/answer.ts`) refuses a second entry naming the same text. That
    // is C3's grammar and phase 4 does not get to change it - so two of Codex's questions
    // sharing a text are not something this projection can carry. Silently keeping one is
    // the worst option available: the human answers a form that looks complete and the
    // response omits a question, which leaves the agent blocked on an ask nobody can see.
    //
    // So refuse the request, naming the collision. The turn ends with an error Codex can
    // read and re-ask differently, which is the only outcome here that does not strand it.
    if (out.some((prior) => prior.question === question)) {
      throw new Error(
        `two questions share the text "${question}", which this form cannot tell apart`,
      );
    }
    out.push({
      question,
      ...(q.header ? { header: q.header } : {}),
      options,
    });
  }
  return out;
}

/** The ticker line for one item: what this session is doing right now. */
export function itemActivity(item: ThreadItem): string | null {
  switch (item.type) {
    case "commandExecution":
      return clip(item.command);
    case "agentMessage":
      return clip(item.text.split("\n").map((l) => l.trim()).find(Boolean) ?? "");
    case "reasoning":
      return "Thinking";
    case "fileChange":
      return "Editing files";
    case "mcpToolCall":
      return clip(`${item.server}/${item.tool}`);
    case "dynamicToolCall":
      return clip(item.tool);
    case "webSearch":
      return "Searching the web";
    case "contextCompaction":
      return "Compacting context";
    default:
      return null;
  }
}

function clip(text: string): string | null {
  const one = text.replace(/\s+/g, " ").trim();
  return one ? one.slice(0, ACTIVITY_CAP) : null;
}

/**
 * A turn's content blocks.
 *
 * An image is handed over as a LOCAL PATH rather than base64, which is the one place this
 * driver is simpler than Claude's and it is not an accident: the app-server runs on this
 * machine, under this daemon, so `localImage` points it at the upload we already wrote and
 * nothing has to encode a screenshot into a JSON frame.
 */
export function turnInput(turn: SdkTurn): UserInput[] {
  const images = (turn.images ?? []).map(
    (image): UserInput => ({ type: "localImage", path: image.path }),
  );
  // Text last, mirroring how the interactive composer sends a pasted image followed by the
  // sentence about it - the model reads the instruction after the thing it refers to.
  return [...images, { type: "text", text: turn.text, text_elements: [] }];
}

/** The `thread/start` params for a configuration. Shared by `launch` and `clearContext`. */
function threadStartParams(config: LaunchConfig): ThreadStartParams {
  const posture = codexPosture(config.permissionMode);
  return {
    cwd: config.cwd,
    ...(config.model ? { model: config.model } : {}),
    ...(posture
      ? {
          approvalPolicy: posture.approvalPolicy,
          approvalsReviewer: posture.approvalsReviewer,
          sandbox: posture.sandbox,
        }
      : {}),
  };
}

/**
 * Codex's `SdkSpec`: start (or resume) an embedded session.
 *
 * `deps` is the transport seam - a test hands in scripted frames and drives this exact code
 * with no `codex` on the machine. Production takes the default, which is the only module
 * that spawns a subprocess.
 */
export function codexSdkSpec(deps: CodexSdkDeps = defaultCodexSdkDeps): SdkSpec {
  return {
    async launch(opts: SdkLaunchOptions): Promise<SdkSessionHandle> {
      // Launch-scoped `-c` config, in the SAME grammar a dispatched terminal Codex takes,
      // from the same descriptor: all three MCP keys or none is `mission-mcp.ts`'s rule and
      // it is not restated here. Hooks are deliberately absent - the event stream is a
      // strictly better version of what they reported, and `--dangerously-bypass-hook-trust`
      // is not spent on a launch that needs no hooks.
      //
      // Imported LAZILY, and only when there is a descriptor to render. `mission-mcp.ts`
      // reaches `config.ts`, which resolves the state dir at module load; a static import
      // here would put that resolution behind `harness/index.ts`, which almost every test
      // file imports - and one that sets `HARNESS_HOME` after a hoisted import of the
      // registry would then find the db already pointed at the operator's real state dir.
      // `openDb` refuses that loudly (see `db-isolation.test.ts`), which is how this was
      // caught, but the fix is to not put it there.
      const args = opts.mcp
        ? (await import("../../mission-mcp.ts")).codexMissionMcpArgs(opts.mcp)
        : [];
      const transport = await deps.connect(args, opts.cwd);
      const config: LaunchConfig = {
        cwd: opts.cwd,
        model: opts.model,
        effort: opts.effort,
        permissionMode: opts.permissionMode,
      };
      let session: CodexSdkSession | null = null;
      const client = new AppServerClient(transport, {
        request: (method, id, params) => session?.onRequest(method, id, params),
        notification: (method, params) => session?.onNotification(method, params),
      });
      session = new CodexSdkSession(client, config);
      // Pumped BEFORE the handshake, because the handshake's own response arrives on it.
      const pump = session.pump();
      try {
        const params: InitializeParams = {
          clientInfo: CLIENT_INFO,
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            optOutNotificationMethods: MUTED_NOTIFICATIONS,
          },
        };
        await client.request<InitializeResponse>("initialize", params);
        if (opts.resume) {
          const resumeParams: ThreadResumeParams = {
            threadId: opts.resume,
            ...threadStartParams(config),
          };
          session.bind(await client.request<ThreadResumeResponse>("thread/resume", resumeParams));
        } else {
          session.bind(
            await client.request<ThreadStartResponse>("thread/start", threadStartParams(config)),
          );
        }
        // Turn one, awaited: `SdkSpec.launch` promises a session that is running what it
        // was asked to run, and a dispatch whose intent was never accepted has to FAIL
        // rather than come back as a card sitting idle with the task marked running.
        if (opts.prompt) await session.seed(opts.prompt);
      } catch (err) {
        // Nothing above this line is durable yet - no row, no card, no SSE frame - so the
        // only thing to unwind is the subprocess.
        await transport.close().catch(() => {});
        await pump.catch(() => {});
        throw err;
      }
      void pump.catch((err) => {
        console.error(`[sdk] codex app-server pump failed:`, err);
      });
      return session;
    },
  };
}

/** The shipped driver. See `HARNESSES.codex.sdk`. */
export const codexSdk: SdkSpec = codexSdkSpec();
