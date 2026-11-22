import { appendFileSync, copyFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "@shared/harness-runtime.mjs";
import type { PromptedCompletionOutcome } from "@shared/types.ts";

/**
 * A durable, one-line record of every prompted completion Foreman decided.
 *
 * WHY THIS EXISTS. A completion decision lives in exactly one durable place, the queue row's
 * `promptedDecision`, and that is a current-state projection: the next completed work cycle
 * replaces it. The packaged app also starts the worker with its own output discarded
 * (`captureChildOutput: false` in `src/main/foreman.ts`), so the worker's `[foreman]` lines
 * reach no file. Together that meant a plan task Foreman held at completion left no trace of
 * WHY once its next turn finished - the investigation behind this module had to infer the hold
 * by elimination.
 *
 * WHAT IT WRITES, AND WHAT IT DOES NOT. Only the decision itself: when, which session and
 * task kind, which generation and intent episode, the outcome, the blocking gap ids with their
 * kind, a claimed run id, and the verifier's summary clamped to one short line. Never the gap
 * details, the transcript, the diff, or the prompt. That keeps the deliberately quiet worker
 * output quiet: this is an audit line per decision, not a stream.
 *
 * It shares `foreman.log` with the supervisor's lifecycle lines, so the file finally answers
 * the question an operator opens it with. Both writers append, which is safe for whole lines.
 */

/** The one name the supervisor and this record agree on. */
export const FOREMAN_LOG_NAME = "foreman.log";
/**
 * Rotate past this size, keeping one previous file. A decision is roughly 300 bytes and there
 * is one per completed turn, so this holds weeks of heavy use while bounding the file forever.
 */
export const FOREMAN_LOG_MAX_BYTES = 5 * 1024 * 1024;
const SUMMARY_MAX = 400;
const NAME_MAX = 80;

export function foremanLogPath(dir: string = stateDir()): string {
  return join(dir, FOREMAN_LOG_NAME);
}

export interface CompletionDecisionRecord {
  at: number;
  sessionId: string;
  sessionName: string;
  taskKind: string | null;
  generation: number;
  episodeKey: string;
  outcome: PromptedCompletionOutcome;
  summary: string;
  gaps: readonly { id: string; kind?: string }[];
  /** The workflow run a `workflow_claimed` decision started. */
  runId?: string;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A gap id is a verifier-chosen slug; keep it one token so the list stays parseable. */
function token(text: string): string {
  return text.replace(/[\s,=]+/g, "-");
}

export function formatCompletionDecision(record: CompletionDecisionRecord): string {
  const fields = [
    new Date(record.at).toISOString(),
    "[foreman] completion",
    `outcome=${record.outcome}`,
    `session=${token(record.sessionId)}`,
    `name=${JSON.stringify(oneLine(record.sessionName, NAME_MAX))}`,
    `task=${token(record.taskKind ?? "none")}`,
    `generation=${record.generation}`,
    `episode=${token(record.episodeKey)}`,
  ];
  if (record.runId) fields.push(`run=${token(record.runId)}`);
  if (record.gaps.length > 0) {
    fields.push(`gaps=${record.gaps.map((gap) => gap.kind ? `${token(gap.id)}:${token(gap.kind)}` : token(gap.id)).join(",")}`);
  }
  const summary = oneLine(record.summary, SUMMARY_MAX);
  if (summary) fields.push(`summary=${JSON.stringify(summary)}`);
  return fields.join(" ");
}

/**
 * Append one decision. Never throws: the generation is already consumed when this runs, and a
 * lost audit line must not turn into a failed tick that the loop would treat as no progress.
 *
 * ROTATION COPIES, THEN TRUNCATES IN PLACE - it never renames. The Electron supervisor holds
 * `foreman.log` open for its whole process life (`openPrivateUtilityLog`, mode `"a"`). A rename
 * would carry that open handle off with the old file: after one rotation its lifecycle lines
 * land in `.1`, and after the next one `.1` is replaced and they reach no path at all.
 * Truncating keeps the same file, and because the supervisor appends with `O_APPEND`, its next
 * write lands at the new end rather than leaving a gap. The cost is a window of microseconds
 * between the copy and the truncate in which a supervisor line could be dropped; the supervisor
 * writes only at worker start and stop, so that is the trade taken.
 */
export function recordCompletionDecision(
  record: CompletionDecisionRecord,
  path: string = foremanLogPath(),
): void {
  try {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    if (size >= FOREMAN_LOG_MAX_BYTES) {
      copyFileSync(path, `${path}.1`);
      truncateSync(path, 0);
    }
    appendFileSync(path, `${formatCompletionDecision(record)}\n`, { mode: 0o600 });
  } catch {
    // An unwritable state directory costs the audit line, never the decision.
  }
}
