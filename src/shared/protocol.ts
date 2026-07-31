import { z } from "zod";
import { WRAPUP_MODES, WRAPUP_TRIGGERS } from "./queue.ts";
import { MAX_LABELS, TASK_PRIORITIES, normalizeLabels } from "./task.ts";
import { TaskSourcesConfigSchema } from "./task-source.ts";
import { CHEAP_ACTIONS, DIVERGENCE_KINDS } from "./foreman.ts";
import { LLM_JOB_IDS } from "./llm-jobs.ts";
import { LLM_RUNNER_IDS } from "./llm.ts";
import { OPEN_TARGET_IDS } from "./open-targets.ts";
import { TERMINAL_BACKEND_IDS } from "./terminal.ts";
import { AGENT_TYPES, SESSION_RUNTIMES, THINKING_LEVELS } from "./types.ts";
import { supportsEffort } from "./harness-capabilities.ts";
import { INSPECTOR_LIMITS } from "./inspector.ts";
import {
  DEFAULT_WORKFLOW_BINDING_DEFAULTS,
  DEFAULT_WORKFLOW_CONFIG,
  DEFAULT_WORKFLOW_RESUMPTION_POLICY,
  EVIDENCE_REF_KINDS,
  INSPECTOR_FINDINGS_POLICIES,
  WORKFLOW_BINDING_STATES,
  WORKFLOW_CHECK_SLOTS,
  WORKFLOW_CHECK_STATUSES,
  WORKFLOW_COMPLETION_KINDS,
  WORKFLOW_DELIVERY_MODES,
  WORKFLOW_LIMITS,
  WORKFLOW_MISSING_PR_ACTIONS,
  WORKFLOW_EXECUTION_LIMITS,
  WORKFLOW_GATE_WAIT_REASONS,
  WORKFLOW_NODE_ATTEMPT_STATES,
  WORKFLOW_RESUMPTION_POLICIES,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_SOURCE_PORTS,
  WORKFLOW_SUBMISSION_MODES,
  WORKFLOW_SUBMISSION_STATUSES,
  WORKFLOW_TARGET_PORTS,
  WORKFLOW_TRIGGER_MODES,
  WORKFLOW_TRIGGER_SOURCES,
  WORKFLOW_EXTERNAL_SOURCE_KINDS,
} from "./workflow.ts";
import type { WorkflowJson } from "./workflow.ts";
import {
  ENSEMBLE_ARTIFACT_KINDS,
  ENSEMBLE_ARTIFACT_STATUSES,
  ENSEMBLE_ATTEMPT_STATUSES,
  ENSEMBLE_DECISION_ACTORS,
  ENSEMBLE_DECISION_STATUSES,
  ENSEMBLE_DRIVER_KEYS,
  ENSEMBLE_EVALUATION_STATUSES,
  ENSEMBLE_EVALUATOR_KINDS,
  ENSEMBLE_HARD_LIMITS,
  ENSEMBLE_LIMITS,
  ENSEMBLE_LLM_CALL_STATES,
  ENSEMBLE_LLM_PURPOSES,
  ENSEMBLE_MEMBER_STATUSES,
  ENSEMBLE_OUTCOME_KINDS,
  ENSEMBLE_PAYLOAD_VERSION,
  ENSEMBLE_PLAN_VERSION,
  ENSEMBLE_SOURCE_KINDS,
  ENSEMBLE_STAGE_DRIVER_KINDS,
  ENSEMBLE_STAGE_STATUSES,
  ENSEMBLE_STATUSES,
  ENSEMBLE_STRATEGY_IDS,
  ENSEMBLE_WORKFLOW_HANDOFF_STATES,
} from "./ensemble.ts";
import type {
  EnsembleArtifact,
  EnsembleAttempt,
  EnsembleDecision,
  EnsembleEvaluation,
  EnsembleEvent,
  EnsembleJson,
  EnsembleLlmCall,
  EnsembleMember,
  EnsemblePayloadEnvelope,
  EnsembleRun,
  EnsembleRunDetail,
  EnsembleStageAttempt,
  EnsembleSummary,
  EnsembleUnreadable,
  EnsembleWorkflowHandoff,
} from "./ensemble.ts";
import {
  SCHEDULE_CRON_FIELD_COUNT,
  SCHEDULE_HISTORY_MAX_LIMIT,
  SCHEDULE_MISSED_POLICIES,
  SCHEDULE_OVERLAP_POLICIES,
  SCHEDULE_PREVIEW_DEFAULT_COUNT,
  SCHEDULE_PREVIEW_MAX_COUNT,
  cronFieldCount,
} from "./schedules.ts";

const EffortLevelSchema = z.enum(THINKING_LEVELS);
const harnessEffortSchema = (agent: (typeof AGENT_TYPES)[number]) =>
  EffortLevelSchema.refine((level) => supportsEffort(agent, level), {
    message: "reasoning effort is not supported by this harness",
  });

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
  /**
   * Which harness's bridge sent this, and therefore whose event vocabulary `event` and
   * the payload fields below are written in. The daemon reads it to pick a `HookSpec`
   * (`harness/index.ts`); nothing else can tell a Claude `Stop` from another agent's.
   *
   * Defaulted rather than required, and the default can only ever be `claude`: the hook
   * script is installed into `~/.claude/settings.json` from a checkout that may lag this
   * code by any amount, so an ingest with no `agent` is by definition from the only
   * bridge that existed when it was installed. A second bridge sends the field.
   */
  agent: z.enum(AGENT_TYPES).optional().default("claude"),
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
  // The harness's current permission mode, when its hook reports one. Left as a free
  // string on the wire - the registry normalizes it to a known PermissionMode - so a
  // mode a newer harness adds never fails hook ingest, it just doesn't render yet.
  permissionMode: z.string().optional(),
  // A GitHub PR URL the hook sniffed out of a PostToolUse tool result (e.g. the
  // link `gh pr create` prints). Optimistically decorates the session's card;
  // the PR poller is the source of truth that later confirms or clears it.
  prUrl: z.string().url().optional(),
  // True when the hook saw the agent RUN `gh pr create` - not merely print a PR URL.
  //
  // The distinction is the whole of the Inspector's consent model. `prUrl` above is a
  // loose text match that `gh pr view` trips just as readily: fine for a chip the
  // poller retracts a tick later, useless as grounds for writing to GitHub. This is
  // read off the command line itself, and it is what adopts a PR for review.
  //
  // Absent (not `false`) when it doesn't match, and absent on every non-Bash event.
  prCreated: z.boolean().optional(),
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
   * This is the terminal transport for a real subscription's limits; an embedded Claude
   * session can report the same account-global windows through its SDK driver. OpenTelemetry
   * has no quota metric. Cost is pointedly NOT taken from here even though the payload
   * carries it: OTel owns cost, and one source per fact is what keeps two numbers from
   * disagreeing on screen.
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
export const SubmitOptionsSchema = z
  .object({
    options: z
      .array(
        z.object({
          number: z.number().int().min(1).max(99),
          label: z.string().min(1),
          checked: z.boolean(),
        }),
      )
      .min(1)
      .max(99)
      .optional(),
    /**
     * A DRIVER form's answers: one entry per question, by the question's own text.
     *
     * A second shape rather than a looser first one, because a driver form genuinely is
     * not a flat list of rows. `AskUserQuestion` carries up to four questions at once, each
     * numbering its own options from 1, so `{number, label, checked}` would be ambiguous
     * across them - two questions both have a row 1. The pane never had this problem
     * because its TUI shows one question at a time and the parser only ever saw that tab,
     * which is exactly why `driverDialog` refuses to flatten them.
     *
     * `text` is what a driver form can do and a pane form cannot: the harness accepts free
     * text where the human would rather write than pick, and the pane path has to refuse it
     * because a menu has no field to type into.
     */
    answers: z
      .array(
        z.object({
          question: z.string().min(1).max(4000),
          labels: z.array(z.string().min(1).max(500)).max(16),
          text: z.string().max(4000).optional(),
        }),
      )
      .min(1)
      .max(8)
      .optional(),
  })
  .refine((o) => Boolean(o.options) !== Boolean(o.answers), {
    message: "send either pane form rows or driver form answers, not both and not neither",
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
 * kind is to present selectable choices, and a decision-less one would reach the
 * dashboard as an empty form with nothing to submit.
 *
 * `input` MAY carry decisions too, and carries exactly one when it does - that is
 * `request_input` asking with discrete options, the replacement for Claude's built-in
 * `AskUserQuestion` menu (see `server/ask-channel.ts`). It reuses this shape rather than
 * growing a parallel one because `PlanDecision` already IS the question-with-options form,
 * and `DecisionForm` already renders it; the only difference is that an `input` has no plan
 * above it. The bound is asserted here rather than left to convention, because everything
 * downstream - the single `<fieldset>`, the "you answered" lead line - reads the one
 * question by position.
 *
 * `plan` and `diff` take no decisions at all: there is no control to render them on.
 */
export const CreateReviewSchema = z
  .object({
    env: EnvSchema,
    sessionId: z.string().nullable().optional().default(null),
    cwd: z.string().nullable().optional().default(null),
    kind: z.enum(["plan", "diff", "input", "plan-decisions"]),
    title: z.string().min(1),
    body: z.string(),
    /** The questions the human answers: many for `plan-decisions`, exactly one for `input`. */
    decisions: z.array(PlanDecisionSchema).optional(),
  })
  .refine((r) => r.kind !== "plan-decisions" || (r.decisions?.length ?? 0) > 0, {
    message: "kind 'plan-decisions' requires at least one decision",
    path: ["decisions"],
  })
  .refine((r) => r.kind !== "input" || (r.decisions?.length ?? 0) <= 1, {
    message: "kind 'input' carries at most one decision",
    path: ["decisions"],
  })
  .refine((r) => r.kind === "plan-decisions" || r.kind === "input" || !r.decisions?.length, {
    message: "only kinds 'plan-decisions' and 'input' can carry decisions",
    path: ["decisions"],
  });
export type CreateReview = z.infer<typeof CreateReviewSchema>;

/**
 * MCP `create_task`: create a backlogged implementation task and optionally bind it
 * to the session making the call. The daemon resolves that session from the same
 * pane/session/cwd evidence as the review channel; the MCP child never guesses a
 * Mission Control session id.
 */
export const McpCreateTaskSchema = z
  .object({
    env: EnvSchema,
    sessionId: z.string().nullable().optional().default(null),
    cwd: z.string().min(1),
    repoRoot: z.string().min(1),
    title: z.string().min(1).max(200),
    intent: z.string().min(1),
    dependsOnTaskIds: z.array(z.string().min(1)).max(50).optional().default([]),
    dependsOnCurrentSession: z.boolean().optional().default(false),
  })
  .refine(
    ({ dependsOnTaskIds, dependsOnCurrentSession }) =>
      dependsOnTaskIds.length + (dependsOnCurrentSession ? 1 : 0) <= 50,
    { path: ["dependsOnTaskIds"], message: "at most 50 task dependencies are allowed" },
  );
export type McpCreateTask = z.infer<typeof McpCreateTaskSchema>;

/** The human's decision on a review, from the dashboard. */
export const ResolveReviewSchema = z.object({
  action: z.enum(["approve", "reject", "answer", "dismiss"]),
  response: z.string().nullable().optional().default(null),
}).transform((resolution) => ({
  ...resolution,
  response: resolution.action === "dismiss" ? null : resolution.response,
}));
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

/** A dependency target selected from the backlog or the live-session list. */
export const TaskDependencyInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task"), taskId: z.string().min(1) }),
  z.object({ type: z.literal("session"), sessionId: z.string().min(1) }),
]);
export type TaskDependencyInput = z.infer<typeof TaskDependencyInputSchema>;

