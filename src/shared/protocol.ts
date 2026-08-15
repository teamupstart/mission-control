import { z } from "zod";
import { WRAPUP_MODES, WRAPUP_TRIGGERS } from "./queue.ts";
import { MAX_LABELS, TASK_PRIORITIES, normalizeLabels } from "./task.ts";
import { PipelinesConfigSchema } from "./pipeline.ts";
import { TaskSourcesConfigSchema } from "./task-source.ts";
import { CHEAP_ACTIONS, DIVERGENCE_KINDS, SKIP_REASONS } from "./foreman.ts";
import { LLM_JOB_IDS } from "./llm-jobs.ts";
import { CLAUDE_TRANSPORTS, LLM_RUNNER_IDS } from "./llm.ts";
import { LLM_SPEND_ROLES } from "./llm-spend.ts";
import { OPEN_TARGET_IDS } from "./open-targets.ts";
import {
  ARCHIVE_INDEX_STATUSES,
  ARCHIVE_KINDS,
  ARCHIVE_SEARCH_LIMITS,
  ARCHIVE_TEXT_LIMITS,
  decodeArchiveCursor,
  isArchiveId,
  isArchiveRepoSlot,
} from "./archives.ts";
import { SCOUT_REPORT_PATH_SHAPE, SCOUT_SUBMISSION_LIMITS, scoutReportSlug } from "./scouts.ts";
import { TERMINAL_BACKEND_IDS } from "./terminal.ts";
import { AGENT_TYPES, SESSION_RUNTIMES, TASK_KINDS, THINKING_LEVELS } from "./types.ts";
import type { AgentType, SessionRuntime, Task } from "./types.ts";
import { supportsEffort } from "./harness-capabilities.ts";
import { INSPECTOR_LIMITS } from "./inspector.ts";
import {
  DEFAULT_WORKFLOW_BINDING_DEFAULTS,
  DEFAULT_WORKFLOW_POLICY,
  DEFAULT_WORKFLOW_RESUMPTION_POLICY,
  EVIDENCE_REF_KINDS,
  INSPECTOR_FINDINGS_POLICIES,
  SESSION_ACTION_BLOCK_CODES,
  SESSION_ACTION_COMPLETION_KINDS,
  SESSION_ACTION_WAIT_REASONS,
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
  // EVERY PR URL that same tool result carried, in the order they were printed, with
  // `prUrl` above as its first element.
  //
  // Both, rather than replacing the scalar, because they answer different questions and
  // one of them is older than this field. `prUrl` is what decorates THIS CARD, and a card
  // has one chip; `prUrls` is what the agent opened, which on a multi-repo task is one per
  // repository it changed. Only the plural is fanned out to adoption, so a second
  // repository's pull request stops being invisible to the Inspector and to completion.
  //
  // Optional so a hook installed before this field existed keeps ingesting: the daemon
  // falls back to `[prUrl]`, which is exactly what it used to do.
  prUrls: z.array(z.string().url()).optional(),
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

/**
 * The transcript route's window shape, named here because its two halves live in different
 * processes and used to drift apart in prose: the daemon's `/api/sessions/:id/transcript`
 * route adds this fixed opening head to EVERY windowed read (so the goal the user set is
 * always present), while the tail count is the caller's - the Foreman worker's
 * `client.transcript` asks for `TRANSCRIPT_DEFAULT_TAIL_TURNS` explicitly, and the route
 * falls back to the same value when no `turns` param arrives. A default windowed read is
 * therefore head + tail = 60 turns; any comment counting only the tail undercounts by this
 * head.
 */
export const TRANSCRIPT_HEAD_TURNS = 12;
/** The tail half of the same window - see `TRANSCRIPT_HEAD_TURNS` for how the two compose. */
export const TRANSCRIPT_DEFAULT_TAIL_TURNS = 48;

/**
 * Who is typing, on the two routes that put a caller's own text into a session.
 *
 * ONE schema across `/send` and `/inject` rather than a copy each, because the daemon
 * makes one decision from it - may this actor write here - and two enums would let the
 * twin routes drift into disagreeing about the answer. Defaults to the human for the
 * reason `InjectPromptSchema.origin` states at length: a caller that forgets the field
 * should under-claim, never over-claim, and almost every caller IS a human.
 */
const PromptOriginSchema = z.enum(["human", "foreman", "workflow"]).default("human");

/** A message the user sends into a session from the dashboard. */
export const SendTextSchema = z.object({
  text: z.string().min(1),
  /** Whether to submit (press Enter) after typing. Default true. */
  submit: z.boolean().optional().default(true),
  /**
   * See `PromptOriginSchema`. Carried here as well as on `/inject` because this is the
   * OTHER end of one delivery the Foreman worker splits across two routes: a submitted
   * answer goes through `/inject`, while an unsubmitted one - a draft the model asked to
   * leave in the composer - keeps this path deliberately, to spend no Enter. Both type
   * into somebody's pane, so both have to be able to say whose text it is.
   */
  origin: PromptOriginSchema,
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
/**
 * Who is answering, on the two routes that settle a session's pending ask.
 *
 * The same field, the same default and the same reason as `ResolveReviewSchema.by`: a
 * driver QUESTION answered here is written down as a resolved review so the conversation
 * can replay it (`sdk/answered-question.ts`), and the conversation may only put an answer
 * in the operator's voice if the operator gave it. Foreman reaches these routes over HTTP
 * exactly as the dashboard does, so it declares itself rather than being inferred - and the
 * default is the human, because every other caller IS one.
 */
const AnswerActorSchema = z.enum(["human", "foreman"]).optional().default("human");

export const SelectOptionSchema = z.object({
  number: z.number().int().min(1).max(99),
  label: z.string().min(1),
  by: AnswerActorSchema,
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
    by: AnswerActorSchema,
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

/**
 * What the human picked for one decision, echoed back by option id.
 *
 * Ids and not labels: the label is display text that an agent may rewrite between asking
 * and being answered, while the id is the handle the question was built with. Unbounded
 * `selected` because a `multiSelect` decision has no fixed arity; empty is legal, since a
 * decision with `allowOther` can be answered entirely in free text.
 */
export const PlanDecisionAnswerSchema = z.object({
  decisionId: z.string().min(1),
  selected: z.array(z.string().min(1)),
  other: z.string().nullable().optional().default(null),
});
export type PlanDecisionAnswerInput = z.infer<typeof PlanDecisionAnswerSchema>;

/**
 * The human's decision on a review, from the dashboard.
 *
 * `selections` is the structured twin of `response`, sent only by the decision form. The
 * agent still receives `response` verbatim - that contract is untouched - but the flattened
 * string cannot say which options were NOT taken, so the conversation replays the form from
 * this instead. Optional, because most resolutions have no form behind them: a free-text
 * `input`, an approve/reject note, a dismiss.
 *
 * `by` names the actor, defaulting to the human because this route is the dashboard's. The
 * Foreman worker is the one caller that must say otherwise, and it reaches the daemon
 * through this same HTTP route rather than in-process - so it declares itself here, and its
 * answers stay out of the conversation the human is credited with.
 */
export const ResolveReviewSchema = z.object({
  action: z.enum(["approve", "reject", "answer", "dismiss"]),
  response: z.string().nullable().optional().default(null),
  selections: z.array(PlanDecisionAnswerSchema).nullable().optional().default(null),
  by: z.enum(["human", "foreman"]).optional().default("human"),
}).transform((resolution) => ({
  ...resolution,
  response: resolution.action === "dismiss" ? null : resolution.response,
  // A dismiss chose nothing by definition, so it carries no form to replay. Cleared here
  // beside the response for the same reason that one is: a client sending both a dismiss
  // and a set of selections is contradicting itself, and the stored row must not.
  selections: resolution.action === "dismiss" ? null : resolution.selections,
}));
export type ResolveReview = z.infer<typeof ResolveReviewSchema>;

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
    /**
     * SECONDARY repositories to attach, beyond `repoRoot`. Each is resolved through
     * `resolveTaskRepoRoot`, deduped, and refused if it names the primary.
     *
     * The cap of 8 is a sanity bound on a request body, not a product limit on how many
     * repos a task may coordinate - nothing downstream reads it as a maximum.
     */
    extraRepoRoots: z.array(z.string().min(1)).max(8).default([]),
    intent: z.string().min(1),
    title: z.string().optional(),
    kind: z.enum(TASK_KINDS).default("ship"),
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
 * Turn the transient Keep Awake mode on or off: `PUT /api/keep-awake`.
 *
 * Strict and exactly one boolean on purpose. Keep Awake is daemon-run-scoped by an
 * approved human decision - there is no persisted preference to patch here, and a body
 * carrying anything beyond `enabled` is a caller confused about that contract, refused
 * rather than partially honoured.
 */
export const KeepAwakeRequestSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();
export type KeepAwakeRequest = z.infer<typeof KeepAwakeRequestSchema>;

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
    /**
     * Replace the attached secondary repos wholesale. Same resolution and refusals as
     * `DispatchSchema`; see the cap note there.
     *
     * No `isAnnotationOnlyUpdate` change is needed for it: that predicate counts KEYS, so
     * naming this one makes the patch a provisioning change by construction and it stays
     * refused once the task has left the backlog. That is the behaviour we want, for free.
     */
    extraRepoRoots: z.array(z.string().min(1)).max(8).optional(),
    intent: z.string().min(1).optional(),
    title: z.string().optional(),
    kind: z.enum(TASK_KINDS).optional(),
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
 * File a backlog task as an item in an external tracker - `POST /api/tasks/:id/push`.
 *
 * One field, and it is required rather than inferred, which is the decision worth stating.
 * The daemon could pick "the configured source whose repo matches", and that would silently
 * choose for the operator the moment a second source watched the same repo - having
 * PUBLISHED to somebody else's tracker, where the wrong choice cannot be taken back by
 * deleting anything here. So the caller names the source it means.
 *
 * Nothing about the ISSUE is accepted: its title, body and labels are derived from the task
 * and from the source's own sweep filter (see `ghIssueCreateArgs`). A body that could
 * override them would be a second, unversioned way to author an external item.
 *
 * The response is the updated `Task` on 200, exactly like its dispatch/complete siblings,
 * so a caller reads the new `source` off the reply rather than racing the `task_upsert`
 * event. The failure codes are part of the contract and are documented on the route: 502
 * means the tracker refused and a retry is safe, 504 means the outcome is unknown and a
 * retry may file a duplicate.
 */
export const PushTaskSchema = z.object({
  /** Which configured task source to file through. See `TaskSourceInstance.id`. */
  sourceId: z.string().min(1),
});
export type PushTask = z.infer<typeof PushTaskSchema>;

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
  // Why the ladder landed where it did. Free text, NOT an enum, and the difference is
  // load-bearing on the wire specifically: one arm of the vocabulary interpolates an error
  // (`tier1-failed: <err>`), and a worker newer than the daemon it posts to must not have
  // its diagnosis rejected by an enum this build has not learned yet. Clamped by
  // `MAX_EPISODE_TEXT` at the store, like every other free field here.
  triageReason: z.string().nullable().optional(),
  skipReason: z.enum(SKIP_REASONS).nullable().optional(),
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
    objective: z.string().nullable().optional(),
    prompt: z.string().nullable().optional(),
    focus: z.string().nullable().optional(),
    relationship: z.enum(["initial", "steer", "amend", "replace", "unclear"]).nullable().optional(),
    rationale: z.string().nullable().optional(),
    objectiveVersion: z.number().int().nonnegative().optional(),
    promptRevision: z.number().int().nonnegative().optional(),
    resolvedPromptRevision: z.number().int().nonnegative().optional(),
    pendingPrompts: z
      .array(
        z.object({
          revision: z.number().int().positive(),
          prompt: z.string().nullable(),
        }),
      )
      .optional(),
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
   * Whether a task whose durable Kind is `scout` is retired at completion instead of
   * reaching any automatic wrap-up action.
   *
   * On by default because scout work is an investigation contract: its useful output is
   * the finding itself, not a Workflow submission or a prompt that asks the session to open
   * a pull request. Turning it off deliberately restores the ordinary wrap-up path, subject
   * to the independent review-artifact safeguard below.
   */
  skipScoutWrapup: z.boolean().default(true),
  /**
   * Whether mockups and other explicit review-only artifacts are retired at completion
   * instead of reaching any automatic wrap-up action.
   *
   * The classifier reads the resolved objective and, when available, the completed diff's
   * paths. It stays independent from `skipScoutWrapup`: a ship-kind task can still request
   * only mockups, while a scout task can also match both safeguards. On by default to keep
   * No-Mistakes Review and Straight-to-PR for work that actually asks for implementation.
   */
  skipReviewArtifactWrapup: z.boolean().default(true),
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
   * human picks from the Wrapup card. `pr` lets Foreman type the direct shipping
   * instruction unattended, but only when no Workflow binding owns the completion.
   *
   * Automating this is strictly more dangerous than the per-item send it resembles,
   * because direct PR can ultimately PUSH. So the auto path carries every
   * gate the manual one does and one more - it is refused outright unless `mode` is live
   * AND the repo is on the allowlist (`mayActLive`), exactly like a queue send. Dry-run
   * degrades direct PR to `ask`. Dry-run means dry-run.
   */
  wrapup: z.enum(WRAPUP_MODES).default("ask"),
  /**
   * Whether Foreman keeps a session on track once its work has become an OPEN pull
   * request by nudging it back to address the Inspector's review comments.
   *
   * On by default, because the gap it closes is the common failure the feature was asked
   * for: a session finishes through the review workflow or straight-to-PR, opens the PR, and
   * parks. The Inspector then reviews and posts comments, and nobody is driving the session
   * to fix them, so the PR sits with unresolved feedback until a human notices. This turns
   * each new Inspector round on a parked PR into a fresh instruction typed back at the
   * session that opened it.
   *
   * Like every automated action here it only ever TYPES in live mode on an allowlisted
   * repo (`mayActLive`): the nudge is a live act, and dry-run means dry-run. It also
   * fires only at a settled-idle session - never interrupting one already working the
   * fixes - and at most once per Inspector round, so it re-engages a stalled PR without
   * nagging one that is being handled. Independent of `wrapupTriggers`: those decide how
   * work BECOMES a PR, this decides what happens to the PR afterwards.
   */
  trackReviewFeedback: z.boolean().default(true),
  /**
   * Whether Foreman sends a failing CI episode back to the settled session that owns the
   * OPEN pull request. This setting never creates a pull request: the open PR is a required
   * input, and the instruction explicitly keeps every fix on that same branch and PR.
   *
   * Independent from `trackReviewFeedback` so an operator can automate CI repair without
   * also automating review-comment handling. It carries the same Live-mode, allowlist,
   * settled-idle, queue-ownership and Workflow-ownership gates, and fires at most once per
   * failing episode until CI recovers and fails again.
   */
  trackCiFailures: z.boolean().default(true),
  /**
   * Whether Foreman schedules the BACKLOG on its own - reading every item, working out
   * what depends on what, and then handing one at a time to an idle agent or to a fresh
   * worktree (see docs/plans/backlog-autopilot/plan.md).
   *
   * Off by default, and - like direct PR wrap-up - it only ever ACTS in live
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
  /**
   * Minutes idle, with work still outstanding, before a session reads as stuck.
   *
   * Covers a parked workflow run as well as an open task or queue: it is one judgement -
   * how long to leave a quiet agent alone - and splitting it would ask an operator to hold
   * two numbers for the same question. See `workOutstanding` in `stall.ts`.
   */
  stallUnfinishedMinutes: z.number().int().min(1).max(240).default(20),
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

/**
 * An operator closing the findings the Inspector is carrying on one pull request.
 *
 * The PR is named in the BODY rather than in the path because its key is `owner/repo#123`
 * - a slash and a hash, both of which have to survive a URL segment intact for the daemon
 * to look the row up. Encoding them is a rule every future caller has to remember; a body
 * field is one nobody can get wrong.
 */
export const ResolveFindingsSchema = z.object({
  prKey: z.string().min(1),
});
export type ResolveFindings = z.infer<typeof ResolveFindingsSchema>;

/** What the daemon reports back: how many findings that actually closed. */
export interface ResolveFindingsResult {
  resolved: number;
}

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
 * The runtime an untouched installation uses for each harness. Only harnesses with a
 * declared embedded driver start on the Agent SDK; Pi remains terminal-backed until it
 * has one. Kept beside the schema so the server's first read and the browser's pre-load
 * state cannot disagree.
 */
export const DEFAULT_HARNESSES_SESSION_RUNTIMES = {
  claude: "sdk",
  codex: "sdk",
  pi: "terminal",
} as const satisfies Record<AgentType, SessionRuntime>;

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
   * New installations use the Agent SDK for Claude and Codex, the two harnesses with
   * embedded drivers. Pi stays terminal-backed because it has no SDK driver. Scoped to
   * dispatch like every other key in this blob: a session an operator started themselves
   * is pane-backed whatever this says, because we do not own their pty.
   *
   * A stored value this build cannot read, or one naming a runtime the harness does not
   * offer, falls back to `"terminal"` and says so - see `resolveDispatchRuntime`. Read at
   * dispatch time, so a flip mid-batch reaches the next launch without a restart.
   */
  sessionRuntime: z
    .object({
      claude: StoredSessionRuntimeSchema.default(DEFAULT_HARNESSES_SESSION_RUNTIMES.claude),
      codex: StoredSessionRuntimeSchema.default(DEFAULT_HARNESSES_SESSION_RUNTIMES.codex),
      pi: StoredSessionRuntimeSchema.default(DEFAULT_HARNESSES_SESSION_RUNTIMES.pi),
    })
    .default(DEFAULT_HARNESSES_SESSION_RUNTIMES),
});
export type HarnessesConfig = z.infer<typeof HarnessesConfigSchema>;

/**
 * Bounds for daemon-owned worktree policy. Kept beside the schemas so a later Settings
 * surface can display the same limits the daemon enforces rather than copying numbers.
 */
export const WORKTREES_CONFIG_LIMITS = {
  minSlots: 1,
  maxSlots: 128,
  maxRepositories: 256,
  maxCommonDirectoryBytes: 4096,
  maxSetupArgs: 32,
  maxSetupArgBytes: 4096,
} as const;

const WorktreeSetupArgvSchema = z
  .array(z.string().min(1).max(WORKTREES_CONFIG_LIMITS.maxSetupArgBytes))
  .min(1)
  .max(WORKTREES_CONFIG_LIMITS.maxSetupArgs);

const WorktreeRepositoryConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxSlots: z
      .number()
      .int()
      .min(WORKTREES_CONFIG_LIMITS.minSlots)
      .max(WORKTREES_CONFIG_LIMITS.maxSlots)
      .optional(),
    /** Operator-authored argv. It is never read from a repository-controlled file. */
    setupArgv: WorktreeSetupArgvSchema.optional(),
  })
  .strict();

const WorktreeRepositoryKeySchema = z
  .string()
  .min(1)
  .max(WORKTREES_CONFIG_LIMITS.maxCommonDirectoryBytes);

/**
 * The only policy authority for native worktrees. Operational pool/slot rows deliberately
 * do not repeat any of these values.
 */
export const WorktreesConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxSlots: z
      .number()
      .int()
      .min(WORKTREES_CONFIG_LIMITS.minSlots)
      .max(WORKTREES_CONFIG_LIMITS.maxSlots)
      .default(16),
    repositories: z.record(WorktreeRepositoryKeySchema, WorktreeRepositoryConfigSchema).default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value.repositories).length > WORKTREES_CONFIG_LIMITS.maxRepositories) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repositories"],
        message: `at most ${WORKTREES_CONFIG_LIMITS.maxRepositories} repository overrides are allowed`,
      });
    }
  });
