import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The backlog's one order: `tasks.backlog_rank`, written by the operator and by nothing
 * else. See docs/plans/backlog-manual-order/plan.md.
 *
 * What is at stake is a class of failure that is entirely silent. Every one of these can
 * hold, ship, and quietly schedule the wrong task first:
 *
 *  - **An unranked row does not sort harmlessly to the bottom.** It sorts last, `appendRank`
 *    hands the NEXT arrival a finite rank, and finite sorts above infinite - so every task
 *    filed after it lands above it. One NULL row inverts the bottom-insertion rule for
 *    everything that follows, and nothing raises an error.
 *  - **The obvious one-line comparator is backwards** in the mixed ranked/unranked case, and
 *    an example-based test that happened to use a younger unranked row would pass anyway.
 *  - **A safe integer is not an allocatable one.** `Number.MIN_SAFE_INTEGER` passes every
 *    validity check and then one prepend produces a value that is not representable.
 *  - **The backfill's SQL `CASE` is a hand-copy of `PRIORITY_RANK`** into a language that
 *    cannot import it. Nothing but a test notices the two drifting.
 *
 * The db-backed half seeds a real `harness.db` under a temp home and lets `openDb` migrate
 * it, so the migration runs on the path production takes rather than on a hand-called
 * helper. The comparator half is pure and needs none of that.
 */

// Set before the imports below resolve, so `openDb` opens THIS database - see AGENTS.md on
// `--import ./test/setup-state.mjs` and why a hoisted import defeats this preamble.
const home = mkdtempSync(join(tmpdir(), "mission-rank-"));
process.env.MISSION_HOME = home;
const DB_FILE = join(home, "harness.db");

/**
 * A pre-`backlog_rank` tasks table, exactly as an upgrading operator's looks: every column
 * the current writer names EXCEPT the one this feature adds, so `openDb` has to ALTER it in
 * and back-fill it.
 */
function seedPreRankDb(rows: Array<{ id: string; priority: string | null; createdAt: number; status?: string }>): void {
  const raw = new DatabaseSync(DB_FILE);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      intent        TEXT NOT NULL,
      kind          TEXT NOT NULL,
      agent         TEXT NOT NULL,
      priority      TEXT,
      repo_root     TEXT NOT NULL,
      worktree_path TEXT,
      branch        TEXT,
      provider      TEXT,
      home_name     TEXT,
      session_id    TEXT,
      status        TEXT NOT NULL,
      outcome       TEXT,
      outcome_url   TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      dispatched_at INTEGER,
      completed_at  INTEGER
    );
  `);
  const insert = raw.prepare(
    `INSERT INTO tasks (id, title, intent, kind, agent, priority, repo_root, status, created_at, updated_at)
     VALUES (?, ?, ?, 'ship', 'claude', ?, '/repo', ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(r.id, r.id, `do ${r.id}`, r.priority, r.status ?? "backlog", r.createdAt, r.createdAt);
  }
  raw.close();
}

// The fixture the backfill test reads. Deliberately filed in an order that neither
// priority nor age alone would produce, so a backfill that got either half wrong shows up.
seedPreRankDb([
  { id: "old-low", priority: "low", createdAt: 100 },
  { id: "new-blocker", priority: "blocker", createdAt: 900 },
  { id: "untriaged", priority: null, createdAt: 200 },
  { id: "older-high", priority: "high", createdAt: 300 },
  { id: "newer-high", priority: "high", createdAt: 400 },
  { id: "already-done", priority: "blocker", createdAt: 50, status: "done" },
]);

