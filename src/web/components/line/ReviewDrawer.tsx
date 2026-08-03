import { Fragment, useState } from "react";
import type { Session } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import {
  workflowRunAttentionParts,
  workflowRunAttentionSplit,
  workflowRunWaitsOnOperator,
} from "@shared/workflow.ts";
import {
  groupReviewRuns,
  triageOrder,
  type ReviewGroupRow,
  type ReviewRunRow,
} from "../../lib/line-review-groups.ts";
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
 *
 * The header counts those two jobs SEPARATELY, in `workflowRunAttentionParts`' words, and it
 * is the same split the strip prints: "32 waiting on you" over a fleet whose 31 dead runs
 * owe you nothing was a number that made the whole strip worth ignoring. The predicate is
 * untouched either way - only the sentence divides.
 *
 * And past three runs stopped for ONE reason, `groupReviewRuns` folds them into a bar that
 * says it once. Every member is still here, behind the bar's caret, because the drawer's
 * standing promise is that the cap is on the panel and never on the list.
 */

function RunRow({
  run,
  sessionName,
  member = false,
  onOpenRun,
  onOpenEnsemble,
  onRemedy,
}: {
  run: WorkflowRunSummary;
  sessionName: string | null;
  /** Rendered under an expanded group bar, which indents it and tints it. Nothing else. */
  member?: boolean;
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
    // A member keeps every column it would have had standing alone, and only moves right.
    // Expanding a bar has to produce the rows the fold replaced, not a second, thinner row
    // shape a reader has to learn - the caret's promise is "these are still here".
    <li className={`line-run-row${tone}${member ? " is-member" : ""}`}>
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

/**
 * One bar for several runs that stopped for one reason.
 *
 * It answers the drawer's three questions at the grain of the pile: WHO is the count and the
 * first few titles, WHY is Phase 1's clause said once, and WHAT TO DO is one `Dismiss all`.
 * The caret is the fourth answer - "and here they all are" - which is what keeps the drawer's
 * standing promise that the cap is on the panel and never on the list.
 *
 * Exactly one row high, like every other row in this list. The drawer's three-row cap is
 * `calc(var(--line-drawer-row-h) * 3)`, so a bar of any other height stops the cap landing on
 * a row boundary and leaves half a row peeking over the edge. That is why the reason is a
 * clause and not the mockup's explanatory paragraph: the paragraph is two lines of prose
 * saying what the clause already says, and it costs the cap its arithmetic.
 */
function GroupBar({
  group,
  expanded,
  onToggle,
  onRemedy,
}: {
  group: ReviewGroupRow;
  expanded: boolean;
  onToggle: () => void;
  onRemedy: (group: ReviewGroupRow) => void;
}): React.JSX.Element {
  const count = `${group.members.length} runs`;
  // The accessible name shared by the bar's two controls, and the batch EXTENDS it rather
  // than repeating it: "Dismiss all 30 runs blocked, session gone" is what makes two bars'
  // batches tellable apart on a fleet holding two reasons. Both are safe to name explicitly
  // because neither is labelled by visible text it would then contradict - the caret has no
  // text at all, and "Dismiss all" is a prefix of its own name.
  const disclosure = `${count} blocked, ${group.clause}`;
  const names = group.names.join(" · ")
    + (group.unnamedCount > 0 ? ` · +${group.unnamedCount}` : "");
  return (
    <li className="line-group is-blocked">
      <Tooltip label={expanded
        ? `Fold these ${group.members.length} runs back into one line`
        : `List the ${group.members.length} runs that stopped because their ${group.clause}`}>
        <button
          type="button"
          className="line-group-caret"
          aria-expanded={expanded}
          aria-label={disclosure}
          onClick={onToggle}
        >
          <span aria-hidden>{expanded ? "▾" : "▸"}</span>
        </button>
      </Tooltip>
      <span className="line-group-who">
        <strong>{count} · {group.clause}</strong>
        <span className="line-run-wf">{group.workflow}</span>
      </span>
      {/* The titles, in the slot a row's chips occupy. A pile has no shared pipeline to draw -
          every member stopped at a different stage - so the useful thing to put here is WHICH
          runs these are, resolved by the same three-step rule the rows use. */}
      <span className="line-group-mid">{names}</span>
      <span className="line-group-ops">
        {group.remedy && (
          <Tooltip label={group.remedy.tooltip}>
            <button
              type="button"
              className="btn btn-remedy"
              aria-label={`${group.remedy.label} ${disclosure}`}
              onClick={() => onRemedy(group)}
            >
              {group.remedy.label}
            </button>
          </Tooltip>
        )}
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
  // The two numbers the strip prints, from the one shared split - so a drawer that marks a
  // row stalled can never sit under a strip calling the same run yours.
  const attention = workflowRunAttentionParts(workflowRunAttentionSplit(live));
  // The LIVE session's display name, and only that. The two durable fallbacks - the binding's
  // captured title, then the conversation key - are `runRowIdentity`'s, so the drawer and any
  // later surface listing the same runs cannot resolve a name two different ways.
  const named = new Map(sessions.map((session) => [session.id, session.name]));
  const rows = groupReviewRuns(
    runs,
    (run) => (run.sessionId && named.get(run.sessionId)) || null,
  );

  // One confirm and one error for the whole drawer, not one per row. Only one overlay can be
  // open at a time (the modal registers with the overlay stack, which is what makes `esc`
  // close the confirm before the drawer), and a per-row error line would break the one-height
  // rule that keeps the three-row cap honest.
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which piles are open, by phase. Phase rather than an index, so a group that grows or
  // shrinks under a live SSE feed keeps its disclosure state instead of handing it to
  // whichever pile happens to land in that position next.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  /**
   * Fire one remedy per target, and report what a PARTIAL failure actually did.
   *
   * A batch is N independent POSTs and not one transaction - there is no batch route, and
   * inventing one to make this tidier would put a second cancel path in the daemon. So the
   * honest failure report is a count: the runs that were cancelled leave over SSE, the ones
   * that refused stay in the list, and the bar above them recounts from what is still there
   * rather than claiming it cleared a pile it did not.
   */
  const post = (targets: readonly { run: WorkflowRunSummary; remedy: RunRemedy }[]): void => {
    setError(null);
    let failed = 0;
    let firstMessage = "";
    for (const { run, remedy } of targets) {
      runAction(
        run.id,
        remedy.kind,
        (requestId) => workflowRequest(remedy.path, {
          method: "POST",
          body: JSON.stringify({ requestId, ...remedy.body }),
        }).catch((caught: unknown) => {
          failed += 1;
          firstMessage ||= caught instanceof Error ? caught.message : "The action failed";
          setError(targets.length === 1
            ? firstMessage
            : `${failed} of ${targets.length} runs could not be dismissed. ${firstMessage}`);
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
    }
  };

  const ask = (
    remedy: RunRemedy,
    targets: readonly { run: WorkflowRunSummary; remedy: RunRemedy }[],
  ): void => {
    if (!remedy.confirm) {
      post(targets);
      return;
    }
    setConfirm({ ...remedy.confirm, onConfirm: () => post(targets) });
  };

  const onRemedy = (run: WorkflowRunSummary, remedy: RunRemedy): void =>
    ask(remedy, [{ run, remedy }]);

  // The batch, and it is Phase 1's `runRemedy` applied to a set rather than a second cancel:
  // every POST is the member's OWN descriptor, so a run the daemon would refuse was never in
  // the group in the first place (`groupReviewRuns` checks each member before offering this).
  const onGroupRemedy = (group: ReviewGroupRow): void => {
    if (!group.remedy) return;
    const targets = group.members.flatMap((member) => {
      const remedy = runRemedy(member.run, runRowIdentity(member.run, member.liveSessionName).name);
      return remedy ? [{ run: member.run, remedy }] : [];
    });
    ask(group.remedy, targets);
  };

  const toggle = (phase: string): void =>
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(phase)) next.add(phase);
      return next;
    });

  const runRow = (row: ReviewRunRow, member: boolean): React.JSX.Element => (
    <RunRow
      key={row.run.id}
      run={row.run}
      sessionName={row.liveSessionName}
      member={member}
      onOpenRun={() => onOpenRun(row.run.id)}
      onOpenEnsemble={onOpenEnsemble}
      onRemedy={onRemedy}
    />
  );

  return (
    <>
      <LineDrawer
        stage="review"
        count={`${live.length} run${live.length === 1 ? "" : "s"} live`}
        attention={attention.join(" · ")}
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
          // ONE flat list, bars and rows together. A nested `<ul>` per group would nest a
          // second scroll context inside the capped body and, worse, break the cap's
          // arithmetic: `.line-drawer-rows > li` is what sets the row height the three-row
          // cap is computed from, and a group's members inside a child list would not be
          // that selector's children.
          <ul className="line-drawer-rows">
            {rows.map((row) => row.kind === "run" ? runRow(row, false) : (
              <Fragment key={row.phase}>
                <GroupBar
                  group={row}
                  expanded={expanded.has(row.phase)}
                  onToggle={() => toggle(row.phase)}
                  onRemedy={onGroupRemedy}
                />
                {expanded.has(row.phase) && row.members.map((member) => runRow(member, true))}
              </Fragment>
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
