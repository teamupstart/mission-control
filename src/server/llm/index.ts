import { DEFAULT_LLM_RUNNER_ID, LLM_RUNNER_IDS } from "@shared/llm.ts";
import type { LlmRunner, LlmRunnerId } from "@shared/llm.ts";
import { claudeRunner } from "./claude.ts";
import { codexRunner } from "./codex.ts";

// The registry of offline model providers. Extend this; do not start a parallel list.
//
// `Record<LlmRunnerId, LlmRunner>` is the whole enforcement mechanism, the same one
// `SESSION_FIELD_COMPARATORS` uses for a new `Session` field: adding an id to
// `LLM_RUNNER_IDS` and stopping there does not compile. Every capability then has to be
// either implemented or explicitly declared `null`, so "I forgot tool grants existed"
// stops being a possible outcome for the next provider.
//
// Server-side, while the interface itself is in `@shared/llm.ts`, because a runner spawns
// processes and the web bundle must not import one. The panel needs the ids and the
// labels; it does not need the implementations.

export const LLM_RUNNERS: Record<LlmRunnerId, LlmRunner> = {
  claude: claudeRunner,
  codex: codexRunner,
};

/**
 * The default runner id is `@shared/llm.ts`'s, not this module's, and re-exported here so
 * a server call site holding the registry still reads it off one import.
 *
 * It had to move: the ladder that ranks config over env over default (`resolveLlmRunner`)
 * is read by the browser too, which cannot import a runner whose implementation spawns
 * processes.
 */
export { DEFAULT_LLM_RUNNER_ID };

/** The runner for an id. Total by construction - the Record cannot have a hole. */
export function llmRunner(id: LlmRunnerId = DEFAULT_LLM_RUNNER_ID): LlmRunner {
  return LLM_RUNNERS[id];
}

/** Every runner, in declaration order. For anything enumerating providers. */
export function allLlmRunners(): LlmRunner[] {
  return LLM_RUNNER_IDS.map((id) => LLM_RUNNERS[id]);
}

/**
 * Kill every live run, across every runner.
 *
 * Through the registry rather than one provider's own kill, because the daemon's background
 * jobs spawn through whichever runner is configured: a shutdown that knew only how to kill
 * Claude's print transport would leave SDK queries or another provider's children running.
 * `killLiveRuns` is required
 * on `LlmRunner` (never optional) for exactly this call - these children are deliberately
 * detached, so they OUTLIVE the process that started them and go on burning tokens to
 * nowhere. A runner that leaves nothing behind implements it as a no-op and says so.
 */
export function killLiveLlmRuns(): void {
  for (const id of LLM_RUNNER_IDS) LLM_RUNNERS[id].killLiveRuns();
}
