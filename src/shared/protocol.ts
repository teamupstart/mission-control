import { z } from "zod";
import { WRAPUP_MODES, WRAPUP_TRIGGERS } from "./queue.ts";
import { MAX_LABELS, TASK_PRIORITIES, normalizeLabels } from "./task.ts";

/**
 * `normalizeLabels`, but absent stays absent.
 *
 * On the create schema an omitted list defaulting to `[]` is right - a new task has no
 * labels. On a PATCH it is not: `[]` means "clear them" and undefined means "leave
 * them", and collapsing the two would make every priority-only patch wipe the labels.
 */
const normalizeLabelsOrUndefined = (v: string[] | undefined): string[] | undefined =>
  v === undefined ? undefined : normalizeLabels(v);

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

/** One rate-limit window as the statusLine forwarder normalizes it. `resetsAt` is epoch SECONDS. */
const RateLimitWindowSchema = z.object({
  usedPercentage: z.number(),
  resetsAt: z.number(),
});

/**
 * Normalized status-line payload the forwarder posts to the daemon. Claude Code
 * pipes a rich JSON blob to the configured statusLine command on every render;
 * our forwarder (hooks/harness-statusline.mjs) lifts the fields we care about
 * into this flat, camelCased shape - model, context window, reasoning effort, and
 * the subscription's rate limits - plus the terminal env used to bind it to a
 * discovered session. Everything but `env` is optional so an older Claude Code that
 * omits a field still validates.
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
  /**
   * The subscription's rate-limit windows, lifted from `payload.rate_limits`.
   *
   * The ONLY local source of a real subscription's limits - OpenTelemetry has no quota
   * metric, which is why the statusLine wrapper is still in the cost design at all.
   * Cost is pointedly NOT taken from here even though the payload carries it: OTel owns
   * cost, and one source per fact is what keeps two numbers from disagreeing on screen.
   *
   * Every level is optional because every level is genuinely absent for someone: an
   * API-key user has no `rate_limits` at all, a session that has not yet had an API
   * response has the key but no windows, and the two windows arrive independently.
   */
  rateLimits: z
    .object({
      fiveHour: RateLimitWindowSchema.nullable().optional(),
      sevenDay: RateLimitWindowSchema.nullable().optional(),
    })
    .optional(),
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
 * Select a row of the option menu a session is showing (a permission prompt, an
 * `AskUserQuestion` menu). Its own endpoint rather than a flag on `SendTextSchema`, because
 * it is not a message: nothing is typed, and the daemon re-reads the pane and refuses unless
 * the row still reads as `label` before it confirms anything (see `selectPaneOption`).
 *
 * `label` is required for exactly that check. Without it the payload would be a bare
 * position on a screen that may have repainted since the caller looked - which is how a
 * confident, well-formed request confirms the wrong row.
 */
export const SelectOptionSchema = z.object({
  number: z.number().int().min(1).max(99),
  label: z.string().min(1),
});
export type SelectOption = z.infer<typeof SelectOptionSchema>;

/**
 * Fill in and send a multi-select `AskUserQuestion` - the form that `SelectOptionSchema`
 * cannot express, because a form is answered by its whole state rather than by one row.
 *
 * Every checkbox row is sent, ticked or not, not just the ones the human changed. The
 * daemon diffs that against a fresh read of the pane and toggles only what differs, so
 * what crosses the wire is the ANSWER ("Alpha and Gamma, nothing else") rather than a list
 * of keystrokes to replay - which is what keeps a box someone ticked in the terminal
 * meanwhile from being silently inverted by a click made before it.
 *
 * `label` carries the same weight as it does above, and each row is re-checked against the
 * screen before anything is typed.
 */
export const SubmitOptionsSchema = z.object({
  options: z
    .array(
      z.object({
        number: z.number().int().min(1).max(99),
        label: z.string().min(1),
        checked: z.boolean(),
      }),
    )
    .min(1)
    .max(99),
});
export type SubmitOptions = z.infer<typeof SubmitOptionsSchema>;

/**
 * How far a submitted form actually got, returned alongside `ok`.
 *
 * A success here is not always a send, and the difference is the human's to see: the boxes
 * are ticked in all three, but only `submitted` reached Claude. The other two are Claude
 * having more to ask ("next-question") or refusing to call the form complete
 * ("unanswered"), both of which leave it on screen with something still to do.
 *
 * WHERE it is left on screen is the daemon's to say, not the outcome's - an `unanswered`
 * that could be walked back to the question and one stranded on the review tab are the
 * same outcome and different situations - so the response may also carry a `note` that
 * replaces the sentence the outcome alone would produce.
 */
export type FormOutcome = "submitted" | "next-question" | "unanswered";

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

/** One selectable choice within a `PlanDecision`. */
export const PlanDecisionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().optional(),
  recommended: z.boolean().optional(),
});

/** One question the human answers when resolving a `plan-decisions` review. */
export const PlanDecisionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(PlanDecisionOptionSchema).min(1),
  multiSelect: z.boolean().optional(),
  allowOther: z.boolean().optional(),
});
export type PlanDecisionInput = z.infer<typeof PlanDecisionSchema>;

