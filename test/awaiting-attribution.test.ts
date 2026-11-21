import { test } from "node:test";
import assert from "node:assert/strict";
import type { PendingNudge, SessionAwaitingRecord } from "../src/server/db.ts";
import {
  declaringTurnEnded, judgeLatePrompt, judgeTurn, nudgeContested, recordAutomatedDelivery, recordPersonDelivery,
  type TurnObservation,
} from "../src/server/awaiting-attribution.ts";

// The wake-attribution policy for a session idle on purpose (issue #1596), judged on plain data:
// no Registry, no discovery, no hooks. The Registry's own tests cover gathering the reading,
// persisting what is decided and publishing a wake.

/** A wait declared at 1_000 and settled at 2_000, with nothing pending. */
function wait(over: Partial<SessionAwaitingRecord> = {}): SessionAwaitingRecord {
  return {
    noteKey: "conv-1", taskId: null, sessionId: "s-1",
    awaiting: {
      id: "aw-1", what: "CI checks on PR #7", wakeSource: "command", expectedBy: 600_000,
      referenceUrl: null, details: null, startedAt: 1_000, updatedAt: 1_000,
    },
    settledAt: 2_000, pendingNudges: [], undecidedTurn: false, redeclaredInTurn: false, judgedTurnAt: null,
    ...over,
  };
}

/** An idle reading after an idle one, on a session whose hooks report prompts. */
function reading(over: Partial<TurnObservation> = {}): TurnObservation {
  return {
    now: 5_000, state: "idle", last: "idle", active: false, prompt: null, reportsPrompts: true,
    freshIdleAt: null, passiveTurnStartedAt: null, ...over,
  };
}

/** A turn starting: confirmed working after idle. */
const turnStart = { state: "working", last: "idle", active: true } as const;
/** A turn ending: confirmed idle after working. */
const turnEnd = { state: "idle", last: "working", active: false } as const;

const nudge = (key: string, contestedBy?: string[]): PendingNudge => ({ at: 3_000, key, ...(contestedBy ? { contestedBy } : {}) });

test("the session's next turn is the wake, and a reading that changes nothing returns the same record", () => {
  const record = wait();
  assert.deepEqual(judgeTurn(record, reading(turnStart)), { next: record, wake: true });
  const quiet = judgeTurn(record, reading());
  assert.equal(quiet.wake, false);
  assert.equal(quiet.next, record, "an unchanged record must be the same object, so nothing is written");
});

test("the declaring turn's end settles the wait, and a reading inside that turn says nothing", () => {
  const declared = wait({ settledAt: null });
  assert.equal(judgeTurn(declared, reading({ state: "working", last: "working", active: true })).next, declared);
  const ended = judgeTurn(declared, reading(turnEnd));
  assert.equal(ended.wake, false);
  assert.equal(ended.next.settledAt, 5_000);
});

test("a wait declared while idle settles only on a fresh idle report stamped no earlier than the declaration", () => {
  const declared = wait({ settledAt: null });
  assert.equal(declaringTurnEnded(declared, reading()), false, "no fresh report: still the declaring turn");
  assert.equal(declaringTurnEnded(declared, reading({ freshIdleAt: 999 })), false, "a report from before the declaration");
  assert.equal(declaringTurnEnded(declared, reading({ freshIdleAt: 1_000 })), true, "a report in the declaration's own millisecond");
  assert.equal(judgeTurn(declared, reading({ freshIdleAt: 1_500 })).next.settledAt, 5_000);
});

test("a turn's prompt decides it: a pending delivery is used up, any other prompt is the wake, a contested one is the wake", () => {
  const pending = wait({ pendingNudges: [nudge("wrap-up")] });
  const nudged = judgeTurn(pending, reading({ ...turnStart, prompt: ["wrap-up"] }));
  assert.equal(nudged.wake, false);
  assert.deepEqual(nudged.next.pendingNudges, []);
  assert.equal(nudged.next.settledAt, null, "a nudge's turn re-arms the watch");
  assert.equal(judgeTurn(pending, reading({ ...turnStart, prompt: ["check the build"] })).wake, true);
  const contested = wait({ pendingNudges: [nudge("wrap-up", ["person-1"])] });
  assert.equal(judgeTurn(contested, reading({ ...turnStart, prompt: ["wrap-up"] })).wake, true);
});

