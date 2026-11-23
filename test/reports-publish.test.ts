import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { rename as renamePath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const { renderMarkdownPage } = await import("../src/server/report-document.ts");
const { ArchiveManager, reportArchiveId } = await import("../src/server/archives/manager.ts");
const { ArchiveStore } = await import("../src/server/archives/store.ts");
const flags = await import("../src/server/feature-flags/index.ts");

type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

after(() => rmSync(home, { recursive: true, force: true }));

const LOOPBACK = { host: "127.0.0.1:7317" };
const PRODUCER = "00000000-0000-4000-8000-0000000000aa";
flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

let serial = 0;
function setup(options: {
  onPruned?: (keys: readonly string[]) => void;
  rename?: (from: string, to: string) => Promise<void>;
} = {}) {
  serial += 1;
  const registry = new Registry();
  const reports = new ReportManager(registry, { stateDir: home });
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

test("an archive at the report's key holding a different page is a conflict and is never overwritten", async () => {
  const { post, publish, bundles, archivedPage, reports } = setup();
  const report = await post("findings.html", STATIC_HTML);
  const first = await publish(report.id);
  assert.equal(first.status, 200);
  const archiveId = reportArchiveId(PRODUCER, report.id, report.createdAt);
  const before = archivedPage(archiveId);
  // Unstamp the report and change what its stored copy now builds, so the page it would publish
  // no longer matches the bundle already at its key.
  openDb().prepare("UPDATE reports SET published_archive_key = NULL WHERE id = ?").run(report.id);
  writeFileSync(join(reportDocumentDir(report.id, home), "findings.html"), "<html><body><p>Different page</p></body></html>");

  const conflict = await publish(report.id);
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.match(conflict.body.problems!.join(" "), /already exists .* with a different page/);
  assert.deepEqual(archivedPage(archiveId), before, "the archived page is unchanged");
  assert.deepEqual(bundles(), [archiveId]);
  assert.equal(reports.get(report.id)?.publishedArchiveKey, null, "a refused publish stamps nothing");
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

// chmod cannot lock root out, so the unreadable-library cases only mean something for a user.
const asRoot = process.getuid?.() === 0;

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