/**
 * An MCP-driven agent creating a review item bound to its session's pane.
 *
 * A `plan-decisions` review must carry at least one decision: the whole point of the
 * kind is that the human answers something, and a decision-less one would reach the
 * dashboard as a form that can only resolve the review on an empty response.
 */
export const CreateReviewSchema = z
  .object({
    env: EnvSchema,
    sessionId: z.string().nullable().optional().default(null),
    cwd: z.string().nullable().optional().default(null),
    kind: z.enum(["plan", "diff", "input", "plan-decisions"]),
    title: z.string().min(1),
    body: z.string(),
    // Present only for kind `plan-decisions`; the questions the human answers.
    decisions: z.array(PlanDecisionSchema).optional(),
  })
  .refine((r) => r.kind !== "plan-decisions" || (r.decisions?.length ?? 0) > 0, {
    message: "kind 'plan-decisions' requires at least one decision",
    path: ["decisions"],
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
 * The two optional triage fields every task-writing schema shares, spread into both
 * `DispatchSchema` and `UpdateTaskSchema` so a task created by the dispatch form, a
 * task source, or a retriage PATCH is validated by exactly one definition.
 *
 * `labels` normalizes in the SCHEMA rather than at a call site: `parseBody` is the
 * only door into a mutating route, so putting the transform here means no writer can
 * reach the DB with duplicated, untrimmed or unbounded tags - including the task
 * sources that will write these without a human in the loop. The pre-transform
 * `.max()` bounds the array before it is walked, so a huge POST is rejected rather
 * than silently truncated.
 */
const TASK_TRIAGE_FIELDS = {
  priority: z.enum(TASK_PRIORITIES).nullable().optional().default(null),
  labels: z.array(z.string()).max(MAX_LABELS).optional().default([]).transform(normalizeLabels),
};

/**
 * A model id, in the only shape that is safe to hand to a harness CLI.
 *
 * This value ends up as an argument on a `tmux new-session` command line, which
 * tmux joins with spaces and runs through a shell - so anything quotable or
 * glob-able here would be a shell injection, not a typo. Every real Claude and
 * Codex id is `[a-z0-9]` plus dots and dashes (`claude-opus-4-8`, `gpt-5.6-sol`),
 * so constraining to that costs nothing and closes the hole at the edge, before
 * the id is stored. Note this deliberately excludes Claude's `[1m]` long-context
 * marker: the CLI takes the bare id and picks the window itself.
 */
export const ModelIdSchema = z
  .string()
  .max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "model id must be alphanumeric with . _ - only");

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
  /**
   * Run this agent on a specific model instead of the harness default. Omitted
   * means "whatever `harnesses.defaultModel` says at dispatch time" - which is
   * not the same as pinning today's default, and is what lets a backlogged task
   * pick up a default changed after it was shelved.
   */
  model: ModelIdSchema.optional(),
  backlog: z.boolean().optional().default(false),
  ...TASK_TRIAGE_FIELDS,
});
export type Dispatch = z.infer<typeof DispatchSchema>;

/**
 * Resolve a typed path to a canonical git repo root, so the Foreman allowlist
 * picker can reject a typo before it enters the trusted-repos list.
 */
export const ResolveRepoSchema = z.object({
  path: z.string().min(1),
});

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

/**
 * Edit a task - what the dispatch modal sends when it is reopened on a backlog card,
 * and what the backlog column's priority picker sends.
 *
 * Every field is optional and the server merges over the stored row, so a caller can
 * correct just the intent without restating the repo. `title` is the one field where
 * empty is meaningful rather than absent: clearing it asks for a title to be derived
 * again from the intent as it now reads, the same bargain the create form offers.
 *
 * The fields are NOT equivalent, and `TaskManager.update` treats them differently.
 * `repoRoot`, `intent`, `title`, `kind`, `agent` and `model` are PROVISIONING fields -
 * repo, intent and title are cut into a branch name and a tmux session at dispatch and
 * cannot be rewritten afterwards, and the model is baked into the launched command line -
 * so a patch touching any of them is refused once the task has left the backlog.
 * `priority` and `labels` are pure annotation that nothing is provisioned from, so they
 * can be changed at any point in a task's life, including while its agent is running.
 *
 * `priority` is `.optional()` WITHOUT the create schema's `.default(null)`: here an
 * absent key has to keep meaning "leave it alone", and a default would turn every patch
 * that didn't mention priority into one that silently cleared it.
 *
 * `model` is nullable for the same reason: an absent field leaves the stored override
 * alone, while an explicit `null` takes it back off - which is the only way to say
 * "follow the harness default again" about a row that already names a model.
 */
export const UpdateTaskSchema = z
  .object({
    repoRoot: z.string().min(1).optional(),
    intent: z.string().min(1).optional(),
    title: z.string().optional(),
    kind: z.enum(["ship", "scout"]).optional(),
    agent: z.enum(["claude", "codex"]).optional(),
    priority: z.enum(TASK_PRIORITIES).nullable().optional(),
    labels: z.array(z.string()).max(MAX_LABELS).optional().transform(normalizeLabelsOrUndefined),
    model: ModelIdSchema.nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "empty task update" });
export type UpdateTask = z.infer<typeof UpdateTaskSchema>;

