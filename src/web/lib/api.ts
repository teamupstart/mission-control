import type {
  AgentType,
  AssignResetConfirm,
  BacklogPlan,
  ForemanEpisode,
  ForemanEpisodeSummary,
  ForemanStatus,
  InspectorInspection,
  InspectorStatus,
  KeepAwakeStatus,
  LlmStatus,
  MessageSendDisposition,
  PendingTurn,
  PermissionMode,
  PlanDecisionAnswer,
  ResetPreview,
  ReviewItem,
  SessionDiff,
  SessionGoal,
  SessionFileDocument,
  SessionFileEntry,
  SessionFileSaveResult,
  SessionQueue,
  SkillsView,
  Task,
  TaskKind,
  TaskPriority,
  TranscriptMessage,
} from "@shared/types.ts";
import type {
  AwayConfig,
  AwayConfigPatch,
  ForemanConfig,
  ForemanConfigPatch,
  FormOutcome,
  CostConfigPatch,
  CostTelemetryStatus,
  HarnessesConfig,
  HarnessesConfigPatch,
  HarnessModelCatalogs,
  InspectorConfig,
  InspectorConfigPatch,
  LlmConfig,
  LlmConfigPatch,
  ResolveEpisode,
  ResolveFindingsResult,
  RetroResponse,
  ShippingConfig,
  ShippingConfigPatch,
  SetNote,
  SkillsConfigPatch,
  UiConfigPatch,
  UiConfigView,
  PipelinesConfigPatch,
  PipelineInstallerLaunchBody,
  TaskSourcesConfigPatch,
  UpdateTask,
  TaskDependencyInput,
  EnsembleActionBody,
  WorktreesConfig,
  WorktreesConfigPatch,
} from "@shared/protocol.ts";
import { HarnessModelCatalogsSchema } from "@shared/protocol.ts";
import type {
  WorktreeActionExecuteResult,
  WorktreeActionPreview,
  WorktreeActionRequest,
  WorktreeInventory,
  WorktreeRiskKey,
} from "@shared/worktrees.ts";
import type {
  EnsembleCreateInput,
  EnsembleDecision,
  EnsembleRun,
  EnsembleSummary,
} from "@shared/ensemble.ts";
import type {
  EnsembleArtifactPatch,
  EnsemblePreviewResult,
  EnsembleRunDetailResponse,
  EnsembleSubmitAck,
} from "../ensembles/types.ts";
import type { EnvironmentChecksView } from "@shared/environment-checks.ts";
import type { OpenFileResult, OpenTargetId, OpenTargetView } from "@shared/open-targets.ts";
import type { TerminalBackendId, TerminalTargetView } from "@shared/terminal.ts";
import type {
  MissionSchedule,
  ScheduleHistoryPage,
  ScheduleMissedPolicy,
  ScheduleOccurrence,
  ScheduleOverlapPolicy,
  SchedulePreviewResult,
  ScheduleTemplate,
  ScheduleValidationField,
} from "@shared/schedules.ts";
import type { SweepReport, TaskSourceRef, TaskSourcesView } from "@shared/task-source.ts";
import type {
  PipelineActionRequest,
  PipelineActionResult,
  PipelineConsoleRequest,
  PipelineConsoleResult,
  PipelineInstallerCandidatesResult,
  PipelineInstallerLaunchResult,
  PipelineProviderId,
  PipelineRepoRegistrationResponse,
  PipelineReposView,
  PipelineRunDetail,
  PipelinesView,
} from "@shared/pipeline.ts";
import type { Attachment } from "@shared/attachments.ts";
import type {
  ArchiveDetail,
  ArchivePage,
  ArchiveSearchQuery,
} from "@shared/archives.ts";
import type { AwayBufferSummary, AwayDigest } from "@shared/away-buffer.ts";
import type { Stall } from "@shared/stall.ts";
import type { PersonaDefaultsView, WorkflowUploadEvidenceLocator } from "@shared/workflow.ts";

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Present when Mission Control or an embedded driver acknowledges the submission. */
  delivery?: MessageSendDisposition;
  /** The durable outbox row created for an editable submission. */
  pendingTurn?: PendingTurn;
  /** HTTP status, so a caller can tell a CAS conflict (409) from a real failure. */
  status?: number;
}

/**
 * A refused assign, which may be asking rather than complaining: `resetConfirm` present
 * means nothing was touched and the same POST with `confirmReset` would go through.
 */
