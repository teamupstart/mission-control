import { z } from "zod";

/** Terminal env the hook / MCP client captures, used to bind an event to a session. */
const EnvSchema = z
  .object({
    tmuxPane: z.string().optional(),
    weztermPane: z.string().optional(),
    termProgram: z.string().optional(),
  })
  .default({});

/**
 * Payload a Claude Code hook posts to the daemon. The hook script forwards the
 * raw event JSON plus the terminal env it captured (pane ids), which the daemon
 * uses to bind the event to a discovered session.
 */
export const HookIngestSchema = z.object({
  event: z.string(),
  sessionId: z.string().nullable().optional().default(null),
  cwd: z.string().nullable().optional().default(null),
  transcriptPath: z.string().nullable().optional().default(null),
  ts: z.number().optional(),
  env: EnvSchema,
  // Selected fields lifted from the raw hook JSON; everything is optional.
  toolName: z.string().optional(),
  prompt: z.string().optional(),
  message: z.string().optional(),
  source: z.string().optional(),
  reason: z.string().optional(),
  // Claude's current permission mode (the Shift+Tab state). Left as a free string
  // on the wire - the registry normalizes it to a known PermissionMode - so a mode
  // a newer Claude adds never fails hook ingest, it just doesn't render yet.
  permissionMode: z.string().optional(),
  // A GitHub PR URL the hook sniffed out of a PostToolUse tool result (e.g. the
  // link `gh pr create` prints). Optimistically decorates the session's card;
  // the PR poller is the source of truth that later confirms or clears it.
  prUrl: z.string().url().optional(),
});

export type HookIngest = z.infer<typeof HookIngestSchema>;

/**
 * Normalized status-line payload the forwarder posts to the daemon. Claude Code
 * pipes a rich JSON blob to the configured statusLine command on every render;
 * our forwarder (hooks/harness-statusline.mjs) lifts the fields we care about
 * into this flat, camelCased shape - model, context window, and reasoning effort -
 * plus the terminal env used to bind it to a discovered session. Everything but
 * `env` is optional so an older Claude Code that omits a field still validates.
 */
export const StatusLineIngestSchema = z.object({
  sessionId: z.string().nullable().optional().default(null),
  cwd: z.string().nullable().optional().default(null),
  ts: z.number().optional(),
  env: EnvSchema,
  model: z
    .object({ id: z.string().optional(), displayName: z.string().optional() })
    .optional(),
  contextWindow: z
    .object({
      /** Claude's own used-% (authoritative; matches what the terminal shows). */
      usedPercentage: z.number().optional(),
      contextWindowSize: z.number().optional(),
      /** Absolute tokens in context (input + cache), for the tooltip. */
      tokens: z.number().optional(),
    })
    .optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  thinkingEnabled: z.boolean().optional(),
});
export type StatusLineIngest = z.infer<typeof StatusLineIngestSchema>;

/** A message the user sends into a session from the dashboard. */
export const SendTextSchema = z.object({
  text: z.string().min(1),
  /** Whether to submit (press Enter) after typing. Default true. */
  submit: z.boolean().optional().default(true),
});
export type SendText = z.infer<typeof SendTextSchema>;

/**
 * Rename a session from the dashboard - renames the underlying tmux session or
 * wezterm tab, which the next discovery sweep reads back as the card's name. The
 * length cap keeps a stray paste from becoming an unwieldy tmux session name; the
 * handle-specific character rules (tmux forbids `.`/`:`) live in the action, which
 * knows which pane backs the session.
 */
export const RenameSchema = z.object({
  name: z.string().min(1).max(200),
});
export type Rename = z.infer<typeof RenameSchema>;

/** An MCP-driven agent creating a review item bound to its session's pane. */
export const CreateReviewSchema = z.object({
  env: EnvSchema,
  sessionId: z.string().nullable().optional().default(null),
  cwd: z.string().nullable().optional().default(null),
  kind: z.enum(["plan", "diff", "input"]),
  title: z.string().min(1),
  body: z.string(),
});
export type CreateReview = z.infer<typeof CreateReviewSchema>;

