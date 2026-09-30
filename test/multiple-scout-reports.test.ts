import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ArchiveSubject, ArchiveTaskGateway } from "../src/server/archives/task-gateway.ts";
import type { ArchiveManagerOptions } from "../src/server/archives/manager.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { validReportHtml } from "./helpers/archive-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-multiple-scouts-"));
process.env.MISSION_HOME = home;
const { ArchiveManager } = await import("../src/server/archives/manager.ts");
const { ArchiveCaptureStore } = await import("../src/server/archives/capture-store.ts");
const { captureArchive } = await import("../src/server/archives/capture.ts");
const { ArchiveStore, clearArchiveTables } = await import("../src/server/archives/store.ts");
const { openDb } = await import("../src/server/db.ts");
after(() => rmSync(home, { recursive: true, force: true }));
let sequence = 0;

function fixture(kind: "scout" | "ship" | "plan" | null = "scout", overrides: Partial<ArchiveManagerOptions> = {}) {
  const id = String(++sequence);
  const root = join(home, `checkout-${id}`);
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  const subject: ArchiveSubject = {
    taskId: kind ? `task-${id}` : null, sessionId: `session-${id}`, episodeId: `episode-${id}`,
    title: "Session title", question: "Investigate", prompts: null,
    origin: { agent: "claude", model: null, source: "manual",
      session: { id: `session-${id}`, name: "Session title", taskId: kind ? `task-${id}` : null, episodeId: `episode-${id}` } },
    repos: [{ slot: "repo-01", label: "fixture", root, head: null, primary: true }],
  };
  const gateway: ArchiveTaskGateway = {
    subjectForSubmission: () => ({ ok: true, subject }),
    subjectForTask: (_id, requested) => kind === requested ? subject : null,
    subjectForExitingSession: () => kind === "scout" ? { kind, subject } : null,
    scoutPromptTrailFor: () => null,
    captureKind: () => kind === "scout" || kind === "plan" ? kind : null,
    awaitsAgent: () => true,
  };
  const options = { root: join(home, `library-${id}`), tasks: gateway, intervalMs: null, watch: false, log: () => {}, ...overrides };
  const manager = new ArchiveManager(options);
  const store = new ArchiveCaptureStore();
  function write(slug: string, contents = validReportHtml()) {
    const reportPath = `docs/reports/${slug}/report.html`;
    mkdirSync(join(root, `docs/reports/${slug}`), { recursive: true });
    writeFileSync(join(root, reportPath), contents);
    return reportPath;
  }
  const submit = (slug: string, title?: string) => manager.submit({
    authority: { taskId: subject.taskId, cwd: root },
    submission: { reportPath: `docs/reports/${slug}/report.html`, title, summary: slug, supporting: [], tags: [] },
  });
  const jobs = () => store.forSession(subject.sessionId!);
  return { manager, store, subject, root, options, write, submit, jobs, gateway };
}

test("two reports have independent bytes and titles, while concurrent retries publish once", async () => {
  const h = fixture();
  const firstBytes = validReportHtml().replace("</body>", "<p>Report A</p></body>");
  const secondBytes = validReportHtml().replace("</body>", "<p>Report B</p></body>");
  h.write("first", firstBytes);
  h.write("second", secondBytes);
  const [a, retry, b] = await Promise.all([h.submit("first", "First report"), h.submit("first"), h.submit("second", "Second report")]);
  assert(a.ok && retry.ok && b.ok);
  assert.equal(a.archive?.key, retry.archive?.key);
  assert.equal(retry.replayed, true);
  assert.notEqual(a.archive?.key, b.archive?.key);
  assert.equal(h.jobs().length, 2);
  for (const [result, bytes] of [[a, firstBytes], [b, secondBytes]] as const) {
    assert.equal(readFileSync(join(h.options.root, result.archive!.relativePath, "report/report.html"), "utf8"), bytes);
  }
  h.write("first", secondBytes);
  const editedRetry = await h.submit("first", "Not a replacement");
  assert(editedRetry.ok && editedRetry.replayed);
  assert.equal(readFileSync(join(h.options.root, a.archive!.relativePath, "report/report.html"), "utf8"), firstBytes);
  await h.manager.reconcileNow();
  assert.equal(h.manager.detail(a.archive!.key)?.title, "First report");
  assert.equal(h.manager.detail(b.archive!.key)?.title, "Second report");
});

