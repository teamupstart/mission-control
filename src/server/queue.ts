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

  /** One item by id - what the routes check ownership against before writing. */
  getItem(itemId: string): WorkItem | undefined {
    return this.registry.getQueueItem(itemId);
  }

  /** Every stored queue - backs the orphan sweep and the cross-session list. */
  list(): SessionQueue[] {
    return this.registry.listQueues();
  }

  /**
   * Queues whose note key matches no live session: nothing drives their tick.
   *
   * The caller escalates what it finds here, terminally, so this answers only from
   * POSITIVE evidence: until a discovery sweep has actually reconciled the session
   * map against the OS, "no live session holds this key" is a statement about an
   * empty map rather than about the sessions. The daemon answers this route from the
   * moment it binds its port, and the worker polls it several times a second, so
   * that window is reached on every single restart - and without this guard it
   * escalates the in-flight item of every healthy session across the sessions.
   */
  orphaned(): SessionQueue[] {
    if (!this.registry.sessionsObserved()) return [];
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
      proposedPayload: null,
      recoveredAt: null,
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
    // approved the OLD text. Clearing approvedAt sends it back for a fresh one,
    // and dropping the drafted payload with it means the card never advertises
    // text Foreman would no longer send - the machine re-drafts from the new
    // intent on the next tick.
    const next: WorkItem = {
      ...item,
      intent,
      approvedAt: null,
      proposedPayload: null,
      revision: item.revision + 1,
      updatedAt: now,
    };
    this.registry.putQueueItem(next);
    return { ok: true, item: next };
  }

  /**
   * Remove a waiting item, or clear one already terminal. An in-flight item is
   * refused: it has already been typed into a pane, so "remove" would be a lie -
   * the agent is working on it right now.
   *
   * The two accepting cases read differently to a human and identically to the DB, so
   * they are one condition: what makes a row removable is that nothing will advance
   * it again, which is true of a waiting item (queued/proposed) and of a finished one
   * (terminal) and false only in between.
   */
  remove(itemId: string): { ok: boolean; error?: string } {
    const item = this.registry.getQueueItem(itemId);
    if (!item) return { ok: false, error: "no such item" };
    const waiting = item.state === "queued" || item.state === "proposed";
    if (!waiting && !isTerminalItem(item.state)) {
      return { ok: false, error: `cannot remove an item that is ${item.state}` };
    }
    this.registry.removeQueueItem(itemId);
    return { ok: true };
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
   *
   * An item with no drafted text is REFUSED, and that check is the teeth behind the
   * whole per-round-approval design rather than defensive noise. Approve means "type
   * this exact text", so without the text there is nothing to consent to - and the
   * request can only come from a card rendering a button it shouldn't have. Enforced
   * here because the UI cannot be the enforcement: this is the boundary the write
   * actually crosses.
   */
  approve(itemId: string, now = Date.now()): { ok: boolean; error?: string } {
    const item = this.registry.getQueueItem(itemId);
    if (!item) return { ok: false, error: "no such item" };
    if (item.state !== "proposed") {
      return { ok: false, error: `only a proposed item can be approved (this is ${item.state})` };
    }
    if (item.proposedPayload === null) {
      return { ok: false, error: "this item has no drafted text yet - nothing to approve" };
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
   *
   * It is stamped on the way INTO `sending`, and that is what makes it readable
   * after a crash. `sentAt` is otherwise only ever set, never cleared, so a fix
   * round re-entering `sending` used to carry the PREVIOUS round's delivery time -
   * and `recover` adopting that stamp made every scrap of the earlier round's work
   * look like a pickup of a prompt that may never have been typed, which silently
   * removed the escalation branch for every round >= 1. Deriving it from
   * `updatedAt` instead is no better: a reorder stamps that on every row in the
   * queue, in-flight ones included.
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
      // Entering `sending` IS the send attempt, so this is where its clock starts.
      // The row is written before the tmux write, which makes it the only timestamp
      // a crash is guaranteed to leave behind - and `recover` adjudicates against it.
      sentAt: state === "sending" ? now : item.sentAt,
      // The draft belongs to `proposed` and to nothing else, so ANY transition out
      // of it clears the text. Doing that here - the one place every transition
      // lands - is what keeps "there is a drafted payload" and "the card is asking
      // you to approve one" the same fact, instead of two that drift.
      proposedPayload:
        patch.proposedPayload !== undefined
          ? patch.proposedPayload
          : state === "proposed"
            ? item.proposedPayload
            : null,
      updatedAt: now,
      completedAt: isTerminalItem(state) ? item.completedAt ?? now : null,
    };
    return this.write(next);
  }

  /**
   * Persist an item, turning the single-flight index's constraint violation into a
   * clean refusal.
   *
   * The index is the enforcement and must stay that way - but a raw
   * `ERR_SQLITE_ERROR` escaping the route means the daemon logs a stack trace and
   * answers an opaque 500, so the caller can't tell "you broke the invariant" from
   * "the daemon fell over". Catching it here keeps the guarantee and makes it
   * legible.
   */
  private write(item: WorkItem): { ok: true; item: WorkItem } | { ok: false; error: string } {
    try {
      this.registry.putQueueItem(item);
      return { ok: true, item };
    } catch (err) {
      if (isSingleFlightViolation(err)) {
        return { ok: false, error: "another item in this queue is already in flight" };
      }
      throw err;
    }
  }

  /**
   * Stamp delivery: the item is out, with the diff + transcript scope it was sent at.
   *
   * The scope is anchored ONCE, on the first send, and every later round keeps it -
   * hence `item.baseSha ?? baseSha` rather than a plain overwrite. An item's evidence
   * is its CUMULATIVE work, because that is what the verifier is asked about: the
   * prompt hands it the original intent and asks whether that intent was satisfied.
   *
   * Re-anchoring each round quietly made that question unanswerable, and only for
   * agents that commit. Say round 0 delivers at abc1234, the agent implements the
   * feature and commits (HEAD is now def5678), and verify raises one blocking gap.
   * Re-anchoring round 1 to def5678 scopes the diff to the fix alone and moves the
   * transcript window past the work - so the verifier, still asked "was the intent
   * satisfied?", correctly answers no, invents fresh gaps for work that was already
   * done, and rides the round budget to escalation. The good citizen got the worst
   * outcome; a non-committing agent never moved HEAD, so it never noticed.
   *
   * Re-checking the whole item every round is deliberate, not a side effect: a fix
   * that breaks the original intent has to still be caught.
   */
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
      baseSha: item.baseSha ?? baseSha,
      // `??` and not `||`: a 0 anchor is a real value (an empty transcript at
      // delivery), and treating it as absent would re-anchor past round 0's turns.
      transcriptAnchor: item.transcriptAnchor ?? transcriptAnchor,
      sentAt: now,
      approvedAt: null, // consent is spent; a later round needs a fresh one
      proposedPayload: null, // and so is the draft it consented to - it's typed now
      // This send WAS watched all the way through the inject, so the resend
      // evidence is positive again. Clearing the flag matters on a later round of
      // an item that was once crash-recovered: without it that round would refuse
      // to resend for a crash it never suffered.
      recoveredAt: null,
      updatedAt: now,
    };
    return this.write(next);
  }

  /**
   * Adopt an item a restart left mid-`sending`, and let the pickup detector
   * adjudicate on evidence.
   *
   * `sentAt` is CARRIED, not restamped: `setState` stamped it on the way into
   * `sending`, so it already says when this round's send was attempted. Stamping
   * `now` would make any activity from the crash window look older than the send and
   * hide a pickup that already happened; re-deriving it from `updatedAt` would trust
   * a field an unrelated reorder can move.
   *
   * `recoveredAt` is what stops this item from ever resending: we never learned
   * whether the Enter was pressed, so the text may be sitting unsubmitted in the
   * pane and a second paste would mangle it.
   */
  recover(itemId: string, now = Date.now()): { ok: true; item: WorkItem } | { ok: false; error: string } {
    const item = this.registry.getQueueItem(itemId);
    if (!item) return { ok: false, error: "no such item" };
    if (item.state !== "sending") {
      return { ok: false, error: `only a sending item can be recovered (this is ${item.state})` };
    }
    const next: WorkItem = {
      ...item,
      state: "awaiting_pickup",
      recoveredAt: now,
      updatedAt: now,
    };
    return this.write(next);
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

/** True when an error is the one_inflight_per_queue index rejecting a write. */
function isSingleFlightViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed: foreman_queue_items\.note_key/i.test(msg);
}
