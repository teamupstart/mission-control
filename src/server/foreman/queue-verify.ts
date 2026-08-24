import { z } from "zod";
import { buildVerifyPrompt } from "./queue-prompt.ts";
import type { VerifyInput } from "./queue-prompt.ts";
import { llmRunner, DEFAULT_LLM_RUNNER_ID } from "../llm/index.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
import { nullAsAbsent, providerJsonSchema } from "../llm/json-schema.ts";
import { parseModelJson, runStructured } from "../llm/structured.ts";
import { FOREMAN_MODEL_SPECS, resolveForemanModel } from "@shared/foreman-models.ts";
import type { QueueVerdict } from "./queue-machine.ts";

// Runs ONE work-item verification in a fresh tool-less model call, mirroring
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
 * Cap on the verdict summary - 1-2 sentences per the prompt, with room to spare.
 *
 * Unlike the gap fields this is never typed into a pane, so the bound is about
 * WEIGHT rather than injection: the summary is persisted to `last_verdict` and
 * re-served on every queue read the worker polls each tick, so an editorializing
 * verifier would otherwise ride every request for the life of the row.
 */
const SUMMARY_MAX = 2000;
/**
 * Cap on the `resolved` id list. Deliberate headroom over the ids it can meaningfully
 * name: an item carries at most MAX_GAPS gaps into a round, so anything past a
 * handful is the model listing ids that don't exist. This is a bound on weight, not a
 * rule the verdict has to satisfy.
 */
const MAX_RESOLVED = 32;

/**
 * CLAMP the model's text rather than REJECT it.
 *
 * Every bound here is a defence on text that eventually gets typed into a
 * tool-enabled agent, and truncating enforces that bound exactly as well as
 * rejecting does - while rejecting throws the whole verdict away. Zod's `.max()`
 * fails the parse, so a verifier that judged an item COMPLETE but wrote a 700-char
 * `detail` loses its verdict entirely; `runStructured` then retries the identical
 * prompt, gets the identical over-long answer, and the item escalates as "Foreman
 * could not verify this item" after six headless calls over a verbose sentence on
 * work that was actually done.
 *
 * The `detail` cap isn't even a rule the model was told: the prompt documents
 * `<= 600 chars` for `fix` alone and describes `detail` as "what is missing,
 * concretely", which invites length. Clamping gives up no protection either way -
 * `renderFixPrompt` re-sanitizes every field through a fixed template before
 * anything reaches a pane.
 */
const clampTo = (max: number) => (s: string) => (s.length > max ? s.slice(0, max) : s);

const SEVERITY_RANK: Record<string, number> = { blocking: 0, advisory: 1 };

/**
 * Make gap ids unique WITHIN one verdict, by reminting a collision rather than
 * dropping it.
 *
 * The prompt asks for "a stable slug for this problem" and nothing tells the model
 * that two gaps in one verdict can't share one - so two blocking gaps about two
 * different files both slugged `untested` is an ordinary answer, and `clampTo` can
 * additionally collapse two long distinct ids into one. Round 0 has no prior gaps to
 * reconcile against, so duplicates land in `item.gaps` as-is and everything keyed on
 * the id then quietly speaks about the wrong one: the panel renders `<li key={g.id}>`
 * and React folds both rows onto one keyed slot, so the human sees ONE gap while the
 * fix prompt (which lists by index) tells the agent to fix TWO. Strike tracking
 * collapses the same way - `byId.get` hands both duplicates the same prior, so they
 * share a count and can only ever resolve together.
 *
 * Reminting rather than keep-first because a duplicate id is a NAMING collision, not
 * a duplicate finding: the two gaps are about different files, so dropping one
 * silently discards a real blocking gap - and the model would likely re-mint the same
 * colliding slug next round, dropping it again, forever.
 *
 * Honest about what this does NOT fix: the suffix is assigned by POSITION, so if the
 * model reports the same two colliding gaps in the opposite order next round, they
 * swap ids and swap strike counts. `reconcileGaps`'s (path + detail) fingerprint does
 * not save it either - that is only consulted when the id MISSES, and here it hits,
 * wrongly. Both gaps still strike and still reach the agent, so this is the same
 * bounded imprecision the per-gap strike heuristic already documents, with
 * `maxFixRounds` as the real termination guarantee. Distinct ids are what this
 * function owes; exact strike attribution across a reorder was never on offer.
 */