test("a valid first report cannot hide a failed second report at completion or cleanup", async () => {
  const h = fixture();
  h.write("first"); h.write("second", "<script>bad()</script>");
  assert((await h.submit("first")).ok);
  assert.equal((await h.submit("second")).ok, false);
  const readiness = await h.manager.ensureReady(h.subject.taskId!);
  assert.equal(readiness.ok, false);
  if (!readiness.ok) assert.match(readiness.problems.join(" "), /second/);
  assert.equal((await h.manager.settleBeforeCleanup(h.subject.taskId!)).ok, false);
  const secondId = h.jobs().find((job) => job.submission?.reportPath.includes("second"))!.archiveId;
  h.write("second");
  assert((await h.submit("second")).ok);
  assert.equal(h.jobs().find((job) => job.archiveId === secondId)?.status, "published");
  assert((await h.manager.ensureReady(h.subject.taskId!)).ok);
});

test("taskless reports recover and retain their source after rebuilding the disposable index", async () => {
  const h = fixture(null);
  h.write("first"); h.write("second", "<script>bad()</script>");
  assert((await h.submit("first")).ok);
  assert.equal((await h.submit("second")).ok, false);
  assert(h.jobs().every((job) => job.taskId === null));
  h.write("second");
  const restarted = new ArchiveManager(h.options);
  await restarted.recoverJobs();
  assert(h.jobs().every((job) => job.status === "published"));
  clearArchiveTables(openDb());
  await restarted.reconcileNow();
  const page = restarted.list({ q: null, producer: null, session: h.subject.sessionId, repo: null,
    agent: null, kind: "scout", status: null, from: null, to: null, cursor: null, limit: 10 });
  assert.equal(page.archives.length, 2);
  assert(page.archives.every((row) => row.sourceSession?.id === h.subject.sessionId));
  assert(page.archives.every((row) => row.sourceSession?.taskId === null));
});

test("explicit ship reports settle at cleanup without becoming a mandatory completion gate", async () => {
  const h = fixture("ship");
  assert((await h.manager.ensureReady(h.subject.taskId!)).ok);
  h.write("first"); h.write("second", "<script>bad()</script>");
  assert((await h.submit("first")).ok);
  assert.equal((await h.submit("second")).ok, false);
  assert((await h.manager.ensureReady(h.subject.taskId!)).ok);
  assert.equal((await h.manager.settleBeforeCleanup(h.subject.taskId!)).ok, false);
  h.write("second");
  assert((await h.manager.settleBeforeCleanup(h.subject.taskId!)).ok);
  assert.equal(h.jobs().length, 2);
});

test("operator-deleted reports stay deleted across cleanup, restart, and retries while other reports settle", async () => {
  for (const kind of ["scout", "ship", "plan", null] as const) {
    const h = fixture(kind);
    h.write("deleted");
    const published = await h.submit("deleted");
    assert(published.ok && published.archive);
    const { key, relativePath } = published.archive;
    await h.manager.delete(key, key);
    assert.equal(existsSync(join(h.options.root, relativePath)), false);
    if (kind === "scout") assert.equal((await h.manager.ensureReady(h.subject.taskId!)).ok, false,
      "a deleted report cannot satisfy scout completion or be rebuilt by the gate");

    h.write("owed", "<script>invalid()</script>");
    assert.equal((await h.submit("owed")).ok, false);
    h.write("owed");
    if (kind) assert.deepEqual(await h.manager.settleBeforeCleanup(h.subject.taskId!), { ok: true });
    const restarted = new ArchiveManager(h.options);
    await restarted.recoverJobs();
    await restarted.reconcileNow();
    assert.equal(existsSync(join(h.options.root, relativePath)), false, `${kind}: deleted bundle must not return`);
    assert.equal(restarted.detail(key), null);
    assert.equal(h.jobs().find((job) => job.submission?.summary === "deleted")?.status, "deleted");
    assert.equal(h.jobs().find((job) => job.submission?.summary === "owed")?.status, "published");
    const retry = await h.submit("deleted");
    assert.equal(retry.ok, false);
    if (!retry.ok) assert.match(retry.problems.join(" "), /deleted.*new slug/);
    assert.equal(h.jobs().length, 2, "retry cannot reserve a fresh identity for a deleted directory");
  }
});

