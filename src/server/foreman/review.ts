import { buildReviewPrompt } from "./prompt.ts";
import type { ReviewInput } from "./prompt.ts";
import { llmRunner, DEFAULT_LLM_RUNNER_ID } from "../llm/index.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
import { parseModelJson, runStructured } from "../llm/structured.ts";
import { VerdictSchema } from "./verdict.ts";
import type { Verdict } from "./verdict.ts";
import { FOREMAN_MODEL_SPECS, resolveForemanModel } from "@shared/foreman-models.ts";

// Foreman's triage review: judge ONE session's pending question. A thin caller
// over runStructured, which owns the fresh tool-less `claude -p` process (so every
// session starts from a clean context), its detached group, its timeout, and the
// parse-miss retry. Its stdout is a JSON envelope whose `result` holds the model's
// text, from which we extract + validate the structured verdict.

/**
 * The result of one review: either a model-produced verdict (success - including a
 * legitimate action:"skip") or a transient failure (a spawn/timeout/exit error, or
 * a parse miss after the retry). The worker treats these differently: a genuine
 * verdict is stamped as handled, but a failure must NOT permanently stamp the
 * prompt's marker, or a single infra blip would abandon the queue item for good.
 */
export type ReviewResult =
  | { kind: "verdict"; verdict: Verdict }
  | { kind: "failed"; reason: string };

/** The reviewer's default, unless overridden by config or FOREMAN_REVIEW_MODEL. */
export const DEFAULT_REVIEW_MODEL = FOREMAN_MODEL_SPECS.review.fallback;

/** The reviewer's model from config, then env, then the Opus default. */
export function reviewModel(cfg: { reviewModel?: string; runner?: LlmRunnerId }): string {
  return resolveForemanModel("review", cfg, process.env, cfg.runner ?? "claude").id;
}

/**
 * Review one session in a fresh process; never throws (returns `failed` instead).
 *
 * `model` is REQUIRED, and passed rather than resolved here, for the same reason
 * `planBacklog` takes one: this module is the prompt-and-parse half, and the config that
 * decides the model lives with the caller. It used to be omitted entirely, which meant
 * `runClaudeText` left `--model` off and the reviewer silently ran as whatever the CLI
 * was logged in as - the behaviour `reviewModel` exists to replace. Making it a required
 * parameter is what stops a future call site quietly re-acquiring that default.
 */
export async function reviewSession(
  input: ReviewInput,
  model: string,
  runnerId: LlmRunnerId = DEFAULT_LLM_RUNNER_ID,
): Promise<ReviewResult> {
  const r = await runStructured<typeof VerdictSchema>(
    (p) => llmRunner(runnerId).run(p, { model, role: "foreman:review" }),
    buildReviewPrompt(input),
    extractVerdict,
    "Foreman review",
  );
  return r.kind === "ok" ? { kind: "verdict", verdict: r.value } : { kind: "failed", reason: r.reason };
}

/** Pull a valid Verdict out of a reviewer's raw stdout. Pure, exported for tests. */
export function extractVerdict(raw: string): Verdict | null {
  return parseModelJson(raw, VerdictSchema);
}
