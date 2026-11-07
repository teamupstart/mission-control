import type { InspectorPr, Task } from "@shared/types.ts";
import {
  expectedStackBase,
  stackPrNumber,
  type Ancestry,
  type StackObservation,
} from "@shared/stacking.ts";
import {
  getInspectorPr,
  latestStackedPr,
  loadClosedStackChildren,
  loadOpenInspectorPrs,
  noteInspectorPrStack,
  recordStackObservation,
  transitionStackParent,
} from "../db.ts";
import { parsePrUrl, type PrRefs, type PrSnapshot } from "../inspector/github.ts";
import type { StackGitHub } from "./github.ts";
import { withRetarget } from "./lineage.ts";

// The stack lifecycle's observation half, run on every Inspector tick for a pull request row
// with stack lineage. It reads the child and its current parent from GitHub, reconciles the
// child's base with the branch it belongs on, runs the replacement-parent transition when the
// operator chose to wait for one, and records what it saw on the row. The lifecycle STATE is
// derived from that record on read (`deriveStackState`), so it never drifts from the release
// record Phase 1's check writes later in the same tick.
//
// The only GitHub write here is a base edit (Phase 1's retarget helper), and nothing runs git
// in any worktree: ancestry and behind-by come from GitHub's compare API.

/** What this needs from the Registry. A narrow slice, so tests can supply a fake. */
export interface StackLifecycleContext {
  getTask(id: string): Task | undefined;
  /** The task's CURRENT work episode, or null. */
  workEpisodeForTask(taskId: string): { episodeId: string; prUrl: string | null } | null;
  /** The work episode a session is (or was last) in, or null. */
  workEpisodeForSession(sessionId: string): { episodeId: string } | null;
  /** The task a session runs, if any. */
  taskForSession(sessionId: string, cwd: string | null): Task | undefined;
}

/**
 * Observe one stacked child and record it. Returns the observation written, or the previous
 * one unchanged when the current parent could not be read (an unknown parent decides nothing).
 */