test("cleanup and report retry cannot cross an in-flight archive deletion", async () => {
  let deleting = false;
  let reachedRename!: () => void;
  const atRename = new Promise<void>((resolve) => { reachedRename = resolve; });
  let releaseRename!: () => void;
  const released = new Promise<void>((resolve) => { releaseRename = resolve; });
  const h = fixture("scout", { rename: async (from, to) => {
    if (deleting) { reachedRename(); await released; }
    await rename(from, to);
  } });
  h.write("deleted");
  const published = await h.submit("deleted");
  assert(published.ok && published.archive);
  deleting = true;
  const deletion = h.manager.delete(published.archive.key, published.archive.key);
  await atRename;
  const retry = h.submit("deleted");
  const cleanup = h.manager.settleBeforeCleanup(h.subject.taskId!);
  releaseRename();
  await deletion;
  assert.equal((await retry).ok, false);
  assert.deepEqual(await cleanup, { ok: true });
  assert.equal(existsSync(join(h.options.root, published.archive.relativePath)), false);
  assert.equal(h.jobs()[0]?.status, "deleted");
  assert.equal(h.jobs().length, 1, "cleanup must not reserve automatic recovery for a deleted report");
});

test("deleting a recovered legacy report retains its directory identity", async () => {
  const h = fixture();
  h.write("recovered");
  assert.deepEqual(await h.manager.settleBeforeCleanup(h.subject.taskId!), { ok: true });
  const legacy = h.jobs()[0]!;
  assert.equal(legacy.scope, null);
  assert.equal(legacy.submission, null);
  const key = `${legacy.producerId}~${legacy.archiveId}`;
  await h.manager.delete(key, key);
  assert.equal((await h.submit("recovered")).ok, false);
  assert.equal(h.jobs().length, 1);
  assert.deepEqual(await h.manager.settleBeforeCleanup(h.subject.taskId!), { ok: true });
  assert.equal(existsSync(join(h.options.root, legacy.relativePath!)), false);
  h.write("replacement");
  assert((await h.submit("replacement")).ok);
});

test("a failed deletion retains durable intent and remains retryable after restart", async () => {
  let failDeletion = false;
  const h = fixture("ship", { rename: async (from, to) => {
    if (failDeletion) throw new Error("fixture rename failure");
    await rename(from, to);
  } });
  h.write("deleted");
  const published = await h.submit("deleted");
  assert(published.ok && published.archive);
  failDeletion = true;
  await assert.rejects(h.manager.delete(published.archive.key, published.archive.key), /fixture rename failure/);
  const restarted = new ArchiveManager({ ...h.options, rename });
  await restarted.recoverJobs();
  await restarted.delete(published.archive.key, published.archive.key);
  assert.deepEqual(await restarted.settleBeforeCleanup(h.subject.taskId!), { ok: true });
  assert.equal(h.jobs()[0]?.status, "deleted");
  assert.equal(existsSync(join(h.options.root, published.archive.relativePath)), false);
});

test("deletion waits for an in-flight rebuild and removes its published bytes", async () => {
  let rebuilding = false;
  let reachedPublish!: () => void;
  const atPublish = new Promise<void>((resolve) => { reachedPublish = resolve; });
  let releasePublish!: () => void;
  const released = new Promise<void>((resolve) => { releasePublish = resolve; });
  const h = fixture("ship", { rename: async (from, to) => {
    if (rebuilding && !to.includes(".trash")) { reachedPublish(); await released; }
    await rename(from, to);
  } });
  h.write("deleted");
  const published = await h.submit("deleted");
  assert(published.ok && published.archive);
  await h.manager.reconcileNow();
  rmSync(join(h.options.root, published.archive.relativePath), { recursive: true });
  rebuilding = true;
  const capture = h.submit("deleted");
  await atPublish;
  const deletion = h.manager.delete(published.archive.key, published.archive.key);
  releasePublish();
  await capture;
  assert.deepEqual(await deletion, { ok: true, deletedBundle: true });
  assert.deepEqual(await h.manager.settleBeforeCleanup(h.subject.taskId!), { ok: true });
  assert.equal(existsSync(join(h.options.root, published.archive.relativePath)), false);
  assert.equal(h.jobs()[0]?.status, "deleted");
});