test("a turn whose prompt is not known yet is stored undecided, then decided by its late prompt", () => {
  const pending = wait({ pendingNudges: [nudge("wrap-up")] });
  const undecided = judgeTurn(pending, reading(turnStart)).next;
  assert.equal(undecided.undecidedTurn, true);
  assert.equal(undecided.settledAt, null);
  const used = judgeLatePrompt(undecided, ["wrap-up"]);
  assert.equal(used.wake, false);
  assert.deepEqual(used.next.pendingNudges, []);
  assert.equal(used.next.undecidedTurn, false);
  assert.equal(judgeLatePrompt(undecided, ["someone else"]).wake, true);
  assert.deepEqual(judgeLatePrompt(pending, ["someone else"]), { next: pending, wake: false }, "no undecided turn to decide");
});

test("an undecided turn that ends without a prompt: the session's own where prompts are reported, the oldest delivery elsewhere", () => {
  const undecided = wait({ settledAt: null, undecidedTurn: true, pendingNudges: [nudge("first"), nudge("second")] });
  assert.equal(judgeTurn(undecided, reading({ ...turnEnd, reportsPrompts: true })).wake, true);
  const fifo = judgeTurn(undecided, reading({ ...turnEnd, reportsPrompts: false }));
  assert.equal(fifo.wake, false);
  assert.deepEqual(fifo.next.pendingNudges.map((n) => n.key), ["second"]);
  assert.equal(fifo.next.settledAt, 5_000);
  const contestedOldest = wait({ settledAt: null, undecidedTurn: true, pendingNudges: [nudge("first", ["person-1"])] });
  assert.equal(judgeTurn(contestedOldest, reading({ ...turnEnd, reportsPrompts: false })).wake, true);
});

test("an undecided turn whose only delivery was withdrawn before it ended is the session's own wake", () => {
  // Start: a delivery is pending, so the promptless turn is stored undecided. The delivery is then
  // withdrawn (it provably never landed). At the turn's end nothing is left that could be its
  // nudge, so on a session without prompts the turn is the wake rather than holding the wait on.
  const undecided = judgeTurn(wait({ pendingNudges: [nudge("wrap-up")] }), reading({ ...turnStart, reportsPrompts: false })).next;
  assert.equal(undecided.undecidedTurn, true);
  const withdrawn = recordAutomatedDelivery(undecided, { at: 3_000, key: "wrap-up", released: true });
  assert.deepEqual(withdrawn.pendingNudges, []);
  assert.equal(judgeTurn(withdrawn, reading({ ...turnEnd, reportsPrompts: false })).wake, true);
  // A turn that declared the wait again still keeps it.
  const kept = judgeTurn({ ...withdrawn, redeclaredInTurn: true }, reading({ ...turnEnd, reportsPrompts: false }));
  assert.equal(kept.wake, false);
  assert.equal(kept.next.settledAt, 5_000);
});

test("a turn the session declared its wait again in is still decided, but never ends the wait", () => {
  const redeclared = wait({ settledAt: null, undecidedTurn: true, redeclaredInTurn: true, pendingNudges: [nudge("first")] });
  const ownEnd = judgeTurn(redeclared, reading({ ...turnEnd, reportsPrompts: true }));
  assert.equal(ownEnd.wake, false);
  assert.deepEqual(ownEnd.next.pendingNudges.map((n) => n.key), ["first"], "its own turn uses no delivery up");
  assert.equal(ownEnd.next.redeclaredInTurn, false);
  const fifo = judgeTurn(redeclared, reading({ ...turnEnd, reportsPrompts: false }));
  assert.deepEqual(fifo.next.pendingNudges, [], "without prompts its end still uses up the delivery that started it");
  const late = judgeLatePrompt(redeclared, ["someone else"]);
  assert.equal(late.wake, false);
  assert.equal(late.next.undecidedTurn, false);
});

test("a turn a session without hooks starts and ends between sweeps is judged from the transcript's turn marker", () => {
  assert.equal(judgeTurn(wait(), reading({ passiveTurnStartedAt: 3_000 })).wake, true);
  const pending = wait({ pendingNudges: [nudge("wrap-up")] });
  const used = judgeTurn(pending, reading({ passiveTurnStartedAt: 3_000 }));
  assert.equal(used.wake, false);
  assert.deepEqual(used.next.pendingNudges, []);
  assert.equal(used.next.judgedTurnAt, 3_000, "the marker is kept as judged, so the same marker is never judged twice");
  assert.equal(used.next.settledAt, 2_000, "the settle is not moved to the sweep's own time");
  assert.equal(judgeTurn(pending, reading({ passiveTurnStartedAt: 1_500 })).next, pending, "a marker from before the settle");
});

