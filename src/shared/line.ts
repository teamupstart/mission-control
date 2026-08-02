/**
 * The Line: the Fleet's permanent pipeline strip.
 *
 * Six stages describing one piece of work's whole journey - where it comes from, where it
 * waits, who is doing it, who is checking it, what needs a decision, and what shipped.
 *
 * The whole fold is computed on the DAEMON and delivered as one `line_summary` event, the
 * `cost_fleet` shape exactly. That is the load-bearing decision in this file: the browser
 * already holds sessions, tasks, runs and ensembles, so a client-side fold would compile
 * and look right - and would be a SECOND answer to "how is the fleet doing", drifting from
 * the server's the moment either side learns something the other has not. It would also be
 * wrong by construction for the two stages whose inputs never reach the browser at all
 * (task-source sweep recency, the adoption ledger's shipped PRs).
 *
 * Browser-safe: no `node:` imports, no server types. Both halves import this one module.
 */

/**
 * The stages, in pipeline order.
 *
 * APPEND-ONLY once shipped. These ids key the strip's buttons, the drawers that hang off
 * them, and the palette rows that name them; renaming one silently re-points every surface
 * that stored it, and reordering re-draws the pipeline as a different claim about how work
 * flows. A seventh stage goes on the END.
 */
export const LINE_STAGES = ["intake", "backlog", "working", "review", "decide", "shipped"] as const;
export type LineStageId = (typeof LINE_STAGES)[number];

/**
 * How a stage is reading, drawn from the SAME vocabulary the session tones use
 * (`src/web/lib/format.ts`) rather than a private one.
 *
 * That is deliberate: `attention` has meant one thing across every card, badge and rail
 * mark in this app - "a person has to do something" - and a strip that spent amber on
 * "busy" would teach the eye to stop trusting it everywhere else. `exited` is absent
 * because a stage is a place, not a process: it can be empty but it never dies.
 */
export type LineTone = "neutral" | "working" | "idle" | "attention";

/** One stage's fold. */
export interface LineStageSummary {
  stage: LineStageId;
  /** The headline figure. What it counts is per-stage; the sentence says which. */
  count: number;
  /**
   * One line under the count, already worded by the daemon.
   *
   * A finished sentence rather than the parts to build one, because the alternative is a
   * template in the browser fed by fields here - which is a fold in two places again, and
   * the half that decides what is worth saying would be the half that cannot see the
   * inputs. Plain text: no markup, no ids, safe to read aloud, and it IS the button's
   * accessible description.
   */
  sentence: string;
  tone: LineTone;
}

/**
 * The whole strip.
 *
 * Deliberately carries no `updatedAt`. `FleetCost` has one and every comparison in the
 * daemon has to remember to exclude it or the change-gate never suppresses anything; here
 * there is nothing to display it on, so not having the field is strictly better than
 * having one every comparator must skip.
 */
export interface LineSummary {
  /** Every stage in `LINE_STAGES` order. The daemon always sends all of them. */
  stages: LineStageSummary[];
}

/** What each stage is called on screen. */
export const LINE_STAGE_LABELS: Record<LineStageId, string> = {
  intake: "Intake",
  backlog: "Backlog",
  working: "Working",
  review: "Review",
  decide: "Decide",
  shipped: "Shipped",
};

/**
 * One stage's fold, or null when this payload does not carry it.
 *
 * Null is reachable both ways round a version skew: an older daemon that predates a stage
 * this build draws, and (through `LINE_STAGES`) a newer one that sends a stage this build
 * has never heard of. Both render as an empty stage rather than as a crash or a hole.
 */
export function lineStage(summary: LineSummary | null, stage: LineStageId): LineStageSummary | null {
  return summary?.stages.find((s) => s.stage === stage) ?? null;
}

/**
 * The strip's own tone: the loudest thing on it.
 *
 * `attention` beats everything, because the whole point of the strip is that one glance
 * answers "does anything need me". Used for the wire between two stages and for the
 * strip's summary label.
 */
export function lineTone(stages: readonly LineStageSummary[]): LineTone {
  if (stages.some((s) => s.tone === "attention")) return "attention";
  if (stages.some((s) => s.tone === "working")) return "working";
  if (stages.some((s) => s.tone === "idle")) return "idle";
  return "neutral";
}
