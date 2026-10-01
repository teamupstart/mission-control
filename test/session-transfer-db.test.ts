import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb, inTransaction } from "../src/server/db.ts";
import { reserveSessionTransfer, updateSessionTransfer, transferForTask, transferForNote, sessionTransferPage, getSessionTransfer, runtimeTransferPredecessors, runtimeTransferConnects, type TransferFacts } from "../src/server/session-transfers/store.ts";

const facts: TransferFacts = { agent: "claude", nativeId: "conversation", sourceName: "Continue work", sourceRuntime: "sdk",
  sourceEpisodeId: null, cwd: "/checkout", repoRoot: "/repo", taskIdentity: null, taskEpisodeId: null, bindings: [],
  leaseRoot: "/private/managed-resumes", leaseId: "lease", backend: null, home: null,
  sourceStopped: false, stopStarted: false, sourceProcess: null, launchAt: null, launchOutcome: "not_started", canEnd: false };
const reserve = (sourceSessionId = "source", noteKey = "note", taskId: string | null = "task") =>
  reserveSessionTransfer({ sourceSessionId, noteKey, taskId, facts });
afterEach(() => openDb().exec("DELETE FROM session_runtime_transfers"));

test("predecessor lookup follows only the latest adopted chain and terminates on cycles", () => {
  const adopt = (source: string, successor: string, time: number) => {
    const row = reserve(source, "note", null);
    updateSessionTransfer(row, { state: "adopted", successorSessionId: successor });
    openDb().prepare("UPDATE session_runtime_transfers SET created_at=? WHERE id=?").run(time, row.id);
  };
  adopt("source", "middle", 1);
  adopt("middle", "target", 2);
  adopt("stranger", "elsewhere", 3);
  assert.deepEqual(new Set(runtimeTransferPredecessors("target", "note")), new Set(["source", "middle", "target"]));
  assert.deepEqual(runtimeTransferPredecessors("target", "another-note"), ["target"]);
  adopt("source", "elsewhere", 4);
  assert.equal(runtimeTransferConnects("source", "target", "note"), false);
  assert.deepEqual(new Set(runtimeTransferPredecessors("target", "note")), new Set(["middle", "target"]));
  adopt("target", "middle", 5);
  assert.deepEqual(new Set(runtimeTransferPredecessors("target", "note")), new Set(["middle", "target"]));
});

test("pre-feature database upgrades twice without changing existing state", () => {
  const db = openDb();
  db.exec("DROP TABLE session_runtime_transfers");
  const before = db.prepare("SELECT * FROM app_config ORDER BY key").all();
  closeDb();
  for (let pass = 0; pass < 2; pass++) {
    assert.deepEqual(openDb().prepare("SELECT * FROM app_config ORDER BY key").all(), before);
    assert.equal(openDb().prepare("SELECT COUNT(*) AS n FROM session_runtime_transfers").get()!.n, 0);
    closeDb();
  }
  assert.equal(openDb().prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='session_runtime_transfers'").get()!.n, 4);
});

test("transactional uniqueness reserves source, conversation and non-null task independently", () => {
  const first = reserve();
  assert.throws(() => reserve("source", "other", "other-task"), /UNIQUE/);
  assert.throws(() => reserve("other", "note", "other-task"), /UNIQUE/);
  assert.throws(() => reserve("other", "other", "task"), /UNIQUE/);
  reserve("taskless-a", "note-a", null); reserve("taskless-b", "note-b", null);
  updateSessionTransfer(first, { state: "adopted", successorSessionId: "terminal" });
  assert.doesNotThrow(() => reserve());
});

test("CAS, rollback and durable references protect a reservation without session or task rows", () => {
  const first = reserve();
  const next = updateSessionTransfer(first, { state: "launching" });
  assert.throws(() => updateSessionTransfer(first, { state: "failed" }), /changed/);
  assert.throws(() => inTransaction(() => { updateSessionTransfer(next, { state: "adopted" }); throw new Error("rollback"); }), /rollback/);
  closeDb();
  assert.equal(transferForTask("task")?.state, "launching");
  assert.equal(transferForNote("note")?.revision, next.revision);
});

test("unknown states stay guarded and paginated snapshots reveal no lease or launch secrets", () => {
  const first = reserve();
  updateSessionTransfer(first, { state: "future_phase", reason: "x".repeat(1000) });
  for (let index = 0; index < 104; index++) reserve(`source-${index}`, `note-${index}`, null);
  assert.equal(getSessionTransfer(first.id)?.reason.length, 500);
  assert.ok(transferForTask("task"));
  const page = sessionTransferPage();
  assert.equal(page.transfers.length, 100); assert.equal(page.overflow, 5);
  const remainder = sessionTransferPage(100); assert.equal(remainder.transfers.length, 5); assert.equal(remainder.overflow, 0);
  const all = [...page.transfers, ...remainder.transfers];
  const unknown = all.find((row) => row.id === first.id)!;
  assert.equal(unknown.state, "recovery_required"); assert.equal(unknown.canEnd, false);
  assert.doesNotMatch(JSON.stringify(all), /private|managed-resumes|leaseId|nativeId|launchStateHome|conversation/);
  assert.equal(new Set(all.map((row) => row.id)).size, 105);
});
