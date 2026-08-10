// Types for `seed.mjs`, following `scripts/db-shell.d.mts`. The seeder stays plain
// JavaScript because it is an operator script the launcher imports at runtime with no build
// step; this file is what lets `test/demo-seed.test.ts` assert its pure half under
// `noImplicitAny`.
//
// The graph types below are the APP's own rather than structural copies, so a test can hand the
// seeded draft straight to `projectStages` and to `CreateWorkflowSchema`. A hand-copied node union
// would drift from the real one silently, which is the entire failure mode these declarations
// exist to prevent.
import type {
  WorkflowDraftGraph,
  WorkflowNodeAttemptState,
  WorkflowRunStatus,
} from "@shared/workflow.ts";

/** A task the seeder dispatches, giving it a real worktree and a played scenario. */
export interface SeedSessionTask {
  key: string;
  repo: string;
  title: string;
  intent: string;
  priority: "low" | "med" | "high" | "blocker";
  labels: string[];
  /** What state the task and its card are left in. */
  settle: "complete" | "leave-running" | "leave-waiting" | "workflow";
  /**
   * Messages to queue on the card once it has settled, in delivery order.
   *
   * Only meaningful with `settle: "leave-waiting"`: the outbox drains onto a session with no held
   * dialog, so any other settle mode would deliver these instead of queueing them.
   */
  queuedMessages?: string[];
}

/** A task the seeder leaves on the board. Only some carry each of the three flags. */
export interface SeedBacklogTask {
  key: string;
  repo: string;
  title: string;
  intent: string;
  priority: "low" | "med" | "high" | "blocker";
  labels: string[];
  /** The `key` of a task this one waits on, which renders as blocked. */
  dependsOn?: string;
  /** Set `enabled: false` after creating it, which renders as parked. */
  park?: boolean;
  /** Cancel it after creating it. */
  cancel?: boolean;
}

export interface SeedSchedule {
  repo: string;
  name: string;
  /** A five-field cron expression, no more frequent than hourly. */
  expression: string;
  overlapPolicy: "skip-active" | "allow";
  missedPolicy: "coalesce-latest" | "create-all" | "skip";
  title: string;
  intent: string;
  priority: "low" | "med" | "high" | "blocker";
  labels: string[];
}

export interface SeedPersona {
  name: string;
  description: string;
  guidanceMarkdown: string;
}

export const SEED_SESSION_TASKS: SeedSessionTask[];
export const SEED_BACKLOG_TASKS: SeedBacklogTask[];
export const SEED_SCHEDULES: SeedSchedule[];
export const SEED_PERSONA: SeedPersona;
export const WORKFLOW_RUN_SETTLED: string[];
export const SEED_WORKFLOW_NAME: string;
/** The built-in review roles the seeded graph names, by `builtin:<slug>` id. */
export const SEED_WORKFLOW_REVIEWERS: {
  intent: string;
  risk: string;
  evidence: string;
  documentation: string;
};

/** What the seeder will build, given the mode. `reduced` is `--check`'s smaller seed. */
export function seedPlan(opts?: { reduced?: boolean; readme?: boolean; capture?: boolean }): {
  sessionTasks: SeedSessionTask[];
  backlogTasks: SeedBacklogTask[];
  schedules: SeedSchedule[];
  persona: SeedPersona | null;
  workflow: boolean;
  ledgerDays: number;
};

export function taskBody(
  spec: SeedSessionTask | SeedBacklogTask,
  repoRoot: string,
  opts: { backlog: boolean; dependsOnTaskId?: string | null },
): Record<string, unknown>;

export function scheduleBody(
  spec: SeedSchedule,
  repoRoot: string,
  timezone: string,
): Record<string, unknown>;

/**
 * The seeded review pipeline. `customPersonaId` adds the seeded Persona to the parallel stage;
 * omit it (or pass null) for the three shipped deep reviewers alone.
 */
export function workflowDraft(opts?: { customPersonaId?: string | null }): WorkflowDraftGraph;

/** One thing in the pipeline that produced a verdict, and what it said. */
export interface SeedJudged {
  name: string;
  verdict: string;
  attempt: number;
  kind: "reviewer" | "check";
}

/** What the seeded run turned out to be. `clean` is the claim the seed refuses to ship without. */
export interface SeedReviewOutcome {
  status: string;
  clean: boolean;
  /** Persona nodes that answered. */
  reviewers: SeedJudged[];
  /** Check nodes that cleared - counted apart, because a skipped check is a weaker claim. */
  checks: SeedJudged[];
  round: number;
  summary: string;
}

