import {
  ATTENTION_DISMISSAL_RETENTION_MS,
  type AttentionDismissal,
  type AttentionDismissalWrite,
} from "@shared/protocol.ts";
import { inTransaction, openDb } from "./db.ts";

/**
 * Attention-inbox rows the operator dismissed without resolving them.
 *
 * The daemon stores the decision and nothing else. Which rows exist, and what each one's
 * `occurrence` fingerprint is, stays the fold's call (`src/web/lib/attention.ts`): the fold is
 * the one place that decides what is owed, and a daemon-side copy of it would be a second
 * opinion. This module only remembers "the operator dismissed row X while it said Y", so a
 * reload, a second window, or a restart does not bring it back.
 *
 * Kept in the daemon rather than `localStorage` for the reason `uiCache.ts` gives: browser
 * storage is keyed by origin and Electron profile, both of which have moved before, and a
 * dismissal that silently resets is exactly the "it popped back up" this exists to stop.
 *
 * NEVER PRUNED BY COUNT. Dropping the oldest dismissal once some number accumulated would bring
 * back an item that is still unresolved and has reported nothing new - the very thing a
 * dismissal promises not to do. A dismissal leaves only through `recordAttentionSightings`:
 * after dashboards have reported its row absent from the inbox, continuously, for
 * `ATTENTION_DISMISSAL_RETENTION_MS`. So the table holds what is still hidden plus about a week
 * of resolved rows, and is bounded by the operator's open obligations rather than by a number.
 *
 * NEVER OVERWRITTEN BY AN OLDER DECISION. Each write carries the newest revision of its row the
 * dismissing window had seen; a write behind the stored revision is refused whole
 * (`dismissAttentionItems`). That is what orders dismissals made in different windows, where no
 * client-side queue can reach.
 */

interface Row {
  revision: number;
  item_id: string;
  occurrence: string;
  dismissed_at: number;
}

/** Every stored dismissal, newest first. */
export function listAttentionDismissals(): AttentionDismissal[] {
  const rows = openDb()
    .prepare(
      `SELECT revision, item_id, occurrence, dismissed_at FROM attention_dismissals
        ORDER BY revision DESC`,
    )
    .all() as unknown as Row[];
  return rows.map((row) => ({
    itemId: row.item_id,
    occurrence: row.occurrence,
    dismissedAt: Number(row.dismissed_at),
    revision: Number(row.revision),
  }));
}

/** What a dismissal write did: every key stored at a fresh revision, or nothing at all. */
export type AttentionDismissalWriteResult =
  | { stored: true; accepted: { itemId: string; revision: number }[] }
  | { stored: false; superseded: string[] };

/**
 * Record a dismissal for each key, unless any of them is stale.
 *
 * A key is stale when its row is stored at a revision newer than the key's `basis`: a dismissal
 * the sending window never saw was made since, by another window or by an earlier write from
 * this one the window had not heard back about. The newer dismissal is the operator's latest
 * word on the row, so the write is refused - all of it, so a row of several questions is never
 * left half dismissed - and the stale keys are named. A row with no stored dismissal, including
 * one retired since, accepts any basis.
 *
 * Accepted keys are rewritten rather than updated in place, which is what takes a fresh
 * AUTOINCREMENT revision, and a fresh dismissal starts with its absence clock cleared. One
 * transaction, so a reader never sees a batch half applied.
 */
export function dismissAttentionItems(
  items: readonly AttentionDismissalWrite[],
  now: number,
): AttentionDismissalWriteResult {
  const d = openDb();
  const current = d.prepare("SELECT revision FROM attention_dismissals WHERE item_id = ?");
  const remove = d.prepare("DELETE FROM attention_dismissals WHERE item_id = ?");
  const insert = d.prepare(
    `INSERT INTO attention_dismissals (item_id, occurrence, dismissed_at, absent_since)
       VALUES (?, ?, ?, NULL)`,
  );
  return inTransaction((): AttentionDismissalWriteResult => {
    const superseded = items
      .filter((item) => {
        const row = current.get(item.itemId) as { revision: number } | undefined;
        return row !== undefined && Number(row.revision) > item.basis;
      })
      .map((item) => item.itemId);
    if (superseded.length > 0) return { stored: false, superseded };
    const accepted = items.map((item) => {
      remove.run(item.itemId);
      const written = insert.run(item.itemId, item.occurrence, now);
      return { itemId: item.itemId, revision: Number(written.lastInsertRowid) };
    });
    return { stored: true, accepted };
  });
}

/**
 * Apply one dashboard's report of which dismissals its inbox is hiding right now, and retire
 * the ones whose rows have been gone for the whole retention window.
 *
 * `hiding` is every item id the fold's filter actually applied. A dismissal listed there is
 * still doing its job: its absence clock is cleared, whatever it said before. One NOT listed
 * had no row to hide in that fold - resolved, or reporting something new - and its clock
 * starts if it was not already running. Only a clock that has run for
 * `ATTENTION_DISMISSAL_RETENTION_MS` deletes the row.
 *
 * Which is what makes a wrong "absent" harmless. A row missing from one fold - a session not
 * adopted yet after a restart, a window holding a set read just before another window
 * dismissed something - is seen again by the next report and its clock is cleared; nothing is
 * deleted on the strength of a single sighting, because the clock must have started at least
 * a full window before the report that deletes it.
 *
 * Returns how many dismissals were retired, so the route announces only a real change.
 */
export function recordAttentionSightings(hiding: readonly string[], now: number): number {
  const d = openDb();
  const seen = new Set(hiding);
  const clear = d.prepare("UPDATE attention_dismissals SET absent_since = NULL WHERE item_id = ?");
  const start = d.prepare("UPDATE attention_dismissals SET absent_since = ? WHERE item_id = ?");
  const retire = d.prepare(
    "DELETE FROM attention_dismissals WHERE absent_since IS NOT NULL AND absent_since <= ?",
  );
  return inTransaction(() => {
    const rows = d
      .prepare("SELECT item_id, absent_since FROM attention_dismissals")
      .all() as unknown as { item_id: string; absent_since: number | null }[];
    for (const row of rows) {
      if (seen.has(row.item_id)) {
        if (row.absent_since !== null) clear.run(row.item_id);
      } else if (row.absent_since === null) {
        start.run(now, row.item_id);
      }
    }
    return Number(retire.run(now - ATTENTION_DISMISSAL_RETENTION_MS).changes);
  });
}
