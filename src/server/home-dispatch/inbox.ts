import { realpathSync } from "node:fs";
import type { Handler } from "hono";
import {
  HomeDispatchInboxQuerySchema,
  INBOX_STATES,
  type HomeDispatchInbox,
  type HomeDispatchInboxItem,
  type InboxState,
} from "@shared/home-dispatch.ts";
import { inboxStateFor, needsYouOrder, workflowSlug } from "@shared/home-dispatch-inbox.ts";
import { canMessage } from "@shared/pane.ts";
import { taskHasRepository } from "@shared/task.ts";
import type { ResidentProfile, ResidentRunSummary } from "@shared/residents.ts";
import type { ReviewItem, Session, Task } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { getForemanConfig } from "../foreman/config.ts";
import { activeAgentCount } from "../foreman/backlog-machine.ts";
import { pendingFor, reviewBelongsTo, taskOwningSession } from "./approval.ts";
import { resolveCaller, taskOrigins, type ResolvedCaller } from "./caller.ts";
import { reviewerRowsFor, runChecksFor } from "./reviewers.ts";
import { canReadTask, type TaskOrigin } from "./sessions.ts";
import type { HomeDispatchDeps, HomeDispatchHandler } from "./stub.ts";
import { shapingFor, type InboxShaping } from "./shaping.ts";
import { subagentCountsFor } from "./subagent-state.ts";

// Owner: P4. `GET /dispatch/inbox` (spec 7.7), and the counts the registration answer carries.
// The inbox is a pure read: nothing here writes, so polling it records nothing (D48).

const NO_ORIGIN: TaskOrigin = { originSurface: null, originRepo: null, originSessionId: null };

function realPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function sameRepo(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const ra = realPath(a);
  return ra !== null && ra === realPath(b);
}

/** A live resident run a session may see (7.24), with what the inbox needs to name it. */
export interface VisibleResident {
  run: ResidentRunSummary;
  name: string;
  builtIn: boolean;
  /** Primary plus attached repositories. */
  repos: number;
}

/**
 * The live resident runs a home session sees (7.24): those whose task's repository, or one of its
 * attached repositories, is the session's repository, and those with no repository at all. A
 * session outside any repository sees only the second kind. P9's residents routes reuse this so
 * the pane's Residents tab and the inbox's resident requests can never disagree about visibility.
 */
export function visibleResidents(
  deps: Pick<HomeDispatchDeps, "registry">,
  sessionRepoRoot: string | null,
): Map<string, VisibleResident> {
  const out = new Map<string, VisibleResident>();
  for (const run of deps.registry.listResidentRuns()) {
    const task = deps.registry.getTask(run.taskId);
    if (!task) continue;
    // A repository-less resident runs in a workspace directory, which is stored as its `repoRoot` but
    // is not a repository (`taskHasRepository` is the codebase's one test for that), so it is left out
    // of the roots. Repositories attached to it still count, and it has none only when it has neither.
    const roots = [...(taskHasRepository(task) ? [task.repoRoot] : []), ...task.extraRepos.map((r) => r.repoRoot)]
      .filter((r): r is string => Boolean(r));
    const noRepository = roots.length === 0;
    if (!noRepository && !roots.some((root) => sameRepo(sessionRepoRoot, root))) continue;
    const profile: ResidentProfile | undefined = deps.registry.getResidentProfile(run.profileId);
    out.set(run.taskId, {
      run,
      name: profile?.name ?? run.personaName ?? run.profileId,
      builtIn: profile?.builtin === true,
      repos: noRepository ? 0 : roots.length,
    });
  }
  return out;
}

/** The first pending review of a session, oldest first: what the item asks. */
function firstPending(deps: Pick<HomeDispatchDeps, "registry">, sessionId: string | null, task: Task): ReviewItem | undefined {
  if (!sessionId) return undefined;
  // Only a review the task could have asked: one created before it started belongs to a task that
  // held the session earlier (`reviewBelongsTo`), and is not attributed to this one.
  return deps.registry.pendingReviews(sessionId)
    .filter((r) => reviewBelongsTo(task, r.createdAt))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
}

/**
 * How much a run matters to the person: one stopped for them first, then one still going, then one
 * that ended. A session has one run per repository it changed, so the task shows the most pressing.
 */
function runPriority(run: WorkflowRunSummary): number {
  if (run.status === "blocked" || run.status === "waiting_for_action") return 2;
  return run.status === "completed" || run.status === "cancelled" || run.status === "failed" ? 0 : 1;
}

/**
 * The task's most relevant workflow run for each session: a run needing the person beats a running
 * one, which beats an ended one, and among equals the most recently updated wins. A completed run in
 * one repository therefore never hides a blocked run in another.
 */
