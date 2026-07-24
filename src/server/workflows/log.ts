const FIELD_VALUE_LIMIT = 200;

export type WorkflowLogLevel = "info" | "warn" | "error";
const WORKFLOW_LOG_FIELDS = [
  "run",
  "submission",
  "event",
  "at",
  "compacted",
  "deleted",
  "failed",
  "error",
  "call",
  "purpose",
  "runner",
  "model",
  "attempt",
  "input_bytes",
  "output_bytes",
  "duration_ms",
  "state",
] as const;
type WorkflowLogField = (typeof WORKFLOW_LOG_FIELDS)[number];
export type WorkflowLogFields = Partial<
  Record<WorkflowLogField, string | number | boolean | null>
>;
const WORKFLOW_LOG_FIELD_SET = new Set<string>(WORKFLOW_LOG_FIELDS);

function bounded(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, FIELD_VALUE_LIMIT);
}

function fieldValue(key: string, value: string | number | boolean | null): string {
  if (value === null) return "null";
  const rendered = bounded(String(value));
  if (key === "error" && !/^[a-zA-Z0-9_.:-]{1,100}$/.test(rendered)) {
    return "classified_error";
  }
  return rendered;
}

/**
 * Structured workflow logging with an intentionally small scalar vocabulary.
 *
 * Callers pass ids, event names, counts, states and classified error codes only. Raw
 * prompts, diffs, transcripts, Persona guidance, delivery packets and model output do
 * not fit this type and must never be interpolated into a workflow log line.
 */
export function workflowLog(
  level: WorkflowLogLevel,
  fields: WorkflowLogFields,
): void {
  const line = Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean | null] =>
      WORKFLOW_LOG_FIELD_SET.has(entry[0]) && entry[1] !== undefined)
    .map(([key, value]) => `${bounded(key)}=${fieldValue(key, value)}`)
    .join(" ");
  const message = `[workflow] ${line}`;
  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  else console.info(message);
}
