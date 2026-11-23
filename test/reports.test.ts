import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ServerEvent } from "../src/shared/types.ts";
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
  raw.exec("DROP TABLE IF EXISTS reports; PRAGMA user_version = 42;");
  raw.close();
  const upgraded = db.openDb();
  assert.equal((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, db.CURRENT_DATABASE_SCHEMA_VERSION);
  assert.ok(db.CURRENT_DATABASE_SCHEMA_VERSION >= 43);
  const columns = (upgraded.prepare("PRAGMA table_info(reports)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const column of [
    "id", "session_id", "task_id", "repository", "author_key", "author_name", "author_resident_profile_id",
    "title", "body", "url", "document_name", "document_kind", "root_id", "version", "superseded_by",
    "created_at", "root_created_at", "opened_at", "read_at", "read_by", "follow_up_task_id",
    "announced_as", "announced_at", "published_archive_key",
  ]) assert.ok(columns.includes(column), `reports.${column}`);
  assert.equal((upgraded.prepare("SELECT COUNT(*) AS n FROM reports").get() as { n: number }).n, 0);
  db.closeDb();
  db.openDb();
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
