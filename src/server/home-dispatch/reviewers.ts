import { AGENT_IDENTITY } from "@shared/agent.ts";
import type { HomeDispatchReviewer, ReviewerFailureClass } from "@shared/home-dispatch.ts";
import type { WorkflowLlmCallState } from "@shared/workflow.ts";
import { openDb } from "../db.ts";

// Owner: P4. What the inbox reads from a workflow run's own rows (spec 7.7, 7.25): the reviewer
// calls of its current round, and its check nodes. Both are plain reads of records the engine
// already writes, so reading the inbox records nothing.

interface RoundAttemptRow {
  id: string;
  node_id: string;
  state: string;
  persona_snapshot_json: string | null;
  session_action_snapshot_json: string | null;
  runner_id: string | null;
  model_id: string | null;
}

interface CallRow {
  node_attempt_id: string | null;
  runner_id: string;
  model_id: string;
  attempt: number;
  state: WorkflowLlmCallState;
  started_at: number;
  finished_at: number | null;
  error_code: string | null;
}

/** The latest submission of a run: its highest round, then its highest segment. */
function currentSubmissionId(runId: string): string | null {
  const row = openDb()
    .prepare(`SELECT id FROM workflow_submissions WHERE run_id = ? ORDER BY round DESC, segment DESC, created_at DESC LIMIT 1`)
    .get(runId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * The submission's node attempts, one per node: its latest attempt, in the order the nodes first
 * appeared. A node that failed and was retried is one row showing its retry, never two.
 */
function attemptsOf(submissionId: string): RoundAttemptRow[] {
  const rows = openDb()
    .prepare(
      `SELECT id, node_id, state, persona_snapshot_json, session_action_snapshot_json, runner_id, model_id
         FROM workflow_node_attempts WHERE submission_id = ? ORDER BY node_id ASC, attempt ASC`,
    )
    .all(submissionId) as unknown as RoundAttemptRow[];
  const latest = new Map<string, RoundAttemptRow>();
  for (const row of rows) latest.set(row.node_id, row);
  // Back to creation order, which is the workflow's reviewer order.
  const order = openDb()
    .prepare(`SELECT node_id, MIN(rowid) AS first FROM workflow_node_attempts WHERE submission_id = ? GROUP BY node_id ORDER BY first ASC`)
    .all(submissionId) as unknown as { node_id: string }[];
  return order.map((o) => latest.get(o.node_id)!);
}

function personaName(json: string | null, fallback: string): string {
  if (!json) return fallback;
  try {
    const name = (JSON.parse(json) as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Sorts a failed reviewer call into one of the six classes. The call stores only an error code and
 * (in the attempt) a message, so this matches the words the engine and the agent runners use. An
 * unmatched failure is `other`: it is never guessed into a more specific class.
 */
export function reviewerFailureClass(errorCode: string | null): ReviewerFailureClass {
  const code = (errorCode ?? "").toLowerCase();
  if (/not[ _-]?found|not[ _-]?installed|enoent|missing[ _-]?binary/.test(code)) return "not-installed";
  if (/signed[ _-]?out|not[ _-]?logged|unauthori[sz]ed|login|auth/.test(code)) return "signed-out";
  if (/model/.test(code)) return "model-unavailable";
  if (/timeout|timed[ _-]?out/.test(code)) return "timeout";
  if (/provider|rate|overload|capacity|quota|budget|529|429/.test(code)) return "provider";
  return "other";
}

/** A fix sentence for the classes that have one, built from the runner's label, never per harness. */
function failureFix(klass: ReviewerFailureClass, runner: string): string | null {
  const label = runner in AGENT_IDENTITY ? AGENT_IDENTITY[runner as keyof typeof AGENT_IDENTITY].label : runner;
  if (klass === "not-installed") return `Install ${label} and make sure it is on the PATH of the Mission Control daemon.`;
  if (klass === "signed-out") return `Sign in to ${label}, then retry the review.`;
  return null;
}

function reviewerState(call: CallRow | undefined): HomeDispatchReviewer["state"] {
  if (!call) return "queued";
  switch (call.state) {
    case "running":
      return call.attempt > 1 ? "retrying" : "running";
    case "succeeded":
      return "passed";
    case "failed":
    case "interrupted":
    case "cancelled":
      return "failed";
  }
}

/**
 * The reviewer rows of a run's current round, in the workflow's reviewer order (7.25): one row per
 * persona node, from its latest `workflow_llm_calls` attempt. A reviewer that has no call yet is
 * `queued`. Empty for a run with no reviewer step.
 */
export function reviewerRowsFor(runId: string): HomeDispatchReviewer[] {
  const submissionId = currentSubmissionId(runId);
  if (!submissionId) return [];
  const reviewers = attemptsOf(submissionId).filter((a) => a.persona_snapshot_json !== null);
  if (reviewers.length === 0) return [];
  const calls = openDb()
    .prepare(
      `SELECT node_attempt_id, runner_id, model_id, attempt, state, started_at, finished_at, error_code
         FROM workflow_llm_calls WHERE submission_id = ? AND purpose = 'persona_review'
        ORDER BY started_at ASC, attempt ASC`,
    )
    .all(submissionId) as unknown as CallRow[];
  const latest = new Map<string, CallRow>();
  for (const call of calls) if (call.node_attempt_id) latest.set(call.node_attempt_id, call);
  return reviewers.map((a): HomeDispatchReviewer => {
    const call = latest.get(a.id);
    const state = reviewerState(call);
    const runner = call?.runner_id ?? a.runner_id ?? "unknown";
    const klass = state === "failed" ? reviewerFailureClass(call?.error_code ?? null) : null;
    return {
      name: personaName(a.persona_snapshot_json, a.node_id),
      runner,
      model: call?.model_id ?? a.model_id ?? null,
      state,
      attempt: call?.attempt ?? 0,
      startedAt: call?.started_at ?? null,
      endedAt: call?.finished_at ?? null,
      failure: klass ? { class: klass, fix: failureFix(klass, runner) } : null,
    };
  });
}

/** One check node of the run's current round, for the Workflows tab (7.7). */
export function runChecksFor(runId: string): { name: string; state: "passed" | "running" | "failed" | "pending" }[] {
  const submissionId = currentSubmissionId(runId);
  if (!submissionId) return [];
  return attemptsOf(submissionId)
    .filter((a) => a.persona_snapshot_json === null && a.session_action_snapshot_json === null)
    .map((a) => ({
      name: a.node_id,
      state: a.state === "completed" ? "passed" as const
        : a.state === "running" ? "running" as const
        : a.state === "error" ? "failed" as const
        : "pending" as const,
    }));
}
