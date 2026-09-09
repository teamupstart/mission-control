import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { TypeOf, ZodTypeAny } from "zod";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { FIXED_OS_EXECUTABLES } from "./executables/catalog.ts";
import {
  AddWorkItemSchema,
  AssignTaskSchema,
  AwayConfigPatchSchema,
  BacklogPlanSchema,
  CompleteTaskSchema,
  CompleteRetroNoChangeSchema,
  ComposerActivitySchema,
  CreatePersonaSchema,
  ImportPersonaSchema,
  ReimportPersonaSchema,
  CreateSessionActionSchema,
  UpdateSessionActionSchema,
  ArchiveSessionActionSchema,
  CostConfigPatchSchema,
  CreateReviewSchema,
  DetachReviewWaitSchema,
  DispatchBacklogTaskSchema,
  DispatchSchema,
  PipelineAdoptSuccessorSchema,
  PipelineRetrySchema,
  PipelineSettlementSchema,
  ResolveRepoSchema,
  TourDispatchSchema,
  EditWorkItemSchema,
  FOREMAN_INSTRUCTIONS_CONFLICT_CODE,
  FOREMAN_INSTRUCTIONS_CONFLICT_MESSAGE,
  FOREMAN_INSTRUCTIONS_MAX_LENGTH,
  MAX_TASK_EXTRA_REPOS,
  STANDING_INSTRUCTIONS_CONFLICT_CODE,
  STANDING_INSTRUCTIONS_CONFLICT_MESSAGE,
  StandingInstructionsUpdateSchema,
  type StandingInstructionsConflict,
  ForemanConfigPatchSchema,
  ForemanInstructionsSchema,
  ForemanHeartbeatSchema,
  ForemanPlannerHealthReportSchema,
  ForemanPlannerRetryClaimSchema,
  ForemanPlannerRetrySchema,
  HarnessesConfigPatchSchema,
  HarnessModelCatalogQuerySchema,
  HarnessModelCatalogsSchema,
  UiConfigPatchSchema,
  InspectorConfigPatchSchema,
  LlmConfigPatchSchema,
  McpCreateTaskSchema,
  McpCreateTaskV2Schema,
  type McpCreateTaskV2,
  McpAdoptPipelineRunSchema,
  McpReportPipelineWorkspaceSchema,
  McpProductIssuePreviewRequestSchema,
  McpProductIssueSubmitRequestSchema,
  ResolveFindingsSchema,
  SetupBannerDismissRequestSchema,
  ShippingConfigPatchSchema,
  HookIngestSchema,
  InjectPromptSchema,
  KeepAwakeRequestSchema,
  MarkItemSentSchema,
  ManualWorktreeAcquireSchema,
  ManualWorktreeReturnSchema,
  OpenWorktreeSchema,
  OtlpMetricsSchema,
  PendingTurnRevisionSchema,
  ReattachQueueSchema,
  ReorderTaskSchema,
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
  ArchiveSearchQuerySchema,
  RenameArchiveSchema,
  DeleteArchiveSchema,
  OpenArchiveArtifactSchema,
  LaunchSessionTerminalSchema,
  SaveSessionFileSchema,
  AppendFileCommentMessageSchema,
  CreateFileCommentSchema,
  HtmlBlockAnchorSchema,
  HtmlBlockTargetSchema,
  EditFileCommentMessageSchema,
  ReorderFileCommentsSchema,
  SetFileCommentStatusSchema,
  FileCommentReviewControlSchema,
  RespondToFileCommentsSchema,
  SessionFilePathSchema,
  SubmitOptionsSchema,
  RecordEpisodeSchema,
  ResolveEpisodeSchema,
  SetNoteSchema,
  SetPermissionModeSchema,
  SetSessionEffortSchema,
  SetWorkItemStateSchema,
  PromptedHandoffUndeliveredSchema,
  PromptedRecoveryClaimSchema,
  PromptedRecoveryDeliverySchema,
  PromptedWrapupSchema,
  WrapupAskedSchema,
  PushTaskSchema,
  ProductIssueDashboardSubmitRequestSchema,
  ProductIssueConfirmRequestSchema,
  ProductIssuePreviewRequestSchema,
  PipelineActionSchema,
  PipelineConsoleSchema,
  PipelineForemanEpisodeSchema,
  PipelineInstallerLaunchSchema,
  SetupInstallerLaunchSchema,
  PipelineRepoRegistrationSchema,
  PipelinesConfigPatchSchema,
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
  GrantWorkflowRepairRoundsSchema,
  CreateWorkflowBindingSchema,
  ReattachWorkflowBindingSchema,
  RestartFullWorkflowSchema,
  ResubmitWorkflowSchema,
  RetryWorkflowRunSchema,
  RetryWorkflowEvidenceReadinessSchema,
  OverrideWorkflowEvidenceReadinessSchema,
  RetryWorkflowDeliverySchema,
  ResolveWorkflowDeliverySchema,
  RemoveWorkflowPersonaDirectiveSchema,
  SetWorkflowNodesDisabledSchema,
  SetWorkflowPersonaDirectiveSchema,
  WorkflowCompletionClaimSchema,
  UpdateWorkflowCommandSchema,
  WorkflowConfigSchema,
  WorkflowRunActionSchema,
  WorktreeActionExecuteSchema,
  WorktreeActionRequestSchema,
  WorktreesConfigPatchSchema,
  SubmitWorkflowSchema,
  SubmitWorkflowEvidenceSchema,
  WorkflowEvidenceCoverageClaimSchema,
  WorkflowRetainedEvidenceLocatorSchema,
  UpdateWorkflowBindingSchema,
  WrapupSchema,
} from "@shared/protocol.ts";
import { DAEMON_PROTOCOL_CAPABILITIES } from "@shared/daemon-protocol.ts";
import type {
  ForemanInstructionsConflict,
  ResolveFindingsResult,
  TaskDependencyInput,
} from "@shared/protocol.ts";
import {
  PRODUCT_ISSUE_LIMITS,
  type ProductIssueSubmitResult,
} from "@shared/product-issues.ts";
import { capturePaneText } from "./discovery/pane-capture.ts";
import { noteKeyFor } from "./registry.ts";
import type { Registry } from "./registry.ts";
import { ComposerActivityTracker } from "./composer-activity.ts";
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
import {
  MANUAL_DISPATCH_TASK_CREATE,
  ScoutArchiveNotReadyError,
  TaskDependencyError,
  TaskEffortUnsupportedError,
  TaskStatusConflictError,
  type TaskManager,
} from "./tasks.ts";
import { serverTour, tourRecipeFor, type TourOperation } from "./tours.ts";
import { sseHandler } from "./sse.ts";
import type { KeepAwakeManager } from "./keep-awake.ts";
import { archiveErrorStatus, type ArchiveManager } from "./archives/manager.ts";
import { planDispatchBlock } from "./plans/skills.ts";
import { verifyScoutSubmissionCredential } from "./scouts/submission-auth.ts";
import { SCOUT_SUBMISSION_CREDENTIAL_HEADER } from "@shared/harness-runtime.mjs";
import { ARCHIVE_SEARCH_LIMITS } from "@shared/archives.ts";
import { recordInjection } from "./injections.ts";
import { runRetro } from "./retro.ts";
import { harnessFor, resumeArgvFor, sessionMessages } from "./harness/index.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { activePaneDialog, reportBucket, sessionWorkspaceRoot } from "@shared/session.ts";
import { resolvedSessionIntent } from "@shared/goal.ts";
import {
  harnessOffersRuntime,
  interruptUnsupportedWhy,
  workQueueBlockedReason,
} from "@shared/harness-capabilities.ts";
import { AGENT_TYPES, SESSION_RUNTIMES } from "@shared/types.ts";
import {
  STANDING_INSTRUCTIONS_MAX_KEY_LENGTH,
  STANDING_INSTRUCTIONS_MAX_LENGTH,
  STANDING_INSTRUCTIONS_MAX_REPOSITORIES,
  type StandingInstructionsDelivery,
} from "@shared/standing-instructions.ts";
import {
  standingInstructionsConfig,
  standingInstructionsView,
  updateStandingInstructions,
} from "./instructions/config.ts";
import { composeStandingInstructions } from "./instructions/compose.ts";
import { canonicalRepoPath } from "./instructions/resolve.ts";
import { transcriptStreamHandler } from "./transcript-stream.ts";
import { attributeTranscript } from "./transcript-attribution.ts";
import { bindLaunchTurnMessage, resolveLaunchMarker } from "./launch-presentation.ts";
import {
  claimForemanLease,
  claimForemanPlannerRetry,
  foremanPlannerControl,
  foremanStatus,
  getForemanConfig,
  recordForemanPlannerHealth,
  releaseForemanLease,
  requestForemanPlannerRetry,
  setForemanConfig,
} from "./foreman/config.ts";
import { getBacklogPlan, setBacklogPlan } from "./backlog.ts";
import { getAwayConfig, setAwayConfig } from "./away/config.ts";
import { buildDigest } from "./away/digest.ts";
import { summarizeBuffer } from "@shared/away-buffer.ts";
import type { AwayWatcher } from "./away/watcher.ts";
import {
  getHarnessesConfig,
  HarnessesConfigError,
  setHarnessesConfig,
} from "./harnesses.ts";
import type { SdkSupervisor } from "./sdk/supervisor.ts";
import type { HarnessModelCatalogService } from "./harness/model-catalog-service.ts";
import { FileCommentError, type FileCommentManager } from "./file-comments.ts";
import {
  HTML_BLOCK_STALE_REASON,
  resolveHtmlBlockAnchor,
  resolveHtmlBlockPath,
} from "./html-block-anchor.ts";
import { progressOf, type FileCommentWalkthrough } from "./file-comment-walkthrough.ts";
import type { ProductIssueService } from "./product-issues.ts";
import type { SettingsBackupService } from "./settings-backups/service.ts";
import {
  SETTINGS_BACKUP_LIMITS,
  SETTINGS_BACKUP_RETENTION,
  SettingsBackupIdSchema,
  SettingsRestoreRequestSchema,
  type SettingsBackupPublicItem,
  type SettingsRestorePreview,
  type SettingsRestorePreviewResult,
  type SettingsRestoreResult,
} from "@shared/settings-backups.ts";
import type { WorktreeManager } from "./worktrees/manager.ts";
import {
  WorktreeOperationError,
  type WorktreeOperationsService,
} from "./worktrees/operations.ts";
import { run as runCommand } from "./util/exec.ts";
import type { PendingTurnManager } from "./pending-turns.ts";
import { driverFormAnswer, driverOptionAnswer, type DriverAnswer } from "./sdk/answer.ts";
import { dialogMarker } from "./foreman/pending.ts";
import { answeredQuestion } from "./sdk/answered-question.ts";
import { handOffToTerminal, type HandoffDeps } from "./sdk/handoff.ts";
import { clearSdkSessionTask } from "./sdk/store.ts";
import { deliverToDriver, injectPromptForRuntime } from "./sdk/deliver.ts";
import { renameDriverSession } from "./sdk/rename.ts";
import { interruptSession, requestSessionStop } from "./sdk/control.ts";
import { spawnUniquely } from "./dispatcher.ts";
import { getTaskSourcesConfig, setTaskSourcesConfig, taskSourceById } from "./task-sources/config.ts";
import { taskSourceKinds } from "./task-sources/index.ts";
import { pushTask } from "./task-sources/push.ts";
import { noteTaskSourceConfigChange, preflightOnce, sweepOnce, taskSourceStatuses } from "./task-sources/sweeper.ts";
import type { TaskSourcesView } from "@shared/task-source.ts";
import { getPipelinesConfig, setPipelinesConfig } from "./pipelines/config.ts";
import {
  activePipelineRepoStatuses,
  pipelineInstallerCandidates,
  pipelineInstallerLaunch,
  pipelineConsoleLaunch,
  pipelineConsoleName,
  pipelineRepoStatuses,
  probeAllPipelineProviders,
  readPipelineRunDetail,
  reconcilePipelineConsent,
  registerPipelineRepo,
  runPipelineAction,
} from "./pipelines/index.ts";
import {
  isPipelineProviderId,
  PIPELINE_CALLER_CREDENTIAL_HEADER,
  pipelineRepoKey,
  type PipelineActionResult,
  type PipelineConsoleResult,
  type PipelineForemanView,
  type PipelineInstallerLaunchResult,
  type PipelinesView,
} from "@shared/pipeline.ts";
import { schedulePipelineRefresh } from "./pipelines/index.ts";
import {
  pipelineEpisodeKey,
  pipelineEpisodeWrite,
  pipelineHaltMarker,
} from "./foreman/pipeline-triage.ts";
import { ingestConductorEvents, MAX_INGEST_BYTES } from "./pipelines/ingest.ts";
import { shellCommand } from "./terminal/shell.ts";
import { setUiConfig, uiConfigView } from "./ui-config.ts";
import { environmentCheckViews } from "./environment/index.ts";
import type { EnvironmentChecksView } from "@shared/environment-checks.ts";
import { RepoIndexConfigPatchSchema } from "@shared/repo-index.ts";
import { defaultSetupDeps, setupChecksView } from "./setup/index.ts";
import type { SetupDeps } from "./setup/types.ts";
import {
  DEFAULT_SETUP_INSTALL_CATALOG,
  executeSetupInstall,
  type SetupInstallRouteDeps,
} from "./setup/install.ts";
import { acknowledgeSetupRows } from "@shared/setup-banner.ts";
import { createSetupSnapshotTracker } from "./setup/snapshots.ts";
import { costTelemetryStatus, setCostConfig } from "./cost.ts";
import {
  getInspectorConfig,
  inspectorModel,
  inspectorRunner,
  setInspectorConfig,
} from "./inspector/config.ts";
import { getLlmConfig, setLlmConfig } from "./llm/config.ts";
import { llmStatus } from "./llm/status.ts";
import { getShippingConfig, setShippingConfig } from "./shipping/config.ts";
import {
  RepoIndexConfigError,
  repoIndexView,
  setRepoIndexConfig,
} from "./repo-index.ts";
import { repositoryIndexEnvironmentOverride } from "./repo-index-config.ts";
import { publishSettingsStatus } from "./settings-status.ts";
import { readCatalog } from "./skills/catalog.ts";
import { applySkillsConfig, getSkillsConfig } from "./skills/config.ts";
import { skillDrift } from "./skills/reconcile.ts";
import { pendingReloads } from "./skills/reload.ts";
import { readStandards, readStandardsFromGitTree } from "./standards.ts";
import {
  foremanInstructionsView,
  updateForemanInstructions,
} from "./foreman/instructions.ts";
import {
  computeCommitDiff,
  computePinnedRefDiff,
  computeSessionDiff,
  repoRootOf,
} from "./diff.ts";
import { readRuntimeEffortBaseline } from "./runtime-meta.ts";
import { checkToken } from "./auth.ts";
import {
  forgetTaskSourceSeen,
  getSkillsAcks,
  loadHumanResolvedReviews,
  loadInspectionsAdoptedSince,
  loadInspectorInspections,
  getInspectorPr,
  resolveInspectorFindings,
  updateInspectorPr,
  episodeById,
  foremanEpisodeExists,
  recentEpisodes,
  recordEpisode as recordForemanEpisode,
} from "./db.ts";
import { recordSpendReport } from "./spend-ledger.ts";
import { FOREMAN_EPISODE_LEDGER, noteAwaitsYou } from "@shared/foreman.ts";
import { foremanMayActLive } from "./foreman/verdict.ts";
import {
  activeWorkflowOwnsSession,
  followupPrs,
} from "./foreman/review-followup.ts";
import {
  decideImmediateHeldGapDelivery,
  decideShipShepherd,
} from "./foreman/ship-shepherd.ts";
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
  type PaneDeps,
  submitPaneForm,
  validateSessionName,
  validateSessionNameAgainstTasks,
} from "./actions.ts";
import { driverClearFor, resetSession } from "./reset.ts";
import { buildReport, renderReportMarkdown } from "./report.ts";
import {
  invalidateReposCache,
  listRepos,
  resolveRepoPath,
  resolveRepoRoot,
  resolveTaskExtraRepoRoots,
  resolveTaskRepoRoot,
} from "./repos.ts";
import { prepareTaskRepositories } from "./task-repository-preparation.ts";
import { MAX_UPLOAD_BYTES, saveImageUpload } from "./uploads.ts";
import {
  readSubmissionImageBody,
  WorkflowImageEvidenceError,
} from "./workflows/images.ts";
import {
  listGitTreeFiles,
  listSessionFiles,
  MAX_SESSION_EDITOR_BYTES,
  readGitTreeFile,
  readSessionFile,
  resolveSessionFilePath,
  saveSessionFile,
  SessionFileError,
} from "./session-files.ts";
import { openFile, openTargetViews } from "./open-targets/index.ts";
import { terminalTargetViews, launchAgentTerminal, launchTerminal } from "./terminal/targets.ts";
import {
  agentLaunchAction,
  agentLaunchBlockedReason,
  shellLaunchBlockedReason,
} from "@shared/session-launch.ts";
import { SERVICE_VERSION } from "./version.ts";
import type { PersonaManager, PersonaMutation } from "./workflows/personas.ts";
import { PersonaImportError } from "./workflows/persona-import.ts";
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
import {
  JSON_UTF8_MAX_BYTES_PER_CHAR,
  WORKFLOW_EVIDENCE_COVERAGE_LIMITS,
  WORKFLOW_IMAGE_LIMITS,
  WORKFLOW_LIMITS,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_TEXT_EVIDENCE_LIMITS,
  legacyCheckCommands,
} from "@shared/workflow.ts";
import type { TestEvidenceAuditAggregate, WorkflowConfig } from "@shared/workflow.ts";
import { TEST_EVIDENCE_AUDIT_SCAN_LIMIT } from "./workflows/test-evidence-audit.ts";
import { WorkflowCommandManager } from "./workflows/commands.ts";
import type { WorkflowCommandMutation } from "./workflows/commands.ts";
import {
  getWorkflowPolicy,
  resolveTaskWorkflowId,
  setWorkflowPolicy,
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
  SubmitScoutArtifactsSchema,
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
 * The semantic schema counts JavaScript code units, while this stream guard counts raw request
 * bytes. A caller may legally spell each code unit as a six-byte `\uXXXX` escape, so the guard
 * includes that worst case plus ample room for the fixed ETag and JSON envelope.
 */
const FOREMAN_INSTRUCTIONS_BODY_MAX_BYTES =
  FOREMAN_INSTRUCTIONS_MAX_LENGTH * 6 + 16 * 1024;
/**
 * The same ×6 escape headroom, sized for the patch the SCHEMA accepts rather than for the
 * one-box save a panel usually sends.
 *
 * `StandingInstructionsUpdateSchema` permits up to `STANDING_INSTRUCTIONS_MAX_REPOSITORIES`
 * keys in one request, each a key of up to `STANDING_INSTRUCTIONS_MAX_KEY_LENGTH` and a box
 * of up to `STANDING_INSTRUCTIONS_MAX_LENGTH`, plus the machine-wide default. Budgeting for
 * a single box and a single key made a bulk write - eleven full repositories is enough - a
 * 413 BEFORE the schema it satisfies was ever consulted, which is the worst kind of refusal:
 * the API says yes and the transport says no, with no way for a caller to tell which limit it
 * hit. Derived from the same three constants for that reason, so raising a cap cannot leave
 * this behind.
 *
 * A ceiling, not an allocation: `bodyLimit` refuses past it while streaming, so an ordinary
 * one-repository save still costs a few hundred bytes.
 */
const STANDING_INSTRUCTIONS_BODY_MAX_BYTES =
  (STANDING_INSTRUCTIONS_MAX_LENGTH + STANDING_INSTRUCTIONS_MAX_KEY_LENGTH) *
    STANDING_INSTRUCTIONS_MAX_REPOSITORIES *
    6 +
  STANDING_INSTRUCTIONS_MAX_LENGTH * 6 +
  16 * 1024;
/**
 * The same ×6 headroom as a Persona's, and derived from the prompt ceiling rather than
 * copied from it: JSON string escaping can expand a UTF-8 byte several times over, so a
 * limit set to the ceiling itself would reject prompts the schema accepts.
 */
const SESSION_ACTION_BODY_MAX_BYTES = WORKFLOW_LIMITS.sessionActionPromptBytes * 6 + 16 * 1024;
/**
 * One slot's whole state: a default argv plus up to `commandOverrides` paths and argvs.
 *
 * Derived from those bounds rather than chosen, so raising a limit cannot silently leave this
 * behind and turn a legal write into a 413. The `+ 1` is the slot's own default command, which
 * is bounded exactly like an override's argv and is not one of them.
 *
 * The multiplication by `JSON_UTF8_MAX_BYTES_PER_CHAR` is the load-bearing part, and leaving it
 * out is a bug this constant already had: the schema counts CHARACTERS and `bodyLimit` counts
 * BYTES, so a catalog of non-ASCII paths satisfies every Zod ceiling and is still refused before
 * validation ever runs. A 413 is also the worst place to be wrong, because it carries no field
 * and no reason - the operator sees a save that failed and no way to learn which value did it.
 *
 * The per-entry constant covers JSON's own punctuation - the key names, quotes, commas and
 * brackets around each override and each argument - and is deliberately generous, because the
 * schema is the real bound here. This is a cheap pre-parse guard against an absurd body, not a
 * second opinion about what a valid catalog looks like.
 */
const WORKFLOW_COMMAND_BODY_MAX_BYTES =
  (WORKFLOW_LIMITS.commandOverrides + 1)
    * ((WORKFLOW_LIMITS.checkRepoRoot + WORKFLOW_LIMITS.checkCommandLength)
        * JSON_UTF8_MAX_BYTES_PER_CHAR
      + 512);
/**
 * The ceiling for a body that carries one integer, wherever it appears.
 *
 * Sizing it from a PROMPT or GUIDANCE ceiling like the writes above would let a caller stream
 * ~600 KB at a route whose entire schema is `{ expectedRevision }` - a body limit in name
 * only. A kilobyte is already orders of magnitude more than the largest legal request and
 * leaves room for whitespace, so the cap refuses abuse without ever refusing a real client.
 *
 * Shared across families rather than restated per block, because the number follows from the
 * SCHEMA and not from which catalog the route belongs to: Persona archive, Persona re-import
 * and session-action archive all accept exactly `{ expectedRevision }`. A per-family copy is
 * how one of them ends up with the wrong one.
 */
const REVISION_ONLY_BODY_MAX_BYTES = 1024;
/**
 * The readiness action schemas accept one 200-character request id, plus the override's
 * bounded reason. The multiplier admits JSON's six-byte unicode escape spelling and the
 * fixed allowance covers property names, punctuation, booleans, and whitespace.
 */
const WORKFLOW_READINESS_RETRY_BODY_MAX_BYTES = 200 * JSON_UTF8_MAX_BYTES_PER_CHAR + 1024;
const WORKFLOW_READINESS_OVERRIDE_BODY_MAX_BYTES =
  (200 + WORKFLOW_LIMITS.readinessOverrideReason) * JSON_UTF8_MAX_BYTES_PER_CHAR + 1024;
/**
 * An import body is one absolute path, so it is bounded from the PATH ceiling.
 *
 * `PersonaSourcePathSchema` accepts 4096 code units. JSON escaping can spend six bytes on one
 * of them (`\uXXXX`), so the largest legal body is ~24 KB plus its envelope - and this must
 * exceed that or the guard would reject paths the schema accepts. It is still two orders of
 * magnitude tighter than the guidance-shaped ceiling this route used to borrow.
 */
const PERSONA_IMPORT_BODY_MAX_BYTES = 32 * 1024;
const WORKFLOW_BODY_MAX_BYTES = WORKFLOW_LIMITS.graphJsonBytes * 6 + 32 * 1024;
/**
 * Direct command evidence carries bounded content plus metadata for every item. Reserve the
 * complete metadata envelope separately for the full accepted command count instead of relying
 * on the aggregate content and locator terms. This deliberately gives the command string
 * overlapping headroom. The fixed 512-byte allowance per item covers the bounded non-string
 * fields, property names, and punctuation.
 */
const WORKFLOW_COMMAND_EVIDENCE_METADATA_MAX_BYTES =
  WORKFLOW_TEXT_EVIDENCE_LIMITS.maxCount
  * (
    (
      WORKFLOW_TEXT_EVIDENCE_LIMITS.clientItemIdChars
      + WORKFLOW_TEXT_EVIDENCE_LIMITS.captionChars
      + WORKFLOW_LIMITS.checkCommandLength
    ) * JSON_UTF8_MAX_BYTES_PER_CHAR
    + 512
  );
export const WORKFLOW_EVIDENCE_BODY_MAX_BYTES =
  WORKFLOW_TEXT_EVIDENCE_LIMITS.maxAggregateBytes * JSON_UTF8_MAX_BYTES_PER_CHAR
  + (WORKFLOW_IMAGE_LIMITS.locatorJsonBytes + WORKFLOW_TEXT_EVIDENCE_LIMITS.locatorJsonBytes)
    * JSON_UTF8_MAX_BYTES_PER_CHAR
  + WORKFLOW_EVIDENCE_COVERAGE_LIMITS.aggregateJsonBytes * JSON_UTF8_MAX_BYTES_PER_CHAR
  + WORKFLOW_COMMAND_EVIDENCE_METADATA_MAX_BYTES
  + 32 * 1024;
export const WORKFLOW_EVIDENCE_COVERAGE_BODY_MAX_BYTES =
  WORKFLOW_EVIDENCE_COVERAGE_LIMITS.aggregateJsonBytes * JSON_UTF8_MAX_BYTES_PER_CHAR
  + 8 * 1024;

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

/** What a refused Foreman write says, on every route that refuses one. */
const FOREMAN_UNINVITED = "Foreman is not invited into this session";
const FOREMAN_COMPOSER_BUSY = "Foreman is waiting while the user composes a reply";

interface ForemanWriteRefusal {
  error: string;
  status: 403 | 409;
}

/**
 * The daemon's final Foreman write boundary: may this actor type into this session now?
 *
 * A BACKSTOP, deliberately redundant with the worker's own selection gates. The worker
 * decides what to act on from a `/api/sessions` snapshot, so a stale snapshot, an invite
 * withdrawn mid-pass, or simply a worker built before this rule existed can all produce a
 * request the worker itself would no longer make. Browser composer state is just as
 * time-sensitive, so the worker cannot safely cache that decision either. Those all end
 * at the same place - text
 * in somebody's pane - and that is the failure this whole plan exists to prevent, so the
 * daemon re-asks the question at the boundary it owns rather than trusting the caller to
 * have asked it. The worker never reads SQLite; the daemon always does.
 *
 * Only the actor-marked routes can be gated, and only `"foreman"` is gated on them.
 * `"human"` and `"workflow"` are other writers with their own authorization, and a human
 * typing into their own session is the case this must never touch. Routes carrying no
 * actor marker at all - the note write, the queue-state writes - stay ungated on purpose:
 * they are shared with the dashboard and are bookkeeping downstream of a typing act these
 * gates already refused, so widening their schemas would buy nothing.
 */
function foremanWriteRefusal(
  activity: ComposerActivityTracker,
  session: Session,
  by: "human" | "foreman" | "workflow",
): ForemanWriteRefusal | null {
  if (by !== "foreman") return null;
  if (session.foremanInvite === null) return { error: FOREMAN_UNINVITED, status: 403 };
  if (activity.blocksForeman(session.id)) return { error: FOREMAN_COMPOSER_BUSY, status: 409 };
  return null;
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

function productIssueSubmitResponse(result: ProductIssueSubmitResult): {
  status: 201 | 502 | 503 | 504;
  body: ProductIssueSubmitResult;
} {
  switch (result.outcome) {
    case "created":
      return { status: 201, body: result };
    case "refused":
      return { status: 502, body: result };
    case "configuration":
      return { status: 503, body: result };
    case "unknown":
      return { status: 504, body: result };
  }
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
  /**
   * How the pane-answering routes reach a terminal. The `HandoffDeps` seam above, for the
   * two routes that drive a menu with bare keystrokes.
   *
   * Injected for one reason the default cannot serve: a pane form reports `ok` on states that
   * delivered nothing (`formDelivered`), and whether those retire the operator's Foreman note
   * is a property of THIS wiring, not of the predicate. Reaching it needs a screen that
   * advances mid-walk, which no real tmux on a test machine will produce on demand - so
   * without a seam the only coverage possible is of the predicate in isolation, and a
   * regression in the gating here would ship undetected. Production passes nothing and gets
   * `defaultPaneDeps`.
   */
  paneDeps?: PaneDeps,
  /**
   * The transient Keep Awake owner. Optional only for the legacy route-unit
   * construction, like every service above it; production always supplies it, and the
   * keep-awake routes answer 503 when it is absent rather than constructing a second
   * owner here - the manager owns exactly one OS child, and a route-built twin would be
   * a second claimant on host power state.
   */
  keepAwake?: KeepAwakeManager,
  /**
   * The archive library owner. Appended LAST for the reason every optional above it is
   * optional: `buildApp` is called positionally by around fifty focused tests, and the ones
   * that care about tasks or panes must not have to learn about archives to keep compiling.
   *
   * Absent means the archive routes answer 503 rather than constructing a manager here. A
   * route-built twin would be a second owner of one filesystem library and one reconciler -
   * two background walks over the same directory, two writers of the same derived rows.
   */
  archives?: ArchiveManager,
  /**
   * The Global Command catalog owner. Appended LAST for the reason every optional above it
   * is: `buildApp` is called positionally by around fifty focused tests, and none of them
   * should have to learn about Commands to keep compiling.
   *
   * Absent means the catalog routes answer 503 and the legacy config route projects an empty
   * command list. A route-built twin would be a second writer of one catalog and a second
   * emitter on one live stream.
   */
  workflowCommands?: WorkflowCommandManager,
  /** The daemon's singleton native allocator. Manual-session routes return 503 without it. */
  worktrees?: WorktreeManager,
  /** Singleton projection/action owner for Settings > Worktrees. */
  worktreeOperations?: WorktreeOperationsService,
  /**
   * Daemon-owned model discovery/cache service. Appended last so focused route tests that
   * do not exercise catalogs never construct or spawn one.
   */
  modelCatalogs?: HarnessModelCatalogService,
  /** Daemon-owned public issue writer. Appended last for focused route-test compatibility. */
  productIssues?: ProductIssueService,
  /**
   * The line-comment owner. Appended LAST for the reason every optional above it is: the
   * ~50 focused tests that construct `buildApp` positionally must not have to learn about
   * comment threads to keep compiling.
   *
   * Absent means these routes answer 503 rather than constructing a manager here. A
   * route-built twin would be a second subscriber on `session_remove` and a second emitter
   * on one live stream - two teardown paths for state whose whole contract is that it has
   * exactly three.
   */
  fileComments?: FileCommentManager,
  /** The walkthrough. Optional for the same reason `fileComments` is; its routes answer 503. */
  fileCommentWalkthrough?: FileCommentWalkthrough,
  /** The daemon's singleton snapshot/restore owner. Its loopback routes return 503 without it. */
  settingsBackups?: SettingsBackupService,
  /** Read-only setup probe seams. Optional so existing focused route tests stay unchanged. */
  setupDeps?: SetupDeps,
  /** Visible-terminal setup execution seams. Browser input never enters these values. */
  setupInstallDeps?: SetupInstallRouteDeps,
): Hono {
  const app = new Hono();
  const composerActivity = new ComposerActivityTracker();
  const setupSnapshots = createSetupSnapshotTracker(randomUUID);
  const terminalLauncher = launchSessionTerminal ?? launchTerminal;
  const panes = paneDeps ?? defaultPaneDeps;
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
    c.json({
      ok: true,
      service: "mission-control",
      version: SERVICE_VERSION,
      pid: process.pid,
      capabilities: Object.values(DAEMON_PROTOCOL_CAPABILITIES),
    }),
  );

  // --- public product issue preflight/preview for the future dashboard form ---
  app.get("/api/product-issues/preflight", async (c) => {
    if (!productIssues) {
      return c.json({
        ready: false,
        target: null,
        attachments: { enabled: false, reason: "Product issue service unavailable" },
        problems: [{ code: "invalid-target", message: "Product issue service unavailable" }],
      }, 503);
    }
    return c.json(await productIssues.preflight());
  });

  app.post(
    "/api/product-issues/preview",
    bodyLimit({
      maxSize: PRODUCT_ISSUE_LIMITS.requestJsonBytes,
      onError: (c) => c.json({ error: "Product issue request is too large" }, 413),
    }),
    async (c) => {
      if (!productIssues) {
        return c.json({
          outcome: "configuration",
          message: "Product issue service unavailable",
          retrySafe: true,
        } as const, 503);
      }
      const parsed = await parseBody(c, ProductIssuePreviewRequestSchema);
      if (!parsed.ok) return parsed.res;
      const result = productIssues.preview("dashboard", parsed.data);
      if (result.outcome === "preview") return c.json(result);
      return c.json(result, result.outcome === "configuration" ? 503 : 409);
    },
  );


  /**
   * Mint the short-lived grant that the dashboard's one Report action immediately spends.
   * Kept apart from preview so reading or editing never creates publishing authority.
   */
  app.post(
    "/api/product-issues/confirm",
    bodyLimit({
      maxSize: PRODUCT_ISSUE_LIMITS.requestJsonBytes,
      onError: (c) => c.json({ error: "Product issue request is too large" }, 413),
    }),
    async (c) => {
      if (!productIssues) {
        return c.json({
          outcome: "configuration",
          message: "Product issue service unavailable",
          retrySafe: true,
        } as const, 503);
      }
      const parsed = await parseBody(c, ProductIssueConfirmRequestSchema);
      if (!parsed.ok) return parsed.res;
      const result = await productIssues.confirm("dashboard", parsed.data);
      if (result.outcome === "confirmation") return c.json(result);
      return c.json(
        result,
        result.outcome === "configuration" ? 503 : result.outcome === "unknown" ? 504 : 409,
      );
    },
  );

  /**
   * The dashboard's public mutation, bound to the confirmation the browser rendered.
   *
   * Phase 1 held this route back on purpose: "preview then submit" alone would let anything
   * that can reach the daemon publish without first obtaining the exact rendered derivation.
   * `confirmationToken` is the single-use grant minted by `/api/product-issues/confirm` -
   * unguessable, so it cannot be computed from the draft; short-lived, so an old approval
   * cannot be held and spent later; and retired once a submission using it reaches a terminal
   * outcome, so a publish cannot be replayed. The service additionally refuses if its own
   * re-derivation has moved since the grant was minted, which is what stops a configuration
   * change between reading and pressing from publishing unseen content.
   *
   * Everything that can steer GitHub - target, labels, source, environment, body - is still
   * derived by the service and never accepted from here.
   */
  app.post(
    "/api/product-issues",
    bodyLimit({
      maxSize: PRODUCT_ISSUE_LIMITS.requestJsonBytes,
      onError: (c) => c.json({ error: "Product issue request is too large" }, 413),
    }),
    async (c) => {
      if (!productIssues) {
        return c.json({
          outcome: "configuration",
          message: "Product issue service unavailable",
          retrySafe: true,
        } as const, 503);
      }
      const parsed = await parseBody(c, ProductIssueDashboardSubmitRequestSchema);
      if (!parsed.ok) return parsed.res;
      const { confirmationToken, ...request } = parsed.data;
      const response = productIssueSubmitResponse(
        await productIssues.submit("dashboard", request, { token: confirmationToken }),
      );
      return c.json(response.body, response.status);
    },
  );

  app.post("/api/worktrees/manual/acquire", async (c) => {
    if (!worktrees) return c.json({ error: "native worktree manager unavailable" }, 503);
    const parsed = await parseBody(c, ManualWorktreeAcquireSchema);
    if (!parsed.ok) return parsed.res;
    const head = await runCommand(
      "git",
      ["-C", parsed.data.repositoryPath, "rev-parse", "--verify", "HEAD^{commit}"],
      { timeoutMs: 15_000 },
    );
    const baseSha = head.stdout.trim();
    if (head.code !== 0 || head.outcomeUnknown || !/^[0-9a-f]{40}$/.test(baseSha)) {
      return c.json({ error: "repository HEAD could not be resolved to an exact commit" }, 400);
    }
    const ownerKey = `${randomUUID()}${parsed.data.label ? `:${parsed.data.label}` : ""}`;
    const acquired = await worktrees.acquire({
      repositoryPath: parsed.data.repositoryPath,
      baseSha,
      owner: { kind: "manual", key: ownerKey },
    });
    if (acquired.outcome === "acquired") {
      return c.json({
        path: acquired.lease.path,
        leaseId: acquired.lease.leaseId,
        baseSha: acquired.lease.baseSha,
      }, 201);
    }
    return c.json(
      { error: acquired.reason, outcome: acquired.outcome },
      acquired.outcome === "outcomeUnknown" ? 503 : 409,
    );
  });

  app.post("/api/worktrees/manual/return", async (c) => {
    if (!worktrees) return c.json({ error: "native worktree manager unavailable" }, 503);
    const parsed = await parseBody(c, ManualWorktreeReturnSchema);
    if (!parsed.ok) return parsed.res;
    const found = worktrees.lookupLease({ leaseId: parsed.data.leaseId });
    if (found.state === "missing") return c.json({ error: "manual lease was not found" }, 404);
    if (found.state === "mismatch") return c.json({ error: found.reason }, 409);
    if (found.lease.owner.kind !== "manual") {
      return c.json({ error: "this lease belongs to a task or workflow check" }, 409);
    }
    if (found.state === "released") return c.json({ ok: true, alreadyReleased: true });

    const status = await worktrees.status();
    const slot = status.flatMap((pool) => pool.slots).find((entry) => entry.slot.id === found.lease.slotId);
    if (!slot || slot.dirty !== false) {
      return c.json({ error: "manual worktree is dirty or its cleanliness is unknown" }, 409);
    }
    const released = await worktrees.release(found.lease, {
      ownerAuthorized: true,
      requireClean: true,
    });
    if (released.outcome === "released" || released.outcome === "alreadyReleased") {
      return c.json({ ok: true, alreadyReleased: released.outcome === "alreadyReleased" });
    }
    return c.json(
      { error: released.reason, outcome: released.outcome },
      released.outcome === "outcomeUnknown" ? 503 : 409,
    );
  });

  function worktreeFailure(error: unknown) {
    if (error instanceof WorktreeOperationError) {
      return { status: error.status, body: { error: error.message, code: error.code } } as const;
    }
    const message = (error instanceof Error ? error.message : String(error)).trim().replace(/\s+/g, " ");
    return {
      status: 503 as const,
      body: { error: message.slice(0, 2_048), code: "unavailable" },
    };
  }

  app.get("/api/worktrees", async (c) => {
    if (!worktreeOperations) return c.json({ error: "worktree operations unavailable" }, 503);
    try {
      return c.json(await worktreeOperations.inventory());
    } catch (error) {
      const failure = worktreeFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

  app.get("/api/worktrees/config", async (c) => {
    if (!worktreeOperations) return c.json({ error: "worktree operations unavailable" }, 503);
    try {
      const inventory = await worktreeOperations.inventory();
      return c.json({
        config: inventory.config,
        effective: inventory.repositories.map((repo) => ({
          poolId: repo.id,
          commonDirectory: repo.commonDirectory,
          policy: repo.policy,
        })),
      });
    } catch (error) {
      const failure = worktreeFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

  app.put("/api/worktrees/config", async (c) => {
    if (!worktreeOperations) return c.json({ error: "worktree operations unavailable" }, 503);
    const parsed = await parseBody(c, WorktreesConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    try {
      return c.json({ config: worktreeOperations.setConfig(parsed.data) });
    } catch (error) {
      const failure = worktreeFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

  app.post("/api/worktrees/actions/preview", async (c) => {
    if (!worktreeOperations) return c.json({ error: "worktree operations unavailable" }, 503);
    const parsed = await parseBody(c, WorktreeActionRequestSchema);
    if (!parsed.ok) return parsed.res;
    try {
      return c.json(await worktreeOperations.preview(parsed.data));
    } catch (error) {
      const failure = worktreeFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

  app.post("/api/worktrees/actions/execute", async (c) => {
    if (!worktreeOperations) return c.json({ error: "worktree operations unavailable" }, 503);
    const parsed = await parseBody(c, WorktreeActionExecuteSchema);
    if (!parsed.ok) return parsed.res;
    try {
      return c.json(await worktreeOperations.execute(parsed.data.token, parsed.data.acknowledgements));
    } catch (error) {
      const failure = worktreeFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

  app.post("/api/worktrees/:slotId/open", async (c) => {
    if (!worktreeOperations) return c.json({ error: "worktree operations unavailable" }, 503);
    const parsed = await parseBody(c, OpenWorktreeSchema);
    if (!parsed.ok) return parsed.res;
    const slotId = c.req.param("slotId");
    const cwd = await worktreeOperations.slotPath(slotId);
    if (!cwd) return c.json({ error: "native worktree slot was not found" }, 404);
    const result = await terminalLauncher(parsed.data.backend, {
      name: `worktree-${slotId.slice(0, 8)}`,
      cwd,
      argv: [process.env.SHELL || FIXED_OS_EXECUTABLES.sh, "-l"],
    });
    const body = {
      ok: result.ok,
      backend: parsed.data.backend,
      label: result.label,
      ...(result.error ? { error: result.error } : {}),
    };
    return result.ok ? c.json(body) : c.json(body, result.status as 404 | 409 | 502 | 504);
  });
  app.get("/api/sessions", (c) => c.json(registry.snapshot().sessions));

  // --- Keep Awake: the transient idle-sleep inhibitor ---
  //
  // Reads and writes go to the injected manager; convergence goes over SSE. The route
  // answers the CALLER with the settled transition, and the Registry event answers every
  // OTHER window - both from the same observation, so they cannot disagree.
  app.get("/api/keep-awake", (c) => {
    if (!keepAwake) return c.json({ error: "keep-awake manager unavailable" }, 503);
    return c.json(keepAwake.status());
  });
  app.put("/api/keep-awake", async (c) => {
    if (!keepAwake) return c.json({ error: "keep-awake manager unavailable" }, 503);
    const parsed = await parseBody(c, KeepAwakeRequestSchema);
    if (!parsed.ok) return parsed.res;
    const before = keepAwake.status();
    if (parsed.data.enabled && !before.supported) {
      // A clear refusal, not a pretend transition: drawing `on` for a host with no
      // provider would be the exact lie the status type exists to prevent. ENABLE only:
      // disabling is always achievable - the manager's off is a no-op on a host with no
      // provider - so a caller ensuring the mode is off (a startup script, a defensive
      // re-request) falls through and gets the off it asked for rather than an error.
      return c.json(
        {
          error: before.unavailableReason ?? "Keep awake is unavailable on this system",
          code: "keep_awake_unavailable",
          status: before,
        },
        409,
      );
    }
    // Waits for the manager's CONFIRMED transition - the response describes observed
    // state, never the request. A failed OS transition reports 502 with the observed
    // error status so the caller can render it without waiting for SSE.
    const status = await keepAwake.setEnabled(parsed.data.enabled);
    const settled = parsed.data.enabled ? status.state === "on" : status.state === "off";
    if (!settled) {
      return c.json(
        {
          error: status.error ?? "the keep-awake transition failed",
          code: "keep_awake_failed",
          status,
        },
        502,
      );
    }
    return c.json(status);
  });

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
            const launched = await launchAgentTerminal(backend, {
              name,
              cwd,
              argv: [bin, ...args],
            }, terminalLauncher);
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
    // The same shape as `builtin` and for the same reason: no retry produces a source file for
    // a Persona that was typed into the editor, so the sentence names what would.
    if (result.reason === "not_imported") {
      return c.json({
        error: "this Persona was authored here rather than imported, so there is no source file "
          + "to re-read. Import from path creates a Persona that tracks one.",
        code,
        current: result.current,
      }, 409);
    }
    return c.json({ error: result.reason.replaceAll("_", " "), code, current: result.current }, 409);
  };
  /**
   * A path refusal, which is NOT a mutation refusal.
   *
   * 400 with the reader's own sentence, because every one of them is about the request the
   * operator just made - the path is relative, nothing is there, it is a directory, it is 4MB,
   * it is not UTF-8 - and the only useful reply names which. Anything else is an unexpected
   * fault and is re-thrown to the error middleware rather than reported as bad input.
   */
  const personaSourceFailure = (c: Context, cause: unknown) => {
    if (!(cause instanceof PersonaImportError)) throw cause;
    return c.json({ error: cause.message, code: "persona_source_unreadable" }, 400);
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
  /**
   * What every imported Persona's source file says now. Above `/:id` because Hono matches in
   * registration order and the parameter route would otherwise answer for a Persona named
   * "drift" - the same reason `defaults` sits here.
   *
   * Always 200, including when nothing is imported: this is a question about state, and a
   * badge-fetching browser has nothing useful to do with a failure. An unreadable source is
   * reported as that Persona's `missing`, not as a failed request.
   */
  app.get("/api/personas/drift", async (c) => {
    const manager = personaManager();
    if (!manager) return c.json({ error: "Persona manager unavailable" }, 503);
    return c.json({ personas: await manager.drift() });
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
  /**
   * Import a Markdown role from a path on the DAEMON's machine.
   *
   * A path, not an upload - that is the whole difference from the browser's **Import .md**,
   * which stays exactly as it was. The daemon reading the file is what makes provenance
   * possible: a browser can hand over bytes but cannot say where they will be tomorrow, and a
   * hash with no path to re-read is a badge that can never fire.
   *
   * Bounded from the PATH ceiling rather than the guidance one the create route beside it uses:
   * this body cannot legally hold a document, so a document-shaped limit would be no limit.
   */
  app.post("/api/personas/import", bodyLimit({
    maxSize: PERSONA_IMPORT_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "Persona request is too large" }, 413),
  }), async (c) => {
    const manager = personaManager();
    if (!manager) return c.json({ error: "Persona manager unavailable" }, 503);
    const parsed = await parseBody(c, ImportPersonaSchema);
    if (!parsed.ok) return parsed.res;
    let result: PersonaMutation;
    try {
      result = await manager.importFromFile(parsed.data.path);
    } catch (cause) {
      return personaSourceFailure(c, cause);
    }
    if (result.ok) workflows?.refreshSummaries();
    return result.ok ? c.json(result.persona, 201) : personaFailure(c, result);
  });
  /**
   * Adopt an imported Persona's upstream as a new revision. Same CAS, same refusals.
   *
   * The path to re-read is provenance the daemon already holds, so the whole body is one
   * integer - bounded accordingly, and never allocated at guidance scale for it.
   */
  app.post("/api/personas/:id/reimport", bodyLimit({
    maxSize: REVISION_ONLY_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "Persona request is too large" }, 413),
  }), async (c) => {
    const manager = personaManager();
    if (!manager) return c.json({ error: "Persona manager unavailable" }, 503);
    const parsed = await parseBody(c, ReimportPersonaSchema);
    if (!parsed.ok) return parsed.res;
    let result: PersonaMutation;
    try {
      result = await manager.reimport(c.req.param("id"), parsed.data.expectedRevision);
    } catch (cause) {
      return personaSourceFailure(c, cause);
    }
    if (result.ok) workflows?.refreshSummaries();
    return result.ok ? c.json(result.persona) : personaFailure(c, result);
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
  // Bounded on the same schema-shaped ceiling as re-import above. This route was the one member
  // of the two catalogs' archive pair with no guard at all - its session-action twin has had one
  // since it was written - and the omission is only visible when the pair is read together.
  app.delete("/api/personas/:id", bodyLimit({
    maxSize: REVISION_ONLY_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "Persona request is too large" }, 413),
  }), async (c) => {
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
    maxSize: REVISION_ONLY_BODY_MAX_BYTES,
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
  const workflowCommandManager = (): WorkflowCommandManager | null => workflowCommands ?? null;
  /**
   * The legacy config shape, COMPOSED rather than stored.
   *
   * `checkCommands` is a projection of the Command catalog's overrides, so an old caller sees
   * exactly what the daemon will run - and there is no second list that could disagree with
   * it. Global defaults are absent by construction: they have no repository, so no legacy row
   * could describe one honestly.
   */
  const legacyWorkflowConfig = (): WorkflowConfig => ({
    ...getWorkflowPolicy(),
    checkCommands: legacyCheckCommands(workflowCommandManager()?.list() ?? []),
  });
  app.get("/api/workflows/config", (c) => c.json(legacyWorkflowConfig()));
  app.get("/api/workflows/status", (c) => {
    const manager = workflowManager();
    return manager
      ? c.json(manager.status())
      : c.json({ error: "Workflow manager unavailable" }, 503);
  });
  // Read-only advisory telemetry over events the engine already appended, on a literal
  // path registered before `/api/workflows/:id` so the id route cannot swallow it.
  app.get("/api/workflows/test-evidence-audit", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const raw = c.req.query("limit");
    const limit = raw === undefined ? TEST_EVIDENCE_AUDIT_SCAN_LIMIT : Number(raw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > TEST_EVIDENCE_AUDIT_SCAN_LIMIT) {
      return c.json({
        error: `limit must be an integer from 1 through ${TEST_EVIDENCE_AUDIT_SCAN_LIMIT}`,
      }, 400);
    }
    return c.json(manager.testEvidenceAudit(limit) satisfies TestEvidenceAuditAggregate);
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
    // ONE transaction over both halves, because the old route's contract is that its body is
    // one object. `checkCommands` belongs to the Command catalog now and everything else to
    // the config blob, and committing the catalog while the policy write failed would answer
    // with a refusal over a change that had already happened - the operator reloads and finds
    // half of it applied, the half that decides which commands run.
    const commands = workflowCommandManager();
    if (!commands) {
      // Only a build with no catalog reaches this, and it cannot honour the command half of
      // the request. Refusing outright beats persisting policy and silently dropping the rest.
      if (parsed.data.checkCommands.length > 0) {
        return c.json({ error: "Command catalog unavailable" }, 503);
      }
      setWorkflowPolicy(parsed.data);
      return c.json(legacyWorkflowConfig());
    }
    commands.saveLegacyConfig(parsed.data.checkCommands, () => setWorkflowPolicy(parsed.data));
    return c.json(legacyWorkflowConfig());
  });

  // --- Global Command catalog: what each portable workflow slot runs on this machine ---
  //
  // Four fixed slots, so this family has no create and no delete: only a list, a read, and
  // one compare-and-swap replacement of a slot's whole state. The legacy config route above
  // writes through the same manager, so there is exactly one durable authority and one live
  // event whichever surface an operator used.
  const workflowCommandFailure = (
    c: Context,
    result: Exclude<WorkflowCommandMutation, { ok: true }>,
  ) => {
    const code = `workflow_command_${result.reason}`;
    if (result.reason === "not_found") {
      return c.json({ error: "no such command slot", code }, 404);
    }
    return c.json({ error: result.reason.replaceAll("_", " "), code, current: result.current }, 409);
  };
  app.get("/api/workflow-commands", (c) => {
    const manager = workflowCommandManager();
    if (!manager) return c.json({ error: "Command catalog unavailable" }, 503);
    return c.json(manager.list());
  });
  app.get("/api/workflow-commands/:slot", (c) => {
    const manager = workflowCommandManager();
    if (!manager) return c.json({ error: "Command catalog unavailable" }, 503);
    const view = manager.get(c.req.param("slot"));
    return view ? c.json(view) : c.json({ error: "no such command slot" }, 404);
  });
  app.put("/api/workflow-commands/:slot", bodyLimit({
    maxSize: WORKFLOW_COMMAND_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "Command request is too large" }, 413),
  }), async (c) => {
    const manager = workflowCommandManager();
    if (!manager) return c.json({ error: "Command catalog unavailable" }, 503);
    const parsed = await parseBody(c, UpdateWorkflowCommandSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.replace(c.req.param("slot"), parsed.data);
    return result.ok ? c.json(result.view) : workflowCommandFailure(c, result);
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
    if (selected && !selected.builtin && getWorkflowPolicy().defaultWorkflowId === id) {
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
    if (selected && !selected.builtin && getWorkflowPolicy().defaultWorkflowId === id) {
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
  const workflowImageFailure = (
    c: Context,
    error: unknown,
    fallback: string,
  ) => {
    const known = error instanceof WorkflowImageEvidenceError ? error : null;
    return c.json({
      error: known?.message ?? fallback,
      code: known?.code ?? "workflow_evidence_failed",
    }, (known?.status ?? 409) as 400 | 403 | 404 | 409 | 410);
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
  app.get("/api/workflow-bindings/:id/evidence", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const staged = manager.stagedEvidence(c.req.param("id"));
    return staged ? c.json(staged) : c.json({ error: "no such workflow binding" }, 404);
  });
  app.post(
    "/api/workflow-bindings/:id/evidence/coverage",
    bodyLimit({
      maxSize: WORKFLOW_EVIDENCE_COVERAGE_BODY_MAX_BYTES,
      onError: (c) => c.json({ error: "Workflow coverage request is too large" }, 413),
    }),
    async (c) => {
      const manager = workflowManager();
      if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
      const parsed = await parseBody(c, WorkflowEvidenceCoverageClaimSchema);
      if (!parsed.ok) return parsed.res;
      try {
        const staged = await manager.stageCoverage(c.req.param("id"), [parsed.data]);
        return staged ? c.json(staged) : c.json({ error: "no such workflow binding" }, 404);
      } catch (error) {
        return workflowImageFailure(c, error, "Workflow coverage could not be staged");
      }
    },
  );
  app.delete("/api/workflow-bindings/:id/evidence/coverage/:clientCriterionId", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const staged = manager.removeStagedCoverage(
      c.req.param("id"),
      c.req.param("clientCriterionId"),
    );
    return staged ? c.json(staged) : c.json({ error: "no such workflow binding" }, 404);
  });
  app.delete("/api/workflow-bindings/:id/evidence/:clientItemId", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    try {
      const staged = manager.removeStagedEvidence(
        c.req.param("id"),
        c.req.param("clientItemId"),
      );
      return staged ? c.json(staged) : c.json({ error: "no such workflow binding" }, 404);
    } catch (error) {
      return workflowImageFailure(c, error, "Remove criterion links before removing evidence");
    }
  });
  app.get("/api/sessions/:id/workflow-evidence", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const staged = manager.stagedEvidenceForSession(c.req.param("id"));
    return staged ? c.json(staged) : c.json({ error: "no such live workflow session" }, 404);
  });
  app.post(
    "/api/sessions/:id/workflow-evidence/coverage",
    bodyLimit({
      maxSize: WORKFLOW_EVIDENCE_COVERAGE_BODY_MAX_BYTES,
      onError: (c) => c.json({ error: "Workflow coverage request is too large" }, 413),
    }),
    async (c) => {
      const manager = workflowManager();
      if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
      const parsed = await parseBody(c, WorkflowEvidenceCoverageClaimSchema);
      if (!parsed.ok) return parsed.res;
      try {
        const staged = await manager.stageCoverageForSession(c.req.param("id"), [parsed.data]);
        return staged ? c.json(staged) : c.json({ error: "no such live workflow session" }, 404);
      } catch (error) {
        return workflowImageFailure(c, error, "Workflow coverage could not be staged");
      }
    },
  );
  app.delete("/api/sessions/:id/workflow-evidence/coverage/:clientCriterionId", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const staged = manager.removeStagedCoverageForSession(
      c.req.param("id"),
      c.req.param("clientCriterionId"),
    );
    return staged ? c.json(staged) : c.json({ error: "no such live workflow session" }, 404);
  });
  app.delete("/api/sessions/:id/workflow-evidence/:clientItemId", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    try {
      const staged = manager.removeStagedEvidenceForSession(
        c.req.param("id"),
        c.req.param("clientItemId"),
      );
      return staged ? c.json(staged) : c.json({ error: "no such live workflow session" }, 404);
    } catch (error) {
      return workflowImageFailure(c, error, "Remove criterion links before removing evidence");
    }
  });
  app.post("/api/workflow-bindings/:id/evidence/reattach", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, WorkflowRetainedEvidenceLocatorSchema);
    if (!parsed.ok) return parsed.res;
    try {
      return c.json(manager.reattachRetainedEvidence(c.req.param("id"), parsed.data));
    } catch (error) {
      const known = error instanceof WorkflowImageEvidenceError ? error : null;
      return c.json({
        error: known?.message ?? "Historical workflow evidence could not be staged",
        code: known?.code ?? "workflow_evidence_failed",
      }, (known?.status ?? 409) as 400 | 403 | 404 | 409 | 410);
    }
  });
  app.post("/api/workflow-bindings/:id/submit", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, SubmitWorkflowSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const result = manager.enqueueSubmit(c.req.param("id"), parsed.data);
      return result.ok
        ? c.json(
            { ...result.value, idempotent: result.idempotent ?? false },
            result.idempotent ? 200 : 202,
          )
        : workflowRuntimeFailure(c, result);
    } catch (error) {
      return workflowImageFailure(c, error, "Workflow evidence could not be staged");
    }
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
  app.get("/api/workflow-runs/:id/images/:imageId", (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    try {
      const body = readSubmissionImageBody(
        manager.store,
        c.req.param("id"),
        c.req.param("imageId"),
      );
      c.header("Content-Type", body.image.mimeType);
      c.header("Content-Length", String(body.image.bytes));
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Content-Security-Policy", "default-src 'none'; sandbox");
      c.header("Cache-Control", "private, no-store");
      return c.body(Uint8Array.from(body.data).buffer);
    } catch (error) {
      const known = error instanceof WorkflowImageEvidenceError ? error : null;
      return c.json({
        error: known?.message ?? "Workflow evidence image could not be read",
        code: known?.code ?? "workflow_evidence_failed",
      }, (known?.status ?? 409) as 400 | 403 | 404 | 409 | 410);
    }
  });
  app.post("/api/workflow-runs/:id/resubmit", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, ResubmitWorkflowSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const result = await manager.resubmit(c.req.param("id"), parsed.data);
      return result.ok
        ? c.json({ ...result.value, idempotent: result.idempotent ?? false })
        : workflowRuntimeFailure(c, result);
    } catch (error) {
      return workflowImageFailure(c, error, "Workflow evidence could not be staged");
    }
  });
  app.post(
    "/api/workflow-runs/:id/submissions/:submissionId/evidence-readiness/retry",
    bodyLimit({
      maxSize: WORKFLOW_READINESS_RETRY_BODY_MAX_BYTES,
      onError: (c) => c.json({ error: "Workflow evidence readiness retry is too large" }, 413),
    }),
    async (c) => {
      const manager = workflowManager();
      if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
      const parsed = await parseBody(c, RetryWorkflowEvidenceReadinessSchema);
      if (!parsed.ok) return parsed.res;
      const result = await manager.retryEvidenceReadiness(
        c.req.param("id"),
        c.req.param("submissionId"),
        parsed.data.requestId,
      );
      return result.ok
        ? c.json({ ...result.value, idempotent: result.idempotent ?? false })
        : workflowRuntimeFailure(c, result);
    },
  );
  app.post(
    "/api/workflow-runs/:id/submissions/:submissionId/evidence-readiness/override",
    bodyLimit({
      maxSize: WORKFLOW_READINESS_OVERRIDE_BODY_MAX_BYTES,
      onError: (c) => c.json({ error: "Workflow evidence readiness override is too large" }, 413),
    }),
    async (c) => {
      const manager = workflowManager();
      if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
      const parsed = await parseBody(c, OverrideWorkflowEvidenceReadinessSchema);
      if (!parsed.ok) return parsed.res;
      const result = manager.overrideEvidenceReadiness(
        c.req.param("id"),
        c.req.param("submissionId"),
        parsed.data.requestId,
        parsed.data.reason,
        parsed.data.acknowledgedRisk,
      );
      if (result.ok) return c.json({ override: result.override, idempotent: result.idempotent });
      switch (result.reason) {
        case "not_found":
          return c.json({
            error: "The workflow run or submission was not found.",
            code: "workflow_evidence_readiness_override_not_found",
          }, 404);
        case "policy_off":
          return c.json({
            error: "This workflow version does not enforce evidence readiness.",
            code: "workflow_evidence_readiness_override_policy_off",
          }, 409);
        case "request_conflict":
          return c.json({
            error: "That request id already names a different evidence readiness override.",
            code: "workflow_evidence_readiness_override_request_conflict",
          }, 409);
        case "conflict":
          return c.json({
            error: "This submission is no longer waiting for an evidence readiness override.",
            code: "workflow_evidence_readiness_override_conflict",
          }, 409);
      }
    },
  );
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
  app.post("/api/workflow-runs/:id/grant-rounds", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, GrantWorkflowRepairRoundsSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.grantRepairRounds(c.req.param("id"), parsed.data);
    /*
     * `idempotent` reported, as every sibling action reports it.
     *
     * The manager has always computed it: `grantRepairRounds` looks for a
     * `repair_rounds_granted` event carrying this same `requestId` and, finding one, returns
     * the run it already granted with `idempotent: true`. That branch matters because the
     * action store RETAINS its request id across a failed response, so a network error on a
     * grant that committed comes back with the same id - and without it the replay would hit
     * the `run_not_waiting` refusal, since the run is no longer spent precisely because the
     * first attempt worked.
     *
     * Dropping the flag here left the browser unable to tell a fresh grant from a replay, on
     * the one action whose success is otherwise invisible. The `?? false` is for the ok arms
     * that never set it, not a default standing in for a manager that cannot answer; both
     * halves are pinned end to end in `test/workflow-resumption.test.ts`.
     */
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
  app.post("/api/workflow-runs/:id/set-persona-directive", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, SetWorkflowPersonaDirectiveSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.setPersonaDirective(c.req.param("id"), parsed.data);
    return result.ok
      ? c.json({ ...result.value, idempotent: result.idempotent ?? false })
      : workflowRuntimeFailure(c, result);
  });
  app.post("/api/workflow-runs/:id/remove-persona-directive", async (c) => {
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, RemoveWorkflowPersonaDirectiveSchema);
    if (!parsed.ok) return parsed.res;
    const result = manager.removePersonaDirective(c.req.param("id"), parsed.data);
    return result.ok
      ? c.json({ ...result.value, idempotent: result.idempotent ?? false })
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
  const pipelineWorkspaceUnavailable = (
    view: Awaited<ReturnType<typeof registry.resolveSessionWorkspace>>["view"],
  ): string => {
    if (!view) return "session has no working directory";
    if (view.reason === "provider_pending") return "Pipeline workspace is still pending";
    if (view.reason === "identity_conflict" || view.reason === "invalid_worktree") {
      return "Pipeline workspace identity could not be revalidated";
    }
    return "Pinned Pipeline workspace evidence is unavailable";
  };
  const resolveRouteWorkspace = async (sessionId: string) => {
    const session = registry.getSession(sessionId);
    if (session && session.workspace?.authority !== "provider") {
      return {
        root: sessionWorkspaceRoot(session),
        view: session.workspace ?? null,
        repoRoot: session.repoRoot,
      };
    }
    return registry.resolveSessionWorkspace(sessionId);
  };
  const readWorkspaceDocument = async (sessionId: string, filePath: string) => {
    const resolved = await resolveRouteWorkspace(sessionId);
    if (resolved.view?.authority === "provider" && resolved.root === null) {
      if (resolved.view.capabilities.files && resolved.view.commit && resolved.repoRoot) {
        return readGitTreeFile(resolved.repoRoot, resolved.view.commit, filePath);
      }
      throw new SessionFileError(pipelineWorkspaceUnavailable(resolved.view), 409);
    }
    if (!resolved.root) throw new SessionFileError("session has no working directory", 400);
    return readSessionFile(resolved.root, filePath);
  };
  const requireLiveWorkspace = async (sessionId: string) => {
    const resolved = await resolveRouteWorkspace(sessionId);
    if (resolved.view?.authority === "provider" && !resolved.view.capabilities.write) {
      throw new SessionFileError("Pinned Pipeline evidence is read-only", 409);
    }
    if (!resolved.root) throw new SessionFileError("session has no working directory", 400);
    return resolved.root;
  };
  app.get("/api/sessions/:id/files", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    try {
      const resolved = await resolveRouteWorkspace(session.id);
      if (resolved.view?.authority === "provider" && resolved.root === null) {
        if (!resolved.view.capabilities.files || !resolved.view.commit || !resolved.repoRoot) {
          return c.json({ error: pipelineWorkspaceUnavailable(resolved.view) }, 409);
        }
        return c.json({ files: await listGitTreeFiles(resolved.repoRoot, resolved.view.commit) });
      }
      if (!resolved.root) return c.json({ error: "session has no working directory" }, 400);
      return c.json({ files: await listSessionFiles(resolved.root) });
    } catch (error) {
      const known = error instanceof SessionFileError ? error : null;
      return c.json({ error: known?.message ?? "could not list session files" }, known?.status === 404 ? 404 : 500);
    }
  });
  app.get("/api/sessions/:id/file", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = SessionFilePathSchema.safeParse({ path: c.req.query("path") });
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      return c.json(await readWorkspaceDocument(session.id, parsed.data.path));
    } catch (error) {
      const known = error instanceof SessionFileError ? error : null;
      const status = known?.status === 403 ? 403
        : known?.status === 404 ? 404
        : known?.status === 409 ? 409
        : 400;
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
    const parsed = await parseBody(c, SaveSessionFileSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const result = await saveSessionFile(
        await requireLiveWorkspace(session.id),
        parsed.data.path,
        parsed.data.text,
        parsed.data.expectedRevision,
      );
      if (!result.ok && result.status === 409) return c.json(result, 409);
      return c.json(result);
    } catch (error) {
      const known = error instanceof SessionFileError ? error : null;
      const status = known?.status === 403 ? 403
        : known?.status === 409 ? 409
        : known?.status === 413 ? 413
        : 400;
      return c.json({ ok: false, error: known?.message ?? "could not save session file" }, status);
    }
    },
  );
  /**
   * Which SOURCE lines a block clicked in the HTML preview covers.
   *
   * A read, and deliberately not a mutation: it answers a question about a file and writes
   * nothing. The create route is still the only way a comment comes into being, so this
   * hands the browser an anchor and the browser opens the ordinary composer on it.
   *
   * The file is re-read here rather than posted up, for two reasons. A 2 MiB document per
   * click is not a thing to put on the wire, and reading the CURRENT source is exactly what
   * turns a stale render into an honest refusal instead of a wrong line.
   *
   * `parse5` stays on this side of the wire as well, which is the other half of why this is
   * a route: a tree-constructing HTML parser has no business in the dashboard bundle.
   */
  app.post("/api/sessions/:id/html-block-anchor", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, HtmlBlockAnchorSchema);
    if (!parsed.ok) return parsed.res;
    let document: Awaited<ReturnType<typeof readSessionFile>>;
    try {
      document = await readWorkspaceDocument(session.id, parsed.data.path);
    } catch (error) {
      const known = error instanceof SessionFileError ? error : null;
      const status = known?.status === 403 ? 403
        : known?.status === 404 ? 404
        : known?.status === 409 ? 409
        : 400;
      return c.json({ error: known?.message ?? "could not read session file" }, status);
    }
    if (document.text === null) {
      return c.json({ error: document.error ?? "this file has no source to anchor to" }, 400);
    }
    // A resolvable path is NOT proof the render is current, and this is the case that looks
    // like success: an edit that rewrites a paragraph in place leaves the tree the same
    // shape, so the stale path still walks to an element - a different one than the reader
    // clicked, quoting words they never saw. The revision the preview was built from settles
    // it, because only the daemon knows which one it just read. Same refusal as a path that
    // no longer walks: the remedy is the same reload.
    if (parsed.data.revision !== undefined && parsed.data.revision !== document.revision) {
      return c.json({ error: HTML_BLOCK_STALE_REASON }, 409);
    }
    const resolved = resolveHtmlBlockAnchor(document.text, parsed.data.blockPath);
    // 409, not 400: the request was well formed and the answer is that the file moved under
    // the render it was taken from. That is a conflict the reader resolves by reloading.
    if (!resolved.ok) return c.json({ error: resolved.reason }, 409);
    return c.json({
      startLine: resolved.startLine,
      endLine: resolved.endLine,
      quote: resolved.quote,
      blockPath: parsed.data.blockPath,
      blockQuote: resolved.blockQuote,
      revision: document.revision,
    });
  });

  /** The inverse read: locate a stored source range in the current rendered HTML tree. */
  app.post("/api/sessions/:id/html-block-target", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, HtmlBlockTargetSchema);
    if (!parsed.ok) return parsed.res;
    let document: Awaited<ReturnType<typeof readSessionFile>>;
    try {
      document = await readWorkspaceDocument(session.id, parsed.data.path);
    } catch (error) {
      const known = error instanceof SessionFileError ? error : null;
      const status = known?.status === 403 ? 403
        : known?.status === 404 ? 404
        : known?.status === 409 ? 409
        : 400;
      return c.json({ error: known?.message ?? "could not read session file" }, status);
    }
    if (document.text === null) {
      return c.json({ error: document.error ?? "this file has no source to locate" }, 400);
    }
    if (parsed.data.revision !== undefined && parsed.data.revision !== document.revision) {
      return c.json({ error: HTML_BLOCK_STALE_REASON }, 409);
    }
    const resolved = resolveHtmlBlockPath(
      document.text,
      parsed.data.startLine,
      parsed.data.endLine,
      parsed.data.quote,
      parsed.data.blockPath,
      parsed.data.blockQuote,
    );
    if (!resolved.ok) return c.json({ error: resolved.reason }, 409);
    return c.json({ blockPath: resolved.blockPath, revision: document.revision });
  });

  // ---- line comments in the Files workspace ----
  //
  // Two roots on purpose. Session-scoped operations - listing a file's threads, reordering
  // the review - key on the session, because that is what a review belongs to (decision 2).
  // Thread-scoped operations key on the thread id, which is a uuid and globally unique, and
  // the manager resolves the session from it rather than trusting a second copy in the URL.
  //
  // `short_id` is deliberately not a route key anywhere here: it is unique PER SESSION, so
  // resolving one without a session could reach another session's thread. Phase 4's reply
  // route resolves it inside a session it already established through `findSessionByEnv`.
  /** 503 rather than a route-built manager: see the parameter's declaration for why. */
  const fileCommentsUnavailable = (c: Context) =>
    fileComments ? null : c.json({ error: "file comments are not available" }, 503);
  /** Map the manager's refusals onto HTTP; anything else is a real 500 and stays one. */
  const fileCommentFailure = (c: Context, error: unknown) => {
    if (error instanceof FileCommentError) {
      return c.json({ error: error.message }, error.status as ContentfulStatusCode);
    }
    if (error instanceof SessionFileError) {
      return c.json({ error: error.message }, error.status as ContentfulStatusCode);
    }
    throw error;
  };
  const fileCommentWorkspaceUnavailable = async (c: Context, threadId: string) => {
    const thread = fileComments?.get(threadId);
    if (!thread || !registry.getSession(thread.sessionId)) return null;
    try {
      await requireLiveWorkspace(thread.sessionId);
      return null;
    } catch (error) {
      return fileCommentFailure(c, error);
    }
  };

  app.get("/api/sessions/:id/file-comments", (c) => {
    const unavailable = fileCommentsUnavailable(c);
    if (unavailable) return unavailable;
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const path = c.req.query("path");
    return c.json({ threads: fileComments!.list(session.id, path || undefined) });
  });

  app.post("/api/sessions/:id/file-comments", async (c) => {
    const unavailable = fileCommentsUnavailable(c);
    if (unavailable) return unavailable;
    const parsed = await parseBody(c, CreateFileCommentSchema);
    if (!parsed.ok) return parsed.res;
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    try {
      await requireLiveWorkspace(session.id);
      return c.json({
        thread: fileComments!.create({ sessionId: c.req.param("id"), ...parsed.data }),
      });
    } catch (error) {
      return fileCommentFailure(c, error);
    }
  });

  app.post("/api/sessions/:id/file-comments/reorder", async (c) => {
    const unavailable = fileCommentsUnavailable(c);
    if (unavailable) return unavailable;
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, ReorderFileCommentsSchema);
    if (!parsed.ok) return parsed.res;
    try {
      await requireLiveWorkspace(session.id);
      return c.json({ threads: fileComments!.reorder(session.id, parsed.data.order) });
    } catch (error) {
      return fileCommentFailure(c, error);
    }
  });

  app.get("/api/file-comments/:id", (c) => {
    const unavailable = fileCommentsUnavailable(c);
    if (unavailable) return unavailable;
    // The whole thread, messages UNCAPPED: this is the route a surface reaches for when
    // `messageCount` told it the frame it holds was a tail, so it reads through the
    // full-history loader rather than the capped one every frame uses.
    const thread = fileComments!.getFull(c.req.param("id"));
    if (!thread) return c.json({ error: "no such comment thread" }, 404);
    return c.json({ thread });
  });

  // One route, not the status route composed with the reorder route. Those are two HTTP
  // requests, and a second submit landing between them takes the same queue position.
  app.post("/api/file-comments/:id/queue", async (c) => {
    const unavailable = fileCommentsUnavailable(c);
    if (unavailable) return unavailable;
    const workspaceUnavailable = await fileCommentWorkspaceUnavailable(c, c.req.param("id"));
    if (workspaceUnavailable) return workspaceUnavailable;
    try {
      return c.json({ thread: fileComments!.queue(c.req.param("id")) });
    } catch (error) {
      return fileCommentFailure(c, error);
    }
  });

  app.post("/api/file-comments/:id/messages", async (c) => {
    const unavailable = fileCommentsUnavailable(c);
    if (unavailable) return unavailable;
    const workspaceUnavailable = await fileCommentWorkspaceUnavailable(c, c.req.param("id"));
    if (workspaceUnavailable) return workspaceUnavailable;
    const parsed = await parseBody(c, AppendFileCommentMessageSchema);
    if (!parsed.ok) return parsed.res;
    try {
      // "human", from the literal the schema pins - never a value carried in from the
      // request. An agent reply is phase 4's, through its own token-guarded `/mcp/*` route;
      // this door is a person typing in a thread.
      const message = fileComments!.appendMessage(
        c.req.param("id"),
        parsed.data.author,
        parsed.data.body,
      );
      return c.json({ message, thread: fileComments!.get(c.req.param("id")) });
    } catch (error) {
      return fileCommentFailure(c, error);
    }
  });

  app.post("/api/file-comment-messages/:id", async (c) => {
    const unavailable = fileCommentsUnavailable(c);
    if (unavailable) return unavailable;
    const messageSession = fileComments!.messageSession(c.req.param("id"));
    if (messageSession) {
      try {
        await requireLiveWorkspace(messageSession);
      } catch (error) {
        return fileCommentFailure(c, error);
      }
    }
    const parsed = await parseBody(c, EditFileCommentMessageSchema);
    if (!parsed.ok) return parsed.res;
    try {
      return c.json({ thread: fileComments!.editMessage(c.req.param("id"), parsed.data.body) });
    } catch (error) {
      return fileCommentFailure(c, error);
    }
  });

  app.post("/api/file-comments/:id/read", async (c) => {
    const unavailable = fileCommentsUnavailable(c);
    if (unavailable) return unavailable;
    const workspaceUnavailable = await fileCommentWorkspaceUnavailable(c, c.req.param("id"));
    if (workspaceUnavailable) return workspaceUnavailable;
    try {
      return c.json({ thread: fileComments!.markRead(c.req.param("id")) });
    } catch (error) {
      return fileCommentFailure(c, error);
    }
  });

  // Phase 2's resolve control posts here. `addressed` gets no route at all - see
  // `SetFileCommentStatusSchema` and `FileCommentManager.markAddressed`.
  app.post("/api/file-comments/:id/status", async (c) => {
    const unavailable = fileCommentsUnavailable(c);
    if (unavailable) return unavailable;
    const workspaceUnavailable = await fileCommentWorkspaceUnavailable(c, c.req.param("id"));
    if (workspaceUnavailable) return workspaceUnavailable;
    const parsed = await parseBody(c, SetFileCommentStatusSchema);
    if (!parsed.ok) return parsed.res;
    try {
      return c.json({ thread: fileComments!.setStatus(c.req.param("id"), parsed.data.status) });
    } catch (error) {
      return fileCommentFailure(c, error);
    }
  });

  app.delete("/api/file-comments/:id", async (c) => {
    const unavailable = fileCommentsUnavailable(c);
    if (unavailable) return unavailable;
    const workspaceUnavailable = await fileCommentWorkspaceUnavailable(c, c.req.param("id"));
    if (workspaceUnavailable) return workspaceUnavailable;
    // Wrapped now that `delete` carries the lifetime guard: a stale dashboard holding the id
    // of a thread whose session ended gets that guard's 409, not an opaque 500.
    try {
      if (!fileComments!.delete(c.req.param("id"))) {
        return c.json({ error: "no such comment thread" }, 404);
      }
    } catch (error) {
      return fileCommentFailure(c, error);
    }
    return c.json({ ok: true });
  });


  // ---- the walkthrough: one comment at a time, with exactly one turn outstanding ----
  //
  // Session-scoped, because a review belongs to a session (decision 2) and there is exactly one
  // per session - which is also why `file_comment_reviews` is keyed by `session_id` rather than
  // by an id of its own. Reorder is NOT redeclared here: phase 1's
  // `POST /api/sessions/:id/file-comments/reorder` is the queue's order, and a review that
  // owned a second reordering door would be a second source of truth about the same column.
  app.get("/api/sessions/:id/file-comment-review", (c) => {
    const unavailable = fileCommentsUnavailable(c);
    if (unavailable) return unavailable;
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json({
      review: registry.fileCommentReview(session.id),
      progress: progressOf(
        fileComments!.list(session.id),
        registry.fileCommentReview(session.id).startedAt,
      ),
    });
  });

  app.post("/api/sessions/:id/file-comment-review", async (c) => {
    const unavailable = fileCommentsUnavailable(c);
    if (unavailable) return unavailable;
    if (!fileCommentWalkthrough) {
      return c.json({ error: "the review walkthrough is not available" }, 503);
    }
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, FileCommentReviewControlSchema);
    if (!parsed.ok) return parsed.res;
    try {
      await requireLiveWorkspace(session.id);
    } catch (error) {
      return fileCommentFailure(c, error);
    }
    // `start` covers resume: see the schema for why those are one action and not two.
    const review = parsed.data.action === "start"
      ? fileCommentWalkthrough.start(session.id)
      : parsed.data.action === "pause"
      ? fileCommentWalkthrough.pause(session.id, parsed.data.reason ?? null)
      : fileCommentWalkthrough.dismissPauseReason(session.id);
    return c.json({ review });
  });

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
    const parsed = await parseBody(c, OpenSessionFileSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const file = await resolveSessionFilePath(
        await requireLiveWorkspace(session.id),
        parsed.data.path,
      );
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
      const status = known?.status === 403 ? 403
        : known?.status === 404 ? 404
        : known?.status === 409 ? 409
        : 400;
      return c.json({ ok: false, error: known?.message ?? "could not open session file" }, status);
    }
  });
  // --- The archive library ---
  //
  // Thin adapters over `ArchiveManager`. Nothing here touches the store, the
  // filesystem, or a path: a request names an opaque archive key and an opaque artifact id,
  // and the manager is the only thing that turns either into a file. That is what makes
  // "never accept a path from the browser" a property of the design rather than a rule each
  // of these routes has to remember.
  const archiveLibrary = (): ArchiveManager | null => archives ?? null;

  app.get("/api/archives", (c) => {
    const library = archiveLibrary();
    if (!library) return c.json({ error: "archive library unavailable" }, 503);
    const parsed = ArchiveSearchQuerySchema.safeParse({
      q: c.req.query("q"),
      producer: c.req.query("producer"),
      repo: c.req.query("repo"),
      agent: c.req.query("agent"),
      kind: c.req.query("kind"),
      status: c.req.query("status"),
      from: c.req.query("from"),
      to: c.req.query("to"),
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const query = parsed.data;
    return c.json(
      library.list({
        q: query.q ?? null,
        producer: query.producer ?? null,
        repo: query.repo ?? null,
        agent: query.agent ?? null,
        kind: query.kind ?? null,
        status: query.status ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        cursor: query.cursor ?? null,
        limit: query.limit ?? ARCHIVE_SEARCH_LIMITS.defaultLimit,
      }),
    );
  });

  app.get("/api/archives/:archiveKey", (c) => {
    const library = archiveLibrary();
    if (!library) return c.json({ error: "archive library unavailable" }, 503);
    const detail = library.detail(c.req.param("archiveKey"));
    return detail ? c.json(detail) : c.json({ error: "no such archive" }, 404);
  });

  // Rename only this machine's catalog entry. The immutable manifest and every archived
  // byte stay untouched; `ArchiveManager` persists the display name beside the library so
  // rebuilding the disposable index does not lose it.
  app.patch("/api/archives/:archiveKey", async (c) => {
    const library = archiveLibrary();
    if (!library) return c.json({ error: "archive library unavailable" }, 503);
    const parsed = await parseBody(c, RenameArchiveSchema);
    if (!parsed.ok) return parsed.res;
    try {
      return c.json(await library.renameArchive(c.req.param("archiveKey"), parsed.data.title));
    } catch (error) {
      const failure = archiveErrorStatus(error);
      return c.json({ ok: false, error: failure.message }, failure.status);
    }
  });

  // One archived file's bytes.
  //
  // ALWAYS an attachment, including the HTML report, and that is the same decision the
  // session-file routes make one screen above: archived HTML is content somebody else wrote,
  // and serving it inline would put it on the daemon's own origin where its scripts would
  // reach every action route on this port. A reader that wants to display it fetches the
  // text and renders it in a sandboxed frame, which `Content-Disposition` does not affect.
  // The content type comes from the archive path's extension through a closed table, never
  // from the manifest's claim, and `nosniff` stops a browser from improving on it.
  app.get("/api/archives/:archiveKey/artifacts/:artifactId", async (c) => {
    const library = archiveLibrary();
    if (!library) return c.json({ error: "archive library unavailable" }, 503);
    try {
      // The manager returns an OPEN handle, not a path, and the length comes from `fstat` on
      // that same handle. Reopening by name here would reintroduce the window between "this
      // path is safe" and "these are the bytes": swap the verified file for a symlink in
      // between and the daemon would serve whatever it points at, under this archive's own
      // content type, with a Content-Length describing different bytes entirely.
      const file = await library.artifactBody(c.req.param("archiveKey"), c.req.param("artifactId"));
      const handle = file.handle;
      c.header("Content-Type", file.view.mediaType);
      c.header("Content-Length", String(file.bytes));
      c.header("Content-Disposition", `attachment; filename="${file.fileName}"`);
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Content-Security-Policy", "default-src 'none'; sandbox");
      c.header("Cache-Control", "no-store");
      return c.body(
        Readable.toWeb(handle.createReadStream({ autoClose: true })) as unknown as ReadableStream,
      );
    } catch (error) {
      const failure = archiveErrorStatus(error);
      return c.json({ error: failure.message }, failure.status);
    }
  });

  // Hand one archived file to an application outside Mission Control. A POST for the reason
  // the session-file twin is: the daemon launches a local application against a local path,
  // and nothing about the file crosses this boundary.
  app.post("/api/archives/:archiveKey/artifacts/:artifactId/open", async (c) => {
    const library = archiveLibrary();
    if (!library) return c.json({ error: "archive library unavailable" }, 503);
    const parsed = await parseBody(c, OpenArchiveArtifactSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const result = await library.openArtifact(
        c.req.param("archiveKey"),
        c.req.param("artifactId"),
        parsed.data.target,
      );
      const body = {
        ok: result.ok,
        target: parsed.data.target,
        label: result.label,
        detail: result.detail,
        ...(result.error ? { error: result.error } : {}),
      };
      return result.ok ? c.json(body) : c.json(body, result.status as 409 | 502 | 504);
    } catch (error) {
      const failure = archiveErrorStatus(error);
      return c.json({ ok: false, error: failure.message }, failure.status);
    }
  });

  // Delete one local bundle. The body echoes the key in the URL and a mismatch is refused
  // before any path is resolved - see `DeleteArchiveSchema` for why that is not
  // redundant. This removes a local file and its rows; it touches no task, no session, and
  // nothing outside this machine.
  app.delete("/api/archives/:archiveKey", async (c) => {
    const library = archiveLibrary();
    if (!library) return c.json({ error: "archive library unavailable" }, 503);
    const parsed = await parseBody(c, DeleteArchiveSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const result = await library.delete(c.req.param("archiveKey"), parsed.data.confirmArchiveKey);
      return c.json(result);
    } catch (error) {
      const failure = archiveErrorStatus(error);
      return c.json({ ok: false, error: failure.message }, failure.status);
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
        let workspaceRoot: string;
        try {
          workspaceRoot = await requireLiveWorkspace(session.id);
        } catch (error) {
          const known = error instanceof SessionFileError ? error : null;
          return c.json(
            { ok: false, error: known?.message ?? "Pipeline workspace is unavailable" },
            409,
          );
        }
        const handedOff = await handoffSession({ ...session, cwd: workspaceRoot }, backend);
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
      let workspaceRoot: string;
      try {
        workspaceRoot = await requireLiveWorkspace(session.id);
      } catch (error) {
        const known = error instanceof SessionFileError ? error : null;
        return c.json(
          { ok: false, error: known?.message ?? "Pipeline workspace is unavailable" },
          409,
        );
      }
      if (agentResumeClaims.has(session.id)) {
        return c.json({ ok: false, error: "this conversation is already being resumed" }, 409);
      }

      // With the mode the session was last observed in, so the resumed CLI starts where
      // the operator left it - the same carry the embedded handoff makes, and null when
      // nobody measured one, which renders no flag rather than a guess.
      let argv: string[] | null;
      try {
        argv = await resumeArgvFor(
          session.agent,
          session.agentSessionId!,
          session.permissionMode,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ ok: false, backend, error: message }, 409);
      }
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
        result = await launchAgentTerminal(backend, {
          name: session.name,
          cwd: workspaceRoot,
          argv,
        }, terminalLauncher);
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
            homeBackend: result.homeName ? backend : null,
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
    let shellRoot: string;
    try {
      shellRoot = await requireLiveWorkspace(session.id);
    } catch (error) {
      const known = error instanceof SessionFileError ? error : null;
      return c.json({ ok: false, error: known?.message ?? "Pipeline workspace is unavailable" }, 409);
    }

    // From the DAEMON's own environment, never the checkout. A repo-supplied shell would
    // be arbitrary code execution on this host from a button labelled "Terminal".
    //
    // `-l` because the README calls this a LOGIN shell, and without it the promise is
    // false in a way an operator feels immediately: bash and zsh skip their login startup
    // files, so PATH, nvm/rbenv shims and prompt all differ from the terminal that person
    // opens by hand - in a window that exists to run the same commands they would. Every
    // shell this can resolve to (bash, zsh, fish, ksh, dash, csh/tcsh) accepts `-l`.
    const argv = [process.env.SHELL || FIXED_OS_EXECUTABLES.sh, "-l"];
    const result = await terminalLauncher(backend, { name: session.name, cwd: shellRoot, argv });
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

  // The machine-local source of those workspace roots. The environment remains the
  // launch-time authority; when present, the view says so and the saved list is read-only.
  app.get("/api/repo-index", async (c) => c.json(await repoIndexView()));
  app.put("/api/repo-index", async (c) => {
    const override = repositoryIndexEnvironmentOverride();
    if (override) {
      return c.json({
        error: `Repository index directories are read-only while ${override.variable} is set.`,
      }, 409);
    }
    const parsed = await parseBody(c, RepoIndexConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    try {
      setRepoIndexConfig(parsed.data);
      return c.json(await repoIndexView());
    } catch (error) {
      if (error instanceof RepoIndexConfigError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  });
  app.post("/api/repo-index/rescan", async (c) => {
    invalidateReposCache();
    return c.json(await repoIndexView());
  });

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

  const backupUnavailable = (c: Context) => c.json({
    error: "service_unavailable" as const,
    message: "Settings backup service is unavailable",
  }, 503);
  const backupFailure = (c: Context, _error: unknown) => c.json({
    error: "service_error" as const,
    message: "Settings backup operation failed",
  }, 500);
  const localPathStart = /file:\/\/\/|\\\\|(?<![A-Za-z0-9])[A-Za-z]:[\\/]|~[\\/]|(?<![A-Za-z0-9/])\/(?!\/)/i;
  const redactLocalPaths = (message: string): string => {
    const match = localPathStart.exec(message);
    if (!match) return message.slice(0, SETTINGS_BACKUP_LIMITS.errorCharacters);
    // An unquoted path may contain spaces, so no suffix after the path start is safe to retain.
    // This intentionally gives up trailing diagnostic detail instead of guessing at a boundary.
    return `${message.slice(0, match.index)}[local path]`
      .slice(0, SETTINGS_BACKUP_LIMITS.errorCharacters);
  };
  const publicPreview = (preview: SettingsRestorePreview): SettingsRestorePreview => ({
    ...preview,
    exclusions: preview.exclusions.map(redactLocalPaths),
    warnings: preview.warnings.map(redactLocalPaths),
    blockers: preview.blockers.map(redactLocalPaths),
  });
  const publicPreviewResult = (
    result: SettingsRestorePreviewResult,
  ): SettingsRestorePreviewResult => {
    if (result.status === "ready" || result.status === "preflight_blocked") {
      return { ...result, preview: publicPreview(result.preview) };
    }
    return {
      ...result,
      reason: result.status === "io_error"
        ? "Snapshot could not be read"
        : redactLocalPaths(result.reason),
    };
  };
  const publicRestoreResult = (result: SettingsRestoreResult): SettingsRestoreResult => {
    if (result.status === "restored") {
      return { ...result, warnings: result.warnings.map(redactLocalPaths) };
    }
    if (result.status === "in_progress") return result;
    if (result.status === "preflight_blocked") {
      return { ...result, preview: publicPreview(result.preview) };
    }
    if (result.status === "io_error") {
      return { ...result, reason: "Snapshot could not be read" };
    }
    if (result.status === "restore_failed") {
      return { ...result, reason: "Restore failed and current settings were preserved" };
    }
    return { ...result, reason: redactLocalPaths(result.reason) };
  };
  const publicBackupItem = (
    item: ReturnType<SettingsBackupService["list"]>[number],
  ): SettingsBackupPublicItem | null => {
    if (item.status === "not_found") return null;
    if (item.status === "ready") {
      return {
        status: item.status,
        id: item.id,
        size: item.size,
        modifiedAt: new Date(item.modifiedAt).toISOString(),
        kind: item.kind,
        createdAt: item.createdAt,
        localDate: item.localDate,
        appVersion: item.appVersion,
        counts: item.counts,
        digest: item.digest,
      };
    }
    return {
      status: item.status,
      id: item.id,
      size: item.size,
      modifiedAt: item.modifiedAt === null ? null : new Date(item.modifiedAt).toISOString(),
      reason: item.status === "unreadable"
        ? "Snapshot could not be read"
        : redactLocalPaths(item.reason),
    };
  };

  app.get("/api/settings-backups", (c) => {
    if (!settingsBackups) return backupUnavailable(c);
    try {
      const snapshots = settingsBackups.list()
        .map(publicBackupItem)
        .filter((item): item is SettingsBackupPublicItem => item !== null);
      return c.json({
        status: "available" as const,
        snapshots,
        retention: {
          daily: SETTINGS_BACKUP_RETENTION.daily,
          preRestore: SETTINGS_BACKUP_RETENTION.pre_restore,
        },
        lastSuccessfulSnapshot: snapshots.find((item) => item.status === "ready") ?? null,
        lastError: settingsBackups.lastError
          ? { at: settingsBackups.lastError.at, message: "Automatic settings snapshot failed" }
          : null,
      });
    } catch (error) {
      return backupFailure(c, error);
    }
  });

  app.get("/api/settings-backups/:id/preview", (c) => {
    if (!settingsBackups) return backupUnavailable(c);
    const id = SettingsBackupIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ status: "not_found", reason: "Snapshot was not found" }, 404);
    try {
      const result = publicPreviewResult(settingsBackups.previewRestore(id.data));
      switch (result.status) {
        case "ready": return c.json(result);
        case "not_found": return c.json(result, 404);
        case "preflight_blocked": return c.json(result, 409);
        case "incompatible":
        case "io_error": return c.json(result, 422);
      }
    } catch (error) {
      return backupFailure(c, error);
    }
  });

  app.post(
    "/api/settings-backups/:id/restore",
    bodyLimit({
      maxSize: 4 * 1024,
      onError: (c) => c.json({
        error: "invalid_request" as const,
        message: "Restore request is too large",
      }, 413),
    }),
    async (c) => {
    if (!settingsBackups) return backupUnavailable(c);
    const id = SettingsBackupIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ status: "not_found", reason: "Snapshot was not found" }, 404);
    const parsed = await parseBody(c, SettingsRestoreRequestSchema);
    if (!parsed.ok) {
      return c.json({ error: "invalid_request", message: "Restore confirmation is invalid" }, 400);
    }
    try {
      const serviceResult = await settingsBackups.restore(id.data, parsed.data.expectedDigest);
      const result = publicRestoreResult(serviceResult);
      switch (result.status) {
        case "restored":
          registry.emitSettingsRestored({
            snapshotId: result.snapshotId,
            restoredAt: result.restoredAt,
            requestId: parsed.data.requestId,
          });
          return c.json(result);
        case "not_found": return c.json(result, 404);
        case "in_progress":
        case "stale_digest":
        case "preflight_blocked": return c.json(result, 409);
        case "incompatible":
        case "io_error": return c.json(result, 422);
        case "restore_failed": return c.json(result, 500);
      }
    } catch (error) {
      return backupFailure(c, error);
    }
    },
  );

  app.get("/events", sseHandler(registry));
  // Live transcript for the session detail (localhost-only, like the actions).
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
      // The panel's own history pages, so they carry the same launch presentation the stream
      // put on `init` - decorated here rather than in the reader, because paging back far
      // enough to reach the launch turn must not make it reappear in full.
      return c.json({
        ...page,
        messages: attributeTranscript(
          session.id,
          page.messages,
          resolveLaunchMarker(registry, session.id),
          (messageId) => bindLaunchTurnMessage(registry, session.id, messageId),
        ),
      });
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
    const resolved = await resolveRouteWorkspace(session.id);
    if (
      resolved.view?.authority === "provider" &&
      resolved.root === null &&
      resolved.view.capabilities.files &&
      resolved.view.commit &&
      resolved.repoRoot
    ) {
      return c.json(await readStandardsFromGitTree(
        resolved.repoRoot,
        resolved.view.commit,
        parsed.data.paths,
      ));
    }
    if (resolved.view?.authority === "provider" && resolved.root === null) {
      return c.json({ docs: [], truncated: true });
    }
    const root = await repoRootOf(resolved.root);
    return c.json(readStandards(root, parsed.data.paths));
  });

  // Foreman's standing instructions - the prose half of its configuration.
  //
  // GLOBAL, not per-session, because that is what it is: one setting for the operator, not a
  // property of whichever session happens to be under review. It reads the stored value if
  // they have edited it and the shipped `FOREMAN.md` otherwise, so the worker never has to
  // know which of the two it got.
  //
  // The document route carries the exact effective text, built-in Reset target, durable source,
  // and opaque ETag together. Status carries only the source so this document never joins the
  // frequent global poll.
  app.get("/api/foreman/instructions", (c) => c.json(foremanInstructionsView()));

  // Replace or reset only from the exact view the caller read. An empty string is a real choice
  // ("judge by your own policy alone") and is stored as such; reset writes null so the shipped
  // default applies and older builds remain able to read the same row.
  app.put("/api/foreman/instructions", bodyLimit({
    maxSize: FOREMAN_INSTRUCTIONS_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "Foreman instructions request is too large" }, 413),
  }), async (c) => {
    const parsed = await parseBody(c, ForemanInstructionsSchema);
    if (!parsed.ok) return parsed.res;
    const result = updateForemanInstructions(parsed.data);
    if (result.ok) return c.json(result.view);
    const conflict = {
      error: FOREMAN_INSTRUCTIONS_CONFLICT_MESSAGE,
      code: FOREMAN_INSTRUCTIONS_CONFLICT_CODE,
      current: result.current,
    } satisfies ForemanInstructionsConflict;
    return c.json(conflict, 409);
  });


  // Repository standing instructions - one box per repository, in the operator's own words,
  // sent to every session Mission Control opens into that checkout.
  //
  // MACHINE-LOCAL and per-repository, which is the intersection nothing else here covers:
  // `AGENTS.md` is per-repository and committed, so it reaches every teammate on every
  // machine, and Foreman's instructions are machine-local but global and never reach a
  // session at all.
  app.get("/api/instructions", (c) => c.json(standingInstructionsView()));

  // Compare-and-swap, from the exact view the caller read. `repositories` is a PATCH: an
  // absent key is left alone, a string sets it, and `null` removes it - so a panel saving
  // one repository sends that one key and cannot persist a neighbouring box's unsaved draft.
  app.put(
    "/api/instructions",
    bodyLimit({
      maxSize: STANDING_INSTRUCTIONS_BODY_MAX_BYTES,
      onError: (c) => c.json({ error: "Standing instructions request is too large" }, 413),
    }),
    async (c) => {
      const parsed = await parseBody(c, StandingInstructionsUpdateSchema);
      if (!parsed.ok) return parsed.res;

      // Every repository key is canonicalized HERE, on the way in, and the stored key is
      // `.path` and never `.repoRoot`. The two differ in exactly the way that breaks this
      // feature: `resolveRepoRoot` is lossy by design, so `<root>/packages/api` would
      // collapse to `<root>` - the package rule silently becomes the monorepo rule,
      // overwrites whatever was there, and the longest-match behaviour the store advertises
      // cannot be configured at all. `.path` still carries the guard that matters, re-rooting
      // a pooled worktree onto its owning main checkout so a throwaway path never reaches
      // durable config.
      const repositories: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(parsed.data.repositories ?? {})) {
        const repoPath = await canonicalRepoPath(key);
        if (!repoPath) return c.json({ error: `not a git repository: ${key}` }, 400);
        // Two spellings of one checkout in a single patch - a symlink and its target, a
        // pool slot and its main checkout - would otherwise be last-wins in whatever order
        // the object happened to iterate.
        if (repoPath in repositories && repositories[repoPath] !== value) {
          return c.json({ error: `listed twice, as the same repository: ${repoPath}` }, 400);
        }
        repositories[repoPath] = value;
      }

      const result = updateStandingInstructions({
        expectedEtag: parsed.data.expectedEtag,
        ...(parsed.data.default !== undefined ? { default: parsed.data.default } : {}),
        ...(parsed.data.repositories !== undefined ? { repositories } : {}),
      });
      if (result.ok) return c.json(result.view);
      if ("refusal" in result) return c.json({ error: result.refusal }, 400);
      const conflict = {
        error: STANDING_INSTRUCTIONS_CONFLICT_MESSAGE,
        code: STANDING_INSTRUCTIONS_CONFLICT_CODE,
        current: result.conflict,
      } satisfies StandingInstructionsConflict;
      return c.json(conflict, 409);
    },
  );

  /**
   * What a session launched into these checkouts WOULD be sent, from live configuration.
   *
   * `repoPath` repeats, once per attached repository in the launch manifest's order,
   * because a launch composes a block for EVERY attached repository that has rules. A
   * preview of one would tell a two-repo dispatch that nothing will be sent while the launch
   * sends the second repository's rules - and a marker saying "nothing" is the reason an
   * operator stops looking.
   *
   * `agent` and `runtime` are required and validated, because the MECHANISM is a property of
   * the pair rather than of the repository: the same text is a system prompt on
   * `claude · terminal`, developer instructions on `codex · sdk`, and turn-one prose on
   * `pi · terminal`. An unknown agent, or a runtime the harness does not offer, is a refusal
   * rather than a default - `resolveSessionRuntime` already owns that degradation and the
   * answer must not be invented a second time here.
   *
   * Composed through the SAME `compose.ts` a launch uses, over the same ordered list, so the
   * preview cannot drift from the delivery. This answers "what WILL a session get"; what a
   * session DID get is the launch snapshot below, whose text and provenance are immutable.
   */
  app.get("/api/instructions/resolved", async (c) => {
    const repoPaths = c.req.queries("repoPath") ?? [];
    if (repoPaths.length === 0) return c.json({ error: "repoPath is required" }, 400);
    // The launch manifest's own cap - primary plus the secondaries a dispatch may attach.
    const maxPreview = MAX_TASK_EXTRA_REPOS + 1;
    if (repoPaths.length > maxPreview) {
      return c.json({ error: `at most ${maxPreview} repositories may be previewed` }, 400);
    }
    const agentParam = c.req.query("agent") ?? "";
    const agent = AGENT_TYPES.find((a) => a === agentParam);
    if (!agent) return c.json({ error: `unknown agent: ${agentParam}` }, 400);
    const runtimeParam = c.req.query("runtime") ?? "";
    const runtime = SESSION_RUNTIMES.find((r) => r === runtimeParam);
    if (!runtime || !harnessOffersRuntime(agent, runtime)) {
      return c.json({ error: `${agent} cannot be driven over runtime: ${runtimeParam}` }, 400);
    }
    // Canonicalized for the reason the PUT is, and one more: the browser hands this route a
    // path it had lying around - a picker selection, a session's cwd - and sessions normally
    // run in pooled worktrees. A raw `~/.treehouse/<pool>/16/mono/packages/api` matches no
    // stored key, so an uncanonicalized preview would report that nothing will be sent while
    // the launch from that very slot delivers the block.
    const candidates: { repoPath: string }[] = [];
    for (const raw of repoPaths) {
      const repoPath = await canonicalRepoPath(raw);
      if (!repoPath) return c.json({ error: `not a git repository: ${raw}` }, 400);
      candidates.push({ repoPath });
    }
    return c.json(
      composeStandingInstructions(standingInstructionsConfig(), candidates, agent, runtime),
    );
  });

  /**
   * What THIS session was actually sent at launch, or 404.
   *
   * Read back by identity and never re-resolved: a session outlives the setting that
   * launched it, so live configuration would quote a running session a text it never saw the
   * moment the operator edits the rule - or show nothing at all once the override is removed.
   *
   * A dedicated fetch rather than a field on the session wire type. The text runs to 8,000
   * characters and `session_upsert` is broadcast over SSE for every session on every change,
   * so a field would put the whole corpus on the wire repeatedly to serve one detail view.
   */
  app.get("/api/sessions/:id/standing-instructions", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const snapshot = registry.standingInstructionsFor(session.id);
    if (!snapshot) return c.json({ error: "this session received no standing instructions" }, 404);
    return c.json({
      text: snapshot.text,
      mechanism: snapshot.mechanism,
      sources: snapshot.sources,
    } satisfies StandingInstructionsDelivery);
  });

  // Diff of a session's worktree/branch vs its source branch (localhost read).
  app.get("/api/sessions/:id/diff", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const resolved = await resolveRouteWorkspace(session.id);
    // `commit` isolates ONE commit (`<sha>^..<sha>`). Distinct from `base`, which
    // diffs from the merge-base and would answer with everything since that sha.
    const commit = c.req.query("commit");
    if (commit) return c.json(await computeCommitDiff(resolved.root ?? resolved.repoRoot, commit));
    const source = c.req.query("base") || undefined;
    if (resolved.view?.authority === "provider" && resolved.root === null) {
      if (resolved.view.capabilities.diff && resolved.view.commit && resolved.repoRoot) {
        return c.json(await computePinnedRefDiff(
          resolved.repoRoot,
          resolved.view.commit,
          resolved.view.branch,
        ));
      }
      return c.json({
        ok: false,
        error: pipelineWorkspaceUnavailable(resolved.view),
        base: null,
        baseSha: null,
        headSha: resolved.view.commit?.slice(0, 12) ?? null,
        repoRoot: resolved.repoRoot,
        branch: resolved.view.branch,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        patch: "",
        truncated: false,
      });
    }
    return c.json(await computeSessionDiff(resolved.root, source));
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

  // --- pipeline event ingest (token-guarded): an external SDLC engine's own events,
  // pushed by the Mission Control visualizer plugin that ships from
  // `integrations/ai-conductor/mission-control/`.
  //
  // In the ingest family and guarded like the rest of it - `x-harness-token` on the first
  // line, no loopback check. That is the family's shape rather than a relaxation: these are
  // the routes a cooperating LOCAL process posts to, and the token is what separates one
  // from any other process on the machine. `requireLoopback` covers `/api/*` and `/events`.
  //
  // NDJSON rather than a JSON array, because the producer is a visualizer inside somebody
  // else's event loop: it appends a line per event and flushes whatever it has, and a line
  // that fails to parse costs that line. A batch is a stream of independent observations,
  // so one bad line never fails the POST - the counts say what happened, and the file tail
  // still covers whatever was dropped.
  app.post("/ingest/conductor", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const tooLarge = () =>
      c.json({ error: `batch too large; the limit is ${MAX_INGEST_BYTES} bytes` }, 413);
    // Refused on the DECLARED length first, so an oversized batch is turned away before it
    // is read into this single-threaded process at all. The producer runs unattended inside
    // another program, and a body without a ceiling is one bug upstream from a JSON.parse
    // that owns the event loop.
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_INGEST_BYTES) return tooLarge();
    // A body that could not be READ is refused, and it is worth being exact about why this
    // one line is not a swallowed error. The producer treats any 2xx as delivered and drops
    // the batch from its buffer; a dropped connection, a stream error or the plugin's own
    // shutdown abort would otherwise arrive here as the empty string, be counted as a batch
    // of nothing, and answer 200 - so a TRANSPORT failure would destroy exactly the events
    // no file records. 5xx is what the plugin retries, and retrying is the whole posture the
    // unpersisted kinds depend on.
    let body: string;
    try {
      body = await c.req.text();
    } catch {
      return c.json({ error: "could not read the batch body" }, 503);
    }
    // Then on the MEASURED length, because the header is the producer's claim rather than a
    // fact - it can be absent entirely under chunked encoding, and wrong otherwise. Measured
    // in BYTES: a JavaScript string is counted in UTF-16 code units, so a body of three-byte
    // characters costs up to three times what `String.length` reports, and non-ASCII is
    // ordinary here (step names, branch names, commit subjects all reach this stream).
    if (Buffer.byteLength(body, "utf8") > MAX_INGEST_BYTES) return tooLarge();
    const { counts, touched, commissions } = ingestConductorEvents(body);
    for (const commission of commissions) registry.upsertPipelineCommission(commission);
    // Then fold the repositories it named, a tick early. See `schedulePipelineRefresh`.
    if (touched.length > 0) schedulePipelineRefresh(registry, touched);
    return c.json(counts);
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

  // --- MCP product issues (token-guarded; source and session are daemon-derived) ---
  app.post(
    "/mcp/product-issues/preview",
    bodyLimit({
      maxSize: PRODUCT_ISSUE_LIMITS.requestJsonBytes,
      onError: (c) => c.json({ error: "Product issue request is too large" }, 413),
    }),
    async (c) => {
      if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
      if (!productIssues) {
        return c.json({
          outcome: "configuration",
          message: "Product issue service unavailable",
          retrySafe: true,
        } as const, 503);
      }
      const parsed = await parseBody(c, McpProductIssuePreviewRequestSchema);
      if (!parsed.ok) return parsed.res;
      const { env, sessionId, cwd, ...request } = parsed.data;
      const session = registry.findSessionByEnv(env, sessionId, cwd);
      if (!session || session.state === "exited") {
        return c.json({ error: "no matching active session" }, 404);
      }
      const result = productIssues.preview("agent", request);
      if (result.outcome === "preview") return c.json(result);
      return c.json(result, result.outcome === "configuration" ? 503 : 409);
    },
  );

  app.post(
    "/mcp/product-issues",
    bodyLimit({
      maxSize: PRODUCT_ISSUE_LIMITS.requestJsonBytes,
      onError: (c) => c.json({ error: "Product issue request is too large" }, 413),
    }),
    async (c) => {
      if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
      if (!productIssues) {
        return c.json({
          outcome: "configuration",
          message: "Product issue service unavailable",
          retrySafe: true,
        } as const, 503);
      }
      const parsed = await parseBody(c, McpProductIssueSubmitRequestSchema);
      if (!parsed.ok) return parsed.res;
      const { env, sessionId, cwd, ...request } = parsed.data;
      const session = registry.findSessionByEnv(env, sessionId, cwd);
      if (!session || session.state === "exited") {
        return c.json({ error: "no matching active session" }, 404);
      }
      const response = productIssueSubmitResponse(
        await productIssues.submit("agent", request),
      );
      return c.json(response.body, response.status);
    },
  );

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

  async function createMcpTask(
    c: Context,
    data: McpCreateTaskV2,
    allowShortNames: boolean,
  ) {
    const {
      env,
      sessionId,
      cwd,
      dependsOnTaskIds,
      dependsOnCurrentSession,
    } = data;
    const shortNameSelectors = !allowShortNames
      ? "none"
      : data.targetRepository === undefined
        ? "extras"
        : "all";
    const prepared = await prepareTaskRepositories({
      primary: data.targetRepository ?? data.repoRoot,
      extras: data.additionalRepositories,
      kind: "ship",
      shortNameSelectors,
    });
    if (!prepared.ok) return c.json({ error: prepared.error }, prepared.status);

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
        repoRoot: prepared.repoRoot,
        extraRepoRoots: prepared.extraRepoRoots,
        title: data.title,
        intent: data.intent,
        kind: "ship",
        // Resolved during repository preparation so the capability check and stored pin
        // cannot observe different ship-kind defaults.
        agent: prepared.agent,
        backlog: true,
        dependencies,
      });
      return c.json(task);
    } catch (error) {
      if (error instanceof TaskDependencyError) return c.json({ error: error.message }, 409);
      throw error;
    }
  }

  app.post("/mcp/tasks", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, McpCreateTaskSchema);
    if (!parsed.ok) return parsed.res;
    // Preserve the selector-free endpoint for older bundles. The caller's own repoRoot still
    // walks a pooled worktree back to its main checkout through the shared preparation door.
    return createMcpTask(
      c,
      { ...parsed.data, targetRepository: undefined, additionalRepositories: [] },
      false,
    );
  });

  app.post("/mcp/v2/tasks", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, McpCreateTaskV2Schema);
    if (!parsed.ok) return parsed.res;
    return createMcpTask(c, parsed.data, true);
  });

  app.post("/mcp/retros/no-change", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, CompleteRetroNoChangeSchema);
    if (!parsed.ok) return parsed.res;
    const { env, sessionId, cwd } = parsed.data;
    const session = registry.findSessionByEnv(env, sessionId, cwd);
    if (!session) return c.json({ error: "no matching active session" }, 404);
    const result = await tasks.completeRetroNoChange(session.id, cwd);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ task: result.task, sourceTaskId: result.sourceTaskId, replayed: result.replayed });
  });

  app.get("/mcp/reviews/:id/wait", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const review = await reviews.wait(c.req.param("id"), WAIT_TIMEOUT_MS);
    if (!review) return c.json({ error: "no such review" }, 404);
    return c.json(review);
  });

  app.post("/mcp/reviews/:id/detach", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, DetachReviewWaitSchema);
    if (!parsed.ok) return parsed.res;
    const session = registry.findSessionByEnv(
      parsed.data.env,
      parsed.data.sessionId,
      parsed.data.cwd,
    );
    if (!session) return c.json({ error: "no matching session" }, 404);
    const review = reviews.detachWait(c.req.param("id"), session.id);
    if (!review) return c.json({ error: "no such review for this session" }, 404);
    return c.json({ id: review.id, detached: true });
  });

  /**
   * The agent's answer to one line comment. Phase 4's whole door.
   *
   * In the `/mcp/reviews` shape - token, `parseBody`, `findSessionByEnv` - and deliberately
   * NOT behind `requireLoopback`: `/mcp/*` is reached by an MCP child that may not present a
   * loopback `host`, and the token is the gate there. Non-blocking by construction: it posts
   * and answers, because an agent must never wait on a human here.
   *
   * The session is established BEFORE the handle is resolved, and that order is the whole
   * safety property: `short_id` is unique per session, so resolving it inside the session
   * that just authenticated is what stops a reply landing on another session's identically
   * named thread.
   */
  app.post("/mcp/file-comments/replies", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const unavailable = fileCommentsUnavailable(c);
    if (unavailable) return unavailable;
    const parsed = await parseBody(c, RespondToFileCommentsSchema);
    if (!parsed.ok) return parsed.res;
    const { env, sessionId, cwd, commentId, body, addressed } = parsed.data;
    const session = registry.findSessionByEnv(env, sessionId, cwd);
    if (!session) return c.json({ error: "no matching session" }, 404);
    try {
      const reply = fileComments!.agentReply(session.id, commentId, body, addressed);
      // Only a released turn is worth waking the walkthrough for. It advances on its own
      // timer regardless, so this is what turns "within ten seconds" into "immediately" -
      // and the walkthrough re-reads everything durably, so nothing is passed to it.
      if (reply.released) fileCommentWalkthrough?.onCommentAnswered(session.id);
      return c.json({
        sessionId: session.id,
        threadId: reply.thread.id,
        commentId: reply.thread.shortId,
        status: reply.thread.status,
        released: reply.released,
      });
    } catch (error) {
      return fileCommentFailure(c, error);
    }
  });

  app.post("/mcp/status", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, StatusSchema);
    if (!parsed.ok) return parsed.res;
    registry.applyStatus(parsed.data.env, parsed.data.sessionId, parsed.data.activity);
    return c.body(null, 204);
  });

  app.post("/mcp/pipelines/adopt", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, McpAdoptPipelineRunSchema);
    if (!parsed.ok) return parsed.res;
    const credential = c.req.header(PIPELINE_CALLER_CREDENTIAL_HEADER);
    const caller = credential ? registry.managedPipelineCaller(credential) : null;
    if (!caller) {
      return c.json({ error: "the caller has no managed Pipeline launch capability" }, 403);
    }
    const task = registry.getTask(caller.taskId);
    if (!task) return c.json({ error: "no matching Pipeline task" }, 404);
    if (!task.pipelineRun) {
      return c.json({ error: "the Pipeline task has no launch reservation" }, 409);
    }
    if (task.sessionId !== caller.sessionId) {
      return c.json({ error: "the caller does not own this Pipeline task" }, 403);
    }
    const session = registry.getSession(caller.sessionId);
    if (session?.state === "exited") return c.json({ error: "no matching active session" }, 404);
    if (session) {
      if (session.cwd !== caller.cwd) {
        return c.json({ error: "the caller does not match the managed Pipeline host" }, 403);
      }
    } else {
      const launch = registry.managedPipelineLaunch(caller.sessionId);
      if (!launch) return c.json({ error: "no matching active session" }, 404);
      if (launch.taskId !== task.id || launch.cwd !== caller.cwd) {
        return c.json({ error: "the caller does not match the pending managed Pipeline host" }, 403);
      }
    }
    const result = tasks.adoptPipelineRun(
      task,
      {
        provider: task.pipelineRun.provider,
        repoRoot: task.repoRoot,
        slug: parsed.data.slug,
      },
      session
        ? { kind: "managed", session }
        : { kind: "managed-launch", sessionId: caller.sessionId },
    );
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ task: result.task, replayed: result.replayed });
  });

  app.post("/mcp/pipelines/workspace", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, McpReportPipelineWorkspaceSchema);
    if (!parsed.ok) return parsed.res;
    const credential = c.req.header(PIPELINE_CALLER_CREDENTIAL_HEADER);
    const caller = credential ? registry.managedPipelineCaller(credential) : null;
    if (!caller) {
      return c.json({ error: "the caller has no managed Pipeline launch capability" }, 403);
    }
    const task = registry.getTask(caller.taskId);
    if (!task) return c.json({ error: "no matching Pipeline task" }, 404);
    if (task.sessionId !== caller.sessionId) {
      return c.json({ error: "the caller does not own this Pipeline task" }, 403);
    }
    const session = registry.getSession(caller.sessionId);
    if (session?.state === "exited") return c.json({ error: "no matching active session" }, 404);
    if (session) {
      if (
        session.cwd !== caller.cwd ||
        session.runtime !== "sdk" ||
        session.pipeline !== null
      ) {
        return c.json({ error: "the caller does not match the managed Pipeline host" }, 403);
      }
    } else {
      const launch = registry.managedPipelineLaunch(caller.sessionId);
      if (!launch) return c.json({ error: "no matching active session" }, 404);
      if (launch.taskId !== task.id || launch.cwd !== caller.cwd) {
        return c.json({ error: "the caller does not match the pending managed Pipeline host" }, 403);
      }
    }
    const result = tasks.reportPipelineWorkspace(task.id, parsed.data.path);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ task: result.task, replayed: result.replayed });
  });

  app.post("/mcp/workflow-evidence", bodyLimit({
    maxSize: WORKFLOW_EVIDENCE_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "Workflow evidence request is too large" }, 413),
  }), async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const parsed = await parseBody(c, SubmitWorkflowEvidenceSchema);
    if (!parsed.ok) return parsed.res;
    const session = registry.findSessionByEnv(
      parsed.data.env,
      parsed.data.sessionId,
      parsed.data.cwd,
    );
    if (!session || session.state === "exited") {
      return c.json({ error: "no matching active session" }, 404);
    }
    try {
      return c.json(await manager.stageAgentEvidence(session.id, {
        images: parsed.data.images,
        artifacts: parsed.data.artifacts,
        commandOutputs: parsed.data.commandOutputs,
        coverage: parsed.data.coverage,
      }));
    } catch (error) {
      const known = error instanceof WorkflowImageEvidenceError ? error : null;
      return c.json({
        error: known?.message ?? "Workflow evidence staging failed",
        code: known?.code ?? "workflow_evidence_failed",
      }, (known?.status ?? 409) as 400 | 403 | 404 | 409 | 410);
    }
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

  // --- scout report submission (token-guarded MCP; attribution is server-side) ---
  //
  // The one door a scout's evidence comes through, and the shape of the body is the argument:
  // a report path, a summary, tags, and locators made of a slot this task was issued. No task,
  // session, episode, producer, archive, destination, or absolute path - the daemon derives
  // every one of those from the authenticated session, so a submission can neither archive on
  // another scout's behalf nor choose where the bytes land.
  //
  // Deliberately does NOT write task status. Completion is the task owner's, and a scout that
  // has submitted is a scout that CAN finish, not one that has - see `TaskManager.complete`.
  app.post("/mcp/scouts/submit", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const library = archiveLibrary();
    if (!library) return c.json({ error: "archive library unavailable" }, 503);
    const parsed = await parseBody(c, SubmitScoutArtifactsSchema);
    if (!parsed.ok) return parsed.res;
    const authority = verifyScoutSubmissionCredential(
      c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER),
    );
    if (!authority) {
      return c.json({ error: "this scout submission has no valid session credential" }, 403);
    }
    const result = await library.submit({
      authority,
      submission: {
        reportPath: parsed.data.reportPath,
        summary: parsed.data.summary,
        tags: parsed.data.tags,
        supporting: parsed.data.supporting,
      },
    });
    if (result.ok) {
      return c.json({ ok: true, replayed: result.replayed, archive: result.archive });
    }
    // An attribution refusal carries its own status (no live session, not a scout, already
    // terminal). A capture refusal is always a 409: the request was well formed and the
    // checkout is untouched, so the agent fixes the named paths and calls again.
    const status = "status" in result ? (result.status as 400 | 404 | 409 | 500 | 503) : 409;
    return c.json({ error: result.problems.join("; "), problems: result.problems }, status);
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
    // The fourth Foreman-marked write, and the one the phase plan left as a judgment call
    // on whether its session could be resolved cheaply. It can: a review record names its
    // `sessionId`, so this is two map lookups and no I/O.
    //
    // Refused only on a POSITIVE answer - the session is here and uninvited. A review
    // whose session has been evicted resolves normally: there is no pane left to type
    // into, so this stops being a typing act and becomes the bookkeeping that settles a
    // dangling row, and refusing it would strand the review instead of protecting anyone.
    const owner = registry.getReview(c.req.param("id"))?.sessionId;
    const ownerSession = owner ? registry.getSession(owner) : undefined;
    const refusal = ownerSession
      ? foremanWriteRefusal(composerActivity, ownerSession, parsed.data.by)
      : null;
    if (refusal) {
      return c.json({ error: refusal.error }, refusal.status);
    }
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
  app.post("/api/sessions/:id/composer-activity", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, ComposerActivitySchema);
    if (!parsed.ok) return parsed.res;
    composerActivity.record(session.id, parsed.data.clientId, parsed.data);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/send", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, SendTextSchema);
    if (!parsed.ok) return parsed.res;
    // The twin of /inject's backstop, and the reason `origin` exists on this schema at
    // all: the Foreman worker splits one delivery across the two routes, sending a
    // SUBMITTED answer through /inject and an unsubmitted one - a draft the model asked to
    // leave in the composer - through here. Gating only the submitted half would leave
    // text appearing in an uninvited session's composer, which is the same intrusion
    // arriving one Enter short.
    const refusal = foremanWriteRefusal(composerActivity, session, parsed.data.origin);
    if (refusal) {
      return c.json({ error: refusal.error }, refusal.status);
    }
    if (parsed.data.origin === "human" && parsed.data.submit && pendingTurns) {
      const result = pendingTurns.submit(session.id, parsed.data.text);
      return c.json(result, result.ok ? 200 : 409);
    }
    // An embedded session has no composer to type into, and `submit` has no meaning for it:
    // a turn is one acked call, not a paste followed by an Enter that may or may not land.
    // `canMessage` is what the Send box asks, so this arm is what makes that button honest.
    if (session.runtime === "sdk") {
      const sent = await deliverToDriver(
        sdkSessions,
        session,
        parsed.data.text,
        undefined,
        parsed.data.origin,
      );
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
    // An absent invite stays 403 because it will not change when the pane settles. Active
    // human composition is 409 because retrying after the quiet period is expected.
    // Nothing is typed and no ask is retired in either case.
    const refusal = foremanWriteRefusal(composerActivity, session, parsed.data.by);
    if (refusal) {
      return c.json({ ok: false as const, error: refusal.error }, refusal.status);
    }
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
    const r = await selectPaneOption(session, parsed.data, panes);
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
    // See `/select-option`: refuse before the shape check and before anything is ticked.
    const refusal = foremanWriteRefusal(composerActivity, session, parsed.data.by);
    if (refusal) {
      return c.json({ ok: false as const, error: refusal.error }, refusal.status);
    }
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
    const r = await submitPaneForm(session, options, panes);
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
    // Before any delivery path, and carrying `pasted` for the same reason the 400 above
    // does: a refusal here is positive evidence that nothing reached the pane, which is
    // the one state the worker may cleanly re-queue from rather than escalate.
    const refusal = foremanWriteRefusal(composerActivity, session, parsed.data.origin);
    if (refusal) {
      return c.json({ error: refusal.error, pasted: false }, refusal.status);
    }
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
      parsed.data.origin,
    );
    // Only once it landed: a refused or failed delivery is not a turn anybody will read,
    // and claiming it would mis-attribute a LATER turn that happens to repeat the text.
    if (r.ok && parsed.data.origin !== "human") recordInjection(session.id, parsed.data.text, parsed.data.origin);
    return c.json(r, r.ok ? 200 : 500);
  });

  // Ask a session to run its own retrospective, or create the appropriate follow-up Task.
  //
  // No request body, deliberately: there is exactly one retro and nothing about it is a
  // parameter. What the daemon does is decided by durable pull-request posture first: a merged
  // work review gets one linked, immediately dispatched Task, while a current open review keeps
  // the same-session delivery. With no merged source posture, an unreachable session gets the
  // existing backlog fallback. None is a choice the caller may override. See `runRetro`.
  //
  // 404 is the session, and it means the registry has no row at all: an EXITED session is not a
  // 404 here, it is the fallback's ordinary input, and it is the only place the branch and pull
  // request the retro task must name are still readable.
  app.post("/api/sessions/:id/retro", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const result = await runRetro(session, {
      tasks,
      sdkSessions,
      promptBlocker: (id) => registry.promptResourceBlockerForSession(id),
    });
    // `pasted` rides along on a refusal that attempted a write, exactly as `/inject`'s
    // contract requires: a caller that retries a 503 whose text is already in the composer
    // appends a second retro instruction under the first.
    if (result.kind === "refused") {
      return c.json(
        result.pasted === undefined
          ? { error: result.error }
          : { error: result.error, pasted: result.pasted },
        result.status,
      );
    }
    return c.json(result);
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
    // A retried turn is going out again, so a review paused behind THIS turn resumes - the
    // walkthrough checks that for itself, because this route fires for every retried row in the
    // session and most of them have nothing to do with a review. The THREAD needs no write:
    // `retryPendingTurn` moves the existing row `uncertain` -> `queued` and leaves its id alone,
    // so `delivery_id` still names the row about to be delivered, the thread stays `sending` -
    // it never left the outstanding set - and `delivered_at` stays NULL, which is what makes the
    // SAME message go rather than the next one.
    if (turn) fileCommentWalkthrough?.onTurnRetried(session.id, c.req.param("turnId"));
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
    // "Mark sent" is the human supplying the confirmation the daemon could not observe, so it
    // performs the confirmed-delivery write on the correlated thread. Without it the thread
    // would stay `sending` - outstanding, indexed - and the partial unique index would block
    // every later delivery, leaving the review stuck behind a comment the human just dealt with.
    // Correlated is the operative word, and the walkthrough decides it: this fires for every
    // resolved row in the session, so an ordinary conversation turn marked sent by hand must
    // not stamp a comment or restart a review somebody paused.
    if (resolved) fileCommentWalkthrough?.onTurnMarkedSent(session.id, c.req.param("turnId"));
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

  /**
   * Stop this session's current turn, and everything queued behind it, without ending it.
   *
   * The gap between "wait" and "kill". No request body, because there is nothing to choose:
   * an interrupt has one meaning, and the queue drop is not an option the caller may decline
   * - leaving the outbox armed would restart the work the operator just stopped.
   *
   * 400 rather than 500 when the harness/runtime pair has no mechanism. A refusal here is
   * not a failure of this request but a property of this session that no retry can change,
   * and the card already draws the control disabled with the identical sentence - so a 400
   * is what a client hitting it anyway has actually done.
   *
   * 409 when the pane declined, which on the terminal runtime means it is sitting in a
   * multiplexer mode that would have swallowed the Escape. Same reasoning as
   * `/select-option` and `/submit-options`: the cause is a person reading their own
   * scrollback, so it is a state conflict that clears on its own rather than a server fault,
   * and 500 stays for the faults.
   */
  app.post("/api/sessions/:id/interrupt", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const unsupported = interruptUnsupportedWhy(session.agent, session.runtime);
    if (unsupported) return c.json({ error: unsupported }, 400);
    const r = await interruptSession(session, sdkSessions, pendingTurns, panes);
    return c.json(r, r.ok ? 200 : r.paneBlocked ? 409 : 500);
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
    // Stamped the instant the driver's own call RESOLVES, not after the route gets back to
    // publishing. Codex can start the first turn that carries the new level inside that gap,
    // and a later stamp would make its `turn_context` look older than the acceptance it is
    // evidence for - so the one record able to settle the selection would be refused and the
    // chip would stay pending through a turn already running the new level.
    let acceptedAt: number | null = null;
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
            acceptedAt = Date.now();
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
    // WHEN an accepted level takes effect is a fact about the harness, declared once on
    // `EffortSpec.driverApplies`, not a branch on an agent name. A pane walk always
    // applies now - it types into the harness's own picker - so only a driver can defer.
    //
    // Deferred means the level rides the driver's next turn: the running one keeps the
    // old level and a steered follow-up joins it, so the card goes on reporting what the
    // conversation is ACTUALLY on and the selection is published beside it as pending.
    // The rollout's next `turn_context` is what retires it.
    const deferred =
      session.runtime === "sdk" &&
      harnessFor(session.agent).effort?.driverApplies === "next-turn";
    const published = !r.ok
      ? true
      : deferred
        // Both measurements come from HERE, and neither may be taken inside the registry:
        // `baseline` is the revision this decision was made against, captured before the
        // driver was asked (a poll landing while the call waited its turn would otherwise
        // become the baseline), and `acceptedAt` is when the driver said yes. The fallback
        // covers the arm that never reached a driver at all - `driverEffortTargetResult`
        // short-circuits only when there is nothing left to change, where the record
        // retires the selection and neither measurement is read.
        ? registry.recordPendingSessionEffort(
            session.id,
            r.effort,
            { revision: baseline, at: acceptedAt ?? Date.now() },
            session,
          )
        : registry.recordObservedSessionEffort(session.id, r.effort, session);
    if (!published) {
      return c.json({
        ok: false,
        error: "the live effort changed, but the session identity changed before it could be published",
        effort: null,
      }, 409);
    }
    // Reported from the PROJECTION rather than from `deferred`, so the one deferred case
    // that settles immediately - choosing back the level the conversation is already on -
    // does not announce a pending change nothing is waiting for.
    const pending = deferred && registry.getSession(session.id)?.pendingEffort === r.effort;
    return c.json({ ...r, ...(r.ok ? { pending } : {}) }, r.ok ? 200 : 409);
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

  // --- Foreman invites (whether Foreman may act in a session) ---
  //
  // Both routes are deliberately body-less (POST carries no options - the source is
  // always 'operator' - and DELETE matches every existing DELETE), so neither needs a
  // protocol.ts schema. State changes reach the dashboard as ordinary session_upserts.

  // Invite - restore-then-elevate, not a blind 'operator' write: a no-op when already
  // invited, deletes a 'withdrawn' tombstone so runtime-implied grants resume (a
  // withdrawn SDK session gets "sdk" back rather than a permanent invisible "operator"
  // downgrade), and writes 'operator' only when the state would otherwise stay null.
  app.post("/api/sessions/:id/foreman-invite", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const foremanInvite = registry.inviteForeman(session.id);
    if (foremanInvite === undefined) return c.json({ error: "no such session" }, 404);
    return c.json({ foremanInvite });
  });

  // Withdraw. DELETE still removes the resource (the invite); the 'withdrawn' tombstone
  // it stores is how that removal stays authoritative for sessions that would otherwise
  // re-derive a grant from their runtime, and how it survives a daemon restart.
  app.delete("/api/sessions/:id/foreman-invite", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const foremanInvite = registry.withdrawForemanInvite(session.id);
    if (foremanInvite === undefined) return c.json({ error: "no such session" }, 404);
    return c.json({ foremanInvite });
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

  // Consume one durable prompted work-cycle generation. `ask` atomically raises the
  // matching Ship it? card too; splitting those writes can spend a verified generation
  // and then permanently lose its question on a daemon error. The Registry rechecks the
  // logical key, generation and resolved intent at this daemon-owned write boundary.
  //
  // `decision` records, in that same statement, WHY this generation stopped - the verifier
  // summary and blocking gaps of a hold, or the terminal disposition of any other outcome.
  // Same one-write argument as `ask`: a reason persisted afterwards can be lost by the very
  // failure that makes it matter, leaving a spent generation nobody can explain. It is
  // nullable on the wire for a caller from an older build, and a null CLEARS the stored
  // reason rather than leaving one that describes a generation this write just replaced.
  //
  // `directHandoff` records, in that same statement, that Foreman is about to type the
  // direct shipping instruction. It is a request field rather than a second call because
  // the ordering IS the safety property: the mark must be durable before anything types,
  // and a failed or ambiguous injection afterwards is never retried - the human Ship it?
  // card is the only recovery. Foreman asks for the stamp here; only the daemon writes it.
  app.post("/api/sessions/:id/queue/wrapup/prompted", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, PromptedWrapupSchema);
    if (!parsed.ok) return parsed.res;
    const now = Date.now();
    if (!registry.consumePromptedGeneration(session.id, parsed.data, now)) {
      return c.json({ error: "prompted work-cycle generation is no longer current" }, 409);
    }
    // AFTER the durable consumption, never instead of it, and never before: this reads a
    // verdict the database has already recorded, and a task concluded from a consumption that
    // then failed would be a `done` row explaining itself with a decision nobody kept.
    //
    // Only a recurring mission's task with `auto-on-conclusion` moves here; `TaskManager` owns
    // every one of those gates, and for everything else this is a no-op.
    if (parsed.data.decision) {
      tasks.concludeScheduledMissionRun(session.id, parsed.data.decision);
    }
    return c.json(queues.get(session.id));
  });

  // Correct a recorded direct handoff whose instruction never reached the agent.
  //
  // Mark-before-inject is not negotiable - the mark must be durable before anything types,
  // because a retried direct injection IS the double push - so a failed injection cannot be
  // undone by rolling the mark back. It is undone by telling the truth about it instead:
  // the generation stays consumed, the latch stays latched, and the stored reason stops
  // claiming the agent was handed anything. Foreman calls this one statement after its own
  // injection threw, beside the Ship it? card that is the actual recovery.
  //
  // A 409 here is not worth acting on and the caller ignores it: it means the row already
  // moved on - another generation was consumed, or this correction already landed - and in
  // both cases the stored reason is one nobody should overwrite.
  app.post("/api/sessions/:id/queue/wrapup/prompted/undelivered", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, PromptedHandoffUndeliveredSchema);
    if (!parsed.ok) return parsed.res;
    if (
      !registry.markPromptedHandoffUndelivered(
        session.id,
        parsed.data.logicalKey,
        parsed.data.generation,
      )
    ) {
      return c.json({ error: "no current direct handoff decision for that generation" }, 409);
    }
    return c.json(queues.get(session.id));
  });

  // Claim one exact pre-PR recovery attempt before Foreman types. The worker's earlier
  // snapshot is never authority: re-read every live owner and the checkout diff here, then
  // let the database compare-and-set the exact current recovery sequence.
  app.post("/api/sessions/:id/queue/ship-recovery/claim", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, PromptedRecoveryClaimSchema);
    if (!parsed.ok) return parsed.res;
    const manager = workflowManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const queue = queues.get(session.id);
    const task = registry.getTask(parsed.data.taskId);
    if (
      !queue
      || !task
      || session.task?.id !== task.id
      || task.kind !== "ship"
      || !["running", "dispatching"].includes(task.status)
    ) {
      return c.json({ error: "the managed ship task is no longer current" }, 409);
    }
    const diff = await computeSessionDiff(session.cwd);
    if (!diff.ok) return c.json({ error: "the current checkout diff is unavailable" }, 409);
    const cfg = getForemanConfig();
    const runs = manager.runs().filter(
      (run) => run.noteKey === parsed.data.logicalKey || run.sessionId === session.id,
    );
    const recoveryInput = {
      session,
      queue,
      episodeKey: resolvedSessionIntent(registry.getGoal(session.id))?.episodeKey ?? null,
      humanOwnsSession:
        reportBucket(session, registry.snapshot().sessions) === "needs-you"
        || Boolean(session.note && noteAwaitsYou(session.note.disposition)),
      workflowOwnsSession: activeWorkflowOwnsSession(runs),
      hasTaskOwnedOpenPr: followupPrs(session).length > 0,
      diffHasChanges: diff.filesChanged > 0 || diff.insertions > 0 || diff.deletions > 0,
      featureEnabled: cfg.keepShipTasksMoving,
      mayActLive: foremanMayActLive(cfg, session.cwd, session.repoRoot),
      recoveryMinutes: cfg.shipRecoveryMinutes,
      now: Date.now(),
    };
    const decision = parsed.data.deliveryRoute === "immediate-held"
      ? decideImmediateHeldGapDelivery(recoveryInput)
      : decideShipShepherd(recoveryInput);
    if (
      decision.kind === "skip"
      || decision.reason !== parsed.data.reason
      || decision.attempt !== parsed.data.attempt
      || decision.marker !== parsed.data.marker
      || (parsed.data.episodeKey !== undefined
        && decision.episodeKey !== parsed.data.episodeKey)
      || (decision.decision?.generation ?? null) !== parsed.data.decisionGeneration
      || (decision.decision?.outcome ?? null) !== parsed.data.decisionOutcome
    ) {
      return c.json({ error: "the ship recovery attempt is no longer eligible" }, 409);
    }
    const claimed = registry.claimPromptedRecovery(session.id, parsed.data);
    return claimed
      ? c.json(claimed)
      : c.json({ error: "the ship recovery state changed before it could be claimed" }, 409);
  });

  // A success confirms the audit projection. Only positive evidence that nothing reached
  // the child releases the exact claim; a lost/unknown result sends no request and remains
  // durably spent.
  app.post("/api/sessions/:id/queue/ship-recovery/delivery", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, PromptedRecoveryDeliverySchema);
    if (!parsed.ok) return parsed.res;
    const resolved = registry.resolvePromptedRecoveryDelivery(session.id, parsed.data);
    return resolved
      ? c.json(resolved)
      : c.json({ error: "no matching current ship recovery claim" }, 409);
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
  // The worker owns this circuit. These routes only project its bounded report and carry
  // an operator's retry signal across the daemon/worker process boundary.
  app.get("/api/foreman/planner/control", (c) => c.json(foremanPlannerControl()));
  app.post("/api/foreman/planner/control/claim", async (c) => {
    const parsed = await parseBody(c, ForemanPlannerRetryClaimSchema);
    if (!parsed.ok) return parsed.res;
    return c.json({
      claimed: claimForemanPlannerRetry(
        parsed.data.workerId,
        parsed.data.retryGeneration,
      ),
    });
  });
  app.post("/api/foreman/planner/health", async (c) => {
    const parsed = await parseBody(c, ForemanPlannerHealthReportSchema);
    if (!parsed.ok) return parsed.res;
    if (!recordForemanPlannerHealth(parsed.data)) {
      return c.json({ error: "that worker does not hold the Foreman lease" }, 409);
    }
    return c.body(null, 204);
  });
  app.post("/api/foreman/planner/retry", async (c) => {
    const parsed = await parseBody(c, ForemanPlannerRetrySchema);
    if (!parsed.ok) return parsed.res;
    return c.json(requestForemanPlannerRetry());
  });
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
  /**
   * Close the findings the Inspector is carrying on one pull request.
   *
   * The one mutating verb on this subsystem that is not a config change, and it exists
   * because a finding that has genuinely been addressed could otherwise hold
   * `mergeBlock: findings` forever - see `resolveInspectorFindings` for the mechanism and
   * for what this pointedly does not loosen.
   *
   * Refuses a PR the ledger has never heard of rather than reporting a no-op success: the
   * caller supplied the key, so a miss is a mistyped or stale key, and "resolved 0
   * findings" reads as "there were none" for a pull request nobody is tracking at all.
   *
   * A CLOSED pull request is refused too, and separately, with a 409 rather than a 404: the
   * row exists and the caller is not confused about which pull request they mean, they are
   * asking to rewrite the record of one that has already landed. `resolveInspectorFindings`
   * enforces this as well - that is the real guard, since it also binds callers that never
   * come through here - but it can only answer 0, which is indistinguishable from "there
   * was nothing open". The status code is what makes the panel's error line say something
   * true when a pull request closes between its poll and the operator's click.
   */
  app.post("/api/inspector/resolve-findings", async (c) => {
    const parsed = await parseBody(c, ResolveFindingsSchema);
    if (!parsed.ok) return parsed.res;
    const pr = getInspectorPr(parsed.data.prKey);
    if (!pr) {
      return c.json({ error: "no adopted pull request with that key" }, 404);
    }
    if (pr.state !== "open") {
      return c.json(
        { error: "that pull request has closed - its findings are the record of what was said about it" },
        409,
      );
    }
    const resolved = resolveInspectorFindings(parsed.data.prKey, Date.now());
    // Clear the recorded block ONLY when it was the one this call just answered.
    //
    // `findings` is derived from the ledger we changed, so it is stale the moment this
    // returns - and `recordBlock` only rewrites the reason when the answer CHANGES, so
    // leaving it would keep publishing "the Inspector has open findings" about a pull
    // request that no longer has any. Null is the honest reading until the next sweep, and
    // it is what an adopted-but-unevaluated row already carries.
    //
    // Any OTHER reason has to survive untouched, which is the part that is easy to miss:
    // `mergeVerdict` reports only the FIRST failing gate, and several of them are checked
    // ahead of `findings`. A pull request that has been pushed to since its last review
    // reads `not-reviewed` while still carrying the previous head's open findings, so
    // resolving them there is a real edit to the ledger that does not make `not-reviewed`
    // any less true. Blanking it would replace an accurate reason with "nothing known" for
    // the ~90s until the next sweep re-derives it - self-healing, and still the panel
    // confidently reporting no known block on a pull request that is waiting for a review.
    if (resolved > 0 && pr.mergeBlock === "findings") {
      updateInspectorPr(parsed.data.prKey, { mergeBlock: null }, Date.now());
    }
    // The panels poll, but the per-session chip rides SSE off this same ledger, so the
    // count on the card would otherwise stay wrong until the Inspector's own 90s sweep.
    registry.refreshInspections();
    return c.json({ resolved } satisfies ResolveFindingsResult);
  });
  // What the Inspector will actually spawn with, resolved HERE rather than in the panel
  // for the reason `ForemanStatus.models` documents: the env layer is invisible to the
  // browser, so a panel showing `config || default` would confidently print a model a
  // `MISSION_INSPECTOR_MODEL` in the daemon's environment is overriding.
  app.get("/api/inspector/status", (c) =>
    c.json({ model: inspectorModel(), runner: inspectorRunner() } satisfies InspectorStatus),
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
  app.get("/api/harnesses/models", async (c) => {
    if (!modelCatalogs) return c.json({ error: "Harness model catalog service unavailable" }, 503);
    const query = HarnessModelCatalogQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: query.error.message }, 400);
    const result = await modelCatalogs.getCatalogs({ refresh: query.data.refresh === "1" });
    const parsed = HarnessModelCatalogsSchema.safeParse(result);
    if (!parsed.success) return c.json({ error: "Harness model catalog response was invalid" }, 500);
    return c.json(parsed.data);
  });
  app.put("/api/harnesses/config", async (c) => {
    const parsed = await parseBody(c, HarnessesConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    let next;
    try {
      next = setHarnessesConfig(parsed.data);
    } catch (error) {
      // A pair only the merge can judge - a model landing on a row that inherits its agent.
      // A refusal the panel can print, not a 500.
      if (error instanceof HarnessesConfigError) return c.json({ error: error.message }, 400);
      throw error;
    }
    // Announced like every sibling settings route publishes its own change. Without this the
    // settings panel learned of another tab's edit only on its next poll, and an already-open
    // dispatch modal - which reads these defaults once, when it opens - never learned at all
    // and went on naming a model that was no longer the default.
    registry.emitHarnessesConfigChanged();
    return c.json(next);
  });

  // --- Task sources: pulling work INTO the backlog from systems that already hold it ---
  //
  // Every route HERE files into the backlog and nothing else - these are the inbound half,
  // and they are periodic and unattended.
  //
  // The feature has exactly one outward write, and it is deliberately not among them:
  // `POST /api/tasks/:id/push`, with the task routes below, files one of OUR tasks as an
  // item upstream. It sits there rather than here because it acts on a TASK, and it fires
  // only on an explicit per-task operator action - never from the sweep loop, because it
  // publishes to a place other people are watching and deleting a row here does not take
  // it back.
  //
  // In neither direction does anything dispatch, provision, or type into a pane - see
  // `src/shared/task-source.ts`.

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

  // --- Pipelines: observing an external SDLC engine (localhost only) ---
  //
  // Detection, registration, observation consent, and guided installation remain separate
  // facts. Provider-owned commands are composed behind typed routes; the browser never sends
  // argv, and the watcher remains a reader of provider-owned files.
  //
  // The probe is the one subprocess in this neighbourhood, and it is cached behind a TTL
  // because the panel polls - `refresh=1` is the panel's own "Check again", which is an
  // operator asking on purpose.

  /** The whole panel in one read: what is consented to, what was detected, how it is doing. */
  const pipelinesView = async (force: boolean): Promise<PipelinesView> => ({
    config: getPipelinesConfig(),
    probes: await probeAllPipelineProviders({ force }),
    status: pipelineRepoStatuses(),
  });

  app.get("/api/pipelines/config", async (c) =>
    c.json(await pipelinesView(c.req.query("refresh") === "1")),
  );

  /**
   * Register a canonical repository through its provider. This changes provider state only;
   * observation consent remains the separate whole-config PUT below.
   */
  app.post("/api/pipelines/register", async (c) => {
    const parsed = await parseBody(c, PipelineRepoRegistrationSchema);
    if (!parsed.ok) return parsed.res;
    const repoRoot = await resolveRepoRoot(parsed.data.repoRoot);
    if (!repoRoot) return c.json({ error: `not a git repository: ${parsed.data.repoRoot}` }, 400);

    const registration = await registerPipelineRepo(parsed.data.provider, repoRoot);
    return c.json({
      registration,
      view: await pipelinesView(registration.ok),
    });
  });

  /** Verified local source checkouts eligible for this provider's interactive installer. */
  app.get("/api/pipelines/installers", async (c) => {
    const provider = c.req.query("provider") ?? "";
    if (!isPipelineProviderId(provider)) {
      return c.json({ error: "no such pipeline provider" }, 400);
    }
    return c.json(await pipelineInstallerCandidates(provider, await listRepos()));
  });

  /**
   * Open the provider's upstream installer in a visible selected terminal.
   *
   * Workspace-catalog membership and every trust marker are checked in this request. Only provider,
   * checkout, and backend came from the browser; the provider owns argv/cwd/title and the
   * daemon owns the trusted hold-open shell wrapper.
   */
  app.post("/api/pipelines/install", async (c) => {
    const parsed = await parseBody(c, PipelineInstallerLaunchSchema);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    const launch = await pipelineInstallerLaunch(body.provider, body.checkout, await listRepos());
    if (!launch.ok) {
      const answer: PipelineInstallerLaunchResult = {
        ok: false,
        provider: body.provider,
        checkout: body.checkout,
        outcome: "refused",
        label: "",
        detail: launch.error,
      };
      return c.json(answer, 409);
    }

    const installerArgv = [
      FIXED_OS_EXECUTABLES.env,
      ...Object.entries(launch.terminalEnv).map(([name, value]) => `${name}=${value}`),
      ...launch.argv,
    ];
    const hold =
      `${shellCommand(installerArgv)}\n` +
      `status=$?\n` +
      `printf '\\n[installer exited %s] press enter to close ' "$status"\n` +
      `read -r _\n`;
    const result = await terminalLauncher(body.backend, {
      name: launch.title,
      cwd: launch.cwd,
      argv: [process.env.SHELL || FIXED_OS_EXECUTABLES.sh, "-c", hold],
    });
    const answer: PipelineInstallerLaunchResult = {
      ok: result.ok,
      provider: body.provider,
      checkout: launch.candidate.checkout,
      outcome: result.ok ? "opened" : result.status === 504 ? "maybe-opening" : "refused",
      label: result.label,
      detail: result.ok
        ? "Installer terminal opened. Setup is not complete until Mission Control detects conduct-ts; finish the interactive installer there, then check again."
        : (result.error ?? `${result.label} could not open the installer terminal.`),
    };
    return result.ok ? c.json(answer) : c.json(answer, result.status as 404 | 409 | 502 | 504);
  });

  /**
   * The repositories being READ, for the Pipelines rail's group headings.
   *
   * Separate from the route above rather than a field on it, and the difference is what it
   * does NOT do: no probe, no subprocess, no consent config. The Runs page polls this while
   * its Pipelines tab is open, and answering it out of `/api/pipelines/config` would put an
   * engine spawn behind a rail that only needs to know whether a daemon is alive - on a
   * cadence, for as long as the tab is on screen.
   */
  app.get("/api/pipelines/repos", (c) => {
    const config = getPipelinesConfig();
    return c.json({
      repos: activePipelineRepoStatuses(config),
      launchRuntime: config.launchRuntime,
    });
  });

  /**
   * One run's gate evidence, read from the engine's files at request time.
   *
   * On demand rather than on the projection because the projection rides every reconnect
   * for every run on the fleet, and `test/pipeline-sse.test.ts` pins that budget with this
   * route named as the answer. The three parts of the run's identity are query parameters
   * because one of them is an absolute path: `repoRoot` cannot be a path segment without
   * being double-encoded at every call site.
   *
   * 404 for anything that names nothing - an unknown provider, a repository nobody
   * consented to, a slug with no worktree - because a surface draws all three as the same
   * stale link, and telling them apart would answer questions about the filesystem to
   * anything that can reach the loopback API.
   */
  app.get("/api/pipelines/run", async (c) => {
    const provider = c.req.query("provider") ?? "";
    const repoRoot = c.req.query("repoRoot") ?? "";
    const slug = c.req.query("slug") ?? "";
    if (!isPipelineProviderId(provider) || !repoRoot || !slug) {
      return c.json({ error: "no such pipeline run" }, 404);
    }
    const detail = await readPipelineRunDetail(provider, repoRoot, slug);
    return detail ? c.json(detail) : c.json({ error: "no such pipeline run" }, 404);
  });

  /**
   * Replace the consent config.
   *
   * Each repository is resolved to a git root here so a typo cannot enter it, using the
   * general resolver for the same reason the task-source route does: an operator may
   * legitimately consent to a checkout that cannot be attributed to a main checkout.
   *
   * The reconciliation after the write is not an optimization. Withdrawing consent has to
   * be felt at once - the rows go, the live catalog entries go, and a `pipeline_remove`
   * reaches every open dashboard - rather than up to one watch tick later, because an
   * operator who switches a repository off and keeps looking at the page is entitled to
   * see it happen.
   */
  app.put("/api/pipelines/config", async (c) => {
    const parsed = await parseBody(c, PipelinesConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    const repos = [];
    // Resolution is what makes duplicates possible, so the duplicate check has to happen
    // after it. The schema rejects two entries naming the same path, but a symlink and its
    // target - or a repository root and a subdirectory of it - are two different paths that
    // land on one root. Left to `setPipelinesConfig`, that throws out of an unguarded
    // handler and the operator loses the edit behind a generic error instead of being told
    // which repository they listed twice.
    const seen = new Set<string>();
    for (const repo of parsed.data.repos) {
      const repoRoot = await resolveRepoRoot(repo.repoRoot);
      if (!repoRoot) return c.json({ error: `not a git repository: ${repo.repoRoot}` }, 400);
      const key = pipelineRepoKey(repo.provider, repoRoot);
      if (seen.has(key))
        return c.json({ error: `listed twice, as the same repository: ${repoRoot}` }, 400);
      seen.add(key);
      repos.push({ ...repo, repoRoot });
    }
    setPipelinesConfig({
      enabled: parsed.data.enabled,
      launchRuntime: parsed.data.launchRuntime,
      foremanMechanicalTriage: parsed.data.foremanMechanicalTriage,
      repos,
    });
    reconcilePipelineConsent(registry);
    // The tuple carries how many repositories are being observed, and the Runs page draws
    // its Pipelines tab from that. Published here rather than waited for on the watcher's
    // once-a-minute presence check, for the same reason the reconciliation above is not
    // deferred to the next tick: an operator who switches a repository on is entitled to
    // see the surface it produces without wondering whether they mis-clicked.
    publishSettingsStatus(registry);
    return c.json(await pipelinesView(false));
  });

  /** Both independent operator grants required for Foreman to touch an external pipeline. */
  const pipelineForemanEnabled = (): boolean => {
    const pipeline = getPipelinesConfig();
    return getForemanConfig().enabled && pipeline.enabled && pipeline.foremanMechanicalTriage;
  };

  const pipelineForemanDisabled = (c: Context) =>
    c.json({ error: "Foreman pipeline triage is disabled" }, 403);

  /**
   * Ask the engine to do one thing: start, stop, pause, resume, park, unpark, grant.
   *
   * ONE route over a validated verb rather than one route per verb, which is a deviation
   * from this phase's own sketch and the better shape for the same reason every registry in
   * this daemon exists: the verbs are a shared tuple with an exhaustive `Record` behind them,
   * so seven handlers would be seven copies of this body differing only in a string - and the
   * eighth verb would be added to six of them. Phase 6's Foreman triage calls this one route
   * with a different verb, which is precisely the surface it was promised.
   *
   * ALWAYS 200 when the engine was reached, with `ok` inside. A refusal by conductor is the
   * ANSWER to "please pause this", not a failure of the request, and the surface has to draw
   * the engine's own words either way - the shape `POST /api/ensembles/preview` uses. The two
   * cases that do get a status are the ones with no engine answer to carry: a body that does
   * not parse, and a repository or run this daemon is not projecting.
   *
   * Consent is enforced inside `runPipelineAction`, not here, because the repository path
   * arrives in the body: without it this route would spawn an engine CLI with a working
   * directory of anywhere on the machine, for anything that can reach the loopback API.
   */
  app.post("/api/pipelines/action", async (c) => {
    const parsed = await parseBody(c, PipelineActionSchema);
    if (!parsed.ok) return parsed.res;
    const { provider, repoRoot, slug, action, step, reason, requestedBy } = parsed.data;
    if (requestedBy === "foreman") {
      if (!pipelineForemanEnabled()) return pipelineForemanDisabled(c);
      const run = registry
        .listPipelineRuns()
        .find(
          (candidate) =>
            candidate.provider === provider &&
            candidate.repoRoot === repoRoot &&
            candidate.slug === slug,
        );
      if (action !== "unpark" || run?.halt?.class !== "mechanical") {
        return c.json({ error: "Foreman may only unpark a current mechanical pipeline halt" }, 403);
      }
      if (!foremanEpisodeExists(pipelineEpisodeKey(run), pipelineHaltMarker(run))) {
        return c.json({ error: "Foreman must reserve the pipeline halt before acting" }, 409);
      }
    }
    const outcome = await runPipelineAction(registry, action, {
      provider,
      repoRoot,
      slug,
      step,
      reason,
    });
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
    return c.json(outcome.result satisfies PipelineActionResult);
  });

  /** Halt observations for the standalone Foreman worker, with no probe or subprocess. */
  app.get("/api/pipelines/foreman", (c) => {
    const enabled = pipelineForemanEnabled();
    const items = enabled
      ? registry
          .listPipelineRuns()
          .filter((run) => run.halt !== null)
          .map((run) => {
            const marker = pipelineHaltMarker(run);
            return {
              run,
              marker,
              handled: foremanEpisodeExists(pipelineEpisodeKey(run), marker),
            };
          })
      : [];
    return c.json({ enabled, items } satisfies PipelineForemanView);
  });

  /**
   * Persist a pipeline triage episode for Foreman, through the daemon's only-writer boundary.
   * A reservation re-derives its marker from the current projection so a worker cannot stamp
   * a stale observation and then act on a newer halt under its identity. A later outcome is
   * different: Unpark can refresh the projection and clear that halt before the worker writes
   * its result, so the existing durable reservation is the authority for finalizing it.
   */
  app.post("/api/pipelines/foreman-episode", async (c) => {
    const parsed = await parseBody(c, PipelineForemanEpisodeSchema);
    if (!parsed.ok) return parsed.res;
    if (!pipelineForemanEnabled()) return pipelineForemanDisabled(c);
    const { provider, repoRoot, slug, episode } = parsed.data;
    const run = registry
      .listPipelineRuns()
      .find(
        (candidate) =>
          candidate.provider === provider &&
          candidate.repoRoot === repoRoot &&
          candidate.slug === slug,
      );
    if (!run) return c.json({ error: "no such pipeline run" }, 404);
    const noteKey = pipelineEpisodeKey(run);
    if (episode.disposition !== "pending") {
      if (episode.classification !== "mechanical") {
        return c.json({ error: "Foreman may only finalize mechanical pipeline triage" }, 403);
      }
      if (!foremanEpisodeExists(noteKey, episode.marker)) {
        return c.json({ error: "Foreman must reserve the pipeline halt before finalizing it" }, 409);
      }
      recordForemanEpisode(pipelineEpisodeWrite(run, episode));
      return c.json({ ok: true });
    }
    if (!run.halt) return c.json({ error: "no such halted pipeline run" }, 404);
    if (run.halt.class !== "mechanical" || episode.classification !== "mechanical") {
      return c.json({ error: "Foreman may only reserve a mechanical pipeline halt" }, 403);
    }
    if (episode.marker !== pipelineHaltMarker(run)) {
      return c.json({ error: "the pipeline halt changed before Foreman could act" }, 409);
    }
    recordForemanEpisode(pipelineEpisodeWrite(run, episode));
    return c.json({ ok: true });
  });

  /**
   * Open a hosted terminal on the engine: its daemon console, or the reseal ceremony.
   *
   * A terminal rather than a verb because neither of these has an answer to parse. The
   * console ATTACHES for as long as somebody watches it, and reseal refuses to run at all
   * without a TTY - a guard conductor added so a build agent cannot re-seal the artifact it
   * was told not to touch, since its providers all feed their children through stdin.
   *
   * The daemon composes the argv from the verb and a validated body; nothing the browser
   * sends becomes a command line. That is the same rule `POST /api/sessions/:id/launch`
   * holds, and it is why this takes a console name and a path list rather than a command.
   *
   * The status echoes the launcher's, including its 504 - the backend that did not report
   * back. That one is not a refusal: the window may well have opened, so what travels is the
   * launcher's own "may still be opening" sentence, which the surface shows verbatim rather
   * than restating as a failure of its own.
   */
  app.post("/api/pipelines/console", async (c) => {
    const parsed = await parseBody(c, PipelineConsoleSchema);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    const launch = pipelineConsoleLaunch(body.console, {
      provider: body.provider,
      repoRoot: body.repoRoot,
      slug: body.slug,
      step: null,
      reason: body.reason,
      paths: body.paths,
      clearHalt: body.clearHalt,
    });
    if (!launch.ok) return c.json({ error: launch.error }, launch.status);
    // Held open after the command exits, and this is the difference between a console an
    // operator can use and one that vanishes. Neither verb prompts: `reseal` prints one line
    // and returns, and a `daemon connect` that cannot find a session prints why and exits 1.
    // On every backend here the window closes with the process, so the outcome of both -
    // including the refusal an operator most needs to read - would flash past unread.
    const hold =
      `${shellCommand(launch.argv)}\n` +
      `status=$?\n` +
      `printf '\\n[%s exited %s] press enter to close ' ${shellCommand([body.console])} "$status"\n` +
      `read -r _\n`;
    const result = await terminalLauncher(body.backend, {
      name: pipelineConsoleName(body.provider, body.console, body.slug),
      cwd: launch.cwd,
      argv: [process.env.SHELL || FIXED_OS_EXECUTABLES.sh, "-c", hold],
    });
    const answer: PipelineConsoleResult = {
      ok: result.ok,
      console: body.console,
      label: result.label,
      ...(result.error ? { error: result.error } : {}),
    };
    return result.ok ? c.json(answer) : c.json(answer, result.status as 404 | 409 | 502 | 504);
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

  // --- Environment checks: what the MACHINE says about the tooling a dispatch inherits ---
  //
  // Always 200, carrying its own result - the shape `POST /api/ensembles/preview` uses: "your
  // machine has a problem" is the ANSWER to this question, not a failure of the request, and a
  // non-2xx here would make the dispatch form's optional fetch drop a finding it asked for.
  //
  // Computed per request rather than at boot; see `environmentCheckViews` for why an operator
  // who fixes what a warning names must not have to restart the daemon to stop seeing it.
  app.get("/api/environment/checks", async (c) =>
    c.json({ checks: await environmentCheckViews() } satisfies EnvironmentChecksView));

  // Uncached. Re-checking reflects installs and sign-ins without restarting, while every
  // remedy remains inert data for the browser to link or copy. The one write during this read
  // only retires acknowledgements for rows the fresh result proved repaired or removed.
  app.get("/api/setup/checks", async (c) =>
    c.json(setupSnapshots.issue(await setupChecksView(setupDeps ?? defaultSetupDeps()))));
  // The same resource path as the read, so dismissal adds no second setup read or endpoint.
  // The browser sends the required broken row ids from the snapshot it is dismissing; argv,
  // probes, and any install behavior remain completely outside this write.
  app.put("/api/setup/checks", async (c) => {
    const parsed = await parseBody(c, SetupBannerDismissRequestSchema);
    if (!parsed.ok) return parsed.res;
    if (!setupSnapshots.consume(parsed.data.snapshotToken, parsed.data.acknowledged)) {
      return c.json({ error: "Setup checks changed. Re-check before dismissing." }, 409);
    }
    const deps = setupDeps ?? defaultSetupDeps();
    deps.writeBannerDismissal(acknowledgeSetupRows(
      deps.readBannerDismissal(),
      parsed.data.acknowledged,
    ));
    return c.json({ ok: true });
  });

  /**
   * Open one catalog-owned remedy in a visible terminal. The request carries identity and a
   * terminal selection only; argv, cwd, environment, title, and shell text stay daemon-owned.
   */
  app.post("/api/setup/install", async (c) => {
    const parsed = await parseBody(c, SetupInstallerLaunchSchema);
    if (!parsed.ok) return parsed.res;
    const result = await executeSetupInstall(parsed.data, {
      catalog: setupInstallDeps?.catalog ?? DEFAULT_SETUP_INSTALL_CATALOG,
      homeDir: setupInstallDeps?.homeDir ?? homedir(),
      listRepoRoots: setupInstallDeps?.listRepoRoots ?? listRepos,
      listProviderInstallers:
        setupInstallDeps?.listProviderInstallers ?? pipelineInstallerCandidates,
      prepareProviderInstaller:
        setupInstallDeps?.prepareProviderInstaller ?? pipelineInstallerLaunch,
      launchTerminal: terminalLauncher,
    });
    return c.json(result.body, result.status as ContentfulStatusCode);
  });

  // --- dispatch: launch/queue agents (localhost only) ---
  app.post("/api/tasks", async (c) => {
    const parsed = await parseBody(c, DispatchSchema);
    if (!parsed.ok) return parsed.res;
    const workflowId = resolveTaskWorkflowId(parsed.data.workflowId);
    const prepared = await prepareTaskRepositories({
      primary: parsed.data.repoRoot,
      extras: parsed.data.extraRepoRoots,
      kind: parsed.data.kind,
      agent: parsed.data.agent,
      shortNameSelectors: "none",
    });
    if (!prepared.ok) return c.json({ error: prepared.error }, prepared.status);
    const { repoRoot, extraRepoRoots, agent } = prepared;
    // Resolved HERE rather than left to `TaskManager.create`, because the checks below
    // - the multi-repo capability, the Workflow dispatch block, and the plan-skill block -
    // are all questions about the harness this task will actually get, and an omitted agent
    // is exactly the case where that is the kind's answer rather than Claude. Passed on
    // explicitly, so the route and the task agree by construction rather than by both
    // running the same resolution and hoping the config did not move between them.
    if (workflowId) {
      const manager = workflowManager();
      if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
      const blocked = parsed.data.backlog
        ? manager.workflowSelectionBlock(workflowId)
        : manager.dispatchWorkflowBlock(workflowId, agent, repoRoot);
      if (blocked) return c.json({ error: blocked }, 409);
    }
    // A plan task's intent invokes the planning skills instead of restating them, so a
    // dispatch that could not invoke them is refused before the task exists - the operator
    // reads the reason on the form they are still standing in, and there is no card to clean
    // up. Only when it would DISPATCH: backlogging is not dispatching, the toggle can be
    // flipped before the task launches, and `TaskManager.dispatch` asks again at that moment.
    if (!parsed.data.backlog) {
      const planBlock = planDispatchBlock({ ...parsed.data, agent });
      if (planBlock) return c.json({ error: planBlock }, 409);
    }
    let task;
    try {
      task = tasks.create(
        { ...parsed.data, agent, repoRoot, extraRepoRoots, workflowId },
        undefined,
        MANUAL_DISPATCH_TASK_CREATE,
      );
    } catch (error) {
      if (error instanceof TaskDependencyError) return c.json({ error: error.message }, 409);
      // The pair only `TaskManager.create` can judge: an effort chosen with no agent named,
      // against the harness the kind turned out to resolve to. A refusal, not a 500.
      if (error instanceof TaskEffortUnsupportedError) return c.json({ error: error.message }, 400);
      throw error;
    }
    return c.json(task);
  });

  // The tour route family. Not a second dispatch API: the body chooses only a repository,
  // while `SERVER_TOURS` fixes the prompt, agent, model, kind, Workflow posture, and MCP tool
  // list of every task a tour may create. An unknown tour, or an operation a tour does not
  // declare, is refused here rather than falling through to general dispatch.
  async function runTourRecipe(c: Context, operation: TourOperation) {
    const tour = serverTour(c.req.param("tourId"));
    if (!tour) return c.json({ ok: false, error: "no such tour" }, 404);
    const recipe = tour.operations[operation];
    if (!recipe) {
      return c.json({ ok: false, error: `that tour does not support ${operation}` }, 404);
    }
    const parsed = await parseBody(c, TourDispatchSchema);
    if (!parsed.ok) return parsed.res;
    const resolved = await resolveTaskRepoRoot(parsed.data.repoRoot);
    if (!resolved.ok) return c.json({ error: resolved.error }, 400);

    const task = tasks.create(
      { ...recipe.create, repoRoot: resolved.repoRoot, extraRepoRoots: [] },
      undefined,
      MANUAL_DISPATCH_TASK_CREATE,
    );
    if (!recipe.dispatch) return c.json({ ok: true, task });
    const launched = await tasks.dispatch(task.id, {
      overrideDisabled: recipe.dispatch.overrideDisabled,
      missionMcp: recipe.dispatch.missionMcp,
    });
    if (!launched.ok) {
      await tasks.complete(task.id, recipe.outcome);
      return c.json({ ok: false, error: launched.error, task: tasks.get(task.id) ?? task }, 409);
    }
    return c.json({ ok: true, task: launched.task ?? task });
  }

  app.post("/api/tours/:tourId/dispatch", (c) => runTourRecipe(c, "dispatch"));

  // An empty fleet has no real desk for See the work's third stop to reveal. Its preview
  // recipe creates one fixed Chat task through the manual-dispatch capability, which is the
  // only supported way Chat can launch.
  app.post("/api/tours/:tourId/preview", (c) => runTourRecipe(c, "preview"));

  // A tour's single terminal path for every task it created. A live demo follows
  // CompleteModal's ordering: record the outcome, then stop the session. An Exit during
  // provisioning has no session to stop, so cancellation first closes that race.
  app.post("/api/tours/:tourId/tasks/:id/complete", async (c) => {
    const tour = serverTour(c.req.param("tourId"));
    if (!tour) return c.json({ ok: false, error: "no such tour" }, 404);
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ ok: false, error: "no such task" }, 404);
    // The identity check is what keeps this route off a task the tour did not create. It
    // reads the title, labels, and intent prefix the recipe itself wrote, never the caller.
    const recipe = tourRecipeFor(tour, task);
    if (!recipe) {
      return c.json({ ok: false, error: "that task does not belong to the tour" }, 409);
    }

    let session = task.sessionId ? registry.getSession(task.sessionId) : null;
    // A cancel that could not reclaim every resource still CANCELLED the task; its `ok: false`
    // reports leftover trees, not a refusal. Returning on it abandoned the completion this
    // route exists to perform, leaving the tour's own task closed as `cancelled` with a null
    // outcome - and worktree teardown contends with the pool, so that is an ordinary outcome
    // on a loaded machine rather than an exceptional one. The warning is carried to the
    // response instead, where the caller can see it without losing the outcome.
    let resourceWarning: string | null = null;
    if (!session && task.status !== "done") {
      const cancelled = await tasks.cancel(id);
      if (!cancelled.ok) {
        resourceWarning = cancelled.error ?? "the task's resources remain tracked";
      }
    }
    const completed = await tasks.complete(id, recipe.outcome);
    if (!completed) return c.json({ ok: false, error: "no such task" }, 404);
    session ??= completed.sessionId ? registry.getSession(completed.sessionId) : null;
    if (session) {
      // A finished SDK handle can disappear just before this request reaches the supervisor,
      // while its registry projection is still inside the normal exit linger. Confirm that
      // absence through the supervisor, then feed the ordinary driver exit event back through
      // Registry so session_remove still comes from its one supported eviction path.
      if (session.runtime === "sdk" && sdkSessions?.handleFor(session.id) === null) {
        registry.applyDriverEvent(session.id, {
          kind: "exited",
          reason: "tour cleanup found no live embedded driver",
          resumable: false,
        });
      } else {
        const stopped = await requestSessionStop(session, sdkSessions);
        if (!stopped.ok) {
          return c.json(
            { ok: false, error: `task marked done, but the session could not be closed: ${stopped.error ?? "failed"}`, task: completed },
            500,
          );
        }
      }
    }
    return c.json({ ok: true, task: completed, ...(resourceWarning ? { warning: resourceWarning } : {}) });
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
    // The secondaries are resolved whenever the patch NAMES them, against whichever root
    // the task ends up with. Unlike the primary above there is no "did it move" shortcut:
    // this key is only ever present because the operator edited the repo set, so there is
    // no untouched value to protect from a re-check.
    if (patch.extraRepoRoots !== undefined) {
      const primary = patch.repoRoot ?? existing?.repoRoot;
      if (!primary) return c.json({ error: "no such task" }, 404);
      const resolved = await resolveTaskExtraRepoRoots(primary, patch.extraRepoRoots);
      if (!resolved.ok) return c.json({ error: resolved.error }, 400);
      patch.extraRepoRoots = resolved.repoRoots;
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

  /**
   * File this backlog task as an item in the external tracker a configured source points
   * at - the one outward write in the task-sources feature.
   *
   * The task STAYS in the backlog. Nothing is dispatched, nothing is provisioned, and the
   * only change to the row is that it now carries the ref of the item that was created for
   * it, which is what the modal renders as a link.
   *
   * The status codes are the contract, and the 502/504 split is the load-bearing part of
   * it - the same reading `POST /api/sessions/:id/open-file` takes, for the same reason:
   *
   *   400 the request could never work (bad body; a kind with no outward verb)
   *   404 no such task, or no such task source
   *   409 a state conflict the operator can see and resolve - not backlog, already linked,
   *       a source bound to a different repo, a push already running, or a task that moved
   *       while `gh` was running (that last one CREATED the item and says so)
   *   502 the tracker refused. Nothing was published, so retrying is safe.
   *   504 the outcome is unknown. The item MAY exist, so retrying may file a duplicate -
   *       the body carries `outcomeUnknown: true` so a caller can drop its retry
   *       affordance rather than having to parse the sentence.
   *
   * A 200 returns the updated `Task`, like its dispatch/assign/complete siblings, so the
   * caller reads the new `source` off the reply instead of racing the `task_upsert` event.
   */
  app.post("/api/tasks/:id/push", async (c) => {
    const parsed = await parseBody(c, PushTaskSchema);
    if (!parsed.ok) return parsed.res;
    const task = tasks.get(c.req.param("id"));
    if (!task) return c.json({ error: "no such task" }, 404);
    const inst = taskSourceById(parsed.data.sourceId);
    if (!inst) return c.json({ error: "no such task source" }, 404);
    const r = await pushTask(inst, task, tasks);
    if (r.ok) return c.json(r.task);
    switch (r.kind) {
      case "unpushable":
        return c.json({ error: r.error }, 400);
      case "conflict":
        return c.json({ error: r.error }, 409);
      case "upstream":
        return c.json({ error: r.error }, 502);
      // Flagged as well as worded. The sentence is what a human reads; the flag is what a
      // client branches on, and this is the one failure a client must not offer to retry.
      case "unknown-outcome":
        return c.json({ error: r.error, outcomeUnknown: true }, 504);
    }
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

  app.post("/api/tasks/:id/pipeline/readiness", async (c) => {
    const r = await tasks.recheckPipelineReadiness(c.req.param("id"));
    if (!r.ok) {
      return c.json({ error: r.error }, r.error === "no such task" ? 404 : 409);
    }
    return c.json(r.task!);
  });

  app.post("/api/tasks/:id/pipeline/start", async (c) => {
    const r = await tasks.startPipelineAfterReadiness(c.req.param("id"));
    if (!r.ok) {
      return c.json({ error: r.error }, r.error === "no such task" ? 404 : 409);
    }
    return c.json(r.task!);
  });

  const pipelineRecoveryResponse = (
    c: Context,
    result: Awaited<ReturnType<TaskManager["retryPipelineAttempt"]>>,
  ) => {
    if (result.ok) return c.json(result.task);
    const status = result.error === "no such task"
      ? 404
      : result.code === "provider_outcome_unknown"
        ? 504
        : result.code === "provider_failure"
          ? 502
        : result.code === "host_launch_failure"
          ? 500
          : result.code === "readiness_blocked" || result.code === "unsupported_provider"
            ? 422
            : 409;
    return c.json(
      { error: result.error, code: result.code, ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}) },
      status,
    );
  };

  app.post("/api/tasks/:id/pipeline/retry", async (c) => {
    const parsed = await parseBody(c, PipelineRetrySchema);
    if (!parsed.ok) return parsed.res;
    return pipelineRecoveryResponse(c, await tasks.retryPipelineAttempt(c.req.param("id"), parsed.data));
  });

  app.post("/api/tasks/:id/pipeline/successor/refresh", async (c) => {
    const parsed = await parseBody(c, PipelineRetrySchema);
    if (!parsed.ok) return parsed.res;
    return pipelineRecoveryResponse(c, await tasks.refreshPipelineSuccessor(c.req.param("id"), parsed.data));
  });

  app.post("/api/tasks/:id/pipeline/successor/adopt", async (c) => {
    const parsed = await parseBody(c, PipelineAdoptSuccessorSchema);
    if (!parsed.ok) return parsed.res;
    return pipelineRecoveryResponse(c, await tasks.adoptPipelineSuccessor(c.req.param("id"), parsed.data));
  });

  app.post("/api/tasks/:id/pipeline/abandon", async (c) => {
    const parsed = await parseBody(c, PipelineSettlementSchema);
    if (!parsed.ok) return parsed.res;
    return pipelineRecoveryResponse(
      c,
      await tasks.settlePipelineCommission(c.req.param("id"), parsed.data, "abandon"),
    );
  });

  app.post("/api/tasks/:id/pipeline/cancel", async (c) => {
    const parsed = await parseBody(c, PipelineSettlementSchema);
    if (!parsed.ok) return parsed.res;
    return pipelineRecoveryResponse(
      c,
      await tasks.settlePipelineCommission(c.req.param("id"), parsed.data, "cancel"),
    );
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

  /**
   * Move one backlog task in the operator's order - the one route that writes a rank.
   *
   * The body names an ANCHOR rather than an index, for the reason `ReorderTaskSchema` gives:
   * an index is a claim about a list the caller last saw, and the daemon's has moved on.
   *
   *   404 no such task, or no such anchor
   *   409 the task is not in the backlog, the anchor is not in the backlog, or the anchor is
   *       the task itself - every one of them a state conflict the operator can see
   *   200 the updated `Task`
   *
   * A 200 returns the moved task, like its dispatch/assign/complete siblings, so the caller
   * reads the new rank off the reply instead of racing its own `task_upsert`.
   */
  app.post("/api/tasks/:id/reorder", async (c) => {
    const parsed = await parseBody(c, ReorderTaskSchema);
    if (!parsed.ok) return parsed.res;
    const r = tasks.reorder(c.req.param("id"), parsed.data);
    if (!r.ok) return c.json({ error: r.error }, r.status);
    return c.json(r.task);
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
      // Awaited now: a scout's completion waits for its durable archive to be published and
      // verified, so the modal that called this stays open until the evidence exists rather
      // than reporting `done` over a report that was never captured.
      t = await tasks.complete(
        c.req.param("id"),
        parsed.data.outcome,
        parsed.data.outcomeUrl,
        parsed.data.satisfyDependents,
        parsed.data.requireStopped,
        parsed.data.confirmIncompleteScout,
      );
    } catch (error) {
      if (error instanceof TaskStatusConflictError) return c.json({ error: error.message }, 409);
      // The task is untouched and its checkout is intact, so this is a conflict the caller can
      // fix and retry - and it carries every problem rather than one, because the fix is
      // usually several paths at once. 422 would read as "malformed request"; the request was
      // fine, the world was not ready.
      if (error instanceof ScoutArchiveNotReadyError) {
        return c.json({
          error: error.message,
          problems: error.problems,
          confirmIncompleteScout: true,
        }, 409);
      }
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
      completionPolicy: d.completionPolicy,
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
      completionPolicy: d.completionPolicy,
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
      completionPolicy: d.completionPolicy,
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
