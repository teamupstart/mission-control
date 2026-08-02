import type { BacklogPlan, FleetCost, Session, Task } from "@shared/types.ts";
import type { EnsembleSummary } from "@shared/ensemble.ts";
import type { MissionSchedule } from "@shared/schedules.ts";
import type { TaskSourceInstance, TaskSourceStatus } from "@shared/task-source.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import type { LineStageId, LineStageSummary, LineSummary } from "@shared/line.ts";
import { LINE_STAGES } from "@shared/line.ts";
import { backlogTasks, reportBucket } from "@shared/session.ts";
import { readyBacklog } from "@shared/backlog.ts";
import { ensembleIsTerminal } from "@shared/ensemble.ts";
import { sessionActionWaitsOnOperator, workflowRunIsLive } from "@shared/workflow.ts";
import { fmtUsd } from "@shared/cost.ts";

/**
 * The Line's fold: fleet state in, six stages out.
 *
 * PURE, and that is the design rather than a testing convenience. Every input is passed in,
 * so this module opens no database, reads no clock and knows no Registry - which is what
 * makes "does a backlog with one dead prerequisite read as needing me?" a table of fixtures
 * instead of a daemon you have to drive into the state first. The gathering lives in
 * `Registry.lineSummaryNow`, which is the only thing that has to know where each store is.
 *
 * The sentences are worded HERE, on the daemon, for the reason the whole event exists: the
 * browser cannot see task-source sweep recency or the adoption ledger, so a client-side
 * template would be a fold whose author is blind to half its inputs.
 */

/** Everything the fold reads. Assembled by the Registry; nothing here reaches for it. */
export interface LineFoldInput {
  now: number;
  /** Every session the registry holds, exited ones included - the fold does the filtering. */
  sessions: Session[];
  tasks: Task[];
  /** Foreman's ordering opinion, or null. Decides `next up`; absence is not an error. */
  backlogPlan: BacklogPlan | null;
  /** The live catalog: non-archived schedules. */
  schedules: MissionSchedule[];
  taskSources: { source: TaskSourceInstance; status: TaskSourceStatus | undefined }[];
  workflowRuns: WorkflowRunSummary[];
  ensembles: EnsembleSummary[];
  /** Pull requests our agents adopted in the trailing week, from the Inspector's ledger. */
  prsThisWeek: number;
  /**
   * Today's fleet figures, consumed exactly as `FleetStrip` consumes them and never
   * recomputed. Null before the ledger has anything to say, which is the ordinary state on
   * an install with telemetry off.
   */
  cost: FleetCost | null;
}

/** Joined with the separator the mockup uses, skipping the parts that had nothing to say. */
function sentence(...parts: (string | null | false)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" · ");
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/**
 * A past instant as "4m ago" / "3h ago" / "2d ago".
 *
 * Its own small helper rather than an import from `src/web/lib/format.ts`: that module is
 * the browser's, and the one thing this fold must not do is reach across the boundary the
 * event exists to respect. Under a minute reads as "just now" - a strip that ticked
 * "12s ago" → "13s ago" would emit a frame a second forever, which is precisely what the
 * change-gate is there to prevent.
 */
