// F5: the turn log and the approval words (spec 7.9). Real SQLite in a temp home, no daemon.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-home-dispatch-turns-"));
process.env.MISSION_HOME = home;

const { openDb, closeDb } = await import("../src/server/db.ts");
const turns = await import("../src/server/home-dispatch/turns.ts");
const sessions = await import("../src/server/home-dispatch/sessions.ts");
const { registerHomeSession } = sessions;
const { HOME_DISPATCH_RETENTION_MS, TURN_EXCERPT_MAX } = await import("../src/shared/home-dispatch.ts");

after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
beforeEach(() => {
  const d = openDb();
  for (const table of ["home_dispatch_sessions", "home_dispatch_turns", "home_dispatch_receipts"]) d.exec(`DELETE FROM ${table}`);
  turns.resetTurnLogCleanupClock();
});

const register = (sessionId = "s1") =>
  registerHomeSession({ sessionId, harness: "claude", cwd: home, hookVersion: null, claudePid: null, source: "startup", entrypoint: "cli", launcherDisabled: false, terminal: null });

test("F5 approval: the words that approve, as whole words", () => {
  for (const text of ["approve", "I approve", "Approved.", "yes, publish", "publish it", "APPROVE IT", "ok, approve 7a1c2d"]) {
    assert.equal(turns.containsApproval(text), true, text);
  }
  for (const text of ["disapprove", "approval pending", "approver", "unapproved"]) {
    assert.equal(turns.containsApproval(text), false, text);
  }
});

test("F5 approval: a negated sentence never approves (the seven refusals of the spec)", () => {
  for (const text of [
    "I do not think we should approve this yet",
    "don't go ahead and approve",
    "do you approve?",
    "I can't approve until I read it",
    "I won't approve this",
    "no, wait, approve it only after the tests pass",
    "why would I approve that",
  ]) {
    assert.equal(turns.containsApproval(text), false, text);
  }
});

test("F5 approval: the negation check covers the whole sentence before the word, not three words", () => {
  assert.equal(turns.containsApproval("I have read every line of this long plan and I do not yet approve it"), false);
  assert.equal(turns.containsApproval("Never, under any circumstances that we have discussed so far, approve this"), false);
  assert.equal(turns.containsApproval("don’t approve"), false, "a curly apostrophe is the same word");
});

test("F5 approval: a negation in another sentence, or after the word, does not cancel it", () => {
  assert.equal(turns.containsApproval("Not sure about the second step. Approve."), true);
  assert.equal(turns.containsApproval("Approve. Wait, I mean it."), true);
  assert.equal(turns.containsApproval("Is this fine? Approve."), true, "a question before does not poison the next sentence");
  assert.equal(turns.containsApproval("Approve it?"), false, "a question never approves");
});

test("F5 turns: the excerpt is at most 120 code points with whitespace collapsed, and never the full prompt", () => {
  register();
  const long = "word  \n\t".repeat(80);
  const turn = turns.openTurn({ sessionId: "s1", prompt: long });
  assert.ok(Array.from(turn.excerpt).length <= TURN_EXCERPT_MAX);
  assert.ok(!/\s{2}/.test(turn.excerpt));
  const emoji = turns.openTurn({ sessionId: "s1", prompt: "\u{1F600}".repeat(200) });
  assert.equal(Array.from(emoji.excerpt).length, TURN_EXCERPT_MAX, "counted in code points, not UTF-16 units");
  const stored = openDb().prepare("SELECT excerpt FROM home_dispatch_turns").all() as Array<{ excerpt: string }>;
  for (const row of stored) assert.ok(Array.from(row.excerpt).length <= TURN_EXCERPT_MAX);
});

test("F5 turns: approval and any 6-hex tokens are recorded, lowercased once each", () => {
  register();
  const turn = turns.openTurn({ sessionId: "s1", prompt: "approve 7A1C2D and 7a1c2d, not ffffffff or 12345" });
  assert.equal(turn.containsApproval, true);
  assert.deepEqual(turn.mentionedHashes, ["7a1c2d"]);
  const plain = turns.openTurn({ sessionId: "s1", prompt: "what is in the diff?" });
  assert.equal(plain.containsApproval, false);
  assert.deepEqual(plain.mentionedHashes, []);
});

test("F5 turns: opening a turn closes the open one, and Stop closes the current one", () => {
  register();
  const first = turns.openTurn({ sessionId: "s1", prompt: "one", now: 1_000 });
  assert.equal(first.closedAt, null);
  const second = turns.openTurn({ sessionId: "s1", prompt: "two", now: 2_000 });
  const all = turns.listTurns("s1");
  assert.equal(all[0]!.closedAt, 2_000, "the earlier turn closed when the next opened");
  assert.equal(second.closedAt, null);
  assert.equal(turns.latestTurn("s1")!.promptId, second.promptId);
  assert.equal(turns.closeTurn("s1", 3_000), true);
  assert.equal(turns.latestTurn("s1")!.closedAt, 3_000);
  assert.equal(turns.closeTurn("s1", 4_000), false, "nothing open the second time");
  const row = openDb().prepare("SELECT last_turn_at, last_stop_at FROM home_dispatch_sessions WHERE session_id = 's1'").get() as { last_turn_at: number; last_stop_at: number };
  assert.deepEqual({ ...row }, { last_turn_at: 2_000, last_stop_at: 4_000 });
});

