import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-pending-turn-db-"));
process.env.MISSION_HOME = home;

const {
  claimNextPendingTurn,
  clearPendingTurns,
  createPendingTurn,
  deleteClaimedPendingTurn,
  listPendingTurns,
  markPendingTurnUncertain,
  recallPendingTurn,
  recoverSendingPendingTurns,
  rekeyPendingTurns,
  releasePendingTurn,
  resolveUncertainPendingTurn,
  retryPendingTurn,
} = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function add(noteKey: string, id: string, text = id, now = 10) {
  return createPendingTurn({ id, noteKey, text, now });
}

test("pending turns receive durable FIFO sequence numbers", () => {
  const key = "fifo";
  assert.equal(add(key, "fifo-a", "first").seq, 0);
  assert.equal(add(key, "fifo-b", "second").seq, 1);
  assert.equal(add(key, "fifo-c", "third").seq, 2);
  assert.deepEqual(
    listPendingTurns(key).map((turn) => [turn.id, turn.text, turn.state, turn.revision]),
    [
      ["fifo-a", "first", "queued", 0],
      ["fifo-b", "second", "queued", 0],
      ["fifo-c", "third", "queued", 0],
    ],
  );
  clearPendingTurns(key);
});

test("recall is newest-only and protected by the projected revision", () => {
  const key = "recall";
  const first = add(key, "recall-a");
  const second = add(key, "recall-b");
  assert.equal(recallPendingTurn(key, first.id, first.revision), null, "an older row cannot jump the stack");
  assert.equal(recallPendingTurn(key, second.id, second.revision + 1), null, "a stale UI cannot delete it");
  assert.equal(recallPendingTurn(key, second.id, second.revision)?.text, "recall-b");
  assert.deepEqual(listPendingTurns(key).map((turn) => turn.id), [first.id]);
  clearPendingTurns(key);
});

test("claim is FIFO, single-flight, and completion is revision guarded", () => {
  const key = "claim";
  add(key, "claim-a");
  add(key, "claim-b");
  const first = claimNextPendingTurn(key, 20);
  assert.equal(first?.id, "claim-a");
  assert.equal(first?.state, "sending");
  assert.equal(first?.revision, 1);
  assert.equal(claimNextPendingTurn(key, 21), null, "a second delivery cannot overlap");
  assert.equal(deleteClaimedPendingTurn(first!.id, 0), false);
  assert.equal(deleteClaimedPendingTurn(first!.id, first!.revision), true);
  assert.equal(claimNextPendingTurn(key, 22)?.id, "claim-b");
  clearPendingTurns(key);
});

test("positive refusal requeues while ambiguity blocks automatic delivery", () => {
  const key = "transitions";
  add(key, "transition-a");
  const claimed = claimNextPendingTurn(key, 20)!;
  const released = releasePendingTurn(claimed.id, claimed.revision, "driver was busy", 21)!;
  assert.equal(released.state, "queued");
  assert.equal(released.claimedAt, null);
  assert.equal(released.lastError, "driver was busy");

  const claimedAgain = claimNextPendingTurn(key, 22)!;
  const uncertain = markPendingTurnUncertain(
    claimedAgain.id,
    claimedAgain.revision,
    "paste may have landed",
    23,
  )!;
  assert.equal(uncertain.state, "uncertain");
  assert.equal(claimNextPendingTurn(key, 24), null);
  assert.equal(retryPendingTurn(uncertain.id, uncertain.revision + 1, 25), null, "stale retry is refused");
  const retried = retryPendingTurn(uncertain.id, uncertain.revision, 25)!;
  assert.equal(retried.state, "queued");
  assert.equal(retried.lastError, null);
  clearPendingTurns(key);
});

test("an uncertain row can be marked sent only with its current revision", () => {
  const key = "resolve";
  add(key, "resolve-a");
  const claim = claimNextPendingTurn(key, 20)!;
  const uncertain = markPendingTurnUncertain(claim.id, claim.revision, "unknown", 21)!;
  assert.equal(resolveUncertainPendingTurn(uncertain.id, uncertain.revision - 1), false);
  assert.equal(resolveUncertainPendingTurn(uncertain.id, uncertain.revision), true);
  assert.deepEqual(listPendingTurns(key), []);
});

test("startup recovery never resends a row claimed by the previous daemon", () => {
  const key = "recovery";
  add(key, "recovery-a");
  const claim = claimNextPendingTurn(key, 20)!;
  assert.equal(recoverSendingPendingTurns(30), 1);
  const recovered = listPendingTurns(key)[0]!;
  assert.equal(recovered.state, "uncertain");
  assert.equal(recovered.revision, claim.revision + 1);
  assert.match(recovered.lastError ?? "", /restarted during delivery/);
  clearPendingTurns(key);
});

test("binding a real conversation key appends synthetic-key rows without reordering", () => {
  const from = "sdk:synthetic";
  const to = "agent:real";
  add(to, "real-a", "older durable row", 1);
  add(from, "synthetic-a", "first pre-bind row", 2);
  add(from, "synthetic-b", "second pre-bind row", 3);
  assert.equal(rekeyPendingTurns(from, to, 4), true);
  assert.deepEqual(listPendingTurns(from), []);
  assert.deepEqual(
    listPendingTurns(to).map((turn) => [turn.id, turn.seq, turn.noteKey]),
    [
      ["real-a", 0, to],
      ["synthetic-a", 1, to],
      ["synthetic-b", 2, to],
    ],
  );
  clearPendingTurns(to);
});

test("reset cleanup can preserve only an ambiguous claimed row", () => {
  const key = "reset-preserve";
  add(key, "reset-preserve-claimed", "possibly delivered");
  add(key, "reset-preserve-queued", "safe to discard");
  const claimed = claimNextPendingTurn(key, 20)!;
  const uncertain = markPendingTurnUncertain(
    claimed.id,
    claimed.revision,
    "reset crossed the delivery boundary",
    21,
  )!;

  assert.equal(clearPendingTurns(key, [uncertain.id]), 1);
  assert.deepEqual(
    listPendingTurns(key).map((turn) => [turn.id, turn.state]),
    [[uncertain.id, "uncertain"]],
  );
  clearPendingTurns(key);
});
