import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import {
  SCOUT_PRIMARY_REPORT_PATH,
  SCOUT_REPORT_PATH_SHAPE,
  parseScoutManifest,
  scoutReportSlug,
} from "../src/shared/scouts.ts";
import { validReportHtml } from "./helpers/scout-fixture.ts";

/**
 * The capture mechanism: what reaches a bundle, what is refused by name, and what a
 * published archive proves about the bytes it holds.
 *
 * Everything here runs against REAL checkouts - real git repositories, real symlinks, real
 * files mutated mid-copy - because every defence being tested is a filesystem defence. A
 * fake checkout would prove the code branches, not that the branch it took was correct about
 * the disk.
 */

const home = mkdtempSync(join(tmpdir(), "mission-scout-capture-"));
process.env.MISSION_HOME = home;

const { captureScoutArchive } = await import("../src/server/scouts/capture.ts");
const { ScoutCaptureStore, clearScoutCaptureJobs, scoutOperationKey } = await import(
  "../src/server/scouts/capture-store.ts"
);
const { openDb } = await import("../src/server/db.ts");
const { verifyScoutBundle } = await import("../src/server/scouts/bundle.ts");

const db = openDb();
const library = realpathSync(mkdirp(join(home, "scouts")));
const PRODUCER = "11111111-2222-4333-8444-555555555555";

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearScoutCaptureJobs(db));

function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

let checkouts = 0;

/** A real git checkout with a `.gitignore`, so the ignore rules are git's rather than ours. */
function makeCheckout(files: Record<string, string> = {}): string {
  const root = mkdirp(join(home, `checkout-${++checkouts}`));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), "secrets/\n*.local\n");
  for (const [relative, contents] of Object.entries(files)) {
    mkdirp(join(root, relative.split("/").slice(0, -1).join("/") || "."));
    writeFileSync(join(root, relative), contents);
  }
  return realpathSync(root);
}

interface JobSpec {
  root: string | null;
  reportPath?: string;
  summary?: string;
  tags?: string[];
  supporting?: Array<{ repoSlot: string; path: string }>;
  extraRoots?: Array<{ slot: string; root: string | null; label: string }>;
  taskId?: string;
}

/** A reserved job, optionally carrying a submission, exactly as the manager would build it. */
function makeJob(spec: JobSpec) {
  const store = new ScoutCaptureStore(db);
  const taskId = spec.taskId ?? `task-${++checkouts}`;
  const job = store.reserve({
    taskId,
    sessionId: "sess-1",
    episodeId: "ep-1",
    producerId: PRODUCER,
    title: "Resume permission loss",
    question: "Why did a resumed agent lose repository permissions?",
    origin: { agent: "claude", model: "opus", source: "manual" },
    repos: [
      { slot: "repo-01", label: "demo", root: spec.root, head: null, primary: true },
      ...(spec.extraRoots ?? []).map((entry) => ({
        slot: entry.slot,
        label: entry.label,
        root: entry.root,
        head: null,
        primary: false,
      })),
    ],
  });
  if (spec.reportPath === undefined) return { store, job, key: scoutOperationKey(taskId, "ep-1") };
  const updated = store.recordSubmission(job.operationKey, {
    reportPath: spec.reportPath,
    summary: spec.summary ?? "Resume rebuilt the session without replaying the grant.",
    tags: spec.tags ?? ["resume"],
    supporting: spec.supporting ?? [],
  })!;
  return { store, job: updated, key: updated.operationKey };
}

const deps = { libraryRoot: library, producerLabel: "a laptop" };

// ---------------------------------------------------------------------------
// The happy path, and what it actually wrote
// ---------------------------------------------------------------------------

