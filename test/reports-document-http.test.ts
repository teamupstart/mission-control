import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkSession } from "./helpers/session-fixture.ts";
import { tempDir } from "./temp-root.mjs";

// `GET /api/reports/:id/document`: the reader's one source.
//
// What is at stake: Open report shows the document an agent attached from the copy Mission
// Control stored when the report was posted, so it still opens once the worktree is gone. It is
// content an agent wrote, so it is served the way an archived page is: an attachment under a
// sandbox policy with `nosniff`, never as a page on the daemon's origin. A stored copy that has
// gone missing is a 404 whose message the reader can show. Reading changes nothing about the
// report.

const home = tempDir("mission-reports-document-http-");
process.env.HARNESS_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ReportManager, reportDocumentDir } = await import("../src/server/reports.ts");
const flags = await import("../src/server/feature-flags/index.ts");

type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

after(() => rmSync(home, { recursive: true, force: true }));

const LOOPBACK = { host: "127.0.0.1:7317" };
flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });

const registry = new Registry();
const reports = new ReportManager(registry, { stateDir: home });
after(() => reports.stop());
const app = buildApp({
  registry,
  reviews: {} as ReviewManager,
  tasks: {} as TaskManager,
  queues: {} as QueueManager,
  reports,
});
const checkout = join(home, "checkout");
mkdirSync(checkout, { recursive: true });
const session = mkSession({ id: "s-doc", name: "Diagnose", repoRoot: "/repos/doc", cwd: checkout });

const read = (id: string) => app.request(`/api/reports/${id}/document`, { headers: LOOPBACK });

test("an HTML document is served from its stored copy as a sandboxed attachment, after the checkout file is gone", async () => {
  const html = "<!doctype html><html><body><h1>Findings</h1><script>alert(1)</script></body></html>";
  writeFileSync(join(checkout, "findings.html"), html);
  const report = await reports.post(session, { title: "Findings", body: "b", file: "findings.html" });
  unlinkSync(join(checkout, "findings.html"));
  const res = await read(report.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(res.headers.get("content-disposition"), "attachment");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(await res.text(), html);
  const after = reports.get(report.id)!;
  assert.equal(after.readAt, null, "reading the document does not mark the report read");
  assert.equal(after.openedAt, null);
});

test("a Markdown document is served as Markdown text", async () => {
  writeFileSync(join(checkout, "notes.md"), "# Notes\n");
  const report = await reports.post(session, { title: "Notes", body: "b", file: "notes.md" });
  const res = await read(report.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(await res.text(), "# Notes\n");
});

test("a missing stored copy, a report with no document and an unknown report are 404s that say why", async () => {
  writeFileSync(join(checkout, "lost.html"), "<p>lost</p>");
  const report = await reports.post(session, { title: "Lost", body: "b", file: "lost.html" });
  unlinkSync(join(reportDocumentDir(report.id, home), "lost.html"));
  const missing = await read(report.id);
  assert.equal(missing.status, 404);
  assert.match(((await missing.json()) as { error: string }).error, /stored copy of lost\.html is missing/);

  const bare = await reports.post(session, { title: "Bare", body: "b" });
  const none = await read(bare.id);
  assert.equal(none.status, 404);
  assert.match(((await none.json()) as { error: string }).error, /no attached document/);

  assert.equal((await read("r-424242")).status, 404);
});

test("a stored copy that is there but cannot be opened is a 500 naming the error, never 'missing'", { skip: process.getuid?.() === 0 }, async () => {
  writeFileSync(join(checkout, "locked.html"), "<p>locked</p>");
  const report = await reports.post(session, { title: "Locked", body: "b", file: "locked.html" });
  const stored = join(reportDocumentDir(report.id, home), "locked.html");
  chmodSync(stored, 0o000);
  try {
    const res = await read(report.id);
    assert.equal(res.status, 500);
    const { error } = (await res.json()) as { error: string };
    assert.equal(error, "Mission Control could not open the stored copy of locked.html (EACCES).");
    assert.doesNotMatch(error, /missing/);
  } finally {
    chmodSync(stored, 0o600);
  }
  assert.equal((await read(report.id)).status, 200, "readable again once the permission is restored");
});

test("with the inbox flag off the document route refuses", async () => {
  writeFileSync(join(checkout, "off.html"), "<p>off</p>");
  const report = await reports.post(session, { title: "Off", body: "b", file: "off.html" });
  flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: false });
  try {
    assert.equal((await read(report.id)).status, 404);
  } finally {
    flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });
  }
});
