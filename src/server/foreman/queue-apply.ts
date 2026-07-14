import type { ForemanConfig } from "@shared/protocol.ts";
import type { Session, SessionQueue, WorkItem } from "@shared/types.ts";
import { reportBucket } from "@shared/session.ts";
import { hasPane, inFlightItem, settledIdle } from "./queue-machine.ts";
import type { QueueAction, QueueConfig } from "./queue-machine.ts";
import { foremanMayActLive } from "./verdict.ts";

// The I/O half of the queue: execute what the pure machine decided. Kept behind a
// narrow interface so the whole thing can be driven against a fake in tests -
// mirroring foreman-verdict.test.ts's ForemanActions fake.

/** The daemon surface applying a queue action needs. Tests inject a fake. */
export interface QueueActions {
  sessions(): Promise<Session[]>;
  getConfig(): Promise<ForemanConfig>;
  queue(sessionId: string): Promise<SessionQueue | null>;
  setItemState(sessionId: string, itemId: string, patch: Record<string, unknown>): Promise<unknown>;
  inject(sessionId: string, text: string): Promise<void>;
  markSent(
    sessionId: string,
    itemId: string,
    baseSha: string | null,
    transcriptAnchor: number | null,
  ): Promise<unknown>;
  recoverItem(sessionId: string, itemId: string): Promise<unknown>;
  markWrapupAsked(sessionId: string): Promise<unknown>;
  /** HEAD sha + transcript byte size to record as this item's scope at delivery. */
  captureScope(
    session: Session,
  ): Promise<{ baseSha: string | null; transcriptAnchor: number | null }>;
  /** True while this worker still holds the fleet lease. */
  holdsLease(): boolean;
}

/** noteKeyFor, inlined so this module doesn't drag the whole registry in. */
export function noteKeyOf(s: Session): string {
  return s.agentSessionId ?? s.id;
}

/** Pane token for a session - what `inject` will actually target. */
export function paneKeyOf(s: Session): string | null {
  if (s.tmux) return `tmux:${s.tmux.paneId}`;
  if (s.wezterm) return `wez:${s.wezterm.paneId}`;
  return null;
}

/** What the guard observed when the machine made its decision. */
export interface SendObservation {
  noteKey: string;
  itemId: string;
  lastActivity: number | null;
  paneKey: string | null;
  itemState: string;
  itemRound: number;
  itemRevision: number;
}

export function observe(session: Session, item: WorkItem): SendObservation {
  return {
    noteKey: noteKeyOf(session),
    itemId: item.id,
    lastActivity: session.lastActivity,
    paneKey: paneKeyOf(session),
    itemState: item.state,
    itemRound: item.round,
    itemRevision: item.revision,
  };
}

export type GuardResult = { ok: true; session: Session } | { ok: false; why: string };

/**
 * Re-confirm, immediately before typing, that this send is still the right thing
 * to do. The `sendStillValid` analogue, at higher stakes: that one guards against
 * re-answering a settled question; this guards against typing a WORK INSTRUCTION
 * into a session that has moved on.
 *
 * All must hold, and any failure of the re-check ITSELF aborts - an abort costs a
 * tick, a bad send costs the human's afternoon.
 *
 * An approved send runs this too. Approve records CONSENT, it does not bypass the
 * guard: the human's "yes" arrives minutes after the draft was made, and the
 * session may have moved on since.
 */
export async function queueSendStillValid(
  actions: QueueActions,
  obs: SendObservation,
  cfg: QueueConfig,
  now: number,
): Promise<GuardResult> {
  try {
    // 1. Re-resolve noteKey -> live session. NEVER cache session.id across a
    //    multi-minute verify: it churns with pid/tty, and /inject and /diff both
    //    resolve by it - a cached id 404s or, worse, hits a DIFFERENT session.
    const sessions = await actions.sessions();
    const fresh = sessions.find((s) => noteKeyOf(s) === obs.noteKey && s.state !== "exited");
    if (!fresh) return { ok: false, why: "the session is gone" };

    // 2. An unanswered question outranks the queue.
    if (reportBucket(fresh, sessions) === "needs-you") {
      return { ok: false, why: "the session needs you" };
    }

    // 3. The strongest guard, and the one that catches A HUMAN TYPING IN THE PANE.
    //    Bucket-checking is insufficient: a human turn can start AND finish inside
    //    a 2-minute verify and land back at idle with an identical bucket -
    //    lastActivity will have moved.
    if (fresh.lastActivity !== obs.lastActivity) {
      return { ok: false, why: "the session did something since we looked" };
    }

    // 4. Still settled.
    if (!settledIdle(fresh, now, cfg.settleMs)) {
      return { ok: false, why: "the session is no longer settled" };
    }

    // 5. Pane unchanged - inject targets a RAW pane id, and a recreated pane can
    //    reuse one, so a stale id could type into someone else's terminal.
    if (!hasPane(fresh)) return { ok: false, why: "the session has no pane" };
    if (paneKeyOf(fresh) !== obs.paneKey) return { ok: false, why: "the pane was recreated" };

    // 6. The item itself hasn't moved (the human may have edited or reordered it).
    const queue = await actions.queue(fresh.id);
    if (!queue) return { ok: false, why: "the queue is gone" };
    const item = queue.items.find((i) => i.id === obs.itemId);
    if (!item) return { ok: false, why: "the item is gone" };
    if (
      item.state !== obs.itemState ||
      item.round !== obs.itemRound ||
      item.revision !== obs.itemRevision
    ) {
      return { ok: false, why: "the item changed while we were verifying" };
    }

    // 7. Defence behind the DB's partial unique index: never two in flight.
    const flight = inFlightItem(queue.items);
    if (flight && flight.id !== item.id) {
      return { ok: false, why: "another item is already in flight" };
    }

    // 8. Re-PLAN from a fresh config, not merely re-check a cached mayActLive - the
    //    lesson the triage path already encodes. A mid-verify flip out of live must
    //    downgrade to a draft rather than type.
    const freshCfg = await actions.getConfig();
    if (!foremanMayActLive(freshCfg, fresh.cwd)) {
      return { ok: false, why: "Foreman is no longer cleared to send live for this repo" };
    }

    // 9. Still ours to drive.
    if (!actions.holdsLease()) return { ok: false, why: "another worker holds the lease" };

    return { ok: true, session: fresh };
  } catch (err) {
    return { ok: false, why: `the re-check failed (${String(err)})` };
  }
}

