import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: the public backend API is the surface the dashboard drives, and it must expose
 * only behavior the daemon can execute safely. Every mutating route goes through `parseBody`, ids
 * in the URL select records but never bypass current-state checks, a decision names the state it
 * expects, and deletion demands the run id echoed back. These tests hit the real routes through
 * `buildApp` and assert the status codes and body-parsing contracts that the UI (Phase 7) relies on.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-http-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { EnsembleManager } = await import("../src/server/ensembles/manager.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { EnsembleEngine } = await import("../src/server/ensembles/engine.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { FakeGateway, FakeFinalize, stubAdapters, decidePlan, runInsert, gitRepo } = await import("./ensemble-fixture.ts");
const { captureWorktreeSnapshot } = await import("../src/server/git/ensemble-snapshot.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

function req(app: ReturnType<typeof buildApp>, path: string, body?: unknown, method = "POST") {
  return app.request(path, {
    method,
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function build() {
  const adapters = stubAdapters();
  const registry = new Registry();
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const finalize = new FakeFinalize();
  // Preview and create share the read-only launch preflight, so stub the harness/MCP availability
  // it probes; the repository is a real one per test where preflight must actually pass.
  const manager = new EnsembleManager(registry, store, {
    tasks: gateway,
    finalize,
    adapters,
    agentBinPresent: async () => true,
    missionMcpAvailable: async () => true,
  });
  const app = buildApp(registry, new ReviewManager(registry), new TaskManager(registry), new QueueManager(registry), undefined, undefined, undefined, undefined, manager);
  // A separate engine on the SAME store/gateway/finalize drives a run to awaiting_decision without
  // needing the manager's private launch path or a real repository.
  const driver = new EnsembleEngine({ store, tasks: gateway, publish: () => {}, adapters, finalize, now: () => 1000, armTimer: () => () => {} });
  return { registry, store, gateway, finalize, manager, app, driver };
}

async function driveToDecision(store: InstanceType<typeof EnsembleStore>, gateway: InstanceType<typeof FakeGateway>, driver: InstanceType<typeof EnsembleEngine>) {
  const { run } = store.createRun(runInsert(decidePlan(3, 2)));
  await driver.launch(run.id);
  for (const dispatch of [...gateway.dispatched]) {
    gateway.running(dispatch.taskId, `/wt/${dispatch.taskId}`);
    await driver.wake(run.id);
    const memberId = store.listAttempts(run.id).find((a) => a.taskId === dispatch.taskId)!.memberId;
    await driver.submit({ runId: run.id, memberId, claims: { summary: "did it", checks: [], testEvidence: null }, source: "mcp", requireWorktree: null });
  }
  return run.id;
}

test("GET /api/ensembles lists compact summaries and filters by status", async () => {
  const { store, app } = build();
  store.createRun(runInsert(decidePlan(2, 2), { sourceKey: "a", status: "running" }));
  store.createRun(runInsert(decidePlan(2, 2), { sourceKey: "b", status: "planning" }));
  const all = await req(app, "/api/ensembles", undefined, "GET");
  assert.equal(all.status, 200);
  const body = (await all.json()) as { ensembles: unknown[]; total: number };
  assert.equal(body.total, 2);
  const running = await req(app, "/api/ensembles?status=running", undefined, "GET");
  const filtered = (await running.json()) as { ensembles: Array<{ status: string }>; total: number };
  assert.equal(filtered.total, 1);
  assert.equal(filtered.ensembles[0]!.status, "running");
});

test("POST /api/ensembles/preview validates a draft side-effect-free and never persists", async () => {
  const { store, app } = build();
  const { path } = gitRepo();
  // A valid draft (real repository, stubbed harness/MCP) previews as launchable through the SAME
  // preflight create runs.
  const ok = await req(app, "/api/ensembles/preview", {
    sourceKey: "p1",
    title: "Try it",
    intent: "implement the feature",
    repoRoot: path,
    strategyId: "best_of_n",
    strategyConfig: { members: [{}, {}, {}] },
  });
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as { ok: boolean; estimate: { initialMembers: number } | null };
  assert.equal(okBody.ok, true);
  assert.equal(okBody.estimate?.initialMembers, 3);
  // A draft below the roster minimum is a 200 carrying its own validation issues, not a refusal.
  const bad = await req(app, "/api/ensembles/preview", {
    sourceKey: "p2",
    title: "Too few",
    intent: "x",
    repoRoot: path,
    strategyId: "best_of_n",
    strategyConfig: { members: [{}] },
  });
  assert.equal(bad.status, 200);
  const badBody = (await bad.json()) as { ok: boolean; issues: unknown[] };
  assert.equal(badBody.ok, false);
  assert.ok(badBody.issues.length > 0);
  // A draft for an invalid repository previews as NOT launchable - preview shares create's preflight.
  const badRepo = await req(app, "/api/ensembles/preview", {
    sourceKey: "p3",
    title: "No repo",
    intent: "implement the feature",
    repoRoot: "/does/not/exist",
    strategyId: "best_of_n",
    strategyConfig: { members: [{}, {}] },
  });
  assert.equal(badRepo.status, 200);
  const badRepoBody = (await badRepo.json()) as { ok: boolean; reason: string | null };
  assert.equal(badRepoBody.ok, false);
  assert.equal(badRepoBody.reason, "preflight_failed");
  // Preview persisted nothing.
  assert.equal(store.listRuns().length, 0);
});

test("POST /api/ensembles refuses an invalid config with a 400 and launches nothing", async () => {
  const { store, gateway, app } = build();
  const res = await req(app, "/api/ensembles", {
    sourceKey: "c1",
    title: "Bad",
    intent: "x",
    repoRoot: "/repo",
    strategyId: "best_of_n",
    strategyConfig: { members: [{}] },
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string };
  assert.match(body.code, /ensemble_create_/);
  assert.equal(store.listRuns().length, 0, "an invalid create persisted no run");
  assert.equal(gateway.dispatched.length, 0, "and launched nothing");
});

test("POST /api/ensembles refuses a mismatched source-key replay with a 409", async () => {
  const { manager, app } = build();
  const request = {
    sourceKey: "create-conflict",
    title: "Original",
    intent: "original intent",
    repoRoot: "/repo",
    strategyId: "best_of_n" as const,
    strategyConfig: { members: [{}, {}] },
  };
  const created = manager.create(request, 100);
  assert.equal(created.ok, true);

  const conflict = await req(app, "/api/ensembles", {
    ...request,
    intent: "different intent",
    workflow: { workflowId: "unsupported-workflow", workflowVersion: 1 },
  });
  assert.equal(conflict.status, 409);
  const body = (await conflict.json()) as { code: string };
  assert.equal(body.code, "ensemble_create_request_conflict");

  // Reusing the source key against a DIFFERENT repository is the same conflict - the caller must not
  // be told it launched against the new repo when it got the old run. Every field is compared.
  const repoConflict = await req(app, "/api/ensembles", { ...request, repoRoot: "/a/different/repo" });
  assert.equal(repoConflict.status, 409);
  assert.equal(((await repoConflict.json()) as { code: string }).code, "ensemble_create_request_conflict");
});

test("POST /api/ensembles/:id/actions decides through the manager and reaches completed", async () => {
  const { store, gateway, driver, app } = build();
  const runId = await driveToDecision(store, gateway, driver);
  const member = store.listMembers(runId).find((m) => m.ordinal === 1)!;
  const attemptIds = new Set(store.listAttempts(runId).filter((a) => a.memberId === member.id).map((a) => a.id));
  const artifactId = store.listArtifacts(runId).find((a) => a.status === "ready" && a.attemptId !== null && attemptIds.has(a.attemptId))!.id;

  // A missing destructive confirmation is rejected at the schema boundary before any effect.
  const noConfirm = await req(app, `/api/ensembles/${runId}/actions`, { kind: "decide", requestId: "r1", expectedStatus: "awaiting_decision", selection: { kind: "selected", artifactId } });
  assert.equal(noConfirm.status, 400);

  const decided = await req(app, `/api/ensembles/${runId}/actions`, { kind: "decide", requestId: "r1", expectedStatus: "awaiting_decision", selection: { kind: "selected", artifactId }, confirmDestructive: true, rationale: "ship it" });
  assert.equal(decided.status, 200);
  assert.equal(store.getRun(runId)!.status, "completed");

  // A conflicting current-state check: deciding again in the wrong expected state is a 409.
  const conflict = await req(app, `/api/ensembles/${runId}/actions`, { kind: "decide", requestId: "r2", expectedStatus: "awaiting_decision", selection: { kind: "selected", artifactId }, confirmDestructive: true });
  assert.equal(conflict.status, 409);
});

// ---- the artifact patch route's two cheaper questions ----------------------------------
//
// `?path=` and `?filesOnly=1` exist so a compare surface does not have to buy N whole patches
// to learn which files N candidates touched. What the route owes its caller is that the cut it
// performed is the cut that was asked for: one path per request (a list would be truncated by
// `maxHeaderSize` long before anyone noticed - see the `/standards` comment beside the route),
// a refusal rather than a silent first-wins when the key repeats, and complete `files` in every
// response so "not in the patch" is never mistaken for "not touched".

/**
 * A run whose artifact is a REAL captured commit in a REAL repository.
 *
 * The route reaches the shipped `ARTIFACT_ADAPTERS`, not the registry a manager was built
 * with, so a stub here would test the query parsing against nothing. This drives the whole
 * path - route, adapter, `git diff` - which is also the only way `?path=` can be shown to cut
 * an actual patch rather than a fixture that agreed to look cut.
 */
async function runWithRealArtifact(
  store: InstanceType<typeof EnsembleStore>,
  sourceKey: string,
  fileDirectoryCollision = false,
) {
  const { path: repo, baseSha: initialBaseSha } = gitRepo();
  let baseSha = initialBaseSha;
  if (fileDirectoryCollision) {
    writeFileSync(join(repo, "src"), "blob replaced by a directory\n");
    execFileSync("git", ["-C", repo, "add", "src"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "collision base"]);
    baseSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    rmSync(join(repo, "src"));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "nested.ts"), "");
  } else {
    // A directory BOTH commits hold and neither touches, committed into the base: the complete
    // file list cannot tell it from a file nobody edited, so it is the case the route has to
    // answer from the trees rather than from the difference.
    mkdirSync(join(repo, "untouched"), { recursive: true });
    writeFileSync(join(repo, "untouched", "stable.txt"), "committed before the base\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "a directory the difference never touches"]);
    baseSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(repo, "a.txt"), "first candidate file\n");
    writeFileSync(join(repo, "b.txt"), "second candidate file\n");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "nested.ts"), "nested candidate file\n");
  }
  const snapshot = await captureWorktreeSnapshot({
    worktreePath: repo,
    ensembleId: randomUUID(),
    artifactId: randomUUID(),
  });
  const { run } = store.createRun(runInsert(decidePlan(2, 2), { sourceKey, repoRoot: repo, baseSha }));
  const artifact = store.recordArtifact({
    runId: run.id,
    attemptId: null,
    kind: "commit",
    formatVersion: 1,
    attempt: 1,
    status: "ready",
    locator: {
      kind: "git_snapshot",
      formatVersion: 1,
      ref: snapshot.ref,
      snapshotSha: snapshot.snapshotSha,
      baseSha,
      parentSha: snapshot.parentSha,
      treeSha: snapshot.treeSha,
    },
    digest: snapshot.treeSha,
    metadata: {},
    operationKey: `op-${sourceKey}`,
    readyAt: 1000,
  });
  return { runId: run.id, artifactId: artifact.id, repo };
}

test("GET .../patch cuts to one path, refuses a list, and can skip the patch entirely", async () => {
  const { store, app } = build();
  const { runId, artifactId } = await runWithRealArtifact(store, "patch-cuts");
  const url = `/api/ensembles/${runId}/artifacts/${artifactId}/patch`;
  const filesIn = (patch: string) => [...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);

  // No query params: what every existing caller already gets, plus the new `patchPaths: null`
  // saying this is the whole difference rather than somebody's cut.
  const whole = await req(app, url, undefined, "GET");
  assert.equal(whole.status, 200);
  const wholeBody = (await whole.json()) as { patch: string; patchPaths: string[] | null; files: Array<{ path: string }> };
  assert.equal(wholeBody.patchPaths, null);
  assert.deepEqual(filesIn(wholeBody.patch).sort(), ["a.txt", "b.txt", "src/nested.ts"]);
  assert.equal(wholeBody.files.length, 3);

  // One path: one file's hunks, and the complete file list beside them.
  const single = await req(app, `${url}?path=a.txt`, undefined, "GET");
  assert.equal(single.status, 200);
  const singleBody = (await single.json()) as { patch: string; patchPaths: string[]; files: Array<{ path: string }> };
  assert.deepEqual(singleBody.patchPaths, ["a.txt"]);
  assert.deepEqual(filesIn(singleBody.patch), ["a.txt"]);
  assert.equal(singleBody.files.length, 3, "the file list is never narrowed by a path filter");
  assert.deepEqual(singleBody.files.map((f) => f.path).sort(), ["a.txt", "b.txt", "src/nested.ts"]);

  // A path this artifact never touched is an empty patch, not an error - and `files` is what
  // says so. Inferring "untouched" from the absent hunks alone would read the same for a file
  // whose diff simply did not fit the budget.
  const absent = await req(app, `${url}?path=never-touched.txt`, undefined, "GET");
  assert.equal(absent.status, 200);
  const absentBody = (await absent.json()) as { patch: string; patchPaths: string[]; files: Array<{ path: string }> };
  assert.equal(absentBody.patch, "");
  assert.deepEqual(absentBody.patchPaths, ["never-touched.txt"]);
  assert.equal(absentBody.files.length, 3);

  const directory = await req(app, `${url}?path=src`, undefined, "GET");
  assert.equal(directory.status, 400);
  assert.match(
    ((await directory.json()) as { error: string }).error,
    /must name exactly one file.*"src" is a directory/,
  );

  // A directory is refused whether or not the difference touched anything under it. Read off
  // the file list alone this one looks exactly like an untouched file, and answering it with a
  // 200 and an empty patch is a directory wearing a file's answer - which is the reading the
  // whole exact-file rule exists to prevent.
  const unchangedDirectory = await req(app, `${url}?path=untouched`, undefined, "GET");
  assert.equal(unchangedDirectory.status, 400);
  assert.match(
    ((await unchangedDirectory.json()) as { error: string }).error,
    /must name exactly one file.*"untouched" is a directory/,
  );

  // The FILE inside it is the other answer, and it must stay a 200: "this candidate did not
  // touch that file" is a real result, not a refusal.
  const untouchedFile = await req(app, `${url}?path=untouched%2Fstable.txt`, undefined, "GET");
  assert.equal(untouchedFile.status, 200);
  const untouchedBody = (await untouchedFile.json()) as { patch: string; patchPaths: string[]; files: unknown[] };
  assert.equal(untouchedBody.patch, "");
  assert.deepEqual(untouchedBody.patchPaths, ["untouched/stable.txt"]);
  assert.equal(untouchedBody.files.length, 3, "and the statistics stay complete");

  // A repeated key is refused rather than reduced to the first: a caller that meant to batch
  // would otherwise get one file's diff labelled as the whole set, and never find out.
  const repeated = await req(app, `${url}?path=a.txt&path=b.txt`, undefined, "GET");
  assert.equal(repeated.status, 400);
  assert.match(((await repeated.json()) as { error: string }).error, /one path per request/);

  // A path nobody can honour is the caller's mistake, so 400 rather than a 500 out of git.
  for (const bad of ["/etc/passwd", "../outside.txt", "nul\0path"]) {
    const refused = await req(app, `${url}?path=${encodeURIComponent(bad)}`, undefined, "GET");
    assert.equal(refused.status, 400, `should refuse ${bad}`);
    assert.match(((await refused.json()) as { error: string }).error, /patch path/);
  }

  // Files only: the complete statistics, and no patch body at all.
  const filesOnly = await req(app, `${url}?filesOnly=1`, undefined, "GET");
  assert.equal(filesOnly.status, 200);
  const filesOnlyBody = (await filesOnly.json()) as {
    patch: string;
    patchPaths: string[];
    files: Array<{ path: string; insertions: number }>;
    filesChanged: number;
    insertions: number;
  };
  assert.equal(filesOnlyBody.patch, "");
  assert.deepEqual(filesOnlyBody.patchPaths, [], "empty says no patch was rendered at all");
  assert.equal(filesOnlyBody.filesChanged, 3);
  assert.deepEqual(filesOnlyBody.files, wholeBody.files, "the same complete file list, for one git call");
  assert.equal(filesOnlyBody.insertions, 3);
});

test("GET .../patch slices a file-to-directory collision to the exact file", async () => {
  const { store, app } = build();
  const { runId, artifactId } = await runWithRealArtifact(store, "patch-collision", true);
  const url = `/api/ensembles/${runId}/artifacts/${artifactId}/patch?path=src`;

  const response = await req(app, url, undefined, "GET");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    patch: string;
    patchPaths: string[];
    files: Array<{ path: string }>;
  };
  assert.equal(body.patch.match(/^diff --git /gm)?.length, 1);
  assert.match(body.patch, /^diff --git a\/src b\/src$/m);
  assert.doesNotMatch(body.patch, /src\/nested\.ts/);
  assert.deepEqual(body.patchPaths, ["src"]);
  assert.deepEqual(body.files.map((file) => file.path).sort(), ["src", "src/nested.ts"]);
});

test("GET .../patch still refuses an artifact that is not ready, whatever it was asked for", async () => {
  const { store, gateway, driver, app } = build();
  const runId = await driveToDecision(store, gateway, driver);
  // A capture in flight has no immutable commit to read, so there is nothing honest to cut.
  const capturing = store.recordArtifact({
    runId,
    attemptId: null,
    kind: "commit",
    formatVersion: 1,
    attempt: 1,
    status: "capturing",
    locator: {},
    digest: "not-yet",
    metadata: {},
    operationKey: "op-capturing",
    readyAt: null,
  });
  const url = `/api/ensembles/${runId}/artifacts/${capturing.id}/patch`;

  for (const query of ["", "?path=src%2Fa.ts", "?filesOnly=1"]) {
    const res = await req(app, `${url}${query}`, undefined, "GET");
    assert.equal(res.status, 409, `a cut must not smuggle a non-ready artifact past the check: ${query}`);
  }

  const missing = await req(app, `/api/ensembles/${runId}/artifacts/nope/patch?path=src%2Fa.ts`, undefined, "GET");
  assert.equal(missing.status, 404);
});

test("DELETE /api/ensembles/:id demands the id echoed and a terminal run", async () => {
  const { store, registry, manager, app } = build();
  const events: string[] = [];
  registry.subscribe((e) => { if (e.type === "ensemble_remove") events.push(e.id); });
  const running = store.createRun(runInsert(decidePlan(2, 2), { sourceKey: "d1", status: "running" })).run;
  manager.publish(running.id);

  // Wrong confirmation id: refused.
  const mismatch = await req(app, `/api/ensembles/${running.id}`, { confirmId: "not-it" }, "DELETE");
  assert.equal(mismatch.status, 400);
  // A non-terminal run cannot be deleted: cancel it first.
  const live = await req(app, `/api/ensembles/${running.id}`, { confirmId: running.id }, "DELETE");
  assert.equal(live.status, 409);

  const done = store.createRun(runInsert(decidePlan(2, 2), { sourceKey: "d2", status: "completed" })).run;
  manager.publish(done.id);
  const deleted = await req(app, `/api/ensembles/${done.id}`, { confirmId: done.id }, "DELETE");
  assert.equal(deleted.status, 200);
  assert.equal(store.getRun(done.id), null, "the terminal run's rows are gone");
  assert.deepEqual(events, [done.id], "ensemble_remove was emitted");
});
