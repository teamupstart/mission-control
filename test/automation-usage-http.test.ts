import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { QueueManager } from "../src/server/queue.ts";

// The status code this route returns IS the durability contract.
//
// The Foreman worker never opens the database, so a completed run reaches the ledger only
// through here - and the worker reads any 2xx as proof the spend landed, then erases its
// own durable copy. That makes an over-generous acknowledgement indistinguishable from
// deleting an already-paid-for run: the tokens are spent, the row was never written, and
// nothing on the machine still knows the run happened.
//
// So the route has to separate "there was nothing to record" from "I could not record
// this". Only the first may be acknowledged.

const home = mkdtempSync(join(tmpdir(), "mission-automation-http-"));
process.env.HARNESS_HOME = home;
const { buildApp } = await import("../src/server/routes.ts");

after(() => rmSync(home, { recursive: true, force: true }));

let recomputed = 0;
const registry = {
  applyAutomationUsage: () => {
    recomputed++;
  },
} as unknown as Registry;

const app = buildApp(
  registry,
  {} as unknown as ReviewManager,
  {} as unknown as TaskManager,
  {} as unknown as QueueManager,
);

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

async function post(body: unknown): Promise<Response> {
  return await app.request("/api/usage/automation", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "foreman:review",
    runner: "codex",
    runId: "http-run-1",
    ts: 1_700_000_000_000,
    models: [{
      modelId: "gpt-5.6-terra",
      input: 1_000,
      output: 100,
      reasoningOutput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reportedCostUsd: null,
    }],
    ...over,
  };
}

test("a recordable report is acknowledged and refreshes the strip", async () => {
  const before = recomputed;
  const res = await post(report());
  assert.equal(res.status, 204);
  assert.equal(recomputed, before + 1);
});

test("a runner this daemon cannot value is REFUSED, not acknowledged", async () => {
  // The rolling-upgrade case from the daemon's side: a worker newer than this build names a
  // runner it has no pricing for. Answering 204 would have the worker delete its durable
  // copy of a run that never became a ledger row. A 4xx sends it to the worker's quarantine
  // instead, where it survives until the daemon catches up.
  const before = recomputed;
  const res = await post(report({ runner: "some-future-runner", runId: "http-run-future" }));
  assert.equal(res.status, 422);
  const body = (await res.json()) as { error?: string };
  assert.match(String(body.error), /unknown runner/);
  assert.equal(recomputed, before, "and nothing was recomputed for a row that was never written");
});

test("a report with no usage at all is acknowledged rather than refused", async () => {
  // The other half. A zero-token run has no spend to lose, so refusing it would make the
  // worker hold it for a recovery with nothing to recover. Acknowledging is correct here
  // precisely because nothing is at stake.
  const res = await post(report({
    runId: "http-run-empty",
    models: [{
      modelId: "gpt-5.6-terra",
      input: 0,
      output: 0,
      reasoningOutput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reportedCostUsd: null,
    }],
  }));
  assert.equal(res.status, 204);
});

test("a malformed body is rejected at the boundary", async () => {
  // Unchanged by this work, asserted so the schema stays the first gate: a body that never
  // validates must not reach the ledger writer at all.
  const res = await post({ role: "not-a-role", runner: "codex", runId: "x", ts: 1, models: [] });
  assert.equal(res.status, 400);
});
