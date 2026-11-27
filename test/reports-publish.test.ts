import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { rename as renamePath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { REPORT_LIMITS, type ReportItem } from "../src/shared/reports.ts";
import { mkSession } from "./helpers/session-fixture.ts";

// `POST /api/reports/:id/publish`: Publish as scout.
//
// What is at stake: an agent's report document reaches the scout archive only when the operator
// presses Publish as scout, once per report, and always from the copy Mission Control stored when
// the report was posted. The request names the report and nothing else: the daemon builds the
// page (an HTML document as stored, a Markdown document rendered by the daemon), so no browser can
// substitute a page and a checkout edited after posting changes nothing. A page the archive's
// static checker refuses is refused with its problems and archives nothing. Neither reading the
// document nor publishing it clears the report from to read.

const home = mkdtempSync(join(tmpdir(), "mission-reports-publish-"));
process.env.HARNESS_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ReportManager, reportDocumentDir } = await import("../src/server/reports.ts");
const { renderMarkdownPage, readStoredReportCompanions, linkedCompanionPaths } = await import("../src/server/report-document.ts");
const { ArchiveManager, reportArchiveId } = await import("../src/server/archives/manager.ts");
const { ArchiveStore } = await import("../src/server/archives/store.ts");
const { verifyArchiveBundle } = await import("../src/server/archives/bundle.ts");
const flags = await import("../src/server/feature-flags/index.ts");

type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

after(() => rmSync(home, { recursive: true, force: true }));

const LOOPBACK = { host: "127.0.0.1:7317" };
const PRODUCER = "00000000-0000-4000-8000-0000000000aa";
flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

// chmod cannot lock root out, so the unreadable-library cases only mean something for a user.
const asRoot = process.getuid?.() === 0;

let serial = 0;
function setup(options: {
  onPruned?: (keys: readonly string[]) => void;
  rename?: (from: string, to: string) => Promise<void>;
  beforeCompanionOpen?: (path: string) => Promise<void> | void;
} = {}) {
  serial += 1;
  const registry = new Registry();
  const reports = new ReportManager(registry, { stateDir: home, beforeCompanionOpen: options.beforeCompanionOpen });
  const root = join(home, `library-${serial}`);
  const archives = new ArchiveManager({
    root,
    legacyRoots: [],
    store: new ArchiveStore(openDb()),
    producer: { id: PRODUCER, label: null },
    intervalMs: null,
    watch: false,
    onPruned: options.onPruned,
    rename: options.rename,
  });
  after(() => {
    reports.stop();
    archives.stop();
  });
  const app = buildApp({
    registry,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
    reports,
    archives,
  });
  const checkout = join(home, `checkout-${serial}`);
  mkdirSync(checkout, { recursive: true });
  const session = mkSession({ id: `s-publish-${serial}`, name: "Diagnose the build", repoRoot: "/repos/build", cwd: checkout });
  const post = async (file: string, contents: string | Buffer, title = "Build failure diagnosed") => {
    writeFileSync(join(checkout, file), contents);
    return reports.post(session, { title, body: "See the attached document.", file });
  };
  const publish = async (id: string, init: { body?: string; headers?: Record<string, string> } = {}) => {
    const res = await app.request(`/api/reports/${id}/publish`, {
      method: "POST",
      headers: { ...LOOPBACK, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return { status: res.status, body: (await res.json()) as { archiveKey?: string; replayed?: boolean; error?: string; problems?: string[]; report?: ReportItem } };
  };
  /** Every bundle in this library's producer namespace. */
  const bundles = () => (existsSync(join(root, PRODUCER)) ? readdirSync(join(root, PRODUCER)) : []);
  const archivedPage = (archiveId: string) => readFileSync(join(root, PRODUCER, archiveId, "report", "report.html"));
  const manifest = (archiveId: string) =>
    JSON.parse(readFileSync(join(root, PRODUCER, archiveId, "manifest.json"), "utf8")) as Record<string, any>;
  return { app, registry, reports, archives, root, checkout, post, publish, bundles, archivedPage, manifest };
}

const STATIC_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Findings</title></head>" +
  "<body><h1>Findings</h1><p>The cache key ignored the lockfile.</p></body></html>";

test("nothing reaches the archive until the operator publishes", async () => {
  const { post, bundles } = setup();
  await post("findings.html", STATIC_HTML);
  await post("notes.md", "# Notes\n");
  assert.deepEqual(bundles(), [], "posting a report with a document archives nothing");
});

test("an HTML document publishes once, as its stored bytes, and a repeated publish returns the same archive", async () => {
  const { post, publish, bundles, archivedPage, manifest, reports } = setup();
  const report = await post("findings.html", STATIC_HTML);
  const first = await publish(report.id);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.equal(first.body.archiveKey, `${PRODUCER}~${archiveId}`);
  assert.equal(first.body.replayed, false);
  assert.equal(first.body.report?.publishedArchiveKey, first.body.archiveKey);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, first.body.archiveKey);

  const stored = readFileSync(join(reportDocumentDir(report.id, home), "findings.html"));
  assert.equal(sha256(archivedPage(archiveId)), sha256(stored), "the archived page is the stored copy, byte for byte");
  const written = manifest(archiveId);
  assert.equal(written.kind, "scout");
  assert.equal(written.archive.title, "Build failure diagnosed");
  assert.equal(written.archive.prompts ?? null, null, "a report bundle has no prompt trail");
  assert.deepEqual(written.content.artifacts.map((artifact: { archive_path: string }) => artifact.archive_path), ["report/report.html"]);

  const again = await publish(report.id);
  assert.equal(again.status, 200);
  assert.equal(again.body.archiveKey, first.body.archiveKey);
  assert.equal(again.body.replayed, true);
  assert.deepEqual(bundles(), [archiveId], "one report, one archive");
});

test("an archive already published for a report whose key was lost is re-verified and its key restored", async () => {
  const { post, publish, bundles, archivedPage, reports } = setup();
  const report = await post("findings.html", STATIC_HTML);
  const first = await publish(report.id);
  assert.equal(first.status, 200);
  // The bundle is on disk but the report no longer names it: a crash between the rename and the
  // row write, or a lost response, leaves exactly this.
  openDb().prepare("UPDATE reports SET published_archive_key = NULL WHERE id = ?").run(report.id);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, null);
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  const before = archivedPage(archiveId);

  const again = await publish(report.id);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replayed, true, "the existing bundle was re-verified, not written again");
  assert.equal(again.body.archiveKey, first.body.archiveKey);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, first.body.archiveKey, "the key is restored");
  assert.deepEqual(bundles(), [archiveId]);
  assert.deepEqual(archivedPage(archiveId), before);
});

test("after a lost key, a report's own archive is returned even when the page built now differs, and is never rewritten", async () => {
  const { post, publish, reports, bundles, archivedPage } = setup();
  const report = await post("render.md", "# Findings\n\nFirst render.\n", "Markdown re-render");
  const key = (await publish(report.id)).body.archiveKey!;
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  const before = archivedPage(archiveId);
  // The key is lost, and the page the daemon would build now differs from the archived one, as it
  // does when the Markdown renderer or its page style has changed since the first publish.
  openDb().prepare("UPDATE reports SET published_archive_key = NULL WHERE id = ?").run(report.id);
  writeFileSync(join(reportDocumentDir(report.id, home), "render.md"), "# Findings\n\nA different render.\n");

  const again = await publish(report.id);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.archiveKey, key);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, key, "its own archive's key is restored");
  assert.deepEqual(archivedPage(archiveId), before, "the archive is returned as it is, never rewritten");
  assert.deepEqual(bundles(), [archiveId]);
});

test("a bundle at the report's key that this report did not publish is a conflict with a remedy, and is never overwritten", async () => {
  const { post, publish, reports, bundles, archivedPage, archives } = setup();
  const report = await post("taken.html", STATIC_HTML, "Key taken");
  // Another session's report bundle already sits at this report's derived id.
  const foreign = await archives.publishReportPage({
    reportId: report.id,
    reportCreatedAt: report.createdAt,
    title: "Someone else's page",
    page: Buffer.from("<html><body><p>Not this report</p></body></html>"),
    companions: [],
    documentName: "report.html",
    session: { id: "s-someone-else", name: "Other", taskId: null },
    repositoryLabel: null,
  });
  assert.equal(foreign.ok, true);
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  const before = archivedPage(archiveId);

  const conflict = await publish(report.id);
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.match(conflict.body.problems!.join(" "), /that this report did not publish; delete it from the Scouts page, then publish again/);
  assert.deepEqual(archivedPage(archiveId), before, "the archive at that key is untouched");
  assert.deepEqual(bundles(), [archiveId]);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, null);
});

test("deleting a report's archive clears its key, tells every window, and Publish as scout writes it again", async () => {
  const { app, post, publish, bundles, reports, registry } = setup();
  const report = await post("findings.html", STATIC_HTML);
  const first = await publish(report.id);
  assert.equal(first.status, 200);
  const key = first.body.archiveKey!;
  const upserts: ReportItem[] = [];
  registry.subscribe((event) => { if (event.type === "report_upsert") upserts.push(event.report); });

  const deleted = await app.request(`/api/archives/${key}`, {
    method: "DELETE",
    headers: { ...LOOPBACK, "content-type": "application/json" },
    body: JSON.stringify({ confirmArchiveKey: key }),
  });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.deepEqual(bundles(), []);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, null, "the report no longer names a deleted archive");
  assert.ok(upserts.some((r) => r.id === report.id && r.publishedArchiveKey === null), "open windows hear it, so the card offers Publish again");
  assert.equal(reports.get(report.id)?.readAt, null, "deletion does not touch whether it was read");

  const again = await publish(report.id);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replayed, false, "the bundle was written again, not answered from the stale key");
  assert.equal(again.body.archiveKey, key);
  assert.equal(bundles().length, 1);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, key);
});

test("an archive removed from disk outside Mission Control is published again rather than answered with its stale key", async () => {
  const { post, publish, bundles, root, reports } = setup();
  const report = await post("findings.html", STATIC_HTML);
  const first = await publish(report.id);
  assert.equal(first.status, 200);
  rmSync(join(root, PRODUCER, reportArchiveId(PRODUCER, report.id, report.createdAt)), { recursive: true, force: true });
  assert.deepEqual(bundles(), []);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, first.body.archiveKey, "nothing told the report yet");

  const again = await publish(report.id);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replayed, false);
  assert.equal(again.body.archiveKey, first.body.archiveKey);
  assert.equal(bundles().length, 1, "the bundle is back");
});

test("a delete interrupted before the report's key was cleared is reconciled after restart, so Publish as scout comes back", async () => {
  const { post, publish, bundles, reports, archives, registry } = setup();
  const kept = await post("kept.html", STATIC_HTML, "Still archived");
  const lost = await post("lost.html", STATIC_HTML, "Archive deleted");
  const keptKey = (await publish(kept.id)).body.archiveKey!;
  const lostKey = (await publish(lost.id)).body.archiveKey!;
  // The bundle goes, and the daemon stops before the route's report cleanup runs: the report still
  // names an archive that no longer exists.
  await archives.delete(lostKey, lostKey);
  assert.equal(bundles().length, 1);
  assert.equal(reports.get(lost.id)?.publishedArchiveKey, lostKey, "the interrupted state");

  // After the restart: a new manager over the same table, reconciled as the daemon does at startup.
  reports.stop();
  const restarted = new ReportManager(registry, { stateDir: home });
  after(() => restarted.stop());
  const upserts: ReportItem[] = [];
  registry.subscribe((event) => { if (event.type === "report_upsert") upserts.push(event.report); });
  const cleared = await restarted.reconcilePublishedArchives((key) => archives.archivePresent(key));

  // The table is shared by this file's tests, whose reports name archives in other libraries; only
  // this test's two reports are asserted on.
  assert.ok(cleared.includes(lost.id), "the report whose archive is gone is cleared");
  assert.ok(!cleared.includes(kept.id), "the report whose archive verifies is not");
  assert.equal(restarted.get(lost.id)?.publishedArchiveKey, null);
  assert.equal(restarted.get(kept.id)?.publishedArchiveKey, keptKey, "a verified archive keeps its key");
  assert.ok(upserts.some((r) => r.id === lost.id && r.publishedArchiveKey === null), "open cards hear it");
  assert.equal(restarted.get(lost.id)?.readAt, null);
  assert.ok(!(await restarted.reconcilePublishedArchives((key) => archives.archivePresent(key))).includes(lost.id), "idempotent");
});

