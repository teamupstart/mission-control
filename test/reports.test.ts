import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ServerEvent, Session } from "../src/shared/types.ts";
import { reportAuthorLabel, type ReportItem } from "../src/shared/reports.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkMuxHandle, mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";

// What is at stake: an agent says "done, read this", and the operator reads it - including after
// the session that said it has gone.
//
// A report is deliberately NOT a review. It never raises `pendingReviews`, never holds a
// completion, and never orphans on eviction, because the session is a report's permanent home
// rather than its owner: an exited session, or one whose pull request merged, still has reports
// waiting to be read. So the row keeps everything it needs to be drawn without its session - the
// author's name, task, repository and resident profile - and nothing here listens for
// `session_remove`.
//
// A replacement takes the earlier report's place and keeps its place in the queue; a `replaces`
// that is not this author's own report still waiting to be read is refused with the ones it could
// have meant, so a resident that lost the id can retry. `markRead` is the one writer of `readAt`.

const home = mkdtempSync(join(tmpdir(), "mission-reports-"));
process.env.HARNESS_HOME = home;

const db = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { ReportManager, ReportRefusal, reportDocumentDir } = await import("../src/server/reports.ts");
const flags = await import("../src/server/feature-flags/index.ts");

after(() => rmSync(home, { recursive: true, force: true }));

flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });

