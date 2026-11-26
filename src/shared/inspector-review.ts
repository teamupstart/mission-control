import { z } from "zod";
import { INSPECTOR_SEVERITIES } from "./types.ts";
export { INSPECTOR_SEVERITIES } from "./types.ts";

function nullAsAbsent<S extends z.ZodType>(schema: S) {
  return z.preprocess((value) => value === null ? undefined : value, schema);
}

/** Clamp rather than reject: a verbose sentence must not discard a good review. */
const clampTo =
  (max: number) =>
  (s: string): string =>
    s.length > max ? s.slice(0, max) : s;

export const DEFAULT_LOCAL_INSPECTOR_SEVERITY = "major" as const;

export const InspectorVerdictSchema = z.object({
  summary: z.preprocess((v) => (typeof v === "string" ? clampTo(4000)(v) : v), z.string()),
  // `nullAsAbsent` because the provider schema carries this as a nullable required key:
  // "I found nothing" is a verdict the model must still be able to state, and under strict
  // Structured Outputs it states it with `null` rather than by omitting the key. Reading
  // that back as absence keeps `.default([])` - and so the `clean: true` below - intact.
  findings: nullAsAbsent(
    z
      .array(
        z.object({
          path: z.string().min(1),
          // The model is asked for the NEW-file line. Null is honest and useful ("this
          // is about the file, not a line"); a made-up number is not, so nullable rather
          // than required.
          line: z.number().int().positive().nullable().default(null),
          severity: z.enum(INSPECTOR_SEVERITIES),
          // Short, because it is half the fingerprint - a title that runs to a paragraph
          // makes the issue's identity unstable across rounds.
          title: z.preprocess(
            (v) => (typeof v === "string" ? clampTo(120)(v) : v),
            z.string().min(1),
          ),
          body: z.preprocess(
            (v) => (typeof v === "string" ? clampTo(4000)(v) : v),
            z.string().min(1),
          ),
        }),
      )
      .max(50)
      .default([]),
  ),
  /**
   * Fingerprints of previously-raised findings this push has addressed.
   *
   * Model-supplied, and the only model-supplied thing that closes a thread - which is
   * why the planner treats it as strictly narrowing: it can close a thread we own and
   * already told the model about, and it can do nothing else.
   *
   * `nullAsAbsent` keeps that narrowing fail-closed under a strict provider schema, where
   * the key is always present: `null` closes nothing, exactly as omitting it did.
   */
  resolved: nullAsAbsent(z.array(z.string()).max(50).default([])),
});
export type InspectorVerdict = z.infer<typeof InspectorVerdictSchema>;

export const LocalInspectorFindingSchema = z.object({
  fingerprint: z.string(),
  path: z.string(),
  line: z.number().int().positive().nullable(),
  severity: z.enum(INSPECTOR_SEVERITIES),
  title: z.string(),
  body: z.string(),
});

export const LocalInspectorReviewSchema = z.object({
  status: z.enum(["passed", "failed", "skipped", "blocked"]),
  publicationTree: z.string().nullable(),
  baseRef: z.string().nullable(),
  mergeBase: z.string().nullable(),
  blockingSeverity: z.enum(INSPECTOR_SEVERITIES),
  findingCount: z.number().int().nonnegative(),
});

export type LocalInspectorFinding = z.infer<typeof LocalInspectorFindingSchema>;
export type LocalInspectorReview = z.infer<typeof LocalInspectorReviewSchema>;