/**
 * Only the fields of `GET /api/workflow-runs/:id` that `reviewOutcome` reads.
 *
 * Spelled out rather than derived as a deep-partial of `WorkflowRunDetail`, whose `WorkflowJson`
 * arms recurse deeply enough to defeat `tsc` (TS2589). The scalars that MATTER still come from the
 * app's own unions, so a fixture naming a status or attempt state this build does not have is a
 * compile error rather than a case that silently tests nothing.
 */
export interface SeedRunDetailFields {
  run?: { status?: WorkflowRunStatus; currentPhase?: string };
  summary?: { round?: number; failedPersonaCount?: number };
  attempts?: Array<{
    nodeId?: string;
    attempt?: number;
    state?: WorkflowNodeAttemptState;
    persona?: { name?: string } | null;
    verdict?: { verdict?: "pass" | "fail" } | null;
    sessionAction?: unknown;
    error?: string | null;
  }>;
}

/** Judge one settled run from the same detail the Runs page reads. */
export function reviewOutcome(detail: SeedRunDetailFields | null): SeedReviewOutcome;

/** One OTLP datapoint. `timeUnixNano` is a decimal DIGIT STRING - see `costExport`. */
export interface OtlpDataPoint {
  asDouble: number;
  startTimeUnixNano: string;
  timeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue: string } }>;
}

export interface OtlpMetric {
  name: string;
  sum: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: OtlpDataPoint[] };
}

/** One OTLP/HTTP JSON metrics export, as `POST /v1/metrics` takes it. */
export interface OtlpExport {
  resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: OtlpMetric[] }> }>;
}

export function costExport(opts: {
  sessionId: string;
  atMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}): OtlpExport;

/**
 * The ledger BEHIND the cards. Takes no session ids on purpose: a card's own spend is written by
 * the driver from its `result` frame, and an OTLP row naming a driven session is dropped.
 */
export function costExports(opts: { nowMs: number; days: number }): OtlpExport[];

/** One `POST /api/usage/automation` body. */
export interface SpendReport {
  role: string;
  runner: string;
  runId: string;
  ts: number;
  models: Array<{
    modelId: string;
    input: number;
    output: number;
    reasoningOutput: number;
    cacheRead: number;
    cacheWrite: number;
    reportedCostUsd: number | null;
  }>;
}

export function automationReports(opts: { nowMs: number; days: number }): SpendReport[];

/** Poll `probe` until it returns something truthy. `probe` gets a note sink for diagnostics. */
export function waitFor<T>(
  what: string,
  probe: (note: (text: string) => void) => Promise<T | null>,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<T>;

/** The `snapshot` frame `GET /events` opens with - the dashboard's own first read. */
export function readSnapshot(baseURL: string): Promise<{
  type: "snapshot";
  sessions: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  reviews: Array<{ status: string; [key: string]: unknown }>;
  workflowRunSummaries: Array<Record<string, unknown>>;
  schedules: Array<Record<string, unknown>>;
  fleetCost: { estimatedCostToday: number | null; [key: string]: unknown } | null;
  [key: string]: unknown;
}>;

export interface SeededFleet {
  tasks: Array<{ title: string; status: string }>;
  sessions: Array<{
    id: string;
    agentSessionId: string | null;
    title: string;
    key: string;
    taskId: string;
    cwd: string | null;
    state: string;
    /** How many messages were left in this card's outbox. */
    queued: number;
  }>;
  reviews: { pending: number; resolved: number };
  schedules: number;
  personas: number;
  workflowRuns: number;
  /** The seeded run's outcome, plus which session it is bound to. Null when none ran. */
  workflowReview: (SeedReviewOutcome & { session: string }) | null;
  ledgerRows: number;
  fleetCost?: number | null;
  headline: string;
}

/** Boot quietly, drive the real routes, stop cleanly. Returns what was seeded. */
export function seedDemoFleet(opts: {
  root: string;
  port: number;
  reduced?: boolean;
  readme?: boolean;
  capture?: boolean;
  keepDaemonAlive?: boolean;
  log?: (message: string) => void;
}): Promise<SeededFleet & {
  daemon?: { baseURL: string; stop: () => Promise<void> };
}>;

export function printSeedSummary(seeded: SeededFleet): void;
