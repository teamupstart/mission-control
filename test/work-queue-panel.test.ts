import { test } from "node:test";
import assert from "node:assert/strict";
import { itemLabel, moveTarget, queueChipView, queueChipVisible } from "../src/web/lib/queue.ts";
import { wrapupAskCopy } from "../src/shared/queue.ts";
import { foremanSendBlock } from "../src/web/lib/foreman.ts";
import type { ForemanSendBlock } from "../src/web/lib/foreman.ts";
import type { SessionQueueSummary, WorkItem, WorkItemState } from "../src/shared/types.ts";

// The work-queue panel's pure presentation logic. It lives in src/web/lib precisely
// so it can be checked here without a DOM - both of these were bugs a rendering test
// would have had to be lucky to catch, and a table catches by construction.

let n = 0;
function mkItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `i${++n}`,
    noteKey: "k",
    seq: 0,
    intent: "add the retry",
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
    createdAt: 0,
    updatedAt: 0,
    sentAt: null,
    completedAt: null,
    ...over,
  };
}

// ---- itemLabel ----

test("an APPROVED draft never still asks for an OK", () => {
  // The label read `state` alone, so the moment the human approved, the card went on
  // demanding an OK while the button that would give one was already gone (Approve is
  // gated on `!approvedAt`). Nothing on screen said the click had registered, and the
  // wait is long: the worker's next tick is IDLE_MS away at best, behind a serial
  // pass that can block minutes on a `claude -p`.
  const drafted = mkItem({ state: "proposed" });
  assert.equal(itemLabel(drafted), "drafted - needs your OK");

  const approved = mkItem({ state: "proposed", approvedAt: 123 });
  assert.notEqual(itemLabel(approved), "drafted - needs your OK");
  assert.match(itemLabel(approved), /approved/i);
});

test("itemLabel is unchanged for every state consent doesn't apply to", () => {
  // `approvedAt` is only ever set on a draft, but it's a stamp rather than a flag -
  // it survives the state moving on. It must not rewrite the label of an item that is
  // being delivered, worked, or already done.
  const states: WorkItemState[] = [
    "queued", "sending", "awaiting_pickup", "in_progress", "verifying",
    "verified", "escalated", "cancelled",
  ];
  for (const state of states) {
    assert.equal(
      itemLabel(mkItem({ state, approvedAt: 123 })),
      itemLabel(mkItem({ state })),
      `${state} reads the same either way`,
    );
  }
  assert.equal(itemLabel(mkItem({ state: "verified", approvedAt: 123 })), "done");
});

// ---- moveTarget: the keyboard reorder ----

test("moveTarget walks a waiting item one place, and stops at the ends", () => {
  const a = mkItem({ id: "a", state: "queued" });
  const b = mkItem({ id: "b", state: "queued" });
  const c = mkItem({ id: "c", state: "queued" });
  const items = [a, b, c];

  assert.equal(moveTarget(items, b, -1), 0);
  assert.equal(moveTarget(items, b, 1), 2);
  assert.equal(moveTarget(items, a, -1), -1, "nowhere above the first");
  assert.equal(moveTarget(items, c, 1), -1, "nowhere below the last");
});

test("moveTarget steps OVER done and in-flight rows, never onto them", () => {
  // The same rule the drop handler enforces: a waiting item renumbered in among the
  // completed work doesn't change delivery order (`nextSendable` skips terminal
  // items) but does break the "in the order you authored it" contract - and makes the
  // done/waiting split unreadable.
  const done = mkItem({ id: "done", state: "verified" });
  const flight = mkItem({ id: "flight", state: "in_progress" });
  const w1 = mkItem({ id: "w1", state: "queued" });
  const w2 = mkItem({ id: "w2", state: "proposed" });
  const items = [done, flight, w1, w2];

  // w1's only legal move up is past BOTH the in-flight and done rows, to index 0.
  assert.equal(moveTarget(items, w1, -1), -1, "no waiting row above it to swap with");
  assert.equal(moveTarget(items, w1, 1), 3, "down onto the next waiting row");
  assert.equal(moveTarget(items, w2, -1), 2);
  assert.equal(moveTarget(items, w2, 1), -1);
});

