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
}

// ---- dispatched tasks (crewmates) ----

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
