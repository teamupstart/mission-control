import type { z } from "zod";
import { buildReviewPrompt } from "./prompt.ts";
import type { ReviewInput } from "./prompt.ts";
import { runStructured } from "../claude-cli.ts";
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

/**
 * Pull a schema-valid object out of a `claude -p` reviewer's raw stdout. Handles the
 * JSON envelope (`{ result: "<text>" }`), markdown-fenced JSON, or a bare object,
 * trying each candidate against the schema. Returns null when none validate. Pure,
 * exported so the Tier 1 triage parses its own (different) schema the same way.
 */
export function parseModelJson<T extends z.ZodTypeAny>(raw: string, schema: T): z.infer<T> | null {
  const text = resultText(raw);
  for (const candidate of jsonCandidates(text)) {
    let obj: unknown;
    try {
      obj = JSON.parse(candidate);
    } catch {
      continue;
    }
    const r = schema.safeParse(obj);
    if (r.success) return r.data;
  }
  return null;
}

/** Pull a valid Verdict out of a reviewer's raw stdout. Pure, exported for tests. */
export function extractVerdict(raw: string): Verdict | null {
  return parseModelJson(raw, VerdictSchema);
}

/** Unwrap the `claude -p --output-format json` envelope to its `result` text. */
function resultText(raw: string): string {
  const trimmed = raw.trim();
  try {
    const env = JSON.parse(trimmed) as { result?: unknown };
    if (env && typeof env === "object" && typeof env.result === "string") return env.result;
  } catch {
    // not an envelope - the raw output is the text
  }
  return trimmed;
}

/** Candidate JSON strings to try, most-specific first. */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) out.push(m[1]!.trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) out.push(text.slice(first, last + 1));
  out.push(text.trim());
  return out;
}