const { openDb } = await import("../src/server/db.ts");
const {
  RANK_STEP,
  appendRank,
  normalizeBacklogRanks,
  placeBacklogRank,
  prependRank,
  rankBetween,
} = await import("../src/server/backlog-rank.ts");
const { byBacklogRank, byPriorityThenAge, priorityRank, TASK_PRIORITIES } = await import(
  "../src/shared/task.ts"
);
const { mkTask } = await import("./helpers/session-fixture.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/** Every backlog row's rank, in id order, for asserting on the whole column at once. */
function ranks(): Map<string, number | null> {
  const rows = openDb()
    .prepare(`SELECT id, backlog_rank AS r FROM tasks WHERE status = 'backlog'`)
    .all() as unknown as Array<{ id: string; r: number | null }>;
  return new Map(rows.map((row) => [row.id, row.r]));
}

/** The backlog in stored-rank order, which is the order a dashboard would draw it. */
function orderedIds(): string[] {
  const rows = openDb()
    .prepare(`SELECT id, backlog_rank AS r, created_at AS c FROM tasks WHERE status = 'backlog'`)
    .all() as unknown as Array<{ id: string; r: number | null; c: number }>;
  return rows
    .map((row) => ({ id: row.id, backlogRank: row.r, createdAt: row.c }))
    .sort(byBacklogRank)
    .map((row) => row.id);
}

/** Add a backlog row directly, the way a build that did not know the column would. */
function insertRow(id: string, rank: number | null | string, createdAt = 1000): void {
  openDb()
    .prepare(
      `INSERT INTO tasks (id, title, intent, kind, agent, priority, repo_root, status,
                          created_at, updated_at, backlog_rank)
       VALUES (?, ?, ?, 'ship', 'claude', NULL, '/repo', 'backlog', ?, ?, ?)`,
    )
    .run(id, id, `do ${id}`, createdAt, createdAt, rank);
}

function dropRow(id: string): void {
  openDb().prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
}

// ---- the migration and its one-time backfill -------------------------------------------

test("the backfill numbers an upgrading backlog in the order the board already showed", () => {
  openDb();
  // `byPriorityThenAge`, which is what the board drew before this feature - so upgrade day
  // changes nothing visible, and only then does the operator start rearranging.
  assert.deepEqual(orderedIds(), [
    "new-blocker",
    "older-high",
    "newer-high",
    "untriaged",
    "old-low",
  ]);
  // Spaced by RANK_STEP, so there is room to insert between any two without renumbering.
  assert.deepEqual(
    [...ranks().values()].sort((a, b) => (a ?? 0) - (b ?? 0)),
    [1, 2, 3, 4, 5].map((n) => n * RANK_STEP),
  );
  // A non-backlog row is left alone. Rank means nothing outside the backlog, and writing
  // one would put a number in the column that describes a queue this task is not in.
  const done = openDb()
    .prepare(`SELECT backlog_rank AS r FROM tasks WHERE id = 'already-done'`)
    .get() as unknown as { r: number | null };
  assert.equal(done.r, null);
});

test("an already-migrated database is not renumbered on the next open", () => {
  // The backfill hangs off `addColumn`'s did-it-add return, so it runs exactly once. If it
  // re-ran, every reorder the operator had made since would be silently undone on the next
  // restart - which is the failure a caching `openDb` in THIS process cannot reproduce.
  //
  // So the second open is a real one, in a child process against the same file. It is the
  // same launch the daemon makes; nothing about it is a test seam.
  const before = ranks();
  // A reorder, expressed the way a prepend does - negative, which is expected and fine.
  openDb().prepare(`UPDATE tasks SET backlog_rank = ? WHERE id = 'old-low'`).run(-4096);

  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "-e", 'import("./src/server/db.ts").then((m) => m.openDb());'],
    { env: { ...process.env, MISSION_HOME: home }, encoding: "utf8" },
  );
  assert.equal(child.status, 0, `the second open failed: ${child.stderr}`);

  const after = ranks();
  assert.equal(after.get("old-low"), -4096, "a reorder must survive the next open");
  for (const [id, rank] of before) {
    if (id === "old-low") continue;
    assert.equal(after.get(id), rank, `${id} was renumbered by a second migration`);
  }
  // Put it back, so the tests below start from the clean column the backfill produced.
  openDb().prepare(`UPDATE tasks SET backlog_rank = ? WHERE id = 'old-low'`).run(5 * RANK_STEP);
});

