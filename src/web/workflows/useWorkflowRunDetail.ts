import { useEffect, useState } from "react";
import type {
  WorkflowRunDetail,
  WorkflowRunId,
} from "@shared/workflow.ts";
import { workflowRunLoadError } from "./run-model.ts";
import { workflowRequest } from "./workflowApi.ts";

export type WorkflowRunDetailState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; detail: WorkflowRunDetail };

const LOADING: WorkflowRunDetailState = { state: "loading" };

interface StoredDetailState {
  runId: WorkflowRunId;
  updatedAt: number;
  value: WorkflowRunDetailState;
}

/**
 * The one client path to a workflow run's detail, shared by the detail pane and Board preview.
 *
 * `updatedAt` is the compact SSE summary's refresh signal. The superseded guard is equally
 * important on a session switch: a slower response for the session just left must not redraw
 * its workflow under the session that replaced it.
 */
export function useWorkflowRunDetail(
  runId: WorkflowRunId | null,
  updatedAt: number,
): WorkflowRunDetailState {
  const [stored, setStored] = useState<StoredDetailState | null>(null);

  useEffect(() => {
    if (runId === null) return;
    let superseded = false;

    setStored({ runId, updatedAt, value: LOADING });
    void workflowRequest<WorkflowRunDetail>(
      `/api/workflow-runs/${encodeURIComponent(runId)}`,
    )
      .then((detail) => {
        if (superseded) return;
        setStored({ runId, updatedAt, value: { state: "ready", detail } });
      })
      .catch((caught) => {
        if (superseded) return;
        setStored({
          runId,
          updatedAt,
          value: { state: "error", message: workflowRunLoadError(caught) },
        });
      });

    return () => {
      superseded = true;
    };
  }, [runId, updatedAt]);

  if (
    runId === null
    || stored === null
    || stored.runId !== runId
    || stored.updatedAt !== updatedAt
  ) return LOADING;
  return stored.value;
}