test("reconciliation never clears a key a publish of the same report has just written", async () => {
  const { post, publish, reports, archives } = setup();
  const report = await post("race.html", STATIC_HTML, "Race");
  const key = (await publish(report.id)).body.archiveKey!;
  await archives.delete(key, key);
  // The operator presses Publish while a reconciliation is starting: the publish republishes, and
  // the reconciliation, queued behind it for this report, finds the archive back and leaves it.
  const [published, cleared] = await Promise.all([
    publish(report.id),
    reports.reconcilePublishedArchives((k) => archives.archivePresent(k)),
  ]);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.ok(!cleared.includes(report.id), "the freshly written key survives");
  assert.equal(reports.get(report.id)?.publishedArchiveKey, key);
  assert.equal(await archives.archivePresent(key), true);
});

test("a check after an archive change visits only reports under the keys it is given, however many are published", async () => {
  const { post, publish, reports } = setup();
  const keys: string[] = [];
  for (const name of ["a", "b", "c", "d", "e"]) {
    const report = await post(`${name}.html`, STATIC_HTML, `Published ${name}`);
    keys.push((await publish(report.id)).body.archiveKey!);
  }
  const checked: string[] = [];
  const present = async (key: string) => { checked.push(key); return true; };

  await reports.reconcilePublishedArchives(present, [keys[2]!]);
  assert.deepEqual(checked, [keys[2]], "one pruned archive, one check, with five reports published");
  checked.length = 0;
  await reports.reconcilePublishedArchives(present, []);
  assert.equal(checked.length, 0, "a pass that pruned nothing checks nothing");
  // Only the startup check, with no keys, visits every published report.
  await reports.reconcilePublishedArchives(present);
  assert.ok(keys.every((key) => checked.includes(key)));
});

test("a reconciliation pass that prunes a removed bundle hands over exactly its key, and that report goes back to unpublished", async () => {
  const pruned: string[][] = [];
  const { post, publish, reports, archives, root } = setup({ onPruned: (keys) => pruned.push([...keys]) });
  const kept = await post("kept.html", STATIC_HTML, "Kept");
  const removed = await post("removed.html", STATIC_HTML, "Removed");
  const keptKey = (await publish(kept.id)).body.archiveKey!;
  const removedKey = (await publish(removed.id)).body.archiveKey!;
  await archives.reconcileNow();
  await archives.reconcileNow();
  // The archive index table is shared by this file's tests, each with its own library root, so
  // these first passes prune the other tests' rows; none of them is this test's.
  assert.ok(pruned.flat().every((key) => key !== keptKey && key !== removedKey), "indexing prunes neither of this test's archives");
  pruned.length = 0;

  rmSync(join(root, PRODUCER, reportArchiveId(PRODUCER, removed.id, removed.createdAt)), { recursive: true, force: true });
  assert.equal(await archives.archivePresent(removedKey), false);
  assert.equal(await archives.archivePresent(keptKey), true);
  assert.equal(await archives.archivePresent("not-a-key"), false);
  await archives.reconcileNow();
  assert.deepEqual(pruned, [[removedKey]], "exactly the vanished archive");

  // What the daemon does with those keys.
  const cleared = await reports.reconcilePublishedArchives((key) => archives.archivePresent(key), pruned[0]);
  assert.deepEqual(cleared, [removed.id]);
  assert.equal(reports.get(removed.id)?.publishedArchiveKey, null, "its card offers Publish as scout again");
  assert.equal(reports.get(kept.id)?.publishedArchiveKey, keptKey);
});

test("a delete's report cleanup never clears the key of an archive a publish recreated in the meantime", async () => {
  const { post, publish, reports, archives, bundles } = setup();
  const report = await post("race.html", STATIC_HTML, "Delete and republish");
  const key = (await publish(report.id)).body.archiveKey!;
  // The order the review names: the bundle is deleted, a Publish press recreates and stamps it,
  // and only then does the delete route's cleanup for that key run.
  await archives.delete(key, key);
  const republished = await publish(report.id);
  assert.equal(republished.status, 200);
  assert.equal(republished.body.replayed, false);
  const cleared = await reports.reconcilePublishedArchives((k) => archives.archivePresent(k), [key]);
  assert.deepEqual(cleared, [], "the recreated archive is present, so its key stays");
  assert.equal(reports.get(report.id)?.publishedArchiveKey, key);
  assert.equal(bundles().length, 1);

  // Without a republish, the same cleanup does clear it.
  await archives.delete(key, key);
  assert.deepEqual(await reports.reconcilePublishedArchives((k) => archives.archivePresent(k), [key]), [report.id]);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, null);
});

test("through the routes: a Publish racing a DELETE ends published, with its archive present", async () => {
  // Fire one Publish from inside the delete's own rename of the bundle to the trash: after the
  // bundle has gone, before the DELETE route has run its report cleanup.
  let duringDelete: (() => void) | null = null;
  const { app, post, publish, reports, archives, bundles } = setup({
    rename: async (from, to) => {
      await renamePath(from, to);
      const fire = duringDelete;
      duringDelete = null;
      fire?.();
    },
  });
  const report = await post("route-race.html", STATIC_HTML, "Route race");
  const key = (await publish(report.id)).body.archiveKey!;
  let racing!: ReturnType<typeof publish>;
  duringDelete = () => { racing = publish(report.id); };

  const deleted = await app.request(`/api/archives/${key}`, {
    method: "DELETE",
    headers: { ...LOOPBACK, "content-type": "application/json" },
    body: JSON.stringify({ confirmArchiveKey: key }),
  });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  const raced = await racing;
  assert.equal(raced.status, 200, JSON.stringify(raced.body));
  assert.equal(await archives.archivePresent(key), true, "the republished archive exists");
  assert.equal(reports.get(report.id)?.publishedArchiveKey, key, "and the report still names it");
  assert.equal(bundles().length, 1);
});

test("a published bundle that is present but no longer verifies keeps its key, and is never rewritten", async () => {
  const { post, publish, reports, archives, bundles, root } = setup();
  const report = await post("damaged.html", STATIC_HTML, "Damaged on disk");
  const key = (await publish(report.id)).body.archiveKey!;
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  const page = join(root, PRODUCER, archiveId, "report", "report.html");
  // Edited on disk after publishing: the bundle is still there, but its page no longer matches
  // the digest in its manifest.
  writeFileSync(page, "<html><body><p>Edited by hand</p></body></html>");
  const damaged = readFileSync(page);

  // The startup check and a Publish press both see the bundle present, so neither clears the key:
  // the card keeps Published, and the Scouts page shows the archive as unreadable.
  assert.deepEqual(await reports.reconcilePublishedArchives((k) => archives.archivePresent(k), [key]), []);
  assert.ok(!(await reports.reconcilePublishedArchives((k) => archives.archivePresent(k))).includes(report.id));
  const pressed = await publish(report.id);
  assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
  assert.equal(pressed.body.archiveKey, key);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, key);
  assert.deepEqual(readFileSync(page), damaged, "the damaged bundle is left exactly as it is");
  assert.deepEqual(bundles(), [archiveId]);
});

test("a press that finds an unverifiable bundle at its key, with no key recorded, says so and writes nothing", async () => {
  const { post, publish, reports, bundles, root } = setup();
  const report = await post("stranded.html", STATIC_HTML, "Stranded bundle");
  await publish(report.id);
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  const page = join(root, PRODUCER, archiveId, "report", "report.html");
  writeFileSync(page, "<html><body><p>Edited by hand</p></body></html>");
  const damaged = readFileSync(page);
  // The key was lost (a crash before the row write), so the next press has no key to keep.
  openDb().prepare("UPDATE reports SET published_archive_key = NULL WHERE id = ?").run(report.id);

  const refused = await publish(report.id);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.problems!.join(" "), /already exists at .* but does not verify .*delete it from the Scouts page, then publish again/);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, null);
  assert.deepEqual(readFileSync(page), damaged, "nothing is renamed over or rewritten");
  assert.deepEqual(bundles(), [archiveId]);
});

test("a republish after the bundle was removed by hand writes a byte-identical manifest, so the index keeps it readable", async () => {
  const { post, publish, archives, root, reports } = setup();
  const report = await post("same.html", STATIC_HTML, "Same page");
  const key = (await publish(report.id)).body.archiveKey!;
  const bundle = join(root, PRODUCER, reportArchiveId(PRODUCER, report.id, report.createdAt));
  await archives.reconcileNow();
  await archives.reconcileNow();
  assert.equal(archives.detail(key)?.status, "ready");
  const manifestBefore = readFileSync(join(bundle, "manifest.json"));

  // Removed by hand, and republished before any reconciliation pass prunes its index row.
  rmSync(bundle, { recursive: true, force: true });
  const again = await publish(report.id);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replayed, false);
  assert.deepEqual(readFileSync(join(bundle, "manifest.json")), manifestBefore,
    "the same page under the same key is the same manifest: its times are the report's, not the clock's");
  await archives.reconcileNow();
  await archives.reconcileNow();
  assert.equal(archives.detail(key)?.status, "ready", "not refused as a rewrite of an immutable key");
  assert.equal(reports.get(report.id)?.publishedArchiveKey, key);
});

test("the startup archive check reads published reports in pages, and still reaches every one", async () => {
  const { reports } = setup();
  const session = mkSession({ id: `s-paged-${Date.now()}`, cwd: home });
  const ids: string[] = [];
  for (let i = 0; i < 205; i += 1) ids.push((await reports.post(session, { title: `Paged ${i}`, body: "b" })).id);
  const update = openDb().prepare("UPDATE reports SET published_archive_key = ? WHERE id = ?");
  for (const id of ids) update.run(`${PRODUCER}~paged-${id}`, id);
  const checked = new Set<string>();
  await reports.reconcilePublishedArchives(async (key) => {
    if (key.includes("~paged-")) checked.add(key);
    return true;
  });
  assert.equal(checked.size, 205, "more than one page of published reports, every one checked");
});

test("a DELETE whose trash cleanup fails after removing the bundle still takes the report back to unpublished", { skip: asRoot }, async () => {
  let lockTrash = false;
  const { app, post, publish, reports, root } = setup({
    rename: async (from, to) => {
      await renamePath(from, to);
      // The bundle is now in the trash; make removing it from there fail.
      if (lockTrash && basename(dirname(to)) === ".trash") chmodSync(dirname(to), 0o555);
    },
  });
  const report = await post("trash.html", STATIC_HTML, "Trash fails");
  const key = (await publish(report.id)).body.archiveKey!;
  lockTrash = true;
  try {
    const deleted = await app.request(`/api/archives/${key}`, {
      method: "DELETE",
      headers: { ...LOOPBACK, "content-type": "application/json" },
      body: JSON.stringify({ confirmArchiveKey: key }),
    });
    assert.equal(deleted.status, 500, "the delete's own failure is still reported");
    assert.match(((await deleted.json()) as { error: string }).error, /trashed bundle could not be removed/);
    assert.equal(reports.get(report.id)?.publishedArchiveKey, null, "but the bundle is gone, so the report is unpublished");
  } finally {
    chmodSync(join(root, ".trash"), 0o700);
  }
});

test("a Markdown document is published as the daemon's own render of the stored copy", async () => {
  const { post, publish, archivedPage } = setup();
  const markdown = "# Findings\n\n| step | result |\n| --- | --- |\n| build | failed |\n\n[Run log](https://ci.example/run/1)\n";
  const report = await post("findings.md", markdown, "Markdown findings");
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const page = archivedPage(reportArchiveId(PRODUCER, report.id, report.createdAt));
  const stored = readFileSync(join(reportDocumentDir(report.id, home), "findings.md"), "utf8");
  assert.equal(sha256(page), sha256(renderMarkdownPage(stored, "Markdown findings")));
  assert.match(page.toString("utf8"), /<table>/, "the shared dialect renders GitHub tables");
});

test("raw HTML and script links in Markdown never reach the published page", async () => {
  const { post, publish, archivedPage } = setup();
  const report = await post("hostile.md", "# Hi\n\n<script>alert(1)</script>\n\n[click](javascript:alert(1))\n", "Hostile markdown");
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const page = archivedPage(reportArchiveId(PRODUCER, report.id, report.createdAt)).toString("utf8");
  assert.doesNotMatch(page, /<script/);
  assert.doesNotMatch(page, /javascript:/);
});

