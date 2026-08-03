import { Fragment, useState } from "react";
import type { Session } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { workflowRunIsOpen, workflowRunWaitsOnOperator } from "@shared/workflow.ts";
import {
  runRemedy,
  runRowIdentity,
  runTriageRound,
  runTriageSentence,
  runTriageSteps,
  type RunRemedy,
} from "../../workflows/run-model.ts";
import { runActionTooltip } from "../../workflows/run-actions.ts";
import { runAction, useRunActions } from "../../workflows/run-action-store.ts";
import { workflowRequest } from "../../workflows/workflowApi.ts";
import {
  WorkflowConfirmModal,
  type WorkflowConfirmRequest,
} from "../../workflows/WorkflowConfirmModal.tsx";
import { PipelineStatusChip } from "../../workflows/pipeline-bits.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { LineDrawer, LineDrawerEmpty } from "./LineDrawer.tsx";

/**
 * REVIEW - every workflow run still in flight, one ladder per row.
 *
 * A projection of `WorkflowRunSummary`, which is what SSE already delivers for the whole
 * fleet, drawn with the chips the run reader draws (`PipelineStatusChip`) from the rules the
 * run reader uses (`run-model.ts`).
 *
 * THE RULE: no fetch and no run detail. Actions only where the summary alone proves the run
 * is stopped and the route needs no argument beyond the run id.
 *
 * The first half is unchanged and load-bearing - a drawer that fetched a detail per row would
 * put N bounded HTTP reads behind one click on a strip, and every fact on a row comes off the
 * summary the browser already holds. The second half REPLACED a flat "and no action", which
 * was written when every row was a live run making progress and the honest answer to "what do
 * I do about this" was "read it on the run page". It does not survive thirty rows of runs
 * whose sessions were removed: a triage surface that can only describe a dead run is not
 * triage. So a parked run gets the one argument-free move its state actually takes -
 * `runRemedy` decides which, and refuses where the daemon would.
 *
 * Still out, and out for the same reason as before: `Reattach` needs a session id, `Resolve
 * delivery` needs a delivery id and a choice, and disabling a reviewer needs a node id. Each
 * of those is a picker or a form, none of them fits a 58px row, and all three stay on the run
 * page one click away through "Open run".
 *
 * The row's job is to answer "which of these is stuck, is it stuck on me, and what moves it".
 * So amber marks the rows genuinely waiting on a person and RED marks the ones that have
 * stopped: `workflowRunWaitsOnOperator` counts both - it is the predicate the strip's Review
 * fold uses - but "your turn" and "this will never move again" are two different jobs and one
 * colour for both is what made the drawer unreadable.
 */

/** A parked run before a live one, and the rows that want a person before either. */
function triageRank(run: WorkflowRunSummary): number {
  // Deliberately not `workflowRunWaitsOnOperator` alone, which is true of both tiers. The
  // predicate itself is untouched - the strip, this drawer's count and the command palette
  // all still read it - this only decides which of the two stopped kinds sorts first.
  if (workflowRunWaitsOnOperator(run) && run.status !== "blocked") return 2;
  if (run.status === "blocked") return 1;
  return 0;
}

/** Newest first, and the rows that want a person first of all. */
function triageOrder(runs: readonly WorkflowRunSummary[]): WorkflowRunSummary[] {
  return runs
    .filter((run) => workflowRunIsOpen(run.status))
    .slice()
    .sort((a, b) => triageRank(b) - triageRank(a) || b.updatedAt - a.updatedAt);
}