const TaskDependenciesSchema = z
  .array(TaskDependencyInputSchema)
  .max(50)
  .superRefine((dependencies, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < dependencies.length; i++) {
      const dependency = dependencies[i]!;
      const key = dependency.type === "task" ? `task:${dependency.taskId}` : `session:${dependency.sessionId}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: "duplicate task dependency" });
      }
      seen.add(key);
    }
  });

/**
 * A model id, in the only shape that is safe to hand to a harness CLI.
 *
 * Terminal backends preserve argv boundaries, but the value still passes through each
 * harness's option parser. Requiring an alphanumeric first character rejects flag- and
 * path-shaped inputs, while the restricted remainder excludes whitespace and control
 * characters before the id is stored. Real Claude and Codex ids fit that alphabet
 * (`claude-opus-4-8`, `gpt-5.6-sol`). Note this deliberately excludes Claude's `[1m]`
 * long-context marker: the CLI takes the bare id and picks the window itself.
 */
export const ModelIdSchema = z
  .string()
  .max(80)
  // `/` is allowed only in the INTERIOR, never as the first character, so a provider-qualified
  // id like `openai/gpt-5.5` (Pi is multi-provider and its ids carry the provider) passes while
  // a path such as `../../etc/passwd` or a bare `-rf` still fails on the leading-char class.
  // Terminal adapters own argv preservation; this schema owns the persisted id vocabulary.
  // Test: `dispatch-model.test.ts`.
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/, "model id must be alphanumeric with . _ - / only");

/**
 * Dispatch (or shelve) a new agent: launch an agent in an isolated worktree of
 * `repoRoot` with `intent` as its first prompt. `backlog: true` only adds it to
 * the backlog (no worktree/session yet); dispatch it later.
 */
export const DispatchSchema = z
  .object({
    repoRoot: z.string().min(1),
    intent: z.string().min(1),
    title: z.string().optional(),
    kind: z.enum(["ship", "scout"]).default("ship"),
    agent: z.enum(AGENT_TYPES).default("claude"),
    /**
     * Run this agent on a specific model instead of the harness default. Omitted
     * means "whatever `harnesses.defaultModel` says at dispatch time" - which is
     * not the same as pinning today's default, and is what lets a backlogged task
     * pick up a default changed after it was shelved.
     */
    model: ModelIdSchema.optional(),
    /** Reasoning-effort override; omitted follows the harness default at launch time. */
    effort: EffortLevelSchema.optional(),
    /**
     * Published Workflow to arm for Foreman Complete. Omitted follows the machine default;
     * explicit null opts this task out of that default.
     */
    workflowId: z.string().min(1).max(500).nullable().optional(),
    backlog: z.boolean().optional().default(false),
    dependencies: TaskDependenciesSchema.optional().default([]),
    ...TASK_TRIAGE_FIELDS,
  })
  .refine((o) => o.effort === undefined || supportsEffort(o.agent, o.effort), {
    path: ["effort"],
    message: "reasoning effort is not supported by this harness",
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

/** Drive a live session to one of its harness's pickable permission modes. */
export const SetPermissionModeSchema = z.object({
  mode: z.enum([
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
    "auto",
    "askForApproval",
    "approveForMe",
    "fullAccess",
    "readOnly",
  ]),
});
export type SetPermissionModeInput = z.infer<typeof SetPermissionModeSchema>;

/** Change the reasoning effort of the currently selected model in a live session. */
export const SetSessionEffortSchema = z.object({
  effort: EffortLevelSchema,
});
export type SetSessionEffortInput = z.infer<typeof SetSessionEffortSchema>;

/**
 * Close a task with a human-recorded outcome (the `/stow` intent -> result loop).
 *
 * `satisfyDependents` is the operator asserting that this task's work is genuinely in
 * place, so the tasks declared to wait on it may start. It defaults to FALSE, and that
 * default is the whole safety story: a declared dependency is otherwise satisfied only
 * by a MERGED PR, because a dependent cuts a fresh worktree from the default branch and
 * therefore does not contain unmerged prerequisite work. Completion alone is weaker
 * evidence than a merge and must not silently stand in for one.
 *
 * What it buys is the exit that was missing. Work that will never produce a merged PR -
 * a scout that only had to answer a question, a session killed after its change landed
 * by another route - could satisfy nothing, and `blockersIn` states declared blockers
 * cannot be manually overridden. So the graph had no way out: observed as a 17-item
 * backlog with `ready: 0` in which every chain rooted in a cancelled task. This is that
 * way out, and it is deliberately an explicit, confirmed act rather than a side effect
 * of any status change.
 */
export const CompleteTaskSchema = z.object({
  outcome: z.string().min(1),
  outcomeUrl: z.string().url().optional(),
  satisfyDependents: z.boolean().optional().default(false),
  requireStopped: z.boolean().optional().default(false),
});
export type CompleteTask = z.infer<typeof CompleteTaskSchema>;

export const RescheduleTaskSchema = z.object({}).strict();

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
 * `repoRoot`, `intent`, `title`, `kind`, `agent`, `model`, `effort`, `workflowId`, `dependencies` and
 * `enabled` are PROVISIONING fields -
 * repo, intent and title are cut into a branch name and terminal home at dispatch and
 * cannot be rewritten afterwards, while model and effort are baked into the launched
 * command line, while dependencies and enabled decide whether a launch is allowed - so a
 * patch touching any of them is refused once the task has left the backlog.
 * `priority` and `labels` are pure annotation that nothing is provisioned from, so they
 * can be changed at any point in a task's life, including while its agent is running.
 *
 * `priority` is `.optional()` WITHOUT the create schema's `.default(null)`: here an
 * absent key has to keep meaning "leave it alone", and a default would turn every patch
 * that didn't mention priority into one that silently cleared it.
 *
 * `model` and `effort` are nullable for the same reason: an absent field leaves the stored override
 * alone, while an explicit `null` takes it back off - which is the only way to say
 * "follow the harness default again" about a row that already names an override.
 *
 * `enabled` is the backlog's enable/disable toggle, and it is deliberately NOT
 * annotation: it only means anything while the task is in the backlog, so it falls
 * under the same status guard as the provisioning fields. Exempting it would let a
 * patch "disable" a task whose agent is already running, and answer 200 to a caller
 * who would reasonably read that as having paused something.
 */
export const UpdateTaskSchema = z
  .object({
    repoRoot: z.string().min(1).optional(),
    intent: z.string().min(1).optional(),
    title: z.string().optional(),
    kind: z.enum(["ship", "scout"]).optional(),
    agent: z.enum(AGENT_TYPES).optional(),
    enabled: z.boolean().optional(),
    priority: z.enum(TASK_PRIORITIES).nullable().optional(),
    labels: z.array(z.string()).max(MAX_LABELS).optional().transform(normalizeLabelsOrUndefined),
    model: ModelIdSchema.nullable().optional(),
    effort: EffortLevelSchema.nullable().optional(),
    workflowId: z.string().min(1).max(500).nullable().optional(),
    dependencies: TaskDependenciesSchema.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "empty task update" })
  .refine(
    (o) => o.agent === undefined || o.effort == null || supportsEffort(o.agent, o.effort),
    { path: ["effort"], message: "reasoning effort is not supported by this harness" },
  );
export type UpdateTask = z.infer<typeof UpdateTaskSchema>;

/** True when this patch only re-describes a task, so no status guard applies. */
export function isAnnotationOnlyUpdate(patch: UpdateTask): boolean {
  return Object.keys(patch).every((k) => k === "priority" || k === "labels");
}

/**
 * Optional launch-time default supplied by Foreman's backlog autopilot.
 *
 * This is intentionally separate from `DispatchSchema`: a task's own `model` is
 * durable operator input, while this value is only used to fill an unpinned backlog
 * task at the instant Foreman launches it. The daemon persists the selected value
 * before dispatch so the task record honestly describes the command it launched.
 */
export const DispatchBacklogTaskSchema = z.object({
  defaultModel: ModelIdSchema.nullable().optional(),
  overrideDisabled: z.boolean().optional().default(false),
});
export type DispatchBacklogTask = z.infer<typeof DispatchBacklogTaskSchema>;

/** Hand a backlog task to an agent that is already running (the board's drag-to-dispatch). */
export const AssignTaskSchema = z.object({
  sessionId: z.string().min(1),
  overrideDisabled: z.boolean().optional().default(false),
  /**
   * The caller has accepted what the handover reset discards beyond git state - the
   * agent's work queue, its context, the branch it stands on.
   *
   * Defaults to FALSE, which is the whole safety property: an assign that would take
   * any of that is refused until someone says yes, and the refusal carries the
   * breakdown (`AssignResetConfirm`) so the caller can show what it is agreeing to. A
   * caller that simply forgets the flag gets the safe answer.
   */
  confirmReset: z.boolean().optional().default(false),
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
  // The shadow measurement, written only under the `shadow` posture. Optional as well as
  // nullable: the worker omits them entirely on the other two postures, and an omitted
  // field and an explicit null mean the same thing here - nothing was measured.
  cheapAction: z.enum(CHEAP_ACTIONS).nullable().optional(),
  divergence: z.enum(DIVERGENCE_KINDS).nullable().optional(),
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
  /** Provider used for every Foreman model call. */
  runner: z.enum(LLM_RUNNER_IDS).optional(),
  /**
   * Whether Foreman is switched on at all. On by default, and that authorises far less than
   * it sounds like.
   *
   * `mode` still ships `dry-run`, so Foreman drafts and never sends; `repoAllowlist` still
   * ships empty, so `mayActLive` is false everywhere; and the worker is a SEPARATE PROCESS
   * (`npm run foreman`) that nothing here starts. Enabled with no worker running is enabled
   * and idle.
   *
   * It flipped because it had become a gate in front of something else: `bindingModeBlock`
   * refuses a `foreman_complete` binding outright when this is false, so the automatic repair
   * loop could not reach its completion trigger on a fresh install no matter what the operator
   * configured in Workflow settings. An operator who explicitly turned Foreman off has a
   * persisted `false` and keeps it - this default is only read when nobody ever answered.
   */
  enabled: z.boolean().default(true),
  mode: z.enum(["dry-run", "live", "semi-auto"]).default("dry-run"),
  /**
   * Repo roots Foreman may act in when live (realpaths). Empty = act nowhere live.
   *
   * `min(1)` is the consent gate, not tidiness: `cwdAllowlisted` compares against
   * `` `${root}/` ``, so a blank entry becomes "/" and every absolute path matches it.
   * One empty string in this array silently grants consent EVERYWHERE, for Foreman and
   * - through the same shared predicate - for the Inspector.
   */
  repoAllowlist: z.array(z.string().min(1)).default([]),
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
   * Both triggers ship armed. `drain` alone was the shipped default and it silently excluded
   * a whole class of session: `drain` fires when a WORK QUEUE empties, so a session driven by
   * a human prompt - which is most of them - has no queue, never drains, and never reaches a
   * wrap-up moment at all. For the automatic repair loop that meant the completion signal
   * simply did not exist for those sessions, and the loop looked broken rather than unarmed.
   *
   * What `prompted` costs is bounded by everything downstream: `wrapup` still defaults to
   * `ask`, so the moment renders a card rather than typing anything, and the auto paths are
   * refused outright unless `mode` is live AND the repository is allowlisted.
   *
   * An empty list means "never wrap up automatically" and is honoured as written; it
   * is NOT treated as unset. Someone running the work queue who wants to ship by hand
   * has no other way to say so, and quietly restoring a default here would type into
   * their sessions against an explicit choice.
   */
  wrapupTriggers: z.array(z.enum(WRAPUP_TRIGGERS)).default(["drain", "prompted"]),
  /**
   * What happens when a wrap-up fires, whichever trigger fired it.
   *
   * `ask` is the shipped behaviour and the default: Foreman marks the moment and the
   * human picks from the Wrapup card. `no-mistakes` claims the verified completion for
   * an existing binding or, when there is none, binds the built-in No-Mistakes Review
   * workflow. `pr` lets Foreman type the direct shipping instruction unattended.
   *
   * Automating this is strictly more dangerous than the per-item send it resembles,
   * because either automated path can ultimately PUSH. So the auto path carries every
   * gate the manual one does and one more - it is refused outright unless `mode` is live
   * AND the repo is on the allowlist (`mayActLive`), exactly like a queue send. Setting
   * this to `no-mistakes` while in dry-run does not auto-bind; it degrades to `ask`.
   * Dry-run means dry-run.
   */
  wrapup: z.enum(WRAPUP_MODES).default("ask"),
  /**
   * Whether Foreman keeps a session on track once its work has become an OPEN pull
   * request - nudging it back to address the Inspector's review comments and to get a
   * failing CI green, until the PR is clean.
   *
   * On by default, because the gap it closes is the common failure the feature was asked
   * for: a session finishes (via `/no-mistakes` or straight-to-PR), opens the PR, and
   * parks. The Inspector then reviews and posts comments, or CI goes red - and nobody is
   * driving the session to fix them, so the PR sits with unresolved feedback until a
   * human notices. This turns each new Inspector round or newly actionable feedback kind
   * on a parked PR into a fresh instruction typed back at the session that opened it.
   *
   * Like every automated action here it only ever TYPES in live mode on an allowlisted
   * repo (`mayActLive`): the nudge is a live act, and dry-run means dry-run. It also
   * fires only at a settled-idle session - never interrupting one already working the
   * fixes - and at most once per Inspector-round/feedback-kind signature, so it
   * re-engages a stalled PR without nagging one that is being handled. Independent of
   * `wrapupTriggers`: those decide how work BECOMES a PR, this decides what happens to
   * the PR afterwards.
   */
  trackReviewFeedback: z.boolean().default(true),
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
   * Whether an idle agent whose branch still carries an OPEN pull request is off-limits
   * to the backlog autopilot.
   *
   * On by default, because the default has to be the safe reading of an ambiguous state.
   * An agent that opened a PR and went quiet looks exactly like an agent that finished:
   * `reportBucket` files it under idle, its work queue is empty, and once its task is
   * marked done nothing binds it. Handing it the next backlog item then types into a
   * checkout still standing on the PR's branch, so the new task's commits land on top of
   * work that is out for review - and the reviewer's next `git pull` picks up changes
   * nobody asked that PR for.
   *
   * Scoped to AUTOPILOT, like every other knob here. Dropping a task onto an agent from
   * the board is a human saying "yes, that one", and the same asymmetry already governs
   * the harness check in `freeAgentFor`: the drag gesture may, the background loop may
   * not.
   *
   * Off is a real choice, not a footgun to hide: a fleet whose PRs auto-merge, or one
   * where every task is dispatched into its own worktree anyway, is paying for a refusal
   * that protects nothing.
   */
  backlogRespectOpenPrs: z.boolean().default(true),
  /**
   * The model Foreman selects when it launches a backlog task that did not already
   * name one. Keyed by agent because a Claude model id cannot be passed to Codex.
   *
   * `null` deliberately leaves the task unpinned, so its launch continues through
   * the Harnesses default (or the harness CLI's own default). An explicit task model
   * always wins; this is a default for the autopilot's fresh launches, not a rewrite
   * of a human's choice. Assigning work to an already-running session has no model
   * knob at all, so it is unaffected.
   */
  backlogDefaultModel: z
    .object({
      claude: ModelIdSchema.nullable().default(null),
      codex: ModelIdSchema.nullable().default(null),
      pi: ModelIdSchema.nullable().default(null),
    })
    .default({ claude: null, codex: null, pi: null }),
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

/**
 * Partial update of the Foreman config from the dashboard.
 *
 * `backlogDefaultModel` is spelled out rather than inherited from `.partial()`:
 * the server merges it per harness, so a Claude edit cannot erase a Codex choice.
 */
export const ForemanConfigPatchSchema = ForemanConfigSchema.partial()
  .extend({
    backlogDefaultModel: z
      .object({
        claude: ModelIdSchema.nullable().optional(),
        codex: ModelIdSchema.nullable().optional(),
        pi: ModelIdSchema.nullable().optional(),
      })
      .optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "empty config update" });
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
 * The Inspector's consent model, in one object.
 *
 * Every default here is the OFF position, and that is not caution theatre: this is the
 * only subsystem that writes to a public place under the operator's GitHub identity.
 * `enabled: false` means it never runs; `mode: "dry-run"` means it computes findings
 * and posts none; an empty `repoAllowlist` means it acts nowhere. Turning it on is
 * three deliberate acts, and the first two are reversible without anyone else seeing.
 */
export const InspectorConfigSchema = z.object({
  /** Provider used for reviews and follow-up replies. */
  runner: z.enum(LLM_RUNNER_IDS).optional(),
  enabled: z.boolean().default(false),
  /**
   * `dry-run` still adopts PRs, reviews them, and records what it WOULD say - which is
   * the point. A preview mode that reviews nothing tells you nothing about whether the
   * reviewer is any good on your repo.
   */
  mode: z.enum(["dry-run", "live"]).default("dry-run"),
  /**
   * Repos the operator has trusted. Empty = act nowhere. Same rule as Foreman's,
   * including the `min(1)`: a blank entry would match every absolute path and turn the
   * one gate that decides whether anything writes to a public PR into a no-op.
   */
  repoAllowlist: z.array(z.string().min(1)).default([]),
  /**
   * Overrides the review model, for both the review pass and the follow-up replies.
   * Empty or unset falls back to `MISSION_INSPECTOR_MODEL`, then to
   * `INSPECTOR_MODEL_SPEC.fallback` - see there for why a default is named at all.
   *
   * `ModelIdSchema` rather than a bare string because this value becomes a `--model`
   * argument: an id starting with `-` would be read as a flag rather than rejected.
   *
   * The empty string is admitted ALONGSIDE it, and that is not a loosening - it is the
   * only way to say "clear my override". The settings field is free text, so a cleared
   * box commits `""`; with the regex alone the daemon refused it, the panel reverted, and
   * an operator who had once typed a model could never get back to the default. Nothing
   * downstream can act on it either way: every layer of `resolveModelChoice` treats blank
   * as absent, so `--model ""` is unreachable.
   */
  model: z.union([ModelIdSchema, z.literal("")]).optional(),
  /**
   * Ceiling on inline comments per round. A reviewer that leaves thirty notes on one
   * push is one nobody reads, and the cap is what turns "be thorough" into "lead with
   * what matters" - the planner sorts by severity before it truncates.
   */
  maxCommentsPerRound: z.number().int().min(1).max(INSPECTOR_LIMITS.maxCommentsPerRound).default(8),
});
export type InspectorConfig = z.infer<typeof InspectorConfigSchema>;

/** Partial update of the Inspector config from the dashboard. */
export const InspectorConfigPatchSchema = InspectorConfigSchema.partial().refine(
  (o) => Object.keys(o).length > 0,
  { message: "empty config update" },
);
export type InspectorConfigPatch = z.infer<typeof InspectorConfigPatchSchema>;

// ---- Shipping (landing the pull requests we opened, unattended) ----

/**
 * YOLO mode's consent model. Same shape and the same defaults-are-off posture as
 * `InspectorConfigSchema`, because it is a bigger version of the same bet: the Inspector
 * writes a comment nobody has to act on, this one writes to the DEFAULT BRANCH.
 *
 * It rides the Inspector's tick and only ever looks at PRs the Inspector adopted, so
 * "only our pull requests" is inherited rather than restated - and with the Inspector off
 * nothing is reviewed, so nothing qualifies and nothing merges.
 */
export const ShippingConfigSchema = z.object({
  /** The master switch. Off means the gate is never even evaluated as passable. */
  autoMerge: z.boolean().default(false),
  /**
   * How long a pull request must have been OPEN before it may merge itself.
   *
   * The one control that is about people rather than about the code: it is the window in
   * which a colleague can look at what an agent has proposed and say no. Ten minutes by
   * default - long enough to notice a PR land in a channel, short enough that a fleet
   * running overnight is not blocked on anyone.
   *
   * Zero is allowed and means "merge as soon as it qualifies", which is the honest
   * reading of YOLO; the ceiling is a day, past which this is not auto-merge any more.
   */
  soakMinutes: z.number().int().min(0).max(1440).default(10),
  /** How to land it. Squash by default, matching what the fleet's own PRs expect. */
  method: z.enum(["squash", "merge", "rebase"]).default("squash"),
  /**
   * Repos the operator has trusted to merge unattended. Empty = merge nowhere.
   *
   * A THIRD consent gate over the same `repoAllowlisted` predicate the Foreman and the
   * Inspector use, and deliberately its own list rather than a reuse of the Inspector's:
   * "you may comment here" and "you may push to main here" are different grants, and
   * folding them would mean switching the Inspector on in a repo silently armed this.
   */
  repoAllowlist: z.array(z.string().min(1)).default([]),
  /**
   * Close a task's session after its pull request merges and the task is marked done,
   * freeing a fleet slot.
   *
   * The pairing with the rest of this object is deliberate but LOOSE, and the asymmetry
   * is the point. Settling a merged task is unconditional and lives outside this config
   * entirely (`TaskManager.settleMergedTask`) because a stranded `running` row is a bug
   * however the merge happened. This flag only decides what becomes of the AGENT, which
   * is a genuine preference rather than a defect.
   *
   * Off by default. On, a merge first completes the task and then closes its idle
   * session, reclaiming its worktree when safe, so the next dispatch cuts a fresh
   * checkout: `activeAgentCount` counts live sessions whole, so an agent that finished
   * otherwise holds a slot against `maxSessions` indefinitely.
   *
   * Off is NOT "nothing happens". The task still settles, which is what makes that agent
   * pass `agentIsFree`, so the backlog autopilot may hand it the next task in the same
   * checkout - no worktree to provision and no process to start. The real trade is
   * context: a reused agent carries the last task's window into the next one, while a
   * closed one costs a full provision cycle to replace. Neither is free, which is why
   * this is a switch and not a hard-coded answer.
   */
  closeSessionAfterMerge: z.boolean().default(false),
});
export type ShippingConfig = z.infer<typeof ShippingConfigSchema>;

/** Partial update of the Shipping config from the dashboard. */
export const ShippingConfigPatchSchema = ShippingConfigSchema.partial().refine(
  (o) => Object.keys(o).length > 0,
  { message: "empty config update" },
);
export type ShippingConfigPatch = z.infer<typeof ShippingConfigPatchSchema>;

/**
 * One runtime choice AS STORED, which is a `string` on purpose.
 *
 * Two things have to be true at once and a `z.enum` here cannot do both. `getHarnessesConfig`
 * parses this blob on the path of every dispatch, so a value written by a NEWER build must
 * not throw - that would take out the model and effort defaults too, over a key the caller
 * never asked about. And the drop has to be REPORTABLE: `resolveSessionRuntime` names the
 * value it could not read, which a `.catch("terminal")` would have already erased, leaving
 * an operator's stored choice indistinguishable from the default they never set.
 *
 * The narrowing is `resolveSessionRuntime` (`@shared/harness-capabilities.ts`), the single
 * gate both the dispatcher and the panel go through. Nothing may read this field raw.
 * The PATCH schema below stays a strict enum, so this build can never WRITE a value it
 * cannot read - the looseness is only ever about reading someone else's.
 */
const StoredSessionRuntimeSchema = z.string();

/** What the dashboard may set. Strict: we write only what we understand. */
const SessionRuntimeSchema = z.enum(SESSION_RUNTIMES);

/**
 * Defaults the harness applies to the sessions IT dispatches - never to the
 * sessions it merely discovered. A schema-validated blob over the `app_config` KV,
 * exactly like ForemanConfig/SkillsConfig, so a new key needs no migration.
 *
 * The scoping is the whole contract: `autoModeOnDispatch` affects only the dispatch
 * path. Claude starts in `auto` through `dispatchPermissionModeArgs`. Terminal Codex
 * keeps the posture from `prepareCodexLaunch`; embedded Codex receives that same posture
 * through its driver. A session the operator started themselves keeps its existing
 * posture. Ships on so dispatched agents use their harness's declared autonomous posture
 * unless the operator turns it off.
 */
export const HarnessesConfigSchema = z.object({
  /**
   * When on, every Claude session dispatched from Mission Control is launched directly
   * in `auto` permission mode (`--permission-mode auto`) - so it works through its task
   * without pausing on permission prompts. Codex dispatches use the existing
   * workspace-write/on-request posture; terminal launches receive it from
   * `prepareCodexLaunch`, while embedded launches receive the native Approve for me
   * profile through app-server turn parameters.
   */
  autoModeOnDispatch: z.boolean().default(true),
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
      pi: ModelIdSchema.nullable().default(null),
    })
    .default({ claude: null, codex: null, pi: null }),
  /** Launch-time reasoning effort per harness; null leaves the harness in control. */
  defaultEffort: z
    .object({
      claude: harnessEffortSchema("claude").nullable().default(null),
      codex: harnessEffortSchema("codex").nullable().default(null),
      pi: harnessEffortSchema("pi").nullable().default(null),
    })
    .default({ claude: null, codex: null, pi: null }),
  /**
   * How a dispatched session of each harness is DRIVEN: through a terminal pane, or
   * embedded through the harness's own programmatic interface.
   *
   * `"terminal"` everywhere is the shipped value and stays the shipped value - the cut-over
   * is an operator flipping a toggle per harness, never a default change (a resolved
   * decision on `docs/plans/agent-sdk-sessions/plan.md`). Scoped to dispatch like every
   * other key in this blob: a session an operator started themselves is pane-backed
   * whatever this says, because we do not own their pty.
   *
   * A stored value this build cannot read, or one naming a runtime the harness does not
   * offer, falls back to `"terminal"` and says so - see `resolveDispatchRuntime`. Read at
   * dispatch time, so a flip mid-batch reaches the next launch without a restart.
   */
  sessionRuntime: z
    .object({
      claude: StoredSessionRuntimeSchema.default("terminal"),
      codex: StoredSessionRuntimeSchema.default("terminal"),
      pi: StoredSessionRuntimeSchema.default("terminal"),
    })
    .default({ claude: "terminal", codex: "terminal", pi: "terminal" }),
});
export type HarnessesConfig = z.infer<typeof HarnessesConfigSchema>;

/**
 * Partial update of the harnesses config from the dashboard.
 *
 * Spelled out rather than `HarnessesConfigSchema.partial()`, because `.partial()`
 * only reaches the top level: a partial per-agent map would parse under it, fill the
 * omitted agent from the inner `.default(null)`, and the merge in `setHarnessesConfig`
 * would then wipe a default the caller never mentioned. Here an omitted inner key stays
 * omitted, and the server merges per-agent.
 */
export const HarnessesConfigPatchSchema = z
  .object({
    autoModeOnDispatch: z.boolean().optional(),
    defaultModel: z
      .object({
        claude: ModelIdSchema.nullable().optional(),
        codex: ModelIdSchema.nullable().optional(),
        pi: ModelIdSchema.nullable().optional(),
      })
      .optional(),
    defaultEffort: z
      .object({
        claude: harnessEffortSchema("claude").nullable().optional(),
        codex: harnessEffortSchema("codex").nullable().optional(),
        pi: harnessEffortSchema("pi").nullable().optional(),
      })
      .optional(),
    sessionRuntime: z
      .object({
        claude: SessionRuntimeSchema.optional(),
        codex: SessionRuntimeSchema.optional(),
        pi: SessionRuntimeSchema.optional(),
      })
      .optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "empty config update" });
export type HarnessesConfigPatch = z.infer<typeof HarnessesConfigPatchSchema>;

/**
 * The whole set of configured task sources, as the panel sends it back.
 *
 * A whole-list PUT rather than a per-source PATCH, and the reason is the one that makes
 * `repoAllowlist` a list too: adding, editing and removing a source are the same edit to
 * the same panel, and a partial protocol would need a third verb for "remove" plus an
 * id-not-found refusal that the list shape answers for free. The list is small, bounded
 * by the schema, and edited by exactly one surface.
 *
 * Every element goes through `TaskSourceInstanceSchema`, which validates each kind's own
 * config blob - so a source that could never sweep is refused here rather than failing
 * quietly on a background tick nobody is watching.
 */
export const TaskSourcesConfigPatchSchema = TaskSourcesConfigSchema;
export type TaskSourcesConfigPatch = z.infer<typeof TaskSourcesConfigPatchSchema>;

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
  usageBarCollapsed: false,
  keybindingHints: true,
  trustStaged: [],
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
  /** Whether the topbar's fleet-cost/rate-limit strip is folded away. */
  usageBarCollapsed: z.boolean().default(UI_CONFIG_DEFAULTS.usageBarCollapsed),
  /**
   * Whether a button that a keyboard shortcut also drives prints that shortcut on its
   * face. On by default: the shortcut table is only discoverable if the buttons teach
   * it. The off switch is for an operator who has learnt them and wants the chrome back.
   */
  keybindingHints: z.boolean().default(UI_CONFIG_DEFAULTS.keybindingHints),
  /**
   * Repos the Trust panel has STAGED - added to the matrix but granted nothing yet.
   *
   * The Trust matrix is a view over the three `repoAllowlist`s, so a repo with no grant
   * exists in none of them and would vanish on the next reload, breaking "adding is
   * configuration; enabling is consent". This durable per-machine list is that repo's only
   * home until it earns a grant. Owned WHOLE by the Trust panel (the blob's shallow-merge
   * rule): it appends a resolved root on add, and prunes an entry the moment its repo gains
   * a first grant or its row is removed. Persisted on operators' machines once shipped, so
   * append-only in practice - renaming the key orphans staged rows. `trustRows` treats it
   * as one more source of repos; a staged entry that has since gained a grant is redundant,
   * and the allowlists win.
   */
  trustStaged: z.array(z.string().min(1)).default([]),
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
   * What the topbar strip leads with. `usd` is an API-equivalent estimate across both
   * harnesses; `plan` is the truer constraint for a subscriber using included quota.
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

// ---- LLM (which provider does the app's own offline work, and on which model) ----

/** A model id, or the empty string meaning "clear my override" - see `InspectorConfig.model`. */
const ModelOverrideSchema = z.union([ModelIdSchema, z.literal("")]);

/**
 * Which provider the app's own offline calls spawn through, and which model each of the
 * daemon's background jobs uses. A schema-validated blob over the `app_config` KV, so a
 * new key needs no migration.
 *
 * Both defaults are the shipped behaviour exactly: an operator who never opens this panel
 * gets the same runner and the same model ids the hardcoded constants produced.
 */
export const LlmConfigSchema = z.object({
  /**
   * The runner every offline call goes through, or empty for "whatever the ladder says".
   *
   * `.catch()` rather than a bare enum, and that is load-bearing: this value is PERSISTED,
   * so a downgrade - or a runner withdrawn - leaves a stored id this build cannot resolve.
   * A schema that threw would make `getLlmConfig()` throw, which takes down the settings
   * route, the titler, the goal refiner and the digest at once, over a preference. Falling
   * back is the honest degradation, and `resolveLlmRunner` reports what it dropped so the
   * panel can say so rather than presenting the fallback as the operator's own choice.
   */
  runner: z
    .union([z.enum(LLM_RUNNER_IDS), z.literal("")])
    .catch("")
    .default(""),
  /**
   * Per-job model overrides, keyed by `LlmJobId`. Empty or absent means the ladder decides.
   *
   * Keys are NOT validated on read for the reason above - a blob from a newer build must
   * still parse here, and `resolveLlmJobModels` simply never asks for a job it does not
   * declare. The PATCH below does validate them, so a typo from the dashboard is a 400
   * rather than a key that sits in the config forever doing nothing.
   */
  models: z.record(z.string(), ModelOverrideSchema).catch({}).default({}),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

/**
 * Partial update of the LLM config from the dashboard.
 *
 * Declared rather than derived from `LlmConfigSchema.partial()`, because the config's
 * tolerance is exactly wrong for a write: `.catch()` would turn an unknown runner id from
 * the panel into a silent no-op - the box reverts on the next poll and nothing says why -
 * where a 400 is a refusal the operator can read.
 */
export const LlmConfigPatchSchema = z
  .object({
    runner: z.union([z.enum(LLM_RUNNER_IDS), z.literal("")]),
    models: z
      .record(z.string(), ModelOverrideSchema)
      .refine((m) => Object.keys(m).every((k) => (LLM_JOB_IDS as readonly string[]).includes(k)), {
        message: "unknown job id",
      }),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, { message: "empty config update" });
export type LlmConfigPatch = z.infer<typeof LlmConfigPatchSchema>;

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
  // The human-decision path must retire the prompted episode and raise its Ship it?
  // card in one durable write. If that write fails, neither marker lands and the
  // worker can retry the whole verified boundary on its next unhurried tick.
  ask: z.boolean().optional().default(false),
});
export type PromptedWrapup = z.infer<typeof PromptedWrapupSchema>;

/**
 * Deliver a whole (possibly multi-line) prompt into a session's input as ONE
 * submission, via bracketed paste. Distinct from SendTextSchema because `/send`
 * types literally, where every embedded newline submits - so it cannot deliver a
 * multi-line intent or a bulleted gap list at all.
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
  origin: z.enum(["human", "foreman", "workflow"]).default("human"),
});
export type InjectPrompt = z.infer<typeof InjectPromptSchema>;

/** A checkout-relative file path. The daemon still performs canonical containment checks. */
export const SessionFilePathSchema = z.object({
  path: z.string().min(1).max(4096),
});
export type SessionFilePath = z.infer<typeof SessionFilePathSchema>;

/**
 * Autosave one existing text file. `expectedRevision` is the SHA-256 returned by the
 * last read/save; it makes a write a compare-and-swap instead of silently replacing an
 * agent's concurrent edit.
 */
export const SaveSessionFileSchema = z.object({
  path: z.string().min(1).max(4096),
  text: z.string().max(2 * 1024 * 1024),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SaveSessionFile = z.infer<typeof SaveSessionFileSchema>;

/**
 * Hand one checkout file to an application outside Mission Control.
 *
 * `target` is the registry's id, not a command: `z.enum(OPEN_TARGET_IDS)` is what keeps
 * "which application" a closed set the daemon resolves for itself, so no part of a request
 * ever becomes part of an argv. The path takes the same route as a read - the daemon
 * realpaths it inside the session's checkout before anything is launched.
 */
export const OpenSessionFileSchema = z.object({
  path: z.string().min(1).max(4096),
  target: z.enum(OPEN_TARGET_IDS),
});
export type OpenSessionFile = z.infer<typeof OpenSessionFileSchema>;

/**
 * Open a terminal on a session's checkout - a shell, or that session's own agent CLI
 * resumed on its conversation.
 *
 * Both fields are CLOSED ENUMS, and neither carries anything that reaches an argv.
 * `backend` names a registered adapter the daemon resolves for itself, the way
 * `OpenSessionFileSchema.target` does. `payload` picks between two argvs the daemon
 * composes - the operator's shell from the DAEMON's environment, or the harness's own
 * resume argv - so a request can say which of two things to run and never what to run.
 * A free-text command here would be remote code execution on the daemon's host.
 */
export const LaunchSessionTerminalSchema = z.object({
  backend: z.enum(TERMINAL_BACKEND_IDS),
  payload: z.enum(["shell", "agent"]),
});
export type LaunchSessionTerminal = z.infer<typeof LaunchSessionTerminalSchema>;

// ---- Workflows and Personas -------------------------------------------------

const workflowUtf8 = new TextEncoder();
const utf8AtMost = (value: string, max: number): boolean => workflowUtf8.encode(value).byteLength <= max;
const jsonAtMost = (value: unknown, max: number): boolean =>
  utf8AtMost(JSON.stringify(value), max);

const PersonaNameSchema = z.string().trim().min(1).max(WORKFLOW_LIMITS.personaName);
const PersonaDescriptionSchema = z.string().max(WORKFLOW_LIMITS.personaDescription);

/** Exact Markdown: validation observes it but never transforms it. */
export const PersonaGuidanceSchema = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "Persona guidance cannot be empty" })
  .refine((value) => utf8AtMost(value, WORKFLOW_LIMITS.personaGuidanceBytes), {
    message: `Persona guidance exceeds ${WORKFLOW_LIMITS.personaGuidanceBytes} UTF-8 bytes`,
  });

export const CreatePersonaSchema = z.object({
  name: PersonaNameSchema,
  description: PersonaDescriptionSchema.optional().default(""),
  guidanceMarkdown: PersonaGuidanceSchema,
  runner: z.enum(LLM_RUNNER_IDS).nullable().optional().default(null),
  model: ModelIdSchema.nullable().optional().default(null),
});
export type CreatePersona = z.infer<typeof CreatePersonaSchema>;

const PERSONA_EDIT_FIELDS = ["name", "description", "guidanceMarkdown", "runner", "model"] as const;

export const UpdatePersonaSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: PersonaNameSchema.optional(),
    description: PersonaDescriptionSchema.optional(),
    guidanceMarkdown: PersonaGuidanceSchema.optional(),
    runner: z.enum(LLM_RUNNER_IDS).nullable().optional(),
    model: ModelIdSchema.nullable().optional(),
  })
  .refine((value) => PERSONA_EDIT_FIELDS.some((field) => field in value), {
    message: "Persona update has no editable fields",
  });
export type UpdatePersona = z.infer<typeof UpdatePersonaSchema>;

export const ArchivePersonaSchema = z.object({
  expectedRevision: z.number().int().positive(),
});
export type ArchivePersona = z.infer<typeof ArchivePersonaSchema>;

const WorkflowIdSchema = z.string().min(1).max(200);
const WorkflowNodeIdSchema = z.string().min(1).max(200);
const WorkflowOutcomeSchema = z.string().min(1).max(200);
const WorkflowNameSchema = z.string().trim().min(1).max(WORKFLOW_LIMITS.workflowName);
const WorkflowDescriptionSchema = z.string().max(WORKFLOW_LIMITS.personaDescription);

export const WorkflowPointSchema = z.object({
  x: z.number().finite().min(-WORKFLOW_LIMITS.canvasCoordinateAbs).max(WORKFLOW_LIMITS.canvasCoordinateAbs),
  y: z.number().finite().min(-WORKFLOW_LIMITS.canvasCoordinateAbs).max(WORKFLOW_LIMITS.canvasCoordinateAbs),
});

export const PersonaSnapshotSchema = z.object({
  sourcePersonaId: WorkflowIdSchema,
  sourceRevision: z.number().int().positive(),
  name: PersonaNameSchema,
  description: PersonaDescriptionSchema,
  guidanceMarkdown: PersonaGuidanceSchema,
  runner: z.enum(LLM_RUNNER_IDS).nullable(),
  model: ModelIdSchema.nullable(),
});

export const WorkflowDraftNodeSchema = z.discriminatedUnion("kind", [
  z.object({ id: WorkflowNodeIdSchema, kind: z.literal("session"), position: WorkflowPointSchema }),
  z.object({
    id: WorkflowNodeIdSchema,
    kind: z.literal("persona"),
    personaId: WorkflowIdSchema,
    position: WorkflowPointSchema,
  }),
  z.object({ id: WorkflowNodeIdSchema, kind: z.literal("all_pass"), position: WorkflowPointSchema }),
  z.object({
    id: WorkflowNodeIdSchema,
    kind: z.literal("check"),
    slot: z.enum(WORKFLOW_CHECK_SLOTS),
    position: WorkflowPointSchema,
  }),
  z.object({
    id: WorkflowNodeIdSchema,
    kind: z.literal("end"),
    outcome: WorkflowOutcomeSchema,
    position: WorkflowPointSchema,
  }),
]);

export const PublishedWorkflowNodeSchema = z.discriminatedUnion("kind", [
  z.object({ id: WorkflowNodeIdSchema, kind: z.literal("session"), position: WorkflowPointSchema }),
  z.object({
    id: WorkflowNodeIdSchema,
    kind: z.literal("persona"),
    persona: PersonaSnapshotSchema,
    position: WorkflowPointSchema,
  }),
  z.object({ id: WorkflowNodeIdSchema, kind: z.literal("all_pass"), position: WorkflowPointSchema }),
  // Identical to the draft arm: a Check snapshots nothing, because its command is
  // deliberately not part of the version.
  z.object({
    id: WorkflowNodeIdSchema,
    kind: z.literal("check"),
    slot: z.enum(WORKFLOW_CHECK_SLOTS),
    position: WorkflowPointSchema,
  }),
  z.object({
    id: WorkflowNodeIdSchema,
    kind: z.literal("end"),
    outcome: WorkflowOutcomeSchema,
    position: WorkflowPointSchema,
  }),
]);

export const WorkflowEdgeSchema = z.object({
  id: WorkflowIdSchema,
  source: WorkflowNodeIdSchema,
  sourcePort: z.enum(WORKFLOW_SOURCE_PORTS),
  target: WorkflowNodeIdSchema,
  targetPort: z.enum(WORKFLOW_TARGET_PORTS),
});

const workflowGraph = <T extends z.ZodTypeAny>(node: T) =>
  z
    .object({
      nodes: z.array(node).max(WORKFLOW_LIMITS.graphNodes),
      edges: z.array(WorkflowEdgeSchema).max(WORKFLOW_LIMITS.graphEdges),
    })
    .refine((value) => jsonAtMost(value, WORKFLOW_LIMITS.graphJsonBytes), {
      message: `Workflow graph exceeds ${WORKFLOW_LIMITS.graphJsonBytes} UTF-8 bytes`,
    });

export const WorkflowDraftGraphSchema = workflowGraph(WorkflowDraftNodeSchema);
export const PublishedWorkflowGraphSchema = workflowGraph(PublishedWorkflowNodeSchema);

export const WorkflowCompletionPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("inspector"),
    onFindings: z.enum(INSPECTOR_FINDINGS_POLICIES),
    missingPrAction: z.enum(WORKFLOW_MISSING_PR_ACTIONS),
  }),
]);

export const WorkflowResumptionPolicySchema = z.enum(WORKFLOW_RESUMPTION_POLICIES);

export const WorkflowBindingDefaultsSchema = z.object({
  triggerMode: z.enum(WORKFLOW_TRIGGER_MODES),
  deliveryMode: z.enum(WORKFLOW_DELIVERY_MODES),
  maxRepairRounds: z
    .number()
    .int()
    .min(WORKFLOW_LIMITS.repairRoundsMin)
    .max(WORKFLOW_LIMITS.repairRoundsMax),
});

/** Recursive, JSON-only durable payload validation for later-phase audit columns. */
export const WorkflowJsonSchema: z.ZodType<WorkflowJson> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(WorkflowJsonSchema),
    z.record(z.string(), WorkflowJsonSchema),
  ]),
);

const WorkflowVerdictTextSchema = z.string().trim().min(1);
export const WorkflowEvidenceRefSchema = z.object({
  kind: z.enum(EVIDENCE_REF_KINDS),
  quote: WorkflowVerdictTextSchema.max(WORKFLOW_EXECUTION_LIMITS.verdictReason),
  path: z.string().max(WORKFLOW_EXECUTION_LIMITS.verdictPath).optional(),
  line: z.number().int().min(1).max(WORKFLOW_EXECUTION_LIMITS.verdictLine).optional(),
});

export const WorkflowRequestedChangeSchema = z.object({
  title: WorkflowVerdictTextSchema.max(WORKFLOW_EXECUTION_LIMITS.verdictSummary),
  rationale: WorkflowVerdictTextSchema.max(WORKFLOW_EXECUTION_LIMITS.verdictReason),
  evidence: z
    .array(WorkflowEvidenceRefSchema)
    .min(1)
    .max(WORKFLOW_EXECUTION_LIMITS.verdictEvidence),
  path: z.string().max(WORKFLOW_EXECUTION_LIMITS.verdictPath).optional(),
  line: z.number().int().min(1).max(WORKFLOW_EXECUTION_LIMITS.verdictLine).optional(),
});

export const PersonaVerdictSchema = z
  .discriminatedUnion("verdict", [
    z.object({
      verdict: z.literal("pass"),
      summary: WorkflowVerdictTextSchema.max(WORKFLOW_EXECUTION_LIMITS.verdictSummary),
      approvalDetails: z.object({
        reason: WorkflowVerdictTextSchema.max(WORKFLOW_EXECUTION_LIMITS.verdictReason),
        evidence: z.array(WorkflowEvidenceRefSchema).max(WORKFLOW_EXECUTION_LIMITS.verdictEvidence),
      }),
      confidence: z.number().finite().min(0).max(1),
    }),
    z.object({
      verdict: z.literal("fail"),
      summary: WorkflowVerdictTextSchema.max(WORKFLOW_EXECUTION_LIMITS.verdictSummary),
      requestedChanges: z
        .array(WorkflowRequestedChangeSchema)
        .min(1)
        .max(WORKFLOW_EXECUTION_LIMITS.verdictChanges),
      confidence: z.number().finite().min(0).max(1),
    }),
  ])
  .refine((value) => jsonAtMost(value, WORKFLOW_EXECUTION_LIMITS.verdictJsonBytes), {
    message: `Persona verdict exceeds ${WORKFLOW_EXECUTION_LIMITS.verdictJsonBytes} UTF-8 bytes`,
  });

export const WorkflowHumanDecisionSchema = z.object({
  decision: z.string().max(16_000),
  rationale: z.string().max(16_000).nullable(),
  source: z.object({
    kind: z.enum(["transcript", "review", "foreman_episode"]),
    id: z.string().min(1).max(500),
  }),
});

export const WorkflowContextSnapshotSchema = z.object({
  primaryGoal: z.object({
    rawPrompt: z.string().max(16_000),
    refined: z.string().max(16_000).nullable(),
    sourceNoteKey: z.string().min(1).max(1_000),
  }),
  humanDecisions: z.array(WorkflowHumanDecisionSchema).max(200),
  constraints: z.array(z.string().max(4_000)).max(100),
  acceptanceCriteria: z.array(z.string().max(4_000)).max(100),
  priorPersonaFeedback: z.array(z.object({
    personaName: z.string().max(WORKFLOW_LIMITS.personaName),
    summary: z.string().max(WORKFLOW_EXECUTION_LIMITS.verdictSummary),
    requestedChanges: z.array(z.string().max(WORKFLOW_EXECUTION_LIMITS.verdictSummary)).max(WORKFLOW_EXECUTION_LIMITS.verdictChanges),
  })).max(WORKFLOW_LIMITS.graphNodes),
  session: z.object({
    agent: z.string().min(1).max(100),
    name: z.string().max(500),
    cwd: z.string().max(4_000).nullable(),
    branch: z.string().max(1_000).nullable(),
  }),
  evidence: z.object({
    headSha: z.string().max(100).nullable(),
    diffFingerprint: z.string().min(1).max(200),
    diff: z.string(),
    diffTruncated: z.boolean(),
    workingTreeDirty: z.boolean(),
    workingTreeStatus: z.array(z.string().max(2_000)).max(500),
    workingTreeStatusTruncated: z.boolean().default(false),
    transcript: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().max(48_000),
      timestamp: z.number().int().nonnegative().optional(),
    })).max(100),
    transcriptAnchor: z.number().int().nonnegative().nullable(),
    transcriptTruncated: z.boolean(),
    standards: z.array(z.object({
      path: z.string().max(4_000),
      text: z.string(),
      truncated: z.boolean(),
      fingerprint: z.string().min(1).max(200),
    })).max(200),
    standardsTruncated: z.boolean(),
    retention: z.discriminatedUnion("state", [
      z.object({ state: z.literal("full") }),
      z.object({
        state: z.literal("pruned"),
        prunedAt: z.number().int().nonnegative(),
        diffBytes: z.number().int().nonnegative(),
        workingTreeStatusEntries: z.number().int().nonnegative(),
        transcriptMessages: z.number().int().nonnegative(),
        standardsDocuments: z.number().int().nonnegative(),
      }),
    ]).default({ state: "full" }),
  }),
  compaction: z.object({
    status: z.enum(["model", "fallback"]),
    runner: z.enum(LLM_RUNNER_IDS).nullable(),
    model: z.string().max(500).nullable(),
    error: z.string().max(8_000).nullable(),
  }),
}).refine((value) => jsonAtMost(value, WORKFLOW_EXECUTION_LIMITS.contextJsonBytes), {
  message: `Workflow context exceeds ${WORKFLOW_EXECUTION_LIMITS.contextJsonBytes} UTF-8 bytes`,
});

export const WorkflowInspectorOnlyContextSchema = z.object({
  bypassReason: z.string().min(1).max(16_000),
  failedHeadSha: z.string().min(1).max(100),
  newHeadSha: z.string().min(1).max(100),
  priorFindingFingerprints: z.array(z.string().min(1).max(200)).max(10_000),
}).refine((value) => jsonAtMost(value, WORKFLOW_EXECUTION_LIMITS.contextJsonBytes), {
  message: `Inspector-only context exceeds ${WORKFLOW_EXECUTION_LIMITS.contextJsonBytes} UTF-8 bytes`,
});

export const CreateWorkflowSchema = z.object({
  name: WorkflowNameSchema,
  description: WorkflowDescriptionSchema.optional().default(""),
  draft: WorkflowDraftGraphSchema.optional().default({
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 360, y: 0 } },
    ],
    edges: [],
  }),
  completionPolicy: WorkflowCompletionPolicySchema.optional().default({ kind: "none" }),
  // A NEW draft, so `auto` rather than the `manual` a NULL column reads as - see
  // `WORKFLOW_RESUMPTION_POLICIES`. The two defaults answer different questions.
  resumptionPolicy: WorkflowResumptionPolicySchema.optional().default(DEFAULT_WORKFLOW_RESUMPTION_POLICY),
  bindingDefaults: WorkflowBindingDefaultsSchema.optional().default(DEFAULT_WORKFLOW_BINDING_DEFAULTS),
});
export type CreateWorkflow = z.infer<typeof CreateWorkflowSchema>;

const WORKFLOW_EDIT_FIELDS = [
  "name",
  "description",
  "draft",
  "completionPolicy",
  "resumptionPolicy",
  "bindingDefaults",
] as const;

export const UpdateWorkflowSchema = z
  .object({
    expectedDraftRevision: z.number().int().positive(),
    name: WorkflowNameSchema.optional(),
    description: WorkflowDescriptionSchema.optional(),
    draft: WorkflowDraftGraphSchema.optional(),
    completionPolicy: WorkflowCompletionPolicySchema.optional(),
    resumptionPolicy: WorkflowResumptionPolicySchema.optional(),
    bindingDefaults: WorkflowBindingDefaultsSchema.optional(),
  })
  .refine((value) => WORKFLOW_EDIT_FIELDS.some((field) => field in value), {
    message: "Workflow update has no editable fields",
  });
export type UpdateWorkflow = z.infer<typeof UpdateWorkflowSchema>;
export const UpdateWorkflowDraftSchema = UpdateWorkflowSchema;

export const ValidateWorkflowSchema = z.object({ expectedDraftRevision: z.number().int().positive() });
export const PublishWorkflowSchema = ValidateWorkflowSchema;
export const ArchiveWorkflowSchema = ValidateWorkflowSchema;
export const UnarchiveWorkflowSchema = ValidateWorkflowSchema;
export const DeleteWorkflowSchema = ValidateWorkflowSchema;

export const CreateWorkflowBindingSchema = z.object({
  workflowVersionId: WorkflowIdSchema,
  sessionId: z.string().min(1).max(500),
  triggerMode: z.enum(WORKFLOW_TRIGGER_MODES).optional(),
  deliveryMode: z.enum(WORKFLOW_DELIVERY_MODES).optional(),
  maxRepairRounds: z
    .number()
    .int()
    .min(WORKFLOW_LIMITS.repairRoundsMin)
    .max(WORKFLOW_LIMITS.repairRoundsMax)
    .optional(),
});
export type CreateWorkflowBinding = z.infer<typeof CreateWorkflowBindingSchema>;

export const UpdateWorkflowBindingSchema = z
  .object({
    triggerMode: z.enum(WORKFLOW_TRIGGER_MODES).optional(),
    deliveryMode: z.enum(WORKFLOW_DELIVERY_MODES).optional(),
    maxRepairRounds: z
      .number()
      .int()
      .min(WORKFLOW_LIMITS.repairRoundsMin)
      .max(WORKFLOW_LIMITS.repairRoundsMax)
      .optional(),
    state: z.enum(WORKFLOW_BINDING_STATES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "empty binding update" });
export type UpdateWorkflowBinding = z.infer<typeof UpdateWorkflowBindingSchema>;

export const ArchiveWorkflowBindingSchema = z.object({});

export const ReattachWorkflowBindingSchema = z.object({
  sessionId: z.string().min(1).max(500),
});
export type ReattachWorkflowBinding = z.infer<typeof ReattachWorkflowBindingSchema>;

export const SubmitWorkflowSchema = z.object({
  requestId: z.string().min(1).max(200),
});
export type SubmitWorkflow = z.infer<typeof SubmitWorkflowSchema>;
export const ManualWorkflowSubmitSchema = SubmitWorkflowSchema;

export const ResubmitWorkflowSchema = z.object({
  requestId: z.string().min(1).max(200),
  resubmitUnchanged: z.boolean().optional().default(false),
});
export type ResubmitWorkflow = z.infer<typeof ResubmitWorkflowSchema>;

export const RetryWorkflowRunSchema = z.object({
  requestId: z.string().min(1).max(200),
  nodeAttemptId: WorkflowIdSchema.optional(),
});
export type RetryWorkflowRun = z.infer<typeof RetryWorkflowRunSchema>;

export const CancelWorkflowRunSchema = z.object({
  requestId: z.string().min(1).max(200),
});

export const WorkflowRunActionSchema = z.object({
  requestId: z.string().min(1).max(200),
});
export type WorkflowRunAction = z.infer<typeof WorkflowRunActionSchema>;

export const RestartFullWorkflowSchema = WorkflowRunActionSchema.extend({
  confirmation: z.string().max(200).optional(),
});
export type RestartFullWorkflow = z.infer<typeof RestartFullWorkflowSchema>;

export const WorkflowInspectorGateStateSchema = z.object({
  prKey: z.string().min(1).max(1_000).nullable(),
  prUrl: z.string().url().max(4_000).nullable(),
  targetHeadSha: z.string().min(1).max(100).nullable(),
  failedHeadSha: z.string().min(1).max(100).nullable(),
  enteredAt: z.number().int().nonnegative(),
  lastObservedAt: z.number().int().nonnegative().nullable(),
  observedHeadSha: z.string().min(1).max(100).nullable(),
  reviewPosture: z.enum(["off", "dry-run", "not-allowlisted", "live"]).nullable(),
  waitReason: z.enum(WORKFLOW_GATE_WAIT_REASONS).nullable(),
  findingFingerprints: z
    .array(z.string().min(1).max(200))
    .max(INSPECTOR_LIMITS.maxFindingFingerprints),
});

/**
 * One repository's command for one slot.
 *
 * `command` is bounded three ways because it is a durable blob an operator types: element
 * count, per-element length, and joined length. An unbounded argv is a blob nobody bounded,
 * and the joined bound is the one that matters - 32 arguments of 1,000 characters each is
 * an argv no `execve` will take anyway.
 */
export const WorkflowCheckCommandSchema = z.object({
  repoRoot: z.string().min(1).max(WORKFLOW_LIMITS.checkRepoRoot),
  slot: z.enum(WORKFLOW_CHECK_SLOTS),
  command: z
    .array(z.string().min(1).max(WORKFLOW_LIMITS.checkCommandArg))
    .min(1)
    .max(WORKFLOW_LIMITS.checkCommandArgs)
    .refine(
      (argv) => argv.join(" ").length <= WORKFLOW_LIMITS.checkCommandLength,
      { message: `Check command exceeds ${WORKFLOW_LIMITS.checkCommandLength} characters` },
    ),
});

/**
 * The STRICT schema, and the one the PUT route parses.
 *
 * No `.catch()` anywhere in it, deliberately: this is a write path, and `.catch()` on a
 * write turns an invalid value from the panel into a silent no-op - the field reverts on
 * the next poll and nothing says why - where a 400 is a refusal an operator can read. Read
 * tolerance is `StoredWorkflowConfigSchema` below, which is a different question asked of
 * the same shape.
 */
export const WorkflowConfigSchema = z.object({
  liveEnabled: z.boolean().default(DEFAULT_WORKFLOW_CONFIG.liveEnabled),
  repoAllowlist: z.array(z.string().min(1).max(4_096)).max(500).default([]),
  defaultWorkflowId: z.string().min(1).max(500).nullable()
    .default(DEFAULT_WORKFLOW_CONFIG.defaultWorkflowId),
  retention: z.object({
    rawEvidenceDays: z.number().int().min(1).max(365)
      .default(DEFAULT_WORKFLOW_CONFIG.retention.rawEvidenceDays),
    completedRunDays: z.number().int().min(30).max(3_650)
      .default(DEFAULT_WORKFLOW_CONFIG.retention.completedRunDays),
    maxCompletedRuns: z.number().int().min(100).max(10_000)
      .default(DEFAULT_WORKFLOW_CONFIG.retention.maxCompletedRuns),
  }).default(DEFAULT_WORKFLOW_CONFIG.retention),
  checksEnabled: z.boolean().default(DEFAULT_WORKFLOW_CONFIG.checksEnabled),
  checkCommands: z
    .array(WorkflowCheckCommandSchema)
    .max(WORKFLOW_LIMITS.checkCommands)
    // `(repoRoot, slot)` is the KEY `checkCommandFor` resolves by, so two entries sharing
    // one are two commands an operator can see and only one that can ever run - which of
    // them depends on array order, a thing no surface displays. The panel already replaces
    // rather than appends on a repeat; this is the same rule for a direct API write, which
    // otherwise stores a config the panel could not have produced.
    //
    // REFUSED, not silently deduplicated, for the reason this schema carries no `.catch()`:
    // a write that quietly dropped one of two commands is a caller who sent two and is
    // never told which survived.
    .refine(
      (commands) =>
        new Set(commands.map((entry) => `${entry.repoRoot} ${entry.slot}`)).size
          === commands.length,
      { message: "Each repository may configure a slot only once" },
    )
    .default([]),
});
export type WorkflowConfigInput = z.input<typeof WorkflowConfigSchema>;

/**
 * The same shape read back off `app_config`, where a value this build cannot parse must not
 * throw.
 *
 * `.default()` already covers an UPGRADE - a blob written before a field existed simply
 * lacks it - so this outer `.catch()` is only for a blob that is present and unreadable: a
 * downgrade from a newer build, or a hand-edited row. `getWorkflowConfig` is on the path of
 * every workflow read, every binding gate and the retention sweep, so a throw there takes
 * all of them down over a preference.
 *
 * It falls back to the COMPLETE default rather than field by field, and that is what makes it
 * safe. The falling-back field is `repoAllowlist`, not the consent booleans: the default
 * allowlist is EMPTY, and `repoAllowlisted(cwd, root, [])` is false for every path, so an
 * unreadable config authorises nothing in any repository whatever `liveEnabled` reads as.
 *
 * Stated that way round deliberately. `liveEnabled` now defaults ON, so an argument resting on
 * the boolean would already be wrong; the pair is the gate and only the pair. A field-by-field
 * fallback would be the dangerous one - it could keep a parsed allowlist beside a defaulted
 * consent flag and grant exactly what neither half was written to allow. An operator whose
 * config cannot be read sees the panel showing defaults, which is a state they can fix.
 */
export const StoredWorkflowConfigSchema = WorkflowConfigSchema.catch(DEFAULT_WORKFLOW_CONFIG);

/** What a Check node recorded, read back out of `workflow_node_attempts.output_json`. */
export const WorkflowCheckOutcomeSchema = z.object({
  status: z.enum(WORKFLOW_CHECK_STATUSES),
  slot: z.enum(WORKFLOW_CHECK_SLOTS),
  command: z.array(z.string()).nullable(),
  exitCode: z.number().int().nullable(),
  output: z.string().max(WORKFLOW_EXECUTION_LIMITS.checkOutput),
  truncatedBytes: z.number().int().min(0),
  note: z.string().min(1).max(WORKFLOW_EXECUTION_LIMITS.verdictSummary),
});

export const WorkflowCompletionClaimSchema = z.object({
  completionKind: z.enum(WORKFLOW_COMPLETION_KINDS),
  marker: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().min(1).max(WORKFLOW_EXECUTION_LIMITS.verdictSummary),
  evidenceFingerprint: z.string().min(1).max(200),
  // Closed to the built-in fallback the Foreman option names. The daemon resolves its
  // immutable version; the worker never gets to choose an arbitrary workflow id.
  fallbackWorkflow: z.literal("no-mistakes").nullable().optional().default(null),
  // Optional on the wire only for drain-claim compatibility with an older worker.
  // A prompted claim without it is refused by the daemon rather than trusted.
  expectedGoal: z.string().min(1).max(INTENT_MAX).nullable().optional().default(null),
});
export type WorkflowCompletionClaimInput = z.infer<typeof WorkflowCompletionClaimSchema>;

export const WorkflowCompletionClaimResultSchema = z.discriminatedUnion("claimed", [
  z.object({
    claimed: z.literal(false),
    reason: z.enum(["no_binding", "manual_trigger"]),
  }),
  z.object({
    claimed: z.literal(true),
    runId: z.string().min(1),
    submissionId: z.string().min(1).nullable(),
    state: z.enum(["started", "resubmitted", "already_claimed", "blocked"]),
  }),
]);

export const RetryWorkflowDeliverySchema = z.object({
  requestId: z.string().min(1).max(200),
  expectedSessionId: z.string().min(1),
  expectedNoteKey: z.string().min(1),
});
export type RetryWorkflowDelivery = z.infer<typeof RetryWorkflowDeliverySchema>;

export const ResolveWorkflowDeliverySchema = z.discriminatedUnion("resolution", [
  z.object({
    requestId: z.string().min(1).max(200),
    resolution: z.literal("mark_delivered"),
  }),
  z.object({
    requestId: z.string().min(1).max(200),
    resolution: z.literal("discard_and_new_round"),
    confirmation: z.string().max(200).optional(),
    expectedSessionId: z.string().min(1),
    expectedNoteKey: z.string().min(1),
  }),
]);
export type ResolveWorkflowDelivery = z.infer<typeof ResolveWorkflowDeliverySchema>;

export const WorkflowTriggerSourceSchema = z.enum(WORKFLOW_TRIGGER_SOURCES);
export const WorkflowExternalSourceKindSchema = z.enum(WORKFLOW_EXTERNAL_SOURCE_KINDS);

/**
 * What an externally sourced submission must observe before its evidence becomes durable.
 *
 * `expectedHeadSha` is a complete lowercase SHA-1 or SHA-256 commit id. An abbreviated one is
 * refused rather than resolved: the daemon compares it against exactly what it captured, so a
 * prefix would simply never match and the run would block with a message that blamed the
 * session rather than the request.
 *
 * `requireCleanWorktree` is `z.literal(true)`, matching the wire type: a matching HEAD with
 * uncommitted changes is not the artifact the caller selected, so there is no valid request
 * that turns the check off.
 */
export const WorkflowCaptureExpectationSchema = z.object({
  expectedHeadSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  requireCleanWorktree: z.literal(true),
});

// Exported closed schemas make durable row parsers reject unknown values before constructing
// typed runtime records.
export const WorkflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUSES);
export const WorkflowSubmissionModeSchema = z.enum(WORKFLOW_SUBMISSION_MODES);
export const WorkflowSubmissionStatusSchema = z.enum(WORKFLOW_SUBMISSION_STATUSES);
export const WorkflowNodeAttemptStateSchema = z.enum(WORKFLOW_NODE_ATTEMPT_STATES);

// ---- multi-agent ensembles ----
//
// The durable half of `@shared/ensemble.ts`. Row parsers in `src/server/ensembles/store.ts`
// classify every TEXT enum and validate every JSON column before a typed record exists:
// unknown enums degrade to null for version skew, while malformed JSON fails at ONE boundary
// rather than surfacing as an undefined three call sites later. The store, read routes, MCP
// submission tool and eventual dashboard all consume these shapes rather than inventing a
// second wire vocabulary.

/** Recursive, JSON-only durable payload validation. */
export const EnsembleJsonSchema: z.ZodType<EnsembleJson> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(EnsembleJsonSchema),
    z.record(z.string(), EnsembleJsonSchema),
  ]),
);

export const EnsemblePayloadEnvelopeSchema: z.ZodType<EnsemblePayloadEnvelope> = z.object({
  payloadVersion: z.literal(ENSEMBLE_PAYLOAD_VERSION),
  body: EnsembleJsonSchema,
});

export const EnsembleStatusSchema = z.enum(ENSEMBLE_STATUSES);
export const EnsembleMemberStatusSchema = z.enum(ENSEMBLE_MEMBER_STATUSES);
export const EnsembleAttemptStatusSchema = z.enum(ENSEMBLE_ATTEMPT_STATUSES);
export const EnsembleArtifactKindSchema = z.enum(ENSEMBLE_ARTIFACT_KINDS);
export const EnsembleArtifactStatusSchema = z.enum(ENSEMBLE_ARTIFACT_STATUSES);
export const EnsembleStageDriverKindSchema = z.enum(ENSEMBLE_STAGE_DRIVER_KINDS);
export const EnsembleStageStatusSchema = z.enum(ENSEMBLE_STAGE_STATUSES);
export const EnsembleEvaluationStatusSchema = z.enum(ENSEMBLE_EVALUATION_STATUSES);
export const EnsembleDecisionStatusSchema = z.enum(ENSEMBLE_DECISION_STATUSES);
export const EnsembleDecisionActorSchema = z.enum(ENSEMBLE_DECISION_ACTORS);
export const EnsembleLlmPurposeSchema = z.enum(ENSEMBLE_LLM_PURPOSES);
export const EnsembleLlmCallStateSchema = z.enum(ENSEMBLE_LLM_CALL_STATES);
export const EnsembleSourceKindSchema = z.enum(ENSEMBLE_SOURCE_KINDS);
export const EnsembleStrategyIdSchema = z.enum(ENSEMBLE_STRATEGY_IDS);
export const EnsembleDriverKeySchema = z.enum(ENSEMBLE_DRIVER_KEYS);

/**
 * The opaque `id@version` key a compiled plan persists.
 *
 * Deliberately a bounded STRING and not `EnsembleStrategyIdSchema`: this is the field that
 * lets a run written by a newer build load at all. Creation validates the id against the
 * exhaustive catalog; a plan read back off disk validates only that the key is bounded and
 * well-formed, and an id nobody recognises becomes a visible "this build cannot run it"
 * rather than a parse failure that hides the run entirely.
 */
const VERSIONED_KEY = /^[a-z][a-z0-9_]*@[1-9][0-9]{0,4}$/;

export const EnsembleStrategyKeySchema = z
  .string()
  .min(3)
  .max(ENSEMBLE_LIMITS.strategyKey)
  .regex(VERSIONED_KEY, "strategy key must be id@version");

/**
 * A stage's driver key as PERSISTED - bounded and well-formed, not checked against the
 * drivers this build ships.
 *
 * Same argument as `EnsembleStrategyKeySchema`: a plan naming `comparative_review@2` must
 * stay readable on a build that only has `@1`, so an operator can see what the run was
 * going to do and cancel it. `knownDriverKey` is where "readable" stops and "executable"
 * begins, and `EnsembleDriverKeySchema` above is what a COMPILER's output is checked
 * against, where naming a driver that does not exist is a bug rather than a version skew.
 */
export const EnsembleDriverKeyRefSchema = z
  .string()
  .min(3)
  .max(ENSEMBLE_LIMITS.strategyKey)
  .regex(VERSIONED_KEY, "driver key must be id@version");

const ensembleId = z.string().min(1).max(200);
const ensembleStageId = z.string().min(1).max(ENSEMBLE_LIMITS.stageId);
const ensembleRoleKey = z.string().min(1).max(ENSEMBLE_LIMITS.roleKey);

export const EnsembleBudgetSchema = z.object({
  maxMembers: z.number().int().min(1).max(ENSEMBLE_HARD_LIMITS.maxMembers),
  maxConcurrentMembers: z.number().int().min(1).max(ENSEMBLE_HARD_LIMITS.maxConcurrentMembers),
  maxWaves: z.number().int().min(1).max(ENSEMBLE_HARD_LIMITS.maxWaves),
  maxStageAttempts: z.number().int().min(1).max(ENSEMBLE_HARD_LIMITS.maxStageAttempts),
  deadlineMs: z.number().int().positive().nullable(),
});

export const EnsembleInformationPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("isolated") }),
]);

export const EnsembleMemberInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run_base") }),
  z.object({
    kind: z.literal("parent_artifacts"),
    roleKeys: z.array(ensembleRoleKey).min(1).max(ENSEMBLE_HARD_LIMITS.maxMembers),
  }),
]);

export const EnsembleRoleSpecSchema = z.object({
  key: ensembleRoleKey,
  label: z.string().min(1).max(ENSEMBLE_LIMITS.roleLabel),
  ordinal: z.number().int().positive(),
  wave: z.number().int().positive(),
  agent: z.enum(AGENT_TYPES).nullable(),
  model: ModelIdSchema.nullable(),
  effort: EffortLevelSchema.nullable(),
  approach: z.string().max(ENSEMBLE_LIMITS.approach).nullable(),
  promptTemplate: z.string().max(ENSEMBLE_LIMITS.rolePrompt),
  requiredArtifacts: z.array(EnsembleArtifactKindSchema).max(ENSEMBLE_ARTIFACT_KINDS.length),
  input: EnsembleMemberInputSchema,
});

export const EnsembleBarrierSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("members_settled"),
    roleKeys: z.array(ensembleRoleKey).min(1).max(ENSEMBLE_HARD_LIMITS.maxMembers),
    minEligible: z.number().int().min(1).max(ENSEMBLE_HARD_LIMITS.maxMembers),
    requiredArtifacts: z.array(EnsembleArtifactKindSchema).max(ENSEMBLE_ARTIFACT_KINDS.length),
  }),
  z.object({
    kind: z.literal("stages_succeeded"),
    stageIds: z.array(ensembleStageId).min(1).max(50),
  }),
  z.object({ kind: z.literal("human_decision") }),
]);

export const EnsembleEvaluatorGuidanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin"), rubricId: z.string().min(1).max(120) }),
  z.object({
    kind: z.literal("persona"),
    personaId: z.string().min(1).max(200),
    revision: z.number().int().positive(),
    name: z.string().min(1).max(200),
    // The pinned guidance bytes. Bounded to `reviewGuidanceBytes` rather than the Persona's
    // own 100 KiB ceiling because this text lives inside the byte-capped compiled plan; the
    // resolver truncates to this bound before the plan is ever validated.
    guidanceMarkdown: z
      .string()
      .refine((value) => utf8AtMost(value, ENSEMBLE_LIMITS.reviewGuidanceBytes), {
        message: `guidance exceeds ${ENSEMBLE_LIMITS.reviewGuidanceBytes} UTF-8 bytes`,
      }),
    runner: z.enum(LLM_RUNNER_IDS).nullable(),
    model: ModelIdSchema.nullable(),
  }),
]);

export const EnsemblePanelJudgeSpecSchema = z.object({
  key: z.string().min(1).max(ENSEMBLE_LIMITS.roleKey),
  label: z.string().min(1).max(ENSEMBLE_LIMITS.roleLabel),
  ordinal: z.number().int().positive(),
  guidance: EnsembleEvaluatorGuidanceSchema,
  runner: z.enum(LLM_RUNNER_IDS).nullable(),
  model: ModelIdSchema.nullable(),
});

/**
 * A review stage's evaluator, as a discriminated union.
 *
 * The panel arm's `minSuccessfulJudges` is bounded at both ends against the judge count by the
 * refinement below rather than by a constant: a quorum of one is a panel that can recommend from a
 * single surviving ballot (whose disagreement measure is vacuously zero, which reads on screen as
 * unanimity), and a quorum above the judge count is a stage that can never succeed. Both are plans
 * the compiler must be unable to emit, and this is where an in-flight snapshot written by any
 * build is held to it.
 */
export const EnsembleEvaluatorPolicySchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("comparative_llm"),
      guidance: EnsembleEvaluatorGuidanceSchema,
      runner: z.enum(LLM_RUNNER_IDS).nullable(),
      model: ModelIdSchema.nullable(),
      anonymizeSubjects: z.boolean(),
      materialBudgetBytes: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal("consensus_llm"),
      guidance: EnsembleEvaluatorGuidanceSchema,
      runner: z.enum(LLM_RUNNER_IDS).nullable(),
      model: ModelIdSchema.nullable(),
      anonymizeSubjects: z.boolean(),
      materialBudgetBytes: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal("panel_llm"),
      judges: z.array(EnsemblePanelJudgeSpecSchema).min(2).max(ENSEMBLE_HARD_LIMITS.maxMembers),
      minSuccessfulJudges: z.number().int().min(2).max(ENSEMBLE_HARD_LIMITS.maxMembers),
      anonymizeSubjects: z.boolean(),
      materialBudgetBytes: z.number().int().positive(),
    }),
  ])
  .superRefine((policy, ctx) => {
    if (policy.kind !== "panel_llm") return;
    if (policy.minSuccessfulJudges > policy.judges.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minSuccessfulJudges"],
        message: "the quorum cannot exceed the number of judges on the panel",
      });
    }
    const keys = new Set(policy.judges.map((judge) => judge.key));
    if (keys.size !== policy.judges.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["judges"], message: "judge keys must be unique" });
    }
  });

export const EnsembleSubjectPolicySchema = z.object({
  kind: z.literal("ready_artifacts"),
  artifactKind: EnsembleArtifactKindSchema,
  minSubjects: z.number().int().min(1).max(ENSEMBLE_HARD_LIMITS.maxMembers),
  maxSubjects: z.number().int().min(1).max(ENSEMBLE_HARD_LIMITS.maxMembers),
});

/**
 * Both members carry the same two eligibility fields because the generic engine reads them
 * WITHOUT narrowing on the kind - see `EnsembleDecisionPolicy`. `answer_divergences` renders its
 * options from the decision stage's persisted input rather than from a static scorecard.
 */
export const EnsembleDecisionPolicySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("select_one"),
    eligibleArtifactKind: EnsembleArtifactKindSchema,
    minEligibleSubjects: z.number().int().min(1).max(ENSEMBLE_HARD_LIMITS.maxMembers),
  }),
  z.object({
    kind: z.literal("answer_divergences"),
    eligibleArtifactKind: EnsembleArtifactKindSchema,
    minEligibleSubjects: z.number().int().min(1).max(ENSEMBLE_HARD_LIMITS.maxMembers),
  }),
]);

/**
 * `requiresHumanDecision` is `z.literal(true)` on every member, matching the wire type and
 * `WorkflowCaptureExpectationSchema.requireCleanWorktree`. `select_one` finalization resets a
 * branch and reaps worktrees, so there is no valid plan that turns the confirmation off;
 * `retain_all` destroys nothing but its terminal outcome IS the human's answer, so a plan that
 * could reach it unattended would file a question set as settled.
 */
export const EnsembleFinalizationPolicySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("select_one"),
    requiresHumanDecision: z.literal(true),
    loserPolicy: z.literal("reap_worktrees"),
  }),
  z.object({
    kind: z.literal("retain_all"),
    requiresHumanDecision: z.literal(true),
    loserPolicy: z.literal("retain"),
  }),
]);

const ensembleStageBase = {
  id: ensembleStageId,
  ordinal: z.number().int().positive(),
  label: z.string().min(1).max(ENSEMBLE_LIMITS.stageLabel),
  driverKey: EnsembleDriverKeyRefSchema,
  dependsOn: z.array(ensembleStageId).max(50),
  barrier: EnsembleBarrierSpecSchema,
  maxAttempts: z.number().int().min(1).max(ENSEMBLE_HARD_LIMITS.maxStageAttempts),
};

export const EnsembleStageSpecSchema = z.discriminatedUnion("driverKind", [
  z.object({
    ...ensembleStageBase,
    driverKind: z.literal("member"),
    wave: z.number().int().positive(),
    roleKeys: z.array(ensembleRoleKey).min(1).max(ENSEMBLE_HARD_LIMITS.maxMembers),
  }),
  z.object({
    ...ensembleStageBase,
    driverKind: z.literal("review"),
    evaluator: EnsembleEvaluatorPolicySchema,
    subjects: EnsembleSubjectPolicySchema,
  }),
  z.object({
    ...ensembleStageBase,
    driverKind: z.literal("decision"),
    decision: EnsembleDecisionPolicySchema,
  }),
  z.object({
    ...ensembleStageBase,
    driverKind: z.literal("finalize"),
    finalization: EnsembleFinalizationPolicySchema,
  }),
]);

/**
 * The immutable plan a run executes for its whole life.
 *
 * `planVersion` is pinned to exactly what this build understands. A snapshot from the future
 * fails HERE, which is what turns it into a visible unreadable run rather than a plan
 * half-read through today's field names.
 */
export const CompiledEnsemblePlanSchema = z
  .object({
    planVersion: z.literal(ENSEMBLE_PLAN_VERSION),
    strategyKey: EnsembleStrategyKeySchema,
    budget: EnsembleBudgetSchema,
    information: EnsembleInformationPolicySchema,
    roles: z.array(EnsembleRoleSpecSchema).min(1).max(ENSEMBLE_HARD_LIMITS.maxMembers),
    stages: z.array(EnsembleStageSpecSchema).min(1).max(50),
  })
  // Structural integrity, checked once here rather than in each compiler and again in the
  // engine: a stage naming a role or a dependency that does not exist is a plan that would
  // block forever at a barrier nothing can satisfy, and it would do so only at runtime.
  .superRefine((plan, ctx) => {
    const roleKeys = new Set(plan.roles.map((role) => role.key));
    if (roleKeys.size !== plan.roles.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles"], message: "role keys must be unique" });
    }
    if (plan.roles.length > plan.budget.maxMembers) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["budget", "maxMembers"],
        message: "the compiled roster is larger than the plan's own hard member cap",
      });
    }
    if (plan.budget.maxConcurrentMembers > plan.budget.maxMembers) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["budget", "maxConcurrentMembers"],
        message: "concurrent members cannot exceed the plan's member cap",
      });
    }
    const waveOf = new Map(plan.roles.map((role) => [role.key, role.wave]));
    plan.roles.forEach((role, index) => {
      if (role.wave > plan.budget.maxWaves) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roles", index, "wave"],
          message: `role ${role.key} exceeds the plan's wave cap`,
        });
      }
      // A parent-artifact input names the roles whose immutable artifacts this member starts
      // from. Each parent must exist and must launch in an EARLIER wave, or the launch runtime
      // would wait on an artifact from a member that has not run - the same forever-blocked
      // barrier the checks above rule out, arriving through the input edge instead.
      if (role.input.kind === "parent_artifacts") {
        for (const parentKey of role.input.roleKeys) {
          const parentWave = waveOf.get(parentKey);
          if (parentWave === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["roles", index, "input", "roleKeys"],
              message: `role ${role.key} starts from unknown role ${parentKey}`,
            });
          } else if (parentWave >= role.wave) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["roles", index, "input", "roleKeys"],
              message: `role ${role.key} starts from ${parentKey}, which is not in an earlier wave`,
            });
          }
        }
      }
    });
    const stageIds = new Set(plan.stages.map((stage) => stage.id));
    if (stageIds.size !== plan.stages.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stages"], message: "stage ids must be unique" });
    }
    plan.stages.forEach((stage, index) => {
      if (stage.maxAttempts > plan.budget.maxStageAttempts) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index, "maxAttempts"],
          message: `stage ${stage.id} exceeds the plan's attempt cap`,
        });
      }
      for (const dependency of stage.dependsOn) {
        if (!stageIds.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, "dependsOn"],
            message: `stage ${stage.id} depends on unknown stage ${dependency}`,
          });
        }
      }
      const named =
        stage.driverKind === "member"
          ? stage.roleKeys
          : stage.barrier.kind === "members_settled"
            ? stage.barrier.roleKeys
            : [];
      for (const key of named) {
        if (!roleKeys.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index],
            message: `stage ${stage.id} names unknown role ${key}`,
          });
        }
      }
      if (stage.driverKind === "member") {
        if (stage.wave > plan.budget.maxWaves) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, "wave"],
            message: `stage ${stage.id} exceeds the plan's wave cap`,
          });
        }
        if (new Set(stage.roleKeys).size !== stage.roleKeys.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, "roleKeys"],
            message: `stage ${stage.id} role keys must be unique`,
          });
        }
      }
      if (stage.barrier.kind === "members_settled") {
        const barrierRoles = new Set(stage.barrier.roleKeys);
        if (barrierRoles.size !== stage.barrier.roleKeys.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, "barrier", "roleKeys"],
            message: `stage ${stage.id} barrier role keys must be unique`,
          });
        }
        if (stage.barrier.minEligible > barrierRoles.size) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, "barrier", "minEligible"],
            message: `stage ${stage.id} requires more eligible members than it names`,
          });
        }
      }
      if (stage.driverKind === "review") {
        if (stage.subjects.minSubjects > stage.subjects.maxSubjects) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, "subjects", "minSubjects"],
            message: `stage ${stage.id} minimum subjects exceed its maximum`,
          });
        }
        if (stage.subjects.maxSubjects > plan.budget.maxMembers) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, "subjects", "maxSubjects"],
            message: `stage ${stage.id} subjects exceed the plan's member cap`,
          });
        }
      }
      if (
        stage.driverKind === "decision" &&
        stage.decision.minEligibleSubjects > plan.budget.maxMembers
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index, "decision", "minEligibleSubjects"],
          message: `stage ${stage.id} eligible subjects exceed the plan's member cap`,
        });
      }
      if (stage.barrier.kind === "stages_succeeded") {
        for (const dependency of stage.barrier.stageIds) {
          if (!stageIds.has(dependency)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["stages", index, "barrier"],
              message: `stage ${stage.id} waits on unknown stage ${dependency}`,
            });
          }
        }
      }
    });

    const dependencies = new Map(
      plan.stages.map((stage) => [
        stage.id,
        [
          ...stage.dependsOn,
          ...(stage.barrier.kind === "stages_succeeded" ? stage.barrier.stageIds : []),
        ],
      ]),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cyclic = new Set<string>();
    const visit = (stageId: string): void => {
      if (visited.has(stageId)) return;
      if (visiting.has(stageId)) {
        cyclic.add(stageId);
        return;
      }
      visiting.add(stageId);
      for (const dependency of dependencies.get(stageId) ?? []) {
        if (!dependencies.has(dependency)) continue;
        visit(dependency);
        if (cyclic.has(dependency)) cyclic.add(stageId);
      }
      visiting.delete(stageId);
      visited.add(stageId);
    };
    for (const stage of plan.stages) visit(stage.id);
    if (cyclic.size > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages"],
        message: `stage dependencies must be acyclic: ${[...cyclic].join(", ")}`,
      });
    }
  });

