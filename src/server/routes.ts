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
  CreateSessionActionSchema,
  UpdateSessionActionSchema,
  ArchiveSessionActionSchema,
  CostConfigPatchSchema,
  CreateReviewSchema,
  DispatchBacklogTaskSchema,
  DispatchSchema,
  ResolveRepoSchema,
  EditWorkItemSchema,
  ForemanConfigPatchSchema,
  ForemanInstructionsSchema,
  ForemanHeartbeatSchema,
  HarnessesConfigPatchSchema,
  UiConfigPatchSchema,
  InspectorConfigPatchSchema,
  LlmConfigPatchSchema,
  McpCreateTaskSchema,
  ShippingConfigPatchSchema,
  HookIngestSchema,
  InjectPromptSchema,
  MarkItemSentSchema,
  OtlpMetricsSchema,
  PendingTurnRevisionSchema,
  ReattachQueueSchema,
  RescheduleTaskSchema,
  RenameSchema,
  ReorderQueueSchema,
  ResetSchema,
  ResolveReviewSchema,
  ArchiveScheduleSchema,
  CreateScheduleSchema,
  RunScheduleNowSchema,
  ScheduleHistoryQuerySchema,
  SchedulePreviewSchema,
  SetScheduleEnabledSchema,
  UpdateScheduleSchema,
  SelectOptionSchema,
  SendTextSchema,
  OpenSessionFileSchema,
  LaunchSessionTerminalSchema,
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
  SpendReportSchema,
  StandardsRequestSchema,
  StatusLineIngestSchema,
  StatusSchema,
  TRANSCRIPT_DEFAULT_TAIL_TURNS,
  TRANSCRIPT_HEAD_TURNS,
  UpdateTaskSchema,
  UpdatePersonaSchema,
  ArchivePersonaSchema,
  CreateWorkflowSchema,
  UpdateWorkflowSchema,
  ValidateWorkflowSchema,
  PublishWorkflowSchema,
  ArchiveWorkflowSchema,
  UnarchiveWorkflowSchema,
  DeleteWorkflowSchema,
  ArchiveWorkflowBindingSchema,
  CancelWorkflowRunSchema,
  CreateWorkflowBindingSchema,
  ReattachWorkflowBindingSchema,
  RestartFullWorkflowSchema,
  ResubmitWorkflowSchema,
  RetryWorkflowRunSchema,
  RetryWorkflowDeliverySchema,
  ResolveWorkflowDeliverySchema,
  SetWorkflowNodesDisabledSchema,
  WorkflowCompletionClaimSchema,
  WorkflowConfigSchema,
  WorkflowRunActionSchema,
  SubmitWorkflowSchema,
  UpdateWorkflowBindingSchema,
  WrapupSchema,
} from "@shared/protocol.ts";
import type { TaskDependencyInput } from "@shared/protocol.ts";
import { capturePaneText } from "./discovery/pane-capture.ts";
import { noteKeyFor } from "./registry.ts";
import type { Registry } from "./registry.ts";
import type { QueueManager } from "./queue.ts";
import type {
  InspectorStatus,
  LlmStatus,
  ReviewActor,
  Session,
  SkillsView,
  WorkItem,
} from "@shared/types.ts";
import { ReviewResolutionError, type ReviewManager } from "./reviews.ts";
import { TaskDependencyError, TaskStatusConflictError, type TaskManager } from "./tasks.ts";
import { sseHandler } from "./sse.ts";
import { recordInjection } from "./injections.ts";
import { harnessFor, resumeArgvFor, sessionMessages } from "./harness/index.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { activePaneDialog } from "@shared/session.ts";
import { workQueueBlockedReason } from "@shared/harness-capabilities.ts";
import { transcriptStreamHandler } from "./transcript-stream.ts";
import { attributeTranscript } from "./transcript-attribution.ts";
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
import { summarizeBuffer } from "@shared/away-buffer.ts";
import type { AwayWatcher } from "./away/watcher.ts";
import { getHarnessesConfig, setHarnessesConfig } from "./harnesses.ts";
import type { SdkSupervisor } from "./sdk/supervisor.ts";
import type { PendingTurnManager } from "./pending-turns.ts";
import { driverFormAnswer, driverOptionAnswer, type DriverAnswer } from "./sdk/answer.ts";
import { dialogMarker } from "./foreman/pending.ts";
import { answeredQuestion } from "./sdk/answered-question.ts";
import { handOffToTerminal, type HandoffDeps } from "./sdk/handoff.ts";
import { clearSdkSessionTask } from "./sdk/store.ts";
import { deliverToDriver, injectPromptForRuntime } from "./sdk/deliver.ts";
import { renameDriverSession } from "./sdk/rename.ts";
import { requestSessionStop } from "./sdk/control.ts";
import { spawnUniquely } from "./dispatcher.ts";
import { getTaskSourcesConfig, setTaskSourcesConfig, taskSourceById } from "./task-sources/config.ts";
import { taskSourceKinds } from "./task-sources/index.ts";
import { noteTaskSourceConfigChange, preflightOnce, sweepOnce, taskSourceStatuses } from "./task-sources/sweeper.ts";
import type { TaskSourcesView } from "@shared/task-source.ts";
import { setUiConfig, uiConfigView } from "./ui-config.ts";
import { costTelemetryStatus, setCostConfig } from "./cost.ts";
import { getInspectorConfig, inspectorModel, setInspectorConfig } from "./inspector/config.ts";
import { getLlmConfig, llmStatus, setLlmConfig } from "./llm/config.ts";
import { getShippingConfig, setShippingConfig } from "./shipping/config.ts";
import { publishSettingsStatus } from "./settings-status.ts";
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
import { readRuntimeEffortBaseline } from "./runtime-meta.ts";
import { checkToken } from "./auth.ts";
import {
  forgetTaskSourceSeen,
  getSkillsAcks,
  loadHumanResolvedReviews,
  loadInspectionsAdoptedSince,
  loadInspectorInspections,
  episodeById,
  recentEpisodes,
} from "./db.ts";
import { recordSpendReport } from "./spend-ledger.ts";
import { FOREMAN_EPISODE_LEDGER } from "@shared/foreman.ts";
import {
  cyclePermissionMode,
  focus,
  rename,
  resetPreview,
  selectPaneOption,
  sendText,
  setPermissionMode,
  setSessionEffort,
  driverEffortTargetResult,
  defaultPaneDeps,
  formDelivered,
  submitPaneForm,
  validateSessionName,
  validateSessionNameAgainstTasks,
} from "./actions.ts";
import { driverClearFor, resetSession } from "./reset.ts";
import { buildReport, renderReportMarkdown } from "./report.ts";
import { listRepos, resolveRepoPath, resolveRepoRoot, resolveTaskRepoRoot } from "./repos.ts";
import { MAX_UPLOAD_BYTES, saveImageUpload } from "./uploads.ts";
import {
  listSessionFiles,
  MAX_SESSION_EDITOR_BYTES,
  readSessionFile,
  resolveSessionFilePath,
  saveSessionFile,
  SessionFileError,
} from "./session-files.ts";
import { openFile, openTargetViews } from "./open-targets/index.ts";
import { terminalTargetViews, launchTerminal } from "./terminal/targets.ts";
import {
  agentLaunchAction,
  agentLaunchBlockedReason,
  shellLaunchBlockedReason,
} from "@shared/session-launch.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import type { PersonaManager, PersonaMutation } from "./workflows/personas.ts";
import type { SessionActionManager, SessionActionMutation } from "./workflows/session-actions.ts";
import { sessionActionCapabilities } from "./workflows/session-action-adapters.ts";
import type {
  WorkflowManager,
  WorkflowDeleteMutation,
  WorkflowMutation,
  WorkflowPublishMutation,
  WorkflowRuntimeMutation,
  WorkflowValidationMutation,
} from "./workflows/manager.ts";
import { WORKFLOW_LIMITS, WORKFLOW_RUN_STATUSES } from "@shared/workflow.ts";
import {
  getWorkflowConfig,
  resolveTaskWorkflowId,
  setWorkflowConfig,
} from "./workflows/config.ts";
import { decodeWorkflowRunCursor } from "./workflows/store.ts";
import type { ScheduleService } from "./schedules/manager.ts";
import { SCHEDULE_HISTORY_DEFAULT_LIMIT } from "@shared/schedules.ts";
import type { ScheduleValidationError } from "@shared/schedules.ts";
import type { EnsembleManager, EnsembleSubmitResult } from "./ensembles/manager.ts";
import {
  EnsembleActionSchema,
  EnsembleCreateInputSchema,
  EnsembleDeleteSchema,
  EnsembleMemberSubmitSchema,
  EnsemblePreviewSchema,
  SubmitEnsembleResultSchema,
} from "@shared/protocol.ts";
import { ENSEMBLE_LIMITS } from "@shared/ensemble.ts";
import { artifactAdapterFor } from "./ensembles/artifacts/index.ts";
// The one statement of which patch paths are usable, imported rather than restated: a route
// that spelled the rule itself would drift from the invocation that has to survive it.
import { SnapshotPathRefused, snapshotPathRefusal } from "./git/ensemble-snapshot.ts";

/** Long-poll window for the agent's review wait (it re-polls if still pending). */
const WAIT_TIMEOUT_MS = 30000;

/** The upload cap as the refusal states it - both size guards say the same number. */
const TOO_BIG_MB = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);
const PERSONA_BODY_MAX_BYTES = WORKFLOW_LIMITS.personaGuidanceBytes * 6 + 16 * 1024;
/**
 * The same ×6 headroom as a Persona's, and derived from the prompt ceiling rather than
 * copied from it: JSON string escaping can expand a UTF-8 byte several times over, so a
 * limit set to the ceiling itself would reject prompts the schema accepts.
 */
const SESSION_ACTION_BODY_MAX_BYTES = WORKFLOW_LIMITS.sessionActionPromptBytes * 6 + 16 * 1024;
/**
 * Archive carries one integer, so it gets its own much smaller ceiling.
 *
 * Sizing it from the PROMPT ceiling like the two writes above would let a caller stream
 * ~600 KB at a route whose entire schema is `{ expectedRevision }` - a body limit in name
 * only. A kilobyte is already orders of magnitude more than the largest legal request and
 * leaves room for whitespace, so the cap refuses abuse without ever refusing a real client.
 */
const SESSION_ACTION_ARCHIVE_BODY_MAX_BYTES = 1024;
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
 * Why this session's permission mode cannot be driven, or null when it can be.
 *
 * The refusal is a CAPABILITY answer, not an agent-id one: a harness may expose a verified
 * footer cycle or a verified native picker, while one declaring neither is refused before
 * any terminal input. Named from `AGENT_IDENTITY` so a fourth harness gets a true sentence
 * instead of inheriting "Claude".
 */
/**
 * Answer an embedded session's pending request: verify against what the caller was shown,
 * then resolve the callback the agent is blocked on.
 *
 * Two refusals with one shape, because a caller cannot act differently on them: the
 * projection said no (the ask moved, a label no longer matches, a form is half-filled), or
 * the driver said no (it no longer holds that request). Either way nothing was delivered
 * and the question is still on the card - which is exactly what a 409 means on the pane
 * path, so the two runtimes read identically to the dashboard, to Foreman and to the MCP
 * tool.
 */