test("a request that carries a page or a path is refused and archives nothing", async () => {
  const { post, publish, bundles, reports } = setup();
  const report = await post("findings.html", STATIC_HTML);
  for (const body of [
    JSON.stringify({ page: "<html><body>Substitute</body></html>" }),
    JSON.stringify({ path: "/etc/passwd" }),
    JSON.stringify({ html: STATIC_HTML }),
    "<html><body>Raw page</body></html>",
  ]) {
    const refused = await publish(report.id, { body });
    assert.equal(refused.status, 400, `refused: ${body}`);
  }
  assert.deepEqual(bundles(), []);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, null);
});

test("editing the checkout file after posting does not change what is published", async () => {
  const { post, publish, archivedPage, checkout } = setup();
  const report = await post("findings.html", STATIC_HTML);
  writeFileSync(join(checkout, "findings.html"), "<html><body><p>Rewritten after posting</p></body></html>");
  const published = await publish(report.id);
  assert.equal(published.status, 200);
  const page = archivedPage(reportArchiveId(PRODUCER, report.id, report.createdAt)).toString("utf8");
  assert.equal(page, STATIC_HTML);
});

test("a page the static checker refuses is refused with its problems, and nothing is published", async () => {
  const { post, publish, bundles, reports } = setup();
  const report = await post("live.html", "<html><body><p>Hi</p><script>fetch('/api/sessions')</script><img src=\"https://tracker.example/p.png\"></body></html>");
  const refused = await publish(report.id);
  assert.equal(refused.status, 422);
  assert.ok(refused.body.problems!.some((problem) => /<script>/.test(problem)), JSON.stringify(refused.body.problems));
  assert.ok(refused.body.problems!.length >= 2, "every problem is named, not only the first");
  assert.deepEqual(bundles(), []);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, null);
});

const LINKED_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Findings</title></head><body>" +
  "<p>Data: <a href=\"variants.csv\">variants.csv</a>, <a href=\"data/recording.json\">recording.json</a>, " +
  "<a href=\"gate.diff\">gate.diff</a>.</p><img alt=\"chart\" src=\"chart.png\"></body></html>";

test("files a report's document links to beside it are stored when it is posted, and published with the page", async () => {
  const { post, publish, manifest, archivedPage, root, checkout } = setup();
  mkdirSync(join(checkout, "docs", "reports", "run", "data"), { recursive: true });
  writeFileSync(join(checkout, "docs", "reports", "run", "variants.csv"), "variant,score\na,1\n");
  writeFileSync(join(checkout, "docs", "reports", "run", "data", "recording.json"), "{\"frames\":3}\n");
  writeFileSync(join(checkout, "docs", "reports", "run", "gate.diff"), "-old\n+new\n");
  writeFileSync(join(checkout, "docs", "reports", "run", "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const report = await post("docs/reports/run/report.html", LINKED_HTML, "Linked data");
  // The checkout goes away before the press: what publishes is what was stored at post time.
  rmSync(join(checkout, "docs"), { recursive: true, force: true });

  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.equal(archivedPage(archiveId).toString("utf8"), LINKED_HTML, "a page whose links were all stored keeps its bytes");
  const written = manifest(archiveId);
  assert.equal(written.archive.capture_status, "complete");
  assert.deepEqual(written.missing, []);
  const companions = (written.content.artifacts as Array<{ role: string; archive_path: string }>)
    .filter((artifact) => artifact.role === "report_companion")
    .map((artifact) => artifact.archive_path);
  assert.deepEqual(companions, ["report/chart.png", "report/data/recording.json", "report/gate.diff", "report/variants.csv"]);
  assert.equal(readFileSync(join(root, PRODUCER, archiveId, "report", "data", "recording.json"), "utf8"), "{\"frames\":3}\n");
  const verified = await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId });
  assert.equal(verified.kind, "verified", JSON.stringify(verified));

  const again = await publish(report.id);
  assert.equal(again.body.replayed, true);
});

test("links to files that were never stored are unlinked and listed as missing, so the page still publishes", async () => {
  const { post, publish, manifest, archivedPage, root, checkout, reports } = setup();
  writeFileSync(join(checkout, "variants.csv"), "variant,score\na,1\n");
  const report = await post("report.html", LINKED_HTML, "Partly stored");
  // A report posted before companions were stored has none at all.
  const older = await post("older.html", LINKED_HTML, "Posted before companions");
  rmSync(join(reportDocumentDir(older.id, home), "companions"), { recursive: true, force: true });

  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  const page = archivedPage(archiveId).toString("utf8");
  assert.match(page, /<a href="variants\.csv">variants\.csv<\/a>/, "a stored file keeps its link");
  assert.match(page, /<a>recording\.json<\/a>/, "an unstored file keeps its text and loses its link");
  assert.match(page, /<img alt="chart">/);
  const written = manifest(archiveId);
  assert.equal(written.archive.capture_status, "partial");
  assert.deepEqual(
    (written.missing as Array<{ kind: string; expected_source: string }>).map((entry) => [entry.kind, entry.expected_source]),
    [["report_companion", "chart.png"], ["report_companion", "data/recording.json"], ["report_companion", "gate.diff"]],
  );
  assert.equal(
    (await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind,
    "verified",
    "the unlinked page passes the same check every bundle is read under",
  );

  const olderPublished = await publish(older.id);
  assert.equal(olderPublished.status, 200, JSON.stringify(olderPublished.body));
  const olderManifest = manifest(reportArchiveId(PRODUCER, older.id, older.createdAt));
  assert.equal(olderManifest.missing.length, 4);
  assert.equal(reports.get(older.id)?.publishedArchiveKey, olderPublished.body.archiveKey);
});

test("a Markdown document's relative links travel the same way", async () => {
  const { post, publish, manifest, checkout } = setup();
  writeFileSync(join(checkout, "table.csv"), "a,b\n");
  const report = await post("notes.md", "# Notes\n\n[table](table.csv) and [gone](gone.csv)\n", "Markdown links");
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const written = manifest(reportArchiveId(PRODUCER, report.id, report.createdAt));
  assert.ok((written.content.artifacts as Array<{ archive_path: string }>).some((artifact) => artifact.archive_path === "report/table.csv"));
  assert.deepEqual((written.missing as Array<{ expected_source: string }>).map((entry) => entry.expected_source), ["gone.csv"]);
});

test("a link to a sibling named report.html is unlinked and listed as missing, never pointed at the published page", async () => {
  const { post, publish, manifest, archivedPage, root, checkout } = setup();
  const SIBLING = "<html><body><p>The sibling page, a different file</p></body></html>";
  writeFileSync(join(checkout, "report.html"), SIBLING);
  writeFileSync(join(checkout, "data.csv"), "a,b\n");
  const findings = "<html><body><a href=\"report.html\">earlier report</a> <a href=\"data.csv\">data</a></body></html>";
  const report = await post("findings.html", findings, "Links a sibling report.html");
  assert.equal(existsSync(join(reportDocumentDir(report.id, home), "companions", "report.html")), false);

  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  const page = archivedPage(archiveId).toString("utf8");
  assert.equal(page, findings.replace(" href=\"report.html\"", ""), "only the sibling's link is removed");
  assert.doesNotMatch(page, /The sibling page/, "the sibling's content is not in the archived page");
  const { stored, missing } = companionsOf(manifest(archiveId));
  assert.deepEqual(stored, ["report/data.csv"]);
  assert.deepEqual(missing, ["report.html"]);
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");

  // A document that IS report.html linking to itself keeps the link: it names the page.
  const self = "<html><body><a href=\"report.html#top\">top</a></body></html>";
  const selfReport = await post("report.html", self, "Links itself");
  const selfPublished = await publish(selfReport.id);
  assert.equal(selfPublished.status, 200, JSON.stringify(selfPublished.body));
  const selfId = reportArchiveId(PRODUCER, selfReport.id, selfReport.createdAt);
  assert.equal(archivedPage(selfId).toString("utf8"), self);
  assert.deepEqual(manifest(selfId).missing, []);
});

test("a same-directory link to a symlink that resolves outside the checkout is not stored, and is unlinked as missing", async () => {
  const { post, publish, manifest, archivedPage, root, checkout } = setup();
  const outside = mkdtempSync(join(tmpdir(), "mission-report-outside-"));
  after(() => rmSync(outside, { recursive: true, force: true }));
  const SECRET = "outside-the-checkout-secret-bytes\n";
  writeFileSync(join(outside, "secret.csv"), SECRET);
  symlinkSync(join(outside, "secret.csv"), join(checkout, "secret.csv"));
  writeFileSync(join(checkout, "kept.csv"), "kept\n");
  const html = "<html><body><a href=\"secret.csv\">secret</a> <a href=\"kept.csv\">kept</a></body></html>";
  const report = await post("leak.html", html, "Links a symlink out");
  assert.deepEqual(readdirSync(join(reportDocumentDir(report.id, home), "companions")), ["kept.csv"], "posting succeeds and stores only the file inside the checkout");

  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  const { stored, missing } = companionsOf(manifest(archiveId));
  assert.deepEqual(stored, ["report/kept.csv"]);
  assert.deepEqual(missing, ["secret.csv"]);
  assert.match(archivedPage(archiveId).toString("utf8"), /<a>secret<\/a> <a href="kept\.csv">kept<\/a>/);
  const bundleDir = join(root, PRODUCER, archiveId);
  const bundleFiles = readdirSync(bundleDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
  assert.ok(bundleFiles.every((text) => !text.includes(SECRET.trim())), "the external bytes are nowhere in the bundle");
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a srcset mixing an escaping link with a missing file refuses the publish, and no archive is written", async () => {
  const { post, publish, bundles, reports, checkout } = setup();
  mkdirSync(join(checkout, "sub"), { recursive: true });
  writeFileSync(join(checkout, "outside.png"), "png");
  const report = await post("sub/mixed.html", "<html><body><img alt=\"x\" srcset=\"../outside.png 1x, gone.png 2x\"></body></html>", "Mixed srcset");
  const refused = await publish(report.id);
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.match(refused.body.problems!.join(" "), /leaves the report directory/);
  assert.deepEqual(bundles(), [], "no archive is written");
  assert.equal(reports.get(report.id)?.publishedArchiveKey, null);
});

test("a link to a path beneath report.html is never stored, and publishes as missing instead of failing the bundle write", async () => {
  const { post, publish, manifest, archivedPage, root, checkout } = setup();
  // In the checkout, `report.html` is a directory holding data; in the archive it is the page.
  mkdirSync(join(checkout, "report.html"), { recursive: true });
  writeFileSync(join(checkout, "report.html", "data.csv"), "a,b\n");
  writeFileSync(join(checkout, "kept.csv"), "kept\n");
  const report = await post("notes.md", "# Notes\n\n[data](report.html/data.csv) and [kept](kept.csv)\n", "Beneath report.html");
  assert.deepEqual(readdirSync(join(reportDocumentDir(report.id, home), "companions")), ["kept.csv"], "nothing beneath report.html is stored");

  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  const { stored, missing } = companionsOf(manifest(archiveId));
  assert.deepEqual(stored, ["report/kept.csv"]);
  assert.deepEqual(missing, ["report.html/data.csv"]);
  assert.doesNotMatch(archivedPage(archiveId).toString("utf8"), /href="report\.html\/data\.csv"/);
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

const mkfifo = (path: string) => execFileSync("mkfifo", [path]);

/** The stored copy of an HTML report's document: the page Publish as scout builds from it. */
const storedPage = (report: ReportItem) => readFileSync(join(reportDocumentDir(report.id, home), report.document!.name));

test("a linked named pipe in the checkout never blocks the post, is not stored, and publishes as missing", { timeout: 20_000 }, async () => {
  const { post, publish, manifest, root, checkout } = setup();
  mkfifo(join(checkout, "pipe.csv"));
  writeFileSync(join(checkout, "kept.csv"), "kept\n");
  const report = await post("pipe.html", "<html><body><a href=\"pipe.csv\">pipe</a> <a href=\"kept.csv\">kept</a></body></html>", "Linked pipe");
  assert.deepEqual(readdirSync(join(reportDocumentDir(report.id, home), "companions")), ["kept.csv"]);
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: ["report/kept.csv"], missing: ["pipe.csv"] });
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a linked file swapped for a named pipe after the containment check never blocks the post's open", { timeout: 20_000 }, async () => {
  let checkout = "";
  const { post, checkout: dir } = setup({
    beforeCompanionOpen: (path) => {
      if (path !== join(realpathSync(checkout), "data.csv")) return;
      unlinkSync(path);
      mkfifo(path);
    },
  });
  checkout = dir;
  writeFileSync(join(checkout, "data.csv"), "a,b\n");
  writeFileSync(join(checkout, "kept.csv"), "kept\n");
  const report = await post("pipe-race.html", "<html><body><a href=\"data.csv\">d</a> <a href=\"kept.csv\">k</a></body></html>", "Pipe swapped in");
  assert.deepEqual(readdirSync(join(reportDocumentDir(report.id, home), "companions")), ["kept.csv"], "the pipe is opened without blocking and rejected as not a regular file");
});

test("a stored companion replaced by a named pipe never blocks the publish, and publishes as missing", { timeout: 20_000 }, async () => {
  const { post, publish, manifest, root, checkout, bundles } = setup();
  writeFileSync(join(checkout, "data.csv"), "a,b\n");
  writeFileSync(join(checkout, "kept.csv"), "kept\n");
  const report = await post("stored-pipe.html", "<html><body><a href=\"data.csv\">d</a> <a href=\"kept.csv\">k</a></body></html>", "Stored pipe");
  const stored = join(reportDocumentDir(report.id, home), "companions", "data.csv");
  unlinkSync(stored);
  mkfifo(stored);
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.deepEqual(bundles(), [archiveId], "exactly this report's archive is written");
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: ["report/kept.csv"], missing: ["data.csv"] });
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("the page's archive name is reserved case-insensitively: Report.html and paths beneath it publish as missing", async () => {
  const { post, publish, manifest, archivedPage, root, checkout, archives } = setup();
  // A file whose name differs from the page's only in case. On a case-insensitive volume it is
  // the page's own path in the archive; on any volume it is never stored as a companion.
  writeFileSync(join(checkout, "Report.html"), "<html><body><p>Another page</p></body></html>");
  writeFileSync(join(checkout, "kept.csv"), "kept\n");
  const html = "<html><body><a href=\"Report.html\">other</a> <a href=\"REPORT.HTML/data.csv\">data</a> <a href=\"kept.csv\">kept</a></body></html>";
  assert.deepEqual(linkedCompanionPaths("html", Buffer.from(html)), ["kept.csv"], "neither case variant is a capture candidate");
  const report = await post("findings.html", html, "Case-folded reserved name");
  assert.deepEqual(readdirSync(join(reportDocumentDir(report.id, home), "companions")), ["kept.csv"]);
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: ["report/kept.csv"], missing: ["REPORT.HTML/data.csv", "Report.html"] });
  assert.match(archivedPage(archiveId).toString("utf8"), /<a>other<\/a> <a>data<\/a> <a href="kept\.csv">kept<\/a>/);
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");

  // The publisher refuses the name on its own as well: handed a companion called Report.html, it
  // never writes it beside report/report.html, and the page's link to it is unlinked instead.
  const direct = await archives.publishReportPage({
    reportId: "r-90001", reportCreatedAt: 90001, title: "Direct", documentName: "findings.html",
    page: Buffer.from("<html><body><a href=\"Report.html\">other</a></body></html>"),
    companions: [{ path: "Report.html", bytes: Buffer.from("<html><body>x</body></html>") }],
    session: { id: "s-direct", name: "Direct", taskId: null }, repositoryLabel: null,
  });
  assert.equal(direct.ok, true, JSON.stringify(direct));
  const directId = reportArchiveId(PRODUCER, "r-90001", 90001);
  assert.deepEqual(companionsOf(manifest(directId)), { stored: [], missing: ["Report.html"] });
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId: directId })).kind, "verified");
});

