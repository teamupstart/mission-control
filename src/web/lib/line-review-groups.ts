import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { workflowRunIsOpen, workflowRunWaitsOnOperator } from "@shared/workflow.ts";
import {
  blockedPhaseClause,
  runRemedy,
  runRowIdentity,
  type RunRemedy,
} from "../workflows/run-model.ts";

/**
 * The Review drawer's rows, after runs that stopped for the SAME reason are folded together.
 *
 * Pure - no React, no fetch, no clock. Everything it reads is on the `WorkflowRunSummary`
 * the browser already holds over SSE, plus the live session names the drawer resolves, so
 * grouping adds nothing to the wire and this file is a table of fixtures rather than a
 * rendering test.
 *
 * The problem it exists for: thirty-one rows, every one of them reading `Blocked · session
 * gone`, with a `Dismiss` on each. Repeating one sentence thirty-one times is not thirty-one
 * facts, and the scroll it costs is the reader's whole budget for the surface. One bar says
 * the reason once, counts it once, and offers one control for the batch.
 *
 * What is deliberately NOT folded:
 *
 *  - **Anything that is not blocked.** A live run is making progress and its chips are the
 *    point of the row; a run parked on YOUR answer is the one row you came here for. Folding
 *    either would hide the thing the drawer is for behind a caret.
 *  - **Fewer than three sharing a reason.** See `REVIEW_GROUP_MIN`.
 */

/**
 * How many runs have to share a reason before they become a bar. The submitted decision.
 *
 * A pair is not a pile. Folding two rows saves ONE line and costs the reader both rows'
 * chips, both round counters and both remedies - so at two the bar is strictly worse than
 * what it replaces. Three is where the repetition starts reading as noise.
 */
export const REVIEW_GROUP_MIN = 3;

/** How many member titles a bar names before it counts the rest. */
const NAMED_MEMBERS = 3;

/** One run, with the name the row resolved for it - the fold never re-derives identity. */
export interface ReviewRunRow {
  kind: "run";
  run: WorkflowRunSummary;
  /** The LIVE session's display name, or null. `runRowIdentity` owns the fallbacks. */
  liveSessionName: string | null;
}

/** Several blocked runs that stopped for one reason, drawn as one bar. */
export interface ReviewGroupRow {
  kind: "group";
  /** The shared `phase`, which is both the fold key and React's key. */
  phase: string;
  /** Phase 1's clause for that phase - "session gone". Never re-worded here. */
  clause: string;
  members: ReviewRunRow[];
  /**
   * The first few member titles, resolved through the same three-step rule the rows use, so
   * a bar can never list GUIDs where its rows would have listed names.
   */
  names: string[];
  /** Members beyond `names`, for the bar's "+27". Zero when every member is named. */
  unnamedCount: number;
  /**
   * `{workflowName} v{version}` when every member shares one, else how many workflows are in
   * here. A bar claiming one workflow's name over a mixed pile would be the fold lying about
   * what it folded.
   */
  workflow: string;
  /**
   * The one control for the batch, or null.
   *
   * ONLY `dismiss`, and only when every member offers it. That is the remedy whose entire
   * purpose is clearing a pile - and it is Phase 1's `runRemedy`, applied to a set rather
   * than re-derived, so there is exactly one cancel path in this drawer. The others stay
   * per-row on purpose: `Restart…` demands a typed phrase each time (batching it would
   * launder thirty deliberate acts into one), and `Retry` is cheap enough per row that a
   * batch button would only be a way to fire thirty provider calls by accident.
   */
  remedy: RunRemedy | null;
}

export type ReviewRow = ReviewRunRow | ReviewGroupRow;

/**
 * A parked run before a live one, and the rows that want a person before either.
 *
 * Deliberately not `workflowRunWaitsOnOperator` alone, which is true of both stopped tiers.
 * The predicate itself is untouched - the strip, the drawer's count and the command palette
 * all still read it - this only decides which of the two sorts first.
 */
function triageRank(run: WorkflowRunSummary): number {
  if (workflowRunWaitsOnOperator(run) && run.status !== "blocked") return 2;
  if (run.status === "blocked") return 1;
  return 0;
}

/** Newest first, and the rows that want a person first of all. */
export function triageOrder(runs: readonly WorkflowRunSummary[]): WorkflowRunSummary[] {
  return runs
    .filter((run) => workflowRunIsOpen(run.status))
    .slice()
    .sort((a, b) => triageRank(b) - triageRank(a) || b.updatedAt - a.updatedAt);
}

