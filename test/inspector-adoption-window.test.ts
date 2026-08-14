/**
 * The read behind "what shipped", and the reason it is not the read the settings panel uses.
 *
 * The Line's Shipped count is `prsOpenedSince`: `COUNT(*) FROM inspector_prs WHERE
 * adopted_at >= ?`, uncapped, over the one column that means "a hook caught us running
 * `gh pr create`". Clicking that number has to land on the rows it counted. The existing
 * ledger read cannot serve them - it orders by `COALESCE(last_reviewed_at, adopted_at)` and
 * the route caps it at 50 - so a surface built on it would disagree with the number the
 * operator clicked in two separate ways, both silent:
 *
 *  1. Order. A review is not a ship. Re-reviewing a PR from Monday moves it above one
 *     opened on Friday, so "newest first" stops meaning newest.
 *  2. Truncation. A week busier than the cap renders short while the count includes
 *     everything, and nothing on screen says rows were dropped.
 *
 * So this file pins the window read against the count itself: same column, same bound,
 * same answer.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-inspector-window-"));
process.env.MISSION_HOME = home;

const { DB_PATH } = await import("../src/server/config.ts");
assert.equal(
  DB_PATH,
  join(home, "harness.db"),
  "refusing to seed the adoption-window fixture outside its disposable home",
);

const {
  openDb,
  adoptInspectorPr,
  loadInspectionsAdoptedSince,
  loadInspectorInspections,
  prsOpenedSince,
  updateInspectorPr,
  upsertInspectorComment,
} = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const WEEK_AGO = NOW - 7 * DAY;

/** Adopt a PR at `adoptedAt`, exactly as `adoptPr` does: nothing observed yet. */
function seed(number: number, adoptedAt: number, over: { title?: string | null } = {}): string {
  const key = `owner/repo#${number}`;
  adoptInspectorPr({
    key,
    url: `https://github.com/owner/repo/pull/${number}`,
    owner: "owner",
    repo: "repo",
    number,
    repoRoot: "/repo",
    cwd: "/repo",
    sessionId: `sess-${number}`,
    source: "hook",
    state: "open",
    headSha: null,
    reviewPosture: null,
    round: 0,
    lastReviewedAt: null,
    lastError: null,
    failCount: 0,
    lastFailKind: null,
    nextAttemptAt: null,
    lastAttemptSha: null,
    mergedAt: null,
    mergeBlock: null,
    observedHeadSha: null,
    observedState: null,
    observedAt: null,
    headRefName: null,
    title: over.title ?? null,
    adoptedAt,
    updatedAt: adoptedAt,
  });
  return key;
}

before(() => {
  openDb();
  // Three inside the week, adopted out of order on purpose, and one the week before it.
  seed(1, WEEK_AGO + 1 * DAY);
  seed(3, WEEK_AGO + 5 * DAY);
  seed(2, WEEK_AGO + 3 * DAY);
  seed(99, WEEK_AGO - 1 * DAY);
});

test("the window is the ledger's own provenance column, so it agrees with the strip's count", () => {
  const rows = loadInspectionsAdoptedSince(WEEK_AGO);
  assert.equal(
    rows.length,
    prsOpenedSince(WEEK_AGO),
    "the list and the number the operator clicked must be made of the same rows",
  );
  assert.deepEqual(rows.map((r) => r.number).sort((a, b) => a - b), [1, 2, 3]);
});

test("a pull request adopted before the window is out of it", () => {
  assert.equal(
    loadInspectionsAdoptedSince(WEEK_AGO).some((r) => r.number === 99),
    false,
  );
  // And the bound is inclusive, matching `prsOpenedSince`'s `>=`. An exclusive one would
  // drop the row on the boundary from the list while the count still held it.
  assert.equal(
    loadInspectionsAdoptedSince(WEEK_AGO - 1 * DAY).some((r) => r.number === 99),
    true,
  );
});

test("rows come back newest ADOPTION first, whatever order they were written in", () => {
  assert.deepEqual(
    loadInspectionsAdoptedSince(WEEK_AGO).map((r) => r.number),
    [3, 2, 1],
  );
});

test("a review does not reorder a settled week - the one thing the panel's read gets wrong", () => {
  // Reviewing the OLDEST pull request right now. Under the settings panel's ordering that
  // hoists it to the top of the list; under adoption order it does not move, because
  // reviewing something is not shipping it again.
  updateInspectorPr("owner/repo#1", { lastReviewedAt: NOW, round: 1 }, NOW);

  assert.equal(
    loadInspectorInspections()[0]?.number,
    1,
    "the fixture must reproduce the reordering, or this proves nothing",
  );
  assert.deepEqual(
    loadInspectionsAdoptedSince(WEEK_AGO).map((r) => r.number),
    [3, 2, 1],
    "the ship log's order is a fact about the past and must not move",
  );
});

test("the finding tallies survive the second ordering", () => {
  // Both reads are the same grouped join; the tallies are what a `LEFT JOIN` plus a
  // `GROUP BY` are there for, and a WHERE clause landing on the wrong side of the GROUP BY
  // is how they would quietly become counts of joined rows instead.
  for (const [index, status] of (["open", "drafted", "posting", "resolved"] as const).entries()) {
    upsertInspectorComment({
      id: `finding-${index}`,
      prKey: "owner/repo#2",
      fingerprint: `fingerprint-${index}`,
      path: "src/example.ts",
      line: index + 1,
      title: `Finding ${index}`,
      body: "Detail",
      severity: "major",
      round: 1,
      status,
      replies: 0,
      answeredCommentId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  const row = loadInspectionsAdoptedSince(WEEK_AGO).find((r) => r.number === 2);
  assert.equal(row?.openFindings, 3);
  assert.equal(row?.postedOpenFindings, 1);
  assert.equal(row?.resolvedFindings, 1);
  // A PR with no findings at all still appears, with zeroes. An INNER JOIN here would drop
  // every pull request the Inspector has nothing to say about - which is most of them, and
  // exactly the ones a ship log is about.
  assert.equal(loadInspectionsAdoptedSince(WEEK_AGO).find((r) => r.number === 3)?.openFindings, 0);
});

test("the window carries the title, and null for the ones no poll has reached", () => {
  updateInspectorPr("owner/repo#3", { title: "Ship the drawer", headRefName: "feat/drawer" }, NOW);
  const rows = loadInspectionsAdoptedSince(WEEK_AGO);
  assert.equal(rows.find((r) => r.number === 3)?.title, "Ship the drawer");
  assert.equal(
    rows.find((r) => r.number === 1)?.title,
    null,
    "unpolled rows arrive null so the renderer can fall back to the branch",
  );
});

test("nothing caps the window - a busy week renders whole or not at all", () => {
  // The failure a cap produces is invisible: 60 pull requests in a week, a list of 50, and a
  // headline count of 60 with nothing on screen admitting the difference. The window is the
  // bound; there is no second one.
  const busy = NOW + 30 * DAY;
  for (let i = 0; i < 60; i += 1) seed(1000 + i, busy + i);
  const rows = loadInspectionsAdoptedSince(busy);
  assert.equal(rows.length, 60);
  assert.equal(rows.length, prsOpenedSince(busy));
  assert.equal(rows[0]?.number, 1059, "and still newest first past the old cap");
});
