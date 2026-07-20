// Shared contract between the daemon (src/server), the MCP bridge (src/mcp),
// and the web UI (src/web). Keep this the single source of truth for anything
// that crosses the SSE / HTTP boundary.

import type { SkillEnforcement } from "./skills.ts";

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
  /**
   * Stable identity for the life of the process: the synthetic discovery id
   * `proc:<tty>:<pid>:<startMs>` (minted in `discovery/correlate.ts`), which is also
   * the registry's map key. Distinct from `agentSessionId`, which the agent mints and
   * rotates on `/clear`; this one never changes under a given entry.
   */
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
  /**
   * True while this session's hook overlay is FRESH - i.e. a hook has reported
   * within the overlay TTL (30 min). This is a liveness window, NOT a fact about
   * whether the integrations are installed: a healthy instrumented session that
   * simply goes quiet flips this back to false, because nothing but a hook event
   * refreshes the overlay. Read it as "we have current hook-sourced state for this
   * session"; for "does this session have hooks at all", read `hooksSeen`.
   */
  instrumented: boolean;
  /**
   * True once a hook has EVER been seen from this session - the installation fact,
   * with no freshness window on it.
   *
   * The distinction is load-bearing. Conflating the two reads a 30-minute silence
   * as "the integrations aren't installed", which is precisely what an agent parked
   * waiting on a human looks like - so anything that punishes a hookless session
   * (see the work queue's step 3) must gate on THIS, not on `instrumented`.
   */
  hooksSeen: boolean;
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
  /**
   * Fixes no-mistakes committed on this session's branch. Derived from git, not
   * from a run, so it outlives the run that produced it - and empties by itself
   * when a reset discards the commits. Empty when there are none.
   */
  nomistakesFixes: NmFixSummary[];
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

