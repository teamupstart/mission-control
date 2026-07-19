import type {
  ForemanStatus,
  NmFixDetail,
  PermissionMode,
  ResetPreview,
  SessionDiff,
  SessionQueue,
  SkillsView,
} from "@shared/types.ts";
import type {
  AwayConfig,
  AwayConfigPatch,
  ForemanConfig,
  ForemanConfigPatch,
  HarnessesConfig,
  HarnessesConfigPatch,
  SetNote,
  SkillsConfigPatch,
} from "@shared/protocol.ts";
import type { Attachment } from "@shared/attachments.ts";
import type { AwayDigest } from "@shared/away-buffer.ts";

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** HTTP status, so a caller can tell a CAS conflict (409) from a real failure. */
  status?: number;
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
/** Dispatch-time defaults the harness applies to the sessions it launches. */
export const fetchHarnessesConfig = () => fetchJson<HarnessesConfig>("/api/harnesses/config");
/** Away mode: whether you're away, since when, and the stall thresholds. */
export const fetchAwayConfig = () => fetchJson<AwayConfig>("/api/away");
/**
 * The return digest, read once - the daemon drops it as it hands it over, so a
 * refresh doesn't re-announce it. Null when there is nothing to report (a 204),
 * which is the common case: you were never away, or nothing happened.
 */
export const fetchAwayDigest = () => fetchJson<AwayDigest>("/api/away/digest");
/** The skills catalog, what's on, and how many sessions are behind - one read. */
export const fetchSkills = () => fetchJson<SkillsView>("/api/skills");

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

/**
 * Fetch a session's diff vs its source branch, or - with `commit` - the diff of
 * that one commit alone. Never throws - maps failures into the shape.
 */