test("moveTarget returns -1 for an item that isn't in the list", () => {
  assert.equal(moveTarget([mkItem({ id: "a" })], mkItem({ id: "ghost" }), 1), -1);
});

// ---- the hint: what the panel owes you about items that aren't moving ----

const hint = (over: Partial<Parameters<typeof foremanSendBlock>[0]> = {}): ForemanSendBlock =>
  foremanSendBlock({
    enabled: true,
    invited: true,
    mode: "live",
    allowlisted: true,
    cwd: "/repo",
    ...over,
  });

test("a live, allowlisted, enabled, invited queue says nothing - the panel already shows it", () => {
  assert.equal(hint(), null);
});

test("Foreman being off outranks whatever the mode and allowlist would say", () => {
  // It short-circuits the worker's loop before it ever reads a queue, so "it will
  // draft each item and wait for your Approve" would describe a draft that is never
  // coming - and an item sitting there forever under that sentence reads as a bug in
  // the queue rather than a switch nobody flipped.
  assert.equal(hint({ enabled: false }), "foreman-off");
  assert.equal(hint({ enabled: false, mode: "dry-run" }), "foreman-off");
  assert.equal(hint({ enabled: false, allowlisted: false, cwd: null }), "foreman-off");
  // ...including over the invite. Inviting Foreman into a session while Foreman is off
  // changes nothing on screen, so it is the wrong first move to recommend.
  assert.equal(hint({ enabled: false, invited: false }), "foreman-off");
});

test("an uninvited session outranks the mode and the allowlist, and loses only to the switch", () => {
  // The worker skips an uninvited session in EVERY mode, so "it will draft each item and
  // wait for your Approve" is a sentence about a draft that is never coming - the same
  // failure `foreman-off` sits first to prevent, one level down. The allowlist and the cwd
  // are questions about a live send that is not being attempted here at all.
  assert.equal(hint({ invited: false }), "not-invited");
  assert.equal(hint({ invited: false, mode: "dry-run" }), "not-invited");
  assert.equal(hint({ invited: false, allowlisted: false }), "not-invited");
  assert.equal(hint({ invited: false, cwd: null }), "not-invited");
  assert.equal(hint({ invited: false, enabled: false }), "foreman-off");
});

test("a session with NO cwd is told why it only ever gets drafts", () => {
  // `foremanMayActLive` returns false on a null cwd, so this session drafts forever.
  // Nothing else says so: `queueBlockedReason` doesn't gate on cwd and the note key
  // never needs one, so a session whose cwd discovery failed while its hooks report
  // gets a fully working panel whose items sit `proposed` under no explanation at
  // all - which is the exact silence this hint exists to break.
  assert.equal(hint({ cwd: null }), "no-cwd");
  assert.equal(
    hint({ cwd: null, allowlisted: false }),
    "no-cwd",
    "a null cwd can't be allowlisted, so this must not fall through to the sentence that names one",
  );
});

test("a live but un-allowlisted repo is told which directory to add", () => {
  assert.equal(hint({ allowlisted: false }), "not-allowlisted");
});

test("a non-live mode explains the drafts, whatever the allowlist says", () => {
  // Approve is the gate in every non-live mode, so the allowlist is not what is
  // stopping the send and naming it would send the human to fix the wrong thing.
  assert.equal(hint({ mode: "dry-run" }), "drafts-only");
  assert.equal(hint({ mode: "dry-run", allowlisted: false }), "drafts-only");
  assert.equal(hint({ mode: "semi-auto", cwd: null }), "drafts-only");
});

// ---- the chip: what a card claims about a batch you can't see ----
//
// This chip is the LAST surviving signal for a stopped session: an exited card renders
// no ActionBar, so there is no Queue button, and this is the only way back into the
// drawer. A label that reads as clean success on a batch Foreman actually gave up on is
// worse than the unreachability it was added to fix - so these pin the honesty.