export type WorktreesConfig = z.infer<typeof WorktreesConfigSchema>;

const WorktreeRepositoryConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxSlots: z
      .number()
      .int()
      .min(WORKTREES_CONFIG_LIMITS.minSlots)
      .max(WORKTREES_CONFIG_LIMITS.maxSlots)
      .optional(),
    /** Null removes an existing operator-authored setup command. */
    setupArgv: WorktreeSetupArgvSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "repository patch must change at least one field");

/** Partial update. A null repository value removes that repository's whole override. */
export const WorktreesConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxSlots: z
      .number()
      .int()
      .min(WORKTREES_CONFIG_LIMITS.minSlots)
      .max(WORKTREES_CONFIG_LIMITS.maxSlots)
      .optional(),
    repositories: z
      .record(WorktreeRepositoryKeySchema, WorktreeRepositoryConfigPatchSchema.nullable())
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "worktrees patch must change at least one field")
  .superRefine((value, ctx) => {
    if (
      value.repositories &&
      Object.keys(value.repositories).length > WORKTREES_CONFIG_LIMITS.maxRepositories
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repositories"],
        message: `at most ${WORKTREES_CONFIG_LIMITS.maxRepositories} repository patches are allowed`,
      });
    }
  });
export type WorktreesConfigPatch = z.infer<typeof WorktreesConfigPatchSchema>;

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

