import type { PendingNudge, SessionAwaitingRecord } from "./db.ts";
import type { SessionState } from "@shared/types.ts";

/**
 * Whose turn was it? The policy that decides, for a session idle on purpose while a background
 * process finishes (issue #1596), whether a turn is the session's own wake or one of Mission
 * Control's own nudges, as pure functions over the stored wait.
 *
 * Every function here takes a `SessionAwaitingRecord` and one observation and returns the record
 * to store next (the very same object when nothing changed) and, for a turn, whether the wait
 * ends as a wake. Nothing here reads a clock, writes SQLite or emits: the Registry gathers the
 * observation, persists `next` and publishes the outcome, so its single-emit contract inside
 * `emitSession` is the Registry's concern alone and every rule below is testable on plain data.
 *
 * The rules, in the order a wait meets them:
 *
 * - The wake is the session's own NEXT turn. The declaration is made mid-turn, so the declaring
 *   turn's end is recorded first (`settledAt`, see `declaringTurnEnded`), and only a turn that
 *   starts after it is judged.
 * - Mission Control's own deliveries (Foreman, a workflow, the harness, a resident) are not a
 *   wake. Each is stored on the wait with its text's fingerprint as it is claimed
 *   (`recordAutomatedDelivery`), and a turn whose prompt matches one uses it up.
 * - A person's message in exactly those words contests that delivery (`recordPersonDelivery`):
 *   the matching turn is then read as the wake, since it is either theirs or the nudge's with
 *   theirs still to come.
 * - A turn whose prompt is not known when it starts is stored as undecided, and is decided by its
 *   prompt when that arrives (`judgeLatePrompt`) or by its end.
 */

/** One confirmed reading of the waiting session, as the Registry gathers it on an emit. */
export interface TurnObservation {
  now: number;
  /** The session's confirmed state now. Presumed (unconfirmed) and exited readings never reach here. */
  state: SessionState;
  /** The last confirmed state the watch saw, or undefined when none has been seen in this process. */
  last: SessionState | undefined;
  /** The session is in a turn now (`agentActive`). */
  active: boolean;
  /** The prompt fingerprints of the hook event that produced this reading, or null when it carried none. */
  prompt: readonly string[] | null;
  /** This session's own hooks have reported a turn's prompt before, so a turn without one is its own. */
  reportsPrompts: boolean;
  /**
   * When the session's own lifecycle source (a hook overlay or a transcript read) reported it idle,
   * in that source's time, for a report OTHER than the one the wait was declared against; null when
   * there is no such fresh idle report. The Registry owns which report is which.
   */
  freshIdleAt: number | null;
  /** The transcript's latest turn start, for a session without hooks; null otherwise. */
  passiveTurnStartedAt: number | null;
}

/** What a judgement decided: the record to store (the same object when unchanged), and whether the wait ends as a wake. */
export interface Judgement {
  next: SessionAwaitingRecord;
  wake: boolean;
}

/** Whether a person's send of the same words still contests this delivery. */
export function nudgeContested(nudge: PendingNudge): boolean {
  return (nudge.contestedBy?.length ?? 0) > 0;
}

/**
 * If one of `prompt`'s fingerprints is a pending delivery of Mission Control's, the record with
 * that delivery used up (the turn is its nudge) and `patch` applied; null when the prompt is
 * someone else's.
 *
 * A contested delivery is never used up: a person also sent those exact words, so this turn is
 * either theirs or the nudge's with theirs still to come, and a person's turn is the wake either
 * way. Null ends the wait now rather than one turn late, or never, when the automated delivery is
 * folded into the person's turn or never lands.
 */
export function useUpNudge(
  record: SessionAwaitingRecord,
  prompt: readonly string[],
  patch: Partial<Pick<SessionAwaitingRecord, "settledAt" | "undecidedTurn" | "redeclaredInTurn">>,
): SessionAwaitingRecord | null {
  const i = record.pendingNudges.findIndex((nudge) => prompt.includes(nudge.key));
  if (i < 0 || nudgeContested(record.pendingNudges[i]!)) return null;
  return {
    ...record,
    ...patch,
    pendingNudges: [...record.pendingNudges.slice(0, i), ...record.pendingNudges.slice(i + 1)],
  };
}

