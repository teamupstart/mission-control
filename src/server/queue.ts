import { randomUUID } from "node:crypto";
import type { SessionQueue, WorkItem } from "@shared/types.ts";
import type { SetWorkItemState } from "@shared/protocol.ts";
import { isTerminalItem } from "./registry.ts";
import type { Registry } from "./registry.ts";
import { nextQueueSeq } from "./db.ts";

/**
 * Owns the session work-queue lifecycle: the batch of work you load up for one
 * agent to do next, one item at a time, in the order you authored. The registry
 * is the single store; this is the policy layer routes call into - the queue
 * analog of ReviewManager.
 *
 * Deliberately NOT built on SessionNote. There is one note per key with one
 * `disposition`, and `putNote` is a patch-merge, so a triage write would clobber
 * the queue's brief and a queue write would skew foremanStatus's disposition
 * tallies. The note is triage's audit record for a *prompt episode*; an item's
 * lifecycle is not one.
 */
export class QueueManager {
  constructor(private registry: Registry) {}

  /** A session's full queue (items + wrap-up state), or null when it has none. */
  get(sessionId: string): SessionQueue | null {
    return this.registry.getQueue(sessionId);
  }

  getByKey(key: string): SessionQueue | null {
    return this.registry.getQueueByKey(key);
  }

  /** Every stored queue - backs the orphan sweep and the fleet-level list. */
  list(): SessionQueue[] {
    return this.registry.listQueues();
  }

  /** Queues whose note key matches no live session: nothing drives their tick. */
  orphaned(): SessionQueue[] {
    const live = this.registry.liveNoteKeys();
    return this.registry.listQueues().filter((q) => !live.has(q.noteKey));
  }

  /**
   * Append an item to a session's queue.
   *
   * Adding to a DRAINED queue re-arms the wrap-up ask: `wrapup_asked_at` fires the
   * ask once, but a queue that drains, gets three more items, and drains again
   * deserves to be asked again - the question ("ship this?") is about the *new*
   * work. Without this the second drain is silent and the human waits forever.
   */
  add(sessionId: string, intent: string, now = Date.now()): WorkItem | null {
    const key = this.registry.ensureQueue(sessionId, now);
    if (!key) return null;
    const item: WorkItem = {
      id: randomUUID(),
      noteKey: key,
      seq: nextQueueSeq(key),
      intent,
      state: "queued",
      round: 0,
      baseSha: null,
      transcriptAnchor: null,
      gaps: [],
      sendAttempts: 0,
      verifyFailures: 0,
      escalationReason: null,
      lastVerdict: null,
      approvedAt: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      completedAt: null,
    };
    this.registry.putQueueItem(item);
    this.registry.setQueueWrapup(key, { wrapupAskedAt: null, wrapupAnswer: null }, now);
    return item;
  }

  /**
   * Edit a waiting item's intent. Fails (409) unless the item is still
   * `queued`/`proposed` AND the caller's `revision` matches: without the CAS the
   * UI would happily let someone edit an item Foreman has already typed into a
   * pane. Bumps `revision`, which also invalidates any in-flight send guard.
   */
  edit(
    itemId: string,
    intent: string,
    revision: number,
    now = Date.now(),
  ): { ok: true; item: WorkItem } | { ok: false; error: string } {
    const item = this.registry.getQueueItem(itemId);
    if (!item) return { ok: false, error: "no such item" };
    if (item.state !== "queued" && item.state !== "proposed") {
      return { ok: false, error: `cannot edit an item that is ${item.state}` };
    }
    if (item.revision !== revision) {
      return { ok: false, error: "this item changed since you loaded it" };
    }
    // Editing a proposed item invalidates the human's earlier approval: they
    // approved the OLD text. Clearing approvedAt sends it back for a fresh one.
    const next: WorkItem = {
      ...item,
      intent,
      approvedAt: null,
      revision: item.revision + 1,
      updatedAt: now,
    };
    this.registry.putQueueItem(next);
    return { ok: true, item: next };
  }

  /**
   * Remove a waiting item, or cancel one already terminal. An in-flight item is
   * refused: it has already been typed into a pane, so "remove" would be a lie -
   * the agent is working on it right now.
   */
  remove(itemId: string, now = Date.now()): { ok: boolean; error?: string } {
    const item = this.registry.getQueueItem(itemId);
    if (!item) return { ok: false, error: "no such item" };
    if (item.state === "queued" || item.state === "proposed") {
      this.registry.removeQueueItem(itemId);
      return { ok: true };
    }
    if (isTerminalItem(item.state)) {
      this.registry.removeQueueItem(itemId);
      return { ok: true };
    }
    return { ok: false, error: `cannot remove an item that is ${item.state}` };
  }

