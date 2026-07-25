import type { ForemanConfig } from "@shared/protocol.ts";
import type { Session, SessionQueue, WorkItem } from "@shared/types.ts";
import { reportBucket } from "@shared/session.ts";
import { isInFlightState } from "@shared/queue.ts";
import { paneToken } from "@shared/pane.ts";
import { SEND_ATTEMPT_CAP, hasPane, inFlightItem, settledIdle } from "./queue-machine.ts";
import type { QueueAction, QueueConfig } from "./queue-machine.ts";
import { foremanMayActLive } from "./verdict.ts";
import { foremanAutomationAuthorized } from "../harness/index.ts";

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
  /**
   * True when the pane refused the write because it is in a tmux mode - see
   * `ActionResult.paneBlocked`.
   *
   * Carried separately from `mayHaveLanded` because the two answer different
   * questions, and the post-paste Enter is the case that proves it: nothing about
   * "a person is in copy-mode" says whether text is already in the composer. This
   * one is about the CAUSE (a human, who will leave) rather than the extent, and
   * only the cause can say whether an attempt should be charged for it.
   */
  readonly paneBlocked: boolean;

  constructor(message: string, mayHaveLanded: boolean, paneBlocked = false) {
    super(message);
    this.name = "InjectError";
    this.mayHaveLanded = mayHaveLanded;
    this.paneBlocked = paneBlocked;
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
  setWrapupAnswer(sessionId: string, answer: string): Promise<unknown>;
  /** HEAD sha + transcript byte size to record as this item's scope at delivery. */
  captureScope(
    session: Session,
  ): Promise<{ baseSha: string | null; transcriptAnchor: number | null }>;
  /** True while this worker still holds the worker lease. */
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

/**
 * Whether a failed delivery was refused by a pane in a tmux mode - a human reading
 * their own scrollback, and nothing else.
 *
 * Defaults to false, the opposite of `mayHaveLanded`, and for the same reason: each
 * defaults to the answer that costs less when wrong. Guessing "might have landed"
 * escalates to a human who can look at the pane; guessing "a human is blocking it"
 * would retry a genuinely broken send forever, silently, with nobody looking.
 */
function paneBlocked(err: unknown): boolean {
  return err instanceof InjectError && err.paneBlocked;
}

/**
 * How long an item waits after a pane refused its delivery.
 *
 * Without it the send re-fires every `IDLE_MS` (4s) for as long as someone is scrolling
 * - two item-state writes, a scope capture and a subprocess each time, plus a "held
 * off" line in the log per tick - to re-learn the one fact that has not changed. 30s
 * costs a person at most half a minute of extra wait after they leave the mode, which
 * is invisible against a queue whose other latencies are settle windows and reviews.
 */
export const PANE_BLOCKED_BACKOFF_MS = 30_000;

/**
 * Items parked behind a pane in a tmux mode, and when each may be tried again.
 *
 * Deliberately in memory and NOT on the item. It is a rate limit, not a fact about the
 * work: losing it on restart costs one extra probe, whereas persisting it would put a
 * second, staler notion of "when may this send" beside the state machine's - and this
 * module's whole discipline is that the machine owns every such decision. Entries are
 * dropped as they expire, so the map holds only what is parked right now.
 */
const blockedUntil = new Map<string, number>();

/** noteKeyFor, inlined so this module doesn't drag the whole registry in. */
export function noteKeyOf(s: Session): string {
  return s.agentSessionId ?? s.id;
}

/**
 * Find the live session holding `noteKey` in a FRESH session read, or null.
 *
 * Defined once because two callers must agree on it - `queueSendStillValid` before
 * typing, and the worker's per-target re-resolve before deciding anything - and
 * they previously did not: the worker's copy omitted the `exited` filter, so a
 * transiently-exited session resolved as live and its in-flight item was escalated.
 * Same lesson as IN_FLIGHT_ITEM_STATES (see @shared/queue.ts): when two readers of
 * one predicate can disagree, the fix is one implementation, not two careful copies.
 *
 * Resolve by NOTE KEY, never by `session.id`: the id churns with pid/tty, while the
 * key is the identity the queue is stored under.
 *
 * `exited` sessions are excluded, and that is deliberate rather than incidental.
 * The state is PROVISIONAL - `applyDiscovery` marks any session missing from a
 * single `ps` sweep as exited and only evicts it EXIT_LINGER_MS later, cancelling
 * that timer if it reappears - so treating one as a live target means acting on a
 * session that may be perfectly healthy. Both callers' actions are irreversible (a
 * typed work instruction; a terminal escalation with no undo), so a missed poll must
 * cost a tick, not the item.
 */
export function resolveLiveSession(sessions: Session[], noteKey: string): Session | null {
  return sessions.find((s) => noteKeyOf(s) === noteKey && s.state !== "exited") ?? null;
}

/** Pane token for a session - what `inject` will actually target. */
export function paneKeyOf(s: Session): string | null {
  return paneToken(s);
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
 * to do. The `pendingStillLive` analogue, at higher stakes: that one guards against
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
    const fresh = resolveLiveSession(sessions, obs.noteKey);
    if (!fresh) return { ok: false, why: "the session is gone" };
    if (!foremanAutomationAuthorized(fresh)) {
      return { ok: false, why: "the session is not authorized for Foreman automation" };
    }

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

    // 5. Still deliverable, and - on the runtime where delivery is addressed by a raw pane
    //    id - still the SAME pane. A recreated pane can reuse an id, so a stale one could
    //    type into someone else's terminal.
    //
    //    The second half is deliberately conditional on there BEING a pane key, rather than
    //    on `null === null` happening to compare equal. An embedded session is addressed by
    //    its session id and driven through a handle the supervisor owns, so there is no id
    //    to go stale and no pane to be recreated: `paneKeyOf` answers null for every one of
    //    them, and a guard that reads as "the pane was recreated" would be either a no-op
    //    that looks load-bearing or, the day a pane key becomes derivable for some other
    //    reason, a refusal nobody could explain. Say which sessions it is about.
    if (!hasPane(fresh)) return { ok: false, why: "the session has no pane" };
    if (obs.paneKey !== null && paneKeyOf(fresh) !== obs.paneKey) {
      return { ok: false, why: "the pane was recreated" };
    }

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
    if (!foremanMayActLive(freshCfg, fresh.cwd, fresh.repoRoot) && !item.approvedAt) {
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

    case "auto-wrapup": {
      // Mark FIRST, then type, then record the answer. The order is the entire safety
      // argument here, and it is the opposite of the send path's - deliberately.
      //
      // A queue item is idempotent-ish under a double delivery: the agent re-reads an
      // instruction it already has. This is not. `/no-mistakes` PUSHES and opens a PR,
      // so typing it twice is two pipelines racing on one branch - the exact harm the
      // card's `wrapupSent` latch was added for after a remount did it once.
      //
      // So the write that RETIRES this action lands before the irreversible act:
      //   - `markWrapupAsked` stamps `wrapupAskedAt`, which is step 5's once-only guard.
      //     From here on no tick can re-decide `auto-wrapup`, crash or no crash.
      //   - then we type.
      //   - then `setWrapupAnswer` records what we sent, which is what retires the CARD.
      //
      // Each failure degrades to the human rather than to a double-push:
      //   - crash after mark, before inject -> answer stays null -> the card renders with
      //     this exact text prefilled, one click away. Which is precisely `ask` mode.
      //   - inject throws -> same, and we say why.
      //   - inject lands, `setWrapupAnswer` fails -> the card re-offers an instruction the
      //     agent already has. Bad, but a human is looking at it and the text is visibly
      //     already in the pane; a silent second push has nobody looking. Report it.
      //
      // Note this deliberately does NOT reuse `queueSendStillValid`: every one of its 9
      // checks is about an ITEM (round caps, base sha drift, pickup windows) and there is
      // no item here. Step 5 gates this one - live + allowlisted + fresh + settled + pane.
      await actions.markWrapupAsked(session.id);
      try {
        await actions.inject(session.id, action.payload);
      } catch (err) {
        // `mayHaveLanded` can't help here: with no item there is no state to demote and
        // nothing to re-decide - step 5 is already retired either way. The card is the
        // recovery, so just say what happened. Never retry: a retry IS the double-push.
        const why = err instanceof Error ? err.message : String(err);
        return { kind: "aborted", why: `could not send the wrap-up (${why}) - asking instead` };
      }
      try {
        await actions.setWrapupAnswer(session.id, action.payload);
      } catch (err) {
        // Sent but unrecorded. Don't let this throw: the instruction is IN the pane, and
        // an exception here reads to the loop like the send never happened.
        const why = err instanceof Error ? err.message : String(err);
        return { kind: "done", what: `sent the wrap-up but could not record it (${why})` };
      }
      return { kind: "done", what: `the queue drained - sent "${action.payload}"` };
    }

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
      // Still parked behind someone's copy-mode. Say `noop` rather than `aborted`: an
      // abort is a thing that went wrong and the loop logs it, while this is the
      // backoff working exactly as intended.
      const parkedUntil = blockedUntil.get(action.item.id);
      if (parkedUntil !== undefined) {
        if (parkedUntil > now) return { kind: "noop" };
        blockedUntil.delete(action.item.id);
      }

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
        //
        // ON THE DRIVER RUNTIME THIS ARM AND THE NEXT ARE UNREACHABLE, and that is a
        // property of the delivery rather than a case handled below. `send()` resolves
        // only when the harness ACCEPTED the turn, so there is no half-landed state to be
        // uncertain about: the daemon reports `pasted: false` on every failure
        // (`sdk/deliver.ts`), which is the one thing `InjectError` reads as positive
        // evidence that nothing was written, and it never reports `paneBlocked` because
        // there is no pane for a human to be scrolling. So an embedded delivery lands on
        // the ordinary counted-attempt arm at the bottom: it spends one of the item's
        // rationed attempts, re-queues, and escalates at the cap - a definite failure,
        // never limbo and never an unbounded park-and-retry.
        if (mayHaveLanded(err)) {
          await actions.setItemState(target.id, action.item.id, {
            state: "escalated",
            escalationReason: `Foreman couldn't tell whether this item reached the pane - check it before retrying (${String(err)})`,
          });
          return { kind: "aborted", why: "send failed and may have half-landed; escalated" };
        }

        // A pane in a tmux mode refused it, and nothing was written. This is a PERSON
        // reading their own scrollback, not a fault of the item, the session, or the
        // daemon - so it must not spend the item's finite delivery budget. Charging it
        // escalated an item permanently after three ticks, roughly twelve seconds of
        // someone scrolling, with a "could not deliver this item" reason that named a
        // condition which had already cleared by the time anyone read it.
        //
        // Rolling `sendAttempts` back to its pre-write value is what makes that true.
        // The count is incremented BEFORE the inject (so a crash mid-send is visible),
        // so merely declining to escalate here would still leave the attempt spent and
        // the cap three refusals away. Note this cannot mask a real delivery problem:
        // it is reached only for a refusal that positively reported writing nothing,
        // and any other failure of the same send still counts normally.
        if (paneBlocked(err)) {
          blockedUntil.set(action.item.id, now + PANE_BLOCKED_BACKOFF_MS);
          await actions.setItemState(target.id, action.item.id, {
            state: "queued",
            sendAttempts: action.item.sendAttempts,
          });
          return { kind: "aborted", why: `the pane is in a tmux mode - waiting (${String(err)})` };
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
