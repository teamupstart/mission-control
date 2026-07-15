import { z } from "zod";
import { buildVerifyPrompt } from "./queue-prompt.ts";
import type { VerifyInput } from "./queue-prompt.ts";
import { runStructured } from "./structured.ts";
import type { QueueVerdict } from "./queue-machine.ts";

// Runs ONE work-item verification in a fresh tool-less `claude -p`, mirroring
// review.ts exactly. It NEVER throws: the {verdict | failed} split is the contract
// that separates "the model judged" from "the infra blipped", and the queue treats
// those completely differently - a verdict advances the item, a failure must not.

/** Hard cap on gap text, enforced in the schema rather than trusted from the model.
 *  This text gets TYPED INTO a tool-enabled agent, so the bound is a defence. */
const GAP_TEXT_MAX = 600;
/** At most 3 gaps per round: a fix prompt the agent can actually act on. */
const MAX_GAPS = 3;
/** Cap on a gap id - long enough for a descriptive slug, short enough to log. */
const GAP_ID_MAX = 120;
/** Cap on a reported path. */
const GAP_PATH_MAX = 400;

/**
 * CLAMP the model's text rather than REJECT it.
 *
 * Every bound here is a defence on text that eventually gets typed into a
 * tool-enabled agent, and truncating enforces that bound exactly as well as
 * rejecting does - while rejecting throws the whole verdict away. Zod's `.max()`
 * fails the parse, so a verifier that judged an item COMPLETE but wrote a 700-char
 * `detail` loses its verdict entirely; `runStructured` then retries the identical
 * prompt, gets the identical over-long answer, and the item escalates as "Foreman
 * could not verify this item" after six `claude -p` spawns - over a verbose
 * sentence, on work that was actually done.
 *
 * The `detail` cap isn't even a rule the model was told: the prompt documents
 * `<= 600 chars` for `fix` alone and describes `detail` as "what is missing,
 * concretely", which invites length. Clamping gives up no protection either way -
 * `renderFixPrompt` re-sanitizes every field through a fixed template before
 * anything reaches a pane.
 */
const clampTo = (max: number) => (s: string) => (s.length > max ? s.slice(0, max) : s);

const SEVERITY_RANK: Record<string, number> = { blocking: 0, advisory: 1 };

const GapSchema = z.object({
  id: z.string().min(1).transform(clampTo(GAP_ID_MAX)),
  severity: z.enum(["blocking", "advisory"]),
  kind: z.enum(["incomplete", "untested", "standards", "regression"]),
  // Required, so the deterministic (path + detail) fingerprint backstop for a
  // reminted gap id always has something to key on.
  path: z.string().transform(clampTo(GAP_PATH_MAX)),
  detail: z.string().min(1).transform(clampTo(GAP_TEXT_MAX)),
  fix: z.string().transform(clampTo(GAP_TEXT_MAX)),
});

export const QueueVerdictSchema = z.object({
  complete: z.boolean(),
  summary: z.string().min(1),
  gaps: z
    .array(GapSchema)
    .default([])
    // Same reasoning as the text caps: a 4th gap is not worth discarding a verdict
    // over. The prompt asks for "AT MOST 3, most severe first", so honour that
    // ordering while trimming - a plain slice would let three advisory nits crowd
    // out the blocking gap that is the only kind that drives a fix round.
    .transform((gaps) =>
      [...gaps]
        .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
        .slice(0, MAX_GAPS),
    ),
  resolved: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type QueueVerifyResult =
  | { kind: "verdict"; verdict: QueueVerdict }
  | { kind: "failed"; reason: string };

/** Verify one work item in a fresh process; never throws. */
export async function verifyItem(input: VerifyInput): Promise<QueueVerifyResult> {
  const r = await runStructured<typeof QueueVerdictSchema>(
    buildVerifyPrompt(input),
    extractQueueVerdict,
    "Foreman verify",
  );
  return r.kind === "ok"
    ? { kind: "verdict", verdict: r.value as QueueVerdict }
    : { kind: "failed", reason: r.reason };
}

/**
 * Pull a valid QueueVerdict out of a reviewer's raw stdout. Handles the
 * `claude -p` JSON envelope (`{ result: "<text>" }`), markdown-fenced JSON, or a
 * bare object, trying each candidate against the schema. Returns null when none
 * validate. Pure, exported for tests.
 */
export function extractQueueVerdict(raw: string): QueueVerdict | null {
  for (const candidate of jsonCandidates(resultText(raw))) {
    let obj: unknown;
    try {
      obj = JSON.parse(candidate);
    } catch {
      continue;
    }
    const r = QueueVerdictSchema.safeParse(obj);
    if (r.success) return r.data as QueueVerdict;
  }
  return null;
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