  /** Reorder a queue to the given id order (whole-list renumber, in a txn). */
  reorder(sessionId: string, ids: string[], now = Date.now()): { ok: boolean; error?: string } {
    const queue = this.registry.getQueue(sessionId);
    if (!queue) return { ok: false, error: "no queue for this session" };
    const known = new Set(queue.items.map((i) => i.id));
    for (const id of ids) {
      if (!known.has(id)) return { ok: false, error: `unknown item ${id}` };
    }
    this.registry.reorderQueue(queue.noteKey, ids, now);
    return { ok: true };
  }

  /**
   * Clear a `proposed` item for send (the dry-run path). Records consent; it does
   * NOT bypass the send guard - the human's "yes" arrives minutes after the draft
   * was made, so the worker still re-runs the full staleness check before typing.
   *
   * Each dry-run fix round needs its own approval: the drafted prompt changes
   * every round (new gaps), so a blanket approval would be consent to text the
   * human never read.
   */
  approve(itemId: string, now = Date.now()): { ok: boolean; error?: string } {
    const item = this.registry.getQueueItem(itemId);
    if (!item) return { ok: false, error: "no such item" };
    if (item.state !== "proposed") {
      return { ok: false, error: `only a proposed item can be approved (this is ${item.state})` };
    }
    this.registry.putQueueItem({ ...item, approvedAt: now, updatedAt: now });
    return { ok: true };
  }

  /**
   * The worker's durable state write. Every transition the pure machine decides
   * lands through here, so the daemon stays the only writer of the DB.
   *
   * `sentAt` is stamped HERE (server-side) rather than by the worker, because the
   * pickup guard compares it against `lastActivity`, which the registry stamps
   * from the hook payload. Both must share a clock; pinning them to the same
   * writer keeps that true by construction rather than by coincidence.
   */
  setState(
    itemId: string,
    patch: SetWorkItemState,
    now = Date.now(),
  ): { ok: true; item: WorkItem } | { ok: false; error: string } {
    const item = this.registry.getQueueItem(itemId);
    if (!item) return { ok: false, error: "no such item" };
    const state = patch.state ?? item.state;
    const next: WorkItem = {
      ...item,
      state,
      round: patch.round ?? item.round,
      baseSha: patch.baseSha !== undefined ? patch.baseSha : item.baseSha,
      transcriptAnchor:
        patch.transcriptAnchor !== undefined ? patch.transcriptAnchor : item.transcriptAnchor,
      gaps: patch.gaps ?? item.gaps,
      sendAttempts: patch.sendAttempts ?? item.sendAttempts,
      verifyFailures: patch.verifyFailures ?? item.verifyFailures,
      escalationReason:
        patch.escalationReason !== undefined ? patch.escalationReason : item.escalationReason,
      lastVerdict: patch.lastVerdict !== undefined ? patch.lastVerdict : item.lastVerdict,
      updatedAt: now,
      completedAt: isTerminalItem(state) ? item.completedAt ?? now : null,
    };
    this.registry.putQueueItem(next);
    return { ok: true, item: next };
  }

  /** Stamp delivery: the item is out, with the diff + transcript scope it was sent at. */
  markSent(
    itemId: string,
    baseSha: string | null,
    transcriptAnchor: number | null,
    now = Date.now(),
  ): { ok: true; item: WorkItem } | { ok: false; error: string } {
    const item = this.registry.getQueueItem(itemId);
    if (!item) return { ok: false, error: "no such item" };
    const next: WorkItem = {
      ...item,
      state: "awaiting_pickup",
      baseSha,
      transcriptAnchor,
      sentAt: now,
      approvedAt: null, // consent is spent; a later round needs a fresh one
      updatedAt: now,
    };
    this.registry.putQueueItem(next);
    return { ok: true, item: next };
  }

  /** Record that the drain-time wrap-up was asked (it fires exactly once). */
  markWrapupAsked(key: string, now = Date.now()): void {
    this.registry.setQueueWrapup(key, { wrapupAskedAt: now }, now);
  }

  setWrapupAnswer(key: string, answer: string | null, now = Date.now()): void {
    this.registry.setQueueWrapup(key, { wrapupAnswer: answer }, now);
  }

  /** Re-key an orphaned queue onto a live session (the explicit re-attach). */
  reattach(fromKey: string, sessionId: string, now = Date.now()): { ok: boolean; error?: string } {
    const done = this.registry.reattachQueue(fromKey, sessionId, now);
    return done ? { ok: true } : { ok: false, error: "could not re-attach that queue" };
  }
}
