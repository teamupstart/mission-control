import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context, MiddlewareHandler } from "hono";
import type { TypeOf, ZodTypeAny } from "zod";
import {
  AddWorkItemSchema,
  AssignTaskSchema,
  AwayConfigPatchSchema,
  BacklogPlanSchema,
  CompleteTaskSchema,
  CreatePersonaSchema,
  CostConfigPatchSchema,
  CreateReviewSchema,
  DispatchBacklogTaskSchema,
  DispatchSchema,
  ResolveRepoSchema,
  EditWorkItemSchema,
  ForemanConfigPatchSchema,
  ForemanInstructionsSchema,
  ForemanHeartbeatSchema,
  GateReplySchema,
  HarnessesConfigPatchSchema,
  UiConfigPatchSchema,
  InspectorConfigPatchSchema,
  LlmConfigPatchSchema,
  ShippingConfigPatchSchema,
  HookIngestSchema,
  InjectPromptSchema,
  MarkItemSentSchema,
  NomistakesRespondSchema,
  OtlpMetricsSchema,
  ReattachQueueSchema,
  RenameSchema,
  ReorderQueueSchema,
  ResetSchema,
  ResolveReviewSchema,
  SelectOptionSchema,
  SendTextSchema,
  SaveSessionFileSchema,
  SessionFilePathSchema,
  SubmitOptionsSchema,
  RecordEpisodeSchema,
  ResolveEpisodeSchema,
  SetNoteSchema,
  SetPermissionModeSchema,
  SetSessionEffortSchema,
  SetWorkItemStateSchema,
  PromptedWrapupSchema,
  WrapupAskedSchema,
  SkillsConfigPatchSchema,
  TaskSourcesConfigPatchSchema,
  StandardsRequestSchema,
  StatusLineIngestSchema,
  StatusSchema,
  UpdateTaskSchema,
  UpdatePersonaSchema,
  ArchivePersonaSchema,
  CreateWorkflowSchema,
  UpdateWorkflowSchema,
  ValidateWorkflowSchema,
  PublishWorkflowSchema,
  ArchiveWorkflowSchema,
  WrapupSchema,
} from "@shared/protocol.ts";
import type { NomistakesRespond } from "@shared/protocol.ts";
import { capturePaneText } from "./discovery/pane-capture.ts";
import { noteKeyFor } from "./registry.ts";
import type { Registry } from "./registry.ts";
import type { QueueManager } from "./queue.ts";
import type {
  InspectorStatus,
  LlmStatus,
  NmRunSummary,
  Session,
  SkillsView,
  WorkItem,
} from "@shared/types.ts";
import type { ReviewManager } from "./reviews.ts";
import type { TaskManager } from "./tasks.ts";
import { sseHandler } from "./sse.ts";
import { recordInjection } from "./injections.ts";
import { harnessFor, sessionMessages } from "./harness/index.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { workQueueBlockedReason } from "@shared/harness-capabilities.ts";
import { transcriptStreamHandler } from "./transcript-stream.ts";
import {
  claimForemanLease,
  foremanStatus,
  getForemanConfig,
  releaseForemanLease,
  setForemanConfig,
} from "./foreman/config.ts";
import { getBacklogPlan, setBacklogPlan } from "./backlog.ts";
import { getAwayConfig, setAwayConfig } from "./away/config.ts";
import { buildDigest } from "./away/digest.ts";
import type { AwayWatcher } from "./away/watcher.ts";
import { getHarnessesConfig, setHarnessesConfig } from "./harnesses.ts";
import { getTaskSourcesConfig, setTaskSourcesConfig, taskSourceById } from "./task-sources/config.ts";
import { taskSourceKinds } from "./task-sources/index.ts";
import { noteTaskSourceConfigChange, preflightOnce, sweepOnce, taskSourceStatuses } from "./task-sources/sweeper.ts";
import type { TaskSourcesView } from "@shared/task-source.ts";
import { setUiConfig, uiConfigView } from "./ui-config.ts";
import { costTelemetryStatus, setCostConfig } from "./cost.ts";
import { getInspectorConfig, inspectorModel, setInspectorConfig } from "./inspector/config.ts";
import { getLlmConfig, llmStatus, setLlmConfig } from "./llm/config.ts";
import { getShippingConfig, setShippingConfig } from "./shipping/config.ts";
import { readCatalog } from "./skills/catalog.ts";
import { applySkillsConfig, getSkillsConfig } from "./skills/config.ts";
import { skillDrift } from "./skills/reconcile.ts";
import { pendingReloads } from "./skills/reload.ts";
import { readStandards } from "./standards.ts";
import {
  defaultForemanInstructions,
  foremanInstructions,
  resetForemanInstructions,
  setForemanInstructions,
} from "./foreman/instructions.ts";
import { computeCommitDiff, computeSessionDiff, repoRootOf } from "./diff.ts";
import { fixDetail } from "./nomistakes-fixes.ts";
import { readRuntimeEffortBaseline } from "./runtime-meta.ts";
import { checkToken } from "./auth.ts";
import {
  dropGateReply,
  forgetTaskSourceSeen,
  getSkillsAcks,
  loadInspectorInspections,
  logGateReply,
} from "./db.ts";
import {
  cyclePermissionMode,
  focus,
  injectPrompt,
  kill,
  rename,
  resetPreview,
  selectPaneOption,
  sendText,
  setPermissionMode,
  setSessionEffort,
  defaultPaneDeps,
  submitPaneForm,
  validateSessionName,
  validateSessionNameAgainstTasks,
} from "./actions.ts";
import { resetSession } from "./reset.ts";
import { respond as nomistakesRespond } from "./nomistakes.ts";
import { buildReport, renderReportMarkdown } from "./report.ts";
import { listRepos, resolveRepoRoot } from "./repos.ts";
import { MAX_UPLOAD_BYTES, saveImageUpload } from "./uploads.ts";
import {
  listSessionFiles,
  MAX_SESSION_EDITOR_BYTES,
  readSessionFile,
  saveSessionFile,
  SessionFileError,
} from "./session-files.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import type { PersonaManager, PersonaMutation } from "./workflows/personas.ts";
import type {
  WorkflowManager,
  WorkflowMutation,
  WorkflowPublishMutation,
  WorkflowValidationMutation,
} from "./workflows/manager.ts";
import { WORKFLOW_LIMITS } from "@shared/workflow.ts";

/** Long-poll window for the agent's review wait (it re-polls if still pending). */
const WAIT_TIMEOUT_MS = 30000;

/** The upload cap as the refusal states it - both size guards say the same number. */
const TOO_BIG_MB = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);
const PERSONA_BODY_MAX_BYTES = WORKFLOW_LIMITS.personaGuidanceBytes * 6 + 16 * 1024;
const WORKFLOW_BODY_MAX_BYTES = WORKFLOW_LIMITS.graphJsonBytes * 6 + 32 * 1024;

/**
 * Parse + validate a JSON request body against a schema. Returns the typed data,
 * or a ready-to-return 400 response - collapsing the safeParse/400 boilerplate
 * every write endpoint otherwise repeats.
 */
// `error` is carried alongside the ready-made `res` so a route with extra facts to
// report on a refusal can build its own body without re-reading this one's. /inject
// is that route: its contract is that EVERY refusal states whether text was pasted.
async function parseBody<S extends ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<{ ok: true; data: TypeOf<S> } | { ok: false; error: string; res: Response }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message, res: c.json({ error: parsed.error.message }, 400) };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Resolve an item-scoped queue route: the `:id` session must exist, and `:itemId`
 * must belong to ITS queue.
 *
 * Without the ownership half, `:id` was decoration - the item was addressed
 * globally, so `POST /api/sessions/does-not-exist/queue/<real-item>/approve`
 * answered 200. That isn't hypothetical mischief: item ids SURVIVE a re-attach
 * (`reattachQueue` preserves `i.id` while re-keying), so a tab holding a
 * pre-re-attach list - SSE dropped, or backgrounded, so no refresh fired - would
 * click Remove on item X under session A and delete it out of session B's live
 * queue. Membership is the only thing that distinguishes those two, and it is
 * checked at the write because that is the boundary the damage crosses.
 *
 * The queue's own key is the unit of ownership, not `session.id`: the id churns
 * with pid/tty while the note key is the identity the queue is stored under.
 */
function ownedItem(
  registry: Registry,
  queues: QueueManager,
  c: Context,
): { ok: true; item: WorkItem } | { ok: false; res: Response } {
  const session = registry.getSession(c.req.param("id") ?? "");
  if (!session) return { ok: false, res: c.json({ error: "no such session" }, 404) };
  const item = queues.getItem(c.req.param("itemId") ?? "");
  if (!item) return { ok: false, res: c.json({ error: "no such item" }, 404) };
  if (item.noteKey !== noteKeyFor(session)) {
    return { ok: false, res: c.json({ error: "that item is not in this session's queue" }, 404) };
  }
  return { ok: true, item };
}

/**
 * Stake the "you typed this" byline on a gate decision that is about to go out.
 * Returns the row to retract if it doesn't land, or null if there is nothing to
 * take back (the byline is best-effort, so a failed write costs the byline alone).
 */
