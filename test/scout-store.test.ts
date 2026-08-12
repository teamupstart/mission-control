import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, beforeEach } from "node:test";
import { SCOUT_SEARCH_LIMITS, decodeScoutCursor, scoutArchiveKey } from "../src/shared/scouts.ts";
import { writeScoutBundle } from "./helpers/scout-fixture.ts";

/**
 * The disposable index: its schema, its upgrade path, and its bounded queries.
 *
 * The database is seeded as a PRE-FEATURE one before db.ts ever opens it, so the schema
 * arrives on the path a real upgrade takes rather than through a hand-called helper - and
 * the pre-existing task row proves the new tables cost an operator nothing.
 */

const home = mkdtempSync(join(tmpdir(), "mission-scout-store-"));
process.env.MISSION_HOME = home;

function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      intent        TEXT NOT NULL,
      kind          TEXT NOT NULL,
      agent         TEXT NOT NULL,
      repo_root     TEXT NOT NULL,
      worktree_path TEXT,
      branch        TEXT,
      provider      TEXT,
      tmux_session  TEXT,
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
  raw
    .prepare(
      `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("before-scouts", "A task filed before the scout library", "look into it", "scout", "claude", "/repo", "backlog", 1, 1);
  raw.close();
}

seedPreFeatureDb();

const { openDb, deleteTask, getTask } = await import("../src/server/db.ts");
const { ScoutStore, clearScoutTables } = await import("../src/server/scouts/store.ts");
const { verifyScoutBundle } = await import("../src/server/scouts/bundle.ts");

const db = openDb();
const library = realpathSync(mkdirp(join(home, "scouts")));
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearScoutTables(db));

function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function index(store: InstanceType<typeof ScoutStore>, spec: Parameters<typeof writeScoutBundle>[1], epoch = 1) {
  const written = writeScoutBundle(library, spec);
  const read = await verifyScoutBundle(library, {
    producerId: written.producerId,
    archiveId: written.archiveId,
  });
  assert.equal(read.kind, "verified", read.kind === "unreadable" ? read.reason : read.kind);
  if (read.kind !== "verified") throw new Error("unreachable");
  store.replaceArchive(read.bundle, epoch, epoch);
  return written;
}

const EMPTY_QUERY = {
  q: null,
  producer: null,
  repo: null,
  agent: null,
  status: null,
  from: null,
  to: null,
  cursor: null,
  limit: SCOUT_SEARCH_LIMITS.defaultLimit,
};

test("a pre-feature database opens safely and keeps every task it already had", () => {
  assert.equal(getTask("before-scouts")?.title, "A task filed before the scout library");
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'scout_%' ORDER BY name`)
      .all() as unknown as Array<{ name: string }>
  ).map((row) => row.name);
  assert.deepEqual(tables, ["scout_archives", "scout_artifacts", "scout_search_segments"]);
});

test("no scout table references a task or a session", () => {
  for (const table of ["scout_archives", "scout_artifacts", "scout_search_segments"]) {
    const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
    assert.deepEqual(keys, [], `${table} must have no foreign keys - a bundle outlives every row it came from`);
  }
});

test("deleting a task leaves its scout archive untouched", async () => {
  const store = new ScoutStore(db);
  const written = await index(store, {});
  deleteTask("before-scouts");
  assert.equal(getTask("before-scouts"), undefined);
  assert.equal(store.get(written.key)?.title, "Resume permission loss");
});

test("an indexed bundle round-trips its display fields and artifacts", async () => {
  const store = new ScoutStore(db);
  const written = await index(store, {
    companions: { "permission-events.csv": "when,what\n" },
    supporting: { "repo-01/evidence/run.log": "log line\n" },
  });
  const row = store.get(written.key);
  assert.ok(row);
  assert.equal(row.producerId, written.producerId);
  assert.equal(row.status, "ready");
  assert.equal(row.captureStatus, "complete");
  assert.equal(row.question, "Why did a resumed agent lose repository permissions?");
  assert.deepEqual(row.tags, ["permissions", "resume"]);
  assert.equal(row.agent, "codex");
  assert.equal(row.repositories[0]?.label, "mission-control");
  assert.equal(row.artifactCount, 3);
  assert.equal(row.completedAt, Date.parse("2026-08-12T18:50:03.000Z"));
  assert.equal(row.sortAt, row.completedAt);

  const artifacts = store.artifacts(written.key);
  assert.deepEqual(
    artifacts.map((artifact) => artifact.archivePath),
    ["report/report.html", "report/permission-events.csv", "artifacts/repo-01/evidence/run.log"],
  );
  assert.equal(artifacts[0]?.mediaType, "text/html; charset=utf-8");
  assert.equal(store.artifact(written.key, "report")?.role, "primary_report");
  assert.equal(store.artifact(written.key, "nope"), null);
});