test("a submitted report publishes the whole report directory with exact bytes and digests", async () => {
  const report = validReportHtml();
  const root = makeCheckout({
    "docs/reports/resume/report.html": report,
    "docs/reports/resume/evidence.csv": "when,what\n1,grant missing\n",
    "docs/reports/resume/nested/trace.txt": "a trace",
    "docs/reports/resume/.DS_Store": "junk",
    "evidence/resume-debug.log": "a log line",
    "secrets/token.txt": "nope",
  });
  const { job } = makeJob({
    root,
    reportPath: "docs/reports/resume/report.html",
    supporting: [{ repoSlot: "repo-01", path: "evidence/resume-debug.log" }],
  });

  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok) return;
  assert.equal(outcome.captureStatus, "complete");
  assert.equal(outcome.replayed, false);

  const bundle = join(library, outcome.identity.producerId, outcome.identity.archiveId);
  // The report's own bytes, unchanged. Rewriting a finished report - even to fix a link - is
  // the one thing the format forbids, because the archive is what somebody else will read.
  assert.equal(readFileSync(join(bundle, SCOUT_PRIMARY_REPORT_PATH), "utf8"), report);
  assert.equal(readFileSync(join(bundle, "report/evidence.csv"), "utf8"), "when,what\n1,grant missing\n");
  assert.equal(readFileSync(join(bundle, "report/nested/trace.txt"), "utf8"), "a trace");
  assert.equal(
    readFileSync(join(bundle, "artifacts/repo-01/evidence/resume-debug.log"), "utf8"),
    "a log line",
  );

  const manifest = parseScoutManifest(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")));
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  // Provenance is SERVER-DERIVED. The scout said none of this.
  assert.equal(manifest.manifest.archive.title, "Resume permission loss");
  assert.equal(manifest.manifest.origin.agent, "claude");
  assert.deepEqual(manifest.manifest.archive.tags, ["resume"]);
  assert.equal(manifest.manifest.producer.label, "a laptop");
  const roles = manifest.manifest.artifacts.map((artifact) => `${artifact.role}:${artifact.archivePath}`);
  assert.deepEqual(roles.sort(), [
    "primary_report:report/report.html",
    "report_companion:report/evidence.csv",
    "report_companion:report/nested/trace.txt",
    "supporting:artifacts/repo-01/evidence/resume-debug.log",
  ].sort());
  // Hidden entries cannot be archive paths at all, so they are skipped rather than published
  // under a name the format refuses.
  assert.ok(!roles.some((role) => role.includes(".DS_Store")));

  // And the whole thing verifies through the same importer a stranger's bundle goes through.
  const read = await verifyScoutBundle(library, outcome.identity);
  assert.equal(read.kind, "verified");
});

test("nothing a scout did not name is captured, including ignored and unrelated files", async () => {
  const root = makeCheckout({
    "docs/reports/resume/report.html": validReportHtml(),
    "src/server/registry.ts": "export const x = 1;",
    "notes.local": "ignored by the checkout",
  });
  const { job } = makeJob({ root, reportPath: "docs/reports/resume/report.html" });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.artifactCount, 1, "only the report; a checkout is not a deliverable");
});

test("an explicitly named ignored file is refused by name rather than archived", async () => {
  const root = makeCheckout({
    "docs/reports/resume/report.html": validReportHtml(),
    "secrets/token.txt": "nope",
  });
  const { job } = makeJob({
    root,
    reportPath: "docs/reports/resume/report.html",
    supporting: [{ repoSlot: "repo-01", path: "secrets/token.txt" }],
  });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.problems.join(" "), /secrets\/token\.txt is ignored by git/);
});

test("an ignored non-hidden report companion is refused by name rather than archived", async () => {
  const root = makeCheckout({
    "docs/reports/resume/report.html": validReportHtml(),
    "docs/reports/resume/credentials.local": "must stay in the checkout",
  });
  const { job } = makeJob({ root, reportPath: "docs/reports/resume/report.html" });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(
    outcome.problems.join(" "),
    /docs\/reports\/resume\/credentials\.local.*is ignored by git and was not archived/,
  );
  const read = await verifyScoutBundle(library, {
    producerId: PRODUCER,
    archiveId: job.archiveId,
  });
  assert.equal(read.kind, "absent");
});

