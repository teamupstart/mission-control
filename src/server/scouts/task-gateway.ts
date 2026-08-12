import type { Registry } from "../registry.ts";
import { SCOUT_TEXT_LIMITS } from "@shared/scouts.ts";
import type { Session, Task } from "@shared/types.ts";
import type { ScoutCaptureOrigin } from "./capture-store.ts";
import { isScoutTask } from "./prompt.ts";
import { scoutRepoSlots, type ScoutRepoSlot } from "./repos.ts";

/**
 * What the capture path is allowed to know about a task, and who answers.
 *
 * A PORT rather than a direct Registry dependency, and the direction is the reason: the
 * archive owner is injected into `TaskManager` so completion can wait on it, so the archive
 * owner cannot in turn own tasks without a cycle. More usefully, it draws the line the plan
 * asks for - `src/server/scouts/` never learns about task status, dispatch, or teardown. It
 * asks one question ("what is this scout, and where are its checkouts?") and gets a frozen
 * answer it can persist.
 *
 * Everything in a `ScoutSubject` is SERVER-DERIVED. Nothing an agent typed reaches it: the
 * title and question come from the task row, the provenance from the session, and the source
 * roots from the provisioned worktrees.
 */

/** One scout, as the capture path sees it. */
export interface ScoutSubject {
  taskId: string;
  sessionId: string | null;
  /**
   * The work episode this capture belongs to, or null when the task has no binding.
   *
   * Part of the operation key, so it is what makes a RE-DISPATCH produce its own archive
   * rather than replaying the first attempt's: that is genuinely new work by a new agent in a
   * new checkout, and collapsing the two would publish the old evidence under the new task.
   */
  episodeId: string | null;
  title: string;
  question: string | null;
  origin: ScoutCaptureOrigin;
  repos: ScoutRepoSlot[];
}

/** Why a session's submission cannot be attributed to a scout. */
export type ScoutSubjectRefusal =
  | { reason: "no_session"; status: 404; detail: string }
  | { reason: "no_task"; status: 404; detail: string }
  | { reason: "not_a_scout"; status: 409; detail: string }
  | { reason: "not_running"; status: 409; detail: string };

export type ScoutSubjectLookup =
  | { ok: true; subject: ScoutSubject }
  | ({ ok: false } & ScoutSubjectRefusal);

/**
 * The pane/id/cwd triple every Mission MCP call carries, as this gateway takes it.
 *
 * Named rather than inlined so the manager and the route can talk about it without either of
 * them importing the Registry - which is the entire point of the port.
 */
export interface ScoutSessionEvidence {
  env: Parameters<Registry["findSessionByEnv"]>[0];
  sessionId: string | null;
  cwd: string | null;
}

export interface ScoutTaskGateway {
  /** The scout the calling session is running, or a refusal a caller can turn into HTTP. */
  subjectForSession(input: ScoutSessionEvidence): ScoutSubjectLookup;
  /** The scout subject for a task id, or null when it is gone or was never a scout. */
  subjectForTask(taskId: string): ScoutSubject | null;
  /**
   * The scout an evicting session was running, or null.
   *
   * Separate from `subjectForSession` because the question is different: this one is asked
   * with the session in hand, from inside `beginEviction`, and it must NOT refuse a session
   * that is already `exited` - being exited is precisely the condition it exists to catch.
   */
  subjectForExitingSession(session: Session): ScoutSubject | null;
  /** Whether a task is a scout at all. Cheap; every completion and cleanup gate asks it. */
  isScout(taskId: string): boolean;
  /**
   * Whether a task is still expecting its agent to report.
   *
   * Startup recovery reads this and nothing else: a `reserved` job whose task is still live
   * means the daemon died between reserving and recording a submission, and publishing a
   * partial for it would burn the archive id the scout is about to submit against.
   */
  awaitsAgent(taskId: string): boolean;
}

/**
 * The production gateway, over the Registry.
 *
 * Deliberately thin: every method is a lookup and a projection, with no policy of its own.
 * The one judgement it makes is which checkout a slot names, and it delegates even that to
 * `scoutRepoSlots` so the prompt an agent read and the roots capture reads agree.
 */
