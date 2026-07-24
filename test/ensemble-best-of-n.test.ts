import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BEST_OF_N_BUILTIN_RUBRIC,
  BEST_OF_N_DEFAULTS,
  BEST_OF_N_MAX_CANDIDATES,
  BEST_OF_N_MIN_CANDIDATES,
  BestOfNConfigSchema,
} from "../src/shared/ensemble-strategies/best-of-n.ts";
import { CompiledEnsemblePlanSchema } from "../src/shared/protocol.ts";
import { bestOfNStrategy } from "../src/server/ensembles/strategies/best-of-n.ts";
import type { StrategyCompileContext } from "../src/server/ensembles/strategies/types.ts";

/**
 * What is at stake: this compiler is the only thing standing between an operator's form and
 * N local agents launching against their machine. Three properties are pinned here.
 *
 *  1. **Determinism.** A stored plan is executed for the life of its run and never
 *     recompiled, so a compiler that embedded a uuid or a clock would produce a plan a test
 *     could not assert and a recovery pass could not compare against.
 *  2. **Bounds.** One candidate is not a comparison and six is uncontrolled resource use.
 *  3. **Fail closed on guidance.** A comparison judged by the built-in rubric when the
 *     operator chose a Persona is a silent substitution: the run completes, the ranking
 *     looks fine, and nothing on screen says a different rubric decided it.
 */

const context: StrategyCompileContext = { repoRoot: "/repo", persona: null, now: 1_000 };

function compile(config: unknown, ctx: StrategyCompileContext = context) {
  return bestOfNStrategy.compile(config, ctx);
}

function planOf(config: unknown, ctx: StrategyCompileContext = context) {
  const result = compile(config, ctx);
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.issues));
  if (!result.ok) throw new Error("unreachable");
  return result.plan;
}

// ---- shape ----

test("the default roster is three candidates in one wave, judged once, decided by a person", () => {
  const plan = planOf({});
  assert.equal(plan.strategyKey, "best_of_n@1");
  assert.equal(plan.information.kind, "isolated");
  assert.deepEqual(
    plan.roles.map((role) => [role.key, role.ordinal, role.wave]),
    [
      ["candidate-1", 1, 1],
      ["candidate-2", 2, 1],
      ["candidate-3", 3, 1],
    ],
  );
  assert.deepEqual(
    plan.stages.map((stage) => [stage.id, stage.driverKind, stage.driverKey]),
    [
      ["stage-1-candidates", "member", "member_wave@1"],
      ["stage-2-review", "review", "comparative_review@1"],
      ["stage-3-decision", "decision", "human_decision@1"],
      ["stage-4-finalize", "finalize", "select_one_finalize@1"],
    ],
  );
});

test("the review stage waits for every member AND for two eligible artifacts", () => {
  // Both halves. "Everyone stopped" alone lets a comparison be manufactured from a single
  // artifact when the rest failed; "two are ready" alone starts judging while a third works.
  const review = planOf({}).stages.find((stage) => stage.id === "stage-2-review");
  assert.ok(review && review.driverKind === "review");
  assert.deepEqual(review.barrier, {
    kind: "members_settled",
    roleKeys: ["candidate-1", "candidate-2", "candidate-3"],
    minEligible: 2,
    requiredArtifacts: ["commit"],
  });
  assert.deepEqual(review.subjects, {
    kind: "ready_artifacts",
    artifactKind: "commit",
    minSubjects: 2,
    maxSubjects: 3,
  });
});

test("finalization waits on a person, not on the ranking", () => {
  const finalize = planOf({}).stages.find((stage) => stage.id === "stage-4-finalize");
  assert.ok(finalize && finalize.driverKind === "finalize");
  assert.deepEqual(finalize.barrier, { kind: "human_decision" });
  assert.equal(finalize.finalization.requiresHumanDecision, true);
  assert.equal(finalize.finalization.loserPolicy, "reap_worktrees");
});

test("every member prompt forbids publishing and sibling inspection", () => {
  for (const role of planOf({}).roles) {
    assert.match(role.promptTemplate, /Do not push/);
    assert.match(role.promptTemplate, /pull request/);
    assert.match(role.promptTemplate, /Do not inspect the other candidates/);
    assert.match(role.promptTemplate, /Do not claim a check you did not run/);
  }
});

test("an approach hint reaches the member it was written for, and only that one", () => {
  const plan = planOf({ members: [{ approach: "use the existing queue" }, {}] });
  assert.match(plan.roles[0]!.promptTemplate, /use the existing queue/);
  assert.doesNotMatch(plan.roles[1]!.promptTemplate, /use the existing queue/);
  assert.equal(plan.roles[0]!.approach, "use the existing queue");
  assert.equal(plan.roles[1]!.approach, null);
});

test("compilation is deterministic - the same input compiles byte-identically", () => {
  const config = { members: [{ agent: "claude" }, { agent: "codex" }], maxConcurrentMembers: 2 };
  assert.equal(
    JSON.stringify(planOf(config)),
    JSON.stringify(planOf(config, { ...context, now: 999_999 })),
  );
});