test("literal search finds every segment kind a bundle contributes", async () => {
  const store = new ScoutStore(db);
  const written = await index(store, {
    title: "Header density regression",
    question: "Why did the topbar wrap on a narrow window?",
    summary: "A rung-three control crossed the container pin.",
    tags: ["layout"],
    agent: "claude",
    reportHtml: [
      "<!doctype html><html><head><title>Header density</title></head><body>",
      "<h1>Header density</h1><p>The measured overflow was seventeen pixels.</p>",
      "</body></html>",
    ].join(""),
    supporting: { "repo-01/evidence/topbar-measurements.csv": "width,px\n" },
  });
  const hits: Array<[string, string]> = [
    ["Header density regression", "title"],
    ["topbar wrap", "question"],
    ["container pin", "summary"],
    ["layout", "tag"],
    ["claude", "provenance"],
    ["mission-control", "provenance"],
    ["seventeen pixels", "report_text"],
    ["topbar-measurements.csv", "artifact_path"],
  ];
  for (const [needle, kind] of hits) {
    const page = store.list({ ...EMPTY_QUERY, q: needle });
    assert.equal(page.rows.length, 1, `"${needle}" should match through its ${kind} segment`);
    assert.equal(page.rows[0]?.key, written.key);
    assert.equal(store.snippet(written.key, needle)?.kind, kind);
  }
  assert.equal(store.list({ ...EMPTY_QUERY, q: "nothing here at all" }).rows.length, 0);
});

test("search is case-folded for text SQLite's own lower() would not fold", async () => {
  const store = new ScoutStore(db);
  await index(store, { title: "Étude de la Résilience", tags: [] });
  assert.equal(store.list({ ...EMPTY_QUERY, q: "étude de la résilience" }).rows.length, 1);
  assert.equal(store.list({ ...EMPTY_QUERY, q: "ÉTUDE" }).rows.length, 1);
});

test("a snippet shows the matched text with its provenance", async () => {
  const store = new ScoutStore(db);
  const written = await index(store, {
    reportHtml: `<!doctype html><html><body><p>${"filler ".repeat(60)}the decisive sentence${" more".repeat(60)}</p></body></html>`,
  });
  const snippet = store.snippet(written.key, "decisive sentence");
  assert.ok(snippet);
  assert.equal(snippet.kind, "report_text");
  assert.match(snippet.text, /decisive sentence/);
  assert.ok(snippet.text.length <= 242, "a snippet stays bounded");
});

test("filters narrow by producer, repository, agent, status, and date", async () => {
  const store = new ScoutStore(db);
  const mine = await index(store, {
    agent: "codex",
    repositories: [{ slot: "repo-01", label: "mission-control", head: null }],
    completedAt: "2026-08-01T00:00:00.000Z",
  });
  const theirs = await index(store, {
    agent: "claude",
    repositories: [{ slot: "repo-01", label: "other-repo", head: null }],
    completedAt: "2026-08-20T00:00:00.000Z",
  });
  assert.deepEqual(
    store.list({ ...EMPTY_QUERY, producer: mine.producerId }).rows.map((row) => row.key),
    [mine.key],
  );
  assert.deepEqual(
    store.list({ ...EMPTY_QUERY, repo: "other-repo" }).rows.map((row) => row.key),
    [theirs.key],
  );
  assert.deepEqual(
    store.list({ ...EMPTY_QUERY, agent: "codex" }).rows.map((row) => row.key),
    [mine.key],
  );
  assert.deepEqual(
    store.list({ ...EMPTY_QUERY, from: Date.parse("2026-08-10T00:00:00.000Z") }).rows.map((row) => row.key),
    [theirs.key],
  );
  assert.deepEqual(
    store.list({ ...EMPTY_QUERY, to: Date.parse("2026-08-10T00:00:00.000Z") }).rows.map((row) => row.key),
    [mine.key],
  );
  assert.equal(store.list({ ...EMPTY_QUERY, repo: "mission" }).rows.length, 0, "a repo filter is not a substring");
  assert.equal(store.list({ ...EMPTY_QUERY, status: "unreadable" }).rows.length, 0);
});

test("the same title under two producers is two archives, not a collision", async () => {
  const store = new ScoutStore(db);
  const first = await index(store, { title: "One question" });
  const second = await index(store, { title: "One question" });
  assert.notEqual(first.producerId, second.producerId);
  const page = store.list({ ...EMPTY_QUERY, q: "One question" });
  assert.equal(page.rows.length, 2);
  assert.equal(new Set(page.rows.map((row) => row.key)).size, 2);
});

test("pagination is newest-first, stable, and cursor-bounded", async () => {
  const store = new ScoutStore(db);
  const keys: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const written = await index(store, {
      title: `Archive ${i}`,
      completedAt: new Date(Date.UTC(2026, 7, 1 + i)).toISOString(),
    });
    keys.push(written.key);
  }
  const newestFirst = [...keys].reverse();
  const first = store.list({ ...EMPTY_QUERY, limit: 2 });
  assert.deepEqual(first.rows.map((row) => row.key), newestFirst.slice(0, 2));
  assert.ok(first.nextCursor);
  const second = store.list({ ...EMPTY_QUERY, limit: 2, cursor: decodeScoutCursor(first.nextCursor) });
  assert.deepEqual(second.rows.map((row) => row.key), newestFirst.slice(2, 4));
  const third = store.list({ ...EMPTY_QUERY, limit: 2, cursor: decodeScoutCursor(second.nextCursor) });
  assert.deepEqual(third.rows.map((row) => row.key), newestFirst.slice(4));
  assert.equal(third.nextCursor, null, "the last page offers no cursor");
});