test("the backfill's SQL CASE agrees with PRIORITY_RANK for every priority, unset included", () => {
  // The `CASE` is a hand-copy of a TypeScript table into a language that cannot import it,
  // so nothing but this test would notice the two drifting - and the drift would be
  // invisible: an upgraded backlog in a slightly wrong order that nobody can prove wrong.
  const probe = new DatabaseSync(":memory:");
  probe.exec(`CREATE TABLE p (priority TEXT)`);
  const insert = probe.prepare(`INSERT INTO p VALUES (?)`);
  for (const priority of TASK_PRIORITIES) insert.run(priority);
  insert.run(null);
  const rows = probe
    .prepare(
      `SELECT priority, CASE priority
                          WHEN 'blocker' THEN 4
                          WHEN 'high' THEN 3
                          WHEN 'med' THEN 2
                          WHEN 'low' THEN 0
                          ELSE 1
                        END AS n
       FROM p`,
    )
    .all() as unknown as Array<{ priority: string | null; n: number }>;
  probe.close();
  assert.equal(rows.length, TASK_PRIORITIES.length + 1);
  for (const row of rows) {
    assert.equal(
      row.n,
      priorityRank(row.priority as null),
      `SQL and PRIORITY_RANK disagree about ${row.priority ?? "unset"}`,
    );
  }
});

// ---- the comparator ---------------------------------------------------------------------

test("byBacklogRank is a strict total order over every shape a rank can take", () => {
  // Asserted as a property rather than by example. A comparator is used by `sort`, which is
  // free to compare any pair in any direction, so "it produced the right list once" is a
  // much weaker claim than the one the sort actually relies on.
  const rows = [
    mkTask({ id: "a", backlogRank: null, createdAt: 5 }),
    mkTask({ id: "b", backlogRank: null, createdAt: 5 }),
    mkTask({ id: "c", backlogRank: 0, createdAt: 5 }),
    mkTask({ id: "d", backlogRank: -4096, createdAt: 5 }),
    mkTask({ id: "e", backlogRank: Number.MAX_SAFE_INTEGER, createdAt: 5 }),
    mkTask({ id: "f", backlogRank: Number.MIN_SAFE_INTEGER, createdAt: 5 }),
    mkTask({ id: "g", backlogRank: 1024, createdAt: 5 }),
    mkTask({ id: "h", backlogRank: 1024, createdAt: 5 }),
  ];
  for (const x of rows) {
    for (const y of rows) {
      const xy = byBacklogRank(x, y);
      assert.ok(!Number.isNaN(xy), `NaN comparing ${x.id} and ${y.id}`);
      if (x.id === y.id) {
        assert.equal(xy, 0, "a row must compare equal to itself");
        continue;
      }
      assert.notEqual(xy, 0, `${x.id} and ${y.id} are distinct rows and must not tie`);
      assert.equal(Math.sign(xy), -Math.sign(byBacklogRank(y, x)), "antisymmetry");
      for (const z of rows) {
        const yz = byBacklogRank(y, z);
        if (xy < 0 && yz < 0) assert.ok(byBacklogRank(x, z) < 0, "transitivity");
      }
    }
  }
});

test("a RANKED row sorts before an UNRANKED one whatever their ages", () => {
  // The case the intuitive single-subtraction comparator gets exactly backwards. Writing it
  // as `(a ?? Infinity) - (b ?? Infinity)` guarded by `Number.isFinite` looks equivalent and
  // is not: finite minus Infinity is -Infinity, the guard rejects it, the comparison falls
  // through to `createdAt`, and an OLD unranked row leads the whole column.
  //
  // Both directions of age, because a by-example test that happened to pick a younger
  // unranked row would pass on the broken comparator.
  const oldUnranked = mkTask({ id: "old-unranked", backlogRank: null, createdAt: 1 });
  const youngRanked = mkTask({ id: "young-ranked", backlogRank: 9_999, createdAt: 9_000 });
  assert.ok(byBacklogRank(youngRanked, oldUnranked) < 0);
  assert.ok(byBacklogRank(oldUnranked, youngRanked) > 0);

  const youngUnranked = mkTask({ id: "young-unranked", backlogRank: null, createdAt: 9_000 });
  const oldRanked = mkTask({ id: "old-ranked", backlogRank: 9_999, createdAt: 1 });
  assert.ok(byBacklogRank(oldRanked, youngUnranked) < 0);
});

