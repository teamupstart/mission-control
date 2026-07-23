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
    headers: { "content-type": "application/json", ...init?.headers },
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
