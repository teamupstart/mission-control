import type { Session, Task, TaskDependency } from "@shared/types.ts";
import type { ShippingConfig } from "@shared/protocol.ts";
import { hasBlocker } from "@shared/session.ts";
import {
  effectiveEdgeMode,
  stackEligibility,
  stackPrNumber,
  stackStartEdge,
  withoutStackStamp,
} from "@shared/stacking.ts";
import { parsePrUrl } from "../inspector/github.ts";
import { prInRepositories, type StackGitHub } from "./github.ts";

// The daemon's half of a stacked start: the readiness stamp on a dependency edge, and the
// revalidation a stacked dispatch runs before it pins the prerequisite's head.
//
// A stack edge releases its dependent to START once the prerequisite's current episode has an
// open, non-draft pull request in its primary repository and its agent has finished that
// episode (idle, nothing queued). The shared blocker predicate cannot see sessions or GitHub,
// so the daemon writes what it saw onto the edge (`stackReadyAt` and friends) and every reader
// - the board, the Line, Foreman's worker, dispatch - agrees by reading that stamp.
//
// The stamp is a cache, not an authority. Dispatch reads the parent pull request again before
// it accepts the pin, because a stamp can go stale in the window before it is cleared.

/** What this needs from the Registry. A narrow slice, so tests can supply a fake. */
export interface StackRegistry {
  listTasks(): Task[];
  getTask(id: string): Task | undefined;
  getSession(id: string): Session | undefined;
  workEpisodeForSession(sessionId: string): { episodeId: string } | null;
  workEpisodeForTask(taskId: string): {
    episodeId: string;
    sessionId: string;
    prUrl: string | null;
    /** Per-repository change verdicts the daemon records from worktree heads. */
    repoChanges?: Array<{ repoRoot: string; verdict: "changed" | "unchanged" | "unknown" }> | null;
  } | null;
  upsertTask(task: Task): void;
}

type TaskEdge = Extract<TaskDependency, { type: "task" }>;

/** The four stack fields a dispatch writes onto its task. All null for an unstacked one. */
export interface StackDispatchFields {
  stackParentTaskId: string | null;
  stackBaseBranch: string | null;
  stackBaseSha: string | null;
  stackPrUrl: string | null;
}

export const UNSTACKED: StackDispatchFields = {
  stackParentTaskId: null,
  stackBaseBranch: null,
  stackBaseSha: null,
  stackPrUrl: null,
};

export type StackedDispatchPlan =
  | { ok: true; baseSha: string; fields: StackDispatchFields }
  | { ok: false; error: string };

/** How long one prerequisite's failed or refused readiness read is not repeated. */
const RETRY_MS = 60_000;
/**
 * How long a stamp stands on one successful read before the prerequisite's pull request is
 * read again. A pull request can be turned back into a draft, closed or moved on GitHub with
 * no local event, and a stamp that outlived that would show the dependent as ready until a
 * dispatch failed. One small read per stamped prerequisite per interval, only while stamps
 * exist.
 */
const RECHECK_MS = 60_000;

/** The prerequisite's finished-episode facts, read synchronously from live state. */
interface FinishedEpisode {
  session: Session;
  episodeId: string;
  prUrl: string;
  repoChanges: Array<{ repoRoot: string; verdict: "changed" | "unchanged" | "unknown" }> | null;
}

