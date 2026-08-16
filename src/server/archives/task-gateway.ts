import {
  ARCHIVE_TEXT_LIMITS,
  type ArchiveKind,
  type ArchiveManifestPromptTrail,
} from "@shared/archives.ts";
import type { Session, Task, TaskKind } from "@shared/types.ts";
import type { Registry } from "../registry.ts";
import { isScoutTask } from "../scouts/prompt.ts";
import { collectScoutPromptTrail } from "../scouts/prompt-collector.ts";
import { scoutPromptContext } from "../scouts/prompt-context.ts";
import { scoutRepoSlots } from "../scouts/repos.ts";
import type { ScoutSubmissionAuthority } from "../scouts/submission-auth.ts";
import type { ArchiveCaptureOrigin, ArchiveRepoSlot } from "./capture-store.ts";

/**
 * What the capture path is allowed to know about a task, and who answers.
 *
 * A PORT rather than a direct Registry dependency, and the direction is the reason: the
 * archive owner is injected into `TaskManager` so completion can wait on it, so the archive
 * owner cannot in turn own tasks without a cycle. More usefully, it draws a line - a kind's
 * own module never learns about task status, dispatch, or teardown. This asks one question
 * ("what is this task, and where are its checkouts?") and gets a frozen answer it can persist.
 *
 * It lives here rather than beside one kind because the question is kind-agnostic: the subject
 * a plan capture needs is the same projection a scout capture needs, off the same row. What is
 * kind-shaped is only which tasks answer, and that is the `captureKind` lookup below.
 *
 * Everything in an `ArchiveSubject` is SERVER-DERIVED. Nothing an agent typed reaches it: the
 * title and question come from the task row, the provenance from the session, and the source
 * roots from the provisioned worktrees.
 */

/** One task's work, as the capture path sees it. */
export interface ArchiveSubject {
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
  prompts: ArchiveManifestPromptTrail | null;
  origin: ArchiveCaptureOrigin;
  repos: ArchiveRepoSlot[];
}

/** Why a session's submission cannot be attributed to a scout. */
export type ArchiveSubjectRefusal =
  | { reason: "no_session"; status: 404; detail: string }
  | { reason: "no_task"; status: 404; detail: string }
  | { reason: "not_a_scout"; status: 409; detail: string }
  | { reason: "not_running"; status: 409; detail: string };

export type ArchiveSubjectLookup =
  | { ok: true; subject: ArchiveSubject }
  | ({ ok: false } & ArchiveSubjectRefusal);

/** One task's work and the kind of archive it would be captured as. */
export interface ArchiveSubjectForKind {
  kind: ArchiveKind;
  subject: ArchiveSubject;
}

export interface ArchiveTaskGateway {
  /** The scout named by a verified checkout credential, after its live binding is confirmed. */
  subjectForSubmission(authority: ScoutSubmissionAuthority): ArchiveSubjectLookup;
  /**
   * The subject for a task, but only when that task is captured as `kind`.
   *
   * Kind is a REQUIRED argument rather than something the caller reads off the answer, and
   * that is a safety property rather than a style. The completion gate asks this with
   * `"scout"`, so a plan task can never reach it however the gate is later edited - which is
   * exactly the approved difference between the two kinds: a plan completes on Foreman's
   * ordinary boundary and must never wait on an archive.
   */
  subjectForTask(taskId: string, kind: ArchiveKind): ArchiveSubject | null;
  /**
   * The work an evicting session was doing, and what it would be archived as, or null.
   *
   * Separate from `subjectForSubmission` because the question is different: this one is asked
   * with the session in hand, from inside `beginEviction`, and it must NOT refuse a session
   * that is already `exited` - being exited is precisely the condition it exists to catch.
   */
  subjectForExitingSession(session: Session): ArchiveSubjectForKind | null;
  /**
   * Freeze the bounded prompt trail for a scout subject that is about to be reserved.
   *
   * Potentially expensive: unlike the subject projections above, this may walk the scout's
   * transcript from its Phase 1 boundary. The archive manager therefore calls it only after
   * proving that this operation has no capture job yet. Replays, readiness checks, and
   * already-reserved cleanup paths never need to read a transcript.
   */
  scoutPromptTrailFor(subject: ArchiveSubject): ArchiveManifestPromptTrail | null;
  /**
   * What this task's work would be archived as, or null when it is not archived at all.
   *
   * Cheap; every cleanup gate asks it before it reads anything from disk. A ship task answers
   * null, which is what keeps ship teardown byte-for-byte what it was.
   */
  captureKind(taskId: string): ArchiveKind | null;
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
export class RegistryArchiveTaskGateway implements ArchiveTaskGateway {
  constructor(
    private readonly registry: Registry,
    private readonly collectPromptTrail: typeof collectScoutPromptTrail = collectScoutPromptTrail,
  ) {}

