import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ENSEMBLE_ARTIFACT_KINDS,
  ENSEMBLE_DRIVER_KEYS,
  ENSEMBLE_HARD_LIMITS,
  ENSEMBLE_MEMBER_STATUSES,
  ENSEMBLE_PAYLOAD_VERSION,
  ENSEMBLE_PLAN_VERSION,
  ENSEMBLE_SOURCE_KINDS,
  ENSEMBLE_STATUSES,
  ENSEMBLE_STRATEGY_IDS,
  ENSEMBLE_TERMINAL_STATUSES,
  ensembleIsRunnable,
  ensembleNeedsAttention,
  ensembleStrategyKey,
  knownDriverKey,
  missingDriverKeys,
  parseEnsembleStrategyKey,
  readEnsembleEnum,
  type CompiledEnsemblePlan,
  type EnsembleRun,
  type EnsembleSummary,
} from "../src/shared/ensemble.ts";
import {
  CompiledEnsemblePlanSchema,
  EnsembleActionSchema,
  EnsembleCreateInputSchema,
  EnsembleEventSchema,
  EnsemblePayloadEnvelopeSchema,
  EnsembleRunDetailSchema,
  EnsembleSummarySchema,
} from "../src/shared/protocol.ts";

/**
 * What is at stake: every id and status in `@shared/ensemble.ts` is written into an
 * operator's SQLite file, so these tuples are a wire format with a spelling that cannot
 * change. The two failures pinned here are both silent:
 *
 *  1. Renaming or reordering a persisted id orphans every row written under the old
 *     spelling - the run stops matching anything registered and becomes one nobody can
 *     execute, cancel or explain, with no error anywhere.
 *  2. A plan schema that accepted a structurally broken plan would produce a run that
 *     blocks forever at a barrier nothing can satisfy, and only at runtime, after N agents
 *     have already been launched.
 */

// ---- append-only ids ----

test("the persisted id tuples are exactly what has shipped", () => {
  // Not a tautology: this is the list a future change has to consciously edit, and appending
  // is the only edit that keeps an operator's existing rows readable.
  assert.deepEqual([...ENSEMBLE_STRATEGY_IDS], ["best_of_n"]);
  assert.deepEqual([...ENSEMBLE_SOURCE_KINDS], ["manual"]);
  assert.deepEqual(
    [...ENSEMBLE_ARTIFACT_KINDS],
    ["patch", "commit", "branch", "worktree", "summary", "test_report", "evaluation"],
  );
  assert.deepEqual(
    [...ENSEMBLE_DRIVER_KEYS],
    [
      "member_wave@1",
      "artifact_barrier@1",
      "comparative_review@1",
      "human_decision@1",
      "select_one_finalize@1",
    ],
  );
});

test("every driver key is versioned, so a new behaviour is a new key rather than a redefinition", () => {
  for (const key of ENSEMBLE_DRIVER_KEYS) {
    const parsed = parseEnsembleStrategyKey(key);
    assert.ok(parsed, `${key} is not id@version`);
    assert.ok(parsed.version >= 1);
  }
});

test("terminal statuses are derived from the status tuple, not a second hand-kept list", () => {
  assert.deepEqual([...ENSEMBLE_TERMINAL_STATUSES], ["completed", "cancelled", "failed"]);
  for (const status of ENSEMBLE_TERMINAL_STATUSES) {
    assert.ok(ENSEMBLE_STATUSES.includes(status), `${status} is not a run status`);
  }
});

test("an enum value this build has never heard of reads as null, never as something adjacent", () => {
  assert.equal(readEnsembleEnum(ENSEMBLE_STATUSES, "completed"), "completed");
  assert.equal(readEnsembleEnum(ENSEMBLE_STATUSES, "compl3ted"), null);
  assert.equal(readEnsembleEnum(ENSEMBLE_MEMBER_STATUSES, null), null);
  assert.equal(readEnsembleEnum(ENSEMBLE_MEMBER_STATUSES, undefined), null);
});

