import { z } from "zod";
import { HEADLESS_MODE_FLAG_ID } from "./feature-flag-registry.ts";
import { AGENT_TYPES, SESSION_RUNTIMES, TASK_KINDS } from "./types.ts";
import { WORKFLOW_RUN_STATUSES } from "./workflow.ts";
import type { ResidentLoopState } from "./residents.ts";

/**
 * Wire contracts for headless mode (FR-05), spec version 18, sections 2.3, 7.2, 7.5 to 7.8,
 * 7.23 to 7.25. Every `/dispatch/*` route is declared here, so the daemon, `mctl` and the
 * Claude Code mod parse the same shapes.
 *
 * Later phases fill the route stubs and never change a shape. A contract change is additive,
 * optional, and lands in its own `contract:` commit. Browser safe: no `node:` imports.
 */

/** The preview flag that gates every surface in this file; `feature-flag-registry.ts` owns its id. */
export { HEADLESS_MODE_FLAG_ID };

/** Largest chat message `POST /dispatch/tasks/{taskId}/send` accepts (7.23). */
export const HOME_DISPATCH_SEND_MAX_CHARS = 8000;

/** Where a task came from (2.4). NULL in the database for dashboard tasks. */
export const HOME_DISPATCH_ORIGIN_SURFACES = ["home-session", "mctl"] as const;
export type HomeDispatchOriginSurface = (typeof HOME_DISPATCH_ORIGIN_SURFACES)[number];

/** Who is calling: the mod (a registered home session) or the CLI (7.2). */
export const HOME_DISPATCH_CALLER_SURFACES = ["home-session", "cli"] as const;

const Text = z.string().min(1);
const Count = z.number().int().nonnegative();

/**
 * Caller fields shared by every route that acts for an already registered home session: answers
 * (7.8, through `AnswerCaller`), drafts (7.6) and resident actions (7.24). Registration (7.2)
 * declares its own `sessionId` and `cwd` because it requires `cwd`.
 */
export const HomeDispatchCallerSchema = z.object({
  sessionId: Text,
  cwd: z.string().optional(),
});

/* ---------------------------------------------------------------- registration (7.2) */

export const HOME_SESSION_START_SOURCES = ["startup", "resume", "clear", "compact"] as const;

export const HomeSessionRegistrationSchema = z.object({
  sessionId: Text,
  harness: z.literal("claude"),
  cwd: Text,
  clientVersion: Text,
  source: z.enum(HOME_SESSION_START_SOURCES),
  entrypoint: z.string().nullable(),
  interactive: z.boolean(),
  beforeFirstPrompt: z.boolean(),
  launcherDisabled: z.boolean(),
});
export type HomeSessionRegistration = z.infer<typeof HomeSessionRegistrationSchema>;

export const HomeSessionRegistrationAnswerSchema = z.object({
  sessionId: Text,
  repoRoot: z.string().nullable(),
  created: z.boolean(),
  offerLauncher: z.boolean(),
  counts: z.object({ running: Count, waiting: Count }),
  daemonVersion: Text,
  minModApi: Count,
  dashboardUrl: z.string(),
});
export type HomeSessionRegistrationAnswer = z.infer<typeof HomeSessionRegistrationAnswerSchema>;

/** The oldest mod API this daemon serves; the registration answer's `minModApi` (7.2). */
export const HOME_DISPATCH_MIN_MOD_API = 1;

/* ------------------------------------------------- dispatch intent detector (7.20) */

export type DispatchIntent = "now" | "backlog";

const NAMES_MISSION_CONTROL = /\bmission[ -]control\b|\bmc\b/i;
const SCHEDULE_WORD = /\b(?:schedule|backlog|later|queue|park)\b/i;
const RUN_VERB = /\b(?:run|start|kick\s+off|send|dispatch|hand|delegate)\b/i;

/**
 * Whether a prompt asks to run a task in Mission Control now or to save it for later (7.20).
 *
 * Pure and case-insensitive: it names Mission Control (`mission control`, `mission-control`,
 * or `MC` as a whole word), and then a schedule word gives `backlog`, else a run verb gives
 * `now`, else null. It lives here, in browser-safe shared code, because the mod runs it on the
 * prompt as typed and sends nothing to the daemon. P3 owns it; the home-session rules in
 * `src/server/home-dispatch/sessions.ts` re-export it.
 */
export function dispatchIntentFor(prompt: string): DispatchIntent | null {
  if (!NAMES_MISSION_CONTROL.test(prompt)) return null;
  if (SCHEDULE_WORD.test(prompt)) return "backlog";
  if (RUN_VERB.test(prompt)) return "now";
  return null;
}

