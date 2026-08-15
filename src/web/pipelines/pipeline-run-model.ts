import {
  PIPELINE_KICKBACK_TARGETS,
  PIPELINE_PHASES,
  pipelineRepoKey,
  pipelineStepInfo,
  sortByPipelineStep,
  type PipelineDaemonState,
  type PipelineGateVerdict,
  type PipelinePhase,
  type PipelineProviderId,
  type PipelineRepoStatus,
  type PipelineRun,
  type PipelineRunGroup,
  type PipelineStep,
  type PipelineStepState,
} from "@shared/pipeline.ts";
import type { PipelineStatus } from "../workflows/pipeline-bits.tsx";

// Everything the Pipelines surface computes, as pure functions over the projection.
//
// Separate from the components for the reason `run-model.ts` is separate from
// `WorkflowRuns.tsx`: these are the claims a reader will act on - which runs need somebody,
// which step a run is on, how many times it has been round - and a claim that can only be
// exercised by rendering a browser is one nobody checks the edges of.
//
// Nothing here derives a fact the daemon already decided. `PipelineRun.group` in particular
// is classified daemon-side from the engine's own files plus its `.daemon/` directory, and
// re-deriving it from the step list here would produce a rail that disagrees with the
// Settings health line the first time one of them learned something the other had not.

/**
 * The rail's groups, in the order an operator should meet them.
 *
 * Deliberately NOT the tuple's own order: `PIPELINE_RUN_GROUPS` is a persisted vocabulary
 * whose order is an append-only contract, and this is a reading order. Halted first because
 * it is the only group that is waiting on a person; parked and processed last because they
 * are outcomes rather than work.
 */
export const PIPELINE_GROUP_ORDER = [
  "halted",
  "building",
  "eligible",
  "waiting",
  "parked",
  "processed",
] as const satisfies readonly PipelineRunGroup[];

/** What each group is called on the rail, and what the word claims. */
export const PIPELINE_GROUP_LABELS: Record<PipelineRunGroup, string> = {
  halted: "Halted",
  building: "Building",
  eligible: "Ready",
  waiting: "Waiting",
  parked: "Parked",
  processed: "Processed",
};

/** The tone each group wears, in the vocabulary the whole fleet already reads. */
export const PIPELINE_GROUP_TONES: Record<PipelineRunGroup, PipelineStatus["tone"]> = {
  halted: "failed",
  building: "running",
  eligible: "waiting",
  // Not amber: nothing is going to advance a waiting run until an operator starts their
  // engine daemon, and amber on this surface means "about to happen".
  waiting: "stopped",
  parked: "stopped",
  processed: "passed",
};

/** What the engine daemon's state is called under a repository heading. */
export const PIPELINE_DAEMON_LABELS: Record<PipelineDaemonState, string> = {
  running: "daemon running",
  paused: "daemon paused",
  stopped: "daemon stopped",
  unknown: "daemon unknown",
};

/** One repository's rail section: its heading, its daemon, and its runs by group. */
export interface PipelineRepoSection {
  /** `pipelineRepoKey(provider, repoRoot)` - the identity a deep link carries. */
  key: string;
  provider: PipelineProviderId;
  repoRoot: string;
  daemon: PipelineDaemonState;
  /** Why the last pass saw less than it should have, or null. */
  error: string | null;
  groups: { group: PipelineRunGroup; runs: PipelineRun[] }[];
  /** How many runs this repository holds, across every group. */
  total: number;
}

/**
 * The rail: every observed repository, with its runs grouped under it.
 *
 * Repositories come from the daemon's own status list so a consented repository with no
 * runs still gets a heading - "nothing here yet" and "we are not looking" are different
 * answers, and only the heading can tell them apart. A run whose repository is missing from
 * that list still gets a section of its own rather than being dropped: consent withdrawal
 * removes runs and statuses in one request, so the two disagreeing means a response is in
 * flight, and a run nobody can see is worse than a heading that outlives its status by a
 * tick.
 */
