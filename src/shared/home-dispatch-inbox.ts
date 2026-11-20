import type { TaskStatus } from "./types.ts";
import type {
  HomeDispatchInboxItem,
  HomeDispatchReceipt,
  HomeDispatchResident,
  InboxState,
} from "./home-dispatch.ts";
import type { WorkflowRunStatus } from "./workflow.ts";

/**
 * Pure rules behind the headless-mode inbox (spec 7.7, 7.8, 7.24). The daemon builds the inbox
 * with them, and the pane, the band, the status entry and `mctl` read the same answers, so
 * every surface agrees. Browser safe: no `node:` imports. Phase 4 owns this file; a change to
 * `workflowStages` or `residentLoopLabel` is asked of that owner.
 */

/** A task that finished or published a plan stays `ready` for this long (7.7). */
export const INBOX_READY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** A failed or cancelled task stays `failed` for this long (7.7). */
export const INBOX_FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The run statuses that stop a run until a person acts. */
const BLOCKED_RUN_STATUSES: readonly WorkflowRunStatus[] = ["blocked", "waiting_for_action"];
/** The run statuses a run cannot leave. Anything else is still on its way. */
const ENDED_RUN_STATUSES: readonly WorkflowRunStatus[] = ["completed", "cancelled", "failed"];

export interface InboxStateFacts {
  taskStatus: TaskStatus;
  /** Backlog items only: whether Foreman may start it. */
  enabled: boolean;
  /** The task's session has a pending review or question. */
  hasPending: boolean;
  /** Status of the task's after-work run, or null with none. */
  runStatus: WorkflowRunStatus | null;
  /** When the task last moved, for the 7 day and 24 hour windows. */
  settledAt: number;
  now: number;
}

/**
 * Maps task facts to an inbox state, or null when the task is not part of the inbox (a task that
 * finished or failed longer ago than its window). The inbox, the pane and the status entry all
 * call this one function.
 */
export function inboxStateFor(facts: InboxStateFacts): InboxState | null {
  const { taskStatus, runStatus } = facts;
  const runBlocked = runStatus !== null && BLOCKED_RUN_STATUSES.includes(runStatus);
  const runOpen = runStatus !== null && !ENDED_RUN_STATUSES.includes(runStatus);
  switch (taskStatus) {
    case "backlog":
      return facts.enabled ? "queued" : "shelved";
    case "dispatching":
    case "running":
      if (facts.hasPending) return "waiting";
      return runBlocked ? "blocked" : "running";
    case "done":
      // A request still pending on a finished task needs the person, whatever the task's status says.
      if (facts.hasPending) return "waiting";
      // The after-work run belongs to the task: it can still be reviewing, or stuck.
      if (runBlocked) return "blocked";
      if (runOpen) return "running";
      return facts.now - facts.settledAt <= INBOX_READY_WINDOW_MS ? "ready" : null;
    case "failed":
    case "cancelled":
      // A request still open on a failed or cancelled task is still owed an answer, however old.
      if (facts.hasPending) return "waiting";
      return facts.now - facts.settledAt <= INBOX_FAILED_WINDOW_MS ? "failed" : null;
  }
}

type NeedsYouFields = Pick<HomeDispatchInboxItem, "taskId" | "state" | "changedAt">;

/**
 * The ids of what needs the person, in the order every surface shows them: waiting items oldest
 * first (a resident's request among them, by age), then blocked items oldest first. Age, never
 * type. A tie keeps the task id order so the answer is stable between polls.
 */
export function needsYouOrder(items: readonly NeedsYouFields[]): string[] {
  const byAge = (a: NeedsYouFields, b: NeedsYouFields) =>
    a.changedAt - b.changedAt || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  const waiting = items.filter((i) => i.state === "waiting").sort(byAge);
  const blocked = items.filter((i) => i.state === "blocked").sort(byAge);
  return [...waiting, ...blocked].map((i) => i.taskId);
}

export const WORKFLOW_STAGE_IDS = ["start", "work", "review", "pr", "merge"] as const;
export type WorkflowStageId = (typeof WORKFLOW_STAGE_IDS)[number];
export type WorkflowStageState = "done" | "running" | "blocked" | "pending";
export type WorkflowStages = Record<WorkflowStageId, WorkflowStageState>;

type StageFields = Pick<HomeDispatchInboxItem, "state" | "pr"> & {
  run?: Pick<NonNullable<HomeDispatchInboxItem["run"]>, "status">;
};

/**
 * The strip the Workflows tab draws for one item: `start`, `work`, `review`, `pr`, `merge`.
 * Derived from `state`, `run` and `pr` only, so the pane never re-derives it.
 */