/** The human's decision on a review, from the dashboard. */
export const ResolveReviewSchema = z.object({
  action: z.enum(["approve", "reject", "answer"]),
  response: z.string().nullable().optional().default(null),
});
export type ResolveReview = z.infer<typeof ResolveReviewSchema>;

/** A decision on a no-mistakes gate, from the dashboard. */
export const NomistakesRespondSchema = z.object({
  action: z.enum(["approve", "fix", "skip"]),
  /** Finding ids to fix (with action=fix); empty means all shown findings. */
  findings: z.array(z.string()).optional().default([]),
  instructions: z.string().optional(),
  step: z.string().optional(),
});
export type NomistakesRespond = z.infer<typeof NomistakesRespondSchema>;

/**
 * Record who answered a no-mistakes gate - the fix log's byline.
 *
 * Posted by the Foreman worker, which is a separate process and reaches the DB
 * only through routes like this one. The dashboard's own replies are logged
 * server-side (the respond route already holds everything this carries), so this
 * has exactly one caller.
 *
 * `findingIds` identifies WHICH round of a step was answered. Deliberately ids
 * and not a digest of the findings' text: `axi status` truncates descriptions,
 * so anything hashing them binds us to another tool's display constants.
 */
export const GateReplySchema = z.object({
  runId: z.string().min(1),
  step: z.string().min(1),
  findingIds: z.array(z.string()).optional().default([]),
  /** What the author wrote. Empty is meaningful: findings selected, nothing typed. */
  text: z.string().optional().default(""),
});
export type GateReply = z.infer<typeof GateReplySchema>;

/** MCP `report_status`: update the session's activity line. */
export const StatusSchema = z.object({
  env: EnvSchema,
  sessionId: z.string().nullable().optional().default(null),
  activity: z.string().min(1),
});
export type StatusReport = z.infer<typeof StatusSchema>;

/**
 * Dispatch (or shelve) a new agent: launch an agent in an isolated worktree of
 * `repoRoot` with `intent` as its first prompt. `backlog: true` only adds it to
 * the backlog (no worktree/session yet); dispatch it later.
 */
export const DispatchSchema = z.object({
  repoRoot: z.string().min(1),
  intent: z.string().min(1),
  title: z.string().optional(),
  kind: z.enum(["ship", "scout"]).default("ship"),
  agent: z.enum(["claude", "codex"]).default("claude"),
  backlog: z.boolean().optional().default(false),
});
export type Dispatch = z.infer<typeof DispatchSchema>;

/**
 * Reset a session's worktree to origin's default branch. The body is optional;
 * `clear` controls whether the agent's context is also reset via `/clear`.
 */
export const ResetSchema = z.object({
  /** Also send `/clear` to the agent after the git reset lands. Default true. */
  clear: z.boolean().optional().default(true),
});
export type ResetInput = z.infer<typeof ResetSchema>;

/**
 * Drive a Claude session to a named permission mode. Closed to the modes Shift+Tab
 * can actually reach: `dontAsk` is settable only at startup, so accepting it here
 * would promise a walk that can never arrive.
 */
export const SetPermissionModeSchema = z.object({
  mode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions", "auto"]),
});
export type SetPermissionModeInput = z.infer<typeof SetPermissionModeSchema>;

/** Close a task with a human-recorded outcome (the `/stow` intent -> result loop). */
export const CompleteTaskSchema = z.object({
  outcome: z.string().min(1),
  outcomeUrl: z.string().url().optional(),
});
export type CompleteTask = z.infer<typeof CompleteTaskSchema>;

// ---- Foreman (auto-responder) ----

