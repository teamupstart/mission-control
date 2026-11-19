/**
 * Headless mode (FR-05) shared contracts: the names, kinds, wire schemas and constants every
 * later work package builds against. Browser-safe: no `node:` imports.
 *
 * Contract rules (spec 8.1): after WP1, a change here only adds an optional field or a new
 * schema, in its own `contract: ...` commit. Nothing in this file reads the flag; each
 * consumer checks `headless-mode` through the feature-flag gates on every operation.
 */
import { z } from "zod";
import { HOME_DISPATCH_KIND_ORDER } from "./task.ts";

export const HEADLESS_MODE_FLAG_ID = "headless-mode" as const;

/** Listed by `/api/health` only while the flag is on. */
export const HOME_DISPATCH_CAPABILITY = "home-dispatch-v1" as const;

/** The only source for the command name. No skill, hook or CLI spells it by hand. */
export const DISPATCH_COMMAND = "/mission-dispatch" as const;

/** The standing line every `SessionStart` context ends with (7.3, 7.20). */
export const DISPATCH_STANDING_LINE =
  "To run or schedule work in Mission Control at any point, use the mission-dispatch skill." as const;

export const DISPATCH_FEATURE_DISABLED = { error: "This feature is disabled.", feature: HEADLESS_MODE_FLAG_ID } as const;

export const HOME_DISPATCH_ROUTE_PREFIX = "/mcp/dispatch" as const;

export const HOME_DISPATCH_ROUTES = {
  sessions: { method: "POST", path: "/mcp/dispatch/sessions" },
  inbox: { method: "GET", path: "/mcp/dispatch/inbox" },
  answers: { method: "POST", path: "/mcp/dispatch/answers" },
  dispatchOptions: { method: "POST", path: "/mcp/dispatch/dispatch-options" },
  drafts: { method: "POST", path: "/mcp/dispatch/drafts" },
  draft: { method: "POST", path: "/mcp/dispatch/drafts/:id" },
  draftConfirm: { method: "POST", path: "/mcp/dispatch/drafts/:id/confirm" },
  checkins: { method: "POST", path: "/mcp/dispatch/checkins" },
  config: { method: "GET", path: "/mcp/dispatch/config" },
  jump: { method: "POST", path: "/mcp/dispatch/jump" },
} as const;

export type HomeDispatchRoute = (typeof HOME_DISPATCH_ROUTES)[keyof typeof HOME_DISPATCH_ROUTES];

/** The one spelling of a route in logs and stub bodies: `POST /mcp/dispatch/answers`. */
export function homeDispatchRouteLabel(route: HomeDispatchRoute): string {
  return route.method + " " + route.path;
}

/** A route's path under its group, for the sub-app that is mounted at `HOME_DISPATCH_ROUTE_PREFIX`. */
export function homeDispatchGroupPath(route: HomeDispatchRoute): string {
  return route.path.slice(HOME_DISPATCH_ROUTE_PREFIX.length);
}

// The kind vocabulary lives in the kind registry (`task.ts`), so no other file writes the set out.
export { HOME_DISPATCH_KINDS, HOME_DISPATCH_KIND_ORDER, type HomeDispatchKind } from "./task.ts";

export const HomeDispatchKindSchema = z.enum(HOME_DISPATCH_KIND_ORDER);

/** `origin_surface` values. Persisted: never rename or reorder (spec 2.4). */
export const HOME_DISPATCH_SURFACES = ["home-session", "mctl"] as const;
export type HomeDispatchSurface = (typeof HOME_DISPATCH_SURFACES)[number];

/** `reviews.resolved_by` actors the server stamps. Persisted: never rename. */
export const HOME_RESOLVER_PREFIX = "home:" as const;
export const HOME_APPROVAL_RESOLVER_PREFIX = "home-approval:" as const;
export const MCTL_RESOLVER = "mctl" as const;
export const homeResolver = (sessionId: string): string => `${HOME_RESOLVER_PREFIX}${sessionId}`;
export const homeApprovalResolver = (sessionId: string): string => `${HOME_APPROVAL_RESOLVER_PREFIX}${sessionId}`;

/** Turns and receipts expire after this long (spec 7.1). */
export const HOME_DISPATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** A turn excerpt never stores more than this many code points of a prompt (7.9). */
export const TURN_EXCERPT_MAX = 120;
/** A draft expires this long after its last change (7.6). */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export const DISPATCH_LAUNCHER_PROMPT_SETTING = "dispatch.launcher.prompt" as const;
export const DISPATCH_MULTIPLEXER_SETTING = "dispatch.multiplexer" as const;
export const DISPATCH_LAUNCHER_ENV = "MISSION_DISPATCH_LAUNCHER" as const;

