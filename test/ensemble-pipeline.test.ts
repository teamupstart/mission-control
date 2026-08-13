// What is at stake: the run explaining itself in operator words. A strategy may change its
// compiled stage ids and driver keys without turning the run header back into schema text, and a
// parked barrier must say what it is waiting for instead of merely saying "waiting".
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompiledEnsemblePlan, EnsembleStageAttempt } from "../src/shared/ensemble.ts";
import { bestOfNStrategy } from "../src/server/ensembles/strategies/best-of-n.ts";
import { consensusStrategy } from "../src/server/ensembles/strategies/consensus.ts";
import { panelVoteStrategy } from "../src/server/ensembles/strategies/panel-vote.ts";
import { projectEnsemblePipeline } from "../src/web/ensembles/pipeline.ts";

const context = { repoRoot: "/repo", personas: new Map(), now: 1000 };

function compile(
  descriptor: typeof bestOfNStrategy | typeof consensusStrategy | typeof panelVoteStrategy,
): CompiledEnsemblePlan {
  const result = descriptor.compile({}, context);
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.issues));
  if (!result.ok) throw new Error("unreachable");
  return result.plan;
}

function summary(
  plan: CompiledEnsemblePlan,
  over: Partial<{
    launchedMembers: number;
    maxMembers: number;
    readyArtifacts: number;
    membersNeedingInput: number;
  }> = {},
) {
  return {
    launchedMembers: plan.roles.length,
    maxMembers: plan.budget.maxMembers,
    readyArtifacts: 0,
    membersNeedingInput: 0,
    ...over,
  };
}

function attempt(
  stageId: string,
  status: EnsembleStageAttempt["status"],
  n = 1,
  output: EnsembleStageAttempt["output"] = null,
): EnsembleStageAttempt {
  return {
    id: `${stageId}-${n}`,
    runId: "run-1",
    stageId,
    driverKind: null,
    driverKey: null,
    attempt: n,
    commandKey: `command-${stageId}-${n}`,
    status,
    input: {},
    output,
    error: null,
    createdAt: 1000,
    updatedAt: 1000 + n,
    startedAt: 1000,
    finishedAt: status === "running" || status === "waiting" ? null : 1000 + n,
  };
}

/** A failed review attempt's receipt: which budget it spent, and whether a retry is owed. */
function receipt(charge: "model" | "infrastructure", retryAt: number | null = null) {
  return { charge, kind: charge === "model" ? "invalid_output" : "infrastructure", retryAt };
}

test("all three shipped strategy plans project to the shared operator vocabulary", () => {
  for (const descriptor of [bestOfNStrategy, consensusStrategy, panelVoteStrategy]) {
    const plan = compile(descriptor);
    const view = projectEnsemblePipeline({
      run: { status: "running", activeStageId: plan.stages[0]!.id, plan },
      summary: summary(plan),
      stageAttempts: [],
      memberCount: plan.roles.length,
    });
    assert.deepEqual(
      view.steps.map((step) => step.label),
      ["Launch", "Work", "Review", "Decide", "Promote"],
    );
  }
});

test("a member barrier names the exact submissions still needed", () => {
  const plan = compile(bestOfNStrategy);
  const review = plan.stages.find((stage) => stage.driverKind === "review")!;
  const view = projectEnsemblePipeline({
    run: { status: "waiting", activeStageId: review.id, plan },
    summary: summary(plan, { readyArtifacts: 1, membersNeedingInput: 1 }),
    stageAttempts: [attempt(review.id, "waiting")],
    memberCount: plan.roles.length,
  });
  assert.equal(view.barrier, "waiting for 1 more submission");
  assert.equal(view.steps.find((step) => step.id === review.id)?.state, "active");
});

test("a human decision stage says it is waiting on you", () => {
  const plan = compile(panelVoteStrategy);
  const decision = plan.stages.find((stage) => stage.driverKind === "decision")!;
  const view = projectEnsemblePipeline({
    run: { status: "awaiting_decision", activeStageId: decision.id, plan },
    summary: summary(plan, { readyArtifacts: plan.roles.length }),
    stageAttempts: [],
    memberCount: plan.roles.length,
  });
  assert.equal(view.barrier, "waiting on you");
  assert.equal(view.steps.find((step) => step.id === decision.id)?.detail, "waiting on you");
});