export const EnsembleOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("selected"),
    memberIds: z.array(ensembleId).max(ENSEMBLE_HARD_LIMITS.maxMembers),
    artifactIds: z.array(ensembleId).max(ENSEMBLE_HARD_LIMITS.maxMembers),
    materializedTaskId: ensembleId.nullable(),
  }),
  z.object({
    kind: z.literal("synthesized"),
    memberId: ensembleId,
    artifactId: ensembleId,
    materializedTaskId: ensembleId.nullable(),
  }),
  z.object({
    kind: z.literal("retained"),
    memberIds: z.array(ensembleId).max(ENSEMBLE_HARD_LIMITS.maxMembers),
    artifactIds: z.array(ensembleId).max(ENSEMBLE_HARD_LIMITS.maxMembers),
  }),
  z.object({
    kind: z.literal("no_consensus"),
    artifactIds: z.array(ensembleId).max(ENSEMBLE_HARD_LIMITS.maxMembers),
    reason: z.string().max(ENSEMBLE_LIMITS.rationale),
  }),
]);

export const EnsembleUnreadableSchema: z.ZodType<EnsembleUnreadable> = z.object({
  reason: z.string(),
  fields: z.array(z.string()),
});

/**
 * The pinned post-selection Workflow handoff snapshot, validated on read.
 *
 * Full commit ids only for `expectedHeadSha` (the same 40/64-hex shape Workflow capture
 * expectations use) - a ref name would mean something different an hour later, which is the
 * drift a pin exists to remove. The mode fields are bounded free strings because they are a
 * display snapshot of the pinned defaults, not a live enum this build must be able to name.
 */