  subjectForSubmission(authority: ScoutSubmissionAuthority): ArchiveSubjectLookup {
    const task = this.registry.getTask(authority.taskId);
    if (!task) {
      return {
        ok: false,
        reason: "no_task",
        status: 404,
        detail: "the credential's task no longer exists",
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
    const session = task.sessionId ? this.registry.getSession(task.sessionId) : undefined;
    const active = session ? this.registry.taskForSession(session.id, session.cwd) : undefined;
    if (
      !session ||
      session.state === "exited" ||
      session.cwd !== authority.cwd ||
      active?.id !== task.id
    ) {
      return {
        ok: false,
        reason: "no_session",
        status: 404,
        detail: "the credential does not match this task's live session and checkout",
      };
    }
    return { ok: true, subject: this.subject(task, session, "scout") };
  }

  subjectForTask(taskId: string, kind: ArchiveKind): ArchiveSubject | null {
    const task = this.registry.getTask(taskId);
    if (!task || captureKindOf(task) !== kind) return null;
    const session = task.sessionId ? this.registry.getSession(task.sessionId) : undefined;
    return this.subject(task, session ?? null, kind);
  }

  subjectForExitingSession(session: Session): ArchiveSubjectForKind | null {
    // `activeTaskFor` behind this still answers during eviction: the row is deleted after
    // `EXIT_LINGER_MS`, and this runs inside `beginEviction`, before the timer fires.
    const task = this.registry.taskForSession(session.id, session.cwd);
    const kind = task ? captureKindOf(task) : null;
    if (!task || !kind) return null;
    // Only work that was actually under way. A backlog task bound to nothing, and a task
    // already settled by hand, have no evidence an eviction could take with it.
    if (task.status !== "running" && task.status !== "dispatching") return null;
    return { kind, subject: this.subject(task, session, kind) };
  }

  scoutPromptTrailFor(subject: ArchiveSubject): ArchiveManifestPromptTrail | null {
    const task = this.registry.getTask(subject.taskId);
    if (!task || !isScoutTask(task)) return null;
    const session = subject.sessionId ? this.registry.getSession(subject.sessionId) : undefined;
    return this.collectPromptTrail(task, subject.episodeId, session ?? null).trail;
  }

  captureKind(taskId: string): ArchiveKind | null {
    const task = this.registry.getTask(taskId);
    return task ? captureKindOf(task) : null;
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
  private subject(task: Task, session: Session | null, kind: ArchiveKind): ArchiveSubject {
    const episodeId = this.registry.workEpisodeForTask(task.id)?.episodeId ?? null;
    // Reading one Phase 1 row preserves the exit/restart title fallback without walking the
    // transcript. The bounded prompt trail itself is frozen only at the reservation boundary.
    const frozenSessionName =
      kind === "scout" && !session?.name.trim() && episodeId
        ? scoutPromptContext(task.id, episodeId)?.sessionName
        : null;
    return {
      taskId: task.id,
      sessionId: session?.id ?? task.sessionId,
      episodeId,
      title:
        kind === "scout"
          ? scoutArchiveTitle(session?.name, frozenSessionName, task.title)
          : clip(task.title, ARCHIVE_TEXT_LIMITS.title) ?? "Plan",
      question: clip(task.intent, ARCHIVE_TEXT_LIMITS.question),
      prompts: null,
      origin: {
        agent: task.agent,
        // The model the harness actually reported, when it did; the task's pin is what was
        // asked for and is the honest fallback rather than a guess.
        model: clip(session?.meta?.modelId ?? session?.meta?.model ?? task.model, ARCHIVE_TEXT_LIMITS.label),
        // How the task got here, as one searchable word: the sweeping source's configured id
        // when a task source filed it, "schedule" when a recurring mission did, else "manual".
        // Never the external URL - a manifest is portable, and a link into somebody's issue
        // tracker is provenance about a machine the archive may never reach again.
        source: clip(
          task.source?.sourceId ?? (task.scheduleId ? "schedule" : "manual"),
          ARCHIVE_TEXT_LIMITS.label,
        ),
      },
      // The fallback checkout is the SESSION's, and only a scout may have it.
      //
      // An assigned task has no worktree of its own: it runs in the checkout the operator's
      // own agent was already standing in. For a scout that is the right root to read, because
      // a scout names the one file it wants and the daemon copies exactly that.
      //
      // A plan reads the checkout's DIFF to decide what to capture, which is only a statement
      // about this task while the checkout belongs to this task alone. In a shared checkout it
      // is a statement about everything anybody is doing there, so an ordinary Cancel or Remove
      // would archive a colleague's in-progress plan under this task's name - precisely the
      // unrelated-directory capture the diff-based selection exists to rule out. So a plan gets
      // no fallback, its assigned form resolves to no checkout, and it is not archived.
      repos: scoutRepoSlots(task, kind === "scout" ? (session?.cwd ?? null) : null),
    };
  }
}

/**
 * The archive kind each task kind's work is captured as, or null when it is not captured.
 *
 * The one place a durable task kind becomes an archive kind, and a total `Record<TaskKind, …>`
 * rather than a chain of predicates so a FOURTH task kind cannot compile until it has said
 * whether it is archived. That is the failure this shape exists to prevent: a predicate chain
 * answers `null` for a kind nobody added to it, so a new kind would silently never be
 * captured and no test would notice - the same silent degradation `TASK_KIND_INFO` and
 * `KIND_CONTRACT` are `Record`s to prevent, one subsystem over.
 *
 * The two vocabularies stay separable even though two of their names coincide. `TaskKind` is
 * what an agent was asked for; `ArchiveKind` is what a bundle preserves, and it is an
 * append-only portable format contract with no `ship` in it. This mapping is where they meet
 * and it is deliberately the ONLY place they do.
 */
const CAPTURE_KIND: Record<TaskKind, ArchiveKind | null> = {
  ship: null,
  scout: "scout",
  plan: "plan",
  pipeline: null,
};

/**
 * The archive kind a task's work is captured as, or null when it is not captured.
 *
 * `?? null` rather than a bare lookup: a row written by a newer build can carry a kind this
 * one has no entry for, and "not archived" is the only safe reading of a kind whose capture
 * rule does not exist here yet.
 */
function captureKindOf(task: Task): ArchiveKind | null {
  return CAPTURE_KIND[task.kind] ?? null;
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
}

/** The single title fallback chain used by normal and exit-recovery scout capture. */
export function scoutArchiveTitle(
  liveSessionName: string | null | undefined,
  frozenSessionName: string | null | undefined,
  taskTitle: string | null | undefined,
): string {
  for (const candidate of [liveSessionName, frozenSessionName, taskTitle]) {
    const clipped = clip(candidate, ARCHIVE_TEXT_LIMITS.title);
    if (clipped) return clipped;
  }
  return "Scout";
}
