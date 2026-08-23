import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LLM_JOB_IDS,
  LLM_JOB_SPECS,
  resolveLlmJobModel,
  resolveLlmJobModels,
} from "../src/shared/llm-jobs.ts";
import {
  DEFAULT_LLM_RUNNER_ID,
  LLM_RUNNER_ENV,
  LLM_RUNNER_ENV_VAR,
  LLM_RUNNER_IDS,
  isLlmRunnerId,
  resolveLlmRunner,
} from "../src/shared/llm.ts";

// What is at stake: this is the migration that took three hardcoded `claude-haiku-4-5`
// constants out of `task-title.ts`, `goal/refiner.ts` and `away/digest.ts` and put them
// behind a config. The promise made when it landed was that an operator who never opens the
// new panel gets EXACTLY what they had - same model ids, same env var names, same "an empty
// box means the ladder decides" reading of a cleared field. Workflow context was appended
// before its first caller and is pinned here under the same persisted-key contract.
//
// Every one of those is silent when it breaks. A changed fallback spends a different tier
// on every dispatch and nothing says so; a changed env var name leaves a `MISSION_GOAL_MODEL`
// in someone's shell doing nothing, which is indistinguishable from it working. So the
// values are pinned here as LITERALS rather than read back off the spec they came from - a
// test that asserts `spec.fallback === spec.fallback` pins nothing.
//
// The runner half is here for a different failure: its ladder validates where the model
// ladder does not, because a model id is free text the CLI resolves and a runner id has to
// name something in `LLM_RUNNERS` or there is nothing to spawn. An unresolvable one must
// fall back rather than be handed on - and must SAY it fell back, or a panel presents the
// default as the operator's own choice.

test("the shipped model for each background job is pinned", () => {
  // The literals as they stood in task-title.ts:20, goal/refiner.ts:39 and away/digest.ts:17
  // before this migration. Pinned, not derived.
  assert.equal(LLM_JOB_SPECS["task-title"].fallback, "claude-haiku-4-5");
  assert.equal(LLM_JOB_SPECS.goal.fallback, "claude-haiku-4-5");
  assert.equal(LLM_JOB_SPECS["away-digest"].fallback, "claude-haiku-4-5");
  assert.equal(LLM_JOB_SPECS["workflow-context"].fallback, "claude-haiku-4-5");
  // The ensemble comparison is a review, but its untuned default is still the cheap tier every
  // other job ships - a comparison the operator has not tuned must not silently spend the priciest
  // one. A judging Persona's own model, or a Settings value, is what replaces it.
  assert.equal(LLM_JOB_SPECS["ensemble-comparison"].fallback, "claude-haiku-4-5");
});

test("each job reads the same env var it always did", () => {
  // The `envVar()` suffixes the original call sites passed, plus the workflow foundation's
  // append-only spelling. An operator's environment outlives any one build.
  assert.equal(LLM_JOB_SPECS["task-title"].envKey, "TASK_TITLE_MODEL");
  assert.equal(LLM_JOB_SPECS.goal.envKey, "GOAL_MODEL");
  assert.equal(LLM_JOB_SPECS["away-digest"].envKey, "AWAY_DIGEST_MODEL");
  assert.equal(LLM_JOB_SPECS["workflow-context"].envKey, "WORKFLOW_CONTEXT_MODEL");
  assert.equal(LLM_JOB_SPECS["ensemble-comparison"].envKey, "ENSEMBLE_COMPARISON_MODEL");
});

test("the env name the panel PRINTS is the one the daemon looks up", () => {
  // Two spellings of one string - `envVar(envKey)` sweeps the MISSION_/FLEET_/HARNESS_
  // chain, `spec.envVar` is what a human is told to export. Drift here means the panel
  // names a variable that does nothing. Same guard `inspector-model.test.ts` carries.
  for (const job of LLM_JOB_IDS) {
    assert.equal(LLM_JOB_SPECS[job].envVar, `MISSION_${LLM_JOB_SPECS[job].envKey}`, job);
  }
  assert.equal(LLM_RUNNER_ENV_VAR, `MISSION_${LLM_RUNNER_ENV}`);
});

