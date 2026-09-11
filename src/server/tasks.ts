import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { missionToolsAvailability } from "./mission-tools.ts";
import type {
  AgentType,
  AssignRefusalScope,
  AssignResetConfirm,
  ResetResult,
  Session,
  Task,
  TaskDependency,
  TaskKind,
  TaskPriority,
} from "@shared/types.ts";
import type {
  PipelineAdoptSuccessor,
  PipelineRetry,
  PromptedCompletionDisposition,
  ReorderTask,
  TaskDependencyInput,
  UpdateTask,
} from "@shared/protocol.ts";
import type { TaskSourceRef } from "@shared/task-source.ts";
import {
  pipelineRecoveryOutcomeFor,
  pipelineRunKeyOf,
  type PipelineRecoveryGuard,
  type PipelineRecoveryResultCode,
  type PipelineRun,
  type PipelineRunLink,
} from "@shared/pipeline.ts";
import { isAnnotationOnlyUpdate } from "@shared/protocol.ts";
import { capabilitiesFor, supportsEffort } from "@shared/harness-capabilities.ts";
import { canMessage, canRename } from "@shared/pane.ts";
import { foremanConcludedMission } from "@shared/schedules.ts";
import { declaredBlockers, type BacklogBlocker } from "@shared/backlog.ts";
import {
  dispatchHasNoProvisionedResources,
  TASK_KIND_BACKLOG_REFUSAL,
  providerOwnsTaskCompletion,
  taskKindAllowsBacklog,
} from "@shared/task.ts";
import { completableByMerge, type Registry, type TaskPrMerged } from "./registry.ts";
import type { WritebackEnqueuer } from "./task-sources/writeback.ts";
import {
  Dispatcher,
  deriveTitle,
  reclaimedFrom,
  releasedTaskResources,
  teardownWorktree,
  type TaskDispatchOptions,
} from "./dispatcher.ts";
import { WorktreeManager } from "./worktrees/manager.ts";
import { LegacyTreehouseService } from "./worktrees/legacy-treehouse.ts";
import {
  branchReleasedByReset,
  injectPrompt,
  kill,
  nameRulesFor,
  paneAcceptsPrompt,
  rename,
  resetWouldDestroyWork,
  validateSessionName,
  validateSessionNameAgainstTasks,
  type ActionResult,
  type InjectResult,
} from "./actions.ts";
import {
  clearTaskSessionClosure,
  completeTaskWithSessionClosure,
  getTask as getDurableTask,
  getTaskSessionClosure,
  listTaskSessionClosures,
  openDb,
  recordTaskSessionClosureAttempt,
  settleTaskWithRetentionAdoption,
  taskSessionClosureForSession,
  historicalTaskWorkEpisodeBindingsForTask,
  primaryRepoPrForTask,
  reserveRetroFollowup,
  retroFollowupForTask,
  taskReposFor,
  taskWorkEpisodeForTask,
  upsertTask as dbUpsertTask,
  workEpisodeRepoPrsForTask,
  updatePipelineCommissionRecovery,
  type TaskSessionClosureRow,
  type TaskWorkEpisodeBinding,
} from "./db.ts";
import { completionPolicyForOccurrence } from "./schedules/store.ts";
import { taskHasWorktrees, taskMergeQuorum, taskRepoRefs, type QuorumVerdict } from "@shared/task-repos.ts";
import { appendRank, placeBacklogRank, prependRank } from "./backlog-rank.ts";
import {
  isRetentionRetryable,
  taskHoldsCleanupResources,
  taskResourceGeneration,
} from "./task-resource-generation.ts";
import { readFailureClass, type ActivityFingerprint } from "./git/worktree-activity.ts";
import { gitInfo } from "./util/git.ts";
import {
  kindMissionMcpRequirement,
  missionMcpDescriptor,
  verifyMissionMcpToolsForRunningSession,
} from "./mission-mcp.ts";
import { isPlanTask } from "./plans/prompt.ts";
import { planDispatchBlock, planSkillsForSession } from "./plans/skills.ts";
import { provisionScoutSubmissionCredential } from "./scouts/submission-auth.ts";
import { cleanupAgentSubprocessEnv } from "./agent-subprocess-env.ts";
import { SUBMIT_SCOUT_ARTIFACTS_TOOL } from "./scouts/submission-tool.ts";
import { SUBMIT_WORKFLOW_EVIDENCE_TOOL } from "./workflows/evidence-tool.ts";
import {
  discardScoutPromptBoundary,
  freezeScoutPromptBoundary,
} from "./scouts/prompt-journal.ts";
import { withTaskKindContract } from "./task-contract.ts";
import { withStandingInstructions } from "./instructions/compose.ts";
import { TASK_KIND_BEHAVIOR } from "@shared/task.ts";
import { resolveTaskAgent } from "./harnesses.ts";
import { cancelPipelineCommission } from "./pipelines/commissions.ts";
import { PIPELINE_PROVIDERS } from "./pipelines/providers.ts";
import {
  PIPELINE_RECOVERY_CONSENT_WITHDRAWN,
  pipelineRepoConsented,
} from "./pipelines/config.ts";
import {
  checkPipelineCommissionReadiness,
  refreshPipelineCommission,
} from "./pipelines/index.ts";
import {
  adoptPipelineSuccessor as adoptValidatedPipelineSuccessor,
  completedPipelineAdoptionMatches,
  pipelineRecoveryGuard,
  preparePipelineRetry,
} from "./pipelines/recovery.ts";

/** Compare recovery identity without depending on object property insertion order. */
function pipelineGuardsMatch(a: PipelineRecoveryGuard, b: PipelineRecoveryGuard): boolean {
  return a.commissionId === b.commissionId &&
    a.activeAttempt === b.activeAttempt &&
    a.engineerRunId === b.engineerRunId &&
    a.providerRevision === b.providerRevision;
}

/**
 * What a SATISFIED quorum records as the task's outcome: every pull request that landed, in
 * repo order, behind the one link every existing consumer of `outcomeUrl` means by it.
 *
 * Shared by both completion paths rather than spelled at each, because they would otherwise
 * be free to disagree about what a finished multi-repo task is called - and one of them runs
 * while the agent is still watching.
 *
 * `outcomeUrl` is the PRIMARY's pull request, falling back to the first that landed only when
 * the primary was not one of the repositories that changed.
 */
function quorumOutcome(
  quorum: QuorumVerdict,
  fallbackUrl: string | null,
): { outcome: string; url: string } | null {
  const primary = quorum.merged.find((entry) => entry.role === "primary");
  const url = primary?.prUrl ?? quorum.merged[0]?.prUrl ?? fallbackUrl;
  if (!url) return null;
  return { outcome: `merged ${quorum.merged.map((entry) => entry.prUrl).join(", ")}`, url };
}
import {
  driverClearFor,
  resetSession,
  type PendingTurnResetBoundary,
} from "./reset.ts";
import { getShippingConfig } from "./shipping/config.ts";
import { unref } from "./util/timers.ts";
import { homeAlive, killHome } from "./terminal/home.ts";
import type { SdkSupervisor } from "./sdk/supervisor.ts";
import { stopSession } from "./sdk/control.ts";
import { renameDriverSession } from "./sdk/rename.ts";
import { summariseTaskTitle } from "./task-title.ts";
import { resolveTaskWorkflowId } from "./workflows/config.ts";
import { canonicalWorktreePath } from "./worktrees/path.ts";

export interface CreateTaskInput {
  repoRoot: string;
  /**
   * Secondary repositories to attach, already resolved through `resolveTaskRepoRoot`,
   * deduped, and checked against the primary by the caller - the same contract `repoRoot`
   * has. Omitted by every single-repo caller, which is nearly all of them.
   */
  extraRepoRoots?: string[];
  intent: string;
  title?: string;
  kind: TaskKind;
  /**
   * Which harness files this task. OMITTED means "whatever this kind is configured to run
   * on" (`resolveTaskAgent`), which is what an MCP `create_task` and any other creator with
   * no opinion should get; a caller that names one is making a pin and always wins.
   *
   * Resolved at CREATION rather than at launch, and that asymmetry with `model`/`effort`
   * below is forced by the schema: `tasks.agent` is `TEXT NOT NULL`, so there is no "unset"
   * for a row to carry. See `resolveTaskAgent`.
   */
  agent?: AgentType;
  /** Optional urgency. Omitted means unset, which is not the same as `low`. */
  priority?: TaskPriority | null;
  /** Optional tags, already normalized by the schema that parsed them. */
  labels?: string[];
  /**
   * Whether backlog autopilot may schedule this task. Omitted means enabled; task sources
   * name it when their per-source default parks newly swept work for review.
   */
  enabled?: boolean;
  /** Launch this agent on a specific model; omitted follows the harness default. */
  model?: string;
  /** Launch with a specific reasoning effort; omitted follows the harness default. */
  effort?: import("@shared/types.ts").ThinkingLevel;
  /**
   * Published Workflow identity to arm when the launched session appears. Omitted follows
   * the machine default; null explicitly means none.
   */
  workflowId?: string | null;
  /** Prerequisites selected from current backlog tasks or live sessions. */
  dependencies?: TaskDependencyInput[];
  /**
   * Where a task source swept this from. Omitted by every human-facing caller, which is
   * nearly all of them. Provenance only (see `Task.source`) - it is never consulted to
   * decide whether an item has been filed before.
   */
  source?: TaskSourceRef;
  /** Only add to the backlog (no worktree/session) - dispatch it later. */
  backlog: boolean;
}

export interface CreateRetroFollowupInput {
  sourceTask: Task;
  sourceEpisodeId: string;
  sourceSessionId: string;
  title: string;
  intent: string;
  agent: AgentType;
}

export const RETRO_NO_CHANGE_OUTCOME = "Retro complete: no memory changes approved";

export type CompleteRetroNoChangeOutcome =
  | { ok: true; task: Task; sourceTaskId: string; replayed: boolean }
  | { ok: false; status: 404 | 409; error: string };

/**
 * The three provenance values a schedule-created task carries, moved as one.
 *
 * A struct rather than three optional fields on `CreateTaskInput` because they are one
 * fact - which occurrence of which schedule filed this, and for what instant - and two of
 * three populated is not a partially-known task, it is a corrupt one.
 */
export interface TaskScheduleProvenance {
  scheduleId: string;
  scheduleOccurrenceId: string;
  /** The instant the task is FOR, not when it was filed. See `Task.scheduledFor`. */
  scheduledFor: number;
}

/**
 * What an INTERNAL, durable producer supplies that no human caller may: a task id it
 * chose itself, plus schedule provenance only when the scheduler is the producer. Ensemble
 * ownership stays normalized in `ensemble_members`; copying it onto Task would create a
 * second source of truth.
 *
 * The id is the whole mechanism behind retry-safe creation. The scheduler reserves an
 * occurrence and task id in one transaction; the ensemble engine persists a member attempt
 * and task id before creating the Task. Recovery repeats the same call, which returns an
 * existing Task only when its owning inputs still match and otherwise fails closed - see
 * `create`.
 *
 * Deliberately a second argument rather than fields on `CreateTaskInput`: every ordinary
 * caller parses a request body into that type, and an id accepted there would be an id an
 * HTTP client could choose.
 */
export type InternalCreateOptions =
  | {
      id: string;
      schedule: TaskScheduleProvenance;
    }
  | {
      id: string;
      schedule?: undefined;
    };

/** A preallocated id already belongs to a DIFFERENT task. Corruption, never idempotency. */
export class TaskIdCollisionError extends Error {}

export interface Ok {
  ok: boolean;
  error?: string;
}

/** The merge identity needed to close the session after its task finishes. */
type MergedSessionRef = Pick<TaskPrMerged, "taskId" | "sessionId" | "episodeId">;

/**
 * What `reorder` answers with. The status is chosen HERE rather than reverse-engineered
 * from the sentence at the route, because the two refusals read the same to a string match
 * and mean opposite things to a caller: 404 is "that card is gone, stop drawing it" and 409
 * is "that card moved on, re-read and try again".
 */
export type TaskReorderResult =
  | { ok: true; task: Task }
  | { ok: false; status: 404 | 409; error: string };

/** A user-fixable dependency selection conflict, safe to return as HTTP 409. */
export class TaskDependencyError extends Error {}

/** A chat task was sent through a surface without the manual Dispatch capability. */
export class TaskKindBacklogError extends Error {}

/** A launch effort named for a harness that cannot be launched with it. */
export class TaskEffortUnsupportedError extends Error {}

/**
 * Capability held only by the localhost manual Dispatch route. Requiring the exact symbol
 * keeps generic and durable task producers from constructing an immediate chat by accident.
 */
export const MANUAL_DISPATCH_TASK_CREATE = Symbol("manual-dispatch-task-create");

export class TaskStatusConflictError extends Error {}

export const INTERRUPTED_BEFORE_PROVISION_ERROR =
  "Dispatch was interrupted before a worktree or agent was created. It is back in the backlog and safe to launch again.";

export const INTERRUPTED_CHAT_BEFORE_PROVISION_ERROR =
  "Chat dispatch was interrupted before a worktree or agent was created. Launch a new chat from Dispatch.";

/**
 * One authorized automatic cleanup, as the retention service presents it.
 *
 * The claim facts are passed in rather than read here on purpose: the ledger is retention's
 * to own, and `TaskManager` must not learn to read or write it. What it receives is "here is
 * a generation and a fingerprint somebody durably claimed, and here is how to re-measure the
 * second one" - and everything it decides, it decides by re-measuring.
 */
export interface AutomaticReclaimRequest {
  taskId: string;
  /** The resource generation the ledger claim was taken against. */
  generation: string;
  /** The aggregate Git-visible fingerprint that claim was taken against. */
  fingerprint: string;
  /**
   * Phase 1's aggregate activity probe, injected.
   *
   * Injected rather than imported so this file gains no second opinion about what counts as
   * Git-visible activity, and so a test can drive both guards without a real checkout.
   */
  probe: (task: Task) => Promise<ActivityFingerprint>;
  /**
   * "Has the caller given up on this?" - checked once, when the job reaches the front of the
   * repository queue.
   *
   * Cleanup is serialized per physical repository, so a due fleet in one repository is a
   * queue of teardowns, and the daemon awaits the retention pass during shutdown so a probe
   * cannot outlive the allocator. Without this, quitting during a large sweep would wait for
   * every queued teardown to run. A job that has not STARTED is abandoned cleanly instead -
   * its claim goes back untouched and the deadline it was working toward is still there on
   * the next boot. A job already past this point is not interrupted: it is mid-teardown, and
   * the safe place to stop is after it finishes accounting for what it released.
   */
  abandoned?: () => boolean;
}

/**
 * What an automatic attempt actually did. Every branch is a durable transition for the caller.
 *
 * The distinction that matters most is between `activity-changed` and everything else that
 * stops a teardown: fresh work means the tree earns a whole new 30-day window, while an
 * external replacement means the old window applies to nothing and observation starts over,
 * and a refusal means the tree is still due and should be retried without either.
 */
export type AutomaticReclaimOutcome =
  /** Every worktree released. The task update has already gone out. */
  | { kind: "reclaimed" }
  /** A fresh probe disagreed with the claim: somebody worked in that checkout. */
  | { kind: "activity-changed" }
  /** The task, its attempt, or its recorded resources were replaced by something else. */
  | { kind: "ownership-changed"; detail: string }
  /** A required validation could not be trusted. Never treated as inactivity. */
  | { kind: "validation-unknown"; detail: string }
  /** A scout report could not be published, so its tree must not be removed yet. */
  | { kind: "archive-refused"; detail: string }
  /** Quiescence or provider teardown refused. Whatever came back is already released. */
  | { kind: "failed"; detail: string };

export interface TaskManagerStartupDeps {
  /**
   * The BACKGROUND teardown seam, injectable so cleanup ordering can be exercised without real
   * providers.
   *
   * Covers the two paths that release a tree on the daemon's own initiative - startup
   * reconciliation and automatic retention cleanup - and deliberately not the manual ones. An
   * operator's Clean up, Cancel, Remove and Reschedule keep calling `teardownWorktree`
   * directly at `foreground` priority, because there is nothing about them a test needs to
   * stand in for and every one of them is somebody watching.
   */
  teardown?: typeof teardownWorktree;
}

interface TaskCleanupJob {
  taskId: string;
  repoKeys: readonly string[];
  run: () => Promise<void>;
}

/**
 * Starts at most one background cleanup touching a given repository.
 *
 * Bounding work per repository is what keeps restart recovery - and now automatic retention
 * cleanup, which can come due for a hundred tasks in the same repository on the same morning -
 * from issuing a same-repository convoy all at once. Jobs touching disjoint repositories still
 * progress together, so a fleet spread over several repositories is not serialized into one
 * queue by accident.
 *
 * This is deliberately NOT a priority queue and does not know about foreground work. The
 * native allocator already gives `WorktreeManager.release("foreground")` precedence over
 * background releases, and duplicating that ordering here would be a second scheduler with a
 * second opinion. What this owns is narrower and is the thing the allocator cannot see: two
 * cleanups reaching into the same physical repository's `.git` at once.
 *
 * Shared by startup reconciliation and retention rather than copied, because the KEY SPACE is
 * the contract - both must canonicalize repository roots the same way, or two jobs on the same
 * repository spelled differently would run together and the bound would silently not exist.
 */
class TaskCleanupQueue {
  private pending: TaskCleanupJob[] = [];
  private activeRepoKeys = new Set<string>();
  /** In-flight and queued jobs by task, so the same task cannot be enqueued twice. */
  private readonly enqueued = new Set<string>();

  /**
   * Queue a job, or refuse when this task already has one.
   *
   * The refusal matters for retention: a pass that comes round again while a task's cleanup
   * is still waiting behind a busy repository must not stack a second attempt behind the
   * first. Returns false so the caller can leave its ledger claim alone rather than treating
   * the queue as an acceptance.
   */
  enqueue(job: TaskCleanupJob): boolean {
    if (this.enqueued.has(job.taskId)) return false;
    this.enqueued.add(job.taskId);
    this.pending.push(job);
    this.drain();
    return true;
  }

  /** How many jobs are queued or running. Retention bounds its own fan-in against this. */
  get size(): number {
    return this.enqueued.size;
  }

  private drain(): void {
    for (let index = 0; index < this.pending.length;) {
      const job = this.pending[index]!;
      if (job.repoKeys.some((key) => this.activeRepoKeys.has(key))) {
        index += 1;
        continue;
      }
      this.pending.splice(index, 1);
      for (const key of job.repoKeys) this.activeRepoKeys.add(key);
      void job.run()
        .catch((error: unknown) => {
          console.error(
            `[tasks] could not reconcile ${job.taskId} during startup:`,
            error,
          );
        })
        .finally(() => {
          for (const key of job.repoKeys) this.activeRepoKeys.delete(key);
          this.enqueued.delete(job.taskId);
          this.drain();
        });
    }
  }
}

/** Every repository whose cleanup one task can reach, in the queue's canonical key space. */
function taskCleanupRepoKeys(task: Task): string[] {
  return [...new Set(
    [task.repoRoot, ...task.extraRepos.map((entry) => entry.repoRoot)].map(canonicalWorktreePath),
  )];
}

function needsStartupReconcile(task: Task): boolean {
  return (
    task.status === "dispatching" ||
    // `taskHasWorktrees` rather than the primary path alone. A multi-repo teardown clears each
    // repository's path as that tree is actually released, so a run that released the primary
    // and then failed on an attached repository leaves a terminal task whose primary is null
    // and whose attached checkout is still on disk - and reading the primary alone meant
    // nothing reconciled that survivor on restart at all. Home ownership stays a separate
    // disjunct: a task holding only a dead terminal home has no checkout to observe.
    (taskHoldsCleanupResources(task) &&
      (task.status === "running" ||
        task.status === "failed" ||
        task.status === "done" ||
        task.status === "cancelled"))
  );
}

/**
 * A scout whose durable archive is not ready, refusing its own completion.
 *
 * Carries every problem rather than one sentence, because the caller is usually an agent or
 * an operator about to fix them: four bad supporting paths should cost one round trip, not
 * four. Distinct from `TaskStatusConflictError` so a route can answer with the list.
 */
export class ScoutArchiveNotReadyError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
  }
}

/** One completion request, as the owner's serialized path takes it. */
interface CompletionInput {
  outcome: string;
  outcomeUrl?: string;
  satisfyDependents: boolean;
  requireStopped: boolean;
  /** A human has accepted the archive problems returned by a prior completion attempt. */
  confirmIncompleteScout: boolean;
  /**
   * The session whose idleness this completion was INFERRED from, or null for a stated one.
   *
   * Present only for `settleIfEpisodeFinished`, and it is what makes that conclusion
   * reversible: `reopenIfWorkResumed` undoes a completion this class inferred and never one a
   * human recorded. Threaded through the completion rather than set by the caller afterwards
   * so it lands in the same tick as the write it describes.
   */
  inferredFrom: string | null;
  /**
   * The session this completion also finishes with, or null when it finishes with nobody.
   *
   * Present only for a concluded recurring mission run. Threaded through the completion
   * rather than recorded by the caller afterwards because the two writes must be ONE: a
   * daemon that died between a durable `done` task and the closure it owes leaves a live
   * agent nothing will ever revisit. See `completeTaskWithSessionClosure`.
   */
  closeSessionId?: string | null;
}

/**
 * How long a mission run's recorded outcome may be, counted in CODE POINTS.
 *
 * The verifier's summary is prose from a model, and `Task.outcome` is rendered on a board
 * card, a rail row and the mission's own run history. Bounded here rather than trusted,
 * for the reason every other bound in this file exists.
 */
const MISSION_RUN_OUTCOME_MAX = 200;

/**
 * The sentence a Foreman-concluded mission run leaves on its task.
 *
 * It names the concluder, because a reader looking at a `done` row weeks later needs to know
 * this was an inference from Foreman's verdict rather than something a person typed - and
 * carries Foreman's own summary, because "why is this done when nothing shipped?" is the
 * first question that row provokes.
 *
 * The cut is made on CODE POINTS, not on `String.prototype.slice`'s UTF-16 code units. The
 * summary is model-authored prose and routinely carries emoji, so a code-unit cut can land
 * between the halves of a surrogate pair and persist a lone surrogate - which renders as a
 * replacement glyph on the board card, the rail row and the run history, for ever, because
 * this string is written once at completion and never revised.
 *
 * Code points rather than grapheme clusters, deliberately. A ZWJ sequence or a combining
 * mark can still be split here, and that is a cosmetic loss; splitting a surrogate pair
 * produces a string that is not valid text at all, which is the defect being fixed.
 */
function missionRunOutcome(decision: PromptedCompletionDisposition): string {
  const why = decision.summary.trim();
  const line = why
    ? `Foreman concluded this recurring mission run: ${why}`
    : "Foreman concluded this recurring mission run";
  const points = [...line];
  return points.length > MISSION_RUN_OUTCOME_MAX
    ? `${points.slice(0, MISSION_RUN_OUTCOME_MAX - 1).join("")}\u2026`
    : line;
}

/** The task facts a scout completion must not cross while its archive gate awaits. */
interface ScoutCompletionSnapshot {
  status: Task["status"];
  sessionId: string | null;
  episodeId: string | null;
  cleanupResources: string;
}

/**
 * What `TaskManager` needs from the archive owner, and nothing else.
 *
 * A narrow port rather than the class, for two reasons. The archive manager is injected into
 * this class so completion can wait on it, so it cannot in turn depend on this class; and the
 * many focused tests that construct a bare `TaskManager` keep compiling and keep behaving
 * exactly as they did, because an absent gate means "nothing here is archived".
 *
 * The two methods are asymmetric on purpose, and the asymmetry is an approved product
 * decision rather than an accident of growth. Cleanup settles for EVERY archived kind, so a
 * plan's directories and a scout's report both leave through `settleBeforeCleanup`. Completion
 * waits only for a scout: `scoutGateFor` hands this over for a `scout` task and nothing else,
 * so a plan finishes on Foreman's ordinary boundary exactly as a ship task does.
 */