test("a versioned key round-trips, and a malformed one is refused rather than half-read", () => {
  assert.equal(ensembleStrategyKey("best_of_n", 1), "best_of_n@1");
  assert.deepEqual(parseEnsembleStrategyKey("best_of_n@1"), { id: "best_of_n", version: 1 });
  // `tournament@2` names a strategy this build does not have, and parsing it must still work:
  // that is what lets a run from a newer build be described and cancelled.
  assert.deepEqual(parseEnsembleStrategyKey("tournament@2"), { id: "tournament", version: 2 });
  for (const bad of ["best_of_n", "@1", "best_of_n@", "best_of_n@x", "best_of_n@0"]) {
    assert.equal(parseEnsembleStrategyKey(bad), null, `${bad} should not parse`);
  }
});

// ---- compiled plans ----

function plan(over: Partial<CompiledEnsemblePlan> = {}): CompiledEnsemblePlan {
  return {
    planVersion: ENSEMBLE_PLAN_VERSION,
    strategyKey: "best_of_n@1",
    budget: {
      maxMembers: 2,
      maxConcurrentMembers: 2,
      maxWaves: 1,
      maxStageAttempts: 2,
      deadlineMs: null,
    },
    information: { kind: "isolated" },
    roles: [1, 2].map((ordinal) => ({
      key: `candidate-${ordinal}`,
      label: `Candidate ${ordinal}`,
      ordinal,
      wave: 1,
      agent: null,
      model: null,
      effort: null,
      approach: null,
      promptTemplate: "work alone",
      requiredArtifacts: ["commit"],
      input: { kind: "run_base" },
    })),
    stages: [
      {
        id: "stage-1",
        ordinal: 1,
        label: "Candidates",
        driverKind: "member",
        driverKey: "member_wave@1",
        dependsOn: [],
        barrier: { kind: "none" },
        maxAttempts: 1,
        wave: 1,
        roleKeys: ["candidate-1", "candidate-2"],
      },
    ],
    ...over,
  };
}

test("a well-formed plan round-trips through its durable schema unchanged", () => {
  const parsed = CompiledEnsemblePlanSchema.safeParse(plan());
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.deepEqual(parsed.data, plan());
  // Through JSON too: this is a TEXT column, and a shape that only survives in memory is a
  // shape the store cannot persist.
  assert.deepEqual(CompiledEnsemblePlanSchema.parse(JSON.parse(JSON.stringify(plan()))), plan());
});

test("a plan naming a role or a stage that does not exist is refused at creation", () => {
  const unknownRole = plan({
    stages: [{ ...plan().stages[0]!, roleKeys: ["candidate-9"] } as CompiledEnsemblePlan["stages"][number]],
  });
  assert.equal(CompiledEnsemblePlanSchema.safeParse(unknownRole).success, false);

  const unknownDependency = plan({
    stages: [{ ...plan().stages[0]!, dependsOn: ["stage-nope"] } as CompiledEnsemblePlan["stages"][number]],
  });
  assert.equal(CompiledEnsemblePlanSchema.safeParse(unknownDependency).success, false);
});

test("a plan whose roster exceeds its own member cap is refused", () => {
  const over = plan({ budget: { ...plan().budget, maxMembers: 1 } });
  assert.equal(CompiledEnsemblePlanSchema.safeParse(over).success, false);
});

test("duplicate role keys and duplicate stage ids are refused", () => {
  const roles = plan().roles;
  const duplicateRole = plan({ roles: [roles[0]!, { ...roles[1]!, key: roles[0]!.key }] });
  assert.equal(CompiledEnsemblePlanSchema.safeParse(duplicateRole).success, false);

  const stage = plan().stages[0]!;
  const duplicateStage = plan({ stages: [stage, { ...stage, ordinal: 2 }] });
  assert.equal(CompiledEnsemblePlanSchema.safeParse(duplicateStage).success, false);
});