/**
 * Upsert a session's Foreman note. Every field is optional so a caller can patch
 * just the purpose (the common case) or the full brief/disposition; the server
 * merges over the existing row. At least one field must be present.
 */
export const SetNoteSchema = z
  .object({
    purpose: z.string().nullable().optional(),
    brief: z.string().nullable().optional(),
    recommendation: z.string().nullable().optional(),
    disposition: z.enum(["answered", "pending", "escalated", "skipped"]).optional(),
    lastAction: z.string().nullable().optional(),
    handledMarker: z.string().nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "empty note update" });
export type SetNote = z.infer<typeof SetNoteSchema>;

/**
 * Foreman's operating config. `dry-run` drafts answers without sending; `live`
 * sends on the human's behalf (only for repos on the allowlist); `semi-auto`
 * drafts a one-click-confirmable action. Ships disabled + dry-run.
 *
 * Only knobs a human should reason about live here (they're surfaced in
 * ForemanBar); operational timings are module constants with an env override,
 * following the FOREMAN_REVIEW_TIMEOUT_MS precedent.
 */
export const ForemanConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["dry-run", "live", "semi-auto"]).default("dry-run"),
  /** Repo roots Foreman may act in when live (realpaths). Empty = act nowhere live. */
  repoAllowlist: z.array(z.string()).default([]),
  /** Whether Foreman may auto-approve non-destructive access asks (still gated by risk). */
  autoApproveAccess: z.boolean().default(true),
  /**
   * The cheap-tier gate in front of the full `claude -p` reviewer (see
   * docs/plans/foreman-watcher/plan.md). `off` = every new marker gets a full review
   * (the pre-triage behaviour); `on` = a pure-code Tier 0 + Haiku Tier 1 dispose the
   * easy cases and only route the hard ones up to the full review; `shadow` = run both
   * the cheap tier and the full review, act on the full review, and log every
   * divergence so the cheap tier's accuracy is measured before it's trusted. Defaults
   * to `shadow` so the first ship gathers evidence rather than short-circuiting blind.
   */
  triage: z.enum(["off", "shadow", "on"]).default("shadow"),
  /**
   * Model id for the Tier 1 triage call (a cheap router, not the full reviewer). Falls
   * back to the FOREMAN_TRIAGE_MODEL env var, then a Haiku default, in the worker.
   */
  triageModel: z.string().optional(),
  /**
   * How many rounds the SAME gap may survive before the item escalates. Counted
   * per gap, not per attempt, so an agent working through several distinct gaps
   * isn't punished for finding more work.
   */
  maxFixAttempts: z.number().int().min(1).max(10).default(3),
  /**
   * Hard per-item round budget - the real termination guarantee. Per-gap strikes
   * are a heuristic (a reminted gap id resets them); this is not.
   */
  maxFixRounds: z.number().int().min(1).max(50).default(10),
});
export type ForemanConfig = z.infer<typeof ForemanConfigSchema>;

/** Partial update of the Foreman config from the dashboard. */
export const ForemanConfigPatchSchema = ForemanConfigSchema.partial().refine(
  (o) => Object.keys(o).length > 0,
  { message: "empty config update" },
);
export type ForemanConfigPatch = z.infer<typeof ForemanConfigPatchSchema>;

// ---- Foreman session work queues ----

/**
 * A worker's leased heartbeat. `workerId` identifies the process so the daemon
 * can tell "the leader renewed" from "a second worker is trying to take over" -
 * which the old bare heartbeat (one module-global timestamp) could not do at all:
 * it just got beaten twice, and two workers would both drain the fleet.
 */
export const ForemanHeartbeatSchema = z.object({
  workerId: z.string().min(1),
});
export type ForemanHeartbeat = z.infer<typeof ForemanHeartbeatSchema>;

/** The daemon's answer to a leased heartbeat: are you the leader, and until when. */
export interface ForemanLeaseResult {
  leader: boolean;
  expiresAt: number;
  /** The worker that currently holds the lease (yours or someone else's). */
  holder: string;
}

