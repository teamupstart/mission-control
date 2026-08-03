import type { BacklogBlocker } from "@shared/backlog.ts";
import { PRIORITY_LABELS, priorityRank } from "@shared/task.ts";
import type { ForemanStatus, Task } from "@shared/types.ts";
import { relativeTime } from "./format.ts";

/**
 * How a blocked backlog item's state is SAID, in one place.
 *
 * `src/shared/backlog.ts` decides what blocks what; this decides what a reader is told about
 * it. The two halves are separate because only one of them is a wire contract - but the copy
 * half needs a single owner just as badly, and for the same reason the predicates do. The
 * backlog is drawn on the board column, in the Sitrep, and now in the Line's Backlog drawer,
 * and a task that reads `after Persist verdicts` on one surface and `blocked` on the next is
 * two facts as far as anybody reading them is concerned.
 *
 * Browser-side rather than in `@shared/`: the daemon never renders a sentence about a
 * blocker, and a wire module is not the place to keep words that only a component says.
 */

/**
 * One line naming what an item is waiting on. Two by name, then a count, because the
 * chip has to stay a chip - and the full list is in the shared tooltip either way.
 *
 * The two "this will never clear on its own" states lead, and they lead in that order
 * because they ask for different things: a dependency that failed needs looking at,
 * while a disabled one needs one click on a toggle somebody already knows they turned
 * off. Both beat "after X", which promises a queue that is not moving.
 */
export function blockedLabel(blockers: BacklogBlocker[]): string {
  const stopped = blockers.filter((b) => b.state === "stopped");
  // A dependency that was cancelled or failed will never clear on its own, so it is a
  // different message from "wait your turn" - it is the one that needs you.
  if (stopped.length > 0) return `needs you - ${stopped[0]!.title} didn't finish`;
  const off = blockers.filter((b) => b.state === "disabled");
  if (off.length > 0) return `${off[0]!.title} is disabled`;
  if (blockers.length === 1) return `after ${blockers[0]!.title}`;
  return `after ${blockers[0]!.title} +${blockers.length - 1}`;
}

/**
 * True while a blocker means "nothing will move this until you act".
 *
 * The tone predicate behind the sentence above, and the reason both live together: a surface
 * that toned a row from its own reading of the blockers could go amber on a row whose words
 * say "after X", which is the queue working exactly as intended.
 */
export function blockersNeedYou(blockers: BacklogBlocker[]): boolean {
  return blockers.some((b) => b.state === "stopped" || b.state === "disabled");
}

/**
 * One computed line in the planner's "why this one" list.
 *
 * `yes` is a fact that put this task at the front - drawn with a tick. `soft` is a
 * consequence of taking it rather than a reason for it (what finishes downstream), and is
 * drawn quietly, because a bullet list where everything looks like evidence stops being
 * read as evidence.
 */
export interface PlannerFact {
  tone: "yes" | "soft";
  text: string;
}

/**
 * Why the head of the ready band is the head of the ready band, in facts a reader can
 * check against the rows underneath.
 *
 * These are deliberately NOT a justification of Foreman's ordering. The plan decides the
 * order (`readyBacklog` walks the plan first), and the plan's own `reason` is quoted
 * beside these in the planner - so what these lines owe the reader is the DATA the plan
 * was made from, stated honestly enough to disagree with it. That is why the priority
 * line reports how many ready items outrank this one rather than asserting it is the most
 * important: on a planned backlog, "first" and "highest priority" are routinely different
 * tasks, and a panel that only ever printed the flattering half would be the reason
 * somebody stopped trusting the plan.
 *
 * Pure, and given everything it needs: the drawer already holds the ordered ready band and
 * the backlog index `dependentsIn` reads, so nothing here re-derives what it just computed
 * - which is also what stops this file from having a second opinion about either.
 */
