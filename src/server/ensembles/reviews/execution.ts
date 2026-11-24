import { resolveLlmEffort, resolveLlmRunner, type LlmRunnerId, type ResolvedLlmRunner } from "@shared/llm.ts";
import { resolveModelChoice } from "@shared/model-choice.ts";
import { providerModelDefault } from "@shared/model.ts";
import { WORKFLOW_PERSONA_MODEL_SPEC } from "@shared/workflow.ts";
import type { ThinkingLevel } from "@shared/types.ts";
import type { EnsembleEvaluatorGuidance } from "@shared/ensemble.ts";
import type { ReviewExecution, ReviewExecutionPins } from "./types.ts";

/**
 * Which runner and model judge one evaluator call, resolved at attempt time.
 *
 * This is `resolvePersonaExecution`'s ladder, deliberately re-expressed here from the same shared
 * helpers rather than imported from the Workflow module - the ensemble review path must not pull
 * the Workflow store into its graph, and the plan's rule is that the two SEMANTICS match, not that
 * the two modules couple. The precedence:
 *
 *  1. An explicit runner/model override wins - either the caller's own pin, or, absent that, the
 *     snapshotted Persona's overrides - resolved with the balanced Persona fallback.
 *  2. Otherwise the `ensemble-comparison` job provider and model, whose ladder is the
 *     daemon's config -> env -> shipped-default one.
 *
 * It takes the PINS rather than the evaluator policy, and that is what lets it serve a panel: a
 * comparative policy carries one runner/model pair and a panel carries one per judge, so a
 * resolver that read the policy would have had to know which arm of the union it was holding to
 * answer a question that is the same either way. Ownership of the ladder stays here.
 *
 * An unresolvable configured runner is reported through `unknownRunner`, never swallowed, so the
 * settings panel can render the fallback as a fallback and not as the operator's own choice.
 */
export interface ComparativeExecutionDeps {
  /** The app-wide resolved runner (config -> env -> default), read once per attempt. */
  appRunner: ResolvedLlmRunner;
  /** The env override for a Persona's model (MISSION_WORKFLOW_PERSONA_MODEL), or null. */
  personaEnvModel: string | null;
  /** The `ensemble-comparison` job model, resolved for whichever runner ends up chosen. */
  jobModel(runnerId: LlmRunnerId): string;
  jobRunner: ResolvedLlmRunner;
  effortEnabled: boolean;
  jobEffort?: ThinkingLevel | null;
}

export function resolveEvaluatorExecution(
  guidance: EnsembleEvaluatorGuidance,
  pins: ReviewExecutionPins,
  deps: ComparativeExecutionDeps,
): ReviewExecution {
  const explicitRunner = pins.runner ?? (guidance.kind === "persona" ? guidance.runner : null);
  const explicitModel = pins.model ?? (guidance.kind === "persona" ? guidance.model : null);
  const pinned = explicitRunner !== null || explicitModel !== null;
  const runner = explicitRunner !== null
    ? resolveLlmRunner(explicitRunner, undefined)
    : pinned ? deps.appRunner : deps.jobRunner;
  const modelId = pinned
    ? resolveModelChoice(
        { ...WORKFLOW_PERSONA_MODEL_SPEC, fallback: providerModelDefault(runner.id, "balanced") },
        explicitModel,
        deps.personaEnvModel,
      ).id
    : deps.jobModel(runner.id);
  const personaEffort = guidance.kind === "persona" ? guidance.effort : undefined;
  const effort = deps.effortEnabled
    ? resolveLlmEffort(runner.id, modelId, personaEffort ?? deps.jobEffort).level
    : null;
  return {
    runnerId: runner.id,
    modelId,
    unknownRunner: runner.unknown,
    ...(effort && { effort }),
  };
}
