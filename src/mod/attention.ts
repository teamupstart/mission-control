import { MISSION_CONTROL_MARK } from "@shared/home-dispatch-banner.ts";
import type { HomeDispatchInbox, HomeDispatchInboxItem } from "@shared/home-dispatch.ts";
import type { ModBand } from "./host.ts";

/**
 * The glance layer's decisions (spec 7.12), as pure functions of the inbox: what needs the
 * person, which of it is new, and the band and status entry that say so. Nothing here touches
 * the host, so every rule is a plain assertion.
 *
 * Quiet by construction: the band and the status entry exist only while something needs the
 * person, a toast fires once per new item, and nothing colours a background.
 */

/** Longest task title a toast or the status entry quotes, in characters. */
const TITLE_MAX = 48;

function short(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

/** The items that need the person, in the daemon's order (`needsYou` is already ordered). */
export function needsYouItems(inbox: HomeDispatchInbox): HomeDispatchInboxItem[] {
  const byId = new Map(inbox.items.map((item) => [item.taskId, item]));
  const out: HomeDispatchInboxItem[] = [];
  for (const id of inbox.needsYou) {
    const item = byId.get(id);
    if (item) out.push(item);
  }
  return out;
}

/**
 * One key per ask: the task and the review it is waiting on. A replaced question is a new ask
 * and toasts again; the same question seen on every poll does not.
 */
export function attentionKey(item: HomeDispatchInboxItem): string {
  return `${item.taskId}:${item.pending?.reviewId ?? item.state}`;
}

const ASKS: Record<NonNullable<HomeDispatchInboxItem["pending"]>["kind"], string> = {
  question: "asks a question",
  plan: "needs plan approval",
  "plan-decisions": "needs plan decisions",
  diff: "needs a review",
  "plan-review": "needs a plan review",
  "resident-request": "has a resident request",
};

function toastFor(item: HomeDispatchInboxItem): string {
  const what = item.pending ? ASKS[item.pending.kind] : "is blocked";
  return `Mission Control: "${short(item.title)}" ${what}`;
}

export interface AttentionMemory {
  /** Keys of the asks already shown. */
  asks: ReadonlySet<string>;
  /** Each task's last state, to see a task become ready or fail. */
  states: ReadonlyMap<string, HomeDispatchInboxItem["state"]>;
}

/**
 * The toasts for what is new since `memory`, and the memory to carry forward. With no `memory`
 * (the first poll) nothing toasts: the banner and the band already say what was waiting when
 * the session opened, and a toast per old item would be noise.
 */
export function nextAttention(
  memory: AttentionMemory | null,
  inbox: HomeDispatchInbox,
): { toasts: string[]; memory: AttentionMemory } {
  const asks = new Set<string>();
  const states = new Map<string, HomeDispatchInboxItem["state"]>();
  const toasts: string[] = [];
  for (const item of needsYouItems(inbox)) {
    const key = attentionKey(item);
    asks.add(key);
    if (memory && !memory.asks.has(key)) toasts.push(toastFor(item));
  }
  for (const item of inbox.items) {
    states.set(item.taskId, item.state);
    const before = memory?.states.get(item.taskId);
    if (memory && before !== undefined && before !== item.state) {
      if (item.state === "ready") toasts.push(`Mission Control: "${short(item.title)}" is ready`);
      else if (item.state === "failed") toasts.push(`Mission Control: "${short(item.title)}" failed`);
    }
  }
  return { toasts, memory: { asks, states } };
}

/** The status entry: set only while something needs the person, else `undefined` to clear it. */
export function statusFor(inbox: HomeDispatchInbox): string | undefined {
  const waiting = needsYouItems(inbox);
  const first = waiting[0];
  if (!first) return undefined;
  return waiting.length === 1
    ? `${MISSION_CONTROL_MARK} ${short(first.title)} needs you`
    : `${MISSION_CONTROL_MARK} ${waiting.length} tasks need you`;
}

/**
 * The band above the prompt, with its `1` button (which opens the pane on Needs you). `error`
 * tone while any item is blocked, otherwise `warning`. `undefined` while nothing waits.
 */
export function bandFor(inbox: HomeDispatchInbox): ModBand | undefined {
  const waiting = needsYouItems(inbox);
  if (waiting.length === 0) return undefined;
  const blocked = waiting.some((item) => item.state === "blocked");
  const noun = waiting.length === 1 ? "task needs" : "tasks need";
  return {
    text: `${MISSION_CONTROL_MARK} ${waiting.length} ${noun} you`,
    tone: blocked ? "error" : "warning",
    button: { label: "1 Open Needs you", hotkey: "1" },
  };
}