test("cleanup refuses an incomplete explicit report for every task kind", async () => {
  for (const kind of ["scout", "ship", "plan"] as const) {
    const h = fixture(kind);
    const missingPath = h.write("incomplete");
    rmSync(join(h.root, missingPath));
    const submitted = await h.submit("incomplete");
    assert.equal(submitted.ok, false, "fresh submissions already refuse missing source files");
    // Seed a partial bundle left by legacy recovery while the ledger carries a submission.
    // Replay must inspect the verified bundle's completeness, not just its existence.
    const partial = await captureArchive({ ...h.jobs()[0]!, submission: null }, {
      libraryRoot: h.options.root, producerLabel: null,
    });
    assert(partial.ok && partial.captureStatus === "partial");
    h.write("complete");
    assert((await h.submit("complete")).ok);
    const cleanup = await h.manager.settleBeforeCleanup(h.subject.taskId!);
    assert.equal(cleanup.ok, false, `${kind} must retain sources for its incomplete explicit report`);
    if (!cleanup.ok) {
      assert.match(cleanup.error, /docs\/reports\/incomplete\/report\.html/);
      assert.match(cleanup.error, /incomplete/);
    }
    if (kind !== "scout") assert((await h.manager.ensureReady(h.subject.taskId!)).ok,
      "report cleanup does not change ordinary task completion rules");
  }
});

test("legacy submitted captures retain their original identity when a new report is added", async () => {
  const h = fixture();
  h.write("first"); h.write("second");
  const legacy = h.store.reserve({ ...h.subject, kind: "scout", producerId: h.manager.producer.id });
  h.store.recordSubmission(legacy.operationKey, { reportPath: "docs/reports/first/report.html", summary: "first", tags: [], supporting: [] });
  await h.manager.recoverJobs();
  const first = await h.submit("first");
  const second = await h.submit("second");
  assert(first.ok && second.ok);
  assert.equal(first.archive?.key, `${legacy.producerId}~${legacy.archiveId}`);
  assert.notEqual(first.archive?.key, second.archive?.key);
  assert.equal(h.jobs().length, 2);
});

test("an unmatched unpublished legacy capture stays unchanged when a different report is submitted", async () => {
  for (const status of ["reserved", "failed"] as const) {
    const h = fixture();
    h.write("earlier-report");
    const reservation = h.store.reserve({ ...h.subject, kind: "scout", producerId: h.manager.producer.id });
    if (status === "failed") h.store.markFailed(reservation.operationKey, "interrupted legacy capture");
    const legacy = h.store.get(reservation.operationKey)!;
    assert.equal(legacy.submission, null);
    assert.equal(legacy.scope, null);
    assert.equal(legacy.status, status);

    const bytes = validReportHtml().replace("</body>", "<p>A different report</p></body>");
    h.write("new-report", bytes);
    const result = await h.submit("new-report", "New report");
    assert(result.ok && result.archive);
    assert.notEqual(result.archive.key, `${legacy.producerId}~${legacy.archiveId}`);
    assert.deepEqual(h.store.get(legacy.operationKey), legacy);
    assert.equal(h.jobs().length, 2);
    const created = h.jobs().find((job) => job.operationKey !== legacy.operationKey)!;
    assert.deepEqual(created.scope, { slot: "repo-01", directory: "docs/reports/new-report" });
    assert.equal(created.status, "published");
    assert.equal(result.archive.key, `${created.producerId}~${created.archiveId}`);
    assert.equal(readFileSync(join(h.options.root, result.archive.relativePath, "report/report.html"), "utf8"), bytes);

    const retry = await h.submit("new-report");
    assert(retry.ok && retry.replayed);
    assert.equal(retry.archive?.key, result.archive.key);
    assert.equal(h.jobs().length, 2);
    assert.deepEqual(h.store.get(legacy.operationKey), legacy);
  }
});