/** True when this patch only re-describes a task, so no status guard applies. */
export function isAnnotationOnlyUpdate(patch: UpdateTask): boolean {
  return Object.keys(patch).every((k) => k === "priority" || k === "labels");
}

/** Hand a backlog task to an agent that is already running (the board's drag-to-dispatch). */
export const AssignTaskSchema = z.object({
  sessionId: z.string().min(1),
});
export type AssignTask = z.infer<typeof AssignTaskSchema>;

/**
 * Store Foreman's reading of the backlog (see `BacklogPlan`).
 *
 * Written by the worker, which is the only thing that can produce it, and read by the
 * board. `generatedAt` is NOT accepted from the caller - the daemon stamps it, so the
 * "planned N minutes ago" the board shows cannot be back-dated by a worker with a
 * skewed clock, or by a replay of an old body.
 *
 * The shape is permissive about the graph on purpose: cycles, self-references and
 * dangling ids are refused by `sanitizePlan` BEFORE the worker posts, because those
 * are judgments about the current task list that a wire schema cannot make. What this
 * schema guarantees is only that the stored value has the shape every reader assumes.
 *
 * The entry cap is a bound on the stored row, and it sits ABOVE `PLANNABLE_LIMIT`
 * (src/shared/backlog.ts), which is what the worker actually plans up to. The order
 * matters: a plan the schema refuses is a write that fails every time, so a limit above
 * this cap would turn a long backlog into a permanently failing write.
 */
export const BacklogPlanSchema = z.object({
  entries: z
    .array(
      z.object({
        taskId: z.string().min(1),
        dependsOn: z.array(z.string().min(1)).default([]),
        reason: z.string().nullable().optional().default(null),
      }),
    )
    .max(500),
  note: z.string().nullable().optional().default(null),
});
export type BacklogPlanInput = z.infer<typeof BacklogPlanSchema>;

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
 * Record one Foreman decision, with the context that produced it.
 *
 * The append-only counterpart to `SetNoteSchema`, and unlike it NOT a patch: an
 * episode is written once, whole, by the worker at the moment it acted, from state
 * it is about to drop. A merge-patch shape would invite a caller to fill it in over
 * several calls, and the fields that matter most (`pane`, `question`) have no second
 * chance to arrive - the pane is read once and discarded.
 *
 * `marker` is required and is the identity: paired with the session's note key it is
 * unique, so re-posting the same marker updates that episode rather than adding one.
 */
export const RecordEpisodeSchema = z.object({
  marker: z.string().min(1),
  situation: z.string().min(1),
  surface: z.enum(["input-review", "terminal"]),
  question: z.string(),
  pane: z.string().nullable().optional(),
  menu: z
    .object({
      options: z.array(z.object({ number: z.number(), label: z.string() })),
      highlighted: z.number(),
    })
    .nullable()
    .optional(),
  reviewId: z.string().nullable().optional(),
  purpose: z.string().nullable().optional(),
  brief: z.string().nullable().optional(),
  recommendation: z.string().nullable().optional(),
  classification: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  tier: z.number().nullable().optional(),
  disposition: z.enum(["answered", "pending", "escalated", "skipped"]),
  lastAction: z.string().nullable().optional(),
  sentText: z.string().nullable().optional(),
  sentOption: z.object({ number: z.number(), label: z.string() }).nullable().optional(),
  sentBy: z.enum(["foreman", "you"]).nullable().optional(),
});
export type RecordEpisode = z.infer<typeof RecordEpisodeSchema>;

/**
 * Stamp the human's answer onto an episode Foreman left open.
 *
 * Deliberately narrow: the dashboard knows which episode it is answering and what it
 * just did, and nothing else. It never saw the pane or the question, so it is given
 * no way to write them - which is what keeps the captured context immutable once the
 * worker has recorded it.
 */
export const ResolveEpisodeSchema = z.object({
  marker: z.string().min(1),
  disposition: z.enum(["answered", "pending", "escalated", "skipped"]),
  sentText: z.string().nullable().optional(),
});
export type ResolveEpisode = z.infer<typeof ResolveEpisodeSchema>;

/**
 * Patch a session's Goal. Separate from SetNoteSchema because the two records have
 * different writers and different lifecycles (see `SessionGoal`); merged the same way, so
 * capturing a prompt never clears the sentence derived from an earlier one.
 *
 * `updatedAt` is NOT accepted from a caller: the server stamps it when the sentence
 * actually changes, so it cannot drift from the value it describes or be back-dated.
 */
export const SetGoalSchema = z
  .object({
    text: z.string().nullable().optional(),
    source: z.enum(["heuristic", "model"]).nullable().optional(),
    prompt: z.string().nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "empty goal update" });