/** Cap on an item's intent: it gets typed into a pane, so it can't be unbounded. */
const INTENT_MAX = 8000;

/**
 * Cap on one repo-relative path in a request. The OS won't hand out a longer one -
 * this matches the tightest mainstream PATH_MAX (darwin's 1024; linux allows 4096) -
 * and these are relative to the repo root, so a real path has room to spare.
 */
const REQUEST_PATH_MAX = 1024;
/**
 * Cap on how many paths one request may carry. Sits above `readStandards`'s own
 * MAX_CHANGED_PATHS (1000), which reports what it dropped - so the schema bounds the
 * request without pre-empting the honest truncation the bundle already reports.
 */
const MAX_REQUEST_PATHS = 5000;

/** Add one work item to a session's queue. */
export const AddWorkItemSchema = z.object({
  intent: z.string().min(1).max(INTENT_MAX),
});
export type AddWorkItem = z.infer<typeof AddWorkItemSchema>;

/**
 * Edit a waiting item. `revision` is a compare-and-swap token, not decoration:
 * without it the UI would happily let someone edit an item Foreman has already
 * typed into a pane. The route 409s when it doesn't match (or the item has left
 * `queued`/`proposed`).
 */
export const EditWorkItemSchema = z.object({
  intent: z.string().min(1).max(INTENT_MAX),
  revision: z.number().int().min(0),
});
export type EditWorkItem = z.infer<typeof EditWorkItemSchema>;

/** Reorder a queue: the full id list in the new authored order, renumbered in a txn. */
export const ReorderQueueSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});
export type ReorderQueue = z.infer<typeof ReorderQueueSchema>;

/**
 * The repo-relative paths an item's diff touched - which standards docs apply.
 *
 * A body rather than `path=` query params because the list is derived from a patch
 * capped at 1.2MB and so has no small bound: encoded into a URL, a large refactor's
 * paths overrun Node's default 16KB header limit and the request never arrives.
 * `readStandards` bounds how many it will actually walk, and reports the drop.
 */
export const StandardsRequestSchema = z.object({
  /**
   * Both bounds are load-bearing, and the per-string one especially so.
   *
   * `readStandards` climbs `dirname` from every path to the repo root, pushing an
   * entry per level, so its cost is quadratic in a path's DEPTH - and
   * MAX_CHANGED_PATHS bounds only how many paths it walks, never how deep any one of
   * them goes. A single ~16KB path of nested segments blocks the daemon's event loop
   * for seconds and a slightly longer one exhausts its heap, taking the whole fleet
   * down with it. The routes are loopback-only so this is hardening rather than a
   * live exploit, but an unbounded array of unbounded strings is out of step with
   * every sibling schema here, and no real path notices the bound.
   *
   * They bound one path's depth and the number of paths; they do NOT bound the
   * PRODUCT, which is what the climb actually costs. `readStandards` owns that with
   * MAX_WALKED_DIRS - the bound has to live where the walking happens.
   */
  paths: z.array(z.string().max(REQUEST_PATH_MAX)).max(MAX_REQUEST_PATHS),
});
export type StandardsRequest = z.infer<typeof StandardsRequestSchema>;

/**
 * Cap on a recorded base sha. A full sha is 40 hex chars and the worker sources this
 * from `rev-parse`, so this is pure headroom - it exists so the two routes that write
 * the identical field bound it identically.
 */
const BASE_SHA_MAX = 64;

/**
 * The worker's durable state write for one item. Everything the machine decides
 * lands through here, so the daemon stays the only writer of the DB.
 *
 * `sentAt` and `recoveredAt` are deliberately ABSENT: both are clocks the server
 * owns. `sentAt` is compared against `lastActivity` (which the registry stamps
 * from the hook payload) to detect pickup, so the two must share a clock - the
 * `/inject`-then-`markSent` and `/recover` routes stamp them, keeping that true by
 * construction rather than by coincidence.
 */
