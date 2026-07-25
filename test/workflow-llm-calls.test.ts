import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowLlmCall } from "../src/shared/workflow.ts";
import { workflowCallCost } from "../src/web/workflows/run-model.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-llm-calls-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { clearWorkflowTables, WorkflowStore } = await import("../src/server/workflows/store.ts");
const db = openDb();
const store = new WorkflowStore(db);
beforeEach(() => clearWorkflowTables(db));

function call(id: string, costUsd: number | null = null): WorkflowLlmCall {
  return {
    id,
    runId: "run",
    submissionId: "submission",
    nodeAttemptId: null,
    purpose: "context_compaction",
    runner: "codex",
    model: "gpt-test",
    attempt: 1,
    state: "running",
    startedAt: 100,
    finishedAt: null,
    durationMs: null,
    inputBytes: 123,
    outputBytes: 0,
    costUsd,
    errorCode: null,
  };
}

test("workflow model calls record actual identity, bytes, timing, state, and classified error", () => {
  const usageBefore = (db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get() as {
    count: number;
  }).count;
  store.insertLlmCall(call("call-1"));
  assert.equal(store.listLlmCallPage("run", null, 20).items[0]?.state, "running");
  store.finishLlmCall("call-1", "failed", 456, "context_compaction_parse", 175);
  const stored = store.listLlmCallPage("run", null, 20).items[0]!;
  assert.deepEqual(stored, {
    ...call("call-1"),
    state: "failed",
    finishedAt: 175,
    durationMs: 75,
    outputBytes: 456,
    errorCode: "context_compaction_parse",
  });
  assert.equal(stored.costUsd, null);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get() as { count: number }).count,
    usageBefore,
  );
});

test("success, cancellation, restart interruption, and retries remain separate attempts", () => {
  store.insertLlmCall({ ...call("success"), attempt: 1 });
  store.finishLlmCall("success", "succeeded", 64, null, 140);
  store.insertLlmCall({ ...call("cancelled"), attempt: 1, startedAt: 150 });
  store.finishLlmCall("cancelled", "cancelled", 0, "run_cancelled", 155);
  store.insertLlmCall({ ...call("interrupted"), attempt: 1, startedAt: 200 });
  store.interruptRunningLlmCalls("run", 225);
  store.insertLlmCall({ ...call("retry"), attempt: 2, startedAt: 230 });
  store.finishLlmCall("retry", "succeeded", 80, null, 250);

  const calls = store.listLlmCallPage("run", null, 20).items;
  assert.deepEqual(calls.map((item) => ({
    id: item.id,
    attempt: item.attempt,
    state: item.state,
    durationMs: item.durationMs,
    outputBytes: item.outputBytes,
    errorCode: item.errorCode,
  })), [
    {
      id: "success",
      attempt: 1,
      state: "succeeded",
      durationMs: 40,
      outputBytes: 64,
      errorCode: null,
    },
    {
      id: "cancelled",
      attempt: 1,
      state: "cancelled",
      durationMs: 5,
      outputBytes: 0,
      errorCode: "run_cancelled",
    },
    {
      id: "interrupted",
      attempt: 1,
      state: "interrupted",
      durationMs: 25,
      outputBytes: 0,
      errorCode: "daemon_restart",
    },
    {
      id: "retry",
      attempt: 2,
      state: "succeeded",
      durationMs: 20,
      outputBytes: 80,
      errorCode: null,
    },
  ]);
});

test("unknown or incomplete provider cost is unavailable, never zero or estimated", () => {
  const unknown = [{ ...call("unknown"), state: "succeeded" as const }];
  assert.equal(workflowCallCost([], 0, null), null);
  assert.equal(workflowCallCost(unknown, 1, null), null);
  assert.equal(workflowCallCost([{ ...unknown[0]!, costUsd: 0.125 }], 2, "next"), null);
  assert.equal(
    workflowCallCost([
      { ...unknown[0]!, id: "known-1", costUsd: 0.125 },
      { ...unknown[0]!, id: "known-2", costUsd: 0.375 },
    ], 2, null),
    0.5,
  );
});
