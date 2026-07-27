import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: the fleet-wide episode ledger is the only cross-session read of the
// richest table in the app, and it arrives on databases that already have episodes in
// them. Two failures are being pinned, and neither shows up on a fresh install.
//
// 1. The MIGRATION. `cheap_action` and `divergence` are named by the INSERT, so a
//    database carrying `foreman_episodes` without them fails EVERY episode write - not
//    the new feature, the existing one. And the index the fleet-wide read needs cannot
//    live beside the CREATE TABLE block, because that block runs in full before
//    `migrate()` does; an index there naming a column an ALTER has not added yet throws
//    inside `openDb()` on first start, for every existing operator and never on the fresh
//    install it was tested against. So this file seeds a PRE-FEATURE database - the table
//    exactly as it stood before this phase - and hands it to `openDb()`. A fresh-schema
//    test passes with both `addColumn` calls deleted, which is the whole reason for the
//    ceremony below.
//
// 2. The ORDERING. `recentEpisodes` has no `note_key` predicate, so it is the one read
//    that can interleave sessions - and if it did not, the ledger would silently be one
//    session's history wearing a fleet-wide label.

// MISSION_HOME *is* the state dir, so the db lands at <home>/harness.db - the file db.ts
// opens below. It must be set before anything that resolves it is imported, which is why
// every server import in this file is dynamic.
const home = mkdtempSync(join(tmpdir(), "mission-foreman-episodes-db-"));
process.env.MISSION_HOME = home;

/**
 * `foreman_episodes` as it stood before this phase - i.e. what is actually on an
 * upgrading operator's disk. No `cheap_action`, no `divergence`, and no
 * `idx_foreman_episodes_recent`.
 */
function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS foreman_episodes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      note_key       TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      marker         TEXT NOT NULL,
      situation      TEXT NOT NULL,
      surface        TEXT NOT NULL,
      question       TEXT NOT NULL,
      pane           TEXT,
      menu           TEXT,
      review_id      TEXT,
      purpose        TEXT,
      brief          TEXT,
      recommendation TEXT,
      classification TEXT,
      confidence     REAL,
      tier           INTEGER,
      disposition    TEXT NOT NULL,
      last_action    TEXT,
      sent_text      TEXT,
      sent_option    TEXT,
      sent_by        TEXT,
      created_at     INTEGER NOT NULL,
      resolved_at    INTEGER,
      resolved_by    TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_foreman_episodes_marker
      ON foreman_episodes(note_key, marker);
  `);
  // One episode written by the old build, so the assertions below run against a table
  // that had rows before the ALTER rather than an empty one.
  raw
    .prepare(
      `INSERT INTO foreman_episodes
         (note_key, session_id, marker, situation, surface, question, disposition,
          tier, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    // Oldest of everything in this file, which is what it is: history from before the
    // feature. It keeps the ordering assertions below about the rows they name.
    .run("legacy-key", "proc:1", "m-legacy", "needs-input", "terminal", "Approve?", "answered", 2, 50);
  raw.close();
}

seedPreFeatureDb();

const db = await import("../src/server/db.ts");
const { MAX_ASK_PREVIEW } = await import("../src/shared/foreman-ask.ts");

after(() => rmSync(home, { recursive: true, force: true }));

// The moment of truth for the ordering rule: on a pre-feature database this either
// migrates cleanly or throws.
db.openDb();

function write(over: Partial<Parameters<typeof db.recordEpisode>[0]> = {}): void {
  db.recordEpisode({
    noteKey: "k1",
    sessionId: "s1",
    marker: "m1",
    situation: "needs-input",
    surface: "terminal",
    question: "Can I run the tests?",
    pane: null,
    menu: null,
    reviewId: null,
    purpose: null,
    brief: null,
    recommendation: null,
    classification: null,
    confidence: null,
    tier: 2,
    cheapAction: null,
    divergence: null,
    disposition: "answered",
    lastAction: null,
    sentText: null,
    sentOption: null,
    sentBy: null,
    createdAt: 5000,
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  });
}

// ---- the migration reached a database that already had the table --------------------

test("the shadow columns and the fleet-wide index land on a pre-feature database", () => {
  const raw = new DatabaseSync(join(home, "harness.db"));
  const cols = (
    raw.prepare(`PRAGMA table_info(foreman_episodes)`).all() as unknown as Array<{ name: string }>
  ).map((c) => c.name);
  assert.ok(cols.includes("cheap_action"), "cheap_action never reached an upgraded database");
  assert.ok(cols.includes("divergence"), "divergence never reached an upgraded database");

  // The index has to exist too - it is what stops the fleet-wide read being a full scan
  // plus a sort on the one table that grows without bound between prunes.
  const idx = (
    raw.prepare(`PRAGMA index_list(foreman_episodes)`).all() as unknown as Array<{ name: string }>
  ).map((i) => i.name);
  assert.ok(
    idx.includes("idx_foreman_episodes_recent"),
    "the (created_at DESC) index is missing - was it left beside the CREATE TABLE block?",
  );
  raw.close();
});

// The row the old build wrote must still read back, with the new fields as "not measured"
// rather than as anything the panel would render.
test("an episode written before the shadow columns reads back as not measured", () => {
  const [legacy] = db.episodesFor("legacy-key");
  assert.ok(legacy);
  assert.equal(legacy.cheapAction, null);
  assert.equal(legacy.divergence, null);
  // Still says what it always said.
  assert.equal(legacy.disposition, "answered");
  assert.equal(legacy.tier, 2);
});

// ---- the cross-session read ----------------------------------------------------------

