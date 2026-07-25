import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PANEL_VOTE_DEFAULTS,
  PANEL_VOTE_MAX_JUDGES,
  PANEL_VOTE_MIN_JUDGES,
  PANEL_VOTE_MIN_QUORUM,
  PANEL_VOTE_FORM,
  PanelVoteConfigSchema,
} from "../src/shared/ensemble-strategies/panel-vote.ts";
import { CompiledEnsemblePlanSchema } from "../src/shared/protocol.ts";
import { panelVoteStrategy } from "../src/server/ensembles/strategies/panel-vote.ts";
import type { StrategyCompileContext } from "../src/server/ensembles/strategies/types.ts";
import type { EnsembleReviewPersona } from "../src/shared/ensemble.ts";

/**
 * What is at stake: this compiler decides both how many local agents launch and what the panel
 * that judges them is, and both are things an operator confirmed a preview of. Four properties.
 *
 *  1. **Determinism.** Recovery executes the STORED plan and a test asserts an exact one, so a
 *     compiler that embedded a clock or a uuid would break both.
 *  2. **A panel has to be able to disagree.** Two judges given the same built-in lens are two
 *     samples of one opinion whose disagreement measure is guaranteed zero - refused at
 *     validation, before anything launches.
 *  3. **Fail closed on guidance.** A judge whose Persona could not be resolved refuses the run
 *     rather than falling back to a built-in lens: the run would complete, the ranking would look
 *     fine, and nothing on screen would say a different lens judged it.
 *  4. **The quorum is in the PLAN.** It is compiled in rather than read from a constant at
 *     execution time, so a later build changing its mind cannot re-aim a run already in flight.
 */

const context: StrategyCompileContext = { repoRoot: "/repo", personas: new Map(), now: 1_000 };

function withPersonas(...personas: EnsembleReviewPersona[]): StrategyCompileContext {
  return { ...context, personas: new Map(personas.map((persona) => [persona.id, persona])) };
}

function persona(id: string, revision = 1): EnsembleReviewPersona {
  return {
    id,
    revision,
    name: `Persona ${id}`,
    guidanceMarkdown: `Weigh ${id} heavily.`,
    runner: null,
    model: null,
  };
}

function compile(config: unknown, ctx: StrategyCompileContext = context) {
  return panelVoteStrategy.compile(config, ctx);
}