export function pipelineRail(
  runs: readonly PipelineRun[],
  repos: readonly PipelineRepoStatus[],
): PipelineRepoSection[] {
  const sections = new Map<string, PipelineRepoSection>();
  const section = (
    provider: PipelineProviderId,
    repoRoot: string,
    status: PipelineRepoStatus | null,
  ): PipelineRepoSection => {
    const key = pipelineRepoKey(provider, repoRoot);
    const held = sections.get(key);
    if (held) return held;
    const fresh: PipelineRepoSection = {
      key,
      provider,
      repoRoot,
      daemon: status?.daemon ?? "unknown",
      error: status?.error ?? null,
      groups: [],
      total: 0,
    };
    sections.set(key, fresh);
    return fresh;
  };

  for (const status of repos) section(status.provider, status.repoRoot, status);

  const byKey = new Map<string, PipelineRun[]>();
  for (const run of runs) {
    const target = section(run.provider, run.repoRoot, null);
    const held = byKey.get(target.key) ?? [];
    held.push(run);
    byKey.set(target.key, held);
  }

  for (const entry of sections.values()) {
    const held = byKey.get(entry.key) ?? [];
    entry.total = held.length;
    entry.groups = PIPELINE_GROUP_ORDER.map((group) => ({
      group,
      runs: held
        .filter((run) => run.group === group)
        // Slug rather than time: a rail that re-ordered itself every time a step finished
        // would move the row somebody was reaching for. The groups already carry the
        // urgency, so within one the stable answer is the alphabetical one.
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    })).filter((entry) => entry.runs.length > 0);
  }
  return [...sections.values()];
}

/**
 * The run the bare tab opens on: the most urgent one on the FLEET, not in the first section.
 *
 * Group-major rather than section-major, and that is the whole point of it existing. The rail
 * is grouped per repository because that is how an operator reads it, but urgency does not
 * stop at a repository boundary: flattening the sections in order picks the first repo's
 * merely-building run over a second repo's halted one, and halted is the only group waiting
 * on a person. Repository order breaks a tie WITHIN a group, and the sections already carry
 * their runs slug-sorted, so the answer is stable as steps finish underneath it.
 */
export function pipelineLeadRun(sections: readonly PipelineRepoSection[]): PipelineRun | null {
  for (const group of PIPELINE_GROUP_ORDER) {
    for (const section of sections) {
      const held = section.groups.find((entry) => entry.group === group);
      if (held?.runs[0]) return held.runs[0];
    }
  }
  return null;
}

/** Find one run by the identity a deep link carries, or null when it names nothing. */
export function findPipelineRun(
  runs: readonly PipelineRun[],
  address: { repoKey: string; slug: string } | null,
): PipelineRun | null {
  if (!address) return null;
  return (
    runs.find(
      (run) =>
        run.slug === address.slug &&
        pipelineRepoKey(run.provider, run.repoRoot) === address.repoKey,
    ) ?? null
  );
}

// ---- steps ------------------------------------------------------------------------------

/**
 * What one step's state is called, in the fleet's own status vocabulary.
 *
 * `pending` is grey rather than amber because a strip draws every step the run has not
 * reached: amber means "about to happen", and fifteen amber rows on a healthy run would
 * say the whole SHIP phase needs somebody. `stale` IS amber, because it is the one state
 * that says a finished step is going to run again.
 */
export function pipelineStepStatus(state: PipelineStepState): PipelineStatus {
  switch (state) {
    case "in_progress":
      return { tone: "running", label: "Running" };
    case "done":
      return { tone: "passed", label: "Done" };
    case "failed":
      return { tone: "failed", label: "Failed" };
    case "skipped":
      return {
        tone: "stopped",
        label: "Skipped",
        tooltip: "The engine skipped this step for this run's tier or track",
      };
    case "stale":
      return {
        tone: "waiting",
        label: "Stale",
        tooltip: "A later gate invalidated this step's result, so it runs again",
      };
    case "pending":
      return { tone: "stopped", label: "Pending" };
  }
}

/** One row of the strip: a step, what this build knows about it, and its gate's answer. */
export interface PipelineStepRow {
  name: string;
  /** The provider's own label, or the raw name for a step this build does not know. */
  label: string;
  state: PipelineStepState;
  /** This build has no entry for the step. Drawn as such, never hidden. */
  unknown: boolean;
  /** Which card it belongs on, or null for a step this build cannot place. */
  phase: PipelinePhase | null;
  /** A retained no-op slot in the engine's own state. Drawn like a disabled command. */
  deprecated: boolean;
  /** Dispatched in response to something rather than in sequence. */
  outOfBand: boolean;
  verdict: PipelineGateVerdict | null;
}