/**
 * Has the turn that declared (or re-declared) this wait ended, as this reading says?
 *
 * Ordinarily that is the session leaving its turn for idle. A wait declared while the registry
 * already read idle sees no such transition: the turn was too short for a discovery sweep to catch,
 * or its hooks lost the race with the MCP call. Its end is then a fresh idle report from the
 * session's own lifecycle source, stamped no earlier than the declaration, which a Stop hook or a
 * transcript read can only be once the declaring call has returned. Never the session's activity
 * stamp: `report_status` and a driver dialog move that mid-turn without the turn ending.
 */
export function declaringTurnEnded(record: SessionAwaitingRecord, obs: TurnObservation): boolean {
  if (obs.state !== "idle") return false;
  if (obs.last !== "idle") return true;
  return obs.freshIdleAt !== null && obs.freshIdleAt >= record.awaiting.updatedAt;
}

/**
 * Judge one confirmed reading of the waiting session: a turn starting, a turn missed between
 * sweeps, or the declaring (or an undecided) turn ending.
 */
export function judgeTurn(record: SessionAwaitingRecord, obs: TurnObservation): Judgement {
  // A turn STARTING, as seen: the last confirmed state was not a turn and this one is. With none
  // seen yet in this process (a restart, or a wait reloaded at startup), a session confirmed in a
  // turn while its wait stood settled started that turn unobserved, and it is judged as a turn
  // start all the same; while the wait is mid-turn it is the same turn.
  const turnStarted = obs.active && obs.last !== "starting" && obs.last !== "working";
  if (record.settledAt !== null && turnStarted) {
    // With no delivery outstanding, nothing of Mission Control's can have started it.
    if (record.pendingNudges.length === 0) return { next: record, wake: true };
    // Settled by the turn's prompt when it is already known (a prompt hook started the turn).
    if (obs.prompt) {
      const used = useUpNudge(record, obs.prompt, { settledAt: null, undecidedTurn: false, redeclaredInTurn: false });
      return used ? { next: used, wake: false } : { next: record, wake: true };
    }
    // Otherwise decided when its prompt arrives, or when it ends without one. Stored, so a
    // restart before the prompt arrives can still decide this turn.
    return { next: { ...record, settledAt: null, undecidedTurn: true, redeclaredInTurn: false }, wake: false };
  }
  // A turn a session without hooks started and finished between two discovery sweeps: the
  // transcript read is idle again, but its turn marker has moved past the wait's settle. Judged
  // as a turn that has already ended, the way an undecided turn's end is.
  if (
    record.settledAt !== null && !turnStarted && obs.state === "idle"
    && obs.passiveTurnStartedAt !== null && obs.passiveTurnStartedAt > record.settledAt
  ) {
    const oldest = record.pendingNudges[0];
    if (!oldest || nudgeContested(oldest)) return { next: record, wake: true };
    return {
      next: { ...record, settledAt: Math.max(obs.now, obs.passiveTurnStartedAt), pendingNudges: record.pendingNudges.slice(1) },
      wake: false,
    };
  }
  if (record.settledAt === null && declaringTurnEnded(record, obs)) {
    if (record.undecidedTurn) {
      // The turn ended with no prompt ever reported. On a session whose hooks report prompts,
      // every delivery Mission Control types reports its prompt, so a turn without one is the
      // session's own: the wake. On one that never reports a prompt (no hooks, or a driver with no
      // prompt hook, though marked instrumented) no turn does, and the oldest delivery still
      // outstanding is the best reading of whose turn it was. A contested oldest delivery is not a
      // nudge either (see `useUpNudge`).
      // With no delivery left (the one pending when the turn started was withdrawn since), the
      // turn can only have been the session's own.
      const oldest = record.pendingNudges[0];
      const ownTurn = obs.reportsPrompts || oldest === undefined || nudgeContested(oldest);
      // Unless the session declared its wait again during this very turn: then the wake, if this
      // turn was one, came and went inside it, and the wait it declared stands.
      if (ownTurn && !record.redeclaredInTurn) return { next: record, wake: true };
      return {
        next: {
          ...record, settledAt: obs.now, undecidedTurn: false, redeclaredInTurn: false,
          pendingNudges: ownTurn ? record.pendingNudges : record.pendingNudges.slice(1),
        },
        wake: false,
      };
    }
    return { next: { ...record, settledAt: obs.now }, wake: false };
  }
  return { next: record, wake: false };
}

