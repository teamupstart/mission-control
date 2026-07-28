import { useEffect, useRef, useState } from "react";
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
 * `updatedAt` is the compact SSE summary's refresh signal. The generation guard is equally
 * important on a session switch: a slower response for the session just left must not redraw
 * its workflow under the session that replaced it.
 */
export function useWorkflowRunDetail(
  runId: WorkflowRunId | null,
  updatedAt: number,
): WorkflowRunDetailState {
  const generation = useRef(0);
  const [stored, setStored] = useState<StoredDetailState | null>(null);

  useEffect(() => {
    const current = ++generation.current;
    if (runId === null) return;

    setStored({ runId, updatedAt, value: LOADING });
    void workflowRequest<WorkflowRunDetail>(
      `/api/workflow-runs/${encodeURIComponent(runId)}`,
    )
      .then((detail) => {
        if (generation.current !== current) return;
        setStored({ runId, updatedAt, value: { state: "ready", detail } });
      })
      .catch((caught) => {
        if (generation.current !== current) return;
        setStored({
          runId,
          updatedAt,
          value: { state: "error", message: workflowRunLoadError(caught) },
        });
      });

    return () => {
      if (generation.current === current) generation.current++;
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