test("an I/O-style failure checking a stored companion after its open fails the read instead of unlinking it", { skip: asRoot }, async () => {
  const { post, checkout } = setup();
  mkdirSync(join(checkout, "data"), { recursive: true });
  writeFileSync(join(checkout, "data", "nested.csv"), "a,b\n");
  const report = await post("io-error.html", "<html><body><a href=\"data/nested.csv\">d</a></body></html>", "Stored I/O error");
  const storedDir = join(reportDocumentDir(report.id, home), "companions", "data");
  try {
    // After the open succeeds, the directory stops being searchable: realpath fails with EACCES,
    // which is not absence.
    await assert.rejects(
      readStoredReportCompanions(report, storedPage(report), home, { afterOpen: () => chmodSync(storedDir, 0o000) }),
      (error: NodeJS.ErrnoException) => error.code === "EACCES",
    );
  } finally {
    chmodSync(storedDir, 0o700);
  }
  assert.deepEqual((await readStoredReportCompanions(report, storedPage(report), home)).map((companion) => companion.path), ["data/nested.csv"]);
});

test("a linked file that exists but cannot be read refuses the post with its cause, and posts once readable", { skip: asRoot }, async () => {
  const { post, reports, checkout } = setup();
  mkdirSync(join(checkout, "locked-dir"), { recursive: true });
  writeFileSync(join(checkout, "locked.csv"), "a,b\n");
  writeFileSync(join(checkout, "locked-dir", "inner.csv"), "c,d\n");
  const count = () => reports.listForSession(`s-publish-${serial}`).length;
  const before = count();
  chmodSync(join(checkout, "locked.csv"), 0o000);
  try {
    await assert.rejects(
      post("unreadable.html", "<html><body><a href=\"locked.csv\">l</a></body></html>", "Unreadable file"),
      /locked\.csv, which the document links to, could not be read \(EACCES\)/,
    );
  } finally {
    chmodSync(join(checkout, "locked.csv"), 0o600);
  }
  chmodSync(join(checkout, "locked-dir"), 0o000);
  try {
    await assert.rejects(
      post("unreadable-dir.html", "<html><body><a href=\"locked-dir/inner.csv\">i</a></body></html>", "Unreadable directory"),
      /locked-dir\/inner\.csv, which the document links to, could not be read \(EACCES\)/,
    );
  } finally {
    chmodSync(join(checkout, "locked-dir"), 0o700);
  }
  assert.equal(count(), before, "neither refused post stored a report");
  const posted = await post("unreadable.html", "<html><body><a href=\"locked.csv\">l</a></body></html>", "Readable again");
  assert.deepEqual(readdirSync(join(reportDocumentDir(posted.id, home), "companions")), ["locked.csv"]);
});

test("links whose paths differ only in case keep one spelling, so the bundle is written and verifies on any volume", async () => {
  const { post, publish, manifest, archivedPage, root, checkout, archives } = setup();
  // Written under both spellings: one file on a case-insensitive volume, two on a sensitive one.
  writeFileSync(join(checkout, "data.csv"), "a,b\n");
  writeFileSync(join(checkout, "Data.csv"), "a,b\n");
  const html = "<html><body><a href=\"Data.csv\">upper</a> <a href=\"data.csv\">lower</a></body></html>";
  assert.deepEqual(linkedCompanionPaths("html", Buffer.from(html)), ["Data.csv", "data.csv"], "both are candidates; the first one stored wins");
  const report = await post("aliases.html", html, "Case aliases");
  assert.deepEqual(readdirSync(join(reportDocumentDir(report.id, home), "companions")), ["Data.csv"]);
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: ["report/Data.csv"], missing: ["data.csv"] });
  assert.match(archivedPage(archiveId).toString("utf8"), /<a href="Data\.csv">upper<\/a> <a>lower<\/a>/);
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");

  // Handed both spellings directly, the publisher writes the first and unlinks the other.
  const direct = await archives.publishReportPage({
    reportId: "r-90002", reportCreatedAt: 90002, title: "Direct aliases", documentName: "aliases.html",
    page: Buffer.from(html),
    companions: [{ path: "Data.csv", bytes: Buffer.from("a,b\n") }, { path: "data.csv", bytes: Buffer.from("a,b\n") }],
    session: { id: "s-direct", name: "Direct", taskId: null }, repositoryLabel: null,
  });
  assert.equal(direct.ok, true, JSON.stringify(direct));
  const directId = reportArchiveId(PRODUCER, "r-90002", 90002);
  assert.deepEqual(companionsOf(manifest(directId)), { stored: ["report/Data.csv"], missing: ["data.csv"] });
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId: directId })).kind, "verified");
});

test("a checkout root that cannot be resolved after the document is read refuses the post instead of storing no companions", { skip: asRoot }, async () => {
  const outer = join(home, `outer-${Date.now()}`);
  const checkout = join(outer, "checkout");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, "data.csv"), "a,b\n");
  writeFileSync(join(checkout, "doc.html"), "<html><body><a href=\"data.csv\">d</a></body></html>");
  const registry = new Registry();
  let lock = true;
  const reports = new ReportManager(registry, {
    stateDir: home,
    // After the document was read: the checkout's parent stops being searchable, so realpath of
    // the root fails with EACCES, which is not absence.
    beforeCompanionCapture: () => { if (lock) chmodSync(outer, 0o000); },
  });
  after(() => reports.stop());
  const session = mkSession({ id: `s-root-error-${serial}`, name: "Root error", repoRoot: "/repos/root", cwd: checkout });
  try {
    await assert.rejects(
      reports.post(session, { title: "Root unreadable", body: "b", file: "doc.html" }),
      /the checkout could not be read to collect the files the document links to \(EACCES\)/,
    );
  } finally {
    chmodSync(outer, 0o700);
  }
  assert.deepEqual(reports.listForSession(session.id), [], "nothing was posted");
  lock = false;
  const posted = await reports.post(session, { title: "Root readable", body: "b", file: "doc.html" });
  assert.deepEqual(readdirSync(join(reportDocumentDir(posted.id, home), "companions")), ["data.csv"]);
});

test("a folder moved out of the checkout and replaced by a symlink before the open is never read, though the file's identity is unchanged", async () => {
  const outside = mkdtempSync(join(tmpdir(), "mission-companion-moved-dir-"));
  after(() => rmSync(outside, { recursive: true, force: true }));
  let checkout = "";
  let moved = false;
  const { post, checkout: dir } = setup({
    // After the containment check, before the open: the folder holding the linked file is moved
    // outside the checkout and its old path becomes a symlink to the new place. The file is the
    // same inode, so an identity check alone would accept it.
    beforeCompanionOpen: (path) => {
      if (path !== join(realpathSync(checkout), "sub", "data.csv")) return;
      renameSync(join(checkout, "sub"), join(outside, "sub"));
      symlinkSync(join(outside, "sub"), join(checkout, "sub"));
      moved = true;
    },
  });
  checkout = dir;
  mkdirSync(join(checkout, "sub"), { recursive: true });
  writeFileSync(join(checkout, "sub", "data.csv"), "moved-out-of-the-checkout\n");
  writeFileSync(join(checkout, "kept.csv"), "kept\n");
  const report = await post("moved.html", "<html><body><a href=\"sub/data.csv\">d</a> <a href=\"kept.csv\">k</a></body></html>", "Folder moved out");
  assert.equal(moved, true, "the move happened inside the window");
  assert.deepEqual(readdirSync(join(reportDocumentDir(report.id, home), "companions")), ["kept.csv"], "the file reached through the symlink is not stored");
});