/** One phase's card: its steps, in the engine's own order. */
export interface PipelinePhaseCard {
  phase: PipelinePhase;
  steps: PipelineStepRow[];
}

/**
 * Fold a run's steps and its gate evidence into the strip's cards.
 *
 * Three piles come out, and each is a different claim. The phase cards are the sequence the
 * engine walks. Out-of-band steps are dispatched in response to something and have no slot
 * in that sequence, so drawing them inside a phase would say a run "walked past" a step that
 * was never on its path. Unknown steps are the tolerance rule made visible: a conductor
 * release that adds a step degrades this display to a labelled chip at the end, never to a
 * page that refuses to draw.
 */
export function pipelineStrip(
  provider: PipelineProviderId,
  steps: readonly PipelineStep[],
  gates: readonly PipelineGateVerdict[],
): { phases: PipelinePhaseCard[]; outOfBand: PipelineStepRow[]; unknown: PipelineStepRow[] } {
  const verdicts = new Map(gates.map((gate) => [gate.step, gate]));
  const rows = steps.map((step): PipelineStepRow => {
    const info = pipelineStepInfo(provider, step.name);
    return {
      name: step.name,
      label: info?.label ?? step.name,
      state: step.state,
      unknown: info === null,
      phase: info?.phase ?? null,
      deprecated: info?.deprecated ?? false,
      outOfBand: info?.outOfBand ?? false,
      verdict: verdicts.get(step.name) ?? null,
    };
  });
  return {
    phases: PIPELINE_PHASES.map((phase) => ({
      phase,
      steps: rows.filter((row) => !row.outOfBand && row.phase === phase),
    })),
    outOfBand: rows.filter((row) => !row.unknown && row.outOfBand),
    unknown: rows.filter((row) => row.unknown),
  };
}

/**
 * What a whole phase card says, folded from its steps.
 *
 * The precedence answers "what does this phase want from me", so a failure outranks work in
 * progress and both outrank the arithmetic of how much is done. A phase that finished with
 * skipped steps is `degraded`: it passed, and it did not do everything a full-ceremony run
 * would have, and a reader comparing two runs needs to see that difference.
 */
export function pipelinePhaseStatus(steps: readonly PipelineStepRow[]): PipelineStatus | null {
  if (steps.length === 0) return null;
  const has = (state: PipelineStepState): boolean => steps.some((step) => step.state === state);
  if (has("failed")) return { tone: "failed", label: "Failed" };
  if (has("in_progress")) return { tone: "running", label: "Running" };
  if (has("stale")) return { tone: "waiting", label: "Re-running" };
  const finished = steps.filter((step) => step.state === "done" || step.state === "skipped");
  if (finished.length === steps.length) {
    const skipped = steps.filter((step) => step.state === "skipped").length;
    return skipped === 0
      ? { tone: "passed", label: "Done" }
      : {
          tone: "passed",
          label: `Done, ${skipped} skipped`,
          degraded: true,
          tooltip: "The engine skipped those steps for this run's tier or track",
        };
  }
  if (finished.length > 0) return { tone: "waiting", label: `${finished.length}/${steps.length}` };
  return { tone: "stopped", label: "Pending" };
}

/** The one-line summary under a phase card's name. */
export function pipelinePhaseSummary(steps: readonly PipelineStepRow[]): string {
  if (steps.length === 0) return "no steps";
  return steps.length === 1 ? "1 step" : `${steps.length} steps`;
}

// ---- the live eyebrow -------------------------------------------------------------------

/**
 * Where the run is, as one line: the phase it is in and how far along the sequence.
 *
 * Counted over the run's OWN sequential steps rather than over the frozen table's 22,
 * because the two differ whenever the engine's vocabulary has moved and the projection is
 * what actually exists. A step this build does not know still gets a position - it is a step
 * the run really is on - it just cannot name a phase for it.
 */
export function pipelineEyebrow(run: PipelineRun): string {
  const sequential = run.steps.filter(
    (step) => !pipelineStepInfo(run.provider, step.name)?.outOfBand,
  );
  if (run.lastStep === null) return "Not started";
  const index = sequential.findIndex((step) => step.name === run.lastStep);
  const info = pipelineStepInfo(run.provider, run.lastStep);
  const where = info ? info.phase : "Unknown step";
  const label = info?.label ?? run.lastStep;
  return index < 0
    ? `${where} · ${label}`
    : `${where} · ${label} · step ${index + 1} of ${sequential.length}`;
}