test("every offending path is named at once, so one correction fixes them all", async () => {
  const root = makeCheckout({ "docs/reports/resume/report.html": validReportHtml() });
  const { job } = makeJob({
    root,
    reportPath: "docs/reports/resume/report.html",
    supporting: [
      { repoSlot: "repo-01", path: "missing-one.txt" },
      { repoSlot: "repo-01", path: "missing-two.txt" },
      { repoSlot: "repo-09", path: "anything.txt" },
    ],
  });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.problems.length, 3);
  assert.match(outcome.problems.join(" "), /missing-one\.txt/);
  assert.match(outcome.problems.join(" "), /missing-two\.txt/);
  assert.match(outcome.problems.join(" "), /repo-09 is not a repository slot this task issued/);
});

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

test("a supporting path that escapes the checkout is refused", async () => {
  const outside = mkdirp(join(home, "outside"));
  writeFileSync(join(outside, "secret.txt"), "not yours");
  const root = makeCheckout({ "docs/reports/resume/report.html": validReportHtml() });
  const { job } = makeJob({
    root,
    reportPath: "docs/reports/resume/report.html",
    supporting: [{ repoSlot: "repo-01", path: "../outside/secret.txt" }],
  });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.problems.join(" "), /leaves the checkout|cannot be represented/);
});

test("a symlink anywhere on a supporting path is refused, leaf or directory", async () => {
  const outside = mkdirp(join(home, "linked-target"));
  writeFileSync(join(outside, "secret.txt"), "not yours");
  const root = makeCheckout({ "docs/reports/resume/report.html": validReportHtml() });
  symlinkSync(join(outside, "secret.txt"), join(root, "leaf-link.txt"));
  symlinkSync(outside, join(root, "dir-link"));

  for (const path of ["leaf-link.txt", "dir-link/secret.txt"]) {
    const { job } = makeJob({
      root,
      reportPath: "docs/reports/resume/report.html",
      supporting: [{ repoSlot: "repo-01", path }],
    });
    const outcome = await captureScoutArchive(job, deps);
    assert.equal(outcome.ok, false, `${path} should be refused`);
    if (outcome.ok) continue;
    assert.match(outcome.problems.join(" "), /symbolic link/);
  }
});

test("a parent symlink swap cannot redirect a validated source outside the checkout", async () => {
  const outside = mkdirp(join(home, `parent-swap-${++checkouts}`));
  writeFileSync(join(outside, "secret.txt"), "outside bytes that must not be archived");
  const root = makeCheckout({
    "docs/reports/resume/report.html": validReportHtml(),
    "evidence/secret.txt": "validated checkout bytes",
  });
  const source = join(root, "evidence/secret.txt");
  const sourceParent = join(root, "evidence");
  const { job } = makeJob({
    root,
    reportPath: "docs/reports/resume/report.html",
    supporting: [{ repoSlot: "repo-01", path: "evidence/secret.txt" }],
  });
  let swapped = false;
  const outcome = await captureScoutArchive(job, {
    ...deps,
    beforeCopy: async (plannedSource) => {
      if (plannedSource !== source) return;
      rmSync(sourceParent, { recursive: true, force: true });
      symlinkSync(outside, sourceParent, "dir");
      swapped = true;
    },
  });

  assert.equal(swapped, true, "the parent changed after validation and before open");
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.problems.join(" "), /changed after its checkout path was validated/);
  const read = await verifyScoutBundle(library, {
    producerId: PRODUCER,
    archiveId: job.archiveId,
  });
  assert.equal(read.kind, "absent");
});

test("a companion directory swap cannot redirect discovery outside the checkout", async () => {
  const outside = mkdirp(join(home, `companion-dir-swap-${++checkouts}`));
  writeFileSync(join(outside, "secret.txt"), "outside bytes that must not be archived");
  const root = makeCheckout({
    "docs/reports/resume/report.html": validReportHtml(),
    "docs/reports/resume/evidence/inside.txt": "validated checkout bytes",
  });
  const sourceParent = join(root, "docs/reports/resume/evidence");
  const { job } = makeJob({ root, reportPath: "docs/reports/resume/report.html" });
  let swapped = false;
  const outcome = await captureScoutArchive(job, {
    ...deps,
    beforeCompanionDirectory: async (directory) => {
      if (directory !== sourceParent) return;
      rmSync(sourceParent, { recursive: true, force: true });
      symlinkSync(outside, sourceParent, "dir");
      swapped = true;
    },
  });

  assert.equal(swapped, true, "the directory changed after inspection and before descent");
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.problems.join(" "), /evidence.*symbolic link/);
  const read = await verifyScoutBundle(library, {
    producerId: PRODUCER,
    archiveId: job.archiveId,
  });
  assert.equal(read.kind, "absent");
});