// ---- the home pane (7.16) -------------------------------------------------------------

export const HomeTerminalSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("tmux"), pane: z.string().min(1), server: z.string().min(1) }),
  z.object({
    backend: z.literal("herdr"),
    pane: z.string().min(1),
    workspace: z.string().min(1).nullable(),
    socket: z.string().min(1).nullable(),
  }),
]);
export type HomeTerminal = z.infer<typeof HomeTerminalSchema>;

// ---- home sessions (7.2) --------------------------------------------------------------

export const HOME_SESSION_START_SOURCES = ["startup", "resume", "clear", "compact"] as const;

export const HomeSessionRegistrationSchema = z.object({
  sessionId: z.string().min(1),
  harness: z.string().min(1),
  cwd: z.string().min(1),
  hookVersion: z.string().nullable().default(null),
  claudePid: z.number().int().positive().nullable().default(null),
  /** Null when the MCP server registers lazily; only a hook registration carries a source. */
  source: z.enum(HOME_SESSION_START_SOURCES).nullable().default(null),
  entrypoint: z.string().nullable().default(null),
  launcherDisabled: z.boolean().default(false),
  terminal: HomeTerminalSchema.nullable().default(null),
});
export type HomeSessionRegistration = z.infer<typeof HomeSessionRegistrationSchema>;

export const HomeSessionRegistrationResultSchema = z.object({
  sessionId: z.string(),
  repoRoot: z.string().nullable(),
  /** False when a hook registration already owned the row and this one only confirmed it. */
  created: z.boolean(),
});
export type HomeSessionRegistrationResult = z.infer<typeof HomeSessionRegistrationResultSchema>;

/** Fields every draft and check-in request carries (7.6, 7.8). */
export const HomeCallerSchema = z.object({
  sessionId: z.string().min(1),
  claudePid: z.number().int().positive().nullable().default(null),
  cwd: z.string().min(1),
});
export type HomeCaller = z.infer<typeof HomeCallerSchema>;

// ---- hook output (7.3) ----------------------------------------------------------------

export const HOOK_DISPATCH_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse"] as const;

/** The optional `dispatch` field of a `/hooks/:event` response. Absent while the flag is off. */
export const HookDispatchOutputSchema = z.object({
  systemMessage: z.string().optional(),
  additionalContext: z.string().optional(),
});
export type HookDispatchOutput = z.infer<typeof HookDispatchOutputSchema>;

// ---- guided choices (7.5) -------------------------------------------------------------

export const DISPATCH_ENTRIES = ["command", "first-message", "conversation"] as const;
export const DispatchEntrySchema = z.enum(DISPATCH_ENTRIES);
export type DispatchEntry = z.infer<typeof DispatchEntrySchema>;

export const DispatchOptionsRequestSchema = z.object({
  cwd: z.string().min(1),
  kind: HomeDispatchKindSchema.optional(),
  brief: z.string().optional(),
  entry: DispatchEntrySchema,
});
export type DispatchOptionsRequest = z.infer<typeof DispatchOptionsRequestSchema>;

export const DispatchChoiceSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type DispatchChoice = z.infer<typeof DispatchChoiceSchema>;

export const DISPATCH_FORM_IDS = ["start", "afterWork", "repo"] as const;

export const DispatchFormSchema = z.object({
  id: z.enum(DISPATCH_FORM_IDS),
  title: z.string(),
  options: z.array(DispatchChoiceSchema).min(1),
  default: z.string(),
});
export type DispatchForm = z.infer<typeof DispatchFormSchema>;

/** The `AskUserQuestion` shape: pages of at most four options (7.5). */
export const DISPATCH_QUESTION_MAX_OPTIONS = 4;
export const DispatchQuestionSchema = z.object({
  header: z.string(),
  question: z.string(),
  options: z.array(DispatchChoiceSchema).min(1).max(DISPATCH_QUESTION_MAX_OPTIONS),
});
export type DispatchQuestion = z.infer<typeof DispatchQuestionSchema>;

export const DispatchOptionsResponseSchema = z.object({
  forms: z.object({
    start: DispatchFormSchema.nullable(),
    afterWork: DispatchFormSchema.nullable(),
    repo: DispatchFormSchema.nullable(),
  }),
  questions: z.array(DispatchQuestionSchema),
  fallbackText: z.string(),
});
export type DispatchOptionsResponse = z.infer<typeof DispatchOptionsResponseSchema>;

// ---- drafts (7.6) ---------------------------------------------------------------------