test("plan dependencies, cardinalities, and per-stage limits must be satisfiable", () => {
  const member = plan().stages[0]!;
  const cycle = plan({
    stages: [
      { ...member, dependsOn: ["stage-2"] },
      { ...member, id: "stage-2", ordinal: 2, dependsOn: ["stage-1"] },
    ],
  });
  assert.equal(CompiledEnsemblePlanSchema.safeParse(cycle).success, false);

  const impossibleBarrier = plan({
    stages: [
      {
        ...member,
        barrier: {
          kind: "members_settled",
          roleKeys: ["candidate-1", "candidate-2"],
          minEligible: 3,
          requiredArtifacts: ["commit"],
        },
      },
    ],
  });
  assert.equal(CompiledEnsemblePlanSchema.safeParse(impossibleBarrier).success, false);

  const impossibleSubjects = plan({
    stages: [
      {
        id: "review",
        ordinal: 1,
        label: "Review",
        driverKind: "review",
        driverKey: "comparative_review@1",
        dependsOn: [],
        barrier: { kind: "none" },
        maxAttempts: 1,
        evaluator: {
          kind: "comparative_llm",
          guidance: { kind: "builtin", rubricId: "default" },
          runner: null,
          model: null,
          anonymizeSubjects: true,
          materialBudgetBytes: 1_000,
        },
        subjects: {
          kind: "ready_artifacts",
          artifactKind: "commit",
          minSubjects: 2,
          maxSubjects: 1,
        },
      },
    ],
  });
  assert.equal(CompiledEnsemblePlanSchema.safeParse(impossibleSubjects).success, false);

  const overStageBudget = plan({
    stages: [{ ...member, maxAttempts: plan().budget.maxStageAttempts + 1 }],
  });
  assert.equal(CompiledEnsemblePlanSchema.safeParse(overStageBudget).success, false);

  const overWaveBudget = plan({
    roles: [{ ...plan().roles[0]!, wave: 2 }, plan().roles[1]!],
  });
  assert.equal(CompiledEnsemblePlanSchema.safeParse(overWaveBudget).success, false);
});

test("no plan may exceed the hard fleet ceilings, whatever its strategy asked for", () => {
  const tooMany = plan({
    budget: { ...plan().budget, maxMembers: ENSEMBLE_HARD_LIMITS.maxMembers + 1 },
  });
  assert.equal(CompiledEnsemblePlanSchema.safeParse(tooMany).success, false);
});

test("a plan from a future shape version fails to parse rather than being half-read", () => {
  const future = { ...plan(), planVersion: ENSEMBLE_PLAN_VERSION + 1 };
  assert.equal(CompiledEnsemblePlanSchema.safeParse(future).success, false);
});

test("a driver key from a newer build still PARSES, and is separately refused as unrunnable", () => {
  // The whole distinction between readable and executable. A plan naming `comparative_review@2`
  // has to stay describable on a build that only has `@1` - an operator has to be able to see
  // what the run was going to do and cancel it - while nothing may execute it.
  const future = plan({
    stages: [{ ...plan().stages[0]!, driverKey: "member_wave@2" } as CompiledEnsemblePlan["stages"][number]],
  });
  const parsed = CompiledEnsemblePlanSchema.safeParse(future);
  assert.equal(parsed.success, true);
  assert.equal(knownDriverKey("member_wave@2"), null);
  assert.deepEqual(missingDriverKeys(future), ["member_wave@2"]);
  assert.deepEqual(missingDriverKeys(plan()), []);
});

// ---- runnability ----