test("archives sharing a completion instant still have a total order", async () => {
  const store = new ScoutStore(db);
  const at = "2026-08-12T18:50:03.000Z";
  const a = await index(store, { completedAt: at });
  const b = await index(store, { completedAt: at });
  const expected = [a.key, b.key].sort().reverse();
  const first = store.list({ ...EMPTY_QUERY, limit: 1 });
  assert.deepEqual(first.rows.map((row) => row.key), [expected[0]]);
  const second = store.list({ ...EMPTY_QUERY, limit: 1, cursor: decodeScoutCursor(first.nextCursor) });
  assert.deepEqual(second.rows.map((row) => row.key), [expected[1]]);
});

test("an unreadable bundle is listed with a bounded reason and no content rows", () => {
  const store = new ScoutStore(db);
  const identity = {
    producerId: "7aa704fd-d2ab-48b3-a726-0c2643ed91d2",
    archiveId: "9f5db6c8-79f5-4f9e-84aa-8b5dc15362f8",
  };
  store.replaceUnreadable({
    identity,
    relativePath: `${identity.producerId}/${identity.archiveId}`,
    fingerprint: { manifestBytes: 10, manifestMtimeNs: "1" },
    reason: "x".repeat(2_000),
    formatVersion: 99,
    indexedAt: 5,
    epoch: 5,
  });
  const key = scoutArchiveKey(identity.producerId, identity.archiveId);
  const row = store.get(key);
  assert.equal(row?.status, "unreadable");
  assert.equal(row?.formatVersion, 99);
  assert.equal(row?.error?.length, 500, "a diagnostic is clipped rather than stored whole");
  assert.equal(store.artifacts(key).length, 0);
  assert.equal(store.list({ ...EMPTY_QUERY, q: "x" }).rows.length, 0, "an unreadable bundle indexes no text");
});

test("re-indexing replaces every derived row rather than merging them", async () => {
  const store = new ScoutStore(db);
  const written = await index(store, { companions: { "a.csv": "1" }, title: "First title" });
  rmSync(written.dir, { recursive: true, force: true });
  const replaced = writeScoutBundle(library, {
    producerId: written.producerId,
    archiveId: written.archiveId,
    title: "Second title",
  });
  const read = await verifyScoutBundle(library, {
    producerId: replaced.producerId,
    archiveId: replaced.archiveId,
  });
  assert.equal(read.kind, "verified");
  if (read.kind !== "verified") return;
  store.replaceArchive(read.bundle, 2, 2);
  assert.equal(store.get(written.key)?.title, "Second title");
  assert.equal(store.artifacts(written.key).length, 1, "the removed companion's row is gone");
  assert.equal(store.list({ ...EMPTY_QUERY, q: "First title" }).rows.length, 0);
});

test("pruning removes exactly the archives a finished pass did not see", async () => {
  const store = new ScoutStore(db);
  const kept = await index(store, {}, 10);
  const stale = await index(store, {}, 9);
  const pruned = store.pruneUnseen(10);
  assert.deepEqual(pruned, [stale.key]);
  assert.equal(store.get(stale.key), null);
  assert.equal(store.get(kept.key)?.key, kept.key);
  assert.equal(store.artifacts(stale.key).length, 0);
});

test("removing one archive removes all three of its row kinds", async () => {
  const store = new ScoutStore(db);
  const written = await index(store, { companions: { "a.csv": "1" } });
  assert.equal(store.remove(written.key), true);
  assert.equal(store.get(written.key), null);
  assert.equal(store.artifacts(written.key).length, 0);
  assert.equal(store.list({ ...EMPTY_QUERY, q: "Resume permission" }).rows.length, 0);
  assert.equal(store.remove(written.key), false, "removing twice is not an error, just false");
});

test("nullable provenance survives a bundle that knows almost nothing about itself", async () => {
  const store = new ScoutStore(db);
  const written = await index(store, {
    agent: null,
    model: null,
    source: null,
    question: null,
    summary: null,
    tags: [],
    repositories: [],
    producerLabel: null,
    completedAt: null,
  });
  const row = store.get(written.key);
  assert.equal(row?.agent, null);
  assert.equal(row?.question, null);
  assert.deepEqual(row?.repositories, []);
  assert.equal(row?.completedAt, null);
  assert.equal(row?.sortAt, row?.createdAt, "with no completion, ordering falls back to creation");
});

test("the list limit is bounded at the store, not only at the route", async () => {
  const store = new ScoutStore(db);
  await index(store, {});
  const page = store.list({ ...EMPTY_QUERY, limit: 10_000 });
  assert.ok(page.rows.length <= SCOUT_SEARCH_LIMITS.maxLimit);
});