export const EnsembleWorkflowHandoffSchema: z.ZodType<EnsembleWorkflowHandoff> = z.object({
  workflowId: z.string().min(1).max(200),
  workflowVersionId: z.string().min(1).max(200),
  workflowVersion: z.number().int(),
  workflowName: z.string().max(ENSEMBLE_LIMITS.strategyLabel),
  triggerMode: z.string().max(60),
  deliveryMode: z.string().max(60),
  maxRepairRounds: z.number().int(),
  completionPolicy: z.string().max(60),
  state: z.enum(ENSEMBLE_WORKFLOW_HANDOFF_STATES),
  sourceKey: z.string().max(ENSEMBLE_LIMITS.sourceKey).nullable(),
  expectedHeadSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).nullable(),
  bindingId: z.string().min(1).max(200).nullable(),
  runId: z.string().min(1).max(200).nullable(),
  submissionId: z.string().min(1).max(200).nullable(),
  error: z.string().max(ENSEMBLE_LIMITS.errorText).nullable(),
});

export const EnsembleRunSchema: z.ZodType<EnsembleRun> = z.object({
  id: ensembleId,
  sourceKind: EnsembleSourceKindSchema.nullable(),
  sourceKey: z.string(),
  sourceId: z.string().nullable(),
  strategyId: EnsembleStrategyIdSchema.nullable(),
  strategyKey: z.string(),
  strategyVersion: z.number().int(),
  strategyLabel: z.string(),
  title: z.string(),
  intent: z.string(),
  repoRoot: z.string(),
  baseBranch: z.string().nullable(),
  baseSha: z.string().nullable(),
  plan: CompiledEnsemblePlanSchema.nullable(),
  strategyConfig: EnsembleJsonSchema,
  status: EnsembleStatusSchema.nullable(),
  activeStageId: z.string().nullable(),
  outcome: EnsembleOutcomeSchema.nullable(),
  workflowHandoff: EnsembleWorkflowHandoffSchema.nullable(),
  unreadable: EnsembleUnreadableSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  completedAt: z.number().int().nullable(),
});