/**
 * Which repositories an external SDLC engine may be observed in, as the panel sends it back.
 *
 * A whole-object PUT for `TaskSourcesConfigPatchSchema`'s reason: adding a repository,
 * enabling one and removing one are the same edit to the same panel, and the list is small
 * and bounded by its schema. The master switch rides the same write because a panel that
 * could save one without the other would let a browser hold a picture in which the master
 * is off and a repository is on, which is not a state the daemon can be in.
 */
export const PipelinesConfigPatchSchema = PipelinesConfigSchema;
export type PipelinesConfigPatch = z.infer<typeof PipelinesConfigPatchSchema>;

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
 * How one session's Conversation is DRAWN - the same rows, read two ways.
 *
 * `chat` is the shipped log: role bylines, bubbles, tool chips. `terminal` is the Native
 * PTY reading (`docs/plans/conversation-native-pty/plan.md`): human turns as prompt
 * lines, agent turns as stdout under a speaker header, tool runs folded into disclosure
 * records, inside a titlebar/status-line frame.
 *
 * A named set rather than a boolean, and here beside `LAYOUT_MODES` for the same reason:
 * the daemon validates a stored value against the one list the render switch branches on.
 * The conversation study drew three concepts and this is the second to ship, so a
 * `terminalConversation: boolean` would have to be renamed the first time a third reading
 * arrives - and this key is persisted on operators' machines.
 */
