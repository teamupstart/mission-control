// Types for `seed.mjs`, following `scripts/db-shell.d.mts`. The seeder stays plain
// JavaScript because it is an operator script the launcher imports at runtime with no build
// step; this file is what lets `test/demo-seed.test.ts` assert its pure half under
// `noImplicitAny`.

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

/** What the seeder will build, given the mode. `reduced` is `--check`'s smaller seed. */
export function seedPlan(opts?: { reduced?: boolean }): {
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

export function workflowDraft(): {
  nodes: Array<{ id: string; kind: string; outcome?: string; position: { x: number; y: number } }>;
  edges: Array<{
    id: string;
    source: string;
    sourcePort: string;
    target: string;
    targetPort: string;
  }>;
};

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

export function costExports(opts: {
  nowMs: number;
  sessionIds: string[];
  days: number;
}): OtlpExport[];

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
  }>;
  reviews: { pending: number; resolved: number };
  schedules: number;
  personas: number;
  workflowRuns: number;
  ledgerRows: number;
  fleetCost?: number | null;
  headline: string;
}

/** Boot quietly, drive the real routes, stop cleanly. Returns what was seeded. */
export function seedDemoFleet(opts: {
  root: string;
  port: number;
  reduced?: boolean;
  log?: (message: string) => void;
}): Promise<SeededFleet>;

export function printSeedSummary(seeded: SeededFleet): void;