export async function fetchSessionDiff(id: string, commit?: string): Promise<SessionDiff> {
  const fail = (error: string): SessionDiff => ({
    ok: false, error, base: null, baseSha: null, headSha: null, repoRoot: null, branch: null,
    filesChanged: 0, insertions: 0, deletions: 0, patch: "", truncated: false,
  });
  try {
    const q = commit ? `?commit=${encodeURIComponent(commit)}` : "";
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/diff${q}`);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return fail(data.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as SessionDiff;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** The context behind one no-mistakes fix. Null when it can't be loaded. */
export const fetchNomistakesFix = (id: string, sha: string): Promise<NmFixDetail | null> =>
  fetchJson<NmFixDetail>(
    `/api/sessions/${encodeURIComponent(id)}/nomistakes/fixes/${encodeURIComponent(sha)}`,
  );

/**
 * Resolve a typed path to its canonical git repo root, validated server-side.
 * Used by the Foreman allowlist picker so a typo can't enter the trusted list -
 * a non-repo path comes back as an error rather than a silently-inert entry.
 */
export async function resolveRepo(
  path: string,
): Promise<{ ok: true; repoRoot: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/repos/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = (await res.json().catch(() => ({}))) as { repoRoot?: string; error?: string };
    if (!res.ok || !data.repoRoot) {
      return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, repoRoot: data.repoRoot };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}`, status: res.status };
    // Task endpoints return the Task object (no `ok` field); a 2xx is success.
    // Errors always arrive as a non-2xx (handled above), so this can't mask one.
    return { ...data, ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const post = (path: string, body?: unknown) => request("POST", path, body);
const put = (path: string, body?: unknown) => request("PUT", path, body);
const patch = (path: string, body?: unknown) => request("PATCH", path, body);
const del = (path: string) => request("DELETE", path);

/**
 * Fetch a session's work queue, saying WHICH kind of nothing it got.
 *
 * `fetchJson` collapses "this session has no queue" (a 200 with a null body) and
 * "the request failed" into the same null, and those two must never render the
 * same: a populated queue whose GET fails would otherwise draw as an empty one,
 * under an add box, inviting the human to re-queue work that already exists.
 */
export async function fetchQueue(
  id: string,
): Promise<{ ok: true; queue: SessionQueue | null } | { ok: false }> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/queue`);
    if (!res.ok) return { ok: false };
    return { ok: true, queue: (await res.json()) as SessionQueue | null };
  } catch {
    return { ok: false };
  }
}

/**
 * Park a dropped image on the daemon's disk, resolving to the path an agent can
 * read. Never throws - maps failures into the shape, like the other uploaders
 * here, because a failed drop is a chip that says why, not a broken compose box.
 */
export async function uploadImage(
  file: File,
): Promise<{ ok: true; upload: Attachment } | { ok: false; error: string }> {
  try {
    const body = new FormData();
    body.append("file", file);
    const res = await fetch("/api/uploads", { method: "POST", body });
    const data = (await res.json().catch(() => ({}))) as Partial<Attachment> & { error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    if (!data.path || !data.name) return { ok: false, error: "upload returned no path" };
    return { ok: true, upload: { path: data.path, name: data.name } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface DispatchInput {
  repoRoot: string;
  intent: string;
  title?: string;
  kind: "ship" | "scout";
  agent: "claude" | "codex";
  backlog?: boolean;
}

export const api = {
  sendText: (id: string, text: string, submit = true) =>
    post(`/api/sessions/${encodeURIComponent(id)}/send`, { text, submit }),
  focus: (id: string) => post(`/api/sessions/${encodeURIComponent(id)}/focus`),
  rename: (id: string, name: string) =>
    post(`/api/sessions/${encodeURIComponent(id)}/rename`, { name }),
  kill: (id: string) => post(`/api/sessions/${encodeURIComponent(id)}/kill`),
  cycleMode: (id: string) => post(`/api/sessions/${encodeURIComponent(id)}/mode/cycle`),
  /**
   * Drive a session to a specific permission mode. Slower than it looks - the
   * daemon walks the Shift+Tab cycle a step at a time, verifying against the pane
   * - so callers should show a pending state while it runs.
   */
  setMode: (id: string, mode: PermissionMode) =>
    post(`/api/sessions/${encodeURIComponent(id)}/mode`, { mode }),
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
  dispatchBacklog: (id: string) => post(`/api/tasks/${encodeURIComponent(id)}/dispatch`),
  /** Hand a backlog task to an agent that is already running, rather than launching one. */
  assignTask: (id: string, sessionId: string) =>
    post(`/api/tasks/${encodeURIComponent(id)}/assign`, { sessionId }),
  cancelTask: (id: string) => post(`/api/tasks/${encodeURIComponent(id)}/cancel`),
  reclaimTask: (id: string) => post(`/api/tasks/${encodeURIComponent(id)}/reclaim`),
  completeTask: (id: string, outcome: string, outcomeUrl?: string) =>
    post(`/api/tasks/${encodeURIComponent(id)}/complete`, { outcome, outcomeUrl }),
  deleteTask: (id: string) => del(`/api/tasks/${encodeURIComponent(id)}`),

  // --- Foreman (auto-responder) ---
  setForemanConfig: (cfg: ForemanConfigPatch) => put(`/api/foreman/config`, cfg),
  setSkillsConfig: (cfg: SkillsConfigPatch) => put(`/api/skills/config`, cfg),

  // --- Harnesses (dispatch-time defaults) ---
  setHarnessesConfig: (cfg: HarnessesConfigPatch) => put(`/api/harnesses/config`, cfg),

  // --- Away mode ---
  setAwayConfig: (cfg: AwayConfigPatch) => put(`/api/away`, cfg),
  setNote: (id: string, note: SetNote) => put(`/api/sessions/${encodeURIComponent(id)}/note`, note),

  // --- Foreman session work queues ---
  addWorkItem: (id: string, intent: string) =>
    post(`/api/sessions/${encodeURIComponent(id)}/queue`, { intent }),
  /** Edit a waiting item. CAS on `revision` - a 409 means Foreman got there first. */
  editWorkItem: (id: string, itemId: string, intent: string, revision: number) =>
    patch(`/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(itemId)}`, {
      intent,
      revision,
    }),
  removeWorkItem: (id: string, itemId: string) =>
    del(`/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(itemId)}`),
  reorderQueue: (id: string, ids: string[]) =>
    put(`/api/sessions/${encodeURIComponent(id)}/queue/order`, { ids }),
  approveWorkItem: (id: string, itemId: string) =>
    post(`/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(itemId)}/approve`),
  setWrapupAnswer: (id: string, answer: string | null) =>
    put(`/api/sessions/${encodeURIComponent(id)}/queue/wrapup`, { answer }),
  reattachQueue: (id: string, noteKey: string) =>
    post(`/api/sessions/${encodeURIComponent(id)}/queue/reattach`, { noteKey }),
  /** Deliver a whole multi-line prompt as one bracketed-paste submission. */
  injectPrompt: (id: string, text: string) =>
    post(`/api/sessions/${encodeURIComponent(id)}/inject`, { text }),
};