/** The rail row's second line: what it is doing, or why it stopped. */
export function pipelineRunLine(run: PipelineRun): string {
  if (run.halt) return run.halt.reason;
  if (run.lastStep === null) return "no step recorded yet";
  return pipelineStepInfo(run.provider, run.lastStep)?.label ?? run.lastStep;
}

// ---- attempts ---------------------------------------------------------------------------

/**
 * One pass the run made at the work, opened by a gate sending it back.
 *
 * There is no attempt counter in the engine's state, and this does not invent one: an
 * attempt here IS a recorded kickback, and a run with no kickbacks has exactly one. That is
 * the honest reading of the only durable trace a kickback leaves.
 */
export interface PipelineAttempt {
  /** 1-based, in the order the kickbacks were recorded. */
  index: number;
  /** What re-opened it: the step that refused, and the steps it re-opened. Null for the first. */
  kickback: { from: string; to: string[]; at: number | null } | null;
  /** The attempt the run is on now. */
  current: boolean;
}

/**
 * Fold gate evidence into attempts.
 *
 * Two gates re-opened by the SAME step at the same instant are one kickback rather than two
 * attempts: a refusal invalidates every gate downstream of the step it returns to, so the
 * engine writes several files for one decision, and counting files would report a run as
 * having gone round four times when it went round once.
 *
 * Undated verdicts sort last and stably. They are rare - the engine dates what it writes -
 * and putting them at the end keeps them visible rather than interleaving them at an
 * invented time.
 */
export function pipelineAttempts(gates: readonly PipelineGateVerdict[]): PipelineAttempt[] {
  const kicked = gates.filter((gate) => gate.kickbackFrom !== null);
  const merged = new Map<string, { from: string; to: string[]; at: number | null; order: number }>();
  for (const [order, gate] of kicked.entries()) {
    const key = `${gate.kickbackFrom}${gate.checkedAt ?? ""}`;
    const held = merged.get(key);
    if (held) {
      held.to.push(gate.step);
      continue;
    }
    merged.set(key, {
      from: gate.kickbackFrom!,
      to: [gate.step],
      at: gate.checkedAt,
      order,
    });
  }
  const ordered = [...merged.values()].sort((a, b) => {
    if (a.at === null && b.at === null) return a.order - b.order;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return a.at - b.at || a.order - b.order;
  });
  const attempts: PipelineAttempt[] = [
    { index: 1, kickback: null, current: ordered.length === 0 },
  ];
  for (const [i, entry] of ordered.entries()) {
    attempts.push({
      index: i + 2,
      kickback: { from: entry.from, to: entry.to, at: entry.at },
      current: i === ordered.length - 1,
    });
  }
  return attempts;
}

/** What a gate's answer says, as a chip beside the step that owns it. */
export function pipelineVerdictStatus(verdict: PipelineGateVerdict): PipelineStatus {
  if (verdict.skipped) {
    return {
      tone: "stopped",
      label: "Gate skipped",
      ...(verdict.reason ? { tooltip: verdict.reason } : {}),
    };
  }
  return {
    tone: verdict.satisfied ? "passed" : "failed",
    label: verdict.satisfied ? "Gate passed" : "Gate refused",
    ...(verdict.reason ? { tooltip: verdict.reason } : {}),
  };
}

/** Gate evidence in the strip's own order, for the list under it. */
export function pipelineVerdicts(
  provider: PipelineProviderId,
  gates: readonly PipelineGateVerdict[],
): PipelineGateVerdict[] {
  return sortByPipelineStep(provider, gates, (gate) => gate.step);
}

/** How the engine's kickback rule reads under the strip. */
export function pipelineKickbackRule(provider: PipelineProviderId): string {
  const targets = PIPELINE_KICKBACK_TARGETS[provider].map(
    (step) => pipelineStepInfo(provider, step)?.label ?? step,
  );
  return `A refused gate sends the run back to ${targets.join(", ")} rather than failing it, and every step after the one it returns to runs again.`;
}
