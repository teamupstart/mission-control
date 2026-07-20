import { LLM_RUNNER_IDS } from "@shared/llm.ts";
import type { LlmRunner, LlmRunnerId } from "@shared/llm.ts";
import { claudeRunner } from "./claude.ts";

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
};

/**
 * The runner used when nothing says otherwise.
 *
 * `claude` because that is what every offline call is today, and because the CLI is
 * already installed and authenticated on any machine running this app - the caller does
 * not have to hold an API key for the app's own bookkeeping.
 */
export const DEFAULT_LLM_RUNNER_ID: LlmRunnerId = "claude";

/** The runner for an id. Total by construction - the Record cannot have a hole. */
export function llmRunner(id: LlmRunnerId = DEFAULT_LLM_RUNNER_ID): LlmRunner {
  return LLM_RUNNERS[id];
}

/** Every runner, in declaration order. For anything enumerating providers. */
export function allLlmRunners(): LlmRunner[] {
  return LLM_RUNNER_IDS.map((id) => LLM_RUNNERS[id]);
}