export type SetGoal = z.infer<typeof SetGoalSchema>;

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
   * back to the FOREMAN_TRIAGE_MODEL env var, then a Haiku default.
   *
   * All four model fields resolve through one shared ladder - `resolveForemanModel`
   * (`@shared/foreman-models.ts`) - so the worker's `--model` and the settings panel's
   * readout can never disagree. Empty means "fall through", not "spawn with no model".
   */
  triageModel: z.string().optional(),
  /**
   * Model id for the full reviewer - the call that judges a stuck session's pending
   * question. Falls back to FOREMAN_REVIEW_MODEL, then an Opus default.
   *
   * Before this existed the reviewer passed no `--model` at all and silently inherited
   * whatever the `claude` CLI was logged in as, which made the question "what does
   * Foreman run as?" unanswerable. See `FOREMAN_MODEL_SPECS`.
   */
  reviewModel: z.string().optional(),
  /**
   * Model id for the work-queue verifier - the call that reads a diff and decides
   * whether an item is done. Falls back to FOREMAN_VERIFY_MODEL, then an Opus default.
   *
   * Separate from `reviewModel` despite the same default: the verifier runs once per
   * queued item on a repo diff, so it is the one most worth stepping down when a queue
   * is long, and doing that must not also cheapen the reviewer.
   */
  verifyModel: z.string().optional(),
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
  /**
   * WHICH moments count as "this session has finished its work" and should wrap up.
   * Independent of `wrapup`, which says what to DO at whichever moment fires.
   *
   * Defaults to `["drain"]` alone - the shipped behaviour - so an existing install
   * upgrades without silently arming a second, unattended trigger on every session
   * it was never watching before. `prompted` is opt-in for exactly that reason.
   *
   * An empty list means "never wrap up automatically" and is honoured as written; it
   * is NOT treated as unset. Someone running the work queue who wants to ship by hand
   * has no other way to say so, and quietly restoring a default here would type into
   * their sessions against an explicit choice.
   */
  wrapupTriggers: z.array(z.enum(WRAPUP_TRIGGERS)).default(["drain"]),
  /**
   * What happens when a wrap-up fires, whichever trigger fired it.
   *
   * `ask` is the shipped behaviour and the default: Foreman marks the moment and the
   * human picks from the Wrapup card. `no-mistakes` and `pr` let Foreman type that
   * instruction itself, unattended - the difference between the two is only which
   * text gets sent (see `autoWrapupPayload`).
   *
   * Automating this is strictly more dangerous than the per-item send it resembles,
   * because the instruction PUSHES: `/no-mistakes` opens a PR at the end of its
   * pipeline. So the auto path carries every gate the manual one does and one more -
   * it is refused outright unless `mode` is live AND the repo is on the allowlist
   * (`mayActLive`), exactly like a queue send. Setting this to `no-mistakes` while
   * in dry-run does NOT type; it degrades to `ask`. Dry-run means dry-run.
   */
  wrapup: z.enum(WRAPUP_MODES).default("ask"),
  /**
   * Whether Foreman schedules the BACKLOG on its own - reading every item, working out
   * what depends on what, and then handing one at a time to an idle agent or to a fresh
   * worktree (see docs/plans/backlog-autopilot/plan.md).
   *
   * Off by default, and - like `wrapup`'s automated actions - it only ever ACTS in live
   * mode on an allowlisted repo. Launching an agent starts unattended work, and
   * assigning to an existing one types a whole task into a pane a human may be sitting
   * in front of; both are strictly more consequential than answering a prompt. In
   * dry-run and semi-auto it still plans, so the board can show what it would take next
   * and the human can click it themselves. Dry-run means dry-run.
   */
  autoBacklog: z.boolean().default(false),
  /**
   * The ceiling on how many agents may be running at once before the backlog autopilot
   * stops launching new ones.
   *
   * Counts EVERY live agent session on the machine plus the tasks still mid-provision,
   * not just the ones Mission launched: "max agents" is a claim about the machine's
   * load, and a count that ignored six hand-started sessions would not be one.
   *
   * It bounds AUTOPILOT only - it never refuses a dispatch a human clicked. Blocking a
   * button you pressed because a background scheduler had reserved the budget is a
   * worse surprise than briefly running over the line.
   */
  maxSessions: z.number().int().min(1).max(20).default(3),
  /**
   * Model id for the backlog dependency read. Falls back to the FOREMAN_BACKLOG_MODEL
   * env var, then a Sonnet default. Not the triage router's model: this is a judgment
   * call over prose the human wrote, not a bucketing.
   */
  backlogModel: z.string().optional(),
});
export type ForemanConfig = z.infer<typeof ForemanConfigSchema>;

/** Partial update of the Foreman config from the dashboard. */
export const ForemanConfigPatchSchema = ForemanConfigSchema.partial().refine(
  (o) => Object.keys(o).length > 0,
  { message: "empty config update" },
);
export type ForemanConfigPatch = z.infer<typeof ForemanConfigPatchSchema>;

/**
 * Away mode: what happens while you're away from the machine.
 *
 * Durable and server-side rather than a localStorage flag, for two reasons. The
 * stall detector's input is elapsed `lastActivity`, which `sessionEqual`
 * deliberately excludes from the SSE change comparison - so a client-side
 * detector is blind to the one signal it needs. And away mode is precisely the
 * feature that must survive the tab closing.
 *
 * Thresholds live here rather than as module constants because they are the knob
 * a human actually reasons about ("don't nag me for 20 minutes"), which is the
 * same line ForemanConfigSchema draws.
 */