/** How the readiness memo's retry is scheduled. Injectable so tests need no real clock. */
export interface StackTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: StackTimers = {
  set: (run, ms) => {
    const handle = setTimeout(run, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Why the prerequisite's secondary repositories still hold a stacked start, or null.
 *
 * A stacked child is cut in the primary repository only, so every OTHER repository the
 * prerequisite changed has to have merged first. "Changed" is the daemon's recorded verdict
 * for the episode, and anything short of a positive "unchanged" - a change with no pull
 * request yet, an unobserved repository, an unreadable head - waits, because starting early
 * on a guess would build on work that has not landed.
 */
function pendingSecondary(parent: Task, finished: FinishedEpisode): string | null {
  for (const repo of parent.extraRepos) {
    if (repo.mergedAt !== null) continue;
    const verdict = finished.repoChanges?.find((change) => change.repoRoot === repo.repoRoot)?.verdict ?? "unknown";
    if (verdict === "unchanged") continue;
    return verdict === "changed"
      ? `${parent.title} has an unmerged change in ${repo.repoRoot}`
      : `${parent.title} may have changed ${repo.repoRoot}, which has not merged`;
  }
  return null;
}

function stamped(edge: TaskDependency): boolean {
  return edge.type !== "plan" && typeof edge.stackReadyAt === "number";
}

export class StackReadiness {
  /** Prerequisites with a readiness read in flight, so one pass never forks two. */
  private inFlight = new Set<string>();
  /** Last failed or refused read per prerequisite, keyed with the head it was refused for. */
  private refused = new Map<string, { at: number; prUrl: string }>();
  private scheduled = false;
  private stopped = false;
  /** One pending re-check per prerequisite whose read was refused or deferred. */
  private retries = new Map<string, unknown>();
  /** When each prerequisite's pull request last read as stackable on. */
  private verifiedAt = new Map<string, number>();

  constructor(
    private readonly registry: StackRegistry,
    private readonly config: () => ShippingConfig,
    private readonly github: StackGitHub,
    private readonly now: () => number = Date.now,
    private readonly timers: StackTimers = realTimers,
  ) {}

  stop(): void {
    this.stopped = true;
    for (const handle of this.retries.values()) this.timers.clear(handle);
    this.retries.clear();
  }

  /**
   * Look at this prerequisite again once its refusal memo has expired.
   *
   * Readiness passes are driven by local task and session events, and the things a refusal
   * waits on usually happen on GitHub - a draft marked ready, a branch catching up - which
   * produce neither. Without this a dependent could stay blocked until something unrelated
   * moved. One timer per prerequisite, so a burst of refusals schedules one re-check.
   *
   * A new refusal REPLACES the pending timer rather than keeping it: the prerequisite may
   * have moved to another pull request, whose memo expires later than the timer armed for the
   * previous one. A timer that fired inside the memo window would re-read nothing and leave
   * no timer behind.
   */
  private retryLater(parentId: string, ms = RETRY_MS + 1): void {
    if (this.stopped) return;
    const pending = this.retries.get(parentId);
    if (pending !== undefined) this.timers.clear(pending);
    this.retries.set(parentId, this.timers.set(() => {
      this.retries.delete(parentId);
      this.schedule();
    }, Math.max(1, ms)));
  }

  /** Coalesce a burst of session and task events into one pass on the next turn. */
  schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.stopped) this.reconcile();
    });
  }

  /**
   * Has this prerequisite finished its current episode with a pull request? The same idle,
   * empty-queue and current-episode evidence `settleIfEpisodeFinished` concludes a merged
   * task on, with "landed" swapped for "has a primary pull request".
   */
  private finishedEpisode(parent: Task): FinishedEpisode | null {
    if (parent.status !== "running" || !parent.sessionId) return null;
    const session = this.registry.getSession(parent.sessionId);
    if (!session || session.state !== "idle") return null;
    // Blocked on someone else: the episode is parked, not finished, so no dependent stacks on it.
    if (hasBlocker(session)) return null;
    if (session.queue && session.queue.openCount > 0) return null;
    const binding = this.registry.workEpisodeForTask(parent.id);
    if (!binding || binding.sessionId !== session.id || !binding.prUrl) return null;
    const current = this.registry.workEpisodeForSession(session.id);
    if (!current || current.episodeId !== binding.episodeId) return null;
    return { session, episodeId: binding.episodeId, prUrl: binding.prUrl, repoChanges: binding.repoChanges ?? null };
  }

  /**
   * One pass over the backlog: clear every stamp that no longer stands, and start a readiness
   * read for each prerequisite that finished an episode and has a dependent waiting to stack.
   *
   * Clearing is synchronous and needs no network: a dependent whose edge stopped being
   * eligible (setting or mode changed, a second prerequisite appeared, the stack grew too
   * deep) or whose prerequisite started a new turn, queued work or moved episode is unstamped
   * at once, so it stops reading as ready before anything acts on it.
   */
  reconcile(): void {
    const tasks = this.registry.listTasks();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const config = this.config();
    const wanted = new Map<string, Task>();
    for (const task of tasks) {
      if (task.status !== "backlog") continue;
      const eligibility = stackEligibility(task, byId, config);
      const keep = eligibility.ok ? eligibility.edge.taskId : null;
      const finished = eligibility.ok ? this.finishedEpisode(eligibility.parent) : null;
      let changed = false;
      const dependencies = task.dependencies.map((edge) => {
        if (!stamped(edge) || edge.type === "plan") return edge;
        const stillStands =
          edge.type === "task" &&
          edge.taskId === keep &&
          finished !== null &&
          edge.stackPrUrl === finished.prUrl;
        if (stillStands) return edge;
        changed = true;
        return withoutStackStamp(edge);
      });
      if (changed) {
        this.registry.upsertTask({ ...task, dependencies, updatedAt: Math.max(task.updatedAt, this.now()) });
      }
      if (eligibility.ok && finished) {
        const parentId = eligibility.parent.id;
        const edge = (changed ? dependencies : task.dependencies).find(
          (candidate): candidate is TaskEdge => candidate.type === "task" && candidate.taskId === parentId,
        );
        if (edge && !stamped(edge)) wanted.set(parentId, eligibility.parent);
        else if (edge) {
          // A standing stamp is only as good as its last read: read it again once that is
          // RECHECK_MS old, and make sure a pass comes round then even if nothing local moves.
          const verified = this.verifiedAt.get(parentId);
          if (verified === undefined || this.now() - verified >= RECHECK_MS) wanted.set(parentId, eligibility.parent);
          else if (!this.retries.has(parentId)) this.retryLater(parentId, verified + RECHECK_MS - this.now() + 1);
        }
      }
    }
    for (const parent of wanted.values()) void this.stampFor(parent.id);
  }

  /**
   * Read the prerequisite's primary pull request and stamp every dependent edge that may
   * stack on it. Network-bound; the in-flight set and the refusal memo keep it to one read
   * per prerequisite per minute at most.
   */
  async stampFor(parentId: string): Promise<void> {
    if (this.inFlight.has(parentId)) return;
    const parent = this.registry.getTask(parentId);
    if (!parent) return;
    const finished = this.finishedEpisode(parent);
    if (!finished) return;
    const memo = this.refused.get(parentId);
    if (memo && memo.prUrl === finished.prUrl && this.now() - memo.at < RETRY_MS) {
      // The memo skips this read, so make sure something reads once it expires: a pass that
      // lands inside the window (an early timer, or a local event) must not be the last one.
      if (!this.retries.has(parentId)) this.retryLater(parentId, memo.at + RETRY_MS - this.now() + 1);
      return;
    }
    this.inFlight.add(parentId);
    const startedAt = this.now();
    try {
      const read = await this.readParent(parent, finished);
      if (this.stopped) return;
      // A dispatch refused while GitHub answered deferred this prerequisite: its refusal is
      // newer than this read, so it wins, and the pending re-check reads again later.
      const deferred = this.refused.get(parentId);
      if (deferred && deferred.prUrl === finished.prUrl && deferred.at >= startedAt) return;
      if (!read.ok) {
        // Logged once per prerequisite per memo window, so a dependent that never reads as
        // ready has a reason somewhere other than a silent cache.
        console.error(`[stacking] ${parent.title} is not ready to stack on: ${read.error}`);
        this.refused.set(parentId, { at: this.now(), prUrl: finished.prUrl });
        this.verifiedAt.delete(parentId);
        // A definite answer (a draft again, closed, moved out of the primary repository)
        // withdraws stamps it no longer supports. A read that simply failed keeps them: the
        // dispatch revalidates anyway, and a network blip should not unready a whole stack.
        if (read.definite) this.clearStampsOn(parentId);
        this.retryLater(parentId);
        return;
      }
      this.refused.delete(parentId);
      this.verifiedAt.set(parentId, this.now());
      // Re-read after the await: the episode may have moved, or a dependent may have been
      // edited, while GitHub answered.
      const still = this.registry.getTask(parentId);
      const current = still ? this.finishedEpisode(still) : null;
      if (!current || current.prUrl !== finished.prUrl) return;
      const tasks = this.registry.listTasks();
      const byId = new Map(tasks.map((task) => [task.id, task]));
      const config = this.config();
      for (const task of tasks) {
        if (task.status !== "backlog") continue;
        const eligibility = stackEligibility(task, byId, config);
        if (!eligibility.ok || eligibility.parent.id !== parentId) continue;
        const missing = await this.missingMergedPrerequisite(task, byId, read.headSha);
        if (this.stopped) return;
        if (missing) {
          // Waiting on the parent's branch to catch up with a merged sibling, which is a
          // push on GitHub rather than a local event: look again later. A stamp from an
          // earlier read no longer stands on this head.
          this.clearStamp(task.id, parentId);
          this.retryLater(parentId);
          continue;
        }
        // The ancestry check awaited GitHub, and the world may have moved meanwhile. Write
        // nothing unless the evidence this stamp stands on still holds NOW: the parent is
        // still finished on the same episode and pull request (a new turn clears stamps, and
        // must not be written over), no dispatch refusal deferred it, and the dependent
        // still stacks on this parent under the current config.
        const nowParent = this.registry.getTask(parentId);
        const nowFinished = nowParent ? this.finishedEpisode(nowParent) : null;
        if (!nowFinished || nowFinished.episodeId !== finished.episodeId || nowFinished.prUrl !== finished.prUrl) return;
        const deferredNow = this.refused.get(parentId);
        if (deferredNow && deferredNow.prUrl === finished.prUrl && deferredNow.at >= startedAt) return;
        const latest = this.registry.getTask(task.id);
        if (!latest || latest.status !== "backlog") continue;
        const nowTasks = new Map(this.registry.listTasks().map((candidate) => [candidate.id, candidate]));
        const nowConfig = this.config();
        const nowEligible = stackEligibility(latest, nowTasks, nowConfig);
        if (!nowEligible.ok || nowEligible.parent.id !== parentId) continue;
        let changed = false;
        const dependencies = latest.dependencies.map((edge) => {
          if (edge.type !== "task" || edge.taskId !== parentId || edge.satisfiedAt !== null) return edge;
          if (effectiveEdgeMode(edge, nowConfig) !== "stack") return edge;
          // A re-read that confirms the same facts writes nothing: the stamp keeps the time it
          // first became ready, and an unchanged board raises no task event.
          if (
            stamped(edge) &&
            edge.stackBaseBranch === read.headRefName &&
            edge.stackBaseSha === read.headSha &&
            edge.stackPrUrl === finished.prUrl
          ) return edge;
          changed = true;
          return {
            ...edge,
            stackReadyAt: stamped(edge) ? edge.stackReadyAt! : this.now(),
            stackBaseBranch: read.headRefName,
            stackBaseSha: read.headSha,
            stackPrUrl: finished.prUrl,
          };
        });
        if (changed) {
          this.registry.upsertTask({ ...latest, dependencies, updatedAt: Math.max(latest.updatedAt, this.now()) });
        }
      }
      // While anything stands on this read, read it again later.
      if (this.hasStampsOn(parentId)) this.retryLater(parentId, RECHECK_MS + 1);
    } catch (error) {
      this.refused.set(parentId, { at: this.now(), prUrl: finished.prUrl });
      this.verifiedAt.delete(parentId);
      this.retryLater(parentId);
      console.error("[stacking] readiness read failed:", parentId, error);
    } finally {
      this.inFlight.delete(parentId);
    }
  }

  /**
   * The prerequisite's primary pull request, if it is open, not a draft, and in the
   * prerequisite's PRIMARY repository. A pull request in a secondary repository can neither
   * supply the stack base nor release the dependent.
   */
  private async readParent(
    parent: Task,
    finished: FinishedEpisode,
  ): Promise<{ ok: true; headSha: string; headRefName: string } | { ok: false; error: string; definite: boolean }> {
    const secondary = pendingSecondary(parent, finished);
    if (secondary) return { ok: false, error: secondary, definite: true };
    const primary = await this.github.primaryRepository(parent.repoRoot);
    if (!primary || !prInRepositories(finished.prUrl, [primary])) {
      return { ok: false, error: `${finished.prUrl} is not in ${parent.title}'s primary repository`, definite: true };
    }
    const refs = await this.github.prRefs(parent.repoRoot, finished.prUrl);
    if (!refs.ok || !refs.value) return { ok: false, error: refs.error ?? "could not read the pull request", definite: false };
    const number = stackPrNumber(finished.prUrl);
    if (refs.value.state !== "OPEN") return { ok: false, error: `#${number} is not open`, definite: true };
    if (refs.value.isDraft) return { ok: false, error: `#${number} is still a draft`, definite: true };
    if (!refs.value.headRefName) return { ok: false, error: "GitHub did not report the pull request's branch", definite: false };
    return { ok: true, headSha: refs.value.headSha, headRefName: refs.value.headRefName };
  }

  /**
   * The first same-repository prerequisite of `task` that has MERGED but whose merge commit is
   * not in `parentHead`'s history, as a sentence; or null when the parent already carries every
   * one. A child cut from a parent that predates a merged sibling would start without code that
   * already landed on the default branch.
   *
   * A sibling is a task edge or a standalone-session edge. A task sibling is in this
   * repository when its task is; a session edge records no repository, so its merged pull
   * request is in this repository when the checkout's own remotes name that repository.
   */
  private async missingMergedPrerequisite(
    task: Task,
    byId: ReadonlyMap<string, Task>,
    parentHead: string,
  ): Promise<string | null> {
    let repositories: Awaited<ReturnType<StackGitHub["repositories"]>> | null = null;
    for (const edge of task.dependencies) {
      if (edge.type === "plan" || edge.satisfiedAt === null || !edge.prUrl) continue;
      if (edge.type === "task") {
        // Only a sibling we can still place in this repository: an ancestry question asked in
        // the wrong repository has no answer, and a gone task has no repository to ask about.
        const sibling = byId.get(edge.taskId);
        if (!sibling || sibling.repoRoot !== task.repoRoot) continue;
      } else {
        repositories ??= await this.github.repositories(task.repoRoot);
        if (!prInRepositories(edge.prUrl, repositories)) continue;
      }
      const parsed = parsePrUrl(edge.prUrl);
      if (!parsed) return `could not read ${edge.title}'s merged pull request`;
      const refs = await this.github.prRefs(task.repoRoot, edge.prUrl);
      const merge = refs.ok ? refs.value?.mergeCommitSha ?? null : null;
      if (!merge) return `could not read ${edge.title}'s merge commit`;
      const contains = await this.github.isAncestor(task.repoRoot, parsed.owner, parsed.repo, merge, parentHead);
      if (!contains.ok) return `could not confirm the parent includes #${parsed.number}`;
      if (!contains.value) return `waiting for the parent to include #${parsed.number}`;
    }
    return null;
  }

  /** Backlog tasks whose edge to `parentId` carries a readiness stamp. */
  private stampedOn(parentId: string): Task[] {
    return this.registry.listTasks().filter(
      (task) =>
        task.status === "backlog" &&
        task.dependencies.some((edge) => edge.type === "task" && edge.taskId === parentId && stamped(edge)),
    );
  }

  private hasStampsOn(parentId: string): boolean {
    return this.stampedOn(parentId).length > 0;
  }

  private clearStampsOn(parentId: string): void {
    for (const task of this.stampedOn(parentId)) this.clearStamp(task.id, parentId);
  }

  /** Remove the readiness stamp from one task's edge to `parentId`, if it carries one. */
  clearStamp(taskId: string, parentId: string): void {
    const task = this.registry.getTask(taskId);
    if (!task) return;
    let changed = false;
    const dependencies = task.dependencies.map((edge) => {
      if (edge.type !== "task" || edge.taskId !== parentId || !stamped(edge)) return edge;
      changed = true;
      return withoutStackStamp(edge);
    });
    if (changed) this.registry.upsertTask({ ...task, dependencies, updatedAt: Math.max(task.updatedAt, this.now()) });
  }

  /**
   * Revalidate a stack-released dependent immediately before it is dispatched, and resolve
   * the exact parent commit to pin.
   *
   * Null when `task` is not starting on a stack (its start does not depend on any stamp), so
   * the caller dispatches it unstacked. A refusal clears the stamp in the same step, so the
   * edge goes back to waiting rather than offering a dispatch that will be refused again.
   *
   * Never falls back to the default branch: a stacked task that cannot be pinned to its
   * parent is refused with the reason, and nothing has been provisioned yet.
   */
  async planStackedDispatch(task: Task): Promise<StackedDispatchPlan | null> {
    const tasks = this.registry.listTasks();
    const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
    const edge = stackStartEdge(task, byId);
    if (!edge) return null;
    const refuse = (error: string): StackedDispatchPlan => {
      this.clearStamp(task.id, edge.taskId);
      return { ok: false, error };
    };
    // A refusal the readiness read cannot see for itself - origin's branch could not be
    // fetched, it is not the pull request's head, or it lacks a merged prerequisite - would be
    // stamped again by the very next pass, and the same dispatch refused on every Foreman
    // tick. It defers this prerequisite through the same refusal memo a refused read uses,
    // so the dependent is offered again only after the memo's re-check reads it afresh.
    const refuseAndDefer = (error: string): StackedDispatchPlan => {
      if (edge.stackPrUrl) {
        this.refused.set(edge.taskId, { at: this.now(), prUrl: edge.stackPrUrl });
        this.verifiedAt.delete(edge.taskId);
        this.retryLater(edge.taskId);
      }
      return refuse(error);
    };
    const eligibility = stackEligibility(task, byId, this.config());
    if (!eligibility.ok || eligibility.edge.taskId !== edge.taskId) {
      return refuse(`cannot stack: ${eligibility.ok ? "the stacked prerequisite changed" : eligibility.reason}`);
    }
    const parent = eligibility.parent;
    const finished = this.finishedEpisode(parent);
    if (!finished) return refuse(`${parent.title} is working again, so it is not ready to stack on`);
    const secondary = pendingSecondary(parent, finished);
    if (secondary) return refuse(secondary);
    if (!edge.stackPrUrl || finished.prUrl !== edge.stackPrUrl) {
      return refuse(`${parent.title}'s pull request changed since it was ready to stack on`);
    }
    const primary = await this.github.primaryRepository(parent.repoRoot);
    if (!primary || !prInRepositories(edge.stackPrUrl, [primary])) {
      return refuse(`${edge.stackPrUrl} is not in ${parent.title}'s primary repository`);
    }
    const refs = await this.github.prRefs(parent.repoRoot, edge.stackPrUrl);
    if (!refs.ok || !refs.value) return refuse(`could not read ${parent.title}'s pull request: ${refs.error ?? "no answer"}`);
    const number = stackPrNumber(edge.stackPrUrl);
    if (refs.value.state !== "OPEN") return refuse(`#${number} is ${refs.value.state.toLowerCase()}, so there is nothing to stack on`);
    if (refs.value.isDraft) return refuse(`#${number} became a draft`);
    if (!edge.stackBaseBranch || refs.value.headRefName !== edge.stackBaseBranch) {
      return refuse(`#${number} moved to another branch since it was ready to stack on`);
    }
    // A new turn can start while GitHub answers; the readiness evidence must still hold now.
    const after = this.registry.getTask(parent.id);
    const stillFinished = after ? this.finishedEpisode(after) : null;
    if (!stillFinished || stillFinished.episodeId !== finished.episodeId || stillFinished.prUrl !== finished.prUrl) {
      return refuse(`${parent.title} is working again, so it is not ready to stack on`);
    }
    const tip = await this.github.branchSha(task.repoRoot, edge.stackBaseBranch);
    if (!tip.ok) return refuseAndDefer(`could not fetch ${edge.stackBaseBranch}: ${tip.reason}`);
    // The branch is fetched from THIS repository's origin by name, and a name proves nothing:
    // a pull request opened from a fork can share its branch name with an unrelated branch
    // here. Only the head GitHub reports for the pull request is the parent's code, so the
    // fetched tip must be exactly that commit. A parent that pushed in between also lands
    // here, and the re-check after the deferral stamps the new head.
    if (tip.value !== refs.value.headSha) {
      return refuseAndDefer(
        `origin's ${edge.stackBaseBranch} is at ${tip.value.slice(0, 12)}, not #${number}'s head ${refs.value.headSha.slice(0, 12)}` +
          " (the pull request may come from a fork, or it just moved), so it is not stacked on",
      );
    }
    const missing = await this.missingMergedPrerequisite(task, byId, tip.value);
    if (missing) return refuseAndDefer(missing);
    // The fetch and the ancestry checks awaited GitHub too, and the parent can start a new turn
    // meanwhile: the plan is only as good as the readiness evidence at the moment it is
    // returned, so the finished episode and its pull request are checked once more, last.
    const atEnd = this.registry.getTask(parent.id);
    const finishedAtEnd = atEnd ? this.finishedEpisode(atEnd) : null;
    if (!finishedAtEnd || finishedAtEnd.episodeId !== finished.episodeId || finishedAtEnd.prUrl !== finished.prUrl) {
      return refuse(`${parent.title} is working again, so it is not ready to stack on`);
    }
    return {
      ok: true,
      baseSha: tip.value,
      fields: {
        stackParentTaskId: parent.id,
        stackBaseBranch: edge.stackBaseBranch,
        stackBaseSha: tip.value,
        stackPrUrl: edge.stackPrUrl,
      },
    };
  }
}