async function answerDriverRequest(
  supervisor: SdkSupervisor | undefined,
  session: Session,
  project: (dialog: Session["paneDialog"]) => DriverAnswer,
  /**
   * Where an answered QUESTION is written down, so the conversation can replay it. Both
   * driver answer routes pass these; see `sdk/answered-question.ts` for why only questions
   * are recorded and why a review is the shape they are recorded as.
   */
  record: { reviews: ReviewManager; by: ReviewActor },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!supervisor) return { ok: false, error: "this build has no session supervisor" };
  // Held rather than re-read below: answering clears the dialog off the session, and the
  // record must describe the ask the caller was actually shown - the same snapshot the
  // projection verified against.
  const asked = session.paneDialog;
  const projected = project(asked);
  if (!projected.ok) return projected;
  // Read BEFORE the delivery, because it is when the operator spoke. Taken afterwards it
  // would be a reading of when the agent was already running again - and the conversation
  // places an answer by this stamp, so a few milliseconds the wrong side of the agent's
  // next turn files the decision below the reply it caused.
  const spokeAt = Date.now();
  try {
    await supervisor.answer(session.id, projected.requestId, projected.answer);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // AFTER the delivery, and never instead of it. The record claims the agent received this
  // answer, so writing it before the driver had taken it would leave the log asserting a
  // decision that a throw above then prevented - the same ordering rule Foreman's approval
  // path follows (`web/lib/foreman.ts`). And a failure to write the record must not turn a
  // delivered answer into a 409: the operator would answer the question again, against a
  // request the agent is no longer blocked on.
  try {
    const answered = answeredQuestion(asked, projected.answer);
    if (answered) {
      record.reviews.record({
        sessionId: session.id,
        kind: "input",
        ...answered,
        resolvedBy: record.by,
        at: spokeAt,
      });
    }
  } catch (err) {
    console.warn(
      `[mission-control] answered ${session.id}'s question but could not record it for the ` +
        `conversation (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return { ok: true };
}

/**
 * You just answered the ask on this session's screen, so retire Foreman's note about it.
 *
 * Called from the two option routes rather than from inside `answerDriverRequest`, because
 * the staleness has nothing to do with the runtime: a driver request resolved over a
 * callback and a pane menu answered with arrow keys are the same event to the note, and
 * only the routes see both branches. `retireNoteAnsweredByYou` checks the marker, so this
 * is a no-op for every session that has no note or whose note is about something else.
 *
 * The dialog is the snapshot the caller was SHOWN, passed in rather than re-read: answering
 * clears it off the session, and the marker has to be the one Foreman minted from the ask
 * that was on screen. Foreman's own sends are excluded - it writes its own note when its
 * verdict is applied, and crediting them to you would put your name on its decision.
 *
 * CALL THIS ONLY ONCE THE ANSWER HAS REACHED THE CHILD, which is not the same as `ok`. A
 * pane form reports `ok` for two states that delivered nothing: `next-question`, where the
 * ticks stand and the walk moved to the following question - and a form's answers reach the
 * agent only when its Submit tab is confirmed, so nothing has been sent yet - and
 * `unanswered`, where Claude's review tab reported a gap and the walk bounced back to the
 * same question. Both leave the agent blocked on the ask the note names, so retiring there
 * drops a decision that is still owed. That is the failure this function's marker check
 * exists to prevent, arriving through the outcome instead of through the marker.
 *
 * The driver branch needs no such gate: resolving the `canUseTool` callback answers the whole
 * request at once, so it has no partial state to report.
 */
function retireForemanNoteForDialog(
  registry: Registry,
  session: Session,
  dialog: Session["paneDialog"],
  by: ReviewActor,
): void {
  if (by !== "human" || !dialog) return;
  registry.retireNoteAnsweredByYou(session.id, dialogMarker(dialog));
}

function noPermissionModes(session: Session): string | null {
  if (harnessFor(session.agent).permissionModes) return null;
  return `${AGENT_IDENTITY[session.agent].label} has no permission modes`;
}

function noPermissionModeCycle(session: Session): string | null {
  const modes = harnessFor(session.agent).permissionModes;
  if (!modes) return `${AGENT_IDENTITY[session.agent].label} has no permission modes`;
  if (modes.liveControl.kind === "cycle") return null;
  return `${AGENT_IDENTITY[session.agent].label} changes permission modes through its picker`;
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

/** Parse a query-string count into a bounded positive integer, or fall back. */
function boundedLimit(raw: string | undefined, fallback: number, max = fallback): number {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** The short commit an artifact points at, for a durable submission acknowledgement. */
function artifactShortSha(locator: unknown): string | null {
  if (locator && typeof locator === "object" && !Array.isArray(locator)) {
    const sha = (locator as { snapshotSha?: unknown }).snapshotSha;
    if (typeof sha === "string") return sha.slice(0, 12);
  }
  return null;
}

/**
 * Map one submission result to an HTTP status and body, for both the MCP and the manual route.
 *
 * The refusals are distinct on purpose: a wrong cwd, a withdrawn member and a late replay are
 * different things for a caller (or an operator) to understand, and collapsing them to one code
 * would turn "you are in the wrong tree" into the same silence as "there is no such member".
 */
function ensembleSubmitResponse(result: EnsembleSubmitResult): { status: 200 | 400 | 404 | 409 | 500 | 503; body: unknown } {
  if (result.ok) {
    return {
      status: 200,
      body: {
        ok: true,
        replayed: result.replayed,
        artifact: {
          id: result.artifact.id,
          kind: result.artifact.kind,
          fingerprint: result.artifact.digest,
          shortSha: artifactShortSha(result.artifact.locator),
        },
      },
    };
  }
  const body = { error: result.detail, code: `ensemble_submit_${result.reason}` };
  switch (result.reason) {
    case "no_engine":
      return { status: 503, body };
    case "no_session":
    case "no_member":
      return { status: 404, body };
    case "capture_failed":
      return { status: 500, body };
    case "wrong_cwd":
    case "member_inactive":
    case "no_attempt":
    case "no_worktree":
    case "run_not_accepting":
    case "already_submitted":
      return { status: 409, body };
    default:
      return { status: 400, body };
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
  /**
   * The Recurring Missions service. Optional only so the broad legacy route-unit
   * construction (four args) still compiles; production always passes it, and the schedule
   * routes answer 503 when it is absent rather than constructing a second manager here.
   */
  schedules?: ScheduleService,
  /** Optional for existing route-unit stubs; the daemon always supplies it. */
  ensembles?: EnsembleManager,
  /**
   * The owner of embedded (SDK-runtime) sessions.
   *
   * Optional for the same route-unit reason, and its absence is answerable rather than
   * silent: the driver arms below refuse with "this build has no session supervisor",
   * which nothing can reach anyway, since without one no embedded session can exist.
   */
  sdkSessions?: SdkSupervisor,
  /**
   * How a handed-off session's terminal home is opened. Injected so the handoff route is
   * testable on a machine with no tmux - the `HomeDeps` seam, one level up.
   */
  handoffDeps?: HandoffDeps,
  /** The selected terminal launcher. Injected so route tests never open a real window. */
  launchSessionTerminal?: typeof launchTerminal,
  /** Optional for existing route-unit stubs; the daemon always supplies it. */
  sessionActions?: SessionActionManager,
  /** Durable editable outbox. Optional only for legacy route-unit construction. */
  pendingTurns?: PendingTurnManager,
): Hono {
  const app = new Hono();
  const terminalLauncher = launchSessionTerminal ?? launchTerminal;
  // A successful exited-session resume keeps its claim for the life of this lingering
  // session id. Otherwise a double-click before `session_remove` can start two agents on
  // the same conversation. A confirmed failure releases it for retry.
  const agentResumeClaims = new Set<string>();
  // A claim must live exactly as long as the lingering session id it guards. Released
  // earlier - on a timer, or when the launch returns - it stops covering the window it
  // exists for; never released, it is an unbounded leak on a daemon that resumes many
  // exited sessions.
  //
  // `session_remove` is that boundary, and it is SUBSCRIBED rather than inferred. Deriving
  // it by asking whether the registry still holds the id looks equivalent and is not: a
  // session id is derived from the tty, so a new agent on the same tty brings the same id
  // back, and a claim pruned only on absence would be inherited by that new session and
  // refuse its first resume forever. The event fires at the moment of removal, before any
  // reuse can happen.
  //
  // Guarded because `buildApp` is constructed with hand-built registry stubs across ~20
  // route tests, the same accommodation several parameters above already document. The
  // daemon always passes a real Registry.
  registry.subscribe?.((e) => {
    if (e.type === "session_remove") agentResumeClaims.delete(e.id);
  });

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
  const ensembleManager = (): EnsembleManager | null => ensembles ?? null;
  const defaultHandoffDeps: HandoffDeps = handoffDeps ?? {
    spawn: spawnUniquely,
    waitForSessionAtCwd: (cwd, timeoutMs) => registry.waitForSessionAtCwd(cwd, timeoutMs),
    settleTask: (taskId) => tasks.settleAfterFailedHandoff(taskId),
  };
  const handoffSession = async (
    session: Session,
    backend?: Parameters<typeof launchTerminal>[0],
  ) => {
    if (!sdkSessions) {
      return {
        ok: false as const,
        error: "this build has no session supervisor",
        label: backend ?? "default terminal",
      };
    }
    let label = "default terminal";
    const deps = backend
      ? {
          ...defaultHandoffDeps,
          spawn: async (
            name: string,
            _shortId: string,
            cwd: string,
            bin: string,
            args: readonly string[] = [],
          ) => {
            const launched = await terminalLauncher(backend, {
              name,
              cwd,
              argv: [bin, ...args],
            });
            label = launched.label;
            // A 504 means the terminal may have opened. The embedded driver is already
            // stopped, so preserve the transfer and let discovery settle what appeared.
            if (!launched.ok && launched.status !== 504) {
              throw new Error(launched.error ?? `${launched.label} could not open a window`);
            }
            return launched.homeName ?? name;
          },
        }
      : defaultHandoffDeps;
    const result = await handOffToTerminal(
      registry,
      sdkSessions,
      session,
      deps,
    );
    return { ...result, label };
  };
  const personaFailure = (c: Context, result: Exclude<PersonaMutation, { ok: true }>) => {
    const code = `persona_${result.reason}`;
    if (result.reason === "not_found") return c.json({ error: "no such Persona", code }, 404);
    // A built-in refusal is not a conflict a retry can clear, so it names the way forward
    // rather than the state: the operator wants a copy they own, and Duplicate makes one.
    if (result.reason === "builtin") {
      return c.json({
        error: "this Persona ships with Mission Control and cannot be edited or archived. "
          + "Duplicate it to make a copy you own.",
        code,
        current: result.current,
      }, 409);
    }
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

  // --- SessionActions: exact prompt Markdown plus revision/CAS writes ---
  //
  // Deliberately the Persona block's shape, refusal vocabulary and status codes. The two
  // catalogs obey the same CAS and built-in rules, and a second dialect of "409 conflict"
  // for the same cause is how a browser ends up handling one and not the other.
  const sessionActionManager = (): SessionActionManager | null => sessionActions ?? null;
  const sessionActionFailure = (
    c: Context,
    result: Exclude<SessionActionMutation, { ok: true }>,
  ) => {
    const code = `session_action_${result.reason}`;
    if (result.reason === "not_found") {
      return c.json({ error: "no such session action", code }, 404);
    }
    if (result.reason === "builtin") {
      return c.json({
        error: "this session action ships with Mission Control and cannot be edited or "
          + "archived. Duplicate it to make a copy you own.",
        code,
        current: result.current,
      }, 409);
    }
    return c.json({ error: result.reason.replaceAll("_", " "), code, current: result.current }, 409);
  };

  app.get("/api/session-actions", (c) => {
    const manager = sessionActionManager();
    if (!manager) return c.json({ error: "session action manager unavailable" }, 503);
    const raw = c.req.query("includeArchived");
    if (raw !== undefined && raw !== "true" && raw !== "false") {
      return c.json({ error: "includeArchived must be true or false" }, 400);
    }
    return c.json(manager.list(raw === "true"));
  });
  /**
   * What this build can actually PROVE, per completion adapter.
   *
   * Served from the daemon's own registry rather than derived in the browser, and registered
   * BEFORE `/:id` so the literal path is not swallowed as an action id. A surface that
   * offered a completion the daemon then refuses would be a workflow an operator can author
   * and never run, so there is exactly one answer and this is where it comes from.
   */
  app.get("/api/session-actions/capabilities", (c) =>
    c.json({ completions: sessionActionCapabilities() }));
  app.get("/api/session-actions/:id", (c) => {
    const manager = sessionActionManager();
    if (!manager) return c.json({ error: "session action manager unavailable" }, 503);
    const action = manager.get(c.req.param("id"));
    return action ? c.json(action) : c.json({ error: "no such session action" }, 404);
  });
  app.post("/api/session-actions", bodyLimit({
    maxSize: SESSION_ACTION_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "session action request is too large" }, 413),
  }), async (c) => {
    const manager = sessionActionManager();
    if (!manager) return c.json({ error: "session action manager unavailable" }, 503);
    const parsed = await parseBody(c, CreateSessionActionSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.create(parsed.data);
    // A draft naming a missing action carries a diagnostic, so creating one can clear it.
    if (result.ok) workflows?.refreshSummaries();
    return result.ok ? c.json(result.action, 201) : sessionActionFailure(c, result);
  });
  app.patch("/api/session-actions/:id", bodyLimit({
    maxSize: SESSION_ACTION_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "session action request is too large" }, 413),
  }), async (c) => {
    const manager = sessionActionManager();
    if (!manager) return c.json({ error: "session action manager unavailable" }, 503);
    const parsed = await parseBody(c, UpdateSessionActionSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.update(c.req.param("id"), parsed.data);
    if (result.ok) workflows?.refreshSummaries();
    return result.ok ? c.json(result.action) : sessionActionFailure(c, result);
  });
  app.delete("/api/session-actions/:id", bodyLimit({
    maxSize: SESSION_ACTION_ARCHIVE_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "session action request is too large" }, 413),
  }), async (c) => {
    const manager = sessionActionManager();
    if (!manager) return c.json({ error: "session action manager unavailable" }, 503);
    const parsed = await parseBody(c, ArchiveSessionActionSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.archive(c.req.param("id"), parsed.data.expectedRevision);
    if (result.ok) workflows?.refreshSummaries();
    return result.ok ? c.json(result.action) : sessionActionFailure(c, result);
  });

  // --- Workflow definitions: CAS drafts and immutable published versions ---
  const workflowFailure = (
    c: Context,
    result: Exclude<
      WorkflowMutation | WorkflowDeleteMutation | WorkflowPublishMutation | WorkflowValidationMutation,
      { ok: true }
    >,
    expectedRevision?: number,
  ) => {
    if (result.reason === "not_found") {
      return c.json({ error: "no such workflow", code: "workflow_not_found" }, 404);
    }
    const current = result.current;
    const currentSummary = current && workflows ? workflows.store.summary(current) : null;
    const body = {
      error: result.reason.replaceAll("_", " "),
      code: `workflow_${result.reason}`,
      expectedRevision: expectedRevision ?? null,
      currentRevision: current?.draftRevision ?? null,
      current: currentSummary,
    };
    // A built-in refusal is not a conflict a retry can clear, so it names the way forward
    // rather than the state: the operator wants a copy they own, and Duplicate makes one.
    if (result.reason === "builtin") {
      return c.json({
        ...body,
        error: "this workflow ships with Mission Control: it cannot be edited, published, "
          + "archived, restored, or deleted. Duplicate it to make a copy you own.",
      }, 409);
    }
    return c.json(body, 409);
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
  app.get("/api/workflows/config", (c) => c.json(getWorkflowConfig()));
  app.get("/api/workflows/status", (c) => {
    const manager = workflowManager();
    return manager
      ? c.json(manager.status())
      : c.json({ error: "Workflow manager unavailable" }, 503);
  });
  app.put("/api/workflows/config", async (c) => {
    const parsed = await parseBody(c, WorkflowConfigSchema);
    if (!parsed.ok) return parsed.res;
    if (parsed.data.defaultWorkflowId) {
      const detail = workflowManager()?.get(parsed.data.defaultWorkflowId) ?? null;
      if (
        !detail
        || detail.workflow.archivedAt !== null
        || detail.workflow.currentVersionId === null
      ) {
        return c.json({ error: "The dispatch default must be an active published workflow" }, 409);
      }
    }
    return c.json(setWorkflowConfig(parsed.data));
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
  app.get("/api/workflows/:id/versions/:version/export", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const versionNumber = Number(c.req.param("version"));
    if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
      return c.json({ error: "version must be a positive integer" }, 400);
    }
    const exported = manager.exportVersion(c.req.param("id"), versionNumber);
    if (!exported) return c.json({ error: "no such workflow version" }, 404);
    c.header("Content-Disposition", `attachment; filename="workflow-version-${versionNumber}.json"`);
    return c.json(exported);
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
    const id = c.req.param("id");
    const selected = manager.get(id)?.workflow ?? null;
    if (selected && !selected.builtin && getWorkflowConfig().defaultWorkflowId === id) {
      return c.json({
        error: "Choose another dispatch default before archiving this workflow",
      }, 409);
    }
    const result = manager.archive(id, parsed.data.expectedDraftRevision);
    return result.ok ? c.json({ workflow: result.workflow, summary: result.summary }) : workflowFailure(c, result, parsed.data.expectedDraftRevision);
  });
  app.post("/api/workflows/:id/unarchive", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, UnarchiveWorkflowSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.unarchive(c.req.param("id"), parsed.data.expectedDraftRevision);
    return result.ok ? c.json({ workflow: result.workflow, summary: result.summary }) : workflowFailure(c, result, parsed.data.expectedDraftRevision);
  });
  // Deliberately NOT `DELETE /api/workflows/:id`: that verb is spoken for by the soft archive
  // above and has been since Phase 2, so reusing it would make the destructive path reachable
  // by any older client that still means "archive" when it sends it. The two take the same
  // body, which is exactly why they must not share a route.
  app.post("/api/workflows/:id/delete", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, DeleteWorkflowSchema);
    if (!parsed.ok) return parsed.res;
    const id = c.req.param("id");
    const selected = manager.get(id)?.workflow ?? null;
    if (selected && !selected.builtin && getWorkflowConfig().defaultWorkflowId === id) {
      return c.json({
        error: "Choose another dispatch default before deleting this workflow",
      }, 409);
    }
    const result = manager.remove(id, parsed.data.expectedDraftRevision);
    return result.ok ? c.json({ ok: true, id: result.id }) : workflowFailure(c, result, parsed.data.expectedDraftRevision);
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

  // --- Published-version bindings and durable manual Preview runs ---
  const workflowRuntimeFailure = (
    c: Context,
    result: Exclude<WorkflowRuntimeMutation<unknown>, { ok: true }>,
  ) => {
    const status =
      result.reason === "not_found" ? 404
      : result.reason === "session_unavailable" ? 404
      : result.reason === "unsupported_mode" ? 422
      : result.reason === "stale_capture" ? 409
      : 409;
    return c.json({
      error: result.message,
      code: `workflow_${result.reason}`,
      current: result.current ?? null,
    }, status);
  };

  app.get("/api/workflow-bindings", (c) => {
    const manager = workflowManager();
    return manager
      ? c.json(manager.bindings())
      : c.json({ error: "Workflow manager unavailable" }, 503);
  });
  app.post("/api/workflow-bindings", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, CreateWorkflowBindingSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.createBinding(parsed.data);
    return result.ok ? c.json(result.value, 201) : workflowRuntimeFailure(c, result);
  });
  app.patch("/api/workflow-bindings/:id", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, UpdateWorkflowBindingSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.updateBinding(c.req.param("id"), parsed.data);
    return result.ok ? c.json(result.value) : workflowRuntimeFailure(c, result);
  });
  app.delete("/api/workflow-bindings/:id", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, ArchiveWorkflowBindingSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.archiveBinding(c.req.param("id"));
    return result.ok ? c.json(result.value) : workflowRuntimeFailure(c, result);
  });
  app.post("/api/workflow-bindings/:id/submit", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, SubmitWorkflowSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.enqueueSubmit(c.req.param("id"), parsed.data);
    return result.ok
      ? c.json(
          { ...result.value, idempotent: result.idempotent ?? false },
          result.idempotent ? 200 : 202,
        )
      : workflowRuntimeFailure(c, result);
  });
  app.post("/api/sessions/:id/workflow-review", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, SubmitWorkflowSchema);
    if (!parsed.ok) return parsed.res;
    const sessionId = c.req.param("id");
    const result = await manager.startBuiltinReview(sessionId, parsed.data);
    if (!result.ok) return workflowRuntimeFailure(c, result);
    const queue = queues.get(sessionId);
    if (queue) queues.setWrapupAnswer(queue.noteKey, "workflow:no-mistakes-review");
    return c.json({ ...result.value, idempotent: result.idempotent ?? false });
  });
  app.post("/api/workflow-bindings/:id/reattach", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, ReattachWorkflowBindingSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.reattach(c.req.param("id"), parsed.data.sessionId);
    return result.ok ? c.json(result.value) : workflowRuntimeFailure(c, result);
  });
  app.get("/api/workflow-runs", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      return c.json({ error: "limit must be an integer from 1 through 200" }, 400);
    }
    const rawCursor = c.req.query("cursor");
    if (rawCursor && rawCursor.length > 512) {
      return c.json({ error: "cursor is invalid" }, 400);
    }
    const cursor = rawCursor ? decodeWorkflowRunCursor(rawCursor) : null;
    if (rawCursor && !cursor) return c.json({ error: "cursor is invalid" }, 400);
    const rawStatus = c.req.query("status");
    if (rawStatus && !(WORKFLOW_RUN_STATUSES as readonly string[]).includes(rawStatus)) {
      return c.json({ error: "status is invalid" }, 400);
    }
    const workflowId = c.req.query("workflowId") || undefined;
    const session = c.req.query("session") || undefined;
    if ((workflowId?.length ?? 0) > 200 || (session?.length ?? 0) > 200) {
      return c.json({ error: "filter is too long" }, 400);
    }
    return c.json(manager.runPage({
      limit,
      cursor,
      status: rawStatus as (typeof WORKFLOW_RUN_STATUSES)[number] | undefined,
      workflowId,
      session,
    }));
  });
  app.get("/api/workflow-runs/:id/events", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const rawAfter = c.req.query("after");
    const after = rawAfter === undefined ? 0 : Number(rawAfter);
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 200 : Number(rawLimit);
    if (!Number.isSafeInteger(after) || after < 0) {
      return c.json({ error: "after must be a non-negative event id" }, 400);
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      return c.json({ error: "limit must be an integer from 1 through 200" }, 400);
    }
    const page = manager.events(c.req.param("id"), after, limit);
    return page ? c.json(page) : c.json({ error: "no such workflow run" }, 404);
  });
  app.get("/api/workflow-runs/:id/calls", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 200 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      return c.json({ error: "limit must be an integer from 1 through 200" }, 400);
    }
    const after = c.req.query("after") || null;
    if ((after?.length ?? 0) > 200) {
      return c.json({ error: "after is invalid" }, 400);
    }
    const page = manager.llmCalls(c.req.param("id"), after, limit);
    return page ? c.json(page) : c.json({ error: "no such workflow run" }, 404);
  });
  app.get("/api/workflow-runs/:id/export", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const exported = manager.exportRun(c.req.param("id"));
    if (!exported) return c.json({ error: "no such workflow run" }, 404);
    c.header("Content-Disposition", `attachment; filename="workflow-run-${c.req.param("id")}.json"`);
    return c.json(exported);
  });
  app.get("/api/workflow-runs/:id", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const result = manager.run(c.req.param("id"));
    if (result.kind === "found") return c.json(result.detail);
    return result.kind === "corrupt"
      ? c.json({
          error: "workflow run data is malformed",
          code: "workflow_run_corrupt",
        }, 500)
      : c.json({
          error: "no such workflow run",
          code: "workflow_run_not_found",
        }, 404);
  });
  app.post("/api/workflow-runs/:id/resubmit", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, ResubmitWorkflowSchema);
    if (!parsed.ok) return parsed.res;
    const result = await manager.resubmit(c.req.param("id"), parsed.data);
    return result.ok
      ? c.json({ ...result.value, idempotent: result.idempotent ?? false })
      : workflowRuntimeFailure(c, result);
  });
  app.post("/api/workflow-runs/:id/retry", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, RetryWorkflowRunSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.retry(c.req.param("id"), parsed.data);
    return result.ok
      ? c.json({ ...result.value, idempotent: result.idempotent ?? false })
      : workflowRuntimeFailure(c, result);
  });
  app.post("/api/workflow-runs/:id/cancel", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, CancelWorkflowRunSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.cancel(c.req.param("id"), parsed.data.requestId);
    return result.ok
      ? c.json({ run: result.value, idempotent: result.idempotent ?? false })
      : workflowRuntimeFailure(c, result);
  });
  app.post("/api/workflow-runs/:id/prepare-pr", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, WorkflowRunActionSchema);
    if (!parsed.ok) return parsed.res;
    const result = await manager.preparePr(c.req.param("id"), parsed.data.requestId);
    return result.ok
      ? c.json({ delivery: result.value, idempotent: result.idempotent ?? false })
      : workflowRuntimeFailure(c, result);
  });
  app.post("/api/workflow-runs/:id/recheck-inspector", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, WorkflowRunActionSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.recheckInspector(c.req.param("id"), parsed.data.requestId);
    return result.ok
      ? c.json({ run: result.value, idempotent: result.idempotent ?? false })
      : workflowRuntimeFailure(c, result);
  });
  app.post("/api/workflow-runs/:id/set-nodes-disabled", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, SetWorkflowNodesDisabledSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.setNodesDisabled(c.req.param("id"), parsed.data);
    return result.ok
      ? c.json({ run: result.value, idempotent: result.idempotent ?? false })
      : workflowRuntimeFailure(c, result);
  });
  app.post("/api/workflow-runs/:id/restart-full", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, RestartFullWorkflowSchema);
    if (!parsed.ok) return parsed.res;
    const result = await manager.restartFull(c.req.param("id"), parsed.data);
    return result.ok
      ? c.json({ ...result.value, idempotent: result.idempotent ?? false })
      : workflowRuntimeFailure(c, result);
  });
  app.post("/api/workflow-deliveries/:id/retry", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, RetryWorkflowDeliverySchema);
    if (!parsed.ok) return parsed.res;
    const result = await manager.retryDelivery(c.req.param("id"), parsed.data);
    return result.ok
      ? c.json({ delivery: result.value, idempotent: result.idempotent ?? false })
      : workflowRuntimeFailure(c, result);
  });
  app.post("/api/workflow-deliveries/:id/resolve", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, ResolveWorkflowDeliverySchema);
    if (!parsed.ok) return parsed.res;
    const result = await manager.resolveDelivery(c.req.param("id"), parsed.data);
    return result.ok
      ? c.json({ value: result.value, idempotent: result.idempotent ?? false })
      : workflowRuntimeFailure(c, result);
  });
  app.post("/api/sessions/:id/workflow-completion", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, WorkflowCompletionClaimSchema);
    if (!parsed.ok) return parsed.res;
    try {
      return c.json(await manager.claimCompletion(c.req.param("id"), parsed.data));
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : String(error),
        code: "workflow_completion_not_claimed",
      }, 409);
    }
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
  // The "Open in" menu: every registered target, and whether THIS machine can use it.
  // Availability is answered here rather than in the browser because it is a question
  // about the daemon's host - which is not the machine the dashboard is necessarily
  // being viewed from.
  app.get("/api/open-targets", async (c) => c.json({ targets: await openTargetViews() }));
  // Hand one checkout file to an application outside Mission Control.
  //
  // A POST, not a GET, and it deliberately does NOT stream the file back: the daemon
  // launches a local application against a local path, so nothing about the checkout
  // crosses the HTTP boundary. Serving the bytes instead would put checkout-controlled
  // HTML on the daemon's own origin, where its scripts would reach every action route
  // on this port.
  app.post("/api/sessions/:id/file/open", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (!session.cwd) return c.json({ error: "session has no working directory" }, 400);
    const parsed = await parseBody(c, OpenSessionFileSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const file = await resolveSessionFilePath(session.cwd, parsed.data.path);
      const result = await openFile(parsed.data.target, file);
      const body = {
        ok: result.ok,
        target: parsed.data.target,
        label: result.label,
        detail: result.detail,
        ...(result.error ? { error: result.error } : {}),
      };
      return result.ok ? c.json(body) : c.json(body, result.status as 409 | 502 | 504);
    } catch (error) {
      const known = error instanceof SessionFileError ? error : null;
      const status = known?.status === 403 ? 403 : known?.status === 404 ? 404 : 400;
      return c.json({ ok: false, error: known?.message ?? "could not open session file" }, status);
    }
  });
  // Which terminals this HOST can open a window in. Same reasoning as `/api/open-targets`:
  // it is a question about the daemon's machine, not about the one the dashboard is being
  // viewed from, and unavailable backends are RETURNED with their sentence rather than
  // filtered out - an empty menu cannot distinguish "none installed" from "did not look".
  app.get("/api/terminal-targets", (c) => c.json({ targets: terminalTargetViews() }));
  // Open a terminal on a session's checkout: a shell, or the session's own agent CLI.
  // Both payloads use the backend the operator selected; only their daemon-owned argv differs.
  app.post("/api/sessions/:id/launch", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, LaunchSessionTerminalSchema);
    if (!parsed.ok) return parsed.res;
    const { backend, payload } = parsed.data;

    if (payload === "agent") {
      // The daemon owns this rule and the browser reads the SAME predicate to shape the
      // button. A session with a live pane is focusable, and resuming beside it would put
      // a second process on one conversation file - so this refuses and names the action
      // that does work, rather than doing something the operator did not ask for.
      const action = agentLaunchAction(session);
      if (action === "focus") {
        return c.json(
          { ok: false, error: "this session already has a terminal - focus it instead" },
          409,
        );
      }
      if (action === "handoff") {
        const handedOff = await handoffSession(session, backend);
        const body = handedOff.ok
          ? {
              ok: true,
              backend,
              label: handedOff.label,
              homeName: handedOff.homeName,
              sessionId: handedOff.sessionId,
            }
          : { ok: false, backend, label: handedOff.label, error: handedOff.error };
        return handedOff.ok ? c.json(body) : c.json(body, 409);
      }
      if (action !== "resume") {
        return c.json({ ok: false, error: agentLaunchBlockedReason(session) }, 409);
      }
      if (agentResumeClaims.has(session.id)) {
        return c.json({ ok: false, error: "this conversation is already being resumed" }, 409);
      }

      const argv = resumeArgvFor(session.agent, session.agentSessionId!);
      if (!argv) return c.json({ ok: false, error: agentLaunchBlockedReason(session) }, 409);

      agentResumeClaims.add(session.id);
      const task =
        registry
          .listTasks()
          .find(
            (candidate) =>
              candidate.sessionId === session.id &&
              (candidate.status === "running" || candidate.status === "dispatching"),
          ) ?? null;
      if (task) {
        if (session.runtime === "sdk") clearSdkSessionTask(session.id);
        // Before launch: the old session's pending `session_remove` must not settle work
        // that is transferring to the replacement process.
        registry.upsertTask({ ...task, sessionId: null, updatedAt: Date.now() });
      }

      let result;
      try {
        result = await terminalLauncher(backend, {
          name: session.name,
          cwd: session.cwd!,
          argv,
        });
      } catch (error) {
        agentResumeClaims.delete(session.id);
        if (task) tasks.settleAfterFailedHandoff(task.id);
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ ok: false, backend, error: message }, 502);
      }
      if (task && (result.ok || result.status === 504)) {
        const current = registry.getTask(task.id);
        if (current) {
          registry.upsertTask({
            ...current,
            // `?? null`, never `?? current.homeName`. The launcher reports null when the
            // backend produced no durable home (an emulator tab), and keeping the OLD name
            // there would be the same bug by a different route: that home belonged to the
            // agent that exited, so a restart would read it as gone and reclaim a worktree
            // the resumed CLI is working in. Null means "could not tell", and only `false`
            // reclaims - see `TerminalLaunchOutcome.homeName` and `homeAlive`.
            homeName: result.homeName ?? null,
            terminalResourceId: null,
            updatedAt: Date.now(),
          });
        }
      } else if (!result.ok) {
        agentResumeClaims.delete(session.id);
        if (task) tasks.settleAfterFailedHandoff(task.id);
      }
      const body = {
        ok: result.ok,
        backend,
        label: result.label,
        ...(result.error ? { error: result.error } : {}),
      };
      return result.ok ? c.json(body) : c.json(body, result.status as 404 | 409 | 502 | 504);
    }

    const noCheckout = shellLaunchBlockedReason(session);
    if (noCheckout) return c.json({ ok: false, error: noCheckout }, 400);

    // From the DAEMON's own environment, never the checkout. A repo-supplied shell would
    // be arbitrary code execution on this host from a button labelled "Terminal".
    //
    // `-l` because the README calls this a LOGIN shell, and without it the promise is
    // false in a way an operator feels immediately: bash and zsh skip their login startup
    // files, so PATH, nvm/rbenv shims and prompt all differ from the terminal that person
    // opens by hand - in a window that exists to run the same commands they would. Every
    // shell this can resolve to (bash, zsh, fish, ksh, dash, csh/tcsh) accepts `-l`.
    const argv = [process.env.SHELL || "/bin/sh", "-l"];
    const result = await terminalLauncher(backend, { name: session.name, cwd: session.cwd!, argv });
    const body = {
      ok: result.ok,
      backend,
      label: result.label,
      ...(result.error ? { error: result.error } : {}),
    };
    return result.ok ? c.json(body) : c.json(body, result.status as 404 | 409 | 502 | 504);
  });
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
    // Both the repository AND the canonical path asked about: a caller configuring a
    // per-package check command needs the subdirectory back, which `repoRoot` alone has
    // already discarded. Existing callers read `repoRoot` and ignore the rest.
    const resolved = await resolveRepoPath(parsed.data.path);
    if (!resolved) return c.json({ error: `not a git repository: ${parsed.data.path}` }, 400);
    return c.json(resolved);
  });
  // Roundup report (/bearings): a projection of the live snapshot, as JSON or a
  // copy-pasteable markdown digest. Localhost reads, like /api/sessions.
  app.get("/api/report", (c) => c.json(buildReport(registry.snapshot())));
  app.get("/api/report.md", (c) => c.text(renderReportMarkdown(buildReport(registry.snapshot()))));
  app.get("/events", sseHandler(registry));
  // Live transcript for the expanded card (localhost-only, like the actions).
  app.get("/api/sessions/:id/transcript/stream", transcriptStreamHandler(registry));
  // One-shot transcript window for a non-streaming reader (Foreman's triage
  // reviewer, the queue verifier, and the dashboard's scroll-back).
  //
  // `?since=<byteOffset>` reads FORWARD from an offset - how the queue scopes a
  // window to one work item. A turn count can't do that: the default 60-turn window
  // can span three items, and the head+tail window elides the middle of a big file, so
  // filtering it by timestamp would silently drop an item's earliest turns (the
  // ones that establish what the agent set out to do). The transcript is
  // append-only, so a stored file size is an exact, O(1) item boundary.
  //
  // `?before=<byteOffset>` reads BACKWARD from one, which is what lets the conversation
  // panel scroll past the turns its stream opened on. Same anchor currency for the same
  // reason, and it chains: each page reports the `start` the next call passes back. The
  // panel is the only caller, but it belongs on this route rather than the SSE stream
  // because it is a request for history, not a subscription to new turns.
  app.get("/api/sessions/:id/transcript", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    // `unavailable` covers every reason there are no turns to serve - a harness declares
    // no conversation capability, or its file hasn't appeared yet - because the readers
    // downstream degrade the same way for all of them: Tier 1 routes UP rather than
    // judging a session it couldn't read.
    const t = sessionMessages(session);
    if (!t) return c.json({ messages: [], truncated: false, unavailable: true });
    // Read `before` off the raw query, not through Number(): `Number("")` is 0, and a 0
    // that arrived as an absent parameter would answer "no older history" for every
    // caller that forgot to send one - the same trap `since` sits in below.
    const beforeRaw = c.req.query("before");
    if (beforeRaw !== undefined && beforeRaw !== "") {
      const before = Number(beforeRaw);
      if (!Number.isSafeInteger(before) || before < 0) {
        return c.json({ error: "before must be a byte offset" }, 400);
      }
      const turns = Number(c.req.query("turns"));
      const want = Number.isFinite(turns) && turns > 0 ? Math.min(turns, 200) : undefined;
      const page = t.read.before(t.path, before, want);
      return c.json({ ...page, messages: attributeTranscript(session.id, page.messages) });
    }
    const since = Number(c.req.query("since"));
    if (Number.isFinite(since) && since >= 0) return c.json(t.read.since(t.path, since));
    const turns = Number(c.req.query("turns"));
    const tail = Number.isFinite(turns) && turns > 0 ? Math.min(turns, 200) : TRANSCRIPT_DEFAULT_TAIL_TURNS;
    return c.json(t.read.window(t.path, TRANSCRIPT_HEAD_TURNS, tail));
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
    // `commit` isolates ONE commit (`<sha>^..<sha>`). Distinct from `base`, which
    // diffs from the merge-base and would answer with everything since that sha.
    const commit = c.req.query("commit");
    if (commit) return c.json(await computeCommitDiff(session.cwd, commit));
    const source = c.req.query("base") || undefined;
    return c.json(await computeSessionDiff(session.cwd, source));
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

  app.post("/mcp/tasks", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, McpCreateTaskSchema);
    if (!parsed.ok) return parsed.res;
    const {
      env,
      sessionId,
      cwd,
      repoRoot: requestedRoot,
      dependsOnTaskIds,
      dependsOnCurrentSession,
    } = parsed.data;
    // The door this matters most at: the caller is an agent, and it passes its own cwd,
    // which for every session we dispatch is a pooled worktree. See `resolveTaskRepoRoot`.
    const resolved = await resolveTaskRepoRoot(requestedRoot);
    if (!resolved.ok) return c.json({ error: resolved.error }, 400);
    const repoRoot = resolved.repoRoot;

    const dependencies: TaskDependencyInput[] = dependsOnTaskIds.map((taskId) => ({
      type: "task",
      taskId,
    }));
    if (dependsOnCurrentSession) {
      const session = registry.findSessionByEnv(env, sessionId, cwd);
      if (!session) return c.json({ error: "no matching active session" }, 404);
      dependencies.push({ type: "session", sessionId: session.id });
    }

    try {
      const task = tasks.create({
        repoRoot,
        title: parsed.data.title,
        intent: parsed.data.intent,
        kind: "ship",
        agent: "claude",
        backlog: true,
        dependencies,
      });
      return c.json(task);
    } catch (error) {
      if (error instanceof TaskDependencyError) return c.json({ error: error.message }, 409);
      throw error;
    }
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

  // --- ensemble member submission (token-guarded MCP; attribution is server-side) ---
  app.post("/mcp/ensembles/submit", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const manager = ensembleManager();
    if (!manager) return c.json({ error: "Ensemble manager unavailable" }, 503);
    const parsed = await parseBody(c, SubmitEnsembleResultSchema);
    if (!parsed.ok) return parsed.res;
    // No id from the caller: the member is derived from its authenticated session, its Task, and
    // its worktree. A guessed ensemble/member id reaches nothing.
    const result = await manager.submitFromSession({
      env: parsed.data.env,
      sessionId: parsed.data.sessionId,
      cwd: parsed.data.cwd,
      claims: parsed.data.result,
    });
    const response = ensembleSubmitResponse(result);
    return c.json(response.body, response.status);
  });

  // --- ensemble catalog: list, side-effect-free preview, idempotent create ---
  app.get("/api/ensembles", (c) => {
    const manager = ensembleManager();
    if (!manager) return c.json({ error: "Ensemble manager unavailable" }, 503);
    // Compact summaries only; full members/artifacts/evaluations stay on the detail route. An
    // optional status filter and a bounded page keep the list bounded when a strategy launches many.
    const statusFilter = c.req.query("status");
    const limit = boundedLimit(c.req.query("limit"), ENSEMBLE_LIMITS.detailPageSize);
    const all = manager.summaries();
    const filtered = statusFilter ? all.filter((s) => s.status === statusFilter) : all;
    return c.json({ ensembles: filtered.slice(0, limit), total: filtered.length });
  });

  app.post("/api/ensembles/preview", async (c) => {
    const manager = ensembleManager();
    if (!manager) return c.json({ error: "Ensemble manager unavailable" }, 503);
    const parsed = await parseBody(c, EnsemblePreviewSchema);
    if (!parsed.ok) return parsed.res;
    // Side-effect-free: nothing is pinned or launched, so a bad draft is a 200 carrying its own
    // validation result, never a refusal status - the form shows the issues inline.
    return c.json(await manager.preview(parsed.data));
  });

  app.post("/api/ensembles", async (c) => {
    const manager = ensembleManager();
    if (!manager) return c.json({ error: "Ensemble manager unavailable" }, 503);
    const parsed = await parseBody(c, EnsembleCreateInputSchema);
    if (!parsed.ok) return parsed.res;
    const outcome = await manager.createAndLaunch(parsed.data);
    if (!outcome.ok) {
      const status = outcome.reason === "request_conflict" ? 409 : 400;
      return c.json({ error: outcome.reason, code: `ensemble_create_${outcome.reason}`, issues: outcome.issues }, status);
    }
    // `created: false` is the response-loss retry doing exactly what the source key exists for - one
    // run, not a second fleet - so it is a 200, not a conflict.
    return c.json({ run: outcome.run, summary: outcome.summary, created: outcome.created }, outcome.created ? 201 : 200);
  });

  app.post("/api/ensembles/:id/actions", async (c) => {
    const manager = ensembleManager();
    if (!manager) return c.json({ error: "Ensemble manager unavailable" }, 503);
    const parsed = await parseBody(c, EnsembleActionSchema);
    if (!parsed.ok) return parsed.res;
    const result = await manager.applyAction(c.req.param("id"), parsed.data);
    if (result.ok) {
      return c.json({ summary: result.summary, decision: result.decision ?? null, replayed: result.replayed ?? false });
    }
    const status = result.reason === "not_found" ? 404 : result.reason === "conflict" ? 409 : result.reason === "unavailable" ? 503 : 400;
    return c.json({ error: result.detail, code: `ensemble_action_${result.reason}` }, status);
  });

  app.delete("/api/ensembles/:id", async (c) => {
    const manager = ensembleManager();
    if (!manager) return c.json({ error: "Ensemble manager unavailable" }, 503);
    const parsed = await parseBody(c, EnsembleDeleteSchema);
    if (!parsed.ok) return parsed.res;
    // Terminal-only, and the id must be echoed in the body: deletion removes generated private refs,
    // and this is the one place an ensemble's evidence is destroyed.
    const result = await manager.deleteRun(c.req.param("id"), parsed.data.confirmId);
    if (result.ok) return c.json({ deleted: true });
    const status =
      result.reason === "not_found"
        ? 404
        : result.reason === "not_terminal"
          ? 409
          : result.reason === "incomplete"
            ? 500
            : 400;
    return c.json({ error: result.detail, code: `ensemble_delete_${result.reason}` }, status);
  });

  // --- ensemble read + manual submission (localhost only) ---
  app.get("/api/ensembles/:id", (c) => {
    const manager = ensembleManager();
    if (!manager) return c.json({ error: "Ensemble manager unavailable" }, 503);
    const detail = manager.detail(c.req.param("id"));
    if (!detail) return c.json({ error: "no such ensemble" }, 404);
    // Bounded on the way out: a later strategy may generate hundreds of events or attempts, and a
    // detail read must not become an unbounded transfer. The full patch is never here - it is its
    // own on-demand route.
    const eventsLimit = boundedLimit(c.req.query("eventsLimit"), ENSEMBLE_LIMITS.detailPageSize);
    const attemptsLimit = boundedLimit(c.req.query("attemptsLimit"), ENSEMBLE_LIMITS.detailPageSize);
    const events = detail.events.slice(-eventsLimit);
    const attempts = detail.attempts.slice(0, attemptsLimit);
    return c.json({
      ...detail,
      events,
      attempts,
      pagination: {
        eventsTotal: detail.events.length,
        eventsReturned: events.length,
        attemptsTotal: detail.attempts.length,
        attemptsReturned: attempts.length,
      },
    });
  });

  app.get("/api/ensembles/:id/artifacts/:artifactId", (c) => {
    const manager = ensembleManager();
    if (!manager) return c.json({ error: "Ensemble manager unavailable" }, 503);
    const detail = manager.detail(c.req.param("id"));
    if (!detail) return c.json({ error: "no such ensemble" }, 404);
    const artifact = detail.artifacts.find((a) => a.id === c.req.param("artifactId"));
    if (!artifact) return c.json({ error: "no such artifact" }, 404);
    // Metadata and bounded evidence only; the exact patch is the separate `/patch` route.
    return c.json({ artifact });
  });

  app.get("/api/ensembles/:id/artifacts/:artifactId/patch", async (c) => {
    const manager = ensembleManager();
    if (!manager) return c.json({ error: "Ensemble manager unavailable" }, 503);
    const detail = manager.detail(c.req.param("id"));
    if (!detail) return c.json({ error: "no such ensemble" }, 404);
    const artifact = detail.artifacts.find((a) => a.id === c.req.param("artifactId"));
    if (!artifact) return c.json({ error: "no such artifact" }, 404);
    if (artifact.status !== "ready" || artifact.kind === null) {
      return c.json({ error: `artifact is ${artifact.status ?? "unreadable"}` }, 409);
    }
    const adapter = artifactAdapterFor(artifact.kind);
    if (!adapter) return c.json({ error: `no adapter for ${artifact.kind} artifacts` }, 409);
    // Two cheaper questions than "the whole patch", both narrowing the patch text alone:
    // `?path=` is one exact file's hunks: a directory is refused, an absent file is an empty
    // patch, and either end of a rename selects that same one-file rename diff.
    // `?filesOnly=1` is the file list with no patch body at all. The statistics come back
    // complete either way, so `files` - never an empty patch - says whether a file was touched.
    //
    // ONE path per request, and a repeated key is refused rather than quietly reduced to the
    // first. The `/api/sessions/:id/standards` route above is the precedent for why there is no
    // list form: a few hundred encoded paths as query params overrun Node's 16KB default
    // `maxHeaderSize` and the request never arrives, which the caller can only see as an empty
    // answer. Taking the first of several would be the same silent wrongness in miniature - a
    // caller that meant to batch would get one file's diff labelled as the set.
    const requestedPaths = c.req.queries("path") ?? [];
    if (requestedPaths.length > 1) {
      return c.json({ error: "one path per request: repeat the request, not the path parameter" }, 400);
    }
    const path = requestedPaths[0];
    if (path !== undefined) {
      const refusal = snapshotPathRefusal(path);
      if (refusal) return c.json({ error: refusal }, 400);
    }
    const filesOnly = ["1", "true"].includes(c.req.query("filesOnly") ?? "");
    // Materialized on demand from the immutable commit, never stored - the ref lives in the shared
    // git dir, so the run's repo root can read it. The cap is explicit and its truncation honest.
    const maxBytes = boundedLimit(c.req.query("maxBytes"), 400 * 1024, 4 * 1024 * 1024);
    try {
      const material = await adapter.materialize(artifact.locator, {
        repoPath: detail.run.repoRoot,
        maxPatchBytes: maxBytes,
        paths: path === undefined ? undefined : [path],
        patch: !filesOnly,
      });
      return c.json(material);
    } catch (error) {
      if (error instanceof SnapshotPathRefused) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.post("/api/ensembles/:id/members/:memberId/submit", async (c) => {
    const manager = ensembleManager();
    if (!manager) return c.json({ error: "Ensemble manager unavailable" }, 503);
    const parsed = await parseBody(c, EnsembleMemberSubmitSchema);
    if (!parsed.ok) return parsed.res;
    // The operator names the member, but the daemon still verifies it is active and holds a live
    // worktree before capturing, and labels the result `operator` rather than a session's provenance.
    const result = await manager.submitManual(c.req.param("id"), c.req.param("memberId"), parsed.data.result);
    const response = ensembleSubmitResponse(result);
    return c.json(response.body, response.status);
  });

  // --- review resolution (from the dashboard, localhost) ---
  app.post("/api/reviews/:id/resolve", async (c) => {
    const parsed = await parseBody(c, ResolveReviewSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const updated = reviews.resolve(
        c.req.param("id"),
        parsed.data.action,
        parsed.data.response,
        parsed.data.by,
        parsed.data.selections,
      );
      if (!updated) return c.json({ error: "no such review" }, 404);
      return c.json(updated);
    } catch (error) {
      if (error instanceof ReviewResolutionError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  // --- session actions (localhost only) ---
  app.post("/api/sessions/:id/send", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, SendTextSchema);
    if (!parsed.ok) return parsed.res;
    if (parsed.data.submit && pendingTurns) {
      const result = pendingTurns.submit(session.id, parsed.data.text);
      return c.json(result, result.ok ? 200 : 409);
    }
    // An embedded session has no composer to type into, and `submit` has no meaning for it:
    // a turn is one acked call, not a paste followed by an Enter that may or may not land.
    // `canMessage` is what the Send box asks, so this arm is what makes that button honest.
    if (session.runtime === "sdk") {
      const sent = await deliverToDriver(sdkSessions, session, parsed.data.text);
      return c.json(
        {
          ok: sent.ok,
          ...(sent.delivery ? { delivery: sent.delivery } : {}),
          ...(sent.error ? { error: sent.error } : {}),
        },
        sent.ok ? 200 : 500,
      );
    }
    const r = await sendText(
      session,
      parsed.data.text,
      parsed.data.submit,
      undefined,
      () => registry.promptResourceBlockerForSession(session.id),
    );
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
    // Held before either branch delivers, because both clear the ask they answered - see
    // `retireForemanNoteForDialog`.
    const asked = activePaneDialog(session);
    // One route, two runtimes, one refusal code. A driver request is answered by resolving
    // the callback the agent is blocked on rather than by walking a cursor, but everything
    // the CALLER sees is the same - `{number, label}` in, 409 and "nothing was selected"
    // out - which is what keeps the dashboard's prompt, Foreman's `answer.option` and the
    // MCP tool on one grammar instead of three.
    if (session.runtime === "sdk") {
      const r = await answerDriverRequest(
        sdkSessions,
        session,
        (dialog) => driverOptionAnswer(dialog, parsed.data),
        { reviews, by: parsed.data.by },
      );
      if (r.ok) retireForemanNoteForDialog(registry, session, asked, parsed.data.by);
      return c.json(r, r.ok ? 200 : 409);
    }
    const r = await selectPaneOption(session, parsed.data);
    if (r.ok) retireForemanNoteForDialog(registry, session, asked, parsed.data.by);
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
    const { options, answers } = parsed.data;
    // See the same line in `/select-option`: the ask is gone once it has been answered.
    const asked = activePaneDialog(session);
    // The two bodies are not interchangeable, and each runtime takes exactly one. A pane
    // form is a list of checkbox ROWS on one screen; a driver form is an answers map across
    // several questions, each numbering its own options from 1. Sending the wrong one is a
    // caller bug, so it is refused rather than coerced - a flattened driver form would tick
    // the right-numbered row of the wrong question.
    if (session.runtime === "sdk") {
      if (!answers) {
        return c.json(
          { ok: false, error: "this session's form is answered with a driver answers map" },
          409,
        );
      }
      const r = await answerDriverRequest(
        sdkSessions,
        session,
        (dialog) => driverFormAnswer(dialog, answers),
        { reviews, by: parsed.data.by },
      );
      if (r.ok) retireForemanNoteForDialog(registry, session, asked, parsed.data.by);
      return c.json(r.ok ? { ...r, outcome: "submitted" as const } : r, r.ok ? 200 : 409);
    }
    if (!options) {
      return c.json(
        { ok: false, error: "this session's form is answered with pane rows" },
        409,
      );
    }
    const r = await submitPaneForm(session, options);
    // `formDelivered`, not `ok`: a pane form reports `ok` for two states that sent the child
    // nothing, and retiring on either drops a decision that is still owed.
    if (formDelivered(r)) retireForemanNoteForDialog(registry, session, asked, parsed.data.by);
    return c.json(r, r.ok ? 200 : 409);
  });

  // Hand an embedded session back to a real terminal, continuing the same conversation.
  //
  // The escape hatch that makes the SDK runtime's one real loss survivable: no pane to look
  // at or type into. Both vendors share a session store between their programmatic and
  // interactive surfaces, so this stops the driver and reopens the SAME conversation under
  // `claude --resume <id>`; discovery adopts the new process and the task's binding follows
  // it. Not idempotent and not a toggle - there is no way back, because the terminal
  // session is now the one holding the conversation.
  app.post("/api/sessions/:id/handoff", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const r = await handoffSession(session);
    return c.json(r, r.ok ? 200 : 409);
  });

  // Rename the session. On the terminal runtime that means the session's handle - discovery
  // reads the new name back onto the card - and on the embedded one it means the durable row,
  // which is the only place an SDK session's name can live. Either way the registry echoes it
  // immediately so the card doesn't lag a poll. A name the backing handle can't accept, or one
  // a task's teardown still aims at, is a 400 the editor can show; a failure to land it a 500.
  //
  // ONE route for both runtimes rather than a second endpoint: everything the caller sees is
  // the same - `{name}` in, the card renamed out - which is what keeps the title click, the
  // command bar's keycap and Shift+R on one code path instead of branching per runtime in the
  // browser, where the runtime is the least interesting thing about the session being named.
  app.post("/api/sessions/:id/rename", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, RenameSchema);
    if (!parsed.ok) return parsed.res;
    const valid = validateSessionName(session, parsed.data.name);
    if (!valid.ok) return c.json({ ok: false, error: valid.error }, 400);
    const free = validateSessionNameAgainstTasks(session, valid.name, registry.listTasks());
    if (!free.ok) return c.json({ ok: false, error: free.error }, 400);
    const r = await rename(session, valid.name, undefined, renameDriverSession);
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
    if (parsed.data.origin === "human" && parsed.data.buffer && pendingTurns) {
      const result = pendingTurns.submit(session.id, parsed.data.text);
      return c.json(result, result.ok ? 200 : 409);
    }
    // The same delivery, reported in this route's own vocabulary. Both of its ambiguous
    // states are unreachable for an embedded session - see `deliverToDriver` - so a refusal
    // here is positive evidence that nothing landed, which is the only state a caller may
    // safely retry from.
    const r = await injectPromptForRuntime(
      sdkSessions,
      session,
      parsed.data.text,
      undefined,
      () => registry.promptResourceBlockerForSession(session.id),
    );
    // Only once it landed: a refused or failed delivery is not a turn anybody will read,
    // and claiming it would mis-attribute a LATER turn that happens to repeat the text.
    if (r.ok && parsed.data.origin !== "human") recordInjection(session.id, parsed.data.text, parsed.data.origin);
    return c.json(r, r.ok ? 200 : 500);
  });

  app.post("/api/sessions/:id/pending-turns/:turnId/recall", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (!pendingTurns) return c.json({ error: "pending turns are unavailable" }, 503);
    const parsed = await parseBody(c, PendingTurnRevisionSchema);
    if (!parsed.ok) return parsed.res;
    const turn = pendingTurns.recall(session.id, c.req.param("turnId"), parsed.data.revision);
    return turn
      ? c.json({ ok: true as const, text: turn.text })
      : c.json({ ok: false as const, error: "that queued message is no longer editable" }, 409);
  });

  app.post("/api/sessions/:id/pending-turns/:turnId/retry", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (!pendingTurns) return c.json({ error: "pending turns are unavailable" }, 503);
    const parsed = await parseBody(c, PendingTurnRevisionSchema);
    if (!parsed.ok) return parsed.res;
    const turn = pendingTurns.retry(session.id, c.req.param("turnId"), parsed.data.revision);
    return turn
      ? c.json({ ok: true as const })
      : c.json({ ok: false as const, error: "that message can no longer be retried" }, 409);
  });

  app.post("/api/sessions/:id/pending-turns/:turnId/resolve", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (!pendingTurns) return c.json({ error: "pending turns are unavailable" }, 503);
    const parsed = await parseBody(c, PendingTurnRevisionSchema);
    if (!parsed.ok) return parsed.res;
    const resolved = pendingTurns.resolve(session.id, c.req.param("turnId"), parsed.data.revision);
    return resolved
      ? c.json({ ok: true as const })
      : c.json({ ok: false as const, error: "that message can no longer be resolved" }, 409);
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
    // SDK teardown may spend seconds flushing its subprocess and event stream. Interactive
    // Kill and Complete need only the supervisor's accepted stop; terminal handoff and
    // daemon shutdown keep using the blocking `stopSession`/`SdkSupervisor.stop` contract.
    const r = await requestSessionStop(session, sdkSessions);
    return c.json(r, r.ok ? 200 : 500);
  });

  // Cycle the session's permission mode one Shift+Tab step - only for a harness whose
  // live control is a cycle. Menu-based harnesses use the named-mode route below.
  app.post("/api/sessions/:id/mode/cycle", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const refusal = noPermissionModeCycle(session);
    if (refusal) return c.json({ error: refusal }, 400);
    const r = await cyclePermissionMode(session);
    // `r.mode` was read back off the pane, so recording it can't diverge from
    // what Claude actually did; it's null when the pane didn't show us a mode.
    if (r.ok) registry.recordObservedPermissionMode(session.id, r.mode ?? null);
    return c.json(r, r.ok ? 200 : 500);
  });

  // Drive the session to a specific permission mode through the harness's declared
  // live control: a verified Shift+Tab walk or a verified native picker selection.
  app.post("/api/sessions/:id/mode", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const refusal = noPermissionModes(session);
    if (refusal) return c.json({ error: refusal }, 400);
    const parsed = await parseBody(c, SetPermissionModeSchema);
    if (!parsed.ok) return parsed.res;
    const r = session.runtime === "sdk"
      ? await (async () => {
          const modes = harnessFor(session.agent).permissionModes;
          if (!modes?.pickable.includes(parsed.data.mode)) {
            return {
              ok: false,
              error: `${parsed.data.mode} is not available for this agent`,
              mode: session.permissionMode,
            };
          }
          if (!sdkSessions) {
            return { ok: false, error: "this build has no session supervisor", mode: null };
          }
          try {
            await sdkSessions.setPermissionMode(session.id, parsed.data.mode);
            return { ok: true, mode: parsed.data.mode };
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              mode: session.permissionMode,
            };
          }
        })()
      : await setPermissionMode(session, parsed.data.mode);
    // A cycle walk can stop early in a mode it read off the footer, so retain that
    // observation even on failure. A successful SDK change is authoritative too: the
    // driver accepted and persisted the posture it will put on the next turn, so leaving
    // the card on the old rollout value makes the control look like a no-op. Codex's
    // freshness guard keeps that accepted value from being overwritten by the current
    // turn's older context before the next turn records the new reviewer.
    //
    // A menu failure observed no new mode: recording its old snapshot would incorrectly
    // start that same freshness guard.
    const liveControl = harnessFor(session.agent).permissionModes?.liveControl;
    if (r.ok || liveControl?.kind === "cycle") {
      registry.recordObservedPermissionMode(session.id, r.mode ?? null);
    }
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
    const r = session.runtime === "sdk"
      ? await (async () => {
          // The DRIVER gate, not the pane one: a `shortcuts` picker's one-step-at-a-time
          // reachability is a fact about keystrokes, and an embedded session has none.
          const targetResult = driverEffortTargetResult(session, parsed.data.effort);
          if (targetResult) return targetResult;
          if (!sdkSessions) {
            return {
              ok: false,
              error: "this build has no session supervisor",
              effort: null,
            };
          }
          try {
            await sdkSessions.setEffort(session.id, parsed.data.effort);
            return { ok: true, effort: parsed.data.effort };
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              effort: null,
            };
          }
        })()
      : await setSessionEffort(session, parsed.data.effort, {
          ...defaultPaneDeps,
          assertBeforeWrite: () => {
            const current = registry.getSession(session.id);
            return current?.agent === session.agent &&
              current.agentSessionId === session.agentSessionId &&
              current.transcriptPath === session.transcriptPath;
          },
        });
    if (
      r.ok &&
      (session.runtime === "terminal" || session.agent !== "codex") &&
      !registry.recordObservedSessionEffort(session.id, r.effort, session)
    ) {
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
    const r = await resetSession(
      registry,
      session,
      parsed.data.clear,
      undefined,
      driverClearFor(sdkSessions),
      pendingTurns,
    );
    return c.json(r, r.ok ? 200 : 500);
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
      // Fail soft: by the time the worker posts this it has already delivered its
      // answer and stamped the note.
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

  /**
   * The answers this session's human gave, for the conversation to replay.
   *
   * Read from SQLite rather than from the registry's review map, which is the live one the
   * SSE stream publishes. That map holds a resolved review only until the daemon restarts -
   * `loadPendingReviews` restores exactly the pending rows at boot, by design - so serving
   * the conversation from it would quietly empty every answer out of the log on restart,
   * while the transcript beside them survived. The dashboard folds the live reviews in on
   * top of this for immediacy; this is the half that is still there tomorrow.
   */
  app.get("/api/sessions/:id/resolved-reviews", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json(loadHumanResolvedReviews(session.id));
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
  // on. `ask` atomically raises the matching Ship it? card too; splitting those writes
  // can retire a verified episode and then permanently lose its question on a daemon
  // error. A separate endpoint from the drain ask because the two triggers still own
  // separate guards - see `SessionQueue.promptedGoal`.
  //
  // Same `ensureQueue` reasoning: these sessions have no queue by definition.
  app.post("/api/sessions/:id/queue/wrapup/prompted", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, PromptedWrapupSchema);
    if (!parsed.ok) return parsed.res;
    const key = registry.ensureQueue(session.id);
    if (!key) return c.json({ error: "no queue for this session" }, 404);
    const now = Date.now();
    registry.setQueueWrapup(
      key,
      parsed.data.ask
        ? {
            promptedGoal: parsed.data.goal,
            wrapupAskedAt: now,
            wrapupAnswer: null,
          }
        : { promptedGoal: parsed.data.goal },
      now,
    );
    return c.json(queues.get(session.id));
  });

  // The full intent record, including its durable objective and latest human prompt.
  // Loopback-only like the rest of the worker's surface: `SessionGoal.prompt` is
  // deliberately never denormalized onto a card (it can be 4KB of someone's paste),
  // so this is how the worker and intent drawer inspect the full completion contract.
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
    const config = setForemanConfig(parsed.data);
    if (config.enabled) workflowManager()?.reconcileDispatchedTaskWorkflows();
    return c.json(config);
  });
  app.get("/api/foreman/status", (c) => c.json(foremanStatus(registry)));
  // The fleet-wide episode ledger, newest first - the cross-session counterpart to
  // `/api/sessions/:id/foreman-episodes`, and the direct analogue of `/api/inspector/prs`
  // above. Capped because it is a display; nothing else reads it.
  //
  // A plain fetch rather than an SSE collection, deliberately: an episode carries the
  // child's screen at decision time, so putting the fleet's worth of them on the live
  // channel would ship a screen capture to every client on every frame - the reasoning
  // `Registry.recordEpisode` already states for the per-session list, and it holds just
  // as well for a 4s poll.
  app.get("/api/foreman/episodes", (c) => c.json(recentEpisodes(FOREMAN_EPISODE_LEDGER)));
  // One episode in full, which is the read the summary above exists to avoid making a
  // hundred times over. Opening a ledger row fetches exactly the decision being opened, so
  // the pane, the brief, the recommendation and the delivered text stay off the poll and
  // are still one click away - the same trade `/api/sessions/:id/foreman-episodes` makes
  // for a surface that shows one session, made here for a surface that shows the fleet.
  //
  // 404 rather than `null` on a miss, unlike the backlog plan below: a row is either in the
  // 30-day window or it has been pruned out of it, and "this decision no longer exists" is
  // a different answer from "there is nothing to show", which is what the ledger's own
  // empty state already says.
  app.get("/api/foreman/episodes/:id", (c) => {
    const id = Number(c.req.param("id"));
    const episode = Number.isInteger(id) ? episodeById(id) : null;
    return episode ? c.json(episode) : c.json({ error: "no such episode" }, 404);
  });

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
   * A LOOK at the window still open, for the topbar's away card. Never consumes.
   *
   * Beside `/api/away/digest` rather than folded into it, because that route cannot
   * answer this question even in principle: it hands the buffer over exactly once, and
   * it reports nothing at all while you are still away, since the pending slot only
   * fills when the window CLOSES. Polling it for a live count would read 204 for the
   * whole away window and then destroy the digest on the one read that worked.
   */
  app.get("/api/away/buffer", (c) => c.json(summarizeBuffer(away?.buffer() ?? null)));

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

  /**
   * The Foreman worker reporting what one of its headless runs cost.
   *
   * Loopback-only like every other `/api/*` route, and unlike `/v1/metrics` above there is
   * no token check: this is the worker talking to its own daemon over 127.0.0.1, the same
   * trust boundary its lease and its work-queue writes already sit on. The OTLP route needs
   * a token because it is reached by every Claude Code process on the machine.
   *
   * 204, with nothing to say. The worker cannot act on the outcome - the run already
   * happened and the tokens are already spent - so a body would only invite it to branch on
   * something that must never fail a review.
   */
  app.post("/api/usage/automation", async (c) => {
    const parsed = await parseBody(c, SpendReportSchema);
    if (!parsed.ok) return parsed.res;
    const outcome = recordSpendReport(parsed.data);
    if (outcome.kind === "recorded") {
      registry.applyAutomationUsage();
      return c.body(null, 204);
    }
    // A report this daemon CANNOT record must not be acknowledged. The worker treats any
    // 2xx as proof the spend landed and erases its durable copy, so a 204 here would delete
    // an already-paid-for run that never reached the ledger - and the case is real rather
    // than theoretical: a worker newer than its daemon can name a runner this build has no
    // pricing for. 422 puts it in the worker's quarantine instead, where it survives until
    // the daemon is upgraded.
    if (outcome.kind === "unsupported") {
      return c.json({ error: `cannot record this spend report: ${outcome.reason}` }, 422);
    }
    // `empty` is genuinely nothing to store - a run that reported no tokens at all.
    // Acknowledging it is right: there is no spend to lose, and refusing would have the
    // worker hold a zero-token report for a recovery that has nothing to recover.
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
    registry.inspectorConfigChanged();
    // The rail dots and gear read Inspector enabled+mode off the live channel, so a write
    // that could move either has to push the new tuple (dropped downstream if unchanged).
    publishSettingsStatus(registry);
    return c.json(next);
  });
  // The ledger. This is what makes dry-run legible: without somewhere to read what it
  // WOULD have said, a preview mode is indistinguishable from a broken one.
  //
  // Two readings of the same rows, because there are two questions. Without a parameter:
  // the 50 most recently REVIEWED, which is the Inspector settings panel's list - capped
  // because it is a display, and the registry's own copy is deliberately not.
  //
  // With `adoptedSince` (epoch ms): every pull request ADOPTED since then, newest
  // adoption first, uncapped. That is the ledger as a ship log, and it has to be a
  // separate reading rather than a bigger limit - review recency is not ship order, so
  // paging the default further back would still hand a caller a week whose order moves
  // whenever the Inspector re-reviews something, and a cap would truncate a busy week
  // against the Line's Shipped count, which is uncapped by construction (`prsOpenedSince`).
  // One route rather than two over the same table, for the reason `useShipping` records:
  // a second endpoint over one ledger is a second thing to keep honest.
  app.get("/api/inspector/prs", (c) => {
    const raw = c.req.query("adoptedSince");
    if (raw === undefined) return c.json(loadInspectorInspections(50));
    // Two guards, each doing work the other cannot.
    //
    // The SHAPE is matched as text before anything is coerced, because `Number()` is far too
    // willing here: it reads `""`, `"  "` and `"\n"` as 0, and 0 means "the entire ledger,
    // from the epoch" - the most expensive answer this route has, returned confidently for a
    // typo or for an unset variable a caller interpolated. Digits only, so what counts as a
    // timestamp has one definition rather than whatever the coercion happens to accept
    // ("1e3", "0x10", " 5 ", "-1"). The length cap bounds what gets parsed at all.
    //
    // The VALUE is then checked for exactness, which the shape cannot speak to: a 17-digit
    // run of digits is well formed and still lands past 2^53, where it silently stops being
    // the number the caller wrote.
    const since = /^\d{1,20}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(since)) {
      return c.json({ error: "adoptedSince must be an epoch-ms timestamp" }, 400);
    }
    return c.json(loadInspectionsAdoptedSince(since));
  });
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
    const next = setShippingConfig(parsed.data);
    // YOLO's armed state is an amber dot; a toggle here has to reach the rail and gear.
    publishSettingsStatus(registry);
    return c.json(next);
  });

  // --- Harnesses: dispatch-time defaults for launched sessions (localhost only) ---
  app.get("/api/harnesses/config", (c) => c.json(getHarnessesConfig()));
  app.put("/api/harnesses/config", async (c) => {
    const parsed = await parseBody(c, HarnessesConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    const next = setHarnessesConfig(parsed.data);
    // Announced like every sibling settings route publishes its own change. Without this the
    // settings panel learned of another tab's edit only on its next poll, and an already-open
    // dispatch modal - which reads these defaults once, when it opens - never learned at all
    // and went on naming a model that was no longer the default.
    registry.emitHarnessesConfigChanged();
    return c.json(next);
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
   * Each source's repo is resolved to a git root here so a typo cannot enter its config.
   * This intentionally uses the general resolver: a human may configure a checkout that
   * is valid even when it cannot be attributed to a main checkout. The sweep applies
   * `resolveTaskRepoRoot` before filing any task and reports that stricter refusal there.
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
    // Removing a failing source, or pausing one, changes the failing count the red dot
    // reads. `noteTaskSourceConfigChange` has already cleared health for a just-paused
    // source, so this recompose sees the new count.
    publishSettingsStatus(registry);
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
    const report = await sweepOnce(inst, tasks);
    // A hand sweep records or clears this source's `lastError`, which is exactly what the
    // red dot counts. The background loop pushes the same way via its `onSwept` hook.
    publishSettingsStatus(registry);
    return c.json(report);
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
    const workflowId = resolveTaskWorkflowId(parsed.data.workflowId);
    const resolved = await resolveTaskRepoRoot(parsed.data.repoRoot);
    if (!resolved.ok) return c.json({ error: resolved.error }, 400);
    const repoRoot = resolved.repoRoot;
    if (workflowId) {
      const manager = workflowManager();
      if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
      const blocked = parsed.data.backlog
        ? manager.workflowSelectionBlock(workflowId)
        : manager.dispatchWorkflowBlock(workflowId, parsed.data.agent, repoRoot);
      if (blocked) return c.json({ error: blocked }, 409);
    }
    let task;
    try {
      task = tasks.create({ ...parsed.data, repoRoot, workflowId });
    } catch (error) {
      if (error instanceof TaskDependencyError) return c.json({ error: error.message }, 409);
      throw error;
    }
    return c.json(task);
  });

  // Edit a task. A repo change is resolved the same way `POST /api/tasks` resolves one,
  // so a task cannot be edited into pointing at an invalid task root. Refusals mirror
  // `assign`: 404 for a task that is gone, 409 for one that has left the backlog and can
  // no longer be REWRITTEN - though a priority/labels-only patch is annotation and stays
  // allowed in any status (see `TaskManager.update`).
  app.post("/api/tasks/:id/update", async (c) => {
    const parsed = await parseBody(c, UpdateTaskSchema);
    if (!parsed.ok) return parsed.res;
    const patch = parsed.data;
    const id = c.req.param("id");
    const existing = tasks.get(id);
    // Resolved only when the repo actually MOVES. A caller restating the root it was
    // handed is not asking for anything, and re-checking it makes a task uneditable the
    // moment its repo goes away - a reclaimed worktree, a directory since renamed - so a
    // priority change would be refused on the strength of a path the edit never touched,
    // under an error message about git that names neither the field nor the task.
    if (patch.repoRoot !== undefined && patch.repoRoot !== tasks.get(id)?.repoRoot) {
      const resolved = await resolveTaskRepoRoot(patch.repoRoot);
      if (!resolved.ok) return c.json({ error: resolved.error }, 400);
      // Assigned in place rather than spread as `{...patch, repoRoot}`: that spread names
      // the key even when it is undefined, and `isAnnotationOnlyUpdate` counts KEYS - so a
      // priority-only patch would look like it touched the repo and get refused on any
      // task that had already been dispatched.
      patch.repoRoot = resolved.repoRoot;
    }
    if (existing) {
      const workflowId =
        patch.workflowId === undefined ? existing.workflowId : patch.workflowId;
      if (workflowId) {
        const manager = workflowManager();
        if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
        const blocked = manager.workflowSelectionBlock(workflowId);
        if (blocked) return c.json({ error: blocked }, 409);
      }
    }
    const r = await tasks.update(id, patch);
    return c.json(r, r.ok ? 200 : r.error === "no such task" ? 404 : 409);
  });

  app.post("/api/tasks/:id/dispatch", async (c) => {
    const parsed = await parseBody(c, DispatchBacklogTaskSchema);
    if (!parsed.ok) return parsed.res;
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (task?.workflowId) {
      const manager = workflowManager();
      if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
      const blocked = manager.dispatchWorkflowBlock(
        task.workflowId,
        task.agent,
        task.repoRoot,
      );
      if (blocked) return c.json({ error: blocked }, 409);
    }
    const r = await tasks.dispatch(id, parsed.data);
    if (!r.ok) {
      return c.json({ error: r.error }, r.error === "no such task" ? 404 : 409);
    }
    return c.json(r.task!);
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
    const id = c.req.param("id");
    const task = tasks.get(id);
    const session = registry.getSession(parsed.data.sessionId);
    if (task && session) {
      const manager = workflowManager();
      if (task.workflowId) {
        if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
        const blocked = manager.dispatchWorkflowBlock(
          task.workflowId,
          session.agent,
          task.repoRoot,
        );
        if (blocked) return c.json({ error: blocked }, 409);
      }
      // Explicit None is intent too: it must not be assigned onto a conversation whose
      // existing binding would still run a Workflow after this task completes.
      const conflict = manager?.assignmentWorkflowBlock(task.workflowId, session) ?? null;
      if (conflict) return c.json({ error: conflict }, 409);
    }
    const r = await tasks.assign(id, parsed.data.sessionId, {
      overrideDisabled: parsed.data.overrideDisabled,
      confirmReset: parsed.data.confirmReset,
    });
    return c.json(r, r.ok ? 200 : r.error === "no such task" ? 404 : 409);
  });

  app.post("/api/tasks/:id/cancel", async (c) => {
    const r = await tasks.cancel(c.req.param("id"));
    return c.json(r, r.ok ? 200 : 404);
  });

  // Put a cancelled/failed task back into the backlog so it can run again. A refusal is a
  // 404 when the task is gone and a 409 when it is in a state that cannot be re-filed (a
  // done task, a live one) - a state conflict the operator can see, exactly like assign.
  app.post("/api/tasks/:id/reschedule", async (c) => {
    const parsed = await parseBody(c, RescheduleTaskSchema);
    if (!parsed.ok) return parsed.res;
    const r = await tasks.reschedule(c.req.param("id"));
    return c.json(r, r.ok ? 200 : r.error === "no such task" ? 404 : 409);
  });

  // Free a terminal task's leftover worktree/agent, keeping its status + outcome.
  app.post("/api/tasks/:id/reclaim", async (c) => {
    const r = await tasks.reclaim(c.req.param("id"));
    return c.json(r, r.ok ? 200 : 404);
  });

  app.post("/api/tasks/:id/complete", async (c) => {
    const parsed = await parseBody(c, CompleteTaskSchema);
    if (!parsed.ok) return parsed.res;
    let t;
    try {
      t = tasks.complete(
        c.req.param("id"),
        parsed.data.outcome,
        parsed.data.outcomeUrl,
        parsed.data.satisfyDependents,
        parsed.data.requireStopped,
      );
    } catch (error) {
      if (error instanceof TaskStatusConflictError) return c.json({ error: error.message }, 409);
      throw error;
    }
    if (!t) return c.json({ error: "no such task" }, 404);
    return c.json(t);
  });

  app.delete("/api/tasks/:id", async (c) => {
    const r = await tasks.remove(c.req.param("id"));
    return c.json(r, r.ok ? 200 : r.error === "no such task" ? 404 : 409);
  });

  // --- Recurring Missions: schedule catalog, preview, and paginated history ---
  //
  // Thin adapters over the schedule service. Each validates SHAPE through `parseBody`, calls
  // exactly one service method, and maps its durable result to HTTP. No recurrence, policy,
  // or schedule SQL lives here: the service owns that, and under it Phase 1's store. The
  // service is the only schedule writer; the Registry is its live cache and notifier.
  const scheduleService = (): ScheduleService | null => schedules ?? null;

  /** A service validation refusal, carrying the field so the editor can attach the message. */
  const scheduleValidationFailure = (c: Context, error: ScheduleValidationError) =>
    c.json({ error: error.message, field: error.field }, 400);

  app.get("/api/schedules", (c) => {
    const svc = scheduleService();
    if (!svc) return c.json({ error: "Schedule service unavailable" }, 503);
    // Served from the Registry, the SAME live collection the SSE snapshot carries, so a GET
    // and a reconnect return byte-identical catalogs. Non-archived schedules only.
    return c.json(registry.listSchedules());
  });

  // Preview is a READ: no schedule, revision, occurrence, or task is written and no
  // ServerEvent is emitted. It forwards the WHOLE definition and the service runs the same
  // validation save does - cadence, name, title, intent, and repo-root resolution - so the
  // browser can never preview a definition the save route would then refuse.
  app.post("/api/schedules/preview", async (c) => {
    const svc = scheduleService();
    if (!svc) return c.json({ error: "Schedule service unavailable" }, 503);
    const parsed = await parseBody(c, SchedulePreviewSchema);
    if (!parsed.ok) return parsed.res;
    const d = parsed.data;
    const result = await svc.previewDefinition({
      name: d.name,
      expression: d.expression,
      timezone: d.timezone,
      overlapPolicy: d.overlapPolicy,
      missedPolicy: d.missedPolicy,
      template: d.template,
      after: d.after,
      count: d.count,
      sleepStartedAt: d.sleepStartedAt,
      resumedAt: d.resumedAt,
      excludeScheduleId: d.excludeScheduleId,
    });
    // A definition the shape layer passed but the service rejects (a bad IANA zone, a
    // sub-hour interval, a non-repository root) returns `ok:false` with the offending field -
    // a 400, not a 500.
    return result.ok ? c.json(result) : scheduleValidationFailure(c, result.error);
  });

  app.post("/api/schedules", async (c) => {
    const svc = scheduleService();
    if (!svc) return c.json({ error: "Schedule service unavailable" }, 503);
    const parsed = await parseBody(c, CreateScheduleSchema);
    if (!parsed.ok) return parsed.res;
    const d = parsed.data;
    // The service canonicalizes cadence and repo root and returns the canonical schedule.
    // `executionMode` / `runnerId` are validated by the schema but not forwarded: V1 pins them.
    const result = await svc.create({
      name: d.name,
      expression: d.expression,
      timezone: d.timezone,
      overlapPolicy: d.overlapPolicy,
      missedPolicy: d.missedPolicy,
      template: d.template,
      enabled: d.enabled,
    });
    return result.ok ? c.json(result.schedule, 201) : scheduleValidationFailure(c, result.error);
  });

  app.post("/api/schedules/:id/update", async (c) => {
    const svc = scheduleService();
    if (!svc) return c.json({ error: "Schedule service unavailable" }, 503);
    const parsed = await parseBody(c, UpdateScheduleSchema);
    if (!parsed.ok) return parsed.res;
    const existing = svc.get(c.req.param("id"));
    if (!existing) return c.json({ error: "no such schedule" }, 404);
    // An archived schedule is present but out of the catalog: it cannot be edited, and that
    // is a 404 (no editable schedule under this id), not a validation 400.
    if (existing.archivedAt !== null) return c.json({ error: "this schedule is archived" }, 404);
    const d = parsed.data;
    const result = await svc.update(existing.id, {
      name: d.name,
      expression: d.expression,
      timezone: d.timezone,
      overlapPolicy: d.overlapPolicy,
      missedPolicy: d.missedPolicy,
      template: d.template,
    });
    return result.ok ? c.json(result.schedule) : scheduleValidationFailure(c, result.error);
  });

  app.post("/api/schedules/:id/set-enabled", async (c) => {
    const svc = scheduleService();
    if (!svc) return c.json({ error: "Schedule service unavailable" }, 503);
    const parsed = await parseBody(c, SetScheduleEnabledSchema);
    if (!parsed.ok) return parsed.res;
    const existing = svc.get(c.req.param("id"));
    if (!existing) return c.json({ error: "no such schedule" }, 404);
    if (existing.archivedAt !== null) return c.json({ error: "this schedule is archived" }, 404);
    // The service recomputes the cursor from the resume instant (enabling) or clears it
    // (pausing); the route never does date math.
    const result = await svc.setEnabled(existing.id, parsed.data.enabled);
    return result.ok ? c.json(result.schedule) : scheduleValidationFailure(c, result.error);
  });

  // Run now works while paused and leaves the cron cursor untouched (see the service). The
  // occurrence it returns carries its own terminal status, so an overlap skip or a failed
  // fire-time repo check is a 200 with that outcome rather than an HTTP error.
  app.post("/api/schedules/:id/run-now", async (c) => {
    const svc = scheduleService();
    if (!svc) return c.json({ error: "Schedule service unavailable" }, 503);
    const parsed = await parseBody(c, RunScheduleNowSchema);
    if (!parsed.ok) return parsed.res;
    const existing = svc.get(c.req.param("id"));
    if (!existing) return c.json({ error: "no such schedule" }, 404);
    if (existing.archivedAt !== null) return c.json({ error: "this schedule is archived" }, 404);
    const result = await svc.runNow(existing.id);
    // After the pre-checks above, a refusal is a claim race or an unreadable revision - a
    // state conflict the operator can retry, i.e. a 409.
    return result.ok
      ? c.json({ occurrence: result.occurrence, schedule: result.schedule })
      : c.json({ error: result.error }, 409);
  });

  // Archive is idempotent and removes the schedule from the live catalog ONLY after the
  // durable archive write: the service notifies `remove` post-commit, which emits
  // `schedule_remove`. Direct occurrence history stays reachable afterwards.
  app.post("/api/schedules/:id/archive", async (c) => {
    const svc = scheduleService();
    if (!svc) return c.json({ error: "Schedule service unavailable" }, 503);
    const parsed = await parseBody(c, ArchiveScheduleSchema);
    if (!parsed.ok) return parsed.res;
    const schedule = await svc.archive(c.req.param("id"));
    return schedule ? c.json(schedule) : c.json({ error: "no such schedule" }, 404);
  });

  // Occurrence history is page-oriented and fetched on demand, never in the SSE snapshot.
  // The page carries the schedule INCLUDING an archived one, so a generated task can still
  // deep-link to its run history after the schedule has left the catalog.
  app.get("/api/schedules/:id/occurrences", (c) => {
    const svc = scheduleService();
    if (!svc) return c.json({ error: "Schedule service unavailable" }, 503);
    const query = ScheduleHistoryQuerySchema.safeParse({
      before: c.req.query("before"),
      limit: c.req.query("limit"),
    });
    // An unparseable cursor or an out-of-range limit is refused, not clamped: paging through
    // the wrong window silently is worse than a 400 the caller can see.
    if (!query.success) return c.json({ error: query.error.message }, 400);
    const page = svc.history(c.req.param("id"), {
      before: query.data.before ?? null,
      limit: query.data.limit ?? SCHEDULE_HISTORY_DEFAULT_LIMIT,
    });
    return page ? c.json(page) : c.json({ error: "no such schedule" }, 404);
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