export const AwayConfigSchema = z.object({
  /** Whether you are away right now. */
  away: z.boolean().default(false),
  /** When away mode was entered (epoch ms), or null. Bounds the return digest. */
  awaySince: z.number().nullable().default(null),
  /**
   * Whether stall detection runs at all. Independent of `away` on purpose: being
   * told an agent is wedged is useful at the desk too, and coupling them would
   * make the feature untestable without pretending to leave.
   */
  detectStalls: z.boolean().default(true),
  /** Minutes of silence before an instrumented, working session reads as stuck. */
  stallWorkingMinutes: z.number().int().min(1).max(240).default(10),
  /** Minutes idle, with work still outstanding, before a session reads as stuck. */
  stallUnfinishedMinutes: z.number().int().min(1).max(240).default(20),
  /** Minutes a parked gate may wait on you before it reads as stuck. */
  stallGateMinutes: z.number().int().min(1).max(240).default(5),
  /** Minutes an unanswered Foreman escalation may sit before it reads as stuck. */
  stallEscalationMinutes: z.number().int().min(1).max(240).default(5),
});
export type AwayConfig = z.infer<typeof AwayConfigSchema>;

/**
 * Foreman's standing instructions - the prose half of its configuration, edited as one
 * document rather than as fields.
 *
 * A separate route and schema from `ForemanConfigPatch` on purpose. That one carries knobs
 * that grant AUTHORITY (may Foreman type, in which repos, may it approve access asks); this
 * carries prose that shapes JUDGEMENT. Keeping them apart is what stops a sentence in a text
 * box from doing a switch's job - see `PREFS_FRAMING`.
 *
 * `reset` and `text` are distinct operations because empty is a real value: an operator who
 * clears the box wants Foreman judging by its own policy alone, which is not the same as
 * wanting the shipped default back.
 */
export const ForemanInstructionsSchema = z
  .object({
    /** The new document. Ignored when `reset` is true. */
    text: z.string().max(64_000).optional(),
    /** Drop the stored value so the shipped `FOREMAN.md` applies again. */
    reset: z.boolean().default(false),
  })
  .refine((o) => o.reset || typeof o.text === "string", {
    message: "provide `text`, or `reset: true`",
  });
export type ForemanInstructionsUpdate = z.infer<typeof ForemanInstructionsSchema>;

/** Partial update of the away config from the dashboard. */
export const AwayConfigPatchSchema = AwayConfigSchema.partial().refine(
  (o) => Object.keys(o).length > 0,
  { message: "empty away update" },
);
export type AwayConfigPatch = z.infer<typeof AwayConfigPatchSchema>;

// ---- Custom skills (dashboard-wide skill toggles) ----

/**
 * Which catalog skills are symlinked into `~/.claude/skills`, and how far the sessions
 * have been told about it. Same partial-patch shape as ForemanConfig, over the same
 * `app_config` KV, so a new key needs no migration.
 *
 * Ships with the master switch OFF and nothing enabled: this writes into the
 * operator's global claude config and changes what the model does in every session
 * on the machine, including ones the harness never launched. That is the point of
 * the feature, and it is also why it is never on by default.
 */
export const SkillsConfigSchema = z.object({
  /** Master switch. Off symlinks NOTHING, whatever `skills` says. */
  enabled: z.boolean().default(false),
  /** Catalog id -> enabled. Ids absent from the catalog are ignored, not an error. */
  skills: z.record(z.boolean()).default({}),
  /**
   * The reload watermark - the whole coalescing story, and a WATERMARK, NOT A QUEUE.
   *
   * A session never needs more than one reload to become current no matter how many
   * skills were flipped: `/reload-skills` re-reads the directory, so one reload reads
   * whatever is there NOW. Flip five skills in ten seconds and this lands at 5; a
   * session that reloads once is done. A queue would have typed five commands into
   * every pane.
   *
   * Bumped ONLY when the reconciler actually changed the symlink set - never on any
   * config write. Bumping it on an unrelated write would reload every session, and
   * each reload writes a command and its response into a session's context.
   */
  generation: z.number().int().default(0),
  /**
   * When `generation` last moved (epoch ms). Not decoration: it is what stops a
   * session that booted AFTER the change from being told to pick it up.
   *
   * Claude scans `~/.claude/skills` at startup, so a session whose process started
   * once the symlink was already on disk loaded the current set by construction and
   * has nothing to reload. Without this, every newly discovered session - forever -
   * would have an unsolicited `/reload-skills` typed into it the first time it went
   * idle, because it has no ack row and `0 < generation`.
   */
  generationAt: z.number().int().default(0),
});
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

/** Partial update of the skills config from the dashboard. */
export const SkillsConfigPatchSchema = SkillsConfigSchema.pick({ enabled: true, skills: true })
  .partial()
  .refine((o) => Object.keys(o).length > 0, { message: "empty config update" });
export type SkillsConfigPatch = z.infer<typeof SkillsConfigPatchSchema>;

// ---- Harnesses (dispatch-time defaults for launched sessions) ----

/**
 * Defaults the harness applies to the sessions IT dispatches - never to the
 * sessions it merely discovered. A schema-validated blob over the `app_config` KV,
 * exactly like ForemanConfig/SkillsConfig, so a new key needs no migration.
 *
 * The scoping is the whole contract: `autoModeOnDispatch` drives a session to `auto`
 * permission mode only on the dispatch path (see `Dispatcher.applyAutoMode`), so a
 * session the operator started themselves keeps whatever mode they chose. Ships off
 * because flipping a session into `auto` lets it act without stopping for prompts,
 * which is a posture the operator opts into, not a default.
 */