/* -------------------------------------------------------------------- inbox (7.7) */

export const INBOX_STATES = ["waiting", "blocked", "ready", "running", "queued", "shelved", "failed"] as const;
export const InboxStateSchema = z.enum(INBOX_STATES);
export type InboxState = z.infer<typeof InboxStateSchema>;

export const REVIEWER_FAILURE_CLASSES = [
  "not-installed", "signed-out", "model-unavailable", "timeout", "provider", "other",
] as const;
export const ReviewerFailureClassSchema = z.enum(REVIEWER_FAILURE_CLASSES);
export type ReviewerFailureClass = z.infer<typeof ReviewerFailureClassSchema>;

export const HomeDispatchReviewerSchema = z.object({
  name: Text,
  runner: Text,
  model: z.string().nullable(),
  state: z.enum(["queued", "running", "retrying", "passed", "failed"]),
  attempt: Count,
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  failure: z.object({ class: ReviewerFailureClassSchema, fix: z.string().nullable() }).nullable(),
});
export type HomeDispatchReviewer = z.infer<typeof HomeDispatchReviewerSchema>;

export const HOME_DISPATCH_PENDING_KINDS = [
  "question", "plan", "plan-decisions", "diff", "plan-review", "resident-request",
] as const;

/** Subagent counts on an inbox item (7.17). The transcript response carries per-subagent lines. */
export const HomeDispatchSubagentCountsSchema = z.object({ running: Count, finished: Count });
export type HomeDispatchSubagentCounts = z.infer<typeof HomeDispatchSubagentCountsSchema>;

export const HomeDispatchInboxItemSchema = z.object({
  taskId: Text,
  title: z.string(),
  kind: z.enum(TASK_KINDS),
  state: InboxStateSchema,
  origin: z.enum(["home-session", "mctl", "resident"]),
  changedAt: z.number(),
  queuePosition: Count.optional(),
  elapsedMs: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  subagents: HomeDispatchSubagentCountsSchema.optional(),
  canMessage: z.boolean(),
  agent: z.enum(AGENT_TYPES),
  runtime: z.enum(SESSION_RUNTIMES).nullable(),
  pr: z.object({
    number: Count,
    url: z.string(),
    checks: z.enum(["pending", "passing", "failing"]).nullable(),
  }).optional(),
  run: z.object({
    workflowId: Text,
    slug: z.string(),
    version: Count,
    status: z.enum(WORKFLOW_RUN_STATUSES),
    phase: z.string().nullable(),
    step: Count.nullable(),
    of: Count.nullable(),
    checks: z.array(z.object({
      name: z.string(),
      state: z.enum(["passed", "running", "failed", "pending"]),
    })),
    blockedReason: z.string().nullable(),
    reviewers: z.array(HomeDispatchReviewerSchema),
  }).optional(),
  pending: z.object({
    reviewId: Text,
    kind: z.enum(HOME_DISPATCH_PENDING_KINDS),
    question: z.string().optional(),
    options: z.array(z.string()).optional(),
    allowsText: z.boolean(),
    revisionHash: z.string().optional(),
    summary: z.string().optional(),
    link: z.string().optional(),
    dashboardOnly: z.boolean(),
    decisions: Count.optional(),
  }).optional(),
  resident: z.object({ runId: Text, name: z.string() }).optional(),
  /**
   * Task shaping's state for the task (spec v20, D60): the "Shaping context" wait and the "Context
   * degraded" marker the dashboard shows. Optional and additive, so an item with nothing to say
   * carries no field. Built from `currentShaping(task)` in `src/shared/shaping.ts`.
   */
  shaping: z.object({ state: z.string(), summary: z.string() }).optional(),
});
export type HomeDispatchInboxItem = z.infer<typeof HomeDispatchInboxItemSchema>;

export const HomeDispatchInboxSchema = z.object({
  items: z.array(HomeDispatchInboxItemSchema),
  needsYou: z.array(Text),
  counts: z.record(InboxStateSchema, Count),
  slots: z.object({ used: Count, ceiling: Count }),
  dashboardOnly: Count,
});
export type HomeDispatchInbox = z.infer<typeof HomeDispatchInboxSchema>;

/** `GET /dispatch/inbox`: `repo` is a path, or `*` for a `cli` caller (`mctl get tasks --all`). */
export const HomeDispatchInboxQuerySchema = z.object({
  repo: z.string().optional(),
  session: z.string().optional(),
});

