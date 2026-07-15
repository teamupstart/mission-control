import type { ForemanConfig } from "@shared/protocol.ts";
import type { Session, SessionQueue, WorkItem } from "@shared/types.ts";
import { reportBucket } from "@shared/session.ts";
import { isInFlightState } from "@shared/queue.ts";
import { SEND_ATTEMPT_CAP, hasPane, inFlightItem, settledIdle } from "./queue-machine.ts";
import type { QueueAction, QueueConfig } from "./queue-machine.ts";
import { foremanMayActLive } from "./verdict.ts";

// The I/O half of the queue: execute what the pure machine decided. Kept behind a
// narrow interface so the whole thing can be driven against a fake in tests -
// mirroring foreman-verdict.test.ts's ForemanActions fake.

/**
 * A delivery that failed, carrying the only fact that decides what happens next.
 *
 * Defined here rather than in the HTTP client because it is part of THIS module's
 * contract: `inject` promises that a rejection says whether text may have reached
 * the pane, and the client is merely one implementation of that promise.
 *
 * `mayHaveLanded` is true unless the delivery positively reported that nothing was
 * pasted. That default is the point: absence of evidence is not evidence.
 */
export class InjectError extends Error {
  readonly mayHaveLanded: boolean;

  constructor(message: string, mayHaveLanded: boolean) {
    super(message);
    this.name = "InjectError";
    this.mayHaveLanded = mayHaveLanded;
  }
}

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

/**
 * Whether a failed delivery might have put text in the pane. Anything that isn't
 * an `InjectError` saying otherwise counts as "might have": an unrecognised
 * failure tells us nothing about the pane, and guessing "nothing landed" is the
 * guess that re-types over a prompt already sitting there.
 */
function mayHaveLanded(err: unknown): boolean {
  return !(err instanceof InjectError) || err.mayHaveLanded;
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
    //    lesson the triage path already encodes. The question is the one the machine
    //    asks: would this item still have to be a DRAFT? A mid-verify flip out of
    //    live must downgrade an unapproved item rather than type it. An approved one
    //    is already past that: the human read this exact text and said yes, which is
    //    the authority live mode would otherwise supply.
    //
    //    `item`, not the caller's snapshot - a "yes" that arrived after the machine
    //    decided is still a yes, and re-planning from fresh state is the whole point.
    const freshCfg = await actions.getConfig();
    if (!foremanMayActLive(freshCfg, fresh.cwd) && !item.approvedAt) {
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
      // A pickup is positive evidence that the send LANDED, so it clears the
      // attempt count - the same "onSuccess" shape a verdict uses on
      // verifyFailures. SEND_ATTEMPT_CAP counts CONSECUTIVE failures; without the
      // reset the count is cumulative across an item's whole life, and a fix round
      // (which sends again) inherits it. An item on round 3 would then arrive at
      // the cap on its FIRST delivery of that round, lose its resend, and escalate
      // claiming "the agent never picked this up" about an agent that picked it up
      // twice.
      await actions.setItemState(session.id, action.item.id, {
        state: "in_progress",
        sendAttempts: 0,
      });
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
      // sent, and the human approves that specific text. From round 1 on that text
      // is the rendered fix prompt, not the original intent - so without storing it
      // Approve would be consent to text the human never saw, which is the exact
      // hazard per-round approval exists to prevent.
      await actions.setItemState(session.id, action.item.id, {
        state: "proposed",
        round: action.round,
        proposedPayload: action.payload,
      });
      return { kind: "proposed", item: action.item };

    case "send":
    case "resend": {
      const obs = observe(session, action.item);
      const guard = await queueSendStillValid(actions, obs, cfg, now);
      if (!guard.ok) {
        // A stale-send abort is NOT evidence about the work, so it must never
        // consume a round or a strike. Fall back and re-decide next tick.
        //
        // An IN-FLIGHT item is never demoted, and `resend` is why: it acts only on
        // `awaiting_pickup`, which means the prompt is ALREADY in the pane. Writing
        // it back to `queued` drops it out of the in-flight set, so the next tick
        // never re-enters decideInFlight and the `picked-up` branch that would have
        // adjudicated the delivery is unreachable - step 9 simply types the item a
        // SECOND time. The race isn't hypothetical: guard #3 aborts because "the
        // session did something since we looked", which is precisely what picking
        // the item up looks like. Leaving the state alone lets decideInFlight see
        // `lastActivity > sentAt` next tick and settle it as picked-up.
        //
        // `proposed` still falls back to `queued`: nothing was typed, so it holds no
        // single-flight slot and re-deciding it from scratch is free.
        if (!isInFlightState(action.item.state) && action.item.state !== "queued") {
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
        // A throw is NOT evidence that nothing landed. Delivery is a non-atomic
        // paste-then-Enter, so a failure after the paste leaves the prompt sitting
        // unsubmitted in the pane - and a retry would paste a second copy after the
        // first and mangle the work instruction. That is the same hazard the crash
        // path already refuses to gamble on (see the `recoveredAt` branch): absence
        // of evidence is not evidence, so hand it to the human instead of guessing.
        if (mayHaveLanded(err)) {
          await actions.setItemState(target.id, action.item.id, {
            state: "escalated",
            escalationReason: `Foreman couldn't tell whether this item reached the pane - check it before retrying (${String(err)})`,
          });
          return { kind: "aborted", why: "send failed and may have half-landed; escalated" };
        }
        const attempts = action.item.sendAttempts + 1;
        if (attempts >= SEND_ATTEMPT_CAP) {
          await actions.setItemState(target.id, action.item.id, {
            state: "escalated",
            escalationReason: `could not deliver this item: ${String(err)}`,
          });
          return { kind: "aborted", why: `send failed ${attempts}x; escalated` };
        }
        // The paste never happened, so nothing landed: safe to go back and retry.
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