export const CONVERSATION_VIEWS = ["chat", "terminal"] as const;
export const ConversationViewSchema = z.enum(CONVERSATION_VIEWS);
/** Derived from the array, not from the schema, so reading it costs the web no zod. */
export type ConversationView = (typeof CONVERSATION_VIEWS)[number];

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
 * needs these synchronously, before any fetch, to paint on a cold cache - and reading them
 * must not be what pulls zod into the web bundle. Everything the web takes from THIS module
 * tree-shakes to a constant. Keep it that way.
 *
 * This comment used to claim zod was absent from `dist/web`, and that has not been true for
 * a while: `@shared/task-source.ts` exports `TASK_SOURCE_KIND_INFO` with a `configSchema`
 * per kind, and `DispatchModal` imports it as a value, so the whole library lands in the
 * bundle (`grep -c ZodError dist/web/assets/index-*.js` says 2, at this commit and at the
 * one before it). Corrected rather than deleted, because the rule it was defending is still
 * the right rule and the breach is a defect to fix, not a licence to add a second one.
 */
export const UI_CONFIG_DEFAULTS = {
  layout: "grid",
  conversationView: "terminal",
  keybindings: {},
  alerts: { notifications: false, sound: true },
  richText: true,
  keybindingHints: true,
  guidedDispatch: true,
  trustStaged: [],
} as const;

export const UiConfigSchema = z.object({
  layout: LayoutModeSchema.default(UI_CONFIG_DEFAULTS.layout),
  /**
   * Which rendering the Conversation opens in. A per-session override lives in the browser
   * only and never reaches here - see `src/web/lib/conversation-view.ts` for why that one is
   * honestly tab-scoped.
   */
  conversationView: ConversationViewSchema.default(UI_CONFIG_DEFAULTS.conversationView),
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
  /* `usageBarCollapsed` lived here and is gone: the topbar's second row it folded was
     retired for the spend popover, and a preference nothing reads is a preference that
     lies about what the app can do. The key is simply dropped from stored configs on the
     next parse - this object is not `.strict()`, so an existing bag still opens - and no
     migration is owed, because forgetting a fold state costs nothing. */
  /**
   * Whether a button that a keyboard shortcut also drives prints that shortcut on its
   * face. On by default: the shortcut table is only discoverable if the buttons teach
   * it. The off switch is for an operator who has learnt them and wants the chrome back.
   */
  keybindingHints: z.boolean().default(UI_CONFIG_DEFAULTS.keybindingHints),
  /**
   * Whether pressing the dispatch shortcut runs the guided pass - the keyboard walk over
   * repo, kind, harness and after-work - before handing over the ordinary dispatch form.
   *
   * On by default: <kbd>Tab</kbd> hands the operator back to the ordinary form in one key,
   * while an explicit off preference remains off. This is the ONE line that decides which
   * dispatch an unconfigured profile gets, so the e2e dashboard fixture pins its own choice
   * instead of inheriting this product default.
   */
  guidedDispatch: z.boolean().default(UI_CONFIG_DEFAULTS.guidedDispatch),
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
 * All defaults are the shipped behaviour exactly: an operator who never saves this config
 * gets the same runner, Claude print transport, and model ids the hardcoded constants produced.
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
   * Claude's headless wire protocol, or empty for the config -> env -> default ladder.
   *
   * Tolerant on read for the runner field's downgrade reason: a newer stored value must
   * not take every background job down over a preference this build cannot understand.
   */
  claudeTransport: z
    .union([z.enum(CLAUDE_TRANSPORTS), z.literal("")])
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
    claudeTransport: z.union([z.enum(CLAUDE_TRANSPORTS), z.literal("")]),
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
   * True when Claude Code's exporter has been silent for a week WHILE the fleet was working.
   *
   * The state this describes has no other symptom. Spend for a session the daemon RUNS comes
   * off the driver's own stream, so `receiving` is satisfied, the topbar has numbers on it and
   * the `env` block is in the file - every signal reads healthy. But a session the daemon
   * merely DISCOVERED, a human's terminal `claude`, has no driver, and the export is the only
   * way its cost is ever counted. So the total looks complete while an entire category of
   * session is missing from it.
   *
   * All of that is the server's to judge, which is why this arrives as one derived boolean
   * rather than as the timestamps behind it. Silence alone is not a fault - an idle machine
   * exports nothing because it runs nothing - session spend alone is not either, and neither
   * is a fleet that enabled telemetry moments ago: `hasClaudeSessionUsageSince` is satisfied by
   * a DRIVER's own rows, so it goes true seconds after the toggle is flipped, well before the
   * exporter has had one export interval. This is false throughout that grace period, whether
   * it started at the toggle or was backfilled for an installation that reached `installed` a
   * different way (`npm run install-telemetry`, a hand-edited settings file, an upgrade). See
   * `exporterSilentWhileActive`.
   */
  exporterSilent: boolean;
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

/**
 * One finished headless run, as the Foreman worker reports it to the daemon.
 *
 * The worker is a separate process and never opens the database, so its share of the app's
 * own token spend reaches the ledger the way everything else it does reaches it: over a
 * route. The daemon's own Inspector runs skip the wire and call the same writer directly.
 *
 * TOKENS ONLY - there is deliberately no cost field. The daemon prices what it is told,
 * because a worker that priced its own runs would be a second place the versioned rate
 * snapshot is applied, and the two would disagree the moment one process was restarted and
 * the other was not. `role` is validated against the shipped tuple rather than accepted as
 * free text: these strings become note keys, and a typo would mint a seventh bucket that
 * looks like a role and answers to nothing.
 *
 * Every count is capped at a number no honest run reaches. The bound is not about a hostile
 * caller - the route is loopback-only - but about a parse bug on either side turning into a
 * ledger row that swamps a day's fleet total and cannot be told from real spend afterwards.
 */
export const SpendModelUsageSchema = z.object({
  modelId: z.string().max(200),
  input: z.number().int().min(0).max(1_000_000_000),
  output: z.number().int().min(0).max(1_000_000_000),
  reasoningOutput: z.number().int().min(0).max(1_000_000_000),
  cacheRead: z.number().int().min(0).max(1_000_000_000),
  cacheWrite: z.number().int().min(0).max(1_000_000_000),
  reportedCostUsd: z.number().min(0).max(100_000).nullable(),
});

export const SpendReportSchema = z.object({
  role: z.enum(LLM_SPEND_ROLES),
  runner: z.string().min(1).max(64),
  runId: z.string().min(1).max(200),
  ts: z.number().int().positive(),
  models: z.array(SpendModelUsageSchema).min(1).max(32),
});
export type SpendReportBody = z.infer<typeof SpendReportSchema>;

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

/**
 * The worker's bounded projection of its process-local backlog planner circuit.
 * The daemon keeps this in memory only; accepting the report never makes the worker a
 * database writer or gives the daemon a second scheduler state machine.
 */
export const ForemanPlannerHealthReportSchema = z.object({
  workerId: z.string().min(1).max(256),
  state: z.enum(["healthy", "degraded"]),
  runner: z.enum(LLM_RUNNER_IDS),
  model: z.string().min(1).max(200),
  failureCount: z.number().int().min(0).max(1_000_000),
  lastError: z.string().max(400).nullable(),
  nextRetryAt: z.number().int().nonnegative().nullable(),
});
export type ForemanPlannerHealthReport = z.infer<typeof ForemanPlannerHealthReportSchema>;

/** A body is still schema-checked even though retry needs no operator options. */
export const ForemanPlannerRetrySchema = z.object({}).strict();

/** A live leader atomically claims one outstanding operator retry. */
export const ForemanPlannerRetryClaimSchema = z.object({
  workerId: z.string().min(1).max(256),
  retryGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type ForemanPlannerRetryClaim = z.infer<typeof ForemanPlannerRetryClaimSchema>;

/** Process-local daemon signal polled by the worker; it is not scheduler state. */
export interface ForemanPlannerControl {
  retryGeneration: number;
  /** Worker that consumed this generation, or null while it is waiting for a live leader. */
  retryClaimedBy: string | null;
  /** Changes on daemon restart so a live worker republishes its in-memory health. */
  projectionEpoch: string;
}

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
  /** Human conversation composers opt into the editable outbox by default. */
  buffer: z.boolean().optional().default(true),
  /**
   * Who is typing. Defaults to the human, because that's who almost every caller is and
   * because claiming to be Foreman is the answer that colours a turn - a caller that
   * forgets the field should under-claim, not over-claim.
   *
   * The daemon is the only place this is knowable at all: by the time the text reaches
   * the pane it's just keystrokes, and the transcript records it as a plain user turn
   * indistinguishable from one a person typed. Round 0 of a work item is the human's
   * intent delivered VERBATIM, so no marker can be added to the text itself.
   *
   * Shared with `SendTextSchema` - see `PromptOriginSchema`.
   */
  origin: PromptOriginSchema,
});
export type InjectPrompt = z.infer<typeof InjectPromptSchema>;

/**
 * What `POST /api/sessions/:id/retro` did, discriminated because the two arms are different
 * events with different follow-ups.
 *
 * `delivered` is the source plan's R1: the session that did the work was asked to run its own
 * retrospective, and the next thing a human sees is that session talking to them. `dispatched`
 * is R3, taken when the session can no longer be typed into: a retro task is filed against the
 * repository, and the next thing a human sees is a backlog card.
 *
 * A `kind` field rather than a shape test, so a caller never has to infer which happened from
 * which fields are present. The union may GAIN arms and fields; a published arm keeps its
 * spelling, because the dashboard's retro affordances are built against these names.
 */
export type RetroResponse =
  | {
    kind: "delivered";
    sessionId: string;
    /** The delivered packet's SHA-256, correlating this call with the turn it produced. */
    payloadSha256: string;
    /**
     * Whether the submit was OBSERVED. False is "no news" and never "it failed" - the text
     * may be sitting in the composer - so it must not drive a retry.
     */
    submitVerified: boolean;
  }
  | { kind: "dispatched"; task: Task };

/** CAS guard for a pending-turn action selected from the current session projection. */
export const PendingTurnRevisionSchema = z.object({
  revision: z.number().int().min(0),
});
export type PendingTurnRevision = z.infer<typeof PendingTurnRevisionSchema>;

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

/**
 * A path on the DAEMON's machine, as an import request body.
 *
 * Absolute and NUL-free is checked here, before any code touches the filesystem, because both
 * refusals are about the string and neither improves by being discovered mid-read. Everything
 * else a path can be wrong about - a directory, a dangling link, a 4MB file, bytes that are not
 * UTF-8 - can only be learned by looking, and the reader names each of those separately.
 *
 * A ceiling of 4096 is the common `PATH_MAX`; this is a bound on nonsense, not a portability
 * claim.
 */
export const PersonaSourcePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), { message: "path may not contain a NUL byte" })
  // Judged on the string exactly as POSIX does, rather than through `node:path`, so this
  // schema stays usable in a browser that has no `path` module to import.
  .refine((value) => value.startsWith("/"), {
    message: "path must be absolute - Mission Control reads it on the daemon's machine",
  });

