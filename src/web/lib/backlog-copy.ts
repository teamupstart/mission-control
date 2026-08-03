import type { BacklogBlocker } from "@shared/backlog.ts";

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
