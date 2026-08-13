import { basename } from "node:path";
import { scoutRepoSlot } from "@shared/scouts.ts";
import type { Task } from "@shared/types.ts";

/**
 * The generated repository slots one scout task works across.
 *
 * A slot is the ONLY name a scout may use for a checkout. The alternative - letting a
 * submission carry a path and working out which tree it belongs to - is the same mistake as
 * letting it carry an archive id: the agent would be choosing what the daemon reads, and an
 * absolute path is precisely the input capture must never accept. So the task's repository
 * manifest issues `repo-01`, `repo-02`, the prompt tells the agent which is which, and a
 * locator is a slot plus a path relative to the checkout that slot names.
 *
 * Shared by the prompt appendix and the capture path deliberately: they must agree about
 * which tree `repo-02` is, and two orderings of the same list is exactly how an agent's
 * evidence ends up read out of the wrong checkout. The order is PRIMARY FIRST, then
 * `extraRepos` in its stored `position` order, which is the order `intentWithRepoManifest`
 * already presents them in.
 */
export interface ScoutRepoSlot {
  slot: string;
  /** A human name for the repository. Informational; never an identity. */
  label: string | null;
  /**
   * The checkout on THIS machine, or null when the task holds none.
   *
   * Null is ordinary rather than exceptional: a backlog task has no worktree yet, and an
   * ASSIGNED scout never gets one - it runs in the checkout the operator's own agent was
   * already standing in, which is why `fallbackRoot` exists.
   */
  root: string | null;
  /** The commit the task's branch was cut at, when it is known. Informational. */
  head: string | null;
  primary: boolean;
}

/**
 * Slot every repository this task can produce evidence from.
 *
 * `fallbackRoot` is the session's own cwd, used for the primary slot when the task holds no
 * worktree of its own. That is the assigned-scout case: `TaskManager.assign` refuses a
 * multi-repo task, so an assignment always resolves to exactly one slot, and using the live
 * session's checkout is the only reading that can be true there.
 */
export function scoutRepoSlots(task: Task, fallbackRoot: string | null = null): ScoutRepoSlot[] {
  const slots: ScoutRepoSlot[] = [
    {
      slot: scoutRepoSlot(1),
      label: repoLabel(task.repoRoot),
      root: task.worktreePath ?? fallbackRoot,
      head: task.baseSha,
      primary: true,
    },
  ];
  task.extraRepos.forEach((entry, index) => {
    slots.push({
      slot: scoutRepoSlot(index + 2),
      label: repoLabel(entry.repoRoot),
      root: entry.worktreePath,
      head: entry.baseSha ?? null,
      primary: false,
    });
  });
  return slots;
}

/** The slot a locator names, or null when the task never issued it. */
export function findScoutRepoSlot(slots: readonly ScoutRepoSlot[], slot: string): ScoutRepoSlot | null {
  return slots.find((entry) => entry.slot === slot) ?? null;
}

function repoLabel(repoRoot: string): string | null {
  const name = basename(repoRoot).trim();
  return name === "" ? null : name;
}