export async function observeStackLifecycle(
  pr: InspectorPr,
  snapshot: Pick<PrSnapshot, "state" | "headSha" | "baseRefName" | "defaultBranch">,
  dir: string,
  github: StackGitHub,
  ctx: StackLifecycleContext,
  now: number,
): Promise<StackObservation | null> {
  const lineage = pr.stack;
  if (!lineage) return null;
  const previous = lineage.observation ?? null;
  let parentUrl = lineage.parentPrUrl;
  const read = await github.prRefs(dir, parentUrl);
  if (!read.ok || !read.value) {
    // An unknown parent decides nothing: no base edit, no transition, no new parent facts. The
    // last parent facts are kept for display, marked unconfirmed, so no prompt or action is
    // offered on them until a read succeeds - the parent may have merged or closed meanwhile.
    // The CHILD's own facts come from a snapshot that was read, so they are recorded as they are
    // now: a child that closes or merges on this very tick must be seen as closed or merged, or
    // it is retired as open and never offered its recovery (or its release).
    const child = {
      childState: snapshot.state,
      childHeadSha: snapshot.headSha || null,
      baseRefName: snapshot.baseRefName || null,
      defaultBranch: snapshot.defaultBranch || null,
    };
    // With nothing known about THIS parent yet - the first read failed, or a replacement just
    // took over - the parent is recorded as unknown, so the row says it is checking rather than
    // claiming the stack is fine.
    const marked: StackObservation = previous?.parentUrl === parentUrl
      ? { ...previous, ...child, parentUnreadSince: previous.parentUnreadSince ?? now }
      : {
          observedAt: now,
          ...child,
          parentUrl,
          parentState: null,
          parentHeadSha: null,
          parentHeadRefName: null,
          parentMergeCommitSha: null,
          parentHeadInChild: null,
          baseBehindBy: null,
          parentTaskStopped: null,
          parentEpisodeId: null,
          parentTaskId: null,
          retargetError: null,
          parentUnreadSince: now,
        };
    recordStackObservation(pr.key, marked, now);
    return marked;
  }
  let parent: PrRefs = read.value;

  const head = snapshot.headSha || null;
  const childOpen = snapshot.state === "OPEN";
  let base = snapshot.baseRefName || null;
  const defaultBranch = snapshot.defaultBranch || null;

  const childTask = ctx.getTask(lineage.taskId);
  const parentTaskId = childTask?.stackParentTaskId ?? null;
  const parentTask = parentTaskId ? ctx.getTask(parentTaskId) : undefined;
  const parentEpisodeId = parentEpisodeFor(parentUrl, parentTaskId, previous, ctx);

  // The replacement-parent transition. Only for an OPEN child whose current parent closed
  // without merging, only once the operator chose to wait for a replacement, and only for a
  // replacement opened by the parent task in the SAME work episode the closed parent was.
  // A child already released off its closed parent (moved onto main) is not broken, and is
  // never taken over by a replacement.
  const released = Boolean(head) && lineage.releasedHeadSha === head;
  if (childOpen && !released && parent.state === "CLOSED" && lineage.awaitReplacementAt && parentTaskId && parentEpisodeId) {
    const replacement = findReplacementParent(pr, parentUrl, parentTaskId, parentEpisodeId, ctx);
    if (replacement) {
      const refs = await github.prRefs(dir, replacement.url);
      if (refs.ok && refs.value?.state === "OPEN" && transitionStackParent(pr.key, parentUrl, replacement.url, now, head)) {
        noteInspectorPrStack(
          pr.key,
          `current parent replaced: #${stackPrNumber(parentUrl) ?? "?"} closed, #${replacement.number} took over`,
          now,
        );
        parentUrl = replacement.url;
        parent = refs.value;
      }
    }
  }

  // Base reconciliation, on every tick: the parent's branch while it is open, the default
  // branch once it has merged or closed. Idempotent - skipped when the base already matches,
  // which covers GitHub's own retarget after an auto-deleted branch - and a failure is simply
  // tried again next tick, its reason shown until then.
  let retargetError: string | null = null;
  if (childOpen) {
    const expected = expectedStackBase(parent, defaultBranch);
    if (expected && base && expected !== base) {
      const from = base;
      const outcome = await withRetarget(pr.key, async () => {
        // Read the base again first: the snapshot may predate an edit that already landed
        // (the adoption-time correction, or GitHub's own retarget), and asking for a change
        // that is already true is a write for nothing.
        const fresh = await github.prRefs(dir, pr.url);
        if (fresh.ok && fresh.value?.baseRefName === expected) return { ok: true as const, moved: false };
        const result = await github.retarget(dir, pr.owner, pr.repo, pr.number, expected);
        return result.ok ? { ok: true as const, moved: true } : { ok: false as const, error: result.error };
      });
      if (outcome?.ok) {
        if (outcome.moved) noteInspectorPrStack(pr.key, `base moved from ${from} to ${expected}`, now);
        base = expected;
      } else if (outcome) {
        retargetError = conciseGhError(outcome.error);
      } else {
        // Another edit of this base is in flight; the next tick reads its result.
        retargetError = previous?.retargetError ?? null;
      }
    }
  }

  // Has the open parent moved past the child? One compare call per (parent head, child head)
  // pair: an unchanged pair reuses the last answer, so a quiet stack costs nothing per tick.
  let parentHeadInChild: Ancestry = null;
  let baseBehindBy: number | null = null;
  if (childOpen && parent.state === "OPEN" && parent.headSha && head) {
    const cached = previous && previous.parentUrl === parentUrl && previous.parentHeadSha === parent.headSha
      && previous.childHeadSha === head && previous.parentHeadInChild !== null;
    if (cached) {
      parentHeadInChild = previous.parentHeadInChild;
      baseBehindBy = previous.baseBehindBy;
    } else {
      const compared = await github.compare(dir, pr.owner, pr.repo, parent.headSha, head);
      if (compared.ok && compared.value) {
        parentHeadInChild = compared.value.contains;
        baseBehindBy = compared.value.behindBy;
      }
    }
  }

  const observation: StackObservation = {
    observedAt: now,
    childState: snapshot.state,
    childHeadSha: head,
    baseRefName: base,
    defaultBranch,
    parentUrl,
    parentState: parent.state,
    parentHeadSha: parent.headSha || null,
    parentHeadRefName: parent.headRefName || null,
    parentMergeCommitSha: parent.mergeCommitSha ?? null,
    parentHeadInChild,
    baseBehindBy,
    parentTaskStopped: parentTaskStoppedFor(parentTask, parentEpisodeId),
    parentTaskId,
    // A replacement parent comes from the same episode as the one it replaced, so the
    // recorded episode carries over a transition unchanged.
    parentEpisodeId,
    retargetError,
  };
  recordStackObservation(pr.key, observation, now);
  return observation;
}

/** How many closed stacked children one sweep reads, and where the next sweep resumes. */
const CLOSED_CHILDREN_PER_SWEEP = 50;
let closedChildrenCursor = "";

/**
 * Keep observing stacked children that GitHub (or a person) closed and that no later pull
 * request of the same task and episode has replaced. The Inspector tick retires a closed row,
 * but its recovery action - Reopen on #A's branch, Reopen against main, Move onto main - is
 * chosen from its PARENT's state, and that parent can still merge or close afterwards. Reads
 * only: the child's own refs, then the ordinary observation of its current parent.
 */