/* -------------------------------------------------------------- answers (7.8) */

export const HOME_DISPATCH_ANSWER_ACTIONS = [
  "answer", "approve_plan", "request_changes", "approve_review", "reject_review", "chat_first",
] as const;

const AnswerTarget = { taskId: Text, reviewId: Text } as const;
const AnswerCaller = { ...HomeDispatchCallerSchema.shape, fromForm: z.boolean().optional() } as const;

/**
 * `taskId` and `reviewId` name the item answered, so a question replaced since the person
 * read it is refused rather than answered by mistake. The spec's table lists only the
 * per-action fields; the target is added here (recorded in the pull request).
 */
export const HomeDispatchAnswerRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("answer"), ...AnswerTarget, ...AnswerCaller,
    option: z.string().optional(), text: z.string().optional() }),
  z.object({ action: z.literal("approve_plan"), ...AnswerTarget, ...AnswerCaller, revisionHash: Text }),
  z.object({ action: z.literal("request_changes"), ...AnswerTarget, ...AnswerCaller, text: Text }),
  z.object({ action: z.literal("approve_review"), ...AnswerTarget, ...AnswerCaller,
    revisionHash: Text, text: z.string().optional() }),
  z.object({ action: z.literal("reject_review"), ...AnswerTarget, ...AnswerCaller, text: z.string().optional() }),
  z.object({ action: z.literal("chat_first"), ...AnswerTarget, ...AnswerCaller }),
]);
export type HomeDispatchAnswerRequest = z.infer<typeof HomeDispatchAnswerRequestSchema>;

export const HomeDispatchReceiptSchema = z.object({
  reviewId: Text,
  taskId: Text,
  sent: z.string(),
  at: z.number(),
});
export type HomeDispatchReceipt = z.infer<typeof HomeDispatchReceiptSchema>;

/* ------------------------------------------------- dispatch options and drafts (7.5, 7.6) */

export const HOME_DISPATCH_ENTRIES = ["command", "first-message", "conversation"] as const;

export const HomeDispatchOptionsRequestSchema = z.object({
  ...AnswerCaller,
  cwd: Text,
  kind: z.enum(TASK_KINDS).optional(),
  brief: z.string().optional(),
  entry: z.enum(HOME_DISPATCH_ENTRIES),
});
export type HomeDispatchOptionsRequest = z.infer<typeof HomeDispatchOptionsRequestSchema>;

export const HomeDispatchQuestionSchema = z.object({
  id: z.enum(["start", "kind", "after-work", "repo"]),
  header: z.string(),
  question: z.string(),
  options: z.array(z.object({ value: Text, label: z.string(), description: z.string().optional() })),
});
export const HomeDispatchOptionsResponseSchema = z.object({ questions: z.array(HomeDispatchQuestionSchema) });
export type HomeDispatchOptionsResponse = z.infer<typeof HomeDispatchOptionsResponseSchema>;

export const HomeDispatchDraftCreateSchema = z.object({
  ...HomeDispatchCallerSchema.shape,
  kind: z.enum(TASK_KINDS),
  workflowId: z.string().optional(),
  repo: z.string().optional(),
  words: z.string().optional(),
  context: z.string().optional(),
  intent: z.enum(["now", "backlog"]).optional(),
});
export type HomeDispatchDraftCreate = z.infer<typeof HomeDispatchDraftCreateSchema>;

export const HomeDispatchDraftUpdateSchema = z.object({
  ...HomeDispatchCallerSchema.shape,
  kind: z.enum(TASK_KINDS).optional(),
  workflowId: z.string().optional(),
  repo: z.string().optional(),
  words: z.string().optional(),
  context: z.string().optional(),
});
export type HomeDispatchDraftUpdate = z.infer<typeof HomeDispatchDraftUpdateSchema>;

export const HOME_DISPATCH_CONFIRM_CHOICES = ["start", "backlog", "cancel"] as const;
export const HomeDispatchDraftConfirmSchema = z.object({
  ...HomeDispatchCallerSchema.shape,
  choice: z.enum(HOME_DISPATCH_CONFIRM_CHOICES),
});
export type HomeDispatchDraftConfirm = z.infer<typeof HomeDispatchDraftConfirmSchema>;