test("every declared job says what it is for, which the panel renders", () => {
  for (const job of LLM_JOB_IDS) {
    const spec = LLM_JOB_SPECS[job];
    assert.ok(spec.label.trim().length > 0, `${job} has no label`);
    assert.ok(spec.blurb.trim().length > 0, `${job} has no blurb`);
    assert.ok(spec.fallback.trim().length > 0, `${job} has no shipped model`);
  }
});

test("the ladder is config, then env, then the shipped default", () => {
  assert.deepEqual(resolveLlmJobModel("goal", { goal: "cfg" }, "env"), {
    job: "goal",
    id: "cfg",
    source: "config",
    unsupported: null,
  });
  assert.deepEqual(resolveLlmJobModel("goal", {}, "env"), {
    job: "goal",
    id: "env",
    source: "env",
    unsupported: null,
  });
  assert.deepEqual(resolveLlmJobModel("goal", {}, undefined), {
    job: "goal",
    id: LLM_JOB_SPECS.goal.fallback,
    source: "default",
    unsupported: null,
  });
});

test("a cleared box falls THROUGH to the layer below, it does not spawn with no model", () => {
  // The field is free text, so clearing it commits `""`. That must mean "go back to the
  // ladder": an unset `--model` inherits whatever the CLI defaults to, which is the priciest
  // tier available and unanswerable from inside the app - never what a cleared box means.
  assert.equal(resolveLlmJobModel("goal", { goal: "" }, "env").id, "env");
  assert.equal(resolveLlmJobModel("goal", { goal: "   " }, "env").id, "env");
  assert.equal(resolveLlmJobModel("goal", { goal: "" }, "").id, LLM_JOB_SPECS.goal.fallback);
});

test("an override for a job this build does not declare is ignored, not fatal", () => {
  // The map is persisted, so a blob written by a newer build reaches an older one. Resolving
  // only the jobs actually declared is what keeps that an upgrade window rather than a crash.
  const all = resolveLlmJobModels({ "not-a-job": "whatever" }, {});
  assert.deepEqual(Object.keys(all).sort(), [...LLM_JOB_IDS].sort());
  for (const job of LLM_JOB_IDS) assert.equal(all[job].source, "default");
});

test("resolveLlmJobModels resolves each job against its OWN env value", () => {
  const all = resolveLlmJobModels({ goal: "from-config" }, { "task-title": "from-env" });
  assert.equal(all.goal.id, "from-config");
  assert.equal(all["task-title"].id, "from-env");
  assert.equal(all["away-digest"].id, LLM_JOB_SPECS["away-digest"].fallback);
  assert.equal(all["workflow-context"].id, LLM_JOB_SPECS["workflow-context"].fallback);
});

test("the runner ladder ranks config over env over the shipped default", () => {
  const runner = LLM_RUNNER_IDS[0];
  assert.deepEqual(resolveLlmRunner(runner, undefined), {
    id: runner,
    source: "config",
    unknown: null,
  });
  assert.deepEqual(resolveLlmRunner("", runner), { id: runner, source: "env", unknown: null });
  assert.deepEqual(resolveLlmRunner("", ""), {
    id: DEFAULT_LLM_RUNNER_ID,
    source: "default",
    unknown: null,
  });
});

test("a runner id this build does not have falls back AND says which one it dropped", () => {
  // The reporting is the point. Silently replacing it makes a stored id indistinguishable
  // from an unset one, and the panel would render the fallback as the operator's own pick.
  const fromConfig = resolveLlmRunner("ollama", undefined);
  assert.equal(fromConfig.id, DEFAULT_LLM_RUNNER_ID);
  assert.equal(fromConfig.source, "default");
  assert.equal(fromConfig.unknown, "ollama");

  const fromEnv = resolveLlmRunner("", "ollama");
  assert.equal(fromEnv.id, DEFAULT_LLM_RUNNER_ID);
  assert.equal(fromEnv.unknown, "ollama");
});

test("the default runner is one this build actually implements", () => {
  assert.ok(isLlmRunnerId(DEFAULT_LLM_RUNNER_ID));
  assert.ok(!isLlmRunnerId("nope"));
});