export const HarnessesConfigSchema = z.object({
  /**
   * When on, every Claude session dispatched from Mission Control is driven to `auto`
   * permission mode once it's ready, before its first prompt lands - so it works
   * through its task without pausing on permission prompts. Codex has no permission
   * mode, so it's untouched today; the setting is worded to admit codex support later.
   */
  autoModeOnDispatch: z.boolean().default(false),
  /**
   * The model each harness is launched on when a task doesn't name one, keyed by
   * agent because "the default model" is meaningless across harnesses - a Claude id
   * is not a thing Codex can run.
   *
   * `null` means "don't pass `--model` at all", which is not the same as naming the
   * CLI's current default: it defers to whatever the operator configured in the
   * harness itself (`~/.claude/settings.json`, `~/.codex/config.toml`, `/model`), and
   * keeps following it when that changes. That is the shipped value, so installing
   * this feature changes nothing about how agents launch until it's set.
   */
  defaultModel: z
    .object({
      claude: ModelIdSchema.nullable().default(null),
      codex: ModelIdSchema.nullable().default(null),
    })
    .default({ claude: null, codex: null }),
});
export type HarnessesConfig = z.infer<typeof HarnessesConfigSchema>;

/**
 * Partial update of the harnesses config from the dashboard.
 *
 * Spelled out rather than `HarnessesConfigSchema.partial()`, because `.partial()`
 * only reaches the top level: a `{defaultModel: {claude}}` patch would parse under
 * it, fill `codex` in from the inner `.default(null)`, and the shallow merge in
 * `setHarnessesConfig` would then wipe the codex default the caller never mentioned.
 * Here an omitted inner key stays omitted, and the server merges per-agent.
 */
export const HarnessesConfigPatchSchema = z
  .object({
    autoModeOnDispatch: z.boolean().optional(),
    defaultModel: z
      .object({
        claude: ModelIdSchema.nullable().optional(),
        codex: ModelIdSchema.nullable().optional(),
      })
      .optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "empty config update" });
export type HarnessesConfigPatch = z.infer<typeof HarnessesConfigPatchSchema>;

// ---- dashboard UI preferences ----

/**
 * Which arrangement the dashboard is in. Lives here rather than in `src/web/lib/layout.ts`
 * so the set of valid modes has ONE definition: the daemon validates a stored layout
 * against the same list the render switch branches on. The labels and descriptions stay
 * in the web lib - the daemon has no use for prose it never shows.
 */
export const LAYOUT_MODES = ["grid", "console", "board"] as const;
export const LayoutModeSchema = z.enum(LAYOUT_MODES);
/** Derived from the array, not from the schema, so reading it costs the web no zod. */
export type LayoutMode = (typeof LAYOUT_MODES)[number];

/**
 * The operator's dashboard preferences: layout, rebound chords, alert delivery, and
 * whether messages render as markdown. A schema-validated blob over the `app_config` KV,
 * exactly like ForemanConfig/SkillsConfig/HarnessesConfig, so a new key needs no migration.
 *
 * ONE key rather than four, unlike the settings sections above, and the difference is
 * server-side behaviour: skills writes symlinks, cost rewrites `~/.claude/settings.json`,
 * foreman drives a worker. These four are pure display preferences the daemon only stores,
 * so splitting them would buy four routes and four polls and nothing else.
 *
 * They lived in `localStorage` until the Mission Control rename reset all four at once -
 * that store is keyed by ORIGIN and by Electron profile, and both moved (see
 * `docs/plans/ui-settings-to-daemon/plan.md`). The daemon is the per-machine store these
 * always wanted; `localStorage` is now a disposable first-paint cache in `lib/uiCache.ts`.
 */
/**
 * The shipped preferences, as a PLAIN object - the one definition, which the schema
 * below reads its `.default()`s from.
 *
 * Plain rather than derived from the schema (`UiConfigSchema.parse({})`) because the web
 * needs these synchronously, before any fetch, to paint on a cold cache - and the web
 * bundle must not pull zod in to get them. That is not hypothetical: zod is absent from
 * `dist/web` today, and the only reason importing from this module is free is that
 * everything the web takes from it tree-shakes to a constant. Keep it that way.
 */
export const UI_CONFIG_DEFAULTS = {
  layout: "grid",
  keybindings: {},
  alerts: { notifications: false, sound: true },
  richText: true,
} as const;

export const UiConfigSchema = z.object({
  layout: LayoutModeSchema.default(UI_CONFIG_DEFAULTS.layout),
  /**
   * Rebound chords, as `ActionId -> chord`. Deliberately a loose record: `ActionId` is a
   * web-only concept (`src/web/lib/keybindings.ts` owns the action table, and the daemon
   * has no opinion on what is bindable), and `loadOverrides` already drops entries for
   * actions it doesn't know. Validating the id set here would mean a build that removed
   * an action could no longer READ its own config - it would 500 on a stored key instead
   * of ignoring it, which is the one failure mode this record must not have.
   */
  keybindings: z.record(z.string()).default(UI_CONFIG_DEFAULTS.keybindings),
  alerts: z
    .object({
      notifications: z.boolean().default(UI_CONFIG_DEFAULTS.alerts.notifications),
      sound: z.boolean().default(UI_CONFIG_DEFAULTS.alerts.sound),
    })
    .default(UI_CONFIG_DEFAULTS.alerts),
  /** Render agent/human turns as markdown. On by default: agents write markdown. */
  richText: z.boolean().default(UI_CONFIG_DEFAULTS.richText),
});
export type UiConfig = z.infer<typeof UiConfigSchema>;

