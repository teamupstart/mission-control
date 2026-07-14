// Shared contract between the daemon (src/server), the MCP bridge (src/mcp),
// and the web UI (src/web). Keep this the single source of truth for anything
// that crosses the SSE / HTTP boundary.

export type AgentType = "claude" | "codex";

/**
 * Lifecycle of a tracked agent session.
 *
 * Passive discovery can only establish `working` (alive, has a foreground agent
 * process) vs `exited`. The precise `idle` / `awaiting_input` / `awaiting_review`
 * states come from active reporting (Claude hooks) and the harness's own review
 * queue. `starting` is the brief window after a SessionStart hook before the
 * first prompt.
 */
export type SessionState =
  | "starting"
  | "idle"
  | "working"
  | "awaiting_input"
  | "awaiting_review"
  | "exited";

/** Where the session's display name came from. */
export type NameSource = "tmux" | "wezterm" | "process";

/** Reasoning effort, shared by Claude (`/effort`) and Codex (rollout `effort`). */
export type ThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Claude's permission mode - the state cycled by Shift+Tab. These are the exact
 * strings Claude reports on its hook payloads (`permission_mode`). Codex has no
 * equivalent, so a Codex session's mode is always null.
 */
export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

/**
 * Where a session's runtime metadata came from, in descending authority:
 * `statusline` is Claude's own live accounting (exact), `transcript` is our
 * passive read of the JSONL (approximate), `codex-rollout` is Codex's session
 * file. The daemon never lets a lower-authority read clobber a fresh statusLine.
 */
export type MetaSource = "statusline" | "transcript" | "codex-rollout";

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

export interface WeztermInfo {
  paneId: number;
  tabId: number;
  windowId: number;
  tabTitle: string;
  isActive: boolean;
}

export interface TmuxInfo {
  session: string;
  window: string;
  windowIndex: number;
  paneId: string; // e.g. "%3"
}

