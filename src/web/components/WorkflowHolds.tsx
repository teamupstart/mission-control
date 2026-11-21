import type { SessionBlocker } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { WORKFLOW_HOLD_DETAILS_FLAG_ID } from "@shared/feature-flag-registry.ts";
import { useFeatureFlag } from "../useFeatureFlag.ts";
import { workflowHold } from "../lib/workflow-hold.ts";
import { Tooltip } from "./Tooltip.tsx";

/** Always visible state, independent of optional workflow decoration and session blockers. */
export function WorkflowHolds({ runs, blocker }: { runs: readonly WorkflowRunSummary[] | null; blocker?: SessionBlocker | null }): React.JSX.Element | null {
  const enabled = useFeatureFlag(WORKFLOW_HOLD_DETAILS_FLAG_ID);
  if (!enabled) return null;
  const holds = (runs ?? []).flatMap(run => {
    const hold = workflowHold(run, blocker);
    return hold ? [{ run, hold }] : [];
  });
  if (!holds.length) return null;
  return <div className="workflow-holds" aria-label="Workflow holds">
    {holds.map(({ run, hold }) => <Tooltip
      key={run.id}
      label={run.deliveryHold ? "Open the workflow run holding this session" : "Open this workflow run"}
    ><a
      className={`workflow-hold ${hold.inProgress ? "is-progress" : "is-waiting"}`}
      href={`#/runs/${encodeURIComponent(hold.runId)}`}
      onClick={event => event.stopPropagation()}
    >
      <span className="workflow-hold-owner">{run.workflowName}{runs && runs.length > 1 && run.repoRoot
        ? ` · ${run.repoRoot.split(/[\\/]/).filter(Boolean).at(-1)}` : ""}</span>
      <span>{hold.reason}</span>
      <strong>{hold.inProgress ? "In progress" : hold.actor === "Operator" ? "Action needed" : "Waiting"} · {hold.actorLabel ?? hold.actor}</strong>
      <span>{run.deliveryHold ? "Open owning run" : "Open run"} ↗</span>
    </a></Tooltip>)}
  </div>;
}