export const DRAFT_INTENTS = ["now", "backlog"] as const;
export const DraftIntentSchema = z.enum(DRAFT_INTENTS);
export type DraftIntent = z.infer<typeof DraftIntentSchema>;

export const DraftCreateSchema = HomeCallerSchema.extend({
  kind: HomeDispatchKindSchema,
  workflowId: z.string().nullable().optional(),
  repo: z.string().optional(),
  words: z.string().optional(),
  context: z.string().optional(),
  intent: DraftIntentSchema.optional(),
});
export type DraftCreate = z.infer<typeof DraftCreateSchema>;

export const DraftUpdateSchema = HomeCallerSchema.extend({
  kind: HomeDispatchKindSchema.optional(),
  workflowId: z.string().nullable().optional(),
  repo: z.string().optional(),
  words: z.string().optional(),
  context: z.string().optional(),
});
export type DraftUpdate = z.infer<typeof DraftUpdateSchema>;

export const DRAFT_CONFIRM_CHOICES = ["start", "backlog", "cancel"] as const;
export const DraftConfirmSchema = HomeCallerSchema.extend({ choice: z.enum(DRAFT_CONFIRM_CHOICES) });
export type DraftConfirm = z.infer<typeof DraftConfirmSchema>;

export const DRAFT_NEEDS = ["words", "repo"] as const;

export const DraftSummarySchema = z.object({
  draftId: z.string(),
  repoRoot: z.string().nullable(),
  kind: HomeDispatchKindSchema,
  kindLabel: z.string(),
  /** A workflow label, or null for None. */
  afterWork: z.string().nullable(),
  afterWorkApplies: z.boolean(),
  words: z.string(),
  context: z.string(),
  needs: z.array(z.enum(DRAFT_NEEDS)),
  /** Exactly what the worker will receive. */
  brief: z.string(),
  /** The Form 3 message. */
  text: z.string(),
});
export type DraftSummary = z.infer<typeof DraftSummarySchema>;

export const DraftConfirmResultSchema = z.object({
  outcome: z.enum(["started", "saved", "cancelled"]),
  taskId: z.string().nullable(),
  /** Why a start was refused, when the task was saved to the backlog instead. */
  refusal: z.string().nullable().default(null),
});
export type DraftConfirmResult = z.infer<typeof DraftConfirmResultSchema>;

// ---- inbox and check-in (7.7) ---------------------------------------------------------

export const INBOX_STATES = ["waiting", "ready", "running", "queued", "shelved", "failed"] as const;
export const InboxStateSchema = z.enum(INBOX_STATES);
export type InboxState = z.infer<typeof InboxStateSchema>;

export const InboxQuerySchema = z.object({
  /** A repository path, or `*` for every repository. */
  repo: z.string().min(1),
});

export const InboxItemSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  kind: z.string(),
  state: InboxStateSchema,
  changedAt: z.number(),
  reviewId: z.string().nullable().default(null),
  /** Worker-written text. Show it only through `home-dispatch-render`. */
  question: z.string().nullable().default(null),
  options: z.array(z.string()).default([]),
  pullRequestUrl: z.string().nullable().default(null),
  queuePosition: z.number().int().nullable().default(null),
  revisionHash: z.string().nullable().default(null),
  /** Set for items the person must answer in the dashboard, with the text to show. */
  dashboardOnly: z.string().nullable().default(null),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const InboxResponseSchema = z.object({ items: z.array(InboxItemSchema) });
export type InboxResponse = z.infer<typeof InboxResponseSchema>;

export const CheckinRequestSchema = HomeCallerSchema;

export const CheckinResponseSchema = z.object({
  waiting: z.array(InboxItemSchema),
  running: z.array(InboxItemSchema),
  finished: z.array(InboxItemSchema),
  queued: z.number().int().nonnegative(),
  shelved: z.number().int().nonnegative(),
});
export type CheckinResponse = z.infer<typeof CheckinResponseSchema>;

// ---- answers and receipts (7.8) -------------------------------------------------------

const AnswerCallerSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  fromForm: z.boolean().default(false),
});

export const ANSWER_ACTIONS = ["answer", "approve_plan", "request_changes", "approve_review", "reject_review"] as const;

export const AnswerRequestSchema = z.discriminatedUnion("action", [
  AnswerCallerSchema.extend({
    action: z.literal("answer"),
    reviewId: z.string().min(1),
    option: z.string().optional(),
    text: z.string().optional(),
  }).refine((answer) => answer.option !== undefined || answer.text !== undefined, {
    message: "answer needs an option or text",
  }),
  AnswerCallerSchema.extend({
    action: z.literal("approve_plan"),
    reviewId: z.string().min(1),
    revisionHash: z.string().min(1),
  }),
  AnswerCallerSchema.extend({ action: z.literal("request_changes"), reviewId: z.string().min(1), text: z.string().min(1) }),
  AnswerCallerSchema.extend({ action: z.literal("approve_review"), reviewId: z.string().min(1), text: z.string().optional() }),
  AnswerCallerSchema.extend({ action: z.literal("reject_review"), reviewId: z.string().min(1), text: z.string().optional() }),
]);
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;