export function plannerFacts({
  task,
  ready,
  unblocks,
  now,
}: {
  task: Task;
  /** The whole ready band, in the order autopilot would take it. Includes `task`. */
  ready: Task[];
  /** What this task's completion releases (`dependentsIn`). */
  unblocks: Task[];
  now: number;
}): PlannerFact[] {
  const facts: PlannerFact[] = [];
  const band = `the ${ready.length} ready`;
  // With one ready item there is nothing to compare it against, and every comparative
  // clause below degenerates into a joke at the panel's expense: "the oldest of the 1
  // ready" is a superlative over a set of one. State the facts and stop.
  const alone = ready.length <= 1;

  // Unset ranks between `low` and `med` (see `priorityRank`), so "outranks" here is the
  // same comparison the board's own sort makes rather than a second reading of it.
  const rank = priorityRank(task.priority);
  const higher = ready.filter((t) => priorityRank(t.priority) > rank).length;
  // Lowercased: `PRIORITY_LABELS` is written for a chip, where the word stands alone, and
  // these lines are prose. "Blocker priority - nothing ready outranks it" reads as a
  // proper noun that has wandered in from the picker.
  const stated = task.priority
    ? `${PRIORITY_LABELS[task.priority].toLowerCase()} priority`
    : "no priority set";
  facts.push({
    tone: "yes",
    text: alone
      ? stated
      : higher === 0
        ? `${stated} - nothing ready outranks it`
        : `${stated} - ${higher} of ${band} rank${higher === 1 ? "s" : ""} higher`,
  });

  // Age is the tiebreak below priority in every ordering this app has, so it is worth a
  // line whether or not this task wins it.
  const older = ready.filter((t) => t.createdAt < task.createdAt).length;
  const filed = `filed ${relativeTime(task.createdAt, now)}`;
  facts.push({
    tone: "yes",
    text: !alone && older === 0 ? `${filed} - the oldest of ${band}` : filed,
  });

  // True by construction - `readyBacklog` filters on exactly this - and said anyway,
  // because it is the condition the whole band is selected by and the one a reader is
  // most likely to be checking when they open this popover at all.
  facts.push({ tone: "yes", text: "no blockers - nothing upstream is holding it" });

  if (unblocks.length > 0) {
    const first = unblocks[0]!.title;
    facts.push({
      tone: "soft",
      text:
        unblocks.length === 1
          ? `unblocks 1 task: ${first}`
          : `unblocks ${unblocks.length} tasks: ${first} +${unblocks.length - 1}`,
    });
  }
  return facts;
}

/**
 * The autopilot's own state, as the drawer's footer says it.
 *
 * Three facts and no more: is it armed, how much of the agent budget is spent, and what
 * that combination means for the queue above. The ready/blocked/parked split is
 * deliberately NOT repeated here even though `status.autopilot` carries it - the drawer's
 * header counts exactly those three numbers, forty pixels up the same panel, in the
 * drawer's own vocabulary ("parked", where the status object says "disabled"). One fact
 * printed twice in two dialects is how a panel teaches people to stop reading it.
 *
 * `launches` is the gate the machine actually applies (`cfg.enabled && mode === "live"`,
 * `worker.ts`). An armed autopilot behind either half of that gate takes nothing, so a
 * footer that read a plain "on" would be the one sentence sending somebody to hunt for
 * why nothing is being picked up. The wording names the gate rather than which half of it
 * is shut, because the fix is the same and it is one click away in the same panel family.
 */
export function autopilotReadout({
  on,
  status,
  launches,
}: {
  /** `ForemanConfig.autoBacklog`, read optimistically so the switch and the words agree. */
  on: boolean;
  /** The daemon's derived counts, or null before the first poll answers. */
  status: ForemanStatus["autopilot"] | null;
  /** False while Foreman is off or not in live mode: it orders the queue, nothing more. */
  launches: boolean;
}): string {
  if (!on) return "Autopilot off - nothing starts unless you start it";
  const agents = status ? ` · ${status.active}/${status.max} agents` : "";
  if (!launches) return `Autopilot on${agents} · nothing launches until Foreman is live`;
  if (!status) return "Autopilot on";
  if (status.ready === 0) return `Autopilot on${agents} · nothing ready to take`;
  if (status.active >= status.max) return `Autopilot on${agents} · full, waiting for one to free up`;
  return `Autopilot on${agents} · takes the top row on its own`;
}