test("a stored companion enlarged past the byte limit after posting is unlinked at publish and listed as missing", async () => {
  const { post, publish, manifest, archivedPage, root, checkout } = setup();
  writeFileSync(join(checkout, "grows.bin"), "small\n");
  writeFileSync(join(checkout, "kept.csv"), "kept\n");
  const report = await post("grows.html", "<html><body><a href=\"grows.bin\">g</a> <a href=\"kept.csv\">k</a></body></html>", "Grows after posting");
  // After posting, the stored copy alone is one byte past the whole companion budget.
  writeFileSync(join(reportDocumentDir(report.id, home), "companions", "grows.bin"), Buffer.alloc(REPORT_LIMITS.companionBytes + 1, 0x67));
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: ["report/kept.csv"], missing: ["grows.bin"] });
  assert.match(archivedPage(archiveId).toString("utf8"), /<a>g<\/a> <a href="kept\.csv">k<\/a>/);
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a stored folder replaced by a symlink to another folder inside the store is never followed at publish", async () => {
  const { post, publish, manifest, root, checkout } = setup();
  mkdirSync(join(checkout, "data"), { recursive: true });
  mkdirSync(join(checkout, "other"), { recursive: true });
  writeFileSync(join(checkout, "data", "x.csv"), "data-file\n");
  writeFileSync(join(checkout, "other", "x.csv"), "other-file\n");
  const report = await post("internal.html", "<html><body><a href=\"data/x.csv\">d</a> <a href=\"other/x.csv\">o</a></body></html>", "Internal symlink");
  const store = join(reportDocumentDir(report.id, home), "companions");
  // Inside the store, data/ now points at other/: its real path and inode stay inside the store.
  rmSync(join(store, "data"), { recursive: true, force: true });
  symlinkSync(join(store, "other"), join(store, "data"));

  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: ["report/other/x.csv"], missing: ["data/x.csv"] },
    "other/x.csv is never archived again under data/x.csv");
  assert.equal(existsSync(join(root, PRODUCER, archiveId, "report", "data")), false);
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("the companions read are chosen from the page being published, not from a second read of the stored document", async () => {
  const { post, checkout } = setup();
  writeFileSync(join(checkout, "kept.csv"), "kept\n");
  const page = "<html><body><a href=\"kept.csv\">k</a></body></html>";
  const report = await post("snapshot.html", page, "One snapshot");
  // The stored document changes after the page was built: it now links nothing.
  writeFileSync(join(reportDocumentDir(report.id, home), "snapshot.html"), "<html><body><p>no links</p></body></html>");
  const read = await readStoredReportCompanions(report, Buffer.from(page), home);
  assert.deepEqual(read.map((companion) => companion.path), ["kept.csv"], "the built page's link is honored");
});

test("a file and a directory path that collide case-insensitively keep one, so the archive is written on a case-insensitive volume", async () => {
  const { manifest, archivedPage, root, archives } = setup();
  const html = "<html><body><a href=\"Data\">file</a> <a href=\"data/x.csv\">nested</a></body></html>";
  assert.deepEqual(linkedCompanionPaths("html", Buffer.from(html)), ["Data", "data/x.csv"], "both are candidates; collisions are settled among stored files");
  // The publisher, handed both (as a case-sensitive checkout could store them), writes one. Without
  // the check, writing report/Data then report/data/x.csv fails on a case-insensitive volume.
  const published = await archives.publishReportPage({
    reportId: "r-90003", reportCreatedAt: 90003, title: "File and directory", documentName: "page.html",
    page: Buffer.from(html),
    companions: [{ path: "data/x.csv", bytes: Buffer.from("nested\n") }, { path: "Data", bytes: Buffer.from("file\n") }],
    session: { id: "s-direct", name: "Direct", taskId: null }, repositoryLabel: null,
  });
  assert.equal(published.ok, true, JSON.stringify(published));
  const archiveId = reportArchiveId(PRODUCER, "r-90003", 90003);
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: ["report/Data"], missing: ["data/x.csv"] });
  assert.match(archivedPage(archiveId).toString("utf8"), /<a href="Data">file<\/a> <a>nested<\/a>/);
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a linked name too long for the filesystem is left out at post and publishes as missing, not a 500", async () => {
  const { post, publish, manifest, root, checkout } = setup();
  // Four 246-character directories and a file: within an archive path's limits (1,024
  // characters, 255 per segment), but too long for the filesystem on every platform, so every
  // lookup answers ENAMETOOLONG. Each segment is 492 UTF-8 bytes (Linux allows 255 per name), and
  // the whole path under the state home passes macOS's 1,024-byte path limit.
  const segment = "\u00e9".repeat(246);
  const long = `${segment}/${segment}/${segment}/${segment}/x.csv`;
  assert.ok(`report/${long}`.length <= 1024);
  writeFileSync(join(checkout, "kept.csv"), "kept\n");
  const report = await post("long-name.html", `<html><body><a href="${long}">long</a> <a href="kept.csv">k</a></body></html>`, "Long name");
  assert.deepEqual(readdirSync(join(reportDocumentDir(report.id, home), "companions")), ["kept.csv"]);
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: ["report/kept.csv"], missing: [long] });
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("Unicode-equivalent companion spellings keep one, so the archive is written on a normalization-insensitive volume", async () => {
  const { manifest, root, archives } = setup();
  const nfc = "caf\u00e9.csv";
  const nfd = "cafe\u0301.csv";
  const html = `<html><body><a href="${nfc}">composed</a> <a href="${nfd}">decomposed</a></body></html>`;
  assert.equal(linkedCompanionPaths("html", Buffer.from(html)).length, 2, "both are candidates; collisions are settled among stored files");
  const published = await archives.publishReportPage({
    reportId: "r-90004", reportCreatedAt: 90004, title: "Unicode aliases", documentName: "page.html",
    page: Buffer.from(html),
    companions: [{ path: nfd, bytes: Buffer.from("d\n") }, { path: nfc, bytes: Buffer.from("c\n") }],
    session: { id: "s-direct", name: "Direct", taskId: null }, repositoryLabel: null,
  });
  assert.equal(published.ok, true, JSON.stringify(published));
  const archiveId = reportArchiveId(PRODUCER, "r-90004", 90004);
  const { stored, missing } = companionsOf(manifest(archiveId));
  assert.equal(stored.length, 1);
  assert.equal(missing.length, 1);
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a checkout replaced at the same path partway through capture refuses the post; no file is taken from the replacement", async () => {
  for (const links of [["a.csv", "b.csv"], ["a.csv"]]) {
    const outer = join(home, `mid-swap-${links.length}-${Date.now()}`);
    const checkout = join(outer, "checkout");
    mkdirSync(checkout, { recursive: true });
    for (const name of links) writeFileSync(join(checkout, name), `original ${name}\n`);
    writeFileSync(join(checkout, "doc.html"), `<html><body>${links.map((name) => `<a href="${name}">${name}</a>`).join(" ")}</body></html>`);
    const registry = new Registry();
    let swapped = false;
    const reports = new ReportManager(registry, {
      stateDir: home,
      // Just before the first linked file is opened, the checkout is moved aside and another
      // directory, holding the same names with other bytes, takes its path.
      beforeCompanionOpen: (path) => {
        if (swapped || !path.endsWith(`${sep}a.csv`)) return;
        swapped = true;
        const real = realpathSync(checkout);
        renameSync(real, `${real}-original`);
        mkdirSync(real);
        for (const name of links) writeFileSync(join(real, name), `replacement ${name}\n`);
      },
    });
    after(() => reports.stop());
    const session = mkSession({ id: `s-mid-swap-${links.length}-${serial}`, name: "Mid swap", repoRoot: "/repos/mid", cwd: checkout });
    await assert.rejects(
      reports.post(session, { title: "Swapped mid-capture", body: "b", file: "doc.html" }),
      /the checkout was replaced while the report was being posted/,
      `${links.length} linked file(s)`,
    );
    assert.equal(swapped, true);
    assert.deepEqual(reports.listForSession(session.id), [], "nothing was posted");
  }
});

test("a checkout replaced at the same path after the document is read refuses the post instead of mixing checkouts", async () => {
  const outer = join(home, `swap-outer-${Date.now()}`);
  const checkout = join(outer, "checkout");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, "data.csv"), "original\n");
  writeFileSync(join(checkout, "doc.html"), "<html><body><a href=\"data.csv\">d</a></body></html>");
  const registry = new Registry();
  let swap = true;
  const reports = new ReportManager(registry, {
    stateDir: home,
    // After the document was read from the original checkout, another directory takes its path.
    beforeCompanionCapture: (real) => {
      if (!swap) return;
      renameSync(real, `${real}-original`);
      mkdirSync(real);
      writeFileSync(join(real, "data.csv"), "replacement\n");
    },
  });
  after(() => reports.stop());
  const session = mkSession({ id: `s-swap-${serial}`, name: "Swap", repoRoot: "/repos/swap", cwd: checkout });
  await assert.rejects(
    reports.post(session, { title: "Swapped checkout", body: "b", file: "doc.html" }),
    /the checkout was replaced while the report was being posted/,
  );
  assert.deepEqual(reports.listForSession(session.id), [], "nothing was posted");
  swap = false;
  writeFileSync(join(checkout, "doc.html"), "<html><body><a href=\"data.csv\">d</a></body></html>");
  const posted = await reports.post(session, { title: "Settled checkout", body: "b", file: "doc.html" });
  assert.equal(readFileSync(join(reportDocumentDir(posted.id, home), "companions", "data.csv"), "utf8"), "replacement\n");
});

test("a case-colliding spelling that names nothing never shuts out the file that exists", async () => {
  const { post, publish, manifest, archivedPage, root, checkout } = setup();
  // Data sorts first but names no regular file (on a case-insensitive checkout it is the
  // directory data/, on a sensitive one nothing at all); data/x.csv is the real file.
  mkdirSync(join(checkout, "data"), { recursive: true });
  writeFileSync(join(checkout, "data", "x.csv"), "real\n");
  const html = "<html><body><a href=\"Data\">missing</a> <a href=\"data/x.csv\">real</a></body></html>";
  const report = await post("collide-missing.html", html, "Missing spelling first");
  assert.equal(readFileSync(join(reportDocumentDir(report.id, home), "companions", "data", "x.csv"), "utf8"), "real\n",
    "the existing file is stored even though the missing spelling sorts first");
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: ["report/data/x.csv"], missing: ["Data"] });
  assert.match(archivedPage(archiveId).toString("utf8"), /<a>missing<\/a> <a href="data\/x\.csv">real<\/a>/, "the working link stays");
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a report whose <style> element names an unstored file publishes with that reference rewritten", async () => {
  const { post, publish, manifest, archivedPage, root, checkout } = setup();
  writeFileSync(join(checkout, "kept.png"), "png");
  const html = "<html><head><style>.a{background:url(kept.png)} .b{background:url(gone.png)}</style></head><body><p>x</p></body></html>";
  const report = await post("styled.html", html, "Style element");
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: ["report/kept.png"], missing: ["gone.png"] });
  assert.match(archivedPage(archiveId).toString("utf8"), /\.a\{background:url\(kept\.png\)\} \.b\{background:none\}/);
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a report whose <style> element imports an unstored stylesheet publishes with no import left to fetch", async () => {
  const { post, publish, manifest, archivedPage, root, checkout } = setup();
  writeFileSync(join(checkout, "kept.css"), "p{margin:0}\n");
  const css = "@import \"gone.css\"; @import url(gone2.css) screen; @import \"kept.css\"; body{color:red}";
  const html = `<html><head><style>${css}</style></head><body><p>x</p></body></html>`;
  const report = await post("imports.html", html, "Style imports");
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: ["report/kept.css"], missing: ["gone.css", "gone2.css"] });
  const page = archivedPage(archiveId).toString("utf8");
  // An empty `@import "";` would resolve to the page's own URL and be fetched when it opens: the
  // missing rules are gone whole, and the stored import and the other rule keep their bytes.
  assert.equal(page, html.replace(css, "  @import \"kept.css\"; body{color:red}"));
  assert.deepEqual([...page.matchAll(/@import\s*([^;]*);/g)].map((match) => match[1]), ['"kept.css"']);
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a report posted as Report.html keeps its self-link: it resolves to the archived page", async () => {
  const { post, publish, manifest, archivedPage, root, checkout } = setup();
  writeFileSync(join(checkout, "kept.csv"), "kept\n");
  const html = "<html><body><h1 id=\"top\">Top</h1><a href=\"Report.html#top\">back to top</a> <a href=\"kept.csv\">k</a></body></html>";
  const report = await post("Report.html", html, "Capitalised page");
  assert.equal(report.document?.name, "Report.html");
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  const written = manifest(archiveId);
  assert.deepEqual(companionsOf(written), { stored: ["report/kept.csv"], missing: [] }, "the self-link is not listed as missing");
  assert.equal(written.archive.capture_status, "complete");
  assert.equal(archivedPage(archiveId).toString("utf8"), html.replace('href="Report.html#top"', 'href="report.html#top"'),
    "only the self-link changes, to the page's archive name");
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a link that climbs out of the document's directory is neither stored nor unlinked, and still refuses the page", async () => {
  const { post, publish, bundles, checkout } = setup();
  mkdirSync(join(checkout, "sub"), { recursive: true });
  writeFileSync(join(checkout, "secret.txt"), "outside\n");
  const report = await post("sub/report.html", "<html><body><a href=\"../secret.txt\">x</a></body></html>", "Escaping");
  assert.equal(existsSync(join(reportDocumentDir(report.id, home), "companions")), false);
  const refused = await publish(report.id);
  assert.equal(refused.status, 422);
  assert.match(refused.body.problems!.join(" "), /leaves the report directory/);
  assert.deepEqual(bundles(), []);
});

