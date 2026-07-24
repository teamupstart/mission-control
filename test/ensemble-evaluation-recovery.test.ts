import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: a comparison is a long provider call, and a daemon that exits in the middle of
 * one leaves a running evaluation and a running call whose child nobody can read. The contract is
 * that recovery turns those into `interrupted` - retryable, never `failed`, because no malformed
 * answer was seen - and re-runs the comparison against the SAME immutable subjects and snapshot
 * guidance, reproducing the exact input fingerprint. It must never reinterpret the run with today's
 * Best-of-N defaults or a Persona's current text, and it must leave a comparison that already
 * completed untouched. Every effect is derived from SQLite plus current Task state.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-eval-recovery-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { EnsembleEngine } = await import("../src/server/ensembles/engine.ts");
const { bestOfNStrategy } = await import("../src/server/ensembles/strategies/best-of-n.ts");
const { ensemblePayload } = await import("../src/shared/ensemble.ts");
const { FakeGateway, ARTIFACT_ADAPTERS, fakeSha, runInsert } = await import("./ensemble-fixture.ts");
type CompiledEnsemblePlan = import("../src/shared/ensemble.ts").CompiledEnsemblePlan;

type Engine = InstanceType<typeof EnsembleEngine>;
type Gateway = InstanceType<typeof FakeGateway>;
type Store = InstanceType<typeof EnsembleStore>;

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