export interface Session {
  /** Stable identity: agent session id when known, else synthetic from tty+pid+start. */
  id: string;
  agent: AgentType;
  /** Display name: tmux session name, else wezterm tab title, else a process fallback. */
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
  /** True when this session's repo is gated by no-mistakes. */
  nomistakesGated: boolean;
  /** The leaf agent process pid (what we act on / kill). */
  pid: number;
  /** Controlling tty, normalized without the /dev/ prefix (e.g. "ttys012"). */
  tty: string | null;
  /**
   * Claude's live permission mode, from its hooks (`permission_mode`). Null until
   * a hook reports it, and always null for Codex (no such concept). Hook-sourced
   * rather than from the statusLine, which doesn't carry it - so it refreshes on
   * the next hook event after a Shift+Tab, not the instant the mode changes.
   */
  permissionMode: PermissionMode | null;
  wezterm: WeztermInfo | null;
  tmux: TmuxInfo | null;
  /** Claude Code session id, present once the session is hook-instrumented. */
  agentSessionId: string | null;
  /**
   * Absolute path to the agent's transcript file, as reported by its hook. The
   * authoritative locator - Claude hands us the exact path, so we never derive it
   * from the cwd. Null until a hook reports it (or for agents without hooks).
   */
  transcriptPath: string | null;
  /** True once we've received at least one hook event from this session. */
  instrumented: boolean;
  /** Free-form one-liner from the last hook/report (e.g. current tool, last prompt). */
  activity: string | null;
  /** When the agent process actually started (epoch ms), for a real uptime. */
  startedAt: number | null;
  firstSeen: number; // epoch ms
  lastSeen: number; // epoch ms (last poll that observed the process)
  lastActivity: number | null; // epoch ms of last hook/report event
  /** Count of pending review items for this session (denormalized for the card). */
  pendingReviews: number;
  /** Live no-mistakes run status for this repo, when gated and a run exists. */
  nomistakes: NmRunSummary | null;
  /** The dispatched task this session is executing, matched by cwd === worktreePath. */
  task: TaskSummary | null;
  /**
   * "What the no-mistakes skill is doing right now" - the in-progress TodoWrite
   * item read from this session's Claude transcript. Only populated while a
   * no-mistakes run is present; null otherwise (or when nothing is in progress).
   */
  nomistakesNarration: string | null;
  /**
   * The GitHub PR whose head branch is this session's *current* git branch, else
   * null. Live decoration, never persisted: set optimistically when the agent
   * runs `gh pr create` (via the hook) and reconciled by the PR poller, which
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
  /**
   * The Foreman auto-responder's note for this session: a one-liner Purpose plus
   * the decision brief / audit of what Foreman did. Denormalized like `task`,
   * keyed on the stable agent session id so it survives the synthetic id churning.
   * Null until Foreman has inspected the session.
   */
  note: SessionNoteSummary | null;
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
  escalatedCount: number;
  /** True when every item is terminal and the wrap-up ask is due/answered. */
  drained: boolean;
  wrapupAskedAt: number | null;
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

export interface Task {
  id: string;
  /** Short label - source of the tmux session slug and the card title. */
  title: string;
  /** The full task prompt injected as the agent's first message. */
  intent: string;
  kind: TaskKind;
  agent: AgentType;
  /** Absolute path of the source repo the worktree is cut from. */
  repoRoot: string;
  /** Isolated worktree the agent runs in (realpath) - the correlation key. Null while in the backlog. */
  worktreePath: string | null;
  /** Worktree branch, once known - remembered so teardown can drop a throwaway `harness/*` branch by name. */
  branch: string | null;
  /** How the worktree was provisioned, so teardown returns a treehouse lease vs `git worktree remove`. */
  provider: WorktreeProvider | null;
  /** The detached tmux session we created for this task. */
  tmuxSession: string | null;
  /** Bound live session's synthetic id, once discovered. */
  sessionId: string | null;
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

/** Compact task view denormalized onto a Session card (like NmRunSummary). */
export interface TaskSummary {
  id: string;
  title: string;
  kind: TaskKind;
  status: TaskStatus;
  outcome: string | null;
  outcomeUrl: string | null;
}

// ---- no-mistakes surfacing ----

export interface NmStep {
  step: string;
  status: string; // pending | running | completed | awaiting_approval | skipped | failed
  findings: number;
}

export interface NmFinding {
  id: string;
  severity: string; // error | warning | info
  file: string;
  action: string; // auto-fix | ask-user
  description: string;
}

/** Compact view of a no-mistakes run, as surfaced on a session card. */
export interface NmRunSummary {
  /**
   * The run's own id (a ULID from `axi status`). Identifies a run independently
   * of its branch, which successive runs share - so retiring one run from a card
   * never gags the next one on the same branch.
   */
  id: string;
  status: string; // running | completed | failed
  branch: string;
  /**
   * When the run started (epoch ms), decoded from the ULID id above - `axi status`
   * carries no timestamps of its own. Null when the id isn't a ULID.
   */
  startedAt: number | null;
  /**
   * When the run stopped (epoch ms), or null while it's still going. Also null for
   * a run that had already finished the first time the daemon saw it: nothing in
   * `axi status` dates the end, so it can only be timed by watching (see timeRun).
   */
  endedAt: number | null;
  /** e.g. "parked 1m30s" while awaiting an agent decision, else null. */
  awaitingAgent: string | null;
  /** e.g. "1 awaiting" / "1 auto-fix". */
  findingsSummary: string | null;
  /** The step the run is parked at (e.g. "review"), or null when not parked. */
  gateStep: string | null;
  gateSummary: string | null;
  gateRisk: string | null;
  steps: NmStep[];
  findings: NmFinding[];
  outcome: string | null; // "passed" once complete
}

export type ReviewKind = "plan" | "diff" | "input";
export type ReviewStatus = "pending" | "approved" | "rejected" | "answered";

export interface ReviewItem {
  id: string;
  sessionId: string;
  kind: ReviewKind;
  title: string;
  /** Markdown for `plan`, a unified diff for `diff`, a question for `input`. */
  body: string;
  status: ReviewStatus;
  /** Human's textual response (for `input`) or optional comment on approve/reject. */
  response: string | null;
  createdAt: number; // epoch ms
  resolvedAt: number | null;
}

// ---- fleet report (/bearings) ----

/** One line in a fleet report - a live session (with its intent) or a task. */
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

/** A point-in-time snapshot of the whole fleet, for the report panel + markdown digest. */
export interface FleetReport {
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

// ---- SSE events (daemon -> UI) ----

export type ServerEvent =
  | { type: "snapshot"; sessions: Session[]; reviews: ReviewItem[]; tasks: Task[] }
  | { type: "session_upsert"; session: Session }
  | { type: "session_remove"; id: string }
  | { type: "review_upsert"; review: ReviewItem }
  | { type: "review_remove"; id: string }
  | { type: "task_upsert"; task: Task }
  | { type: "task_remove"; id: string };

// ---- session transcript (expanded card) ----

/** One normalized turn from a Claude/Codex transcript, for the expanded card. */
export interface TranscriptMessage {
  /** Stable id (the record uuid) - used to de-dupe across init/append. */
  id: string;
  role: "user" | "assistant";
  /** Prose the human/agent wrote. May be empty on a pure tool-call turn. */
  text: string;
  /** Names of tools invoked in this turn, rendered as compact chips. */
  tools: string[];
  /** epoch ms of the turn, 0 when the record had no timestamp. */
  ts: number;
}

/**
 * Messages on the per-session transcript SSE stream
 * (`GET /api/sessions/:id/transcript/stream`). `init` carries the recent
 * history on connect; `append` streams new turns as the agent writes them.
 */
export type TranscriptStreamMsg =
  | { type: "init"; messages: TranscriptMessage[] }
  | { type: "append"; messages: TranscriptMessage[] }
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
  /** Whether the agent's context can be cleared (session has a pane to send `/clear`). */
  canClear: boolean;
}

/** Result of executing a reset: `POST /api/sessions/:id/reset`. */
export interface ResetResult {
  ok: boolean;
  error: string | null;
  /**
   * The worktree root the reset actually ran in (git's own `--show-toplevel`),
   * or null when we never got that far. Identifies which checkout was wiped, so
   * callers can act on the sessions sharing it without re-resolving it.
   */
  root: string | null;
  /** True when `/clear` was sent to the agent after the git reset landed. */
  cleared: boolean;
}