/** The archive paths of a manifest's companions, and the paths it lists as missing. */
function companionsOf(written: Record<string, any>): { stored: string[]; missing: Array<string | null> } {
  return {
    stored: (written.content.artifacts as Array<{ role: string; archive_path: string }>)
      .filter((artifact) => artifact.role === "report_companion")
      .map((artifact) => artifact.archive_path),
    missing: (written.missing as Array<{ expected_source: string | null }>).map((entry) => entry.expected_source),
  };
}

test("a report stores at most the companion file limit: the file past it is unlinked and listed as missing", async () => {
  const { post, publish, manifest, archivedPage, root, checkout } = setup();
  const names = Array.from({ length: REPORT_LIMITS.companionFiles + 1 }, (_, index) => `c${String(index).padStart(3, "0")}.txt`);
  for (const name of names) writeFileSync(join(checkout, name), `${name}\n`);
  const links = names.map((name) => `<a href="${name}">${name}</a>`).join(" ");
  const report = await post("many.html", `<html><body><p>${links}</p></body></html>`, "Many companions");
  const storedDir = join(reportDocumentDir(report.id, home), "companions");
  assert.equal(readdirSync(storedDir).length, REPORT_LIMITS.companionFiles, "exactly the limit is stored");
  assert.equal(existsSync(join(storedDir, names.at(-1)!)), false, "the file past the limit is not stored");

  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  const { stored, missing } = companionsOf(manifest(archiveId));
  assert.deepEqual(stored, names.slice(0, -1).map((name) => `report/${name}`));
  assert.deepEqual(missing, [names.at(-1)]);
  const page = archivedPage(archiveId).toString("utf8");
  assert.match(page, new RegExp(`<a href="${names.at(-2)}">`), "the last file within the limit keeps its link");
  assert.match(page, new RegExp(`<a>${names.at(-1)}</a>`), "the file past the limit keeps its text and loses its link");
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("posting looks up at most the companion lookup bound of linked paths, so thousands of missing links cannot stall it", async () => {
  const { post, publish, manifest, checkout } = setup();
  // Sorted, the 512th linked path exists and is within the bound; the 513th exists and is past it.
  const missing = Array.from({ length: REPORT_LIMITS.companionLookups - 1 }, (_, index) => `m${String(index).padStart(4, "0")}.csv`);
  writeFileSync(join(checkout, "n-at-bound.csv"), "at\n");
  writeFileSync(join(checkout, "o-past-bound.csv"), "past\n");
  const names = [...missing, "n-at-bound.csv", "o-past-bound.csv"];
  const html = `<html><body>${names.map((name) => `<a href="${name}">${name}</a>`).join(" ")}</body></html>`;
  const report = await post("many-missing.html", html, "Many missing links");
  assert.deepEqual(readdirSync(join(reportDocumentDir(report.id, home), "companions")), ["n-at-bound.csv"],
    "the last path within the bound is looked up and stored; the one past it is not looked up");

  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const { stored, missing: listed } = companionsOf(manifest(reportArchiveId(PRODUCER, report.id, report.createdAt)));
  assert.deepEqual(stored, ["report/n-at-bound.csv"]);
  assert.equal(listed.length, 64, "the manifest's missing list is capped, with its last entry counting the rest");
});

test("a report stores companions up to exactly the byte limit: a file that would pass it is unlinked and listed as missing", async () => {
  const { post, publish, manifest, archivedPage, root, checkout } = setup();
  const small = 10;
  // a.bin and b.bin together are exactly the limit; c.bin is one byte past it.
  writeFileSync(join(checkout, "a.bin"), Buffer.alloc(REPORT_LIMITS.companionBytes - small, 0x61));
  writeFileSync(join(checkout, "b.bin"), Buffer.alloc(small, 0x62));
  writeFileSync(join(checkout, "c.bin"), Buffer.alloc(1, 0x63));
  // One file alone over the limit is never stored, whatever came before it.
  writeFileSync(join(checkout, "huge.bin"), Buffer.alloc(REPORT_LIMITS.companionBytes + 1, 0x68));
  const html = "<html><body><a href=\"a.bin\">a</a> <a href=\"b.bin\">b</a> <a href=\"c.bin\">c</a> <a href=\"huge.bin\">huge</a></body></html>";
  const report = await post("bytes.html", html, "Byte limit");
  assert.deepEqual(readdirSync(join(reportDocumentDir(report.id, home), "companions")).sort(), ["a.bin", "b.bin"]);

  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  const { stored, missing } = companionsOf(manifest(archiveId));
  assert.deepEqual(stored, ["report/a.bin", "report/b.bin"]);
  assert.deepEqual(missing, ["c.bin", "huge.bin"]);
  assert.equal(readFileSync(join(root, PRODUCER, archiveId, "report", "a.bin")).byteLength, REPORT_LIMITS.companionBytes - small);
  const page = archivedPage(archiveId).toString("utf8");
  assert.match(page, /<a href="b\.bin">b<\/a>/);
  assert.match(page, /<a>c<\/a> <a>huge<\/a>/);
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a manifest lists up to 64 unlinked paths; past that, 63 are listed and one entry counts the rest", async () => {
  const { post, publish, manifest, archivedPage, root } = setup();
  const MAX_MISSING = 64;
  for (const count of [MAX_MISSING, MAX_MISSING + 1]) {
    // None of these files exists in the checkout, so none is stored and every link is unlinked.
    const names = Array.from({ length: count }, (_, index) => `m${String(index).padStart(3, "0")}.csv`);
    const links = names.map((name) => `<a href="${name}">${name}</a>`).join(" ");
    const report = await post(`missing-${count}.html`, `<html><body><p>${links}</p></body></html>`, `Missing ${count}`);
    const published = await publish(report.id);
    assert.equal(published.status, 200, JSON.stringify(published.body));
    const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
    const written = manifest(archiveId);
    assert.equal(written.archive.capture_status, "partial");
    const missing = written.missing as Array<{ kind: string; expected_source: string | null; reason: string }>;
    assert.equal(missing.length, MAX_MISSING, `${count} unlinked paths fill the manifest's ${MAX_MISSING} entries`);
    assert.ok(missing.every((entry) => entry.kind === "report_companion"));
    if (count === MAX_MISSING) {
      assert.deepEqual(missing.map((entry) => entry.expected_source), names, "at the limit, every path is listed");
    } else {
      assert.deepEqual(missing.slice(0, -1).map((entry) => entry.expected_source), names.slice(0, MAX_MISSING - 1));
      assert.deepEqual(missing.at(-1), {
        kind: "report_companion",
        expected_source: null,
        reason: "2 more linked files were not stored with the report, so their links were removed",
      });
    }
    const page = archivedPage(archiveId).toString("utf8");
    assert.doesNotMatch(page, /href=/, "every link to an unstored file is removed, listed or counted");
    assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
  }
});

test("one stored companion that cannot be opened answers 500, and is never unlinked into a partial archive", { skip: asRoot }, async () => {
  const { post, publish, bundles, reports, checkout, manifest } = setup();
  writeFileSync(join(checkout, "data.csv"), "a,b\n");
  writeFileSync(join(checkout, "notes.txt"), "kept\n");
  const report = await post("one-locked.html", "<html><body><a href=\"data.csv\">data</a> <a href=\"notes.txt\">notes</a></body></html>", "One locked companion");
  const locked = join(reportDocumentDir(report.id, home), "companions", "data.csv");
  assert.equal(existsSync(locked), true);
  chmodSync(locked, 0o000);
  try {
    const refused = await publish(report.id);
    assert.equal(refused.status, 500, JSON.stringify(refused.body));
    assert.match(refused.body.problems!.join(" "), /^could not read the files stored with this report: .*EACCES/);
    assert.deepEqual(bundles(), [], "no partial archive is written without the stored file");
    assert.equal(reports.get(report.id)?.publishedArchiveKey, null);
  } finally {
    chmodSync(locked, 0o600);
  }
  // Readable again, the same press publishes it whole.
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const written = manifest(reportArchiveId(PRODUCER, report.id, report.createdAt));
  assert.deepEqual(companionsOf(written), { stored: ["report/data.csv", "report/notes.txt"], missing: [] });
});

test("a linked file or its folder swapped for a symlink after the containment check, before the open, is never read", async () => {
  const outside = mkdtempSync(join(tmpdir(), "mission-companion-race-outside-"));
  after(() => rmSync(outside, { recursive: true, force: true }));
  const SECRET = "companion-swapped-between-check-and-open-secret";
  writeFileSync(join(outside, "data.csv"), `${SECRET}\n`);
  mkdirSync(join(outside, "sub"), { recursive: true });
  writeFileSync(join(outside, "sub", "nested.csv"), `${SECRET}\n`);

  // The hook runs after each linked file passed its containment check and before it is opened:
  // the window a session would race. It swaps data.csv for a symlink out (final component), and
  // the sub folder for a symlink to an outside folder holding a file of the same name (parent).
  let checkout = "";
  const swapped: string[] = [];
  const { post, publish, manifest, archivedPage, root, checkout: dir } = setup({
    beforeCompanionOpen: (path) => {
      const real = realpathSync(checkout);
      if (path === join(real, "data.csv")) {
        unlinkSync(path);
        symlinkSync(join(outside, "data.csv"), path);
        swapped.push("data.csv");
      } else if (path === join(real, "sub", "nested.csv")) {
        renameSync(join(checkout, "sub"), join(checkout, "sub-moved"));
        symlinkSync(join(outside, "sub"), join(checkout, "sub"));
        swapped.push("sub/nested.csv");
      }
    },
  });
  checkout = dir;
  mkdirSync(join(checkout, "sub"), { recursive: true });
  writeFileSync(join(checkout, "data.csv"), "a,b\n");
  writeFileSync(join(checkout, "sub", "nested.csv"), "c,d\n");
  writeFileSync(join(checkout, "kept.csv"), "kept\n");
  const html = "<html><body><a href=\"data.csv\">data</a> <a href=\"sub/nested.csv\">nested</a> <a href=\"kept.csv\">kept</a></body></html>";
  const report = await post("race.html", html, "Swapped before open");
  assert.deepEqual(swapped.sort(), ["data.csv", "sub/nested.csv"], "both swaps happened inside the window");
  assert.deepEqual(readdirSync(join(reportDocumentDir(report.id, home), "companions")), ["kept.csv"], "neither swapped file was stored");

  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: ["report/kept.csv"], missing: ["data.csv", "sub/nested.csv"] });
  assert.match(archivedPage(archiveId).toString("utf8"), /<a>data<\/a> <a>nested<\/a> <a href="kept\.csv">kept<\/a>/);
  const contents = readdirSync(join(root, PRODUCER, archiveId), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
  assert.ok(contents.every((text) => !text.includes(SECRET)), "the outside bytes are nowhere in the bundle");
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a stored companion replaced by a symlink to an outside file is never followed: unlinked as missing, its bytes absent", async () => {
  const { post, publish, manifest, archivedPage, root, checkout } = setup();
  const outside = mkdtempSync(join(tmpdir(), "mission-stored-companion-outside-"));
  after(() => rmSync(outside, { recursive: true, force: true }));
  const SECRET = "stored-companion-swapped-for-a-symlink-secret";
  writeFileSync(join(outside, "secret.csv"), `${SECRET}\n`);
  mkdirSync(join(outside, "dir"), { recursive: true });
  writeFileSync(join(outside, "dir", "nested.json"), `{"secret":"${SECRET}"}\n`);
  mkdirSync(join(checkout, "data"), { recursive: true });
  writeFileSync(join(checkout, "data.csv"), "a,b\n");
  writeFileSync(join(checkout, "data", "nested.json"), "{}\n");
  writeFileSync(join(checkout, "kept.csv"), "kept\n");
  const html = "<html><body><a href=\"data.csv\">data</a> <a href=\"data/nested.json\">nested</a> <a href=\"kept.csv\">kept</a></body></html>";
  const report = await post("swapped.html", html, "Stored companion swapped");
  const stored = join(reportDocumentDir(report.id, home), "companions");
  assert.deepEqual(readdirSync(stored).sort(), ["data", "data.csv", "kept.csv"]);
  // After posting, the stored file and the stored directory are each replaced by a symlink out.
  unlinkSync(join(stored, "data.csv"));
  symlinkSync(join(outside, "secret.csv"), join(stored, "data.csv"));
  rmSync(join(stored, "data"), { recursive: true, force: true });
  symlinkSync(join(outside, "dir"), join(stored, "data"));

  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: ["report/kept.csv"], missing: ["data.csv", "data/nested.json"] });
  assert.match(archivedPage(archiveId).toString("utf8"), /<a>data<\/a> <a>nested<\/a> <a href="kept\.csv">kept<\/a>/);
  const bundleDir = join(root, PRODUCER, archiveId);
  const contents = readdirSync(bundleDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
  assert.ok(contents.every((text) => !text.includes(SECRET)), "the outside bytes are nowhere in the bundle");
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a companions store replaced by a symlink to an outside directory is never listed or read at publish", async () => {
  const { post, publish, manifest, archivedPage, root, checkout } = setup();
  const outside = mkdtempSync(join(tmpdir(), "mission-companion-store-outside-"));
  after(() => rmSync(outside, { recursive: true, force: true }));
  const SECRET = "companions-store-swapped-for-a-symlink-secret";
  writeFileSync(join(outside, "data.csv"), `${SECRET}\n`);
  writeFileSync(join(checkout, "data.csv"), "a,b\n");
  const report = await post("store-swap.html", "<html><body><a href=\"data.csv\">data</a></body></html>", "Store swapped");
  const store = join(reportDocumentDir(report.id, home), "companions");
  rmSync(store, { recursive: true, force: true });
  symlinkSync(outside, store);

  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: [], missing: ["data.csv"] });
  assert.match(archivedPage(archiveId).toString("utf8"), /<a>data<\/a>/);
  const contents = readdirSync(join(root, PRODUCER, archiveId), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
  assert.ok(contents.every((text) => !text.includes(SECRET)), "the outside bytes are nowhere in the bundle");
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a companions store swapped for a symlink to a large outside tree opens only the linked paths, and reads none of it", async () => {
  const { post, publish, manifest, checkout } = setup();
  const outside = mkdtempSync(join(tmpdir(), "mission-companion-store-tree-"));
  after(() => rmSync(outside, { recursive: true, force: true }));
  // A large tree with a file at the linked name: publishing must neither walk it nor read it.
  for (let d = 0; d < 40; d += 1) {
    mkdirSync(join(outside, `d${d}`));
    for (let f = 0; f < 125; f += 1) writeFileSync(join(outside, `d${d}`, `f${f}.txt`), "x");
  }
  writeFileSync(join(outside, "data.csv"), "outside-tree-secret\n");
  writeFileSync(join(checkout, "data.csv"), "a,b\n");
  const report = await post("tree-swap.html", "<html><body><a href=\"data.csv\">data</a></body></html>", "Store swapped for a tree");
  const store = join(reportDocumentDir(report.id, home), "companions");
  let opened = 0;
  const read = await readStoredReportCompanions(report, storedPage(report), home, {
    beforeOpen: () => {
      opened += 1;
      if (opened === 1) {
        renameSync(store, `${store}-moved`);
        symlinkSync(outside, store);
      }
    },
  });
  assert.deepEqual(read, [], "the file reached through the swapped store is not read");
  assert.equal(opened, 1, "only the one linked path is opened: the store is never listed");

  // Through the route, with the swap left in place: the store is a symlink, so nothing is read.
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.deepEqual(companionsOf(manifest(reportArchiveId(PRODUCER, report.id, report.createdAt))), { stored: [], missing: ["data.csv"] });
});

