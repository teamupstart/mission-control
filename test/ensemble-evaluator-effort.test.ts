import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEvaluatorExecution, type ComparativeExecutionDeps } from "../src/server/ensembles/reviews/execution.ts";
import type { EnsembleEvaluatorGuidance } from "../src/shared/ensemble.ts";
import { EnsembleEvaluatorGuidanceSchema } from "../src/shared/protocol.ts";

const deps: ComparativeExecutionDeps = {
  appRunner: { id: "claude", source: "default", unknown: null },
  personaEnvModel: null,
  jobRunner: { id: "codex", source: "config", unknown: null },
  jobModel: () => "gpt-6-luna",
  jobEffort: "high",
  effortEnabled: true,
};
const pins = { runner: null, model: null };
const builtin = { kind: "builtin", rubricId: "comparison" } satisfies EnsembleEvaluatorGuidance;
const persona = {
  kind: "persona",
  personaId: "judge",
  revision: 2,
  name: "Judge",
  guidanceMarkdown: "Check the evidence.",
  runner: "codex",
  model: "gpt-6-sol",
  effort: "low",
} satisfies EnsembleEvaluatorGuidance;

test("ensemble effort uses the background job unless the pinned Persona supplied an effort", () => {
  assert.deepEqual(resolveEvaluatorExecution(builtin, pins, deps), {
    runnerId: "codex", modelId: "gpt-6-luna", unknownRunner: null, effort: "high",
  });
  assert.deepEqual(resolveEvaluatorExecution(EnsembleEvaluatorGuidanceSchema.parse(persona), pins, deps), {
    runnerId: "codex", modelId: "gpt-6-sol", unknownRunner: null, effort: "low",
  });
  assert.equal(resolveEvaluatorExecution(builtin, pins, { ...deps, effortEnabled: false }).effort, undefined);
  assert.equal(resolveEvaluatorExecution({ ...persona, effort: "max", model: "gpt-5.6-test" }, pins, deps).effort, undefined);
});
