import {
  PIPELINE_STEPS,
  sortPipelineSteps,
  type PipelineRun,
  type PipelineRunGroup,
  type PipelineStep,
} from "@shared/pipeline.ts";

import type { ConductStateReading, DaemonReading, HaltReading } from "./state.ts";

// Fold one worktree's files - plus whatever its event ledger has added since the last pass
// - into the one `PipelineRun` the dashboard reads.
//
// A pure function over stated evidence, with no I/O of its own. That is what makes the
// grouping rule testable at all: every input below is something a caller has already read,
// so the whole classification can be exercised against literals rather than against a
// directory somebody had to build.

/** Everything one fold is handed. */
export interface NormalizeInput {
  repoRoot: string;
  slug: string;
  /** Absolute path of the feature's worktree. */
  worktree: string;
  state: ConductStateReading;
  halt: HaltReading | null;
  done: boolean;
  daemon: DaemonReading;
  /** Tokens the event ledger has attributed to this run so far, or null for none seen. */
  costTokens: number | null;
  now: number;
}

/**
 * Which bucket a run sits in.
 *
 * Ordered by what OVERRIDES what, and each rung is a deliberate answer:
 *
 *  1. `parked` first, because it is the operator's own act. A parked run that also halted
 *     is still parked - they set it aside knowing, and a rail that re-surfaced it under
 *     `halted` would be arguing with them.
 *  2. `halted`, because a halt is the state that wants a human, and it outranks every
 *     inference below it. A run with a HALT marker AND an in-progress step halted DURING
 *     that step; drawing it as `building` would say work is happening that stopped.
 *  3. `processed` - the engine converged, marked the feature complete, or the daemon
 *     recorded it shipped. Below `halted` on purpose: a run that finished and then had a
 *     land-time gate refuse is not finished.
 *  4. `building` - some step is actually running.
 *  5. `waiting` - nothing is running and nothing WILL be: the daemon is paused, or there
 *     is no live daemon in this repository to advance it.
 *  6. `eligible` - nothing is running and something could start.
 *
 * The distinction between the last two is the one an operator acts on. Both look identical
 * from the state file; only `.daemon/` tells them apart, which is why the daemon reading is
 * an input here rather than a decoration on the panel.
 */
export function classifyGroup(input: NormalizeInput): PipelineRunGroup {
  const { state, halt, done, daemon, slug } = input;
  if (daemon.parked.has(slug)) return "parked";
  if (halt !== null) return "halted";
  if (done || state.complete || daemon.processed.has(slug)) return "processed";
  // An `in_progress` step is only evidence of live work when something is alive to be
  // doing it. With no engine daemon in this repository the marker is a leftover from one
  // that crashed or was killed mid-step, and nothing will ever advance it - so it reads as
  // `waiting`, which is the state that sends an operator to start their daemon rather than
  // to wait out a step that is not running.
  //
  // A PAUSED daemon is deliberately not the same case. The engine honours a pause between
  // steps, so a step already in flight when the marker landed really is still running, and
  // calling it `waiting` would be the same lie in the other direction.
  if (daemon.pid !== null) {
    for (const status of state.steps.values()) {
      if (status === "in_progress") return "building";
    }
  }
  if (daemon.paused || daemon.pid === null) return "waiting";
  return "eligible";
}

/**
 * The run's steps, in the order they will be drawn.
 *
 * Every step the state file mentions, plus every step this build knows about that the file
 * does not - the second half is what makes a run that has reached `build` still draw the
 * six SHIP steps ahead of it as pending, rather than as a strip that grows a box at a time.
 *
 * A step the file mentions and this build does not know is CARRIED, and `sortPipelineSteps`
 * puts it after every known one. That is the whole tolerance rule: a conductor release that
 * adds a step degrades this display to an unlabelled chip in the right state, never to a
 * page that refuses to draw.
 */
export function foldSteps(state: ConductStateReading): PipelineStep[] {
  const steps: PipelineStep[] = [];
  const seen = new Set<string>();
  for (const info of PIPELINE_STEPS["ai-conductor"]) {
    // Out-of-band steps have no ordered slot, so they appear only when the run actually
    // ran one. Drawing `remediate` as a pending box on every healthy run would promise a
    // step that is only ever dispatched in response to a failure.
    if (info.outOfBand && !state.steps.has(info.name)) continue;
    steps.push({ name: info.name, state: state.steps.get(info.name) ?? "pending" });
    seen.add(info.name);
  }
  for (const [name, status] of state.steps) {
    if (seen.has(name)) continue;
    steps.push({ name, state: status });
  }
  return sortPipelineSteps("ai-conductor", steps);
}

/** Fold one worktree's evidence into the projection. */
export function normalizeConductorRun(input: NormalizeInput): PipelineRun {
  const { state, daemon, slug } = input;
  return {
    provider: "ai-conductor",
    repoRoot: input.repoRoot,
    slug,
    worktree: input.worktree,
    tier: state.tier,
    track: state.track,
    steps: foldSteps(state),
    lastStep: state.lastStep,
    halt: input.halt === null ? null : { class: input.halt.class, reason: input.halt.reason },
    group: classifyGroup(input),
    // The state file first, because the engine writes it as soon as `finish` mints one.
    // The daemon's shipped record is the fallback for a run whose worktree was already
    // torn down past the point the state file described.
    prUrl: state.prUrl ?? daemon.processed.get(slug)?.prUrl ?? null,
    costTokens: input.costTokens,
    updatedAt: input.now,
  };
}
