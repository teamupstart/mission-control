import test from "node:test";
import assert from "node:assert/strict";

import {
  PIPELINE_HALT_CLASSES,
  PIPELINE_PHASES,
  PIPELINE_PROVIDER_IDS,
  PIPELINE_PROVIDER_INFO,
  PIPELINE_RUN_GROUPS,
  PIPELINE_STEPS,
  PIPELINE_STEP_STATES,
  PipelinesConfigSchema,
  activePipelineRepos,
  isPipelineHaltClass,
  isPipelineProviderId,
  isPipelineStepState,
  pipelinePhaseOfStep,
  pipelineRunKey,
  pipelineStepInfo,
  pipelineStepOrder,
  sortPipelineSteps,
  type PipelinePhase,
} from "../src/shared/pipeline.ts";

// What is at stake: `src/shared/pipeline.ts` is a cross-phase contract - phases 2 to 6 are
// all consumers of it - and two of the things it promises are only true if somebody checks.
//
// The first is APPEND-ONLY. `PIPELINE_PROVIDER_IDS` is persisted in `app_config` and in
// `pipeline_runs.provider`, so a rename orphans every repository an operator consented to
// under the old spelling. The literal below is the tripwire: changing an id fails here,
// which is the moment to append instead.
//
// The second is TOLERANCE. Mission Control ships a frozen copy of conductor's step
// vocabulary, and conductor is a separate program on a release train nobody here controls.
// The copy must therefore degrade rather than refuse: an unknown step name renders and
// sorts, and `pipelineStepInfo` returning null is an ordinary answer.

test("the provider id tuple is append-only, and every id has a Record entry", () => {
  // Written out rather than derived. A test that read the tuple to check the tuple would
  // pass through a rename, which is the one edit this exists to catch.
  assert.deepEqual([...PIPELINE_PROVIDER_IDS], ["ai-conductor"]);
  for (const id of PIPELINE_PROVIDER_IDS) {
    const info = PIPELINE_PROVIDER_INFO[id];
    assert.equal(info.provider, id, `${id}'s info must name itself`);
    assert.ok(info.label, `${id} needs a display name`);
    assert.ok(info.blurb, `${id} needs a sentence saying what an operator is consenting to`);
    assert.ok(info.bin, `${id} needs a binary to probe for`);
    assert.ok(PIPELINE_STEPS[id].length > 0, `${id} needs a step table`);
  }
  assert.equal(isPipelineProviderId("ai-conductor"), true);
  assert.equal(isPipelineProviderId("ai-conductor-2"), false);
});

test("the vocabularies read out of provider files are checked, not cast", () => {
  // Each of these decodes a string another program wrote. A cast would let a value from a
  // newer engine flow into a `Record` key and render as `undefined`.
  assert.deepEqual([...PIPELINE_STEP_STATES], [
    "pending",
    "in_progress",
    "done",
    "failed",
    "skipped",
    "stale",
  ]);
  assert.deepEqual([...PIPELINE_HALT_CLASSES], [
    "needs-human",
    "mechanical",
    "protected-artifact",
    "legacy",
    "unclassified",
  ]);
  assert.deepEqual([...PIPELINE_RUN_GROUPS], [
    "building",
    "eligible",
    "waiting",
    "halted",
    "parked",
    "processed",
  ]);
  assert.equal(isPipelineStepState("in_progress"), true);
  assert.equal(isPipelineStepState("quantum"), false);
  assert.equal(isPipelineHaltClass("needs-human"), true);
  assert.equal(isPipelineHaltClass("needs-a-human"), false);
});