/**
 * Judge an undecided turn by the prompt that has now arrived for it (an SDK driver's state can
 * arrive before the prompt hook). One of Mission Control's pending deliveries is that nudge;
 * anything else is the wake, unless the session already declared its wait again during this turn.
 * A record with no undecided turn is returned unchanged.
 */
export function judgeLatePrompt(record: SessionAwaitingRecord, prompt: readonly string[]): Judgement {
  if (!record.undecidedTurn) return { next: record, wake: false };
  const used = useUpNudge(record, prompt, { undecidedTurn: false, redeclaredInTurn: false });
  if (used) return { next: used, wake: false };
  // The wake came and went inside a turn that re-declared: the turn is decided, and the wait it
  // re-declared settles at the turn's end.
  if (record.redeclaredInTurn) return { next: { ...record, undecidedTurn: false, redeclaredInTurn: false }, wake: false };
  return { next: record, wake: true };
}

/**
 * Store one delivery Mission Control's own automation claimed into the session, with its text's
 * fingerprint, or, `released`, remove the one claimed at `at`, which provably never landed.
 *
 * One entry per delivery, so two deliveries that both land are two turns of Mission Control's own,
 * each matched to its turn by that turn's prompt; a withdrawn delivery removes only itself.
 * `contestedBy` is the ids of the person sends in the same words made just before it (the
 * Registry's in-memory window), whose turn may not have started yet.
 */
export function recordAutomatedDelivery(
  record: SessionAwaitingRecord,
  delivery: { at: number; key: string; released: boolean },
  contestedBy: readonly string[] = [],
): SessionAwaitingRecord {
  if (delivery.released) {
    let i = -1;
    for (let j = record.pendingNudges.length - 1; j >= 0; j--) {
      const nudge = record.pendingNudges[j]!;
      if (nudge.at === delivery.at && nudge.key === delivery.key) {
        i = j;
        break;
      }
    }
    if (i < 0) return record;
    return { ...record, pendingNudges: [...record.pendingNudges.slice(0, i), ...record.pendingNudges.slice(i + 1)] };
  }
  // Bounded like the claims behind it: far more than ever overlap, never unbounded.
  const nudge: PendingNudge = { at: delivery.at, key: delivery.key, ...(contestedBy.length > 0 ? { contestedBy: [...contestedBy] } : {}) };
  return { ...record, pendingNudges: [...record.pendingNudges, nudge].slice(-32) };
}

/**
 * Record a person's own words (the operator's, or a controlling session's) being written into the
 * session, or, `released`, take that send back because it provably never landed.
 *
 * Every pending delivery in exactly the same words records the send as contesting it, which
 * `useUpNudge` reads as the wake. A send taken back withdraws its own claim and only its own:
 * another send of the same words, even one made before a daemon restart, still contests the
 * delivery.
 */
export function recordPersonDelivery(
  record: SessionAwaitingRecord,
  delivery: { id: string; key: string; released: boolean },
): SessionAwaitingRecord {
  if (delivery.released) {
    if (!record.pendingNudges.some((nudge) => nudge.contestedBy?.includes(delivery.id))) return record;
    return {
      ...record,
      pendingNudges: record.pendingNudges.map((nudge) => {
        if (!nudge.contestedBy?.includes(delivery.id)) return nudge;
        const by = nudge.contestedBy.filter((id) => id !== delivery.id);
        return { at: nudge.at, key: nudge.key, ...(by.length > 0 ? { contestedBy: by } : {}) };
      }),
    };
  }
  if (!record.pendingNudges.some((nudge) => nudge.key === delivery.key)) return record;
  return {
    ...record,
    pendingNudges: record.pendingNudges.map((nudge) => nudge.key === delivery.key
      ? { ...nudge, contestedBy: [...(nudge.contestedBy ?? []), delivery.id].slice(-8) }
      : nudge),
  };
}