test("recentEpisodes interleaves sessions, newest first", () => {
  write({ noteKey: "alpha", marker: "a1", createdAt: 100 });
  write({ noteKey: "beta", marker: "b1", createdAt: 300 });
  write({ noteKey: "alpha", marker: "a2", createdAt: 200 });
  write({ noteKey: "beta", marker: "b2", createdAt: 400 });

  const rows = db.recentEpisodes(100);
  // The four written here plus the seeded legacy row, newest first across ALL keys. The
  // per-session read cannot answer this question at all, which is why it existed.
  const ours = rows.filter((r) => r.noteKey === "alpha" || r.noteKey === "beta");
  assert.deepEqual(
    ours.map((r) => r.marker),
    ["b2", "b1", "a2", "a1"],
  );
  assert.ok(
    rows.some((r) => r.noteKey === "legacy-key"),
    "a row from another session key was not in the fleet-wide read",
  );
});

test("recentEpisodes respects its limit, taking the newest", () => {
  const rows = db.recentEpisodes(2);
  assert.equal(rows.length, 2);
  // Newest two of everything written so far: b2 (400) then b1 (300).
  assert.deepEqual(
    rows.map((r) => r.marker),
    ["b2", "b1"],
  );
});

// Two episodes recorded in the same millisecond still come back in the order they were
// written. `created_at` alone is not a total order on a table the worker can write twice
// inside one tick, and a ledger whose top row shuffles between polls reads as broken.
test("recentEpisodes breaks a created_at tie by id, not by scan order", () => {
  write({ noteKey: "tie", marker: "t1", createdAt: 9000 });
  write({ noteKey: "tie", marker: "t2", createdAt: 9000 });
  const ties = db.recentEpisodes(100).filter((r) => r.noteKey === "tie");
  assert.deepEqual(
    ties.map((r) => r.marker),
    ["t2", "t1"],
  );
});

// ---- the shadow measurement round-trips ----------------------------------------------

// The Inspector's finding on PR #285, pinned. `recentEpisodes` is polled every 4 seconds
// by the Settings page, and its first cut reused the full-episode row mapper - so every
// poll shipped up to a hundred captured terminal screens. Measured on a real 631-episode
// database, `pane` alone was 50.6% of that payload and the drawer-only fields came to
// 82KB per poll, about 72MB an hour. That is the same cost this feature already refused
// to pay on the SSE channel; a poll is not a loophole in that argument.
//
// The ask is NOT lost by dropping them: it is derived from pane/menu/question by the
// shared `askPreview`, which the daemon now runs so the wire carries only its one line.
test("the fleet-wide ledger ships no stored pane captures, only the reduced ask", () => {
  const pane = [
    "Bash command",
    "",
    "rm -rf ./build && npm run build",
    "",
    "Do you want to proceed?",
    "1. Yes",
    "2. No",
  ].join("\n");
  write({ noteKey: "lean", marker: "lean-1", createdAt: 9500, pane, question: "Needs approval: Bash" });

  const row = db.recentEpisodes(100).find((r) => r.marker === "lean-1");
  assert.ok(row);
  // The heavy, drawer-only fields are absent from the summary entirely - not null, absent.
  for (const heavy of ["pane", "menu", "brief", "recommendation", "sentText", "question"]) {
    assert.ok(!(heavy in row), `${heavy} is still on the fleet-wide ledger payload`);
  }
  // ...and the ask still says what the decision was about, reduced from that same pane.
  assert.equal(row.ask, "rm -rf ./build && npm run build");

  // The per-session read is unchanged and still carries the full capture, because that
  // surface shows one decision at a time and the pane is the only copy of the question.
  const full = db.episodesFor("lean").find((r) => r.marker === "lean-1");
  assert.equal(full?.pane, pane);
});

// A pane long enough to matter must not cross the wire in full even via the ask.
test("the reduced ask is clamped for the wire", () => {
  const long = "x".repeat(5000);
  write({
    noteKey: "clamp",
    marker: "clamp-1",
    createdAt: 9600,
    pane: null,
    question: long,
  });
  const row = db.recentEpisodes(100).find((r) => r.marker === "clamp-1");
  assert.ok(row);
  assert.ok(row.ask.length <= MAX_ASK_PREVIEW, `ask was ${row.ask.length} chars`);
  assert.ok(row.ask.endsWith("…"));
});

test("a shadow measurement survives the write and reads back on both reads", () => {
  write({
    noteKey: "shadowed",
    marker: "s-1",
    createdAt: 8000,
    cheapAction: "answer",
    divergence: "cheap-over-eager",
  });
  const [byKey] = db.episodesFor("shadowed");
  assert.equal(byKey?.cheapAction, "answer");
  assert.equal(byKey?.divergence, "cheap-over-eager");
  // And the same row through the fleet-wide read, which is a second SELECT and could
  // have been given a column list that drifted from the per-session one.
  const fleet = db.recentEpisodes(100).find((r) => r.marker === "s-1");
  assert.equal(fleet?.cheapAction, "answer");
  assert.equal(fleet?.divergence, "cheap-over-eager");
});

// A value this build has no word for must read as null - "not measured" - and never be
// rounded to the nearest one it does know. `agree` is the reading that would flatter the
// cheap tier on exactly the evidence an operator uses to decide whether to trust it.
test("a divergence written by a newer build reads as not measured, not as a nearest match", () => {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw
    .prepare(`UPDATE foreman_episodes SET divergence = ?, cheap_action = ? WHERE marker = ?`)
    .run("cheap-invented-a-new-kind", "teleported", "s-1");
  raw.close();
  const row = db.recentEpisodes(100).find((r) => r.marker === "s-1");
  assert.equal(row?.divergence, null);
  assert.equal(row?.cheapAction, null);
});