export const EnsembleMemberSchema: z.ZodType<EnsembleMember> = z.object({
  id: ensembleId,
  runId: ensembleId,
  roleKey: z.string(),
  roleLabel: z.string(),
  ordinal: z.number().int(),
  wave: z.number().int(),
  taskId: z.string().nullable(),
  status: EnsembleMemberStatusSchema.nullable(),
  selectedAttemptId: z.string().nullable(),
  resultLabel: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const EnsembleAttemptSchema: z.ZodType<EnsembleAttempt> = z.object({
  id: ensembleId,
  runId: ensembleId,
  memberId: ensembleId,
  attempt: z.number().int(),
  taskId: z.string().nullable(),
  sessionId: z.string().nullable(),
  agent: z.enum(AGENT_TYPES).nullable(),
  requestedModel: z.string().nullable(),
  requestedEffort: EffortLevelSchema.nullable(),
  observedModel: z.string().nullable(),
  baseSha: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  status: EnsembleAttemptStatusSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
});

export const EnsembleArtifactSchema: z.ZodType<EnsembleArtifact> = z.object({
  id: ensembleId,
  runId: ensembleId,
  attemptId: z.string().nullable(),
  kind: EnsembleArtifactKindSchema.nullable(),
  formatVersion: z.number().int(),
  attempt: z.number().int(),
  status: EnsembleArtifactStatusSchema.nullable(),
  locator: EnsembleJsonSchema,
  digest: z.string(),
  metadata: EnsembleJsonSchema,
  error: z.string().nullable(),
  createdAt: z.number().int(),
  readyAt: z.number().int().nullable(),
});

export const EnsembleStageAttemptSchema: z.ZodType<EnsembleStageAttempt> = z.object({
  id: ensembleId,
  runId: ensembleId,
  stageId: z.string(),
  driverKind: EnsembleStageDriverKindSchema.nullable(),
  driverKey: EnsembleDriverKeySchema.nullable(),
  attempt: z.number().int(),
  commandKey: z.string(),
  status: EnsembleStageStatusSchema.nullable(),
  input: EnsembleJsonSchema,
  output: EnsembleJsonSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
});

export const EnsembleEvaluationSchema: z.ZodType<EnsembleEvaluation> = z.object({
  id: ensembleId,
  runId: ensembleId,
  stageAttemptId: ensembleId,
  attempt: z.number().int(),
  method: z.string(),
  runnerId: z.string().nullable(),
  modelId: z.string().nullable(),
  inputFingerprint: z.string(),
  subjectArtifactIds: z.array(z.string()),
  result: EnsemblePayloadEnvelopeSchema.nullable(),
  status: EnsembleEvaluationStatusSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
});

export const EnsembleLlmCallSchema: z.ZodType<EnsembleLlmCall> = z.object({
  id: ensembleId,
  runId: ensembleId,
  stageAttemptId: z.string().nullable(),
  evaluationId: z.string().nullable(),
  purpose: EnsembleLlmPurposeSchema.nullable(),
  runnerId: z.string(),
  modelId: z.string(),
  attempt: z.number().int(),
  state: EnsembleLlmCallStateSchema.nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  inputBytes: z.number().int(),
  outputBytes: z.number().int(),
  costUsd: z.number().nullable(),
  errorCode: z.string().nullable(),
});

export const EnsembleDecisionSchema: z.ZodType<EnsembleDecision> = z.object({
  id: ensembleId,
  runId: ensembleId,
  version: z.number().int(),
  actor: EnsembleDecisionActorSchema.nullable(),
  actorId: z.string().nullable(),
  status: EnsembleDecisionStatusSchema.nullable(),
  selection: EnsemblePayloadEnvelopeSchema,
  rationale: z.string(),
  finalizationStageAttemptId: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const EnsembleEventSchema: z.ZodType<EnsembleEvent> = z.object({
  id: z.number().int(),
  runId: ensembleId,
  ts: z.number().int(),
  kind: z.string(),
  payload: EnsembleJsonSchema,
});

export const EnsembleSummarySchema: z.ZodType<EnsembleSummary> = z.object({
  id: ensembleId,
  title: z.string(),
  repoRoot: z.string(),
  strategyId: EnsembleStrategyIdSchema.nullable(),
  strategyKey: z.string(),
  strategyLabel: z.string(),
  strategyVersion: z.number().int(),
  status: EnsembleStatusSchema.nullable(),
  activeStageId: z.string().nullable(),
  memberCount: z.number().int().nonnegative(),
  launchedMembers: z.number().int().nonnegative(),
  maxMembers: z.number().int().nonnegative(),
  readyArtifacts: z.number().int().nonnegative(),
  membersOut: z.number().int().nonnegative(),
  membersNeedingInput: z.number().int().nonnegative(),
  membersReady: z.number().int().nonnegative(),
  selectedMemberId: z.string().nullable(),
  outcomeKind: z.enum(ENSEMBLE_OUTCOME_KINDS).nullable(),
  unreadable: EnsembleUnreadableSchema.nullable(),
  attention: z.boolean(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  completedAt: z.number().int().nullable(),
});

export const EnsembleRunDetailSchema: z.ZodType<EnsembleRunDetail> = z.object({
  run: EnsembleRunSchema,
  members: z.array(EnsembleMemberSchema),
  attempts: z.array(EnsembleAttemptSchema),
  artifacts: z.array(EnsembleArtifactSchema),
  stageAttempts: z.array(EnsembleStageAttemptSchema),
  evaluations: z.array(EnsembleEvaluationSchema),
  decisions: z.array(EnsembleDecisionSchema),
  llmCalls: z.array(EnsembleLlmCallSchema),
  events: z.array(EnsembleEventSchema),
});

/**
 * What a caller asks for.
 *
 * `strategyConfig` stays `unknown` here on purpose: the generic envelope must not know what
 * a roster is, and the chosen strategy's own schema is the only thing that can validate it.
 * The daemon re-parses it through the descriptor at creation, which is the one place the
 * config's type is known - the same split `TaskSourceInstanceSchema` makes.
 */
/**
 * An operator's optional choice to review the finalized winner through a published Workflow.
 *
 * Both a workflow id AND a version number: the daemon resolves them to one immutable published
 * version at creation and pins its display snapshot, so a later edit or archive cannot re-aim it.
 * A caller never supplies the version id, binding defaults, or mode - those are read off the
 * pinned version, and an unsupported mode (Live/Foreman) is a typed refusal, not a Preview
 * downgrade.
 */
export const EnsembleWorkflowPlacementSchema = z.object({
  workflowId: z.string().min(1).max(200),
  workflowVersion: z.number().int().positive(),
});
export type EnsembleWorkflowPlacement = z.infer<typeof EnsembleWorkflowPlacementSchema>;

export const EnsembleCreateInputSchema = z.object({
  sourceKey: z.string().min(1).max(ENSEMBLE_LIMITS.sourceKey),
  sourceKind: EnsembleSourceKindSchema.default("manual"),
  sourceId: z.string().min(1).max(ENSEMBLE_LIMITS.sourceId).nullable().default(null),
  title: z.string().trim().min(1).max(ENSEMBLE_LIMITS.title),
  intent: z.string().min(1).max(ENSEMBLE_LIMITS.intent),
  repoRoot: z.string().min(1),
  strategyId: EnsembleStrategyIdSchema,
  /** Absent means "this build's current version for that strategy". */
  strategyVersion: z.number().int().positive().optional(),
  strategyConfig: z.unknown().default({}),
  /** Optional post-selection Workflow handoff; the daemon resolves it to an immutable version. */
  workflow: EnsembleWorkflowPlacementSchema.nullable().default(null),
});
export type EnsembleCreateBody = z.infer<typeof EnsembleCreateInputSchema>;

/**
 * A side-effect-free draft validation, sharing the create body's shape so an estimate the
 * preview shows can never drift from what create would accept. `sourceKey` stays required so
 * the two bodies are one shape; preview never persists it.
 */
export const EnsemblePreviewSchema = EnsembleCreateInputSchema;
export type EnsemblePreviewBody = z.infer<typeof EnsemblePreviewSchema>;

/**
 * Explicit terminal-history/ref deletion, confirmed by echoing the run id.
 *
 * The id is in the URL AND the body, and they must match: deletion removes generated private
 * refs, and a body-less DELETE is one accidental double-click from erasing a run's evidence.
 */
export const EnsembleDeleteSchema = z.object({ confirmId: ensembleId });
export type EnsembleDeleteBody = z.infer<typeof EnsembleDeleteSchema>;

/**
 * The generic operator authorities over one run.
 *
 * One discriminated union behind the actions route rather than a route family per verb: a
 * strategy composed only from existing primitives must add nothing here, so a proposal that
 * needs a new member is evidence of a new primitive rather than a new strategy.
 */
export const EnsembleActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("retry_stage"), stageId: ensembleStageId }),
  z.object({ kind: z.literal("retry_member"), memberId: ensembleId }),
  z.object({ kind: z.literal("withdraw_member"), memberId: ensembleId }),
  z.object({
    kind: z.literal("decide"),
    /** Client-stable idempotency key: a lost response returns the same recorded decision. */
    requestId: z.string().min(1).max(900),
    /** The state the caller believes it is deciding in. A mismatch is a `409`, never an act. */
    expectedStatus: EnsembleStatusSchema,
    /** The outcome, re-validated by the compiled decision driver against eligible artifacts. */
    selection: EnsembleJsonSchema,
    rationale: z.string().max(ENSEMBLE_LIMITS.rationale).default(""),
    /** The literal `true`: destructive finalization is unreachable without explicit confirmation. */
    confirmDestructive: z.literal(true),
  }),
  z.object({
    kind: z.literal("resolve_finalization"),
    /** True abandons a blocked Workflow handoff and finishes with the normal continuation. */
    skipWorkflowHandoff: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("cancel"), reason: z.string().max(ENSEMBLE_LIMITS.rationale).nullable().default(null) }),
  z.object({ kind: z.literal("restore_artifact"), artifactId: ensembleId }),
]);
export type EnsembleActionBody = z.infer<typeof EnsembleActionSchema>;

/**
 * The `select_one` decision selection, mirrored here and in the server driver so both boundaries
 * reject the same bodies. Cancelling is a separate authority; a decision that destroys is never
 * accidental.
 */
export const EnsembleSelectOneSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selected"), artifactId: ensembleId }),
  z.object({ kind: z.literal("no_consensus"), reason: z.string().max(ENSEMBLE_LIMITS.rationale) }),
]);
export type EnsembleSelectOneSelectionBody = z.infer<typeof EnsembleSelectOneSelectionSchema>;

