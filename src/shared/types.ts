// Shared contract between the daemon (src/server), the MCP bridge (src/mcp),
// and the web UI (src/web). Keep this the single source of truth for anything
// that crosses the SSE / HTTP boundary.

// Type-only both ways: `ensemble.ts` needs `AgentType`/`ThinkingLevel` from here. Both
// imports are erased at emit (verbatimModuleSyntax), so there is no runtime cycle.
import type { EnsembleSummary, TaskEnsembleLink } from "./ensemble.ts";
// Same type-only, cycle-free relationship: `schedules.ts` reads `AgentType`, `TaskKind`,
// `TaskPriority`, `TaskStatus` and `ThinkingLevel` from here.
import type { MissionSchedule } from "./schedules.ts";
import type { CheapAction, Divergence, SkipReason } from "./foreman.ts";
import type { ForemanModelRole, ResolvedForemanModel } from "./foreman-models.ts";
import type { FileCommentSurface } from "./file-comment-anchor.ts";
import type {
  FileCommentAuthor,
  FileCommentReviewState,
  FileCommentThreadStatus,
} from "./file-comments.ts";
import type { InspectorPosture } from "./inspector.ts";
import type { LlmJobId, ResolvedLlmJobModel } from "./llm-jobs.ts";
import type { AutomationRoleCost } from "./llm-spend.ts";
import type { LineSummary } from "./line.ts";
import type { ClaudeTransport, CodexTransport, LlmRunnerId, ResolvedLlmRunner } from "./llm.ts";
import type { ResolvedModel } from "./model-choice.ts";
import type {
  PipelineLaunchRuntime,
  PipelineProviderId,
  PipelineRun,
  PipelineRunLink,
  SessionPipelineLink,
} from "./pipeline.ts";
// Type-only in the opposite direction from protocol.ts's runtime schema imports, so the wire
// status can reuse the document contract without introducing an emitted module cycle.
import type { ForemanInstructionsSource } from "./protocol.ts";
import type { SkillEnforcement } from "./skills.ts";
import type { TaskSourceRef } from "./task-source.ts";
import type { TerminalBackendId, TerminalHandle } from "./terminal.ts";
import type {
  PersonaId,
  PersonaView,
  SessionAction,
  SessionActionId,
  WorkflowBindingId,
  WorkflowBindingSummary,
  WorkflowCommandView,
  WorkflowId,
  WorkflowRunId,
  WorkflowRunSummary,
  WorkflowSummary,
} from "./workflow.ts";

/**
 * Every agent harness Mission Control can drive. THE source of the union - the
 * zod enum in `protocol.ts` and the dashboard's dispatch input both derive from
 * this array, so a new id is added here and nowhere else.
 *
 * A tuple rather than a bare union because half the consumers need the ids as
 * VALUES (a `z.enum`, a `<select>`), and a union alone cannot produce them - which
 * is how three hand-kept copies of two strings came to exist.
 */
export const AGENT_TYPES = ["claude", "codex", "pi"] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

/**
 * Lifecycle of a tracked agent session.
 *
 * Passive discovery can only establish `working` (alive, has a foreground agent
 * process) vs `exited`. The precise `idle` / `awaiting_input` / `awaiting_review`
 * states come from active reporting (hooks or an SDK driver) and the harness's own
 * review queue. `starting` is the brief window after a terminal SessionStart hook or
 * a fresh or interrupted SDK registration, before the first prompt or driver lifecycle
 * frame. An SDK restore whose durable turn flag is clear instead carries `idle` into the
 * binding that confirms it. `stopping` means an SDK driver has accepted an operator stop
 * but has not finished draining its event stream; durable cleanup still waits for `exited`
 * and the later `session_remove`.
 */
export type SessionState =
  | "starting"
  | "idle"
  | "working"
  | "awaiting_input"
  | "awaiting_review"
  | "stopping"
  | "exited";

/**
 * Where the session's display name came from: the terminal backend that supplied it,
 * `process` when no backend holds a pane on its tty and the name is a `<agent> <pid>`
 * fallback, or `sdk` when there is no pane to name it at all and the supervisor that
 * launched it said what it is called.
 *
 * Derived from `TerminalBackendId` rather than written out, so a new multiplexer or
 * emulator widens this automatically. It used to be the closed union `"tmux" | "wezterm" |
 * "process"` with nothing connecting it to the registries - which meant a third backend
 * would stamp a `nameSource` the type did not admit and the dashboard could not read.
 */
export type NameSource = TerminalBackendId | "process" | "sdk";

/**
 * How Mission Control TALKS to a session, which is a different axis from which harness
 * it runs (`AgentType`) and from which terminal backend holds it (`TerminalBackendId`).
 *
 *  - `terminal`: a pane-backed session, whether an operator started it or we dispatched
 *    it into a terminal home. Delivery is keystrokes, structured reads are screen parses.
 *  - `sdk`: a session the daemon runs through its harness's own programmatic interface,
 *    with no pane at all. Delivery is an acked call and menus arrive as data.
 *
 * An SDK-backed Claude session is still Claude on every axis the registries measure -
 * same transcript format, same skills directory, same accent - so this is deliberately
 * NOT a new agent id. See `docs/plans/agent-sdk-sessions/plan.md`.
 *
 * APPEND-ONLY, and a tuple rather than a bare union because both are persisted: the
 * operator's per-harness choice lives in the `harnesses` blob in `app_config`. A value
 * this build cannot read falls back to `"terminal"` and REPORTS the drop
 * (`resolveDispatchRuntime`) rather than guessing at a nearest match, because the two
 * runtimes launch genuinely different things.
 */
export const SESSION_RUNTIMES = ["terminal", "sdk"] as const;
export type SessionRuntime = (typeof SESSION_RUNTIMES)[number];

/**
 * How Foreman came to be invited into a session - the value of `Session.foremanInvite`
 * when it is invited at all.
 *
 * - `"sdk"`: an embedded session Mission Control runs by definition; invited implicitly,
 *   with no stored row.
 * - `"dispatch"`: Mission Control dispatched this terminal session for a task; the
 *   dispatcher records the invite once discovery confirms the spawn.
 * - `"operator"`: a human invited Foreman explicitly.
 *
 * APPEND-ONLY, and a tuple rather than a bare union because the values are persisted in
 * `foreman_invites.source`. That persisted domain additionally contains `'withdrawn'` -
 * the tombstone an operator's withdrawal writes, which beats even the implicit SDK grant -
 * and it NEVER surfaces here: the registry resolves a withdrawn row to `null`, the same
 * value an ordinary discovered session carries.
 */
export const FOREMAN_INVITES = ["sdk", "dispatch", "operator"] as const;
export type ForemanInvite = (typeof FOREMAN_INVITES)[number];

/**
 * What an embedded driver's acknowledgement means for the submitted message.
 *
 * Both current drivers fold a message sent mid-turn into the turn already running, and both
 * report that as `steered`: Codex through `turn/steer`, Claude Code by attaching it to the
 * running turn as a `queued_command`. Either way ONE turn is in flight and one `result` ends
 * it, which is the fact the supervisor's completion bookkeeping is built on.
 *
 * `queued` is the third possibility - a CLI that holds the message for a separate next turn,
 * owing a second completion - and no driver reports it today. It is retained because it is
 * the honest description of that behavior if a driver ever has it, and it must not be
 * inferred from the vocabulary that any driver currently does: this type previously claimed
 * Claude did, the Claude driver said so on every mid-turn send, and the resulting turn that
 * was owed forever wedged the outbox closed against an idle session.
 */
export type SdkSendDisposition = "started" | "steered" | "queued";

/**
 * Where a conversation-composer submission went.
 *
 * `pending` is Mission Control's editable outbox, before any runtime has accepted the
 * turn. The other three are the embedded-driver acknowledgements above. Keeping the two
 * vocabularies distinct at the type boundary prevents a buffered message, which is still
 * editable, from being mistaken for one a driver has already accepted, which is not.
 */
export type MessageSendDisposition = SdkSendDisposition | "pending";

/** The durable lifecycle of one human-authored turn waiting to enter a conversation. */
export const PENDING_TURN_STATES = ["queued", "sending", "uncertain"] as const;
export type PendingTurnState = (typeof PENDING_TURN_STATES)[number];

/**
 * A human message Mission Control still owns.
 *
 * Queued rows are editable. `sending` means the row has crossed the atomic claim boundary
 * and may be entering a terminal or SDK driver, so recalling it would risk editing text
 * the agent already received. `uncertain` is the fail-closed recovery state whenever a
 * handoff may have crossed its runtime boundary but its outcome cannot be proven.
 */
export interface PendingTurn {
  id: string;
  /** Stable conversation key (`agentSessionId ?? session.id`), never a transient pane id. */
  noteKey: string;
  /** FIFO delivery order within the conversation. */
  seq: number;
  text: string;
  state: PendingTurnState;
  /** CAS token used by recall/retry actions. */
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** When delivery claimed the row, or null while it remains editable. */
  claimedAt: number | null;
  /** Positive non-delivery detail retained beside an editable row. */
  lastError: string | null;
}

/**
 * Reasoning effort, shared by Claude (`--effort` / `/effort`) and Codex
 * (`model_reasoning_effort` / rollout `effort`). A tuple because the settings and
 * dispatch pickers need the same values as the wire schemas and launch adapters.
 */
export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * A harness's live permission posture.
 *
 * The first six values are Claude's exact hook/footer strings. The remaining four
 * represent Codex's built-in `/permissions` profiles; they stay distinct because
 * Read Only is not Claude Plan mode, and Approve for me is not Claude Auto mode.
 */
