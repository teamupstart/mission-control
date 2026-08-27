import {
  PIPELINE_HALT_CLASS_INFO,
  PIPELINE_KICKBACK_TARGETS,
  PIPELINE_PHASES,
  PIPELINE_RUN_GROUPS,
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
import type { PipelineStatus, PipelineStatusTone } from "../workflows/pipeline-bits.tsx";

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
 * How urgently each group wants an operator, lowest first.
 *
 * A `Record` over the union rather than a hand-written list, and that is the whole point:
 * `pipelineRail` shows a run only if its group appears in the reading order below, so a group
 * added to `PipelineRunGroup` and forgotten here would not be a mis-sorted rail - it would be
 * a run that is invisible, uncounted in `section.total`, and unreachable through
 * `pipelineLeadRun`. `satisfies readonly PipelineRunGroup[]` on a literal list cannot catch
 * that: it checks that every element IS a group, never that every group is an element. A
 * `Record` inverts the obligation, so the omission is a compile error at the point of the
 * change.
 */
const PIPELINE_GROUP_RANK: Record<PipelineRunGroup, number> = {
  // The only group waiting on a person.
  halted: 0,
  building: 1,
  eligible: 2,
  waiting: 3,
  // Outcomes rather than work, so they sort below everything still moving.
  parked: 4,
  processed: 5,
};

/**
 * The rail's groups, in the order an operator should meet them.
 *
 * Deliberately NOT the tuple's own order: `PIPELINE_RUN_GROUPS` is a persisted vocabulary
 * whose order is an append-only contract, and this is a reading order. Halted first because
 * it is the only group that is waiting on a person; parked and processed last because they
 * are outcomes rather than work.
 *
 * Derived from that tuple rather than restated, so this is a permutation of the vocabulary by
 * construction and cannot silently lose a member. The rank above decides the order; the
 * vocabulary decides the membership.
 */
export const PIPELINE_GROUP_ORDER: readonly PipelineRunGroup[] = [...PIPELINE_RUN_GROUPS].sort(
  (a, b) => PIPELINE_GROUP_RANK[a] - PIPELINE_GROUP_RANK[b],
);

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
    case "refused":
      return {
        tone: "waiting",
        label: "Refused",
        tooltip:
          "An entry condition, environmental guard, or human judgement boundary refused this attempt; the step's work did not fail",
      };
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
  // Refusal is terminal for this attempt but is not failed work. It therefore outranks a
  // sibling still marked in progress while keeping the fleet's amber attention tone.
  if (has("refused")) return { tone: "waiting", label: "Refused" };
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
 * The run's OWN sequential steps - the ones any "n of N" about this run is counted over.
 *
 * Extracted from the eyebrow so the eyebrow and the board card's phase meter cannot come to
 * disagree about what the denominator is. Two rules are folded into the one filter, and both
 * are load-bearing:
 *
 * - A KNOWN out-of-band step is dropped. It was dispatched in response to something and never
 *   had a slot in the sequence, so counting it would report a run as longer than the path it
 *   actually walked.
 * - An UNKNOWN step is KEPT, and the optional chain is the reason rather than an accident:
 *   `pipelineStepInfo` answers null for a name this build has no entry for, so the property
 *   read yields undefined and the step survives the filter. It is a step the run really has,
 *   and a total that quietly excluded it would be wrong about the engine rather than tolerant
 *   of it. A caller that counts one owes it somewhere to be READ - see `pipelinePhaseMeter`.
 */
export function pipelineSequentialSteps(run: PipelineRun): PipelineStep[] {
  return run.steps.filter((step) => !pipelineStepInfo(run.provider, step.name)?.outOfBand);
}

/**
 * Where the run is, as one line: the phase it is in and how far along the sequence.
 *
 * Counted over the run's OWN sequential steps rather than over the frozen table's 22,
 * because the two differ whenever the engine's vocabulary has moved and the projection is
 * what actually exists. A step this build does not know still gets a position - it is a step
 * the run really is on - it just cannot name a phase for it.
 */
export function pipelineEyebrow(run: PipelineRun): string {
  const sequential = pipelineSequentialSteps(run);
  if (run.lastStep === null) return "Not started";
  const index = sequential.findIndex((step) => step.name === run.lastStep);
  const info = pipelineStepInfo(run.provider, run.lastStep);
  const where = info ? info.phase : "Unknown step";
  const label = info?.label ?? run.lastStep;
  return index < 0
    ? `${where} · ${label}`
    : `${where} · ${label} · step ${index + 1} of ${sequential.length}`;
}

// ---- the board card's phase meter -------------------------------------------------------

/**
 * One segment of the board card's phase meter: a phase, sized and filled by THIS run.
 *
 * `total` and `finished` are counted over the phase's own steps as the projection reports
 * them, never over the frozen table. That is the whole tolerance rule expressed as geometry:
 * ai-conductor builds its effective step list per repository, and its own config disables one
 * step and inserts two custom SHIP ones - so a hardcoded 1/1/9/5/6 split would be wrong on
 * the very repository this meter exists to watch.
 */
export interface PipelinePhaseSegment {
  phase: PipelinePhase;
  /** The phase's steps, in the engine's own order, for the popover's rows. */
  steps: PipelineStepRow[];
  /**
   * What the phase says, from `pipelinePhaseStatus` - never a local map, so failure keeps
   * outranking running and both keep outranking the arithmetic below.
   *
   * A phase the run's state file has never mentioned folds to null there; it is reported as
   * "Not started" rather than dropped, so the meter is always the engine's whole sequence.
   */
  status: PipelineStatus;
  /** How many steps this phase holds in this run. The segment's share of the bar's width. */
  total: number;
  /** Done or skipped. The segment's fill. */
  finished: number;
  /** The phase the run is in right now, which is the segment that carries the ring. */
  current: boolean;
  /**
   * The sentence under the popover's rows, or null. The halt's own reason on the phase the
   * halt is attributed to, else the skip explanation on a phase that finished having skipped
   * something - which is the difference between "done" and "done, 2 skipped" said in words as
   * well as in a hatch.
   */
  footer: string | null;
}

/** Everything the board card's phase meter draws, folded from one run. */
export interface PipelinePhaseMeterView {
  /** One per entry of `PIPELINE_PHASES`, always, in that order. */
  segments: PipelinePhaseSegment[];
  /**
   * The caption's phase word: the phase the run is in, `"Unknown step"` for a step this
   * build cannot place, or `"Not started"` before the first one. It inherits the eyebrow's
   * honest arm deliberately - a nearest-phase guess would be a claim the projection does
   * not support.
   */
  caption: string;
  /** The tone the caption word wears: the halt's if the run halted, else the phase it names. */
  captionTone: PipelineStatusTone;
  /**
   * The run's halt, or null - read straight off `run.halt` with NO other condition.
   *
   * Unconditional on purpose, and the meter's answer to "has anything failed". It used to be
   * carried only by the popover of a phase whose tone had resolved to `failed`, which was a
   * bug rather than a shortcut: `pipelinePhaseStatus` is a function of step STATES and knows
   * nothing about `run.halt`, so a run that halted during a step - the halting step still
   * `in_progress` - had no failed phase, no halt sentence anywhere, and a blue current
   * segment reading as work in progress. `classifyGroup`
   * (`src/server/pipelines/conductor/normalize.ts`) names that exact case as the reason
   * `halted` outranks `building`: "a run with a HALT marker AND an in-progress step halted
   * DURING that step; drawing it as `building` would say work is happening that stopped."
   * The meter was saying it.
   *
   * So a halt is a fact about the RUN and is stated at the run's own level, the way
   * `pipelineRunLine` above already states it (`if (run.halt) return run.halt.reason`).
   * Attributing it to a phase, below, is an addition to that and never the only copy.
   */
  halt: { label: string; reason: string; blurb: string } | null;
  /** Finished steps of the run's own sequential list - the `n` of `n/N`. */
  done: number;
  /** The run's own sequential step count - the `N`. */
  total: number;
  /**
   * The steps that can own no segment, which is why they need a home of their own.
   *
   * `unknown` names steps this build cannot place: they ARE inside `total` above, because the
   * run really has them. `outOfBand` names known steps the run dispatched in response to
   * something: they are NOT in `total`, because they were never on the sequence. Both are
   * absent from every segment's `steps`, so a meter that counted them and drew them nowhere
   * would be leaving the reader an unexplained discrepancy. The general rule: anything the
   * meter counts must be readable somewhere on the meter.
   */
  extras: { unknown: PipelineStepRow[]; outOfBand: PipelineStepRow[] };
}

/**
 * Fold one run into the board card's phase meter.
 *
 * A composition of the existing derivation rather than a second one: `pipelineStrip` splits
 * the steps into the five phases and the two piles, and `pipelinePhaseStatus` says what each
 * phase wants. Nothing here re-decides either, which is what stops the card and the Runs page
 * from ever disagreeing about what a phase's colour means.
 *
 * Called with NO GATE EVIDENCE, and that is a finding rather than a shortcut:
 * `pipelinePhaseStatus` reads only `step.state` and never a verdict, so the card needs no
 * fetch and gate verdicts stay detail-only exactly as `src/shared/pipeline.ts` intends.
 *
 * Null for a run with no sequential steps at all - a worktree the engine has only just cut.
 * An empty five-segment bar would claim a shape the projection has not reported.
 */
export function pipelinePhaseMeter(run: PipelineRun): PipelinePhaseMeterView | null {
  const sequential = pipelineSequentialSteps(run);
  if (sequential.length === 0) return null;
  const strip = pipelineStrip(run.provider, run.steps, []);

  const lastInfo = run.lastStep ? pipelineStepInfo(run.provider, run.lastStep) : null;
  /**
   * The phase the run is IN, and therefore the one segment that gets the ring - derived only
   * from a step the bar can honestly point at, which means sequential AND placeable.
   *
   * The out-of-band exclusion is the whole reason this is not `pipelinePhaseOfStep`. A known
   * out-of-band step still carries a registry phase (`remediate` is filed under SHIP), but
   * `pipelineStrip` deliberately puts it in no phase's `steps` - drawing it inside one would
   * say the run walked past something that was never on its path. Reading its phase back for
   * the ring reintroduced exactly that claim from the other end: a run remediating after a
   * blocked SHIP gate captioned SHIP and ringed a SHIP segment with nothing started in it.
   *
   * So an out-of-band current step rings nothing, the same answer the unknown-step case
   * already gave. The step itself is not lost: it is named, with its state and a `current`
   * marker, in the extras marker that is the only home either pile has.
   */
  const current = lastInfo && !lastInfo.outOfBand ? lastInfo.phase : null;

  const halt = run.halt
    ? {
        label: PIPELINE_HALT_CLASS_INFO[run.halt.class].label,
        reason: run.halt.reason,
        blurb: PIPELINE_HALT_CLASS_INFO[run.halt.class].blurb,
      }
    : null;

  const base = strip.phases.map((card) => ({
    card,
    // The same fallback the vertical ladder draws for an unmentioned phase, for the same
    // reason: the sequence the operator is reading is the engine's, not the projection's.
    status: pipelinePhaseStatus(card.steps) ?? { tone: "stopped" as const, label: "Not started" },
  }));

  /**
   * Which phase's popover also carries the halt sentence.
   *
   * The phase that failed when there is one, because that is where the evidence is. Otherwise
   * the phase the run is IN, because a run halts somewhere and the ringed segment is the
   * segment an operator opens first. And when the run is on no placeable phase at all, no
   * segment claims it - the caption's own halt marker is then the only honest home, which is
   * the same rule the extras marker exists for: anything the meter states must be readable
   * somewhere on the meter, and never attributed to a phase that did not earn it.
   */
  const haltHome =
    base.find((entry) => entry.status.tone === "failed")?.card.phase ??
    base.find((entry) => entry.card.phase === current)?.card.phase ??
    null;

  const segments = base.map(({ card, status }): PipelinePhaseSegment => ({
    phase: card.phase,
    steps: card.steps,
    status,
    total: card.steps.length,
    finished: card.steps.filter((step) => step.state === "done" || step.state === "skipped")
      .length,
    current: card.phase === current,
    footer:
      halt && card.phase === haltHome
        ? `${halt.label} - ${halt.reason}`
        : status.degraded
          ? status.tooltip ?? null
          : null,
  }));

  // The caption names where the run is, and it declines to name a phase in the two cases where
  // there honestly is not one. `Out of band` is this repository's own word for the second of
  // them - `PipelineLadder` heads the same pile with it - and it is the honest answer for a
  // step that was dispatched in response to something rather than walked to in sequence.
  const caption =
    run.lastStep === null
      ? "Not started"
      : lastInfo === null
        ? "Unknown step"
        : lastInfo.outOfBand
          ? "Out of band"
          : lastInfo.phase;
  // An out-of-band step has no segment to borrow a tone from, so it lends its OWN. Without
  // this a run actively remediating captioned grey, which reads as nothing happening - the
  // same class of lie as drawing a halted run as building.
  const outOfBandTone =
    lastInfo?.outOfBand && run.lastStep
      ? pipelineStepStatus(
          run.steps.find((step) => step.name === run.lastStep)?.state ?? "pending",
        ).tone
      : null;
  return {
    segments,
    caption,
    // A halted run's caption is `failed` whatever its steps say. This is the ONE place the
    // meter lets a run-level fact outrank the phase arithmetic, and it is deliberately the
    // caption rather than a segment: the caption is the run's own line, while a segment's tone
    // is `pipelinePhaseStatus`'s answer about that phase's steps and overriding it here would
    // be the second fold this module exists to prevent. Otherwise the caption borrows the tone
    // of the phase it names; a caption naming no phase - not started, or a step with no
    // placeable phase - has no status to borrow and stays neutral.
    captionTone: halt
      ? "failed"
      : segments.find((segment) => segment.current)?.status.tone ?? outOfBandTone ?? "stopped",
    halt,
    done: sequential.filter((step) => step.state === "done" || step.state === "skipped").length,
    total: sequential.length,
    extras: { unknown: strip.unknown, outOfBand: strip.outOfBand },
  };
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
    // A tuple rather than a joined string. It was joined on a LITERAL unit separator, which
    // was correct and unreadable: an invisible 0x1F byte sitting in source that `git diff`
    // and `grep` cannot show, which is the exact thing `src/shared/pipeline.ts` writes its own
    // separator as an escape to avoid. `JSON.stringify` of the pair is unambiguous without
    // putting a control character in a file people read.
    const key = JSON.stringify([gate.kickbackFrom, gate.checkedAt]);
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