test("passive turns are compared in transcript time: a late sweep of an automated turn does not hide the real wake after it", () => {
  // An automated delivery's turn ends at 3,000 and the session's real wake starts at 4,000, also
  // finishing before the next look. The sweep at 5,000 is still reading the automated turn's idle
  // report, whose marker is that turn's start.
  const pending = wait({ pendingNudges: [{ at: 2_400, key: "wrap-up" }] });
  const automated = judgeTurn(pending, reading({ now: 5_000, passiveTurnStartedAt: 2_500, reportsPrompts: false }));
  assert.equal(automated.wake, false);
  assert.deepEqual(automated.next.pendingNudges, []);
  assert.equal(automated.next.judgedTurnAt, 2_500, "the judged turn is kept in transcript time, not as the sweep's 5,000");
  const again = judgeTurn(automated.next, reading({ now: 5_500, passiveTurnStartedAt: 2_500, reportsPrompts: false }));
  assert.equal(again.next, automated.next, "the same transcript read again changes nothing");
  const real = judgeTurn(automated.next, reading({ now: 6_000, passiveTurnStartedAt: 4_000, reportsPrompts: false }));
  assert.equal(real.wake, true, "the real wake's 4,000 start is past the judged turn, though before the 5,000 sweep");
});

test("an unchanged transcript read never spends a second delivery", () => {
  const two = wait({ pendingNudges: [nudge("first"), nudge("second")] });
  const once = judgeTurn(two, reading({ passiveTurnStartedAt: 3_000 })).next;
  assert.deepEqual(once.pendingNudges.map((n) => n.key), ["second"]);
  assert.equal(judgeTurn(once, reading({ now: 9_000, passiveTurnStartedAt: 3_000 })).next, once);
});

test("the declaring turn's end keeps that turn's transcript marker, so a later turn is judged against it, not the sweep", () => {
  const declared = wait({ settledAt: null });
  const settled = judgeTurn(declared, reading({ ...turnEnd, now: 5_000, passiveTurnStartedAt: 1_500 })).next;
  assert.equal(settled.settledAt, 5_000);
  assert.equal(settled.judgedTurnAt, 1_500);
  assert.equal(judgeTurn(settled, reading({ now: 6_000, passiveTurnStartedAt: 1_500 })).next, settled, "the declaring turn is not judged again");
  assert.equal(judgeTurn(settled, reading({ now: 6_000, passiveTurnStartedAt: 4_000 })).wake, true, "a turn that began before the sweep settled");
});

test("automated deliveries: one entry each, a release removes only its own, and one just after a person's same words starts contested", () => {
  const once = recordAutomatedDelivery(wait(), { at: 3_000, key: "wrap-up", released: false });
  const twice = recordAutomatedDelivery(once, { at: 3_500, key: "wrap-up", released: false });
  assert.deepEqual(twice.pendingNudges.map((n) => n.at), [3_000, 3_500]);
  assert.deepEqual(recordAutomatedDelivery(twice, { at: 3_500, key: "wrap-up", released: true }).pendingNudges.map((n) => n.at), [3_000]);
  assert.equal(recordAutomatedDelivery(twice, { at: 9_999, key: "wrap-up", released: true }), twice, "an unknown release changes nothing");
  const contested = recordAutomatedDelivery(wait(), { at: 3_000, key: "wrap-up", released: false }, ["person-1"]);
  assert.equal(nudgeContested(contested.pendingNudges[0]!), true);
});

test("a person's send contests every pending delivery of its words, and its release removes only its own claim", () => {
  const pending = wait({ pendingNudges: [nudge("wrap-up"), nudge("other")] });
  const one = recordPersonDelivery(pending, { id: "p-1", key: "wrap-up", released: false });
  const two = recordPersonDelivery(one, { id: "p-2", key: "wrap-up", released: false });
  assert.deepEqual(two.pendingNudges[0]!.contestedBy, ["p-1", "p-2"]);
  assert.equal(two.pendingNudges[1]!.contestedBy, undefined, "a delivery in other words is not contested");
  const back = recordPersonDelivery(two, { id: "p-2", key: "wrap-up", released: true });
  assert.deepEqual(back.pendingNudges[0]!.contestedBy, ["p-1"], "the release took another send's claim");
  const clear = recordPersonDelivery(back, { id: "p-1", key: "wrap-up", released: true });
  assert.equal(clear.pendingNudges[0]!.contestedBy, undefined);
  assert.equal(recordPersonDelivery(pending, { id: "p-3", key: "nothing pending", released: false }), pending);
});