function bestOfNPlan(count: number): CompiledEnsemblePlan {
  const result = bestOfNStrategy.compile(
    { members: Array.from({ length: count }, () => ({})), evaluator: {} },
    { repoRoot: "/repo", persona: null, now: 1000 },
  );
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.issues)}`);
  return result.plan;
}

let sourceCounter = 0;
function makeRun(store: Store, plan: CompiledEnsemblePlan) {
  return store.createRun(runInsert(plan, { sourceKey: `recovery-test:${(sourceCounter += 1)}` })).run;
}

function reviewAdapters() {
  const commit = {
    kind: "commit" as const,
    formatVersion: 1,
    async capture(input: { runId: string; artifactId: string; baseSha: string }) {
      const ref = `refs/mission-control/ensembles/${input.runId}/${input.artifactId}`;
      const snapshotSha = fakeSha(`snap:${input.artifactId}`);
      const treeSha = fakeSha(`tree:${input.artifactId}`);
      return {
        locator: { kind: "git_snapshot", formatVersion: 1, ref, snapshotSha, baseSha: input.baseSha, parentSha: input.baseSha, treeSha },
        fingerprint: treeSha,
        observed: { ref, snapshotSha, treeSha, filesChanged: 1, insertions: 2, deletions: 0, binaryFiles: 0, dirty: false, patchTruncated: false, patchOmittedBytes: 0 },
      };
    },
    async recover() {
      return null;
    },
    async materialize() {
      return {
        files: [{ path: "src/app.ts", oldPath: null, insertions: 2, deletions: 0, binary: false }],
        filesChanged: 1,
        insertions: 2,
        deletions: 0,
        patch: "diff --git a/src/app.ts b/src/app.ts\n@@\n+one\n+two\n",
        truncated: false,
        omittedBytes: 0,
      };
    },
    async verify() {
      return true;
    },
    async restore() {},
  };
  return { ...ARTIFACT_ADAPTERS, commit } as never;
}

function validResponse(prompt: string): string {
  const line = prompt.match(/Rank exactly these submissions, each once: (.+)\./);
  const labels = line ? line[1]!.split(", ").map((s) => s.trim()) : [];
  return JSON.stringify({
    recommendation: labels[0],
    comparison: "compared",
    caveats: [],
    subjects: labels.map((label, index) => ({
      label,
      score: 90 - index * 10,
      rank: index + 1,
      strengths: ["a"],
      risks: ["b"],
      rationale: "r",
      confidence: 0.7,
    })),
  });
}

function makeEngine(
  store: Store,
  gateway: Gateway,
  runModel: (prompt: string) => Promise<string>,
): Engine {
  return new EnsembleEngine({
    store,
    tasks: gateway,
    publish: () => {},
    adapters: reviewAdapters(),
    armTimer: () => () => {},
    review: {
      scheduler: <T>(fn: () => Promise<T>) => fn(),
      resolveExecution: () => ({ runnerId: "claude" as const, modelId: "judge-model", unknownRunner: null }),
      runModel: (_runnerId, prompt) => runModel(prompt),
      timeoutMs: 1000,
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Launch and submit every member. Does NOT wait for the review to settle. */
async function submitMembers(engine: Engine, gateway: Gateway, store: Store, runId: string): Promise<void> {
  await engine.launch(runId);
  for (const dispatch of [...gateway.dispatched]) {
    const memberId = store.listAttempts(runId).find((a) => a.taskId === dispatch.taskId)!.memberId;
    gateway.running(dispatch.taskId, `/wt/${dispatch.taskId}`);
    await engine.wake(runId);
    await engine.submit({
      runId,
      memberId,
      claims: { summary: "work", checks: [], testEvidence: null },
      source: "mcp",
      requireWorktree: `/wt/${dispatch.taskId}`,
    });
  }
}

test("a comparison interrupted by a restart recovers and retries with the same immutable inputs", async () => {
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  // Engine one hangs inside the provider call, standing in for a daemon that exited mid-comparison.
  const engine1 = makeEngine(store, gateway, () => new Promise<string>(() => {}));
  const run = makeRun(store, bestOfNPlan(3));
  await submitMembers(engine1, gateway, store, run.id);

  // The comparison is in flight: a running stage attempt, a running evaluation, a running call.
  await waitFor(() => store.listLlmCalls(run.id).some((c) => c.state === "running"));
  const interruptedEval = store.listEvaluations(run.id).find((e) => e.status === "running")!;
  assert.ok(interruptedEval, "an evaluation was opened before the provider call");
  const fingerprintBefore = interruptedEval.inputFingerprint;
  const subjectsBefore = [...interruptedEval.subjectArtifactIds];
  assert.equal(store.getRun(run.id)!.status, "evaluating");

  // Engine two takes over the same store with a working model and recovers.
  const engine2 = makeEngine(store, gateway, (prompt) => Promise.resolve(validResponse(prompt)));
  await engine2.recover(run.id);
  await waitFor(() => store.getRun(run.id)!.status === "awaiting_decision");

  // The interrupted evaluation is `interrupted`, not `failed`, and its call is `interrupted`.
  const afterEvals = store.listEvaluations(run.id);
  const revived = afterEvals.find((e) => e.id === interruptedEval.id)!;
  assert.equal(revived.status, "interrupted");
  assert.equal(
    store.listLlmCalls(run.id).find((c) => c.evaluationId === interruptedEval.id)!.state,
    "interrupted",
  );

  // The retry produced a fresh, succeeded evaluation over the SAME immutable subjects and the SAME
  // input fingerprint - the exact same evidence, judged again.
  const succeeded = afterEvals.find((e) => e.status === "succeeded")!;
  assert.ok(succeeded, "the bounded retry produced a succeeded evaluation");
  assert.notEqual(succeeded.id, interruptedEval.id);
  assert.equal(succeeded.inputFingerprint, fingerprintBefore, "the retry judged the same packet");
  assert.deepEqual([...succeeded.subjectArtifactIds], subjectsBefore, "the subject set is unchanged");

  // No member Task was reaped by the recovery, and every artifact is still ready.
  assert.deepEqual(gateway.cancelled, []);
  assert.ok(store.listArtifacts(run.id).every((a) => a.status === "ready"));
});

test("recovery completes a running review stage from its succeeded evaluation", async () => {
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const engine1 = makeEngine(store, gateway, () => new Promise<string>(() => {}));
  const run = makeRun(store, bestOfNPlan(2));
  await submitMembers(engine1, gateway, store, run.id);
  await waitFor(() => store.listLlmCalls(run.id).some((call) => call.state === "running"));

  const evaluation = store.listEvaluations(run.id)[0]!;
  const call = store.listLlmCalls(run.id)[0]!;
  const [recommendedArtifactId, otherArtifactId] = evaluation.subjectArtifactIds;
  assert.ok(recommendedArtifactId && otherArtifactId);
  const finishedAt = call.startedAt + 10;
  store.finishLlmCall(call.id, ["running"], "succeeded", {
    finishedAt,
    durationMs: 10,
    inputBytes: 100,
    outputBytes: 100,
    costUsd: null,
    errorCode: null,
  });
  store.finishEvaluation(
    evaluation.id,
    ["running"],
    "succeeded",
    {
      result: ensemblePayload({
        version: 1,
        recommendedArtifactId,
        comparison: "compared",
        caveats: [],
        scorecards: [
          {
            artifactId: recommendedArtifactId,
            score: 90,
            rank: 1,
            strengths: ["a"],
            risks: ["b"],
            rationale: "r",
            confidence: 0.8,
          },
          {
            artifactId: otherArtifactId,
            score: 80,
            rank: 2,
            strengths: ["a"],
            risks: ["b"],
            rationale: "r",
            confidence: 0.7,
          },
        ],
        evidenceTruncated: false,
      }),
    },
    finishedAt,
  );

  let modelCalls = 0;
  const engine2 = makeEngine(store, gateway, async (prompt) => {
    modelCalls += 1;
    return validResponse(prompt);
  });
  await engine2.recover(run.id);

  assert.equal(store.getRun(run.id)!.status, "awaiting_decision");
  assert.equal(modelCalls, 0, "the completed comparison was not run again");
  assert.equal(store.listEvaluations(run.id).length, 1);
  assert.equal(store.listEvaluations(run.id)[0]!.status, "succeeded");
  assert.equal(store.listLlmCalls(run.id)[0]!.state, "succeeded");
  const stageAttempt = store.listStageAttempts(run.id).find((attempt) => attempt.driverKind === "review")!;
  assert.equal(stageAttempt.status, "succeeded");
  assert.deepEqual(stageAttempt.output, {
    evaluationId: evaluation.id,
    resultLabel: "recommends Submission A",
  });
});

test("a comparison that already completed is left untouched by recovery", async () => {
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const engine = makeEngine(store, gateway, (prompt) => Promise.resolve(validResponse(prompt)));
  const run = makeRun(store, bestOfNPlan(2));
  await submitMembers(engine, gateway, store, run.id);
  await waitFor(() => store.getRun(run.id)!.status === "awaiting_decision");

  const evalBefore = store.listEvaluations(run.id)[0]!;
  const callsBefore = store.listLlmCalls(run.id).map((c) => ({ id: c.id, state: c.state }));
  assert.equal(evalBefore.status, "succeeded");

  // A restart while parked at the human boundary must not re-run or disturb the finished comparison.
  const engine2 = makeEngine(store, gateway, (prompt) => Promise.resolve(validResponse(prompt)));
  await engine2.recover(run.id);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store.getRun(run.id)!.status, "awaiting_decision");
  const evalAfter = store.listEvaluations(run.id);
  assert.equal(evalAfter.length, 1, "no second evaluation was created");
  assert.equal(evalAfter[0]!.status, "succeeded");
  assert.equal(evalAfter[0]!.inputFingerprint, evalBefore.inputFingerprint);
  assert.deepEqual(
    store.listLlmCalls(run.id).map((c) => ({ id: c.id, state: c.state })),
    callsBefore,
    "completed call rows are preserved exactly",
  );
});