/**
 * The `answer_divergences` selection is NOT mirrored here.
 *
 * `ConsensusAnswersSelectionSchema` (`./ensemble-strategies/consensus.ts`) is the one spelling,
 * imported directly by the divergence decision driver the way the comparative reviewer imports
 * its own result schema. Restating it here would put a second copy on the wire boundary, and
 * re-exporting it would close an import cycle - that module imports `ModelIdSchema` from this
 * one, and a cycle between two files full of module-level zod schemas is an initialization order
 * bug waiting for the first importer that resolves them the other way round.
 */

// ---- Recurring Missions (schedule catalog) ----

/**
 * The mission a due instant files, validated to the SHAPE a `ScheduleTemplate` needs.
 *
 * `title` is required here for the reason it is required nowhere else a task is created: a
 * recurring mission files the same work over and over, and an untitled task takes the
 * model-titling path, spending an LLM call on every single run to derive the same string.
 * `labels` normalizes in the schema, like `TASK_TRIAGE_FIELDS`, so no writer reaches the
 * store with duplicated or unbounded tags.
 */
const ScheduleTemplateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    intent: z.string().trim().min(1),
    repoRoot: z.string().min(1),
    kind: z.enum(["ship", "scout"]).default("ship"),
    agent: z.enum(AGENT_TYPES).default("claude"),
    priority: z.enum(TASK_PRIORITIES).nullable().default(null),
    labels: z.array(z.string()).max(MAX_LABELS).default([]).transform(normalizeLabels),
    model: ModelIdSchema.nullable().default(null),
    effort: EffortLevelSchema.nullable().default(null),
  })
  .refine((t) => t.effort === null || supportsEffort(t.agent, t.effort), {
    path: ["effort"],
    message: "reasoning effort is not supported by this harness",
  });