test("completion admission stays closed until the task's checked transition commits", async () => {
  const h = fixture();
  h.write("first"); h.write("second");
  await h.submit("first");
  await h.manager.withCompletion(h.subject.taskId!, async () => {
    assert((await h.manager.ensureReady(h.subject.taskId!)).ok);
    const late = await h.submit("second");
    assert.equal(late.ok, false);
    if (!late.ok) assert.match(late.problems.join(" "), /completing/);
    assert.equal(h.jobs().length, 1);
  });
  assert((await h.submit("second")).ok);
});

test("session filters pair source identity with producer identity", async () => {
  const h = fixture();
  h.write("first"); await h.submit("first");
  await h.manager.reconcileNow();
  const query = { q: null, producer: null, session: h.subject.sessionId, repo: null,
    agent: null, kind: null, status: null, from: null, to: null, cursor: null, limit: 10 };
  assert.equal(h.manager.list(query).archives.length, 1);
  assert.equal(h.manager.list({ ...query, producer: "11111111-2222-4333-8444-555555555555" }).archives.length, 0);
  assert.equal(new ArchiveStore().get(h.jobs()[0]!.producerId + "~" + h.jobs()[0]!.archiveId)?.sourceSession?.id, h.subject.sessionId);
});


test("cleanup closes admission before its first wait even when no report has been submitted", async () => {
  const h = fixture("ship");
  h.write("first");
  const cleanup = h.manager.settleBeforeCleanup(h.subject.taskId!);
  const late = await h.submit("first");
  assert.equal(late.ok, false);
  if (!late.ok) {
    assert.equal("status" in late && late.status, 409);
    assert.match(late.problems.join(" "), /releasing its checkout/);
  }
  assert((await cleanup).ok);
  assert.equal(h.jobs().length, 0);
  assert((await h.submit("first")).ok, "settlement alone retains the checkout and permits retries");
});