export const SetWorkItemStateSchema = z
  .object({
    state: z
      .enum([
        "queued",
        "proposed",
        "sending",
        "awaiting_pickup",
        "in_progress",
        "verifying",
        "verified",
        "escalated",
        "cancelled",
      ])
      .optional(),
    round: z.number().int().min(0).optional(),
    baseSha: z.string().max(BASE_SHA_MAX).nullable().optional(),
    transcriptAnchor: z.number().int().min(0).nullable().optional(),
    gaps: z
      .array(
        z.object({
          id: z.string().min(1),
          severity: z.enum(["blocking", "advisory"]),
          kind: z.enum(["incomplete", "untested", "standards", "regression"]),
          path: z.string(),
          detail: z.string(),
          fix: z.string(),
          strikes: z.number().int().min(0),
          firstSeenRound: z.number().int().min(0),
        }),
      )
      .optional(),
    sendAttempts: z.number().int().min(0).optional(),
    verifyFailures: z.number().int().min(0).optional(),
    escalationReason: z.string().nullable().optional(),
    lastVerdict: z.string().nullable().optional(),
    proposedPayload: z.string().nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "empty item update" });
export type SetWorkItemState = z.infer<typeof SetWorkItemStateSchema>;

/**
 * Cap on a note key in a request. A key is `agentSessionId ?? syntheticId` - a UUID
 * or a short synthetic token - so this is orders of magnitude of headroom, and it
 * keeps an unbounded string out of a SQL lookup + a `Set` probe on the daemon's one
 * synchronous handle.
 */
const NOTE_KEY_MAX = 256;

/**
 * Stamp an item as delivered, with the evidence scope it was sent at.
 *
 * Schema'd rather than hand-checked because `transcriptAnchor` is a BOUND, not a
 * shape: an unvalidated negative anchor doesn't reach `readSync` (the transcript
 * route guards `since >= 0`) - it falls through to the default head+tail window, so
 * the verify scope silently degrades from "this item's turns" to "the last 48
 * turns". A verifier judging cumulative work it was never scoped to invents gaps,
 * which is exactly the quiet fail-open the evidence-first design exists to avoid.
 * `SetWorkItemStateSchema` already validates this identical field this identical way.
 */
export const MarkItemSentSchema = z.object({
  baseSha: z.string().max(BASE_SHA_MAX).nullable().default(null),
  transcriptAnchor: z.number().int().min(0).nullable().default(null),
});
export type MarkItemSent = z.infer<typeof MarkItemSentSchema>;

/** Re-attach an orphaned queue onto a live session: the key to move off. */
export const ReattachQueueSchema = z.object({
  noteKey: z.string().min(1).max(NOTE_KEY_MAX),
});
export type ReattachQueue = z.infer<typeof ReattachQueueSchema>;

/** Record the human's answer to the drain-time wrap-up ask. */
export const WrapupSchema = z.object({
  // INTENT_MAX like every sibling that carries human text, and for the same reason:
  // the answer is delivered into a pane. The panel injects it (already capped) before
  // recording it here, so today that bound is incidental to the flow rather than
  // enforced at the boundary - and the boundary is where it belongs, since this value
  // is persisted and re-served on every queue read the worker polls.
  answer: z.string().max(INTENT_MAX).nullable(),
});
export type Wrapup = z.infer<typeof WrapupSchema>;

/**
 * Deliver a whole (possibly multi-line) prompt into a session's input as ONE
 * submission, via bracketed paste. Distinct from SendTextSchema because `/send`
 * is literal `send-keys -l`, where every embedded newline submits - so it cannot
 * deliver a multi-line intent or a bulleted gap list at all.
 */
export const InjectPromptSchema = z.object({
  text: z.string().min(1).max(INTENT_MAX),
});
export type InjectPrompt = z.infer<typeof InjectPromptSchema>;