test("a submitted report with a symlinked companion is refused rather than called complete", async () => {
  const outside = mkdirp(join(home, "companion-target"));
  writeFileSync(join(outside, "secret.txt"), "not yours");
  const root = makeCheckout({
    "docs/reports/resume/report.html": validReportHtml(),
    "docs/reports/resume/bad\\name.txt": "cannot be represented in a bundle",
  });
  symlinkSync(join(outside, "secret.txt"), join(root, "docs/reports/resume/linked.txt"));

  const { job } = makeJob({ root, reportPath: "docs/reports/resume/report.html" });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.problems.length, 2, "every automatically omitted companion is a problem");
  assert.match(outcome.problems.join(" "), /docs\/reports\/resume\/linked\.txt.*symbolic link/);
  assert.match(outcome.problems.join(" "), /bad\\name\.txt.*cannot be represented/);
  const read = await verifyScoutBundle(library, {
    producerId: PRODUCER,
    archiveId: job.archiveId,
  });
  assert.equal(read.kind, "absent");
});

test("a supporting file already beside the report is refused rather than archived twice", async () => {
  const root = makeCheckout({
    "docs/reports/resume/report.html": validReportHtml(),
    "docs/reports/resume/evidence.csv": "a,b\n",
  });
  const { job } = makeJob({
    root,
    reportPath: "docs/reports/resume/report.html",
    supporting: [{ repoSlot: "repo-01", path: "docs/reports/resume/evidence.csv" }],
  });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.problems.join(" "), /already captured with the report directory/);
});

// ---------------------------------------------------------------------------
// The static-HTML contract, enforced against the STAGED bundle
// ---------------------------------------------------------------------------

test("a report that would execute or reach the network never reaches the library", async () => {
  const cases: Array<[string, string]> = [
    ["a script tag", "<!doctype html><html><body><script>alert(1)</script></body></html>"],
    ["an external image", '<!doctype html><html><body><img src="https://example.com/a.png"></body></html>'],
    ["an event handler", '<!doctype html><html><body><div onclick="go()">x</div></body></html>'],
  ];
  for (const [label, html] of cases) {
    const root = makeCheckout({ "docs/reports/resume/report.html": html });
    const { job } = makeJob({ root, reportPath: "docs/reports/resume/report.html" });
    const outcome = await captureScoutArchive(job, deps);
    assert.equal(outcome.ok, false, `${label} should be refused`);
    if (outcome.ok) continue;
    assert.match(outcome.problems.join(" "), /not a static report/);
    // And the refusal happened in staging: no half-archive is visible in the library.
    const read = await verifyScoutBundle(library, { producerId: PRODUCER, archiveId: job.archiveId });
    assert.equal(read.kind, "absent");
  }
});

test("a report linking to a companion that was not captured is refused", async () => {
  // The companion is hidden, so it cannot be an archive path - and the link would dangle.
  const root = makeCheckout({
    "docs/reports/resume/report.html":
      '<!doctype html><html><body><a href=".hidden.csv">data</a></body></html>',
    "docs/reports/resume/.hidden.csv": "a,b\n",
  });
  const { job } = makeJob({ root, reportPath: "docs/reports/resume/report.html" });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.problems.join(" "), /not a static report/);
});

