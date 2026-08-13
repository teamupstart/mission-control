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
const { ENSEMBLE_HARD_LIMITS, ensemblePayload } = await import("../src/shared/ensemble.ts");
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
    { repoRoot: "/repo", personas: new Map(), now: 1000 },
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

/**
 * A controllable clock, for the tests that need an infrastructure backoff to actually elapse.
 *
 * The default `armTimer` in this file never fires, which is what the pure-restart tests want.
 * Anything mixing restarts with provider failures has to let the retry ladder run, and it has to
 * run in zero real time.
 */
function fastClock(startAt = 10_000) {
  let now = startAt;
  return {
    now: () => now,
    armTimer: (delayMs: number, fire: () => void) => {
      now += delayMs;
      const timer = setTimeout(fire, 0);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  };
}

function makeEngine(
  store: Store,
  gateway: Gateway,
  runModel: (prompt: string) => Promise<string>,
  clock?: { now: () => number; armTimer: (delayMs: number, fire: () => void) => () => void },
): Engine {
  return new EnsembleEngine({
    store,
    tasks: gateway,
    publish: () => {},
    adapters: reviewAdapters(),
    armTimer: clock?.armTimer ?? (() => () => {}),
    ...(clock ? { now: clock.now } : {}),
    review: {
      scheduler: <T>(fn: () => Promise<T>) => fn(),
      resolveExecution: () => ({ runnerId: "claude" as const, modelId: "judge-model", unknownRunner: null }),
      runModel: (_runnerId, prompt) => runModel(prompt),
      guaranteesSchema: (runnerId) => runnerId === "claude",
      timeoutMs: 1000,
    },
  });
}

/** Every review stage attempt of a run, in attempt order. */
function reviewAttempts(store: Store, runId: string) {
  return store
    .listStageAttempts(runId)
    .filter((attempt) => attempt.driverKind === "review")
    .sort((a, b) => a.attempt - b.attempt);
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

test("two restarts in a row still reach a decision, against a budget of two attempts", async () => {
  // The case that killed a real run. The evaluator's budget is 2, and a restart used to be
  // recorded as a failed attempt, so the second daemon exit exhausted a budget that no model had
  // ever answered against - throwing away every candidate the run had already paid for.
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const hang = () => new Promise<string>(() => {});
  const engine1 = makeEngine(store, gateway, hang);
  const run = makeRun(store, bestOfNPlan(3));
  assert.equal(
    run.plan!.stages.find((stage) => stage.driverKind === "review")!.maxAttempts,
    2,
    "the default budget is what makes two restarts fatal",
  );
  await submitMembers(engine1, gateway, store, run.id);
  await waitFor(() => store.listLlmCalls(run.id).some((c) => c.state === "running"));

  // Restart one: a second daemon takes over the same store and also exits mid-comparison.
  const engine2 = makeEngine(store, gateway, hang);
  await engine2.recover(run.id);
  await waitFor(() => store.listLlmCalls(run.id).filter((c) => c.state === "running").length === 1);
  await waitFor(() => reviewAttempts(store, run.id).length === 2);

  // Restart two: the third daemon has a working provider.
  const engine3 = makeEngine(store, gateway, (prompt) => Promise.resolve(validResponse(prompt)));
  await engine3.recover(run.id);
  await waitFor(() => store.getRun(run.id)!.status === "awaiting_decision");

  const attempts = reviewAttempts(store, run.id);
  assert.deepEqual(attempts.map((a) => a.attempt), [1, 2, 3], "attempt numbers stay monotonic");
  assert.deepEqual(
    attempts.map((a) => a.status),
    ["interrupted", "interrupted", "succeeded"],
    "a restart is interrupted, not failed, so it spends none of the budget",
  );
  // Three attempt rows against a budget of two, and the run still decided: the budget counts bad
  // model answers, and across both restarts no model answered at all.
  assert.equal(store.listEvaluations(run.id).filter((e) => e.status === "interrupted").length, 2);
  assert.equal(store.listEvaluations(run.id).filter((e) => e.status === "succeeded").length, 1);
  assert.deepEqual(gateway.cancelled, [], "no candidate was thrown away");
  assert.ok(store.listArtifacts(run.id).every((a) => a.status === "ready"));
});

test("a crash loop cannot spin attempt rows forever", async () => {
  // Not charging a restart is what makes this backstop necessary: a daemon that dies in the same
  // place every time would otherwise open a fresh, free attempt on every boot, forever. The
  // ceiling is the hard limit on a stage's attempts, counted over INTERRUPTIONS - the rows that
  // neither retry budget bounds, and the only counter a run of pure interruptions ever moves.
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const engine = makeEngine(store, gateway, () => new Promise<string>(() => {}));
  const run = makeRun(store, bestOfNPlan(2));
  await submitMembers(engine, gateway, store, run.id);
  await waitFor(() => reviewAttempts(store, run.id).length === 1);

  for (let restart = 0; restart < ENSEMBLE_HARD_LIMITS.maxStageAttempts + 2; restart += 1) {
    if (store.getRun(run.id)!.status === "failed") break;
    await engine.recover(run.id);
  }

  assert.equal(store.getRun(run.id)!.status, "failed");
  assert.equal(
    reviewAttempts(store, run.id).length,
    ENSEMBLE_HARD_LIMITS.maxStageAttempts,
    "the ceiling is on interruptions, and a pure crash loop opens nothing else",
  );
  assert.ok(
    reviewAttempts(store, run.id).every((a) => a.status === "interrupted"),
    "every one of them was an interruption, so the evaluator's own budget was never spent",
  );
  assert.deepEqual(
    reviewAttempts(store, run.id).map((a) => a.attempt),
    Array.from({ length: ENSEMBLE_HARD_LIMITS.maxStageAttempts }, (_, i) => i + 1),
    "and every attempt number is still monotonic and unique",
  );
});

test("restarts before a provider outage still park the run rather than ending it", async () => {
  // The ceiling used to be counted over ROWS, and `maxAttempts` (2) plus the infrastructure
  // budget (3) is exactly the ceiling (5), so a stage had no room to be interrupted at all. Two
  // restarts and then three provider failures is five rows, and the row that spent the last of
  // the infrastructure budget - the row whose whole job is to say "park this for a person" - was
  // also the row that hit the ceiling. The ceiling answered first and the run died on it.
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const run = makeRun(store, bestOfNPlan(2));
  await submitMembers(makeEngine(store, gateway, () => new Promise<string>(() => {})), gateway, store, run.id);
  await waitFor(() => reviewAttempts(store, run.id).length === 1);

  // Two restarts: rows 1 and 2 settle `interrupted`, charged to neither budget.
  await makeEngine(store, gateway, () => new Promise<string>(() => {})).recover(run.id);
  await waitFor(() => reviewAttempts(store, run.id).length === 2);

  // Then the provider goes down for good, and its own budget of 3 runs out on row 5.
  const dead = makeEngine(
    store,
    gateway,
    () => Promise.reject(new Error("provider unreachable")),
    fastClock(),
  );
  await dead.recover(run.id);
  await waitFor(() => reviewAttempts(store, run.id).length === ENSEMBLE_HARD_LIMITS.maxStageAttempts);
  await waitFor(() => reviewAttempts(store, run.id).every((a) => a.status !== "running"));

  const attempts = reviewAttempts(store, run.id);
  assert.deepEqual(
    attempts.map((a) => a.status),
    ["interrupted", "interrupted", "failed", "failed", "failed"],
    "two free interruptions and three charged to infrastructure",
  );
  assert.equal(
    store.getRun(run.id)!.status,
    "evaluating",
    "parked for an operator, not ended: the infrastructure budget is what ran out, and the candidates are intact",
  );
  assert.ok(store.listArtifacts(run.id).every((a) => a.status === "ready"));
});

test("a run that has been interrupted four times can still be rescued by one working call", async () => {
  // The same defect at a different mix, and the one that shows it was never about the sum of the
  // two budgets: four restarts and a single provider blip is five rows with NEITHER budget spent.
  // A ceiling counted over rows ended this run; counted over interruptions, the fifth restart is
  // still the bound and this run simply finishes.
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const run = makeRun(store, bestOfNPlan(2));
  await submitMembers(makeEngine(store, gateway, () => new Promise<string>(() => {})), gateway, store, run.id);
  await waitFor(() => reviewAttempts(store, run.id).length === 1);

  for (let restart = 1; restart < 4; restart += 1) {
    await makeEngine(store, gateway, () => new Promise<string>(() => {})).recover(run.id);
    await waitFor(() => reviewAttempts(store, run.id).length === restart + 1);
  }

  let calls = 0;
  const recovered = makeEngine(
    store,
    gateway,
    (prompt) => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("provider unreachable"))
        : Promise.resolve(validResponse(prompt));
    },
    fastClock(),
  );
  await recovered.recover(run.id);
  await waitFor(() => store.getRun(run.id)!.status === "awaiting_decision");

  const attempts = reviewAttempts(store, run.id);
  assert.deepEqual(
    attempts.map((a) => a.status),
    ["interrupted", "interrupted", "interrupted", "interrupted", "failed", "succeeded"],
    "four interruptions, one blip, and then an answer",
  );
  assert.deepEqual(attempts.map((a) => a.attempt), [1, 2, 3, 4, 5, 6], "attempt numbers stay monotonic");
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
  // The receipt names every evaluation the attempt produced. A comparison produces one; the list
  // is what lets a panel's receipt name each judge's ballot rather than only the first.
  assert.deepEqual(stageAttempt.output, {
    evaluationIds: [evaluation.id],
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
