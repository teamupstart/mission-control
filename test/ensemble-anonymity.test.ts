// What is at stake: the evaluator packet's anonymity is a SAFETY property, not a preference, and
// for a while both strategy forms offered a toggle for it that nothing read. That is the worst of
// both worlds - an operator who turned "judge blind" off got an anonymous comparison anyway, and an
// operator who left it on had no reason to believe it did anything either.
//
// This pins the resolution. Anonymity is unconditional in `reviews/packet.ts`, every compiled plan
// records `anonymizeSubjects: true` so the plan states what actually happened, a stored `false`
// from any other build still LOADS but can never describe a run as de-anonymised, and no strategy
// form offers a control for it. If someone later wants a de-anonymised packet, this test is what
// makes them build it rather than flip a boolean that was never wired up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ENSEMBLE_STRATEGY_IDS } from "../src/shared/ensemble.ts";
import { ENSEMBLE_STRATEGY_INFO } from "../src/shared/ensemble-strategies.ts";
import { ENSEMBLE_STRATEGIES } from "../src/server/ensembles/strategies/index.ts";
import { CompiledEnsemblePlanSchema } from "../src/shared/protocol.ts";

function src(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

/**
 * The file with its comments removed.
 *
 * The scan below is about what the CODE does, and the module documents at length why it does not
 * read the policy flag - so a scan over the raw text would be tripped by the very comment that
 * explains the rule.
 */
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no strategy form offers an anonymity control, because nothing would honour it", () => {
  for (const id of ENSEMBLE_STRATEGY_IDS) {
    const fields = ENSEMBLE_STRATEGY_INFO[id].form.fields;
    const offender = fields.find((field) => field.key.endsWith("anonymizeSubjects"));
    assert.equal(
      offender,
      undefined,
      `${id} offers "${offender?.label}" for anonymizeSubjects; the packet never reads it, so the control would be a promise nothing keeps`,
    );
  }
});

test("the evidence packet anonymizes unconditionally - it never branches on the policy flag", () => {
  // The label assignment must not be behind a condition on the policy. A read of the field at all
  // in this module's CODE is the signal that anonymity became optional again.
  assert.doesNotMatch(
    code("src/server/ensembles/reviews/packet.ts"),
    /anonymizeSubjects/,
    "packet.ts reads anonymizeSubjects; anonymity is unconditional and must stay so",
  );
  assert.match(
    src("src/server/ensembles/reviews/packet.ts"),
    /Submission \$\{/,
    "every subject is relabelled to an opaque Submission id",
  );
});

test("every compiled plan records anonymizeSubjects: true, whatever the config asked for", () => {
  // A stored config asking to de-anonymise compiles to an anonymous plan rather than a plan that
  // claims something the packet will not do. The config normalizes too, so the run's recorded
  // strategy config and its plan agree.
  const configs: Record<string, unknown> = {
    best_of_n: { members: [{}, {}], evaluator: { anonymizeSubjects: false } },
    consensus: { members: [{}, {}, {}], evaluator: { anonymizeSubjects: false } },
  };
  for (const id of ENSEMBLE_STRATEGY_IDS) {
    const result = ENSEMBLE_STRATEGIES[id].compile(configs[id], {
      repoRoot: "/repo",
      persona: null,
      now: 1000,
    });
    assert.ok(result.ok, `${id} failed to compile: ${JSON.stringify(result.ok ? null : result.issues)}`);
    const reviews = result.plan.stages.filter((stage) => stage.driverKind === "review");
    assert.ok(reviews.length > 0, `${id} compiled no review stage`);
    for (const stage of reviews) {
      assert.equal(
        stage.driverKind === "review" && stage.evaluator.anonymizeSubjects,
        true,
        `${id} compiled a plan claiming a de-anonymised evaluator`,
      );
    }
    const config = result.config as { evaluator?: { anonymizeSubjects?: unknown } };
    assert.equal(config.evaluator?.anonymizeSubjects, true, `${id} kept a de-anonymised config value`);
  }
});

test("a plan written elsewhere with anonymizeSubjects false still LOADS, and is simply run anonymously", () => {
  // Readability is separate from behaviour: a run from another build must not become unreadable
  // over this field - a run nobody can see is one nobody can cancel - and the packet ignores it.
  const plan = {
    planVersion: 1,
    strategyKey: "best_of_n@1",
    budget: { maxMembers: 2, maxConcurrentMembers: 2, maxWaves: 1, maxStageAttempts: 2, deadlineMs: null },
    information: { kind: "isolated" },
    roles: [
      {
        key: "candidate-1",
        label: "Candidate 1",
        ordinal: 1,
        wave: 1,
        agent: null,
        model: null,
        effort: null,
        approach: null,
        promptTemplate: "work alone",
        requiredArtifacts: ["commit"],
        input: { kind: "run_base" },
      },
    ],
    stages: [
      {
        id: "stage-1",
        ordinal: 1,
        label: "Comparison",
        driverKind: "review",
        driverKey: "comparative_review@1",
        dependsOn: [],
        barrier: { kind: "none" },
        maxAttempts: 1,
        evaluator: {
          kind: "comparative_llm",
          guidance: { kind: "builtin", rubricId: "best_of_n_v1" },
          runner: null,
          model: null,
          anonymizeSubjects: false,
          materialBudgetBytes: 65_536,
        },
        subjects: { kind: "ready_artifacts", artifactKind: "commit", minSubjects: 1, maxSubjects: 1 },
      },
    ],
  };
  const parsed = CompiledEnsemblePlanSchema.safeParse(plan);
  assert.equal(parsed.success, true, "a stored false must not make a plan unreadable");
});