test("a report path that is not the convention is refused with the required shape", async () => {
  const root = makeCheckout({ "docs/report.html": validReportHtml() });
  const { job } = makeJob({ root, reportPath: "docs/report.html" });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.problems.join(" "), new RegExp(SCOUT_REPORT_PATH_SHAPE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// ---------------------------------------------------------------------------
// Idempotency, conflict, and publication boundaries
// ---------------------------------------------------------------------------

test("a replay returns the existing archive rather than publishing a second one", async () => {
  const root = makeCheckout({ "docs/reports/resume/report.html": validReportHtml() });
  const { job } = makeJob({ root, reportPath: "docs/reports/resume/report.html" });

  const first = await captureScoutArchive(job, deps);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.replayed, false);

  const second = await captureScoutArchive(job, deps);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.replayed, true);
  assert.deepEqual(second.identity, first.identity, "one operation, one archive");
});

test("a final key that already holds an archive is a conflict, never an overwrite", async () => {
  const root = makeCheckout({ "docs/reports/resume/report.html": validReportHtml("first") });
  const { job } = makeJob({ root, reportPath: "docs/reports/resume/report.html" });
  const first = await captureScoutArchive(job, deps);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  // Damage the published manifest so the replay check cannot accept it, then capture again
  // under the same identity: the directory is there, and it must not be replaced.
  writeFileSync(join(library, job.producerId, job.archiveId, "manifest.json"), "{ not json");
  const second = await captureScoutArchive(job, deps);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.conflict, true);
  assert.match(second.problems.join(" "), /an archive already exists/);
  assert.equal(
    readFileSync(join(library, job.producerId, job.archiveId, "manifest.json"), "utf8"),
    "{ not json",
    "both sides survive a conflict",
  );
});