function RunRow({
  run,
  sessionName,
  onOpenRun,
  onOpenEnsemble,
  onRemedy,
}: {
  run: WorkflowRunSummary;
  sessionName: string | null;
  onOpenRun: () => void;
  onOpenEnsemble: ((ensembleId: string) => void) | null;
  onRemedy: (run: WorkflowRunSummary, remedy: RunRemedy) => void;
}): React.JSX.Element {
  const steps = runTriageSteps(run);
  const blocked = run.status === "blocked";
  const waiting = !blocked && workflowRunWaitsOnOperator(run);
  const source = run.externalSource ?? null;
  const identity = runRowIdentity(run, sessionName);
  const remedy = runRemedy(run, identity.name);
  // One subscription per row rather than the bare module functions, because pending is state
  // the drawer has to RE-RENDER on: the POST settles on its own schedule and nothing else
  // would tell this row its button is busy. `useRunActions` also registers this row as a
  // refresh surface, which costs nothing here - the run list arrives over SSE, so there is
  // genuinely nothing to refetch.
  const actions = useRunActions(run.id, () => {});
  const pending = remedy ? actions.isPending(remedy.kind) : false;
  // Through the run page's own helper, so "this action is already running" is written once.
  const remedyTooltip = remedy
    ? runActionTooltip(
        { id: remedy.kind, label: remedy.label, tooltip: remedy.tooltip, disabled: pending },
        pending,
      )
    : "";
  const tone = blocked ? " is-blocked" : waiting ? " is-waiting" : "";
  return (
    <li className={`line-run-row${tone}`}>
      <span className="line-run-who">
        {/* Bold for a name, dim mono for an id. The conversation key is the LAST fallback and
            it is not a title: printing a GUID where a title goes is the defect this row was
            rebuilt around, and drawing it as one would hide that it is still happening. */}
        {identity.isIdentifier
          ? <span className="line-run-id">{identity.name}</span>
          : <strong>{identity.name}</strong>}
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
      <span className={`line-run-state${tone}`}>{runTriageSentence(run)}</span>
      <span className="line-run-ops">
        {remedy && (
          <Tooltip label={remedyTooltip}>
            <button
              type="button"
              className="btn btn-remedy"
              disabled={pending}
              onClick={() => onRemedy(run, remedy)}
            >
              {remedy.label}
            </button>
          </Tooltip>
        )}
        {/* Demoted to the secondary slot where there is a remedy, because "read the whole
            run" is the slower answer once a faster correct one exists on the row. */}
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
  // The LIVE session's display name, and only that. The two durable fallbacks - the binding's
  // captured title, then the conversation key - are `runRowIdentity`'s, so the drawer and any
  // later surface listing the same runs cannot resolve a name two different ways.
  const named = new Map(sessions.map((session) => [session.id, session.name]));

  // One confirm and one error for the whole drawer, not one per row. Only one overlay can be
  // open at a time (the modal registers with the overlay stack, which is what makes `esc`
  // close the confirm before the drawer), and a per-row error line would break the one-height
  // rule that keeps the three-row cap honest.
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const post = (run: WorkflowRunSummary, remedy: RunRemedy): void => {
    setError(null);
    runAction(
      run.id,
      remedy.kind,
      (requestId) => workflowRequest(remedy.path, {
        method: "POST",
        body: JSON.stringify({ requestId, ...remedy.body }),
      }).catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "The action failed");
        // Rethrown rather than swallowed: the action store keeps the request id across a
        // FAILED response and drops it only on success, which is what makes a second press
        // replay the same intent instead of filing a new one.
        throw caught;
      }),
      // No refetch. `workflowRuns` arrives over SSE, so the row this action changed is
      // rewritten by the daemon's own publish - and the drawer is conditionally mounted, so
      // an action that settles after it closes has nothing here to refresh anyway.
      () => {},
    );
  };

  const onRemedy = (run: WorkflowRunSummary, remedy: RunRemedy): void => {
    if (!remedy.confirm) {
      post(run, remedy);
      return;
    }
    setConfirm({ ...remedy.confirm, onConfirm: () => post(run, remedy) });
  };

  return (
    <>
      <LineDrawer
        stage="review"
        count={`${live.length} run${live.length === 1 ? "" : "s"} live`}
        attention={waiting > 0 ? `${waiting} waiting on you` : ""}
        onClose={onClose}
        notice={error ? <p className="line-drawer-alert" role="alert">{error}</p> : null}
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
                sessionName={(run.sessionId && named.get(run.sessionId)) || null}
                onOpenRun={() => onOpenRun(run.id)}
                onOpenEnsemble={onOpenEnsemble}
                onRemedy={onRemedy}
              />
            ))}
          </ul>
        )}
      </LineDrawer>
      {confirm && (
        <WorkflowConfirmModal request={confirm} onClose={() => setConfirm(null)} />
      )}
    </>
  );
}