/**
 * Partial update from the dashboard. A plain `.partial()` is right here, unlike
 * `HarnessesConfigPatchSchema`: every top-level field is owned whole by exactly one panel
 * (Layout sets `layout`, Keyboard sets `keybindings`, and so on), so replacing a named
 * field wholesale is what the caller means. Nothing merges per-key, so nothing can be
 * blanked by a patch that didn't mention it.
 */
export const UiConfigPatchSchema = UiConfigSchema.partial().refine(
  (o) => Object.keys(o).length > 0,
  { message: "empty config update" },
);
export type UiConfigPatch = z.infer<typeof UiConfigPatchSchema>;

/**
 * What the daemon reports back: the config, plus whether the operator has ever saved one.
 *
 * `configured` exists for exactly one job, and it is not decoration. On a cold origin the
 * dashboard offers to adopt whatever an older build left in `localStorage` under a
 * previous product name - and it must only do that when the daemon has NOTHING, or
 * opening the dashboard on a new port would push months-old strays over the settings the
 * operator is actually using. A bare `UiConfig` cannot express the difference: an unset
 * key parses to the defaults, which is byte-identical to deliberately choosing them.
 */
export const UiConfigViewSchema = z.object({
  configured: z.boolean(),
  config: UiConfigSchema,
});
export type UiConfigView = z.infer<typeof UiConfigViewSchema>;

// ---- cost telemetry ----

/**
 * Slowest and fastest export intervals we will write into a user's settings.
 *
 * The OTel SDK default is 60s, which makes a cost badge feel dead beside a context meter
 * that moves every render. Lower is livelier and costs one HTTP request per session on
 * the machine per interval - so the floor is where that stops being free. The ceiling is
 * the SDK default: anything slower is better expressed by turning the feature off.
 */
export const COST_EXPORT_INTERVAL_MIN_MS = 5_000;
export const COST_EXPORT_INTERVAL_MAX_MS = 60_000;

/**
 * The Cost settings section: whether we ask Claude Code for telemetry at all, how often,
 * and which number the fleet strip leads with. A schema-validated blob over `app_config`,
 * exactly like Foreman/Skills/Harnesses, so a new key needs no migration.
 *
 * `enabled` is not merely a display toggle - it is the thing that writes (or removes) the
 * `env` block in `~/.claude/settings.json`, which is the user's file. Off by default for
 * that reason: nothing edits their config until they ask.
 */
export const CostConfigSchema = z.object({
  /** Whether the OTel `env` block is installed in `~/.claude/settings.json`. */
  enabled: z.boolean().default(false),
  /** `OTEL_METRIC_EXPORT_INTERVAL`, in ms. */
  exportIntervalMs: z
    .number()
    .int()
    .min(COST_EXPORT_INTERVAL_MIN_MS)
    .max(COST_EXPORT_INTERVAL_MAX_MS)
    .default(15_000),
  /**
   * What the topbar strip leads with. `usd` is honest about being an estimate; `plan`
   * is the truer number for a Pro/Max subscriber, for whom the dollars are notional.
   */
  view: z.enum(["usd", "plan"]).default("usd"),
});
export type CostConfig = z.infer<typeof CostConfigSchema>;

/** Partial update of the cost config from the dashboard. */
export const CostConfigPatchSchema = CostConfigSchema.partial().refine(
  (o) => Object.keys(o).length > 0,
  { message: "empty config update" },
);
export type CostConfigPatch = z.infer<typeof CostConfigPatchSchema>;

/**
 * What the daemon reports back about the telemetry wiring, beyond the stored config.
 *
 * The config records intent; this records what is actually true of the user's
 * `settings.json` right now. They diverge for real reasons - a hand-edited file, an
 * install from a different checkout, a `CLAUDE_CODE_ENABLE_TELEMETRY` the user set
 * themselves - and a panel that showed only the intent would be confidently wrong.
 */
export interface CostTelemetryStatus {
  config: CostConfig;
  /** True when our `env` keys are present in `~/.claude/settings.json`. */
  installed: boolean;
  /**
   * True once ANY export has ever landed in the ledger.
   *
   * The difference between "configured" and "working", which `installed` alone cannot
   * tell you: the `env` block only reaches sessions started AFTER it was written, so the
   * ordinary first-run state is a correctly-installed feature that has recorded nothing
   * and will go on recording nothing until the user opens a new session. Without this the
   * panel would show a switch that is on beside a dashboard with no numbers on it, and
   * nothing to explain the gap.
   */
  receiving: boolean;
  /**
   * Set when `OTEL_METRICS_INCLUDE_SESSION_ID` reads false anywhere we can see it. That
   * value silently destroys per-session attribution - every datapoint arrives
   * unattributable and is dropped - so it is surfaced rather than diagnosed later.
   */
  sessionIdDisabled: boolean;
  /** Absolute path of the settings file we would edit, for the panel to name. */
  settingsPath: string;
}

