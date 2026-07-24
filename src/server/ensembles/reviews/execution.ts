import { resolveLlmRunner, type LlmRunnerId, type ResolvedLlmRunner } from "@shared/llm.ts";
import { resolveModelChoice } from "@shared/model-choice.ts";
import { providerModelDefault } from "@shared/model.ts";
import { WORKFLOW_PERSONA_MODEL_SPEC } from "@shared/workflow.ts";
import type { EnsembleEvaluatorGuidance, EnsembleEvaluatorPolicy } from "@shared/ensemble.ts";
import type { ReviewExecution } from "./types.ts";

/**
 * Which runner and model judge one comparison, resolved at attempt time.
 *
 * This is `resolvePersonaExecution`'s ladder, deliberately re-expressed here from the same shared
 * helpers rather than imported from the Workflow module - the ensemble review path must not pull
 * the Workflow store into its graph, and the plan's rule is that the two SEMANTICS match, not that
 * the two modules couple. The precedence:
 *
 *  1. An explicit runner/model override wins - either the evaluator policy's own pin, or, absent
 *     that, the snapshotted Persona's overrides - resolved with the balanced Persona fallback.
 *  2. Otherwise the app runner plus the `ensemble-comparison` job model, whose own ladder is the
 *     daemon's config -> env -> shipped-default one.
 *
 * An unresolvable configured runner is reported through `unknownRunner`, never swallowed, so the
 * panel can render the fallback as a fallback and not as the operator's own choice.
 */
export interface ComparativeExecutionDeps {
  /** The app-wide resolved runner (config -> env -> default), read once per attempt. */
  appRunner: ResolvedLlmRunner;
  /** The env override for a Persona's model (MISSION_WORKFLOW_PERSONA_MODEL), or null. */
  personaEnvModel: string | null;
  /** The `ensemble-comparison` job model, resolved for whichever runner ends up chosen. */
  jobModel(runnerId: LlmRunnerId): string;
}

export function resolveComparativeExecution(
  guidance: EnsembleEvaluatorGuidance,
  policy: EnsembleEvaluatorPolicy,
  deps: ComparativeExecutionDeps,
): ReviewExecution {
  const explicitRunner = policy.runner ?? (guidance.kind === "persona" ? guidance.runner : null);
  const explicitModel = policy.model ?? (guidance.kind === "persona" ? guidance.model : null);
  if (explicitRunner !== null || explicitModel !== null) {
    const runner = explicitRunner === null ? deps.appRunner : resolveLlmRunner(explicitRunner, undefined);
    const model = resolveModelChoice(
      { ...WORKFLOW_PERSONA_MODEL_SPEC, fallback: providerModelDefault(runner.id, "balanced") },
      explicitModel,
      deps.personaEnvModel,
    );
    return { runnerId: runner.id, modelId: model.id, unknownRunner: runner.unknown };
  }
  return {
    runnerId: deps.appRunner.id,
    modelId: deps.jobModel(deps.appRunner.id),
    unknownRunner: deps.appRunner.unknown,
  };
}