export const HomeDispatchDraftSummarySchema = z.object({
  draftId: Text,
  repoRoot: z.string(),
  kind: z.enum(TASK_KINDS),
  kindLabel: z.string(),
  afterWork: z.string(),
  afterWorkApplies: z.boolean(),
  words: z.string(),
  context: z.string().nullable(),
  needs: z.array(z.string()),
  brief: z.string(),
  text: z.string(),
});
export type HomeDispatchDraftSummary = z.infer<typeof HomeDispatchDraftSummarySchema>;

export const HomeDispatchConfirmResultSchema = z.object({
  choice: z.enum(HOME_DISPATCH_CONFIRM_CHOICES),
  taskId: z.string().nullable(),
  started: z.boolean(),
});
export type HomeDispatchConfirmResult = z.infer<typeof HomeDispatchConfirmResultSchema>;

/* ------------------------------------------------------------ residents (7.24) */

/** Mirrors `ResidentLoopState` in `residents.ts`: `satisfies` fails if a value here is not a state, and `ResidentLoopStatesComplete` below fails if a state is missing here. */
export const RESIDENT_LOOP_STATE_VALUES = ["working", "waiting", "compacting", "paused", "ended"] as const satisfies readonly ResidentLoopState[];
type AssertNever<T extends never> = T;
export type ResidentLoopStatesComplete = AssertNever<Exclude<ResidentLoopState, (typeof RESIDENT_LOOP_STATE_VALUES)[number]>>;
export const HomeDispatchResidentSchema = z.object({
  runId: Text,
  taskId: Text,
  name: z.string(),
  builtIn: z.boolean(),
  repos: Count,
  loopState: z.enum(RESIDENT_LOOP_STATE_VALUES),
  needsYou: z.boolean(),
  iteration: Count,
  nextWakeAt: z.number().nullable(),
  pauseReason: z.string().nullable(),
  wakeReason: z.string().nullable(),
  runRequestedAt: z.number().nullable(),
  contextPercent: z.number().nullable(),
  costUsd: z.number().nullable(),
});
export type HomeDispatchResident = z.infer<typeof HomeDispatchResidentSchema>;

export const HomeDispatchResidentsSchema = z.object({ residents: z.array(HomeDispatchResidentSchema) });
export type HomeDispatchResidents = z.infer<typeof HomeDispatchResidentsSchema>;

/** `restart` and `cancel-run-now` are not offered from the terminal (7.24). */
export const HOME_DISPATCH_RESIDENT_ACTIONS = ["run-now", "pause", "resume"] as const;
export const HomeDispatchResidentActionRequestSchema = HomeDispatchCallerSchema;
/** The result of the residents' existing route, passed through. */
export const HomeDispatchResidentActionResultSchema = z.looseObject({});

/* ---------------------------------------------------- transcript and send (7.23) */

/** One line per subagent (7.17). `subagentLines` in `subagent-lines.ts` (P15) formats them. */
export const HomeDispatchSubagentLineSchema = z.object({
  type: z.string(),
  state: z.enum(["running", "finished"]),
  elapsedMs: z.number().nonnegative(),
  description: z.string().nullable(),
  tokens: z.number().nullable().optional(),
  toolUses: z.number().nullable().optional(),
});
export type HomeDispatchSubagentLine = z.infer<typeof HomeDispatchSubagentLineSchema>;

/** `?session=` for the mod, `?repo=` for `mctl logs`; `since` is the offset to read after. */
export const HomeDispatchTranscriptQuerySchema = z.object({
  session: z.string().optional(),
  repo: z.string().optional(),
  since: z.coerce.number().int().nonnegative().optional(),
});

export const HomeDispatchStreamQuerySchema = z.object({
  repo: z.string().optional(),
  from: z.coerce.number().int().nonnegative().optional(),
});

/**
 * One transcript turn as `TranscriptMessage` (types.ts) defines it. The five native fields are
 * required; the advisory ones (`origin`, `presentation`, `advisor`, ...) pass through untouched,
 * so a field added to the turn later never makes a valid response fail to parse.
 */
export const HomeDispatchTranscriptMessageSchema = z.looseObject({
  id: Text,
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  tools: z.array(z.looseObject({ name: z.string(), input: z.string().optional(), id: z.string().optional() })),
  ts: z.number().nonnegative(),
});

export const HomeDispatchTranscriptSchema = z.object({
  sessionId: Text,
  messages: z.array(HomeDispatchTranscriptMessageSchema),
  next: Count,
  canMessage: z.boolean(),
  state: z.string(),
  elapsedMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  subagents: z.array(HomeDispatchSubagentLineSchema),
});
export type HomeDispatchTranscript = z.infer<typeof HomeDispatchTranscriptSchema>;

