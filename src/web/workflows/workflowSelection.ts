const KEY = "mission-control.workflow.selected";
const VERSION_KEY = "mission-control.workflow.requested-version";

export function readLastWorkflowId(): string | null {
  try {
    return localStorage.getItem(KEY)?.trim() || null;
  } catch {
    return null;
  }
}

export function requestWorkflowVersionOpen(workflowId: string, version: number): void {
  if (!workflowId || !Number.isSafeInteger(version) || version < 1) return;
  rememberWorkflowId(workflowId);
  try {
    sessionStorage.setItem(VERSION_KEY, JSON.stringify({ workflowId, version }));
  } catch {
    return;
  }
}

export function readRequestedWorkflowVersion(workflowId: string): number | null {
  try {
    const raw = sessionStorage.getItem(VERSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { workflowId?: unknown; version?: unknown };
    if (
      value.workflowId !== workflowId
      || !Number.isSafeInteger(value.version)
      || Number(value.version) < 1
    ) return null;
    return value.version as number;
  } catch {
    return null;
  }
}

export function clearRequestedWorkflowVersion(): void {
  try {
    sessionStorage.removeItem(VERSION_KEY);
  } catch {
    return;
  }
}

export function rememberWorkflowId(id: string | null): void {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    return;
  }
}