export const ImportPersonaSchema = z.object({ path: PersonaSourcePathSchema });
export type ImportPersona = z.infer<typeof ImportPersonaSchema>;

/**
 * Re-import carries only the revision it believes it is replacing.
 *
 * Deliberately not the path: the path is provenance the daemon already stores, and accepting
 * one here would let a browser re-point a Persona at another file while calling it a refresh.
 * Changing where a Persona comes from is an import, which creates its own row.
 */
export const ReimportPersonaSchema = z.object({
  expectedRevision: z.number().int().positive(),
});
export type ReimportPersona = z.infer<typeof ReimportPersonaSchema>;

/**
 * The provenance blob as it is stored, and as it is read back.
 *
 * Bounded field by field because this is durable text that a later build parses: an unbounded
 * `sourceRepo` would let one malformed write make every read of that row expensive. Strict on
 * shape and tolerant in use - the store degrades a blob that fails this to null rather than
 * failing the Persona.
 */
export const PersonaProvenanceSchema = z.object({
  sourcePath: PersonaSourcePathSchema,
  sourceRepo: z.string().min(1).max(4096).nullable(),
  pluginVersion: z.string().min(1).max(200).nullable(),
  /**
   * `.default(null)` on both of these is what makes them additive rather than a migration.
   *
   * This schema parses blobs a PREVIOUS build wrote, and those blobs have no key here at all.
   * Without the default they would fail the shape, and the store's tolerant reader would
   * degrade every provenance record written before this build to null - silently stripping the
   * upstream badge off Personas an operator imported by hand and had working. A default reads
   * the absent key as what it means: this document was imported before catalogs existed, so it
   * belongs to no catalog.
   */
  sourceKey: z.string().min(1).max(4096).nullable().default(null),
  catalogLabel: z.string().min(1).max(200).nullable().default(null),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/, "contentSha256 must be lowercase hex sha256"),
  importedAt: z.number().int().nonnegative(),
});

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

export const WorkflowPersonaDirectiveFeedbackSchema = z.string().trim().min(1)
  .refine((value) => utf8AtMost(value, WORKFLOW_LIMITS.personaDirectiveBytes), {
    message: `Persona feedback exceeds ${WORKFLOW_LIMITS.personaDirectiveBytes} UTF-8 bytes`,
  });

export const WorkflowPersonaDirectiveSchema = z.object({
  nodeId: WorkflowNodeIdSchema,
  feedback: WorkflowPersonaDirectiveFeedbackSchema,
  revision: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const WorkflowPersonaDirectiveSnapshotSchema = WorkflowPersonaDirectiveSchema.omit({
  nodeId: true,
});

// ---- SessionActions ----

const SessionActionNameSchema = z.string().trim().min(1).max(WORKFLOW_LIMITS.sessionActionName);
const SessionActionDescriptionSchema = z.string().max(WORKFLOW_LIMITS.sessionActionDescription);

/**
 * Exact Markdown: validation observes it but never transforms it.
 *
 * `.trim()` is deliberately absent where `PersonaNameSchema` has one. This string is TYPED
 * INTO a session verbatim, so a boundary that silently stripped its leading blank line would
 * deliver a packet different from the one the operator authored and the version snapshotted.
 */
export const SessionActionPromptSchema = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "Session action prompt cannot be empty" })
  .refine((value) => utf8AtMost(value, WORKFLOW_LIMITS.sessionActionPromptBytes), {
    message: `Session action prompt exceeds ${WORKFLOW_LIMITS.sessionActionPromptBytes} UTF-8 bytes`,
  });

/**
 * A skill CAPABILITY id, bounded like the data it is.
 *
 * The character class is the load-bearing part, not the length: this value reaches the code
 * that resolves a harness-native invocation, so anything that could carry whitespace, a
 * shell metacharacter or a path separator has to be refused at the boundary rather than
 * relied on to be harmless later. A catalog id is a slug, and a slug is all this admits.
 */
export const SessionActionSkillIdSchema = z
  .string()
  .max(WORKFLOW_LIMITS.sessionActionSkillId)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "A required skill is a catalog id, not a command");

