import { envVar } from "../config.ts";
import { readStandards } from "../standards.ts";
import { providerJsonSchema } from "../llm/json-schema.ts";
import { parseModelReply, runStructured } from "../llm/structured.ts";
import { readBrief } from "./brief.ts";
import { buildReviewPrompt, type ReviewPromptInput } from "./prompt.ts";
import { InspectorVerdictSchema } from "./verdict.ts";

/**
 * Cap on the diff we put in a prompt. A 2MB refactor is not reviewable in one pass anyway.
 *
 * BYTES, and `fetchDiff` applies it as such - it read as UTF-16 code units, which let a
 * diff of CJK or box-drawing content through at ~3x this.
 *
 * `INSPECTOR_MAX_DIFF_BYTES` is the documented override and is read BARE, with the
 * `MISSION_` / `FLEET_` / `HARNESS_` spellings `envVar` resolves still winning ahead of
 * it so no existing setting stops working. The bare alias is granted HERE, on this one
 * setting, and deliberately NOT added to `envVar`'s chain: that chain also serves
 * `envVar("HOME")` and `envVar("PORT")`, so a bare tier in it would let the `HOME` every
 * shell exports relocate the state directory and a stray `PORT` move the daemon off
 * 7317. This name is specific enough to carry no such collision.
 */
export function resolveMaxDiffBytes(): number {
  return Number(
    envVar("INSPECTOR_MAX_DIFF_BYTES") ?? process.env.INSPECTOR_MAX_DIFF_BYTES ?? 400_000,
  );
}
export const INSPECTOR_VERDICT_JSON_SCHEMA = providerJsonSchema(InspectorVerdictSchema);

export function runInspectorReview(
  input: Omit<ReviewPromptInput, "brief" | "standards"> & { repoRoot: string | null },
  run: (prompt: string) => Promise<string>,
) {
  const prompt = buildReviewPrompt({
    ...input,
    brief: readBrief(input.repoRoot),
    standards: readStandards(input.repoRoot, input.changedPaths),
  });
  return runStructured<typeof InspectorVerdictSchema>(
    run, prompt, raw => parseModelReply(raw, InspectorVerdictSchema), "The inspector",
  );
}
