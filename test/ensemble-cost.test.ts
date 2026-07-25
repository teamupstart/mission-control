import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sumAgentCost,
  readArtifactAgentCost,
  aggregateEnsembleAgentCost,
} from "../src/shared/ensemble.ts";

/**
 * What is at stake: an ensemble spends real money across several agents, and the dashboard must
 * report that honestly. The two failures this rules out are symmetrical: fabricating a cost a runner
 * never reported (a $0.00 that reads as "free"), and folding the evaluator's own model cost into the
 * candidates' agent cost. Member agent cost is captured ONCE, at the submission observation boundary,
 * and frozen into the immutable artifact so it survives the session exiting; unknown stays unknown;
 * a resubmission never double-counts; and the aggregate keeps "nobody reported" distinct from "zero".
 */

// ---- pure aggregation ----

test("sumAgentCost keeps unknown distinct from zero", () => {
  assert.deepEqual(sumAgentCost([]), { totalUsd: null, known: 0, unknown: 0 });
  assert.deepEqual(sumAgentCost([null, null]), { totalUsd: null, known: 0, unknown: 2 }, "all-unknown stays null, never 0");
  assert.deepEqual(sumAgentCost([0.1, 0.2]), { totalUsd: 0.1 + 0.2, known: 2, unknown: 0 });
  assert.deepEqual(sumAgentCost([0.5, null]), { totalUsd: 0.5, known: 1, unknown: 1 }, "a partial total reports what it left out");
  // A real zero (the runner reported exactly 0) is known, not unknown.
  assert.deepEqual(sumAgentCost([0]), { totalUsd: 0, known: 1, unknown: 0 });
});

test("readArtifactAgentCost reads the frozen figure and treats anything else as unknown", () => {
  assert.equal(readArtifactAgentCost({ agentCostUsd: 1.25 }), 1.25);
  assert.equal(readArtifactAgentCost({ agentCostUsd: null }), null);
  assert.equal(readArtifactAgentCost({}), null);
  assert.equal(readArtifactAgentCost(null), null);
  assert.equal(readArtifactAgentCost("nope"), null);
  assert.equal(readArtifactAgentCost({ agentCostUsd: "1.0" }), null, "a stringified number is not a cost");
});

test("aggregateEnsembleAgentCost attributes per member and never double-counts a resubmission", () => {
  const attempts = [
    { id: "att-1", memberId: "m-1" },
    { id: "att-2", memberId: "m-2" },
  ];
  const artifacts = [
    { attemptId: "att-1", kind: "commit" as const, status: "ready" as const, attempt: 1, metadata: { agentCostUsd: 0.1 } },
    // m-1 resubmitted: a later attempt supersedes the earlier one, so its cost replaces, not adds.
    { attemptId: "att-1", kind: "commit" as const, status: "ready" as const, attempt: 2, metadata: { agentCostUsd: 0.3 } },
    { attemptId: "att-2", kind: "commit" as const, status: "ready" as const, attempt: 1, metadata: { agentCostUsd: null } },
    // A non-ready or non-commit artifact contributes nothing.
    { attemptId: "att-2", kind: "summary" as const, status: "ready" as const, attempt: 1, metadata: { agentCostUsd: 99 } },
  ];
  const cost = aggregateEnsembleAgentCost(attempts, artifacts);
  assert.deepEqual(cost, { totalUsd: 0.3, known: 1, unknown: 1 }, "m-1's latest cost only, m-2 unknown");
});

// ---- capture at the submission boundary ----

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-cost-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { EnsembleEngine } = await import("../src/server/ensembles/engine.ts");
const { FakeGateway, stubAdapters, singleWavePlan, runInsert } = await import("./ensemble-fixture.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

async function launchAndSubmit(costs: (number | null)[]): Promise<{ store: InstanceType<typeof EnsembleStore>; runId: string }> {
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const engine = new EnsembleEngine({ store, tasks: gateway, publish: () => {}, armTimer: () => () => {}, adapters: stubAdapters() });
  const run = store.createRun(runInsert(singleWavePlan(costs.length), { sourceKey: `cost:${costs.join(",")}` })).run;
  await engine.launch(run.id);
  const dispatched = [...gateway.dispatched];
  for (let i = 0; i < dispatched.length; i++) {
    const taskId = dispatched[i]!.taskId;
    const attempt = store.listAttempts(run.id).find((a) => a.taskId === taskId)!;
    gateway.running(taskId, `/wt/${taskId}`);
    gateway.setCost(taskId, costs[i]!);
    await engine.wake(run.id);
    await engine.submit({ runId: run.id, memberId: attempt.memberId, claims: { summary: `w${i}`, checks: [], testEvidence: null }, source: "mcp", requireWorktree: `/wt/${taskId}` });
  }
  return { store, runId: run.id };
}

test("each member's session cost is frozen into its immutable artifact at submission", async () => {
  const { store, runId } = await launchAndSubmit([0.42, 0.08, null]);
  const ready = store.listArtifacts(runId).filter((a) => a.status === "ready");
  const costs = ready.map((a) => readArtifactAgentCost(a.metadata)).sort((x, y) => (x ?? -1) - (y ?? -1));
  assert.deepEqual(costs, [null, 0.08, 0.42], "the third member reported no cost - it stays null, not 0");

  const aggregate = aggregateEnsembleAgentCost(store.listAttempts(runId), store.listArtifacts(runId));
  assert.equal(aggregate.known, 2);
  assert.equal(aggregate.unknown, 1);
  assert.ok(Math.abs((aggregate.totalUsd ?? 0) - 0.5) < 1e-9, "the total sums only the reported members");
});

test("a run whose members all report no cost aggregates to unknown, never zero", async () => {
  const { store, runId } = await launchAndSubmit([null, null]);
  const aggregate = aggregateEnsembleAgentCost(store.listAttempts(runId), store.listArtifacts(runId));
  assert.deepEqual(aggregate, { totalUsd: null, known: 0, unknown: 2 });
});
