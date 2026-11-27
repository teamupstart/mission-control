import { isTerminalTask } from "@shared/task-status.ts";
import type { Task } from "@shared/types.ts";
import { chooseAutoCallSign, type CallSignClaim } from "@shared/voice-call-signs.ts";
import { taskKindTakesCallSign, taskSpokenNameKey, type SpokenName } from "@shared/voice-names.ts";

// Automatic call signs: which names are already spoken for, read from the daemon's roster and
// its task catalog, and the one name a launching task takes from what is left.
//
// Safe for simultaneous dispatches because it never waits: the dispatcher asks it inside the
// synchronous claim that writes the task's `dispatching` row (`Dispatcher.dispatch`), so the
// next launch, even one already queued behind it, reads a catalog that holds the name.

/**
 * Every name a task launching now must not be heard as, without the task's own.
 *
 * - The voice roster: each resident's spoken name, and each launched task's call sign while it is
 *   running, hibernated, or within its day after stopping. A finished task's entry is the one
 *   kind another agent may take (`CallSignClaim.displaceable`).
 * - Every task that is not finished and holds a call sign, whatever its status. A launch that has
 *   not yet reached a session is not on the roster, and a backlog task's chosen name will be when
 *   it launches; both hold their names outright.
 */
export function callSignClaims(task: Pick<Task, "id">, roster: readonly SpokenName[], tasks: readonly Task[]): CallSignClaim[] {
  const own = taskSpokenNameKey(task.id);
  const claims: CallSignClaim[] = [];
  const held = new Set<string>();
  for (const other of tasks) {
    if (other.id === task.id || !other.callSign || isTerminalTask(other.status) || !taskKindTakesCallSign(other.kind)) continue;
    claims.push({ name: other.callSign, displaceable: false });
    held.add(taskSpokenNameKey(other.id));
  }
  for (const entry of roster) {
    if (entry.key === own || held.has(entry.key)) continue;
    claims.push({
      name: entry.name,
      ...(entry.isReferenceName ? { isReferenceName: true as const } : {}),
      // An unfinished task's entry was skipped above, so a session left here has finished.
      displaceable: entry.kind === "session" && entry.state === "not-running",
    });
  }
  return claims;
}

/**
 * The call sign to store on `task` as it launches, or null to leave it as it is: it already has
 * one (an operator's own, or the one an earlier launch gave it), its kind takes none, or every
 * safe name is spoken for (see `chooseAutoCallSign` for the order).
 */
export function allocateCallSign(task: Task, roster: readonly SpokenName[], tasks: readonly Task[]): string | null {
  if (task.callSign || !taskKindTakesCallSign(task.kind)) return null;
  const name = chooseAutoCallSign(callSignClaims(task, roster, tasks), task.id);
  if (name === null) {
    console.info(`[voice] no distinctive call sign is free for task ${task.id}; it launches without one`);
  }
  return name;
}