export async function observeClosedStackChildren(
  github: StackGitHub,
  ctx: StackLifecycleContext,
  dirOf: (pr: InspectorPr) => string | null,
  now: number,
  pageSize = CLOSED_CHILDREN_PER_SWEEP,
): Promise<void> {
  // A bounded page per sweep, round-robin by key: every eligible row is reached in turn however
  // many there are, and no sweep spends more than one page of GitHub reads on them.
  let page = loadClosedStackChildren(closedChildrenCursor, pageSize);
  if (page.length === 0 && closedChildrenCursor) page = loadClosedStackChildren("", pageSize);
  closedChildrenCursor = page.length < pageSize ? "" : page.at(-1)!.key;
  for (const row of page) {
    const lineage = row.stack;
    const o = lineage?.observation ?? null;
    if (!lineage) continue;
    // Closed by the ledger's own reading, or by the last observation: either is enough, so a row
    // retired on a tick whose observation still said OPEN is not lost.
    if (row.observedState !== "CLOSED" && o?.childState !== "CLOSED") continue;
    // A confirmed MERGED parent is terminal: the offered action (Reopen against main) cannot
    // change, so reading it again buys nothing and spends the shared gh rate limit.
    if (o?.parentState === "MERGED" && !o.parentUnreadSince && o.parentUrl === lineage.parentPrUrl) continue;
    const latest = latestStackedPr(lineage.taskId, row.owner, row.repo, lineage.episode);
    if (latest && latest.key !== row.key) continue;
    const dir = dirOf(row);
    if (!dir) continue;
    const child = await github.prRefs(dir, row.url);
    if (!child.ok || !child.value) continue;
    await observeStackLifecycle(row, {
      state: child.value.state,
      headSha: child.value.headSha,
      baseRefName: child.value.baseRefName,
      defaultBranch: child.value.defaultBranch,
    }, dir, github, ctx, now);
  }
}

/**
 * The parent task's work episode its current pull request belongs to.
 *
 * Remembered from the first observation that could tell, so a later reschedule of the parent
 * task - which moves it to a new episode - can be recognised as one, and a pull request it
 * opens there is never taken for a replacement. Read from the parent pull request's adopted
 * row (the session that opened it), else from the parent task's current binding when that
 * binding still names this pull request.
 */
function parentEpisodeFor(
  parentUrl: string,
  parentTaskId: string | null,
  previous: StackObservation | null,
  ctx: StackLifecycleContext,
): string | null {
  if (previous?.parentUrl === parentUrl && previous.parentEpisodeId) return previous.parentEpisodeId;
  const parsed = parsePrUrl(parentUrl);
  const row = parsed ? getInspectorPr(parsed.key) : null;
  if (row?.sessionId) {
    const episode = ctx.workEpisodeForSession(row.sessionId)?.episodeId ?? null;
    if (episode) return episode;
  }
  if (!parentTaskId) return null;
  const binding = ctx.workEpisodeForTask(parentTaskId);
  return binding && binding.prUrl === parentUrl ? binding.episodeId : null;
}

/**
 * Whether the parent task has stopped working on its pull request: cancelled, failed, or
 * rescheduled back into the backlog after it had started. A parent task that is running again,
 * in this episode or a later one, is working: its open pull request can still be pushed to and
 * merge, so that is not a broken stack.
 */
function parentTaskStoppedFor(
  parentTask: Task | undefined,
  parentEpisodeId: string | null,
): StackObservation["parentTaskStopped"] {
  if (!parentTask) return null;
  if (parentTask.status === "cancelled" || parentTask.status === "failed") return parentTask.status;
  if (parentTask.status === "backlog" && parentEpisodeId) return "rescheduled";
  return null;
}

/**
 * A replacement for a closed parent: an open pull request the Inspector adopted from a
 * session of the same parent task, in the same work episode, in the same repository, after the
 * closed one. The newest such row wins.
 */
function findReplacementParent(
  child: InspectorPr,
  closedUrl: string,
  parentTaskId: string,
  parentEpisodeId: string,
  ctx: StackLifecycleContext,
): InspectorPr | null {
  const closed = parsePrUrl(closedUrl);
  if (!closed) return null;
  const closedRow = getInspectorPr(closed.key);
  const candidates = loadOpenInspectorPrs().filter((row) =>
    row.key !== closed.key &&
    row.key !== child.key &&
    row.owner.toLowerCase() === closed.owner.toLowerCase() &&
    row.repo.toLowerCase() === closed.repo.toLowerCase() &&
    (!closedRow || row.adoptedAt >= closedRow.adoptedAt) &&
    row.sessionId !== null &&
    ctx.taskForSession(row.sessionId, row.cwd)?.id === parentTaskId &&
    ctx.workEpisodeForSession(row.sessionId)?.episodeId === parentEpisodeId,
  );
  return candidates.sort((a, b) => b.adoptedAt - a.adoptedAt)[0] ?? null;
}

/** GitHub's own reason, without the command prefix, short enough for one merge-queue line. */
function conciseGhError(error: string | undefined): string {
  const text = (error ?? "refused").replace(/^gh api \([^)]*\) failed \([^)]*\):\s*/, "").trim();
  return (text || "refused").slice(0, 160);
}
