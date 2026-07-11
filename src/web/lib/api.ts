import type { SessionDiff } from "@shared/types.ts";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Fetch a session's diff vs its source branch. Never throws - maps failures into the shape. */
export async function fetchSessionDiff(id: string): Promise<SessionDiff> {
  const fail = (error: string): SessionDiff => ({
    ok: false, error, base: null, baseSha: null, headSha: null, branch: null,
    filesChanged: 0, insertions: 0, deletions: 0, patch: "", truncated: false,
  });
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/diff`);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return fail(data.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as SessionDiff;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
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
    // Task endpoints return the Task object (no `ok` field); a 2xx is success.
    // Errors always arrive as a non-2xx (handled above), so this can't mask one.
    return { ...data, ok: true };
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
  reclaimTask: (id: string) => post(`/api/tasks/${encodeURIComponent(id)}/reclaim`),
  completeTask: (id: string, outcome: string, outcomeUrl?: string) =>
    post(`/api/tasks/${encodeURIComponent(id)}/complete`, { outcome, outcomeUrl }),
  deleteTask: (id: string) => del(`/api/tasks/${encodeURIComponent(id)}`),
};
