import { z } from "zod";
import { LLM_RUNNER_IDS } from "./llm.ts";

export const FOREMAN_HEALTH_OPERATIONS = [
  "review", "verify", "triage", "backlog", "ship-recovery", "daemon", "snapshot",
  "autopilot", "pipeline", "followup", "session", "instructions",
] as const;
export type ForemanHealthOperation = typeof FOREMAN_HEALTH_OPERATIONS[number];
export const FOREMAN_HEALTH_LABELS: Record<ForemanHealthOperation, string> = {
  review: "Review", verify: "Verification", triage: "Cheap tier", backlog: "Dependency planner",
  "ship-recovery": "Ship recovery", daemon: "Daemon connection", snapshot: "Session snapshot",
  autopilot: "Backlog autopilot", pipeline: "Pipeline triage", followup: "PR follow-through",
  session: "Session processing", instructions: "Standing instructions",
};
export const FOREMAN_HEALTH_MAX_ISSUES = 12;
export const FOREMAN_HEALTH_MAX_SESSIONS = 20;
export const FOREMAN_HEALTH_ERROR_LENGTH = 600;

/** Bounded, plain-text diagnostics. Redact before truncating so a cut token cannot leak. */
export function foremanErrorText(value: unknown): string {
  return String(value)
    // oxlint-disable-next-line eslint/no-control-regex -- Strip terminal escape sequences from diagnostics.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[\w.+/=-]+/gi, "$1 [redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|secret)["']?\s*[:=]\s*)["']?[^\s,;"'}]+["']?/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, "$1?[redacted]")
    // oxlint-disable-next-line eslint/no-control-regex -- Diagnostics must contain no control bytes.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, FOREMAN_HEALTH_ERROR_LENGTH) || "Unknown Foreman error";
}

export const ForemanHealthIssueSchema = z.object({
  id: z.string().min(1).max(80),
  operation: z.enum(FOREMAN_HEALTH_OPERATIONS),
  runner: z.enum(LLM_RUNNER_IDS).nullable(),
  model: z.string().min(1).max(200).nullable(),
  error: z.string().min(1).max(FOREMAN_HEALTH_ERROR_LENGTH).transform(foremanErrorText),
  count: z.number().int().min(1).max(1_000_000),
  firstSeenAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  sessions: z.array(z.object({
    id: z.string().min(1).max(200),
    name: z.string().max(160),
  })).max(FOREMAN_HEALTH_MAX_SESSIONS),
  sessionsTruncated: z.boolean(),
});
export type ForemanHealthIssue = z.infer<typeof ForemanHealthIssueSchema>;

/** Process-local health, bounded to 12 groups with at most 20 session references each. */
export const ForemanHealthSnapshotSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  issues: z.array(ForemanHealthIssueSchema).max(FOREMAN_HEALTH_MAX_ISSUES),
  truncated: z.boolean(),
}).superRefine((value, ctx) => {
  if (new Set(value.issues.map((issue) => issue.id)).size !== value.issues.length) {
    ctx.addIssue({ code: "custom", message: "Issue ids must be unique" });
  }
  if (value.issues.some((issue) => issue.lastSeenAt < issue.firstSeenAt)) {
    ctx.addIssue({ code: "custom", message: "Last occurrence must follow the first" });
  }
});
export type ForemanHealthSnapshot = z.infer<typeof ForemanHealthSnapshotSchema>;
export const ForemanHealthReportSchema = z.object({
  workerId: z.string().min(1).max(256),
  health: ForemanHealthSnapshotSchema,
});
export type ForemanHealthReport = z.infer<typeof ForemanHealthReportSchema>;
export interface ForemanHealthStatus extends ForemanHealthSnapshot {
  reportedAt: number;
  /** False when the snapshot belongs to a stopped/replaced worker or reporting is stale. */
  current: boolean;
}