function ago(from: number, now: number): string {
  const ms = Math.max(0, now - from);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A future instant as "in 12m" / "in 3h" / "in 2d", with the same one-minute floor. */
function until(to: number, now: number): string {
  const ms = Math.max(0, to - now);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "any moment";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

/** A source's own name, falling back to its kind when it was never labelled. */
function sourceName(source: TaskSourceInstance): string {
  return source.label.trim() || source.kind;
}

/**
 * INTAKE - the machinery that files work without being asked.
 *
 * Counts CHANNELS, not items: a source that filed nothing this hour is still switched on
 * and still the answer to "where does work come from". Items it filed are counted one stage
 * along, in the backlog, and counting them twice would draw a pipeline that double-bills.
 */
function foldIntake(input: LineFoldInput): LineStageSummary {
  const sources = input.taskSources.filter((s) => s.source.enabled);
  const missions = input.schedules.filter((s) => s.enabled && s.archivedAt === null);
  const count = sources.length + missions.length;

  const failingSources = sources.filter((s) => s.status?.lastError != null);
  // Health is the schedule store's derivation (`deriveScheduleHealth`); this only reads it.
  const failingMissions = missions.filter((m) => m.health === "attention");
  const failing = failingSources.length + failingMissions.length;

  if (count === 0) {
    return { stage: "intake", count: 0, sentence: "no sources or missions", tone: "neutral" };
  }

  const swept = sources
    .map((s) => s.status?.lastSweepAt)
    .filter((at): at is number => typeof at === "number");
  const lastSweep = swept.length > 0 ? Math.max(...swept) : null;
  const sweeper = lastSweep == null ? null : sources.find((s) => s.status?.lastSweepAt === lastSweep);

  const nextRuns = missions
    .map((m) => m.nextRunAt)
    .filter((at): at is number => typeof at === "number");
  const nextRun = nextRuns.length > 0 ? Math.min(...nextRuns) : null;

  const sweeping = sources.some((s) => s.status?.sweeping === true);

  return {
    stage: "intake",
    count,
    sentence: sentence(
      failing > 0 ? `${failing} ${plural(failing, "needs", "need")} a look` : null,
      sweeper && lastSweep != null
        ? `${sourceName(sweeper.source)} swept ${ago(lastSweep, input.now)}`
        : sources.length > 0
          ? "no sweep yet"
          : null,
      nextRun != null ? `next mission ${until(nextRun, input.now)}` : null,
    ) || "configured and quiet",
    tone: failing > 0 ? "attention" : sweeping ? "working" : "idle",
  };
}

/**
 * BACKLOG - filed and not started.
 *
 * `readyBacklog` decides what "ready" means, not this: it already folds the scheduling gate,
 * declared dependencies and Foreman's plan into one ordering, and it is what the board's
 * "next up" marker and the autopilot both select from. A second definition here would put a
 * different task's name on the strip than on the column.
 */
function foldBacklog(input: LineFoldInput): LineStageSummary {
  const waiting = backlogTasks(input.tasks);
  const count = waiting.length;
  if (count === 0) {
    return { stage: "backlog", count: 0, sentence: "nothing waiting", tone: "neutral" };
  }

  const ready = readyBacklog(input.tasks, input.backlogPlan);
  const blocked = count - ready.length;

  // A full backlog with nothing runnable in it is the one backlog state a person has to
  // clear - every item is parked behind a dependency or switched off, so no amount of
  // capacity starts any of it.
  //
  // The two reasons are named separately because the remedies are opposite: a PARKED item
  // was switched off deliberately and needs someone to change their mind, a BLOCKED one is
  // waiting on a prerequisite and needs that prerequisite moved. `readyBacklog` drops
  // disabled items first, so the two counts partition the backlog exactly.
  if (ready.length === 0) {
    const parked = waiting.filter((t) => !t.enabled).length;
    const held = count - parked;
    return {
      stage: "backlog",
      count,
      sentence: sentence(
        "nothing ready",
        parked > 0 && held > 0
          ? `${held} blocked, ${parked} parked`
          : parked > 0
            ? `${parked} parked`
            : `${held} blocked`,
      ),
      tone: "attention",
    };
  }

  return {
    stage: "backlog",
    count,
    sentence: sentence(`next up: ${ready[0]!.title}`, blocked > 0 ? `${blocked} blocked` : null),
    tone: "idle",
  };
}

/**
 * WORKING - open sessions, and how many of them are stuck on you.
 *
 * `reportBucket` is the shared predicate the daemon's sitrep and the dashboard's report
 * panel already share; the strip joins them rather than adding a third opinion about who
 * "needs you". Exited sessions are excluded: they are gone, and the stage counts what is
 * on the board.
 */
function foldWorking(input: LineFoldInput): LineStageSummary {
  const live = input.sessions.filter((s) => s.state !== "exited");
  const count = live.length;
  if (count === 0) {
    return { stage: "working", count: 0, sentence: "no sessions open", tone: "neutral" };
  }

  let needsYou = 0;
  let working = 0;
  for (const s of live) {
    const bucket = reportBucket(s, input.sessions);
    if (bucket === "needs-you") needsYou++;
    else if (bucket === "working") working++;
  }
  const quiet = count - needsYou - working;

  return {
    stage: "working",
    count,
    sentence: sentence(
      needsYou > 0 ? `${needsYou} ${plural(needsYou, "needs", "need")} you` : null,
      working > 0 ? `${working} working` : null,
      quiet > 0 ? `${quiet} idle` : null,
    ),
    tone: needsYou > 0 ? "attention" : working > 0 ? "working" : "idle",
  };
}

/**
 * REVIEW - workflow runs still in flight.
 *
 * The amber half is deliberately narrow. Most of `SESSION_ACTION_WAIT_REASONS` is the daemon
 * waiting on itself, so `sessionActionWaitsOnOperator` picks out only the waits a person can
 * end; `blocked` joins them because a blocked run has stopped and stated why.
 */
function foldReview(input: LineFoldInput): LineStageSummary {
  const live = input.workflowRuns.filter((r) => workflowRunIsLive(r.status));
  const count = live.length;
  if (count === 0) {
    return { stage: "review", count: 0, sentence: "no runs live", tone: "neutral" };
  }

  const waiting = live.filter(
    (r) => r.status === "blocked" || sessionActionWaitsOnOperator(r.actionWait),
  ).length;

  // Which workflow is doing the most of this - the run ladder's identity, condensed. Ties
  // break on the name so the sentence is stable rather than reordering with map iteration.
  const byWorkflow = new Map<string, { name: string; version: number; runs: number }>();
  for (const run of live) {
    const key = `${run.workflowId}@${run.workflowVersion}`;
    const seen = byWorkflow.get(key);
    if (seen) seen.runs++;
    else byWorkflow.set(key, { name: run.workflowName, version: run.workflowVersion, runs: 1 });
  }
  const top = [...byWorkflow.values()].sort(
    (a, b) => b.runs - a.runs || a.name.localeCompare(b.name),
  )[0]!;

  return {
    stage: "review",
    count,
    sentence: sentence(
      `${top.name} v${top.version}${top.runs > 1 ? ` ×${top.runs}` : ""}`,
      waiting > 0 ? `${waiting} waiting on you` : null,
    ),
    tone: waiting > 0 ? "attention" : "working",
  };
}

/**
 * DECIDE - ensemble runs, and which of them have stopped for an answer.
 *
 * `EnsembleSummary.attention` is the daemon's own derivation (`ensembleNeedsAttention`), the
 * same figure the Ensembles tab badge and the away digest count. Read, never recomputed -
 * three surfaces inventing three thresholds is exactly the drift that predicate exists to
 * stop. Members racing under an ensemble are counted on the Working stage, where their
 * sessions are; this stage counts RUNS.
 */
function foldDecide(input: LineFoldInput): LineStageSummary {
  const live = input.ensembles.filter((e) => e.status == null || !ensembleIsTerminal(e.status));
  const count = live.length;
  if (count === 0) {
    return { stage: "decide", count: 0, sentence: "no ensembles live", tone: "neutral" };
  }

  const deciding = live.filter((e) => e.status === "awaiting_decision");
  const attention = live.filter((e) => e.attention).length;

  if (deciding.length > 0) {
    return {
      stage: "decide",
      count,
      sentence:
        deciding.length === 1
          ? `${deciding[0]!.strategyLabel} · waiting on you`
          : `${deciding.length} waiting on you`,
      tone: "attention",
    };
  }

  const ready = live.reduce((n, e) => n + e.readyArtifacts, 0);
  return {
    stage: "decide",
    count,
    sentence: sentence(
      count === 1 ? live[0]!.strategyLabel : `${count} runs`,
      `${ready} ${plural(ready, "artifact")} ready`,
      attention > 0 ? `${attention} ${plural(attention, "needs", "need")} a look` : null,
    ),
    tone: attention > 0 ? "attention" : "working",
  };
}

/**
 * SHIPPED - pull requests our agents adopted, and what they cost.
 *
 * Two windows on purpose, and the sentence says which is which. The COUNT is the week,
 * because a day is too short a window for "did this fleet produce anything" - a Monday
 * morning would read as zero on a fleet that shipped four things on Friday. The per-PR
 * figure is TODAY's, because that is the only window `FleetCost` offers and dividing a
 * day's spend by a week's pull requests would be a number with no meaning.
 */
function foldShipped(input: LineFoldInput): LineStageSummary {
  const count = input.prsThisWeek;
  if (count === 0) {
    return { stage: "shipped", count: 0, sentence: "nothing this week", tone: "neutral" };
  }

  const prsToday = input.cost?.prsToday ?? 0;
  const estimated = input.cost?.estimatedCostToday ?? null;
  // The FleetStrip's own derivation, on the same gate: an estimate over zero pull requests
  // is a division by zero, and a null estimate means some usage in the window is unpriced,
  // so a per-PR figure built from it would be a subtotal wearing a total's clothes.
  const perPr = estimated != null && estimated > 0 && prsToday > 0 ? estimated / prsToday : null;

  return {
    stage: "shipped",
    count,
    sentence: sentence(
      "this week",
      perPr != null
        ? `≈${fmtUsd(perPr)} per PR today`
        : prsToday > 0
          ? `${prsToday} today`
          : "none today",
    ),
    tone: "idle",
  };
}

/**
 * One fold per stage id. A `Record` keyed on `LineStageId` rather than a switch, so adding
 * a stage to `LINE_STAGES` fails to compile here until it has a fold - the strip can never
 * ship a stage the daemon silently has nothing to say about.
 */
const FOLDS: Record<LineStageId, (input: LineFoldInput) => LineStageSummary> = {
  intake: foldIntake,
  backlog: foldBacklog,
  working: foldWorking,
  review: foldReview,
  decide: foldDecide,
  shipped: foldShipped,
};

/** The whole strip, every stage present, in `LINE_STAGES` order. */
export function foldLineSummary(input: LineFoldInput): LineSummary {
  return { stages: LINE_STAGES.map((stage) => FOLDS[stage]!(input)) };
}

/**
 * Whether two folds say the same thing to a human.
 *
 * A field walk rather than `JSON.stringify`, because the point of the gate is to name what
 * counts as news: the count, the sentence and the tone are the whole of what the strip
 * draws, so if all three match on all six stages there is nothing to wake a browser for. A
 * structural compare would agree today and quietly start emitting the moment the payload
 * grew a field nobody renders.
 */
export function lineSummaryEqual(a: LineSummary | null, b: LineSummary): boolean {
  if (a == null || a.stages.length !== b.stages.length) return false;
  return a.stages.every((stage, i) => {
    const other = b.stages[i]!;
    return (
      stage.stage === other.stage &&
      stage.count === other.count &&
      stage.sentence === other.sentence &&
      stage.tone === other.tone
    );
  });
}