/**
 * The closed, server-owned completion registry.
 *
 * Spelled arm by arm rather than as `z.object({ kind: z.enum(SESSION_ACTION_COMPLETION_KINDS) })`
 * so the parsed type is the discriminated union the shared contract declares, and so an
 * adapter that later carries a parameter gains it on one arm instead of all of them.
 * `session-action-contracts.test.ts` pins this against the tuple so the two cannot drift.
 */
export const SessionActionCompletionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session_turn") }),
  z.object({ kind: z.literal("pull_request") }),
  z.object({ kind: z.literal("repo_commit") }),
]);

export const CreateSessionActionSchema = z.object({
  name: SessionActionNameSchema,
  description: SessionActionDescriptionSchema.optional().default(""),
  promptMarkdown: SessionActionPromptSchema,
  requiredSkillId: SessionActionSkillIdSchema.nullable().optional().default(null),
  // `session_turn` is the default because it is the only completion a freshly authored
  // action can honestly promise. `pull_request` proves something about a repository, and an
  // operator opts into that proof rather than inheriting it.
  completion: SessionActionCompletionSchema.optional().default({ kind: "session_turn" }),
});
export type CreateSessionAction = z.infer<typeof CreateSessionActionSchema>;

const SESSION_ACTION_EDIT_FIELDS = [
  "name",
  "description",
  "promptMarkdown",
  "requiredSkillId",
  "completion",
] as const;

export const UpdateSessionActionSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: SessionActionNameSchema.optional(),
    description: SessionActionDescriptionSchema.optional(),
    promptMarkdown: SessionActionPromptSchema.optional(),
    requiredSkillId: SessionActionSkillIdSchema.nullable().optional(),
    completion: SessionActionCompletionSchema.optional(),
  })
  .refine((value) => SESSION_ACTION_EDIT_FIELDS.some((field) => field in value), {
    message: "Session action update has no editable fields",
  });
export type UpdateSessionAction = z.infer<typeof UpdateSessionActionSchema>;

export const ArchiveSessionActionSchema = z.object({
  expectedRevision: z.number().int().positive(),
});
export type ArchiveSessionAction = z.infer<typeof ArchiveSessionActionSchema>;

export const SessionActionSnapshotSchema = z.object({
  sourceSessionActionId: WorkflowIdSchema,
  sourceRevision: z.number().int().positive(),
  name: SessionActionNameSchema,
  description: SessionActionDescriptionSchema,
  promptMarkdown: SessionActionPromptSchema,
  requiredSkillId: SessionActionSkillIdSchema.nullable(),
  completion: SessionActionCompletionSchema,
});

/**
 * A git object id, in either width git produces: 40 hex for SHA-1, 64 for SHA-256.
 *
 * Kept in step with `FULL_SHA` in `src/server/workflows/commit-id.ts`, which is what actually
 * decides whether a resolved id is full. This is browser-safe shared code and that module is
 * server-only, so the rule is stated twice rather than imported - and
 * `session-action-pull-request-adapter.test.ts` asserts the two accept exactly the same set,
 * because a schema wider than its producer is a field that can never be filled and a schema
 * narrower than its producer refuses a row the runtime just wrote.
 */
const CommitOidSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/**
 * What an adapter may require of a continuation capture, as a CLOSED discriminated union.
 *
 * This value is persisted on a waiting attempt and re-validated against a capture that may
 * happen after a daemon restart, so an `unknown` escape hatch would be a durable field
 * nothing can read back safely.
 *
 * The `pull_request` arm replaced a placeholder `head` arm that no adapter ever produced: the
 * only completion kind that could have written one refused before deciding, because its
 * capability shipped `available: false`. Nothing stored names it, so the union stays closed
 * over exactly the two shapes that are written.
 */
export const SessionActionContinuationExpectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("pull_request"),
    pullRequestKey: z.string().min(1).max(400),
    pullRequestUrl: z.string().min(1).max(2_000),
    pullRequestNumber: z.number().int().positive(),
    repositoryRoot: z.string().min(1).max(4_000),
    branch: z.string().min(1).max(400),
    expectedHeadOid: CommitOidSchema,
    observedAt: z.number().int(),
  }),
]);

export const SessionActionDeliveryAnchorSchema = z.object({
  deliveryId: WorkflowIdSchema,
  sessionId: z.string().min(1).max(200),
  noteKey: z.string().min(1).max(1_000),
  deliveredAt: z.number().int(),
  transcriptBytes: z.number().int().nonnegative().nullable(),
});

/**
 * A waiting action attempt's durable observation state, as it is stored in `output_json`.
 *
 * Strict rather than permissive: this is what a restart reads to decide whether a packet was
 * sent, whether the session picked it up, and whether a child segment already exists. A
 * shape that degraded on a malformed field could re-send a packet somebody already received.
 */
export const SessionActionAttemptStateSchema = z.object({
  wait: z.enum(SESSION_ACTION_WAIT_REASONS),
  deliveryId: WorkflowIdSchema.nullable(),
  anchor: SessionActionDeliveryAnchorSchema.nullable(),
  pickedUpAt: z.number().int().nullable(),
  settledAt: z.number().int().nullable(),
  expectation: SessionActionContinuationExpectationSchema.nullable(),
  continuationSubmissionId: WorkflowIdSchema.nullable(),
  blocked: z
    .object({ code: z.enum(SESSION_ACTION_BLOCK_CODES), detail: z.string().max(2_000) })
    .nullable(),
});

/** The build's per-adapter answer, as the browser receives it. Never re-derived client-side. */
/**
 * What a COMPLETED action attempt's `output_json` holds, which is not the waiting shape.
 *
 * `completeSessionActionAttempt` replaces the observation state with a record of what
 * happened: the outcome, the action it was, the segment it authorized, and the three
 * timestamps worth keeping. Read-only and deliberately narrow - run detail needs the
 * timeline, and a reader that expected `SessionActionAttemptState` here gets `null` and
 * silently drops it.
 */
export const SessionActionCompletedOutputSchema = z.object({
  outcome: z.literal("complete"),
  anchor: SessionActionDeliveryAnchorSchema.nullable().optional().default(null),
  pickedUpAt: z.number().nullable().optional().default(null),
  settledAt: z.number().nullable().optional().default(null),
  continuationSubmissionId: WorkflowIdSchema.nullable().optional().default(null),
  /**
   * What the adapter PROVED before it let the graph advance, kept past completion.
   *
   * Optional and defaulted for the reason every field above is: a row written by an older
   * daemon carries none, and the reader draws the absence rather than failing the card.
   */
  expectation: SessionActionContinuationExpectationSchema.nullable().optional().default(null),
});