test("F5 turns: cards shown are recorded with their key, change time, state and revision hash", () => {
  register();
  const turn = turns.openTurn({ sessionId: "s1", prompt: "hello" });
  const cards = [{ key: "r1", changedAt: 5, state: "waiting", revisionHash: "7a1c2d" }];
  turns.recordCardsShown("s1", turn.promptId, cards);
  assert.deepEqual(turns.latestTurn("s1")!.cardsShown, cards);
});

test("F5 turns: the SessionStart summary card turn has an empty excerpt and is not the first turn", () => {
  register();
  turns.recordSessionStartCards("s1", [{ key: "r1", changedAt: 1, state: "waiting", revisionHash: null }]);
  assert.equal(sessions.getHomeSession("s1")!.lastTurnAt, null, "the summary card is not a person's turn");
  assert.equal(turns.latestTurn("s1")!.excerpt, "");
  turns.openTurn({ sessionId: "s1", prompt: "first real message" });
  assert.notEqual(sessions.getHomeSession("s1")!.lastTurnAt, null, "a person's turn stamps last_turn_at");
  turns.recordSessionStartCards("s1", []);
  assert.equal(turns.listTurns("s1").length, 2, "a quiet start writes no row");
});

test("F5 turns: turns and receipts older than 7 days are deleted, newer ones kept", () => {
  register();
  const now = 10 * HOME_DISPATCH_RETENTION_MS;
  turns.openTurn({ sessionId: "s1", prompt: "old", now: now - HOME_DISPATCH_RETENTION_MS - 1 });
  turns.openTurn({ sessionId: "s1", prompt: "fresh", now: now - 1_000 });
  const d = openDb();
  const receipt = d.prepare("INSERT INTO home_dispatch_receipts (review_id, task_id, session_id, surface, sent, from_words, created_at) VALUES (?, 't', 's1', 'home-session', 'x', NULL, ?)");
  receipt.run("old", now - HOME_DISPATCH_RETENTION_MS - 1);
  receipt.run("fresh", now - 1_000);
  assert.equal(turns.pruneExpiredHomeDispatchLog(now), 2);
  assert.deepEqual(turns.listTurns("s1").map((t) => t.excerpt), ["fresh"]);
  assert.deepEqual((d.prepare("SELECT review_id FROM home_dispatch_receipts").all() as Array<{ review_id: string }>).map((r) => r.review_id), ["fresh"]);
});

test("F5 turns: the seven-day cutoff is exclusive: a row exactly at the cutoff stays, one millisecond older goes", () => {
  register();
  const now = 10 * HOME_DISPATCH_RETENTION_MS;
  const cutoff = now - HOME_DISPATCH_RETENTION_MS;
  const d = openDb();
  const turn = d.prepare("INSERT INTO home_dispatch_turns (session_id, prompt_id, opened_at, excerpt) VALUES ('s1', ?, ?, ?)");
  const receipt = d.prepare("INSERT INTO home_dispatch_receipts (review_id, task_id, session_id, surface, sent, from_words, created_at) VALUES (?, 't', 's1', 'home-session', 'x', NULL, ?)");
  for (const [label, at] of [["before", cutoff - 1], ["at", cutoff], ["after", cutoff + 1]] as const) {
    turn.run(`p-${label}`, at, label);
    receipt.run(`r-${label}`, at);
  }
  assert.equal(turns.pruneExpiredHomeDispatchLog(now), 2, "one turn and one receipt");
  assert.deepEqual(turns.listTurns("s1").map((t) => t.excerpt), ["at", "after"]);
  const left = (d.prepare("SELECT review_id FROM home_dispatch_receipts ORDER BY created_at").all() as Array<{ review_id: string }>).map((r) => r.review_id);
  assert.deepEqual(left, ["r-at", "r-after"]);
});

test("F5 turns: opening a turn runs the daily cleanup once, not on every turn", () => {
  register();
  const d = openDb();
  const now = 20 * HOME_DISPATCH_RETENTION_MS;
  d.prepare("INSERT INTO home_dispatch_turns (session_id, prompt_id, opened_at, excerpt) VALUES ('s1', 'stale-1', ?, 'stale')").run(now - HOME_DISPATCH_RETENTION_MS - 5);
  turns.openTurn({ sessionId: "s1", prompt: "a", now });
  assert.equal(turns.listTurns("s1").some((t) => t.promptId === "stale-1"), false, "the first turn of the day prunes");
  d.prepare("INSERT INTO home_dispatch_turns (session_id, prompt_id, opened_at, excerpt) VALUES ('s1', 'stale-2', ?, 'stale')").run(now - HOME_DISPATCH_RETENTION_MS - 5);
  turns.openTurn({ sessionId: "s1", prompt: "b", now: now + 1_000 });
  assert.equal(turns.listTurns("s1").some((t) => t.promptId === "stale-2"), true, "the same day does not prune again");
  const day = 24 * 60 * 60 * 1000;
  turns.openTurn({ sessionId: "s1", prompt: "c", now: now + day - 1 });
  assert.equal(turns.listTurns("s1").some((t) => t.promptId === "stale-2"), true, "one millisecond short of a day: still no cleanup");
  turns.openTurn({ sessionId: "s1", prompt: "d", now: now + day });
  assert.equal(turns.listTurns("s1").some((t) => t.promptId === "stale-2"), false, "at the 24-hour boundary the cleanup runs again");
});