/**
 * The one editable definition preview, create, and update all share, so the browser can
 * never preview a value the save route would refuse.
 *
 * Shape only. The cron is checked for exactly five fields HERE - `cron-parser` accepts
 * three through six, so a six-field seconds expression would otherwise parse and schedule
 * a mission every second - but its semantics, the IANA zone, and the minimum interval stay
 * with the Phase 2 service, which owns the recurrence evaluator. `executionMode` and
 * `runnerId` are pinned to their only V1 values rather than dropped: a form that offered
 * `remote-runner` would be offering a promise this build does not keep, and the schema is
 * where that is refused, not the manager.
 */
const ScheduleDefinitionSchema = z.object({
  name: z.string().trim().min(1),
  expression: z
    .string()
    .min(1)
    .refine((expr) => cronFieldCount(expr) === SCHEDULE_CRON_FIELD_COUNT, {
      message: "a cron expression must have exactly five space-separated fields",
    }),
  timezone: z.string().trim().min(1),
  overlapPolicy: z.enum(SCHEDULE_OVERLAP_POLICIES),
  missedPolicy: z.enum(SCHEDULE_MISSED_POLICIES),
  executionMode: z.literal("local-catchup").optional().default("local-catchup"),
  runnerId: z.null().optional().default(null),
  template: ScheduleTemplateSchema,
});
export type ScheduleDefinitionBody = z.infer<typeof ScheduleDefinitionSchema>;

