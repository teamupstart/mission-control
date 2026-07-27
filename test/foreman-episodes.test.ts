import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { EpisodeWrite } from "../src/server/db.ts";

// The append-only record behind the Foreman note.
//
// What these pin is the difference between this table and `session_notes`: the note
// is a current-state row that each write destroys, and this must NOT be - except for
// the one case where a second write is the same decision reaching a later state.

// Isolate the db in a throwaway home before config.ts resolves the state dir.
const home = mkdtempSync(join(tmpdir(), "mission-episodes-"));
process.env.HARNESS_HOME = home;
const { openDb, recordEpisode, resolveEpisode, episodesFor, pruneEpisodes } = await import(
  "../src/server/db.ts"
);
const { Registry } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/** First row, asserting there is one - the repo compiles with strict index access. */
function first<T>(rows: T[]): T {
  assert.ok(rows.length > 0, "expected at least one row");
  return rows[0]!;
}


function mkEpisode(over: Partial<EpisodeWrite> = {}): EpisodeWrite {
  return {
    noteKey: "agent-1",
    sessionId: "sid",
    marker: "await:1",
    situation: "terminal-pane",
    surface: "terminal",
    question: "Claude needs your permission to use AskUserQuestion",
    pane: "❯ 1. Postgres\n  2. SQLite",
    menu: { options: [{ number: 1, label: "Postgres" }, { number: 2, label: "SQLite" }], highlighted: 1 },
    reviewId: null,
    purpose: "A design fork with real cost either way.",
    brief: "Both options are defensible.",
    recommendation: "SQLite - keep CI dependency-free.",
    classification: "design-fork",
    confidence: 0.41,
    tier: 2,
    cheapAction: null,
    divergence: null,
    disposition: "escalated",
    lastAction: "escalated for your decision",
    sentText: null,
    sentOption: null,
    sentBy: null,
    createdAt: 1000,
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  };
}

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "n",
    nameSource: "process",
    cwd: "/wt/a",
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    terminals: [],
    startedAt: 0,
    ...over,
  };
}

test("an episode round-trips with the context the note never carried", () => {
  openDb();
  recordEpisode(mkEpisode({ noteKey: "rt-1" }));
  const got = first(episodesFor("rt-1"));
  assert.equal(got.question, "Claude needs your permission to use AskUserQuestion");
  assert.equal(got.pane, "❯ 1. Postgres\n  2. SQLite");
  assert.equal(got.menu?.options.length, 2);
  assert.equal(got.menu?.options[1]?.label, "SQLite");
  assert.equal(got.menu?.highlighted, 1);
  // The verdict fields the note drops on the floor.
  assert.equal(got.classification, "design-fork");
  assert.equal(got.confidence, 0.41);
  assert.equal(got.tier, 2);
});

test("successive episodes accumulate rather than overwriting (unlike the note)", () => {
  recordEpisode(mkEpisode({ noteKey: "acc-1", marker: "await:1", createdAt: 1000 }));
  recordEpisode(mkEpisode({ noteKey: "acc-1", marker: "await:2", createdAt: 2000 }));
  recordEpisode(mkEpisode({ noteKey: "acc-1", marker: "review:r-9", createdAt: 3000 }));
  const list = episodesFor("acc-1");
  assert.equal(list.length, 3, "three distinct markers are three episodes");
  assert.deepEqual(
    list.map((e) => e.marker),
    ["review:r-9", "await:2", "await:1"],
    "newest first",
  );
});

test("re-posting the same marker updates that episode instead of adding one", () => {
  recordEpisode(mkEpisode({ noteKey: "up-1", marker: "await:7", createdAt: 1000 }));
  recordEpisode(
    mkEpisode({
      noteKey: "up-1",
      marker: "await:7",
      createdAt: 5000,
      disposition: "answered",
      sentText: "SQLite",
      sentBy: "foreman",
    }),
  );
  const list = episodesFor("up-1");
  assert.equal(list.length, 1, "same (note_key, marker) is the same episode");
  assert.equal(list[0]!.disposition, "answered");
  assert.equal(list[0]!.sentText, "SQLite");
  assert.equal(
    list[0]!.createdAt,
    1000,
    "the episode began when Foreman first faced it, not when it was updated",
  );
});

test("a later write with no pane keeps the pane the first one captured", () => {
  // The case this exists for: the human's Approve knows the marker and nothing else.
  // If a partial write could null the pane, answering a question would erase it.
  recordEpisode(mkEpisode({ noteKey: "pane-1", marker: "await:3" }));
  recordEpisode(mkEpisode({ noteKey: "pane-1", marker: "await:3", pane: null, menu: null }));
  const got = first(episodesFor("pane-1"));
  assert.equal(got.pane, "❯ 1. Postgres\n  2. SQLite", "the only copy of the ask survives");
  assert.equal(got.menu?.options.length, 2);
});

