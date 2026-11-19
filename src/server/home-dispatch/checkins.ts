import type { CheckinResponse, HomeCaller, InboxItem } from "@shared/home-dispatch.ts";
import { openDb } from "../db.ts";
import { resolveRepoRoot } from "../repos.ts";
import type { HomeDispatchDeps } from "./deps.ts";
import { handleReadInbox } from "./inbox.ts";
import type { HomeDispatchResult } from "./stub.ts";

/** When each session last checked in. In memory only, as the spec keeps it (7.7). */
const lastCheckin = new Map<string, number>();
let clock: () => number = Date.now;

/** Tests only: forget every check-in time and (optionally) replace the clock. */
export function resetCheckinsForTest(now?: () => number): void {
  lastCheckin.clear();
  clock = now ?? Date.now;
}

/**
 * Sort one repository's inbox into the check-in lists (spec 7.7): what waits on the person,
 * what runs, and what finished (ready or failed) since `since`, or all of it on a first
 * check-in. Queued and shelved are counts only. Newest first within each list.
 */
export function buildCheckin(items: readonly InboxItem[], since: number | null): CheckinResponse {
  const newestFirst = (a: InboxItem, b: InboxItem): number => b.changedAt - a.changedAt;
  const pick = (state: InboxItem["state"]): InboxItem[] => items.filter((item) => item.state === state);
  const finished = items
    .filter((item) => (item.state === "ready" || item.state === "failed") && (since === null || item.changedAt > since))
    .sort(newestFirst);
  return {
    waiting: pick("waiting").sort(newestFirst),
    running: pick("running").sort(newestFirst),
    finished,
    queued: pick("queued").length,
    shelved: pick("shelved").length,
  };
}

const READY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The repository's tasks as inbox items, read straight from the task manager and the review
 * registry. Used only while the inbox handler (WP2b) is still its 501 stub, so a check-in
 * answers with real lists today; once that handler answers, it is the single source and this
 * is never reached. Scope is the same: tasks whose `origin_repo` is this repository.
 */
export function inboxFromTasks(deps: HomeDispatchDeps, repo: string, now: number): InboxItem[] {
  const { tasks, registry } = deps;
  if (!tasks) return [];
  const ids = openDb().prepare("SELECT id FROM tasks WHERE origin_repo = ?").all(repo) as { id: string }[];
  const items: InboxItem[] = [];
  for (const { id } of ids) {
    const task = tasks.get(id);
    if (!task) continue;
    const base = { taskId: task.id, title: task.title, kind: task.kind, changedAt: task.updatedAt };
    const make = (state: InboxItem["state"], extra: Partial<InboxItem> = {}): void => {
      items.push({
        reviewId: null, question: null, options: [], pullRequestUrl: null, queuePosition: null,
        revisionHash: null, dashboardOnly: null, ...base, state, ...extra,
      });
    };
    if (task.status === "backlog") make(task.enabled ? "queued" : "shelved");
    else if (task.status === "dispatching") make("running");
    else if (task.status === "running") {
      const pending = (task.sessionId ? registry?.pendingReviews(task.sessionId) : [])
        ?.find((r) => r.kind === "input" || r.kind === "plan" || r.kind === "plan-decisions" || r.kind === "diff");
      if (pending) {
        make("waiting", {
          reviewId: pending.id,
          changedAt: Math.max(task.updatedAt, pending.createdAt ?? 0),
          question: pending.kind === "input" ? pending.body : pending.title,
          options: pending.decisions?.length === 1 ? pending.decisions[0]!.options.map((o) => o.label) : [],
        });
      } else make("running");
    } else if (task.status === "done" && now - (task.completedAt ?? task.updatedAt) <= READY_WINDOW_MS) {
      make("ready", { pullRequestUrl: task.outcomeUrl });
    } else if ((task.status === "failed" || task.status === "cancelled") && now - task.updatedAt <= FAILED_WINDOW_MS) {
      make("failed");
    }
  }
  return items;
}

/** `POST /mcp/dispatch/checkins`. Records this session's check-in time in memory. */
export async function handleCheckin(
  input: HomeCaller,
  deps: HomeDispatchDeps = {},
): Promise<HomeDispatchResult<CheckinResponse>> {
  const repo = (await resolveRepoRoot(input.cwd)) ?? input.cwd;
  const inbox = await (deps.readInbox ?? handleReadInbox)({ repo });
  let items: InboxItem[];
  if (inbox.status === 200) items = (inbox.body as { items: InboxItem[] }).items;
  else if (inbox.status === 501) items = inboxFromTasks(deps, repo, clock());
  else return inbox as HomeDispatchResult<never>;
  const body = buildCheckin(items, lastCheckin.get(input.sessionId) ?? null);
  lastCheckin.set(input.sessionId, clock());
  return { status: 200, body };
}
