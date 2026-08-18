import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.ts";
import type { WorktreeOwnerReference } from "./manager.ts";

function taskOwner(key: string): { taskId: string; position: number } | null {
  const split = key.lastIndexOf(":");
  if (split <= 0) return null;
  const position = Number(key.slice(split + 1));
  if (!Number.isSafeInteger(position) || position < 0) return null;
  return { taskId: key.slice(0, split), position };
}

/**
 * The durable domain half of native slot ownership. Slot rows decide allocation; these rows
 * decide whether task/check/manual work still exists and therefore whether a released slot
 * may be reused after a crash before its consumer cleared the lease ID.
 */
export function nativeWorktreeOwnerReferenced(
  reference: WorktreeOwnerReference,
  db: DatabaseSync = openDb(),
): boolean {
  switch (reference.owner.kind) {
    case "task": {
      const owner = taskOwner(reference.owner.key);
      if (!owner) return false;
      if (owner.position === 0) {
        return db
          .prepare(
            `SELECT 1 FROM tasks
              WHERE id = ? AND provider = 'mission' AND worktree_lease_id = ?
              LIMIT 1`,
          )
          .get(owner.taskId, reference.leaseId) !== undefined;
      }
      return db
        .prepare(
          `SELECT 1 FROM task_repos
            WHERE task_id = ? AND position = ? AND provider = 'mission'
              AND worktree_lease_id = ?
            LIMIT 1`,
        )
        .get(owner.taskId, owner.position - 1, reference.leaseId) !== undefined;
    }
    case "check":
      return db
        .prepare(
          `SELECT 1 FROM workflow_check_leases
            WHERE attempt_id = ? AND provider = 'mission' AND lease_id = ?
              AND cleanup_state IN ('held', 'returning')
            LIMIT 1`,
        )
        .get(reference.owner.key, reference.leaseId) !== undefined;
    case "manual":
      // A manual lease has no second domain row by design. Its durable slot owner is its
      // complete lifetime record and must survive daemon restart until an explicit return.
      return db
        .prepare(
          `SELECT 1 FROM worktree_slots
            WHERE id = ? AND active_lease_id = ?
              AND active_owner_kind = 'manual' AND active_owner_key = ?
            LIMIT 1`,
        )
        .get(reference.slotId, reference.leaseId, reference.owner.key) !== undefined;
  }
}