/**
 * Live runs in, drawer rows out.
 *
 * ORDERING is `triageOrder`'s, unchanged, and a group takes the position of its NEWEST
 * member. That is the one placement that leaves the surface reading the same before and
 * after the fold: a bar stands exactly where its most recent row stood, so the pile does not
 * jump to the top of a drawer whose whole promise is "what wants me, then what is recent".
 * It also keeps two groups ordered against each other by the same recency rule as two rows,
 * which is the only rule a reader has been given.
 *
 * `liveSessionName` is the drawer's live-session lookup, passed in rather than reached for:
 * this module has no session list and must not grow one, or the name a bar prints could
 * differ from the name the row under it prints.
 */
export function groupReviewRuns(
  runs: readonly WorkflowRunSummary[],
  liveSessionName: (run: WorkflowRunSummary) => string | null,
): ReviewRow[] {
  const ordered = triageOrder(runs);
  const row = (run: WorkflowRunSummary): ReviewRunRow => ({
    kind: "run",
    run,
    liveSessionName: liveSessionName(run),
  });

  // Which phases have enough blocked runs to be worth a bar. Counted over the whole list
  // first, because the decision is about the PILE and cannot be made one row at a time.
  const blockedByPhase = new Map<string, WorkflowRunSummary[]>();
  for (const run of ordered) {
    if (run.status !== "blocked") continue;
    const seen = blockedByPhase.get(run.phase);
    if (seen) seen.push(run);
    else blockedByPhase.set(run.phase, [run]);
  }

  const emitted = new Set<string>();
  const rows: ReviewRow[] = [];
  for (const run of ordered) {
    const pile = run.status === "blocked" ? blockedByPhase.get(run.phase) ?? [] : [];
    if (pile.length < REVIEW_GROUP_MIN) {
      rows.push(row(run));
      continue;
    }
    // `ordered` is newest-first within the blocked band, so the first member reached IS the
    // newest one - the bar lands there and the rest are folded into it.
    if (emitted.has(run.phase)) continue;
    emitted.add(run.phase);
    rows.push(groupOf(run.phase, pile.map(row)));
  }
  return rows;
}

function groupOf(phase: string, members: ReviewRunRow[]): ReviewGroupRow {
  const names = members
    .slice(0, NAMED_MEMBERS)
    .map((member) => runRowIdentity(member.run, member.liveSessionName).name);
  const workflows = new Set(
    members.map((member) => `${member.run.workflowName} v${member.run.workflowVersion}`),
  );
  // Every member, not just the first: `runRemedy` guards on more than the phase, and a batch
  // control that acted on runs the daemon would refuse is a button that reports a lie.
  const remedies = members.map((member) =>
    runRemedy(member.run, runRowIdentity(member.run, member.liveSessionName).name));
  const clause = blockedPhaseClause(phase);
  const dismissable = remedies.every((remedy) => remedy?.kind === "dismiss");
  return {
    kind: "group",
    phase,
    clause,
    members,
    names,
    unnamedCount: Math.max(0, members.length - names.length),
    workflow: workflows.size === 1 ? [...workflows][0]! : `${workflows.size} workflows`,
    remedy: dismissable ? batchDismiss(remedies[0]!, clause, members.length) : null,
  };
}

/**
 * The batch's descriptor: one member's remedy, re-worded for the set.
 *
 * `path` and `body` are the first member's and are never posted as they stand - the drawer
 * walks the members and posts each one's OWN remedy, so no route ever receives a run id that
 * is not its own. What a batch can genuinely share is the label, the tooltip and the
 * confirmation, and that is all this rewrites.
 *
 * The count is echoed in the confirmation because this control can end thirty runs from a
 * panel one keystroke off the strip - the same demand `DELETE /api/ensembles/:id` makes with
 * its `confirmId`.
 */
function batchDismiss(member: RunRemedy, clause: string, count: number): RunRemedy {
  return {
    ...member,
    label: "Dismiss all",
    tooltip: `Stop all ${count} of these runs - none of them will resume`,
    confirm: {
      title: `Cancel ${count} runs`,
      body: `${count} runs stopped for the same reason: ${clause}.`
        + " Stopping them all means none of them will resume, and their evidence and"
        + " verdicts stay in history.",
      confirmLabel: `Cancel ${count} runs`,
      confirmHint: `Stops all ${count} runs for good`,
      danger: true,
    },
  };
}
