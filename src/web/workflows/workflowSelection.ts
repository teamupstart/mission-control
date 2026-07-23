const KEY = "mission-control.workflow.selected";

export function readLastWorkflowId(): string | null {
  try {
    return localStorage.getItem(KEY)?.trim() || null;
  } catch {
    return null;
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