test("cleanup waits for an attributed second report before its durable job exists", async () => {
  let entered!: () => void; let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  let pause = false;
  const h = fixture("ship", { afterSubmissionAttribution: async () => { if (pause) { entered(); await resume; } } });
  h.write("first"); h.write("second");
  await h.submit("first");
  pause = true;
  const pending = h.submit("second");
  await waiting;
  let settled = false;
  const cleanup = h.manager.settleBeforeCleanup(h.subject.taskId!).then((result) => { settled = true; return result; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(h.jobs().length, 1);
  release();
  assert((await pending).ok);
  assert((await cleanup).ok);
  assert.equal(h.jobs().filter((job) => job.status === "published").length, 2);
});

test("cleanup drains admitted claims and keeps every owner episode closed through nested settlement", async () => {
  let onAttribution!: () => void; let releaseSubmission!: () => void;
  let onDecision!: () => void; let releaseCleanup!: () => void;
  const attributed = new Promise<void>((resolve) => { onAttribution = resolve; });
  const resumeSubmission = new Promise<void>((resolve) => { releaseSubmission = resolve; });
  const deciding = new Promise<void>((resolve) => { onDecision = resolve; });
  const resumeCleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const h = fixture("ship", { afterSubmissionAttribution: async () => {
    onAttribution();
    await resumeSubmission;
  } });
  h.write("accepted"); h.write("late");
  const accepted = h.submit("accepted");
  await attributed;
  let checkoutDecisionStarted = false;
  const cleanup = h.manager.withCleanup(h.subject.taskId!, async () => {
    checkoutDecisionStarted = true;
    assert.equal(h.jobs()[0]?.status, "published", "accepted bytes are durable before cleanup proceeds");
    assert((await h.manager.settleBeforeCleanup(h.subject.taskId!)).ok);
    onDecision();
    await resumeCleanup;
    return { ok: true };
  });
  try {
    assert.equal((await h.submit("late")).ok, false, "new claims cannot join the drain");
    assert.equal(checkoutDecisionStarted, false);
    assert.equal(h.jobs().length, 0, "the admitted claim is still ahead of its durable row");
    releaseSubmission();
    assert((await accepted).ok);
    await deciding;
    // A lifecycle callback can rotate the episode while cleanup holds the owner's checkout.
    h.subject.episodeId = "rotated-during-cleanup";
    const late = await h.submit("late");
    assert.equal(late.ok, false, "nested settlement cannot reopen this owner, even after an episode change");
    if (!late.ok) assert.equal("status" in late && late.status, 409);
    const other = fixture("ship");
    other.write("independent");
    assert((await other.submit("independent")).ok, "unrelated owners remain available");
  } finally {
    releaseSubmission();
    releaseCleanup();
    await accepted;
    await cleanup;
  }
  assert((await h.submit("late")).ok);
});

test("cleanup reopens retained sources after a refusal or exception", async () => {
  for (const failure of ["refusal", "exception"] as const) {
    const h = fixture();
    h.write("retry");
    const cleanup = h.manager.withCleanup(h.subject.taskId!, async () => {
      await h.manager.withCompletion(h.subject.taskId!, async () => {
        assert.equal((await h.submit("retry")).ok, false);
      });
      assert.equal((await h.submit("retry")).ok, false, "completion cannot reopen cleanup admission");
      if (failure === "exception") throw new Error("checkout retained");
      return { ok: false, error: "checkout retained" };
    });
    if (failure === "exception") await assert.rejects(cleanup, /checkout retained/);
    else assert.deepEqual(await cleanup, { ok: false, error: "checkout retained" });
    assert.equal(h.jobs().length, 0);
    assert((await h.submit("retry")).ok, "the caller can retry against retained sources");
  }
});

test("an automatically recovered legacy report replays and a new directory gets its own archive", async () => {
  const h = fixture();
  h.gateway.awaitsAgent = () => false;
  h.write("first");
  const old = h.store.reserve({ ...h.subject, kind: "scout", producerId: h.manager.producer.id });
  await h.manager.recoverJobs();
  const replay = await h.submit("first");
  assert(replay.ok && replay.replayed);
  assert.equal(replay.archive?.key, `${old.producerId}~${old.archiveId}`);
  h.write("second");
  assert((await h.submit("second")).ok);
  assert.equal(h.jobs().length, 2);
});

test("later reports freeze later human context without rewriting the first report's prompt trail", async () => {
  const { openScoutPromptContext, appendScoutPromptTurn, scoutPromptContext } = await import("../src/server/scouts/prompt-context.ts");
  const { collectScoutPromptTrail } = await import("../src/server/scouts/prompt-collector.ts");
  const h = fixture();
  const task = mkTask({ id: h.subject.taskId!, kind: "scout", intent: "Initial question" });
  openScoutPromptContext({ taskId: task.id, episodeId: h.subject.episodeId!, sessionId: h.subject.sessionId,
    sessionName: "Source session", transcriptPath: null, transcriptOffset: null });
  h.gateway.scoutPromptTrailFor = () => collectScoutPromptTrail(task, h.subject.episodeId, null).trail;
  h.write("first"); h.write("second");
  await h.submit("first");
  assert(scoutPromptContext(task.id, h.subject.episodeId!));
  appendScoutPromptTurn({ id: "later-human", taskId: task.id, episodeId: h.subject.episodeId!, origin: "human", text: "Also examine the second case" });
  await h.submit("second");
  const first = h.jobs().find((job) => job.submission?.reportPath.includes("first"))!;
  const second = h.jobs().find((job) => job.submission?.reportPath.includes("second"))!;
  assert.equal(first.prompts?.entries.length, 1);
  assert.equal(second.prompts?.entries.length, 2);
  assert.equal(second.prompts?.entries[1]?.text, "Also examine the second case");
  h.manager.reconcilePromptContexts(new Set());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(scoutPromptContext(task.id, h.subject.episodeId!), null);
  assert.equal(h.store.get(second.operationKey)?.prompts?.entries.length, 2);
});


test("fallback titles retain each report slug when the session name reaches the title limit", async () => {
  const h = fixture();
  h.subject.title = "A".repeat(200);
  h.write("first"); h.write("second");
  await h.submit("first"); await h.submit("second");
  assert(h.jobs().every((job) => job.title.length <= 200));
  assert.deepEqual(h.jobs().map((job) => job.title.slice(-8)).sort(), [" / first", "/ second"].sort());
});