test("no runtime id is embedded in a compiled plan", () => {
  // A compiler that minted one could not compile the same plan for two runs, and recovery
  // could not compare a stored plan against a fresh compilation.
  const serialized = JSON.stringify(planOf({}));
  assert.doesNotMatch(serialized, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
});

test("a compiled plan satisfies the durable schema it will be stored under", () => {
  assert.equal(CompiledEnsemblePlanSchema.safeParse(planOf({})).success, true);
});

// ---- bounds and overrides ----

test("two through five candidates are accepted; one and six are not", () => {
  for (let count = BEST_OF_N_MIN_CANDIDATES; count <= BEST_OF_N_MAX_CANDIDATES; count += 1) {
    const plan = planOf({ members: Array.from({ length: count }, () => ({})) });
    assert.equal(plan.roles.length, count);
    assert.equal(plan.budget.maxMembers, count);
  }
  for (const count of [0, 1, BEST_OF_N_MAX_CANDIDATES + 1]) {
    const result = compile({ members: Array.from({ length: count }, () => ({})) });
    assert.equal(result.ok, false, `${count} candidates should be refused`);
  }
});

test("concurrency never exceeds the roster it is running", () => {
  const plan = planOf({ members: [{}, {}], maxConcurrentMembers: 8 });
  assert.equal(plan.budget.maxConcurrentMembers, 2);
});

test("explicit agent, model and effort overrides survive compilation exactly", () => {
  const plan = planOf({
    members: [
      { agent: "claude", model: "claude-opus-4-8", effort: "xhigh" },
      { agent: "codex", model: "gpt-5.6-sol", effort: null },
    ],
  });
  assert.deepEqual(
    plan.roles.map((role) => [role.agent, role.model, role.effort]),
    [
      ["claude", "claude-opus-4-8", "xhigh"],
      ["codex", "gpt-5.6-sol", null],
    ],
  );
});

test("null overrides mean the daemon's default at launch, not a pinned default now", () => {
  const plan = planOf({ members: [{}, {}] });
  for (const role of plan.roles) {
    assert.equal(role.agent, null);
    assert.equal(role.model, null);
    assert.equal(role.effort, null);
  }
});

test("an effort the chosen harness cannot honour is refused where the operator typed it", () => {
  // Dropped silently at launch, this would show a roster saying `max` beside an agent
  // running at its default. Codex is the harness that has no `max`, measured through
  // `supportsEffort` rather than restated here.
  const result = compile({ members: [{ agent: "codex", effort: "max" }, {}] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.path === "members.0.effort"), JSON.stringify(result.issues));
});

test("a model id that is not a bare model id is refused before it reaches a command line", () => {
  assert.equal(compile({ members: [{ model: "../../etc/passwd" }, {}] }).ok, false);
  assert.equal(compile({ members: [{ model: "-rf" }, {}] }).ok, false);
});

test("the shared defaults are the schema's own, so form and compiler cannot disagree", () => {
  assert.deepEqual(BEST_OF_N_DEFAULTS, BestOfNConfigSchema.parse({}));
  assert.equal(BEST_OF_N_DEFAULTS.members.length, 3);
  assert.equal(BEST_OF_N_DEFAULTS.evaluator.anonymizeSubjects, true);
});

// ---- evaluator guidance ----

test("with no Persona chosen, the built-in rubric is snapshotted into the plan", () => {
  const review = planOf({}).stages.find((stage) => stage.id === "stage-2-review");
  assert.ok(review && review.driverKind === "review");
  assert.deepEqual(review.evaluator.guidance, { kind: "builtin", rubricId: BEST_OF_N_BUILTIN_RUBRIC });
  assert.equal(review.evaluator.anonymizeSubjects, true);
});

test("a chosen Persona is snapshotted whole into the plan, not just pinned by id", () => {
  const plan = planOf(
    { evaluator: { personaId: "persona-1" } },
    {
      ...context,
      persona: {
        id: "persona-1",
        revision: 4,
        name: "Security",
        guidanceMarkdown: "Weigh security risk heavily.",
        runner: "codex",
        model: "gpt-5.6-sol",
      },
    },
  );
  const review = plan.stages.find((stage) => stage.id === "stage-2-review");
  assert.ok(review && review.driverKind === "review");
  // The whole snapshot - name, guidance text and overrides - is in the plan, so recovery never
  // reloads the live Persona and a later edit cannot re-aim this run.
  assert.deepEqual(review.evaluator.guidance, {
    kind: "persona",
    personaId: "persona-1",
    revision: 4,
    name: "Security",
    guidanceMarkdown: "Weigh security risk heavily.",
    runner: "codex",
    model: "gpt-5.6-sol",
  });
});

test("a Persona that could not be resolved refuses the run rather than falling back", () => {
  const result = compile({ evaluator: { personaId: "gone" } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issues[0]?.path, "evaluator.personaId");
});

test("a resolved Persona nobody asked for is refused too", () => {
  // The mirror image, and it matters for the same reason: it would mean the caller and the
  // config disagree about what is judging, and the plan would record the caller's answer.
  const result = compile(
    {},
    {
      ...context,
      persona: {
        id: "persona-1",
        revision: 1,
        name: "Security",
        guidanceMarkdown: "Weigh security risk heavily.",
        runner: null,
        model: null,
      },
    },
  );
  assert.equal(result.ok, false);
});

test("evaluator retries bound the stage attempts the plan will allow", () => {
  const plan = planOf({ evaluator: { maxAttempts: 4 } });
  assert.equal(plan.budget.maxStageAttempts, 4);
  const review = plan.stages.find((stage) => stage.id === "stage-2-review");
  assert.equal(review?.maxAttempts, 4);
  assert.equal(compile({ evaluator: { maxAttempts: 99 } }).ok, false);
});

test("the launch estimate says exactly what pressing create would start", () => {
  const estimate = bestOfNStrategy.estimate({ members: [{}, {}, {}, {}] });
  assert.deepEqual(estimate, {
    initialMembers: 4,
    maxMembers: 4,
    maxConcurrentMembers: 3,
    maxWaves: 1,
    evaluationCalls: 1,
  });
});