test("terminal runs never leave stale active-stage evidence active", () => {
  const plan = compile(consensusStrategy);
  const active = plan.stages[1]!;
  for (const status of ["failed", "cancelled"] as const) {
    const view = projectEnsemblePipeline({
      run: { status, activeStageId: active.id, plan },
      summary: summary(plan),
      stageAttempts: [attempt(active.id, status === "failed" ? "running" : "waiting")],
      memberCount: plan.roles.length,
    });
    assert.equal(view.steps.find((step) => step.id === active.id)?.state, "failed");
    assert.ok(view.steps.every((step) => step.state !== "active"));
  }
});

test("an unreadable run never projects stale evidence as active work", () => {
  const plan = compile(consensusStrategy);
  const active = plan.stages[1]!;
  const view = projectEnsemblePipeline({
    run: { status: null, activeStageId: active.id, plan },
    summary: summary(plan, {
      launchedMembers: 1,
      readyArtifacts: 1,
      membersNeedingInput: 1,
    }),
    stageAttempts: [attempt(active.id, "running")],
    memberCount: plan.roles.length,
  });
  assert.deepEqual(view, { steps: [], barrier: null });
});

test("the review counter counts the budget it spent, never the attempt row it is on", () => {
  const plan = compile(bestOfNStrategy);
  const review = plan.stages.find((stage) => stage.driverKind === "review")!;
  assert.equal(review.maxAttempts, 2);
  const view = projectEnsemblePipeline({
    run: { status: "evaluating", activeStageId: review.id, plan },
    summary: summary(plan, { readyArtifacts: plan.roles.length }),
    // Two restarts and a provider blip, then the live attempt. The row number is 4; the number of
    // times a model has been given the chance to answer badly is one.
    stageAttempts: [
      attempt(review.id, "interrupted", 1),
      attempt(review.id, "interrupted", 2),
      attempt(review.id, "failed", 3, receipt("infrastructure", 5000)),
      attempt(review.id, "running", 4),
    ],
    memberCount: plan.roles.length,
  });
  const step = view.steps.find((s) => s.id === review.id)!;
  assert.equal(step.state, "active");
  assert.equal(step.detail, "attempt 1 of 2", "attempt 4 of 2 is not a sentence about a budget");
});

test("a spent evaluator attempt does count, and a retry that is owed says so", () => {
  const plan = compile(bestOfNStrategy);
  const review = plan.stages.find((stage) => stage.driverKind === "review")!;
  const spent = attempt(review.id, "failed", 1, receipt("model"));

  const live = projectEnsemblePipeline({
    run: { status: "evaluating", activeStageId: review.id, plan },
    summary: summary(plan, { readyArtifacts: plan.roles.length }),
    stageAttempts: [spent, attempt(review.id, "running", 2)],
    memberCount: plan.roles.length,
  });
  assert.equal(live.steps.find((s) => s.id === review.id)?.detail, "attempt 2 of 2");

  // An infrastructure failure that still owes a backoff is a stage between attempts, not a dead
  // one: it stays active, and says why the operator is looking at a pause.
  const waiting = projectEnsemblePipeline({
    run: { status: "evaluating", activeStageId: review.id, plan },
    summary: summary(plan, { readyArtifacts: plan.roles.length }),
    stageAttempts: [attempt(review.id, "failed", 1, receipt("infrastructure", 5000))],
    memberCount: plan.roles.length,
  });
  const step = waiting.steps.find((s) => s.id === review.id)!;
  assert.equal(step.state, "active");
  assert.equal(step.detail, "attempt 1 of 2 · retrying after an infrastructure error");
});