function uniqueGapIds<T extends { id: string }>(gaps: T[]): T[] {
  const seen = new Set<string>();
  return gaps.map((g) => {
    if (!seen.has(g.id)) {
      seen.add(g.id);
      return g;
    }
    let n = 2;
    let id: string;
    // Re-clamped, not just suffixed: an id already at GAP_ID_MAX would otherwise
    // grow past the bound the cap exists to hold.
    do {
      const suffix = `~${n++}`;
      id = `${g.id.slice(0, GAP_ID_MAX - suffix.length)}${suffix}`;
    } while (seen.has(id));
    seen.add(id);
    return { ...g, id };
  });
}

const GapSchema = z.object({
  id: z.string().min(1).transform(clampTo(GAP_ID_MAX)),
  severity: z.enum(["blocking", "advisory"]),
  kind: z.enum(["incomplete", "untested", "standards", "regression", "unverified"]),
  // Required, so the deterministic (path + detail) fingerprint backstop for a
  // reminted gap id always has something to key on.
  path: z.string().transform(clampTo(GAP_PATH_MAX)),
  detail: z.string().min(1).transform(clampTo(GAP_TEXT_MAX)),
  fix: z.string().transform(clampTo(GAP_TEXT_MAX)),
});

export const QueueVerdictSchema = z.object({
  complete: z.boolean(),
  // Clamped, not rejected, for the reason `clampTo` documents: a verdict that judged
  // the item correctly is not worth discarding over a verbose summary.
  summary: z.string().min(1).transform(clampTo(SUMMARY_MAX)),
  // `nullAsAbsent` on all three below: the provider schema carries them as nullable
  // required keys (see `strictify`), and "no gaps", "nothing resolved" and "no confidence
  // stated" must keep meaning what they meant when the model could omit the key. Note
  // `confidence` in particular - it feeds a safety gate, so a `null` that failed the parse
  // would discard a verdict that was otherwise complete.
  gaps: nullAsAbsent(
    z
      .array(GapSchema)
      .default([])
      // Same reasoning as the text caps: a 4th gap is not worth discarding a verdict
      // over. The prompt asks for "AT MOST 3, most severe first", so honour that
      // ordering while trimming - a plain slice would let three advisory nits crowd
      // out the blocking gap that is the only kind that drives a fix round.
      //
      // Ids are made unique only AFTER the trim, so a collision with a gap that didn't
      // survive can't remint one that did.
      .transform((gaps) =>
        uniqueGapIds(
          [...gaps]
            .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
            .slice(0, MAX_GAPS),
        ),
      ),
  ),
  // Ids only ever looked up as a Set, so both bounds are cheap: clamp each to a gap
  // id's length and take the first MAX_RESOLVED. Trimming can only make the verdict
  // resolve FEWER prior gaps, which keeps them tracked for another round - the safe
  // direction, and the same reasoning the gaps cap above uses.
  resolved: nullAsAbsent(
    z.array(z.string().transform(clampTo(GAP_ID_MAX))).default([]).transform((r) => r.slice(0, MAX_RESOLVED)),
  ),
  confidence: nullAsAbsent(z.number().min(0).max(1).default(0.5)),
});
const QUEUE_VERDICT_JSON_SCHEMA = providerJsonSchema(QueueVerdictSchema);

export type QueueVerifyResult =
  | { kind: "verdict"; verdict: QueueVerdict }
  | { kind: "failed"; reason: string };

/** The verifier's default, unless overridden by config or FOREMAN_VERIFY_MODEL. */
export const DEFAULT_VERIFY_MODEL = FOREMAN_MODEL_SPECS.verify.fallback;

/** The verifier's model from config, then env, then the Opus default. */
export function verifyModel(
  cfg: { verifyModel?: string },
  /**
   * The provider this role RESOLVED to, supplied by the caller.
   *
   * Required, and not defaulted to `cfg.runner`, for the reason `model` is required on the
   * call below: the ladder now has three rungs and its bottom one - the app-wide answer -
   * sits behind an env layer this process cannot see. Re-deriving it here would make the
   * worker and the settings panel able to disagree about the very pair being spawned.
   */
  runner: LlmRunnerId,
): string {
  return resolveForemanModel("verify", cfg, process.env, runner).id;
}

/**
 * Verify one work item with fresh context; never throws.
 *
 * `model` is required and supplied by the caller - see `reviewSession` for why this is
 * a parameter rather than a lookup, and why it must not be optional.
 */
export async function verifyItem(
  input: VerifyInput,
  model: string,
  runnerId: LlmRunnerId = DEFAULT_LLM_RUNNER_ID,
): Promise<QueueVerifyResult> {
  const runner = llmRunner(runnerId);
  const r = await runStructured<typeof QueueVerdictSchema>(
    (p) =>
      runner.run(p, {
        model,
        role: "foreman:verify",
        schema: QUEUE_VERDICT_JSON_SCHEMA,
      }),
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
  return parseModelJson(raw, QueueVerdictSchema) as QueueVerdict | null;
}