export const ReceiptSchema = z.object({
  reviewId: z.string(),
  taskId: z.string(),
  sent: z.string(),
  fromWords: z.string().nullable(),
  at: z.number(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

// ---- config view and jump (7.13, 7.16) ------------------------------------------------

export const HomeDispatchConfigViewSchema = z.object({
  slotCeiling: z.number().int().nonnegative(),
  afterWorkByKind: z.record(z.string(), z.string().nullable()),
  launcherPrompt: z.boolean(),
  multiplexer: z.string(),
});
export type HomeDispatchConfigView = z.infer<typeof HomeDispatchConfigViewSchema>;

export const JumpRequestSchema = z.object({
  /** A task id, or `home` for the recorded home pane. */
  target: z.string().min(1),
  returnTo: z.object({ backend: z.enum(["tmux", "herdr"]), pane: z.string().min(1) }).optional(),
});
export type JumpRequest = z.infer<typeof JumpRequestSchema>;

// ---- stubs ----------------------------------------------------------------------------

/** The body every route stub answers with (501) while the flag is on. A later work package replaces the stub. */
export const HomeDispatchNotImplementedSchema = z.object({
  error: z.literal("not implemented"),
  feature: z.literal(HEADLESS_MODE_FLAG_ID),
  route: z.string(),
  owner: z.string(),
});
export type HomeDispatchNotImplemented = z.infer<typeof HomeDispatchNotImplementedSchema>;

// ---- the run-now or schedule intent (7.20) ------------------------------------------

const MISSION_CONTROL_NAME = /\b(?:mission[\s-]control|mc)\b/i;
// Whole words, with the plain inflections a person types ("scheduling", "queued", "kicked off").
const SCHEDULE_WORDS = /\b(?:schedul(?:e|es|ed|ing)|backlog(?:s|ged|ging)?|later|queu(?:e|es|ed|ing)|park(?:s|ed|ing)?)\b/i;
const RUN_VERBS =
  /\b(?:run(?:s|ning)?|start(?:s|ed|ing)?|kick(?:s|ed|ing)?\s+off|send(?:s|ing)?|dispatch(?:es|ed|ing)?|hand(?:s|ing)?|delegat(?:e|es|ed|ing))\b/i;

/**
 * Whether a prompt asks to run something in Mission Control now, or to schedule it in the
 * backlog (spec 7.20). Pure and case-insensitive: it reads the prompt the hook already sends and
 * stores nothing.
 *
 * It matches only when the prompt names Mission Control (`mission control`, `mission-control`,
 * or `MC` as a whole word) AND carries a verb. A schedule word beats a run verb, so "queue this
 * in MC and start it later" is `backlog`. A verb with a negation before it in its clause ("do not run
 * this in Mission Control") does not count, and the verb's own clause must name Mission Control. Anything else is null.
 */
export function dispatchIntentFor(prompt: string): "now" | "backlog" | null {
  // Each segment is judged on its own: the action must be in a segment that names Mission Control,
  // and a negation only cancels an action it comes before in that same segment. So "Do not run this
  // in Mission Control. Start it locally" and "Do not schedule this in MC but run it now in MC" are
  // read one clause at a time.
  const segments = prompt.replace(/[\u2018\u2019]/g, "'").split(/[.!?;,\n]+|\bbut\b/i);
  const named = segments.filter((segment) => MISSION_CONTROL_NAME.test(segment));
  if (named.some((segment) => affirms(SCHEDULE_WORDS, segment))) return "backlog";
  if (named.some((segment) => affirms(RUN_VERBS, segment))) return "now";
  return null;
}

// A refusal such as "do not run this in Mission Control" is not a request (spec 7.20 reads
// requests; a negated verb is the opposite of one).
const INTENT_NEGATIONS = /\b(?:not|no|never|don't|dont|doesn't|cannot|can't|won't|without|stop|skip)\b/i;

/** True when some match of the word has no negation before it in the segment. */
function affirms(word: RegExp, segment: string): boolean {
  const all = new RegExp(word.source, "gi");
  for (const match of segment.matchAll(all)) {
    if (!INTENT_NEGATIONS.test(segment.slice(0, match.index))) return true;
  }
  return false;
}