export const HomeDispatchSendRequestSchema = z.object({
  sessionId: Text,
  text: z.string().min(1).max(HOME_DISPATCH_SEND_MAX_CHARS),
});
export type HomeDispatchSendRequest = z.infer<typeof HomeDispatchSendRequestSchema>;
export const HomeDispatchSendResultSchema = z.object({ ok: z.literal(true), at: z.number() });

/* ------------------------------------------------------------ readiness (7.25) */

export const CODEX_TRANSPORTS = ["exec", "sdk"] as const;
const ReviewerPair = z.object({ model: z.string().nullable(), transport: z.enum(CODEX_TRANSPORTS) });

export const CODEX_READINESS_CHECK_IDS = [
  "codex-cli", "codex-version", "codex-auth", "codex-headless", "codex-review-models", "codex-live",
] as const;

export const CodexReadinessSchema = z.object({
  checkedAt: z.number().nullable(),
  stale: z.boolean(),
  accountChangeVisible: z.boolean(),
  accountVerified: z.boolean(),
  observed: z.object({
    codexPath: z.string().nullable(),
    binarySize: z.number().nullable(),
    binaryMtime: z.number().nullable(),
    authMtime: z.number().nullable(),
    codexVersion: z.string().nullable(),
    account: z.string().nullable(),
  }),
  required: z.boolean(),
  canStart: z.boolean(),
  reviewPath: z.object({
    ok: z.boolean(),
    verifiedAt: z.number(),
    codexVersion: z.string(),
    account: z.string(),
    reviewerSetKey: z.string(),
    covered: z.array(ReviewerPair.extend({ ok: z.boolean(), error: z.string().nullable() })),
  }).nullable(),
  reviewsReady: z.boolean(),
  workflows: z.array(z.object({
    workflowId: Text,
    slug: z.string(),
    label: z.string(),
    reviewers: z.array(ReviewerPair.extend({ name: z.string() })),
  })),
  reviewerSet: z.array(ReviewerPair),
  checks: z.array(z.object({
    id: z.enum(CODEX_READINESS_CHECK_IDS),
    level: z.enum(["prerequisite", "review-path"]),
    ok: z.boolean().nullable(),
    required: z.boolean(),
    detail: z.string(),
    fix: z.string().nullable(),
  })),
});
export type CodexReadiness = z.infer<typeof CodexReadinessSchema>;

/** `live=1` is for a `cli` caller only; from the mod it is 400. */
export const HomeDispatchReadinessQuerySchema = z.object({
  session: z.string().optional(),
  live: z.enum(["1"]).optional(),
});

/* -------------------------------------------------------------------- config */

/** `GET /dispatch/config`: the dispatch settings `mctl config` shows (2.3). */
export const HomeDispatchConfigSchema = z.object({
  launcher: z.object({ prompt: z.boolean() }),
});
export type HomeDispatchConfig = z.infer<typeof HomeDispatchConfigSchema>;

/* ------------------------------------------------------------------ route table */

/**
 * The inventory of every `/dispatch/*` route, with the phase that fills it. It registers
 * nothing: `src/server/home-dispatch/routes.ts` lists each `app.get` and `app.post` itself.
 * `test/home-dispatch-routes.test.ts` compares the two, so a route added in one place and not
 * the other fails that test. A new route needs an entry here and a registration there.
 */
export const HOME_DISPATCH_ROUTES = [
  { method: "POST", path: "/dispatch/sessions", owner: "P3" },
  { method: "GET", path: "/dispatch/inbox", owner: "P4" },
  { method: "POST", path: "/dispatch/answers", owner: "P4" },
  { method: "GET", path: "/dispatch/config", owner: "P4" },
  { method: "POST", path: "/dispatch/dispatch-options", owner: "P5" },
  { method: "POST", path: "/dispatch/drafts", owner: "P5" },
  { method: "POST", path: "/dispatch/drafts/:id", owner: "P5" },
  { method: "POST", path: "/dispatch/drafts/:id/confirm", owner: "P5" },
  { method: "GET", path: "/dispatch/readiness", owner: "P7" },
  { method: "GET", path: "/dispatch/residents", owner: "P9" },
  { method: "POST", path: "/dispatch/residents/:runId/:action", owner: "P9" },
  { method: "GET", path: "/dispatch/tasks/:taskId/transcript", owner: "P9" },
  { method: "GET", path: "/dispatch/tasks/:taskId/transcript/stream", owner: "P9" },
  { method: "POST", path: "/dispatch/tasks/:taskId/send", owner: "P9" },
] as const;