/** What applying an action did, for the worker's log line. */
export type ApplyOutcome =
  | { kind: "sent"; item: WorkItem }
  | { kind: "proposed"; item: WorkItem }
  | { kind: "aborted"; why: string }
  | { kind: "noop" }
  | { kind: "done"; what: string };

/**
 * Execute a decided action. Everything that types goes through the guard first,
 * and the send-then-stamp order matters: `awaiting_pickup` is written only AFTER
 * the inject resolves, so a failed send never leaves an item looking delivered
 * (the same discipline applyVerdict already encodes for triage).
 */
export async function applyQueueAction(
  actions: QueueActions,
  session: Session,
  action: QueueAction,
  cfg: QueueConfig,
  now: number,
): Promise<ApplyOutcome> {
  switch (action.kind) {
    case "none":
    case "triage":
      return { kind: "noop" };

    case "recover-send":
      await actions.recoverItem(session.id, action.item.id);
      return { kind: "done", what: "adopted an item left mid-send by a restart" };

    case "picked-up":
      await actions.setItemState(session.id, action.item.id, { state: "in_progress" });
      return { kind: "done", what: "the agent picked the item up" };

    case "escalate":
      await actions.setItemState(session.id, action.item.id, {
        state: "escalated",
        escalationReason: action.reason,
      });
      return { kind: "done", what: `escalated: ${action.reason}` };

    case "ask-wrapup":
      await actions.markWrapupAsked(session.id);
      return { kind: "done", what: "the queue drained - asked about wrapping up" };

    case "propose":
      // Dry-run drafts, and NEVER types. The payload is stored as the item's
      // intent-of-record for this round so the card can show exactly what would be
      // sent, and the human approves that specific text.
      await actions.setItemState(session.id, action.item.id, {
        state: "proposed",
        round: action.round,
      });
      return { kind: "proposed", item: action.item };

    case "send":
    case "resend": {
      const obs = observe(session, action.item);
      const guard = await queueSendStillValid(actions, obs, cfg, now);
      if (!guard.ok) {
        // A stale-send abort is NOT evidence about the work, so it must never
        // consume a round or a strike. Fall back and re-decide next tick.
        if (action.item.state !== "in_progress" && action.item.state !== "queued") {
          await actions
            .setItemState(session.id, action.item.id, { state: "queued" })
            .catch(() => {});
        }
        return { kind: "aborted", why: guard.why };
      }
      const target = guard.session;

      // Mark `sending` BEFORE the tmux write. That's what makes a crash detectable
      // at all - and why the machine adopts rather than retries such an item.
      await actions.setItemState(target.id, action.item.id, {
        state: "sending",
        round: action.round,
        sendAttempts: action.item.sendAttempts + 1,
      });

      const scope = await actions.captureScope(target);
      try {
        await actions.inject(target.id, action.payload);
      } catch (err) {
        const attempts = action.item.sendAttempts + 1;
        if (attempts >= 3) {
          await actions.setItemState(target.id, action.item.id, {
            state: "escalated",
            escalationReason: `could not deliver this item: ${String(err)}`,
          });
          return { kind: "aborted", why: `send failed ${attempts}x; escalated` };
        }
        // The inject threw, so nothing landed: it's safe to go back and retry.
        await actions.setItemState(target.id, action.item.id, { state: "queued" });
        return { kind: "aborted", why: `send failed (${String(err)})` };
      }

      // Only now is it genuinely delivered.
      await actions.markSent(target.id, action.item.id, scope.baseSha, scope.transcriptAnchor);
      return { kind: "sent", item: action.item };
    }

    // `verify` is driven by the worker (it needs the reviewer subprocess), not here.
    case "verify":
      return { kind: "noop" };
  }
}