export const SessionActionCompletionCapabilitySchema = z.object({
  kind: z.enum(SESSION_ACTION_COMPLETION_KINDS),
  available: z.boolean(),
  label: z.string().min(1).max(200),
  unavailableReason: z.string().max(1_000).nullable(),
});
export const SessionActionCapabilitiesSchema = z.object({
  completions: z.array(SessionActionCompletionCapabilitySchema),
});
export type SessionActionCapabilities = z.infer<typeof SessionActionCapabilitiesSchema>;

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
    kind: z.literal("session_action"),
    sessionActionId: WorkflowIdSchema,
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
  // Unlike a Check, an action's published form DIFFERS from its draft: the exact text a run
  // types has to be frozen into the version, or an edit to the library would change what an
  // in-flight run says. `sessionActionId` alone is refused here for that reason.
  z.object({
    id: WorkflowNodeIdSchema,
    kind: z.literal("session_action"),
    action: SessionActionSnapshotSchema,
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

/**
 * How many EXTRA repair rounds to add to a run that spent its budget.
 *
 * A delta rather than an absolute ceiling, because the operator is answering "give it
 * another go", not "set this run's budget to seven". The manager clamps the sum at
 * `WORKFLOW_LIMITS.repairRoundsMax`, the same ceiling the binding form enforces, and
 * answers a repeat of the same `requestId` with the grant that already landed.
 *
 * The delta does NOT make concurrent grants additive - the manager reads the current budget
 * and writes the sum outside a shared transaction, so two racing grants of two both settle
 * on the same +2 rather than +4. That is the safe direction (an operator gets fewer rounds
 * than two clicks suggest, never a budget nobody asked for) and the idempotency key makes
 * the realistic version of the race - one intent retried - exact.
 */
export const GrantWorkflowRepairRoundsSchema = z.object({
  requestId: z.string().min(1).max(200),
  rounds: z.number().int().min(1).max(WORKFLOW_LIMITS.repairRoundsMax),
});
export type GrantWorkflowRepairRounds = z.infer<typeof GrantWorkflowRepairRoundsSchema>;

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

/**
 * Toggle the operator-disabled (auto-pass) flag on verdict nodes of ONE run.
 *
 * An array rather than a single id so disabling a whole stage is one atomic request:
 * a stage half-disabled by a failed second POST would pass some of its members and run
 * the rest, which is neither of the states the operator asked for.
 *
 * Duplicate ids are refused rather than tolerated: the request drives one audit event
 * per named gate, and a repeated id would put the same toggle on the timeline twice.
 */
export const SetWorkflowNodesDisabledSchema = WorkflowRunActionSchema.extend({
  nodeIds: z.array(WorkflowIdSchema).min(1).max(WORKFLOW_LIMITS.graphNodes)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "nodeIds must not repeat",
    }),
  disabled: z.boolean(),
});
export type SetWorkflowNodesDisabled = z.infer<typeof SetWorkflowNodesDisabledSchema>;

/** Set or replace persistent feedback for one Persona node of one live workflow run. */
export const SetWorkflowPersonaDirectiveSchema = WorkflowRunActionSchema.extend({
  nodeId: WorkflowIdSchema,
  feedback: WorkflowPersonaDirectiveFeedbackSchema,
});
export type SetWorkflowPersonaDirective = z.infer<typeof SetWorkflowPersonaDirectiveSchema>;

/** Remove the active persistent feedback without rewriting attempts that already used it. */
export const RemoveWorkflowPersonaDirectiveSchema = WorkflowRunActionSchema.extend({
  nodeId: WorkflowIdSchema,
});
export type RemoveWorkflowPersonaDirective = z.infer<typeof RemoveWorkflowPersonaDirectiveSchema>;

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
 * One executable argv, in the one place every command surface bounds it.
 *
 * Bounded three ways because it is a durable blob an operator types: element count,
 * per-element length, and joined length. An unbounded argv is a blob nobody bounded, and the
 * joined bound is the one that matters - 32 arguments of 1,000 characters each is an argv no
 * `execve` will take anyway.
 *
 * Stated ONCE and reused by the legacy config shape and the Command catalog alike, so the
 * two write paths that now reach the same storage cannot disagree about what fits.
 */
export const WorkflowCommandArgvSchema = z
  .array(z.string().min(1).max(WORKFLOW_LIMITS.checkCommandArg))
  .min(1)
  .max(WORKFLOW_LIMITS.checkCommandArgs)
  .refine(
    (argv) => argv.join(" ").length <= WORKFLOW_LIMITS.checkCommandLength,
    { message: `Check command exceeds ${WORKFLOW_LIMITS.checkCommandLength} characters` },
  );

/** One repository's command for one slot, in the legacy flat shape. */
export const WorkflowCheckCommandSchema = z.object({
  repoRoot: z.string().min(1).max(WORKFLOW_LIMITS.checkRepoRoot),
  slot: z.enum(WORKFLOW_CHECK_SLOTS),
  command: WorkflowCommandArgvSchema,
});

/** One repository or subdirectory exception, inside the slot that owns it. */
export const WorkflowCommandOverrideSchema = z.object({
  repoRoot: z.string().min(1).max(WORKFLOW_LIMITS.checkRepoRoot),
  command: WorkflowCommandArgvSchema,
});

/**
 * One atomic replacement of a Command slot's COMPLETE state.
 *
 * Both fields are required rather than defaulted, and that is the safety property: a caller
 * who omits `overrides` would otherwise silently clear every exception an operator wrote,
 * and a caller who omits `defaultCommand` would silently clear the machine-wide command. A
 * partial write of a slot is not expressible, so the two halves can never be committed apart.
 *
 * `expectedRevision` is compare-and-swap, exactly as the Persona and SessionAction catalogs
 * do it: two open windows editing one slot must not silently overwrite one another.
 */
export const UpdateWorkflowCommandSchema = z.object({
  expectedRevision: z.number().int().min(1),
  defaultCommand: WorkflowCommandArgvSchema.nullable(),
  overrides: z
    .array(WorkflowCommandOverrideSchema)
    .max(WORKFLOW_LIMITS.commandOverrides)
    // `repoRoot` is the KEY resolution picks by, so two overrides sharing one are two
    // commands an operator can see and only one that can ever run - which of them depends on
    // array order, a thing no surface displays. REFUSED rather than deduplicated: a write
    // that quietly dropped one of two is a caller who sent two and is never told which
    // survived. The store's composite key refuses it a second time.
    .refine(
      (overrides) => new Set(overrides.map((entry) => entry.repoRoot)).size === overrides.length,
      { message: "Each repository may configure a Command only once" },
    ),
});
export type UpdateWorkflowCommand = z.infer<typeof UpdateWorkflowCommandSchema>;

/**
 * The STRICT policy schema: everything about workflows that is still stored in `app_config`.
 *
 * No `.catch()` anywhere in it, deliberately: this is a write path, and `.catch()` on a
 * write turns an invalid value from the panel into a silent no-op - the field reverts on
 * the next poll and nothing says why - where a 400 is a refusal an operator can read. Read
 * tolerance is `StoredWorkflowPolicySchema` below, which is a different question asked of
 * the same shape.
 */
export const WorkflowPolicySchema = z.object({
  liveEnabled: z.boolean().default(DEFAULT_WORKFLOW_POLICY.liveEnabled),
  repoAllowlist: z.array(z.string().min(1).max(4_096)).max(500).default([]),
  defaultWorkflowId: z.string().min(1).max(500).nullable()
    .default(DEFAULT_WORKFLOW_POLICY.defaultWorkflowId),
  retention: z.object({
    rawEvidenceDays: z.number().int().min(1).max(365)
      .default(DEFAULT_WORKFLOW_POLICY.retention.rawEvidenceDays),
    completedRunDays: z.number().int().min(30).max(3_650)
      .default(DEFAULT_WORKFLOW_POLICY.retention.completedRunDays),
    maxCompletedRuns: z.number().int().min(100).max(10_000)
      .default(DEFAULT_WORKFLOW_POLICY.retention.maxCompletedRuns),
  }).default(DEFAULT_WORKFLOW_POLICY.retention),
  checksEnabled: z.boolean().default(DEFAULT_WORKFLOW_POLICY.checksEnabled),
});
export type WorkflowPolicyInput = z.input<typeof WorkflowPolicySchema>;

/**
 * Policy PLUS the legacy flat command list: the complete body `PUT /api/workflows/config`
 * still accepts.
 *
 * `checkCommands` is validated here exactly as strictly as it always was, then handed to the
 * Command catalog rather than persisted beside the policy. Keeping the field on the write
 * schema is what lets the existing Settings form keep saving through one request while the
 * durable owner changes underneath it.
 */