function mkSummary(over: Partial<SessionQueueSummary> = {}): SessionQueueSummary {
  return {
    openCount: 0,
    totalCount: 0,
    inFlightState: null,
    inFlightIntent: null,
    round: 0,
    blockingGaps: 0,
    verifiedCount: 0,
    escalatedCount: 0,
    drained: false,
    wrapupAskedAt: null,
    wrapupAnswered: false,
    updatedAt: 0,
    ...over,
  };
}

test("a queue with work still in it counts what's waiting, quietly", () => {
  const chip = queueChipView(mkSummary({ openCount: 3, totalCount: 3 }));
  assert.equal(chip.label, "3 queued");
  assert.equal(chip.attention, false);
});

test("a batch that all landed says so, and doesn't call itself queued", () => {
  // `openCount` excludes every terminal state, so once the batch is through there is
  // nothing "queued" left to claim - the old label said "3 queued" here.
  const chip = queueChipView(mkSummary({ openCount: 0, totalCount: 3, verifiedCount: 3 }));
  assert.equal(chip.label, "3 done");
  assert.equal(chip.attention, false);
});

test("an escalation is never hidden behind a count that reads as success", () => {
  // The regression this exists for. `escalated` is TERMINAL, so it leaves `openCount`
  // at zero exactly like a verified item does - and a chip that only counts what's
  // through reported "3 finished" over a batch Foreman gave up on two thirds of.
  const chip = queueChipView(
    mkSummary({ openCount: 0, totalCount: 3, verifiedCount: 1, escalatedCount: 2 }),
  );
  assert.equal(chip.label, "1 done · 2 escalated");
  assert.equal(chip.attention, true, "work that stopped short must not wear the neutral tone");
  assert.doesNotMatch(chip.title, /all landed/, "the tooltip must not claim it finished");
  assert.match(chip.title, /escalated/);
});

test("a batch Foreman gave up on entirely claims nothing was done", () => {
  // Not "0 done · 3 escalated": a zero is noise, and this is the whole story.
  const chip = queueChipView(mkSummary({ openCount: 0, totalCount: 3, escalatedCount: 3 }));
  assert.equal(chip.label, "3 escalated");
  assert.equal(chip.attention, true);
});

test("an escalation shows even while the rest of the batch is still running", () => {
  // Terminal and open items coexist, so gating the call-out on a drained queue would
  // hide an escalation behind every batch that still had work left in it.
  const chip = queueChipView(
    mkSummary({
      openCount: 3,
      totalCount: 6,
      verifiedCount: 1,
      escalatedCount: 2,
      inFlightState: "in_progress",
    }),
  );
  assert.equal(chip.label, "3 queued · 2 escalated");
  assert.equal(chip.attention, true);
});

test("the in-flight intent is what the tooltip leads with while one is running", () => {
  const chip = queueChipView(
    mkSummary({ openCount: 2, totalCount: 2, inFlightIntent: "add the retry" }),
  );
  assert.match(chip.title, /add the retry/);
});

