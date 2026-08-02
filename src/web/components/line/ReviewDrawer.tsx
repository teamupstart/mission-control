import { Fragment } from "react";
import type { Session } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { workflowRunIsOpen, workflowRunWaitsOnOperator } from "@shared/workflow.ts";
import {
  runTriageRound,
  runTriageSentence,
  runTriageSteps,
} from "../../workflows/run-model.ts";
import { PipelineStatusChip } from "../../workflows/pipeline-bits.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { LineDrawer, LineDrawerEmpty } from "./LineDrawer.tsx";

/**
 * REVIEW - every workflow run still in flight, one ladder per row.
 *
 * A projection of `WorkflowRunSummary`, which is what SSE already delivers for the whole
 * fleet, drawn with the chips the run reader draws (`PipelineStatusChip`) from the rules the
 * run reader uses (`run-model.ts`). No fetch, no run detail, and no action: everything that
 * CHANGES a run - resolving a delivery, rechecking Inspector, disabling a reviewer, resetting
 * a round - stays on the run page, one click away through "Open run".
 *
 * The row's job is to answer "which of these is stuck, and is it stuck on me". So the amber
 * mark is `workflowRunWaitsOnOperator`, the same predicate the strip's Review fold counts for
 * "N waiting on you" - the drawer is that number, expanded.
 */

/** Newest first, and the rows that want a person first of all. */
function triageOrder(runs: readonly WorkflowRunSummary[]): WorkflowRunSummary[] {
  return runs
    .filter((run) => workflowRunIsOpen(run.status))
    .slice()
    .sort((a, b) =>
      Number(workflowRunWaitsOnOperator(b)) - Number(workflowRunWaitsOnOperator(a))
      || b.updatedAt - a.updatedAt);
}

function RunRow({
  run,
  sessionName,
  onOpenRun,
  onOpenEnsemble,
}: {
  run: WorkflowRunSummary;
  sessionName: string;
  onOpenRun: () => void;
  onOpenEnsemble: ((ensembleId: string) => void) | null;
}): React.JSX.Element {
  const steps = runTriageSteps(run);
  const waiting = workflowRunWaitsOnOperator(run);
  const source = run.externalSource ?? null;
  return (
    <li className={`line-run-row${waiting ? " is-waiting" : ""}`}>
      <span className="line-run-who">
        <strong>{sessionName}</strong>
        <span className="line-run-wf">
          {/* Provenance leads the line when there is any, because "this run is not one you
              started" changes how every other fact on the row reads - nobody is going to
              wonder why an ensemble handoff has no session they remember dispatching. */}
          {source && (
            onOpenEnsemble ? (
              <Tooltip label="Open the ensemble run that started this workflow">
                <button
                  type="button"
                  className="line-run-prov"
                  onClick={() => onOpenEnsemble(source.sourceId)}
                >
                  <span aria-hidden>⧉</span> from an ensemble
                </button>
              </Tooltip>
            ) : (
              <span className="line-run-prov"><span aria-hidden>⧉</span> from an ensemble</span>
            )
          )}
          {run.workflowName} v{run.workflowVersion} · {runTriageRound(run)}
        </span>
      </span>
      <span className="line-run-chips">
        {steps.map((step, i) => (
          <Fragment key={step.key}>
            {i > 0 && <span className="line-run-chip-sep" aria-hidden>→</span>}
            <PipelineStatusChip status={step.status} />
          </Fragment>
        ))}
      </span>
      <span className="line-run-state">{runTriageSentence(run)}</span>
      <span className="line-run-ops">
        <Tooltip label={`Open this ${run.workflowName} run - verdicts, deliveries, timeline`}>
          <button type="button" className="btn btn-ghost" onClick={onOpenRun}>
            Open run
          </button>
        </Tooltip>
      </span>
    </li>
  );
}

export function ReviewDrawer({
  runs,
  sessions,
  onClose,
  onOpenRun,
  onOpenAllRuns,
  onBindWorkflow,
  onOpenEnsemble,
}: {
  runs: readonly WorkflowRunSummary[];
  sessions: readonly Session[];
  onClose: () => void;
  onOpenRun: (runId: string) => void;
  onOpenAllRuns: () => void;
  onBindWorkflow: () => void;
  onOpenEnsemble: (ensembleId: string) => void;
}): React.JSX.Element {
  const live = triageOrder(runs);
  const waiting = live.filter(workflowRunWaitsOnOperator).length;
  // The live session's display name, falling back to the binding's conversation key. The
  // fallback is not a degraded case: a run outlives the session it reviewed, and `noteKey` is
  // the durable identity the run page itself shows for exactly that reason.
  const named = new Map(sessions.map((session) => [session.id, session.name]));

  return (
    <LineDrawer
      stage="review"
      count={`${live.length} run${live.length === 1 ? "" : "s"} live`}
      attention={waiting > 0 ? `${waiting} waiting on you` : ""}
      onClose={onClose}
      actions={(
        <>
          <Tooltip label="Bind a workflow to a session, so its work gets reviewed">
            <button type="button" className="btn btn-ghost" onClick={onBindWorkflow}>
              Bind a workflow…
            </button>
          </Tooltip>
          <Tooltip label="Open the runs page - history, filters, and every run's full reader">
            <button type="button" className="btn btn-ghost" onClick={onOpenAllRuns}>
              All runs <span aria-hidden>→</span>
            </button>
          </Tooltip>
        </>
      )}
    >
      {live.length === 0 ? (
        <LineDrawerEmpty>
          No workflow runs are in flight. Bind a workflow to a session and its next submission
          starts one.
        </LineDrawerEmpty>
      ) : (
        <ul className="line-drawer-rows">
          {live.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              sessionName={(run.sessionId && named.get(run.sessionId)) || run.noteKey}
              onOpenRun={() => onOpenRun(run.id)}
              onOpenEnsemble={onOpenEnsemble}
            />
          ))}
        </ul>
      )}
    </LineDrawer>
  );
}