export class RegistryScoutTaskGateway implements ScoutTaskGateway {
  constructor(private readonly registry: Registry) {}

  subjectForSession(input: ScoutSessionEvidence): ScoutSubjectLookup {
    const session = this.registry.findSessionByEnv(
      input.env,
      input.sessionId ?? undefined,
      input.cwd ?? undefined,
    );
    if (!session || session.state === "exited") {
      return { ok: false, reason: "no_session", status: 404, detail: "no live session matched this request" };
    }
    const task = this.registry.taskForSession(session.id, session.cwd);
    if (!task) {
      return {
        ok: false,
        reason: "no_task",
        status: 404,
        detail: "this session is not running a Mission Control task",
      };
    }
    if (!isScoutTask(task)) {
      return {
        ok: false,
        reason: "not_a_scout",
        status: 409,
        detail: "this session's task is not a scout, so it has no report to archive",
      };
    }
    if (task.status !== "running" && task.status !== "dispatching") {
      return {
        ok: false,
        reason: "not_running",
        status: 409,
        detail: `this scout is ${task.status}, so its report can no longer be archived against it`,
      };
    }
    return { ok: true, subject: this.subject(task, session) };
  }

  subjectForTask(taskId: string): ScoutSubject | null {
    const task = this.registry.getTask(taskId);
    if (!task || !isScoutTask(task)) return null;
    const session = task.sessionId ? this.registry.getSession(task.sessionId) : undefined;
    return this.subject(task, session ?? null);
  }

  subjectForExitingSession(session: Session): ScoutSubject | null {
    // `activeTaskFor` behind this still answers during eviction: the row is deleted after
    // `EXIT_LINGER_MS`, and this runs inside `beginEviction`, before the timer fires.
    const task = this.registry.taskForSession(session.id, session.cwd);
    if (!task || !isScoutTask(task)) return null;
    // Only work that was actually under way. A backlog scout bound to nothing, and a scout
    // already settled by hand, have no evidence an eviction could take with it.
    if (task.status !== "running" && task.status !== "dispatching") return null;
    return this.subject(task, session);
  }

  isScout(taskId: string): boolean {
    const task = this.registry.getTask(taskId);
    return task ? isScoutTask(task) : false;
  }

  awaitsAgent(taskId: string): boolean {
    const status = this.registry.getTask(taskId)?.status;
    return status === "running" || status === "dispatching";
  }

  /**
   * Freeze one task and its session into a capture subject.
   *
   * The episode is read from the TASK's binding rather than the session's current episode.
   * They are usually the same, and where they differ the binding is the right answer: it says
   * which episode this task's work belongs to, while the session's current one may already
   * have rotated onto whatever the agent did next.
   */
  private subject(task: Task, session: Session | null): ScoutSubject {
    return {
      taskId: task.id,
      sessionId: session?.id ?? task.sessionId,
      episodeId: this.registry.workEpisodeForTask(task.id)?.episodeId ?? null,
      title: clip(task.title, SCOUT_TEXT_LIMITS.title) ?? "Scout",
      question: clip(task.intent, SCOUT_TEXT_LIMITS.question),
      origin: {
        agent: task.agent,
        // The model the harness actually reported, when it did; the task's pin is what was
        // asked for and is the honest fallback rather than a guess.
        model: clip(session?.meta?.modelId ?? session?.meta?.model ?? task.model, SCOUT_TEXT_LIMITS.label),
        // How the task got here, as one searchable word: the sweeping source's configured id
        // when a task source filed it, "schedule" when a recurring mission did, else "manual".
        // Never the external URL - a manifest is portable, and a link into somebody's issue
        // tracker is provenance about a machine the archive may never reach again.
        source: clip(
          task.source?.sourceId ?? (task.scheduleId ? "schedule" : "manual"),
          SCOUT_TEXT_LIMITS.label,
        ),
      },
      repos: scoutRepoSlots(task, session?.cwd ?? null),
    };
  }
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
}