test("one escalated item is spoken about in the singular", () => {
  const chip = queueChipView(mkSummary({ openCount: 0, totalCount: 1, escalatedCount: 1 }));
  assert.equal(chip.label, "1 escalated");
  assert.match(chip.title, /1 of this session's 1 queued item /);
  assert.doesNotMatch(chip.title, /items/);
});

// ---- done is what LANDED, not what merely stopped moving ----
//
// The bug this table exists for: `done` used to be reckoned as totalCount - openCount
// - escalatedCount, i.e. "terminal minus the failure I thought of". `cancelled` is
// terminal and is NOT escalated, so it fell straight into the win column and a
// cancelled batch reported itself as done. It is reachable today without touching this
// file - SetWorkItemStateSchema accepts it and PUT /queue/:itemId/state hands it to
// setState - so this is a live lie, not a hypothetical one. Reading `verifiedCount`
// directly is what fixes it, and what keeps the NEXT terminal state from doing it
// again: anything that isn't verified counts as unfinished by construction.

test("a cancelled item never counts as done", () => {
  // One verified, one cancelled: cancelled is terminal so openCount is 0, and the old
  // subtraction called both of them done.
  const chip = queueChipView(mkSummary({ openCount: 0, totalCount: 2, verifiedCount: 1 }));
  assert.equal(chip.label, "1 done · 1 stopped");
  assert.equal(chip.attention, true, "work that never landed must not wear the neutral tone");
  assert.doesNotMatch(chip.title, /all landed/);
});

test("a wholly cancelled batch claims nothing landed", () => {
  const chip = queueChipView(mkSummary({ openCount: 0, totalCount: 3 }));
  assert.equal(chip.label, "3 stopped");
  assert.equal(chip.attention, true);
});

test("a terminal state nobody enumerated still lands outside the win column", () => {
  // The property, stated directly: whatever the summary can't account for as verified
  // or escalated is unfinished. A new terminal state must not be able to join `done`
  // by default - that default is the whole bug.
  for (const [total, verified, escalated] of [
    [1, 0, 0],
    [4, 1, 1],
    [9, 5, 0],
  ] as const) {
    const chip = queueChipView(
      mkSummary({ openCount: 0, totalCount: total, verifiedCount: verified, escalatedCount: escalated }),
    );
    assert.match(chip.label, new RegExp(`${total - verified - escalated} stopped`));
    assert.equal(chip.attention, true);
  }
});

test("escalated and cancelled are counted apart, not lumped together", () => {
  // Both are unfinished, but "Foreman gave up" and "you called it off" are different
  // things to walk back into, and the chip is the only thing left saying which.
  const chip = queueChipView(
    mkSummary({ openCount: 0, totalCount: 4, verifiedCount: 1, escalatedCount: 2 }),
  );
  assert.equal(chip.label, "1 done · 2 escalated · 1 stopped");
  assert.match(chip.title, /3 of this session's 4 queued items never landed \(2 escalated to you\)/);
});

test("the counts never go negative when the summary can't be reconciled", () => {
  // Belt and braces: the parts come from one projection, but a label reading
  // "-2 stopped" would be a worse bug than whatever produced the mismatch.
  const chip = queueChipView(mkSummary({ openCount: 0, totalCount: 1, verifiedCount: 5 }));
  assert.doesNotMatch(chip.label, /-/);
});

// ---- the prompted trigger's ask, which lives on a row with NO items ----

test("an outstanding wrap-up ask makes the chip render on an itemless row", () => {
  // The `prompted` trigger fires only on a checkout with no work queue, so its ask
  // lands on a zero-item row. Gated on `totalCount > 0`, the chip never rendered and
  // the alert pointed the human at a card showing no queue affordance at all.
  assert.equal(queueChipVisible(mkSummary({ totalCount: 0, wrapupAskedAt: 123 })), true);
});

test("an ANSWERED ask leaves nothing behind on an itemless row", () => {
  // `wrapupAskedAt` is never cleared - on the drain path it doubles as the once-only
  // guard - so keying visibility on it alone would grow a permanent, contentless chip
  // on every session that ever wrapped up.
  assert.equal(
    queueChipVisible(mkSummary({ totalCount: 0, wrapupAskedAt: 123, wrapupAnswered: true })),
    false,
  );
  assert.equal(queueChipVisible(mkSummary({ totalCount: 0 })), false);
});

test("an itemless chip says the one thing it has to say instead of an empty tally", () => {
  const chip = queueChipView(mkSummary({ totalCount: 0, wrapupAskedAt: 123 }));
  assert.ok(chip.label.trim().length > 0);
  assert.equal(chip.attention, true);
});

test("the Ship it? copy never claims a queue drained when there was no queue", () => {
  // The card and the toast come out of ONE call precisely so they cannot drift into
  // describing the same ask two different ways - which is how a queue-drain sentence
  // came to be shown on a session that never had a queue.
  const prompted = wrapupAskCopy(false);
  assert.doesNotMatch(prompted.card, /queue/i);
  assert.doesNotMatch(prompted.alert, /queue/i);

  const drain = wrapupAskCopy(true);
  assert.match(drain.card, /queue/i);
  assert.match(drain.alert, /queue/i);
  assert.notEqual(prompted.card, drain.card);
});