test("a review with no retry left to come is blocked, which is not failed", () => {
  const plan = compile(bestOfNStrategy);
  const review = plan.stages.find((stage) => stage.driverKind === "review")!;
  // `retryAt` null on an infrastructure charge is exactly how the engine records "I have stopped
  // retrying and am waiting for a person". The run is NOT terminal here, every artifact is still
  // ready, and one press starts the next attempt - so drawing this the same as a dead run would
  // tell the operator their work is gone at the moment it is intact and waiting for them.
  const blocked = [
    attempt(review.id, "failed", 1, receipt("infrastructure", 2000)),
    attempt(review.id, "failed", 2, receipt("infrastructure", 5000)),
    attempt(review.id, "failed", 3, receipt("infrastructure", null)),
  ];
  const view = projectEnsemblePipeline({
    run: { status: "evaluating", activeStageId: review.id, plan },
    summary: summary(plan, { readyArtifacts: plan.roles.length }),
    stageAttempts: blocked,
    memberCount: plan.roles.length,
  });
  const step = view.steps.find((s) => s.id === review.id)!;
  assert.equal(step.state, "blocked");
  assert.equal(
    step.detail,
    "attempt 1 of 2 · paused after 3 infrastructure errors",
    "a blocked step says what it is waiting for, and that no evaluator attempt was spent",
  );

  // The same rows on a run that really did end are drawn as the failure they are: `blocked` is a
  // statement about a run that can still be resumed, and a terminal run cannot be.
  const terminal = projectEnsemblePipeline({
    run: { status: "failed", activeStageId: review.id, plan },
    summary: summary(plan, { readyArtifacts: plan.roles.length }),
    stageAttempts: blocked,
    memberCount: plan.roles.length,
  });
  assert.equal(terminal.steps.find((s) => s.id === review.id)?.state, "failed");
});

test("a parked review stays parked when the retry it granted is interrupted", () => {
  // The engine keeps a stage `blocked` from the whole history - once the infrastructure budget is
  // spent it will not re-drive the stage at all. Reading that from the NEWEST row alone said the
  // opposite: press Retry stage, let a restart interrupt the attempt it granted, and the newest
  // row is `interrupted`, which the projection took as "a retry is coming" and drew as a live
  // attempt. Nothing was coming. The run sat parked with no amber, no reason, and - because the
  // Retry button also hides for an interrupted row - nothing on screen to press.
  const plan = compile(bestOfNStrategy);
  const review = plan.stages.find((stage) => stage.driverKind === "review")!;
  const view = projectEnsemblePipeline({
    run: { status: "evaluating", activeStageId: review.id, plan },
    summary: summary(plan, { readyArtifacts: plan.roles.length }),
    stageAttempts: [
      attempt(review.id, "failed", 1, receipt("infrastructure", 2000)),
      attempt(review.id, "failed", 2, receipt("infrastructure", 5000)),
      attempt(review.id, "failed", 3, receipt("infrastructure", null)),
      // The operator pressed the door, and a daemon restart interrupted what it granted.
      attempt(review.id, "interrupted", 4),
    ],
    memberCount: plan.roles.length,
  });
  const step = view.steps.find((s) => s.id === review.id)!;
  assert.equal(step.state, "blocked", "an interruption does not un-park a stage the engine parks");
  assert.equal(
    step.detail,
    "attempt 1 of 2 · paused after 3 infrastructure errors",
    "and the line that explains why nothing is moving has to survive it",
  );

  // The same rows with the infrastructure budget NOT spent are the case the newest row does
  // decide: the engine re-drives an interruption, so the stage really is between attempts.
  const retrying = projectEnsemblePipeline({
    run: { status: "evaluating", activeStageId: review.id, plan },
    summary: summary(plan, { readyArtifacts: plan.roles.length }),
    stageAttempts: [
      attempt(review.id, "failed", 1, receipt("infrastructure", 2000)),
      attempt(review.id, "interrupted", 2),
    ],
    memberCount: plan.roles.length,
  });
  assert.equal(retrying.steps.find((s) => s.id === review.id)?.state, "active");
});

test("terminal runs keep the full walked pipeline visible", () => {
  const plan = compile(consensusStrategy);
  const view = projectEnsemblePipeline({
    run: { status: "completed", activeStageId: null, plan },
    summary: summary(plan, { readyArtifacts: plan.roles.length }),
    stageAttempts: plan.stages.map((stage) => attempt(stage.id, "succeeded")),
    memberCount: plan.roles.length,
  });
  assert.equal(view.steps.length, plan.stages.length + 1);
  assert.ok(view.steps.every((step) => step.state === "complete"));
});