function planOf(config: unknown, ctx: StrategyCompileContext = context) {
  const result = compile(config, ctx);
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.issues)}`);
  return result.plan;
}

function panelStage(config: unknown, ctx: StrategyCompileContext = context) {
  const stage = planOf(config, ctx).stages.find((s) => s.id === "stage-2-panel");
  assert.ok(stage && stage.driverKind === "review");
  assert.equal(stage.evaluator.kind, "panel_llm");
  if (stage.evaluator.kind !== "panel_llm") throw new Error("unreachable");
  return { stage, evaluator: stage.evaluator };
}

// ---- shape ----

test("the compiled plan is the four generic stages, with the panel driver on the review stage", () => {
  const plan = planOf({});
  assert.deepEqual(
    plan.stages.map((s) => [s.id, s.driverKind, s.driverKey]),
    [
      ["stage-1-candidates", "member", "member_wave@1"],
      ["stage-2-panel", "review", "panel_review@1"],
      ["stage-3-decision", "decision", "human_decision@1"],
      ["stage-4-finalize", "finalize", "select_one_finalize@1"],
    ],
  );
  // ONE review stage, not one per judge: the judges are parallel inside it, which is what makes a
  // quorum expressible and stops the operator waiting for M sequential model calls.
  assert.equal(plan.stages.filter((s) => s.driverKind === "review").length, 1);
  assert.equal(plan.strategyKey, "panel_vote@1");
  assert.ok(CompiledEnsemblePlanSchema.safeParse(plan).success, "the plan round-trips through its durable schema");
});

test("compilation is deterministic and leaks no runtime id", () => {
  assert.equal(JSON.stringify(planOf({})), JSON.stringify(planOf({})));
  assert.doesNotMatch(JSON.stringify(planOf({})), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/, "no uuid in a compiled plan");
});

test("the default panel is three distinct lenses over three candidates", () => {
  assert.equal(PANEL_VOTE_DEFAULTS.members.length, 3);
  assert.equal(PANEL_VOTE_DEFAULTS.judges.length, 3);
  const { evaluator } = panelStage({});
  assert.deepEqual(
    evaluator.judges.map((judge) => [judge.key, judge.label, judge.guidance]),
    [
      ["judge-1", "Correctness", { kind: "builtin", rubricId: "panel_correctness_v1" }],
      ["judge-2", "Maintainability", { kind: "builtin", rubricId: "panel_maintainability_v1" }],
      ["judge-3", "Risk", { kind: "builtin", rubricId: "panel_risk_v1" }],
    ],
  );
  assert.equal(evaluator.anonymizeSubjects, true, "the panel judges blind by default");
});

test("anonymization is fixed panel behavior, not a no-op operator control", () => {
  assert.equal(PANEL_VOTE_FORM.fields.some((field) => field.key === "anonymizeSubjects"), false);
});

test("the quorum is compiled into the plan rather than left to the executing build", () => {
  assert.equal(panelStage({}).evaluator.minSuccessfulJudges, PANEL_VOTE_MIN_QUORUM);
  // Never above the judge count, or the stage could never succeed.
  const two = panelStage({ judges: [{ lens: "panel_correctness_v1" }, { lens: "panel_risk_v1" }] });
  assert.ok(two.evaluator.minSuccessfulJudges <= two.evaluator.judges.length);
});

test("the members' prompt tells them a panel will judge them, not one comparison", () => {
  const plan = planOf({ judges: [{ lens: "panel_correctness_v1" }, { lens: "panel_risk_v1" }] });
  for (const role of plan.roles) {
    assert.match(role.promptTemplate, /panel of 2 independent judges/);
    assert.match(role.promptTemplate, /do not optimise for a single one of them/);
    assert.match(role.promptTemplate, /Do not push, do not open a pull request/);
  }
});

test("an approach hint reaches the member it was written for, and only that one", () => {
  const plan = planOf({
    members: [{ approach: "start from the tests" }, {}],
    judges: [{ lens: "panel_correctness_v1" }, { lens: "panel_risk_v1" }],
  });
  assert.match(plan.roles[0]!.promptTemplate, /Suggested approach for this candidate: start from the tests/);
  assert.doesNotMatch(plan.roles[1]!.promptTemplate, /Suggested approach/);
});

// ---- bounds ----

test("roster and panel bounds are refused before anything launches", () => {
  assert.equal(PanelVoteConfigSchema.safeParse({ members: [{}] }).success, false, "one candidate is not a comparison");
  assert.equal(PanelVoteConfigSchema.safeParse({ members: Array.from({ length: 6 }, () => ({})) }).success, false);
  assert.equal(
    PanelVoteConfigSchema.safeParse({ judges: [{ lens: "panel_correctness_v1" }] }).success,
    false,
    `a panel needs at least ${PANEL_VOTE_MIN_JUDGES} judges`,
  );
  const tooMany = Array.from({ length: PANEL_VOTE_MAX_JUDGES + 1 }, (_, i) => ({ lens: `judge-${i}` }));
  assert.equal(PanelVoteConfigSchema.safeParse({ judges: tooMany }).success, false);
});

test("two judges on the same built-in lens are refused - a panel that cannot disagree is not one", () => {
  const result = compile({
    judges: [{ lens: "panel_correctness_v1" }, { lens: "panel_correctness_v1" }],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issues[0]?.path, "judges.1.lens");
  assert.match(result.issues[0]!.message, /distinct lenses/);
});

test("the same PERSONA on two judges is allowed - the operator wrote that guidance", () => {
  // Different claim from a repeated built-in lens: sampling one operator-authored lens twice is a
  // choice they may legitimately make, and the panel is honest about being two samples of it.
  const result = compile(
    { judges: [{ personaId: "sec" }, { personaId: "sec" }] },
    withPersonas(persona("sec")),
  );
  assert.equal(result.ok, true, JSON.stringify(result.ok ? "" : result.issues));
});

test("an unsupported reasoning effort on a candidate is refused rather than silently dropped", () => {
  // Codex is the harness with no `max`, measured through `supportsEffort` rather than restated
  // here. Dropped silently at launch, this would show a roster saying `max` beside an agent
  // running at its default.
  const result = compile({ members: [{ agent: "codex", effort: "max" }, {}] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issues[0]?.path, "members.0.effort");
});

// ---- guidance ----

test("a judge's Persona is snapshotted whole into the plan, not just pinned by id", () => {
  const { evaluator } = panelStage(
    { judges: [{ lens: "panel_correctness_v1" }, { personaId: "sec" }] },
    withPersonas({
      id: "sec",
      revision: 4,
      name: "Security",
      guidanceMarkdown: "Weigh security risk heavily.",
      runner: "codex",
      model: "gpt-5.6-sol",
    }),
  );
  assert.deepEqual(evaluator.judges[1]!.guidance, {
    kind: "persona",
    personaId: "sec",
    revision: 4,
    name: "Security",
    guidanceMarkdown: "Weigh security risk heavily.",
    runner: "codex",
    model: "gpt-5.6-sol",
  });
  assert.equal(evaluator.judges[1]!.label, "Security", "the ballot is labelled with the Persona's pinned name");
  // The first judge keeps its built-in lens - resolving one judge's Persona must not re-aim another.
  assert.deepEqual(evaluator.judges[0]!.guidance, { kind: "builtin", rubricId: "panel_correctness_v1" });
});

test("a judge whose Persona could not be resolved refuses the run rather than falling back", () => {
  const result = compile({ judges: [{ lens: "panel_correctness_v1" }, { personaId: "gone" }] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issues[0]?.path, "judges.1.personaId");
});

test("a resolved Persona nobody asked for is refused too", () => {
  // The mirror image, and it matters for the same reason: the caller and the config disagree about
  // what is judging, and the plan would record the caller's answer.
  const result = compile({}, withPersonas(persona("stray")));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.issues[0]!.message, /did not ask for one/);
});

// ---- persona refs ----

test("personaRefs reports every judge's Persona and its pin, defensively over a raw blob", () => {
  assert.deepEqual(
    panelVoteStrategy.personaRefs({
      judges: [{ lens: "panel_risk_v1" }, { personaId: "sec", personaRevision: 7 }, { personaId: "dx" }],
    }),
    [
      { path: "judges.1.personaId", personaId: "sec", revision: 7 },
      { path: "judges.2.personaId", personaId: "dx", revision: null },
    ],
  );
  // It runs BEFORE validation, so nonsense is "no Persona named" here and the schema states the
  // real refusal with a path on it.
  assert.deepEqual(panelVoteStrategy.personaRefs(null), []);
  assert.deepEqual(panelVoteStrategy.personaRefs({ judges: "not an array" }), []);
  assert.deepEqual(panelVoteStrategy.personaRefs({ judges: [{ personaId: "" }, 7, null] }), []);
});

// ---- estimate ----

test("the estimate counts one model call per judge, which is what the panel actually costs", () => {
  assert.deepEqual(panelVoteStrategy.estimate({}), {
    initialMembers: 3,
    maxMembers: 3,
    maxConcurrentMembers: 3,
    maxWaves: 1,
    evaluationCalls: 3,
  });
  const five = panelVoteStrategy.estimate({
    members: [{}, {}],
    judges: [
      { lens: "panel_correctness_v1" },
      { lens: "panel_maintainability_v1" },
      { lens: "panel_risk_v1" },
      { lens: "panel_evidence_v1" },
      { lens: "panel_scope_v1" },
    ],
  })!;
  assert.equal(five.evaluationCalls, 5);
  assert.equal(five.initialMembers, 2);
  assert.equal(panelVoteStrategy.estimate({ judges: [] }), null, "an invalid config estimates nothing");
});