let checkoutCount = 0;
/** A checkout directory for one session, so a document can be attached from inside it. */
function checkout(): string {
  const dir = join(home, `checkout-${++checkoutCount}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function wired() {
  const registry = new Registry();
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  const reviews = new ReviewManager(registry);
  const reports = new ReportManager(registry);
  after(() => reports.stop());
  return { registry, reviews, reports, events };
}

const upserts = (events: ServerEvent[]) =>
  events.flatMap((event) => (event.type === "report_upsert" ? [event.report] : []));

test("a database from before reports gains the empty table on open, at the current schema", () => {
  db.closeDb();
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec("DROP TABLE IF EXISTS reports; PRAGMA user_version = 45;");
  raw.close();
  const upgraded = db.openDb();
  assert.equal((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, db.CURRENT_DATABASE_SCHEMA_VERSION);
  assert.ok(db.CURRENT_DATABASE_SCHEMA_VERSION >= 49);
  const columns = (upgraded.prepare("PRAGMA table_info(reports)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const column of [
    "id", "session_id", "task_id", "repository", "author_key", "author_name", "author_resident_profile_id",
    "title", "body", "url", "document_name", "document_kind", "root_id", "version", "superseded_by",
    "created_at", "root_created_at", "opened_at", "read_at", "read_by", "follow_up_task_id",
    "announced_as", "announced_at", "published_archive_key", "counted_in_digest_at",
  ]) assert.ok(columns.includes(column), `reports.${column}`);
  assert.equal((upgraded.prepare("SELECT COUNT(*) AS n FROM reports").get() as { n: number }).n, 0);
  db.closeDb();
  db.openDb();
});

test("a schema 47 database, from before the digest mark, gains counted_in_digest_at on open with its rows intact", () => {
  db.openDb().prepare(
    `INSERT INTO reports (id, session_id, author_key, author_name, title, body, root_id, version, created_at, root_created_at)
     VALUES ('r-mig', 's-mig', 'session:s-mig', 'Mig', 'Kept', 'b', 'r-mig', 1, 5, 5)`,
  ).run();
  db.closeDb();
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec("ALTER TABLE reports DROP COLUMN counted_in_digest_at; PRAGMA user_version = 47;");
  raw.close();
  const upgraded = db.openDb();
  assert.equal((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, db.CURRENT_DATABASE_SCHEMA_VERSION);
  const row = upgraded.prepare("SELECT title, counted_in_digest_at FROM reports WHERE id = 'r-mig'").get() as { title: string; counted_in_digest_at: number | null };
  assert.deepEqual({ ...row }, { title: "Kept", counted_in_digest_at: null });
  upgraded.prepare("DELETE FROM reports WHERE id = 'r-mig'").run();
});

test("schema 64 report labels and historical mutes recover the name source at post and mute time", () => {
  const store = db.openDb();
  const revision = store.prepare("INSERT INTO resident_profile_revisions VALUES (?, ?, ?, ?)");
  revision.run("historic-sage", 1, JSON.stringify({ identity: { name: "Captain", referenceName: "Sage" } }), 10);
  revision.run("historic-sage", 2, JSON.stringify({ identity: { name: "Sage" } }), 20);
  const report = store.prepare(`INSERT INTO reports (id, session_id, author_key, author_resident_profile_id,
    author_name, author_spoken_name, title, body, root_id, version, created_at, root_created_at)
    VALUES (?, 'old-session', 'resident:historic-sage', 'historic-sage', 'Captain', 'Sage', 'Review', 'Done', ?, 1, ?, ?)`);
  report.run("old-reference", "old-reference", 15, 15);
  report.run("old-profile-name", "old-profile-name", 25, 25);
  revision.run("historic-linter", 1, JSON.stringify({ identity: { name: "Linter" } }), 10);
  store.prepare(`INSERT INTO reports (id, session_id, author_key, author_resident_profile_id,
    author_name, title, body, root_id, version, created_at, root_created_at)
    VALUES ('ordinary-report', 'ordinary-session', 'resident:historic-linter', 'historic-linter',
      'Linter', 'Review', 'Done', 'ordinary-report', 1, 15, 15)`).run();
  const mute = store.prepare("INSERT INTO report_mutes (author_key, author_name, author_spoken_name, muted_at) VALUES (?, ?, ?, ?)");
  // Sage was muted after the reference-name report and before the later ordinary-name report.
  mute.run("resident:historic-sage", "Captain", "Sage", 18);
  mute.run("resident:historic-linter", "Linter", null, 18);
  db.closeDb();
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec("ALTER TABLE reports DROP COLUMN author_is_reference_name; ALTER TABLE report_mutes DROP COLUMN author_is_reference_name; PRAGMA user_version = 64;");
  raw.close();
  const upgraded = db.openDb();
  const rows = upgraded.prepare("SELECT author_spoken_name, author_is_reference_name FROM reports WHERE session_id = 'old-session' ORDER BY seq").all();
  assert.deepEqual(rows.map(row => [row.author_spoken_name, row.author_is_reference_name]), [["Sage", 1], ["Sage", 0]]);
  const mutes = upgraded.prepare("SELECT author_key, author_is_reference_name FROM report_mutes ORDER BY author_key").all();
  assert.deepEqual(mutes.map(row => [row.author_key, row.author_is_reference_name]), [
    ["resident:historic-linter", 0], ["resident:historic-sage", 1],
  ]);
  upgraded.exec(`
    DELETE FROM report_mutes WHERE author_key IN ('resident:historic-linter', 'resident:historic-sage');
    DELETE FROM reports WHERE session_id IN ('ordinary-session', 'old-session');
    DELETE FROM resident_profile_revisions WHERE profile_id IN ('historic-linter', 'historic-sage');
  `);
});

test("a schema 49 database, from before mutes, gains the empty report_mutes table on open with its reports intact", () => {
  db.openDb().prepare(
    `INSERT INTO reports (id, session_id, author_key, author_name, title, body, root_id, version, created_at, root_created_at)
     VALUES ('r-mut', 's-mut', 'session:s-mut', 'Mut', 'Kept', 'b', 'r-mut', 1, 5, 5)`,
  ).run();
  db.closeDb();
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec("DROP TABLE IF EXISTS report_mutes; ALTER TABLE reports DROP COLUMN author_spoken_name; PRAGMA user_version = 49;");
  raw.close();
  const upgraded = db.openDb();
  assert.equal((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, db.CURRENT_DATABASE_SCHEMA_VERSION);
  assert.ok(db.CURRENT_DATABASE_SCHEMA_VERSION >= 50);
  const columns = (upgraded.prepare("PRAGMA table_info(report_mutes)").all() as Array<{ name: string; pk: number }>);
  assert.deepEqual(columns.map((c) => [c.name, c.pk]), [["author_key", 1], ["author_name", 0], ["muted_at", 0], ["author_spoken_name", 0], ["author_is_reference_name", 0]]);
  assert.equal((upgraded.prepare("SELECT COUNT(*) AS n FROM report_mutes").get() as { n: number }).n, 0);
  const row = upgraded.prepare("SELECT title, read_at, author_name, author_spoken_name FROM reports WHERE id = 'r-mut'").get() as { title: string; read_at: number | null };
  assert.deepEqual({ ...row }, { title: "Kept", read_at: null, author_name: "Mut", author_spoken_name: null });
  upgraded.prepare("DELETE FROM reports WHERE id = 'r-mut'").run();
});

test("a mute is stored, survives a restart into the snapshot, hides without reading, and unmute brings every report back", async () => {
  const { registry, reports } = wired();
  const session = mkSession({ id: "s-mute", name: "chatty", cwd: checkout() });
  const first = await reports.post(session, { title: "One", body: "b" });
  const second = await reports.post(session, { title: "Two", body: "b" });
  const mute = reports.mute(first.author.key)!;
  assert.equal(mute.authorName, first.author.name);
  // A fresh manager over the same table, as after a daemon restart: the snapshot carries the mute.
  const restarted = new Registry();
  const again = new ReportManager(restarted);
  after(() => again.stop());
  assert.ok(restarted.snapshot().reportMutes?.some((m) => m.authorKey === first.author.key));
  // Nothing was read, and the registry still holds both: the fold, not the daemon, leaves them out.
  const held = registry.reportsToRead().filter((r) => r.sessionId === "s-mute");
  assert.deepEqual(held.map((r) => [r.id, r.readAt]), [[first.id, null], [second.id, null]]);
  assert.equal(reports.unmute(first.author.key), true);
  assert.equal(reports.unmute(first.author.key), false);
  assert.ok(!registry.snapshot().reportMutes?.some((m) => m.authorKey === first.author.key));
  assert.deepEqual(reports.listForSession("s-mute").map((r) => r.readAt), [null, null]);
  // Leave nothing waiting, so a later test's fresh manager hands the registry only its own.
  assert.deepEqual(reports.markAllRead([first.id, second.id]).map((r) => r.readBy), ["mark-all", "mark-all"]);
});

test("a post stores the report with its author, task and repository, and tells every window", async () => {
  const { reports, events } = wired();
  const session = mkSession({
    id: "s-post", name: "parser-session", repoRoot: "/repos/parser", cwd: checkout(),
    task: mkTaskSummary({ id: "t-post", title: "Fix the parser" }),
  });
  const report = await reports.post(session, { title: "Build failure diagnosed", body: "The cache was **stale**." });
  assert.match(report.id, /^r-\d+$/);
  assert.equal(report.rootId, report.id);
  assert.equal(report.version, 1);
  assert.deepEqual(report.author, { key: "session:s-post", name: "Fix the parser", residentProfileId: null });
  assert.equal(report.taskId, "t-post");
  assert.equal(report.repository, "/repos/parser");
  assert.deepEqual(
    [report.openedAt, report.readAt, report.readBy, report.supersededBy, report.followUpTaskId,
      report.announcedAs, report.announcedAt, report.publishedArchiveKey],
    [null, null, null, null, null, null, null, null],
  );
  assert.deepEqual(upserts(events).map((r) => r.id), [report.id]);
});

test("a session with no repository posts a report whose repository is null", async () => {
  const { reports } = wired();
  const report = await reports.post(mkSession({ id: "s-norepo", repoRoot: null, cwd: checkout() }), { title: "t", body: "b" });
  assert.equal(report.repository, null);
});

test("a resident is one author across its runs: keyed by its profile and named by it", async () => {
  const { registry, reports } = wired();
  registry.upsertResidentRun({
    id: "run-1", profileId: "steve", taskId: "t-res",
    settings: { identity: { name: "Steve" }, board: { colorId: "violet" } },
  } as unknown as Parameters<typeof registry.upsertResidentRun>[0]);
  const report = await reports.post(
    mkSession({ id: "s-res", cwd: checkout(), task: mkTaskSummary({ id: "t-res", title: "Resident work", kind: "resident" }) }),
    { title: "Weekly sweep done", body: "Nothing broke." },
  );
  assert.deepEqual(report.author, { key: "resident:steve", name: "Steve", residentProfileId: "steve" });
});

test("reports keep the source of an explicit reference name identical to the profile name", async (t) => {
  t.after(() => { flags.applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false }); });
  flags.applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  const { registry, reports } = wired();
  registry.upsertResidentRun({
    id: "run-sage", profileId: "sage", taskId: "t-sage",
    settings: { identity: { name: "Sage", referenceName: "Sage" }, board: { colorId: "violet" } },
  } as unknown as Parameters<typeof registry.upsertResidentRun>[0]);
  const session = mkSession({ id: "s-sage", task: mkTaskSummary({ id: "t-sage", kind: "resident" }) });
  const report = await reports.post(session, { title: "Reviewed", body: "Done." });
  const stored = reports.get(report.id)!.author;
  assert.equal(stored.name, "Sage");
  assert.equal(reportAuthorLabel(stored), '"Sage"');
  assert.equal(reportAuthorLabel(stored, false), "Sage");
  assert.equal(reports.mute(stored.key)?.isReferenceName, true);
  reports.unmute(stored.key);
});

test("a session's call sign names a report's author only while the voice flag is on", async (t) => {
  t.after(() => { flags.applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false }); });
  const { reports } = wired();
  const session = (id: string) => mkSession({
    id, cwd: checkout(), task: mkTaskSummary({ id: `t-${id}`, title: "Fix the parser", callSign: "Alice" }),
  });
  const off = await reports.post(session("s-voice-off"), { title: "Parser fixed", body: "Done." });
  assert.equal(off.author.name, "Fix the parser", "a saved call sign names nothing with voice off");
  flags.applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  const on = await reports.post(session("s-voice-on"), { title: "Parser fixed", body: "Done." });
  assert.equal(on.author.name, "Alice");
  assert.equal(reports.get(off.id)?.author.name, "Alice");
  reports.mute(on.author.key);
  flags.applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
  assert.equal(reports.get(on.id)?.author.name, "Fix the parser");
  assert.equal(reports.listMutes().find((m) => m.authorKey === on.author.key)?.authorName, "Fix the parser");
  flags.applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  assert.equal(reports.get(on.id)?.author.name, "Alice");
  assert.equal(reports.listMutes().find((m) => m.authorKey === on.author.key)?.authorName, "Alice");
  reports.unmute(on.author.key);
});

test("replaces: the new report takes the old one's place and keeps its place in the queue", async () => {
  let clock = 1_000;
  const registry = new Registry();
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  const reports = new ReportManager(registry, { now: () => clock });
  after(() => reports.stop());
  const session = mkSession({ id: "s-chain", cwd: checkout() });
  const first = await reports.post(session, { title: "First pass", body: "draft" });
  clock = 2_000;
  const second = await reports.post(session, { title: "Second pass", body: "better", replaces: first.id });
  assert.equal(second.rootId, first.id);
  assert.equal(second.version, 2);
  assert.equal(second.rootCreatedAt, 1_000, "the chain keeps its first report's place");
  assert.equal(second.createdAt, 2_000);
  assert.equal(reports.get(first.id)?.supersededBy, second.id);
  assert.equal(reports.get(first.id)?.readAt, null, "replaced is not read");
  // The window hears the old one leave and the new one arrive; only the new one waits to be read.
  assert.deepEqual(upserts(events).slice(-2).map((r) => [r.id, r.supersededBy]), [[first.id, second.id], [second.id, null]]);
  assert.deepEqual(registry.reportsToRead().filter((r) => r.sessionId === "s-chain").map((r) => r.id), [second.id]);
  clock = 3_000;
  const third = await reports.post(session, { title: "Third pass", body: "best", replaces: second.id });
  assert.equal(third.version, 3);
  assert.equal(third.rootId, first.id);
  // Every version stays in the session's history.
  assert.deepEqual(reports.listForSession("s-chain").map((r) => r.id), [first.id, second.id, third.id]);
});

test("a replaces the author may not use is refused with that author's open reports", async () => {
  const { reports } = wired();
  const mine = mkSession({ id: "s-mine", cwd: checkout() });
  const theirs = mkSession({ id: "s-theirs", cwd: checkout() });
  const a = await reports.post(mine, { title: "Alpha", body: "a" });
  const b = await reports.post(mine, { title: "Beta", body: "b" });
  const other = await reports.post(theirs, { title: "Theirs", body: "t" });
  const refusal = async (replaces: string) => {
    try {
      await reports.post(mine, { title: "x", body: "y", replaces });
    } catch (error) {
      assert.ok(error instanceof ReportRefusal);
      assert.equal(error.status, 409);
      return error.message;
    }
    assert.fail(`replaces ${replaces} was accepted`);
  };
  // Another author's report, an unknown id, and a report already read are all refused.
  for (const id of [other.id, "r-999999"]) {
    const message = await refusal(id);
    assert.match(message, new RegExp(`${a.id} "Alpha", ${b.id} "Beta"`));
    assert.doesNotMatch(message, /Theirs/);
  }
  reports.markRead(a.id, "mark-read");
  assert.match(await refusal(a.id), new RegExp(`Your reports waiting to be read: ${b.id} "Beta"\\.`));
  // A superseded report cannot be replaced again: its successor is the one to replace.
  const c = await reports.post(mine, { title: "Gamma", body: "c", replaces: b.id });
  assert.match(await refusal(b.id), new RegExp(`${c.id} "Gamma"`));
  // With nothing open the refusal says so.
  reports.markRead(c.id, "mark-read");
  assert.match(await refusal(c.id), /You have none; post without replaces\./);
});

test("opening is recorded once and never reads a report; markRead records its first time and way only", async () => {
  let clock = 10;
  const registry = new Registry();
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  const reports = new ReportManager(registry, { now: () => clock });
  after(() => reports.stop());
  const report = await reports.post(mkSession({ id: "s-read", cwd: checkout() }), { title: "t", body: "b" });
  clock = 20;
  assert.equal(reports.markOpened(report.id)?.openedAt, 20);
  clock = 30;
  assert.equal(reports.markOpened(report.id)?.openedAt, 20, "a second open keeps the first time");
  assert.equal(reports.get(report.id)?.readAt, null, "opening does not read it");
  assert.ok(registry.reportsToRead().some((r) => r.id === report.id));
  clock = 40;
  const read = reports.markRead(report.id, "mark-read")!;
  assert.deepEqual([read.readAt, read.readBy], [40, "mark-read"]);
  clock = 50;
  const again = reports.markRead(report.id, "reply")!;
  assert.deepEqual([again.readAt, again.readBy], [40, "mark-read"], "the first way and time stand");
  assert.ok(!registry.reportsToRead().some((r) => r.id === report.id));
  // One event per change: post, open, read. The repeats changed nothing and sent nothing.
  assert.equal(upserts(events).filter((r) => r.id === report.id).length, 3);
  assert.equal(reports.markRead("r-424242", "mark-read"), null);
  assert.equal(reports.markOpened("r-424242"), null);
});

test("a report changes nothing the review channel counts: no pending review, no completion hold", async () => {
  const { registry, reports } = wired();
  const dir = checkout();
  registry.applyDiscovery([mkDiscovered("s-norev", { cwd: dir })]);
  const session = registry.getSession("s-norev")!;
  await reports.post(session, { title: "Done", body: "Read this." });
  const after = registry.getSession("s-norev")!;
  assert.equal(after.pendingReviews, 0);
  assert.deepEqual(registry.pendingReviews("s-norev"), []);
  assert.equal(registry.completionHeldByQuestion(after), false);
  assert.equal(db.openDb().prepare("SELECT COUNT(*) AS n FROM reviews WHERE session_id = ?").get("s-norev")!.n, 0);
});

test("a report outlives its session's eviction, with its repository and author intact", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { registry, reports, events } = wired();
  const dir = checkout();
  registry.applyDiscovery([mkDiscovered("s-evict", { cwd: dir, name: "evicted-session" })]);
  const live = registry.getSession("s-evict")!;
  const report = await reports.post({ ...live, repoRoot: "/repos/evicted" }, { title: "Before I go", body: "Read me." });
  registry.applyDiscovery([]);
  t.mock.timers.tick(10_000);
  assert.ok(events.some((event) => event.type === "session_remove" && event.id === "s-evict"), "the session really was evicted");
  assert.equal(registry.getSession("s-evict"), undefined);
  const kept = reports.get(report.id)!;
  assert.equal(kept.readAt, null);
  assert.equal(kept.repository, "/repos/evicted");
  assert.deepEqual(kept.author, report.author);
  assert.ok(registry.reportsToRead().some((r) => r.id === report.id), "still waiting to be read");
  // And across a restart: a new registry and manager read it back from the table.
  const restarted = new Registry();
  const again = new ReportManager(restarted);
  t.after(() => again.stop());
  assert.ok(restarted.reportsToRead().some((r) => r.id === report.id));
  assert.ok((restarted.snapshot().reports ?? []).some((r) => r.id === report.id));
});

test("an attached document is copied into the state home; the checkout's rules refuse the rest", async () => {
  const { reports } = wired();
  const dir = checkout();
  writeFileSync(join(dir, "findings.md"), "# Findings\n");
  writeFileSync(join(dir, "notes.txt"), "plain");
  writeFileSync(join(home, "outside.md"), "# Outside\n");
  const session = mkSession({ id: "s-doc", cwd: dir, workspaceRoot: dir });
  const report = await reports.post(session, { title: "With a document", body: "See attached.", file: "findings.md" });
  assert.deepEqual(report.document, { name: "findings.md", kind: "markdown" });
  assert.equal(readFileSync(join(reportDocumentDir(report.id, home), "findings.md"), "utf8"), "# Findings\n");
  const status = async (file: string) => {
    try {
      await reports.post(session, { title: "x", body: "y", file });
    } catch (error) {
      assert.ok(error instanceof ReportRefusal);
      return error.status;
    }
    return 200;
  };
  assert.equal(await status("notes.txt"), 400, "only .html and .md");
  assert.equal(await status("../outside.md"), 403, "never outside the checkout");
  assert.equal(await status("missing.md"), 404);
  // Exactly at the cap is accepted and copied byte for byte; one byte over is refused.
  writeFileSync(join(dir, "limit.html"), Buffer.alloc(2 * 1024 * 1024, 0x61));
  const atLimit = await reports.post(session, { title: "At the cap", body: "b", file: "limit.html" });
  assert.deepEqual(atLimit.document, { name: "limit.html", kind: "html" });
  assert.equal(statSync(join(reportDocumentDir(atLimit.id, home), "limit.html")).size, 2 * 1024 * 1024);
  writeFileSync(join(dir, "huge.html"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  assert.equal(await status("huge.html"), 413, "never past the size cap");
  // A refused post stored nothing.
  assert.deepEqual(reports.listForSession("s-doc").map((r) => r.id), [report.id, atLimit.id]);
  assert.ok(!existsSync(reportDocumentDir(`r-${Number(atLimit.id.slice(2)) + 1}`, home)));
});

test("a report attaches exactly .html and .md; .htm, .markdown and anything else are refused and store nothing", async () => {
  const { reports, events } = wired();
  const dir = checkout();
  for (const name of ["page.html", "SHOUT.HTML", "notes.md", "page.htm", "notes.markdown", "notes.txt"]) {
    writeFileSync(join(dir, name), "content");
  }
  const session = mkSession({ id: "s-ext", cwd: dir, workspaceRoot: dir });
  for (const [file, kind] of [["page.html", "html"], ["SHOUT.HTML", "html"], ["notes.md", "markdown"]] as const) {
    const report = await reports.post(session, { title: file, body: "b", file });
    assert.deepEqual(report.document, { name: file, kind }, file);
    assert.ok(existsSync(join(reportDocumentDir(report.id, home), file)), `${file} was copied`);
  }
  const stored = reports.listForSession("s-ext").map((r) => r.id);
  const before = events.length;
  for (const file of ["page.htm", "notes.markdown", "notes.txt"]) {
    await assert.rejects(reports.post(session, { title: file, body: "b", file }), (error: unknown) => {
      assert.ok(error instanceof ReportRefusal, file);
      assert.equal(error.status, 400, file);
      assert.equal(error.message, `${file} is not an .html or .md file`);
      return true;
    });
  }
  assert.deepEqual(reports.listForSession("s-ext").map((r) => r.id), stored, "a refused extension stored no report");
  assert.equal(upserts(events.slice(before)).length, 0, "and told no window");
});

test("a document that cannot be stored leaves no report, no event and no partial file", async () => {
  const registry = new Registry();
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  const dir = checkout();
  writeFileSync(join(dir, "findings.md"), "# Findings\n");
  const session = mkSession({ id: "s-store-fail", cwd: dir, workspaceRoot: dir });
  const reportCount = () => (db.openDb().prepare("SELECT COUNT(*) AS n FROM reports").get() as { n: number }).n;

  // The reports directory cannot be created: the state home's `reports` is a plain file.
  const blockedHome = join(home, "blocked-state");
  mkdirSync(blockedHome, { recursive: true });
  writeFileSync(join(blockedHome, "reports"), "not a directory");
  const blocked = new ReportManager(registry, { stateDir: blockedHome });
  after(() => blocked.stop());
  const rowsBefore = reportCount();
  const eventsBefore = events.length;
  await assert.rejects(blocked.post(session, { title: "Will not store", body: "b", file: "findings.md" }), /ENOTDIR|EEXIST/);
  assert.equal(reportCount(), rowsBefore, "the insert was rolled back");
  assert.deepEqual(blocked.listForSession("s-store-fail"), []);
  assert.equal(upserts(events.slice(eventsBefore)).length, 0, "no window was told about it");
  assert.ok(!registry.reportsToRead().some((r) => r.sessionId === "s-store-fail"));

  // The directory is made but the copy cannot land: the report's own file name is taken by a
  // non-empty directory, so the rename fails after the partial file was written.
  const stateDir = join(home, "rename-fail-state");
  const next = (db.openDb().prepare("SELECT seq FROM sqlite_sequence WHERE name = 'reports'").get() as { seq: number }).seq + 1;
  const occupied = join(reportDocumentDir(`r-${next}`, stateDir), "findings.md");
  mkdirSync(join(occupied, "in-the-way"), { recursive: true });
  const renaming = new ReportManager(registry, { stateDir });
  after(() => renaming.stop());
  const before = events.length;
  await assert.rejects(renaming.post(session, { title: "Will not land", body: "b", file: "findings.md" }), /EISDIR|ENOTEMPTY|EEXIST|EPERM/);
  assert.equal(reportCount(), rowsBefore, "the insert was rolled back");
  assert.equal(upserts(events.slice(before)).length, 0, "no window was told about it");
  assert.ok(!existsSync(reportDocumentDir(`r-${next}`, stateDir)), "the half-written document and its directory were removed");

  // Nothing was left wedged: the same post succeeds once storage works.
  const working = new ReportManager(registry, { stateDir: join(home, "working-state") });
  after(() => working.stop());
  const stored = await working.post(session, { title: "Stored", body: "b", file: "findings.md" });
  assert.deepEqual(working.listForSession("s-store-fail").map((r) => r.id), [stored.id]);
  assert.equal(readFileSync(join(reportDocumentDir(stored.id, join(home, "working-state")), "findings.md"), "utf8"), "# Findings\n");
});

test("a commit that fails after the document was copied removes the copy, stores no report and tells no window", async () => {
  const registry = new Registry();
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  const stateDir = join(home, "commit-fail-state");
  const reports = new ReportManager(registry, { stateDir });
  after(() => reports.stop());
  const dir = checkout();
  writeFileSync(join(dir, "findings.md"), "# Findings\n");
  const session = mkSession({ id: "s-commit-fail", cwd: dir, workspaceRoot: dir });
  const d = db.openDb();
  const reportCount = () => (d.prepare("SELECT COUNT(*) AS n FROM reports").get() as { n: number }).n;
  const next = (d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'reports'").get() as { seq: number }).seq + 1;
  // A deferred foreign key is checked only at COMMIT, so everything inside the transaction -
  // the insert, the id, and the document copy - succeeds, and then the commit itself is refused.
  d.exec(`
    CREATE TEMP TABLE report_commit_parent (id TEXT PRIMARY KEY);
    CREATE TEMP TABLE report_commit_child (
      parent TEXT REFERENCES report_commit_parent(id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TEMP TRIGGER report_commit_fails AFTER INSERT ON main.reports BEGIN
      INSERT INTO report_commit_child (parent) VALUES ('missing');
    END;
  `);
  const rowsBefore = reportCount();
  const eventsBefore = events.length;
  try {
    await assert.rejects(reports.post(session, { title: "Will not commit", body: "b", file: "findings.md" }), /FOREIGN KEY constraint failed/);
  } finally {
    d.exec("DROP TRIGGER temp.report_commit_fails; DROP TABLE temp.report_commit_child; DROP TABLE temp.report_commit_parent;");
  }
  assert.equal(reportCount(), rowsBefore, "the row was rolled back");
  assert.equal(upserts(events.slice(eventsBefore)).length, 0, "no window was told about it");
  assert.ok(!existsSync(reportDocumentDir(`r-${next}`, stateDir)), "the copied document was removed with its row");
  // And the next post stores normally: nothing was left half-committed.
  const stored = await reports.post(session, { title: "Commits", body: "b", file: "findings.md" });
  assert.equal(readFileSync(join(reportDocumentDir(stored.id, stateDir), "findings.md"), "utf8"), "# Findings\n");
  assert.deepEqual(reports.listForSession("s-commit-fail").map((r) => r.id), [stored.id]);
});

test("while the inbox flag is off no window is told about a report, and turning it on sends what is waiting", async () => {
  const { registry, reports, events } = wired();
  const report = await reports.post(mkSession({ id: "s-flag", cwd: checkout() }), { title: "Behind the flag", body: "b" });
  flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: false });
  try {
    assert.equal(registry.snapshot().reports, undefined, "the snapshot omits reports");
    const before = events.length;
    reports.markOpened(report.id);
    assert.equal(upserts(events.slice(before)).length, 0, "no report event while the flag is off");
    flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });
    assert.ok(upserts(events.slice(before)).some((r) => r.id === report.id), "turning the flag on resends it");
    assert.ok((registry.snapshot().reports ?? []).some((r) => r.id === report.id));
  } finally {
    flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });
  }
});

// ---- The announce stamp ----
//
// A post always happens mid-turn, so whether the agent then stopped is only known afterwards. The
// report is stamped `back` if its session leaves working within the grace period, else `working`
// when the period ends, and one found unstamped at startup is stamped from its session's state.
// Each stamp is one `report_upsert`, which is what raises the report's notification.

/** A registry stand-in whose sessions and session events the test drives by hand. */
function fakeRegistry() {
  const listeners = new Set<(event: ServerEvent) => void>();
  const sessions = new Map<string, Session>();
  const upserted: ReportItem[] = [];
  const emit = (event: ServerEvent) => { for (const fn of listeners) fn(event); };
  const registry = {
    subscribe(fn: (event: ServerEvent) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    getSession: (id: string) => sessions.get(id),
    upsertReport: (report: ReportItem) => { upserted.push(report); },
    reportsToRead: () => [],
    setReportMutes: () => undefined,
    listReportMutes: () => [],
    listResidentRuns: () => [],
    // An author's name reads its resident's current reference name from the profiles.
    listResidentProfiles: () => [],
  } as unknown as InstanceType<typeof Registry>;
  return {
    registry,
    upserted,
    set(session: Session) { sessions.set(session.id, session); emit({ type: "session_upsert", session }); },
    remove(id: string) { sessions.delete(id); emit({ type: "session_remove", id }); },
  };
}

/** Timers the test fires by hand, recording the delay each was set for. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  return {
    timers: {
      set: (fn: () => void, ms: number) => { pending.set(++next, { fn, ms }); return next; },
      clear: (handle: unknown) => { pending.delete(handle as number); },
    },
    delays: () => [...pending.values()].map((timer) => timer.ms),
    // Deleting the entry being visited is safe while iterating a Map.
    fireAll() { for (const [id, timer] of pending) { pending.delete(id); timer.fn(); } },
    /** Fire only the timers set so far; one a callback sets is left for the next call. */
    fireSetSoFar() {
      for (const [id, timer] of new Map(pending)) { pending.delete(id); timer.fn(); }
    },
  };
}

const working = (id: string, over: Partial<Session> = {}) =>
  mkSession({ id, state: "working", stateConfirmed: true, cwd: checkout(), ...over });

function announcer(clock: { now: number }) {
  const fake = fakeRegistry();
  const time = fakeTimers();
  const reports = new ReportManager(fake.registry, { now: () => clock.now, timers: time.timers });
  after(() => reports.stop());
  const stamps = (id: string) => fake.upserted.filter((r) => r.id === id).map((r) => [r.announcedAs, r.announcedAt]);
  return { ...fake, ...time, reports, stamps };
}

test("a report whose session stops within the grace period is stamped back, once", async () => {
  const clock = { now: 1_000 };
  const a = announcer(clock);
  const session = working("s-back");
  a.set(session);
  const report = await a.reports.post(session, { title: "Done", body: "Read this." });
  assert.deepEqual(a.delays().slice(-1), [20_000], "the grace period is twenty seconds");
  assert.deepEqual(a.stamps(report.id), [[null, null]], "posting announces nothing yet");
  // Still working: nothing. Then it stops.
  clock.now = 3_000;
  a.set({ ...session, activity: "Bash" });
  assert.deepEqual(a.stamps(report.id), [[null, null]]);
  clock.now = 6_000;
  a.set({ ...session, state: "idle" });
  assert.deepEqual(a.stamps(report.id), [[null, null], ["back", 6_000]]);
  assert.equal(a.reports.get(report.id)?.announcedAs, "back");
  // The stamp is final: the grace period ending, or the session working again, changes nothing.
  a.fireAll();
  a.set(session);
  a.set({ ...session, state: "idle" });
  assert.equal(a.stamps(report.id).length, 2);
});

test("a stamp whose write fails is kept and written again, from a sighting or from the grace period", async (t) => {
  const { openDb } = await import("../src/server/db.ts");
  t.mock.method(console, "error", () => undefined);
  const busy = (on: boolean) => openDb().exec(on
    ? "CREATE TEMP TRIGGER report_stamp_busy BEFORE UPDATE OF announced_as ON reports BEGIN SELECT RAISE(ABORT, 'database is locked'); END;"
    : "DROP TRIGGER IF EXISTS temp.report_stamp_busy;");
  t.after(() => busy(false));
  const clock = { now: 1_000 };
  const a = announcer(clock);
  const stops = working("s-stamp-busy-back");
  const keeps = working("s-stamp-busy-working");
  a.set(stops);
  a.set(keeps);
  const back = await a.reports.post(stops, { title: "Stopped", body: "b" });
  const kept = await a.reports.post(keeps, { title: "Kept going", body: "b" });
  busy(true);
  // The session stops while the database is busy: nothing escapes into the registry's loop, and
  // the report is not stamped yet.
  clock.now = 3_000;
  assert.doesNotThrow(() => a.set({ ...stops, state: "idle" }));
  assert.equal(a.reports.get(back.id)?.announcedAs, null);
  assert.ok(a.delays().includes(5_000), "the stamp is written again shortly");
  // The wording is decided: working again before the retry does not change it.
  a.set(stops);
  // The other's grace period ends while still busy: its timer does not throw either, and retries.
  clock.now = 21_000;
  assert.doesNotThrow(() => a.fireSetSoFar());
  assert.equal(a.reports.get(kept.id)?.announcedAs, null);
  // Still busy at the first retry: tried again, still not dropped.
  assert.doesNotThrow(() => a.fireSetSoFar());
  assert.deepEqual([a.reports.get(back.id)?.announcedAs, a.reports.get(kept.id)?.announcedAs], [null, null]);
  busy(false);
  clock.now = 31_000;
  a.fireSetSoFar();
  assert.deepEqual(a.stamps(back.id).at(-1), ["back", 31_000]);
  assert.deepEqual(a.stamps(kept.id).at(-1), ["working", 31_000]);
  assert.deepEqual(a.delays(), [], "both watches are done");
});

test("a stamp whose write keeps failing backs off and is given up with one last log", async (t) => {
  const { openDb } = await import("../src/server/db.ts");
  const logged = t.mock.method(console, "error", () => undefined);
  const busy = (on: boolean) => openDb().exec(on
    ? "CREATE TEMP TRIGGER report_stamp_stuck BEFORE UPDATE OF announced_as ON reports BEGIN SELECT RAISE(ABORT, 'attempt to write a readonly database'); END;"
    : "DROP TRIGGER IF EXISTS temp.report_stamp_stuck;");
  t.after(() => busy(false));
  const clock = { now: 1_000 };
  const a = announcer(clock);
  const session = working("s-stamp-stuck");
  a.set(session);
  const report = await a.reports.post(session, { title: "Never stamped", body: "b" });
  busy(true);
  a.set({ ...session, state: "idle" });
  // Each failure waits longer, up to a minute, then the stamp is given up: no retry left.
  const waits: number[] = [];
  for (let i = 0; i < 10 && a.delays().length > 0; i++) {
    waits.push(...a.delays());
    a.fireSetSoFar();
  }
  assert.deepEqual(waits, [5_000, 10_000, 20_000, 40_000, 60_000]);
  assert.deepEqual(a.delays(), [], "the watch is gone");
  assert.equal(logged.mock.callCount(), 6, "one line per failed write, the last saying it gave up");
  assert.match(String(logged.mock.calls.at(-1)?.arguments[0]), /giving up/);
  // Given up for good: the database recovering later stamps nothing, and the report still waits
  // to be read.
  busy(false);
  a.set(session);
  a.set({ ...session, state: "idle" });
  assert.equal(a.reports.get(report.id)?.announcedAs, null);
  assert.equal(a.reports.get(report.id)?.readAt, null);
});

test("a report whose session keeps working through the grace period is stamped working", async () => {
  const clock = { now: 1_000 };
  const a = announcer(clock);
  const session = working("s-busy");
  a.set(session);
  const report = await a.reports.post(session, { title: "Halfway", body: "Still going." });
  clock.now = 21_000;
  a.fireAll();
  assert.deepEqual(a.stamps(report.id), [[null, null], ["working", 21_000]]);
  // Stopping afterwards does not restamp it.
  a.set({ ...session, state: "idle" });
  assert.equal(a.reports.get(report.id)?.announcedAs, "working");
});

test("a session that leaves after posting is back; one never seen working is announced as still working", async () => {
  const clock = { now: 1_000 };
  const a = announcer(clock);
  const gone = working("s-gone");
  a.set(gone);
  const left = await a.reports.post(gone, { title: "Bye", body: "b" });
  a.remove("s-gone");
  assert.equal(a.reports.get(left.id)?.announcedAs, "back");
  // An uninstrumented session reads idle whatever it does, which is no evidence it stopped.
  const quiet = working("s-quiet", { state: "idle", stateConfirmed: false });
  a.set(quiet);
  const unproven = await a.reports.post(quiet, { title: "Hm", body: "b" });
  a.set({ ...quiet, activity: "still typing" });
  assert.equal(a.reports.get(unproven.id)?.announcedAs, null);
  a.fireAll();
  assert.equal(a.reports.get(unproven.id)?.announcedAs, "working");
});

test("a report posted while its session's state says it is not working, but says something, is read as a restart is", async () => {
  const clock = { now: 1_000 };
  const a = announcer(clock);
  // Blocked on you when it posts (a question open, confirmed), then still not working: it stopped.
  const asking = working("s-post-blocked", { state: "awaiting_review", pendingReviews: 1 });
  a.set(asking);
  const asked = await a.reports.post(asking, { title: "Blocked", body: "b" });
  a.set({ ...asking, state: "idle", pendingReviews: 0 });
  assert.equal(a.reports.get(asked.id)?.announcedAs, "back");
  // Confirmed idle when it posts (a hook already said the turn ended), then idle again: back.
  const done = working("s-post-confirmed-idle", { state: "idle" });
  a.set(done);
  const posted = await a.reports.post(done, { title: "Done", body: "b" });
  a.set({ ...done, activity: "idle" });
  assert.equal(a.reports.get(posted.id)?.announcedAs, "back");
  // Confirmed idle at the post, then working: it kept going, and the grace period decides.
  const busy = working("s-post-idle-then-busy", { state: "idle" });
  a.set(busy);
  const kept = await a.reports.post(busy, { title: "Kept going", body: "b" });
  a.set({ ...busy, state: "working" });
  a.fireAll();
  assert.equal(a.reports.get(kept.id)?.announcedAs, "working");
});

test("a report read or replaced before its stamp is never stamped", async () => {
  const clock = { now: 1_000 };
  const a = announcer(clock);
  const session = working("s-early");
  a.set(session);
  const read = await a.reports.post(session, { title: "Quick", body: "b" });
  a.reports.markRead(read.id, "mark-read");
  const first = await a.reports.post(session, { title: "Draft", body: "b" });
  const second = await a.reports.post(session, { title: "Final", body: "b", replaces: first.id });
  a.set({ ...session, state: "idle" });
  a.fireAll();
  assert.equal(a.reports.get(read.id)?.announcedAs, null);
  assert.equal(a.reports.get(first.id)?.announcedAs, null);
  assert.equal(a.reports.get(second.id)?.announcedAs, "back");
});

test("a report the daemon stopped before stamping is stamped from its session's state after a restart", async () => {
  const clock = { now: 1_000 };
  const before = announcer(clock);
  const idle = working("s-restart-idle");
  const busy = working("s-restart-busy");
  const unseen = working("s-restart-unseen");
  for (const session of [idle, busy, unseen]) before.set(session);
  const idleReport = await before.reports.post(idle, { title: "One", body: "b" });
  const busyReport = await before.reports.post(busy, { title: "Two", body: "b" });
  const unseenReport = await before.reports.post(unseen, { title: "Three", body: "b" });
  before.reports.stop();

  // The restarted daemon re-adopts sessions after the manager starts.
  clock.now = 30_000;
  const after = announcer(clock);
  for (const r of [idleReport, busyReport, unseenReport]) assert.equal(after.reports.get(r.id)?.announcedAs, null);
  after.set({ ...idle, state: "idle" });
  assert.equal(after.reports.get(idleReport.id)?.announcedAs, "back", "first seen stopped");
  after.set(busy);
  assert.equal(after.reports.get(busyReport.id)?.announcedAs, null, "first seen working: wait");
  after.fireAll();
  assert.equal(after.reports.get(busyReport.id)?.announcedAs, "working", "still working when the grace ended");
  assert.equal(after.reports.get(unseenReport.id)?.announcedAs, "back", "its session never came back");
});

test("after a restart an unconfirmed session's idle state is no evidence it stopped: posted a report, unless it leaves", async () => {
  const clock = { now: 1_000 };
  const before = announcer(clock);
  const quiet = working("s-restart-unconfirmed");
  const late = working("s-restart-unconfirmed-late");
  const gone = working("s-restart-unconfirmed-gone");
  for (const session of [quiet, late, gone]) before.set(session);
  const quietReport = await before.reports.post(quiet, { title: "Quiet", body: "b" });
  const goneReport = await before.reports.post(gone, { title: "Gone", body: "b" });
  clock.now = 2_000;
  before.reports.stop();

  // Restarted within the grace period: re-adopted idle, before any hook confirms its state.
  const after = announcer(clock);
  after.set({ ...quiet, state: "idle", stateConfirmed: false });
  after.set({ ...gone, state: "idle", stateConfirmed: false });
  assert.equal(after.reports.get(quietReport.id)?.announcedAs, null, "an unconfirmed idle sighting stamps nothing");
  after.remove(gone.id);
  assert.equal(after.reports.get(goneReport.id)?.announcedAs, "back", "leaving is evidence");
  after.fireSetSoFar();
  assert.equal(after.reports.get(quietReport.id)?.announcedAs, "working");
  after.reports.stop();

  // Restarted after the deadline, first sighting unconfirmed: announced as still working at once.
  const lateReport = await after.reports.post(late, { title: "Late", body: "b" });
  after.reports.stop();
  clock.now = 30_000;
  const later = announcer(clock);
  later.fireSetSoFar(); // the deadline passed with the session not yet re-adopted
  later.set({ ...late, state: "idle", stateConfirmed: false });
  assert.equal(later.reports.get(lateReport.id)?.announcedAs, "working");
});

test("a restart recovers only reports it interrupted: an older unstamped report is never stamped, and raises nothing", async () => {
  const clock = { now: 1_000 };
  const before = announcer(clock);
  const session = working("s-backlog");
  before.set(session);
  const old = await before.reports.post(session, { title: "From before stamping existed", body: "b" });
  before.reports.stop();

  // Long after its deadline: a backlog report, as every report from before this build is.
  clock.now = 1_000 + 3 * 20_000;
  const after = announcer(clock);
  after.set({ ...session, state: "idle" }); // re-adopted idle and confirmed
  after.fireAll();
  assert.equal(after.reports.get(old.id)?.announcedAs, null, "left unstamped");
  assert.ok(after.upserted.filter((r) => r.id === old.id).every((r) => r.announcedAs === null), "no stamp event, so no notification");
  after.remove(session.id);
  assert.equal(after.reports.get(old.id)?.announcedAs, null);
});

test("a report posted with an unconfirmed state reads back once its session says it stopped", async () => {
  const clock = { now: 1_000 };
  const a = announcer(clock);
  // Uninstrumented at the post, then blocked on you (a question open): it stopped.
  const asking = working("s-unconfirmed-then-blocked", { state: "idle", stateConfirmed: false });
  a.set(asking);
  const asked = await a.reports.post(asking, { title: "Asking", body: "b" });
  a.set({ ...asking, pendingReviews: 1 });
  assert.equal(a.reports.get(asked.id)?.announcedAs, "back");
  // Unconfirmed at the post, then a hook confirms the turn ended: it stopped.
  const ended = working("s-unconfirmed-then-confirmed", { state: "idle", stateConfirmed: false });
  a.set(ended);
  const done = await a.reports.post(ended, { title: "Done", body: "b" });
  a.set({ ...ended, stateConfirmed: true });
  assert.equal(a.reports.get(done.id)?.announcedAs, "back");
  // Still saying nothing: no stamp until the grace ends, and then still working.
  const quiet = working("s-unconfirmed-still-quiet", { state: "idle", stateConfirmed: false });
  a.set(quiet);
  const unproven = await a.reports.post(quiet, { title: "Hm", body: "b" });
  a.set({ ...quiet, activity: "still typing" });
  assert.equal(a.reports.get(unproven.id)?.announcedAs, null);
  a.fireAll();
  assert.equal(a.reports.get(unproven.id)?.announcedAs, "working");
});

test("after a restart an unconfirmed session blocked on you is evidence it stopped: back", async () => {
  const clock = { now: 1_000 };
  const before = announcer(clock);
  const asking = working("s-restart-blocked");
  const late = working("s-restart-blocked-late");
  before.set(asking);
  before.set(late);
  const askingReport = await before.reports.post(asking, { title: "Asking", body: "b" });
  const lateReport = await before.reports.post(late, { title: "Late", body: "b" });
  before.reports.stop();

  clock.now = 2_000;
  const after = announcer(clock);
  // Re-adopted unconfirmed, but with a question open: blocked on you, so stopped.
  after.set({ ...asking, state: "idle", stateConfirmed: false, pendingReviews: 1 });
  assert.equal(after.reports.get(askingReport.id)?.announcedAs, "back");
  // The same for a second session first seen blocked on you.
  after.set({ ...late, state: "idle", stateConfirmed: false, pendingReviews: 1 });
  assert.equal(after.reports.get(lateReport.id)?.announcedAs, "back");
});

test("after a restart the grace period keeps its original deadline: still working at it is working", async () => {
  // The reviewer's sequence: posted while working, the daemon restarts 19 s later, the agent is
  // still working when the original 20 s deadline passes, and stops 6 s after that.
  const clock = { now: 1_000 };
  const before = announcer(clock);
  const session = working("s-deadline");
  before.set(session);
  const report = await before.reports.post(session, { title: "Profiling", body: "b" });
  before.reports.stop();

  clock.now = 20_000;
  const after = announcer(clock);
  assert.ok(after.delays().includes(1_000), "only the remaining second is waited, not a fresh 20 s");
  after.set(session); // re-adopted, still working
  clock.now = 21_000;
  after.fireSetSoFar(); // the original deadline
  assert.equal(after.reports.get(report.id)?.announcedAs, "working");
  clock.now = 26_000;
  after.set({ ...session, state: "idle" });
  assert.equal(after.reports.get(report.id)?.announcedAs, "working", "stopping after the deadline changes nothing");
});

test("after a restart past the deadline, the session's first sighting decides, and an unseen one is gone", async () => {
  const clock = { now: 1_000 };
  const before = announcer(clock);
  const late = working("s-late-seen");
  const lost = working("s-never-seen");
  before.set(late);
  before.set(lost);
  const lateReport = await before.reports.post(late, { title: "Late", body: "b" });
  const lostReport = await before.reports.post(lost, { title: "Lost", body: "b" });
  before.reports.stop();

  clock.now = 30_000;
  const after = announcer(clock);
  after.fireSetSoFar(); // both deadlines have passed; neither session has been re-adopted yet
  assert.equal(after.reports.get(lateReport.id)?.announcedAs, null, "absence right after a restart says nothing");
  assert.equal(after.reports.get(lostReport.id)?.announcedAs, null);
  after.set(late); // first seen working, past its deadline
  assert.equal(after.reports.get(lateReport.id)?.announcedAs, "working");
  after.fireSetSoFar(); // one more grace period and the other session never came back
  assert.equal(after.reports.get(lostReport.id)?.announcedAs, "back");
});

test("every report a return digest counted is marked in the table, stamped or not, once", async () => {
  const clock = { now: 1_000 };
  const a = announcer(clock);
  const counted = working("s-digest-counted");
  const plain = working("s-digest-plain");
  a.set(counted);
  a.set(plain);
  const countedReport = await a.reports.post(counted, { title: "Counted", body: "b" });
  const plainReport = await a.reports.post(plain, { title: "Plain", body: "b" });
  // Already stamped while away: marked too, so a window that missed the stamp's event and
  // reconnects later is kept quiet.
  a.set({ ...plain, state: "idle" });
  clock.now = 4_000;
  a.reports.countedInDigest([countedReport.id, plainReport.id, "r-999999"]);
  assert.equal(a.reports.get(countedReport.id)?.countedInDigestAt, 4_000);
  assert.deepEqual([a.reports.get(plainReport.id)?.announcedAs, a.reports.get(plainReport.id)?.countedInDigestAt], ["back", 4_000]);
  assert.equal(a.upserted.filter((r) => r.id === plainReport.id).at(-1)?.countedInDigestAt, 4_000);
  // Every window is told at once, so even one that misses the later stamp event holds the mark.
  assert.deepEqual(a.upserted.filter((r) => r.id === countedReport.id).at(-1)?.countedInDigestAt, 4_000);
  // The stamp keeps it, and a second count changes nothing.
  a.set({ ...counted, state: "idle" });
  assert.deepEqual([a.reports.get(countedReport.id)?.announcedAs, a.reports.get(countedReport.id)?.countedInDigestAt], ["back", 4_000]);
  clock.now = 9_000;
  a.reports.countedInDigest([countedReport.id]);
  assert.equal(a.reports.get(countedReport.id)?.countedInDigestAt, 4_000);
});

test("a claimed digest's mark survives a daemon restart before the stamp lands", async () => {
  const clock = { now: 1_000 };
  const before = announcer(clock);
  const session = working("s-digest-restart");
  before.set(session);
  const report = await before.reports.post(session, { title: "Counted, then restarted", body: "b" });
  clock.now = 3_000;
  before.reports.countedInDigest([report.id]);
  clock.now = 5_000;
  before.reports.digestClaimed(); // a dashboard read the digest
  before.reports.stop(); // the daemon stops before the stamp

  clock.now = 10_000;
  const after = announcer(clock);
  after.set({ ...session, state: "idle" }); // re-adopted, stopped: stamped back
  const stamped = after.upserted.filter((r) => r.id === report.id && r.announcedAs !== null);
  assert.deepEqual(stamped.map((r) => [r.announcedAs, r.countedInDigestAt]), [["back", 3_000]]);
  // The dashboard's alert rule reads the mark and stays quiet.
  const { detectAlerts } = await import("../src/shared/alerts.ts");
  const scope = (reports: ReportItem[]) => ({ sessions: [], tasks: [], reports, takenAt: clock.now });
  assert.deepEqual(detectAlerts(scope([{ ...stamped[0]!, announcedAs: null, announcedAt: null }]), scope(stamped)), []);
});

test("a digest lost to a restart before any dashboard claimed it takes its marks with it", async () => {
  const clock = { now: 1_000 };
  const before = announcer(clock);
  const session = working("s-digest-unclaimed");
  before.set(session);
  const report = await before.reports.post(session, { title: "Counted, never shown", body: "b" });
  clock.now = 3_000;
  before.reports.countedInDigest([report.id]);
  // Every window is told at once, from memory: the closed window's digest is waiting to be read.
  assert.equal(before.reports.get(report.id)?.countedInDigestAt, 3_000);
  before.reports.stop(); // the daemon stops before any dashboard claims the digest

  clock.now = 10_000;
  const after = announcer(clock);
  // The digest is gone, so nothing keeps the report quiet as if one had shown it.
  assert.equal(after.reports.get(report.id)?.countedInDigestAt, null);
  // The marks were the old run's own: starting another manager erased nothing of the first one's.
  // What the new run lacks is only what was never written to the table.
  assert.equal(before.reports.get(report.id)?.countedInDigestAt, 3_000);
  after.set({ ...session, state: "idle" });
  const stamped = after.upserted.filter((r) => r.id === report.id && r.announcedAs !== null);
  assert.deepEqual(stamped.map((r) => [r.announcedAs, r.countedInDigestAt]), [["back", null]]);
  // A claim in the new run has no marks of the old one to keep.
  after.reports.digestClaimed();
  assert.equal(after.reports.get(report.id)?.countedInDigestAt, null);
});

function mkDiscovered(id: string, over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/wt/reports",
    gitBranch: "harness/reports",
    pid: 1,
    tty: "ttys015",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: `%${id}` })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

test("a Mark all read batch is one transaction: a write that fails partway reads and announces nothing", async () => {
  const { reports, events } = wired();
  const session = mkSession({ id: "s-read-all-atomic", name: "batch", cwd: checkout() });
  const posted = [
    await reports.post(session, { title: "One", body: "b" }),
    await reports.post(session, { title: "Two", body: "b" }),
    await reports.post(session, { title: "Three", body: "b" }),
  ];
  const ids = posted.map((report) => report.id);
  // The database refuses the second report's write, as a busy or failing one would, after the
  // first report's write has already run inside the batch.
  db.openDb().exec(`CREATE TEMP TRIGGER fail_read_all BEFORE UPDATE OF read_at ON reports
    WHEN NEW.id = '${ids[1]}' BEGIN SELECT RAISE(ABORT, 'database is busy'); END`);
  const before = events.length;
  try {
    assert.throws(() => reports.markAllRead(ids), /database is busy/);
  } finally {
    db.openDb().exec("DROP TRIGGER IF EXISTS fail_read_all");
  }
  // Rolled back whole: the first report's write is undone too, and no window was told any changed.
  assert.deepEqual(reports.listForSession(session.id).map((report) => [report.id, report.readAt, report.readBy]),
    ids.map((id) => [id, null, null]));
  assert.equal(events.slice(before).filter((event) => event.type === "report_upsert").length, 0);

  // The same batch, once the database accepts it: all three read at one moment, each announced once.
  const cleared = reports.markAllRead(ids);
  assert.deepEqual(cleared.map((report) => [report.id, report.readBy]), ids.map((id) => [id, "mark-all"]));
  assert.equal(new Set(cleared.map((report) => report.readAt)).size, 1, "one moment for the whole batch");
  const announced = upserts(events.slice(before)).filter((report) => report.readBy === "mark-all").map((report) => report.id);
  assert.deepEqual(announced, ids);
});