function stakeYourByline(
  session: Session,
  gate: NmRunSummary,
  step: string,
  body: NomistakesRespond,
): number | null {
  try {
    return logGateReply({
      sessionId: session.id,
      ts: Date.now(),
      source: "you",
      runId: gate.id,
      step,
      // What the human actually picked. Falling back to every finding at the gate
      // matches the Fix box's own contract - it sends an empty list to mean "all
      // shown findings" - so the recorded set is what was decided either way, which
      // is what the join reads.
      findingIds:
        body.findings.length > 0 ? body.findings : gate.findings.map((f) => f.id).filter(Boolean),
      // The Fix box sends `trim() || undefined`, so selecting findings and typing
      // nothing is ordinary and lands as null: an author with no words, not an
      // absent author.
      text: body.instructions ?? null,
    });
  } catch (err) {
    // The decision still goes out; losing the byline must not fail the request.
    console.error("[nomistakes] could not record the gate reply:", err);
    return null;
  }
}

/**
 * Take back a "you typed this" byline the gate never received.
 *
 * Fail-soft, like the write it undoes: this runs both in a request path and in a
 * background `.then()`, and losing the retraction costs one wrong byline while
 * throwing would cost the caller its response or its reconcile.
 */
function retractByline(rowId: number): void {
  try {
    dropGateReply(rowId);
  } catch (err) {
    console.error("[nomistakes] could not retract the gate reply:", err);
  }
}

/**
 * Why this session's permission mode cannot be driven, or null when it can be.
 *
 * The refusal is a CAPABILITY answer, not an agent-id one: both mode routes walk the
 * Shift+Tab cycle and read the result back off a footer line, and a harness that renders
 * no such line has nothing for the walk to verify against - so it is refused here rather
 * than left to time out having typed Shift+Tab into somebody's editor. Named from
 * `AGENT_IDENTITY` so a fourth harness gets a true sentence instead of inheriting "Claude".
 */
function noPermissionModes(session: Session): string | null {
  if (harnessFor(session.agent).permissionModes) return null;
  return `${AGENT_IDENTITY[session.agent].label} has no permission modes`;
}