test("the frozen step table is conductor's own 22-step sequence plus its four out-of-band steps", () => {
  // Copied from ai-conductor `8b51392d`'s `ALL_STEPS` and `OUT_OF_BAND_STEPS`. Written out
  // so that re-freezing the copy against a newer engine is a deliberate, reviewable edit
  // rather than a diff nobody can read.
  const steps = PIPELINE_STEPS["ai-conductor"];
  const sequential = steps.filter((s) => !s.outOfBand);
  assert.deepEqual(
    sequential.map((s) => s.name),
    [
      "worktree",
      "memory",
      "explore",
      "complexity",
      "prd",
      "architecture_diagram",
      "architecture_review",
      "stories",
      "conflict_check",
      "plan",
      "coherence_check",
      "acceptance_specs",
      "build",
      "wiring_check",
      "test_suite",
      "build_review",
      "manual_test",
      "prd_audit",
      "architecture_review_as_built",
      "retro",
      "rebase",
      "finish",
    ],
  );
  assert.deepEqual(
    steps.filter((s) => s.outOfBand).map((s) => s.name),
    ["bootstrap", "assess", "remediate", "attribution_verify"],
  );

  // The phase counts the plan states, checked as a fold rather than restated per step.
  const perPhase: Record<PipelinePhase, number> = {
    SETUP: 0,
    UNDERSTAND: 0,
    DECIDE: 0,
    BUILD: 0,
    SHIP: 0,
  };
  for (const step of sequential) perPhase[step.phase] += 1;
  assert.deepEqual(perPhase, { SETUP: 1, UNDERSTAND: 1, DECIDE: 9, BUILD: 5, SHIP: 6 });
  assert.equal(sequential.length, 22);

  // `wiring_check` is a retained compatibility no-op. It is drawn dashed rather than hidden
  // because it still occupies a slot in the engine's own state - and it is the only one.
  assert.deepEqual(
    steps.filter((s) => s.deprecated).map((s) => s.name),
    ["wiring_check"],
  );

  // Every step names a phase this build has a word for.
  for (const step of steps) {
    assert.ok(PIPELINE_PHASES.includes(step.phase), `${step.name} names an unknown phase`);
    assert.ok(step.label, `${step.name} needs a label`);
  }
});

test("an unknown step is tolerated: no info, no phase, and it sorts after every known one", () => {
  assert.equal(pipelineStepInfo("ai-conductor", "build")?.label, "Build");
  assert.equal(pipelinePhaseOfStep("ai-conductor", "build"), "BUILD");

  // The whole tolerance rule, as three answers about a step from a newer engine.
  assert.equal(pipelineStepInfo("ai-conductor", "quantum_check"), null);
  assert.equal(pipelinePhaseOfStep("ai-conductor", "quantum_check"), null);
  assert.ok(
    pipelineStepOrder("ai-conductor", "quantum_check") >
      pipelineStepOrder("ai-conductor", "finish"),
    "an unknown step must sort after the last known one",
  );
});

test("sorting is stable, so two unknown steps keep the order they arrived in", () => {
  // Not decoration. Two unknown steps compare equal, and a browser that reshuffled them
  // between two frames would draw a strip that moved for no reason a reader could see.
  const sorted = sortPipelineSteps("ai-conductor", [
    { name: "zeta_from_the_future" },
    { name: "build" },
    { name: "alpha_from_the_future" },
    { name: "worktree" },
  ]);
  assert.deepEqual(
    sorted.map((s) => s.name),
    ["worktree", "build", "zeta_from_the_future", "alpha_from_the_future"],
  );
});

test("the projection key is the engine's own identity, and separates its three parts", () => {
  assert.notEqual(
    pipelineRunKey("ai-conductor", "/repo/a", "b-c"),
    pipelineRunKey("ai-conductor", "/repo/a b", "c"),
  );
});

test("the consent config ships off, and defaults over a blob an older build wrote", () => {
  // The zod-defaults-on-read pattern is what means this key needs no migration. An empty
  // object is what `getAppConfig` returns for a key nothing has written.
  const shipped = PipelinesConfigSchema.parse({});
  assert.equal(shipped.enabled, false);
  assert.deepEqual(shipped.repos, []);

  // A repository arrives OFF even when the caller says nothing: adding is configuration,
  // enabling is consent.
  const added = PipelinesConfigSchema.parse({
    repos: [{ provider: "ai-conductor", repoRoot: "/repo/a" }],
  });
  assert.equal(added.repos[0]?.enabled, false);

  // Two entries naming one repository would each overwrite the other's consent.
  assert.throws(() =>
    PipelinesConfigSchema.parse({
      repos: [
        { provider: "ai-conductor", repoRoot: "/repo/a" },
        { provider: "ai-conductor", repoRoot: "/repo/a" },
      ],
    }),
  );
});

test("the master switch gates every repository, without forgetting which were chosen", () => {
  const config = PipelinesConfigSchema.parse({
    enabled: false,
    repos: [
      { provider: "ai-conductor", repoRoot: "/repo/a", enabled: true },
      { provider: "ai-conductor", repoRoot: "/repo/b", enabled: false },
    ],
  });
  // Off: nothing is read...
  assert.deepEqual(activePipelineRepos(config), []);
  // ...but the choice survives, which is the whole reason the master switch is not just
  // "turn every repository off".
  assert.equal(config.repos.length, 2);
  assert.deepEqual(
    activePipelineRepos({ ...config, enabled: true }).map((r) => r.repoRoot),
    ["/repo/a"],
  );
});
