import { envVar } from "@shared/harness-runtime.mjs";
import { LLM_JOB_IDS, LLM_JOB_SPECS, resolveLlmJobModels } from "@shared/llm-jobs.ts";
import type { LlmJobId } from "@shared/llm-jobs.ts";
import type { LlmConfig } from "@shared/protocol.ts";
import type { ResolvedLlmRunner } from "@shared/llm.ts";
import type { LlmStatus } from "@shared/types.ts";
import {
  claudeTransportChoice,
  codexTransportChoice,
  getLlmConfig,
  llmJobRunner,
  llmRunnerChoice,
} from "./config.ts";
import { allLlmRunners } from "./index.ts";

// What the app's offline work will actually spawn as, assembled for the one route that
// reports it.
//
// Split from `config.ts` because of the LAST import below. `allLlmRunners()` reaches every
// provider adapter, and one of them freezes `MISSION_CLAUDE_BIN` at module load - so anything
// that merely wants to RESOLVE a preference (the Inspector's config, Foreman's, and through
// `settings-status.ts` the registry itself) would have loaded a spawner to do it. The route
// genuinely needs the adapters, because a provider's human-facing label lives on its
// implementation and the browser cannot import one. Nothing else does.

/** Every job at once, plus the runner, Claude transport and available providers. */
export function llmStatus(cfg: LlmConfig = getLlmConfig()): LlmStatus {
  const envValues = Object.fromEntries(
    LLM_JOB_IDS.map((job) => [job, envVar(LLM_JOB_SPECS[job].envKey)]),
  ) as Partial<Record<LlmJobId, string | undefined>>;
  return {
    runner: llmRunnerChoice(cfg),
    // Foreman reads this resolved value over HTTP. It cannot read app_config, and resolving
    // only from its own environment would let the daemon and worker disagree about a stored
    // choice until one of them restarted.
    claudeTransport: claudeTransportChoice(cfg),
    codexTransport: codexTransportChoice(cfg),
    // Each job against ITS provider, which is no longer one answer for all five.
    models: resolveLlmJobModels(cfg.models, envValues, (job) => llmJobRunner(job, cfg).id),
    // Beside the models rather than folded into them: a row prints the provider and the
    // model as two controls, and the provider carries its own source and `unknown`.
    jobRunners: Object.fromEntries(
      LLM_JOB_IDS.map((job) => [job, llmJobRunner(job, cfg)]),
    ) as Record<LlmJobId, ResolvedLlmRunner>,
    // Ids AND labels, because a label lives on the implementation and the browser cannot
    // import one - see `LlmStatus.runners`.
    runners: allLlmRunners().map((r) => ({ id: r.id, label: r.label })),
  };
}