test("a store of 128 files in separate branches eight directories deep is read in full and publishes with nothing missing", async () => {
  const { post, publish, manifest, root, checkout } = setup();
  // Each file sits at the end of its own chain of eight directories: 128 files and 1,024
  // directories, more entries than any fixed walk bound tied to the file count would allow.
  const names = Array.from({ length: REPORT_LIMITS.companionFiles }, (_, index) =>
    `b${index}/${Array.from({ length: 7 }, (_, depth) => `l${depth}`).join("/")}/f.txt`);
  for (const name of names) {
    mkdirSync(join(checkout, dirname(name)), { recursive: true });
    writeFileSync(join(checkout, name), name);
  }
  const report = await post("deep-store.html", `<html><body>${names.map((name) => `<a href="${name}">x</a>`).join("")}</body></html>`, "Deep store");
  const read = await readStoredReportCompanions(report, storedPage(report), home);
  assert.deepEqual(read.map((companion) => companion.path), [...names].sort(), "every stored file is read");

  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  const { stored, missing } = companionsOf(manifest(archiveId));
  assert.equal(stored.length, REPORT_LIMITS.companionFiles);
  assert.deepEqual(stored, [...names].sort().map((name) => `report/${name}`));
  assert.deepEqual(missing, [], "no stored file's link is removed");
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a report directory replaced by a symlink to an outside directory never supplies companions at publish", async () => {
  const { post, publish, manifest, archivedPage, root, checkout } = setup();
  const outside = mkdtempSync(join(tmpdir(), "mission-report-dir-outside-"));
  after(() => rmSync(outside, { recursive: true, force: true }));
  const SECRET = "report-directory-swapped-for-a-symlink-secret";
  const html = "<html><body><a href=\"data.csv\">data</a></body></html>";
  writeFileSync(join(checkout, "data.csv"), "a,b\n");
  const report = await post("dir-swap.html", html, "Report directory swapped");
  const reportDir = reportDocumentDir(report.id, home);
  // The outside directory looks exactly like a report's: the same document, and a companions
  // store whose data.csv holds bytes from outside.
  mkdirSync(join(outside, "companions"), { recursive: true });
  writeFileSync(join(outside, "dir-swap.html"), html);
  writeFileSync(join(outside, "companions", "data.csv"), `${SECRET}\n`);
  rmSync(reportDir, { recursive: true, force: true });
  symlinkSync(outside, reportDir);

  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  assert.deepEqual(companionsOf(manifest(archiveId)), { stored: [], missing: ["data.csv"] });
  assert.match(archivedPage(archiveId).toString("utf8"), /<a>data<\/a>/);
  const contents = readdirSync(join(root, PRODUCER, archiveId), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
  assert.ok(contents.every((text) => !text.includes(SECRET)), "the outside bytes are nowhere in the bundle");
  assert.equal((await verifyArchiveBundle(realpathSync(root), { producerId: PRODUCER, archiveId })).kind, "verified");
});

test("a report directory swapped for a symlink between listing and reading is never read, even when the swap is undone after the open", async () => {
  const { post, checkout } = setup();
  const outside = mkdtempSync(join(tmpdir(), "mission-report-dir-race-"));
  after(() => rmSync(outside, { recursive: true, force: true }));
  const SECRET = "report-directory-race-secret";
  writeFileSync(join(checkout, "data.csv"), "a,b\n");
  const report = await post("dir-race.html", "<html><body><a href=\"data.csv\">d</a></body></html>", "Report directory race");
  const reportDir = reportDocumentDir(report.id, home);
  mkdirSync(join(outside, "companions"), { recursive: true });
  writeFileSync(join(outside, "companions", "data.csv"), `${SECRET}\n`);
  const swapIn = () => {
    renameSync(reportDir, `${reportDir}-moved`);
    symlinkSync(outside, reportDir);
  };
  const swapBack = () => {
    unlinkSync(reportDir);
    renameSync(`${reportDir}-moved`, reportDir);
  };

  const left = await readStoredReportCompanions(report, storedPage(report), home, { beforeOpen: swapIn });
  assert.deepEqual(left, [], "left in place, the path resolves outside the reports store");
  swapBack();
  const undone = await readStoredReportCompanions(report, storedPage(report), home, { beforeOpen: swapIn, afterOpen: swapBack });
  assert.deepEqual(undone, [], "undone after the open, the file at the path is not the one the handle holds");
  assert.deepEqual((await readStoredReportCompanions(report, storedPage(report), home)).map((companion) => companion.path), ["data.csv"]);
});

test("a stored directory swapped for a symlink between listing and reading is never read, even when the swap is undone after the open", async () => {
  const { post, checkout } = setup();
  const outside = mkdtempSync(join(tmpdir(), "mission-companion-parent-outside-"));
  after(() => rmSync(outside, { recursive: true, force: true }));
  const SECRET = "stored-parent-directory-swapped-secret";
  mkdirSync(join(outside, "data"), { recursive: true });
  writeFileSync(join(outside, "data", "nested.json"), `{"secret":"${SECRET}"}\n`);
  mkdirSync(join(checkout, "data"), { recursive: true });
  writeFileSync(join(checkout, "data", "nested.json"), "{}\n");
  writeFileSync(join(checkout, "kept.csv"), "kept\n");
  const report = await post("parent-swap.html", "<html><body><a href=\"data/nested.json\">n</a> <a href=\"kept.csv\">k</a></body></html>", "Parent swapped");
  const store = join(reportDocumentDir(report.id, home), "companions");
  const swapIn = () => {
    renameSync(join(store, "data"), join(store, "data-moved"));
    symlinkSync(join(outside, "data"), join(store, "data"));
  };
  const swapBack = () => {
    unlinkSync(join(store, "data"));
    renameSync(join(store, "data-moved"), join(store, "data"));
  };
  const isNested = (path: string) => path.endsWith(join("data", "nested.json"));

  // Swapped in just before the open and left in place: the path now resolves outside the store.
  const left = await readStoredReportCompanions(report, storedPage(report), home, { beforeOpen: (path) => { if (isNested(path)) swapIn(); } });
  assert.deepEqual(left.map((companion) => companion.path), ["kept.csv"]);
  assert.ok(left.every((companion) => !companion.bytes.toString("utf8").includes(SECRET)));
  swapBack();

  // Swapped in before the open and undone right after it: the path resolves inside again, but the
  // file there is not the one the handle holds.
  const undone = await readStoredReportCompanions(report, storedPage(report), home, {
    beforeOpen: (path) => { if (isNested(path)) swapIn(); },
    afterOpen: (path) => { if (isNested(path)) swapBack(); },
  });
  assert.deepEqual(undone.map((companion) => companion.path), ["kept.csv"]);
  assert.ok(undone.every((companion) => !companion.bytes.toString("utf8").includes(SECRET)));

  // Untouched, the same store reads both files.
  assert.deepEqual((await readStoredReportCompanions(report, storedPage(report), home)).map((companion) => companion.path), ["data/nested.json", "kept.csv"]);
});

test("a stored companion that is gone by publish time is unlinked as missing, as before", async () => {
  const { post, publish, manifest, checkout } = setup();
  writeFileSync(join(checkout, "data.csv"), "a,b\n");
  const report = await post("gone-companion.html", "<html><body><a href=\"data.csv\">data</a></body></html>", "Companion gone");
  unlinkSync(join(reportDocumentDir(report.id, home), "companions", "data.csv"));
  const published = await publish(report.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.deepEqual(companionsOf(manifest(reportArchiveId(PRODUCER, report.id, report.createdAt))), { stored: [], missing: ["data.csv"] });
});

test("stored companions that cannot be read answer 500 with the error, and nothing is archived", { skip: asRoot }, async () => {
  const { post, publish, bundles, reports, checkout } = setup();
  writeFileSync(join(checkout, "data.csv"), "a,b\n");
  const report = await post("locked.html", "<html><body><a href=\"data.csv\">data</a></body></html>", "Locked companions");
  const storedDir = join(reportDocumentDir(report.id, home), "companions");
  assert.equal(existsSync(join(storedDir, "data.csv")), true);
  chmodSync(storedDir, 0o000);
  try {
    const refused = await publish(report.id);
    assert.equal(refused.status, 500, JSON.stringify(refused.body));
    assert.match(refused.body.problems!.join(" "), /^could not read the files stored with this report: .*EACCES/);
  } finally {
    chmodSync(storedDir, 0o700);
  }
  assert.deepEqual(bundles(), [], "no archive is written");
  assert.equal(reports.get(report.id)?.publishedArchiveKey, null);
});

test("publishing a report whose stored copy has gone missing is refused, and nothing is archived", async () => {
  const { post, publish, bundles, reports } = setup();
  const report = await post("gone.html", STATIC_HTML);
  unlinkSync(join(reportDocumentDir(report.id, home), "gone.html"));
  const refused = await publish(report.id);
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "The stored copy of gone.html is missing from Mission Control's state folder.");
  assert.deepEqual(refused.body.problems, [refused.body.error]);
  assert.deepEqual(bundles(), []);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, null);
});