/**
 * OTLP/HTTP JSON metrics, as Claude Code's exporter sends them to `POST /v1/metrics`.
 *
 * Deliberately LOOSE. This is Claude Code's wire shape, not ours: we validate only the
 * fields we actually read and leave everything else optional, so an upstream addition
 * never fails a whole export. The alternative - a strict mirror - would turn any change
 * on their side into total, silent data loss on ours.
 *
 * `asInt` accepts a string as well as a number because OTLP/JSON encodes 64-bit ints as
 * strings, and `timeUnixNano` (~1.78e18) is past `Number.MAX_SAFE_INTEGER` - it is read
 * as text and never parsed as a JS number. See `usage_ledger.window_end_ns`.
 */
export const OtlpMetricsSchema = z.object({
  resourceMetrics: z
    .array(
      z.object({
        scopeMetrics: z
          .array(
            z.object({
              metrics: z
                .array(
                  z.object({
                    name: z.string(),
                    sum: z
                      .object({
                        /** 1 = delta (Claude Code's default), 2 = cumulative. */
                        aggregationTemporality: z.number().optional(),
                        dataPoints: z
                          .array(
                            z.object({
                              asDouble: z.number().optional(),
                              asInt: z.union([z.number(), z.string()]).optional(),
                              startTimeUnixNano: z.union([z.string(), z.number()]).optional(),
                              timeUnixNano: z.union([z.string(), z.number()]).optional(),
                              attributes: z
                                .array(
                                  z.object({
                                    key: z.string(),
                                    value: z
                                      .object({ stringValue: z.string().optional() })
                                      .passthrough(),
                                  }),
                                )
                                .optional()
                                .default([]),
                            }),
                          )
                          .optional()
                          .default([]),
                      })
                      .optional(),
                  }),
                )
                .optional()
                .default([]),
            }),
          )
          .optional()
          .default([]),
      }),
    )
    .optional()
    .default([]),
});
export type OtlpMetrics = z.infer<typeof OtlpMetricsSchema>;

// ---- Foreman session work queues ----

/**
 * A worker's leased heartbeat. `workerId` identifies the process so the daemon
 * can tell "the leader renewed" from "a second worker is trying to take over" -
 * which the old bare heartbeat (one module-global timestamp) could not do at all:
 * it just got beaten twice, and two workers would both draacross the sessions.
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
   * for seconds and a slightly longer one exhausts its heap, taking every session
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
 * Stamp the wrap-up ask.
 *
 * `clearAnswer` says this ask opens a NEW question, so any recorded answer on the row
 * is an answer to a previous one and must go in the same write. Only the `prompted`
 * trigger sets it: that trigger fires once per episode, and its second episode lands on
 * a row that may already carry an answer (its own earlier auto-send, or a human's drain
 * answer) - and since the card renders only while `wrapupAnswer` is null, the stale
 * value would swallow the new ask outright. Optional, and absent by default, because the
 * DRAIN path must never set it: there the answer it would clear is the answer to the
 * very ask being raised.
 */
export const WrapupAskedSchema = z.object({
  clearAnswer: z.boolean().optional(),
});
export type WrapupAsked = z.infer<typeof WrapupAskedSchema>;

/**
 * Retire one episode of the `prompted` wrap-up trigger: the goal it just decided on.
 *
 * INTENT_MAX is generous headroom here, not a tight fit: this carries a whole captured
 * prompt, which `clampPrompt` has already bounded to ~4k upstream. The bound is about
 * weight rather than safety - unlike `WrapupSchema.answer` this value is never
 * delivered into a pane and is only ever compared for equality, so its content is
 * inert. It still belongs at the boundary, since it is persisted and re-served on
 * every queue read the worker polls.
 */
export const PromptedWrapupSchema = z.object({
  goal: z.string().min(1).max(INTENT_MAX),
});
export type PromptedWrapup = z.infer<typeof PromptedWrapupSchema>;

/**
 * Deliver a whole (possibly multi-line) prompt into a session's input as ONE
 * submission, via bracketed paste. Distinct from SendTextSchema because `/send`
 * is literal `send-keys -l`, where every embedded newline submits - so it cannot
 * deliver a multi-line intent or a bulleted gap list at all.
 */
export const InjectPromptSchema = z.object({
  text: z.string().min(1).max(INTENT_MAX),
  /**
   * Who is typing. Defaults to the human, because that's who almost every caller is and
   * because claiming to be Foreman is the answer that colours a turn - a caller that
   * forgets the field should under-claim, not over-claim.
   *
   * The daemon is the only place this is knowable at all: by the time the text reaches
   * the pane it's just keystrokes, and the transcript records it as a plain user turn
   * indistinguishable from one a person typed. Round 0 of a work item is the human's
   * intent delivered VERBATIM, so no marker can be added to the text itself.
   */
  origin: z.enum(["human", "foreman"]).default("human"),
});
export type InjectPrompt = z.infer<typeof InjectPromptSchema>;