test("a failed rename leaves nothing in the library and no staging residue", async () => {
  const root = makeCheckout({ "docs/reports/resume/report.html": validReportHtml() });
  const { job } = makeJob({ root, reportPath: "docs/reports/resume/report.html" });
  const outcome = await captureScoutArchive(job, {
    ...deps,
    rename: () => Promise.reject(new Error("disk went away")),
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.problems.join(" "), /disk went away/);
  const read = await verifyScoutBundle(library, { producerId: PRODUCER, archiveId: job.archiveId });
  assert.equal(read.kind, "absent");

  // And the operation is still retryable: nothing about the failure consumed the identity.
  const retry = await captureScoutArchive(job, deps);
  assert.equal(retry.ok, true);
});

test("a file that changes while it is being archived fails the whole operation", async () => {
  const root = makeCheckout({ "docs/reports/resume/report.html": validReportHtml() });
  const target = join(root, "big.txt");
  writeFileSync(target, "x".repeat(1024 * 1024));
  const { job } = makeJob({
    root,
    reportPath: "docs/reports/resume/report.html",
    supporting: [{ repoSlot: "repo-01", path: "big.txt" }],
  });
  // Rewritten with different content and a different mtime while the copy is in flight.
  const churn = setInterval(() => {
    try {
      writeFileSync(target, "y".repeat(1024 * 1024 + Math.floor(Math.random() * 64)));
    } catch {
      // The file may be mid-read; a failed write here is not the assertion.
    }
  }, 1);
  let outcome;
  try {
    outcome = await captureScoutArchive(job, deps);
  } finally {
    clearInterval(churn);
  }
  // Either the copy caught the change, or it did not race at all and published cleanly. The
  // one outcome that must never happen is a published archive whose digest does not describe
  // the bytes beside it, which the importer below would catch.
  if (outcome.ok) {
    const read = await verifyScoutBundle(library, outcome.identity);
    assert.equal(read.kind, "verified", "a published archive always describes its own bytes");
  } else {
    assert.match(outcome.problems.join(" "), /changed while it was being archived|exceeds/);
  }
});

// ---------------------------------------------------------------------------
// Multi-repository capture
// ---------------------------------------------------------------------------

test("a supporting file is read from the checkout its slot names", async () => {
  const primary = makeCheckout({ "docs/reports/resume/report.html": validReportHtml() });
  const secondary = makeCheckout({ "notes/other.md": "from the second repo" });
  const { job } = makeJob({
    root: primary,
    reportPath: "docs/reports/resume/report.html",
    extraRoots: [{ slot: "repo-02", root: secondary, label: "sibling" }],
    supporting: [{ repoSlot: "repo-02", path: "notes/other.md" }],
  });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok) return;
  const bundle = join(library, outcome.identity.producerId, outcome.identity.archiveId);
  assert.equal(readFileSync(join(bundle, "artifacts/repo-02/notes/other.md"), "utf8"), "from the second repo");
  const manifest = parseScoutManifest(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")));
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  assert.deepEqual(
    manifest.manifest.origin.repositories.map((repo) => repo.slot),
    ["repo-01", "repo-02"],
    "every slot the task issued is described, in order",
  );
});

// ---------------------------------------------------------------------------
// Recovery, when nothing was submitted
// ---------------------------------------------------------------------------

test("exactly one conventional report is recovered as a complete archive", async () => {
  const root = makeCheckout({
    "docs/reports/resume/report.html": validReportHtml(),
    "docs/reports/resume/evidence.csv": "a,b\n",
  });
  const { job } = makeJob({ root });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.captureStatus, "complete");
  assert.equal(outcome.artifactCount, 2);
  const bundle = join(library, outcome.identity.producerId, outcome.identity.archiveId);
  const manifest = parseScoutManifest(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")));
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  // No summary was invented for it. A recovered archive says what was written, not what a
  // model might have said about it.
  assert.equal(manifest.manifest.archive.summary, null);
});

test("a recovered report with a symlinked companion is an honest partial", async () => {
  const outside = mkdirp(join(home, "recovered-companion-target"));
  writeFileSync(join(outside, "secret.txt"), "not yours");
  const root = makeCheckout({ "docs/reports/resume/report.html": validReportHtml() });
  symlinkSync(join(outside, "secret.txt"), join(root, "docs/reports/resume/linked.txt"));

  const { job } = makeJob({ root });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.captureStatus, "partial");
  const bundle = join(library, outcome.identity.producerId, outcome.identity.archiveId);
  const manifest = parseScoutManifest(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")));
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  assert.equal(manifest.manifest.missing[0]?.expectedSource, "docs/reports/resume/linked.txt");
  assert.match(manifest.manifest.missing[0]?.reason ?? "", /symbolic link/);
});

test("an ignored recovered primary report becomes a named partial and is not archived", async () => {
  const root = makeCheckout({
    ".gitignore": "docs/reports/\n",
    "docs/reports/resume/report.html": validReportHtml(),
  });
  const { job } = makeJob({ root });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.captureStatus, "partial");
  assert.equal(outcome.artifactCount, 0);
  const bundle = join(library, outcome.identity.producerId, outcome.identity.archiveId);
  const manifest = parseScoutManifest(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")));
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  assert.equal(manifest.manifest.missing[0]?.expectedSource, "docs/reports/resume/report.html");
  assert.match(manifest.manifest.missing[0]?.reason ?? "", /ignored by git and was not archived/);
});

test("two candidate reports are never guessed between - the archive is an honest partial", async () => {
  const root = makeCheckout({
    "docs/reports/resume/report.html": validReportHtml(),
    "docs/reports/other/report.html": validReportHtml("a different investigation"),
  });
  const { job } = makeJob({ root });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.captureStatus, "partial");
  const bundle = join(library, outcome.identity.producerId, outcome.identity.archiveId);
  const manifest = parseScoutManifest(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")));
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  assert.equal(manifest.manifest.primaryArtifactId, null);
  assert.match(manifest.manifest.missing[0]!.reason, /2 candidate reports/);
});

test("no report at all is a partial that says so, and never a manufactured one", async () => {
  const root = makeCheckout({ "notes.md": "I thought about it" });
  const { job } = makeJob({ root });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.captureStatus, "partial");
  assert.equal(outcome.artifactCount, 0);
  const bundle = join(library, outcome.identity.producerId, outcome.identity.archiveId);
  const manifest = parseScoutManifest(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")));
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  assert.equal(manifest.manifest.missing[0]!.kind, "primary_report");
  assert.match(manifest.manifest.missing[0]!.reason, /without submitting a report/);
  // The partial still verifies as a bundle: it is a record, not a broken one.
  const read = await verifyScoutBundle(library, outcome.identity);
  assert.equal(read.kind, "verified");
  if (read.kind !== "verified") return;
  assert.equal(read.bundle.status, "partial");
});

test("a checkout that is already gone cannot be captured from, and says so", async () => {
  const { job } = makeJob({ root: join(home, "never-existed"), reportPath: "docs/reports/x/report.html" });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.problems.join(" "), /checkout is no longer available/);
});

