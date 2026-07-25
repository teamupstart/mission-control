import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: explicit deletion is the ONE act that destroys an ensemble's evidence - its
 * generated private refs. It must delete only refs this build generated (never a ref name read off
 * anywhere but the run's own artifacts), resume the same remaining refs after a crash, and never
 * touch a Task or any linked Workflow state. These tests use a real Git repository and a real ref so
 * the deletion and its recovery are exercised end to end.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-delete-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { EnsembleManager } = await import("../src/server/ensembles/manager.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { resolveEnsembleRef } = await import("../src/server/git/ensemble-snapshot.ts");
const { gitRepo, decidePlan, runInsert } = await import("./ensemble-fixture.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

/** Seed a completed run in a real repo, with one ready artifact pointing at a real private ref. */
function seedWithRef(store: InstanceType<typeof EnsembleStore>) {
  const { path, baseSha } = gitRepo();
  const { run } = store.createRun(runInsert(decidePlan(2, 2), { repoRoot: path, status: "completed", sourceKey: `del:${Math.random()}` }));
  const ref = `refs/mission-control/ensembles/${run.id}/artifact-1`;
  execFileSync("git", ["-C", path, "update-ref", ref, baseSha]);
  store.recordArtifact(
    {
      runId: run.id,
      attemptId: null,
      kind: "commit",
      formatVersion: 1,
      attempt: 1,
      status: "ready",
      locator: { kind: "git_snapshot", ref, snapshotSha: baseSha, baseSha },
      digest: "digest",
      metadata: {},
      operationKey: `op:${run.id}`,
      readyAt: 1,
    },
    1,
  );
  return { run, path, ref };
}

test("deleting a terminal run removes its generated private ref and its rows, and emits ensemble_remove", async () => {
  const registry = new Registry();
  const store = new EnsembleStore(db);
  const manager = new EnsembleManager(registry, store, {});
  const { run, path, ref } = seedWithRef(store);
  manager.publish(run.id);
  const removed: string[] = [];
  registry.subscribe((e) => { if (e.type === "ensemble_remove") removed.push(e.id); });
  assert.notEqual(await resolveEnsembleRef(path, ref), null, "the ref exists before deletion");

  const result = await manager.deleteRun(run.id, run.id);
  assert.equal(result.ok, true);
  assert.equal(await resolveEnsembleRef(path, ref), null, "the generated ref is deleted");
  assert.equal(store.getRun(run.id), null, "the ensemble rows are gone");
  assert.deepEqual(removed, [run.id]);
});

test("a crash mid-deletion resumes the same remaining refs", async () => {
  const registry = new Registry();
  const store = new EnsembleStore(db);
  const manager = new EnsembleManager(registry, store, {});
  const { run, path, ref } = seedWithRef(store);
  // Simulate a crash AFTER the intent was opened but BEFORE the run was deleted: the intent is
  // durable and its run still exists, so recovery finds exactly the deletions that did not finish.
  store.beginDeletionIntent(run.id, 1);
  assert.notEqual(store.getDeletionIntent(run.id), null);

  await manager.recoverDeletions();
  assert.equal(await resolveEnsembleRef(path, ref), null, "recovery deleted the remaining ref");
  assert.equal(store.getRun(run.id), null, "and finished deleting the run");
  assert.equal(store.getDeletionIntent(run.id), null, "the intent is gone with its run");
});

test("deletion refuses a non-terminal run and a mismatched confirmation, and validates ref shape", async () => {
  const registry = new Registry();
  const store = new EnsembleStore(db);
  const manager = new EnsembleManager(registry, store, {});
  const { path } = gitRepo();
  const live = store.createRun(runInsert(decidePlan(2, 2), { repoRoot: path, status: "running", sourceKey: "live" })).run;
  const mismatch = await manager.deleteRun(live.id, "not-it");
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.reason, "mismatch");
  const notTerminal = await manager.deleteRun(live.id, live.id);
  assert.equal(notTerminal.ok, false);
  if (!notTerminal.ok) assert.equal(notTerminal.reason, "not_terminal");

  // A foreign ref an artifact might carry is NOT deleted: generatedRefsFor requires the exact
  // `refs/mission-control/ensembles/<runId>/…` prefix, so a run only ever deletes its own refs.
  const done = store.createRun(runInsert(decidePlan(2, 2), { repoRoot: path, status: "completed", sourceKey: "done" })).run;
  const foreign = "refs/heads/someone-elses-branch";
  const head = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", path, "update-ref", foreign, head]);
  store.recordArtifact(
    { runId: done.id, attemptId: null, kind: "commit", formatVersion: 1, attempt: 1, status: "ready", locator: { ref: foreign, snapshotSha: "x", baseSha: "x" }, digest: "d", metadata: {}, operationKey: `foreign:${done.id}`, readyAt: 1 },
    1,
  );
  await manager.deleteRun(done.id, done.id);
  const survives = execFileSync("git", ["-C", path, "rev-parse", "--verify", "--quiet", foreign], { encoding: "utf8" }).trim();
  assert.equal(survives, head, "a foreign ref an artifact named is never deleted");
});
