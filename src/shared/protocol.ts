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

/** MCP `report_status`: update the session's activity line. */
export const StatusSchema = z.object({
  env: EnvSchema,
  sessionId: z.string().nullable().optional().default(null),
  activity: z.string().min(1),
});
export type StatusReport = z.infer<typeof StatusSchema>;

/**
 * Dispatch (or queue) a new agent: launch an agent in an isolated worktree of
 * `repoRoot` with `intent` as its first prompt. `queue: true` only adds it to the
 * backlog (no worktree/session yet); dispatch it later.
 */
export const DispatchSchema = z.object({
  repoRoot: z.string().min(1),
  intent: z.string().min(1),
  title: z.string().optional(),
  kind: z.enum(["ship", "scout"]).default("ship"),
  agent: z.enum(["claude", "codex"]).default("claude"),
  queue: z.boolean().optional().default(false),
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
});
export type ForemanConfig = z.infer<typeof ForemanConfigSchema>;

/** Partial update of the Foreman config from the dashboard. */
export const ForemanConfigPatchSchema = ForemanConfigSchema.partial().refine(
  (o) => Object.keys(o).length > 0,
  { message: "empty config update" },
);
export type ForemanConfigPatch = z.infer<typeof ForemanConfigPatchSchema>;