export const PERMISSION_MODES = [
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "askForApproval",
  "approveForMe",
  "fullAccess",
  "readOnly",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Where a session's runtime metadata came from. `statusline` is Claude's own live
 * accounting (exact), `driver` is the model an embedded runtime reports when it
 * binds, `transcript` is our passive read of Claude's JSONL (approximate), and
 * `codex-rollout` is Codex's session file. The daemon never lets either passive
 * file source clobber a fresh statusLine; a driver reading seeds the model until
 * its file source supplies the rest of the row.
 */
export type MetaSource = "statusline" | "driver" | "transcript" | "codex-rollout";

/**
 * Live runtime facts about a session's model, thinking level, and context usage -
 * the same values ccstatusline shows in the terminal. Populated from the source
 * with the highest authority currently available (see `MetaSource`); null on a
 * session we haven't been able to read yet.
 */
export interface SessionMeta {
  /** Friendly model name for the chip, e.g. "Opus 4.8". Null when unknown. */
  model: string | null;
  /** Raw model id, e.g. "claude-opus-4-8[1m]" / "gpt-5-codex" (tooltip + inference). */
  modelId: string | null;
  /** True when the model runs a 1M-token window (drives the "1M" marker). */
  longContext: boolean;
  /** Live reasoning effort; null when unknown or the model has no effort parameter. */
  thinkingLevel: ThinkingLevel | null;
  /** Whether extended thinking is on (Claude statusLine only; null otherwise). */
  thinkingEnabled: boolean | null;
  /** Share of the context window used, 0-100 (rounded to an int), or null. */
  contextPct: number | null;
  /** Absolute tokens in context + the window size, for the meter's tooltip. */
  contextTokens: number | null;
  contextWindow: number | null;
  /** Which source produced these values (governs precedence on refresh). */
  source: MetaSource;
  /** epoch ms these values were observed (drives precedence + freshness TTL). */
  updatedAt: number;
}

/** Which estimator produced the API-equivalent dollar figure. */
export type CostBasis = "reported" | "api-equivalent" | "unpriced";

/**
 * One session's estimated API-equivalent cost, summed out of the `usage_ledger`.
 *
 * Both priced variants are API-equivalent estimates. `reported` means the harness client
 * performed the arithmetic (Claude Code); `api-equivalent` means Mission Control applied
 * its versioned standard-rate snapshot (Codex). The distinction is estimator provenance,
 * not economic basis: neither is subscription-plan spend or an invoice.
 *
 * Null on a session, rather than zero, when the ledger has no rows for its key - "we
 * have not been told" and "it cost nothing" are different claims and only one of them
 * is ever true here.
 */
export interface SessionCost {
  /** SUM(cost_usd) over every ledger window for this session's note key. */
  costUsd: number | null;
  basis: CostBasis;
  /** Exact model ids observed in the rows represented by this summary. */
  pricingModels: string[];
  /** Immutable estimator snapshots represented here; empty for client-calculated rows. */
  pricingVersions: string[];
  /** Token totals by tier. `cacheRead`/`cacheWrite` are billed at different rates. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Reasoning tokens included in output, when the harness reports the split. */
  reasoningOutput?: number;
  /** epoch ms of the newest window counted, so a card can say how fresh this is. */
  updatedAt: number;
}

/** One subscription rate-limit window, normalized from a harness's live usage source. */
export interface RateLimitWindow {
  /** 0-100. The harness's own number; we never derive it. */
  usedPercentage: number;
  /** When the window rolls over, in epoch SECONDS. */
  resetsAt: number;
  id?: string;
  label?: string;
  durationMinutes?: number;
}

export interface RateLimitSource {
  source: AgentType;
  windows: RateLimitWindow[];
  updatedAt: number;
}

/**
 * The Claude subscription's rate-limit picture, from statusLine or the embedded SDK.
 *
 * The one fact OpenTelemetry cannot supply (there is no quota metric). Account-global
 * rather than per-session, so it rides `FleetCost` and is deliberately NOT a `Session`
 * field.
 *
 * Present only for subscription-backed sessions, and only after usage is available -
 * an API-key user never gets one. Either window may be null on its own.
 * Absent means "unknown", and must render as nothing rather than as 0%.
 */
export interface RateLimits {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  /** epoch ms the reading was taken (these are live gauges; they are never persisted). */
  updatedAt: number;
}

/** Fleet-wide estimated usage cost for the topbar strip. */
export interface FleetCost {
  /**
   * Claude- plus Codex-estimated API-equivalent cost since local midnight. Null when any
   * usage in the window is unpriced, because a known subtotal is not a complete total.
   */
  estimatedCostToday: number | null;
  /** Same estimate over the last hour; null when that window contains unpriced usage. */
  estimatedBurnPerHour: number | null;
  /**
   * Every tier summed - input, output, cache read and cache write - since local midnight.
   *
   * One figure rather than the ledger's four columns: the strip answers "how much did the
   * fleet chew through today", and a cache read is a token the account spent whatever it
   * was billed at. The tier split stays in the ledger for anyone who needs it.
   */
  tokensToday: number;
  /**
   * Pull requests our agents opened since local midnight, from the Inspector's adoption
   * ledger - and ONLY from there, because adoption is the one thing that proves we opened
   * a PR rather than merely stood next to one (see `adoptPr`). Adoption is not gated on
   * the Inspector being enabled, so this counts on every install.
   */
  prsToday: number;
  rateLimits: RateLimits | null;
  /** Quota windows grouped by provider, so account updates remain independent. */
  rateLimitSources?: RateLimitSource[];
  /**
   * What the app spent on ITSELF - the Foreman's and Inspector's own headless runs - kept
   * out of every figure above.
   *
   * A separate line rather than part of the fleet total, and that is a product decision
   * rather than a schema convenience. The figures above answer "what is the work I asked
   * for costing me"; this answers "what is the overhead of having it watched", and they
   * move for unrelated reasons - the loops spend while nobody is asking for anything. Rolled
   * together, a quiet morning with a busy Inspector would read as fleet activity, and the
   * operator would have no way to tell which half moved. Anyone who wants one number can add
   * two that are each independently true.
   */
  automation: FleetAutomationCost;
  updatedAt: number;
}

/**
 * The autonomous loops' own spend, today.
 *
 * Always present, never null: unlike a rate-limit window, whose absence means "not
 * reported", an empty automation summary is a claim we can always make truthfully - the
 * loops either ran or they did not, and the ledger knows which.
 */
export interface FleetAutomationCost {
  /** API-equivalent estimate since local midnight; null when a row in it is unpriced. */
  estimatedCostToday: number | null;
  /** Every tier summed, since local midnight. */
  tokensToday: number;
  /**
   * Per role, heaviest first, so the strip can name what the money went on rather than
   * only how much. Empty when the loops have not run today.
   */
  roles: AutomationRoleCost[];
}

/**
 * Registry-owned identity for one logical conversation's completed work cycles.
 *
 * The logical key is the same durable identity used by the session note and goal. A
 * generation is meaningful only within that key: clearing or rebinding a conversation
 * selects a different row and starts from fresh state. `active` means work has been
 * observed since the last completion; it is persisted so a daemon restart between work
 * and the turn-end signal does not lose the completion opportunity.
 */
export interface WorkCycleSummary {
  logicalKey: string;
  generation: number;
  active: boolean;
  completedAt: number | null;
  updatedAt: number;
}

export interface Session {
  /**
   * Stable identity and Registry map key for the life of this entry. Discovery mints
   * `proc:<tty>:<pid>:<startMs>` for terminal sessions; the SDK supervisor mints
   * `sdk:<uuid>` for sessions it drives. Distinct from `agentSessionId`, which the
   * harness mints and may rotate on a context clear.
   */
  id: string;
  agent: AgentType;
  /**
   * How the daemon talks to this session: `terminal` for a pane-backed session,
   * `sdk` for one the daemon drives through the harness's programmatic interface.
   *
   * FIXED FOR THE LIFE OF AN ENTRY, which is what lets it be `alwaysEqual`-adjacent
   * reasoning elsewhere: a pane-backed session cannot become an SDK one, and a takeover
   * ends the SDK session and lets discovery adopt its terminal successor as a NEW entry
   * under its own id. Read this rather than testing the id prefix - `sdk:` ids are minted
   * by the supervisor, but nothing outside it may key behaviour on the spelling.
   */
  runtime: SessionRuntime;
  /**
   * Whether Foreman is invited to act in this session, and on whose word - see
   * `FOREMAN_INVITES`. `null` means uninvited: every plainly discovered session, and any
   * session whose invite was withdrawn.
   *
   * RESOLVED by the registry, never stored on the session: a `'withdrawn'` row in
   * `foreman_invites` resolves to `null` (the tombstone beats even the implicit SDK
   * grant); otherwise a stored `'dispatch'` or `'operator'` row resolves to its own
   * value; otherwise an SDK-runtime session resolves to `"sdk"` and everything else to
   * `null`.
   *
   * READ AS POLICY by the Foreman worker's selection sites - `foremanTriageAuthorized`,
   * `tickTargets`, `decideReviewFollowup`, `agentIsFree` - and enforced a second time by
   * the daemon, which refuses a Foreman-marked write into a session resolving to `null`.
   * Two of those read more than null-ness: `agentIsFree` requires `"sdk"` or `"dispatch"`
   * specifically, because an `"operator"` invite is help with the work already in the
   * session and not consent to be handed a new task.
   *
   * NOT an authorization field for anything a HUMAN does. Manual sends, drag-assign and
   * human review resolution never consult it; it governs the background loop only.
   */
  foremanInvite: ForemanInvite | null;
  /**
   * Display name. A terminal session takes it from the highest-priority backend holding
   * its pane - a multiplexer's session name, else an emulator's tab title, else an
   * `<agent> <pid>` process fallback. The SDK supervisor names a driver-run session.
   * `nameSource` says which answered.
   *
   * The priority is the registries' declared order (`MULTIPLEXER_IDS` then `EMULATOR_IDS`,
   * `@shared/terminal.ts`), not a tmux-then-wezterm branch: a multiplexer pane lives inside
   * an emulator pane and is the inner, more specific answer to "where does this session
   * live?".
   */
  name: string;
  nameSource: NameSource;
  state: SessionState;
  cwd: string | null;
  gitBranch: string | null;
  /**
   * The root of the checkout `cwd` sits in, resolved through symlinks. Null when
   * the session isn't in a repo. Distinguishes sessions sharing one worktree from
   * sessions that merely share a branch name across different worktrees.
   */
  gitRoot: string | null;
  /**
   * The root of the REPO this checkout belongs to, from git's common dir. Equals
   * `gitRoot` for a normal checkout; for a linked worktree it points back at the
   * main repo rather than the worktree's own directory. Null outside a repo.
   *
   * Shipped to the dashboard so the UI can answer "may Foreman send here?" with
   * the same `foremanAllowlisted` the server gates on - a worktree of an
   * allowlisted repo is allowlisted, and the card has to be able to say so.
   */
  repoRoot: string | null;
  /** Leaf agent process pid; 0 for an SDK driver with no reported subprocess. */
  pid: number;
  /** Controlling tty without `/dev/` (e.g. `ttys012`); null for an SDK runtime. */
  tty: string | null;
  /**
   * The harness's live permission posture. Terminal Claude is observed from hooks and its
   * pane footer; Codex from rollout turn_context records. An SDK registration carries the
   * launch posture until its driver can change it. Null until an authoritative source
   * reports a known built-in mode.
   */
  permissionMode: PermissionMode | null;
  /**
   * Every terminal pane this session is reachable through, in naming-priority order and at
   * most one per backend. Empty for an unintegrated terminal or an SDK runtime.
   *
   * A LIST, replacing the `wezterm` / `tmux` pair of named nullable siblings that made "how
   * many backends are there" a fact of this type. Read it through the shared helpers rather
   * than by hand: `canMessage` for "can a turn reach this session at all" (which is the
   * question ~20 call sites were asking), `canWriteTo` for "is there a composer to type
   * into" - the two differ for a driver-run session - `innermostPane` /
   * `paneToken` for which pane that is (`@shared/pane.ts`). Which handle a given action
   * wants is a rule (writes go innermost, focus walks outward), and it has one statement.
   */
  terminals: TerminalHandle[];
  /** Harness-native session/thread id, present once a hook, passive read, or driver binds it. */
  agentSessionId: string | null;
  /**
   * Absolute path to the agent's transcript file, as reported by its authoritative
   * identity source (hook, passive read, or driver). Null until that source binds it,
   * and for harnesses whose session format has no path.
   */
  transcriptPath: string | null;
  /**
   * True while this session has a current push channel. For a terminal session that
   * means its hook overlay is fresh (within the 30-minute TTL); a quiet session therefore
   * flips false. For an SDK session the live driver handle is the channel, so it remains
   * true for the rest of the entry after `bound` (including its short exit linger).
   *
   * Read it as current push-sourced state, not as an installation fact. For whether that
   * channel has ever been established, read `hooksSeen` (the historical field name).
   */
  instrumented: boolean;
  /**
   * True while `state` is backed by a fresh lifecycle reading. Hooks are one source;
   * a harness transcript that records explicit start/complete markers and an SDK driver
   * event stream are the others.
   *
   * Keep this separate from `instrumented`: the dashboard only needs to know whether
   * `idle` / `working` was observed rather than guessed from process existence, while
   * delivery safeguards may require a current push channel.
   */
  stateConfirmed: boolean;
  /**
   * True once a push channel has EVER been established for this session, with no
   * freshness window: a hook event for a terminal runtime, or `bound` for an SDK runtime.
   * The name predates the runtime axis.
   *
   * The distinction is load-bearing. Conflating the two reads a 30-minute silence
   * as "the integrations aren't installed", which is precisely what an agent parked
   * waiting on a human looks like - so anything that punishes an unobserved session
   * (see the work queue's step 3) must gate on THIS, not on `instrumented`.
   */
  hooksSeen: boolean;
  /** Free-form one-liner from the last hook, passive report, or driver state event. */
  activity: string | null;
  /** Process start for terminal sessions; SDK registration time for driver-run sessions. */
  startedAt: number | null;
  firstSeen: number; // epoch ms
  lastSeen: number; // epoch ms (last discovery observation; registration time for SDK)
  lastActivity: number | null; // epoch ms of last hook/report/driver event
  /**
   * Latest durable work-cycle state for this logical conversation.
   *
   * Optional for mixed daemon/worker startup compatibility. Absence means no lifecycle
   * activity has been persisted for the current logical key, and consumers must fail closed.
   */
  workCycle?: WorkCycleSummary;
  /** Count of pending review items for this session (denormalized for the card). */
  pendingReviews: number;
  /**
   * The current task projected onto this session's views.
   *
   * Assigned tasks correlate by `Task.sessionId`; dispatched tasks fall back to the
   * worktree path. A terminal task remains here until the session takes its next task.
   */
  task: TaskSummary | null;
  /**
   * The GitHub PR whose head branch is this session's *current* git branch, else
   * null. Live decoration, never persisted: set optimistically when the agent
   * runs `gh pr create` (proven by a hook or driver event) and reconciled by the PR poller, which
   * shells out to `gh` to keep it honest. An open PR shows here, and a *merged*
   * one lingers so you can see the session's work landed - both are retracted
   * only when the session moves to a branch that no longer matches the PR's head
   * (so a reset/reused session never shows a stale link). A closed-unmerged PR is
   * dropped like no PR at all.
   */
  prUrl: string | null;
  /** The PR number backing `prUrl` (for a compact "#123" chip), else null. */
  prNumber: number | null;
  /** Whether `prUrl` is still open or already merged - drives the card's status icon. */
  prState: PrState | null;
  /**
   * Model / thinking-level / context-usage for the card, from the highest-
   * authority source available (Claude statusLine, our transcript read, or a
   * Codex rollout). Null until we've read the session at least once.
   */
  meta: SessionMeta | null;
  /** A passive read has established the effort baseline for this exact live identity. */
  effortBaselineReady: boolean;
  /**
   * An effort the operator chose, the harness ACCEPTED, and the conversation has not run
   * under yet - null whenever `meta.thinkingLevel` is already the live answer.
   *
   * It exists because "accepted" and "applied" are not the same event on every harness.
   * Claude's driver applies a level to the conversation it is already running, so its
   * change is observed the moment the route returns. Codex's rides the next `turn/start`
   * and a running turn cannot be moved onto it: a steered follow-up joins the turn that
   * is going, which keeps the OLD level, and the rollout keeps appending `turn_context`
   * records saying so. Writing the selection into `meta.thinkingLevel` there would claim
   * the current turn changed when it did not, and leaving it nowhere at all made the chip
   * silently revert on the next routine rollout read.
   *
   * Which harnesses can produce one is declared by `EffortSpec.driverApplies`, not by
   * agent name. Server-owned and in-memory: the registry sets it, and clears it when a
   * later `turn_context` confirms the level, contradicts it, changes model, or the
   * session rebinds. A daemon restart drops it - the durable `sdk_sessions.effort` column
   * is what carries the accepted level across one, and the next turn re-asserts it.
   */
  pendingEffort: ThinkingLevel | null;
  /**
   * This session's API-equivalent estimate, denormalized off the usage ledger and keyed on
   * the same stable note key as `note` and `goal` - never on `id`, which re-mints on
   * every restart while the ledger is meant to outlive the session.
   *
   * Null until either a reported OTel window or a durable harness usage event lands for
   * the key. `basis` retains which calculator produced known estimates and keeps
   * unpriced token counts explicit.
   */
  cost: SessionCost | null;
  /**
   * The Foreman auto-responder's note for this session: a one-liner Purpose plus
   * the decision brief / audit of what Foreman did. Denormalized like `task`,
   * keyed on the stable agent session id so it survives the synthetic id churning.
   * Null until Foreman has inspected the session.
   */
  note: SessionNoteSummary | null;
  /**
   * What this session is currently attempting to solve, in one sentence. Denormalized like
   * `note` and keyed on the same stable note key, but written by the daemon on every
   * instrumented Claude session rather than by Foreman on the ones it inspects.
   *
   * A sibling of `note` rather than a field inside it, because Foreman does not own this
   * sentence and the dashboard must be free to show it without showing (or gating on)
   * anything of Foreman's - the feature remains visible in fleet summaries.
   * Null for a session that has taken no prompt yet, and for a Codex session, which carries
   * no hooks to derive one from.
   */
  goal: SessionGoalSummary | null;
  /**
   * Compact view of this session's Foreman work queue - the batch of work queued
   * for it to do next. Denormalized like `note`, keyed on the same stable note
   * key. Null when the session has no queue.
   */
  queue: SessionQueueSummary | null;
  /** Human-authored turns Mission Control still owns, in FIFO delivery order. */
  pendingTurns: PendingTurn[];
  /**
   * A queue left behind by a PREVIOUS session at this same cwd (its note key died
   * - a `/clear` or a crash-relaunch mints a new agent session id). A hint on a
   * live card offering re-attach, never an automatic rebind. Null normally.
   */
  orphanedQueue: OrphanedQueueHint | null;
  /**
   * Rolled-up state of the PR's CI checks (GitHub status-check rollup): `failing`
   * if any check failed, else `pending` while any is still running, else
   * `passing`. Null when the PR has no checks (or `gh` couldn't be asked). Only
   * `failing` is surfaced on the card - as an alert next to the PR chip.
   */
  prChecks: PrChecks | null;
  /**
   * The Inspector's state for this session's pull request, or null when there is no PR
   * or the Inspector never adopted it.
   *
   * Null is the overwhelmingly common case and MEANS SOMETHING: the Inspector only
   * adopts PRs it can prove Mission Control opened, so a card showing a PR chip and no
   * inspector chip is telling you that PR came from somewhere else.
   */
  inspector: InspectorSummary | null;
  /**
   * Why this session is worth retrospecting, or ABSENT when it is not.
   *
   * Additive and optional rather than nullable, so a daemon that has never computed it and
   * a session that has nothing to catalogue are the same thing on the wire: no offer. Every
   * surface that renders the retro offer reads this first, so a session nobody corrected and
   * whose review raised nothing gets no prompt at all - the whole point of conditioning the
   * offer rather than making Retro permanent chrome.
   */
  retro?: RetroSummary;
  /**
   * The pipeline run this session is doing the work of, or null - which is every session
   * on a fleet with no pipeline provider enabled, and so the overwhelmingly common case.
   *
   * Denormalized onto the session, like `note` and `inspector`, rather than looked up per
   * card - and for a reason particular to this one: the correlation is a fact about the
   * PROCESS. An engine-driven agent is spawned into the provider's own worktree, so its
   * cwd is what identifies it, and the cwd is a thing only the discovery sweep holds.
   *
   * It carries the three coordinates the run is keyed by plus the step that was running
   * when the session was last observed, which is everything a badge and a deep link need
   * and nothing more: a whole `PipelineRun` on every session frame would ship the run's
   * 22 step states once per correlated card per sweep, to say one word on a chip.
   *
   * Null-by-default is load-bearing rather than incidental. An uncorrelated session must
   * behave EXACTLY as it does today, so every consumer of this field fails open.
   *
   * Stamped by `Registry.pipelineLinkFor` against the projection's own worktree paths, and
   * only on a session Mission Control did NOT launch - see that method. The composer
   * suppression that hangs off it (`canMessage`) is why: an engine-driven agent runs in
   * `--print` mode and reads no input at all.
   */
  pipeline: SessionPipelineLink | null;
  /**
   * The option dialog this session's pane is showing right now - a permission prompt, an
   * `AskUserQuestion` clarification menu, the folder-trust check - or null when it isn't
   * showing one. Read off the pane each poll by `annotatePaneState`.
   *
   * Carried to the browser so the dashboard can offer the rows as buttons, because prose
   * is not an answer to a menu: text typed at a dialog is SWALLOWED and the trailing Enter
   * confirms whatever row was already highlighted (the incident `pane-dialog.ts` opens
   * with). Foreman was taught to answer these by cursor-walk; the human's only affordance
   * was the composer, which is that same swallowed-text bug with a person behind it.
   *
   * Deliberately NOT sticky across polls, unlike `permissionMode`: a dialog that has been
   * dismissed must clear from the card, and a stale one would be a button that answers a
   * question nobody is asking. It is up to one poll (1.5s) old regardless, which is why
   * answering goes through the daemon - `POST /api/sessions/:id/select-option`, or
   * `submit-options` for a form (see `multiSelect`) - which re-reads the pane and refuses
   * unless the rows still read as the labels the human was shown.
   */
  paneDialog: PaneDialog | null;
}

/** One selectable row of an option dialog, as rendered on the pane. */
export interface PaneOption {
  /** The number Claude prints on the row (1-based, and its position in the list). */
  number: number;
  /**
   * The row's visible label, whitespace-collapsed. Never the description beneath it.
   *
   * This is the field a selection is VERIFIED against (`optionRowMiss`), so it must stay
   * exactly what the row rendered - the browser echoes it back untouched when the human
   * clicks, and the daemon refuses if the pane no longer agrees.
   */
  label: string;
  /**
   * The description `AskUserQuestion` prints under the row, absent when Claude prints
   * none. Display only - it is never part of the selection check, so a description that
   * repaints between poll and click cannot make a click miss.
   */
  detail?: string;
  /**
   * Whether this row's checkbox is ticked, on the multi-select form rows that have one.
   * Absent on every row of a dialog that isn't a form, and on a form's unboxed rows
   * ("Chat about this").
   *
   * Deliberately NOT part of `label` (nor of `dialogIdentity`): it is the one thing about
   * a row that changes while the row stays the same question, so folding it into either
   * would make every tick read as a different menu.
   */
  checked?: boolean;
}

/**
 * One question of a multi-question driver form.
 *
 * Claude's `AskUserQuestion` carries several at once, each with its own rows and its own
 * single/multi choice - a shape a pane can never produce, because the TUI shows one tab at
 * a time and the parser only ever sees that tab. So this is present only on a
 * driver-sourced dialog, and its absence is what tells a reader it is looking at a screen.
 */
export interface SessionRequestQuestion {
  /** The question itself, in the words the human is shown. */
  question: string;
  /** A short label for the question, when the harness supplies one. */
  header?: string;
  /** The rows offered for THIS question. Numbered within the question, from 1. */
  options: PaneOption[];
  /** True when this question takes several answers rather than one. */
  multiSelect?: boolean;
}

/**
 * An option dialog: read off a pane, or reported by a session's driver.
 *
 * The pane was the only producer when this shape was written, which is why the field names
 * still describe a screen. It generalizes rather than being replaced because it is already
 * the wire shape the dashboard renders and Foreman answers - a second shape for the same
 * question would mean every reading surface deciding which one it is looking at, and
 * `reportBucket`'s `activePaneDialog` check would have to grow a second arm to keep saying
 * `needs-you`.
 *
 * Every field added for a driver is OPTIONAL, and their ABSENCE means "this came off a
 * pane" - so a dialog produced by `parsePaneDialog` is byte-identical to what it was
 * before the runtime axis existed, and the parser was not touched.
 */
export interface PaneDialog {
  /** Every row, ascending. Includes Claude's own trailing rows ("Type something."). */
  options: PaneOption[];
  /**
   * The row the `❯` cursor sits on - where an Enter would land right now.
   *
   * 0 on a driver-sourced dialog, which HAS no cursor: nothing is pre-selected and there
   * is no keystroke that could confirm a default row. That is the whole hazard the pane
   * path carries (text typed at a dialog is swallowed and the trailing Enter confirms
   * whatever was highlighted), and it does not exist when the answer is a callback.
   */
  highlighted: number;
  /**
   * The question the rows answer, read off the lines above them; absent when nothing
   * above them reads like one. Display only, like `detail` - but load-bearing for the
   * feature, because a permission prompt's rows are "Yes" / "No" and a human reading only
   * those has not been shown what they are approving.
   */
  prompt?: string;
  /**
   * Set when the rows carry checkboxes - a multi-select `AskUserQuestion`, which is a FORM
   * rather than a menu and must be answered as one.
   *
   * The distinction is the whole point of the flag: on a menu, Enter on a row IS the
   * answer. On a form, Enter only TOGGLES that row's box - the form stays up and nothing
   * reaches Claude until its "Submit" tab is confirmed. So a click here routes to
   * `submitPaneForm` (tick the boxes, then send) instead of `selectPaneOption` (press the
   * row), and the dashboard renders checkboxes and a Submit button instead of buttons that
   * each look like they answer.
   */
  multiSelect?: true;
  /**
   * Where this dialog came from. Absent means `pane`, which is what keeps the wire
   * compatible and keeps the parser's output unchanged - a reader that has never heard of
   * a driver goes on rendering rows exactly as it did.
   */
  source?: "pane" | "driver";
  /**
   * The driver's correlation id for the pending request. An answer must echo it, so the
   * driver resolves the callback the human was actually shown rather than whatever is
   * pending by the time the click lands. Absent for a pane dialog, which has no such
   * handle - its equivalent guard is re-reading the screen and refusing on `optionRowMiss`.
   */
  requestId?: string;
  /**
   * What kind of ask this is. DISPLAY ONLY, and absent for a pane dialog, because a pane
   * dialog cannot classify itself: the parser sees a numbered block with a cursor on it and
   * has no way to know whether that is a permission prompt, a clarifying question or a
   * folder-trust check. A driver is told which.
   */
  kind?: "permission" | "question" | "plan" | "approval" | "trust";
  /**
   * The questions of a multi-question form; absent for a pane dialog and for a driver
   * request that asks one thing. See `SessionRequestQuestion`.
   */
  questions?: SessionRequestQuestion[];
}

// ---- Foreman session notes (auto-responder) ----

/**
 * What Foreman did (or decided) about a session's pending question.
 *  - answered: Foreman sent a reply on the human's behalf (live mode).
 *  - pending: Foreman drafted a reply but has NOT sent it (dry-run / semi-auto) -
 *    it's waiting for the human to confirm or to flip the repo to live.
 *  - escalated: a real fork / risky ask - Foreman declined to answer and framed
 *    the decision for the human.
 *  - skipped: Foreman couldn't understand the ask and left it for the human.
 */
export type NoteDisposition = "answered" | "pending" | "escalated" | "skipped";

/**
 * Where a session's Goal sentence came from.
 *
 *  - heuristic: the human's own filtered prompt, written instantly by the daemon on
 *    `UserPromptSubmit`. Free, always available, but reads like a prompt rather than a
 *    summary - and says nothing at all for a session driven by a slash command.
 *  - model: a headless model pass reconciled an instruction with the durable objective
 *    and derived the compact card sentence.
 *
 * Stored rather than inferred because legacy rows use it to distinguish an already-refined
 * prompt, and because "this is still the initial raw prompt" remains visible while its first
 * reconciliation is pending.
 */
export type GoalSource = "heuristic" | "model";

/** How the latest human instruction relates to the session's durable objective. */
export type IntentRelationship = "initial" | "steer" | "amend" | "replace" | "unclear";

/**
 * The durable Foreman record for one session, keyed on `agentSessionId` when
 * known (stable across the synthetic-id churn) else the synthetic session id.
 */
export interface SessionNote {
  noteKey: string;
  /** 1-2 sentence "what is this session for + the latest relevant context". */
  purpose: string | null;
  /** Decision brief markdown: the question, the options, and Foreman's take. */
  brief: string | null;
  /** Foreman's recommended answer (shown for escalate + dry-run proposals). */
  recommendation: string | null;
  disposition: NoteDisposition;
  /** One-line audit of the last action, e.g. "approved Bash: npm test". */
  lastAction: string | null;
  /** The reviewId / transcript turn id Foreman last acted on, for idempotency. */
  handledMarker: string | null;
  updatedAt: number;
}

/** Who delivered an episode's answer: Foreman on its own, or the human via Approve. */
export type EpisodeAuthor = "foreman" | "you";

/**
 * One decision Foreman faced on a session, with the context that produced it.
 *
 * The append-only counterpart to `SessionNote`. The note says what Foreman decided
 * *now*; an episode says what it was asked, what it concluded, and what reached the
 * child - and survives the next decision, which the note does not.
 *
 * `question` and `pane` are the fields the record exists for. A terminal ask lives
 * on the child's screen and nowhere else (a blocked tool call is not yet a
 * transcript turn), so unless it is captured at decision time it is unrecoverable
 * afterwards - unlike an `input` review, whose body is durable in `reviews`.
 */
export interface ForemanEpisode {
  id: number;
  /** Same key as the note: `agentSessionId` when known, else the synthetic id. */
  noteKey: string;
  sessionId: string;
  /** `Pending.marker` - the stable id of this waiting episode. */
  marker: string;
  situation: string;
  surface: "input-review" | "terminal" | "pipeline";
  /** The ask, verbatim: a review body, an activity line, or a framed gate. */
  question: string;
  /** The child's screen when the reviewer read it. Terminal surfaces only. */
  pane: string | null;
  /** The option rows on screen, when the ask was a menu. */
  menu: PaneDialogSummary | null;
  /** `reviews.id`, when the ask arrived as a review. */
  reviewId: string | null;
  purpose: string | null;
  brief: string | null;
  recommendation: string | null;
  /** The verdict's own fields, which the note has never carried. */
  classification: string | null;
  confidence: number | null;
  /** Which tier produced the verdict (0 structural, 1 cheap, 2 full review). */
  tier: number | null;
  /**
   * What the cheap tier would have done, and how that compared - `shadow` posture only.
   *
   * Both null means NOT MEASURED, which is a different claim from `agree`: every row
   * written before these columns existed, and every row written under `off` (no cheap
   * call) or `on` (the cheap tier decided, so there is no second opinion to compare
   * against), has no measurement rather than a favourable one.
   *
   * Deliberately NOT folded into `tier`. That field honestly reports which tier produced
   * the verdict that was USED, and under shadow that is always 2 - the full review acts
   * and the cheap tier only watches. Overwriting it to say 1 would make the record claim
   * the cheap tier decided something it did not.
   */
  cheapAction: CheapAction | null;
  divergence: Divergence | null;
  disposition: NoteDisposition;
  /**
   * Why the tier ladder landed where it did - `TriageOutcome.reason`, verbatim.
   *
   * The cheap tier has always computed this and always thrown it away: `needs-judgment`,
   * `low-confidence`, `human-only-risky`, `access-without-answer`, `no-transcript-context`,
   * `no-window-boundary`, `menu-needs-a-row`, `tier1-unparseable` and the rest went to
   * `log()` and nowhere else. It is the most direct answer the system has to "why was this
   * escalated rather than answered", and until it was a column that answer existed only in
   * a worker's stdout, for the length of one scrollback.
   *
   * Free TEXT rather than an enum because one arm interpolates (`tier1-failed: <err>`), and
   * because a row written by a newer build with a reason this one has no word for should
   * still print the reason it was given. Null on every row written before the column, and
   * on the paths that never consult the ladder.
   */
  triageReason: string | null;
  /** Why a `skipped` row was skipped, when the disposition alone does not say. */
  skipReason: SkipReason | null;
  lastAction: string | null;
  /** What was actually delivered - null when nothing was sent. */
  sentText: string | null;
  /** The menu row selected, when the answer was a selection rather than typing. */
  sentOption: { number: number; label: string } | null;
  /** Who authored what reached the child - null when nothing was delivered. */
  sentBy: EpisodeAuthor | null;
  createdAt: number;
  resolvedAt: number | null;
  /**
   * Who DECIDED this episode, which is not the same question as who sent the text.
   *
   * A dismissal resolves an episode without delivering a word, so `sentBy` is null on
   * exactly the paths where a human still made the call. Reading authorship off
   * `sentBy` alone made a dismissal read back as an approval; the two answers are
   * kept apart so the record can say "you dismissed this" without inventing a send.
   * Null while the episode is still waiting on someone.
   */
  resolvedBy: EpisodeAuthor | null;
}

/**
 * One episode as the FLEET-WIDE ledger reads it - a strict subset, and deliberately so.
 *
 * `ForemanEpisode` above is the per-session drawer's shape: it carries the captured
 * terminal screen, the menu rows, the reviewer's brief and recommendation, and the text
 * that was delivered. All of that is the right payload for a surface you open on ONE
 * decision and read in full. It is the wrong payload for a list of a hundred, polled
 * every four seconds - measured on a real 631-episode database, `pane` alone was 50.6% of
 * that response and the drawer-only fields came to 82KB per poll, roughly 72MB an hour
 * with the Settings page open.
 *
 * So the ledger gets what it actually renders and nothing else. The one field that looks
 * like a loss is the ask, and it is not: the daemon runs the same `askPreview` the drawer
 * would have run and ships the one line it produces, so the two surfaces cannot disagree
 * about what a decision was about while the screen capture stays where it is read.
 *
 * Adding a field here is adding it to every poll. Prefer the per-session read.
 */
export interface ForemanEpisodeSummary {
  id: number;
  /** Same key as the note, and what the ledger groups by. */
  noteKey: string;
  marker: string;
  /** The ask, already reduced by `askPreview` server-side and clamped for the wire. */
  ask: string;
  /** Foreman's 1-2 sentence reading of what this decision was for; the row's tooltip. */
  purpose: string | null;
  /** Which tier produced the verdict that was used (0 structural, 1 cheap, 2 review). */
  tier: number | null;
  cheapAction: CheapAction | null;
  divergence: Divergence | null;
  disposition: NoteDisposition;
  /**
   * The three fields the row's own WHY is built from, and the one place this shape's
   * "prefer the per-session read" rule is deliberately spent.
   *
   * They are here because the ledger renders them, which is the test the rest of this
   * interface is held to. Before them every row printed one word from a four-word
   * vocabulary and a hover, and a screen of `running AskUserQuestion / escalated / cheap`
   * repeated six times was the actual rendering - the ask is not an identity (three
   * strings cover 54% of a real ledger) and `skipped` was covering three different events.
   *
   * The cost is what makes it defensible, and it is a MEASURED number rather than an
   * estimated one: serialising a real 841-episode ledger's newest hundred with and without
   * these three fields is 60,813 against 54,050 bytes, so 6.8KB per poll, or 68 bytes a row.
   * More than half of that is the JSON keys - `triageReason` and `skipReason` are null on
   * every row written before they existed - and it is still an order of magnitude under the
   * 82KB the drawer-only fields cost on the same measurement. `brief`, `recommendation`,
   * `lastAction` and the captured screen all stay off, and the detail read
   * (`GET /api/foreman/episodes/:id`) is where a reader goes for them.
   */
  classification: string | null;
  triageReason: string | null;
  skipReason: SkipReason | null;
  /** Who DECIDED it - not who sent the text. See `ForemanEpisode.resolvedBy`. */
  resolvedBy: EpisodeAuthor | null;
  createdAt: number;
}

/**
 * The menu rows an episode's pane was showing, as stored. A structural echo of the
 * server's `PaneDialog` rather than a re-export: this crosses the wire and is read
 * back from JSON written by an older daemon, so it must stay loose about fields the
 * parser may add.
 */
export interface PaneDialogSummary {
  options: Array<{ number: number; label: string }>;
  /** The row the `❯` cursor sat on - where an Enter would have landed. */
  highlighted: number;
}

/**
 * A session's durable objective, compact card sentence, and ordered intent-reconciliation
 * state, written by the daemon for every harness that reports substantive human prompts.
 * Foreman may never run, but the daemon still owns and persists this record.
 *
 * Keyed on the same `noteKeyFor` as SessionNote - so it survives a daemon restart and
 * orphans on a `/clear` exactly as a note does - but stored in its own row, NOT as columns
 * on `session_notes`, for the reason `QueueManager` gives for the same choice: one note has
 * one `disposition` and one `updatedAt`, and a second writer sharing them corrupts both.
 * A goal-only write would have had to invent a disposition (defaulting to "pending", which
 * means "Foreman drafted a reply it hasn't sent" - untrue for every session that merely has
 * a goal) and would bump the timestamp `foremanStatus` reports as `lastActionAt`. On a live
 * state that reads as N phantom drafts in ForemanBar and a Foreman that claims to have just
 * acted on every keystroke. Same key, same lifecycle, different record.
 */
export interface SessionGoal {
  noteKey: string;
  /** The compact form of the durable objective shown on session cards. */
  text: string | null;
  source: GoalSource | null;
  /** The completion contract Foreman verifies before it offers or performs wrap-up. */
  objective: string | null;
  /**
   * The latest filtered human prompt awaiting or represented by `relationship`.
   *
   * Persisted rather than re-read because the refiner runs debounced, well after the hook
   * that captured it: without this it would have to race the transcript for text it was
   * already handed, and would lose it entirely across a restart. Clamped (`clampPrompt`) so
   * a pasted log can't put a megabyte in a row. Server-side only - never shipped to a card.
   */
  prompt: string | null;
  /** Compact rendering of `prompt`, kept separate from the durable objective. */
  focus: string | null;
  /**
   * The most recently reconciled relationship. A revision gap, rather than this field alone,
   * says whether a newer instruction is still pending.
   */
  relationship: IntentRelationship | null;
  /** Short explanation of the relationship, shown in the Foreman drawer. */
  rationale: string | null;
  /** Starts at one and advances when an amendment or replacement changes the objective. */
  objectiveVersion: number;
  /** Increments for every substantive human prompt. */
  promptRevision: number;
  /** The newest prompt revision the intent reconciler has classified. */
  resolvedPromptRevision: number;
  /**
   * Every captured instruction not yet incorporated into the effective objective, oldest
   * first. This is durable so a rapid amendment followed by tactical steering cannot collapse
   * into the steering prompt across a debounce window or daemon restart.
   *
   * Server-side reconciliation state. It is returned only by the loopback full-goal endpoint,
   * never denormalized onto session cards.
   */
  pendingPrompts: GoalPromptRevision[];
  updatedAt: number;
}

export interface SessionIntentGuard {
  objective: string;
  objectiveVersion: number;
  promptRevision: number;
  episodeKey: string;
}

export interface GoalPromptRevision {
  revision: number;
  /** Null only for a legacy unresolved revision whose text was already lost before migration. */
  prompt: string | null;
}

// ---- Foreman session work queues ----

/**
 * Lifecycle of one work item in a session's queue.
 *
 * Three states you might expect are deliberately DERIVED, not stored - each would
 * otherwise need its own re-entry transition and would desync from the thing it
 * mirrors:
 *  - *blocked on a question* = `in_progress` && the session's bucket is
 *    `needs-you`. Triage owns that episode; the item simply doesn't advance.
 *  - *fixing* = `round >= 1` && state in {sending, awaiting_pickup, in_progress}.
 *    A fix round reuses the SAME send/pickup/work/verify cycle - only the payload
 *    differs - so it's one cycle plus a counter, not two parallel paths.
 *  - *drained* = every item terminal (see `queueDrained`).
 */
export type WorkItemState =
  | "queued"
  | "proposed"
  | "sending"
  | "awaiting_pickup"
  | "in_progress"
  | "verifying"
  | "verified"
  | "escalated"
  | "cancelled";

/** How badly a gap misses: ONLY `blocking` drives a fix round. */
export type GapSeverity = "blocking" | "advisory";

export type GapKind = "incomplete" | "untested" | "standards" | "regression";

/**
 * One shortfall the verifier found, with the strike count that decides when to
 * stop asking the agent to fix it.
 *
 * Strikes are counted PER GAP (not per attempt), so an item that keeps missing
 * the same thing escalates while an agent working through several distinct gaps
 * isn't punished for having found more work. This is a heuristic, not an identity
 * mechanism: the model will sometimes remint an id for a semantically identical
 * gap, resetting its strikes. `maxFixRounds` is the only real termination
 * guarantee - see `reconcileGaps`.
 */
export interface TrackedGap {
  /** Reused across rounds when it's the same underlying problem. */
  id: string;
  severity: GapSeverity;
  kind: GapKind;
  /** Repo-relative path the gap is about; also backs the deterministic id merge. */
  path: string;
  detail: string;
  /** What the agent should do about it (capped + sanitized before injection). */
  fix: string;
  /** How many rounds this same gap has survived. Escalates at `maxFixAttempts`. */
  strikes: number;
  /** The round it was first seen, for the audit trail. */
  firstSeenRound: number;
}

/** One unit of queued work for a session, and everything its lifecycle needs. */
export interface WorkItem {
  id: string;
  /** The queue this belongs to: `noteKeyFor(session)`. */
  noteKey: string;
  /** Authored order. Whole-list renumber on reorder, in a txn. */
  seq: number;
  /** What the human asked for - the payload of round 0. */
  intent: string;
  state: WorkItemState;
  /** Fix rounds spent. 0 = the original attempt. Bounded by `maxFixRounds`. */
  round: number;
  /** HEAD at delivery, so the verifier's diff is scoped to THIS item. */
  baseSha: string | null;
  /**
   * Transcript byte offset at delivery, scoping the verify window to this item.
   * A byte offset (not a ts/uuid) because the window reader elides the middle of
   * a big file, so filtering by time would silently drop an item's earliest turns.
   */
  transcriptAnchor: number | null;
  gaps: TrackedGap[];
  sendAttempts: number;
  /** Transient verify failures (spawn/timeout/parse-miss). Durable - see the machine. */
  verifyFailures: number;
  escalationReason: string | null;
  /** The verifier's last summary, for the card's audit trail. */
  lastVerdict: string | null;
  /** Set when a human approves a `proposed` item (the dry-run path). */
  approvedAt: number | null;
  /**
   * The exact text Foreman would type, while this item is `proposed`. Null in
   * every other state.
   *
   * It is what Approve consents TO, which is why it's stored rather than
   * recomputed for display: from round 1 on the payload is the rendered fix
   * prompt, not `intent`, so a card showing `intent` would be asking the human to
   * approve text they never read. `decideQueueTick` re-drafts whenever this stops
   * matching the payload it would render now, so "proposed" always means "THIS
   * text".
   */
  proposedPayload: string | null;
  /**
   * Set when Foreman restarted while this item was mid-`sending` and adopted it.
   *
   * The distinction is load-bearing at pickup-expiry, and it is NOT derivable from
   * anything else. On the normal path the worker watched the inject resolve, so
   * "delivered but never ingested" is positive evidence of non-delivery and a
   * resend is safe. On the crash path we never learned whether the Enter was
   * pressed - the text may be sitting unsubmitted in the pane - so a resend would
   * paste a second copy after the first and mangle the prompt. A recovered item
   * therefore escalates at expiry instead of resending.
   */
  recoveredAt: number | null;
  /** CAS token: bumped on every edit, so a stale UI write 409s. */
  revision: number;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  completedAt: number | null;
}

/** A session's whole work queue: its items plus the drain-time wrap-up state. */
export interface SessionQueue {
  noteKey: string;
  /** Re-attach hint for when the note key dies (a `/clear` mints a new one). */
  cwd: string | null;
  branch: string | null;
  /** The drain ask fires exactly once - cleared when new items arrive. */
  wrapupAskedAt: number | null;
  wrapupAnswer: string | null;
  /**
   * Historical resolved-intent guard from prompted completion before work-cycle cutover.
   * New completion decisions never read or write it; it remains readable so an upgraded
   * daemon can bootstrap a proven consumption or conservative cutover ceiling without
   * replaying a spent turn.
   *
   * The historical field name is persisted and must not be renamed casually; its value
   * is now an opaque episode key rather than goal text.
   *
   * Deliberately separate from `wrapupAskedAt`, which stays the DRAIN trigger's guard.
   * One field for both would mean a prompted wrap-up consumed the drain ask (or the
   * reverse) on a checkout that later gets a work queue.
   */
  promptedGoal: string | null;
  /**
   * Historical prompted evidence marker. Retained for database and wire compatibility;
   * current evidence fingerprints live on completion claims and do not re-arm lifecycle.
   */
  promptedEvidence: string | null;
  /**
   * Historical activity watermark paired with `promptedEvidence`. Current prompted
   * completion consumes work-cycle generations instead.
   */
  promptedActivityAt: number | null;
  /**
   * Conservative one-time upgrade ceiling for a legacy guard with no immutable activity
   * watermark. Generations at or below it are ineligible; a later completed generation
   * naturally re-arms prompted completion without consulting legacy intent or evidence.
   */
  promptedLegacyCutoverGeneration: number | null;
  /** Latest completed work-cycle generation consumed by prompted completion. */
  promptedConsumedGeneration: number | null;
  /**
   * The prompted direct-shipping handoff this queue has already made, or null when it
   * has made none under the currently recorded intent episode.
   *
   * WHY THIS EXISTS, AND WHY IT IS NOT `promptedConsumedGeneration`.
   *
   * Consuming a generation says "Foreman has answered this settled completion". It
   * deliberately does NOT say "and a human is now the only one who may re-open the
   * question", because a later generation under unchanged human intent is a legitimate
   * new opportunity - a background task notification landing its result, an item-less
   * Live Workflow repair packet being worked. Those must stay eligible.
   *
   * Injecting the direct-shipping instruction is different in kind. The instruction
   * itself makes the agent work and then park, which completes the NEXT generation, so
   * a guard keyed only on generations re-arms on the very turn it caused and injects
   * again. The handoff is authorized by the human INTENT EPISODE, not by any one
   * generation, so that is what is recorded here.
   */
  promptedDirectHandoff: PromptedDirectHandoff | null;
  /**
   * WHY the current consumed generation stopped where it did, or null.
   *
   * `promptedConsumedGeneration` answers "has this settled completion been handled" and
   * nothing else, which is exactly the state that made the reported deadlock invisible: a
   * verifier judged a finished implementation incomplete, the hold spent the generation,
   * and every later tick skipped it as handled with no record of what it believed was
   * missing. This field is that record.
   *
   * CURRENT PROJECTION, NOT HISTORY. It is written in the same statement that consumes a
   * generation and replaced wholesale by the next one; `foreman_episodes` remains the
   * append-only ledger of what Foreman did. The two answer different questions - this one
   * answers "what may recovery do now".
   *
   * Null means one of two different things, and a reader must keep them apart: a row
   * written before this field existed (legacy, still consumed, never replay it), or state
   * that failed validation (malformed JSON, an outcome this build cannot interpret, a
   * mismatched logical key, a generation that is not the consumed one). Both read as "no
   * actionable decision", which is the fail-closed answer; only the second is a bug, and
   * `toPromptedDecision` in `server/db.ts` logs it.
   */
  promptedDecision: PromptedCompletionDecision | null;
  updatedAt: number;
  items: WorkItem[];
}

/**
 * Why one prompted completion generation was consumed. APPEND-ONLY and persisted: a value
 * is added beside the existing ones, never renamed or reordered, and a build that cannot
 * interpret a stored value reads the whole decision as absent rather than guessing.
 *
 * - `held`: the verifier judged the work unfinished, or contradicted itself with a
 *   blocking gap on a complete verdict. The summary and blocking gaps are stored.
 * - `workflow_claimed`: a bound Workflow claimed the completion and owns the session.
 * - `asked`: Foreman raised the Ship it? card for a human instead of acting.
 * - `direct_handoff`: Foreman typed the direct shipping instruction for this generation.
 * - `direct_handoff_undelivered`: the handoff was recorded and the instruction then FAILED to
 *   reach the agent. The mark is written before anything types, deliberately, because a
 *   retried direct injection is the double push - so the mark cannot be rolled back and this
 *   is what keeps the record honest instead. The generation stays consumed and the Ship it?
 *   card is the recovery; a later reader must not treat this as work that was handed over.
 * - `retired`: consumed with no wrap-up action - a scout report, a review-only artifact,
 *   or another non-shipping settled turn.
 * - `empty`: the session changed nothing, so there was nothing to ship.
 * - `verification_failed`: verification INFRASTRUCTURE failed repeatedly and hit its cap.
 *   Deliberately not `held`: no model ever judged this work, so a later recovery must not
 *   send a verifier summary back that does not exist.
 */
export const PROMPTED_COMPLETION_OUTCOMES = [
  "held",
  "workflow_claimed",
  "asked",
  "direct_handoff",
  "retired",
  "empty",
  "verification_failed",
  "direct_handoff_undelivered",
] as const;
export type PromptedCompletionOutcome = (typeof PROMPTED_COMPLETION_OUTCOMES)[number];

/** One bounded blocking gap carried on a `held` decision. */
export interface PromptedCompletionGap {
  /** The verifier's stable slug for the problem. */
  id: string;
  /** Repo-relative path the gap is about, or "" when the verifier named none. */
  path: string;
  /** What is missing, concretely. Bounded at the schema, because it may later be typed. */
  detail: string;
}

/**
 * The current prompted completion decision for one logical session.
 *
 * `logicalKey` and `generation` are carried IN the record rather than left implicit in the
 * row, so a reader can refuse a decision that does not belong to the row's own key or to
 * its current consumed generation instead of trusting placement. That refusal is the whole
 * fail-closed contract: a decision is actionable only when it is demonstrably about the
 * generation the queue says was consumed.
 */
export interface PromptedCompletionDecision {
  logicalKey: string;
  generation: number;
  outcome: PromptedCompletionOutcome;
  /** Bounded human-readable reason: the verifier's summary, or why no verdict exists. */
  summary: string;
  /** Blocking gaps, non-empty only for `held`. Bounded in count and length. */
  gaps: PromptedCompletionGap[];
  decidedAt: number;
}

/**
 * Which prompted handoff a queue made. Constrained rather than a free string so a row
 * stays self-describing if a second automated handoff is ever added beside direct
 * shipping - an existing row then reads as the handoff it actually was, instead of as
 * an untyped latch whose meaning has to be inferred from when it was written.
 */
export const PROMPTED_DIRECT_HANDOFF_KINDS = ["direct-ship"] as const;
export type PromptedDirectHandoffKind = (typeof PROMPTED_DIRECT_HANDOFF_KINDS)[number];

/**
 * One recorded prompted handoff: the kind, the intent episode that authorized it, and
 * the work-cycle generation that was consumed to make it.
 *
 * Modeled as one nullable object rather than three nullable columns' worth of fields
 * because the three are written together or not at all. A partially-set triple has no
 * meaning, and the type is the cheapest place to say so.
 */
export interface PromptedDirectHandoff {
  kind: PromptedDirectHandoffKind;
  /**
   * The resolved `SessionIntentGuard.episodeKey` that authorized the handoff. Eligibility
   * compares this against the CURRENT resolved episode, which is what re-arms naturally:
   * a later accepted human prompt advances promptRevision (and so the episode key), and a
   * context clear rotates the logical key onto a different queue row entirely.
   */
  episodeKey: string;
  /** The work-cycle generation consumed in the same atomic write. */
  generation: number;
}

/**
 * Compact queue view denormalized onto a Session card (like TaskSummary).
 *
 * Deliberately NOT the full item list: the card only needs counts + the in-flight
 * headline, while the worker fetches the full queue (with gaps, shas, anchors and
 * strike counts) over the API when it actually needs to decide.
 */
export interface SessionQueueSummary {
  /** Items not yet terminal (queued/proposed/sending/…/verifying). */
  openCount: number;
  totalCount: number;
  /** The single in-flight item's state, or null when nothing is in flight. */
  inFlightState: WorkItemState | null;
  /** The in-flight item's intent, for the chip. */
  inFlightIntent: string | null;
  /** Fix round of the in-flight item (0 = the first attempt). */
  round: number;
  /** Blocking gaps on the in-flight item - what the agent is being asked to fix. */
  blockingGaps: number;
  /**
   * Items the agent actually LANDED. Projected positively rather than left to be
   * derived, because "terminal" and "succeeded" are different facts: `verified`,
   * `escalated` and `cancelled` are all terminal, so subtracting the failures a
   * caller happens to know about counts every other terminal state as a success -
   * which is how a cancelled item came to read as "done" on the card's chip. A new
   * terminal state must not silently join the win column; it has to be added here.
   */
  verifiedCount: number;
  escalatedCount: number;
  /** True when every item is terminal and the wrap-up ask is due/answered. */
  drained: boolean;
  wrapupAskedAt: number | null;
  /**
   * Whether the ask above has been answered (sent or dismissed) - projected as a
   * boolean because the card only ever needs "is this question still open", never the
   * instruction itself.
   *
   * Required here rather than left to be derived from `wrapupAskedAt`, because that
   * field is never cleared: on the drain path it is also the once-only guard, so an
   * answered ask keeps a timestamp forever. Anything reading `wrapupAskedAt` alone as
   * "there is a question here" is right once and wrong every time after - which is
   * exactly what the card chip needs to get right on a `prompted` ask, whose row has no
   * items to make the chip render for any other reason.
   */
  wrapupAnswered: boolean;
  updatedAt: number;
}

/**
 * A queue whose own session is gone, surfaced on a LIVE card at the same cwd as a
 * re-attach hint. Never an auto-rebind: a different agent at that cwd may be doing
 * something else entirely, so re-attaching is always an explicit click.
 */
export interface OrphanedQueueHint {
  noteKey: string;
  itemCount: number;
  branch: string | null;
}

/**
 * Compact goal view denormalized onto a Session card.
 *
 * Rides the existing session snapshot, so Goal needs no event type of its own - exactly how
 * `note` already reaches the card. `SessionGoal.prompt` is deliberately absent: it is the
 * refiner's input, up to `clampPrompt`'s 4KB, and this is denormalized onto every card in
 * every snapshot - shipping it would put kilobytes of prompt on the wire per session to
 * render nothing.
 */
export interface SessionGoalSummary {
  /** The current resolved objective shown under the card title. */
  text: string | null;
  /** Lets the card tell an initial raw objective from a refined one. */
  source: GoalSource | null;
  /** The current tactical focus, bounded to the same one-line size as the objective. */
  focus?: string | null;
  relationship?: IntentRelationship | null;
  objectiveVersion?: number;
  promptRevision?: number;
  resolvedPromptRevision?: number;
  updatedAt: number;
}

/** Compact note view denormalized onto a Session card (like TaskSummary). */
export interface SessionNoteSummary {
  purpose: string | null;
  brief: string | null;
  recommendation: string | null;
  disposition: NoteDisposition;
  lastAction: string | null;
  /**
   * The channel this draft targets, so Approve delivers to the surface Foreman
   * actually drafted for (`review:<id>` resolves that review; `await:`/`state:`
   * type into the terminal) rather than inferring it from the live review map,
   * which can drift while a draft sits pending.
   */
  handledMarker: string | null;
  updatedAt: number;
}

/** Foreman's live status for the dashboard (config + derived counts). */
export interface ForemanStatus {
  enabled: boolean;
  mode: "dry-run" | "live" | "semi-auto";
  /**
   * Which standing-guidance state is current. The document and its ETag stay on the focused
   * instructions route rather than joining this frequently polled status response.
   */
  instructionsSource: ForemanInstructionsSource;
  /**
   * True when a worker currently HOLDS THE LEASE and renewed it recently - i.e. a
   * leader is alive. A second `npm run foreman` idles as a standby (so it can take
   * over when the leader's lease expires) and never acquires the lease, so it can
   * neither make this true on its own nor make the dashboard claim two workers.
   */
  running: boolean;
  /** How many sessions currently need you (Foreman's inbound queue). */
  queueDepth: number;
  /** Note counts by disposition, across all inspected sessions. */
  counts: { answered: number; escalated: number; pending: number; skipped: number };
  /** epoch ms of the most recent Foreman note, or null. */
  lastActionAt: number | null;
  /**
   * The backlog autopilot's live readout: how much of the agent budget is spent, and
   * how the backlog splits into schedulable and blocked.
   *
   * `active` counts EVERY live agent session plus the tasks still mid-provision, which
   * is the same number `decideBacklogTick` refuses to launch past - so the popover's
   * "3 / 5 agents" is the ceiling being applied, not a second opinion about it.
   */
  autopilot: {
    /** Whether the backlog autopilot is armed (`autoBacklog` in the config). */
    on: boolean;
    /** Live agents + tasks mid-provision. */
    active: number;
    /** The configured ceiling (`maxSessions`). */
    max: number;
    /** Enabled backlog items with every dependency satisfied - what autopilot may take next. */
    ready: number;
    /**
     * ENABLED backlog items waiting on another task.
     *
     * Counted over the enabled ones only, so `ready + blocked + disabled` is the whole
     * backlog. Folding the disabled items in here would report work somebody
     * deliberately parked as work the dependency graph is holding up - a number that
     * sends the operator looking for a prerequisite that does not exist.
     */
    blocked: number;
    /** Backlog items switched off, which autopilot will not schedule at all. */
    disabled: number;
  };
  /**
   * The worker-owned dependency planner circuit, projected through the daemon.
   *
   * This is operational state, not persisted scheduler state. The worker remains the only
   * process that decides when to plan or enter serial fallback; the daemon only bounds and
   * exposes its latest report so the dashboard can explain a quiet backlog.
   */
  planner: ForemanPlannerHealth;
  /**
   * What each of Foreman's four model calls will actually spawn with, and why -
   * the operator's config, an env var, or the shipped default.
   *
   * RESOLVED server-side rather than re-derived in the panel, because the env layer is
   * invisible to the browser: a panel that showed only `config || default` would print
   * "claude-haiku-4-5 (default)" while a `FOREMAN_TRIAGE_MODEL` in the worker's shell
   * quietly ran something else. Reporting the resolution, with its source, is the
   * difference between a settings screen and a guess.
   *
   * The daemon resolves it from its OWN env, which is the worker's env in every
   * supported way of running the stack (`make start` puts both under one
   * `concurrently` shell). Hand-starting the worker with a different environment is the
   * one case this readout cannot see.
   */
  models: Record<ForemanModelRole, ResolvedForemanModel>;
  /**
   * The provider every Foreman role actually spawns through, resolved the same way and
   * for the same reason as `models` above.
   *
   * Foreman's own `runner` when it has one; otherwise the app-wide ladder (`llm` config,
   * then `MISSION_LLM_RUNNER`, then the default), which the browser cannot see. The panel
   * renders this rather than `config.runner ?? "claude"`, which would print a provider the
   * operator neither chose nor is running on.
   */
  runner: LlmRunnerId;
}

/** One bounded snapshot of the backlog dependency planner's effective runtime and health. */
export interface ForemanPlannerHealth {
  state: "healthy" | "degraded";
  /** Provider the worker is actually using for the dependency read. */
  runner: LlmRunnerId;
  /** Model the worker is actually passing to that provider. */
  model: string;
  /** Consecutive failures for the most recent failing planner or storage path. */
  failureCount: number;
  /** Safe, single-line, bounded reason from the most recent failure. */
  lastError: string | null;
  /** Epoch ms for the next automatic probe, or null while no retry is owed. */
  nextRetryAt: number | null;
}

// ---- Custom skills ----

/** One catalog skill, as parsed from `skills/<id>/SKILL.md`'s frontmatter. */
export interface SkillCatalogEntry {
  /** The directory under `skills/`. Owns the `mission-<id>` namespace in ~/.claude/skills. */
  id: string;
  /** The frontmatter `name` - what the user types and what the panel shows. */
  name: string;
  /** The frontmatter `description`. Preloaded into context; drives model invocation. */
  description: string;
  category: string;
  enforcement: SkillEnforcement;
}

/** A catalog row plus whether it is currently symlinked in. */
export interface SkillRow extends SkillCatalogEntry {
  enabled: boolean;
}

/** Everything the skills panel draws, in one read. */
export interface SkillsView {
  /** The master switch. Off means nothing is symlinked, whatever the rows say. */
  enabled: boolean;
  skills: SkillRow[];
  /**
   * Live CLAUDE sessions that have yet to pick up the current symlink set - i.e.
   * what "N sessions will pick this up when they next go idle" is counting.
   *
   * Codex sessions are excluded, and not as a detail: codex has no
   * `/reload-skills` and no `~/.claude/skills`, so counting them would leave a
   * number that can never reach zero on a mixed set of sessions.
   */
  pending: number;
  /** Anything the reconciler could not do, in the operator's words. Usually empty. */
  problems: string[];
}

/** The states we surface for a session's PR. Closed-unmerged is treated as "no PR". */
export type PrState = "open" | "merged";

/** Rolled-up CI status for a session's PR. A single failing check dominates. */
export type PrChecks = "passing" | "failing" | "pending";

// ---- dispatched tasks (agents) ----

/**
 * What a dispatched task is FOR: ship = deliver a change (PR/merge);
 * scout = investigate/audit and report; plan = produce a reviewed plan, which can then
 * schedule the work it describes; chat = have an open-ended conversation with no planned
 * artifact.
 *
 * `scout` used to own the word "plan" in this comment, and giving the third kind the word
 * is the point of adding it: an investigation answers a question, where a plan proposes a
 * route and is reviewed before anything is built.
 *
 * A tuple rather than a bare union, for the reason `AGENT_TYPES` above is one: half the
 * consumers need the ids as VALUES (a `z.enum`, a `<select>`), a union alone cannot
 * produce them, and the set had accordingly been written out by hand in seven more
 * places. Array order is picker order - the order the dispatch form lists the kinds in,
 * and `test/task-kinds.test.ts` fails on a second copy of the set.
 *
 * APPEND, never reorder: `ship` at index 0 is the default every automated writer takes,
 * and the read paths that degrade an unknown persisted kind land on it.
 */
export const TASK_KINDS = ["ship", "scout", "plan", "pipeline", "chat"] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

/**
 * The kind a task has when nobody chose one.
 *
 * Derived from the tuple rather than written as `"ship"`, so the "index 0 is the default"
 * contract that the comment above states is a thing the compiler carries: reordering the
 * tuple moves this with it instead of leaving a literal behind that silently disagrees.
 *
 * Two surfaces read it as a value rather than as a default they hardcode - the task pill,
 * which draws every kind EXCEPT the one you get by not choosing, and the task row read
 * (`server/db.ts`), which degrades a kind this build has never heard of to it.
 */
export const DEFAULT_TASK_KIND = TASK_KINDS[0];

/**
 * Coarse lifecycle of a dispatched task. Deliberately does NOT mirror the live
 * session's runtime state (working/idle/needs-input) - that stays a property of
 * the Session so runtime status is never duplicated. A task waits in the
 * `backlog`, is provisioned (`dispatching`), bound to a live session (`running`),
 * and then reaches a terminal state.
 *
 * `backlog` (not "queued"): a session work queue (`SessionQueue`) is a different
 * thing entirely - it feeds items to an EXISTING agent, where this provisions a
 * new worktree + agent per task. The UI has always said "backlog"; the word here
 * matches it so "queue" only ever means the session work queue.
 */
export type TaskStatus =
  | "backlog"
  | "dispatching"
  | "running"
  | "done"
  | "cancelled"
  | "failed";

/**
 * How a task's isolated worktree was provisioned - decides how it is torn down.
 *
 * Persisted and append-only. `treehouse` and `git` keep their historical meanings even
 * after native allocation becomes the default: cleanup always follows the provider that
 * created the checkout, never whichever provider is currently available.
 */
export type WorktreeProvider = "treehouse" | "git" | "mission";

/**
 * How urgent a task is, when somebody said. Never inferred: a task with no priority
 * carries `null`, which is a distinct answer from `low` and sorts differently (see
 * `priorityRank` in `@shared/task.ts`).
 */
export type TaskPriority = "low" | "med" | "high" | "blocker";

/**
 * An operator-declared prerequisite for a task.
 *
 * Task references are the durable form: selecting an active session that already
 * carries a Mission Control task is normalized to that task by the daemon. A bare
 * session reference is kept only for operator-started work with no task row of its
 * own. `title` is a display snapshot so a stopped/removed target can still explain
 * what is blocking the dependent task.
 *
 * `satisfiedAt` is deliberately persisted on the edge, not inferred forever from a
 * live session. A merged PR can outlive the process that opened it, and terminal task
 * rows are eventually pruned from the in-memory registry; once observed, completion
 * must therefore remain true without either object being present.
 */
export type TaskDependency =
  | {
      type: "task";
      taskId: string;
      title: string;
      sessionId: string | null;
      episodeId: string | null;
      agentSessionId: string | null;
      branch: string | null;
      prUrl: string | null;
      selectedAt: number | null;
      satisfiedAt: number | null;
    }
  | {
      type: "session";
      sessionId: string;
      title: string;
      episodeId: string | null;
      agentSessionId: string | null;
      branch: string | null;
      prUrl: string | null;
      selectedAt: number | null;
      satisfiedAt: number | null;
    };

/**
 * One SECONDARY repository attached to a multi-repo task.
 *
 * The primary repo is never one of these. It stays on `Task`'s own scalars
 * (`repoRoot`/`worktreePath`/`branch`/`provider`/`baseSha`), so every single-repo consumer
 * keeps a meaningful value and a single-repo task carries an EMPTY `extraRepos` - the
 * invariant the persisted `task_repos` table states as "zero rows".
 *
 * Order is the entry's persisted `position`, which is also the worktree slot the git
 * fallback derives its path from. Nothing may renumber a provisioned entry without moving
 * its tree: teardown and startup reconciliation read the recorded `worktreePath` rather
 * than recomputing it.
 *
 * `prUrl`/`prState`/`mergedAt` carry this repository's own pull request, projected on read
 * from the episode's per-repo record. They were declared - and left null - one phase before
 * anything wrote them, so the wire shape did not change under consumers when it started
 * being populated. The PRIMARY repo's pull request is deliberately not among them: it is not
 * one of these entries, and a card reads the whole set through `TaskSummary.repoPrs`.
 */
export interface TaskRepoEntry {
  /** Absolute path of the attached repo's main checkout, as `resolveTaskRepoRoot` returns it. */
  repoRoot: string;
  /** Worktree provisioned for this repo (realpath), or null before dispatch. */
  worktreePath: string | null;
  /** Branch cut in this repo. Deliberately the SAME name as the primary's. */
  branch: string | null;
  /** Persisted provider authority for native return, legacy return, or disposable removal. */
  provider: WorktreeProvider | null;
  /** Opaque native allocator identity. Present only when `provider` is `mission`. */
  worktreeLeaseId: string | null;
  /** Full 40-character commit this repo's branch was cut at, recorded at provisioning time. */
  baseSha: string | null;
  /** The pull request this task opened in THIS repository, or null if none yet. */
  prUrl: string | null;
  /** `open` or `merged` as of the last observation, or null while unknown. */
  prState: string | null;
  /** When that pull request was observed merged, or null. */
  mergedAt: number | null;
}

/**
 * How long a terminal task's checkouts survive without a Git-visible change.
 *
 * Fixed, and deliberately without a configuration key in this release - see
 * `docs/worktrees-and-checks.md`. Shared rather than server-only because the dashboard states
 * the policy in words next to the manual cleanup control, and a copy that drifted from the
 * server's window would be a promise the product does not keep.
 */
export const TASK_WORKTREE_RETENTION_DAYS = 30;

/** Bytes of automatic-cleanup explanation that may reach a browser. One short sentence. */
export const TASK_AUTOMATIC_CLEANUP_DETAIL_LIMIT = 200;

/**
 * What automatic worktree cleanup has to say about this task, or null when it has nothing.
 *
 * Null in every ordinary case: a task with no checkout, a checkout inside its 30-day window,
 * and a task whose automatic cleanup simply worked (its row is deleted, and the whole-task
 * update that removes the Clean up control is the report). It becomes non-null only when a
 * cleanup that was already DUE failed to release everything and is waiting to try again -
 * which is the one situation where a card showing a stale worktree needs to explain itself.
 *
 * Deliberately small. The ledger holds a fingerprint, a resource generation, a claim token and
 * a provider's own error text; none of them appear here. `detail` is a bounded, human-readable
 * classification produced for this purpose, never a raw exception, never a git path.
 *
 * It is derived from the retention ledger on read, not stored on the `tasks` row: there is one
 * durable clock, and a second copy of its state would be a second thing to keep in step.
 */
export interface TaskAutomaticCleanup {
  /** Only one state crosses today. An enum so a later observability state is additive. */
  state: "retrying";
  /** When the daemon will try again, epoch ms, or null if it is ready now. */
  retryAt: number | null;
  /** One bounded sentence about why the last attempt did not finish. */
  detail: string | null;
}

export interface Task {
  id: string;
  /** Short label - source of the terminal home name slug and the card title. */
  title: string;
  /** The full task prompt delivered as the agent's first message. */
  intent: string;
  kind: TaskKind;
  agent: AgentType;
  /** Urgency, or null when nobody set one. Optional everywhere; never inferred. */
  priority: TaskPriority | null;
  /**
   * Free-form tags - single strings, not key/value pairs. Empty by default. Normalized
   * on the way in by `normalizeLabels` (@shared/task.ts), so what's stored is already
   * trimmed, deduped and capped.
   */
  labels: string[];
  /** Operator-declared prerequisites. Unmet entries force this task to stay backlogged. */
  dependencies: TaskDependency[];
  /**
   * Whether Foreman's backlog autopilot may schedule this item. True on every task
   * that has not been deliberately switched off - including every task filed before
   * the toggle existed.
   *
   * A SCHEDULING GATE, not a dependency and not annotation. `readyBacklog` drops a
   * disabled item, so the autopilot does not select it for dispatch or assignment.
   * `plannableBacklog` deliberately KEEPS it in the finite planning budget: `sanitizePlan`
   * drops inferred edges whose target was not in its input, so hiding a parked prerequisite
   * would delete dependencies pointing at it and make its dependents ready on the next
   * replan. Re-enabling an item already covered by the stored plan does not make it stale.
   *
   * It deliberately does NOT stop a human, but the daemon still enforces the gate by
   * default: dispatch and assign refuse a parked backlog task unless the request claims
   * `overrideDisabled`. The dashboard's manual launch and drag-to-assign paths claim it;
   * Foreman's client never does. The toggle says "not without me", not "not at all" - a
   * gate that refused the button the operator just pressed to protect a background
   * scheduler's ordering is the same surprise `maxSessions` deliberately avoids.
   *
   * A disabled item still BLOCKS anything that depends on it, and reports as its own
   * `BlockerState` (@shared/backlog.ts) rather than as "waiting": it will not finish
   * on its own, and the dependent card has to say which of the two kinds of "needs
   * you" this is.
   */
  enabled: boolean;
  /**
   * Model override for this task, or null to follow the harness default configured
   * in Settings. Null is NOT "the default as it stood when this was shelved" - the
   * default is resolved at dispatch time, so a backlogged task launches on whatever
   * is configured then.
   */
  model: string | null;
  /**
   * Reasoning-effort override for this task, or null to follow the harness default.
   * Resolved at dispatch time for the same reason as `model`: a shelved task should
   * follow a default changed while it waited unless somebody explicitly pinned it.
   */
  effort: ThinkingLevel | null;
  /**
   * Published Workflow identity armed for this task's completion, or null for none.
   *
   * This is durable dispatch intent rather than a binding id: the binding cannot exist until
   * the launched session has a stable conversation identity. WorkflowManager resolves this to
   * the workflow's current immutable version when that session appears.
   */
  workflowId: WorkflowId | null;
  /**
   * Where this task was swept from, when a task source filed it, else null.
   *
   * The LINK BACK, and nothing more. De-duplication is decided against the
   * `task_source_seen` table, never against this - dedupe here would mean deleting a
   * swept task un-sees it, so the next sweep re-files it and the delete button becomes a
   * no-op. A seen row deliberately outlives the task; this field dies with it.
   */
  source: TaskSourceRef | null;
  /**
   * The provider run this pipeline dispatch owns.
   *
   * New dispatches persist it before their host starts. Older terminal tasks may still learn
   * it when a child agent proves the home/worktree join. Kept separate from `sessionId`:
   * conductor may launch several sequential agents, so no one child session owns the task
   * lifecycle. The daemon settles the task from the provider projection instead.
   */
  pipelineRun: PipelineRunLink | null;
  /** Absolute path of the source repo the worktree is cut from. */
  repoRoot: string;
  /** Isolated worktree the agent runs in (realpath) - the correlation key. Null while in the backlog. */
  worktreePath: string | null;
  /** Worktree branch, once known - remembered so teardown can drop a throwaway `harness/*` branch by name. */
  branch: string | null;
  /** Persisted provider authority for native return, legacy return, or disposable removal. */
  provider: WorktreeProvider | null;
  /** Opaque native allocator identity. Present only when `provider` is `mission`. */
  worktreeLeaseId: string | null;
  /**
   * The full 40-character commit the PRIMARY repo's branch was cut at, or null before
   * dispatch (and on every task dispatched before this column existed).
   *
   * On `Task` rather than in a `task_repos` row, and that placement is load-bearing in two
   * directions. It keeps "a single-repo task has zero `task_repos` rows" true, and it is
   * the only place a reader can learn the primary's baseline - so a rule that iterates
   * `extraRepos` alone silently excludes the primary. Recorded on single-repo dispatches
   * too: it costs one column write and keeps one code path.
   */
  baseSha: string | null;
  /**
   * Secondary repositories attached to this task, in `position` order. Empty for the
   * single-repo tasks that are nearly all of them.
   *
   * Rides the whole-`Task` `task_upsert` event, so there is no new `ServerEvent` and no
   * `MissionState` collection to keep in step.
   */
  extraRepos: TaskRepoEntry[];
  /**
   * The name of the terminal home we created for this task, or null before dispatch.
   *
   * Vendor-neutral: it is a NAME, and which backend holds it is resolved against the
   * terminal registry (`killHome` / `homeAlive` in `terminal/home.ts`), never assumed to
   * be tmux. Persisted as `home_name`, migrated in place from the former `tmux_session`
   * column - see the backfill in `db.ts`'s `migrate()`. It drives destructive teardown, so
   * a value that fails to resolve leaves the worktree standing rather than reclaiming it.
   */
  homeName: string | null;
  /** Stable backend resource identity used to retain cleanup ownership across renames. */
  terminalResourceId: string | null;
  /**
   * The session this task is CURRENTLY EXECUTING ON, or null.
   *
   * A mutable pointer, not a biography. A session runs tasks SERIALLY over its life -
   * finish one, take the next - so this field answers "who is running this right now",
   * and it is the only question it answers. Provenance ("which agent produced this
   * work", "which pull request did it open") lives in the work-episode bindings, which
   * are per-task and durable; reading it off this field was the 1:1-for-the-session's-
   * life assumption, and it goes wrong the moment an agent takes a second task.
   *
   * Three rules follow, and each is enforced somewhere rather than merely described:
   *
   *  - **The pointer is exclusive.** At most one task row carries a given session id at
   *    a time: `upsertTask` (`db.ts`) nulls it on every other row in the same
   *    transaction. So a terminal row KEEPS its session id - it is display convenience
   *    while the card still shows that outcome - until the agent takes its next task,
   *    at which point the pointer moves and the old row is unbound. Nothing is
   *    destroyed by that: the bindings still hold what the row produced.
   *  - **At most one NON-TERMINAL task per session**, which is the serial-execution
   *    invariant. Enforced at `agentIsFree` (`foreman/backlog-machine.ts`) for the
   *    autopilot and re-checked server-side in `TaskManager.assign` for everyone else.
   *  - **A liveness-flavoured reader filters on STATUS, never on the pointer alone.**
   *    "Is this agent busy" is `running`/`dispatching` rows bound here; a `done` row
   *    still naming a session says only that the card has something to show.
   */
  sessionId: string | null;
  /**
   * The recurring mission that filed this task, or null. See `MissionSchedule`
   * (@shared/schedules.ts).
   *
   * Its own field rather than a `TaskSourceRef`, and that is the whole reason Recurring
   * Missions is not a task source: `source` is the link back to an EXTERNAL system, and
   * de-duplication for it lives in `task_source_seen`. A schedule is internal durable
   * state whose identity is `(scheduleId, scheduledFor)` and whose ledger is its own
   * occurrence table. Overloading `source.externalId` with an internal clock instant
   * would put recurring work in Settings and lose the revision, catch-up and overlap
   * lifecycle it exists for.
   *
   * All three move together: populated on a generated task, null on every other - manual
   * dispatch, an MCP call, a task-source sweep, and every task filed before the feature.
   */
  scheduleId: string | null;
  /** The occurrence that reserved this task, for the deep link into run history. */
  scheduleOccurrenceId: string | null;
  /** The instant this task was FOR, in UTC epoch ms - not when it was actually filed. */
  scheduledFor: number | null;
  status: TaskStatus;
  /** Free text set on completion (e.g. "opened PR #123"). */
  outcome: string | null;
  outcomeUrl: string | null;
  /** Failure reason when status = failed. */
  error: string | null;
  /**
   * Automatic worktree cleanup's own state for this task, or null when it has nothing to say.
   *
   * Derived from the retention ledger every time the task is loaded or refreshed, so it rides
   * the ordinary whole-task `task_upsert` and needs no event of its own and no browser
   * polling. Separate from `outcome` and `error` on purpose: what a task PRODUCED and why it
   * FAILED are the task's own record, and a maintenance note must never overwrite either.
   */
  automaticCleanup: TaskAutomaticCleanup | null;
  createdAt: number;
  updatedAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
}

// ---- backlog autopilot (Foreman scheduling the backlog) ----

/**
 * One backlog task as Foreman's planner read it: what it must wait for, and why.
 *
 * `dependsOn` is CYCLE-FREE by construction - `sanitizePlan` breaks any cycle the
 * model returns before the plan is ever stored. It has to: a cycle deadlocks the two
 * tasks in it forever, and does so silently, since a blocked item looks exactly like
 * an item that is correctly waiting its turn.
 */
export interface BacklogPlanEntry {
  taskId: string;
  /** Task ids that must reach `done` before this one may start. Often empty. */
  dependsOn: string[];
  /** One line on what this touches, or why it waits. Shown on the backlog card. */
  reason: string | null;
}

/**
 * Foreman's reading of the backlog: a scheduling order, and the dependencies behind it.
 *
 * Stored beside the tasks rather than on them (in `app_config`, like the Foreman
 * config) because it is Foreman's OPINION about the backlog, not a fact about any one
 * task - the same reason notes and episodes are not fields on `Session`. It is
 * regenerated whenever it stops covering the backlog, so it is always a statement
 * about a set of tasks that actually existed.
 */
export interface BacklogPlan {
  /** In scheduling order, most-ready first. Covers every backlog task at the time it was made. */
  entries: BacklogPlanEntry[];
  /** One line on how the planner read the backlog, for the board. */
  note: string | null;
  generatedAt: number;
}

/** Compact task view denormalized onto a Session card. */
export interface TaskSummary {
  id: string;
  title: string;
  /** Complete title for hover/focus help when `title` is the shortened generated fallback. */
  fullTitle: string;
  kind: TaskKind;
  /** Published Workflow chosen for completion, or null when the human owns completion. */
  workflowId: WorkflowId | null;
  status: TaskStatus;
  outcome: string | null;
  outcomeUrl: string | null;
  /** The provider run this task owns, separate from process-owned `Session.pipeline`. */
  pipelineRun: PipelineRunLink | null;
  /**
   * Schedule provenance, carried through to the session card. Same three fields as
   * `Task`, and null together for the same reasons.
   *
   * Here rather than only on `Task` because binding a task to a session is where a
   * denormalized view silently drops what it was not told to keep: a card would then
   * have no way to say the work it is running came from a recurring mission, and no link
   * back to the run that filed it. This nests inside `Session.task`, so it adds no
   * top-level Session field and the `byJson` comparator on `task` still covers it.
   */
  scheduleId: string | null;
  scheduleOccurrenceId: string | null;
  scheduledFor: number | null;
  /**
   * Which ensemble member this task is, or null for ordinary work.
   *
   * Here rather than on `Session` deliberately, and the phase plan calls it out: a
   * top-level session field would need its own `SESSION_FIELD_COMPARATORS` entry and would
   * be a second denormalized copy of group state, while `Session.task` is already compared
   * structurally by `byJson`. Populated by the daemon's task projection, which joins the
   * task to its member row; nothing in the browser derives it.
   */
  ensemble: TaskEnsembleLink | null;
  /**
   * One entry per repository this MULTI-repo task is attached to, primary first, with the
   * pull request each one has produced.
   *
   * **Empty for a single-repo task**, which is nearly all of them, and that emptiness is a
   * contract rather than an optimisation: every surface renders this list only when it is
   * non-empty, so a single-repo card's markup is byte-identical to what it was before this
   * field existed.
   *
   * Here rather than reaching for `Task.extraRepos` from a card because a card is handed a
   * `TaskSummary`, not a `Task` - and because `extraRepos` deliberately excludes the
   * primary, which is exactly the repository whose pull request an operator most expects to
   * see. This list includes it.
   */
  repoPrs: TaskRepoPrSummary[];
}

/** One repository of a multi-repo task, and the pull request it has produced so far. */
export interface TaskRepoPrSummary {
  /** Absolute repo root, as the task recorded it. */
  repoRoot: string;
  /** True for the task's own repo - the one the session's cwd is a worktree of. */
  primary: boolean;
  /** The pull request adopted for this repository on this task, or null if none yet. */
  prUrl: string | null;
  /** `open` or `merged` as of the last observation, or null while unknown. */
  prState: string | null;
  /** When that pull request was observed merged, or null. */
  mergedAt: number | null;
  /**
   * The live feedback on this repository's pull request, or null when the last poll did not
   * see one OPEN here.
   *
   * The three fields beside it are DURABLE - the association this task made with a pull
   * request, which is never retracted once made, because that is what a card and the
   * completion quorum need. This one is the opposite and deliberately so: it is the same
   * observation `Session.prChecks`/`Session.inspector` carry for the session's own checkout,
   * made per repository, and it is retracted the moment a poll stops seeing an open pull
   * request there. Foreman's review follow-through reads it, and a nudge about a pull request
   * that has since been closed is exactly the mistake the retraction prevents.
   */
  feedback: RepoPrFeedback | null;
}

/**
 * What Foreman's review follow-through reads about ONE pull request of a multi-repo task.
 *
 * The per-repository twin of the `Session` scalars a single-repo session is followed up
 * through (`prNumber`, `prChecks`, `inspector`), carrying the same facts under the same
 * meanings so one decision core can read either. Its presence means the poll saw this
 * repository's pull request open; see `TaskRepoPrSummary.feedback`.
 */
export interface RepoPrFeedback {
  /** The pull request's number, for `gh` commands scoped to its own repository. */
  prNumber: number;
  /** That pull request's CI rollup as of the last poll, or null when it reported none. */
  prChecks: PrChecks | null;
  /** The Inspector's state for it, or null when the Inspector never adopted it. */
  inspector: InspectorSummary | null;
}

export type ReviewKind = "plan" | "diff" | "input" | "plan-decisions";
/**
 * Persisted as text in `reviews.status`, so these spellings are append-only.
 *
 * `orphaned` is the only one the DAEMON writes; the other four terminal statuses are a
 * human's answer arriving through `/api/reviews/:id/resolve`. It means the session that
 * asked went away before anyone answered, which is why it is not `dismissed` - the
 * operator declining to choose and the agent no longer being there to hear a choice are
 * different facts, and only the first is evidence of intent (see
 * `loadResolvedWorkflowReviews`, which reads none of it).
 */
export type ReviewStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "answered"
  | "dismissed"
  | "orphaned";

/**
 * Who settled a review. Persisted as text in `reviews.resolved_by`, so these spellings
 * are append-only.
 *
 * The daemon's own `orphaned` settle records NEITHER: nobody decided anything, the agent
 * simply stopped being there to hear an answer. A row from before this column existed
 * reads as null for the same reason - it may well have been a human, but the record does
 * not say so, and the conversation must not claim an answer the human cannot be shown to
 * have given.
 */
export type ReviewActor = "human" | "foreman";

/** One selectable choice within a `PlanDecision`. */
export interface PlanDecisionOption {
  /** Stable id, echoed back in the human's selection. */
  id: string;
  /** What the human reads on the control. */
  label: string;
  /** Optional one-line elaboration shown under the label. */
  detail?: string;
  /** Renders a "recommended" hint; does not preselect. */
  recommended?: boolean;
}

/**
 * One question the human answers when resolving a `plan-decisions` review - or the single
 * question an `input` review carries when the agent asked with discrete options rather than
 * open prose (see `server/ask-channel.ts`).
 */
export interface PlanDecision {
  /** Stable id for this question. */
  id: string;
  question: string;
  options: PlanDecisionOption[];
  /** Checkboxes (many) when true, radios (one) when false/absent. */
  multiSelect?: boolean;
  /** Adds a free-text "Other" field the human can fill instead of / alongside options. */
  allowOther?: boolean;
}

/**
 * What the human picked for one `PlanDecision`.
 *
 * The structured half of an answer, kept because `response` is not one: that string is
 * FLATTENED for the agent to read ("→ OAuth via Clerk"), so it records the labels chosen
 * and nothing about the ones passed over. Replaying the question in the conversation needs
 * both - which option was taken and what it was taken from - and re-deriving the first by
 * matching labels back out of the prose would break the moment two options shared a prefix
 * or a label contained the separator.
 *
 * Option ids rather than labels, so a decision replays correctly even though the label is
 * what the agent's response string quotes.
 */
export interface PlanDecisionAnswer {
  /** The `PlanDecision.id` this answers. */
  decisionId: string;
  /** Chosen `PlanDecisionOption.id`s - one for a radio, any number for a multi-select. */
  selected: string[];
  /** What was typed into "Other", when the decision allowed it and the human used it. */
  other: string | null;
}

export interface ReviewItem {
  id: string;
  sessionId: string;
  kind: ReviewKind;
  title: string;
  /** Markdown for `plan`/`plan-decisions`, a unified diff for `diff`, a question for `input`. */
  body: string;
  status: ReviewStatus;
  /**
   * Human's textual response (for `input`), their formatted selections (for
   * `plan-decisions`), or an optional comment on approve/reject.
   */
  response: string | null;
  /**
   * The decision points to answer: many for `plan-decisions`, exactly one for an `input`
   * whose agent supplied discrete options, absent for a free-text `input`.
   */
  decisions?: PlanDecision[] | null;
  /**
   * The human's selections against `decisions`, kept alongside the flattened `response`
   * so the conversation can replay the form as it was answered. Null for every other way
   * a review settles: free-text `input`, approve/reject, dismiss, orphan.
   */
  selections?: PlanDecisionAnswer[] | null;
  /** Who settled it, or null when nobody did (`orphaned`) and on pre-column rows. */
  resolvedBy?: ReviewActor | null;
  createdAt: number; // epoch ms
  resolvedAt: number | null;
}

// ---- roundup report (/bearings) ----

/** One line in a roundup report - a live session (with its intent) or a task. */
export interface ReportItem {
  sessionId: string | null;
  name: string;
  kind: TaskKind | null;
  branch: string | null;
  activity: string | null;
  /** Why this session needs you (needsYou items only); "" otherwise. */
  reason: string;
  taskTitle: string | null;
  outcome: string | null;
  outcomeUrl: string | null;
}

/** A point-in-time snapshot of every session, for the report panel + markdown digest. */
export interface MissionReport {
  generatedAt: number;
  counts: {
    sessions: number;
    working: number;
    idle: number;
    needsYou: number;
    exited: number;
    backlog: number;
  };
  needsYou: ReportItem[];
  working: ReportItem[];
  idle: ReportItem[];
  backlog: Task[];
  recent: Task[];
  /** True when `recent` was capped, so the digest can say so instead of lying by omission. */
  recentTruncated: boolean;
}

// ---- Inspector (automated PR review) ----
//
// The Inspector reviews pull requests MISSION CONTROL OPENED, and only those. Every
// type here hangs off that sentence: `InspectorPr` is the adoption ledger that answers
// "is this one ours?", and `InspectorComment` is the provenance ledger that answers
// "did we write this?". Both questions have to survive a daemon restart, which is why
// this is durable state and not a poller's in-memory map.

/** How far the Inspector may go. `dry-run` computes everything and posts nothing. */
export type InspectorMode = "dry-run" | "live";

/** How a PR came to be adopted. Older persisted provenance is normalized to `legacy`. */
export type InspectorSource = "hook" | "legacy" | "pipeline";

/** Whether the PR is still worth polling. Merged and closed-unmerged are both "closed". */
export type InspectorPrState = "open" | "closed";

/**
 * What a failed attempt says about whether the NEXT PUSH is worth trying immediately.
 *
 * `push-fixable` is a failure that is a property of the head itself, so pushing is the
 * remedy and the only one - a diff too large to hold in memory is declined until the
 * author shrinks it. `persistent` is everything else: `gh` refused us, the model could
 * not answer in time for a diff nobody has meaningfully changed. Pushing buys nothing
 * there, so those are the failures the push-escape is capped on.
 */
export type InspectorFailKind = "push-fixable" | "persistent";

export type InspectorSeverity = "blocker" | "major" | "minor" | "nit";

/**
 * `drafted` is a dry-run finding: computed, deduped, never posted. It occupies the
 * fingerprint slot so the preview is stable across ticks, and switching to live must
 * treat it as NOT YET POSTED - otherwise dry-run permanently swallows everything it
 * previewed.
 *
 * `posting` is the crash window made visible. The review is written to this ledger
 * BEFORE the POST that publishes it, because the other order loses: a POST that reaches
 * GitHub and whose response times out leaves no row, so the next tick re-reviews the
 * same push, finds nothing recorded, and posts every comment a second time under the
 * operator's name. A `posting` row is read as "already raised" for dedup, so the
 * duplicate cannot happen; the next round reconciles it against the live threads.
 */
export type InspectorCommentStatus = "drafted" | "posting" | "open" | "resolved";

/** One adopted pull request. The row's existence IS the permission to comment on it. */
export interface InspectorPr {
  /** "owner/repo#123" - stable across clones, worktrees and session churn. */
  key: string;
  url: string;
  owner: string;
  repo: string;
  number: number;
  /** The repo this PR belongs to, for INSPECTOR.md + standards + the allowlist check. */
  repoRoot: string | null;
  /** A checkout to run `gh` from. May go stale when the session's worktree is reaped. */
  cwd: string | null;
  /** The session that opened it. Nullable: a PR outlives the session, deliberately. */
  sessionId: string | null;
  source: InspectorSource;
  state: InspectorPrState;
  /**
   * The head commit as of the last completed review. The re-review trigger is simply
   * `headRefOid !== headSha`, which is why it is stored rather than timestamped: a
   * force-push backwards still differs, and a no-op tick still costs nothing.
   */
  headSha: string | null;
  /** The consent posture that produced `headSha`; null for rows from older builds. */
  reviewPosture: InspectorPosture | null;
  /** Completed review rounds. Also the runaway guard. */
  round: number;
  lastReviewedAt: number | null;
  /** Why the last attempt failed, or null. Surfaced, never silently retried forever. */
  lastError: string | null;
  /**
   * Consecutive failed attempts. Reset by any attempt that completes.
   *
   * `round` counts SUCCESSES, so it can never stop a PR that fails permanently - a
   * reaped worktree, revoked `gh` access, a diff the model cannot answer for inside the
   * timeout. Each such tick costs up to two full `claude -p` runs, so failures have to
   * be counted separately from progress in order to be backed off.
   */
  failCount: number;
  /**
   * What the wait currently in force was earned by, or null when nothing has failed.
   *
   * The wait was set by the LAST failure, so the last failure is what decides whether a
   * push is entitled to end it early. Reset alongside `failCount` by a completed round.
   */
  lastFailKind: InspectorFailKind | null;
  /** Epoch ms before which this PR is not retried. Null when it is due now. */
  nextAttemptAt: number | null;
  /**
   * The head we last STARTED work on, whether or not that work finished.
   *
   * Distinct from `headSha`, which records the last head we successfully reviewed, and
   * the distinction is what makes the backoff both effective and escapable. Keyed on
   * `headSha` the backoff would never apply at all to a PR whose review has never
   * succeeded - the common case, since a failed round does not advance it - and keyed on
   * nothing it would outlast the push that earned it, so a diff force-pushed down to
   * three lines would sit out the full wait a huge one bought.
   */
  lastAttemptSha: string | null;
  /**
   * When YOLO mode merged this PR itself, epoch ms, or null.
   *
   * Distinct from the row simply going `closed`, which is also what a human merging it
   * looks like. Only this field says the fleet landed it unattended, and that is the one
   * fact somebody reading the ledger afterwards actually wants.
   */
  mergedAt: number | null;
  /**
   * Why it has not merged itself, as of the last sweep. A `MergeBlock` code
   * (`@shared/shipping.ts`), or the message `gh` gave when it refused the merge outright.
   *
   * Stored rather than derived because the panel polls a route and the decision is made
   * in the tick, 90 seconds apart - and because the failure mode of an auto-merger is
   * merging nothing while saying nothing.
   */
  mergeBlock: string | null;
  /**
   * The pull request's remote head as of the last POLL, not the last review.
   *
   * `headSha` above advances only when a review round completes, which makes it useless for
   * the question "has the branch reached the pull request yet". That question is what a
   * `pull_request` session action has to answer before it lets downstream stages read fresh
   * evidence, so the tick writes down what `fetchPr` already told it.
   *
   * Null means this build has not looked since the column existed. Every reader treats that
   * as "unknown", never as "unchanged" - a session action waits for the next tick rather than
   * completing on a head nobody observed.
   */
  observedHeadSha: string | null;
  /** What that same poll saw the pull request's state to be, or null when never polled. */
  observedState: "OPEN" | "CLOSED" | "MERGED" | null;
  /** When that observation was made, epoch ms, or null when never polled. */
  observedAt: number | null;
  /**
   * The branch the pull request is opened FROM, as GitHub reports it.
   *
   * Stored because a session action proves its pull request by repository AND branch: a commit
   * id match alone cannot tell a pull request opened from this work apart from one that
   * happens to include the same commit. Null until the first poll after adoption.
   */
  headRefName: string | null;
  /**
   * The pull request's title, as GitHub reported it on the last poll.
   *
   * Written by the POLL, never by adoption. The adoption signal is a hook catching
   * `gh pr create` and carries nothing but the URL, and that ingest path is deliberately
   * free of anything slow or fallible - so the title arrives with the first observation
   * instead, from a snapshot the tick already pays for.
   *
   * Null means "not polled since this column existed", the same reading the `observed_*`
   * fields carry, and it is a state a row can stay in for ever: the tick retires closed
   * and merged rows, so one adopted by an older build and landed before its first poll
   * has no later chance to be titled. Every renderer therefore falls back to
   * `headRefName` rather than treating null as an empty title.
   */
  title: string | null;
  adoptedAt: number;
  updatedAt: number;
}

/**
 * One issue the Inspector raised on one PR.
 *
 * Keyed by `fingerprint`, which is the identity of the ISSUE (path + normalized title)
 * rather than of the comment - so a push that shifts the code down does not produce a
 * second copy of the same complaint. `UNIQUE(pr_key, fingerprint)` makes that a
 * property of the database instead of a code path someone can forget.
 */
export interface InspectorComment {
  id: string;
  prKey: string;
  fingerprint: string;
  path: string | null;
  line: number | null;
  title: string;
  /** Already-scrubbed finding detail. Null only for rows created before body persistence. */
  body: string | null;
  severity: InspectorSeverity;
  round: number;
  status: InspectorCommentStatus;
  /** Follow-up replies we have written in this thread. Capped, so bots can't ping-pong. */
  replies: number;
  /** The newest foreign comment we have answered, so we never answer one twice. */
  answeredCommentId: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The compact per-session view, denormalized onto a Session card like `TaskSummary`.
 * Deliberately counts rather than findings: the card says whether to go look, and the
 * PR itself is where you look.
 */
export interface InspectorSummary {
  prKey: string;
  url: string;
  mode: InspectorMode;
  /** Findings currently tracked as unresolved, including drafted and posting rows. */
  open: number;
  /** Findings currently posted on the pull request. */
  postedOpen: number;
  /** Completed review rounds. Zero means adopted but not yet looked at. */
  round: number;
  lastReviewedAt: number | null;
  /** True when the last attempt errored, so the chip can say so instead of "clean". */
  failed: boolean;
}

/**
 * Why a finished session is worth a retrospective.
 *
 * Two reasons, and they are the two the source plan named: the human STEERED the agent, or
 * the Inspector raised findings that were then resolved. Both describe
 * something that was LEARNED - a correction the next session should not need, a defect the
 * repository could have warned about - which is exactly what a repository memory is for. A
 * clean run nobody had to steer teaches nothing, and gets no offer.
 *
 * `corrections` is the wire spelling of the first, and it is broader than its name: steering
 * arrives either as a human turn in the transcript beyond the opening brief or as a review
 * the human settled - an answered question, an approved plan, a set of decisions - which no
 * transcript carries, because those land in the JSONL as pure tool results. One reason for
 * both, because they are one fact about the session and the offer asks one question of it.
 *
 * The values are display vocabulary rather than persisted vocabulary: nothing writes them to
 * SQLite, so they may be renamed. They still reach the browser, so a build that does not
 * recognise one must degrade to "worthy, reason unknown" rather than to "not worthy" - which
 * is why the offer keys on the LIST being non-empty and never on a particular member.
 */
export const RETRO_REASONS = ["corrections", "findings"] as const;
export type RetroReason = (typeof RETRO_REASONS)[number];

/**
 * The per-session retro-worthiness signal, denormalized onto a Session like `inspector`.
 *
 * A list rather than one reason because both can hold at once and they say different things
 * to the person deciding whether to spend a turn on it: "you steered this agent four times"
 * and "the review found things" are separate arguments for the same ceremony. The summary is
 * only ever present when `reasons` is non-empty; absence IS "not worth retrospecting".
 */
export interface RetroSummary {
  reasons: RetroReason[];
}

/** A ledger row plus its finding tallies - what the settings panel lists. */
export interface InspectorInspection extends InspectorPr {
  openFindings: number;
  postedOpenFindings: number;
  resolvedFindings: number;
}

/** Server-internal wakeup after Inspector observes or updates one adopted PR. */
export interface InspectionUpdated {
  prKey: string;
  observedHeadSha: string | null;
  observedState: "OPEN" | "CLOSED" | "MERGED" | null;
  observedAt: number;
  ledger: InspectorInspection;
}

/**
 * What the Inspector is set up to do, as opposed to what it has been asked to do.
 *
 * Separate from `InspectorConfig` because that is the STORED record and this is the
 * resolved one: the model field here folds in an env var the browser cannot see. Same
 * split, and the same reason, as `ForemanConfig` against `ForemanStatus.models`.
 */
export interface InspectorStatus {
  model: ResolvedModel;
}

export interface LlmProviderView {
  id: LlmRunnerId;
  label: string;
}

/**
 * What the app's offline work will actually spawn as - the runner and every background
 * job's model, each with the layer that chose it.
 *
 * Resolved by the DAEMON and sent whole, for the reason `ForemanStatus.models` and
 * `InspectorStatus` are: both the runner and the model ids sit behind an env layer the
 * browser cannot see, so a panel deriving `config || default` would confidently print a
 * value a `MISSION_GOAL_MODEL` in the daemon's environment is overriding.
 *
 * `runners` travels with it because the picker cannot be built from `LLM_RUNNER_IDS`
 * alone: a runner's human-facing label lives on the implementation, which is server-side.
 */
export interface LlmStatus {
  runner: ResolvedLlmRunner;
  /** The resolved wire transport for tool-less Claude calls in every process. */
  claudeTransport: ClaudeTransport;
  /** The same, for Codex. `exec` spawns the CLI; `sdk` drives it through the typed SDK. */
  codexTransport: CodexTransport;
  models: Record<LlmJobId, ResolvedLlmJobModel>;
  /** Every provider this build has, in declaration order. */
  runners: LlmProviderView[];
}

/**
 * The small status tuple the Settings rail dots and the topbar gear read, carried on the
 * live channel so the dots are right whenever the app is open - not only while the panel
 * that computes each fact happens to be polling.
 *
 * Deliberately tiny and denormalized: it holds the few facts the dots need and nothing a
 * panel already fetches. Foreman is NOT here on purpose - App owns `ForemanState`, so the
 * Foreman dot derives from that rather than being shipped twice and left to disagree.
 *
 * APPEND fields rather than reshaping this. An older dashboard still in flight holds the
 * last value it read, so a rename orphans it while an addition is free.
 */
export interface SettingsStatus {
  /** The Inspector's two switches the dots care about; its allowlist is not a dot fact. */
  inspector: { enabled: boolean; mode: "dry-run" | "live" };
  /** YOLO mode's master switch. Armed is an amber dot; the soak/method are not dot facts. */
  shipping: { autoMerge: boolean };
  /** How many configured task sources failed their last sweep. Nonzero is a red dot. */
  taskSources: { failing: number };
  /**
   * Whether an external SDLC engine is installed or configured, retained as an append-only
   * compatibility fact for dashboards that predate the permanent Conductor destination.
   * `observing` remains the independent exact-repository gate for Runs and Dispatch.
   */
  pipelines: {
    present: boolean;
    /**
     * How many repositories are being READ right now - master switch on, repository
     * switched on.
     *
     * A different question from `present`, and it decides a different surface: this is what
     * draws the Runs page's Pipelines tab. Zero means the page is byte-for-byte the one
     * that shipped before this feature - no tab strip, no rail, and nothing fetching
     * anything - which is the state almost every fleet stays in.
     *
     * A count rather than a boolean because the tab's empty state names how many
     * repositories are being watched, and a surface deriving that a second way is how it
     * comes to disagree with Settings.
     */
    observing: number;
    /**
     * Exact active provider/repository keys, appended for consumers that must invalidate a
     * cached exact-root decision even when `observing` stays numerically unchanged.
     * Optional so an older daemon's SettingsStatus remains readable during a rolling update.
     */
    observedRepoKeys?: string[];
    /** Engineer host choice, appended so an open Dispatch dialog can invalidate its copy. */
    launchRuntime?: PipelineLaunchRuntime;
  };
}

// ---- Keep Awake (transient idle-sleep inhibition) ----

/**
 * The daemon's observed Keep Awake state - never a saved preference. There is nothing
 * durable behind this on purpose: the mode applies only to the current daemon run, so a
 * quit, crash, or restart returns the next snapshot to `off` and nothing reacquires the
 * assertion. The one writer is the daemon's `KeepAwakeManager`; the browser's one source
 * is the snapshot plus `keep_awake_status` below.
 *
 * `state` reports what was OBSERVED of the OS assertion, not what was requested: `on` is
 * reachable only after the provider confirms the assertion, and a provider failure lands
 * on `error` rather than being hidden. That is what lets the live indicator promise it
 * never claims `awake` before the assertion exists or after it is gone.
 */
export interface KeepAwakeStatus {
  /** Whether this host has an idle-sleep inhibitor to offer. */
  supported: boolean;
  /** Why the mode is unavailable, bounded for the wire; null when `supported`. */
  unavailableReason: string | null;
  /** Observed lifecycle of the OS assertion. Exhaustive - reducers must switch it. */
  state: "off" | "starting" | "on" | "stopping" | "error";
  /** Which inhibitor implementation this daemon would run; null when unsupported. */
  provider: "caffeinate" | "iokit" | null;
  /** Epoch ms at which the active assertion was confirmed; else null. */
  since: number | null;
  /** Bounded runtime failure from the last transition or an unexpected exit; else null. */
  error: string | null;
}

// ---- SSE events (daemon -> UI) ----

export type ServerEvent =
  | {
      type: "snapshot";
      sessions: Session[];
      reviews: ReviewItem[];
      tasks: Task[];
      personas: PersonaView[];
      /**
       * The bounded SessionAction catalog, archived rows included so a draft or version can
       * always name its source. Carries the full record - prompt Markdown and all - the way
       * `personas` carries guidance; see `Registry.sessionActions` for why that is bounded.
       */
      sessionActions: SessionAction[];
      /**
       * The Global Command catalog: exactly one entry per built-in workflow slot, in
       * `WORKFLOW_CHECK_SLOTS` order, whether or not it has been configured. Bounded by the
       * append-only slot list rather than by operator data, so it rides the snapshot whole.
       */
      workflowCommands: WorkflowCommandView[];
      workflowSummaries: WorkflowSummary[];
      workflowRunSummaries: WorkflowRunSummary[];
      workflowBindingSummaries: WorkflowBindingSummary[];
      /**
       * Compact ensemble projections only. Members, artifacts, evaluations, stage output and
       * patches stay on HTTP: this collection must stay bounded when a later strategy runs
       * a large roster or generates pairwise evaluations.
       */
      ensembleSummaries: EnsembleSummary[];
      /**
       * Live Recurring Missions catalog: non-archived schedules only. Archived ones leave
       * the collection via `schedule_remove` and are reachable afterwards only through the
       * page-oriented occurrence-history route, which is why history is not in the snapshot.
       */
      schedules: MissionSchedule[];
      /**
       * Every pipeline run the daemon is projecting, for the repositories an operator has
       * consented to. EMPTY on every fleet with no pipeline provider enabled, which is the
       * shipped state - so this collection costs an ordinary installation one `[]`.
       *
       * Bounded by consent rather than by history: a repository holds one run per feature
       * currently in its provider's worktrees, and a run that leaves those worktrees leaves
       * the collection through `pipeline_remove`. Nothing accumulates here.
       */
      pipelineRuns: PipelineRun[];
      /**
       * Every line-comment thread the daemon holds for a session it still knows about.
       *
       * BOUNDED BY LIVE SESSIONS, not by history. A thread belongs to exactly one session
       * and ends with it: `session_remove` settles it to `orphaned` and it leaves this
       * collection through `file_comment_thread_remove`, and a throttled prune finally
       * deletes settled rows whose session key is gone. Nothing accumulates here.
       *
       * The arithmetic: a review is normally tens of comments on one file, a busy fleet
       * holds tens of sessions, and most sessions have none at all - so the realistic
       * ceiling is a few hundred threads. That is the TYPICAL case; the hard one is
       * `FILE_COMMENT_THREADS_PER_SESSION_MAX`, refused at the create route, because
       * "bounded by live sessions" alone caps how LONG a thread lives and not how many one
       * session can accumulate while it is alive - and the prune only reaches settled
       * threads whose session key is already gone. Per-thread size is what a later phase can move,
       * and it is dominated by the anchored quote (`FILE_COMMENT_QUOTE_MAX`, 4kB) plus a
       * capped reply list (`FILE_COMMENT_THREAD_MESSAGE_CAP`); `test/file-comments-sse.ts`
       * measures one realistic thread and states the ceiling it implies. When a surface
       * needs more than the budget allows, fetch that ONE thread from its own route -
       * never widen the collection.
       *
       * EMPTY on every fleet where nobody has written a comment, which is the shipped
       * state, so an ordinary installation carries one `[]`.
       */
      fileCommentThreads: FileCommentThread[];
      /**
       * Fleet cost estimate at connect time. Carried in the snapshot rather than waited for,
       * or the topbar strip would sit blank until the next export happened to change
       * something - up to a whole export interval of a dashboard that looks broken.
       */
      fleetCost: FleetCost | null;
      /**
       * The Line's six stage folds at connect time, for the same reason the two values
       * around it are here: the strip is permanent chrome on the fleet page, so a dashboard
       * that had to wait for the next change would open on six blank stages.
       *
       * Never null - unlike `fleetCost`, whose null means "the ledger has nothing to say".
       * A quiet fleet is a real answer here ("nothing waiting", "no sessions open"), and a
       * null would make the strip choose between drawing nothing and drawing zeros it was
       * never told.
       */
      lineSummary: LineSummary;
      /**
       * The settings status tuple at connect time, so the rail dots and gear are right
       * from the first render rather than blank until the next config write happens to
       * change something. Composed fresh on every snapshot (see `Registry.snapshot`).
       */
      settingsStatus: SettingsStatus;
      /**
       * The transient Keep Awake state at connect time, so a reconnect converges on the
       * daemon's truth immediately - which is what makes restart-resets visible: a daemon
       * that just started always reports `off` here, and the browser must adopt that over
       * any stale `on` it was drawing before the drop.
       */
      keepAwake: KeepAwakeStatus;
    }
  | { type: "session_upsert"; session: Session }
  | { type: "session_remove"; id: string }
  | { type: "review_upsert"; review: ReviewItem }
  | { type: "review_remove"; id: string }
  | { type: "task_upsert"; task: Task }
  | { type: "task_remove"; id: string }
  | { type: "persona_upsert"; persona: PersonaView }
  | { type: "persona_remove"; id: PersonaId }
  /** Archive emits UPSERT, not remove: the entity stays addressable by every draft naming it. */
  | { type: "session_action_upsert"; action: SessionAction }
  | { type: "session_action_remove"; id: SessionActionId }
  /**
   * A Command slot changed. No remove twin: a built-in slot is emptied, never deleted, and
   * an emptied slot is still a card the operator has to be able to see.
   */
  | { type: "workflow_command_upsert"; command: WorkflowCommandView }
  | { type: "workflow_upsert"; workflow: WorkflowSummary }
  | { type: "workflow_remove"; id: WorkflowId }
  | { type: "workflow_run_upsert"; run: WorkflowRunSummary }
  | { type: "workflow_run_remove"; id: WorkflowRunId }
  | { type: "workflow_binding_upsert"; binding: WorkflowBindingSummary }
  | { type: "workflow_binding_remove"; id: WorkflowBindingId }
  | { type: "ensemble_upsert"; ensemble: EnsembleSummary }
  | { type: "ensemble_remove"; id: string }
  /**
   * A schedule was created, edited, enabled/paused, or had a live occurrence settle -
   * anything the catalog must reflect. Carries the whole `MissionSchedule`, so a browser
   * never fetches to reconcile. `schedule_remove` fires on archive, AFTER the durable write.
   */
  | { type: "schedule_upsert"; schedule: MissionSchedule }
  | { type: "schedule_remove"; id: string }
  /**
   * A pipeline run's projection moved - a step changed state, a gate answered, the engine
   * halted, or the run appeared for the first time. Carries the WHOLE run, like
   * `schedule_upsert` and unlike the two content-free invalidation frames: the projection
   * is small, bounded, and read as one picture of one feature, so a patch would let a
   * browser draw a strip in which four steps came from one instant and two from another.
   *
   * Emitted only when a field a human can see actually changed. The watch loop re-reads
   * the provider's files on a cadence and would otherwise emit a frame per repository per
   * tick for a fleet where nothing is happening.
   */
  | { type: "pipeline_upsert"; run: PipelineRun }
  /**
   * A run left the projection: its worktree is gone, or its repository's consent was
   * withdrawn. Keyed rather than carrying the run, because there is nothing left to carry.
   */
  | {
      type: "pipeline_remove";
      provider: PipelineProviderId;
      repoRoot: string;
      slug: string;
    }
  /**
   * A line-comment thread was created, edited, re-anchored, requeued, replied to, or
   * resolved. Carries the WHOLE thread, messages included, like `schedule_upsert`: a
   * thread is read as one picture of one conversation on one line, and a patch would let a
   * gutter draw a marker whose state came from one instant and whose replies came from
   * another. It is also what makes a reply reach every open dashboard without a fetch.
   */
  | { type: "file_comment_thread_upsert"; thread: FileCommentThread }
  /**
   * A thread left the live collection: it was deleted, or its session went away and the
   * row was settled to `orphaned`. Keyed rather than carrying the thread, because there is
   * nothing left to draw.
   *
   * NOT a durable delete signal for the orphan case - the row survives by UPDATE, which is
   * this repository's standing rule for session-scoped cleanup. This frame says only that
   * the browser should stop holding it.
   */
  | { type: "file_comment_thread_remove"; id: string }
  /**
   * Fleet-wide API-equivalent estimate and subscription rate limits. A top-level collection,
   * not a per-session field: the rate limits are account-global, so hanging them off each
   * session would ship the same numbers N times and invite N places to disagree.
   */
  | { type: "cost_fleet"; fleet: FleetCost }
  /**
   * The Line's six stage folds, recomputed on the daemon and emitted only when a figure or
   * a sentence a human can read actually moved.
   *
   * One payload rather than six, and a whole payload rather than a patch: the strip is read
   * as a single sentence about the fleet, so a half-applied update would draw a pipeline
   * that never existed - four stages from one instant and two from another.
   */
  | { type: "line_summary"; line: LineSummary }
  /**
   * The settings status tuple, emitted whenever a config write or a task-source sweep
   * changed it. Reduced into `MissionState.settingsStatus`, which is the ONE client-side
   * source of these facts: the rail dots and the topbar gear read it, never a re-poll.
   */
  | { type: "settings_status"; status: SettingsStatus }
  /**
   * The per-harness dispatch defaults (model, effort, runtime) were rewritten. An
   * invalidation signal: whoever cares re-reads `GET /api/harnesses/config`.
   *
   * CONTENT-FREE ON PURPOSE, unlike `settings_status` above. The config's type and its
   * validation both live on `HarnessesConfigSchema` in `protocol.ts`, and `protocol.ts`
   * imports THIS module - so carrying the config here would either invert that dependency
   * or require restating the shape, which would be a second source of truth for a schema
   * that already has one. The route stays the only thing that can describe this config.
   *
   * Why it exists at all: the daemon re-reads the config on every dispatch, so a launch was
   * always correct, but nothing told the BROWSER. The settings panel found out on its next
   * poll and an already-open dispatch modal never did, so both could name a model that had
   * been retired - which reads as a saved change being ignored.
   */
  | { type: "harnesses_config_changed" }
  /**
   * Native policy, bounded native inventory, or legacy drain classification changed.
   * Content-free because the inventory is an expensive bounded HTTP observation and never
   * belongs in the reconnect snapshot.
   */
  | { type: "worktrees_changed" }
  /**
   * The Keep Awake observation moved - a transition was requested, the OS assertion was
   * acquired or released, or a transition failed. Carries the whole status so every open dashboard
   * converges without a fetch; emitted only when an observable field changed (see
   * `Registry.setKeepAwakeStatus`).
   */
  | { type: "keep_awake_status"; status: KeepAwakeStatus }
  /**
   * The local archive library changed - a reconciliation batch indexed, refused, or pruned
   * at least one bundle. An invalidation signal: a surface showing archive history re-runs
   * its own bounded query against `GET /api/archives`.
   *
   * CONTENT-FREE, and for a stronger reason than `harnesses_config_changed` above. Archives
   * are HISTORY: a library holds every archive an operator ever kept, and it is explicitly
   * not evicted by age or count. Putting rows on this frame - or in the reconnect
   * snapshot - would mean every dashboard paying for the whole archive on every connect, to
   * populate a page that is bounded, filtered, and paginated anyway. So history stays out of
   * the stream entirely and only the fact that it moved crosses it.
   *
   * ONE frame per batch, never one per file: a sync tool delivering forty bundles raises a
   * single revision bump, because forty is not more informative than one to something whose
   * only response is to re-read its current page.
   */
  | { type: "archive_changed" };

// ---- session transcript (session detail) ----

/** One tool call in a turn: what was invoked, and what it was invoked with. */
export interface ToolCall {
  /** Tool name, e.g. "Bash" - rendered as a compact chip on the card. */
  name: string;
  /**
   * The call's arguments, JSON-serialized and capped (see TOOL_INPUT_CAP). Undefined
   * when the record carried no input, or an empty one.
   *
   * This is the only place the CONCRETE action a turn takes is written down: the name
   * says "Bash", the input says `rm -rf /`. Foreman's whole judgment surface rests on
   * it - on the terminal surface the pending question is the generic, 120-char-capped
   * "Claude needs your permission" (see the Notification branch of the Claude hook
   * spec's `toState`), so an `AskUserQuestion`'s options and a `Bash`'s command reach the
   * reviewer through here or not at all.
   */
  input?: string;
}

/** One normalized turn from a Claude/Codex transcript, for the session detail. */
export interface TranscriptMessage {
  /** Stable id (the record uuid) - used to de-dupe across init/append. */
  id: string;
  role: "user" | "assistant";
  /** Prose the human/agent wrote. May be empty on a pure tool-call turn. */
  text: string;
  /** Tools invoked in this turn. The card chips name + target (web/lib/tools.ts); Foreman reads the inputs. */
  tools: ToolCall[];
  /** epoch ms of the turn, 0 when the record had no timestamp. */
  ts: number;
  /**
   * Who typed a user turn, when it wasn't the human. Absent on assistant turns, and on
   * anything we can't attribute - which reads as the human, the way it always has.
   */
  origin?: TurnOrigin;
  /**
   * How the DASHBOARD should present this turn, when that differs from how the transcript
   * records it. Absent on every turn the log renders literally, which is nearly all of
   * them, and absent on the wire for any client or fixture that never asked.
   *
   * Additive and advisory: `text`, `tools`, `ts`, `role` and `id` are the native record
   * either way, so a server-side evidence consumer that ignores this field reads exactly
   * what it read before the field existed. Only `src/web/lib/launch-presentation.ts` acts
   * on it.
   */
  presentation?: TranscriptPresentation;
}

/**
 * A dashboard-only presentation instruction attached to one normalized turn.
 *
 * A discriminated `kind` rather than a `hidden: true` boolean, because the question a
 * reader of this field has to answer is "WHY does this turn present differently", and a
 * boolean answers only "should I draw it". A second presentation kind extends the union;
 * it must not repurpose `launch`.
 *
 * `launch` is the composed prompt Mission Control used to START a managed conversation:
 * the operator's request plus the repository manifest, the shared execution authorization,
 * and the task kind's contract. All of it reached the agent and all of it is in the native
 * transcript. `displayText` is the operator's own request, captured at dispatch, and is
 * what the conversation window draws in place of the whole payload. `null` means this
 * launch had no distinct human-authored request, and the turn is omitted from the visible
 * log rather than drawn as platform instructions or invented prose.
 */
export type TranscriptPresentation = {
  kind: "launch";
  displayText: string | null;
};

/**
 * The non-human authors of a "user" turn.
 *
 * A session Foreman is driving is mostly Foreman talking, workflow repair is delivered
 * under its own identity, and the dashboard types `/reload-skills` into idle sessions.
 * The transcript file records all of them exactly as it records a person's typing, so without this the log credits the human
 * with instructions they never wrote - and hides the machinery doing its job.
 */
export type TurnOrigin = "foreman" | "harness" | "workflow";

/**
 * Messages on the per-session transcript SSE stream
 * (`GET /api/sessions/:id/transcript/stream`). `init` carries the recent history on
 * connect, `resume` continues one the reader already has, and `append` streams new turns
 * as the agent writes them.
 *
 * `init` carries the BYTE RANGE it was read from, and both ends earn their place. `start`
 * is what `GET /api/sessions/:id/transcript?before=` pages back from, so older history is
 * reachable instead of merely absent; `atStart` is how the panel knows to stop offering.
 * Without them the panel could not tell a session that said eighty things from one that
 * said eight hundred, and silently drew the second as the first.
 *
 * Every message-bearing variant carries `pos`, the offset the reader has now consumed to.
 * That is what a reconnect hands back as `?from=`, and it is the whole reason `resume`
 * exists: an `init` re-states a window anchored at the CURRENT end of the file, so any
 * turn written meanwhile slides that anchor forward and strands the scrollback above it.
 * A session that is actively working writes turns constantly, which made "you lost your
 * place" the normal outcome of a dropped connection rather than a rare one.
 */
export type TranscriptStreamMsg =
  | {
      type: "init";
      messages: TranscriptMessage[];
      /** Byte offset of the first turn in `messages` - the back-paging anchor. */
      start: number;
      /** True when `start` is the top of the file, so nothing older exists. */
      atStart: boolean;
      /** Byte offset just past the last turn - what a later reconnect resumes from. */
      pos: number;
    }
  | {
      /**
       * Turns written since the offset the reader asked to continue from.
       *
       * Carries no `start`: the reader keeps the anchor and the pages it already had, so
       * a reconnect costs it nothing. The server sends this only when it can cover the
       * gap exactly; otherwise it sends `init` and the reader starts over honestly.
       */
      type: "resume";
      messages: TranscriptMessage[];
      pos: number;
    }
  | { type: "append"; messages: TranscriptMessage[]; pos: number }
  | { type: "unavailable"; reason: string };

// ---- session diff (changes vs the source branch) ----

/**
 * A session's changes against its source branch (typically `main`):
 * `GET /api/sessions/:id/diff`. The patch is everything the branch + worktree
 * changed since it diverged (committed since the merge-base, staged, unstaged,
 * and untracked) - so it captures the work done in that checkout. Diff stats are
 * from `--numstat`, so they stay accurate even when a huge `patch` is truncated.
 */
export interface SessionDiff {
  ok: boolean;
  error: string | null;
  /** Source branch the diff is against (e.g. "main"), or null if none was found. */
  base: string | null;
  /** Short sha of the merge-base actually diffed against, or null (diffed vs HEAD). */
  baseSha: string | null;
  headSha: string | null;
  /**
   * The repo's toplevel (`git rev-parse --show-toplevel`), or null when the cwd
   * isn't a git repo. The paths in `patch` are relative to THIS, not to the
   * session's cwd - git emits toplevel-relative paths wherever it's invoked from -
   * so anything resolving a changed path needs it.
   */
  repoRoot: string | null;
  branch: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** Raw unified diff (tracked changes then untracked-as-new-files), possibly capped. */
  patch: string;
  /** True when `patch` was truncated for size (stats above are still complete). */
  truncated: boolean;
}

// ---- session reset (start a checkout over from origin's default branch) ----

/**
 * Preview of what a "reset to origin/main" would permanently discard, computed
 * after fetching origin so it reflects the *current* remote: `GET
 * /api/sessions/:id/reset/preview`. Powers the confirm dialog's warning so the
 * user sees exactly what work is at stake before committing to the reset.
 */
export interface ResetPreview {
  ok: boolean;
  error: string | null;
  /** The ref the reset would land on (e.g. "origin/main"), null when none was found. */
  target: string | null;
  /** The branch being reset (from the session), for display. */
  branch: string | null;
  /** Tracked files with uncommitted (staged or unstaged) changes - discarded. */
  dirtyFiles: number;
  /** Untracked files that `git clean` would remove. */
  untrackedFiles: number;
  /** Commits on the branch not on `target` - discarded by the hard reset. */
  aheadCommits: number;
  /** Subject lines of up to 10 of those commits, most recent first. */
  aheadSubjects: string[];
  /** True when the worktree is already clean and at `target` (nothing to lose). */
  clean: boolean;
  /** Whether the agent's context can be cleared through its pane or live driver. */
  canClear: boolean;
}

/** Result of executing a reset: `POST /api/sessions/:id/reset`. */
export interface ResetResult {
  ok: boolean;
  error: string | null;
  workIdentityReady?: boolean;
  clearIssuedAt?: number;
  /**
   * The worktree root the reset actually ran in (git's own `--show-toplevel`),
   * or null when we never got that far. Identifies which checkout was wiped, so
   * callers can act on the sessions sharing it without re-resolving it.
   */
  root: string | null;
  /**
   * True when the agent was seen ACTING on the `/clear` sent after the git reset - not
   * merely that the keystrokes were accepted. The two differ by however long Claude
   * takes to process the command, and a caller that types behind this (see
   * `TaskManager.assign`) has its prompt wiped if it believes the wrong one.
   */
  cleared: boolean;
  /**
   * True when the checkout ends up holding no branch at all - standing on a
   * commit, which is what leaves the next task free to claim a branch of its own.
   *
   * False only where the reset deliberately left a branch standing (the checkout
   * was already on the repo's default branch) or where the detach failed after
   * the reset had already landed. Both are reported rather than raised, for the
   * reason `cleared` is: the git reset is done by then, so the operation
   * succeeded even when this last step didn't.
   */
  detached: boolean;
}

/**
 * What assigning a backlog task to a running agent would take from that agent BEYOND
 * what git can hand back, sent with the refusal that asks for a confirmation.
 *
 * Carried on the refusal rather than served by a preview route on purpose: a preview is
 * a second round trip with a window in the middle, and the thing being described - the
 * queue, the branch - can move inside that window. This is what the daemon saw at the
 * moment it decided, so the dialog and the action cannot disagree.
 */
export interface AssignResetConfirm {
  /** Open work-queue items on that session, which the reset drops. */
  queuedItems: number;
  /** Whether the agent's conversation is wiped (`/clear`) as part of the handover. */
  clearsContext: boolean;
  /** The branch the checkout is released from, or null when nothing is released. */
  branch: string | null;
}

/** One git-discovered path in a live session checkout. */
export interface SessionFileEntry {
  path: string;
}

export type SessionFileKind = "html" | "markdown" | "image" | "text" | "binary" | "oversized";

export interface SessionFileImagePreview {
  /** Browser-decodable media type selected from the shared image-extension registry. */
  mediaType: string;
  /** Exact bounded bytes from this read, kept self-contained rather than exposed by a second route. */
  dataUrl: string;
}

/** A file opened through the daemon's contained, size-bounded reader. */
export interface SessionFileDocument {
  path: string;
  kind: SessionFileKind;
  editable: boolean;
  text: string | null;
  size: number;
  mtime: number;
  language: string;
  revision: string;
  error: string | null;
  /** Present only for browser-renderable image documents. */
  image?: SessionFileImagePreview;
}

export interface SessionFileSaveResult {
  ok: boolean;
  error?: string;
  status?: number;
  revision?: string;
  mtime?: number;
  /** Current disk state on a 409; local editor text is never replaced implicitly. */
  currentRevision?: string;
  currentText?: string | null;
  deleted?: boolean;
}

// ---- line comments in the Files workspace ----

/**
 * One message in a thread: the opening comment, an agent reply, or a human follow-up.
 *
 * The BODY lives here rather than on the thread, which is what makes a draft a draft: the
 * opening comment is an ordinary message row edited from the first keystroke, and so is a
 * queued reply. It stops being editable when its bytes leave for the agent - see
 * `deliveredAt`.
 */
export interface FileCommentMessage {
  id: string;
  threadId: string;
  author: FileCommentAuthor;
  /** The session that wrote or received it; null for a row whose session was not recorded. */
  sessionId: string | null;
  body: string;
  /**
   * When this message actually reached the agent - stamped from CONFIRMED delivery, never
   * from submitting, which only queues a turn. Null while it is still the queue's business.
   *
   * Phase 3 selects what to send with it (a thread's oldest human message where it is
   * NULL), which is why the queue can reorder threads and still send the right message
   * from each.
   */
  deliveredAt: number | null;
  /** When a human read it. NULL is what the Files tab's attention pip counts. */
  readAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A line-anchored comment thread, drawn from durable state and never from the transcript.
 *
 * It carries its messages because a thread has to render from ONE frame: phase 2 draws a
 * thread from a snapshot arm and phase 4 delivers a reply through an upsert, and neither
 * has a second fetch. See `FILE_COMMENT_THREAD_MESSAGE_CAP` for what bounds that list and
 * what a surface does past it.
 *
 * `status` and `outdated` are two dimensions, not one. A thread whose quote has stopped
 * resolving keeps the status it had; losing that would lose its place in the review.
 */
export interface FileCommentThread {
  id: string;
  /** `MC-a41f`: the stable, human-quotable handle, unique PER SESSION and never global. */
  shortId: string;
  /** The session this thread belongs to. Threads end with the session that owns them. */
  sessionId: string;
  path: string;
  /** 1-based, inclusive, in the file's source. */
  startLine: number;
  endLine: number;
  /** The anchored source text, bounded by `FILE_COMMENT_QUOTE_MAX`. */
  quote: string;
  /** `sha256(path + LF + normalized quote)`; excludes the line, as the Inspector's does. */
  quoteHash: string;
  /** The file revision the anchor was last VALID against; null when it was unknown. */
  revision: string | null;
  surface: FileCommentSurface;
  status: FileCommentThreadStatus;
  /** The quote no longer resolves. A flag beside the status, reversible, never a status. */
  outdated: boolean;
  /** Position in the review; null once terminal. */
  queueSeq: number | null;
  /** The `pending_turns` row currently carrying it - the correlation that table cannot hold. */
  deliveryId: string | null;
  sentAt: number | null;
  answeredAt: number | null;
  /** The agent's "I handled this". A suggestion, never a closure - only a person resolves. */
  addressedAt: number | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /**
   * In time order, oldest first. Capped at `FILE_COMMENT_THREAD_MESSAGE_CAP`, carrying the
   * NEWEST that many when there are more.
   */
  messages: FileCommentMessage[];
  /** The true total, so a surface can tell `messages` is a tail rather than the whole thread. */
  messageCount: number;
}

/**
 * The walkthrough's run state for one session. Phase 3 is its only writer; it is declared
 * now because a shipped table cannot gain a column from its CREATE TABLE afterwards.
 */
export interface FileCommentReview {
  sessionId: string;
  state: FileCommentReviewState;
  /** Why it stopped, as a human reads it. Null unless paused. */
  pauseReason: string | null;
  startedAt: number | null;
  updatedAt: number;
}

/**
 * Who a refused assign is ABOUT, so a caller can tell "this agent is unusable" from
 * "this task is gone".
 *
 * The autopilot is the caller that needs it: it parks a session for ten minutes after a
 * session-scoped refusal, and doing that over a task a human dispatched a second earlier
 * would take a perfectly free agent off the backlog for no reason at all.
 */
export type AssignRefusalScope = "task" | "session";