export function workflowStages(item: StageFields): WorkflowStages {
  const stages: WorkflowStages = { start: "pending", work: "pending", review: "pending", pr: "pending", merge: "pending" };
  if (item.state === "queued" || item.state === "shelved") return stages;
  stages.start = "done";
  const runStatus = item.run?.status;
  const runBlocked = runStatus !== undefined && BLOCKED_RUN_STATUSES.includes(runStatus);
  const hasRun = runStatus !== undefined;

  if (item.state === "failed") {
    stages.work = "blocked";
    return stages;
  }
  if (item.state === "waiting") stages.work = "blocked";
  else if (item.state === "running" && !hasRun) stages.work = "running";
  else stages.work = "done";

  if (hasRun) {
    stages.review = runBlocked ? "blocked" : runStatus === "completed" ? "done" : "running";
  } else if (item.state === "ready") {
    stages.review = "done";
  }
  if (item.pr) stages.pr = "done";
  return stages;
}

/** A resident's loop line as the Residents tab draws it (7.24); the dashboard's words are the same. */
export interface ResidentLoopLabel {
  mark: string;
  name: string;
  /** `waiting on you · iteration 3`, `working · iteration 2 · $0.40`, ... */
  status: string;
  /** `asks: {question}`, only while the resident needs the person and a question is known. */
  asks?: string;
  /** `built-in`, `{n} repos`, `ctx {p}%`, each only when known. */
  extra: string[];
}

type ResidentLabelFields = Pick<
  HomeDispatchResident,
  "name" | "builtIn" | "repos" | "loopState" | "needsYou" | "iteration" | "nextWakeAt" | "pauseReason" | "contextPercent" | "costUsd"
>;

function minutesUntil(at: number | null, now: number): number | null {
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 60_000));
}

export function residentLoopLabel(resident: ResidentLabelFields, now: number, question?: string): ResidentLoopLabel {
  const extra: string[] = [];
  if (resident.builtIn) extra.push("built-in");
  if (resident.repos > 0) extra.push(`${resident.repos} ${resident.repos === 1 ? "repo" : "repos"}`);
  if (resident.contextPercent !== null) extra.push(`ctx ${Math.round(resident.contextPercent)}%`);
  const n = resident.iteration;
  if (resident.needsYou) {
    return {
      mark: "▲", name: resident.name, status: `waiting on you · iteration ${n}`,
      ...(question ? { asks: `asks: ${question}` } : {}), extra,
    };
  }
  switch (resident.loopState) {
    case "working": {
      const cost = resident.costUsd === null ? "" : ` · $${resident.costUsd.toFixed(2)}`;
      return { mark: "●", name: resident.name, status: `working · iteration ${n}${cost}`, extra };
    }
    case "waiting": {
      const m = minutesUntil(resident.nextWakeAt, now);
      const wake = m === null ? "" : ` · next wake ${m}m`;
      return { mark: "◌", name: resident.name, status: `waiting for wake${wake} · iter ${n}`, extra };
    }
    case "compacting":
      return { mark: "◐", name: resident.name, status: `compacting · iter ${n}`, extra };
    case "paused":
      return { mark: "‖", name: resident.name, status: `paused: ${resident.pauseReason ?? "paused"} · iter ${n}`, extra };
    case "ended":
      return { mark: "○", name: resident.name, status: `ended · iter ${n}`, extra };
  }
}

/** Residents needing the person first, then by name. */
export function sortResidents<T extends Pick<HomeDispatchResident, "needsYou" | "name">>(residents: readonly T[]): T[] {
  return [...residents].sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || a.name.localeCompare(b.name));
}

/**
 * The slug the command line and the pane call a workflow: its name, lower-cased, with every run of
 * other characters turned into one hyphen. Workflows have no stored slug, so this one function is
 * the only place that spells it.
 */
export function workflowSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The fixed text a `chat_first` answer sends (7.8). */
export const HOME_DISPATCH_CHAT_FIRST_TEXT =
  "The person wants to talk this through before deciding. Read their next messages, then ask again.";

/** The receipt's `sent` for a `chat_first` answer. */
export const HOME_DISPATCH_CHAT_FIRST_SENT = "chat first";

/** The characters of a revision hash a person sees (7.8). */
export function shortRevision(hash: string): string {
  return hash.slice(0, 7);
}

/** `sent` for an approval or rejection, as 7.8 spells it. */
export function approvalSent(kind: "plan" | "review" | "reject", hash: string | null, text?: string): string {
  const head = kind === "plan"
    ? `approve plan revision ${shortRevision(hash ?? "")}`
    : kind === "review"
      ? `approve rev ${shortRevision(hash ?? "")}`
      : "reject";
  return text ? `${head}: ${text}` : head;
}

/** The exact line the person sees for a receipt. */
export function receiptLine(r: HomeDispatchReceipt): string {
  return `sent "${r.sent}" to ${r.taskId}`;
}

/** The message the mod shows when a 2xx answer carried no readable receipt (7.8, L17). */
export function unreadableReceiptLine(reviewId: string): string {
  return `Answer delivered for review ${reviewId}; the receipt could not be read. Do not send it again.`;
}