/** Service version, read once from package.json; "unknown" if unreadable. */
const VERSION = readVersion();
function readVersion(): string {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

export function buildApp(
  registry: Registry,
  reviews: ReviewManager,
  tasks: TaskManager,
  queues: QueueManager,
  /** Optional so tests can build an app without the away poller running. */
  away?: AwayWatcher,
  /** Optional for existing route-unit stubs; the daemon always supplies it. */
  personas?: PersonaManager,
  /** Optional for existing route-unit stubs; the daemon always supplies it. */
  workflows?: WorkflowManager,
): Hono {
  const app = new Hono();

  // The daemon binds to loopback, but that alone doesn't stop a web page the user
  // visits from reaching here via DNS-rebinding (the browser sends the *attacker's*
  // Host but the rebound request still hits 127.0.0.1). Writes would be RCE; reads
  // leak task prompts, repo paths, and transcripts. Require a loopback Host on every
  // data endpoint - the same-origin UI and Vite's changeOrigin proxy both qualify,
  // but a rebound cross-site request can't forge it.
  const requireLoopback: MiddlewareHandler = async (c, next) => {
    if (!hostIsLoopback(c.req.header("host"))) return c.json({ error: "forbidden" }, 403);
    await next();
  };
  app.use("/api/*", requireLoopback);
  app.use("/events", requireLoopback);

  app.get("/api/health", (c) =>
    c.json({ ok: true, service: "mission-control", version: VERSION, pid: process.pid }),
  );
  app.get("/api/sessions", (c) => c.json(registry.snapshot().sessions));

  // --- Workflow Personas: exact Markdown plus revision/CAS writes ---
  const personaManager = (): PersonaManager | null => personas ?? null;
  const workflowManager = (): WorkflowManager | null => workflows ?? null;
  const personaFailure = (c: Context, result: Exclude<PersonaMutation, { ok: true }>) => {
    const code = `persona_${result.reason}`;
    if (result.reason === "not_found") return c.json({ error: "no such Persona", code }, 404);
    return c.json({ error: result.reason.replaceAll("_", " "), code, current: result.current }, 409);
  };

  app.get("/api/personas", (c) => {
    const manager = personaManager();
    if (!manager) return c.json({ error: "Persona manager unavailable" }, 503);
    const raw = c.req.query("includeArchived");
    if (raw !== undefined && raw !== "true" && raw !== "false") {
      return c.json({ error: "includeArchived must be true or false" }, 400);
    }
    return c.json(manager.list(raw === "true"));
  });
  app.get("/api/personas/defaults", (c) => {
    const manager = personaManager();
    if (!manager) return c.json({ error: "Persona manager unavailable" }, 503);
    return c.json(manager.defaults());
  });
  app.get("/api/personas/:id", (c) => {
    const manager = personaManager();
    if (!manager) return c.json({ error: "Persona manager unavailable" }, 503);
    const persona = manager.get(c.req.param("id"));
    return persona ? c.json(persona) : c.json({ error: "no such Persona" }, 404);
  });
  app.post("/api/personas", bodyLimit({
    maxSize: PERSONA_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "Persona request is too large" }, 413),
  }), async (c) => {
    const manager = personaManager();
    if (!manager) return c.json({ error: "Persona manager unavailable" }, 503);
    const parsed = await parseBody(c, CreatePersonaSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.create(parsed.data);
    if (result.ok) workflows?.refreshSummaries();
    return result.ok ? c.json(result.persona, 201) : personaFailure(c, result);
  });
  app.patch("/api/personas/:id", bodyLimit({
    maxSize: PERSONA_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "Persona request is too large" }, 413),
  }), async (c) => {
    const manager = personaManager();
    if (!manager) return c.json({ error: "Persona manager unavailable" }, 503);
    const parsed = await parseBody(c, UpdatePersonaSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.update(c.req.param("id"), parsed.data);
    if (result.ok) workflows?.refreshSummaries();
    return result.ok ? c.json(result.persona) : personaFailure(c, result);
  });
  app.delete("/api/personas/:id", async (c) => {
    const manager = personaManager();
    if (!manager) return c.json({ error: "Persona manager unavailable" }, 503);
    const parsed = await parseBody(c, ArchivePersonaSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.archive(c.req.param("id"), parsed.data.expectedRevision);
    if (result.ok) workflows?.refreshSummaries();
    return result.ok ? c.json(result.persona) : personaFailure(c, result);
  });

  // --- Workflow definitions: CAS drafts and immutable published versions ---
  const workflowFailure = (
    c: Context,
    result: Exclude<WorkflowMutation | WorkflowPublishMutation | WorkflowValidationMutation, { ok: true }>,
    expectedRevision?: number,
  ) => {
    if (result.reason === "not_found") {
      return c.json({ error: "no such workflow", code: "workflow_not_found" }, 404);
    }
    const current = result.current;
    const currentSummary = current && workflows ? workflows.store.summary(current) : null;
    return c.json({
      error: result.reason.replaceAll("_", " "),
      code: `workflow_${result.reason}`,
      expectedRevision: expectedRevision ?? null,
      currentRevision: current?.draftRevision ?? null,
      current: currentSummary,
    }, 409);
  };

  app.get("/api/workflows", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const raw = c.req.query("includeArchived");
    if (raw !== undefined && raw !== "true" && raw !== "false") {
      return c.json({ error: "includeArchived must be true or false" }, 400);
    }
    return c.json(manager.list(raw === "true"));
  });
  app.post("/api/workflows", bodyLimit({
    maxSize: WORKFLOW_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "Workflow request is too large" }, 413),
  }), async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, CreateWorkflowSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.create(parsed.data);
    return result.ok ? c.json({ workflow: result.workflow, summary: result.summary }, 201) : workflowFailure(c, result);
  });
  app.get("/api/workflows/:id/versions", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const versions = manager.versions(c.req.param("id"));
    return versions ? c.json(versions) : c.json({ error: "no such workflow" }, 404);
  });
  app.get("/api/workflows/:id/versions/:version", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const versionNumber = Number(c.req.param("version"));
    if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
      return c.json({ error: "version must be a positive integer" }, 400);
    }
    const version = manager.version(c.req.param("id"), versionNumber);
    return version ? c.json(version) : c.json({ error: "no such workflow version" }, 404);
  });
  app.get("/api/workflows/:id", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const detail = manager.get(c.req.param("id"));
    return detail ? c.json(detail) : c.json({ error: "no such workflow" }, 404);
  });
  app.patch("/api/workflows/:id", bodyLimit({
    maxSize: WORKFLOW_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "Workflow request is too large" }, 413),
  }), async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, UpdateWorkflowSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.update(c.req.param("id"), parsed.data);
    return result.ok ? c.json({ workflow: result.workflow, summary: result.summary }) : workflowFailure(c, result, parsed.data.expectedDraftRevision);
  });
  app.delete("/api/workflows/:id", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, ArchiveWorkflowSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.archive(c.req.param("id"), parsed.data.expectedDraftRevision);
    return result.ok ? c.json({ workflow: result.workflow, summary: result.summary }) : workflowFailure(c, result, parsed.data.expectedDraftRevision);
  });
  app.post("/api/workflows/:id/validate", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, ValidateWorkflowSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.validate(c.req.param("id"), parsed.data.expectedDraftRevision);
    if (!result.ok) return workflowFailure(c, result, parsed.data.expectedDraftRevision);
    return result.valid
      ? c.json({ valid: true, diagnostics: result.diagnostics })
      : c.json({ valid: false, diagnostics: result.diagnostics }, 422);
  });
  app.post("/api/workflows/:id/publish", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, PublishWorkflowSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.publish(c.req.param("id"), parsed.data.expectedDraftRevision);
    if (!result.ok && result.reason === "validation") {
      return c.json({ error: "workflow validation failed", code: "workflow_validation", diagnostics: result.diagnostics ?? [] }, 422);
    }
    return result.ok
      ? c.json({ workflow: result.workflow, summary: result.summary, version: result.version, idempotent: result.idempotent })
      : workflowFailure(c, result, parsed.data.expectedDraftRevision);
  });
  app.get("/api/sessions/:id/files", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (!session.cwd) return c.json({ error: "session has no working directory" }, 400);
    try {
      return c.json({ files: await listSessionFiles(session.cwd) });
    } catch (error) {
      const known = error instanceof SessionFileError ? error : null;
      return c.json({ error: known?.message ?? "could not list session files" }, known?.status === 404 ? 404 : 500);
    }
  });
  app.get("/api/sessions/:id/file", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (!session.cwd) return c.json({ error: "session has no working directory" }, 400);
    const parsed = SessionFilePathSchema.safeParse({ path: c.req.query("path") });
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      return c.json(await readSessionFile(session.cwd, parsed.data.path));
    } catch (error) {
      const known = error instanceof SessionFileError ? error : null;
      const status = known?.status === 403 ? 403 : known?.status === 404 ? 404 : 400;
      return c.json({ error: known?.message ?? "could not read session file" }, status);
    }
  });
  app.put(
    "/api/sessions/:id/file",
    bodyLimit({
      // JSON escaping can expand a valid 2 MiB UTF-8 document substantially. The
      // decoded byte cap is rechecked by `saveSessionFile`; this only prevents an
      // unbounded body from being buffered before validation.
      maxSize: MAX_SESSION_EDITOR_BYTES * 6 + 16 * 1024,
      onError: (c) => c.json({ ok: false, error: "file save request is too large" }, 413),
    }),
    async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (!session.cwd) return c.json({ error: "session has no working directory" }, 400);
    const parsed = await parseBody(c, SaveSessionFileSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const result = await saveSessionFile(
        session.cwd,
        parsed.data.path,
        parsed.data.text,
        parsed.data.expectedRevision,
      );
      if (!result.ok && result.status === 409) return c.json(result, 409);
      return c.json(result);
    } catch (error) {
      const known = error instanceof SessionFileError ? error : null;
      const status = known?.status === 403 ? 403 : known?.status === 413 ? 413 : 400;
      return c.json({ ok: false, error: known?.message ?? "could not save session file" }, status);
    }
    },
  );
  app.get("/api/reviews", (c) => c.json(registry.snapshot().reviews));
  app.get("/api/tasks", (c) => c.json(tasks.list()));
  // Git repos under the workspace roots - the pickable bases for a new dispatch.
  app.get("/api/repos", async (c) => c.json(await listRepos()));

  // Resolve a typed path to its canonical git repo root, so the Foreman allowlist
  // picker stores what the server actually gates on (a realpath'd top-level) and
  // rejects a non-repo path instead of letting a typo sit inertly on the list.
  app.post("/api/repos/resolve", async (c) => {
    const parsed = await parseBody(c, ResolveRepoSchema);
    if (!parsed.ok) return parsed.res;
    const repoRoot = await resolveRepoRoot(parsed.data.path);
    if (!repoRoot) return c.json({ error: `not a git repository: ${parsed.data.path}` }, 400);
    return c.json({ repoRoot });
  });
  // Roundup report (/bearings): a projection of the live snapshot, as JSON or a
  // copy-pasteable markdown digest. Localhost reads, like /api/sessions.
  app.get("/api/report", (c) => c.json(buildReport(registry.snapshot())));
  app.get("/api/report.md", (c) => c.text(renderReportMarkdown(buildReport(registry.snapshot()))));
  app.get("/events", sseHandler(registry));
  // Live transcript for the expanded card (localhost-only, like the actions).
  app.get("/api/sessions/:id/transcript/stream", transcriptStreamHandler(registry));
  // One-shot transcript window for a non-streaming reader (Foreman's triage
  // reviewer, and the queue verifier).
  //
  // `?since=<byteOffset>` reads FORWARD from an offset - how the queue scopes a
  // window to one work item. A turn count can't do that: a 48-turn window can span
  // three items, and the head+tail window elides the middle of a big file, so
  // filtering it by timestamp would silently drop an item's earliest turns (the
  // ones that establish what the agent set out to do). The transcript is
  // append-only, so a stored file size is an exact, O(1) item boundary.
  app.get("/api/sessions/:id/transcript", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    // `unavailable` covers every reason there are no turns to serve - a harness declares
    // no conversation capability, or its file hasn't appeared yet - because the readers
    // downstream degrade the same way for all of them: Tier 1 routes UP rather than
    // judging a session it couldn't read.
    const t = sessionMessages(session);
    if (!t) return c.json({ messages: [], truncated: false, unavailable: true });
    const since = Number(c.req.query("since"));
    if (Number.isFinite(since) && since >= 0) return c.json(t.read.since(t.path, since));
    const turns = Number(c.req.query("turns"));
    const tail = Number.isFinite(turns) && turns > 0 ? Math.min(turns, 200) : 48;
    return c.json(t.read.window(t.path, 12, tail));
  });

  // The child's rendered screen - the only place an ask that is BLOCKING on the user
  // exists (see `ReviewInput.pane`). Foreman's reviewer reads it alongside the transcript.
  //
  // Captured on demand rather than served off the poll's snapshot, even though
  // `annotatePaneState` already captures every pane each tick, parsing the mode line and the
  // dialog out of it. A review fires after a settle debounce, so a snapshot would be up to a
  // tick stale - and "stale by one tick" here is not a slightly-old screen, it is the wrong
  // question: the menu the reviewer is about to answer may have replaced the one the poll
  // saw. The cost is one `tmux capture-pane` per review, which is noise beside the
  // `claude -p` it feeds.
  app.get("/api/sessions/:id/pane", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json({ text: await capturePaneText(session) });
  });

  // The transcript's current byte size - the anchor a work item records when it's
  // delivered, so its verify window starts exactly at its first turn.
  app.get("/api/sessions/:id/transcript/size", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const t = sessionMessages(session);
    return c.json({ size: t ? t.read.size(t.path) : null });
  });

  // The repo standards the queue verifier judges an item's diff against.
  //
  // Resolved against the git TOPLEVEL, not the session's cwd: `paths` come from the
  // diff, and git emits those relative to the toplevel wherever it was invoked from.
  // A session sitting in a subdirectory (a monorepo package - the ordinary case)
  // would otherwise look for the root AGENTS.md one level down and resolve every
  // changed path into a directory chain that doesn't exist, quietly loading NO
  // standards at all. Worse, `truncated` would be false, so the prompt wouldn't even
  // print its "some standards docs were omitted" line - the verifier would judge
  // against the repo's main contract without it, and nothing would say so.
  //
  // A POST carrying the paths in its body, though it is a pure read: the list comes
  // from a patch capped at 1.2MB, so as `path=` query params a large refactor's few
  // hundred encoded paths overrun Node's 16KB default `maxHeaderSize` and the request
  // never arrives. The caller degrades that to an empty bundle, which is the exact
  // silent failure the paragraph above is about.
  app.post("/api/sessions/:id/standards", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, StandardsRequestSchema);
    if (!parsed.ok) return parsed.res;
    const root = await repoRootOf(session.cwd);
    return c.json(readStandards(root, parsed.data.paths));
  });

  // Foreman's standing instructions - the prose half of its configuration.
  //
  // GLOBAL, not per-session, because that is what it is: one setting for the operator, not a
  // property of whichever session happens to be under review. It reads the stored value if
  // they have edited it and the shipped `FOREMAN.md` otherwise, so the worker never has to
  // know which of the two it got.
  //
  // A plain string body rather than JSON: the value IS the document, and the settings panel
  // that will edit it wants a textarea, not a wrapper object.
  app.get("/api/foreman/instructions", (c) =>
    c.json({ text: foremanInstructions(), default: defaultForemanInstructions() }),
  );

  // Replace them, or reset to the shipped default. An empty string is a real choice ("judge
  // by your own policy alone") and is stored as such; resetting is a separate action, which
  // is why it is a flag rather than an empty write.
  app.put("/api/foreman/instructions", async (c) => {
    const parsed = await parseBody(c, ForemanInstructionsSchema);
    if (!parsed.ok) return parsed.res;
    const text = parsed.data.reset
      ? resetForemanInstructions()
      : setForemanInstructions(parsed.data.text ?? "");
    return c.json({ text, default: defaultForemanInstructions() });
  });

  // Diff of a session's worktree/branch vs its source branch (localhost read).
  app.get("/api/sessions/:id/diff", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    // `commit` isolates ONE commit (`<sha>^..<sha>`) - what a single no-mistakes
    // fix changed. Distinct from `base`, which diffs from the merge-base and so
    // would answer with everything *since* that sha.
    const commit = c.req.query("commit");
    if (commit) return c.json(await computeCommitDiff(session.cwd, commit));
    const source = c.req.query("base") || undefined;
    return c.json(await computeSessionDiff(session.cwd, source));
  });

  // The context behind one no-mistakes fix: the findings that justified it and
  // the reply that authorized it. Fetched per fix rather than denormalized onto
  // the card - a 22-finding fix carries ~20KB of description text.
  app.get("/api/sessions/:id/nomistakes/fixes/:sha", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (!session.cwd) return c.json({ error: "session has no repo directory" }, 400);
    const detail = await fixDetail(session.cwd, c.req.param("sha"));
    if (!detail) return c.json({ error: "no such fix on this branch" }, 404);
    return c.json(detail);
  });

  const authed = (c: { req: { header: (k: string) => string | undefined } }) =>
    checkToken(c.req.header("x-harness-token"));

  // --- hook ingest (token-guarded) ---
  app.post("/hooks/:event", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "invalid json" }, 400);
    const parsed = HookIngestSchema.safeParse({ ...(body as object), event: c.req.param("event") });
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    registry.applyHook(parsed.data);
    return c.body(null, 204);
  });

  // --- statusLine ingest (token-guarded): Claude's live model / effort / context
  // %, forwarded by hooks/harness-statusline.mjs on every terminal render. ---
  app.post("/statusline", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, StatusLineIngestSchema);
    if (!parsed.ok) return parsed.res;
    registry.applyStatusLine(parsed.data);
    return c.body(null, 204);
  });

  // --- OTLP metrics ingest (token-guarded): Claude Code's own API-equivalent cost
  // arithmetic. It joins Mission Control's Codex estimate in fleet totals while retaining
  // its client-reported provenance on each ledger row.
  // The exporter posts here when the `env` block in ~/.claude/settings.json points
  // `OTEL_EXPORTER_OTLP_ENDPOINT` at the daemon; the path is OTLP's, not ours - the SDK
  // appends `/v1/metrics` to the base. ---
  app.post("/v1/metrics", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, OtlpMetricsSchema);
    if (!parsed.ok) return parsed.res;
    registry.applyOtelMetrics(parsed.data);
    // A JSON body, NOT a 204: the OTel SDK reads a non-JSON 2xx as a partial failure and
    // retries the export, which would double the request volume from every session on
    // the machine while looking, from here, like everything was fine.
    return c.json({});
  });

  // --- MCP review channel (token-guarded) ---
  app.post("/mcp/reviews", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, CreateReviewSchema);
    if (!parsed.ok) return parsed.res;
    const { env, sessionId, cwd, kind, title, body, decisions } = parsed.data;
    const session = registry.findSessionByEnv(env, sessionId, cwd);
    if (!session) return c.json({ error: "no matching session" }, 404);
    const review = reviews.create(session.id, kind, title, body, decisions ?? null);
    return c.json({ id: review.id, sessionId: session.id });
  });

  app.get("/mcp/reviews/:id/wait", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const review = await reviews.wait(c.req.param("id"), WAIT_TIMEOUT_MS);
    if (!review) return c.json({ error: "no such review" }, 404);
    return c.json(review);
  });

  app.post("/mcp/status", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, StatusSchema);
    if (!parsed.ok) return parsed.res;
    registry.applyStatus(parsed.data.env, parsed.data.sessionId, parsed.data.activity);
    return c.body(null, 204);
  });

  // --- review resolution (from the dashboard, localhost) ---
  app.post("/api/reviews/:id/resolve", async (c) => {
    const parsed = await parseBody(c, ResolveReviewSchema);
    if (!parsed.ok) return parsed.res;
    const updated = reviews.resolve(c.req.param("id"), parsed.data.action, parsed.data.response);
    if (!updated) return c.json({ error: "no such review" }, 404);
    return c.json(updated);
  });

  // --- session actions (localhost only) ---
  app.post("/api/sessions/:id/send", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, SendTextSchema);
    if (!parsed.ok) return parsed.res;
    const r = await sendText(session, parsed.data.text, parsed.data.submit);
    return c.json(r, r.ok ? 200 : 500);
  });

  // Answer the option menu a session is showing by selecting a row.
  //
  // A refusal is a 409, not a 500: every way this fails is the pane declining to confirm
  // (no menu on screen, the row moved, the dialog closed under us), which is a state
  // conflict rather than a server fault - and, because the Enter is never pressed, the
  // child is left exactly as it was found. Foreman's client throws on it either way; the
  // distinction is for the human reading the log, who should not be hunting a crash.
  app.post("/api/sessions/:id/select-option", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, SelectOptionSchema);
    if (!parsed.ok) return parsed.res;
    const r = await selectPaneOption(session, parsed.data);
    return c.json(r, r.ok ? 200 : 409);
  });

  // Fill in and send a multi-select `AskUserQuestion`. Separate from select-option because
  // pressing a row of one of these answers nothing - it ticks a box, and the answers reach
  // Claude only when the form's Submit tab is confirmed (see `submitPaneForm`).
  //
  // 409 on refusal for the same reason as above: every failure is the pane declining, and
  // the walk stops before the send rather than half-way through it.
  app.post("/api/sessions/:id/submit-options", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, SubmitOptionsSchema);
    if (!parsed.ok) return parsed.res;
    const r = await submitPaneForm(session, parsed.data.options);
    return c.json(r, r.ok ? 200 : 409);
  });

  // Rename the session's tmux session / wezterm tab; discovery reads the new name
  // back onto the card, and the registry echoes it immediately so it doesn't lag a
  // poll. A name the backing handle can't accept, or one a task's teardown still
  // aims at, is a 400 the editor can show; a shelled-out failure a 500.
  app.post("/api/sessions/:id/rename", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, RenameSchema);
    if (!parsed.ok) return parsed.res;
    const valid = validateSessionName(session, parsed.data.name);
    if (!valid.ok) return c.json({ ok: false, error: valid.error }, 400);
    const free = validateSessionNameAgainstTasks(session, valid.name, registry.listTasks());
    if (!free.ok) return c.json({ ok: false, error: free.error }, 400);
    const r = await rename(session, valid.name);
    if (r.ok) registry.renameSession(session.id, valid.name);
    return c.json(r, r.ok ? 200 : 500);
  });

  // Deliver a whole prompt as ONE submission (bracketed paste), unlike /send's
  // literal send-keys where every embedded newline submits. This is the only way
  // to deliver a multi-line intent or a bulleted gap list at all.
  //
  // Mirrors /send's contract exactly - `c.json(r, r.ok ? 200 : 500)` - so the
  // client genuinely throws on failure. That's what lets the worker write
  // `awaiting_pickup` only AFTER the inject resolves (the send-first-then-stamp
  // discipline applyVerdict already encodes).
  // The response carries `pasted`, which is what lets the worker tell a delivery
  // that never happened (retryable) from one that may be sitting unsubmitted in the
  // pane (must not be retyped over). Every refusal below reports it too, since
  // rejecting a request outright is the one case where we KNOW nothing was typed.
  // It also carries `paneBlocked` when a pane in a tmux mode refused the write, which
  // is what stops the worker charging an attempt for a human reading their scrollback.
  // Both ride along on the ActionResult itself, so neither can be forgotten here.
  app.post("/api/sessions/:id/inject", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session", pasted: false }, 404);
    // `parseBody`'s generic 400 carries no `pasted`, and the client reads a MISSING
    // field as "may have landed" (absence of evidence is not evidence - see
    // InjectError). That default is right everywhere else and exactly wrong here: a
    // rejected body never reached tmux, so reporting the refusal without the field
    // terminally escalates the item ("Foreman couldn't tell whether this reached the
    // pane", no undo) instead of taking the clean re-queue. Say what we know.
    const parsed = await parseBody(c, InjectPromptSchema);
    if (!parsed.ok) return c.json({ error: parsed.error, pasted: false }, 400);
    const r = await injectPrompt(session, parsed.data.text);
    // Only once it landed: a refused or failed delivery is not a turn anybody will read,
    // and claiming it would mis-attribute a LATER turn that happens to repeat the text.
    if (r.ok && parsed.data.origin !== "human") recordInjection(session.id, parsed.data.text, parsed.data.origin);
    return c.json(r, r.ok ? 200 : 500);
  });

  // Park a dropped image on disk and hand back its path, which the caller pastes
  // into a prompt for the agent to read - the same trick a terminal plays when you
  // drag a file onto it, and the only one available when the last hop is a pty.
  //
  // Not bound to a session: the dispatch modal drops images before a session
  // exists, and an upload is inert until a path is typed somewhere, so scoping it
  // to a session would buy nothing.
  //
  // The response is a path this daemon just wrote inside its own state dir, never
  // one the client named - the request supplies bytes and a display name, and
  // `saveImageUpload` decides where they land. That, plus the sniff (bytes must
  // BE an image, whatever the client claims) and the loopback guard above, is what
  // keeps "write a file the agent will act on" from being a wider door than /send.
  //
  // `bodyLimit` runs first so an oversized request is refused while it's still a
  // stream - `formData()` would otherwise buffer the whole thing into memory before
  // anyone could object to its size. The slack over the cap covers the multipart
  // envelope (boundaries, headers) wrapping the bytes; the route re-checks the
  // decoded part below, which is what lets the refusal talk about the IMAGE's size
  // rather than the request's.
  app.post(
    "/api/uploads",
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES + 64 * 1024,
      onError: (c) => c.json({ error: `image is larger than ${TOO_BIG_MB}MB` }, 413),
    }),
    async (c) => {
      const form = await c.req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) return c.json({ error: "expected a `file` part" }, 400);
      if (file.size > MAX_UPLOAD_BYTES) {
        return c.json({ error: `image is larger than ${TOO_BIG_MB}MB` }, 413);
      }
      try {
        const saved = saveImageUpload(new Uint8Array(await file.arrayBuffer()), file.name);
        return c.json(saved);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  );

  app.post("/api/sessions/:id/focus", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const r = await focus(session);
    return c.json(r, r.ok ? 200 : 500);
  });

  app.post("/api/sessions/:id/kill", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const r = await kill(session);
    return c.json(r, r.ok ? 200 : 500);
  });

  // Cycle the session's permission mode one Shift+Tab step - only for a harness that
  // declares `permissionModes`.
  app.post("/api/sessions/:id/mode/cycle", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const refusal = noPermissionModes(session);
    if (refusal) return c.json({ error: refusal }, 400);
    const r = await cyclePermissionMode(session);
    // `r.mode` was read back off the pane, so recording it can't diverge from
    // what Claude actually did; it's null when the pane didn't show us a mode.
    if (r.ok) registry.recordObservedPermissionMode(session.id, r.mode ?? null);
    return c.json(r, r.ok ? 200 : 500);
  });

  // Drive the session to a specific permission mode. Walks the Shift+Tab cycle,
  // verifying against the pane at each step; see `setPermissionMode` for why the
  // distance can't just be computed.
  app.post("/api/sessions/:id/mode", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const refusal = noPermissionModes(session);
    if (refusal) return c.json({ error: refusal }, 400);
    const parsed = await parseBody(c, SetPermissionModeSchema);
    if (!parsed.ok) return parsed.res;
    const r = await setPermissionMode(session, parsed.data.mode);
    // Record on failure too: a walk that stops early still leaves the session in a
    // mode we observed, and the chip should show where it actually ended up.
    registry.recordObservedPermissionMode(session.id, r.mode ?? null);
    return c.json(r, r.ok ? 200 : 409);
  });

  app.post("/api/sessions/:id/effort", async (c) => {
    const sessionId = c.req.param("id");
    if (!registry.getSession(sessionId)) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, SetSessionEffortSchema);
    if (!parsed.ok) return parsed.res;
    const session = registry.getSession(sessionId);
    if (!session) return c.json({ error: "no such session" }, 404);
    const baseline = readRuntimeEffortBaseline(session);
    if (baseline === undefined) {
      return c.json({
        ok: false,
        error: "the session's passive effort baseline is not ready; no setting was changed",
        effort: null,
      }, 409);
    }
    if (!registry.recordRuntimeEffortBaseline(session.id, baseline, session)) {
      return c.json({
        ok: false,
        error: "the session changed before its effort baseline could be recorded",
        effort: null,
      }, 409);
    }
    const r = await setSessionEffort(session, parsed.data.effort, {
      ...defaultPaneDeps,
      assertBeforeWrite: () => {
        const current = registry.getSession(session.id);
        return current?.agent === session.agent &&
          current.agentSessionId === session.agentSessionId &&
          current.transcriptPath === session.transcriptPath;
      },
    });
    if (r.ok && !registry.recordObservedSessionEffort(session.id, r.effort, session)) {
      return c.json({
        ok: false,
        error: "the live effort changed, but the session identity changed before it could be published",
        effort: null,
      }, 409);
    }
    return c.json(r, r.ok ? 200 : 409);
  });

  // Preview what a reset-to-origin would discard (fetches origin; localhost read).
  app.get("/api/sessions/:id/reset/preview", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json(await resetPreview(session));
  });

  // Pull latest and hard-reset the checkout to origin's default branch, then
  // clear the agent's context. The UI confirms (with the loss preview) first.
  app.post("/api/sessions/:id/reset", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, ResetSchema);
    if (!parsed.ok) return parsed.res;
    // The git reset AND every piece of session-scoped state that described the work it
    // discarded - see `resetSession`, which `TaskManager.assign` shares.
    const r = await resetSession(registry, session, parsed.data.clear);
    return c.json(r, r.ok ? 200 : 500);
  });

  // Answer a no-mistakes gate (approve / fix / skip) for the session's repo.
  app.post("/api/sessions/:id/nomistakes/respond", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (!session.cwd) return c.json({ error: "session has no repo directory" }, 400);
    const parsed = await parseBody(c, NomistakesRespondSchema);
    if (!parsed.ok) return parsed.res;
    // The "you typed this" byline. Recorded HERE rather than inside `respond()`
    // because this route is what the claim actually means: `respond()` is a helper
    // keyed by cwd that anything could call, while a POST to this route is by
    // definition the dashboard's Fix box. It's also the only side holding a session
    // and its live run.
    //
    // Only for `fix`: `approve`/`skip` commit nothing, so they have no fix to put a
    // byline on.
    //
    // Written BEFORE the decision goes out and RETRACTED if it doesn't land, rather
    // than written once we know. The ordering is load-bearing, not an optimisation:
    // `axi respond` blocks server-side until the run reaches the next gate or an
    // outcome, so by the time it settles the fix it authorized is already committed -
    // a byline stamped then would date from after that commit, and `pickGateReply`'s
    // causality filter would discard it. Logging on the way out is the only way the
    // row's `ts` can precede the fix it explains; the alternative silently deletes
    // the whole "you" lane.
    const gate = session.nomistakes;
    const step = parsed.data.step || gate?.gateStep;
    const rowId =
      parsed.data.action === "fix" && gate && step
        ? stakeYourByline(session, gate, step, parsed.data)
        : null;

    const r = await nomistakesRespond(registry, session.cwd, parsed.data.action, {
      ...parsed.data,
      runId: gate?.id,
      step: step ?? undefined,
      // Undelivered is un-authored. The gate the user answered may be one the run has
      // already moved past (status is polled, so the Fix box can be ~seconds stale),
      // and `axi respond` then exits non-zero having said nothing. Left behind, that
      // row would sign whatever the agent later decided for itself through the
      // `/no-mistakes` skill - stamping "by you, in the dashboard" on an autonomous
      // fix, which is the feature's own distinction inverted, in its worst direction.
      //
      // KNOWN LIMITATION: only the LOUD failure is compensated. `axi` exiting 0 while
      // no-opping on an already-decided gate leaves a row nothing here can tell from a
      // delivered one, so that byline stands. Guessing at it would reintroduce exactly
      // the misattribution this closes.
      onUndelivered: rowId === null ? undefined : () => retractByline(rowId),
    });
    // Rejected before anything was spawned (no binary, or a decision already in
    // flight): the gate heard nothing, so the same retraction applies.
    if (!r.ok && rowId !== null) retractByline(rowId);
    return c.json(r, r.ok ? 200 : 409);
  });

  // Record a Foreman gate nudge, for the fix log's byline. Loopback-gated like
  // every /api route: the worker is a separate process with no DB access of its own.
  app.post("/api/sessions/:id/gate-reply", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, GateReplySchema);
    if (!parsed.ok) return parsed.res;
    try {
      logGateReply({
        sessionId: session.id,
        ts: Date.now(),
        source: "foreman",
        runId: parsed.data.runId,
        step: parsed.data.step,
        findingIds: parsed.data.findingIds,
        text: parsed.data.text || null,
      });
    } catch (err) {
      // Fail soft, like every other byline write (stakeYourByline, retractByline,
      // attribute, the prune). A byline is never worth an error to its caller: the
      // foreman's reply is already delivered by the time it posts this, so a DB
      // failure must cost the byline and nothing else. 500ing here would be the one
      // write in the feature that breaks that posture.
      console.error("[nomistakes] could not record the foreman gate reply:", err);
    }
    return c.json({ ok: true });
  });

  // --- Foreman session notes (localhost only) ---
  // Full note incl. handledMarker, for the worker's idempotency check.
  app.get("/api/sessions/:id/note", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json(registry.getNote(session.id));
  });

  app.put("/api/sessions/:id/note", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, SetNoteSchema);
    if (!parsed.ok) return parsed.res;
    const note = registry.upsertNote(session.id, parsed.data);
    if (!note) return c.json({ error: "no such session" }, 404);
    return c.json(note);
  });

  // --- Foreman episodes: the append-only record behind the note ---

  // Written by the worker (a separate process with no DB access of its own) once it
  // has acted, carrying the context it is about to drop - above all the pane, which
  // for a terminal ask is the only copy of the question that ever exists.
  app.post("/api/sessions/:id/foreman-episode", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, RecordEpisodeSchema);
    if (!parsed.ok) return parsed.res;
    try {
      registry.recordEpisode(session.id, parsed.data);
    } catch (err) {
      // Fail soft, on the same reasoning as the gate byline above: by the time the
      // worker posts this it has already delivered its answer and stamped the note.
      // The episode is the audit trail for an act that already happened, so a DB
      // failure must cost the record and nothing else - 500ing would make the worker
      // log an error for work that succeeded.
      console.error("[foreman] could not record the episode:", err);
    }
    return c.json({ ok: true });
  });

  // Stamped by the dashboard when the human answers an episode Foreman left open.
  app.post("/api/sessions/:id/foreman-episode/resolve", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, ResolveEpisodeSchema);
    if (!parsed.ok) return parsed.res;
    try {
      registry.resolveEpisode(session.id, parsed.data);
    } catch (err) {
      console.error("[foreman] could not stamp the episode:", err);
    }
    return c.json({ ok: true });
  });

  app.get("/api/sessions/:id/foreman-episodes", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json(registry.listEpisodes(session.id));
  });

  // --- Foreman session work queues (localhost only) ---
  app.get("/api/sessions/:id/queue", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json(queues.get(session.id));
  });

  app.post("/api/sessions/:id/queue", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, AddWorkItemSchema);
    if (!parsed.ok) return parsed.res;
    const item = queues.add(session.id, parsed.data.intent);
    // The session resolved above, so a refusal is a capability or hook-authorization
    // answer rather than "no such session". Compose it from the same policy the panel
    // reads so the write boundary cannot drift from its presentation.
    if (!item) {
      return c.json(
        { error: workQueueBlockedReason(session) ?? "could not create work queue" },
        409,
      );
    }
    return c.json(item);
  });

  // Edit: 409 on a CAS miss or an item that has left queued/proposed - Foreman may
  // already have typed it into a pane, and "edited" would then be a lie.
  app.patch("/api/sessions/:id/queue/:itemId", async (c) => {
    const owned = ownedItem(registry, queues, c);
    if (!owned.ok) return owned.res;
    const parsed = await parseBody(c, EditWorkItemSchema);
    if (!parsed.ok) return parsed.res;
    const r = queues.edit(owned.item.id, parsed.data.intent, parsed.data.revision);
    if (r.ok) return c.json(r.item);
    return c.json({ error: r.error }, r.error === "no such item" ? 404 : 409);
  });

  app.delete("/api/sessions/:id/queue/:itemId", (c) => {
    const owned = ownedItem(registry, queues, c);
    if (!owned.ok) return owned.res;
    const r = queues.remove(owned.item.id);
    return c.json(r, r.ok ? 200 : r.error === "no such item" ? 404 : 409);
  });

  app.put("/api/sessions/:id/queue/order", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, ReorderQueueSchema);
    if (!parsed.ok) return parsed.res;
    const r = queues.reorder(session.id, parsed.data.ids);
    return c.json(r, r.ok ? 200 : 409);
  });

  app.post("/api/sessions/:id/queue/:itemId/approve", (c) => {
    const owned = ownedItem(registry, queues, c);
    if (!owned.ok) return owned.res;
    const r = queues.approve(owned.item.id);
    return c.json(r, r.ok ? 200 : r.error === "no such item" ? 404 : 409);
  });

  app.put("/api/sessions/:id/queue/:itemId/state", async (c) => {
    const owned = ownedItem(registry, queues, c);
    if (!owned.ok) return owned.res;
    const parsed = await parseBody(c, SetWorkItemStateSchema);
    if (!parsed.ok) return parsed.res;
    const r = queues.setState(owned.item.id, parsed.data);
    if (r.ok) return c.json(r.item);
    // 409, not 500: a single-flight refusal means the caller broke the invariant,
    // and it must be able to tell that from the daemon falling over.
    return c.json({ error: r.error }, r.error === "no such item" ? 404 : 409);
  });

  // Stamp delivery. Separate from /state because `sentAt` is the daemon's clock,
  // not the worker's: the pickup guard compares it against `lastActivity`, which
  // the registry stamps from the hook payload, so the two must share a writer.
  app.post("/api/sessions/:id/queue/:itemId/sent", async (c) => {
    const owned = ownedItem(registry, queues, c);
    if (!owned.ok) return owned.res;
    const parsed = await parseBody(c, MarkItemSentSchema);
    if (!parsed.ok) return parsed.res;
    const r = queues.markSent(owned.item.id, parsed.data.baseSha, parsed.data.transcriptAnchor);
    if (r.ok) return c.json(r.item);
    return c.json({ error: r.error }, r.error === "no such item" ? 404 : 409);
  });

  // Adopt an item a restart left mid-send (see QueueManager.recover).
  app.post("/api/sessions/:id/queue/:itemId/recover", (c) => {
    const owned = ownedItem(registry, queues, c);
    if (!owned.ok) return owned.res;
    const r = queues.recover(owned.item.id);
    if (r.ok) return c.json(r.item);
    return c.json({ error: r.error }, r.error === "no such item" ? 404 : 409);
  });

  // The human's answer to the drain-time ask.
  app.put("/api/sessions/:id/queue/wrapup", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const queue = queues.get(session.id);
    if (!queue) return c.json({ error: "no queue for this session" }, 404);
    const parsed = await parseBody(c, WrapupSchema);
    if (!parsed.ok) return parsed.res;
    queues.setWrapupAnswer(queue.noteKey, parsed.data.answer);
    return c.json(queues.get(session.id));
  });

  // The worker's "I've raised the ask" stamp - what makes it fire exactly once.
  // Separate from the answer above because they have different writers: this is
  // Foreman recording that it asked, that is the human recording what they said.
  //
  // `ensureQueue` rather than a 404 on a missing row, because the `prompted` trigger
  // fires on sessions that have NO work queue - that is its entire premise - and the
  // Ship it? card it raises renders off `wrapupAskedAt` on the queue row. Without a
  // row to stamp there is nowhere for the ask to live and the trigger would verify the
  // work, decide to ask, and then silently drop the question. Creating the row is not a
  // side effect being smuggled in: `ensureQueue` writes cwd/branch and nothing else, an
  // itemless queue renders no item list, and `addItem` already creates one this way.
  app.post("/api/sessions/:id/queue/wrapup/asked", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, WrapupAskedSchema);
    if (!parsed.ok) return parsed.res;
    const key = registry.ensureQueue(session.id);
    if (!key) return c.json({ error: "no queue for this session" }, 404);
    queues.markWrapupAsked(key, undefined, { clearAnswer: parsed.data.clearAnswer });
    return c.json(queues.get(session.id));
  });

  // The `prompted` trigger's once-per-episode stamp: the goal it last fired (or held)
  // on. A separate endpoint from the two above because it is a separate guard on a
  // separate trigger - see `SessionQueue.promptedGoal` for why they must not share a
  // field. Same `ensureQueue` reasoning: these sessions have no queue by definition.
  app.post("/api/sessions/:id/queue/wrapup/prompted", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, PromptedWrapupSchema);
    if (!parsed.ok) return parsed.res;
    const key = registry.ensureQueue(session.id);
    if (!key) return c.json({ error: "no queue for this session" }, 404);
    registry.setQueueWrapup(key, { promptedGoal: parsed.data.goal });
    return c.json(queues.get(session.id));
  });

  // The full goal record, including the verbatim prompt the refiner derived from.
  // Loopback-only like the rest of the worker's surface: `SessionGoal.prompt` is
  // deliberately never denormalized onto a card (it can be 4KB of someone's paste),
  // so this is the only way the out-of-process worker can read the ask it needs to
  // verify work against.
  app.get("/api/sessions/:id/goal", (c) => {
    const goal = registry.getGoal(c.req.param("id"));
    if (!goal) return c.json({ error: "no goal for this session" }, 404);
    return c.json(goal);
  });

  // Re-attach an orphaned queue onto this live session. Always an explicit click:
  // a different agent at the same cwd may be doing something else entirely.
  app.post("/api/sessions/:id/queue/reattach", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, ReattachQueueSchema);
    if (!parsed.ok) return parsed.res;
    const blocked = workQueueBlockedReason(session);
    if (blocked) return c.json({ error: blocked }, 409);
    const r = queues.reattach(parsed.data.noteKey, session.id);
    return c.json(r, r.ok ? 200 : 409);
  });

  // Cross-session: queues with no live session at all, so nothing is stranded with
  // no surface whatsoever (the cwd-match hint only covers a queue whose cwd still
  // has a live session on it).
  app.get("/api/queues", (c) =>
    c.json(c.req.query("orphaned") === "1" ? queues.orphaned() : queues.list()),
  );

  /*
    The same write, addressed by QUEUE KEY - the orphan sweep's route.

    It exists because the session-scoped routes above now insist the session
    resolves, and the sweep's whole subject is a queue whose session is GONE: it
    terminalizes the in-flight item of a queue nothing can drive any more, so there
    is no `:id` for it to name. It previously borrowed the session route by passing
    the note key as the session id, which worked only because that route ignored the
    segment entirely - i.e. the sweep was relying on the very bug that let any tab
    write to any queue.

    Ownership is checked the same way, against the key the caller named.
  */
  app.put("/api/queues/:key/items/:itemId/state", async (c) => {
    const item = queues.getItem(c.req.param("itemId"));
    if (!item) return c.json({ error: "no such item" }, 404);
    if (item.noteKey !== c.req.param("key")) {
      return c.json({ error: "that item is not in this queue" }, 404);
    }
    const parsed = await parseBody(c, SetWorkItemStateSchema);
    if (!parsed.ok) return parsed.res;
    const r = queues.setState(item.id, parsed.data);
    if (r.ok) return c.json(r.item);
    return c.json({ error: r.error }, r.error === "no such item" ? 404 : 409);
  });

  // --- Foreman config + status (localhost only) ---
  app.get("/api/foreman/config", (c) => c.json(getForemanConfig()));
  app.put("/api/foreman/config", async (c) => {
    const parsed = await parseBody(c, ForemanConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    return c.json(setForemanConfig(parsed.data));
  });
  app.get("/api/foreman/status", (c) => c.json(foremanStatus(registry)));

  // --- backlog autopilot: Foreman's reading of the backlog (localhost only) ---
  //
  // Written by the worker (which never touches the DB) and read by the board. `null`
  // rather than a 404 for "no plan yet": the absence of a plan is the ordinary starting
  // state, not an error, and both readers already branch on it.
  app.get("/api/backlog/plan", (c) => c.json(getBacklogPlan()));
  app.put("/api/backlog/plan", async (c) => {
    const parsed = await parseBody(c, BacklogPlanSchema);
    if (!parsed.ok) return parsed.res;
    return c.json(setBacklogPlan(parsed.data));
  });

  // --- Away mode (localhost only) ---
  app.get("/api/away", (c) => c.json(getAwayConfig()));
  app.put("/api/away", async (c) => {
    const parsed = await parseBody(c, AwayConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    const next = setAwayConfig(parsed.data);
    // Close the window synchronously on return: the poll tick is up to AWAY_POLL_MS
    // behind, and the client's follow-up digest read would otherwise beat it.
    if (!next.away) away?.flush();
    return c.json(next);
  });

  /** Currently-stalled sessions. Empty when stall detection is off. */
  app.get("/api/away/stalls", (c) => c.json(away?.stalls() ?? []));

  /**
   * The return digest, read once. 204 when there is nothing to report - either you
   * were never away, or nothing happened while you were, and a digest that says "0
   * finished" is a notification that says nothing.
   */
  app.get("/api/away/digest", async (c) => {
    const buf = away?.takePending();
    if (!buf) return c.body(null, 204);
    const digest = await buildDigest(buf, Date.now());
    if (digest.empty) return c.body(null, 204);
    return c.json(digest);
  });

  // A LEASED heartbeat: acquires when free/expired, renews when already ours, and
  // reports leader:false otherwise. The old bare heartbeat was one module-global
  // timestamp that couldn't detect a second worker at all - it just got beaten
  // twice, and both workers would draacross the sessions.
  app.post("/api/foreman/heartbeat", async (c) => {
    const parsed = await parseBody(c, ForemanHeartbeatSchema);
    if (!parsed.ok) return parsed.res;
    return c.json(claimForemanLease(parsed.data.workerId));
  });

  // A leader handing the lease back on a clean shutdown, so a standby takes over
  // at once rather than waiting out the TTL. Best-effort by nature: a crash just
  // lets the lease expire, which is exactly what the TTL is for.
  app.post("/api/foreman/heartbeat/release", async (c) => {
    const parsed = await parseBody(c, ForemanHeartbeatSchema);
    if (!parsed.ok) return parsed.res;
    releaseForemanLease(parsed.data.workerId);
    return c.body(null, 204);
  });

  // --- custom skills: the catalog + what's switched on (localhost only) ---

  /**
   * The whole panel in one read: the catalog, what's enabled, how many sessions are
   * behind, and anything the reconciler refused.
   *
   * One route rather than a config/status pair, because unlike Foreman there is no
   * second consumer - the worker process doesn't read this - and the two halves are
   * only ever rendered together. A split would be two polls to draw one panel.
   */
  const skillsView = (): SkillsView => {
    const cfg = getSkillsConfig();
    const catalog = readCatalog();
    return {
      enabled: cfg.enabled,
      skills: catalog.skills.map((s) => ({ ...s, enabled: cfg.skills[s.id] === true })),
      pending: pendingReloads(registry.snapshot().sessions, getSkillsAcks(), cfg),
      // Catalog problems plus a fresh look at the DISK. The drift check is what keeps a
      // failed STARTUP reconcile from being invisible: its problems had no PUT to answer,
      // so they went to a console nobody reads, and every toggle would render on while
      // the sessions had none of them.
      problems: [...catalog.problems, ...skillDrift(cfg, catalog)],
    };
  };

  app.get("/api/skills", (c) => c.json(skillsView()));

  /**
   * Reconcile, then persist - both inside `applySkillsConfig`, so this route cannot
   * do one without the other.
   *
   * The patch schema accepts only `enabled` and `skills`. The generation is the
   * server's watermark, and a client that could set it could either silence every
   * session's reload (set it back) or type into every pane on the machine at will (set
   * it forward). Excluding it at the boundary beats trusting the route.
   *
   * 409 on `refused` and NOT on `problems`, which is the difference between "your
   * toggle didn't work" and "something else is wrong". A reconcile pass reports on every
   * enabled skill, so `problems` is routinely non-empty for reasons the caller had
   * nothing to do with - one skill dropped from the catalog by a `git pull` says so on
   * every pass, forever. 409ing on that turned a toggle that had fully applied into
   * "nothing changed" in the panel, reverted the switch, and let the next poll flip it
   * back on - and wedged every other toggle the same way. Those problems reach the
   * operator through the view, which reports them continuously anyway.
   */
  app.put("/api/skills/config", async (c) => {
    const parsed = await parseBody(c, SkillsConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    const synced = applySkillsConfig(parsed.data);
    if (synced.refused.length > 0) return c.json({ error: synced.refused.join("; ") }, 409);
    return c.json(skillsView());
  });

    // --- Inspector: automated review of the PRs Mission Control opened ---
  app.get("/api/inspector/config", (c) => c.json(getInspectorConfig()));
  app.put("/api/inspector/config", async (c) => {
    const parsed = await parseBody(c, InspectorConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    const next = setInspectorConfig(parsed.data);
    // The per-session chip bakes `mode` in when the summary is resolved, and the tick
    // that would otherwise re-resolve it only runs while the feature is ENABLED. Without
    // this, flipping live -> dry-run leaves every card claiming the last review was
    // posted publicly, and flipping enabled -> off freezes the chips in whatever mode
    // was in force, indefinitely. This chip's whole job is that distinction.
    registry.refreshInspections();
    return c.json(next);
  });
  // The ledger, newest first. This is what makes dry-run legible: without somewhere to
  // read what it WOULD have said, a preview mode is indistinguishable from a broken one.
  // Capped because it is a display; the registry's copy is deliberately not.
  app.get("/api/inspector/prs", (c) => c.json(loadInspectorInspections(50)));
  // What the Inspector will actually spawn with, resolved HERE rather than in the panel
  // for the reason `ForemanStatus.models` documents: the env layer is invisible to the
  // browser, so a panel showing `config || default` would confidently print a model a
  // `MISSION_INSPECTOR_MODEL` in the daemon's environment is overriding.
  app.get("/api/inspector/status", (c) =>
    c.json({ model: inspectorModel() } satisfies InspectorStatus),
  );

  // --- LLM: which provider does the app's own offline work, and on which model ---
  //
  // The runner is app-wide; the models here are the DAEMON's own background jobs. Foreman's
  // four roles and the Inspector's one keep their own routes and their own blobs, because
  // each is edited by the panel that owns that subsystem - a second writer would turn a
  // per-key merge into a lost update.
  app.get("/api/llm/config", (c) => c.json(getLlmConfig()));
  app.put("/api/llm/config", async (c) => {
    const parsed = await parseBody(c, LlmConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    const config = setLlmConfig(parsed.data);
    // Personas without a provider override follow this setting. Refresh their top-level SSE
    // projections in the same mutation so the editor never advertises a stale effective model.
    if ("runner" in parsed.data) personas?.refreshExecution();
    return c.json(config);
  });
  // Resolved HERE rather than in the panel, for the reason `ForemanStatus.models` documents:
  // the env layer is invisible to the browser, so a panel showing `config || default` would
  // confidently print a model a `MISSION_GOAL_MODEL` in the daemon's environment is
  // overriding. The Foreman worker reads its runner off this route too - it is a separate
  // process and never touches the DB.
  app.get("/api/llm/status", (c) => c.json(llmStatus() satisfies LlmStatus));

  // --- Shipping: YOLO mode, which merges the clean ones ---
  //
  // The ledger this panel reads is the Inspector's (`/api/inspector/prs` above), because
  // it is the same ledger: a PR's merge block lives on the row that says we opened it.
  // Only the config is separate, and it is separate because the grant is.
  app.get("/api/shipping/config", (c) => c.json(getShippingConfig()));
  app.put("/api/shipping/config", async (c) => {
    const parsed = await parseBody(c, ShippingConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    return c.json(setShippingConfig(parsed.data));
  });

  // --- Harnesses: dispatch-time defaults for launched sessions (localhost only) ---
  app.get("/api/harnesses/config", (c) => c.json(getHarnessesConfig()));
  app.put("/api/harnesses/config", async (c) => {
    const parsed = await parseBody(c, HarnessesConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    return c.json(setHarnessesConfig(parsed.data));
  });

  // --- Task sources: pulling work INTO the backlog from systems that already hold it ---
  //
  // Every route here files into the backlog and nothing else. Nothing dispatches, nothing
  // provisions, and nothing types into a pane - see `src/shared/task-source.ts`.

  /** The whole panel in one read: what is configured, how it is doing, what is on offer. */
  const taskSourcesView = (): TaskSourcesView => {
    const cfg = getTaskSourcesConfig();
    return {
      sources: cfg.sources,
      status: taskSourceStatuses(cfg.sources),
      kinds: taskSourceKinds(),
    };
  };

  app.get("/api/task-sources/config", (c) => c.json(taskSourcesView()));

  /**
   * Replace the configured set.
   *
   * Each source's repo is resolved to a git root here, the same way `POST /api/tasks`
   * resolves one, so a typo cannot enter a config that then files tasks against a path
   * that is not a checkout - which the dispatcher would only discover much later, with a
   * worktree half cut and nobody watching.
   */
  app.put("/api/task-sources/config", async (c) => {
    const parsed = await parseBody(c, TaskSourcesConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    const sources = [];
    for (const s of parsed.data.sources) {
      const repoRoot = await resolveRepoRoot(s.repoRoot);
      if (!repoRoot) return c.json({ error: `not a git repository: ${s.repoRoot}` }, 400);
      sources.push({ ...s, repoRoot });
    }
    const before = getTaskSourcesConfig();
    setTaskSourcesConfig({ sources });
    noteTaskSourceConfigChange(before.sources, sources);
    return c.json(taskSourcesView());
  });

  /**
   * Sweep now, and say what it filed.
   *
   * Runs whether or not the source is ENABLED: the switch governs the background loop,
   * and being able to sweep a source once by hand before turning it loose is the whole
   * way to find out what it would do.
   */
  app.post("/api/task-sources/:id/sweep", async (c) => {
    const inst = taskSourceById(c.req.param("id"));
    if (!inst) return c.json({ error: "no such task source" }, 404);
    return c.json(await sweepOnce(inst, tasks));
  });

  // "Is this actually going to work?" - the question an empty sweep cannot answer.
  app.post("/api/task-sources/:id/preflight", async (c) => {
    const inst = taskSourceById(c.req.param("id"));
    if (!inst) return c.json({ error: "no such task source" }, 404);
    const problem = await preflightOnce(inst);
    return c.json({ ok: problem === null, problem });
  });

  // Forget what this source has filed, so it can file it again. The deliberate act that
  // answers "a task you deleted stays deleted" - and the only thing that undoes it.
  app.delete("/api/task-sources/:id/seen", (c) => {
    const id = c.req.param("id");
    if (!taskSourceById(id)) return c.json({ error: "no such task source" }, 404);
    return c.json({ forgotten: forgetTaskSourceSeen(id) });
  });

  // --- Dashboard UI preferences (localhost only) ---
  //
  // Layout, keybindings, alert delivery, rich text. The daemon only stores these; nothing
  // server-side reads them. They are here because `localStorage` is per-ORIGIN and per
  // Electron profile, and a rename moved both out from under the operator - see
  // docs/plans/ui-settings-to-daemon/plan.md.
  // The GET carries `configured` alongside the config because an unset key parses to the
  // defaults, and the dashboard's one-time adoption of pre-rename `localStorage` MUST NOT
  // fire against a config the operator already has.
  app.get("/api/ui/config", (c) => c.json(uiConfigView()));
  app.put("/api/ui/config", async (c) => {
    const parsed = await parseBody(c, UiConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    setUiConfig(parsed.data);
    return c.json(uiConfigView());
  });

  // --- Cost telemetry config (localhost only) ---
  //
  // The GET reports what is actually in `~/.claude/settings.json` alongside the stored
  // intent, because those genuinely diverge (a hand-edited file, an install from another
  // checkout) and a panel showing only the intent would be confidently wrong.
  app.get("/api/cost/config", (c) => c.json(costTelemetryStatus()));
  app.put("/api/cost/config", async (c) => {
    const parsed = await parseBody(c, CostConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    // 409 rather than 500: every way this fails is the user's settings file being
    // unwritable or unparseable - a state they can see and fix, not a daemon fault.
    try {
      setCostConfig(parsed.data);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
    return c.json(costTelemetryStatus());
  });

  // --- dispatch: launch/queue agents (localhost only) ---
  app.post("/api/tasks", async (c) => {
    const parsed = await parseBody(c, DispatchSchema);
    if (!parsed.ok) return parsed.res;
    const repoRoot = await resolveRepoRoot(parsed.data.repoRoot);
    if (!repoRoot) return c.json({ error: `not a git repository: ${parsed.data.repoRoot}` }, 400);
    const task = tasks.create({ ...parsed.data, repoRoot });
    return c.json(task);
  });

  // Edit a task. A repo change is resolved the same way `POST /api/tasks` resolves one,
  // so a task cannot be edited into pointing at a path that is not a git root - the
  // dispatcher would only discover that much later, with a worktree half cut. Refusals
  // mirror `assign`: 404 for a task that is gone, 409 for one that has left the backlog
  // and can no longer be REWRITTEN - though a priority/labels-only patch is annotation
  // and stays allowed in any status (see `TaskManager.update`).
  app.post("/api/tasks/:id/update", async (c) => {
    const parsed = await parseBody(c, UpdateTaskSchema);
    if (!parsed.ok) return parsed.res;
    const patch = parsed.data;
    const id = c.req.param("id");
    // Resolved only when the repo actually MOVES. A caller restating the root it was
    // handed is not asking for anything, and re-checking it makes a task uneditable the
    // moment its repo goes away - a reclaimed worktree, a directory since renamed - so a
    // priority change would be refused on the strength of a path the edit never touched,
    // under an error message about git that names neither the field nor the task.
    if (patch.repoRoot !== undefined && patch.repoRoot !== tasks.get(id)?.repoRoot) {
      const resolved = await resolveRepoRoot(patch.repoRoot);
      if (!resolved) return c.json({ error: `not a git repository: ${patch.repoRoot}` }, 400);
      // Assigned in place rather than spread as `{...patch, repoRoot}`: that spread names
      // the key even when it is undefined, and `isAnnotationOnlyUpdate` counts KEYS - so a
      // priority-only patch would look like it touched the repo and get refused on any
      // task that had already been dispatched.
      patch.repoRoot = resolved;
    }
    const r = await tasks.update(id, patch);
    return c.json(r, r.ok ? 200 : r.error === "no such task" ? 404 : 409);
  });

  app.post("/api/tasks/:id/dispatch", async (c) => {
    const parsed = await parseBody(c, DispatchBacklogTaskSchema);
    if (!parsed.ok) return parsed.res;
    const t = await tasks.dispatch(c.req.param("id"), parsed.data);
    if (!t) return c.json({ error: "no such task" }, 404);
    return c.json(t);
  });

  // Assign a backlog task to an already-running agent. A refusal here is a 409, not a
  // 500: every way it fails (task already dispatched, agent busy, agent in another
  // repo, pane locked) is a state conflict the operator can see and resolve on the
  // board - and in none of them was anything typed at the agent.
  //
  // "The handover would discard something" is one of those refusals, and it carries a
  // `resetConfirm` breakdown for the caller to render. Answering it is a re-POST with
  // `confirmReset`, not a second preview route: one round trip, and no window between
  // reading the loss and acting on it in which the loss can change.
  app.post("/api/tasks/:id/assign", async (c) => {
    const parsed = await parseBody(c, AssignTaskSchema);
    if (!parsed.ok) return parsed.res;
    const r = await tasks.assign(c.req.param("id"), parsed.data.sessionId, {
      confirmReset: parsed.data.confirmReset,
    });
    return c.json(r, r.ok ? 200 : r.error === "no such task" ? 404 : 409);
  });

  app.post("/api/tasks/:id/cancel", async (c) => {
    const r = await tasks.cancel(c.req.param("id"));
    return c.json(r, r.ok ? 200 : 404);
  });

  // Free a terminal task's leftover worktree/agent, keeping its status + outcome.
  app.post("/api/tasks/:id/reclaim", async (c) => {
    const r = await tasks.reclaim(c.req.param("id"));
    return c.json(r, r.ok ? 200 : 404);
  });

  app.post("/api/tasks/:id/complete", async (c) => {
    const parsed = await parseBody(c, CompleteTaskSchema);
    if (!parsed.ok) return parsed.res;
    const t = await tasks.complete(c.req.param("id"), parsed.data.outcome, parsed.data.outcomeUrl);
    if (!t) return c.json({ error: "no such task" }, 404);
    return c.json(t);
  });

  app.delete("/api/tasks/:id", async (c) => {
    const r = await tasks.remove(c.req.param("id"));
    return c.json(r, r.ok ? 200 : r.error === "no such task" ? 404 : 409);
  });

  return app;
}

/** True when the Host header names a loopback address (defeats DNS-rebinding). */
export function hostIsLoopback(host: string | undefined): boolean {
  if (!host) return false;
  // Strip a trailing :port and any [] IPv6 brackets, then match loopback names.
  const h = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}