/** Create a schedule. `enabled` defaults to true; save paused sends `enabled: false`. */
export const CreateScheduleSchema = ScheduleDefinitionSchema.extend({
  enabled: z.boolean().optional().default(true),
});
export type CreateScheduleBody = z.infer<typeof CreateScheduleSchema>;

/** Edit a schedule. The same definition, applied as a new immutable revision by the service. */
export const UpdateScheduleSchema = ScheduleDefinitionSchema;
export type UpdateScheduleBody = z.infer<typeof UpdateScheduleSchema>;

/**
 * Preview an unsaved definition, plus the knobs a preview alone needs.
 *
 * It IS the save definition with preview-only fields added, so the same shape validation
 * runs. `count` is bounded to the 10-50 the source plan promised. The standby simulation is
 * both-or-neither and ordered: a lone `sleepStartedAt` describes no window, and a
 * `resumedAt` before it describes one that ran backwards.
 */
export const SchedulePreviewSchema = ScheduleDefinitionSchema.extend({
  count: z.number().int().min(SCHEDULE_PREVIEW_DEFAULT_COUNT).max(SCHEDULE_PREVIEW_MAX_COUNT).optional(),
  after: z.number().int().nonnegative().optional(),
  sleepStartedAt: z.number().int().nonnegative().optional(),
  resumedAt: z.number().int().nonnegative().optional(),
  excludeScheduleId: z.string().min(1).optional(),
})
  .refine((v) => (v.sleepStartedAt === undefined) === (v.resumedAt === undefined), {
    path: ["resumedAt"],
    message: "a standby simulation needs both sleepStartedAt and resumedAt, or neither",
  })
  .refine((v) => v.sleepStartedAt === undefined || v.resumedAt === undefined || v.resumedAt > v.sleepStartedAt, {
    path: ["resumedAt"],
    message: "resumedAt must be after sleepStartedAt",
  });
export type SchedulePreviewBody = z.infer<typeof SchedulePreviewSchema>;

/** Pause or resume. The service recomputes the cursor from the correct anchor. */
export const SetScheduleEnabledSchema = z.object({ enabled: z.boolean() });
export type SetScheduleEnabledBody = z.infer<typeof SetScheduleEnabledSchema>;

/**
 * Run now and Archive carry no body, but they still go through `parseBody`: a `.strict()`
 * empty object refuses a stray key rather than hand-parsing arbitrary JSON, so a caller
 * that thinks it is passing an argument learns it is not.
 */
export const RunScheduleNowSchema = z.object({}).strict();
export const ArchiveScheduleSchema = z.object({}).strict();

/**
 * The occurrence-history query. `before` is the opaque cursor a prior page returned - a
 * numeric instant - and `limit` is bounded; an unparseable cursor or an out-of-range limit
 * is REFUSED, not clamped, because a history route that silently reinterpreted a bad cursor
 * would page through the wrong window and look like it worked.
 */
export const ScheduleHistoryQuerySchema = z.object({
  before: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(SCHEDULE_HISTORY_MAX_LIMIT).optional(),
});
export type ScheduleHistoryQuery = z.infer<typeof ScheduleHistoryQuerySchema>;

/**
 * The bounded, member-authored content of one submission - and NOTHING that names a subject.
 *
 * There is no ensemble, member, task, session, worktree, artifact or ref id here, by design:
 * attribution is the daemon's job, derived from the authenticated runtime, and a caller-supplied
 * id would be an invitation to submit for a sibling by guessing its name. What a member CAN say
 * is what it did and which checks it actually ran, and both are labelled as CLAIMS downstream -
 * "reported by the member", never "observed by Mission Control".
 */
export const EnsembleSubmissionClaimsSchema = z.object({
  summary: z.string().trim().min(1).max(ENSEMBLE_LIMITS.submissionSummary),
  /** The checks the member says it ran. Claims, not evidence. */
  checks: z
    .array(z.string().trim().min(1).max(ENSEMBLE_LIMITS.submissionCheck))
    .max(ENSEMBLE_LIMITS.submissionChecks)
    .default([]),
  /** Optional free-text test output the member chose to include. */
  testEvidence: z.string().max(ENSEMBLE_LIMITS.submissionTestEvidence).nullable().default(null),
});
export type EnsembleSubmissionClaims = z.infer<typeof EnsembleSubmissionClaimsSchema>;

/**
 * The MCP `submit_ensemble_result` request.
 *
 * Carries the same pane/session/cwd evidence every other MCP tool sends - `findSessionByEnv`
 * turns it into the one live session, and the daemon walks that session to its Task and its
 * active member. The member NEVER names itself: the whole submission tool exists so that a
 * ready-for-comparison signal cannot be forged for a sibling, and the only way to keep that
 * true is to refuse to read an id off the wire.
 */
export const SubmitEnsembleResultSchema = z.object({
  env: EnvSchema,
  sessionId: z.string().nullable().optional().default(null),
  cwd: z.string().nullable().optional().default(null),
  result: EnsembleSubmissionClaimsSchema,
});
export type SubmitEnsembleResultInput = z.infer<typeof SubmitEnsembleResultSchema>;

/**
 * The manual submission fallback body.
 *
 * The member is named in the URL because this is an explicit operator action, not a message
 * from an agent - but the daemon still verifies the member is active and its Task and worktree
 * still match the record before it captures anything, and it labels the result `operator`
 * rather than impersonating a session's provenance. The content it accepts is the same claims
 * shape, so both paths run one capture service.
 */
export const EnsembleMemberSubmitSchema = z.object({
  result: EnsembleSubmissionClaimsSchema,
});
export type EnsembleMemberSubmitBody = z.infer<typeof EnsembleMemberSubmitSchema>;