test("resolveEpisode stamps the human's answer without touching the captured ask", () => {
  recordEpisode(mkEpisode({ noteKey: "res-1", marker: "await:5" }));
  resolveEpisode({
    noteKey: "res-1",
    marker: "await:5",
    disposition: "answered",
    sentText: "SQLite. Keep CI dependency-free.",
    resolvedBy: "you",
    resolvedAt: 9000,
  });
  const got = first(episodesFor("res-1"));
  assert.equal(got.disposition, "answered");
  assert.equal(got.sentBy, "you");
  assert.equal(got.resolvedBy, "you");
  assert.equal(got.sentText, "SQLite. Keep CI dependency-free.");
  assert.equal(got.resolvedAt, 9000);
  assert.equal(got.question, "Claude needs your permission to use AskUserQuestion");
  assert.equal(got.pane, "❯ 1. Postgres\n  2. SQLite");
  assert.equal(got.brief, "Both options are defensible.", "Foreman's reasoning is not erased");
});

test("resolving an unknown marker is a no-op, not a throw", () => {
  // An episode written before this shipped, or already swept, has nothing to stamp -
  // and a bookkeeping gap must never fail the human's actual decision.
  assert.doesNotThrow(() =>
    resolveEpisode({
      noteKey: "nope",
      marker: "await:404",
      disposition: "answered",
      sentText: "x",
      resolvedBy: "you",
      resolvedAt: 1,
    }),
  );
});

test("dismissing records who decided it without inventing a send", () => {
  // The bug this pins: `sent_by` was stamped "you" for a dismissal as well as an
  // approval, so the card's Resolution block read "You approved" two lines under a
  // header saying you dismissed it. A dismissal delivers nothing, so there is no
  // author to name - but it IS still your decision, which `resolved_by` carries.
  recordEpisode(mkEpisode({ noteKey: "dis-1", marker: "await:6" }));
  resolveEpisode({
    noteKey: "dis-1",
    marker: "await:6",
    disposition: "skipped",
    sentText: null,
    resolvedBy: "you",
    resolvedAt: 9100,
  });
  const got = first(episodesFor("dis-1"));
  assert.equal(got.disposition, "skipped");
  assert.equal(got.sentBy, null, "nothing was sent, so nothing is attributed");
  assert.equal(got.resolvedBy, "you", "you still made the call");
  assert.equal(got.sentText, null);
});

test("a disposition an older build can't read falls back to skipped, not escalated", () => {
  // These rows outlive the daemon that wrote them. Reading an unknown disposition as
  // `escalated` would put a live Approve in front of the human for a decision nothing
  // established was theirs.
  openDb()
    .prepare(
      `INSERT INTO foreman_episodes
         (note_key, session_id, marker, situation, surface, question, disposition, created_at)
       VALUES ('fwd-1', 'sid', 'm', 'terminal-pane', 'terminal', 'q', 'deferred', 1)`,
    )
    .run();
  const got = first(episodesFor("fwd-1"));
  assert.equal(got.disposition, "skipped");
});

test("a corrupt menu blob costs the menu, not the read", () => {
  openDb()
    .prepare(
      `INSERT INTO foreman_episodes
         (note_key, session_id, marker, situation, surface, question, menu, disposition, created_at)
       VALUES ('bad-1', 'sid', 'm', 'terminal-pane', 'terminal', 'q', '{not json', 'escalated', 1)`,
    )
    .run();
  const got = first(episodesFor("bad-1"));
  assert.equal(got.menu, null);
  assert.equal(got.question, "q", "the rest of the row still reads");
});

test("pruneEpisodes ages rows out by when the episode began", () => {
  recordEpisode(mkEpisode({ noteKey: "old-1", marker: "a", createdAt: 100 }));
  recordEpisode(mkEpisode({ noteKey: "old-1", marker: "b", createdAt: 9_000_000 }));
  const gone = pruneEpisodes(1000);
  assert.ok(gone >= 1);
  const left = episodesFor("old-1");
  assert.equal(left.length, 1);
  assert.equal(left[0]!.marker, "b");
});

test("registry.recordEpisode keys the episode the way the note is keyed", () => {
  const r = new Registry();
  r.applyDiscovery([mkDiscovered({ syntheticId: "e1", cwd: "/wt/e1" })]);
  const s = r.snapshot().sessions.find((x) => x.id === "e1")!;
  r.recordEpisode(
    s.id,
    {
      marker: "await:99",
      situation: "terminal-pane",
      surface: "terminal",
      question: "which db?",
      pane: "❯ 1. Postgres",
      disposition: "escalated",
    },
    4242,
  );
  const list = r.listEpisodes(s.id);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.question, "which db?");
  assert.equal(list[0]!.createdAt, 4242);
  assert.equal(list[0]!.resolvedAt, null, "an escalation stays open until someone acts");
});

test("an episode Foreman closed itself is resolved as it is recorded", () => {
  const r = new Registry();
  r.applyDiscovery([mkDiscovered({ syntheticId: "e2", cwd: "/wt/e2" })]);
  const s = r.snapshot().sessions.find((x) => x.id === "e2")!;
  r.recordEpisode(
    s.id,
    {
      marker: "await:100",
      situation: "terminal-pane",
      surface: "terminal",
      question: "may I rm the vite cache?",
      disposition: "answered",
      sentText: "yes",
      sentBy: "foreman",
    },
    777,
  );
  const got = first(r.listEpisodes(s.id));
  assert.equal(got.resolvedAt, 777);
  assert.equal(got.sentBy, "foreman");
});
