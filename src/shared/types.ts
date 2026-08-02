// Shared contract between the daemon (src/server), the MCP bridge (src/mcp),
// and the web UI (src/web). Keep this the single source of truth for anything
// that crosses the SSE / HTTP boundary.

// Type-only both ways: `ensemble.ts` needs `AgentType`/`ThinkingLevel` from here. Both
// imports are erased at emit (verbatimModuleSyntax), so there is no runtime cycle.
import type { EnsembleSummary, TaskEnsembleLink } from "./ensemble.ts";
// Same type-only, cycle-free relationship: `schedules.ts` reads `AgentType`, `TaskKind`,
// `TaskPriority`, `TaskStatus` and `ThinkingLevel` from here.
import type { MissionSchedule } from "./schedules.ts";
import type { CheapAction, Divergence } from "./foreman.ts";
import type { ForemanModelRole, ResolvedForemanModel } from "./foreman-models.ts";
import type { InspectorPosture } from "./inspector.ts";
import type { LlmJobId, ResolvedLlmJobModel } from "./llm-jobs.ts";
import type { AutomationRoleCost } from "./llm-spend.ts";
import type { LlmRunnerId, ResolvedLlmRunner } from "./llm.ts";
import type { ResolvedModel } from "./model-choice.ts";
import type { SkillEnforcement } from "./skills.ts";
import type { TaskSourceRef } from "./task-source.ts";
import type { TerminalBackendId, TerminalHandle } from "./terminal.ts";
import type {
  PersonaId,
  PersonaView,
  SessionAction,
  SessionActionId,
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
 * SDK registration, before the first prompt or driver binding.
 */
export type SessionState =
  | "starting"
  | "idle"
  | "working"
  | "awaiting_input"
  | "awaiting_review"
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
 * What an embedded driver's acknowledgement means for the submitted message.
 *
 * A busy Claude stream accepts a follow-up into its FIFO for the next turn, while Codex
 * can steer input into the turn already running. Both are successful sends, but collapsing
 * them into a bare `ok` leaves the operator unable to tell a queued message from one the
 * active turn is already processing.
 */
export type SdkSendDisposition = "started" | "steered" | "queued";

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
   * sentence and the card must be free to show it without showing (or gating on) anything
   * of Foreman's - the whole point of the feature is that it is visible on a collapsed card.
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
  surface: "input-review" | "terminal";
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
   * The resolved intent episode the `prompted` wrap-up trigger last handled, or null if
   * it never has. Encoded as `intent:<objectiveVersion>:<promptRevision>`, so a newly
   * reconciled human instruction re-arms it and an unchanged idle session stays quiet.
   *
   * The historical field name is persisted and must not be renamed casually; its value
   * is now an opaque episode key rather than goal text.
   *
   * Deliberately separate from `wrapupAskedAt`, which stays the DRAIN trigger's guard.
   * One field for both would mean a prompted wrap-up consumed the drain ask (or the
   * reverse) on a checkout that later gets a work queue.
   */
  promptedGoal: string | null;
  updatedAt: number;
  items: WorkItem[];
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
   * What each of Foreman's four `claude -p` calls will actually spawn with, and why -
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

/** ship = deliver a change (PR/merge); scout = investigate/plan/audit and report. */
export type TaskKind = "ship" | "scout";

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

/** How a task's isolated worktree was provisioned - decides how it's torn down. */
export type WorktreeProvider = "treehouse" | "git";

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
  /** Absolute path of the source repo the worktree is cut from. */
  repoRoot: string;
  /** Isolated worktree the agent runs in (realpath) - the correlation key. Null while in the backlog. */
  worktreePath: string | null;
  /** Worktree branch, once known - remembered so teardown can drop a throwaway `harness/*` branch by name. */
  branch: string | null;
  /** How the worktree was provisioned, so teardown returns a treehouse lease vs `git worktree remove`. */
  provider: WorktreeProvider | null;
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
  kind: TaskKind;
  status: TaskStatus;
  outcome: string | null;
  outcomeUrl: string | null;
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
export type InspectorSource = "hook" | "legacy";

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
      workflowSummaries: WorkflowSummary[];
      workflowRunSummaries: WorkflowRunSummary[];
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
       * Fleet cost estimate at connect time. Carried in the snapshot rather than waited for,
       * or the topbar strip would sit blank until the next export happened to change
       * something - up to a whole export interval of a dashboard that looks broken.
       */
      fleetCost: FleetCost | null;
      /**
       * The settings status tuple at connect time, so the rail dots and gear are right
       * from the first render rather than blank until the next config write happens to
       * change something. Composed fresh on every snapshot (see `Registry.snapshot`).
       */
      settingsStatus: SettingsStatus;
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
  | { type: "workflow_upsert"; workflow: WorkflowSummary }
  | { type: "workflow_remove"; id: WorkflowId }
  | { type: "workflow_run_upsert"; run: WorkflowRunSummary }
  | { type: "workflow_run_remove"; id: WorkflowRunId }
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
   * Fleet-wide API-equivalent estimate and subscription rate limits. A top-level collection,
   * not a per-session field: the rate limits are account-global, so hanging them off each
   * session would ship the same numbers N times and invite N places to disagree.
   */
  | { type: "cost_fleet"; fleet: FleetCost }
  /**
   * The settings status tuple, emitted whenever a config write or a task-source sweep
   * changed it. Reduced into `MissionState.settingsStatus`, which is the ONE client-side
   * source of these facts: the rail dots and the topbar gear read it, never a re-poll.
   */
  | { type: "settings_status"; status: SettingsStatus };

// ---- session transcript (expanded card) ----

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

/** One normalized turn from a Claude/Codex transcript, for the expanded card. */
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
}

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

export type SessionFileKind = "html" | "markdown" | "text" | "binary" | "oversized";

/** A file opened through the daemon's contained, UTF-8-only reader. */
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

/**
 * Who a refused assign is ABOUT, so a caller can tell "this agent is unusable" from
 * "this task is gone".
 *
 * The autopilot is the caller that needs it: it parks a session for ten minutes after a
 * session-scoped refusal, and doing that over a task a human dispatched a second earlier
 * would take a perfectly free agent off the backlog for no reason at all.
 */
export type AssignRefusalScope = "task" | "session";
