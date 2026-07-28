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
    output: null,
    error: null,
    createdAt: 1000,
    updatedAt: 1000 + n,
    startedAt: 1000,
    finishedAt: status === "running" || status === "waiting" ? null : 1000 + n,
  };
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