// ---------------------------------------------------------------------------
// The path convention itself
// ---------------------------------------------------------------------------

test("the report path convention accepts one slug segment and refuses everything else", () => {
  assert.equal(scoutReportSlug("docs/reports/resume-permissions/report.html"), "resume-permissions");
  assert.equal(scoutReportSlug("docs/reports/Odd_Name.v2/report.html"), "Odd_Name.v2");
  for (const bad of [
    "docs/reports/report.html",
    "docs/reports/a/b/report.html",
    "docs/reports/../../etc/report.html",
    "/docs/reports/a/report.html",
    "docs/reports/a/index.html",
    "docs/reports/.hidden/report.html",
    "docs/reports//report.html",
  ]) {
    assert.equal(scoutReportSlug(bad), null, `${bad} must not be a report path`);
  }
});

test("a report that is not a regular file is refused before anything is copied", async () => {
  const root = makeCheckout({});
  mkdirp(join(root, "docs/reports/resume/report.html"));
  const { job } = makeJob({ root, reportPath: "docs/reports/resume/report.html" });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.problems.join(" "), /is not an ordinary file/);
});

test("an unreadable source file fails the capture rather than publishing a short one", async () => {
  const root = makeCheckout({
    "docs/reports/resume/report.html": validReportHtml(),
    "locked.txt": "you cannot read me",
  });
  chmodSync(join(root, "locked.txt"), 0o000);
  const { job } = makeJob({
    root,
    reportPath: "docs/reports/resume/report.html",
    supporting: [{ repoSlot: "repo-01", path: "locked.txt" }],
  });
  const outcome = await captureScoutArchive(job, deps);
  chmodSync(join(root, "locked.txt"), 0o644);
  // Running as root reads it anyway, which is a legitimate environment rather than a failure.
  if (outcome.ok) return;
  assert.match(outcome.problems.join(" "), /could not be opened/);
});

test("a supporting path is archived under the file it resolved to, not the string claimed", async () => {
  const root = makeCheckout({
    "docs/reports/resume/report.html": validReportHtml(),
    "evidence/trace.log": "a trace",
  });
  // Three spellings of one file. All three must land on one entry, at the resolved path -
  // otherwise a manifest describes the same bytes as three artifacts under three names.
  const { job } = makeJob({
    root,
    reportPath: "docs/reports/resume/report.html",
    supporting: [
      { repoSlot: "repo-01", path: "evidence/trace.log" },
      { repoSlot: "repo-01", path: "./evidence/trace.log" },
      { repoSlot: "repo-01", path: "evidence//trace.log" },
    ],
  });
  const outcome = await captureScoutArchive(job, deps);
  assert.equal(outcome.ok, false, "the duplicates are named rather than silently deduplicated");
  if (outcome.ok) return;
  assert.equal(outcome.problems.length, 2);
  assert.match(outcome.problems.join(" "), /was submitted twice for repo-01/);

  const { job: single } = makeJob({
    root,
    reportPath: "docs/reports/resume/report.html",
    supporting: [{ repoSlot: "repo-01", path: "./evidence/trace.log" }],
  });
  const ok = await captureScoutArchive(single, deps);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  if (!ok.ok) return;
  const bundle = join(library, ok.identity.producerId, ok.identity.archiveId);
  // The `./` never reaches the archive path, which `validateScoutArchivePath` would refuse.
  assert.equal(readFileSync(join(bundle, "artifacts/repo-01/evidence/trace.log"), "utf8"), "a trace");
  const manifest = parseScoutManifest(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")));
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  const supporting = manifest.manifest.artifacts.find((a) => a.role === "supporting")!;
  assert.equal(supporting.originalPath, "evidence/trace.log", "provenance is the resolved path");
});
