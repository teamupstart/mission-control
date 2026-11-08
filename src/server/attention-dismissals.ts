import type { AttentionDismissal, AttentionDismissalWrite } from "@shared/protocol.ts";
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
 * NEVER EXPIRED AND NEVER PRUNED. A dismissal lasts until its row reports something new, which
 * is the only thing that brings a dismissed row back. Dropping one by age or by count would
 * bring back an item that has reported nothing new - the very thing a dismissal promises not to
 * do. The table grows by one small row per inbox row the operator ever dismissed, and a row
 * dismissed again is rewritten in place of the old one, never added beside it.
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
 * left half dismissed - and the stale keys are named. A row with no stored dismissal accepts any
 * basis.
 *
 * Accepted keys are rewritten rather than updated in place, which is what takes a fresh
 * AUTOINCREMENT revision. One transaction, so a reader never sees a batch half applied.
 */
export function dismissAttentionItems(
  items: readonly AttentionDismissalWrite[],
  now: number,
): AttentionDismissalWriteResult {
  const d = openDb();
  const current = d.prepare("SELECT revision FROM attention_dismissals WHERE item_id = ?");
  const remove = d.prepare("DELETE FROM attention_dismissals WHERE item_id = ?");
  const insert = d.prepare(
    `INSERT INTO attention_dismissals (item_id, occurrence, dismissed_at) VALUES (?, ?, ?)`,
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