export interface TaskArchiveGate {
  /** Resolve once the task's verified COMPLETE bundle exists, or say what is wrong. */
  ensureReady(taskId: string): Promise<{ ok: true } | { ok: false; problems: string[] }>;
  /** Publish whatever this task produced before its checkout is destroyed. */
  settleBeforeCleanup(taskId: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

/**
 * Why the disabled toggle refuses by DEFAULT rather than trusting callers to identify
 * themselves, spelled out once for both options objects below.
 *
 * The first design had the autopilot declare itself and be refused on that basis. It
 * cannot work: the Foreman worker is a separate process started by hand
 * (`npm run foreman`), so it can outlive a daemon restart, and a worker that predates
 * this field sends nothing - which an "are you the autopilot?" flag reads as a human
 * override. That stale worker also has no `readyBacklog` filter of its own, so it would
 * cheerfully launch a task somebody had just parked.
 *
 * Inverting it removes the question. Nothing has to be identified: a request that does
 * not CLAIM an override does not get one, so the stale worker is refused by
 * construction. The dashboard ships in the same bundle as the daemon and can never be
 * skewed against it, so it can always claim the override behind the operator's own
 * "launch anyway" button - which is the one path that must keep working.
 */
const DISABLED_REFUSAL =
  "task is disabled - Foreman will not schedule it (launch it yourself to override)";

/** True when this call must be refused because the task is parked and nobody claimed an override. */
function refusedAsDisabled(task: Task, overrideDisabled: boolean | undefined): boolean {
  // Scoped to `backlog`: `enabled` gates SCHEDULING, and the retry path for a cleanly
  // failed task is not scheduling - that task already ran.
  return task.status === "backlog" && !task.enabled && overrideDisabled !== true;
}

/**
 * What a caller asks of ONE launch: the launch options the Dispatcher acts on
 * (`TaskDispatchOptions` - pinned base, required Mission MCP tools, the launch-time default
 * model Foreman may supply for an otherwise-unpinned backlog task) plus the one thing that
 * is a TaskManager decision rather than a launch property.
 *
 * The split is the point. `overrideDisabled` is an authorization the caller is claiming
 * about this request; everything else describes the agent that is about to start, and is
 * forwarded verbatim. Nothing here is persisted - see `TaskDispatchOptions`.
 */
export interface DispatchOptions extends TaskDispatchOptions {
  /** The caller is deliberately starting a parked task. See `DISABLED_REFUSAL`. */
  overrideDisabled?: boolean;
}

/** The seams and the one decision `TaskManager.assign` takes from its caller. */
export interface AssignOptions {
  /** The caller is deliberately handing over a parked task. See `DISABLED_REFUSAL`. */
  overrideDisabled?: boolean;
  /**
   * The caller has accepted what the handover reset discards beyond git state. False -
   * the default, and what an omitted flag gets - means a reset with anything to lose is
   * refused with the breakdown attached instead of run.
   */
  confirmReset?: boolean;
  /** Deliver the task's intent to the agent. The one call that types. */
  inject?: typeof injectPrompt;
  /** Ask whether the pane could take a prompt, before anything is done to the agent. */
  paneReady?: (session: Session) => Promise<ActionResult>;
  /** Hand the agent's checkout back in the shape a fresh one starts in. */
  reset?: (session: Session) => Promise<ResetResult>;
  /** Rename the agent's terminal after the task it just took. Cosmetic, never fatal. */
  rename?: (session: Session, name: string) => Promise<ActionResult>;
  /**
   * Whether Mission Control's MCP bundle can be launched on this machine.
   *
   * A seam only so a test can drive the scout capability refusal without deleting `dist/`.
   * It answers a machine-level question - is the bundle on disk - which is the honest one for
   * an assignment: the target session's own launch allowlist was fixed before we arrived.
   */
  missionMcpDescriptor?: typeof missionMcpDescriptor;
  /**
   * Whether the bundle THIS SESSION is running publishes the scout submission tool.
   *
   * The companion to the seam above, and the reason it is a second one: "the bundle is on
   * disk" and "the bundle serves `submit_scout_artifacts`" were the same question right up
   * until a stale `dist/` made them different ones. Session-scoped rather than the plain
   * disk check a dispatch uses, because an assignment targets an agent that is already
   * running against a bundle it loaded earlier.
   */
  verifyMissionMcpToolsForRunningSession?: typeof verifyMissionMcpToolsForRunningSession;
  /** Publish the checkout-scoped bearer before a scout's prompt is delivered. */
  provisionScoutCredential?: typeof provisionScoutSubmissionCredential;
  /**
   * Which planning-skill invocations THIS SESSION could be told to run.
   *
   * A seam only so a test can drive the plan refusal, and the watermark-aware resolver by
   * construction: an assignment types into a conversation that already exists, and one that
   * has not acknowledged the current skills generation is still holding the previous set.
   */
  requirePlanSkills?: typeof planSkillsForSession;
}

/** Evidence that the daemon resolved before a Pipeline task may change its durable run. */
export type PipelineRunAdoptionProof =
  | { kind: "managed"; session: Session }
  | { kind: "managed-launch"; sessionId: string }
  | { kind: "terminal"; session: Session };

export type PipelineRunAdoptionResult =
  | { ok: true; task: Task; replayed: boolean }
  | { ok: false; status: 403 | 404 | 409; error: string };

export type PipelineWorkspaceReportResult =
  | { ok: true; task: Task; replayed: boolean }
  | { ok: false; status: 404 | 409; error: string };

/**
 * How long after a concluded recurring mission run's recorded completion its agent session is
 * guaranteed to be out of the active-session registry.
 *
 * Four minutes, and it is a GUARANTEE rather than an aspiration: the session is out of the
 * registry by then whether or not its backend cooperated, because
 * `MISSION_SESSION_CLOSURE_ESCALATE_MS` retires one that will not go. Wide enough to cover a
 * driver that takes its time going down plus the registry's own exit linger, and far short of
 * the hourly cadence these missions run on - a session that outlived the next occurrence is the
 * failure this whole path exists to prevent.
 */
export const MISSION_SESSION_CLOSURE_DEADLINE_MS = 240_000;

/**
 * How often an unconfirmed closure is re-attempted.
 *
 * Fixed rather than backing off, unlike the retention ledger's hourly doubling, because the
 * deadline is four minutes rather than a month and every pass is cheap: a stop against a
 * driver that is already going down, or one keystroke into a pane. The common case does not
 * wait for it at all - `session_remove` kicks the sweep the moment the registry evicts the
 * session it just stopped.
 */
export const MISSION_SESSION_CLOSURE_RETRY_MS = 10_000;

/**
 * When asking stops being enough and the session is retired instead.
 *
 * Three minutes, deliberately INSIDE the four-minute guarantee rather than at it. Retirement
 * goes through `Registry.beginEviction`, which lingers the card before removing it, so an
 * escalation that fired exactly on the deadline would remove the session just after the moment
 * it had promised to be gone. The gap leaves room for the eviction linger and a retry tick, and
 * still gives a slow-but-honest driver eighteen attempts to go by itself first.
 */
export const MISSION_SESSION_CLOSURE_ESCALATE_MS = 180_000;

/**
 * How long ONE stop attempt may take before the sweep stops waiting on its answer.
 *
 * The guarantee is only a guarantee if nothing can hold the sweep open. `stopSession` awaits
 * the driver all the way down - `SdkSupervisor.stop` waits on the pump, deliberately, so a
 * caller handing the conversation to a terminal knows the file is written - and a driver that
 * wedges never answers at all. Without a bound the pass stays in flight for ever, every later
 * pass returns early on `sweepingClosures`, and the escalation that exists precisely for an
 * agent that will not go is the thing that never runs. The session then outlives the four
 * minutes while the daemon believes it is mid-close.
 *
 * Twenty seconds: long enough that an ordinary stop, even a slow one draining a real driver,
 * answers well inside it; short enough that several attempts and the retirement all fit before
 * the deadline. Worst case is a pass starting a moment before the escalation instant - it
 * gives up at 200s, retires, and the registry's own linger removes the session by ~208s.
 *
 * The abandoned attempt is not cancelled, because nothing here can cancel it. It is simply no
 * longer waited on, and its eventual rejection is absorbed rather than left unhandled.
 */
export const MISSION_SESSION_CLOSURE_STOP_TIMEOUT_MS = 20_000;

/** The bounded sentence a refused stop contributes to the operator-visible summary. */
function closureRefusal(result: ActionResult): string {
  return result.error ?? "the agent could not be stopped";
}

export interface CloseMergedSessionDeps {
  resetWouldDestroyWork: typeof resetWouldDestroyWork;
  kill: typeof kill;
}

const defaultCloseMergedSessionDeps: CloseMergedSessionDeps = {
  resetWouldDestroyWork,
  kill,
};

/**
 * An assign's answer. A refusal says whose fault it is, and - when the caller only has
 * to say yes - exactly what saying yes would spend.
 */
export interface AssignOutcome extends Ok {
  scope?: AssignRefusalScope;
  resetConfirm?: AssignResetConfirm;
}

export type DispatchOutcome =
  | { ok: true; task: Task }
  | { ok: false; error: string; task?: Task };

export type PipelineRecoveryOutcome =
  | { ok: true; task: Task }
  | {
      ok: false;
      code: PipelineRecoveryResultCode;
      error: string;
      task?: Task;
      outcomeUnknown?: boolean;
    };

function pipelineRecoveryConsentFailure(task: Task): PipelineRecoveryOutcome {
  return {
    ok: false,
    code: "task_conflict",
    error: PIPELINE_RECOVERY_CONSENT_WITHDRAWN,
    task,
  };
}

/** Whether the handover would take anything the caller has not already agreed to. */
function needsResetConfirm(c: AssignResetConfirm): boolean {
  // `clearsContext` is deliberately NOT a trigger, though it IS reported. Every agent
  // that can be assigned at all has a pane, so treating the `/clear` as something to ask
  // about would put a dialog in front of every drop - including onto a pooled worktree
  // sitting detached with nothing in it, which is the case that must stay one gesture.
  return c.queuedItems > 0 || c.branch != null;
}

/** The loss in one sentence, for the refusal a caller may show as-is. */
function describeResetLoss(c: AssignResetConfirm): string {
  const parts: string[] = [];
  if (c.queuedItems > 0) parts.push(`${c.queuedItems} queued work item(s)`);
  if (c.branch) parts.push(`the branch ${c.branch}`);
  if (c.clearsContext) parts.push("the agent's context");
  return parts.join(", ");
}

/**
 * Owns the task lifecycle: create/queue, kick off dispatch, cancel (tearing down
 * the live session + terminal home + optional worktree), complete with an outcome, and
 * remove from the list. The registry is the single store; this class is the
 * policy layer routes call into - the task analog of ReviewManager.
 */
export class TaskManager {
  private dispatcher: Dispatcher;
  private readonly worktrees: WorktreeManager;
  private readonly legacyWorktrees: LegacyTreehouseService;
  /**
   * In-flight titling runs, by task id.
   *
   * A backlogged untitled task is on the board - and dispatchable - the instant `create`
   * returns, while its title is still being decided. Dispatching in that window would cut
   * the branch and terminal home name from the heuristic title and then rename only the card,
   * which is the exact mismatch the awaited-titling ordering exists to prevent. `dispatch`
   * awaits this first, so an early click waits a beat and gets the model's title instead.
   * Held here rather than checked at the route so the invariant holds on every path.
   */
  private titling = new Map<string, Promise<void>>();
  private assigningTasks = new Set<string>();
  private assigningSessions = new Set<string>();
  private reschedulingTasks = new Set<string>();
  /**
   * Repository-serialized background cleanup, shared by startup reconciliation and by
   * automatic worktree retention. See `TaskCleanupQueue`.
   */
  private readonly cleanupQueue = new TaskCleanupQueue();
  /**
   * Tasks whose resources one destructive path currently owns.
   *
   * The in-process half of a two-part exclusion, and it is not redundant with the retention
   * ledger's claim. The ledger closes overlap ACROSS daemon lives - a claim written before a
   * crash is still there afterwards. This closes overlap WITHIN one, between callers that
   * never look at the ledger at all: manual Clean up, Remove, Cancel, Reschedule, startup
   * reconciliation, and another automatic attempt. Two of those tearing the same tree down
   * together is a double `git worktree remove` and a lease returned twice.
   *
   * Held across the whole destructive window, quiescence and archives included, because those
   * are exactly the awaits during which a second caller used to be able to walk in.
   */
  private readonly cleanupReservations = new Set<string>();
  /** One in-process launcher per durable retry reservation. SQLite owns cross-request CAS. */
  private readonly pipelineRecoveries = new Set<string>();
  /** One completion in flight per task, so two signals cannot both publish one archive. */
  private completing = new Map<string, Promise<Task | null>>();
  /** Tasks concluded from an agent's idleness, and so reversible. See `reopenIfWorkResumed`. */
  private autoCompleted = new Map<string, string>();
  /** Re-entrancy guard for `reconcileMergedTasks`, which its own completions can re-enter. */
  private reconcilingMergedTasks = false;
  /** The self-rescheduling closure sweep, alive only while a closure is actually owed. */
  private closureTimer: ReturnType<typeof setTimeout> | null = null;
  /** When that timer is due, so an earlier kick can pre-empt a pending retry. */
  private closureDueAt: number | null = null;
  private sweepingClosures = false;
  /** A pass asked for while one was running, so the urgent request is not lost to the retry. */
  private sweepUrgentlyRequested = false;
  private closuresStopped = false;
  private completedInitialSessionSweep = false;
  private workflowEvidenceEnabledForTask: (
    task: Pick<Task, "kind" | "workflowId">,
  ) => boolean = () => false;
  /**
   * Where a completion is announced to the task-source write-back ledger, when the daemon
   * installed one. Absent in every focused test, which is exactly the shipped default
   * behaviour: nothing is owed and nothing is written.
   */
  private writeback?: WritebackEnqueuer;
  constructor(
    private registry: Registry,
    private closeMergedSessionDeps: CloseMergedSessionDeps = defaultCloseMergedSessionDeps,
    /**
     * The owner of embedded (SDK-runtime) sessions, when the daemon built one.
     *
     * Optional so the many route-unit tests that construct a bare TaskManager still
     * compile; production always supplies it. Without it, dispatch refuses the SDK runtime
     * out loud rather than taking the terminal path an operator did not ask for, and
     * startup reconciliation falls through to the terminal axis - which for a task with no
     * `homeName` means "keep the worktree", the safe direction.
     */
    private supervisor?: SdkSupervisor,
    /** Coordinates claimed message delivery with every task-assignment reset. */
    private pendingTurns?: PendingTurnResetBoundary,
    /**
     * The archive owner, when the daemon built one.
     *
     * Optional for the same reason `supervisor` is - the focused tests that construct a bare
     * TaskManager exercise no archives and must keep behaving identically. Absent means every
     * completion is a ship completion and every cleanup is unguarded, which is exactly what
     * this file did before any kind had archives.
     */
    private archives?: TaskArchiveGate,
    private startupDeps: TaskManagerStartupDeps = {},
    worktrees?: WorktreeManager,
    legacyWorktrees?: LegacyTreehouseService,
  ) {
    this.worktrees = worktrees ?? new WorktreeManager();
    this.legacyWorktrees = legacyWorktrees ?? new LegacyTreehouseService();
    this.dispatcher = new Dispatcher(registry, undefined, {
      supervisor,
      workflowEvidenceEnabled: (task) => this.workflowEvidenceEnabledForTask(task),
      worktrees: this.worktrees,
      legacy: this.legacyWorktrees,
      // The launch no longer waits for a model to name it, so the name can arrive on either
      // side of the session. This is the "session arrived" half; see `settleTitleName`.
      onSessionBound: (taskId) => void this.settleTitleName(taskId),
    });
    // A restart severs the in-flight dispatch promises but leaves worktrees + terminal
    // homes on disk. Reconcile every task that still holds resources by checking
    // whether its agent's terminal home survived (emulator pane identity or mux name).
    for (const t of registry.listTasks()) {
      const recovery = t.pipelineCommissionId
        ? registry.pipelineCommission(t.pipelineCommissionId)?.recovery
        : null;
      const recoveryOutcome = recovery ? pipelineRecoveryOutcomeFor(recovery) : null;
      if (
        recovery && recoveryOutcome && !recoveryOutcome.ok &&
        recoveryOutcome.code === "recovery_in_flight"
      ) {
        const guard = {
          commissionId: t.pipelineCommissionId!,
          activeAttempt: recovery.predecessorAttempt,
          engineerRunId: recovery.predecessorEngineerRunId,
          providerRevision: recovery.predecessorProviderRevision,
        };
        if (recovery.kind === "retry") {
          void this.retryPipelineAttempt(t.id, { guard });
        } else {
          const commission = registry.pipelineCommission(t.pipelineCommissionId!);
          const candidate = commission?.successorCandidate;
          if (candidate?.fingerprint) {
            void this.adoptPipelineSuccessor(t.id, {
              guard,
              candidateEngineerRunId: candidate.engineerRunId,
              candidateRevision: candidate.providerRevision,
              candidateFingerprint: candidate.fingerprint,
            });
          }
        }
        continue;
      }
      // Every `dispatching` task needs reconciling even before it acquired a
      // worktree (a restart mid-provision would otherwise strand it forever);
      // terminal tasks only when they still hold resources to check/reclaim.
      if (!needsStartupReconcile(t)) continue;
      // No cleanup exists in this state, so do not make visibility wait behind cleanup.
      // The async function reaches this branch before its first await.
      if (dispatchHasNoProvisionedResources(t)) {
        void this.reconcileOnStartup(t);
        continue;
      }
      this.cleanupQueue.enqueue({
        taskId: t.id,
        repoKeys: taskCleanupRepoKeys(t),
        run: async () => {
          // A queued job can wait minutes. Re-read instead of resurrecting the startup
          // snapshot after an operator has already reclaimed, removed, or rescheduled it.
          const current = this.registry.getTask(t.id);
          if (current && needsStartupReconcile(current)) {
            await this.reconcileOnStartup(current);
          }
        },
      });
    }

    // A bound session can also go away while the daemon is UP: the (k) kill, a terminal
    // the operator closed, an agent that exited by itself. Registry emits `session_remove`
    // only from its eviction timer, which is the durable answer - a session marked exited
    // by one sweep and rediscovered by the next never reaches it.
    registry.subscribe((e) => {
      if (e.type === "session_remove") {
        // Before `agentWentAway`, so a task whose work landed reads as done rather than
        // as a failure with a merged pull request sitting in its record. Registry deletes
        // the session before it emits this, so the reconciler sees the agent as gone;
        // `agentWentAway` keeps its own `mergedPrFor` check as the belt for any caller
        // that does not.
        this.reconcileMergedTasks();
        this.reconcileTasksBoundTo(e.id);
        // The one signal that can CONFIRM an owed closure. `session_remove` is the durable
        // answer to "that agent is gone" (see `Registry.beginEviction`), so a run concluded
        // seconds ago settles here rather than waiting out a retry interval.
        this.scheduleMissionSessionClosureSweep(0);
      }
      if (e.type === "task_remove") this.autoCompleted.delete(e.id);
      if (
        e.type === "task_upsert" &&
        this.autoCompleted.has(e.task.id) &&
        (e.task.status !== "done" ||
          e.task.sessionId !== this.autoCompleted.get(e.task.id))
      ) {
        this.autoCompleted.delete(e.task.id);
      }
      // The other end of a merged task's life, for an agent that is still here. See
      // `settleIfEpisodeFinished`.
      if (e.type === "session_upsert") {
        this.rebindTaskAtCwd(e.session);
        this.bindPipelineTask(e.session);
        this.settleIfEpisodeFinished(e.session);
        this.reopenIfWorkResumed(e.session);
        this.interceptWorkOnClosingSession(e.session);
        // And the rows no session can settle: a terminal task whose pull request has since
        // merged, or one still bound to a session id nothing answers to. Cheap on the hot
        // path - a task whose agent is right here costs no query at all.
        this.reconcileMergedTasks();
      }
    });

    // And one that went away while the daemon was DOWN is in no map at all until discovery
    // rebuilds it, so the same reconciliation waits for the first completed sweep. This is
    // the half the startup loop above cannot reach: it only visits a task still holding a
    // worktree or a home, so an ASSIGNED task - handed to an agent the operator started, so
    // it never had resources of ours - was skipped by it on every restart, forever.
    registry.onSessionsObserved(() => {
      this.completedInitialSessionSweep = true;
      this.reconcileMergedTasks();
      this.reconcileTasksWithNoLiveSession();
      // And the closures a previous daemon left owed. Nothing before this point may act on
      // one: until the process table has been read, a session missing from the registry has
      // not been observed to be gone. See `sweepMissionSessionClosures`.
      this.scheduleMissionSessionClosureSweep(0);
    });

    // The other way a task ends: its work landed. See `settleMergedTask`.
    registry.onTaskPrMerged((e) => this.settleMergedTask(e));
    // And the periodic backstop for the tasks that announcement cannot reach: whatever the
    // by-URL poller recorded this tick. No timer of its own - the poller's tick is it.
    registry.onPrMergesRecorded(() => this.reconcileMergedTasks());
    // A pipeline task belongs to the provider run rather than to any one child agent.
    // The provider projection is therefore its durable completion authority, including
    // the boot-time restore of a run that finished while Mission Control was down.
    registry.onPipelineRun((run) => this.settlePipelineTask(run));
  }

  /** Persist the strong terminal-home plus projected-worktree join for a pipeline task. */
  private bindPipelineTask(session: Session): void {
    const link = session.pipeline;
    if (!link || session.state === "exited") return;
    try {
      const task = this.registry.taskResourceOwnerForSession(
        session.id,
        undefined,
        (candidate) =>
          candidate.kind === "pipeline" &&
          (candidate.status === "running" || candidate.status === "dispatching"),
      );
      if (!task || task.repoRoot !== link.repoRoot) return;
      this.adoptPipelineRun(task, link, { kind: "terminal", session });
    } catch (error) {
      // Session discovery must survive a persistence failure. The next discovery frame or
      // projection update retries the same idempotent join.
      console.warn("[tasks] could not bind pipeline task:", error);
    }
  }

  /**
   * Adopt one observed provider run as an active Pipeline task's durable completion key.
   *
   * The caller supplies only the provider slug. Provider, repository, task and session
   * authority all come from daemon-owned state. Every guard and the write remain synchronous
   * so two claims cannot both pass the active-owner check before either becomes visible.
   */
  adoptPipelineRun(
    resolvedTask: Task,
    target: PipelineRunLink,
    proof: PipelineRunAdoptionProof,
  ): PipelineRunAdoptionResult {
    const task = this.registry.getTask(resolvedTask.id);
    if (!task) return { ok: false, status: 404, error: "no matching Pipeline task" };
    if (
      task.kind !== "pipeline" ||
      (task.status !== "running" && task.status !== "dispatching")
    ) {
      return { ok: false, status: 409, error: "this task is not an active Pipeline task" };
    }

    let sessionPipeline: PipelineRunLink | null = null;
    if (proof.kind === "managed-launch") {
      const launch = this.registry.managedPipelineLaunch(proof.sessionId);
      if (!launch || launch.taskId !== task.id || task.sessionId !== launch.sessionId) {
        return {
          ok: false,
          status: 403,
          error: "only this task's pending managed Engineer launch may adopt its Pipeline run",
        };
      }
    } else {
      const session = this.registry.getSession(proof.session.id);
      if (!session || session.state === "exited") {
        return { ok: false, status: 403, error: "the Pipeline task host is no longer active" };
      }
      if (proof.kind === "managed") {
        if (task.sessionId !== session.id || session.runtime !== "sdk" || session.pipeline !== null) {
          return {
            ok: false,
            status: 403,
            error: "only this task's live managed Engineer host may adopt its Pipeline run",
          };
        }
      } else {
        const owner = this.registry.taskResourceOwnerForSession(
          session.id,
          undefined,
          (candidate) =>
            candidate.id === task.id &&
            candidate.kind === "pipeline" &&
            (candidate.status === "running" || candidate.status === "dispatching"),
        );
        if (session.runtime !== "terminal" || owner?.id !== task.id || !session.pipeline) {
          return {
            ok: false,
            status: 403,
            error: "the terminal session does not prove ownership of this Pipeline task",
          };
        }
      }
      sessionPipeline = session.pipeline;
    }

    const provider = task.pipelineRun?.provider ?? sessionPipeline?.provider;
    const runLink: PipelineRunLink = {
      provider: target.provider,
      repoRoot: target.repoRoot,
      slug: target.slug,
    };
    if (
      !provider ||
      target.provider !== provider ||
      target.repoRoot !== task.repoRoot ||
      (task.pipelineRun?.repoRoot !== undefined && task.pipelineRun.repoRoot !== task.repoRoot)
    ) {
      return { ok: false, status: 409, error: "the task has no valid provider reservation" };
    }
    const targetKey = pipelineRunKeyOf(runLink);
    if (task.pipelineRun && pipelineRunKeyOf(task.pipelineRun) === targetKey) {
      return { ok: true, task, replayed: true };
    }
    const runs = this.registry.listPipelineRuns();
    if (
      task.pipelineRun &&
      (proof.kind === "terminal" ||
        runs.some((candidate) =>
          pipelineRunKeyOf(candidate) === pipelineRunKeyOf(task.pipelineRun!),
        ))
    ) {
      return {
        ok: false,
        status: 409,
        error: proof.kind === "terminal"
          ? `the terminal join cannot replace reserved Pipeline run "${task.pipelineRun.slug}"`
          : `the reserved Pipeline run "${task.pipelineRun.slug}" is already observed and cannot be reassigned`,
      };
    }
    const observed = runs.find((candidate) => pipelineRunKeyOf(candidate) === targetKey);
    if (!observed) {
      return {
        ok: false,
        status: 409,
        error: `Pipeline run "${target.slug}" is not observed in this task's repository`,
      };
    }
    if (
      proof.kind === "terminal" &&
      pipelineRunKeyOf(sessionPipeline!) !== targetKey
    ) {
      return {
        ok: false,
        status: 403,
        error: "the terminal session does not match the observed Pipeline run",
      };
    }

    const owner = this.registry.listTasks().find(
      (candidate) =>
        candidate.id !== task.id &&
        candidate.kind === "pipeline" &&
        (candidate.status === "running" || candidate.status === "dispatching") &&
        candidate.pipelineRun !== null &&
        pipelineRunKeyOf(candidate.pipelineRun) === targetKey,
    );
    if (owner) {
      return {
        ok: false,
        status: 409,
        error: `Pipeline run "${target.slug}" is already owned by active task ${owner.id}`,
      };
    }

    let adopted: Task;
    try {
      adopted = {
        ...task,
        pipelineRun: runLink,
        updatedAt: Date.now(),
      };
      this.registry.upsertTask(adopted);
    } catch (error) {
      return {
        ok: false,
        status: 409,
        error: `could not persist Pipeline run adoption: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (observed.group === "processed") this.settlePipelineTask(observed);
    return { ok: true, task: this.registry.getTask(task.id) ?? adopted, replayed: false };
  }

  /** Persist the provider-owned authoring checkout used by a managed Pipeline host. */
  reportPipelineWorkspace(
    taskId: string,
    requestedPath: string,
  ): PipelineWorkspaceReportResult {
    const task = this.registry.getTask(taskId);
    if (!task) return { ok: false, status: 404, error: "no matching Pipeline task" };
    if (
      task.kind !== "pipeline" ||
      (task.status !== "running" && task.status !== "dispatching")
    ) {
      return { ok: false, status: 409, error: "this task is not an active Pipeline task" };
    }
    if (!isAbsolute(requestedPath)) {
      return { ok: false, status: 409, error: "the Pipeline workspace path must be absolute" };
    }

    let workspace: string;
    let repoRoot: string;
    let worktreesRoot: string;
    try {
      workspace = realpathSync(requestedPath);
      repoRoot = realpathSync(task.repoRoot);
      worktreesRoot = realpathSync(join(repoRoot, ".worktrees"));
    } catch {
      return { ok: false, status: 409, error: "the Pipeline workspace path does not exist" };
    }
    const info = gitInfo(workspace);
    if (
      dirname(workspace) !== worktreesRoot ||
      info.root !== workspace ||
      info.repoRoot !== repoRoot
    ) {
      return {
        ok: false,
        status: 409,
        error: "the Pipeline workspace must be a direct .worktrees checkout of this task repository",
      };
    }

    const owner = this.registry.listTasks().find(
      (candidate) =>
        candidate.id !== task.id &&
        candidate.kind === "pipeline" &&
        (candidate.status === "running" || candidate.status === "dispatching") &&
        candidate.pipelineWorkspacePath === workspace,
    );
    if (owner) {
      return {
        ok: false,
        status: 409,
        error: `the Pipeline workspace is already owned by active task ${owner.id}`,
      };
    }
    if (task.pipelineWorkspacePath === workspace) {
      return { ok: true, task, replayed: true };
    }

    const updated = { ...task, pipelineWorkspacePath: workspace, updatedAt: Date.now() };
    try {
      this.registry.upsertTask(updated);
    } catch (error) {
      return {
        ok: false,
        status: 409,
        error: `could not persist Pipeline workspace: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    return { ok: true, task: this.registry.getTask(task.id) ?? updated, replayed: false };
  }

  /** Settle every live task durably correlated with a provider-completed run. */
  private settlePipelineTask(run: PipelineRun): void {
    if (run.group !== "processed") return;
    for (const task of this.registry.listTasks()) {
      if (
        task.kind !== "pipeline" ||
        (task.status !== "running" && task.status !== "dispatching") ||
        task.pipelineRun?.provider !== run.provider ||
        task.pipelineRun.repoRoot !== run.repoRoot ||
        task.pipelineRun.slug !== run.slug
      ) {
        continue;
      }
      this.completeInBackground(task.id, {
        outcome: run.prUrl ? `pipeline opened ${run.prUrl}` : `pipeline processed ${run.slug}`,
        outcomeUrl: run.prUrl ?? undefined,
        // A provider finishing or opening its pull request concludes this run, but it is not
        // evidence that the pull request merged. Declared dependencies retain the ordinary
        // merge-only satisfaction rule.
        satisfyDependents: false,
        requireStopped: false,
        confirmIncompleteScout: false,
        inferredFrom: null,
      });
    }
  }

  /**
   * Install the write-back enqueuer after both owners exist.
   *
   * A registration rather than a ninth positional constructor parameter, following
   * `registerWorkflowEvidenceEligibility` below: the many route-unit tests that construct a
   * bare `TaskManager` keep compiling unchanged, and a daemon that forgets to call this
   * simply writes nothing back - which is the same behaviour as every write-back switch
   * being off, and therefore not a state that can surprise anyone.
   */
  registerWritebackEnqueuer(enqueuer: WritebackEnqueuer): void {
    this.writeback = enqueuer;
  }

  /** Install the daemon's immutable workflow-graph eligibility reader after both owners exist. */
  registerWorkflowEvidenceEligibility(
    resolve: (task: Pick<Task, "kind" | "workflowId">) => boolean,
  ): void {
    this.workflowEvidenceEnabledForTask = resolve;
  }

  /**
   * A task's pull request merged. Settle it if its episode appears finished, and end its
   * agent if the operator asked for that.
   *
   * A merge is not proof the task is over: an agent may be mid-turn or roll onto more
   * work, and no timer can rule out a prompt that has not arrived yet. An idle, empty,
   * still-current episode is enough to conclude provisionally; `reopenIfWorkResumed`
   * reverses that inference if the agent contradicts it by working again. A working
   * session is left alone, while a session that later disappears settles through
   * `agentWentAway`.
   *
   * The disposition of the agent remains a separate preference. The shared idle-completion
   * path below applies it only AFTER the task has been recorded done, whether idleness came
   * before this event or later. `closeMergedSession` then rechecks the task and episode after
   * its asynchronous checkout-safety probe. Work resuming during that probe reopens the
   * inferred completion and cancels the close.
   *
   * Errors are swallowed to a log line: this runs inside the PR poller's reconciliation,
   * where a throw would abandon the rest of the sweep.
   */
  private settleMergedTask(e: TaskPrMerged): void {
    try {
      const t = this.registry.getTask(e.taskId);
      if (!t || (t.status !== "running" && t.status !== "dispatching")) return;
      if (providerOwnsTaskCompletion(t.kind)) return;
      const session = this.registry.getSession(e.sessionId);
      // The common ordering, and the one a `session_upsert` listener alone misses: the
      // agent finished its turn BEFORE the poller noticed the merge. Nothing further is
      // guaranteed to touch that session, so the same finished-episode question has to be
      // asked here too or the task stays running for ever. Both callers land on one
      // predicate rather than two that could drift.
      if (session) this.settleIfEpisodeFinished(session);
    } catch (error) {
      console.error("[merge] settling merged task failed:", e.taskId, error);
    }
  }

  /**
   * Land a merged task whose agent is still here but has finished the episode.
   *
   * The counterpart to `agentWentAway`, and the reason both exist: waiting for the agent
   * to go away is unimpeachable but it never arrives for the ordinary case, where an
   * agent ships its pull request and then sits idle forever. That session keeps a
   * `running` task, so `agentIsFree` refuses it and the backlog cannot reuse the agent -
   * which is the whole problem this change is about, left in place by the safe half of
   * the fix.
   *
   * So the episode is concluded on EVIDENCE that it finished, never on a clock:
   *
   *  - the agent is idle, so its turn is over rather than merely paused;
   *  - its work queue is empty, so nothing pending is about to continue this task;
   *  - the merged episode is still its CURRENT one, so it has not already rolled onto
   *    new work (this live-session gate does not apply after `agentWentAway`);
   *  - and a merge is durably recorded against that binding.
   *
   * An idle agent can still be wrong about being finished - it may be idle only because
   * nobody has typed yet. That is why this conclusion is REVERSIBLE: see
   * `reopenIfWorkResumed`. Every other route to `done` is a human's and stays put.
   */
  private settleIfEpisodeFinished(s: Session): void {
    if (s.state !== "idle") return;
    if (s.queue && s.queue.openCount > 0) return;
    // The one task this agent is executing, per the serial invariant - never "the task
    // this session ever ran", which is what the bindings are for.
    const t = this.executingTaskOn(s.id);
    if (!t) return;
    if (providerOwnsTaskCompletion(t.kind)) return;
    const binding = taskWorkEpisodeForTask(t.id);
    if (!binding) return;
    // Rolled onto new work since the merge - not ours to conclude while the agent is still
    // HERE. This is deliberately narrower than `mergedPrFor`, and the asymmetry is the point:
    // a present agent that got a follow-up prompt may still be mid-turn, so an intermediate
    // merge is not yet its outcome; a DEPARTED agent (which is what `mergedPrFor`/`agentWentAway`
    // answer for) has no such turn left, so any merge it produced IS the outcome. So this
    // path keeps the episode-currency gate and reads only THIS episode's evidence.
    const current = this.registry.workEpisodeForSession(s.id);
    if (current && current.episodeId !== binding.episodeId) return;
    // This episode's own work has to have landed, and for a multi-repo task that is any repo
    // it shipped rather than the PRIMARY specifically. Gating on the primary's own binding -
    // the only thing this line used to read - meant a task that never touched the primary
    // could not finish here at all: it had no primary pull request to merge, so it sat
    // `running` holding its agent's slot until the session went away, contradicting the
    // exemption every other path grants an untouched repo.
    if (!this.currentEpisodeLanded(t, binding)) return;
    const outcome = this.liveEpisodeOutcome(t, binding);
    if (!outcome) return;
    // Backgrounded rather than awaited because this runs inside a `session_upsert` listener.
    // For a ship task the whole completion - status, broadcast, and the `autoCompleted`
    // provenance that makes it reversible - still happens synchronously inside this call, so
    // the reopen path sees exactly what it always did. For a scout it lands once the archive
    // is verified, which is the only ordering that can be true: a scout is not done until its
    // report is durable.
    this.completeInBackground(t.id, {
      outcome: outcome.outcome,
      outcomeUrl: outcome.url,
      satisfyDependents: false,
      requireStopped: false,
      confirmIncompleteScout: false,
      inferredFrom: s.id,
    }, undefined, () => {
      this.closeMergedSessionAfterCompletion({
        taskId: t.id,
        sessionId: s.id,
        episodeId: binding.episodeId,
      });
    });
  }

  /**
   * Conclude a recurring mission's generated task on Foreman's own settled verdict.
   *
   * The gap this closes. Every existing route to `done` for an autonomous task runs through a
   * merged pull request - `settleIfEpisodeFinished`, `settleMergedTask`,
   * `reconcileMergedTasks` all read `currentEpisodeLanded`. A recurring mission whose run has
   * nothing to ship produces no pull request to merge: the sweep found nothing, the report was
   * written, the audit came back clean. That task never leaves `running`, and under the
   * default `skip-active` overlap policy it then blocks every later occurrence of the same
   * mission for ever - the exact failure the cadence exists to prevent, recorded run after run
   * as `skipped_overlap` naming a task that finished its work weeks ago.
   *
   * Four gates, and each one is refusing a different wrong answer:
   *
   *  - **The verdict must be a conclusion, not a step.** `foremanConcludedMission` owns that
   *    list; a `held` verdict is Foreman saying the work is UNFINISHED, and an `asked` or
   *    `direct_handoff` says shipping is still under way and the merge path still owns it.
   *  - **The task must be a mission's.** `scheduleOccurrenceId` is what makes this policy
   *    reachable at all: an ordinary dispatched task's completion stays the operator's, and
   *    nothing here changes what happens to one.
   *  - **The mission must have asked for it.** The policy is read from the immutable revision
   *    that FILED this task, so an edit or an archive since then cannot retroactively conclude
   *    work in flight, and an unreadable stored value leaves the task alone.
   *  - **Provider-owned completion is never overridden**, exactly as the merge paths refuse it.
   *
   * TERMINAL, and deliberately not registered as an inference. This used to pass
   * `inferredFrom` so `reopenIfWorkResumed` could undo it, on the same bargain
   * `settleIfEpisodeFinished` makes about idleness - and for a mission run that bargain was
   * the bug. The completion left the agent alive: it kept its context and its slot, it was
   * still free to be prompted, and a prompt an hour later reopened a task Foreman had
   * concluded and the operator had seen finish. Observed in the field over three consecutive
   * hourly runs, one of which took new work thirty-five minutes after its conclusion.
   *
   * So the conclusion and the closure of the agent that produced it are ONE boundary. The
   * completion lands, `openTaskSessionClosure` records that the session is owed a close, and
   * `settleMissionSessionClosure` keeps asking until nothing live answers to that id. Reopening
   * has nothing left to be true about: the session this would have handed the task back to is
   * the session being closed, and until it goes `promptResourceBlockerForSession` refuses to
   * deliver anything to it.
   *
   * The two evidence bases really are different, which is what makes the asymmetry honest
   * rather than an inconsistency with `settleIfEpisodeFinished`. That path concludes on
   * IDLENESS - an agent that has not been typed at yet looks exactly like one that is
   * finished - so it must be reversible. This one concludes on a settled verdict Foreman
   * recorded ABOUT this generation, against a mission whose operator asked in advance for
   * exactly this, and its own recurrence is what makes a lingering session compound.
   *
   * Non-throwing, and it AWAITS the first close attempt rather than leaving one scheduled: the
   * agent is asked to go inside the request that concluded it, so there is no asynchronous gap
   * between "this run is over" and "something started closing it". The completion itself is
   * still backgrounded - this is called from a route that has already committed the durable
   * consumption, and a scout whose archive is not submitted yet simply stays running rather
   * than failing the request that reported the verdict.
   */
  async concludeScheduledMissionRun(
    sessionId: string,
    decision: PromptedCompletionDisposition,
  ): Promise<void> {
    if (!foremanConcludedMission(decision.outcome)) return;
    const t = this.executingTaskOn(sessionId);
    if (!t || !t.scheduleOccurrenceId) return;
    if (providerOwnsTaskCompletion(t.kind)) return;
    if (completionPolicyForOccurrence(t.scheduleOccurrenceId) !== "auto-on-conclusion") return;
    // A concluded run that DID open a pull request has to carry it, and this is the only
    // chance to record one: `completableByMerge` excludes `done`, so once this row is
    // terminal the merge reconciler will never revisit it, and a later merge has nowhere
    // to write itself. Without this the ordinary `retired` case - a review-only artifact
    // that still opened a PR for its diff - lands a `done` task pointing at nothing.
    //
    // Read from the same bindings every merge path reads, so the url on the card is the
    // one those paths would have recorded. Absent for the `empty` case by construction,
    // which is the case with no pull request to name.
    const pr = primaryRepoPrForTask(t.id).prUrl;
    this.completeInBackground(t.id, {
      outcome: missionRunOutcome(decision),
      ...(pr ? { outcomeUrl: pr } : {}),
      satisfyDependents: false,
      requireStopped: false,
      confirmIncompleteScout: false,
      inferredFrom: null,
      // The other half of the boundary, written in the same transaction as the `done` row.
      closeSessionId: sessionId,
    });
    // AWAITED, and aimed at THIS run's own closure rather than routed through the shared sweep.
    //
    // The point of awaiting is a guarantee about one session: the agent is asked to stop before
    // the request that concluded it returns, so no interval opens in which the run is over, the
    // card is still up, and nothing has begun closing it. That is the interval the reported
    // failure lived in.
    //
    // The whole-table sweep cannot carry that guarantee, and it took a review to see why. It is
    // mutex-guarded, so a pass already in flight - a retry, the zero-delay pass `session_remove`
    // kicks, another mission concluding in the same tick - makes this call return having asked
    // nobody, deferring the ask to whenever that other pass finishes. And when it does run, it
    // walks every owed row, so this request would wait out the stop budget of closures that have
    // nothing to do with it.
    //
    // Settling one row directly costs the ordinary case nothing and can at worst duplicate an
    // attempt a concurrent sweep is already making. That is harmless in every arm: the
    // supervisor dedupes a stop it is already running, a repeated terminal kill is idempotent,
    // `beginEviction` keeps the deadline it already had, and the only visible cost is an inflated
    // attempt count on a row that is being closed anyway.
    //
    // Only when the session is actually here. Absence is what CLOSES a closure, and a session
    // this daemon has not observed yet is not an absent one - that judgement belongs to the
    // sweep, behind the discovery gate.
    try {
      const owed = getTaskSessionClosure(t.id);
      if (owed && this.registry.getSession(sessionId)) {
        await this.settleMissionSessionClosure(owed);
      }
    } catch (error) {
      // The closure is durable, so a first attempt that could not even be made costs nothing
      // but time: the row is still owed and the sweep will come back to it. What must not
      // happen is this failing the request that reported the verdict, which has already
      // committed the durable consumption behind it.
      console.warn(`[mission] could not begin closing session ${sessionId}:`, error);
    }
    // Arm the cadence for whatever is still owed - this row if it was not confirmed, and any
    // other. `finishCompletion` deliberately schedules nothing, so this is where it starts.
    //
    // Inside the same guard as the settle above: reading the ledger is the very thing that
    // fails when the ledger is what is broken, and this must not be the throw that escapes a
    // route which has already committed its durable consumption.
    try {
      if (listTaskSessionClosures().length > 0) this.scheduleMissionSessionClosureSweep();
    } catch (error) {
      console.warn(`[mission] could not arm the closure sweep for ${sessionId}:`, error);
    }
  }

  /**
   * Ask the sweep to run, once, after `delayMs`.
   *
   * A `setTimeout` chain rather than a `setInterval`, for the reason `startScheduleManager` is
   * one: the next sleep is scheduled from the END of a pass, so a pass that waits on a driver
   * stop cannot have a second one started on top of it. Unref'd, so an owed closure never holds
   * the process open - it is durable, and the next daemon picks it up.
   *
   * Nothing schedules itself while the ledger is empty, which is why every test that never
   * concludes a mission run pays nothing for this.
   *
   * An EARLIER request replaces a later one, which is not a refinement - it is the difference
   * between confirming a closure now and confirming it a retry interval from now. `session_remove`
   * asks for zero, and it is the one signal that can actually settle a row; dropping it because
   * a routine ten-second retry was already pending would leave the ledger claiming a live agent
   * that the registry has just deleted, and the operator reading that.
   */
  private scheduleMissionSessionClosureSweep(
    delayMs: number = MISSION_SESSION_CLOSURE_RETRY_MS,
  ): void {
    if (this.closuresStopped) return;
    const dueAt = Date.now() + delayMs;
    if (this.closureTimer) {
      if (this.closureDueAt !== null && this.closureDueAt <= dueAt) return;
      clearTimeout(this.closureTimer);
    }
    this.closureDueAt = dueAt;
    this.closureTimer = unref(setTimeout(() => {
      this.closureTimer = null;
      this.closureDueAt = null;
      void this.sweepMissionSessionClosures();
    }, delayMs));
  }

  /** Stop scheduling closure sweeps. Owed closures stay in SQLite for the next daemon. */
  stopMissionSessionClosures(): void {
    this.closuresStopped = true;
    if (this.closureTimer) clearTimeout(this.closureTimer);
    this.closureTimer = null;
    this.closureDueAt = null;
  }

  /**
   * One pass over every owed closure, and the reschedule that keeps the guarantee alive.
   *
   * Exported to the daemon only through the timer and the two registry signals that kick it;
   * it is public for the tests, which drive it directly rather than waiting out a real cadence.
   *
   * Gated on the first COMPLETED discovery sweep, and that gate is the whole of restart
   * recovery. Before it, a session missing from the registry has not been observed to be gone -
   * the process table has not been read yet - and clearing a row there would abandon exactly
   * the closure a restart exists to resume.
   */
  async sweepMissionSessionClosures(): Promise<void> {
    if (!this.completedInitialSessionSweep) return;
    // A pass asked for while one is already running is REMEMBERED rather than dropped, and
    // that is not tidiness. The urgent caller is `interceptWorkOnClosingSession`: an agent we
    // are closing has started working, and the answer must not be "in up to ten seconds".
    // Dropping the request left exactly that, because the running pass then rescheduled on
    // the ordinary retry interval and the news that a turn had started was already gone.
    if (this.sweepingClosures) {
      this.sweepUrgentlyRequested = true;
      return;
    }
    this.sweepingClosures = true;
    try {
      for (const row of listTaskSessionClosures()) {
        await this.settleMissionSessionClosure(row);
      }
    } finally {
      this.sweepingClosures = false;
      const urgent = this.sweepUrgentlyRequested;
      this.sweepUrgentlyRequested = false;
      if (listTaskSessionClosures().length > 0) {
        this.scheduleMissionSessionClosureSweep(urgent ? 0 : MISSION_SESSION_CLOSURE_RETRY_MS);
      }
    }
  }

  /**
   * Settle one owed closure: drop it, confirm it, or try again.
   *
   * The order of the three questions is the correctness argument.
   *
   *  - **Is it still ours?** A task that was removed, rescheduled, or handed to another session
   *    is not a closure this ledger can act on, and holding the row would let a later sweep
   *    kill an agent that is legitimately working. Dropped without a stop.
   *  - **Is the session already gone?** This is the ONLY thing that closes a row. `stopSession`
   *    answering ok is a request that was serviced, not an agent that has left - the registry
   *    lingers an exited session before removing it, a terminal kill can be refused by the
   *    multiplexer after the write, and a driver can throw on the way down. So absence is
   *    observed rather than inferred, which is what "if closure cannot be confirmed, retry"
   *    actually requires.
   *  - **Otherwise, stop it again** - and, past `MISSION_SESSION_CLOSURE_ESCALATE_MS`, retire it
   *    rather than keep asking. Asking is not a guarantee: a multiplexer can refuse a kill, and
   *    a driver can accept a stop and then not go. Retrying a refused request until the heat
   *    death of the fleet is not "the session is removed within four minutes", it is a promise
   *    the daemon never keeps, so the last resort goes through `Registry.beginEviction` - the
   *    one producer of `session_remove` - and the refusal stays on the record.
   *
   * Every attempt is counted, and a refusal - or a stop that was accepted and did not take -
   * is recorded as a bounded sentence that reaches the operator through the task's
   * automatic-cleanup summary for as long as the closure is outstanding.
   *
   * The worktree is deliberately NOT touched here, which is the difference from
   * `closeMergedSession`. A merge proves the committed work landed, so that path may reclaim a
   * checkout it can prove is safe. A concluded mission run proves the opposite: `empty` means
   * nothing was committed at all, so anything in that tree is unpushed work. It stays, the
   * 30-day retention clock owns it exactly as it owns every other terminal task's, and the
   * closure is finished either way - the session's fate never waits on the tree's.
   */
  private async settleMissionSessionClosure(row: TaskSessionClosureRow): Promise<void> {
    // SQLite, not `registry.getTask`. The in-memory task map is BOUNDED and evicts terminal
    // rows (see `pruneTerminalTasks`), so a mission task that finished a while ago is exactly
    // the one this would fail to find - and "not in memory" would then be read as "no longer
    // ours" and drop a closure that is still owed, silently, for the runs that waited longest.
    const task = getDurableTask(row.taskId);
    if (!task || task.status !== "done" || task.sessionId !== row.sessionId) {
      this.dropMissionSessionClosure(row.taskId);
      return;
    }
    const session = this.registry.getSession(row.sessionId);
    if (!session) {
      this.dropMissionSessionClosure(row.taskId);
      return;
    }
    // Already on its way out - the stop landed and the registry is lingering the card before
    // it removes it. Asking again would be answered "this session has no live embedded driver"
    // and recorded as a refusal, which is a sentence about our own timing rather than about
    // anything the operator could act on. Wait for `session_remove`, which is due in seconds.
    if (session.state === "exited") return;
    const stopped = await this.stopWithinBudget(session);
    const now = Date.now();
    const overdue = now >= row.requestedAt + MISSION_SESSION_CLOSURE_ESCALATE_MS;
    // A stop this pass ACCEPTED, on a session that is still here well past the point one should
    // have taken, is its own kind of refusal and is recorded as one. Without this the summary
    // would go quiet for exactly the case it is most needed on - a driver that says yes and
    // does nothing - because there was no error to publish.
    const refusal = stopped.ok
      ? (overdue ? "the agent accepted the stop and did not leave" : null)
      : closureRefusal(stopped);
    recordTaskSessionClosureAttempt(row.taskId, now, refusal);
    // The summary only says anything once an attempt has been refused or the guarantee has
    // passed, so the ordinary close publishes nothing and a stuck one publishes on every pass.
    this.registry.refreshTaskAutomaticCleanup(row.taskId);
    if (!overdue) return;
    // `stopSession` may have awaited a driver all the way down, so ask the registry again
    // rather than escalating against the session as it looked before the stop.
    if (!this.registry.retireConcludedMissionSession(row.taskId, row.sessionId)) return;
    console.warn(
      `[mission] task ${row.taskId}: session ${row.sessionId} would not close after ` +
        `${row.attempts + 1} attempts (${refusal ?? "no reason recorded"}) - retiring it to keep ` +
        "the mission's completion boundary. If its agent survived, it is no longer Mission " +
        "Control's, and the task stays done.",
    );
  }

  /**
   * Cut short a turn that started on a session Mission Control has already finished with.
   *
   * `promptResourceBlockerForSession` refuses every prompt this daemon would DELIVER, and that
   * is the whole of what a delivery boundary can promise. It is not the whole of what happens:
   * a person can type straight into the pane, and the agent's own harness accepts that prompt
   * and fires `UserPromptSubmit` without asking us. That is not a hypothetical - it is the
   * reported failure, where a concluded mission run took a prompt thirty-five minutes after
   * its conclusion and finished another whole generation six minutes later.
   *
   * So the transition itself is treated as the signal it is: an agent we are in the middle of
   * closing has started working again, and the closure that was going to happen on its next
   * ten-second tick happens NOW instead. What this can honestly promise is bounded and worth
   * stating - a prompt already accepted by the agent's own harness cannot be un-accepted, so
   * the guarantee is that the turn does not get to run, not that the keystroke never landed.
   *
   * Costs one indexed lookup on a normally-empty table, and only for a session that has just
   * gone to work.
   */
  private interceptWorkOnClosingSession(s: Session): void {
    if (s.state !== "working") return;
    if (!taskSessionClosureForSession(s.id)) return;
    this.scheduleMissionSessionClosureSweep(0);
  }

  /**
   * Ask a session to stop, and stop waiting after `MISSION_SESSION_CLOSURE_STOP_TIMEOUT_MS`.
   *
   * A timed-out attempt is reported as a REFUSAL rather than a success, which is the honest
   * reading and also the useful one: the sweep goes on to count it, publish it, and - once the
   * escalation instant has passed - retire the session itself. Retirement goes through the
   * registry and needs nothing from the driver, so it works precisely when the driver is the
   * thing that is stuck.
   *
   * The losing promise is left running with its rejection absorbed. There is no cancellation
   * to reach for - neither a driver's `stop()` nor a multiplexer kill takes an abort signal -
   * so the choice is between waiting for ever and letting it finish unobserved. A stop that
   * eventually lands is harmless: the session leaves, `session_remove` confirms the closure,
   * and the ledger row is cleared by the pass that sees the absence.
   */
  private async stopWithinBudget(session: Session): Promise<ActionResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<ActionResult>((resolve) => {
      timer = unref(setTimeout(
        () => resolve({ ok: false, error: "the stop did not answer within its budget" }),
        MISSION_SESSION_CLOSURE_STOP_TIMEOUT_MS,
      ));
    });
    const attempt = stopSession(session, this.supervisor, this.closeMergedSessionDeps.kill)
      .catch((error: unknown): ActionResult => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    try {
      return await Promise.race([attempt, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Close the ledger on a task that no longer owes a session, and refresh what a browser reads. */
  private dropMissionSessionClosure(taskId: string): void {
    clearTaskSessionClosure(taskId);
    this.registry.refreshTaskAutomaticCleanup(taskId);
  }

  /**
   * Put back a task this class concluded, when its agent turns out to be working again.
   *
   * The honest answer to the one thing an idle agent cannot tell us. Concluding on
   * idleness is what makes a shipped agent reusable at all, but idleness is not proof
   * the work is over - the operator may simply not have typed yet. Landing an
   * intermediate pull request, reading the diff, and then saying "now do the follow-up"
   * is an ordinary sequence, and it produces a terminal task while its agent works on.
   *
   * Rather than guess for longer before concluding - every fixed window is outrunnable,
   * which is what the timer this replaced got wrong - the conclusion is simply undone
   * once the agent contradicts it. The evidence is unambiguous and it is the agent's
   * own: it is working again on the very task we called finished.
   *
   * Only tasks THIS class auto-completed are eligible, tracked in `autoCompleted`. An
   * outcome a human recorded is a statement about the work, not an inference from
   * idleness, and nothing here may overwrite one. The set is in memory on purpose: after
   * a restart nothing is reopened, which is the conservative direction - a task that
   * stays `done` is the state the whole feature exists to reach.
   *
   * It has to be the agent working on THAT task, not merely the same agent - and it is,
   * without a clause of its own. A session runs tasks serially, so once it has taken
   * another task the agent typing again is typing at the NEW one; reopening the finished
   * row there would double-book it. What rules that out is the exclusive pointer rather
   * than a guard here: claiming the next task moves `sessionId` off the completed row
   * (`upsertTask`), so the `find` below no longer matches it, and the `task_upsert`
   * listener in the constructor drops it from `autoCompleted` on that same write. Two
   * independent reasons, both structural. A guard was tried and removed as dead code -
   * it could not be made to fire. Pinned by `task-multi-session.test.ts`, which is what
   * would catch a future writer of the pointer that skipped `upsertTask`.
   */
  private reopenIfWorkResumed(s: Session): void {
    if (s.state !== "working") return;
    const t = this.registry.listTasks().find(
      (task) =>
        task.sessionId === s.id &&
        task.status === "done" &&
        this.autoCompleted.get(task.id) === s.id,
    );
    if (!t) return;
    this.autoCompleted.delete(t.id);
    this.registry.upsertTask({
      ...t,
      status: "running",
      outcome: null,
      outcomeUrl: null,
      completedAt: null,
      updatedAt: Date.now(),
    });
  }

  /**
   * The newest pull request any of this task's work episodes produced, if one was observed
   * merged - or null.
   *
   * The durable-record contract: a merge on ANY of this task's episodes is durable
   * completion evidence, and the session's CURRENT episode is irrelevant to the
   * session-independent consumers. They wait for a live `running`/`dispatching` turn to
   * disappear, while already-concluded `failed`/`cancelled` rows need no liveness gate.
   * Read from `task_work_episode_bindings` AND `historical_task_work_episode_bindings`, both
   * stamped by `markWorkEpisodeMerged` at the moment the merge is seen. That is the durable
   * acknowledgement the settle needs: it survives a restart, it cannot be outrun by a
   * prompt arriving later, and unlike a timer it is a FACT rather than an inference.
   *
   * This reverses the earlier "current binding only" rule deliberately (adopted plan
   * decision). That rule read only the current binding so that a task whose episode rolled
   * over after its merge stayed `failed` - the reasoning being the agent was handed more
   * work and then vanished mid-flight. Its consumers, `agentWentAway` and
   * `reconcileMergedTasks`, only use this to conclude a `running`/`dispatching` task once
   * the session is GONE, so there is no "more work" in progress to strand; the reconciler
   * also upgrades already-concluded `failed`/`cancelled` rows. Reporting any of those as a
   * stopped blocker strands every dependent for work that shipped. When several episodes
   * merged (a fix-forward task can open more than one PR), the NEWEST `mergedAt` is the
   * outcome to display.
   */
  private mergedPrFor(taskId: string): string | null {
    const current = taskWorkEpisodeForTask(taskId);
    const candidates = [
      ...(current ? [current] : []),
      ...historicalTaskWorkEpisodeBindingsForTask(taskId),
    ];
    let best: { mergedAt: number; prUrl: string } | null = null;
    for (const binding of candidates) {
      if (binding.mergedAt === null || !binding.prUrl) continue;
      if (best === null || binding.mergedAt > best.mergedAt) {
        best = { mergedAt: binding.mergedAt, prUrl: binding.prUrl };
      }
    }
    return best?.prUrl ?? null;
  }

  /**
   * The adopted all-merged quorum for one MULTI-repo task: has every repository it changed
   * had its pull request merged?
   *
   * The facts are gathered here and the RULE lives in `@shared/task-repos.ts`, which is the
   * whole point of that module: per-repo review runs decide what to review from the same
   * changed-set predicate, and two implementations of "changed" would eventually disagree
   * about whether a repository's work had shipped.
   *
   * Read from durable state rather than from the in-memory row, deliberately. The projection
   * onto `Task.extraRepos` exists for surfaces; a completion is irreversible, so it asks the
   * tables. Heads come from the poller's sweep - a worktree nobody has looked at yet reads as
   * "unknown" and HOLDS, which is what stops a restart completing a task on one merged
   * sibling before anything has looked at the others.
   */
  private mergeQuorumFor(t: Task): QuorumVerdict {
    const primary = primaryRepoPrForTask(t.id);
    const task = { ...t, extraRepos: taskReposFor(t.id) };
    return taskMergeQuorum(task, (ref) => {
      const entry = ref.role === "primary" ? null : task.extraRepos[ref.position - 1];
      return {
        prUrl: entry ? entry.prUrl : primary.prUrl,
        mergedAt: entry ? entry.mergedAt : primary.mergedAt,
        headSha: this.registry.worktreeHead(ref.worktreePath),
      };
    });
  }

  /**
   * The outcome a merged pull request records for this task, or null while it is not over.
   *
   * The single fork between the one-repo world and the many-repo one, and single-repo takes
   * the branch it always took: `mergedPrFor`, unchanged, so every existing rule about which
   * merge counts and which status a merge upgrades is untouched for the tasks that are
   * nearly all of them.
   *
   * A multi-repo task instead asks the quorum, and `outcome` then names EVERY pull request
   * that landed, in repo order. `outcomeUrl` stays the primary's, which is what every
   * existing consumer of that field means by it - falling back to the first merged only when
   * the primary repository was not one of the ones that changed.
   */
  private mergeOutcomeFor(t: Task): { outcome: string; url: string } | null {
    const merged = this.mergedPrFor(t.id);
    if (t.extraRepos.length === 0) {
      return merged ? { outcome: `merged ${merged}`, url: merged } : null;
    }
    const quorum = this.mergeQuorumFor(t);
    return quorum.satisfied ? quorumOutcome(quorum, merged) : null;
  }

  /**
   * Did the episode this agent is on right now actually ship something?
   *
   * The generalisation of the single-repo rule this used to be spelled as - "the current
   * binding's own pull request merged" - to a task with several. It is what keeps a LIVE
   * agent's intermediate merge from concluding work it is still in the middle of: evidence
   * from an episode the task has already rolled past is enough for a departed agent
   * (`mergedPrFor` reads it) and deliberately not enough here.
   *
   * The primary's merge lives on the binding; a secondary's lives on the episode's own row,
   * and either one counts. Requiring the PRIMARY's specifically is the bug this replaced.
   */
  private currentEpisodeLanded(t: Task, binding: TaskWorkEpisodeBinding): boolean {
    if (binding.mergedAt !== null && binding.prUrl) return true;
    if (t.extraRepos.length === 0) return false;
    return workEpisodeRepoPrsForTask(t.id).some(
      (row) => row.episodeId === binding.episodeId && row.mergedAt !== null,
    );
  }

  /** The outcome to record for a task settled while its agent is still here and idle. */
  private liveEpisodeOutcome(
    t: Task,
    binding: TaskWorkEpisodeBinding,
  ): { outcome: string; url: string } | null {
    if (t.extraRepos.length === 0) {
      return binding.prUrl && binding.mergedAt !== null
        ? { outcome: `merged ${binding.prUrl}`, url: binding.prUrl }
        : null;
    }
    const quorum = this.mergeQuorumFor(t);
    return quorum.satisfied ? quorumOutcome(quorum, binding.prUrl) : null;
  }

  /**
   * Complete every task whose durable record shows a merged pull request, whatever became
   * of the session that produced it.
   *
   * The single owner of pull-request-driven completion, and the answer to the requirement
   * the two session-shaped paths could not reach between them: `settleIfEpisodeFinished`
   * needs an agent that is here and idle, `agentWentAway` needs the exact moment one is
   * evicted. A task whose agent was killed while the daemon was down, or whose merge only
   * happened days after everyone stopped looking, met neither - and sat behind a `stopped`
   * blocker holding up every dependent for work that had shipped.
   *
   * Three rules, each load-bearing:
   *
   *  - **A live agent is left to the narrower path.** While the session that owns a
   *    `running` task is still on the process table, the merge is not necessarily its
   *    outcome: an agent routinely lands an intermediate pull request and carries on, so
   *    only `settleIfEpisodeFinished`'s idle-and-still-on-that-episode evidence may
   *    conclude it, and that conclusion stays reversible. This path is what happens
   *    afterwards, when there is no turn left to interrupt.
   *  - **`failed` and `cancelled` are upgraded**, per `completableByMerge`. Those statuses
   *    record what was concluded before anyone could see the pull request merge, and a
   *    merge is evidence that outranks it. `complete` clears the error, records the pull
   *    request as the outcome, and keeps the worktree and terminal home for the operator's
   *    confirmed Clean up - freeing a checkout stays a human's click.
   *  - **The completion is NOT registered in `autoCompleted`.** `reopenIfWorkResumed`
   *    exists to reverse an inference drawn from idleness; this one is drawn from a merged
   *    pull request. An agent typing again must not resurrect a task whose work landed.
   *
   * `satisfyDependents` is on for the same reason `satisfyDeclaredEdgesTo` writes on the
   * edge: terminal rows are eventually pruned, so a completion recorded only in this task's
   * row stops being readable and every dependent silently re-blocks.
   *
   * Idempotent, and it must stay that way - it runs from four signals. A `done` task is
   * never revisited, and a merge already recorded costs one indexed read per task.
   */
  reconcileMergedTasks(): void {
    // Completing re-enters here: `complete` upserts, which resyncs the bound session, which
    // emits `session_upsert`, which this class listens to. The inner pass would re-scan the
    // same rows the outer loop is still walking, so it is refused and the outer pass simply
    // carries on to them.
    if (this.reconcilingMergedTasks) return;
    this.reconcilingMergedTasks = true;
    try {
      for (const { id } of this.registry.listTasks()) {
        // Re-read rather than trusting the snapshot: a completion mid-loop can settle
        // another row through that same re-entrancy, and can evict a terminal one entirely.
        const t = this.registry.getTask(id);
        if (!t || !completableByMerge(t.status)) continue;
        if (providerOwnsTaskCompletion(t.kind)) continue;
        // A reschedule mid-teardown holds a cancelled/failed row it is about to re-file as
        // backlog. `complete` throws on that, and this runs inside event listeners and the
        // PR poller's reconciliation, where a throw abandons the rest of the sweep.
        if (this.reschedulingTasks.has(t.id)) continue;
        if (this.agentMayStillBeUndiscovered(t)) continue;
        if (this.agentIsStillHere(t)) continue;
        // The one fork: a single-repo task completes on its merge exactly as it always has,
        // a multi-repo one only once every repository it changed has landed.
        const outcome = this.mergeOutcomeFor(t);
        if (!outcome) continue;
        // A ship task still settles inside this iteration; a scout's settles once its archive
        // is verified, and a scout that has not submitted one is simply not completed by this
        // sweep. Either way the sweep is not abandoned, which is what the background form buys
        // over an `await` this synchronous, re-entrant loop could not take.
        this.completeInBackground(t.id, {
          outcome: outcome.outcome,
          outcomeUrl: outcome.url,
          satisfyDependents: true,
          requireStopped: false,
          confirmIncompleteScout: false,
          inferredFrom: null,
        });
      }
    } finally {
      this.reconcilingMergedTasks = false;
    }
  }

  /**
   * Before the first completed discovery sweep, an absent session map entry means the
   * process table has not been authoritatively observed, not that the task's agent is gone.
   */
  private agentMayStillBeUndiscovered(t: Task): boolean {
    return (
      !this.completedInitialSessionSweep &&
      (t.status === "running" || t.status === "dispatching")
    );
  }

  /**
   * Is the agent that was executing this task still on the process table?
   *
   * Only asked of live statuses: a `failed` or `cancelled` task may still name the session
   * it ran on (`cancel` leaves `sessionId` alone), and that agent being alive says nothing
   * about a status something already concluded.
   */
  private agentIsStillHere(t: Task): boolean {
    return (
      (t.status === "running" || t.status === "dispatching") &&
      t.sessionId !== null &&
      this.registry.getSession(t.sessionId) !== undefined
    );
  }

  /** Apply the operator's preference after either merge/idle event ordering completes. */
  private closeMergedSessionAfterCompletion(e: MergedSessionRef): void {
    if (!getShippingConfig().closeSessionAfterMerge) return;
    void this.closeMergedSession(e).catch((error: unknown) => {
      console.error("[merge] closing merged session failed:", e.taskId, error);
    });
  }

  /**
   * Close the agent of a task that was completed after its merge, and reclaim its
   * checkout if that is safe.
   *
   * Two separate judgements. Closing is allowed only while the session is still idle,
   * its task is already done, and it still owns this merged episode. The checkout-safety
   * probe awaits filesystem work, so all four facts are re-read afterwards; a follow-up
   * prompt during the probe reopens an inferred completion and cancels the close instead
   * of terminating a working agent.
   *
   * Reclaiming is not. A merge proves the COMMITTED work landed; it says nothing about
   * uncommitted edits or untracked files still sitting in that checkout, and `reclaim`
   * runs `git worktree remove --force` over them. So the tree is freed only when the same
   * `resetWouldDestroyWork` probe the assign path consults says there is nothing to lose,
   * and otherwise kept - the row stays visible with Clean up on it, exactly as a killed
   * session's does. That is the house rule holding: freeing a tree is the operator's call
   * whenever anything could be lost by it.
   */
  private async closeMergedSession(e: MergedSessionRef): Promise<void> {
    const session = this.registry.getSession(e.sessionId);
    if (!session) return;
    // Probed BEFORE the kill: the answer is about the checkout, and asking first keeps
    // the reason readable in the log even when the kill races the process away.
    const holding = await this.closeMergedSessionDeps.resetWouldDestroyWork(session);
    const currentSession = this.registry.getSession(e.sessionId);
    const currentTask = this.registry.getTask(e.taskId);
    const currentEpisode = this.registry.workEpisodeForSession(e.sessionId);
    if (
      !currentSession ||
      currentSession.state !== "idle" ||
      (currentSession.queue?.openCount ?? 0) > 0 ||
      currentTask?.sessionId !== e.sessionId ||
      currentEpisode?.episodeId !== e.episodeId ||
      currentTask.status !== "done" ||
      this.autoCompleted.get(e.taskId) !== e.sessionId
    ) {
      return;
    }
    const killed = await stopSession(
      currentSession,
      this.supervisor,
      this.closeMergedSessionDeps.kill,
    );
    if (!killed.ok) {
      throw new Error(killed.error ?? "could not close the merged task's session");
    }
    if (holding !== null) {
      console.log(
        `[merge] task ${e.taskId}: session closed, checkout kept - ${holding}. ` +
          "Clean up on the task row frees it.",
      );
      return;
    }
    await this.reclaim(e.taskId);
  }

  list(): Task[] {
    return this.registry.listTasks();
  }

  /**
   * Settle every task bound to a session that is gone for good.
   *
   * A `running` task used to be reconciled ONLY on a daemon restart, so until this existed
   * a killed session left a row claiming to be executing - and holding a worktree and a
   * terminal home that nothing would ever offer to reclaim. The Foreman already had to
   * defend against exactly that (`inFlightTasks` re-reads the session list because such a
   * row "is a row nothing will ever move"), which treated the symptom at one reader while
   * every other reader - the board, the report, `agentIsFree` - still believed the row.
   *
   * EVERY row carrying the id, not the first one found: a terminal row may still name the
   * session it ran on, and `agentWentAway` is a no-op on those, so the loop costs nothing
   * and cannot miss the live one. It runs AFTER `reconcileMergedTasks` at both call sites,
   * which is the ordering that matters - completion by merge outranks "ended with no
   * outcome recorded", and `agentWentAway` keeps its own `mergedPrFor` check as the belt.
   */
  private reconcileTasksBoundTo(sessionId: string): void {
    for (const t of this.registry.listTasks()) {
      if (t.sessionId === sessionId) this.agentWentAway(t);
    }
  }

  /** The same reconciliation for a restart: whatever the first completed sweep did not find. */
  private reconcileTasksWithNoLiveSession(): void {
    for (const t of this.registry.listTasks()) {
      if (!t.sessionId || this.registry.getSession(t.sessionId)) continue;
      // A managed Pipeline reserves its SDK id before the driver starts so its first MCP
      // call can prove which task launched it. A discovery sweep can complete inside that
      // launch window, when the task already names the id but the supervisor has not yet
      // registered the session. The registry's launch marker is the positive evidence that
      // this absence is provisional, not a host that vanished while the daemon was down.
      const launch = this.registry.managedPipelineLaunch(t.sessionId);
      if (launch?.taskId === t.id) continue;
      this.agentWentAway(t);
    }
  }

  /**
   * Settle a task whose terminal handoff stopped its agent and then could not open a home.
   *
   * The one narrow door into `agentWentAway` from outside the eviction path, and it exists
   * because that path cannot reach this case: the handoff clears `Task.sessionId` BEFORE
   * stopping the driver (so the ordinary stop does not settle a task that is merely
   * transferring), and when the spawn then fails there is no session left to bind to and no
   * `session_remove` anyone can key on. The task would sit `running` with no agent for ever,
   * and `rebindTaskAtCwd` cannot rescue it either - no terminal is ever going to appear in
   * that checkout.
   *
   * Routed through `agentWentAway` rather than writing a status here so this case inherits
   * its two rules rather than approximating them: work that MERGED still reads `done`, and
   * the worktree, branch and home are KEPT for the operator's confirmed Clean up.
   */
  settleAfterFailedHandoff(taskId: string): void {
    const t = this.registry.getTask(taskId);
    if (t) this.agentWentAway(t);
  }

  private rebindTaskAtCwd(session: Session): void {
    if (!session.cwd || session.state === "exited") return;
    const tasks = this.registry.listTasks();
    if (
      tasks.some(
        (task) =>
          task.sessionId === session.id &&
          (task.status === "running" || task.status === "dispatching"),
      )
    ) return;
    const candidates = tasks.filter(
      (task) =>
        task.sessionId === null &&
        task.worktreePath === session.cwd &&
        task.status === "running",
    );
    if (candidates.length !== 1) return;
    const task = candidates[0]!;
    this.registry.upsertTask({ ...task, sessionId: session.id, updatedAt: Date.now() });
    this.registry.bindTaskToWorkEpisode(task.id, session.id);
  }

  /**
   * Mark one task's agent gone, KEEPING everything it holds.
   *
   * Deliberately not a teardown, and the asymmetry with `reconcileOnStartup` is the point:
   * that path reclaims because a row nobody can see leaks invisibly, while this one makes
   * the row visible the moment it happens - settled, resources intact, one confirmed Clean
   * up away from being freed. Tearing down here would run `git worktree remove --force`
   * seconds after a mis-aimed (k), which is the one thing `complete` already refuses to do
   * ("Mark done must not discard work"). Freeing a tree is the operator's call; saying the
   * agent is gone is ours.
   *
   * When no episode recorded a merge, `failed` is the least-wrong terminal state, and the
   * sentence is careful not to overclaim what it means. An agent that finished cleanly and
   * exited is indistinguishable here from one that crashed - the only thing observed is
   * that the session went away with no outcome recorded, so that is what it says. It is
   * also the status `reconcileOnStartup` already reaches for in the same situation, and
   * the one whose row carries the affordances this state wants: Retry when the tree is
   * gone, Clean up when it is not.
   */
  private agentWentAway(t: Task): void {
    this.autoCompleted.delete(t.id);
    if (providerOwnsTaskCompletion(t.kind)) {
      if (t.status === "running" || t.status === "dispatching") this.pipelineHostWentAway(t);
      else if (t.sessionId !== null) {
        this.registry.upsertTask({ ...t, sessionId: null, updatedAt: Date.now() });
      }
      return;
    }
    if (t.status !== "running" && t.status !== "dispatching") return;
    // The agent is gone AND its work landed, which is the one combination that means the
    // task finished rather than merely stopped. This is the boundary a later prompt
    // cannot outrun: while an agent is still being given work it is still here, so
    // nothing reaches this line; once it is gone, no prompt is coming. `failed` below
    // says "ended with no outcome recorded", and a merged pull request IS the outcome -
    // reporting it as a failure would strand every task declared to wait on this one
    // behind a `stopped` blocker, for work that shipped.
    const outcome = this.mergeOutcomeFor(t);
    if (outcome) {
      // A scout can refuse this: its pull request merged but no verified report was archived,
      // and `done` would claim a durable answer that does not exist. The agent is gone, so
      // the row still has to settle - it falls through to the same `failed` write, with a
      // sentence that says which of the two things went wrong. The archive itself is settled
      // separately by the exit reservation and by every cleanup guard.
      this.completeInBackground(
        t.id,
        {
          outcome: outcome.outcome,
          outcomeUrl: outcome.url,
          satisfyDependents: false,
          requireStopped: false,
          confirmIncompleteScout: false,
          inferredFrom: null,
        },
        (problems) => this.settleAgentGone(t.id, problems),
      );
      return;
    }
    this.settleAgentGone(t.id, null);
  }

  /** The exact projected provider run this task prebound, or null when it has not appeared. */
  private projectedPipelineRun(t: Task): PipelineRun | null {
    const link = t.pipelineRun;
    if (!link) return null;
    return this.registry.listPipelineRuns().find(
      (run) =>
        run.provider === link.provider &&
        run.repoRoot === link.repoRoot &&
        run.slug === link.slug,
    ) ?? null;
  }

  /** Reconcile a managed Engineer host that disappeared without claiming provider completion. */
  private pipelineHostWentAway(t: Task): void {
    const run = this.projectedPipelineRun(t);
    if (run) {
      if (run.group === "processed") {
        this.settlePipelineTask(run);
        return;
      }
      this.registry.upsertTask({
        ...t,
        sessionId: null,
        updatedAt: Date.now(),
      });
      return;
    }
    const expected = t.pipelineRun?.slug ? ` "${t.pipelineRun.slug}"` : "";
    this.registry.upsertTask({
      ...t,
      status: "failed",
      error: `the managed Agent SDK host ended before Conductor created pipeline run${expected}`,
      sessionId: null,
      updatedAt: Date.now(),
    });
  }

  /**
   * Write the terminal row for a task whose agent is gone, keeping everything it holds.
   *
   * Split out of `agentWentAway` because a scout reaches it a beat later - after its archive
   * refused the completion - and by then the row has to be re-read: a cancel or a fresh
   * dispatch may have landed inside that window, and resurrecting the old snapshot would put
   * a `failed` row over live work.
   */
  private settleAgentGone(taskId: string, scoutProblems: string[] | null): void {
    const t = this.registry.getTask(taskId);
    if (!t) return;
    if (t.status !== "running" && t.status !== "dispatching") return;
    const holdsResources = Boolean(t.worktreePath) || Boolean(t.homeName);
    const now = Date.now();
    const kept = holdsResources
      ? " - its worktree was kept; Clean up or re-dispatch it"
      : "";
    this.registry.upsertTask({
      ...t,
      status: "failed",
      error: scoutProblems
        ? `the agent's session ended and this scout's report was not archived: ${scoutProblems.join("; ")}${kept}`
        : `the agent's session ended with no outcome recorded${kept}`,
      // A synthetic id carries the pid and the process start time, so this one can never
      // name a running agent again.
      sessionId: null,
      updatedAt: now,
    });
  }

  get(id: string): Task | undefined {
    return this.registry.getTask(id);
  }

  /** A durable lookup for provenance workflows whose completed source may be off the board. */
  getDurable(id: string): Task | undefined {
    return getDurableTask(id);
  }

  /** Explicit blockers are enforced on every path that can start a task. */
  dependencyBlockers(task: Task): BacklogBlocker[] {
    return declaredBlockers(task, this.registry.listTasks());
  }

  private observedPrFor(session: Session, taskId?: string): string | null {
    const observation = this.registry.prObservationFor(session.id);
    const episode = this.registry.workEpisodeForSession(session.id);
    if (
      !observation ||
      !episode ||
      observation.url !== session.prUrl ||
      observation.branch !== session.gitBranch ||
      observation.agentSessionId !== session.agentSessionId ||
      observation.episodeId !== episode.episodeId ||
      (taskId !== undefined && !this.registry.taskOwnsWorkEpisode(taskId, session.id, observation.url))
    ) {
      return null;
    }
    return observation.url;
  }

  /**
   * Resolve untrusted ids to durable dependency edges and reject deadlocks.
   *
   * A selected session already carrying a task becomes a task edge. That is what lets
   * the dependency survive a process restart and follow the work through its PR merge.
   * Bare operator-started sessions remain session edges.
   */
  private resolveDependencies(
    inputs: TaskDependencyInput[],
    taskId: string,
    current: Task["dependencies"] = [],
  ): TaskDependency[] {
    const selectedAt = Date.now();
    const existing = new Map(
      current.map((dependency) => [
        dependency.type === "task" ? `task:${dependency.taskId}` : `session:${dependency.sessionId}`,
        dependency,
      ]),
    );
    const sessions = this.registry.snapshot().sessions;
    const resolved: TaskDependency[] = [];
    const seen = new Set<string>();

    for (const input of inputs) {
      let dependency: TaskDependency;
      if (input.type === "session") {
        const kept = existing.get(`session:${input.sessionId}`);
        if (kept?.type === "session") {
          dependency = kept;
          const key = `session:${dependency.sessionId}`;
          if (!seen.has(key)) resolved.push(dependency);
          seen.add(key);
          continue;
        }
        const session = sessions.find((candidate) => candidate.id === input.sessionId && candidate.state !== "exited");
        // Preserve an existing edge whose target disappeared so the operator can edit
        // other fields or remove dependencies without the daemon resurrecting/dropping it.
        if (!session) {
          throw new TaskDependencyError("dependency session is no longer active");
        }
        const episode = this.registry.workEpisodeForSession(session.id);
        if (!session.agentSessionId || !episode || episode.awaitingAgentRebind) {
          throw new TaskDependencyError("dependency session has no stable work identity yet");
        } else if (!session.hooksSeen) {
          throw new TaskDependencyError("dependency session has no observable work lifecycle");
        } else if (session.task && this.registry.getTask(session.task.id)) {
          const target = this.registry.getTask(session.task.id)!;
          const observedPr = this.observedPrFor(session, target.id);
          const previouslySatisfied =
            existing.get(`task:${target.id}`)?.satisfiedAt ??
            existing.get(`session:${session.id}`)?.satisfiedAt;
          const previousEdge =
            existing.get(`task:${target.id}`) ?? existing.get(`session:${session.id}`);
          dependency = {
            type: "task",
            taskId: target.id,
            title: target.title,
            sessionId: previousEdge?.sessionId ?? session.id,
            episodeId: previousEdge?.episodeId ?? episode?.episodeId ?? null,
            agentSessionId: previousEdge?.agentSessionId ?? episode?.agentSessionId ?? null,
            branch: previousEdge?.branch ?? episode?.branch ?? null,
            prUrl: previousEdge?.prUrl ?? observedPr,
            selectedAt: previousEdge ? previousEdge.selectedAt : selectedAt,
            satisfiedAt:
              observedPr && session.prState === "merged"
                ? Date.now()
                : previouslySatisfied ?? null,
          };
        } else {
          const observedPr = this.observedPrFor(session);
          dependency = {
            type: "session",
            sessionId: session.id,
            title: session.name,
            episodeId: episode.episodeId,
            agentSessionId: session.agentSessionId,
            branch: session.gitBranch,
            prUrl: observedPr,
            selectedAt,
            satisfiedAt: observedPr && session.prState === "merged" ? Date.now() : null,
          };
        }
      } else {
        const target = this.registry.getTask(input.taskId);
        if (!target) {
          const kept = existing.get(`task:${input.taskId}`);
          if (!kept) throw new TaskDependencyError("dependency task is no longer available");
          dependency = kept;
        } else {
          const activeSession = sessions.find(
            (session) => session.state !== "exited" && session.task?.id === target.id,
          );
          const previousEdge = existing.get(`task:${target.id}`);
          const binding = this.registry.workEpisodeForTask(target.id);
          const observedPr = activeSession ? this.observedPrFor(activeSession, target.id) : null;
          const eligible = target.status === "backlog" || Boolean(activeSession);
          if (!eligible && !existing.has(`task:${target.id}`)) {
            throw new TaskDependencyError("dependency task is neither backlogged nor active");
          }
          if (target.status !== "backlog" && activeSession && !activeSession.hooksSeen && !previousEdge) {
            throw new TaskDependencyError("dependency task has no observable work lifecycle");
          }
          dependency = {
            type: "task",
            taskId: target.id,
            title: target.title,
            sessionId: previousEdge?.sessionId ?? binding?.sessionId ?? null,
            episodeId: previousEdge?.episodeId ?? binding?.episodeId ?? null,
            agentSessionId: previousEdge?.agentSessionId ?? binding?.agentSessionId ?? null,
            branch: previousEdge?.branch ?? binding?.branch ?? null,
            prUrl: previousEdge?.prUrl ?? observedPr ?? binding?.prUrl ?? null,
            selectedAt: previousEdge ? previousEdge.selectedAt : selectedAt,
            satisfiedAt:
              observedPr && activeSession?.prState === "merged"
                ? Date.now()
                : existing.get(`task:${target.id}`)?.satisfiedAt ?? null,
          };
        }
      }

      const key = dependency.type === "task" ? `task:${dependency.taskId}` : `session:${dependency.sessionId}`;
      if (dependency.type === "task" && dependency.taskId === taskId) {
        throw new TaskDependencyError("a task cannot depend on itself");
      }
      if (!seen.has(key)) resolved.push(dependency);
      seen.add(key);
    }

    if (this.createsDependencyCycle(taskId, resolved)) {
      throw new TaskDependencyError("task dependencies cannot form a cycle");
    }
    return resolved;
  }

  private createsDependencyCycle(taskId: string, proposed: TaskDependency[]): boolean {
    const tasks = new Map(this.registry.listTasks().map((task) => [task.id, task]));
    const visiting = new Set<string>();
    const reachesTask = (id: string): boolean => {
      if (id === taskId) return true;
      if (visiting.has(id)) return false;
      visiting.add(id);
      const dependencies = id === taskId ? proposed : tasks.get(id)?.dependencies ?? [];
      for (const dependency of dependencies) {
        if (dependency.satisfiedAt !== null || dependency.type !== "task") continue;
        if (reachesTask(dependency.taskId)) return true;
      }
      return false;
    };
    return proposed.some(
      (dependency) =>
        dependency.satisfiedAt === null &&
        dependency.type === "task" &&
        reachesTask(dependency.taskId),
    );
  }

  /**
   * Create a task, and - when the operator left the title blank - name it with a model
   * before anything downstream reads that name.
   *
   * Stays synchronous so the POST returns a task immediately: the card must appear the
   * instant it is dispatched, not after a subprocess. It appears under the heuristic title,
   * which `autoTitleThenDispatch` replaces over SSE a beat later.
   *
   * `internal` is the durable producer's door - today the Recurring Missions scheduler and
   * the ensemble engine. It makes this call idempotent on a caller-chosen id, which is the
   * property both recovery paths are built on. See `InternalCreateOptions`. Omitting it is
   * every other caller, and their behaviour here is unchanged: fresh UUID, model titling
   * when the title is blank, dispatch when it is not.
   *
   * `manualDispatch` is an explicit capability rather than another input field. Request
   * bodies and generic producers therefore cannot opt themselves into creating chat tasks.
   */
  create(
    input: CreateTaskInput,
    internal?: InternalCreateOptions,
    manualDispatch?: symbol,
  ): Task {
    if (!taskKindAllowsBacklog(input.kind) && manualDispatch !== MANUAL_DISPATCH_TASK_CREATE) {
      throw new TaskKindBacklogError(TASK_KIND_BACKLOG_REFUSAL);
    }
    if (
      !taskKindAllowsBacklog(input.kind) &&
      (input.backlog || internal !== undefined || input.source !== undefined ||
        (input.dependencies?.length ?? 0) > 0)
    ) {
      throw new TaskKindBacklogError(TASK_KIND_BACKLOG_REFUSAL);
    }
    const now = Date.now();
    const explicitTitle = input.title?.trim();
    // The ONE place an omitted agent becomes a real one, so every creator - the dispatch
    // route, an MCP `create_task`, a task source sweep, a recurring mission, a retro
    // follow-up, an ensemble member - inherits the kind default without any of them
    // learning that kind defaults exist. A caller that named an agent keeps it verbatim.
    const agent = resolveTaskAgent(input.kind, input.agent);
    // The half of `DispatchSchema`'s effort refinement that a browser-safe schema cannot run:
    // with the agent omitted there, the harness the level was chosen for is not known until
    // this line.
    //
    // Applied to EVERY caller, including one whose agent was inherited. An earlier draft let
    // an inheriting creator through on the reasoning that its author never made the
    // resolution - but the task row it writes is a PIN, and a stored pin is the one thing the
    // launch ladder used to pass on without checking. Refusing here is where the operator can
    // still act on it: `PUT /api/schedules` and the task-source save answer 400, naming the
    // level and the harness, instead of a mission that files silently and launches wrong.
    if (input.effort && !supportsEffort(agent, input.effort)) {
      throw new TaskEffortUnsupportedError(
        `reasoning effort ${input.effort} is not supported by ${agent}`,
      );
    }
    const id = internal?.id ?? randomUUID();
    if (internal) {
      // Two producer-specific identity checks, with the same recovery rule. A scheduled id
      // must carry THIS occurrence's provenance; an ensemble id must still carry the exact
      // member Task inputs its attempt reserved. A match closes the crash window without
      // re-emitting, re-titling or re-dispatching. Anything else means the id belongs to a
      // different Task, so fail closed rather than adopt and rewrite a stranger's work.
      const existing = getDurableTask(id);
      if (existing) {
        if (internal.schedule) {
          const p = internal.schedule;
          if (
            existing.scheduleId !== p.scheduleId ||
            existing.scheduleOccurrenceId !== p.scheduleOccurrenceId ||
            existing.scheduledFor !== p.scheduledFor
          ) {
            throw new TaskIdCollisionError(
              `task ${id} already exists and was not filed by occurrence ${p.scheduleOccurrenceId}`,
            );
          }
        } else {
          const workflowId = resolveTaskWorkflowId(input.workflowId);
          if (
            existing.repoRoot !== input.repoRoot ||
            existing.intent !== input.intent ||
            existing.title !== explicitTitle ||
            existing.kind !== input.kind ||
            existing.agent !== agent ||
            existing.model !== (input.model ?? null) ||
            existing.effort !== (input.effort ?? null) ||
            existing.workflowId !== workflowId ||
            existing.scheduleId !== null
          ) {
            throw new TaskIdCollisionError(`task ${id} already exists with different ensemble input`);
          }
        }
        return existing;
      }
      // Shared contract for every durable producer, asserted here rather than trusted at
      // each call site: first persist a named ordinary backlog Task. The scheduler stops
      // there; the ensemble engine separately dispatches through TaskManager only after the
      // complete wave exists. A blank title would also put model titling on a recovery path.
      if (!input.backlog) throw new Error(`internally created task ${id} must be backlog`);
      if (!explicitTitle) throw new Error(`internally created task ${id} must carry a title`);
    }
    const workflowId = resolveTaskWorkflowId(input.workflowId);
    const dependencies = this.resolveDependencies(input.dependencies ?? [], id);
    const mustBacklog = dependencies.some((dependency) => dependency.satisfiedAt === null);
    const backlogged = Boolean(input.backlog) || mustBacklog;
    // The ONE edit that makes "work that files itself arrives at the bottom" true for every
    // automatic filer at once - a task source sweep, a recurring mission, a retro follow-up,
    // an ensemble member, an MCP `create_task`. They all come through here with
    // `backlog: true`, so none of them needs to know the rule and none of them can forget
    // it. Nothing that files itself gets to jump the queue the operator arranged.
    //
    // A task dispatched straight out (no backlog stop) gets no rank at all: rank is
    // meaningful only in the backlog, and inventing one for a row that never sits there
    // would put a number in the column that means nothing. `reschedule` is what gives one
    // to a task that arrives in the backlog later.
    const backlogRank = backlogged ? this.allocateBacklogRank("bottom") : null;
    const task: Task = {
      id,
      title: explicitTitle || deriveTitle(input.intent),
      intent: input.intent,
      kind: input.kind,
      agent,
      priority: input.priority ?? null,
      labels: input.labels ?? [],
      dependencies,
      backlogRank,
      // Human and internal callers remain schedulable by default. A task source can make
      // the opposite choice explicit in its settings, so every item it files arrives on
      // hold for review without a second, non-atomic update after creation.
      enabled: input.enabled ?? true,
      // Stored as an override, not a resolved value: unset means the dispatcher asks
      // the harness config at launch time, so shelving a task doesn't freeze the
      // defaults it happened to see (see `resolveDispatchModel` and
      // `resolveDispatchEffort`).
      model: input.model ?? null,
      effort: input.effort ?? null,
      // The binding is intentionally deferred: a fresh task has no session or durable
      // conversation key yet. WorkflowManager watches the task/session join and pins the
      // selected workflow's current immutable version there.
      workflowId,
      source: input.source ?? null,
      // Filled by pipeline dispatch before its host starts. Null remains valid for backlog
      // rows and for tasks persisted by builds that learned the link only from a child.
      pipelineRun: null,
      repoRoot: input.repoRoot,
      worktreePath: null,
      branch: null,
      provider: null,
      worktreeLeaseId: null,
      baseSha: null,
      // Already resolved and validated by the caller (the route), exactly as `repoRoot` is.
      // Recorded at creation so a backlog task carries its full repo set before anything is
      // provisioned - which is what lets Foreman answer the allowlist question about all of
      // them, and what makes a repo-set edit a provisioning change the status guard refuses.
      extraRepos: (input.extraRepoRoots ?? []).map((repoRoot) => ({
        repoRoot,
        worktreePath: null,
        branch: null,
        provider: null,
        worktreeLeaseId: null,
        baseSha: null,
        prUrl: null,
        prState: null,
        mergedAt: null,
      })),
      homeName: null,
      homeBackend: null,
      terminalResourceId: null,
      sessionId: null,
      // Null for every human or external caller - the dispatch form, an MCP tool, a task
      // source sweep - none of which has an occurrence to point at. All three arrive
      // together or not at all, from the scheduler's internal producer above.
      scheduleId: internal?.schedule?.scheduleId ?? null,
      scheduleOccurrenceId: internal?.schedule?.scheduleOccurrenceId ?? null,
      scheduledFor: internal?.schedule?.scheduledFor ?? null,
      status: backlogged ? "backlog" : "dispatching",
      outcome: null,
      outcomeUrl: null,
      error: null,
      // A brand new task has no checkout, so retention has nothing to observe and nothing to
      // say. It stays null until an automatic cleanup of this task's trees actually fails.
      automaticCleanup: null,
      createdAt: now,
      updatedAt: now,
      dispatchedAt: null,
      completedAt: null,
    };
    this.registry.upsertTask(task);
    if (explicitTitle) {
      if (task.status === "dispatching") void this.dispatcher.dispatch(task.id);
    } else {
      // Registered synchronously, before this returns, so no caller can observe the task
      // without also observing that its title is still in flight.
      const settled = this.autoTitleThenDispatch(task.id, input.intent, task.status === "backlog")
        .catch((err) => console.error("[title] titling failed:", err))
        .finally(() => this.titling.delete(task.id));
      this.titling.set(task.id, settled);
    }
    return task;
  }

  /**
   * Create or recover the one post-merge retro task owned by a source work episode.
   *
   * The normalized relation reserves the id first. A crash after that reservation leaves no
   * second source of task state: retrying reconstructs the ordinary Task under the reserved id,
   * and `create` verifies that an existing row still describes this exact follow-up.
   */
  createRetroFollowup(input: CreateRetroFollowupInput): Task {
    const reserved = reserveRetroFollowup({
      sourceTaskId: input.sourceTask.id,
      sourceEpisodeId: input.sourceEpisodeId,
      sourceSessionId: input.sourceSessionId,
      retroTaskId: randomUUID(),
      now: Date.now(),
    }).relation;
    const extraRepoRoots = input.sourceTask.extraRepos.map((repo) => repo.repoRoot);
    const task = this.create(
      {
        repoRoot: input.sourceTask.repoRoot,
        extraRepoRoots,
        title: input.title,
        intent: input.intent,
        kind: "ship",
        agent: input.agent,
        workflowId: null,
        backlog: true,
      },
      { id: reserved.retroTaskId },
    );
    // A completed source may remain clickable after the bounded board projection evicted this
    // older follow-up. Re-admit the durable row before `dispatch` inspects it; the upsert does
    // not change its status or create another Task.
    if (!this.registry.getTask(task.id)) this.registry.upsertTask(task);
    const actualExtraRepos = task.extraRepos.map((repo) => repo.repoRoot);
    if (
      actualExtraRepos.length !== extraRepoRoots.length ||
      actualExtraRepos.some((repo, index) => repo !== extraRepoRoots[index])
    ) {
      throw new TaskIdCollisionError(
        `retro task ${task.id} already exists with a different repository set`,
      );
    }
    return task;
  }

  /**
   * Settle exactly the retro follow-up running in the authenticated caller's session.
   *
   * There is no caller-supplied task id and no general-purpose outcome. Session attribution
   * selects the Task, the durable relation proves its special kind, and dependency edges stay
   * untouched. Replaying the one accepted terminal outcome is a no-op.
   */
  async completeRetroNoChange(
    sessionId: string,
    cwd: string | null,
  ): Promise<CompleteRetroNoChangeOutcome> {
    const task = this.registry.taskForSession(sessionId, cwd);
    if (!task) {
      return { ok: false, status: 404, error: "no task is attributed to this session" };
    }
    const relation = retroFollowupForTask(task.id);
    if (!relation) {
      return {
        ok: false,
        status: 409,
        error: "this session is not running a post-merge retro follow-up task",
      };
    }
    if (task.status === "done") {
      if (task.outcome !== RETRO_NO_CHANGE_OUTCOME || task.outcomeUrl !== null) {
        return {
          ok: false,
          status: 409,
          error: "this retro follow-up already completed with a different outcome",
        };
      }
      return { ok: true, task, sourceTaskId: relation.sourceTaskId, replayed: true };
    }
    if (task.status !== "dispatching" && task.status !== "running") {
      return {
        ok: false,
        status: 409,
        error: `this retro follow-up is ${task.status}, so it cannot report a no-change result`,
      };
    }
    const completed = await this.complete(task.id, RETRO_NO_CHANGE_OUTCOME);
    if (!completed) {
      return { ok: false, status: 404, error: "the retro follow-up no longer exists" };
    }
    return { ok: true, task: completed, sourceTaskId: relation.sourceTaskId, replayed: false };
  }

  /**
   * Dispatch NOW, and let the model's title rename what it named.
   *
   * This ordering was the reverse until the wait was measured. Dispatch reads `task.title`
   * once to build the terminal home name (`sessionLabel`), so naming used to gate the entire
   * launch behind the titling call, and the justification written here was that neither the
   * branch nor the terminal "can be renamed afterwards from the dashboard". That premise was
   * false on both halves:
   *
   *  - The SESSION can be renamed. `POST /api/sessions/:id/rename` does it, and
   *    `Registry.renameSession` deliberately carries the task's resource binding across so a
   *    renamed agent's worktree is not force-removed underneath it. `renameForTask` below is
   *    that operation applied from a task's title, and `assign` has always called it.
   *  - The BRANCH is not cut from the title on the path this actually runs. A pooled lease is
   *    DETACHED - `provisionWorktree` reads its branch back off the tree with `currentBranch`
   *    and never sees the slug. Only the git FALLBACK arm names a branch, and that arm is
   *    reached when the pool is disabled or declines.
   *
   * What the old ordering bought, then, was a correctly-named branch in the fallback case, at
   * the price of every dispatch waiting on a headless model call - measured at 4.5-7.7s
   * against the configured provider, of which only ~0.3-0.6s is the process and none of it is
   * prompt size. That is the whole of the delay between pressing Dispatch and an agent
   * existing. The fallback branch keeps the heuristic slug now, which is the same string the
   * card carried at that instant and is never rewritten afterwards.
   *
   * Never throws, and never lets a titling failure cost a launch: the dispatch is started
   * before the model is asked, so a missing, logged-out or hanging provider costs a rougher
   * name and nothing else.
   */
  private async autoTitleThenDispatch(id: string, intent: string, backlog: boolean): Promise<void> {
    // Launch first. A backlog item is not launching at all, so it simply waits for its title.
    if (!backlog && this.registry.getTask(id)?.status === "dispatching") {
      void this.dispatcher.dispatch(id);
    }
    const title = await summariseTaskTitle(intent);
    // Re-read rather than closing over the created task: the operator can cancel or remove a
    // task while the model is thinking, and both of those are decisions this must not undo.
    const cur = this.registry.getTask(id);
    if (!cur) return;
    if (!title || title === cur.title) return;
    try {
      this.registry.upsertTask({ ...cur, title, updatedAt: Date.now() });
    } catch (err) {
      // A failed write must not cost the dispatch. The heuristic title stands, and with it
      // the name already on the session, which is a consistent pair rather than a broken one.
      console.error("[title] could not store the title:", err);
      return;
    }
    if (backlog) return;
    // Second half of the rename race. If the session is already bound this renames it now; if
    // it is not, `onSessionBound` will call the same method the moment it binds. Both paths
    // are no-ops once the name matches, so whichever runs second settles it and a third call
    // changes nothing.
    await this.settleTitleName(id);
  }

  /**
   * Bring a launched session's name up to date with its task's title.
   *
   * Reached from BOTH sides of a race that has no fixed winner: the model can answer before
   * the agent's session is discovered, or minutes after it. `autoTitleThenDispatch` calls this
   * when the title lands, and the Dispatcher's `onSessionBound` calls it when the session
   * does. Whichever completes second performs the rename; the other finds nothing to do.
   *
   * Silent about everything it declines to do, because every one of those is a correct
   * outcome rather than an error: no task, no session yet, a session the operator has since
   * renamed by hand onto something else, or a task that never had a model title at all.
   * `renameForTask` is itself best-effort and leaves the old name standing on refusal - a
   * cosmetic name must never be able to disturb an agent that is already working.
   */
  private async settleTitleName(id: string): Promise<void> {
    const task = this.registry.getTask(id);
    if (!task?.sessionId) return;
    // Only while the task is actually running on that session. A cancelled or completed task
    // is being torn down, and renaming its terminal home mid-teardown would point `killHome`
    // at a name that no longer exists.
    if (task.status !== "dispatching" && task.status !== "running") return;
    const session = this.registry.getSession(task.sessionId);
    if (!session) return;
    try {
      await this.renameForTask(
        session,
        task,
        (s, name) => rename(s, name, undefined, renameDriverSession),
      );
    } catch (err) {
      console.error(`[title] could not rename the session for ${id}:`, err);
    }
  }

  /**
   * Dispatch a backlog task, or retry a failed one - but only when the failure was
   * cleanly torn down (no lingering worktree). A failed task that still holds a
   * worktree means its agent may still be running; the user should Cancel it first
   * (which reclaims the tree) rather than dispatch a second agent onto it.
   *
   * Waits out any in-flight titling first: the branch and initial terminal home name are cut
   * from `task.title`, and later title edits do not propagate to them. Dispatching
   * mid-titling would name them after the heuristic title and leave the card disagreeing.
   *
   * This is the other way a task acquires its `Task.sessionId` "currently executing on"
   * pointer. Dispatch launches a brand-new agent, so the binding is the pointer's first
   * value rather than a move from a prior task. It needs no equivalent of `assign`'s serial
   * re-check; any future path that binds an existing session would.
   */
  async dispatch(id: string, options: DispatchOptions = {}): Promise<DispatchOutcome> {
    await this.titling.get(id);
    // Read only AFTER the wait - the task may have been cancelled or removed during it.
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    if (this.assigningTasks.has(id)) {
      return { ok: false, error: "task is being assigned", task: t };
    }
    if (t.kind === "pipeline" && t.pipelineCommissionId) {
      const commission = this.registry.pipelineCommission(t.pipelineCommissionId);
      const guard = commission ? pipelineRecoveryGuard(commission) : null;
      if (commission?.lifecycle === "failed" && guard) {
        const recovered = await this.retryPipelineAttempt(id, { guard });
        return recovered.ok
          ? recovered
          : { ok: false, error: recovered.error, task: recovered.task };
      }
    }
    if (t.status === "backlog" || (t.status === "failed" && !t.worktreePath)) {
      if (!taskKindAllowsBacklog(t.kind)) {
        return { ok: false, error: TASK_KIND_BACKLOG_REFUSAL, task: t };
      }
      // Asked before dependencies, like the allowlist is in `decideBacklogTick`: it is
      // the coarser fact and the one the operator can act on immediately.
      if (refusedAsDisabled(t, options.overrideDisabled)) {
        return { ok: false, error: DISABLED_REFUSAL, task: t };
      }
      const blockers = this.dependencyBlockers(t);
      if (blockers.length > 0) {
        return {
          ok: false,
          error: `task is waiting on ${blockers.map((blocker) => blocker.title).join(", ")}`,
          task: t,
        };
      }
      // A plan whose contract cannot be honoured is turned away HERE, synchronously, rather
      // than left to fail on the card a few seconds later. The Dispatcher refuses it too and
      // that is not redundancy: this is the answer the operator's click and the autopilot's
      // pass both read, and that one is the backstop for every door that does not come
      // through here. Null for every other kind, so nothing else changes.
      const planBlock = planDispatchBlock(t);
      if (planBlock) return { ok: false, error: planBlock, task: t };
      // Forwarded whole: `TaskDispatchOptions` describes the launch, and the Dispatcher is
      // the layer that acts on it - including `defaultModel`, which it ranks between the
      // task's own pin and the Harnesses panel default (see `Dispatcher.dispatch`).
      //
      // This method used to WRITE `options.defaultModel` onto the task row first, so the
      // card's model would match the command line. That pinned the task: `t.model` outranks
      // the Harnesses default, `reschedule` does not clear it, and nothing in the UI had
      // asked for it - so a task Foreman launched once could never follow a changed default
      // again. The launch-only value now travels with the launch, and an unpinned task stays
      // unpinned; the model a session actually ran on is recorded on the SESSION, which is
      // where it belongs and where the card reads it from.
      void this.dispatcher.dispatch(id, options);
    }
    return { ok: true, task: this.registry.getTask(id) ?? t };
  }

  /** Re-run readiness for the same reserved provider attempt without minting a retry. */
  async recheckPipelineReadiness(id: string): Promise<DispatchOutcome> {
    const task = this.registry.getTask(id);
    if (!task) return { ok: false, error: "no such task" };
    if (task.kind !== "pipeline" || !task.pipelineCommissionId) {
      return { ok: false, error: "task has no Pipeline commission", task };
    }
    const commission = this.registry.pipelineCommission(task.pipelineCommissionId);
    if (!commission?.readinessRequired || commission.readiness?.permitted !== false) {
      return { ok: false, error: "Pipeline readiness is not currently blocking this task", task };
    }
    if (task.sessionId || task.status !== "running") {
      return { ok: false, error: "Pipeline task is not waiting at the readiness gate", task };
    }
    const lifecycle = PIPELINE_PROVIDERS[commission.provider].engineerLifecycle;
    if (!commission.capabilities?.readiness || !lifecycle) {
      return { ok: false, error: "the provider no longer exposes Pipeline readiness", task };
    }
    const checked = await checkPipelineCommissionReadiness(this.registry, commission, lifecycle);
    if (!checked.ok) return { ok: false, error: checked.error, task };
    const current = this.registry.getTask(id) ?? task;
    this.registry.upsertTask({
      ...current,
      error: checked.commission.readiness?.permitted
        ? null
        : checked.commission.readiness?.summary ?? "Provider readiness remains blocked",
      updatedAt: Date.now(),
    });
    return { ok: true, task: this.registry.getTask(id) ?? task };
  }

  /** Launch a ready initial provider attempt after a separate, non-launching recheck. */
  async startPipelineAfterReadiness(id: string): Promise<DispatchOutcome> {
    const task = this.registry.getTask(id);
    if (!task) return { ok: false, error: "no such task" };
    if (task.kind !== "pipeline" || !task.pipelineCommissionId) {
      return { ok: false, error: "task has no Pipeline commission", task };
    }
    const commission = this.registry.pipelineCommission(task.pipelineCommissionId);
    const attempt = commission?.attempts.find(
      (candidate) => candidate.attempt === commission.activeAttempt,
    );
    if (
      !commission?.readinessRequired ||
      commission.readiness?.permitted !== true ||
      attempt?.state !== "created"
    ) {
      return { ok: false, error: "Pipeline is not ready for its initial host launch", task };
    }
    if (task.sessionId || task.status !== "running") {
      return { ok: false, error: "Pipeline task is not waiting for its initial host", task };
    }
    void this.dispatcher.dispatch(id);
    return { ok: true, task };
  }

  /** Retire one predecessor through Registry's sole managed-session eviction path. */
  private async stopPipelineEngineerHost(taskId: string, sessionId: string): Promise<boolean> {
    return await this.registry.replacePipelineEngineerHost(taskId, sessionId, async () => {
      if (this.supervisor?.handleFor(sessionId)) await this.supervisor.stop(sessionId);
    });
  }

  /** Reserve and launch the one Mission Control-owned successor to a retryable failure. */
  async retryPipelineAttempt(id: string, input: PipelineRetry): Promise<PipelineRecoveryOutcome> {
    const task = this.registry.getTask(id);
    if (!task) return { ok: false, code: "task_conflict", error: "no such task" };
    if (task.kind !== "pipeline" || task.pipelineCommissionId !== input.guard.commissionId) {
      return { ok: false, code: "task_conflict", error: "task has no matching Pipeline commission", task };
    }
    const commission = this.registry.pipelineCommission(input.guard.commissionId);
    if (!commission) {
      return { ok: false, code: "stale_guard", error: "the Pipeline commission no longer exists", task };
    }
    const authorized = (): boolean => pipelineRepoConsented(commission.provider, commission.repoRoot);
    if (!authorized()) {
      return pipelineRecoveryConsentFailure(task);
    }
    const lifecycle = PIPELINE_PROVIDERS[commission.provider].engineerLifecycle;
    if (!lifecycle) {
      return { ok: false, code: "unsupported_provider", error: "the provider has no Engineer lifecycle", task };
    }
    const capability = await lifecycle.capability();
    if (!authorized()) {
      return pipelineRecoveryConsentFailure(task);
    }
    if (!capability.ok || !capability.value.supported) {
      return {
        ok: false,
        code: capability.ok ? "unsupported_provider" : "provider_outcome_unknown",
        error: capability.ok ? "the provider does not support Engineer recovery" : capability.error,
        task,
        ...(!capability.ok && capability.outcomeUnknown ? { outcomeUnknown: true } : {}),
      };
    }
    const prepared = await preparePipelineRetry({
      sink: this.registry,
      commission,
      guard: input.guard,
      lifecycle,
      capabilities: capability.value,
      authorized,
    });
    if (!prepared.ok) return { ...prepared, task };
    const recoveryAttempt = prepared.commission.recovery?.attempt;
    if (!recoveryAttempt) {
      return { ok: false, code: "task_conflict", error: "the retry reservation was not retained", task };
    }
    if (prepared.commission.recovery?.state === "complete") {
      return { ok: true, task: this.registry.getTask(id) ?? task };
    }
    const recoveryKey = `${prepared.commission.id}:${recoveryAttempt}`;
    if (this.pipelineRecoveries.has(recoveryKey)) {
      return { ok: false, code: "recovery_in_flight", error: "this Pipeline retry is already launching", task };
    }
    this.pipelineRecoveries.add(recoveryKey);
    const persistHostFailure = (error: string, expectedState?: "replacing_host"): void => {
      const failed = updatePipelineCommissionRecovery({
        commissionId: prepared.commission.id,
        attempt: recoveryAttempt,
        ...(expectedState ? { expectedState } : {}),
        state: "host_launch_failed",
        error,
      });
      if (failed) this.registry.upsertPipelineCommission(failed);
    };
    try {
      if (!authorized()) {
        return pipelineRecoveryConsentFailure(task);
      }
      const liveRecovery = this.registry.pipelineCommission(prepared.commission.id)?.recovery;
      if (
        liveRecovery?.attempt === recoveryAttempt &&
        liveRecovery.state === "launching_host" &&
        task.sessionId &&
        this.registry.getSession(task.sessionId)
      ) {
        const completed = updatePipelineCommissionRecovery({
          commissionId: prepared.commission.id,
          attempt: recoveryAttempt,
          state: "complete",
          error: null,
        });
        if (completed) this.registry.upsertPipelineCommission(completed);
      } else {
        const replacing = updatePipelineCommissionRecovery({
          commissionId: prepared.commission.id,
          attempt: recoveryAttempt,
          state: "replacing_host",
          error: null,
        });
        if (replacing) this.registry.upsertPipelineCommission(replacing);
        try {
          if (task.sessionId) {
            const replaced = await this.stopPipelineEngineerHost(id, task.sessionId);
            const current = this.registry.getTask(id);
            if (!replaced && current?.sessionId) {
              const error = "the Pipeline task changed host ownership before recovery replacement";
              persistHostFailure(error, "replacing_host");
              return {
                ok: false,
                code: "task_conflict",
                error,
                task: current,
              };
            }
          }
          if (!authorized()) {
            return pipelineRecoveryConsentFailure(this.registry.getTask(id) ?? task);
          }
          if (task.homeName) {
            const stopped = await killHome(
              task.homeName,
              undefined,
              task.homeBackend ?? null,
            );
            if (!stopped.asked || !stopped.ok) {
              throw new Error(stopped.error ?? `no terminal backend could stop ${task.homeName}`);
            }
            const current = this.registry.getTask(id);
            if (current?.homeName === task.homeName) {
              this.registry.upsertTask({
                ...current,
                homeName: null,
                homeBackend: null,
                terminalResourceId: null,
                updatedAt: Date.now(),
              });
            }
          }
          if (!authorized()) {
            return pipelineRecoveryConsentFailure(this.registry.getTask(id) ?? task);
          }
          const launchTask = this.registry.getTask(id);
          const launchCommission = this.registry.pipelineCommission(prepared.commission.id);
          if (
            !launchTask || launchTask.kind !== "pipeline" ||
            launchTask.pipelineCommissionId !== prepared.commission.id ||
            launchTask.status !== "running" || launchTask.sessionId ||
            launchCommission?.activeAttempt !== recoveryAttempt ||
            launchCommission.recovery?.kind !== "retry" ||
            launchCommission.recovery.attempt !== recoveryAttempt ||
            launchCommission.recovery.state !== "replacing_host"
          ) {
            const error = "the Pipeline task or recovery ownership changed before host launch";
            persistHostFailure(error, "replacing_host");
            return {
              ok: false,
              code: "task_conflict",
              error,
              task: launchTask ?? task,
            };
          }
          await this.dispatcher.dispatch(id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          persistHostFailure(message);
          return { ok: false, code: "host_launch_failure", error: message, task: this.registry.getTask(id) ?? task };
        }
      }
      const current = this.registry.getTask(id) ?? task;
      const latest = this.registry.pipelineCommission(prepared.commission.id);
      if (!latest?.recovery || latest.recovery.attempt !== recoveryAttempt) {
        return {
          ok: false,
          code: "task_conflict",
          error: "the retry recovery state changed during launch",
          task: current,
        };
      }
      const outcome = pipelineRecoveryOutcomeFor(latest.recovery);
      return outcome.ok ? { ok: true, task: current } : { ...outcome, task: current };
    } finally {
      this.pipelineRecoveries.delete(recoveryKey);
    }
  }

  /** Refresh review evidence for one direct provider successor without adopting it. */
  async refreshPipelineSuccessor(id: string, input: PipelineRetry): Promise<PipelineRecoveryOutcome> {
    const task = this.registry.getTask(id);
    const commission = task?.pipelineCommissionId
      ? this.registry.pipelineCommission(task.pipelineCommissionId)
      : null;
    if (!task || !commission) {
      return { ok: false, code: "task_conflict", error: "no such Pipeline commission", ...(task ? { task } : {}) };
    }
    const authorized = (): boolean => pipelineRepoConsented(commission.provider, commission.repoRoot);
    if (!authorized()) {
      return pipelineRecoveryConsentFailure(task);
    }
    const before = pipelineRecoveryGuard(commission);
    if (!before || !pipelineGuardsMatch(before, input.guard)) {
      return { ok: false, code: "stale_guard", error: "the failed Engineer attempt changed", task };
    }
    await refreshPipelineCommission(this.registry, commission, { refreshSuccessor: true });
    if (!authorized()) {
      return pipelineRecoveryConsentFailure(task);
    }
    const latest = this.registry.pipelineCommission(commission.id);
    const after = latest ? pipelineRecoveryGuard(latest) : null;
    if (!latest || !after || !pipelineGuardsMatch(after, input.guard)) {
      return { ok: false, code: "stale_guard", error: "the failed Engineer attempt changed during inspection", task };
    }
    return { ok: true, task: this.registry.getTask(id) ?? task };
  }

  /** Adopt one revalidated external successor before replaying any of its journal. */
  async adoptPipelineSuccessor(id: string, input: PipelineAdoptSuccessor): Promise<PipelineRecoveryOutcome> {
    const task = this.registry.getTask(id);
    const commission = task?.pipelineCommissionId
      ? this.registry.pipelineCommission(task.pipelineCommissionId)
      : null;
    if (!task || !commission) {
      return { ok: false, code: "task_conflict", error: "no such Pipeline commission", ...(task ? { task } : {}) };
    }
    const authorized = (): boolean => pipelineRepoConsented(commission.provider, commission.repoRoot);
    if (!authorized()) {
      return pipelineRecoveryConsentFailure(task);
    }
    if (!completedPipelineAdoptionMatches(commission, input)) {
      const lifecycle = PIPELINE_PROVIDERS[commission.provider].engineerLifecycle;
      if (!lifecycle) {
        return { ok: false, code: "unsupported_provider", error: "the provider has no Engineer lifecycle", task };
      }
      const capability = await lifecycle.capability();
      if (!authorized()) {
        return pipelineRecoveryConsentFailure(task);
      }
      if (!capability.ok || !capability.value.supported) {
        return {
          ok: false,
          code: capability.ok ? "unsupported_provider" : "provider_outcome_unknown",
          error: capability.ok ? "the provider does not support Engineer recovery" : capability.error,
          task,
        };
      }
      const adopted = await adoptValidatedPipelineSuccessor({
        sink: this.registry,
        commission,
        guard: input.guard,
        candidateEngineerRunId: input.candidateEngineerRunId,
        candidateRevision: input.candidateRevision,
        candidateFingerprint: input.candidateFingerprint,
        lifecycle,
        authorized,
      });
      if (!adopted.ok) return { ...adopted, task };
    }
    if (!authorized()) {
      return pipelineRecoveryConsentFailure(this.registry.getTask(id) ?? task);
    }
    if (task.sessionId) {
      try {
        await this.stopPipelineEngineerHost(id, task.sessionId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `[pipelines] successor adopted, but the predecessor host could not be retired: ${detail.slice(0, 500)}`,
        );
      }
    }
    return { ok: true, task: this.registry.getTask(id) ?? task };
  }

  /** Settle a failed commission only when the browser still names its exact predecessor. */
  async settlePipelineCommission(
    id: string,
    input: PipelineRetry,
    action: "abandon" | "cancel",
  ): Promise<PipelineRecoveryOutcome> {
    const task = this.registry.getTask(id);
    const commission = task?.pipelineCommissionId
      ? this.registry.pipelineCommission(task.pipelineCommissionId)
      : null;
    const guard = commission ? pipelineRecoveryGuard(commission) : null;
    if (!task || !commission || !guard || !pipelineGuardsMatch(guard, input.guard)) {
      return { ok: false, code: "stale_guard", error: "the Pipeline commission changed", ...(task ? { task } : {}) };
    }
    if (!pipelineRepoConsented(commission.provider, commission.repoRoot)) {
      return pipelineRecoveryConsentFailure(task);
    }
    if (action === "cancel") {
      const cancelled = await this.cancel(id);
      return cancelled.ok
        ? { ok: true, task: this.registry.getTask(id) ?? task }
        : { ok: false, code: "task_conflict", error: cancelled.error ?? "Pipeline cancellation failed", task };
    }
    if (task.sessionId) {
      try {
        await this.stopPipelineEngineerHost(id, task.sessionId);
      } catch (error) {
        return {
          ok: false,
          code: "task_conflict",
          error: `could not retire the Engineer host before abandoning: ${error instanceof Error ? error.message : String(error)}`,
          task,
        };
      }
    }
    if (!pipelineRepoConsented(commission.provider, commission.repoRoot)) {
      return pipelineRecoveryConsentFailure(this.registry.getTask(id) ?? task);
    }
    let abandoned;
    try {
      abandoned = cancelPipelineCommission({
        commissionId: commission.id,
        reason: "Operator abandoned the failed Engineer commission",
      });
    } catch (error) {
      return {
        ok: false,
        code: "task_conflict",
        error: `could not abandon the Engineer commission: ${error instanceof Error ? error.message : String(error)}`,
        task: this.registry.getTask(id) ?? task,
      };
    }
    this.registry.upsertPipelineCommission(abandoned);
    const current = this.registry.getTask(id) ?? task;
    this.registry.upsertTask({
      ...current,
      status: "failed",
      sessionId: null,
      error: "Pipeline commission abandoned by operator",
      updatedAt: Date.now(),
    });
    return { ok: true, task: this.registry.getTask(id) ?? task };
  }

  /**
   * Edit a task - the dispatch modal reopened on a card, or the backlog column's
   * priority picker and enable/disable toggle.
   *
   * The status guard applies to the PROVISIONING fields only, and that split is the
   * whole rule. The moment a task dispatches, its title has supplied a git branch and an
   * initial terminal home name (see `autoTitleThenDispatch`), and its intent has already
   * been typed at an agent. A title edit after that point would change the card without
   * propagating to those resources, which is worse than a refusal. Every
   * other status is a conflict the caller shows, not retries.
   *
   * Dependencies share that guard because changing them can change whether launch is
   * allowed, and `enabled` shares it because it is the same kind of statement: it
   * decides whether the autopilot may start this item, and a task that already started
   * has no such question left to answer.
   * `priority` and `labels` are exempt because nothing is provisioned from them. They
   * are annotation, so re-marking a RUNNING task `blocker` is safe, and re-marking a
   * finished one keeps the record honest - the two things the guard above is protecting
   * simply are not at stake. Refusing them would make the board's priority picker dead
   * the instant its card was dispatched, for no reason anyone could name.
   *
   * Waits out any in-flight titling for the same reason `dispatch` does, inverted: the
   * model writes the whole row back when it lands, so an edit applied before it would be
   * silently reverted a beat later, in front of an operator who watched their text go in.
   */
  async update(id: string, patch: UpdateTask): Promise<Ok & { task?: Task }> {
    await this.titling.get(id);
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    if (this.assigningTasks.has(id) && !isAnnotationOnlyUpdate(patch)) {
      return { ok: false, error: "task is being assigned" };
    }
    if (
      t.sessionId
      && patch.workflowId !== undefined
      && patch.workflowId !== t.workflowId
    ) {
      return {
        ok: false,
        error: "the after-work workflow cannot change once the task has a session",
      };
    }
    if (t.status !== "backlog" && !isAnnotationOnlyUpdate(patch)) {
      return { ok: false, error: `task is ${t.status}, not in the backlog` };
    }
    if (!isAnnotationOnlyUpdate(patch) && !taskKindAllowsBacklog(patch.kind ?? t.kind)) {
      return { ok: false, error: TASK_KIND_BACKLOG_REFUSAL };
    }
    const intent = patch.intent?.trim() ?? t.intent;
    const title = patch.title?.trim();
    const agent = patch.agent ?? t.agent;
    const agentChanged = agent !== t.agent;
    const model = patch.model === undefined ? (agentChanged ? null : t.model) : patch.model;
    const effort = patch.effort === undefined ? (agentChanged ? null : t.effort) : patch.effort;
    if (effort !== null && !supportsEffort(agent, effort)) {
      return { ok: false, error: `reasoning effort ${effort} is not supported by ${agent}` };
    }
    // The repo set is replaced wholesale when named, and left alone otherwise. Safe to
    // rebuild the entries from roots because the status guard above has already refused
    // any patch that is not annotation on a task that left the backlog - so nothing here
    // has a provisioned worktree to lose.
    const extraRepos =
      patch.extraRepoRoots === undefined
        ? t.extraRepos
        : patch.extraRepoRoots.map((repoRoot) => ({
            repoRoot,
            worktreePath: null,
            branch: null,
            provider: null,
            worktreeLeaseId: null,
            baseSha: null,
            prUrl: null,
            prState: null,
            mergedAt: null,
          }));
    // The primary must not also be attached as a secondary, asked of the set this edit
    // RESULTS in rather than of the field it happened to touch.
    //
    // The route resolves and checks whenever `extraRepoRoots` is in the patch, but that is
    // only half the collision: moving the PRIMARY onto a path already attached sends a patch
    // carrying `repoRoot` alone (`taskUpdatePatch` names a field only when it changed), and
    // nothing in that direction was looking. The task would save with one repo listed twice,
    // and the failure would surface much later as a raw `git worktree add` error during the
    // all-or-nothing unwind - a message that names neither the duplicate nor the edit.
    //
    // A string comparison rather than a re-resolution, deliberately: both sides are already
    // canonical roots by this type's contract, and re-resolving a repo set the edit did not
    // touch would make a task uneditable the moment one of its directories went away.
    const collision = extraRepos.find((entry) => entry.repoRoot === (patch.repoRoot ?? t.repoRoot));
    if (collision) {
      return {
        ok: false,
        error:
          `${collision.repoRoot} is attached to this task as another repo - detach it before ` +
          `making it the primary`,
      };
    }
    // Asked of the agent this edit RESULTS in, which is what catches the case a check on
    // the incoming repo set alone would miss: switching a multi-repo task onto a harness
    // whose write scope cannot leave its cwd, without touching the repos at all.
    if (extraRepos.length > 0 && !capabilitiesFor(agent).multiRepoDispatch) {
      return {
        ok: false,
        error: `${agent} cannot be given write access to more than one repo`,
      };
    }
    const missionToolsTask = {
      kind: patch.kind ?? t.kind,
      workflowId: patch.workflowId === undefined ? t.workflowId : patch.workflowId,
    };
    if (
      (patch.agent !== undefined || patch.kind !== undefined || patch.workflowId !== undefined) &&
      kindMissionMcpRequirement(
        missionToolsTask,
        null,
        this.workflowEvidenceEnabledForTask(missionToolsTask),
      )
    ) {
      const tools = await missionToolsAvailability(agent);
      if (!tools.available) return { ok: false, error: tools.reason! };
    }
    let dependencies = t.dependencies;
    try {
      if (patch.dependencies !== undefined) {
        dependencies = this.resolveDependencies(patch.dependencies, t.id, t.dependencies);
      }
    } catch (error) {
      if (error instanceof TaskDependencyError) return { ok: false, error: error.message };
      throw error;
    }
    const next: Task = {
      ...t,
      repoRoot: patch.repoRoot ?? t.repoRoot,
      extraRepos,
      intent,
      // Emptying the title asks for one to be derived again - and from the intent as it
      // now reads, not the one the task was first shelved under. Derived here rather than
      // re-run through the model: an edit is a synchronous answer to a click, and the
      // titling wait it would cost buys a nicety on a name the operator is looking at and
      // can simply type.
      title: title === undefined ? t.title : title || deriveTitle(intent),
      kind: patch.kind ?? t.kind,
      agent,
      // Read by `in`, not by truthiness: `priority: null` is a caller deliberately
      // clearing the field back to unset, and `?? t.priority` would silently ignore them.
      priority: "priority" in patch ? (patch.priority ?? null) : t.priority,
      labels: patch.labels ?? t.labels,
      dependencies,
      // Guarded by the status check above, like the provisioning fields and unlike
      // priority/labels: it is a statement about scheduling, and there is nothing left
      // to schedule once the task has left the backlog.
      enabled: patch.enabled ?? t.enabled,
      // `undefined` leaves an override as it stands unless the agent changed; `null` is
      // the caller clearing it, which is a value the row can hold and cannot use `??`.
      model,
      effort,
      // Like model and effort, this is provisioning intent: it can change while shelved
      // and is frozen once the session that will carry the binding has launched.
      workflowId: patch.workflowId === undefined ? t.workflowId : patch.workflowId,
      updatedAt: Date.now(),
    };
    this.registry.upsertTask(next);
    return { ok: true, task: next };
  }

  /**
   * Link a backlog task to the external item that was just created FOR it.
   *
   * The counterpart of `create({source})`, for the direction that did not exist until
   * push did: a swept task is born carrying its ref, and this is the only way a task
   * born here acquires one. `UpdateTask` deliberately cannot set `source` - provenance
   * is not something an HTTP client gets to assert about a row - so this is a separate,
   * narrower call rather than another optional field on the edit path.
   *
   * SYNCHRONOUS, and that is a requirement rather than a convenience. Its caller
   * (`src/server/task-sources/push.ts`) runs it inside `inTransaction` alongside the
   * `task_source_seen` write, and SQLite transaction bodies are synchronous - an async
   * body would commit before it resolved and split the pair this feature exists to keep
   * together. So this cannot wait out in-flight titling the way `update` does, and it does
   * not need to: `autoTitleThenDispatch` re-reads the row before writing its title, so a
   * title that lands after this one carries the link forward, and one that lands before is
   * simply the row this reads.
   *
   * Every refusal is RETURNED, never thrown, and that is the second requirement. A throw
   * would roll the caller's transaction back, taking the seen row with it - and the seen
   * row is precisely what must survive a task that vanished mid-push, or the next sweep
   * re-files the very issue this push just created.
   *
   * There are exactly two refusals, and STATUS is deliberately not one of them - which is
   * where this parts company with `update`. That guard exists because a dispatched task's
   * title and repo have already been cut into a branch name and a terminal home, so
   * rewriting them changes the card without propagating. Nothing is provisioned from
   * `source`: it is a record of something that HAPPENED, and it happened while the task
   * was in the backlog, because `pushTask` refuses to publish for a task that has left it.
   * Refusing to write it down because the operator dispatched the task during the two
   * seconds `gh` was running would throw away the identity of an issue that exists - and
   * with it the "already linked" guard that stops a later push filing a second one.
   */
  attachSource(id: string, ref: TaskSourceRef): Ok & { task?: Task } {
    const t = this.registry.getTask(id);
    // Deleted while the push was in flight. The one state that genuinely cannot hold a
    // link, and the caller reports the created item's name because this is where the
    // knowledge of it ends.
    if (!t) return { ok: false, error: "no such task" };
    // Re-checked here rather than trusted from the caller's earlier look, because the
    // window between them is a subprocess talking to GitHub. Refused rather than
    // overwritten: the first item is the one that exists, and clobbering its ref would
    // leave it unreachable from the task it was created for.
    if (t.source) {
      return { ok: false, error: `task is already linked to ${t.source.externalId}` };
    }
    const task: Task = { ...t, source: ref, updatedAt: Date.now() };
    // The db upsert behind this already persists `source_id/external_id/source_url` and
    // the registry emits `task_upsert` - so the dashboard learns of the link over the
    // stream that already exists, and this feature adds no `ServerEvent`.
    this.registry.upsertTask(task);
    return { ok: true, task };
  }

  /**
   * The task this session is executing right now, or undefined - the serial-execution
   * invariant, asked as a question.
   *
   * A session runs tasks SERIALLY over its life: `Task.sessionId` is a "currently
   * executing on" pointer that moves from one task to the next, and at most one
   * NON-TERMINAL row may hold it at a time. Filtered on STATUS rather than on the
   * pointer alone, because a `done` or `failed` row keeps naming its session until the
   * agent takes its next task (see `Task.sessionId`) - reading those as "busy" would
   * make an agent that finished permanently ineligible for more work, which is the
   * whole problem the completion paths exist to remove.
   */
  private executingTaskOn(sessionId: string): Task | undefined {
    return this.registry
      .listTasks()
      .find(
        (t) =>
          t.sessionId === sessionId &&
          (t.status === "running" || t.status === "dispatching"),
      );
  }

  /**
   * Hand a backlog task to an agent that is ALREADY running, instead of cutting a
   * fresh worktree and launching one. This is what the board's drag-onto-an-idle-
   * agent gesture calls: the operator has an agent sitting free in the right repo
   * and would rather feed it than pay for another checkout.
   *
   * An agent may take SEVERAL tasks over its life, one after another - that is the
   * point of recycling it - but never two at once. This is one of the two enforcement
   * points of that serial-execution invariant (`agentIsFree` is the other, for the
   * autopilot's own selection): the refusal below is the server-side re-check, and it
   * has to be here rather than only in the caller because a session can pick up a task
   * between the moment something decided it was free and the POST that acts on it.
   *
   * The critical difference from `dispatch`: an assigned task owns no worktree. The
   * agent keeps its own checkout - very often the operator's real one - so
   * `worktreePath` stays null, and that is precisely what keeps a later Cancel from
   * running `git worktree remove --force` over a directory we did not create.
   *
   * That reuse is what the reset below is for: the agent keeps the checkout, so unless
   * something puts it back to origin's default branch the new task inherits the last
   * one's branch and context. It also means an assign CLEARS the session's work queue,
   * because the reset does - those items were authored against a branch that no longer
   * exists.
   *
   * Which is why an assign that would take any of that ASKS FIRST. `resetWouldDestroyWork`
   * covers only what git holds; the queue, the context and the branch name are losses
   * origin cannot undo, and a drag gesture that spends them unannounced is the same
   * unconfirmed destruction the Reset button's dialog exists to prevent. An agent with
   * nothing to lose - empty queue, no branch - still takes a task in one gesture.
   *
   * Every refusal below is a state conflict the caller should surface, not retry, and
   * each says whose fault it is (`scope`) - see `AssignRefusalScope`.
   *
   * `inject` and `paneReady` are parameters for the same reason `inject` is one on
   * `injectPrompt` itself: they are the calls here that leave the process, and the
   * window they hold open is where this method's ordering rules can be broken.
   */
  async assign(id: string, sessionId: string, opts: AssignOptions = {}): Promise<AssignOutcome> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task", scope: "task" };
    if (t.status !== "backlog") {
      return { ok: false, error: `task is ${t.status}, not in the backlog`, scope: "task" };
    }
    if (!taskKindAllowsBacklog(t.kind)) {
      return { ok: false, error: TASK_KIND_BACKLOG_REFUSAL, scope: "task" };
    }
    // Provider-owned tasks need the provider's own terminal launch. Handing one to an
    // existing harness session would bypass that launch and type an engine idea into an
    // agent, which is a different operation with no engine run behind it.
    if (TASK_KIND_BEHAVIOR[t.kind].launch !== "harness") {
      return {
        ok: false,
        error: `${t.title} must be dispatched so its pipeline provider can open the terminal session`,
        scope: "task",
      };
    }
    // Multi-repo tasks are DISPATCH-ONLY, and this is where that is enforced for every
    // caller - the board's drag, Foreman's autopilot, the HTTP route.
    //
    // Not a policy preference: assignment hands a task to a session that already exists,
    // and everything a secondary repo needs was decided when that session LAUNCHED. Its
    // extra worktrees are provisioned by the dispatcher, and its write access to them is a
    // launch-time grant that neither harness can widen afterwards (Claude's runtime
    // directory control refuses anything outside the launch set; Codex's sandbox is fixed
    // for a thread). Accepting one here would produce a session holding an intent that
    // names repositories it cannot reach, which fails as confused agent output rather than
    // as an error anybody can act on.
    if (t.extraRepos.length > 0) {
      return {
        ok: false,
        error:
          `${t.title} attaches ${t.extraRepos.length} more ` +
          `${t.extraRepos.length === 1 ? "repo" : "repos"} - a multi-repo task has to be ` +
          `dispatched, because its extra worktrees and their write access are granted at launch`,
        scope: "task",
      };
    }
    // The same refusal `dispatch` applies, and it has to be here too: assigning onto a
    // running agent is the autopilot's OTHER way of starting a parked task, and a guard
    // on one path only is the drift this whole feature is built to avoid.
    if (refusedAsDisabled(t, opts.overrideDisabled)) {
      return { ok: false, error: DISABLED_REFUSAL, scope: "task" };
    }
    const dependencyBlockers = this.dependencyBlockers(t);
    if (dependencyBlockers.length > 0) {
      return {
        ok: false,
        error: `task is waiting on ${dependencyBlockers.map((blocker) => blocker.title).join(", ")}`,
        scope: "task",
      };
    }

    const s = this.registry.getSession(sessionId);
    if (!s) return { ok: false, error: "no such session", scope: "session" };
    if (this.assigningTasks.has(id)) {
      return { ok: false, error: "task is already being assigned", scope: "task" };
    }
    if (this.assigningSessions.has(sessionId)) {
      return { ok: false, error: "that agent is already taking another task", scope: "session" };
    }
    // The serial-execution invariant, refused as early as it can be seen. Reaching the
    // claim with a second non-terminal task bound would not merely double-book the agent:
    // `upsertTask` keeps the session pointer exclusive, so the first task would be
    // silently unbound and left `running` with nothing left that could ever settle it -
    // `reconcileTasksBoundTo` and `reconcileTasksWithNoLiveSession` both find their rows
    // through that pointer.
    const executing = this.executingTaskOn(sessionId);
    if (executing) {
      return {
        ok: false,
        error: `that agent is already running ${executing.title} - it takes one task at a time`,
        scope: "session",
      };
    }
    this.assigningTasks.add(id);
    this.assigningSessions.add(sessionId);
    try {
      return await this.assignReserved(t, s, opts);
    } finally {
      this.assigningTasks.delete(id);
      this.assigningSessions.delete(sessionId);
    }
  }

  private async assignReserved(
    t: Task,
    s: Session,
    opts: AssignOptions,
  ): Promise<AssignOutcome> {
    const inject = opts.inject ?? injectPrompt;
    const paneReady = opts.paneReady ?? paneAcceptsPrompt;
    const reset =
      opts.reset ??
      ((session: Session) =>
        // The supervisor is what lets an embedded agent's context actually be wiped before
        // its next task's intent is typed at it. Without it the reset reports
        // `cleared: false`, `workIdentityReady` stays false, and `assignReserved` correctly
        // refuses to hand the task over - so this is the difference between an SDK session
        // taking a second task and never taking one.
        resetSession(
          this.registry,
          session,
          true,
          undefined,
          driverClearFor(this.supervisor),
          this.pendingTurns,
        ));
    // The driver arm is supplied here rather than left to `rename`'s default for the same
    // reason `driverClearFor` is above: an embedded session handed a new task has to stop
    // advertising the old one, and its name lives in a row rather than on a handle. Without
    // this the auto-titler would run, find no pane, and silently leave the previous task's
    // title on the card - the exact state `renameForTask` exists to prevent.
    const doRename: NonNullable<AssignOptions["rename"]> =
      opts.rename ?? ((session, name) => rename(session, name, undefined, renameDriverSession));

    if (s.state !== "idle") {
      return {
        ok: false,
        error: `that agent is ${s.state.replace("_", " ")} - drop onto an idle one`,
        scope: "session",
      };
    }
    if (!s.instrumented) {
      return {
        ok: false,
        error: "that agent has no live hook instrumentation to confirm a safe handover",
        scope: "session",
      };
    }
    // Reports idle, but something is already parked on it waiting for the human. The
    // dashboard files such a session under "needs you" rather than "idle" and won't
    // offer it as a target; refuse it here too, so the API can't route around a rule
    // the operator can see being applied on screen.
    if (s.pendingReviews > 0) {
      return {
        ok: false,
        error: "that agent has a review waiting on you - clear it first",
        scope: "session",
      };
    }
    // Running a task's intent against the wrong checkout is the one way this gesture
    // does damage you cannot undo from the dashboard, so a mismatch is refused rather
    // than best-efforted. Compared on repoRoot, not cwd: a linked worktree of the
    // task's repo is a legitimate home for it, a different repo never is.
    if (!s.repoRoot || s.repoRoot !== t.repoRoot) {
      return {
        ok: false,
        error: `that agent is in a different repo (${s.repoRoot ?? "no repo"})`,
        scope: "session",
      };
    }
    const resourceOwner = this.registry.taskResourceOwnerForSession(s.id);
    if (resourceOwner) {
      return {
        ok: false,
        error: `that agent still holds resources for ${resourceOwner.title} - clean up that task before reusing it`,
        scope: "session",
      };
    }
    // Asked BEFORE the reset, and that ordering is the whole reason it is a separate
    // probe. Everything below strips the agent - detaches its checkout, drops its work
    // queue, wipes its context - for the sake of a prompt that is typed at the very end.
    // Finding out then that the pane has no handle, or that a human is sitting in
    // copy-mode reading their scrollback, leaves an agent taken apart for a task that
    // goes straight back to the backlog.
    const pane = await paneReady(s);
    if (!pane.ok) {
      return { ok: false, error: pane.error ?? "that agent's pane cannot take a prompt", scope: "session" };
    }

    // A scout cannot finish its normal contract without submitting its report through our MCP
    // server, and an assignment cannot change an already-running process's launch allowlist - so if the
    // bundle it would have to call is not on this machine at all, the assignment is refused
    // HERE, before the reset. The alternative is an agent whose checkout has just been wiped
    // working towards a task it can provably never complete normally.
    //
    // The bundle's presence is what can honestly be established: whether THIS session's launch
    // registered it is a property of a process we did not necessarily start. A dispatched
    // session carried `--mcp-config` (see `askChannelArgs`), and an operator's own session
    // reaches the same server through `claude mcp add` if they installed the integration. The
    // agent's own submission failure is the backstop for the remaining case, and it happens
    // with the checkout intact rather than after it was reset.
    const workflowEvidence = this.workflowEvidenceEnabledForTask(t);
    const requiresSubmissionTool = t.kind === "scout" || workflowEvidence;
    const mcpDescriptor = requiresSubmissionTool
      ? await (opts.missionMcpDescriptor ?? missionMcpDescriptor)(s.cwd ?? undefined)
      : null;
    if (requiresSubmissionTool && !mcpDescriptor) {
      return {
        ok: false,
        error: t.kind === "scout"
          ? "this is a scout, and Mission Control's MCP server is not built on this machine, so "
            + "the agent could not submit the report the task needs to finish"
          : "this workflow accepts image evidence, but Mission Control's MCP server is not built on this machine",
        scope: "task",
      };
    }
    // Present is not the same as usable. A bundle can be on disk and still not publish
    // `submit_scout_artifacts` - `dist/mcp/server.mjs` is rebuilt only by `npm run build` and
    // ignored by git, so it drifts behind the source that introduced the tool, and an operator
    // who pulled the scout feature has the tool in `src/` and not in the file the agent runs.
    // That reads to this probe exactly like a working install, and the scout it admits is one
    // whose checkout we are about to reset for a task it can provably never finish - which is
    // the precise outcome the guard above exists to prevent. Same question, asked of the bytes.
    //
    // Asked THROUGH the session, not of the file alone. This agent is already running and its
    // MCP server is a child it spawned at launch, so the file on disk only speaks for it while
    // the two are the same build - see `verifyMissionMcpToolsForRunningSession`. Interrogating
    // the current file after a rebuild would report on a process this agent is not using.
    if (requiresSubmissionTool) {
      // Handed the descriptor resolved just above rather than a second resolution of it, so
      // this reports on the very bundle the check above admitted - and asked about EVERY tool
      // this assignment needs rather than one of them. The two requirements are independent:
      // a scout needs its report tool, and a workflow-armed task of any kind needs the
      // evidence tool. A scout carrying a Persona workflow needs both, so asking about the
      // first and inferring the second would admit a bundle publishing only the older of the
      // two - the same stale `dist/` this probe exists for, one tool later.
      let published: Awaited<ReturnType<typeof verifyMissionMcpToolsForRunningSession>>;
      try {
        published = await (
          opts.verifyMissionMcpToolsForRunningSession ?? verifyMissionMcpToolsForRunningSession
        )(
          [
            ...(t.kind === "scout" ? [SUBMIT_SCOUT_ARTIFACTS_TOOL] : []),
            ...(workflowEvidence ? [SUBMIT_WORKFLOW_EVIDENCE_TOOL] : []),
          ],
          s.startedAt,
          mcpDescriptor,
        );
      } finally {
        cleanupAgentSubprocessEnv(mcpDescriptor?.env);
      }
      if (!published.ok) {
        return {
          ok: false,
          // Names what this assignment needed, so a scout that also carries a workflow does
          // not report only half of why it was refused.
          error: t.kind === "scout"
            ? `this is a scout${workflowEvidence ? " with a workflow that accepts evidence" : ""}, `
              + `and ${published.reason}, so the agent could not hand over what the task needs to finish`
            : `this workflow accepts image evidence, and ${published.reason}`,
          scope: "task",
        };
      }
    }
    if (t.kind === "scout") {
      if (!s.cwd) {
        return {
          ok: false,
          error: "this agent has no checkout to authorize for scout submission",
          scope: "session",
        };
      }
      try {
        (opts.provisionScoutCredential ?? provisionScoutSubmissionCredential)(t.id, s.cwd);
      } catch (error) {
        return {
          ok: false,
          error: `could not authorize this scout's submission channel - ${error instanceof Error ? error.message : String(error)}`,
          scope: "task",
        };
      }
    }

    // The plan equivalent of the scout probes above, and refused in the same place for the
    // same reason: everything below this line is destructive, so a plan whose contract cannot
    // be honoured has to be turned away with the agent's checkout still intact rather than
    // after it has been reset for work it can provably not do.
    //
    // `planSkillsForSession`, NOT the launch-time resolver. This types into a conversation
    // that already exists, and a session that has not acknowledged the current skills
    // generation is still holding the previous set - so the launch-time answer would have this
    // seam paste an invocation naming a skill the agent cannot load, which is exactly the
    // silent degradation the watermark rung exists to turn into a refusal.
    const planSkills = isPlanTask(t)
      ? (opts.requirePlanSkills ?? planSkillsForSession)(s)
      : null;
    if (planSkills && !planSkills.ok) {
      return { ok: false, error: planSkills.message, scope: "task" };
    }

    // A reused agent starts the new task from origin's default branch with a cleared
    // context, not wherever the last one left it.
    //
    // The state this fixes is the ordinary one, not an edge case: an agent that just
    // shipped is standing on its own feature branch with that work committed. Typing
    // the next task in stacks unrelated commits on top of it, so two tasks can arrive
    // in one pull request.
    // `resetSession` is the same operation the Reset button performs (git reset --hard
    // onto origin/main, clean, detach the branch, /clear), so a recycled agent is handed
    // over in the shape a freshly dispatched one starts in.
    //
    // Guarded rather than unconditional, and the guard REFUSES rather than proceeding.
    // A reset is destructive and the autopilot's is unwatched: the button has a confirm
    // dialog with a loss preview in front of it. So a checkout holding work sends the
    // task back to the backlog with a sentence saying what is in the way, which the
    // operator can act on - the one outcome we cannot offer is silently discarding it.
    const holding = await resetWouldDestroyWork(s);
    if (holding) {
      return { ok: false, error: `that agent's checkout cannot be reset - ${holding}`, scope: "session" };
    }
    // Git is not the whole loss. The reset also drops the agent's work queue, wipes its
    // context and takes its branch away, and none of that is recoverable from origin -
    // so the human drag gesture is told what it is about to spend and asked once. The
    // breakdown travels WITH the refusal so the dialog and the action cannot disagree
    // about a queue that moved in between.
    if (!opts.confirmReset) {
      const confirm = await this.resetConfirmFor(s);
      if (needsResetConfirm(confirm)) {
        return {
          ok: false,
          error: `resetting that agent first would discard ${describeResetLoss(confirm)}`,
          scope: "session",
          resetConfirm: confirm,
        };
      }
    }
    // Re-read immediately before the destructive step. The idle check above is by now
    // several git invocations old, and the reset itself spends up to 30s in a fetch -
    // an agent a human woke up in that window must not be reset out from under them.
    const fresh = this.registry.getSession(s.id);
    if (
      !fresh ||
      !fresh.instrumented ||
      fresh.state !== "idle" ||
      fresh.pendingReviews > 0
    ) {
      return { ok: false, error: "that agent stopped being idle - try again", scope: "session" };
    }
    // And the serial invariant again, in the same breath and for the same reason: the
    // probes above spend up to 30s in a fetch, and a dispatch or a Foreman assignment
    // could have bound this agent a task in that window. Asked HERE, in front of the
    // reset, because everything below is destructive - past this line the checkout is
    // detached and the context wiped, so a refusal costs the operator work rather than
    // merely a retry.
    const claimed = this.executingTaskOn(s.id);
    if (claimed) {
      return {
        ok: false,
        error: `that agent started running ${claimed.title} - it takes one task at a time`,
        scope: "session",
      };
    }

    const done = await reset(s);
    if (!done.ok) {
      return { ok: false, error: `could not reset that agent's checkout - ${done.error}`, scope: "session" };
    }
    // `cleared` means the agent was SEEN acting on the `/clear`, not that tmux took the
    // keystrokes. Believing the weaker one is how a task gets claimed with nothing
    // running it: a `/clear` processed after the paste below wipes the prompt off the
    // composer, and the pane read that follows the paste finds nothing pending and calls
    // that success. Unconfirmed, the task stays in the backlog.
    if (!done.cleared) {
      return {
        ok: false,
        error: "could not confirm the agent cleared its context, so the task was not typed",
        scope: "session",
      };
    }
    if (done.workIdentityReady === false || (!opts.reset && !done.workIdentityReady)) {
      return {
        ok: false,
        error: "could not confirm the agent's new work identity, so the task was not typed",
        scope: "session",
      };
    }
    if (opts.reset) {
      this.registry.resetWorkEpisode(s.id);
    }
    if (this.registry.workEpisodeForSession(s.id)?.awaitingAgentRebind) {
      return {
        ok: false,
        error: "could not confirm the agent's new work identity, so the task was not typed",
        scope: "session",
      };
    }

    const ready = this.registry.getTask(t.id);
    if (!ready || ready.status !== "backlog") {
      return {
        ok: false,
        error: ready ? `task is ${ready.status}, not in the backlog` : "no such task",
        scope: "task",
      };
    }
    const blockers = this.dependencyBlockers(ready);
    if (blockers.length > 0) {
      return {
        ok: false,
        error: `task is waiting on ${blockers.map((blocker) => blocker.title).join(", ")}`,
        scope: "task",
      };
    }

    // Type the prompt BEFORE claiming the task: if the pane refuses (it is locked, or
    // the agent died between the drop and here) the task must stay in the backlog,
    // droppable again, rather than sit marked `running` with nothing running it.
    //
    // The kind's contract rides on the SAME text, composed here rather than in the dispatcher,
    // because this seam types `ready.intent` straight into a live pane and a dispatcher-only
    // helper would leave every assigned scout with no idea it owed an HTML page and every
    // assigned plan with no idea which skill to reach for. `assign` refuses a multi-repo task,
    // so the one repository slot this resolves is the session's own checkout - which is also
    // the tree the capture path will read.
    // The scout boundary is frozen here rather than at dispatch's seam for the same reason
    // the contract is composed here: this is where the prompt crosses into the runtime on
    // this path. It matters more on an assignment than on a dispatch - the session already
    // holds a conversation, so the offset recorded now is the only thing that later
    // separates this scout's follow-ups from whatever the agent was doing beforehand.
    const boundary = freezeScoutPromptBoundary(this.registry, ready, s.id, "current");
    // A THROW is a failed delivery too, and it has to undo the boundary for the same reason
    // a refusal does - the task stays in the backlog, so a surviving row would claim an
    // episode saw a task nobody has been given. `inject` is injectable here and the guard
    // callback runs inside it, so neither is bound to resolve `{ ok: false }` rather than
    // reject; the dispatcher's seam guards the same risk the same way.
    let r: InjectResult;
    try {
      // AN ASSIGNMENT RESOLVES NOTHING. The repository cannot have changed - `assign`
      // refuses a multi-repo task and stands in the session's own checkout - so the only
      // thing that could have is the configuration, and a live process's system prompt
      // cannot be rewritten. Re-resolving here would give the pairs with a durable channel
      // one mid-session semantic and the pairs without one another, for the same feature.
      // One boundary instead: a session keeps the standing instructions it launched with.
      //
      // So this replays the session's own launch snapshot, and only for a session whose
      // pair had no out-of-band channel. On the three pairs that do, the block is still
      // installed on that process - that is what "durable" means - and prefixing it again
      // would have the agent read the same rule twice. A session with no snapshot acquires
      // nothing mid-life.
      const launched = this.registry.standingInstructionsFor(s.id);
      const standingPrefix = launched?.mechanism === "prompt-prefix" ? launched.text : "";
      r = await inject(
        this.registry.getSession(s.id) ?? s,
        withTaskKindContract(ready, withStandingInstructions(standingPrefix, ready.intent), {
          fallbackRoot: s.cwd,
          planSkills: planSkills?.ok ? planSkills.commands : null,
          workflowEvidence,
        }),
        undefined,
        () => this.registry.promptResourceBlockerForSession(s.id),
      );
    } catch (err) {
      discardScoutPromptBoundary(boundary);
      throw err;
    }
    // The boundary is discarded on anything short of a VERIFIED submit, which is a wider
    // refusal than the task's own. `injectPrompt` returns `{ ok: true, submitVerified: false }`
    // on two reachable paths - a harness that renders no pending-paste placeholder, and a run
    // of unreadable captures - and both mean the Enter went out while the text may still be
    // sitting in the composer. The task still proceeds on `ok` alone, exactly as it always
    // has: reversing that would change what assignment MEANS, which is not archive
    // bookkeeping's call to make. But a boundary is a claim that this episode was handed this
    // prompt, and an unconfirmed paste cannot support that claim.
    //
    // The cost of being wrong this way is a scout that loses its frozen title and anchor and
    // falls back to the legacy task title with an honestly truncated trail. The cost of being
    // wrong the other way is an archive anchored into a conversation that never started.
    if (!r.ok || !r.submitVerified) discardScoutPromptBoundary(boundary);
    if (!r.ok) {
      // Nothing was typed, and the task stays droppable. A boundary left behind would claim
      // an episode saw a task that is still sitting in the backlog.
      return { ok: false, error: r.error ?? "could not type into the agent's pane", scope: "session" };
    }

    // Merge onto the LATEST snapshot, not the one read before the injection, for the
    // same reason `cancel` and `reclaim` do it: typing into a pane takes long enough
    // for a retriage to land, and priority/labels stay editable in every status - so a
    // stale spread here writes yesterday's priority back over one just set on the card,
    // silently, on a gesture that was only meant to hand the task to an agent.
    const cur = this.registry.getTask(t.id) ?? t;
    const now = Date.now();
    this.registry.upsertTask({
      ...cur,
      status: "running",
      sessionId: s.id,
      dispatchedAt: now,
      updatedAt: now,
    });
    this.registry.bindTaskToWorkEpisode(t.id, s.id);
    // The agent now IS this task, so its terminal has to say so - see `renameForTask`.
    // Last, and after the claim: it is the one step here that changes nothing about
    // whether the task is running, so it must not sit in front of anything that does.
    await this.renameForTask(
      // Re-read for the same reason the task is: the reset detached the checkout and the
      // injection took a round trip, and `rename` targets the terminal home BY NAME.
      this.registry.getSession(s.id) ?? s,
      this.registry.getTask(t.id) ?? cur,
      doRename,
    );
    return { ok: true };
  }

  /**
   * Name the agent's terminal after the task it just took, the way a fresh dispatch does.
   *
   * A dispatch cuts its session name from the task title, so a launched agent's card is
   * titled by its work from the first frame. An assign reuses a terminal that was
   * named for something else - the pooled worktree it was handed out as, or the task it
   * finished ten minutes ago - and everything else about the handover (branch back to
   * origin's default, work queue dropped, context cleared) already says this is a fresh
   * start. Leaving the name behind is how a board ends up with a card reading one task
   * while running another, which is worse than either name alone: the operator cannot tell
   * from the card which of the two is the lie.
   *
   * Best-effort, and deliberately AFTER the task is claimed. The task is typed and running
   * by the time this is reached; failing the assign over a cosmetic rename would send a
   * task that an agent is already working on back to the backlog, to be handed to a second
   * agent. So every refusal below is a silent no-op that leaves the old name standing.
   *
   * The fallback name exists for one reason: a rename onto a name a live terminal home
   * already holds fails, and `validateSessionNameAgainstTasks` refuses a name a task's
   * teardown still aims at (taking it would point that task's `killHome` at this agent).
   * Both are answered the same way `spawnUniquely` answers them - retry once under a name
   * the task id makes unique.
   */
  private async renameForTask(
    s: Session,
    t: Task,
    doRename: NonNullable<AssignOptions["rename"]>,
  ): Promise<void> {
    // This session's OWN backend spells the name, not the one a fresh dispatch would land
    // on: the two can differ (an operator's multiplexer session on a machine where a dispatch
    // would open a tab), and sanitizing for the wrong one strips characters this rename
    // could have kept - or keeps ones it cannot.
    const label = nameRulesFor(s).sanitize(t.title);
    if (s.name === label) return;
    if (!canRename(s)) {
      this.registry.nameDispatchedEmulatorSession(s.id, label);
      return;
    }
    for (const candidate of [label, `${label}-${t.id.slice(0, 6)}`]) {
      // `sanitize` already strips what this backend's names cannot hold, so this normally
      // only refuses a session with nowhere for a name to live at all - a terminal session
      // with no handle, whose card is named after its process.
      const valid = validateSessionName(s, candidate);
      if (!valid.ok) continue;
      if (!validateSessionNameAgainstTasks(s, valid.name, this.list()).ok) continue;
      const r = await doRename(s, valid.name).catch((err) => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (r.ok) {
        this.registry.renameSession(s.id, valid.name);
        return;
      }
    }
  }

  /**
   * What the handover reset would take from this agent that git cannot give back.
   *
   * Read from the registry and the checkout at the moment of deciding, and returned
   * with the refusal, so the dialog the operator answers describes the same state the
   * assign will act on.
   */
  private async resetConfirmFor(s: Session): Promise<AssignResetConfirm> {
    return {
      queuedItems: s.queue?.openCount ?? 0,
      // Whether the handover can clear the agent's context, which is a delivery question
      // rather than a pane one: a pane-backed session is typed at, a driver-run one is asked
      // through its handle. `assign` has already refused a session it cannot reach at all by
      // the time this is asked.
      clearsContext: canMessage(s),
      branch: await branchReleasedByReset(s),
    };
  }

  /** Stop only an agent this task launched, leaving assigned operator sessions alone. */
  private async quiesceLaunchedAgentBeforeCapture(t: Task): Promise<void> {
    const session = t.sessionId ? this.registry.getSession(t.sessionId) : undefined;
    if ((t.worktreePath || providerOwnsTaskCompletion(t.kind)) && session?.runtime === "sdk") {
      if (!this.supervisor) throw new Error("this build has no session supervisor");
      if (this.supervisor.handleFor(session.id)) await this.supervisor.stop(session.id);
    }
    if (!t.homeName) return;
    if (session) {
      const stopped = await this.closeMergedSessionDeps.kill(session);
      if (!stopped.ok) throw new Error(stopped.error ?? "could not stop the task agent");
      return;
    }
    const alive = await homeAlive(t.homeName, undefined, t.homeBackend ?? null, t.terminalResourceId);
    if (alive === false) return;
    const stopped = await killHome(t.homeName, undefined, t.homeBackend ?? null);
    if (!stopped.asked || !stopped.ok) {
      throw new Error(stopped.error ?? `no terminal backend could stop ${t.homeName}`);
    }
  }

  /**
   * Publish this task's archives before anything destroys the checkout they live in.
   *
   * Every destructive path in this class runs `teardownWorktree`, which is
   * `git worktree remove --force` or a pooled lease handed back, and it takes the checkout
   * with it. So the last moment at which durable work can be saved is right here, before the
   * teardown, on every one of those paths rather than on the visible Reclaim button alone.
   *
   * Kind-neutral by name because it is now kind-neutral in fact: a scout's report and a plan
   * task's plan directories both reach the archive library through this one line, and which
   * of them applies is settled inside the gate rather than here. That keeps the five call
   * sites below identical and stops a sixth teardown path being added that remembered only
   * one kind.
   *
   * A refusal is returned rather than swallowed, and the caller must stop: the resources stay
   * tracked and the operator can retry, which is strictly better than freeing a worktree and
   * discovering afterwards that the work went with it. A ship task, a task with no archive
   * gate, and a task whose bundles are already published all return `ok` without touching the
   * filesystem - as does a plan task that produced no plan at all, which is a real and
   * allowed outcome rather than an anomaly, and must not hold a worktree for ever.
   */
  private async settleArchivesBeforeTeardown(id: string): Promise<Ok> {
    if (!this.archives) return { ok: true };
    try {
      const settled = await this.archives.settleBeforeCleanup(id);
      return settled.ok ? { ok: true } : { ok: false, error: settled.error };
    } catch (error) {
      return {
        ok: false,
        error: `this task's archive could not be published: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Stop a task's agent and reclaim its (ephemeral) worktree, marking it
   * cancelled. A dispatched agent's tree is throwaway - to preserve work you
   * Focus and commit/PR it before cancelling - so cancel always reclaims, which
   * keeps the teardown model simple and leak-free (no keep/remove ambiguity that
   * an in-flight dispatch could race).
   *
   * Cancel only kills agents we LAUNCHED. An assigned task (dropped onto an agent
   * that was already running) never had a terminal home of ours, and killing it would
   * take down the operator's own session - along with whatever else it was doing
   * before we handed it this task. For those, cancel means "stop tracking it", and
   * the human stops the agent themselves if they want it stopped.
   */
  async cancel(id: string): Promise<Ok> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    const engineerReservation = t.kind === "pipeline"
      ? this.registry.requestPipelineEngineerReservationCancellation(id)
      : null;
    try {
      return await this.withCleanupReservation<Ok>(
        id,
        { ok: false, error: "this task's resources are being cleaned up - try again in a moment" },
        () => this.cancelReserved(id, t),
      );
    } finally {
      if (engineerReservation) {
        this.registry.finishPipelineEngineerReservationCancellation(
          id,
          this.registry.getTask(id)?.status === "cancelled",
        );
      }
    }
  }

  /** `cancel`'s body, once the cleanup reservation is held. */
  private async cancelReserved(id: string, t: Task): Promise<Ok> {
    const cancellationWarnings: string[] = [];
    const commission = this.registry.pipelineCommissionForTask(id);
    // Once Engineer handed off a specification, cancelling the Task applies to the later
    // implementation run. The authoring commission is successful history at that point, so
    // rewriting it to `cancelled` would make every projection claim Engineer failed to finish.
    const authoringCommission =
      commission &&
      commission.handoff === null &&
      commission.linkedRun === null &&
      !["awaiting_spec_merge", "cancelled", "settled"].includes(commission.lifecycle)
        ? commission
        : null;
    if (authoringCommission) {
      const active = authoringCommission.attempts.find(
        (attempt) => attempt.attempt === authoringCommission.activeAttempt,
      );
      if (active && !active.engineerRunId && !["cancelled", "failed", "settled"].includes(active.state)) {
        const reservation = this.registry.requestPipelineEngineerReservationCancellation(id);
        if (!reservation) {
          return {
            ok: false,
            error: "the provider Engineer run reservation is still in progress - try cancellation again",
          };
        }
        if (!(await reservation)) {
          return {
            ok: false,
            error: "the provider Engineer run reservation did not produce a cancellable run",
          };
        }
        return await this.cancelReserved(id, this.registry.getTask(id) ?? t);
      }
      if (active?.engineerRunId && !["cancelled", "failed", "settled"].includes(active.state)) {
        const lifecycle = PIPELINE_PROVIDERS[authoringCommission.provider].engineerLifecycle;
        if (!lifecycle) {
          return { ok: false, error: "the Pipeline provider cannot cancel its active Engineer run" };
        }
        let stopped;
        try {
          stopped = await lifecycle.cancel({
            engineerRunId: active.engineerRunId,
            reason: "Pipeline task cancelled in Mission Control",
          });
        } catch (error) {
          return {
            ok: false,
            error: `could not cancel the provider Engineer run: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
        if (!stopped.ok) {
          return { ok: false, error: `could not cancel the provider Engineer run: ${stopped.error}` };
        }
        await refreshPipelineCommission(this.registry, authoringCommission);
      }
      try {
        const cancelled = cancelPipelineCommission({
          commissionId: authoringCommission.id,
          reason: "Pipeline task cancelled in Mission Control",
        });
        this.registry.upsertPipelineCommission(cancelled);
      } catch (error) {
        // Provider cancellation may have succeeded just before replay advances the durable
        // commission to a terminal lifecycle. Keep cancelling the local task and its agent;
        // an exception here must not strand them after the provider already stopped.
        cancellationWarnings.push(
          `could not cancel the Engineer commission: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (commission && (commission.handoff !== null || commission.linkedRun !== null)) {
      // A successful Engineer commission is immutable history, so the task is the terminal
      // cancellation boundary after handoff. Publish that boundary before stopping the SDK
      // host or capturing archives: either await can observe a native identity rotation, and
      // a still-running task would otherwise be rebound to the new episode while cancellation
      // already owns its resources. A teardown failure keeps those resources on this cancelled
      // row and remains retryable through Cancel.
      const current = this.registry.getTask(id) ?? t;
      const now = Date.now();
      this.registry.upsertTask({
        ...current,
        status: "cancelled",
        completedAt: now,
        updatedAt: now,
      });
    }
    // Stop an agent we launched BEFORE inspecting its checkout. Otherwise a scout can finish
    // writing after capture published an immutable partial but before teardown deletes the
    // tree. Assigned tasks own no worktree and no home, so this deliberately preserves the
    // existing rule that Cancel never kills the operator's own agent.
    try {
      await this.quiesceLaunchedAgentBeforeCapture(t);
    } catch (error) {
      return {
        ok: false,
        error: `could not stop task agent: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // The agent is now quiescent and the checkout still exists. A report that was complete at
    // the stop boundary is captured; a failure keeps every resource tracked for a retry.
    const archived = await this.settleArchivesBeforeTeardown(id);
    this.autoCompleted.delete(id);
    if (!archived.ok) {
      const current = this.registry.getTask(id) ?? t;
      const now = Date.now();
      this.registry.upsertTask({
        ...current,
        status: "cancelled",
        completedAt: now,
        updatedAt: now,
      });
      return {
        ok: false,
        error: `task cancelled, but ${[
          ...cancellationWarnings,
          `its resources remain tracked: ${archived.error ?? "this task's archive could not be published"}`,
        ].join("; ")}`,
      };
    }

    let teardownError: string | null = null;
    // Which worktrees actually came back. Null means every one of them did - the ordinary
    // case - and a partial failure narrows it to the ones that are really gone.
    let reclaimed: readonly string[] | null = null;
    try {
      // Re-read before tearing down so we don't miss resources a concurrent dispatch
      // created during the stop/capture awaits. teardownWorktree also closes the terminal
      // home if it survived the direct stop above.
      const teardownTarget = this.registry.getTask(id) ?? t;
      await teardownWorktree(teardownTarget, this.legacyWorktrees, "foreground", this.worktrees);
    } catch (error) {
      teardownError = error instanceof Error ? error.message : String(error);
      reclaimed = reclaimedFrom(error);
    }

    // Merge onto the LATEST snapshot, not a stale one, so we don't resurrect fields
    // the dispatcher patched during the awaits.
    const cur = this.registry.getTask(id) ?? t;
    const now = Date.now();
    this.registry.upsertTask({
      ...cur,
      status: "cancelled",
      // Per TREE, not per teardown. `teardownWorktree` attempts every one of a task's trees
      // even after an earlier one fails, so "the teardown failed" no longer means "nothing
      // came back": clearing the whole collection would have the row forget trees that are
      // still standing, and keeping it would leave rows naming trees already released.
      // `releasedTaskResources` splits it on what was reclaimed.
      ...releasedTaskResources(cur, reclaimed),
      homeName: teardownError === null ? null : cur.homeName,
      homeBackend: teardownError === null ? null : cur.homeBackend,
      terminalResourceId: teardownError === null ? null : cur.terminalResourceId,
      completedAt: now,
      updatedAt: now,
    });
    if (teardownError !== null) {
      cancellationWarnings.push(`its resources remain tracked: ${teardownError}`);
    }
    return cancellationWarnings.length === 0
      ? { ok: true }
      : { ok: false, error: `task cancelled, but ${cancellationWarnings.join("; ")}` };
  }

  /**
   * Record a task's outcome. Deliberately does NOT tear down the worktree/agent -
   * "Mark done" annotates a result, it must not silently discard unpushed work.
   * The tree is freed later by an explicit, confirmed `reclaim` (or `remove`).
   *
   * `satisfyDependents` additionally closes the operator-declared edges pointing HERE.
   * Off by default, and that default is load-bearing - see `CompleteTaskSchema` for why
   * a merge is ordinarily the only thing that satisfies a declared dependency, and what
   * this exists to rescue. Callers that pass nothing behave exactly as before.
   */
  complete(
    id: string,
    outcome: string,
    outcomeUrl?: string,
    satisfyDependents = false,
    requireStopped = false,
    confirmIncompleteScout = false,
  ): Promise<Task | null> {
    return this.runCompletion(id, {
      outcome,
      outcomeUrl,
      satisfyDependents,
      requireStopped,
      confirmIncompleteScout,
      inferredFrom: null,
    });
  }

  /**
   * The one door every completion goes through, and the fork that keeps ship behaviour exact.
   *
   * A ship task never awaits anything, so it takes the synchronous path and its status write,
   * broadcast, dependency satisfaction and inferred-completion provenance all happen INSIDE
   * the caller's call, exactly as they did before completion returned a promise. That is not
   * an optimisation: `complete` runs from `session_upsert` and `session_remove` listeners that
   * read the registry on the very next line, and a completion deferred to a microtask would
   * silently stop being visible to them.
   *
   * A scout awaits its durable archive, so it takes the asynchronous path - and only that path
   * touches the in-flight map. Serializing ship completions through the same map was tried and
   * removed: the map entry outlives the write by a microtask, so a second synchronous
   * completion signal in the same turn chained onto it and was deferred, which is precisely
   * the regression above.
   */
  private runCompletion(id: string, input: CompletionInput): Promise<Task | null> {
    const gate = this.scoutGateFor(id);
    if (!gate) {
      try {
        return Promise.resolve(this.finishCompletion(id, input));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    // Two completion signals for one scout must not both publish. Chained rather than
    // deduplicated so the second acts on the state the first left behind.
    const inflight = this.completing.get(id);
    const run = inflight
      ? inflight.catch(() => null).then(() => this.completeScout(id, input, gate))
      : this.completeScout(id, input, gate);
    const tracked = run.finally(() => {
      if (this.completing.get(id) === tracked) this.completing.delete(id);
    });
    this.completing.set(id, tracked);
    return tracked;
  }

  /** The archive gate for this task, or null when there is nothing durable to wait for. */
  private scoutGateFor(id: string): TaskArchiveGate | null {
    if (!this.archives) return null;
    return this.registry.getTask(id)?.kind === "scout" ? this.archives : null;
  }

  /**
   * A scout's completion, in the order the durable evidence requires.
   *
   * 1. validate the task's current state, so a refusal costs no capture work;
   * 2. await a verified COMPLETE archive - the only await in any completion;
   * 3. finish through the same synchronous write every other completion uses, which re-reads
   *    and re-validates the row: a cancel or a reschedule can land inside a capture.
   *
   * Step 2 is a refusal on the first request rather than a fallback. There is no transcript
   * to fall back to: the archive contract is one submitted HTML page, and manufacturing an
   * archive from conversation text would publish something nobody wrote as the durable answer
   * to the question. An explicitly confirmed request may still close the task without that
   * archive, after the operator has seen the exact problems and accepted the missing record.
   */
  private async completeScout(
    id: string,
    input: CompletionInput,
    gate: TaskArchiveGate,
  ): Promise<Task | null> {
    const before = this.scoutCompletionSnapshot(id, input.requireStopped);
    if (!before) return null;
    const ready = await gate.ensureReady(id);
    if (!ready.ok && !input.confirmIncompleteScout) {
      throw new ScoutArchiveNotReadyError(ready.problems);
    }
    this.assertScoutCompletionUnchanged(id, input.requireStopped, before);
    return this.finishCompletion(id, input);
  }

  /**
   * Freeze the lifecycle facts an asynchronous scout completion is allowed to finish over.
   *
   * `status` catches cancel, `episodeId` catches a cancel/reschedule/re-dispatch that has
   * already returned to running, and the cleanup fields catch reclaim, which deliberately
   * preserves status while releasing the session and worktrees. Other task edits may proceed
   * while the archive is verified; only a lifecycle change makes the evidence stale.
   */
  private scoutCompletionSnapshot(
    id: string,
    requireStopped: boolean,
  ): ScoutCompletionSnapshot | null {
    this.assertCompletable(id, requireStopped);
    const task = this.registry.getTask(id);
    if (!task) return null;
    return {
      status: task.status,
      sessionId: task.sessionId,
      episodeId: this.registry.workEpisodeForTask(id)?.episodeId ?? null,
      cleanupResources: JSON.stringify([
        task.worktreePath,
        task.branch,
        task.provider,
        task.baseSha,
        task.homeName,
        task.terminalResourceId,
        task.extraRepos.map((repo) => [
          repo.repoRoot,
          repo.worktreePath,
          repo.branch,
          repo.provider,
          repo.baseSha,
        ]),
      ]),
    };
  }

  /** Refuse to write `done` over a lifecycle transition that landed during archive I/O. */
  private assertScoutCompletionUnchanged(
    id: string,
    requireStopped: boolean,
    before: ScoutCompletionSnapshot,
  ): void {
    const after = this.scoutCompletionSnapshot(id, requireStopped);
    if (!after) return;
    if (
      after.status !== before.status ||
      after.sessionId !== before.sessionId ||
      after.episodeId !== before.episodeId ||
      after.cleanupResources !== before.cleanupResources
    ) {
      throw new TaskStatusConflictError(
        "task changed while its scout archive was being verified; retry completion against its current run",
      );
    }
  }

  /**
   * The state guards, shared so the pre-capture check and the write cannot disagree.
   *
   * Refuses EVERY completion while a reschedule holds this task, not only the stopped-only
   * dead-blocker path: a reschedule mid-teardown still has the row cancelled/failed, so an
   * ordinary Mark done would flip it to `done` and the reschedule would then tear its worktree
   * out from under that done row, leaving it pointing at reclaimed resources. The reservation
   * covers the whole teardown window. The internal auto-settle callers never reach this throw:
   * they only complete a running/dispatching task, and a reschedule only ever holds a
   * cancelled/failed one.
   */
  private assertCompletable(id: string, requireStopped: boolean): void {
    if (this.reschedulingTasks.has(id)) {
      throw new TaskStatusConflictError("task is being rescheduled");
    }
    const t = this.registry.getTask(id);
    if (!t) return;
    if (t.kind === "pipeline" && t.pipelineCommissionId) {
      const commission = this.registry.pipelineCommission(t.pipelineCommissionId);
      const linkedKey = t.pipelineRun ? pipelineRunKeyOf(t.pipelineRun) : null;
      const processed = linkedKey
        ? this.registry.listPipelineRuns().some(
            (run) => pipelineRunKeyOf(run) === linkedKey && run.group === "processed",
          )
        : false;
      if (!commission || !processed) {
        throw new TaskStatusConflictError(
          "Pipeline completion is provider-owned until its linked implementation run is processed",
        );
      }
    }
    if (requireStopped && t.status !== "cancelled" && t.status !== "failed") {
      throw new TaskStatusConflictError(
        `task is ${t.status}, only a cancelled or failed task can be completed from a blocked dependent`,
      );
    }
  }

  /** The synchronous status write. Unchanged from before completion became awaitable. */
  private finishCompletion(id: string, input: CompletionInput): Task | null {
    this.assertCompletable(id, input.requireStopped);
    const t = this.registry.getTask(id);
    if (!t) return null;
    this.autoCompleted.delete(id);
    const now = Date.now();
    const updated: Task = {
      ...t,
      status: "done",
      outcome: input.outcome,
      outcomeUrl: input.outcomeUrl ?? null,
      error: null,
      completedAt: now,
      updatedAt: now,
    };
    // One transaction when this completion also finishes with the agent that produced it, so
    // an interruption cannot land the task without the closure it owes. `publishPersistedTask`
    // then broadcasts what that transaction already wrote, rather than writing it twice.
    if (input.closeSessionId) {
      const displaced = completeTaskWithSessionClosure(updated, {
        sessionId: input.closeSessionId,
        requestedAt: now,
        deadlineAt: now + MISSION_SESSION_CLOSURE_DEADLINE_MS,
      });
      this.registry.publishPersistedTask(updated, displaced);
      // Armed HERE, beside the write, and that placement is the invariant: a closure row is
      // never committed without something scheduled to settle it.
      //
      // This was briefly removed as redundant, on the reasoning that
      // `concludeScheduledMissionRun` settles its own row the moment it returns. That holds
      // only when this ran synchronously inside that call. A scout's completion awaits
      // `gate.ensureReady` first, so the conclusion had already looked at an empty ledger and
      // moved on by the time the row landed here - leaving a live session with nothing
      // scheduled to close it until some unrelated event happened by. Found in review.
      //
      // The ordinary path pays one extra pass, which costs a stop attempt against a session
      // that is usually already exiting and refused by the guard at the top of the settle.
      this.scheduleMissionSessionClosureSweep(0);
    } else {
      this.registry.upsertTask(updated);
    }
    // Recorded HERE rather than by the caller, and immediately after the upsert, because the
    // window between them is the whole correctness argument: `upsertTask` may evict this row
    // from the bounded in-memory list, and its `task_upsert` listener clears exactly this map.
    // Setting it from a `.then` would put both of those between the write and the record.
    if (input.inferredFrom && this.registry.getTask(id) === updated) {
      this.autoCompleted.set(id, input.inferredFrom);
    }
    // The task's upstream item, if it came from one, is owed a note. A LOCAL INSERT and
    // nothing else - the enqueuer spawns nothing and the worker does the delivering - so
    // this stays as synchronous as the rest of this function.
    //
    // The try/catch is not defensive decoration. `finishCompletion` runs inside
    // `session_upsert` and `session_remove` listeners, and a throw here would abort a
    // completion that has already been persisted and broadcast, in order to fail at
    // writing a comment nobody is waiting for.
    try {
      this.writeback?.completed(updated);
    } catch (err) {
      console.error("[writeback] enqueue on completion failed:", id, err);
    }
    if (input.satisfyDependents) this.satisfyDeclaredEdgesTo(id, now);
    return updated;
  }

  /**
   * Complete from a place that cannot await: an event listener, a reconciliation sweep.
   *
   * The rejection has to be absorbed HERE rather than leaked as an unhandled promise, and the
   * two failures it absorbs are both ordinary rather than exceptional - a reschedule holding
   * the row, and a scout that has not submitted its report. Neither is a reason to abandon a
   * sweep over every other task.
   */
  private completeInBackground(
    id: string,
    input: CompletionInput,
    onScoutRefusal?: (problems: string[]) => void,
    onCompleted?: (task: Task) => void,
  ): void {
    void this.runCompletion(id, input)
      .then((task) => {
        if (task) onCompleted?.(task);
      })
      .catch((error: unknown) => {
        if (error instanceof ScoutArchiveNotReadyError) {
          // Ordinary while a scout is still working: the merge landed but the report has not
          // been submitted, so the task stays running and the agent still owes its page.
          // Callers whose own signal was terminal - an agent that went away - pass a handler
          // and settle the row themselves.
          onScoutRefusal?.(error.problems);
          return;
        }
        if (error instanceof TaskStatusConflictError) return;
        console.warn(`[tasks] could not complete ${id}:`, error);
      });
  }

  /**
   * Stamp `satisfiedAt` on every unsatisfied declared edge aimed at `taskId`.
   *
   * Written on the EDGE rather than inferred from the target's status, which is the
   * same reason `TaskDependency.satisfiedAt` is persisted at all: terminal task rows are
   * eventually pruned, so a completion that lives only in the target's row stops being
   * readable once that row is gone, and every dependent silently re-blocks. One
   * timestamp per edge survives that.
   *
   * Task edges only. `resolveDependencies` normalizes a session reference to a task
   * reference whenever that session carries a task row, so a surviving `session` edge is
   * by construction operator-started work with no task to complete - nothing this call
   * could be about.
   */
  private satisfyDeclaredEdgesTo(taskId: string, at: number): void {
    for (const task of this.registry.listTasks()) {
      let changed = false;
      const dependencies = task.dependencies.map((dependency) => {
        if (
          dependency.type !== "task" ||
          dependency.taskId !== taskId ||
          dependency.satisfiedAt !== null
        ) {
          return dependency;
        }
        changed = true;
        return { ...dependency, satisfiedAt: at };
      });
      if (changed) {
        this.registry.upsertTask({ ...task, dependencies, updatedAt: Math.max(task.updatedAt, at) });
      }
    }
  }

  /**
   * Put a stopped task back into the backlog so it can be run again. The escape hatch
   * for a prerequisite that was cancelled or failed while the work it stood for still
   * needs doing: its dependents stay blocked (a `stopped` dependency never satisfies)
   * until it is either marked done or actually run, and this is the "run it" half - the
   * companion to `complete(..., satisfyDependents)`, which is the "it already landed" half.
   *
   * Only `cancelled` and `failed` tasks are eligible: a `done` task's result is already
   * recorded and a live one is on its way, so neither is a thing to re-file. Any leftover
   * worktree/agent is reclaimed first - the same teardown `reclaim` performs, behind the
   * same human click - because a fresh backlog dispatch provisions its own, and keeping
   * the old one would leak it. The row is reset to the shape `create` leaves a backlog
   * task in, so nothing stale (an old outcome, a dead branch) survives into the relaunch,
   * and re-enabled so the autopilot it was filed for can actually pick it up again.
   *
   * Schedule provenance (`scheduleId` / `scheduleOccurrenceId` / `scheduledFor`) is left
   * untouched: it records which occurrence FILED this task, a fact rescheduling does not
   * change. Its declared dependencies are kept too - re-running it means re-running it
   * under the same prerequisites, which the backlog re-evaluates on the next plan.
   */
  /**
   * Allocate a rank at one end of the backlog, publishing any row a repair moved on the way.
   *
   * Every allocation is a potential repair - `appendRank` and `prependRank` heal a row
   * that has no rank before they read the end they are extending - and a repair that moved
   * rows nobody was told about would leave every open dashboard drawing a stale column
   * until the next reload. So the publish is here rather than at each caller. In the
   * ordinary case it publishes nothing, because in the ordinary case the repair wrote
   * nothing.
   *
   * NULL when that end of the rank space has no integer left. The task is then filed with
   * no rank at all, which `byBacklogRank` sorts LAST - which is the bottom, which is where
   * an arrival belongs. Several such arrivals keep their order, because the comparator
   * breaks the tie by age. The alternative - renumbering the whole backlog to manufacture
   * one gap - is the thing sparse ranks exist to avoid, and it would rewrite an order the
   * operator arranged in order to file a task they did not ask to have filed anywhere in
   * particular.
   */
  private allocateBacklogRank(end: "top" | "bottom"): number | null {
    const d = openDb();
    const placement = end === "top" ? prependRank(d) : appendRank(d);
    if (!placement) return null;
    this.publishBacklogRanks(placement.normalized);
    return placement.rank;
  }

  /** Broadcast rows a rank repair rewrote in SQL, so the in-memory snapshot follows. */
  private publishBacklogRanks(ranks: ReadonlyMap<string, number>): void {
    for (const [id, backlogRank] of ranks) {
      const task = this.registry.getTask(id);
      if (!task || task.backlogRank === backlogRank) continue;
      // Already persisted by the normalize, so this publishes without writing again.
      this.registry.publishPersistedTask({ ...task, backlogRank }, []);
    }
  }

  /**
   * Move a backlog task in the operator's order - the one route that writes a rank by hand.
   *
   * Every refusal is a state the operator can SEE, which is why none of them is a silent
   * no-op: a card that dispatched between the click and the request is a 409, and a control
   * that quietly sprang back would look broken rather than late.
   *
   * The placement, any renormalization it needed and the row write all happen inside ONE
   * transaction. Two dashboards reordering at once therefore produce two orderings that are
   * each a real ordering of the real backlog, and never a half-applied one - there is no
   * lock and no version field, because the anchor is re-read inside the transaction rather
   * than trusted from the request.
   *
   * A reorder never makes Foreman's plan stale. `planStale` is COVERAGE - does every
   * plannable backlog item have an entry - not a fingerprint of the order, so moving a card
   * costs zero model calls. That is the reason rank lives on the task row and not in the
   * stored plan.
   */
  reorder(id: string, request: ReorderTask): TaskReorderResult {
    const task = this.registry.getTask(id);
    if (!task) return { ok: false, status: 404, error: "no such task" };
    if (task.status !== "backlog") {
      return {
        ok: false,
        status: 409,
        error: `task is ${task.status}, only a backlog task can be reordered`,
      };
    }
    const anchorId = "anchorTaskId" in request ? request.anchorTaskId : null;
    if (anchorId !== null) {
      if (anchorId === id) {
        return { ok: false, status: 409, error: "a task cannot be moved relative to itself" };
      }
      const anchor = this.registry.getTask(anchorId);
      if (!anchor) return { ok: false, status: 404, error: "no such anchor task" };
      if (anchor.status !== "backlog") {
        return {
          ok: false,
          status: 409,
          error: `the anchor task is ${anchor.status}, so it has no place in the backlog order`,
        };
      }
    }
    const d = openDb();
    const ownsTransaction = !d.isTransaction;
    if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
    let moved: Task;
    let normalized: ReadonlyMap<string, number>;
    let displaced: readonly string[] = [];
    try {
      const placement = placeBacklogRank(d, id, request.position, anchorId);
      // The backlog has no integer left where the operator pointed. Refused rather than
      // approximated: a move that silently landed somewhere else is worse than one that
      // says it could not happen.
      if (!placement) {
        if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
        return { ok: false, status: 409, error: "the backlog has no room left at that position" };
      }
      normalized = placement.normalized;
      // Re-read INSIDE the transaction: a normalize may have just rewritten this very
      // row's rank, and writing the pre-normalize snapshot back would undo it.
      const current = this.registry.getTask(id) ?? task;
      moved = {
        ...current,
        backlogRank: placement.rank,
        updatedAt: Date.now(),
      };
      // Persisted INSIDE the transaction, published only after it commits.
      //
      // `upsertTask` would do both at once, and a `task_upsert` cannot be recalled: if
      // COMMIT then threw, the catch below would roll the row back while every connected
      // dashboard had already drawn the card in its new place, and the registry's
      // in-memory copy - now disagreeing with SQLite - could persist that phantom move
      // later. Being synchronous prevents an interleaving, which is a different hazard
      // and not this one. This is the same split `settleTaskWithRetentionAdoption` uses,
      // and `publishPersistedTask` exists for it.
      displaced = dbUpsertTask(moved);
      if (ownsTransaction) d.exec("COMMIT");
    } catch (error) {
      if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
      throw error;
    }
    this.registry.publishPersistedTask(moved, displaced);
    // Also after the commit, and only for the rows the repair moved - the one the operator
    // asked about was published just above.
    this.publishBacklogRanks(new Map([...normalized].filter(([rowId]) => rowId !== id)));
    return { ok: true, task: moved };
  }

  async reschedule(id: string): Promise<Ok> {
    if (this.reschedulingTasks.has(id)) {
      return { ok: false, error: "task is being rescheduled" };
    }
    if (this.cleanupReservations.has(id)) {
      // A reschedule tears the old attempt's tree down before re-filing it, so it is one of
      // the destructive paths and must not run alongside another. It refuses rather than
      // waits: the caller is an operator, and a background cleanup that is already releasing
      // these exact resources makes the re-file safe a moment later anyway.
      return { ok: false, error: "this task's resources are being cleaned up - try again in a moment" };
    }
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    if (!taskKindAllowsBacklog(t.kind)) {
      return { ok: false, error: TASK_KIND_BACKLOG_REFUSAL };
    }
    if (t.status !== "cancelled" && t.status !== "failed") {
      return {
        ok: false,
        error: `task is ${t.status}, only a cancelled or failed task can be rescheduled`,
      };
    }
    if (t.kind === "pipeline" && t.status === "cancelled" && t.pipelineCommissionId) {
      return {
        ok: false,
        error: "a cancelled Pipeline commission is terminal; create a new Pipeline task",
      };
    }
    this.reschedulingTasks.add(id);
    this.cleanupReservations.add(id);
    try {
      try {
        await this.quiesceLaunchedAgentBeforeCapture(this.registry.getTask(id) ?? t);
      } catch (error) {
        return {
          ok: false,
          error: `could not stop task agent: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      // Re-filing a scout tears its worktree down and gives the next attempt a fresh one, so
      // whatever the first attempt found is archived here or lost. The new attempt gets its
      // own work episode and therefore its own archive, which is why this cannot simply be
      // left to the relaunch.
      const archived = await this.settleArchivesBeforeTeardown(id);
      if (!archived.ok) return archived;
      this.autoCompleted.delete(id);
      // `taskHasWorktrees` rather than the primary path: a task whose primary tree was
      // released and whose attached repository's tree survived a partial teardown still has
      // something to release, and reading the primary alone skipped it entirely - re-filing
      // the task on top of a checkout the previous attempt still held.
      if (taskHasWorktrees(t) || t.homeName) {
        try {
          const current = this.registry.getTask(id) ?? t;
          await teardownWorktree(current, this.legacyWorktrees, "foreground", this.worktrees);
        } catch (error) {
          const partial = this.registry.getTask(id) ?? t;
          this.registry.upsertTask({
            ...partial,
            ...releasedTaskResources(partial, reclaimedFrom(error)),
            updatedAt: Date.now(),
          });
          return {
            ok: false,
            error: `could not reclaim task resources: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      const cur = this.registry.getTask(id);
      if (!cur) return { ok: false, error: "no such task" };
      if (cur.status !== "cancelled" && cur.status !== "failed") {
        return {
          ok: false,
          error: `task is ${cur.status}, only a cancelled or failed task can be rescheduled`,
        };
      }
      this.registry.upsertTask({
        ...cur,
        status: "backlog",
        enabled: true,
        // A re-entering task KEEPS the rank it already has, so a recovered dispatch
        // reappears where it was rather than at the bottom of a queue it never left. A task
        // that never had one - dispatched straight out, never a backlog row - is appended,
        // because arriving somewhere is the whole rule and an unranked row would sit below
        // everything filed after it.
        backlogRank: cur.backlogRank ?? this.allocateBacklogRank("bottom"),
        // Everything came back: this path returns early when the teardown throws.
        ...releasedTaskResources(cur, null),
        homeName: null,
        homeBackend: null,
        terminalResourceId: null,
        sessionId: null,
        pipelineRun: null,
        outcome: null,
        outcomeUrl: null,
        error: null,
        dispatchedAt: null,
        completedAt: null,
        updatedAt: Date.now(),
      });
      return { ok: true };
    } finally {
      this.reschedulingTasks.delete(id);
      this.cleanupReservations.delete(id);
    }
  }

  /**
   * Take exclusive in-process ownership of a task's resources for the duration of `fn`.
   *
   * Every destructive path in this class runs inside one of these. A caller that finds the
   * task already reserved is REFUSED rather than queued: all of these are either an operator
   * click, which should say so immediately rather than block on a background sweep, or a
   * background attempt, which has a retry schedule of its own and loses nothing by waiting
   * for the next one.
   */
  private async withCleanupReservation<T>(
    id: string,
    conflict: T,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.cleanupReservations.has(id)) return conflict;
    this.cleanupReservations.add(id);
    try {
      return await fn();
    } finally {
      this.cleanupReservations.delete(id);
    }
  }

  /** Is some destructive path already holding this task? Read by the non-destructive guards. */
  taskCleanupIsReserved(id: string): boolean {
    return this.cleanupReservations.has(id);
  }

  /**
   * The ownership facts a reserved cleanup must find UNCHANGED at its destructive boundary.
   *
   * Deliberately narrower than the resource generation, and the difference is the whole point
   * of there being two guards. The generation includes `homeName`, `terminalResourceId` and
   * `sessionId` - it has to, because cleanup can clear all three - so comparing the generation
   * after quiescence would have every automatic attempt reject the mutation it just performed
   * itself, forever. What this carries instead is the set of things a reserved cleanup does NOT
   * touch before teardown: the attempt boundary, the status, and the exact ordered tuple of
   * repository roots, checkout paths, providers and leases that `teardownWorktree` will act on.
   *
   * A change here between the first guard and the last means somebody ELSE moved the task -
   * a reschedule, a manual reclaim, a re-dispatch - and the attempt aborts.
   */
  private stableCleanupOwnership(task: Task): string {
    return JSON.stringify({
      status: task.status,
      dispatchedAt: task.dispatchedAt,
      repos: taskRepoRefs(task).map((ref) => [
        ref.position,
        ref.repoRoot,
        ref.worktreePath,
        ref.provider,
        ref.worktreeLeaseId,
      ]),
    });
  }

  /**
   * Reclaim a terminal task's worktrees because their 30-day retention window expired.
   *
   * The automatic twin of `reclaim()`, sharing its teardown, its partial-release accounting
   * and its task update - and differing only in what it must PROVE before it is allowed to
   * run. A person clicking Clean up is the authorization; here the authorization is a
   * persisted claim, so this re-establishes at every step that the claim still describes
   * reality.
   *
   * The order of the two guards is load-bearing and was got wrong once already:
   *
   *  1. Before anything mutates - before quiescence, before archives - the complete claimed
   *     generation and the claimed fingerprint must both still hold. This is the check that
   *     can safely be strict, because nothing has happened yet.
   *  2. Immediately before `teardownWorktree`, the stable ownership snapshot and a FRESH
   *     fingerprint must both still hold. Quiescence and archive settlement legitimately
   *     stop the terminal home and clear the session, so this guard deliberately does not
   *     look at those - it looks at the attempt, the status and the exact trees about to be
   *     removed, plus whether anything wrote into them while the agent was being stopped.
   *
   * Everything is reported rather than thrown, because the caller has durable state to move
   * and needs to know WHICH of these happened: fresh work postpones, an external replacement
   * abandons, and an unreadable tree or a refusing provider retries.
   */
  async reclaimForRetention(request: AutomaticReclaimRequest): Promise<AutomaticReclaimOutcome> {
    const { taskId } = request;
    return this.withCleanupReservation<AutomaticReclaimOutcome>(
      taskId,
      { kind: "ownership-changed", detail: "another cleanup holds this task" },
      async () => {
        /**
         * The activity half of both guards.
         *
         * A task with no checkout left is skipped rather than probed, and that is not a
         * loosened guard: what a fingerprint buys is "never destroy a tree somebody has worked
         * in", and this task has no tree - only an unreleased terminal home, which carries no
         * unpushed work. Probing it would compare the digest of nothing against the digest of
         * the trees that are already gone and refuse the attempt that finishes the release,
         * forever. Ownership and generation are still checked, both times.
         */
        const activityUnchanged = async (t: Task): Promise<AutomaticReclaimOutcome | null> => {
          if (!taskHasWorktrees(t)) return null;
          const read = await request.probe(t);
          if (read.kind === "unknown") return { kind: "validation-unknown", detail: read.reason };
          if (read.digest !== request.fingerprint) return { kind: "activity-changed" };
          return null;
        };

        // --- guard 1: nothing has been mutated yet, so this can be strict ---
        const before = this.registry.getTask(taskId) ?? getDurableTask(taskId);
        // The KEEPING rule: an attempt that has to finish releasing a terminal home left over
        // from a partial teardown reaches here holding no worktree at all.
        if (!before || !isRetentionRetryable(before)) {
          return { kind: "ownership-changed", detail: "task no longer holds these resources" };
        }
        if (taskResourceGeneration(before) !== request.generation) {
          return { kind: "ownership-changed", detail: "task resources were replaced" };
        }
        const preflight = await activityUnchanged(before);
        if (preflight) return preflight;
        const ownership = this.stableCleanupOwnership(before);

        // --- the reserved cleanup itself, which may legitimately move terminal identity ---
        try {
          await this.quiesceLaunchedAgentBeforeCapture(before);
        } catch (error) {
          return { kind: "failed", detail: `could not stop the task agent (${readFailureClass(error)})` };
        }
        const archived = await this.settleArchivesBeforeTeardown(taskId);
        if (!archived.ok) {
          return { kind: "archive-refused", detail: "this task's archive could not be published" };
        }

        // --- guard 2: the trees about to be removed, and what is in them, right now ---
        const current = this.registry.getTask(taskId) ?? getDurableTask(taskId);
        if (!current || !isRetentionRetryable(current)) {
          return { kind: "ownership-changed", detail: "task no longer holds these resources" };
        }
        if (this.stableCleanupOwnership(current) !== ownership) {
          return { kind: "ownership-changed", detail: "task resources were replaced" };
        }
        const final = await activityUnchanged(current);
        if (final) return final;

        // Past the last guard, and only now. `autoCompleted` is a one-way in-memory drop that
        // makes an inferred completion irreversible, and doing it above would mean an attempt
        // that correctly aborted had still quietly changed the task's lifecycle on its way out.
        this.autoCompleted.delete(taskId);
        try {
          // `background`, unlike every manual path's `foreground`. The native allocator uses
          // that to let an operator's dispatch acquire ahead of maintenance, which is the
          // ordering that keeps a large stale fleet from standing in front of live work.
          const teardown = this.startupDeps.teardown ?? ((target, legacy, priority) =>
            teardownWorktree(target, legacy ?? this.legacyWorktrees, priority, this.worktrees));
          await teardown(current, this.legacyWorktrees, "background");
        } catch (error) {
          const partial = this.registry.getTask(taskId) ?? current;
          // Every durable resource fact this attempt did not actually release SURVIVES,
          // terminal identity included. A teardown that handed back the last checkout and then
          // failed on the home leaves that home genuinely still there, so clearing the field
          // would delete the only record of a live resource; the ledger row stays retryable
          // instead, and finishes the release on a later attempt.
          this.registry.upsertTask({
            ...partial,
            ...releasedTaskResources(partial, reclaimedFrom(error)),
            updatedAt: Date.now(),
          });
          // Deliberately NOT written onto `task.error`. That field is this task's own record
          // of why the work failed, and a maintenance failure overwriting it would destroy the
          // only account of the run. The bounded explanation rides `automaticCleanup` instead.
          return { kind: "failed", detail: `could not release this task's resources (${readFailureClass(error)})` };
        }
        const after = this.registry.getTask(taskId) ?? current;
        this.registry.upsertTask({
          ...after,
          ...releasedTaskResources(after, null),
          homeName: null,
          homeBackend: null,
          terminalResourceId: null,
          sessionId: null,
          updatedAt: Date.now(),
        });
        return { kind: "reclaimed" };
      },
    );
  }

  /**
   * Run one retention cleanup through the shared repository-serialized queue.
   *
   * Retention enters here rather than calling `reclaimForRetention` directly so that automatic
   * cleanup and startup reconciliation contend for a repository through ONE mechanism. The
   * refusal when the queue already holds this task is not an error: the ledger claim stays
   * exactly as it was and the next pass tries again.
   */
  async enqueueRetentionCleanup(
    request: AutomaticReclaimRequest,
  ): Promise<AutomaticReclaimOutcome | { kind: "not-queued" }> {
    const task = this.registry.getTask(request.taskId) ?? getDurableTask(request.taskId);
    if (!task) return { kind: "not-queued" };
    type Settled = AutomaticReclaimOutcome | { kind: "not-queued" };
    let resolve!: (outcome: Settled) => void;
    const settled = new Promise<Settled>((r) => {
      resolve = r;
    });
    const accepted = this.cleanupQueue.enqueue({
      taskId: request.taskId,
      repoKeys: taskCleanupRepoKeys(task),
      run: async () => {
        // Queue position is never authorization. A job can wait minutes behind a busy
        // repository, and `reclaimForRetention` re-reads and re-probes everything from
        // scratch - this call site proves nothing on its own.
        if (request.abandoned?.()) {
          resolve({ kind: "not-queued" });
          return;
        }
        // Always resolves, including on a throw from deep inside teardown. The caller awaits
        // this to move durable ledger state, so a promise that never settles would strand the
        // claim on the row and stall the whole observation pass behind it.
        try {
          resolve(await this.reclaimForRetention(request));
        } catch (error) {
          resolve({ kind: "failed", detail: `cleanup failed unexpectedly (${readFailureClass(error)})` });
        }
      },
    });
    if (!accepted) return { kind: "not-queued" };
    return settled;
  }

  /** Queued plus in-flight background cleanups, so retention can bound how many it adds. */
  get pendingCleanupJobs(): number {
    return this.cleanupQueue.size;
  }

  /**
   * Free a terminal task's leftover worktree + agent (the explicit, confirmed
   * "reclaim" action) while KEEPING its status and outcome - unlike cancel, which
   * aborts an active task.
   */
  async reclaim(id: string): Promise<Ok> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    // Reserved for the same reason the automatic path is, and against the same set of
    // callers - including that automatic path. Two teardowns of one tree is a double
    // `git worktree remove` and a lease handed back twice; an operator who clicks while a
    // background cleanup is mid-flight is told so rather than made to wait behind it.
    return this.withCleanupReservation<Ok>(
      id,
      { ok: false, error: "this task's resources are already being cleaned up" },
      () => this.reclaimReserved(id, t),
    );
  }

  /** `reclaim`'s body, once the reservation is held. */
  private async reclaimReserved(id: string, t: Task): Promise<Ok> {
    try {
      await this.quiesceLaunchedAgentBeforeCapture(t);
    } catch (error) {
      return {
        ok: false,
        error: `could not stop task agent: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    // A normally completed scout already has its verified bundle, so this is a cheap replay.
    // A scout that was never archived - one whose agent went away, or that failed - gets its
    // last chance here, because after this line its report is gone.
    const archived = await this.settleArchivesBeforeTeardown(id);
    if (!archived.ok) return archived;
    this.autoCompleted.delete(id);
    try {
      const current = this.registry.getTask(id) ?? t;
      await teardownWorktree(current, this.legacyWorktrees, "foreground", this.worktrees);
    } catch (error) {
      // A partial reclaim still releases what came back. The refusal stands - the operator
      // is told the reclaim failed, and the trees still standing keep their record so a
      // retry can reach them - but a tree already back in its pool stops being pinned.
      const partial = this.registry.getTask(id) ?? t;
      this.registry.upsertTask({
        ...partial,
        ...releasedTaskResources(partial, reclaimedFrom(error)),
        updatedAt: Date.now(),
      });
      return {
        ok: false,
        error: `could not reclaim task resources: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const cur = this.registry.getTask(id) ?? t;
    this.registry.upsertTask({
      ...cur,
      ...releasedTaskResources(cur, null),
      homeName: null,
      homeBackend: null,
      terminalResourceId: null,
      sessionId: null,
      updatedAt: Date.now(),
    });
    return { ok: true };
  }

  async remove(id: string): Promise<Ok> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    return this.withCleanupReservation<Ok>(
      id,
      { ok: false, error: "this task's resources are being cleaned up - try again in a moment" },
      () => this.removeReserved(id, t),
    );
  }

  /** `remove`'s body, once the cleanup reservation is held. */
  private async removeReserved(id: string, t: Task): Promise<Ok> {
    if (t.status === "running" || t.status === "dispatching") {
      return { ok: false, error: "cancel the task before removing it" };
    }
    try {
      await this.quiesceLaunchedAgentBeforeCapture(t);
    } catch (error) {
      return {
        ok: false,
        error: `could not stop task agent: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    // Removing the task must not remove its evidence: an archive is deliberately independent
    // of the task that produced it, so the bundle is published first and then outlives the row
    // entirely. This is also the only place a `remove` could silently discard a report.
    const archived = await this.settleArchivesBeforeTeardown(id);
    if (!archived.ok) return archived;
    this.autoCompleted.delete(id);
    // A terminal task may still hold a tree (e.g. a failed-but-alive dispatch);
    // reclaim it so removing the record never leaks a worktree/lease. `taskHasWorktrees`
    // rather than the primary path, for the reason `reschedule` says above: an attached-only
    // survivor of a partial teardown is a real checkout, and removing the row without it
    // leaks the tree and its lease with no record left that could ever reclaim them.
    if (taskHasWorktrees(t) || t.homeName) {
      try {
        await teardownWorktree(t, this.legacyWorktrees, "foreground", this.worktrees);
      } catch (error) {
        // The row survives a failed remove, so the same partial-release rule applies to it.
        const partial = this.registry.getTask(id) ?? t;
        this.registry.upsertTask({
          ...partial,
          ...releasedTaskResources(partial, reclaimedFrom(error)),
          updatedAt: Date.now(),
        });
        return {
          ok: false,
          error: `could not reclaim task resources: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    this.registry.removeTask(id);
    return { ok: true };
  }

  /**
   * Reconcile a resource-holding task after a restart. If its agent's terminal home
   * survived, keep it (a `running`/`failed` task re-binds to its rediscovered
   * session; a `dispatching` one can't confirm its prompt landed, so it fails
   * honestly but keeps the live agent to Focus/Cancel). If the home is gone, the
   * agent died with the daemon - reclaim its worktree so nothing leaks invisibly.
   *
   * `homeAlive` has three answers and only ONE of them may reclaim. `null` - no installed
   * backend could hold a named home, so the recorded name proves nothing either way - is
   * grouped with "survived", because this is the most destructive branch in the product:
   * the reclaim path runs `git worktree remove --force` and hands a pooled lease back. A
   * wrong "gone" deletes work an agent is still doing; a wrong "survived" leaves a tree the
   * operator frees with one Reclaim.
   *
   * A MISSING home name defaults to `null` here, not `false`, and that is a deliberate
   * departure from the live dispatch path. On the first start after the `tmux_session` ->
   * `home_name` migration, a name that failed to carry across would read as absent - and an
   * absent name reclaiming by omission (`? probe : false`) is exactly how a rename destroys
   * a live agent's worktree. This is a restart, where an absent name cannot be told apart
   * from an unmigrated one, so it fails safe: keep the tree, surface the task. (The
   * dispatcher's own catch keeps `: false` - there the absence is this process's own
   * knowledge that no home was ever spawned, not a value that might have been lost.)
   */
  private async reconcileOnStartup(t: Task): Promise<void> {
    if (dispatchHasNoProvisionedResources(t)) {
      const current = this.registry.getTask(t.id);
      if (!current || !dispatchHasNoProvisionedResources(current)) return;
      this.registry.upsertTask({
        ...current,
        status: taskKindAllowsBacklog(current.kind) ? "backlog" : "failed",
        error: taskKindAllowsBacklog(current.kind)
          ? INTERRUPTED_BEFORE_PROVISION_ERROR
          : INTERRUPTED_CHAT_BEFORE_PROVISION_ERROR,
        dispatchedAt: null,
        updatedAt: Date.now(),
      });
      return;
    }
    // The embedded arm answers first, and it answers `true` or `false` - never the `null`
    // that means "nobody could tell us". `homeAlive`'s uncertainty is about terminal
    // backends, a question an embedded session never poses: the supervisor either holds
    // this task's handle or has a durable row saying what became of it. Asking it before
    // `homeName` also closes the trap that shape would otherwise set - an embedded task has
    // no home name at all, so the terminal reading would be a confident "gone".
    //
    // Note this runs BEFORE `restore()` has relaunched anything, which is why the
    // supervisor answers from the row: a row that says it was alive is a session this
    // daemon is about to pick back up, and reading the empty handle map would reclaim its
    // worktree out from under it.
    const embedded = this.supervisor?.taskLiveness(t.id) ?? null;
    if (providerOwnsTaskCompletion(t.kind) && t.homeName === null && t.pipelineRun !== null) {
      const session = this.supervisor?.liveSessionForTask(t.id) ?? null;
      if (embedded === true && session) {
        this.registry.upsertTask({
          ...t,
          status: "running",
          sessionId: session,
          error: null,
          updatedAt: Date.now(),
        });
        return;
      }
      const run = this.projectedPipelineRun(t);
      if (run) {
        if (run.group === "processed") this.settlePipelineTask(run);
        else {
          this.registry.upsertTask({
            ...t,
            status: "running",
            sessionId: null,
            error: null,
            updatedAt: Date.now(),
          });
        }
        return;
      }
      if (embedded === false || t.status === "dispatching") {
        this.pipelineHostWentAway(t);
        return;
      }
    }
    const alive = embedded ?? (
      t.homeName ? await homeAlive(t.homeName, undefined, t.homeBackend ?? null, t.terminalResourceId) : null
    );
    if (alive !== false) {
      if (t.status === "dispatching") {
        // An embedded dispatch that was interrupted mid-flight is COMPLETED, not failed,
        // and the difference is that its agent is real. `supervisor.start()` persists the
        // row and registers the card before `dispatchEmbedded` records `running` and the
        // session id, so a daemon that died between the two left a task whose conversation
        // exists and whose driver `restore()` is about to resume. Failing it there would
        // leave that agent working under a failed row nothing can settle - and the
        // dispatch's own reason for failing here does not apply: the intent is turn ONE of
        // the conversation, delivered by the launch itself, so there is no pasted prompt
        // whose landing a restart cannot confirm.
        const session = this.supervisor?.liveSessionForTask(t.id) ?? null;
        if (embedded === true && session) {
          this.registry.upsertTask({
            ...t,
            status: "running",
            sessionId: session,
            error: null,
            updatedAt: Date.now(),
          });
          // Its work episode binds when the resumed driver reports `bound`, exactly as it
          // would have on the original dispatch - the task now records the session id that
          // `applyDriverBinding` looks up.
          return;
        }
        this.registry.upsertTask({
          ...t,
          status: "failed",
          error:
            embedded === true
              ? "dispatch interrupted by a restart - its session is being resumed; Cancel it if you don't want it"
              : "dispatch interrupted by a restart - Focus or Cancel it",
          updatedAt: Date.now(),
        });
      }
      return; // resource-holding tasks stay loaded; live sessions re-bind by cwd
    }
    // Everything past the terminal probe is destructive: it settles the row, publishes
    // archives, and can stop the home and tear worktrees down. So it runs under the same
    // in-process reservation every operator path takes - without it, a restart could be
    // stopping this home while an operator's Remove, Cancel or Clean up stops it too, and
    // hand the same lease back twice.
    //
    // Deliberately NOT held across the probe above. `homeAlive` reaches a terminal backend
    // and can take seconds; refusing an operator for that whole window would be a worse
    // bargain than the race it closes. The re-read and the ownership comparison that open
    // the section below happen INSIDE the reservation, so an operator who won the race is
    // observed rather than raced with.
    await this.withCleanupReservation(t.id, undefined, () => this.reconcileAfterProbe(t));
  }

  /** The destructive tail of `reconcileOnStartup`, run under the cleanup reservation. */
  private async reconcileAfterProbe(t: Task): Promise<void> {
    // A completion authority may have moved the row while the terminal probe awaited. The
    // pipeline projection is one such authority during boot restore. Re-read before cleanup
    // so its `done` result is preserved instead of being overwritten from the startup
    // snapshot as a failed task.
    const currentAfterProbe = this.registry.getTask(t.id);
    if (!currentAfterProbe) return;
    if (
      currentAfterProbe.dispatchedAt !== t.dispatchedAt ||
      currentAfterProbe.worktreePath !== t.worktreePath ||
      currentAfterProbe.homeName !== t.homeName ||
      currentAfterProbe.terminalResourceId !== t.terminalResourceId ||
      currentAfterProbe.sessionId !== t.sessionId ||
      JSON.stringify(currentAfterProbe.extraRepos) !== JSON.stringify(t.extraRepos)
    ) {
      // Reschedule or re-dispatch replaced the launch while this probe was in flight. Its
      // resources belong to a different attempt and this startup job has no claim on them.
      return;
    }
    t = currentAfterProbe;
    const settledStatus = t.status === "done" || t.status === "cancelled" ? t.status : "failed";
    const settledError =
      t.status === "done" || t.status === "cancelled"
        ? t.error
        : t.status === "dispatching"
          ? "dispatch interrupted by a restart - re-dispatch"
          : "the agent's session did not survive a restart";

    if (taskHasWorktrees(t)) {
      // The agent died WITH the daemon, and this used to be where its checkout was removed on
      // the spot. It no longer is, and that is the point of the approved policy: a tree with
      // staged work, a local commit, or an afternoon of untracked notes in it is not less
      // valuable because the machine rebooted, and a restart is not evidence that anybody is
      // finished with it. So the task is SETTLED - honest status, honest reason, dead session
      // binding cleared - and every worktree, provider and lease fact it holds is preserved
      // for the same 30-day clock a task that ended while the daemon was up gets. The operator
      // keeps the ordinary Clean up affordance throughout, and retention reclaims it later.
      //
      // Nothing is archived here either. A scout's report stays in its tree and is published by
      // the shared reclaim core immediately before the teardown that would actually destroy it,
      // which is both later and better: a restart is no longer a deadline for capture.
      //
      // The settlement and the retention ledger's adoption of it go in one transaction because
      // the session binding is part of the resource generation. Written separately, a crash
      // between them - or simply the ordinary next observation - would read the settled task as
      // a brand new set of resources and hand a checkout 29 days into its window a fresh 30.
      const expectedStatus = t.status;
      const expectedGeneration = taskResourceGeneration(t);
      const now = Date.now();
      const settled: Task = {
        ...t,
        status: settledStatus,
        error: settledError,
        // The one resource fact restart is entitled to clear, and only because the existing
        // reconciliation contract has just PROVEN this session gone. Everything else -
        // worktree paths, providers, leases, the terminal home and its resource id - is
        // retained so the shared reclaim core can resolve it safely whenever cleanup runs.
        sessionId: null,
        updatedAt: now,
      };
      const result = settleTaskWithRetentionAdoption({
        settled,
        expectedStatus,
        expectedGeneration,
        now,
      });
      // A refusal means the task moved under this job between the re-read above and the
      // transaction. Nothing was written at all - not half a task update, not a stranded
      // ledger row - and the next pass or the next event reconciles whatever it became.
      if (result.committed) this.registry.publishPersistedTask(settled, result.displaced);
      return;
    }

    // No checkout at all, only a dead terminal home. There is nothing here for a Git-visible
    // activity clock to observe and nothing of a person's work to protect, so this keeps the
    // behavior it always had: stop the home, clear its identity, and settle. Retention is a
    // worktree policy, and holding a ledger row open for a shell would be inventing one.
    const archived = await this.settleArchivesBeforeTeardown(t.id);
    if (!archived.ok) {
      this.registry.upsertTask({
        ...t,
        status: settledStatus,
        error: t.status === "done" || t.status === "cancelled" ? t.error : archived.error ?? null,
        sessionId: null,
        updatedAt: Date.now(),
      });
      return;
    }
    try {
      const teardown = this.startupDeps.teardown ?? ((target, legacy, priority) =>
        teardownWorktree(target, legacy ?? this.legacyWorktrees, priority, this.worktrees));
      await teardown(t, this.legacyWorktrees, "background");
    } catch (error) {
      const now = Date.now();
      this.registry.upsertTask({
        ...t,
        // Whatever came back is released even though the teardown failed overall; the rest
        // keeps its record so it stays reclaimable. See `releasedTaskResources`.
        ...releasedTaskResources(t, reclaimedFrom(error)),
        status: settledStatus,
        error:
          t.status === "done" || t.status === "cancelled"
            ? t.error
            : `could not reclaim task resources: ${error instanceof Error ? error.message : String(error)}`,
        sessionId: null,
        updatedAt: now,
      });
      return;
    }
    this.registry.upsertTask({
      ...t,
      status: settledStatus,
      error: settledError,
      ...releasedTaskResources(t, null),
      homeName: null,
      homeBackend: null,
      terminalResourceId: null,
      sessionId: null,
      updatedAt: Date.now(),
    });
  }
}