test("publishing a stored copy that is there but cannot be opened answers 500 with its error code, and archives nothing", { skip: process.getuid?.() === 0 }, async () => {
  const { post, publish, bundles, reports } = setup();
  const report = await post("unopenable.html", STATIC_HTML, "Unopenable copy");
  const stored = join(reportDocumentDir(report.id, home), "unopenable.html");
  chmodSync(stored, 0o000);
  try {
    const refused = await publish(report.id);
    assert.equal(refused.status, 500, JSON.stringify(refused.body));
    assert.deepEqual(refused.body.problems, ["Mission Control could not open the stored copy of unopenable.html (EACCES)."]);
    assert.deepEqual(bundles(), []);
    assert.equal(reports.get(report.id)?.publishedArchiveKey, null);
  } finally {
    chmodSync(stored, 0o600);
  }
});

test("a stored copy that is not UTF-8 text is refused with 422, for Markdown and for HTML, and nothing is archived", async () => {
  const { post, publish, bundles, reports } = setup();
  // 0xff and 0xfe never appear in UTF-8, so a fatal decoder rejects them rather than replacing.
  const invalid = Buffer.concat([Buffer.from("# Notes\n\n"), Buffer.from([0xff, 0xfe, 0x41])]);

  // Markdown: the daemon's page builder refuses before rendering anything.
  const markdown = await post("broken.md", invalid, "Broken markdown");
  const md = await publish(markdown.id);
  assert.equal(md.status, 422, JSON.stringify(md.body));
  assert.deepEqual(md.body.problems, ["broken.md is not UTF-8 text."]);
  assert.equal(reports.get(markdown.id)?.publishedArchiveKey, null);

  // HTML: the stored bytes are the page, so the archive's capture refuses them before staging.
  const html = await post("broken.html", Buffer.concat([Buffer.from("<html><body><p>"), Buffer.from([0xff, 0xfe]), Buffer.from("</p></body></html>")]), "Broken html");
  const page = await publish(html.id);
  assert.equal(page.status, 422, JSON.stringify(page.body));
  assert.deepEqual(page.body.problems, ["the document is not UTF-8 text"]);
  assert.equal(reports.get(html.id)?.publishedArchiveKey, null);

  assert.deepEqual(bundles(), []);
});

/** A static page of exactly `bytes` bytes, padded inside a paragraph. */
function pageOf(bytes: number): Buffer {
  const head = "<!doctype html><html><body><p>";
  const tail = "</p></body></html>";
  return Buffer.from(head + "x".repeat(bytes - head.length - tail.length) + tail);
}

test("a stored copy at the attachment limit reads and publishes; one byte over is refused by both, and nothing is archived", async () => {
  const { app, post, publish, bundles, reports } = setup();
  const read = (id: string) => app.request(`/api/reports/${id}/document`, { headers: LOOPBACK });

  const atLimit = await post("limit.html", STATIC_HTML, "At the limit");
  writeFileSync(join(reportDocumentDir(atLimit.id, home), "limit.html"), pageOf(REPORT_LIMITS.documentBytes));
  const fits = await read(atLimit.id);
  assert.equal(fits.status, 200);
  assert.equal((await fits.arrayBuffer()).byteLength, REPORT_LIMITS.documentBytes);
  const published = await publish(atLimit.id);
  assert.equal(published.status, 200, JSON.stringify(published.body).slice(0, 300));
  assert.equal(bundles().length, 1);

  const over = await post("over.html", STATIC_HTML, "One byte over");
  writeFileSync(join(reportDocumentDir(over.id, home), "over.html"), pageOf(REPORT_LIMITS.documentBytes + 1));
  const tooLarge = await read(over.id);
  assert.equal(tooLarge.status, 409);
  assert.equal(((await tooLarge.json()) as { error: string }).error, "The stored copy of over.html is larger than a report may attach.");
  const refused = await publish(over.id);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body.problems, ["The stored copy of over.html is larger than a report may attach."]);
  assert.equal(reports.get(over.id)?.publishedArchiveKey, null);
  assert.equal(bundles().length, 1, "only the report at the limit was archived");
});

test("a symlink put in place of the stored copy is never followed: reading and publishing refuse it without exposing its target", async () => {
  const { app, post, publish, bundles, reports } = setup();
  const secret = join(home, `secret-${Date.now()}.html`);
  writeFileSync(secret, "<html><body><p>TOP-SECRET-TARGET</p></body></html>");
  const report = await post("linked.html", STATIC_HTML, "Linked copy");
  const stored = join(reportDocumentDir(report.id, home), "linked.html");
  unlinkSync(stored);
  symlinkSync(secret, stored);

  const read = await app.request(`/api/reports/${report.id}/document`, { headers: LOOPBACK });
  assert.equal(read.status, 404);
  const text = await read.text();
  assert.equal((JSON.parse(text) as { error: string }).error, "This report's stored document cannot be read.",
    "a symlink is unreadable, not missing, and its message names nothing about the target");
  assert.doesNotMatch(text, /TOP-SECRET-TARGET/);
  assert.doesNotMatch(text, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the target's path is not disclosed");

  const refused = await publish(report.id);
  assert.equal(refused.status, 404);
  assert.doesNotMatch(JSON.stringify(refused.body), /TOP-SECRET-TARGET/);
  assert.deepEqual(bundles(), []);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, null);
});

test("publishing while the archive manager is shutting down is refused with 503, and nothing is archived", async () => {
  const { post, publish, bundles, reports, archives } = setup();
  const report = await post("shutdown.html", STATIC_HTML, "During shutdown");
  archives.stop();
  const refused = await publish(report.id);
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  assert.deepEqual(refused.body.problems, ["Mission Control is shutting down; try again after it restarts"]);
  assert.deepEqual(bundles(), [], "no archive is written");
  assert.equal(reports.get(report.id)?.publishedArchiveKey, null, "the report stays unpublished");
  assert.equal(reports.get(report.id)?.readAt, null);
});


test("archivePresent is false only for a real absence, and throws when the library cannot be read", { skip: asRoot }, async () => {
  const lockedParent = join(home, `locked-${Date.now()}`);
  const root = join(lockedParent, "library");
  mkdirSync(root, { recursive: true });
  const archives = new ArchiveManager({
    root, legacyRoots: [], store: new ArchiveStore(openDb()),
    producer: { id: PRODUCER, label: null }, intervalMs: null, watch: false,
  });
  after(() => archives.stop());
  const key = `${PRODUCER}~${reportArchiveId(PRODUCER, "r-1", 1)}`;
  assert.equal(await archives.archivePresent(key), false, "no bundle at that key: absent");
  rmSync(root, { recursive: true, force: true });
  assert.equal(await archives.archivePresent(key), false, "no library root at all: absent");
  mkdirSync(root, { recursive: true });
  chmodSync(lockedParent, 0o000);
  try {
    await assert.rejects(archives.archivePresent(key), /EACCES/, "an unreadable library root is not an absence");
  } finally {
    chmodSync(lockedParent, 0o700);
  }
});

test("a press against a library that cannot be read answers 500 and writes nothing; only a missing root counts as empty", { skip: asRoot }, async () => {
  const lockedParent = join(home, `publish-locked-${Date.now()}`);
  const root = join(lockedParent, "library");
  mkdirSync(root, { recursive: true });
  const archives = new ArchiveManager({
    root, legacyRoots: [], store: new ArchiveStore(openDb()),
    producer: { id: PRODUCER, label: null }, intervalMs: null, watch: false,
  });
  after(() => archives.stop());
  const page = Buffer.from(STATIC_HTML);
  const publication = (reportId: string) => ({
    reportId, reportCreatedAt: 1, title: "Locked library", page, companions: [], documentName: "report.html",
    session: { id: "s-locked", name: "Locked", taskId: null }, repositoryLabel: null,
  });

  // The library root cannot be resolved (realpath: EACCES on its parent).
  chmodSync(lockedParent, 0o000);
  try {
    const refused = await archives.publishReportPage(publication("r-501"));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.status, 500);
    assert.match(!refused.ok ? refused.problems.join(" ") : "", /could not read the archive library: .*EACCES/);
  } finally {
    chmodSync(lockedParent, 0o700);
  }
  // The root resolves but cannot be listed, so the bundle at the key cannot be checked for replay.
  chmodSync(root, 0o000);
  try {
    const refused = await archives.publishReportPage(publication("r-502"));
    assert.equal(!refused.ok && refused.status, 500);
    assert.match(!refused.ok ? refused.problems.join(" ") : "", /could not read the archive library: .*EACCES/);
  } finally {
    chmodSync(root, 0o700);
  }
  assert.deepEqual(readdirSync(root), [], "nothing was staged or written while the library was unreadable");

  // A root that is simply not there is empty: the press publishes and creates it.
  rmSync(root, { recursive: true, force: true });
  const published = await archives.publishReportPage(publication("r-503"));
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.equal(await archives.archivePresent(published.ok ? published.key : ""), true);
});

test("an unreadable library keeps every recorded key: the startup check skips it and a press answers 500", { skip: asRoot }, async () => {
  const { post, publish, reports, archives, root } = setup();
  const report = await post("locked.html", STATIC_HTML, "Library locked");
  const key = (await publish(report.id)).body.archiveKey!;
  chmodSync(root, 0o000);
  try {
    await assert.rejects(archives.archivePresent(key), /EACCES/);
    const cleared = await reports.reconcilePublishedArchives((k) => archives.archivePresent(k));
    assert.ok(!cleared.includes(report.id), "a key that cannot be checked is not cleared");
    const pressed = await publish(report.id);
    assert.equal(pressed.status, 500, JSON.stringify(pressed.body));
    assert.match(pressed.body.problems![0]!, /could not check whether archive .* is still in the library: .*EACCES/);
    assert.equal(reports.get(report.id)?.publishedArchiveKey, key, "the key is kept");
  } finally {
    chmodSync(root, 0o700);
  }
  assert.equal(await archives.archivePresent(key), true, "and the bundle was there all along");
});

test("a filesystem failure while publishing answers 500, never the 422 of a checker refusal", async () => {
  let failRename = false;
  const { post, publish, reports, bundles } = setup({
    rename: async (from, to) => {
      if (failRename) throw Object.assign(new Error("ENOSPC: no space left on device, rename"), { code: "ENOSPC" });
      await renamePath(from, to);
    },
  });
  const report = await post("full-disk.html", STATIC_HTML, "Disk full");
  failRename = true;
  const failed = await publish(report.id);
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  assert.match(failed.body.problems!.join(" "), /ENOSPC/);
  assert.deepEqual(bundles(), []);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, null);

  // The same report publishes once the disk recovers: nothing about the failure stuck.
  failRename = false;
  assert.equal((await publish(report.id)).status, 200);
});

test("a report with no document is not publishable", async () => {
  const { publish, reports, bundles } = setup();
  const report = await reports.post(mkSession({ id: "s-no-doc", cwd: home }), { title: "No document", body: "Body only." });
  const refused = await publish(report.id);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error!, /no attached document/);
  assert.deepEqual(bundles(), []);
  assert.equal((await publish("r-999999")).status, 404);
});

test("only the operator publishes: an agent or Foreman is refused", async () => {
  const { post, publish, bundles } = setup();
  const report = await post("findings.html", STATIC_HTML);
  assert.equal((await publish(report.id, { headers: { "x-mission-operation-actor": "agent" } })).status, 403);
  assert.equal((await publish(report.id, { headers: { "x-mission-operation-actor": "foreman" } })).status, 403);
  assert.deepEqual(bundles(), []);
});

test("neither reading the document nor publishing it marks the report read", async () => {
  const { app, post, publish, reports } = setup();
  const report = await post("findings.html", STATIC_HTML);
  const read = await app.request(`/api/reports/${report.id}/document`, { headers: LOOPBACK });
  assert.equal(read.status, 200);
  assert.equal((await publish(report.id)).status, 200);
  const after = reports.get(report.id)!;
  assert.equal(after.readAt, null);
  assert.equal(after.readBy, null);
  assert.equal(after.openedAt, null, "reading and publishing record no open; the dashboard posts that");
});

test("with the inbox flag off, publishing is refused", async () => {
  const { post, publish, bundles } = setup();
  const report = await post("findings.html", STATIC_HTML);
  flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: false });
  try {
    assert.equal((await publish(report.id)).status, 404);
  } finally {
    flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });
  }
  assert.deepEqual(bundles(), []);
});