function runsBySession(deps: Pick<HomeDispatchDeps, "workflows">): Map<string, WorkflowRunSummary> {
  const out = new Map<string, WorkflowRunSummary>();
  for (const summary of deps.workflows?.runs() ?? []) {
    if (!summary.sessionId) continue;
    const have = out.get(summary.sessionId);
    const better = !have
      || runPriority(summary) > runPriority(have)
      || (runPriority(summary) === runPriority(have) && summary.updatedAt > have.updatedAt);
    if (better) out.set(summary.sessionId, summary);
  }
  return out;
}

function blockedReasonOf(run: WorkflowRunSummary): string | null {
  if (run.status === "blocked") return run.phase || null;
  if (run.status === "waiting_for_action") return run.actionWait ?? (run.phase || null);
  return null;
}

function runBlock(run: WorkflowRunSummary): NonNullable<HomeDispatchInboxItem["run"]> {
  return {
    workflowId: run.workflowId,
    slug: workflowSlug(run.workflowName),
    version: run.workflowVersion,
    status: run.status,
    phase: run.phase || null,
    step: run.round > 0 ? run.round : null,
    of: null,
    checks: runChecksFor(run.id),
    blockedReason: blockedReasonOf(run),
    reviewers: reviewerRowsFor(run.id),
  };
}