export interface AssignResult extends ActionResult {
  resetConfirm?: AssignResetConfirm;
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
/**
 * The fleet-wide episode ledger - every decision Foreman has faced, newest first.
 *
 * Fetched rather than streamed for the reason the route states: an episode carries the
 * child's screen at decision time. Rides `useForeman`'s existing 4s tick, so the panel
 * that shows it costs no second timer.
 */
export const fetchForemanEpisodes = () =>
  fetchJson<ForemanEpisodeSummary[]>("/api/foreman/episodes");
/**
 * One decision in full, fetched when a reader opens a ledger row.
 *
 * The other half of the trade above. The poll ships a hundred summaries and no screen
 * captures; this ships one whole episode, on a click, and only for the row being read - so
 * the fleet ledger can show the ask, the brief, the recommendation and what was actually
 * delivered without any of it riding the 4s tick. `null` on a miss, which is a pruned or
 * unknown id and reads as "this decision is gone" in the row that asked for it.
 */
export const fetchForemanEpisode = (id: number) =>
  fetchJson<ForemanEpisode>(`/api/foreman/episodes/${id}`);
/**
 * Foreman's reading of the backlog - what waits on what, and in what order.
 *
 * Polled beside the config rather than streamed: it changes only when the backlog
 * gains an item, which is far rarer than the SSE traffic it would ride on, and the
 * board's use of it (a blocked chip, a "next up" marker) is chrome that can be a
 * poll behind. `null` is the ordinary answer before Foreman has ever read the backlog,
 * and is indistinguishable here from a failed fetch on purpose - both mean "draw the
 * column with no plan", which is exactly the pre-autopilot rendering.
 */
export const fetchBacklogPlan = () => fetchJson<BacklogPlan>("/api/backlog/plan");
/** Dispatch-time defaults the harness applies to the sessions it launches. */
export const fetchHarnessesConfig = () => fetchJson<HarnessesConfig>("/api/harnesses/config");
/**
 * The complete dispatch-time model catalog, read once by the root browser provider.
 *
 * Unlike most optional reads in this module, this response is narrowed at the browser
 * boundary. A stale tab can be talking to an older daemon, and a malformed aggregate must
 * degrade to the shipped catalog rather than become three partially trusted picker lists.
 */
export async function fetchHarnessModelCatalogs(
  refresh = false,
  signal?: AbortSignal,
): Promise<HarnessModelCatalogs | null> {
  const value = await fetchJsonWithSignal<unknown>(
    `/api/harnesses/models${refresh ? "?refresh=1" : ""}`,
    signal,
  );
  const parsed = HarnessModelCatalogsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export const fetchWorktrees = (signal?: AbortSignal) =>
  fetchJsonWithSignal<WorktreeInventory>("/api/worktrees", signal);

async function fetchJsonWithSignal<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(path, { signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface WorktreeApiFailure {
  ok: false;
  status: number;
  error: string;
  code?: string;
}

async function worktreeRequest<T>(path: string, method: "POST" | "PUT", body: unknown): Promise<({ ok: true } & T) | WorktreeApiFailure> {
  try {
    const res = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
    if (!res.ok) return { ok: false, status: res.status, error: data.error ?? `HTTP ${res.status}`, code: data.code };
    return { ok: true, ...data };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export const updateWorktreesConfig = (patch: WorktreesConfigPatch) =>
  worktreeRequest<{ config: WorktreesConfig }>("/api/worktrees/config", "PUT", patch);

export const previewWorktreeAction = (request: WorktreeActionRequest) =>
  worktreeRequest<WorktreeActionPreview>("/api/worktrees/actions/preview", "POST", request);

export const executeWorktreeAction = (token: string, acknowledgements: WorktreeRiskKey[]) =>
  worktreeRequest<WorktreeActionExecuteResult>("/api/worktrees/actions/execute", "POST", {
    token,
    acknowledgements,
  });

export const openWorktreeTerminal = (slotId: string, backend: TerminalBackendId) =>
  worktreeRequest<{ label?: string }>(`/api/worktrees/${encodeURIComponent(slotId)}/open`, "POST", { backend });
/**
 * What this MACHINE says about third-party tooling a dispatched session will inherit from
 * `~/.claude` - see `src/shared/environment-checks.ts`.
 *
 * Read when a dispatch form opens rather than streamed: the answers change when the operator
 * repairs their own machine, which no server event can announce, and every one of them is
 * chrome the form can simply do without. `null` on failure, like every other optional read
 * here, and the form treats that as "nothing to warn about" - a fetch that did not land must
 * never be the reason a dispatch does not go.
 */
export const fetchEnvironmentChecks = () =>
  fetchJson<EnvironmentChecksView>("/api/environment/checks");
/**
 * The operator's dashboard preferences, plus whether one was ever saved. `configured` is
 * what gates the one-time adoption of pre-rename `localStorage`; see `lib/uiConfig.ts`.
 */
export const fetchUiConfig = () => fetchJson<UiConfigView>("/api/ui/config");
/**
 * Cost telemetry: the stored config PLUS what is actually in the user's settings.json.
 * Both, because they diverge for real reasons (a hand-edited file, an install from
 * another checkout) and a panel showing only the intent would be confidently wrong.
 */
export const fetchCostConfig = () => fetchJson<CostTelemetryStatus>("/api/cost/config");
export const fetchInspectorConfig = () => fetchJson<InspectorConfig>("/api/inspector/config");
/**
 * The adoption ledger, in one of its two readings.
 *
 * Bare: the 50 most recently REVIEWED, which is the Inspector settings panel's list.
 *
 * With `adoptedSince` (epoch ms): every pull request adopted since then, newest adoption
 * first and uncapped - the ship-log reading. The Ship log must pass it and must never fall
 * back to the bare form on a wide range, because review recency is not ship order: the
 * default's cap would truncate a busy week and its ordering would reshuffle the same week
 * whenever the Inspector re-reviewed something, leaving a page that disagrees with the
 * Line's Shipped count about a number they both take from this one table.
 */
export const fetchInspectorPrs = (adoptedSince?: number) =>
  fetchJson<InspectorInspection[]>(
    adoptedSince === undefined
      ? "/api/inspector/prs"
      : `/api/inspector/prs?adoptedSince=${Math.floor(adoptedSince)}`,
  );
export const fetchInspectorStatus = () => fetchJson<InspectorStatus>("/api/inspector/status");
/** Which provider the app's offline work uses, and each background job's model override. */
export const fetchLlmConfig = () => fetchJson<LlmConfig>("/api/llm/config");
/**
 * The RESOLVED runner and models, plus the providers this build has.
 *
 * Separate from the config for the reason the Inspector's status is: the config is what was
 * stored, this is what the daemon will actually spawn with once the env layer - which the
 * browser cannot see - has had its say.
 */
export const fetchLlmStatus = () => fetchJson<LlmStatus>("/api/llm/status");
export const fetchPersonaDefaults = () => fetchJson<PersonaDefaultsView>("/api/personas/defaults");
/** YOLO mode: whether adopted PRs may merge themselves, and how long they must soak. */
export const fetchShippingConfig = () => fetchJson<ShippingConfig>("/api/shipping/config");
/**
 * The Task sources panel in one read: what is configured, how each is doing, and which
 * kinds this build offers. One route rather than a config/status pair, for the reason
 * `/api/skills` is one: nothing else reads any half of it, and the halves are only ever
 * rendered together.
 */
export const fetchTaskSources = () => fetchJson<TaskSourcesView>("/api/task-sources/config");
/**
 * The Conductor panel in one read: consent, detection, and per-repository health.
 *
 * One route rather than a config/detection pair for `fetchTaskSources`' reason - nothing
 * else reads any half of it. `refresh` forces the daemon to re-run its engine probe rather
 * than answer from its TTL cache; the poll never sets it, because a probe is a subprocess
 * and only an operator pressing "Check again" is asking for a fresh one.
 */
export const fetchPipelines = (refresh = false) =>
  fetchJson<PipelinesView>(`/api/pipelines/config${refresh ? "?refresh=1" : ""}`);

/**
 * Replace observation consent and keep the returned pipeline status array intact.
 *
 * This cannot use the generic mutation helper: that helper adds the HTTP `status` number to
 * every answer, while `PipelinesView.status` is the repository health array. Flattening both
 * shapes would replace the array with `200` precisely when a consent write succeeds.
 */
export async function setPipelinesConfig(
  config: PipelinesConfigPatch,
): Promise<{ ok: true; view: PipelinesView } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/pipelines/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<PipelinesView> & {
      error?: string;
    };
    if (!res.ok || !data.config || !data.probes || !data.status) {
      return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    }
    return {
      ok: true,
      view: { config: data.config, probes: data.probes, status: data.status },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
/**
 * The repositories being read, for the Pipelines rail's headings.
 *
 * Deliberately not `fetchPipelines`. That route carries the consent config and answers
 * behind an engine probe; this one is a config read and a map lookup, which is what a rail
 * polling while its tab is open should cost.
 */
export const fetchPipelineRepos = () =>
  fetchJson<PipelineReposView>("/api/pipelines/repos");

/** Ephemeral, provider-verified local source checkouts eligible for guided installation. */
export const fetchPipelineInstallers = (provider: PipelineProviderId) =>
  fetchJson<PipelineInstallerCandidatesResult>(
    `/api/pipelines/installers?provider=${encodeURIComponent(provider)}`,
  );

/** Open the reverified upstream installer in the selected hosted terminal. */
export const openPipelineInstaller = (body: PipelineInstallerLaunchBody) =>
  post<ActionResult & PipelineInstallerLaunchResult>("/api/pipelines/install", body);
/**
 * One run's gate evidence, read from the engine's files at request time.
 *
 * On demand rather than over the stream because the projection rides every reconnect for
 * every run on the fleet - see the per-run wire budget in `test/pipeline-sse.test.ts`. Null
 * for a run that no longer exists or a repository nobody is observing, which the detail view
 * draws as a stale link rather than as an error.
 */
export const fetchPipelineRunDetail = (
  provider: PipelineProviderId,
  repoRoot: string,
  slug: string,
) =>
  fetchJson<PipelineRunDetail>(
    `/api/pipelines/run?provider=${encodeURIComponent(provider)}&repoRoot=${encodeURIComponent(repoRoot)}&slug=${encodeURIComponent(slug)}`,
  );
/**
 * Ask the engine to do one thing, and answer with what it said about it.
 *
 * Deliberately not `post()`: that helper flattens every 2xx to `ok: true`, and this route's
 * whole shape is a 200 carrying the ENGINE's own `ok`. A refused pause is the answer to
 * "please pause this" rather than a failed request, so flattening it would draw an engine that
 * ignored the operator as one that obeyed. Every failure - a refusal, a non-2xx, a dead fetch -
 * comes back in the same record, because the surface needs one sentence for all of them.
 *
 * Nothing here re-reads the run afterwards. The daemon re-projects as part of the action and
 * emits `pipeline_upsert`, so the row updates from the stream that already owns it.
 */
export async function runPipelineAction(req: PipelineActionRequest): Promise<PipelineActionResult> {
  const failed = (detail: string): PipelineActionResult => ({
    ok: false,
    action: req.action,
    command: "",
    detail,
    output: "",
  });
  try {
    const res = await fetch("/api/pipelines/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<PipelineActionResult> & {
      error?: string;
    };
    if (!res.ok) return failed(data.error ?? `HTTP ${res.status}`);
    return {
      ok: data.ok === true,
      action: data.action ?? req.action,
      command: data.command ?? "",
      detail: data.detail ?? "",
      output: data.output ?? "",
    };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/** Open one hosted terminal on the engine - its daemon console, or the reseal ceremony. */
export async function openPipelineConsole(
  req: PipelineConsoleRequest,
): Promise<PipelineConsoleResult> {
  try {
    const res = await fetch("/api/pipelines/console", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<PipelineConsoleResult> & {
      error?: string;
    };
    return {
      ok: res.ok && data.ok !== false,
      console: req.console,
      label: data.label ?? "",
      ...(data.error ? { error: data.error } : res.ok ? {} : { error: `HTTP ${res.status}` }),
    };
  } catch (err) {
    return {
      ok: false,
      console: req.console,
      label: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Away mode: whether you're away, since when, and the stall thresholds. */
export const fetchAwayConfig = () => fetchJson<AwayConfig>("/api/away");
/**
 * The return digest, read once - the daemon drops it as it hands it over, so a
 * refresh doesn't re-announce it. Null when there is nothing to report (a 204),
 * which is the common case: you were never away, or nothing happened.
 */
export const fetchAwayDigest = () => fetchJson<AwayDigest>("/api/away/digest");
/**
 * What has piled up in the window still open, for the away card's count and preview.
 *
 * Separate from the digest read above and NOT interchangeable with it: this one only
 * looks. `fetchAwayDigest` claims the digest for good, and answers nothing at all until
 * you are back at the desk, so it can never source a figure shown while you are away.
 */
export const fetchAwayBuffer = () => fetchJson<AwayBufferSummary>("/api/away/buffer");
/**
 * The sessions the daemon currently reads as stuck. Fetched rather than derived:
 * a stall is elapsed silence, and `sessionEqual` keeps `lastActivity` out of the
 * SSE change comparison, so the session stream cannot carry the signal.
 */
export const fetchAwayStalls = () => fetchJson<Stall[]>("/api/away/stalls");
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

// ---- ensembles ----
//
// These do not go through the `request`/`post` helpers below: those flatten every 2xx to
// `ok: true`, which would clobber preview's own `ok` (the draft's validity) and hide the
// `409` an action's `expectedStatus` mismatch reports. Each ensemble call instead preserves
// the raw HTTP status and the `code`/body the daemon returns, so the detail controller can
// tell a deleted run (404) from a real failure and refetch on a stale-state conflict.

/** The result of one ensemble call: the parsed body on success, the status + code on refusal. */
export type EnsembleFetch<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; code?: string; data: Record<string, unknown> };

async function ensembleJson<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<EnsembleFetch<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
        code: typeof data.code === "string" ? data.code : undefined,
        data,
      };
    }
    return { ok: true, status: res.status, data: data as T };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err), data: {} };
  }
}

/** Compact run summaries. The dashboard prefers the live SSE collection; this is the fallback. */
export const fetchEnsembles = (status?: string) =>
  fetchJson<{ ensembles: EnsembleSummary[]; total: number }>(
    `/api/ensembles${status ? `?status=${encodeURIComponent(status)}` : ""}`,
  );

/** The full bounded detail for one run: members, artifacts, stages, evaluations, decisions. */
export const fetchEnsembleDetail = (id: string) =>
  ensembleJson<EnsembleRunDetailResponse>("GET", `/api/ensembles/${encodeURIComponent(id)}`);

/** One artifact's on-demand, byte-bounded diff. Never carried in SSE. */
export const fetchEnsembleArtifactPatch = (runId: string, artifactId: string, maxBytes?: number) =>
  ensembleJson<EnsembleArtifactPatch>(
    "GET",
    `/api/ensembles/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/patch${
      maxBytes ? `?maxBytes=${maxBytes}` : ""
    }`,
  );

/** Complete file stats for one artifact, with no patch bytes. Used by the compare matrix. */
export const fetchArtifactFiles = (runId: string, artifactId: string) =>
  ensembleJson<EnsembleArtifactPatch>(
    "GET",
    `/api/ensembles/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/patch?filesOnly=1`,
  );

/**
 * One exact repo-relative path from one artifact. The route deliberately accepts one `path` per
 * request; compare fans these out instead of growing an unbounded multi-path query string.
 */
export function fetchArtifactFilePatch(
  runId: string,
  artifactId: string,
  path: string,
  maxBytes?: number,
) {
  const params = new URLSearchParams({ path });
  if (maxBytes !== undefined) params.set("maxBytes", String(maxBytes));
  return ensembleJson<EnsembleArtifactPatch>(
    "GET",
    `/api/ensembles/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/patch?${params}`,
  );
}

/**
 * The side-effect-free launch/budget/handoff estimate. Always returns a body: `ok: false`
 * with per-field `issues` for an invalid draft is the ordinary case, not an error.
 */
export async function previewEnsemble(input: EnsembleCreateInput): Promise<EnsemblePreviewResult> {
  const r = await ensembleJson<EnsemblePreviewResult>("POST", "/api/ensembles/preview", input);
  return r.ok
    ? r.data
    : { ok: false, reason: "preview_failed", issues: [{ path: "", message: r.error }], estimate: null, workflow: null };
}

/** Idempotently create and launch one run. `created: false` is a same-`sourceKey` replay. */
export const createEnsemble = (input: EnsembleCreateInput) =>
  ensembleJson<{ run: EnsembleRun; summary: EnsembleSummary; created: boolean }>(
    "POST",
    "/api/ensembles",
    input,
  );

/** One generic operator action (decide, retry, withdraw, cancel, restore, resolve-finalization). */
export const ensembleAction = (id: string, body: EnsembleActionBody) =>
  ensembleJson<{ summary: EnsembleSummary | null; decision: EnsembleDecision | null; replayed: boolean }>(
    "POST",
    `/api/ensembles/${encodeURIComponent(id)}/actions`,
    body,
  );

/** The manual fallback for a member that cannot reach the MCP submission tool. */
export const submitEnsembleMember = (
  runId: string,
  memberId: string,
  result: { summary: string; checks?: string[]; testEvidence?: string | null },
) =>
  ensembleJson<EnsembleSubmitAck>(
    "POST",
    `/api/ensembles/${encodeURIComponent(runId)}/members/${encodeURIComponent(memberId)}/submit`,
    { result },
  );

/** Terminal-only history + private-ref deletion, confirmed by echoing the run id. */
export const deleteEnsemble = (id: string, confirmId: string) =>
  ensembleJson<{ deleted: true }>("DELETE", `/api/ensembles/${encodeURIComponent(id)}`, {
    confirmId,
  });

/**
 * Resolve a typed path to its canonical git repo root, validated server-side.
 * Used by the Foreman allowlist picker so a typo can't enter the trusted list -
 * a non-repo path comes back as an error rather than a silently-inert entry.
 */
export async function resolveRepo(
  path: string,
): Promise<{ ok: true; repoRoot: string; path: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/repos/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      repoRoot?: string;
      path?: string;
      error?: string;
    };
    if (!res.ok || !data.repoRoot) {
      return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    }
    // `path` is the CANONICAL form of what was asked about, which a caller needs when the
    // subdirectory matters. An older daemon does not send it; falling back to the root
    // reproduces the previous behaviour rather than failing the lookup.
    return { ok: true, repoRoot: data.repoRoot, path: data.path ?? data.repoRoot };
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

/**
 * The repositories Trust has granted the Workflows cell, for a picker that wants to offer
 * them first. Never throws - [] on failure, which degrades a picker rather than a page.
 *
 * A read of POLICY, not of the Command catalog: the catalog rides the SSE snapshot and is
 * never fetched a second time. This is the one fact the Library's Command editor needs that
 * lives in the workflow config blob, and it is read once because a consent grant moves about
 * as often as the app itself.
 */
export async function fetchWorkflowRepoAllowlist(): Promise<string[]> {
  try {
    const res = await fetch("/api/workflows/config");
    if (!res.ok) return [];
    const data = (await res.json()) as { repoAllowlist?: unknown };
    return Array.isArray(data.repoAllowlist) ? (data.repoAllowlist as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * The refusal body is KEPT, not reduced to its message. A route that answers a conflict
 * with structure - what a destructive action would cost, which the caller then renders -
 * would otherwise have that structure thrown away here, and every such route would have
 * to bypass this helper to be usable. `T` is how a caller names what it expects back.
 */
async function request<T extends ActionResult = ActionResult>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T;
    if (!res.ok) {
      return { ...data, ok: false, error: data.error ?? `HTTP ${res.status}`, status: res.status };
    }
    // Task endpoints return the Task object (no `ok` field); a 2xx is success.
    // Errors always arrive as a non-2xx (handled above), so this can't mask one.
    return { ...data, ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) } as T;
  }
}

const post = <T extends ActionResult = ActionResult>(path: string, body?: unknown) =>
  request<T>("POST", path, body);
const put = <T extends ActionResult = ActionResult>(path: string, body?: unknown) =>
  request<T>("PUT", path, body);
const patch = (path: string, body?: unknown) => request("PATCH", path, body);
const del = (path: string) => request("DELETE", path);

// ---- Recurring Missions ----
//
// Typed helpers over the schedule routes, everything Phase 4 needs to preview, save,
// enable/pause, Run now, archive, and page history without inventing a payload. Preview
// returns the daemon's own `SchedulePreviewResult` - the browser does no date math - and the
// mutations PRESERVE the validation field so the editor can put a refusal under the input
// that caused it. History is on-demand only: no interval, no effect poller, no global
// collection. The live catalog is SSE-owned (see `useEventStream`).

/** The editable definition the preview, create, and update routes accept. */
export interface ScheduleDefinitionPayload {
  name: string;
  expression: string;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy;
  missedPolicy: ScheduleMissedPolicy;
  template: ScheduleTemplate;
}

/** The definition plus the knobs a preview alone needs (count, standby window, self-exclude). */
export interface SchedulePreviewPayload extends ScheduleDefinitionPayload {
  count?: number;
  after?: number;
  sleepStartedAt?: number;
  resumedAt?: number;
  excludeScheduleId?: string;
}

export interface ScheduleMutationResult extends ActionResult {
  schedule?: MissionSchedule;
  /** The input a validation refusal belongs to, so the editor can attach the message. */
  field?: ScheduleValidationField;
}

export interface RunScheduleNowResult extends ActionResult {
  /** The occurrence the run recorded - its own status says whether work was filed or skipped. */
  occurrence?: ScheduleOccurrence;
  schedule?: MissionSchedule;
}

/** A create/update/enable/archive that returns the canonical schedule, field errors intact. */
async function scheduleMutation(path: string, body?: unknown): Promise<ScheduleMutationResult> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as Partial<MissionSchedule> & {
      error?: string;
      field?: ScheduleValidationField;
    };
    if (!res.ok) {
      return { ok: false, error: data.error ?? `HTTP ${res.status}`, field: data.field, status: res.status };
    }
    return { ok: true, schedule: data as MissionSchedule, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Enumerate an unsaved cadence without writing anything. Returns the daemon's own result. */
export async function previewSchedule(payload: SchedulePreviewPayload): Promise<SchedulePreviewResult> {
  try {
    const res = await fetch("/api/schedules/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as SchedulePreviewResult & {
      error?: string;
      field?: ScheduleValidationField;
    };
    if (!res.ok) {
      return { ok: false, error: { field: data.field ?? "expression", message: data.error ?? `HTTP ${res.status}` } };
    }
    return data;
  } catch (err) {
    return { ok: false, error: { field: "expression", message: err instanceof Error ? err.message : String(err) } };
  }
}

/** Save a new schedule. `enabled` is explicit: Save paused sends false, Save & enable true. */
export const createSchedule = (payload: ScheduleDefinitionPayload & { enabled: boolean }) =>
  scheduleMutation("/api/schedules", payload);

export const updateSchedule = (id: string, payload: ScheduleDefinitionPayload) =>
  scheduleMutation(`/api/schedules/${encodeURIComponent(id)}/update`, payload);

export const setScheduleEnabled = (id: string, enabled: boolean) =>
  scheduleMutation(`/api/schedules/${encodeURIComponent(id)}/set-enabled`, { enabled });

export const archiveSchedule = (id: string) =>
  scheduleMutation(`/api/schedules/${encodeURIComponent(id)}/archive`, {});

/** File this mission's work now, paused or not, without touching the cron cursor. */
export async function runScheduleNow(id: string): Promise<RunScheduleNowResult> {
  try {
    const res = await fetch(`/api/schedules/${encodeURIComponent(id)}/run-now`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = (await res.json().catch(() => ({}))) as {
      occurrence?: ScheduleOccurrence;
      schedule?: MissionSchedule;
      error?: string;
    };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}`, status: res.status };
    return { ok: true, occurrence: data.occurrence, schedule: data.schedule, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * One page of a schedule's occurrence history, newest first, paged by an opaque `before`
 * cursor. On-demand only - deliberately not wired into any interval, effect poller, or
 * global collection - and it carries the schedule (including an archived one) so a
 * generated task can deep-link here after the schedule leaves the catalog.
 */
export function fetchScheduleHistory(
  id: string,
  cursor: { before?: number | null; limit?: number } = {},
): Promise<ScheduleHistoryPage | null> {
  const params = new URLSearchParams();
  if (cursor.before != null) params.set("before", String(cursor.before));
  if (cursor.limit != null) params.set("limit", String(cursor.limit));
  const query = params.toString();
  return fetchJson<ScheduleHistoryPage>(
    `/api/schedules/${encodeURIComponent(id)}/occurrences${query ? `?${query}` : ""}`,
  );
}

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
 * The page of turns immediately before a byte offset - the conversation panel's
 * scroll-back.
 *
 * The live stream deliberately opens on a bounded tail, so this is the only way to reach
 * a turn older than it. Anchored in bytes because that is the one currency an
 * append-only file indexes for free, and each page reports the `start` that anchors the
 * next call - see `transcript-history.ts` for why the ranges must abut exactly.
 */
export async function fetchTranscriptBefore(
  id: string,
  before: number,
  signal?: AbortSignal,
): Promise<
  | { ok: true; messages: TranscriptMessage[]; start: number; end: number; atStart: boolean }
  | { ok: false; error: string }
> {
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(id)}/transcript?before=${encodeURIComponent(String(before))}`,
      { signal },
    );
    const data = (await res.json().catch(() => ({}))) as {
      messages?: TranscriptMessage[];
      start?: number;
      end?: number;
      atStart?: boolean;
      error?: string;
    };
    if (!res.ok || !data.messages || typeof data.start !== "number" || typeof data.end !== "number") {
      return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    }
    return {
      ok: true,
      messages: data.messages,
      start: data.start,
      end: data.end,
      // A response that omits the flag is treated as "nothing older", which stops the
      // scroll-back rather than looping on an anchor the server never moved.
      atStart: data.atStart ?? true,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchSessionFiles(
  id: string,
): Promise<{ ok: true; files: SessionFileEntry[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/files`);
    const data = (await res.json().catch(() => ({}))) as { files?: SessionFileEntry[]; error?: string };
    if (!res.ok || !data.files) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, files: data.files };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchSessionFile(
  id: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ ok: true; file: SessionFileDocument } | { ok: false; error: string }> {
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
      { signal },
    );
    const data = (await res.json().catch(() => ({}))) as SessionFileDocument & { error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, file: data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Which "Open in" targets this build has, and whether the daemon's host can use each.
 *
 * Null on failure, not an empty list: an empty list is a real answer meaning "this build
 * registers no targets", and drawing it for a failed fetch would hide the control rather
 * than say why. See `useOpenTargets`.
 */
export const fetchOpenTargets = () =>
  fetchJson<{ targets: OpenTargetView[] }>("/api/open-targets");

/**
 * Which terminals the daemon's host can open a window in.
 *
 * Null on failure for `fetchOpenTargets`'s reason: an empty list would be a real answer,
 * and drawing it for a dropped connection reads as "you have no terminals". See
 * `useTerminalTargets`.
 */
export const fetchTerminalTargets = () =>
  fetchJson<{ targets: TerminalTargetView[] }>("/api/terminal-targets");

/**
 * Park a dropped image on the daemon's disk, resolving to the path an agent can
 * read. Never throws - maps failures into the shape, like the other uploaders
 * here, because a failed drop is a chip that says why, not a broken compose box.
 */
export async function uploadImage(
  file: File,
): Promise<
  | { ok: true; upload: Attachment; uploadId: string; bytes: number }
  | { ok: false; error: string }
> {
  try {
    const body = new FormData();
    body.append("file", file);
    const res = await fetch("/api/uploads", { method: "POST", body });
    const data = (await res.json().catch(() => ({}))) as Partial<Attachment> & {
      uploadId?: string;
      bytes?: number;
      error?: string;
    };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    if (!data.path || !data.name) return { ok: false, error: "upload returned no path" };
    if (!data.uploadId || !Number.isInteger(data.bytes) || (data.bytes ?? 0) <= 0) {
      return { ok: false, error: "upload returned no workflow locator" };
    }
    return {
      ok: true,
      upload: { path: data.path, name: data.name },
      uploadId: data.uploadId,
      bytes: data.bytes!,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Turn the transient Keep Awake mode on or off: `PUT /api/keep-awake`.
 *
 * Resolves with the daemon's OBSERVED status - never an echo of the request - and never
 * throws into React, like the other mutators here. On a refusal (unsupported host, failed
 * OS transition) the server sends its observed status beside the error, so the control
 * can draw the failure at once instead of waiting for the SSE frame that carries it.
 */
export async function setKeepAwake(
  enabled: boolean,
): Promise<
  | { ok: true; status: KeepAwakeStatus }
  | { ok: false; error: string; status: KeepAwakeStatus | null }
> {
  try {
    const res = await fetch("/api/keep-awake", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        status?: KeepAwakeStatus;
      };
      return { ok: false, error: data.error ?? `HTTP ${res.status}`, status: data.status ?? null };
    }
    return { ok: true, status: (await res.json()) as KeepAwakeStatus };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), status: null };
  }
}

/**
 * What `POST /api/tasks/:id/push` answers, in the two readings a caller must tell apart.
 *
 * A 200 returns the updated `Task`, so `source` is the ref of the item that was just created -
 * read off the reply rather than waited for over SSE, which is what lets the modal draw the
 * link in the same tick the button was pressed.
 *
 * `outcomeUnknown` is the 504, and it is the one failure a caller must NOT offer to retry:
 * the item may already exist upstream, and a second attempt files a duplicate into a tracker
 * other people are reading. A refusal without it (the 502) published nothing, so retrying is
 * safe. Flagged rather than only worded, so this decision is never a sentence match.
 */
export interface PushTaskResult extends ActionResult {
  source?: TaskSourceRef | null;
  outcomeUnknown?: boolean;
}

export interface DispatchInput {
  repoRoot: string;
  /** Secondary repos to attach; the daemon resolves, dedupes and refuses each one. */
  extraRepoRoots?: string[];
  intent: string;
  title?: string;
  kind: TaskKind;
  agent: AgentType;
  /** Optional urgency; omitted or null means unset, which is not the same as "low". */
  priority?: TaskPriority | null;
  /** Optional free-form tags; the server normalizes them. */
  labels?: string[];
  /** Model override; omitted follows the configured harness default at dispatch time. */
  model?: string;
  /** Reasoning-effort override; omitted follows the harness default at dispatch time. */
  effort?: import("@shared/types.ts").ThinkingLevel;
  /** After-work Workflow; omitted follows the dispatch default, null explicitly opts out. */
  workflowId?: string | null;
  /** Backlog-task or live-session prerequisites. */
  dependencies?: TaskDependencyInput[];
  backlog?: boolean;
  /** Whether Foreman's backlog autopilot may schedule a shelved task. */
  enabled?: boolean;
}

// ---- Archives ----
//
// The archive read model. Everything here is BOUNDED and on demand: the catalog is unbounded
// history that is deliberately absent from the SSE snapshot, so the page asks for one window
// at a time and the daemon's `scout_archive_changed` invalidation tells it when to ask again.
//
// These do not use `fetchJson`, and that is the whole point of the section. `fetchJson`
// answers every failure with `null`, which the Scouts page cannot tell apart from a library
// that genuinely holds nothing - and "no scouts yet" drawn over a daemon that refused the
// request is the one wrong answer this page must never give. Every read below returns its
// failure instead.

/** A bounded read that distinguishes "nothing there" from "could not ask". */
export type ArchiveRead<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; status?: number };

/**
 * GET a scout endpoint, preserving the daemon's own refusal.
 *
 * `AbortError` is reported as a normal failure with `aborted: true` filtered out by the
 * caller: a superseded keystroke is not a fault, and the page drops it rather than drawing
 * an error for a request it cancelled itself.
 */
async function archiveJson<T>(path: string, signal?: AbortSignal): Promise<ArchiveRead<T>> {
  try {
    const res = await fetch(path, { ...(signal ? { signal } : {}) });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? `HTTP ${res.status}`, status: res.status };
    }
    return { ok: true, value: (await res.json()) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** True when a rejected read was this page cancelling itself, not a failure worth showing. */
export function isArchiveAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Serializes the page's filters into the query the daemon validates.
 *
 * Built HERE rather than in the component so there is one place that knows an out-of-range
 * `limit` or a malformed `cursor` is REFUSED by the route rather than clamped, and one place
 * that spells each parameter. The names match `ArchiveSearchQuerySchema` exactly.
 */
export function archiveSearchPath(query: Partial<ArchiveSearchQuery>): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.producer) params.set("producer", query.producer);
  if (query.repo) params.set("repo", query.repo);
  if (query.agent) params.set("agent", query.agent);
  if (query.status) params.set("status", query.status);
  if (query.from !== undefined && query.from !== null) params.set("from", String(query.from));
  if (query.to !== undefined && query.to !== null) params.set("to", String(query.to));
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit !== undefined && query.limit !== null) params.set("limit", String(query.limit));
  const search = params.toString();
  return search ? `/api/archives?${search}` : "/api/archives";
}

/** One artifact's bytes, plus what the daemon said they are. */
export interface ArchiveArtifactBody {
  blob: Blob;
  mediaType: string;
}

export const api = {
  listFiles: fetchSessionFiles,
  readFile: fetchSessionFile,
  saveFile: (id: string, path: string, text: string, expectedRevision: string) =>
    put<SessionFileSaveResult>(`/api/sessions/${encodeURIComponent(id)}/file`, {
      path,
      text,
      expectedRevision,
    }),
  /**
   * Hand one checkout file to an application outside Mission Control. The daemon resolves
   * the target to a command; the caller only ever names a registered id.
   */
  openFile: (id: string, path: string, target: OpenTargetId) =>
    post<OpenFileResult & ActionResult>(
      `/api/sessions/${encodeURIComponent(id)}/file/open`,
      { path, target },
    ),
  sendText: (id: string, text: string, submit = true) =>
    post(`/api/sessions/${encodeURIComponent(id)}/send`, { text, submit }),
  recallPendingTurn: (id: string, turnId: string, revision: number) =>
    post<ActionResult & { text?: string }>(
      `/api/sessions/${encodeURIComponent(id)}/pending-turns/${encodeURIComponent(turnId)}/recall`,
      { revision },
    ),
  retryPendingTurn: (id: string, turnId: string, revision: number) =>
    post(
      `/api/sessions/${encodeURIComponent(id)}/pending-turns/${encodeURIComponent(turnId)}/retry`,
      { revision },
    ),
  resolvePendingTurn: (id: string, turnId: string, revision: number) =>
    post(
      `/api/sessions/${encodeURIComponent(id)}/pending-turns/${encodeURIComponent(turnId)}/resolve`,
      { revision },
    ),
  focus: (id: string) => post(`/api/sessions/${encodeURIComponent(id)}/focus`),
  /**
   * Open a terminal on this session's checkout - a shell, or its own agent CLI resumed on
   * this conversation.
   *
   * `payload` picks between two argvs the DAEMON composes; nothing here becomes part of a
   * command line, which is why this takes two enums and no strings.
   */
  launchTerminal: (
    id: string,
    backend: TerminalBackendId,
    payload: "shell" | "agent",
  ): Promise<ActionResult & { label?: string }> =>
    post(`/api/sessions/${encodeURIComponent(id)}/launch`, { backend, payload }),
  rename: (id: string, name: string) =>
    post(`/api/sessions/${encodeURIComponent(id)}/rename`, { name }),
  kill: (id: string) => post(`/api/sessions/${encodeURIComponent(id)}/kill`),
  /**
   * Stop what the session is doing right now and drop what was queued behind it, leaving
   * the conversation open. Nothing to send: the gesture has one meaning.
   *
   * `stoppedTurn: false` is a SUCCESS that found nothing - the turn ended on its own in the
   * window between the keypress and the request landing. The queue is deliberately left
   * alone in that case, so a caller must report it rather than treating a 200 as a stop.
   */
  interrupt: (
    id: string,
  ): Promise<ActionResult & { stoppedTurn?: boolean; droppedQueued?: number }> =>
    post(`/api/sessions/${encodeURIComponent(id)}/interrupt`),
  cycleMode: (id: string) => post(`/api/sessions/${encodeURIComponent(id)}/mode/cycle`),
  /**
   * Drive a session to a specific permission mode through its harness's native live
   * control (a verified Shift+Tab walk or a numbered permissions menu).
   */
  setMode: (id: string, mode: PermissionMode) =>
    post(`/api/sessions/${encodeURIComponent(id)}/mode`, { mode }),
  /**
   * Apply a reasoning effort to one live session.
   *
   * `pending` on a successful answer means the harness ACCEPTED the level for its next
   * turn and the conversation is still running the old one - the daemon has published that
   * on `Session.pendingEffort`, so the caller must not hold a local copy of it.
   */
  setEffort: (id: string, effort: import("@shared/types.ts").ThinkingLevel) =>
    post<ActionResult & { pending?: boolean }>(
      `/api/sessions/${encodeURIComponent(id)}/effort`,
      { effort },
    ),
  reset: (id: string, clear = true) =>
    post(`/api/sessions/${encodeURIComponent(id)}/reset`, { clear }),
  /**
   * Ask a session to run its own retrospective, or file one when it can no longer be typed
   * into. The daemon decides which; there is nothing to send and nothing to choose.
   *
   * The two success arms are worth distinguishing to the person who clicked, which is why the
   * response body is kept rather than reduced to `ok`: same-session delivery, dead-session
   * fallback, accepted post-merge launch, and recoverably queued post-merge launch each leave
   * the operator looking in a different place.
   */
  runRetro: (id: string) =>
    post<ActionResult & RetroResponse>(
      `/api/sessions/${encodeURIComponent(id)}/retro`,
    ),
  /**
   * Answer the option menu a session is showing by selecting one of its rows.
   *
   * `label` is not decoration: the card renders a snapshot up to one poll (1.5s) old, and
   * the daemon re-reads the pane and refuses unless the row still reads as the label the
   * human was actually shown. Always pass the label off the row that was clicked, never a
   * remembered or re-derived one, or the check is checking our own guess.
   *
   * A 409 means the screen moved out from under the click (the menu closed, the rows
   * repainted, Foreman answered first). Nothing was pressed - re-render and let the human
   * look again rather than retrying blind.
   */
  selectOption: (id: string, number: number, label: string) =>
    post(`/api/sessions/${encodeURIComponent(id)}/select-option`, { number, label }),
  /**
   * Fill in and SEND a multi-select `AskUserQuestion`, which `selectOption` cannot do:
   * pressing a row of one ticks its box and answers nothing, so the whole form goes at
   * once and the daemon walks Claude's own Submit tab (see `submitPaneForm`).
   *
   * Send every checkbox row with the state the human left it in - not just the ones they
   * changed - so the daemon diffs against the live pane rather than replaying clicks onto
   * a form that may have been ticked in the terminal since.
   */
  submitOptions: (
    id: string,
    options: Array<{ number: number; label: string; checked: boolean }>,
  ): Promise<ActionResult & { outcome?: FormOutcome; note?: string }> =>
    post(`/api/sessions/${encodeURIComponent(id)}/submit-options`, { options }),
  /**
   * Submit a DRIVER form - one answer per question, keyed by the question's own text.
   *
   * A second call rather than a wider `submitOptions`, because the bodies are not
   * interchangeable: a pane form is a list of checkbox rows on one screen, and a driver
   * form is several questions each numbering its options from 1. Flattening them would tick
   * the right-numbered row of the wrong question. `text` carries free prose where the
   * harness accepts it, which a pane form has to refuse for want of a field to type into.
   */
  submitAnswers: (
    id: string,
    answers: Array<{ question: string; labels: string[]; text?: string }>,
  ): Promise<ActionResult & { outcome?: FormOutcome; note?: string }> =>
    post(`/api/sessions/${encodeURIComponent(id)}/submit-options`, { answers }),
  /**
   * Hand an embedded session back to a terminal, continuing the same conversation.
   *
   * One-way and not a toggle: the driver stops, `claude --resume <id>` opens on the same
   * session file, and discovery adopts the new process. There is no route back, because
   * after this the terminal session is the one holding the conversation.
   */
  handoff: (
    id: string,
  ): Promise<ActionResult & { homeName?: string; sessionId?: string | null }> =>
    post(`/api/sessions/${encodeURIComponent(id)}/handoff`),
  /**
   * `selections` rides along only when a decision form was filled in. It is what the
   * conversation replays afterwards - `response` is the flattened string the agent reads,
   * which cannot say which options went untaken. The route attributes this to the human;
   * only the Foreman worker declares otherwise.
   */
  resolveReview: (
    id: string,
    action: "approve" | "reject" | "answer" | "dismiss",
    response?: string | null,
    selections?: PlanDecisionAnswer[] | null,
  ) =>
    post(`/api/reviews/${encodeURIComponent(id)}/resolve`, { action, response, selections }),
  // --- dispatch (agents) ---
  dispatch: (input: DispatchInput) => post(`/api/tasks`, input),
  /** Launch the fixed, read-only Terra task used only by the See the work tour spike. */
  startSeeWorkTourDemo: (repoRoot: string) =>
    post<ActionResult & { task?: Task }>("/api/tours/see-work/dispatch", { repoRoot }),
  /** Launch the fixed Chat conversation used when the tour starts on an empty fleet. */
  startSeeWorkTourPreview: (repoRoot: string) =>
    post<ActionResult & { task?: Task }>("/api/tours/see-work/preview", { repoRoot }),
  /** Record the fixed Tour demo outcome and close any session the spike launched. */
  completeSeeWorkTourDemo: (taskId: string) =>
    post<ActionResult & { task?: Task }>(
      `/api/tours/see-work/tasks/${encodeURIComponent(taskId)}/complete`,
    ),
  /**
   * Launch an existing task. Dashboard callers claim `overrideDisabled` for this manual
   * action; without that claim the daemon refuses a parked task.
   */
  dispatchBacklog: (id: string, overrideDisabled: boolean) =>
    post(`/api/tasks/${encodeURIComponent(id)}/dispatch`, { overrideDisabled }),
  /**
   * Edit a task - the dispatch modal reopened on a card, the backlog column's priority
   * picker, or its enable/disable toggle.
   * Rewriting repo/intent/title/kind/agent/model/effort/dependencies/enabled is refused (409)
   * once the task has been dispatched, when its launch configuration is already in use;
   * a priority/labels-only patch is annotation and is accepted in any status.
   * An omitted key means "leave it"; `priority: null` explicitly clears it to unset.
   */
  updateTask: (id: string, patch: UpdateTask) =>
    post(`/api/tasks/${encodeURIComponent(id)}/update`, patch),
  /**
   * Hand a backlog task to an agent that is already running, rather than launching one.
   * Dashboard callers claim `overrideDisabled` for the manual handoff; without it the
   * daemon refuses a parked task.
   *
   * The agent is reset first, so an agent holding anything the reset would take - a work
   * queue, a branch - refuses with a `resetConfirm` breakdown instead. Re-POST with
   * `confirmReset` once the operator has seen it; a clean agent never gets that far.
   */
  assignTask: (
    id: string,
    sessionId: string,
    overrideDisabled: boolean,
    confirmReset = false,
  ) =>
    post<AssignResult>(`/api/tasks/${encodeURIComponent(id)}/assign`, {
      sessionId,
      overrideDisabled,
      confirmReset,
    }),
  cancelTask: (id: string) => post(`/api/tasks/${encodeURIComponent(id)}/cancel`),
  reclaimTask: (id: string) => post(`/api/tasks/${encodeURIComponent(id)}/reclaim`),
  // Put a cancelled/failed task back into the backlog so the autopilot can run it again.
  // The "run it" half of unblocking a dependent stranded behind a stopped prerequisite;
  // `completeTask(id, ..., true)` is the "it already landed" half. Refused (409) on a task
  // that is done or still live.
  rescheduleTask: (id: string) => post(`/api/tasks/${encodeURIComponent(id)}/reschedule`, {}),
  // `satisfyDependents` is the operator's explicit override of the merge gate on
  // declared dependencies - omitted rather than sent as false so the request body stays
  // the one every existing caller already sends. See `CompleteTaskSchema`.
  completeTask: (
    id: string,
    outcome: string,
    outcomeUrl?: string,
    satisfyDependents?: boolean,
    requireStopped?: boolean,
  ) =>
    post(`/api/tasks/${encodeURIComponent(id)}/complete`, {
      outcome,
      outcomeUrl,
      ...(satisfyDependents ? { satisfyDependents: true } : {}),
      ...(requireStopped ? { requireStopped: true } : {}),
    }),
  deleteTask: (id: string) => del(`/api/tasks/${encodeURIComponent(id)}`),
  /**
   * File this backlog task as an item in the tracker a configured source points at - the one
   * outward write in the task-sources feature, and the only call here that PUBLISHES.
   *
   * The task stays in the backlog; what changes is that its row now carries the ref of the
   * item created for it. See `PushTaskResult` for why the two failure readings are not
   * interchangeable, and never retry one carrying `outcomeUnknown`.
   */
  pushTaskToSource: (id: string, sourceId: string) =>
    post<PushTaskResult>(`/api/tasks/${encodeURIComponent(id)}/push`, { sourceId }),

  // --- Foreman (auto-responder) ---
  setForemanConfig: (cfg: ForemanConfigPatch) => put(`/api/foreman/config`, cfg),
  retryForemanPlanner: () => post(`/api/foreman/planner/retry`, {}),
  setSkillsConfig: (cfg: SkillsConfigPatch) => put(`/api/skills/config`, cfg),

  // --- Harnesses (dispatch-time defaults) ---
  setHarnessesConfig: (cfg: HarnessesConfigPatch) => put(`/api/harnesses/config`, cfg),
  setInspectorConfig: (cfg: InspectorConfigPatch) => put(`/api/inspector/config`, cfg),
  /**
   * Close the findings the Inspector is carrying on one pull request.
   *
   * The way out of a finding that has genuinely been addressed but that nothing can mark
   * resolved - the review round only closes fingerprints the model lists, and it stops
   * running once the head has been reviewed. It does not merge anything and it does not
   * relax a gate: every other merge condition, including GitHub's own unresolved review
   * threads, is still checked on the next sweep.
   */
  resolveInspectorFindings: (prKey: string) =>
    post<ActionResult & ResolveFindingsResult>(`/api/inspector/resolve-findings`, { prKey }),

  // --- LLM (which provider does the app's own offline work, and on which model) ---
  setLlmConfig: (cfg: LlmConfigPatch) => put(`/api/llm/config`, cfg),

  // --- Shipping (YOLO mode: merging the clean ones) ---
  setShippingConfig: (cfg: ShippingConfigPatch) => put(`/api/shipping/config`, cfg),

  // --- Pipelines (observing an external SDLC engine) ---
  setPipelines: setPipelinesConfig,
  registerPipelineRepo: (provider: PipelineProviderId, repoRoot: string) =>
    post<ActionResult & PipelineRepoRegistrationResponse>(`/api/pipelines/register`, {
      provider,
      repoRoot,
    }),

  // --- Task sources (pulling work into the backlog) ---
  setTaskSources: (cfg: TaskSourcesConfigPatch) => put(`/api/task-sources/config`, cfg),
  /** Sweep one source now. The report says what it filed, skipped and dropped. */
  sweepTaskSource: (id: string) =>
    post<ActionResult & SweepReport>(`/api/task-sources/${encodeURIComponent(id)}/sweep`),
  /** "Is this actually going to work?" - the question an empty sweep cannot answer. */
  preflightTaskSource: (id: string) =>
    post<ActionResult & { problem: string | null }>(
      `/api/task-sources/${encodeURIComponent(id)}/preflight`,
    ),
  /** Forget what this source has filed, so it can file it again. */
  forgetTaskSourceSeen: (id: string) =>
    del(`/api/task-sources/${encodeURIComponent(id)}/seen`),

  // --- Dashboard UI preferences (layout, keybindings, alerts, rich text) ---
  setUiConfig: (cfg: UiConfigPatch) => put(`/api/ui/config`, cfg),
  setCostConfig: (cfg: CostConfigPatch) => put(`/api/cost/config`, cfg),

  // --- Away mode ---
  setAwayConfig: (cfg: AwayConfigPatch) => put(`/api/away`, cfg),
  setNote: (id: string, note: SetNote) => put(`/api/sessions/${encodeURIComponent(id)}/note`, note),

  // --- Foreman invites: whether Foreman may act in this session at all ---
  //
  // Both body-less, matching the routes. The answer never comes back through the
  // response: the daemon re-resolves the session and emits a `session_upsert`, so the
  // rail and every "not-invited" sentence flip from the stream that already owns the
  // session record rather than from a second, racing copy of it held here.
  /** Let Foreman triage, wrap up, and follow PRs in this session. */
  inviteForeman: (id: string) => post(`/api/sessions/${encodeURIComponent(id)}/foreman-invite`),
  /** Remove Foreman from this session. Authoritative even for embedded SDK sessions. */
  withdrawForemanInvite: (id: string) =>
    del(`/api/sessions/${encodeURIComponent(id)}/foreman-invite`),

  // --- Foreman episodes: the append-only record behind the note ---
  /**
   * Stamp your answer onto the episode Foreman left open.
   *
   * Paired with `setNote`, not replaced by it. The note is current state, so
   * answering correctly clears its recommendation; the episode is the record, so it
   * keeps what was sent and who sent it. Before this existed, Approve nulled the
   * recommendation and the words that went to the child survived nowhere at all.
   */
  resolveEpisode: (id: string, p: ResolveEpisode) =>
    post(`/api/sessions/${encodeURIComponent(id)}/foreman-episode/resolve`, p),
  episodes: (id: string) =>
    fetchJson<ForemanEpisode[]>(`/api/sessions/${encodeURIComponent(id)}/foreman-episodes`),
  /** Full resolved intent for the Foreman drawer; the session snapshot carries only its summary. */
  goal: (id: string) =>
    fetchJson<SessionGoal>(`/api/sessions/${encodeURIComponent(id)}/goal`),

  /**
   * The answers this session's human gave, oldest first - the durable half of the
   * conversation's review entries. Served from SQLite, so a reopened dashboard or a
   * restarted daemon still shows what was decided; the live SSE reviews are folded in on
   * top of these for immediacy (see `useTimelineReviews`).
   */
  resolvedReviews: (id: string) =>
    fetchJson<ReviewItem[]>(`/api/sessions/${encodeURIComponent(id)}/resolved-reviews`),

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
  startBuiltinReview: (
    id: string,
    requestId: string,
    evidence: WorkflowUploadEvidenceLocator[] = [],
  ) =>
    post<{ run?: { id: string } } & ActionResult>(
      `/api/sessions/${encodeURIComponent(id)}/workflow-review`,
      { requestId, evidence },
    ),
  reattachQueue: (id: string, noteKey: string) =>
    post(`/api/sessions/${encodeURIComponent(id)}/queue/reattach`, { noteKey }),
  /** Deliver a whole multi-line prompt as one bracketed-paste submission. */
  injectPrompt: (id: string, text: string, buffer = true) =>
    post(`/api/sessions/${encodeURIComponent(id)}/inject`, { text, buffer }),

  // ---- Archives ----

  /** One bounded, cursor-paged window of the archive catalog, newest first. */
  listArchives: (query: Partial<ArchiveSearchQuery>, signal?: AbortSignal) =>
    archiveJson<ArchivePage>(archiveSearchPath(query), signal),

  /**
   * One archive in full: provenance, completeness, and artifact metadata, but no bodies.
   *
   * Fetched even for a key absent from the current window, which is what makes a deep link
   * to a filtered-out archive open the archive instead of an empty reader.
   */
  archiveDetail: (archiveKey: string, signal?: AbortSignal) =>
    archiveJson<ArchiveDetail>(`/api/archives/${encodeURIComponent(archiveKey)}`, signal),

  /**
   * One artifact's bytes, addressed by its GENERATED id.
   *
   * The caller never builds a path: the daemon resolves the stored relative path beneath the
   * verified archive root and refuses anything that escapes it, so an artifact id is the only
   * thing that crosses this boundary. The route always answers as an attachment with
   * `default-src 'none'; sandbox`, so these bytes are inert wherever they land - a blob URL
   * made from one cannot execute, and the caller is expected to revoke it.
   */
  archiveArtifact: async (
    archiveKey: string,
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<ArchiveRead<ArchiveArtifactBody>> => {
    try {
      const res = await fetch(
        `/api/archives/${encodeURIComponent(archiveKey)}/artifacts/${encodeURIComponent(artifactId)}`,
        { ...(signal ? { signal } : {}) },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: body.error ?? `HTTP ${res.status}`, status: res.status };
      }
      const blob = await res.blob();
      // The daemon's own content type wins over the blob's, which is empty for anything it
      // served with `nosniff` and a generic type.
      const mediaType = res.headers.get("content-type")?.split(";")[0]?.trim() || blob.type;
      return { ok: true, value: { blob, mediaType: mediaType || "application/octet-stream" } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  /** Hand one archived artifact to an application outside Mission Control. */
  openArchiveArtifact: (archiveKey: string, artifactId: string, target: OpenTargetId) =>
    post<OpenFileResult & ActionResult>(
      `/api/archives/${encodeURIComponent(archiveKey)}/artifacts/${encodeURIComponent(artifactId)}/open`,
      { target },
    ),

  /** Change only this machine's display name for an immutable archive. */
  renameArchive: (archiveKey: string, title: string) =>
    request<ActionResult & { title?: string }>(
      "PATCH",
      `/api/archives/${encodeURIComponent(archiveKey)}`,
      { title },
    ),

  /**
   * Delete one archive from THIS machine's library.
   *
   * `confirmArchiveKey` is echoed and must equal the route's key or the daemon refuses with
   * a 409. That is not belt-and-braces: it binds the deletion to the record the operator was
   * looking at, so a list that reordered under a stale browser cannot turn a confirmed
   * delete into a delete of whatever now occupies that position.
   */
  deleteArchive: (archiveKey: string) =>
    request<{ deletedBundle?: boolean } & ActionResult>(
      "DELETE",
      `/api/archives/${encodeURIComponent(archiveKey)}`,
      { confirmArchiveKey: archiveKey },
    ),
};
