import { buildReviewPrompt } from "./prompt.ts";
import type { ReviewInput } from "./prompt.ts";
import { parseModelJson, runStructured } from "../claude-cli.ts";
import { VerdictSchema } from "./verdict.ts";
import type { Verdict } from "./verdict.ts";

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

/** Review one session in a fresh process; never throws (returns `failed` instead). */
export async function reviewSession(input: ReviewInput): Promise<ReviewResult> {
  const r = await runStructured<typeof VerdictSchema>(
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
