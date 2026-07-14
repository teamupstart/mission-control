import type { ForemanStatus, ResetPreview, SessionDiff } from "@shared/types.ts";
import type { ForemanConfig, ForemanConfigPatch, SetNote } from "@shared/protocol.ts";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** GET a JSON endpoint, returning null on any failure (for optional UI data). */
async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const fetchForemanConfig = () => fetchJson<ForemanConfig>("/api/foreman/config");
export const fetchForemanStatus = () => fetchJson<ForemanStatus>("/api/foreman/status");

/** Fetch what a reset-to-origin would discard. Never throws - maps failures into the shape. */
export async function fetchResetPreview(id: string): Promise<ResetPreview> {
  const fail = (error: string): ResetPreview => ({
    ok: false, error, target: null, branch: null, dirtyFiles: 0, untrackedFiles: 0,
    aheadCommits: 0, aheadSubjects: [], clean: false, canClear: false,
  });
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/reset/preview`);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return fail(data.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as ResetPreview;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
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

/** Fetch the workspace's git repos (dispatch bases). Never throws - [] on failure. */
export async function fetchRepos(): Promise<string[]> {
  try {
    const res = await fetch("/api/repos");
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as string[]) : [];
  } catch {
    return [];
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
const put = (path: string, body?: unknown) => request("PUT", path, body);
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
  cycleMode: (id: string) => post(`/api/sessions/${encodeURIComponent(id)}/mode/cycle`),
  reset: (id: string, clear = true) =>
    post(`/api/sessions/${encodeURIComponent(id)}/reset`, { clear }),
  resolveReview: (id: string, action: "approve" | "reject" | "answer", response?: string | null) =>
    post(`/api/reviews/${encodeURIComponent(id)}/resolve`, { action, response }),
  nomistakesRespond: (
    id: string,
    action: "approve" | "fix" | "skip",
    opts: { findings?: string[]; instructions?: string } = {},
  ) => post(`/api/sessions/${encodeURIComponent(id)}/nomistakes/respond`, { action, ...opts }),

  // --- dispatch (agents) ---
  dispatch: (input: DispatchInput) => post(`/api/tasks`, input),
  dispatchQueued: (id: string) => post(`/api/tasks/${encodeURIComponent(id)}/dispatch`),
  cancelTask: (id: string) => post(`/api/tasks/${encodeURIComponent(id)}/cancel`),
  reclaimTask: (id: string) => post(`/api/tasks/${encodeURIComponent(id)}/reclaim`),
  completeTask: (id: string, outcome: string, outcomeUrl?: string) =>
    post(`/api/tasks/${encodeURIComponent(id)}/complete`, { outcome, outcomeUrl }),
  deleteTask: (id: string) => del(`/api/tasks/${encodeURIComponent(id)}`),

  // --- Foreman (auto-responder) ---
  setForemanConfig: (patch: ForemanConfigPatch) => put(`/api/foreman/config`, patch),
  setNote: (id: string, patch: SetNote) => put(`/api/sessions/${encodeURIComponent(id)}/note`, patch),
};