function prBlock(task: Task, session: Session | undefined): HomeDispatchInboxItem["pr"] {
  if (session?.prUrl && session.prNumber !== null) {
    return { number: session.prNumber, url: session.prUrl, checks: session.prChecks ?? null };
  }
  const url = task.outcomeUrl;
  const match = url ? /\/pull\/(\d+)(?:[/?#].*)?$/.exec(url) : null;
  return url && match ? { number: Number(match[1]), url, checks: null } : undefined;
}

/** Backlog positions: the enabled backlog in the operator's order, ranked tasks first. */
function queuePositions(tasks: readonly Task[]): Map<string, number> {
  const queued = tasks
    .filter((t) => t.status === "backlog" && t.enabled)
    .sort((a, b) => (a.backlogRank ?? Infinity) - (b.backlogRank ?? Infinity) || a.createdAt - b.createdAt);
  return new Map(queued.map((t, i) => [t.id, i + 1]));
}

/** The id prefix of an item that stands for a pending review no task can be named for. */
export const UNATTRIBUTED_ITEM_PREFIX = "review:";

/**
 * A pending review whose asking task cannot be established (another task took over its worker
 * session after it was asked). It is a waiting item in `needsYou`, marked dashboard-only so the
 * answers route's refusal and the pane say the same thing, and it names no task but the review.
 */
function unattributedItem(review: ReviewItem, holder: Task, session: Session | undefined): HomeDispatchInboxItem {
  return {
    taskId: `${UNATTRIBUTED_ITEM_PREFIX}${review.id}`,
    title: review.title,
    kind: "chat",
    state: "waiting",
    origin: "home-session",
    changedAt: review.createdAt,
    canMessage: false,
    agent: session?.agent ?? holder.agent,
    runtime: session?.runtime ?? null,
    pending: { ...pendingFor(review, false), dashboardOnly: true, allowsText: false },
  };
}

/** Foreman's agent slots: the live agents against the `maxSessions` ceiling. */
function slotsOf(deps: Pick<HomeDispatchDeps, "registry">): HomeDispatchInbox["slots"] {
  const sessions = deps.registry.snapshot().sessions;
  return { used: activeAgentCount(sessions, deps.registry.listTasks()), ceiling: getForemanConfig().maxSessions };
}

/**
 * Builds the inbox for a caller (7.7). A home session sees its repository's home-dispatched tasks,
 * the tasks it started itself, and the pending requests of residents it can see. `mctl` sees the
 * home-dispatched tasks of the repository it names, or every repository's with `repo=*`.
 */
export function buildInbox(
  deps: Pick<HomeDispatchDeps, "registry" | "workflows">,
  resolved: ResolvedCaller,
  now: number = Date.now(),
  /** Where an item's `shaping` comes from; the stub until task-shaping Phase 2 lands. Tests inject their own. */
  shapingOf: (task: Task) => InboxShaping | undefined = shapingFor,
): HomeDispatchInbox {
  const { caller } = resolved;
  const tasks = deps.registry.listTasks();
  const origins = taskOrigins();
  const residents = caller.surface === "home-session" ? visibleResidents(deps, caller.repoRoot) : new Map<string, VisibleResident>();
  const runs = runsBySession(deps);
  const positions = queuePositions(tasks);
  const items: HomeDispatchInboxItem[] = [];
  const orphaned = new Set<string>();

  for (const task of tasks) {
    const origin = origins.get(task.id) ?? NO_ORIGIN;
    const resident = residents.get(task.id);
    if (resolved.allRepos) {
      if (origin.originSurface === null) continue;
    } else if (canReadTask(caller, origin, { residentVisible: resident !== undefined })) {
      continue;
    }
    const session = task.sessionId ? deps.registry.getSession(task.sessionId) : undefined;
    // A review belongs to the one task that owns its session; a task that merely shares the session
    // (an earlier one) never shows the question, and an ambiguous session shows it on neither.
    const owner = task.sessionId ? taskOwningSession(deps, task.sessionId) : undefined;
    const pending = owner && "task" in owner && owner.task.id === task.id ? firstPending(deps, task.sessionId, task) : undefined;
    // A question that predates this task's start was asked by whichever task held the session before
    // it, which the registry no longer records. It is still pending, so it is listed on its own as
    // something only the dashboard can answer, and attributed to neither task.
    if (task.sessionId && owner && "task" in owner && owner.task.id === task.id) {
      for (const review of deps.registry.pendingReviews(task.sessionId)) {
        if (reviewBelongsTo(task, review.createdAt) || orphaned.has(review.id)) continue;
        orphaned.add(review.id);
        items.push(unattributedItem(review, task, session));
      }
    }
    // A resident run is in the inbox only while it has a request; the Residents tab lists the rest.
    if (resident && !pending) continue;
    const run = task.sessionId ? runs.get(task.sessionId) : undefined;
    const state = inboxStateFor({
      taskStatus: task.status,
      enabled: task.enabled,
      hasPending: pending !== undefined,
      runStatus: run?.status ?? null,
      settledAt: task.completedAt ?? task.updatedAt,
      now,
    });
    if (state === null) continue;

    const started = task.dispatchedAt ?? task.createdAt;
    const elapsedMs = state === "queued" || state === "shelved"
      ? undefined
      : Math.max(0, (task.completedAt ?? now) - started);
    const costUsd = session?.cost?.costUsd ?? undefined;
    const subagents = subagentCountsFor(session);
    const pr = prBlock(task, session);
    const shaping = shapingOf(task);
    items.push({
      taskId: task.id,
      title: task.title,
      kind: task.kind,
      state,
      origin: resident ? "resident" : origin.originSurface ?? "home-session",
      changedAt: Math.max(task.updatedAt, pending?.createdAt ?? 0),
      ...(positions.has(task.id) ? { queuePosition: positions.get(task.id)! } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(subagents ? { subagents } : {}),
      canMessage: session ? canMessage(session) : false,
      agent: task.agent,
      runtime: session?.runtime ?? null,
      ...(pr ? { pr } : {}),
      ...(run ? { run: runBlock(run) } : {}),
      ...(pending ? { pending: pendingFor(pending, resident !== undefined) } : {}),
      ...(resident ? { resident: { runId: resident.run.id, name: resident.name } } : {}),
      ...(shaping ? { shaping } : {}),
    });
  }

  const needsYou = needsYouOrder(items);
  const counts = Object.fromEntries(INBOX_STATES.map((s) => [s, 0])) as Record<InboxState, number>;
  for (const item of items) counts[item.state] += 1;
  const byId = new Map(items.map((i) => [i.taskId, i]));
  const dashboardOnly = needsYou.filter((id) => byId.get(id)?.pending?.dashboardOnly).length;
  return { items, needsYou, counts, slots: slotsOf(deps), dashboardOnly };
}

/**
 * The `{ running, waiting }` a registration answer carries for the banner (7.2, 7.21): the running
 * tasks and what needs the person, counted exactly as that session's own inbox lists them, with
 * the same visibility (its repository, its own tasks, and the residents it can see).
 */
export function registrationCounts(
  deps: Pick<HomeDispatchDeps, "registry" | "workflows">,
  repoRoot: string | null,
  sessionId: string,
): { running: number; waiting: number } {
  const inbox = buildInbox(deps, { caller: { surface: "home-session", sessionId, repoRoot }, sessionId, allRepos: false });
  return { running: inbox.counts.running, waiting: inbox.needsYou.length };
}

/** `GET /dispatch/inbox?repo=&session=` (7.7). `repo=*` is for `mctl` only. */
export const inboxHandler: HomeDispatchHandler = (deps): Handler => async (c) => {
  const query = HomeDispatchInboxQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ error: "invalid query" }, 400);
  const outcome = await resolveCaller(deps, c, { sessionId: query.data.session, repo: query.data.repo });
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json(buildInbox(deps, outcome.resolved));
};