/** An option dialog as read off a pane. */
export interface PaneDialog {
  /** Every row, ascending. Includes Claude's own trailing rows ("Type something."). */
  options: PaneOption[];
  /** The row the `❯` cursor sits on - where an Enter would land right now. */
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
 *  - model: a `claude -p` pass rewrote it into one sentence.
 *
 * Stored rather than inferred because the refiner needs to know what it is upgrading, and
 * because "this is still the raw prompt" is a real distinction when a refinement silently
 * fails (see the Q3 fallback: a failed refine leaves the heuristic goal standing).
 */
export type GoalSource = "heuristic" | "model";

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
 * A session's Goal: one sentence saying what it is currently attempting to solve, written
 * by the DAEMON on every instrumented Claude session whether or not Foreman ever runs.
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
  /** The sentence itself. Null while only the raw prompt has been captured. */
  text: string | null;
  source: GoalSource | null;
  /**
   * The filtered prompt `text` was derived from.
   *
   * Persisted rather than re-read because the refiner runs debounced, well after the hook
   * that captured it: without this it would have to race the transcript for text it was
   * already handed, and would lose it entirely across a restart. Clamped (`clampPrompt`) so
   * a pasted log can't put a megabyte in a row. Server-side only - never shipped to a card.
   */
  prompt: string | null;
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
  /**
   * The session goal the `prompted` wrap-up trigger last fired on, or null if it never
   * has. The trigger's once-per-episode guard: it fires only when the CURRENT goal
   * differs from this, so a new human prompt re-arms it and an idle session that has
   * already been wrapped up stays quiet.
   *
   * Stored as the goal text verbatim rather than a hash - it is capped at 4000 chars
   * upstream (`clampPrompt`), so there is nothing to gain by hashing and a collision
   * here would silently skip a wrap-up nobody could then explain.
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
  /** The sentence shown under the card title. */
  text: string | null;
  /** Lets the card tell a raw prompt from a refined sentence. */
  source: GoalSource | null;
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

export interface Task {
  id: string;
  /** Short label - source of the tmux session slug and the card title. */
  title: string;
  /** The full task prompt injected as the agent's first message. */
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
  /**
   * Model override for this task, or null to follow the harness default configured
   * in Settings. Null is NOT "the default as it stood when this was shelved" - the
   * default is resolved at dispatch time, so a backlogged task launches on whatever
   * is configured then.
   */
  model: string | null;
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

/**
 * A step `axi status` reports as active right now, from its `active_steps` block.
 *
 * Why this exists: `steps[]` gives a step nothing but a status, and "running" covers
 * both a step mid-work and a `ci` step that finished its checks hours ago and is
 * simply watching an open PR. That collapse is what makes a green, pushed, PR-opened
 * run look stuck - the dots say "running" and cannot say why. This block carries the
 * why, in no-mistakes' own words.
 *
 * Only the columns the card uses are kept; the block carries a couple more, and
 * ignoring them costs nothing (rows are read by column name). Deliberately NOT kept:
 * `agent_pid`. It is empty for a perfectly healthy `ci` monitor, so reading it as
 * "nothing is driving this" marks live steps dead - measured, not assumed.
 */
export interface NmActiveStep {
  step: string;
  status: string;
  /** How long the step has been active, e.g. "2h26m". */
  activeFor: string;
  /**
   * What the step last did, in no-mistakes' words, e.g. `2m43s ago: log: all CI
   * checks passed - still monitoring until merged or closed`. It may lead with
   * `quiet …` when the gap grows - which is idling, NOT a stall: a `ci` monitor
   * legitimately sits quiet for hours between polls, then completes the moment the
   * PR merges. Surfaced verbatim; nothing here infers health from it.
   */
  lastActivity: string;
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
  /**
   * The steps no-mistakes reports as active, saying what each is actually doing.
   * Empty when the block is absent - an older no-mistakes, or a run with nothing
   * active - which costs the card an explanation, never a wrong one.
   */
  activeSteps: NmActiveStep[];
  findings: NmFinding[];
  outcome: string | null; // once landed: checks-passed | passed | failed | cancelled
}

// ---- no-mistakes fix log ----
//
// What the pipeline actually changed on a branch, and why. Sourced from git (the
// fix commits themselves) joined to no-mistakes' own round records (the findings
// that justified each fix, and the reply that authorized it). Two tiers: the card
// carries `NmFixSummary`, and the bulky context is fetched per fix on demand - a
// 22-finding fix runs ~20KB of description text, which has no business riding on
// every session snapshot.

/**
 * Who caused a fix to happen. `auto` - the pipeline fixed it under its own
 * round limit, nobody was asked. `replied` - it was fixed because someone
 * answered the gate; the reply text is on `NmFixDetail`.
 *
 * This is no-mistakes' own `selection_source` and nothing more: it says THAT
 * somebody answered, never who. The byline is a separate fact from a separate
 * source - see `NmFixAttribution`, which deliberately does not fold into this
 * union. `replied` stays honest that way: it means exactly what the pipeline
 * recorded, and an unattributed reply (the common case - the agent drove its own
 * gate) reads as `replied` with no byline rather than as a third enum member
 * that would have to mean "replied, source unknown".
 */
export type NmFixDecision = "auto" | "replied";

/**
 * Who the reply came from. `you` - typed into the dashboard's Fix box. `foreman`
 * - the foreman nudged the session's pane about this gate and the agent answered
 * it afterwards.
 *
 * Absent for the common case: the agent answered its own gate (via the
 * `/no-mistakes` skill), which no-mistakes records identically to a human reply
 * and which nothing on our side witnessed. So this is only ever ADDITIVE - it
 * names an author when we logged one, and says nothing when we didn't.
 */
export type NmFixReplySource = "you" | "foreman";

/**
 * The byline on a fix's reply, joined from our own record of who said what to
 * which gate.
 *
 * `foreman` attribution is INDIRECT and the shape says so. The foreman never
 * calls `axi respond`; it types into the session's pane, and the *agent* decides
 * what to send. So `text` is what the foreman said about this gate - context for
 * the reply, never the reply itself - and the agent was free to ignore it. The
 * UI must keep those two sentences visibly apart; collapsing them would be its
 * own attribution bug.
 */
export interface NmFixAttribution {
  source: NmFixReplySource;
  /** What the author actually wrote. Null when they selected findings and typed nothing. */
  text: string | null;
  /** When it was said (epoch ms). Always before the fix it explains. */
  at: number;
}

/** One no-mistakes fix commit on a session's branch. Card-weight. */
export interface NmFixSummary {
  /** Short sha. Also the key for fetching this fix's detail. */
  sha: string;
  step: string; // review | document | lint | test | ...
  /** The commit subject with the `no-mistakes(<step>): ` prefix stripped. */
  summary: string;
  committedAt: number; // epoch ms
  filesChanged: number;
  added: number;
  removed: number;
  /** From the round that produced it; null when no round matched the commit. */
  decision: NmFixDecision | null;
  /**
   * The reply's author, when we logged one. Card-weight (an enum, not the text)
   * so a foreman-caused fix is spottable down the list without opening each row -
   * which is the whole point: a bot changing your branch while you were away is
   * the thing you'd want to catch at a glance. The text is on `NmFixDetail`.
   */
  repliedBy: NmFixReplySource | null;
  /** How many findings justified it. The TRUE count, even if the detail caps its list. */
  findingCount: number;
}

/** One finding no-mistakes reported as justification for a fix. */
export interface NmFixFinding {
  id: string;
  severity: string; // error | warning | info
  file: string;
  line: number | null;
  /** The justification, verbatim from the pipeline. Runs long (500-900 chars). */
  description: string;
}

export interface NmFixFile {
  path: string;
  added: number;
  removed: number;
}

/** Everything behind one fix: why it happened, who authorized it, what it changed. */
export interface NmFixDetail {
  sha: string;
  step: string;
  summary: string;
  committedAt: number;
  decision: NmFixDecision | null;
  /**
   * The reply that authorized the fix. no-mistakes stores this per-finding (it
   * copies the `--instructions` text onto every selected finding), but it is one
   * reply, so it belongs to the fix. Null when auto-fixed or unmatched.
   */
  reply: string | null;
  /**
   * Who wrote the reply, and what they said in their own words. Null when nobody
   * we know about did - see `NmFixAttribution`.
   */
  attribution: NmFixAttribution | null;
  /** Capped: compare against `findingCount` to know if this is the whole set. */
  findings: NmFixFinding[];
  /** The true number of findings, which can exceed `findings.length`. */
  findingCount: number;
  /** Capped: compare against `filesChanged` to know if this is every file. */
  files: NmFixFile[];
  /**
   * The true number of files the commit touched. Distinct from `files.length`,
   * which is capped - a card that showed the capped length would disagree with
   * the row above it about the same commit.
   */
  filesChanged: number;
  added: number;
  removed: number;
}

export type ReviewKind = "plan" | "diff" | "input" | "plan-decisions";
export type ReviewStatus = "pending" | "approved" | "rejected" | "answered";

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

/** One question the human answers when resolving a `plan-decisions` review. */
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
  /** The decision points to answer; present only for kind `plan-decisions`. */
  decisions?: PlanDecision[] | null;
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
   * "Claude needs your permission" (see the Notification branch of registry.ts's
   * `hookToState`), so an `AskUserQuestion`'s options and a `Bash`'s command reach the
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
 * A session Foreman is driving is mostly Foreman talking, and the dashboard types
 * `/reload-skills` into idle sessions on its own account. The transcript file records
 * both exactly as it records a person's typing, so without this the log credits the human
 * with instructions they never wrote - and hides the machinery doing its job.
 */
export type TurnOrigin = "foreman" | "harness";

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
