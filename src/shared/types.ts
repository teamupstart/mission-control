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
  /** True when this session's repo is gated by no-mistakes. */
  nomistakesGated: boolean;
  /** The leaf agent process pid (what we act on / kill). */
  pid: number;
  /** Controlling tty, normalized without the /dev/ prefix (e.g. "ttys012"). */
  tty: string | null;
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
}

/** The states we surface for a session's PR. Closed-unmerged is treated as "no PR". */
export type PrState = "open" | "merged";

// ---- dispatched tasks (agents) ----

/** ship = deliver a change (PR/merge); scout = investigate/plan/audit and report. */
export type TaskKind = "ship" | "scout";

/**
 * Coarse lifecycle of a dispatched task. Deliberately does NOT mirror the live
 * session's runtime state (working/idle/needs-input) - that stays a property of
 * the Session so runtime status is never duplicated. A task is queued in the
 * backlog, provisioned (`dispatching`), bound to a live session (`running`), and
 * then reaches a terminal state.
 */
export type TaskStatus =
  | "queued"
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
  /** Isolated worktree the agent runs in (realpath) - the correlation key. Null while queued. */
  worktreePath: string | null;
  /** Worktree branch, once known (carried here since gitInfo can't read linked-worktree .git). */
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
  status: string; // running | completed | failed
  branch: string;
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
    queued: number;
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
