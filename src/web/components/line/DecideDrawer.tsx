import type { EnsembleSummary } from "@shared/ensemble.ts";
import { ensembleIsTerminal } from "@shared/ensemble.ts";
import { fmtElapsed } from "../../ensembles/format.ts";
import { ensembleStatusLabel, ensembleStatusTone } from "../../ensembles/format.ts";
import { EnsembleProgressDots } from "../session-bits.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { LineDrawer, LineDrawerEmpty } from "./LineDrawer.tsx";

/**
 * DECIDE - the ensembles that are racing, and the ones that have stopped for an answer.
 *
 * The condensed dossier, and "condensed" is doing real work here. The full dossier
 * (`ensembles/results/`) is a per-strategy renderer over a FETCHED run detail: candidate
 * columns, judge matrices, dissent quotes, the Decide form itself. None of that is available
 * from a summary, and a drawer that fetched one detail per row would fire N bounded HTTP
 * reads on a strip click - which is both a new capability and, at three visible rows, mostly
 * wasted.
 *
 * So the row states the four facts that decide whether to open the dossier at all - what was
 * at stake, how many candidates are in, how long it has been running, and whether the answer
 * is now owed - and every one of them comes from the SSE summary the Ensembles list already
 * renders. `Decide` and `Open full dossier` both land on `#/ensembles/:id`, which is where the
 * strategy renderers and the one-shot decision live and where they stay.
 */

/** Awaiting an answer first, then anything else flagged, then newest. */
function triageOrder(summaries: readonly EnsembleSummary[]): EnsembleSummary[] {
  const rank = (run: EnsembleSummary): number =>
    run.status === "awaiting_decision" ? 0 : run.attention ? 1 : 2;
  return summaries
    .filter((run) => run.status == null || !ensembleIsTerminal(run.status))
    .slice()
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}

/**
 * What this run wants next, in the operator's terms rather than the engine's.
 *
 * The status chip beside it already prints the engine's word (`Awaiting decision`,
 * `Evaluating`). This says what that means for the person reading, which is the difference
 * between a list and a triage row.
 */
function nextMove(run: EnsembleSummary): string {
  if (run.unreadable) return "this build cannot read the stored run - cancel or delete it";
  if (run.status === "awaiting_decision") return "waiting for your decision";
  if (run.membersNeedingInput > 0) {
    return `${run.membersNeedingInput} candidate${run.membersNeedingInput === 1 ? "" : "s"} need you`;
  }
  if (run.membersOut > 0 && run.membersReady === 0) return `${run.membersOut} out, none in yet`;
  return `${run.membersReady}/${run.maxMembers} candidates in`;
}

function EnsembleRow({
  run,
  now,
  onOpen,
}: {
  run: EnsembleSummary;
  now: number;
  onOpen: () => void;
}): React.JSX.Element {
  const deciding = run.status === "awaiting_decision";
  return (
    <li className={`line-ens-row${run.attention ? " is-waiting" : ""}`}>
      <span className="line-ens-who">
        <strong>{run.title}</strong>
        <span className="line-ens-strategy">
          {run.strategyLabel} · {fmtElapsed(run.createdAt, run.completedAt ?? now)} elapsed
        </span>
      </span>
      <span className="line-ens-progress">
        <EnsembleProgressDots summary={run} />
        <span className={`workflow-chip ensemble-tone-${ensembleStatusTone(run.status, run.unreadable)}`}>
          {ensembleStatusLabel(run)}
        </span>
      </span>
      <span className="line-ens-state">{nextMove(run)}</span>
      <span className="line-ens-ops">
        {/* One button, two words, and which word it wears is the whole escalation: a run
            awaiting an answer says Decide, everything else says the reading verb. Both open
            the same page - a second control that opened the same place would imply two
            destinations. */}
        <Tooltip
          label={deciding
            ? `Open ${run.title} and record the decision - candidates, scores, and dissent`
            : `Open ${run.title}'s dossier - candidates, evidence, and judge rankings`}
        >
          <button
            type="button"
            className={deciding ? "btn" : "btn btn-ghost"}
            onClick={onOpen}
          >
            {deciding ? "Decide" : "Open full dossier"}
          </button>
        </Tooltip>
      </span>
    </li>
  );
}

export function DecideDrawer({
  summaries,
  attentionCount,
  now,
  onClose,
  onOpenEnsemble,
  onOpenAllEnsembles,
}: {
  summaries: readonly EnsembleSummary[];
  /** The daemon's own count, passed down rather than re-folded here. */
  attentionCount: number;
  /** Injected so elapsed is a pure function of props - see the render tests. */
  now: number;
  onClose: () => void;
  onOpenEnsemble: (id: string) => void;
  onOpenAllEnsembles: () => void;
}): React.JSX.Element {
  const live = triageOrder(summaries);
  const deciding = live.filter((run) => run.status === "awaiting_decision").length;

  return (
    <LineDrawer
      stage="decide"
      count={`${live.length} ensemble${live.length === 1 ? "" : "s"} live`}
      attention={deciding > 0
        ? `${deciding} waiting on you`
        : attentionCount > 0
          ? `${attentionCount} need${attentionCount === 1 ? "s" : ""} a look`
          : ""}
      onClose={onClose}
      actions={(
        <Tooltip label="Open the ensembles page - every run, its evidence, and its decisions">
          <button type="button" className="btn btn-ghost" onClick={onOpenAllEnsembles}>
            All ensembles <span aria-hidden>→</span>
          </button>
        </Tooltip>
      )}
    >
      {live.length === 0 ? (
        <LineDrawerEmpty>
          No ensembles are running. Start one from Dispatch, in Ensemble mode.
        </LineDrawerEmpty>
      ) : (
        <ul className="line-drawer-rows">
          {live.map((run) => (
            <EnsembleRow
              key={run.id}
              run={run}
              now={now}
              onOpen={() => onOpenEnsemble(run.id)}
            />
          ))}
        </ul>
      )}
    </LineDrawer>
  );
}
