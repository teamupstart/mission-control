export interface ActionResult {
  ok: boolean;
  error?: string;
}

async function request(method: string, path: string, body?: unknown): Promise<ActionResult> {
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as ActionResult;
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return data;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const post = (path: string, body?: unknown) => request("POST", path, body);
const del = (path: string) => request("DELETE", path);

export interface DispatchInput {
  repoRoot: string;
  intent: string;
  title?: string;
  kind: "ship" | "scout";
  agent: "claude" | "codex";
  queue?: boolean;
}

export const api = {
  sendText: (id: string, text: string, submit = true) =>
    post(`/api/sessions/${encodeURIComponent(id)}/send`, { text, submit }),
  focus: (id: string) => post(`/api/sessions/${encodeURIComponent(id)}/focus`),
  kill: (id: string) => post(`/api/sessions/${encodeURIComponent(id)}/kill`),
  resolveReview: (id: string, action: "approve" | "reject" | "answer", response?: string | null) =>
    post(`/api/reviews/${encodeURIComponent(id)}/resolve`, { action, response }),
  nomistakesRespond: (
    id: string,
    action: "approve" | "fix" | "skip",
    opts: { findings?: string[]; instructions?: string } = {},
  ) => post(`/api/sessions/${encodeURIComponent(id)}/nomistakes/respond`, { action, ...opts }),

  // --- dispatch (crewmates) ---
  dispatch: (input: DispatchInput) => post(`/api/tasks`, input),
  dispatchQueued: (id: string) => post(`/api/tasks/${encodeURIComponent(id)}/dispatch`),
  cancelTask: (id: string) => post(`/api/tasks/${encodeURIComponent(id)}/cancel`),
  completeTask: (id: string, outcome: string, outcomeUrl?: string) =>
    post(`/api/tasks/${encodeURIComponent(id)}/complete`, { outcome, outcomeUrl }),
  deleteTask: (id: string) => del(`/api/tasks/${encodeURIComponent(id)}`),
};