function run(over: Partial<EnsembleRun> = {}): EnsembleRun {
  return {
    id: "run-1",
    sourceKind: "manual",
    sourceKey: "key",
    sourceId: null,
    strategyId: "best_of_n",
    strategyKey: "best_of_n@1",
    strategyVersion: 1,
    strategyLabel: "Best of N",
    title: "T",
    intent: "do the thing",
    repoRoot: "/repo",
    baseBranch: null,
    baseSha: null,
    plan: plan(),
    strategyConfig: {},
    status: "planning",
    activeStageId: null,
    outcome: null,
    workflowHandoff: null,
    unreadable: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    ...over,
  };
}

test("a run is runnable only when every field a newer build could have written is readable", () => {
  assert.equal(ensembleIsRunnable(run()), true);
  assert.equal(ensembleIsRunnable(run({ strategyId: null })), false);
  assert.equal(ensembleIsRunnable(run({ plan: null })), false);
  assert.equal(ensembleIsRunnable(run({ status: null })), false);
  assert.equal(ensembleIsRunnable(run({ sourceKind: null })), false);
  // Readable in every field and still refused, because the plan needs a driver this build
  // does not ship. Substituting the latest version would execute a stage the operator's plan
  // never described.
  assert.equal(
    ensembleIsRunnable(run({ unreadable: { reason: "needs member_wave@2", fields: ["compiled_plan_json"] } })),
    false,
  );
});

test("attention is derived once, so the daemon and the browser cannot disagree", () => {
  assert.equal(ensembleNeedsAttention({ status: "running", unreadable: null }), false);
  assert.equal(ensembleNeedsAttention({ status: "completed", unreadable: null }), false);
  assert.equal(ensembleNeedsAttention({ status: "failed", unreadable: null }), true);
  assert.equal(ensembleNeedsAttention({ status: "awaiting_decision", unreadable: null }), true);
  assert.equal(ensembleNeedsAttention({ status: null, unreadable: null }), true);
  assert.equal(
    ensembleNeedsAttention({ status: "running", unreadable: { reason: "x", fields: [] } }),
    true,
  );
});

test("summary, detail, and event wire schemas match their shared contracts", () => {
  const summary: EnsembleSummary = {
    id: "run-1",
    title: "Try two approaches",
    repoRoot: "/repo",
    strategyId: "best_of_n",
    strategyKey: "best_of_n@1",
    strategyLabel: "Best of N",
    strategyVersion: 1,
    status: "running",
    activeStageId: "stage-1",
    memberCount: 2,
    launchedMembers: 1,
    maxMembers: 2,
    readyArtifacts: 0,
    selectedMemberId: null,
    outcomeKind: null,
    unreadable: null,
    attention: false,
    error: null,
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
  };
  assert.deepEqual(EnsembleSummarySchema.parse(summary), summary);
  assert.equal(
    EnsembleSummarySchema.safeParse({ ...summary, launchedMembers: -1 }).success,
    false,
  );
  assert.equal(EnsembleSummarySchema.safeParse({ ...summary, status: "future" }).success, false);

  const event = {
    id: 1,
    runId: "run-1",
    ts: 2,
    kind: "created",
    payload: { members: 2 },
  };
  assert.deepEqual(EnsembleEventSchema.parse(event), event);
  const detail = {
    run: run(),
    members: [],
    attempts: [],
    artifacts: [],
    stageAttempts: [],
    evaluations: [],
    decisions: [],
    llmCalls: [],
    events: [event],
  };
  assert.deepEqual(EnsembleRunDetailSchema.parse(detail), detail);
});

test("strategy-owned payload envelopes accept only this build's version", () => {
  const payload = {
    payloadVersion: ENSEMBLE_PAYLOAD_VERSION,
    body: { recommendedArtifactId: "artifact-1" },
  };
  assert.deepEqual(EnsemblePayloadEnvelopeSchema.parse(payload), payload);
  assert.equal(
    EnsemblePayloadEnvelopeSchema.safeParse({ ...payload, payloadVersion: 2 }).success,
    false,
  );
  assert.equal(
    EnsemblePayloadEnvelopeSchema.safeParse({ body: payload.body }).success,
    false,
  );
});

