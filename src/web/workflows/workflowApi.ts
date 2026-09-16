import { beginOperation } from "../lib/operation-context.ts";
import { parseMissionRoute } from "./useWorkflowRoute.ts";
import type { TelemetryOperationSurface } from "@shared/telemetry-ingress.ts";

function workflowOperationSurface(): TelemetryOperationSurface {
  if (typeof window === "undefined") return "unknown";
  const { page } = parseMissionRoute(window.location.hash);
  if (page === "fleet") return "board";
  return page === "library" || page === "runs" || page === "settings" ? page : "unknown";
}
export class WorkflowApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "WorkflowApiError";
  }
}

export async function workflowRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json",
      ...(init?.method && init.method !== "GET" ? beginOperation(workflowOperationSurface()).headers : {}), ...init?.headers },
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new WorkflowApiError(
      typeof body?.error === "string" ? body.error : `Workflow request failed (${response.status})`,
      response.status,
      body,
    );
  }
  return body as T;
}