export const WorkflowConfigSchema = WorkflowPolicySchema.extend({
  checkCommands: z
    .array(WorkflowCheckCommandSchema)
    .max(WORKFLOW_LIMITS.checkCommands)
    // `(repoRoot, slot)` is the KEY resolution picks by, so two entries sharing one are two
    // commands an operator can see and only one that can ever run - which of them depends on
    // array order, a thing no surface displays. The panel already replaces rather than
    // appends on a repeat; this is the same rule for a direct API write, which otherwise
    // stores a config the panel could not have produced.
    //
    // REFUSED, not silently deduplicated, for the reason this schema carries no `.catch()`:
    // a write that quietly dropped one of two commands is a caller who sent two and is
    // never told which survived.
    .refine(
      (commands) =>
        new Set(commands.map((entry) => `${entry.repoRoot}\u0000${entry.slot}`)).size
          === commands.length,
      { message: "Each repository may configure a slot only once" },
    )
    .default([]),
});

/**
 * The policy read back off `app_config`, where a value this build cannot parse must not
 * throw.
 *
 * `.default()` already covers an UPGRADE - a blob written before a field existed simply
 * lacks it - so this outer `.catch()` is only for a blob that is present and unreadable: a
 * downgrade from a newer build, or a hand-edited row. `getWorkflowPolicy` is on the path of
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
 *
 * Commands are deliberately NOT in this fallback any more. An unreadable policy blob no
 * longer takes an operator's configured commands with it: those live in their own table with
 * their own revisions, and a preference this build cannot parse says nothing about them.
 */
export const StoredWorkflowPolicySchema = WorkflowPolicySchema.catch(DEFAULT_WORKFLOW_POLICY);

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

/**
 * Foreman's proof that a completion episode is verified, offered to whatever workflow is
 * already bound to the conversation.
 *
 * The claim carries no workflow identity at all. A claim can only ever start a run on a
 * binding an operator or a dispatch already made, so it can never be the thing that puts a
 * second PR-producing path on a branch.
 */
export const WorkflowCompletionClaimSchema = z.object({
  completionKind: z.enum(WORKFLOW_COMPLETION_KINDS),
  marker: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().min(1).max(WORKFLOW_EXECUTION_LIMITS.verdictSummary),
  evidenceFingerprint: z.string().min(1).max(200),
  expectedIntent: z.object({
    objective: z.string().trim().min(1).max(INTENT_MAX),
    objectiveVersion: z.number().int().min(1),
    promptRevision: z.number().int().min(1),
    episodeKey: z.string().min(1).max(200),
  }).refine(
    (intent) =>
      intent.episodeKey === `intent:${intent.objectiveVersion}:${intent.promptRevision}`,
    { message: "Intent episode key does not match its revisions" },
  ).nullable().optional().default(null),
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
    kind: z.enum(TASK_KINDS).default("ship"),
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

/**
 * The archive library's list query.
 *
 * Every field is bounded at the schema edge, and an out-of-range `limit` or an unparseable
 * `cursor` is REFUSED rather than clamped, on `ScheduleHistoryQuerySchema`'s rule: a history
 * route that reinterpreted a bad cursor would page through a different window and look like
 * it worked. `producer` is a generated UUID and `status` is a closed vocabulary, so neither
 * can carry a path fragment into a filter. `kind` is the same closed vocabulary the manifest
 * declares, so a filter names a kind this build understands or is refused.
 */
export const ArchiveSearchQuerySchema = z.object({
  q: z.string().max(ARCHIVE_SEARCH_LIMITS.queryChars).optional(),
  producer: z.string().refine(isArchiveId, "not a producer id").optional(),
  repo: z.string().max(ARCHIVE_TEXT_LIMITS.label).optional(),
  agent: z.string().max(ARCHIVE_TEXT_LIMITS.label).optional(),
  kind: z.enum(ARCHIVE_KINDS).optional(),
  status: z.enum(ARCHIVE_INDEX_STATUSES).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  cursor: z.string().refine((value) => decodeArchiveCursor(value) !== null, "not a cursor").optional(),
  limit: z.coerce.number().int().min(1).max(ARCHIVE_SEARCH_LIMITS.maxLimit).optional(),
});
export type ArchiveSearchQueryInput = z.infer<typeof ArchiveSearchQuerySchema>;

/**
 * Deleting one archive.
 *
 * The body ECHOES the archive key that is already in the URL, and the daemon refuses a
 * mismatch before it resolves any path. That looks redundant and is not: a list is a live,
 * filtered, reconciled view, so a browser holding a stale page can name a row position whose
 * occupant has changed. Binding the typed key to the route key means a delete can only ever
 * remove the archive the operator was actually looking at.
 */
export const DeleteArchiveSchema = z.object({
  confirmArchiveKey: z.string().min(1).max(128),
});
export type DeleteArchiveBody = z.infer<typeof DeleteArchiveSchema>;

/** Handing one archived artifact to a registered "Open in" target. */
export const OpenArchiveArtifactSchema = z.object({
  target: z.enum(OPEN_TARGET_IDS),
});
export type OpenArchiveArtifactBody = z.infer<typeof OpenArchiveArtifactSchema>;

/**
 * One additional supporting file a scout asks to keep, located by a SERVER-ISSUED slot.
 *
 * The slot is validated as a generated `repo-NN` here rather than merely bounded, which is
 * what stops it from being a path fragment: it becomes a directory component under
 * `artifacts/` in the published bundle, and every other component below it comes from the
 * checkout-relative path after its own containment check.
 */
const ScoutSupportingLocatorSchema = z.object({
  repoSlot: z.string().refine(isArchiveRepoSlot, "not a repository slot issued for this task"),
  path: z.string().trim().min(1).max(SCOUT_SUBMISSION_LIMITS.sourcePathChars),
});

/**
 * The MCP `submit_scout_artifacts` request.
 *
 * The shape is the whole security argument, so read what is ABSENT: no environment, task id,
 * session id, cwd, work episode, producer id, archive id, destination, absolute source, digest,
 * or completion status. A scout says what it wrote and what is worth keeping; the daemon
 * derives which task that was, which episode, which checkouts, and where the bundle goes from
 * the signed checkout credential on the HTTP request. A field in this body could only ever be
 * a field used to archive on somebody else's behalf.
 *
 * `reportPath` is checked against the convention HERE, at the schema edge, so a path that is
 * not `docs/reports/<slug>/report.html` is refused with the required shape before any
 * filesystem work happens. That is a shape check and nothing more: containment, symlinks,
 * regular-file-ness, and ignore rules are the daemon's, against a realpath'd root it chose.
 *
 * The zod in `src/mcp/server.ts` is a hand-written mirror of this. They are duplicated
 * deliberately and change together; `test/mission-mcp.test.ts` catches a rename.
 */
export const SubmitScoutArtifactsSchema = z.object({
  reportPath: z
    .string()
    .trim()
    .min(1)
    .max(SCOUT_SUBMISSION_LIMITS.sourcePathChars)
    .refine((value) => scoutReportSlug(value) !== null, `the report must be at ${SCOUT_REPORT_PATH_SHAPE}`),
  summary: z.string().trim().min(1).max(SCOUT_SUBMISSION_LIMITS.summary),
  tags: z
    .array(z.string().trim().min(1).max(SCOUT_SUBMISSION_LIMITS.tag))
    .max(SCOUT_SUBMISSION_LIMITS.tags)
    .optional()
    .default([]),
  supporting: z
    .array(ScoutSupportingLocatorSchema)
    .max(SCOUT_SUBMISSION_LIMITS.supportingFiles)
    .optional()
    .default([]),
});
export type SubmitScoutArtifactsInput = z.infer<typeof SubmitScoutArtifactsSchema>;