// ---- create input and actions ----

const validCreate = {
  sourceKey: "manual:abc",
  title: "Try three approaches",
  intent: "Implement the feature",
  repoRoot: "/repo",
  strategyId: "best_of_n",
  strategyConfig: { members: [{}, {}] },
};

test("a create request defaults its source and leaves strategy config to the strategy", () => {
  const parsed = EnsembleCreateInputSchema.safeParse(validCreate);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.sourceKind, "manual");
  assert.equal(parsed.data.sourceId, null);
  // Deliberately NOT validated here: the generic envelope must not know what a roster is.
  assert.deepEqual(parsed.data.strategyConfig, { members: [{}, {}] });
});

test("a create request without an idempotency key, a title or a known strategy is refused", () => {
  for (const bad of [
    { ...validCreate, sourceKey: "" },
    { ...validCreate, title: "   " },
    { ...validCreate, intent: "" },
    { ...validCreate, repoRoot: "" },
    { ...validCreate, strategyId: "tournament" },
    { ...validCreate, strategyVersion: 0 },
  ]) {
    assert.equal(EnsembleCreateInputSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("the create route launches through the manager, and the MCP boundary stays submission-only", () => {
  // Phase 6 opens the create path: finalization now makes a launched run safe to FINISH, so the
  // route reaching `createAndLaunch` no longer strands a run it cannot complete. The MCP boundary
  // is unchanged - a member SUBMITS through it, and it exposes nothing that creates or launches a
  // run, so the launch authority stays with the operator's own localhost front door.
  const routes = readFileSync(fileURLToPath(new URL("../src/server/routes.ts", import.meta.url)), "utf8");
  assert.match(routes, /createAndLaunch/, "routes.ts reaches the ensemble launch path");
  assert.match(
    routes,
    /app\.post\(\s*["'`]\/api\/ensembles["'`]/,
    "routes.ts exposes the ensemble create route",
  );
  const mcp = readFileSync(fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(
    mcp,
    /create[_-]?ensemble|ensembles?\/create|createAndLaunch/i,
    "the MCP server must expose no ensemble-creation tool",
  );
});

test("the operator authorities are one closed union a new strategy must not need to widen", () => {
  assert.equal(EnsembleActionSchema.safeParse({ kind: "retry_stage", stageId: "stage-1" }).success, true);
  assert.equal(EnsembleActionSchema.safeParse({ kind: "retry_member", memberId: "m" }).success, true);
  assert.equal(EnsembleActionSchema.safeParse({ kind: "cancel" }).success, true);
  assert.equal(EnsembleActionSchema.safeParse({ kind: "resolve_finalization" }).success, true);
  // A decision carries its idempotency key, the state it expects, its selection, and an explicit
  // destructive confirmation - the last the literal `true`, so finalization is never reachable by
  // omission the way a plain boolean default would allow.
  assert.equal(
    EnsembleActionSchema.safeParse({
      kind: "decide",
      requestId: "r1",
      expectedStatus: "awaiting_decision",
      selection: { kind: "selected", artifactId: "a" },
      confirmDestructive: true,
    }).success,
    true,
  );
  assert.equal(
    EnsembleActionSchema.safeParse({
      kind: "decide",
      requestId: "r1",
      expectedStatus: "awaiting_decision",
      selection: { kind: "selected", artifactId: "a" },
      confirmDestructive: false,
    }).success,
    false,
    "confirmDestructive must be the literal true",
  );
  assert.equal(
    EnsembleActionSchema.safeParse({
      kind: "decide",
      requestId: "r".repeat(901),
      expectedStatus: "awaiting_decision",
      selection: { kind: "selected", artifactId: "a" },
      confirmDestructive: true,
    }).success,
    false,
  );
  assert.equal(EnsembleActionSchema.safeParse({ kind: "promote_everything" }).success, false);
});