test("two unranked rows fall through to age and then id, and never to NaN", () => {
  // `Infinity - Infinity` is NaN, and a NaN-returning comparator sorts unpredictably - a
  // column that reshuffles between renders for no reason a human could see.
  const a = mkTask({ id: "a", backlogRank: null, createdAt: 5 });
  const b = mkTask({ id: "b", backlogRank: null, createdAt: 5 });
  const older = mkTask({ id: "z", backlogRank: null, createdAt: 1 });
  assert.ok(byBacklogRank(a, b) < 0, "ids break a full tie");
  assert.ok(byBacklogRank(older, a) < 0, "age comes before the id tiebreak");
  assert.ok(!Number.isNaN(byBacklogRank(a, b)));
});

// ---- allocation -------------------------------------------------------------------------

test("rankBetween finds the midpoint, and refuses when there is no integer left", () => {
  assert.equal(rankBetween(1024, 3072), 2048);
  assert.equal(rankBetween(0, 2), 1);
  // Adjacent integers have nothing strictly between them. Null is the caller's signal to
  // renormalize and retry, which is the whole collision story.
  assert.equal(rankBetween(5, 6), null);
  assert.equal(rankBetween(5, 5), null);
  assert.equal(rankBetween(6, 5), null, "a reversed pair has no midpoint either");
  // Extremes stay representable or fail closed - never a value JSON cannot round-trip.
  const wide = rankBetween(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  assert.ok(wide === null || Number.isSafeInteger(wide));
});

test("appendRank puts a new task at the BOTTOM, on an empty backlog and a full one", () => {
  const d = openDb();
  const max = Math.max(...[...ranks().values()].map((r) => r ?? 0));
  assert.equal(appendRank(d)!.rank, max + RANK_STEP);
  // And on an empty backlog it is the first step rather than zero, so there is room to
  // prepend above it without going negative on the very first move.
  const empty = new DatabaseSync(":memory:");
  empty.exec(`CREATE TABLE tasks (id TEXT, status TEXT, created_at INTEGER, backlog_rank INTEGER)`);
  assert.equal(appendRank(empty)!.rank, RANK_STEP);
  assert.equal(prependRank(empty)!.rank, RANK_STEP);
  empty.close();
});

test("a task filed after an UNRANKED row still lands below it - the rule, not the mechanism", () => {
  // The regression this whole repair exists for, stated as the promise it protects. An
  // unranked row sorts last; without the repair `appendRank` would hand the new task a
  // finite rank, finite sorts above infinite, and the new task would land SECOND to last.
  insertRow("older-build-wrote-this", null, 10);
  const placement = appendRank(openDb())!;
  insertRow("filed-after", placement.rank, 20);
  const order = orderedIds();
  assert.ok(
    order.indexOf("filed-after") > order.indexOf("older-build-wrote-this"),
    "a task filed after an unranked row must sort BELOW it",
  );
  // And the repair healed rather than tolerated: no backlog row is left unranked.
  assert.equal([...ranks().values()].filter((r) => r === null).length, 0);
  dropRow("older-build-wrote-this");
  dropRow("filed-after");
});

test("an allocation normalizes ONLY when it has no integer left to write", () => {
  // The settled decision, pinned as the fence around the expensive path: sparse ranks
  // "renormalize only on collision". A collision is one thing and one thing only - there
  // is no integer left where one is needed - and it is discovered at the moment of
  // allocation rather than guessed at by a pre-check over the whole column. Every case
  // below is a column state that would once have been called degenerate; none of them is a
  // reason to renumber the operator's order, and each is asserted to cost zero rewrites.
  const d = openDb();
  const cases: Array<[string, number | null | string]> = [
    ["a NULL rank - a row with no place, not a space with no room", null],
    ["a fraction, which reads as unranked and is healed the same way", 1024.5 as unknown as number],
    ["a rank shared with a card the placement never goes near", [...ranks().values()][0]!],
  ];
  for (const [why, rank] of cases) {
    insertRow("probe", rank, 90_000);
    const kept = new Map([...ranks()].filter(([id]) => id !== "probe"));
    const placement = appendRank(d)!;
    for (const [id, was] of kept) {
      assert.equal(ranks().get(id), was, `${why}: ${id} must keep the rank it had`);
    }
    assert.ok(
      [...placement.normalized.keys()].every((id) => id === "probe"),
      `${why} must not renumber the column`,
    );
    dropRow("probe");
  }
});

test("a NULL row is HEALED in place - the other ranks keep the spacing the operator set", () => {
  // The requirement this repair round exists for. A missing rank must not cost a full
  // renumber: the ranks around it are still the operator's order and still perfectly
  // spaced, so rewriting them would move cards nobody asked to move and publish an event
  // per card to say so.
  const d = openDb();
  const before = new Map([...ranks()].filter(([, r]) => r !== null));
  assert.ok(before.size >= 3, "the fixture needs a column to leave alone");
  insertRow("lost-its-rank", null, 99_000);

  const placement = appendRank(d)!;

  const healed = new Map(ranks());
  assert.equal(
    healed.get("lost-its-rank") !== null,
    true,
    "the unranked row was given a rank",
  );
  for (const [id, rank] of before) {
    assert.equal(healed.get(id), rank, `${id} must keep the rank the operator gave it`);
  }
  // And nothing was reported as moved, because nothing was: the heal touched one row that
  // had no rank to change, and the append has not been written yet.
  assert.deepEqual([...placement.normalized.keys()], ["lost-its-rank"]);
  dropRow("lost-its-rank");
});

test("normalizeBacklogRanks compacts in place, keeping the order and healing the NULLs", () => {
  const d = openDb();
  const before = orderedIds();
  insertRow("unranked", null, 10_000);
  const touched = normalizeBacklogRanks(d);
  assert.ok(touched.size > 0, "it reports what it moved, so the caller can publish it");
  // Order preserved, with the unranked row placed LAST - which is where an unplaced
  // arrival belongs, and why one repair can heal and compact in a single pass.
  assert.deepEqual(orderedIds(), [...before, "unranked"]);
  // Every rank is now a small positive multiple of the step: full headroom at both ends.
  const values = [...ranks().values()];
  assert.deepEqual(
    values.sort((a, b) => (a ?? 0) - (b ?? 0)),
    values.map((_, i) => (i + 1) * RANK_STEP),
  );
  dropRow("unranked");
  normalizeBacklogRanks(d);
});

test("a rank near the CEILING narrows the next gap and moves nobody", () => {
  // Reachable in practice from outside the allocator - a restored backup, a hand-edited
  // row, an older build. The sparse scheme's answer is to take a smaller step, NOT to
  // renumber: the operator's spacing everywhere else is not the allocator's to rewrite in
  // order to make room for one arrival.
  const d = openDb();
  const untouched = new Map(ranks());
  insertRow("planted-high", Number.MAX_SAFE_INTEGER - 4, 10_000);

  const placement = appendRank(d)!;
  assert.ok(Number.isSafeInteger(placement.rank), "the new rank must be representable");
  assert.ok(placement.rank > Number.MAX_SAFE_INTEGER - 4, "it still lands at the bottom");
  assert.ok(
    placement.rank - (Number.MAX_SAFE_INTEGER - 4) < RANK_STEP,
    "the step shrank to fit the room that was left",
  );
  assert.deepEqual([...placement.normalized.keys()], [], "nothing was rewritten to make room");
  for (const [id, was] of untouched) {
    assert.equal(ranks().get(id), was, `${id} must keep the rank the operator gave it`);
  }
  dropRow("planted-high");
});

test("a rank near the FLOOR narrows the next gap too, symmetrically", () => {
  const d = openDb();
  const untouched = new Map(ranks());
  insertRow("planted-low", Number.MIN_SAFE_INTEGER + 4, 10_000);

  const placement = prependRank(d)!;
  assert.ok(Number.isSafeInteger(placement.rank));
  assert.ok(placement.rank < Number.MIN_SAFE_INTEGER + 4, "it still lands at the top");
  assert.ok(placement.rank > Number.MIN_SAFE_INTEGER, "and stays inside what JSON can carry");
  assert.deepEqual([...placement.normalized.keys()], [], "nothing was rewritten to make room");
  for (const [id, was] of untouched) {
    assert.equal(ranks().get(id), was, `${id} must keep the rank the operator gave it`);
  }
  dropRow("planted-low");
});

test("a relative move at an exhausted edge REFUSES; only a real gap collision renumbers", () => {
  // The two ways a `before`/`after` can fail, and they call for opposite answers.
  //
  // EXHAUSTED: the operator points past an anchor that has no integer beyond it. A renumber
  // cannot help - it would rewrite every rank in the column and then run out at the very
  // same place, because repacking does not make the number line longer - so this is
  // reported and the operator's order is left exactly as they arranged it.
  const d = openDb();
  normalizeBacklogRanks(d);
  const untouched = new Map(ranks());
  insertRow("edge", Number.MAX_SAFE_INTEGER, 10_000);
  assert.equal(
    placeBacklogRank(d, orderedIds()[0]!, "after", "edge"),
    null,
    "no room past the anchor is a refusal, not a renumber",
  );
  for (const [id, was] of untouched) {
    assert.equal(ranks().get(id), was, `${id} must keep the rank the operator gave it`);
  }
  dropRow("edge");

  // COLLISION: the operator points BETWEEN two cards whose ranks are adjacent. There is no
  // integer there, respacing the column creates one, and that is the trade sparse ranks
  // exist to make - so this one is allowed to renumber.
  normalizeBacklogRanks(d);
  const order = orderedIds();
  const [mover, above, below] = [order.at(-1)!, order[0]!, order[1]!];
  openDb()
    .prepare(`UPDATE tasks SET backlog_rank = ? WHERE id = ?`)
    .run(ranks().get(above)! + 1, below);
  const collided = placeBacklogRank(d, mover, "before", below)!;
  assert.ok(collided, "a real collision still places the card");
  assert.ok(collided.normalized.size > 0, "and it is the one thing that pays for a renumber");
  normalizeBacklogRanks(d);
});

test("an END with no integer left REFUSES rather than renumbering the column", () => {
  // The last place a renumber could have hidden, and it does not. When the space above the
  // last card is genuinely empty there is nothing to shrink into, and the honest answer is
  // that this end cannot be extended - not a rewrite of an order the operator arranged.
  const d = openDb();
  const untouched = new Map(ranks());
  insertRow("at-the-very-top", Number.MAX_SAFE_INTEGER, 10_000);

  assert.equal(appendRank(d), null, "an exhausted end reports a failure to place");
  for (const [id, was] of untouched) {
    assert.equal(ranks().get(id), was, `${id} must keep the rank the operator gave it`);
  }
  assert.equal(ranks().get("at-the-very-top"), Number.MAX_SAFE_INTEGER, "and it is left alone");

  // The mirror, so neither end can renumber its way out.
  insertRow("at-the-very-bottom", Number.MIN_SAFE_INTEGER, 20_000);
  assert.equal(prependRank(d), null);
  dropRow("at-the-very-top");
  dropRow("at-the-very-bottom");
});

test("a NULL row beside a near-ceiling row is healed into what room is left", () => {
  // Both repairs at once. The unranked row needs a place and the room above the column is
  // narrow, so the heal takes a smaller gap - and still writes only the row that had no
  // rank. Measuring the room instead of insisting on `RANK_STEP` is what keeps this a
  // repair rather than an excuse to renumber.
  const d = openDb();
  const untouched = new Map(ranks());
  insertRow("planted-high", Number.MAX_SAFE_INTEGER - 8, 10_000);
  insertRow("unranked", null, 20_000);

  const placement = appendRank(d)!;
  assert.deepEqual(
    [...placement.normalized.keys()],
    ["unranked"],
    "only the row with no rank was written",
  );
  for (const [id, was] of untouched) {
    assert.equal(ranks().get(id), was, `${id} must keep the rank the operator gave it`);
  }
  assert.equal(ranks().get("planted-high"), Number.MAX_SAFE_INTEGER - 8, "and so does the plant");
  assert.deepEqual(orderedIds().slice(-2), ["planted-high", "unranked"], "the order is kept");
  for (const rank of ranks().values()) {
    assert.ok(rank !== null && Number.isSafeInteger(rank), "no unusable value was written");
  }
  dropRow("planted-high");
  dropRow("unranked");
  normalizeBacklogRanks(d);
});

test("placeBacklogRank puts a card before and after an anchor, ignoring the mover's own rank", () => {
  const d = openDb();
  const order = orderedIds();
  const [first, second, third] = order as [string, string, string];

  // "Move up" is `before` the card above. The mover's own rank must be ignored when the
  // gap is measured, or the placement would compute the position it is already in.
  const up = placeBacklogRank(d, third, "before", second)!;
  openDb().prepare(`UPDATE tasks SET backlog_rank = ? WHERE id = ?`).run(up.rank, third);
  assert.deepEqual(orderedIds().slice(0, 3), [first, third, second]);

  // And back down again.
  const down = placeBacklogRank(d, third, "after", second)!;
  openDb().prepare(`UPDATE tasks SET backlog_rank = ? WHERE id = ?`).run(down.rank, third);
  assert.deepEqual(orderedIds().slice(0, 3), [first, second, third]);
});

test("a collision renormalizes and the retry cannot collide again", () => {
  // Two adjacent integers have no midpoint, so this is the one move that pays for the whole
  // backlog to be rewritten - and after that rewrite every neighbouring pair is RANK_STEP
  // apart, so the retry always finds one.
  const d = openDb();
  normalizeBacklogRanks(d);
  const order = orderedIds();
  const [first, second, third] = order as [string, string, string];
  // Wedge `second` immediately above `third`, leaving no room between them.
  const thirdRank = ranks().get(third)!;
  openDb().prepare(`UPDATE tasks SET backlog_rank = ? WHERE id = ?`).run(thirdRank - 1, second);

  const placement = placeBacklogRank(d, first, "before", third)!;
  assert.ok(Number.isSafeInteger(placement.rank));
  assert.ok(placement.normalized.size > 0, "the collision paid for a full renormalize");
  openDb().prepare(`UPDATE tasks SET backlog_rank = ? WHERE id = ?`).run(placement.rank, first);
  const after = orderedIds();
  assert.equal(after.indexOf(first) + 1, after.indexOf(third), "it landed directly above the anchor");
  normalizeBacklogRanks(d);
});

test("top and bottom need no anchor and mean the same thing in any list", () => {
  const d = openDb();
  normalizeBacklogRanks(d);
  const order = orderedIds();
  const last = order.at(-1)!;
  const top = placeBacklogRank(d, last, "top", null)!;
  openDb().prepare(`UPDATE tasks SET backlog_rank = ? WHERE id = ?`).run(top.rank, last);
  assert.equal(orderedIds()[0], last);
  const bottom = placeBacklogRank(d, last, "bottom", null)!;
  openDb().prepare(`UPDATE tasks SET backlog_rank = ? WHERE id = ?`).run(bottom.rank, last);
  assert.equal(orderedIds().at(-1), last);
});

test("byPriorityThenAge still orders as the backfill needs it to", () => {
  // Its ONE remaining caller is the migration backfill above, which orders an upgrading
  // operator's backlog once. That call has to be right, which is why this survives its
  // retirement from the product.
  const tasks = [
    mkTask({ id: "low", priority: "low", createdAt: 1 }),
    mkTask({ id: "unset", priority: null, createdAt: 2 }),
    mkTask({ id: "blocker", priority: "blocker", createdAt: 3 }),
  ];
  assert.deepEqual(
    [...tasks].sort(byPriorityThenAge).map((t) => t.id),
    ["blocker", "unset", "low"],
  );
});
