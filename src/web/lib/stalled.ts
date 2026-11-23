import type { Session } from "@shared/types.ts";
import { parkedMissingStep } from "./stall-actions.ts";
import { isIdleStall, type Stall } from "@shared/stall.ts";
import { stallDismissalKey } from "./attention.ts";

/**
 * Idle's Stalled section (`idle-stalled` flag): which sessions it draws, and which stalls the
 * inbox keeps.
 *
 * The two answers are one decision split in two, which is why they live together. A stall is
 * drawn in exactly one place: an idle stall (`isIdleStall`) on its card in Idle while the flag is
 * on, every other stall as the inbox's Stuck row. A helper for each side that read the flag on its
 * own would be one refactor away from a stall drawn twice, or not at all.
 */

/** No stalled sessions: the shared empty answer, so "none" is one stable reference. */
export const NO_STALLED_SESSIONS: ReadonlyMap<string, Stall> = new Map();

/** No session drawn under the Stalled rule, for the same reason. */
export const NO_STALLED_DRAWN: ReadonlySet<string> = new Set();

/**
 * The stalls Idle's Stalled section draws, by session id. Empty with the flag off, and leaves out
 * a stall the operator dismissed: dismissing a Stalled card returns it to free or held until the
 * stall's facts change, exactly as dismissing a Stuck row hides it until then.
 *
 * `dismissed` null means the dismissals have not been read yet, and is read as "nothing
 * dismissed": a card drawn for a moment and then returned to its old place is the honest failure,
 * where hiding every stall until a read lands would hide the ones nobody dismissed.
 */
export function stalledSessions(
  stalls: readonly Stall[] | undefined,
  enabled: boolean,
  dismissed: ReadonlyMap<string, string> | null,
): ReadonlyMap<string, Stall> {
  if (!enabled || !stalls || stalls.length === 0) return NO_STALLED_SESSIONS;
  const out = new Map<string, Stall>();
  for (const stall of stalls) {
    if (!isIdleStall(stall)) continue;
    const key = stallDismissalKey(stall.sessionId, stall);
    if (dismissed?.get(key.itemId) === key.occurrence) continue;
    out.set(stall.sessionId, stall);
  }
  return out.size > 0 ? out : NO_STALLED_SESSIONS;
}

/**
 * The stalls the inbox folds into Stuck rows: every stall except the ones Idle's Stalled section
 * actually draws (`drawn`, the members of the idle group's stalled span: `stalledInOrder`).
 *
 * Keyed on what the fleet ordering DREW rather than on the stall's kind. A pinned resident's stall
 * is drawn (a stall outranks the pin, `orderSessions`), but a resident placed in the residents
 * drawer is not on the fleet at all, so it has an idle stall and no Stalled card: it keeps its
 * Stuck row, where a rule that dropped every idle-kind stall would leave it shown nowhere. With
 * the flag off `drawn` is empty and every stall stays.
 *
 * Returns the input unchanged when nothing is removed, so the inbox's fold sees the same
 * reference it did before this existed.
 */
export function inboxStalls(stalls: readonly Stall[], drawn: ReadonlySet<string>): readonly Stall[] {
  if (drawn.size === 0 || !stalls.some((stall) => drawn.has(stall.sessionId))) return stalls;
  return stalls.filter((stall) => !drawn.has(stall.sessionId));
}

/** Longest stalled first, then the session id, so the section reads as a queue of the oldest. */
export function byStalledLongest(stalls: ReadonlyMap<string, Stall>) {
  return (a: { id: string }, b: { id: string }): number =>
    (stalls.get(b.id)?.forMs ?? 0) - (stalls.get(a.id)?.forMs ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The board prints all the facts. The rail has room for the first. */
export function stalledFactRows(session: Session, stall: Stall) {
  const facts = stall.facts;
  const note = session.note?.brief || session.note?.lastAction || null;

  const rows: { label: string; value: string; detail?: string; tone?: "muted" | "warn" | "quote" }[] = [];
  if (facts?.kind === "unfinished-work") {
    if (facts.task) {
      const status = session.task?.id === facts.task.id ? session.task.status : undefined;
      rows.push({ label: "Task", value: facts.task.title, detail: status === "running" ? "in progress" : status });
    }
    if (facts.queueOpen > 0) {
      rows.push({ label: "Queue", value: facts.queueOpen === 1 ? "1 open item" : `${facts.queueOpen} open items` });
    }
  } else if (facts?.kind === "workflow-parked") {
    rows.push({
      label: "Waiting",
      value: facts.status === "waiting_for_new_head"
        ? `${facts.workflowName} round ${facts.round} needs a pushed head`
        : `${facts.workflowName} round ${facts.round} never reopened`,
    });
    const missing = facts.status === "waiting_for_new_head" && facts.unpushedCommits > 0
      ? `${facts.unpushedCommits} ${facts.unpushedCommits === 1 ? "commit" : "commits"} not pushed`
      : parkedMissingStep(facts);
    rows.push({ label: "Missing", value: missing, tone: "warn" });
  } else {
    // A stall from a daemon that predates facts: its sentence is all there is to say.
    rows.push({ label: "Why", value: stall.reason });
  }
  rows.push({ label: "Last", value: session.activity ?? "No activity reported", tone: "muted" });
  if (note) rows.push({ label: "Foreman", value: note, tone: "quote" });

  return rows;
}
