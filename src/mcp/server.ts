import { resolve } from "node:path";
import {
  SettingsRequestSchema, SettingsToolInputSchema, isBoundedSettingsValue, settingsFailure, type SettingsResult,
} from "@shared/settings-mcp.ts";
import { McpCreateScheduleSchema, McpSchedulePreviewSchema } from "@shared/protocol.ts";
import { ScheduleNextIterationSchema } from "@shared/residents.ts";
import { requestInputReview } from "@shared/request-input.ts";
import { MEANWHILE_MAX_CHARS } from "@shared/async-input.ts";
import {
  ProposeResidentInstructionChangesSchema,
  residentInstructionOutcomeText,
  type ResidentInstructionOutcome,
} from "@shared/resident-instructions.ts";
import { scheduleResidentIteration } from "./resident-pacing.ts";
import {
  DispatchBacklogTaskSchema, PLAN_DECISION_LIMITS, SESSION_CONTROL_REQUEST_REASON_MAX, SessionControlReadSchema,
  SessionControlRequestSchema, type SessionControlRequestResult,
} from "@shared/protocol.ts";
import { PlanReviewInputSchema, TaskPlanInputsSchema, PlanIdentitySchema } from "@shared/managed-plans.ts";
import { DAEMON_PROTOCOL_CAPABILITIES, daemonHealthSupports } from "@shared/daemon-protocol.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ReviewWaitResponse } from "@shared/async-input.ts";
import type { Task } from "@shared/types.ts";
import {
  SESSION_AWAITING_LIMITS, SESSION_AWAITING_WAKE_SOURCES, SESSION_BLOCKER_KINDS, SESSION_BLOCKER_LIMITS,
} from "@shared/types.ts";
import { reviewToolResult } from "@shared/review-item.ts";
import { ENSEMBLE_LIMITS } from "@shared/ensemble.ts";
import { SCOUT_REPORT_PATH_SHAPE, SCOUT_SUBMISSION_LIMITS } from "@shared/scouts.ts";
import {
  WORKFLOW_IMAGE_LIMITS,
  WORKFLOW_LIMITS,
  WORKFLOW_TEXT_EVIDENCE_LIMITS,
  WORKFLOW_EVIDENCE_COVERAGE_LIMITS,
  WORKFLOW_EVIDENCE_PROOF_CLASSES,
  WORKFLOW_EVIDENCE_PROOF_ROLES,
  workflowCommandEvidenceContent,
} from "@shared/workflow.ts";
import {
  BASE_URL,
  MISSION_SESSION_ID_ENV,
  MISSION_AGENT_SESSION_ID_ENV,
  SCOUT_SUBMISSION_CREDENTIAL_HEADER,
  captureTerminalEnv,
  readClientToken,
  readSessionScoutSubmissionCredential,
} from "@shared/harness-runtime.mjs";
import { TASK_REFERENCE_RULE } from "@shared/task-references.ts";
import { taskShapingRead, type TaskShapingRead } from "@shared/shaping.ts";
import { DECISION_CONTEXT_MAX_CHARS, DECISION_CONTEXT_RULE } from "@shared/decision-asks.ts";
import { REPORT_GUIDANCE, REPORT_GUIDANCE_LIMIT, REPORT_ID_PATTERN, REPORT_LIMITS, postReportGuidance } from "@shared/reports.ts";
import {
  PRODUCT_ISSUE_CLIENT_ENV,
  productIssueClientFromEnvironment,
  type ProductIssueRequest,
} from "@shared/product-issues.ts";
import { reportProductIssueWithConfirmation } from "./product-issues.ts";
import {
  PIPELINE_CALLER_CREDENTIAL_HEADER,
} from "@shared/pipeline.ts";
import { MAX_TASK_EXTRA_REPOS, inputQuestionProblem, McpTaskConfigurationSchema, McpWorkUnitChoiceSchema, McpUpdateTaskSchema, McpDeleteTaskSchema, McpCancelTaskSchema, McpListTasksSchema, McpGetTaskSchema, type McpTaskSnapshot, ProductIssueDraftSchema, WorkflowCommandExitCodeSchema } from "@shared/protocol.ts";
import { readPipelineCallerCredential } from "./pipeline-credential.ts";
import { submitWorkflowEvidenceToDaemon } from "./workflow-evidence.ts";
import { PlanPublicationContextSchema } from "@shared/plan-publication.ts";
import { PlanContextInputSchema, SavePlanInputSchema, ReadPlanInputSchema } from "@shared/managed-plans.ts";
import {
  ConfigureWorkflowCommandSchema,
  GetWorkflowRunSchema,
  ListWorkflowRunsSchema,
  ReadWorkflowCommandOutputMcpSchema,
  WorkflowMcpActionSchema,
} from "@shared/workflow-mcp.ts";

// This runs as a stdio MCP server in one of two provenance modes. An SDK launch carries
// Mission Control's exact session id and must not also claim an inherited terminal pane,
// because the Registry intentionally resolves pane identity first. A terminal launch has
// no Mission id, so it keeps the pane join key and uses the extension's native session id
// when supplied, falling back to the legacy Claude session id.

const MISSION_SESSION_ID = process.env[MISSION_SESSION_ID_ENV];
const ENV = MISSION_SESSION_ID === undefined ? captureTerminalEnv() : {};
const SESSION_ID = MISSION_SESSION_ID ?? process.env[MISSION_AGENT_SESSION_ID_ENV] ?? process.env.CLAUDE_SESSION_ID ?? null;
const PIPELINE_CALLER_CREDENTIAL = readPipelineCallerCredential();
const PRODUCT_ISSUE_CLIENT = productIssueClientFromEnvironment(
  process.env[PRODUCT_ISSUE_CLIENT_ENV],
);

async function http(
  path: string,
  method: string,
  body?: unknown,
  scoutCredential = false,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    // The imported `randomUUID`, never the `crypto` global: Node 18 has no such global, and
    // a Node 18 child made every tool call fail with "ReferenceError: crypto is not defined".
    "x-mission-operation-id": randomUUID().replaceAll("-", ""),
    "x-mission-operation-surface": "mcp",
    "x-mission-operation-actor": "agent",
    ...extraHeaders,
    "content-type": "application/json",
    "x-harness-token": readClientToken(),
  };
  if (scoutCredential) {
    const credential = readSessionScoutSubmissionCredential(process.cwd());
    if (credential) headers[SCOUT_SUBMISSION_CREDENTIAL_HEADER] = credential;
  }
  return fetch(BASE_URL + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
}

async function createReview(
  kind: string,
  title: string,
  body: string,
  decisions?: unknown,
  managedPlan?: unknown,
  /** Offer "Remind me later": only `request_input`'s own asks, whose agent knows how to carry on. */
  snoozable?: boolean,
): Promise<string> {
  return (await postReview({ kind, title, body, decisions, managedPlan, snoozable })).id;
}

/**
 * How the daemon said a review waits (`async-input`): `call` means long-poll it as always;
 * `message` means the agent hears the answer later as a message, and `receipt` is the tool result.
 * A daemon from an older build says nothing, which is `call`.
 */
type CreatedReview = { id: string; wait: "call" } | { id: string; wait: "message"; receipt: string };

/**
 * The daemon refused the ask with a reason meant for the agent (409): the ten-question limit, or a
 * `revises` that names no form this ask may revise. Nothing was filed, so the tool result is that
 * reason, not a transport failure.
 */
class AskRefused extends Error {}

async function postReview(input: {
  kind: string;
  title: string;
  body: string;
  decisions?: unknown;
  managedPlan?: unknown;
  snoozable?: boolean;
  /** This child can hand back a receipt instead of long-polling. `request_input` and `request_plan_decisions` say so. */
  asyncCapable?: boolean;
  meanwhile?: string;
  /** The filed plan form this one revises (`request_plan_decisions`). */
  revises?: string;
}): Promise<CreatedReview> {
  const res = await http(input.managedPlan ? "/mcp/v2/reviews" : "/mcp/reviews", "POST", {
    env: ENV,
    sessionId: SESSION_ID,
    cwd: process.cwd(),
    kind: input.kind,
    title: input.title,
    body: input.body,
    decisions: input.decisions,
    managedPlan: input.managedPlan,
    ...(input.snoozable ? { snoozable: true } : {}),
    ...(input.asyncCapable ? { asyncCapable: true, convertible: true } : {}),
    ...(input.meanwhile ? { meanwhile: input.meanwhile } : {}),
    ...(input.revises ? { revises: input.revises } : {}),
  });
  if (res.status === 409) {
    const text = await res.text();
    let reason: unknown = null;
    try { reason = (JSON.parse(text) as { error?: unknown }).error; } catch { /* not JSON: reported below */ }
    throw typeof reason === "string" ? new AskRefused(reason) : new Error(`harness 409: ${text}`);
  }
  if (!res.ok) throw new Error(`harness ${res.status}: ${await res.text()}`);
  const created = (await res.json()) as { id: string; wait?: string; receipt?: unknown };
  return created.wait === "message" && typeof created.receipt === "string"
    ? { id: created.id, wait: "message", receipt: created.receipt }
    : { id: created.id, wait: "call" };
}

/**
 * What the caller hands `waitForResolution` so the call can outlive a human's coffee break.
 *
 * Structural rather than the SDK's `RequestHandlerExtra`, because only these three members
 * are used and naming them here is what documents why the tool passes `extra` down at all.
 */
type BlockingCall = {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (n: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
};

/**
 * Tell the client we are still here, once per long-poll round trip.
 *
 * The tools that block do so on a HUMAN, who may take minutes or hours. The MCP client in
 * front of them does not wait that long on its own: it abandons the tool call on its own
 * timeout - five minutes, in the duplicates the live database recorded - and hands the model
 * an error for a question the operator can still see and still answer. What the model does
 * next is ask again, which is where the duplicate cards came from.
 *
 * A progress notification is the protocol's first answer to this: a client MAY restart its
 * timeout for that request, while still enforcing a maximum. It is only ever sent against
 * the `progressToken` the client itself supplied - a client that wants no progress sends
 * none, and gets none. The durable answer after that maximum is the detach fallback below.
 *
 * Best-effort on purpose. No token, no `sendNotification`, or a notification that fails to
 * send, and the wait carries on exactly as it did before. `ReviewManager.create` keeps a
 * retry from duplicating the card, while `/detach` makes a later answer resumable after the
 * host cancels this result channel entirely.
 */
function heartbeat(call?: BlockingCall): () => void {
  if (!call) return () => {};
  const progressToken = call._meta?.progressToken;
  if (progressToken === undefined) return () => {};
  let progress = 0;
  return () => {
    void call
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: ++progress, message: "Waiting on your answer" },
      })
      .catch(() => {});
  };
}

/** A listening daemon can still be temporarily unavailable while it starts. */
class WaitServiceUnavailable extends Error {}

/**
 * Long-poll the daemon until the human resolves the review.
 *
 * `call` is optional so a caller with nothing to report in can still wait; passing it buys
 * two things. The heartbeat above, and an exit: without a signal this loop re-polls every
 * thirty seconds FOR EVER, including long after the client cancelled the tool call and threw
 * away whatever it returns, so an abandoned ask left a poller hammering the daemon for the
 * rest of the session's life. Aborting the in-flight fetch ends it at the cancellation.
 */
async function waitForResolution(id: string, call?: BlockingCall, convertible = false): Promise<ReviewWaitResponse> {
  const beat = heartbeat(call);
  const retryDelays = [250, 500, 1000, 2000, 4000, 8000];
  let failures = 0;
  try {
    for (;;) {
      if (call?.signal.aborted) throw new Error("the client cancelled this request");
      let review: ReviewWaitResponse;
      try {
        const query = convertible ? "?convertible=1" : "";
        const res = await http(`/mcp/reviews/${id}/wait${query}`, "GET", undefined, false, call?.signal);
        if (!res.ok) {
          await res.body?.cancel();
          if (res.status === 503) throw new WaitServiceUnavailable("harness wait 503");
          throw new Error(`harness wait ${res.status}`);
        }
        review = await res.json() as ReviewWaitResponse;
        failures = 0;
      } catch (err) {
        // The receipt can commit just before daemon shutdown. Allow time to bind the port again.
        const backoff = retryDelays[failures];
        const temporarilyUnavailable = err instanceof TypeError || err instanceof WaitServiceUnavailable;
        if (!temporarilyUnavailable || !convertible || backoff === undefined || call?.signal.aborted) throw err;
        failures++;
        beat();
        await delay(backoff, undefined, { signal: call?.signal });
        continue;
      }
      if (convertible && review.converted && !call?.signal.aborted) return review;
      if (review.status !== "pending") {
        // The host can cancel after the daemon has answered the long poll but before this
        // result crosses the MCP response boundary. Recheck at the fast-path handoff so that
        // cancellation takes the detach path below instead of silently losing the answer.
        if (call?.signal.aborted) throw new Error("the client cancelled this request");
        return review;
      }
      beat();
    }
  } catch (error) {
    let detachFailure: unknown = null;
    try {
      const response = await http(
        `/mcp/reviews/${id}/detach`,
        "POST",
        { env: ENV, sessionId: SESSION_ID, cwd: process.cwd() },
        false,
        AbortSignal.timeout(2_000),
      );
      if (!response.ok) {
        throw new Error(`harness detach ${response.status}: ${await response.text()}`);
      }
    } catch (detachError) {
      // Startup recovery still covers a daemon restart. Retain every other handoff failure
      // in the returned error so a running daemon cannot silently lose the detached wait.
      detachFailure = detachError;
    }
    if (detachFailure) {
      const detail = detachFailure instanceof Error ? detachFailure.message : String(detachFailure);
      throw new AggregateError(
        [error, detachFailure],
        `review wait ended and its durable detach failed: ${detail}`,
      );
    }
    if (call?.signal.aborted) {
      throw new Error("the client cancelled this request");
    }
    throw error;
  }
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

async function responseResult(res: Response): Promise<{ status: number; body: unknown }> {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: res.status, body: text };
  }
}

// Server-level instructions reach every session this server is registered with, dispatched or
// started by hand, on harnesses that read them. The task tools below repeat the same rule in
// their own descriptions because tool descriptions reach every harness.
const server = new McpServer(
  { name: "mission-control", version: "0.1.0" },
  { instructions: TASK_REFERENCE_RULE },
);

server.registerTool("list_workflow_runs", {
  description: "List your own Mission Control workflow runs, with optional status, workflowId and session filters. Reading other sessions' runs requires a read-only inspection or session-control grant. Follow nextCursor for more results. Use get_workflow_run before changing a run.",
  inputSchema: ListWorkflowRunsSchema,
}, async (input) => {
  try {
    const res = await http("/mcp/workflows/list", "POST", input, true);
    return textResult(await res.text(), !res.ok);
  } catch (error) {
    return textResult(String(error), true);
  }
});

server.registerTool("get_workflow_run", {
  description: "Inspect your own workflow run, including its binding, submissions, deliveries and recovery actions. Reading another session's run requires a read-only inspection or session-control grant. Returns IDs needed by trigger_workflow_action.",
  inputSchema: GetWorkflowRunSchema,
}, async ({ runId }) => {
  try {
    const res = await http("/mcp/workflows/read", "POST", { runId }, true);
    return textResult(await res.text(), !res.ok);
  } catch (error) {
    return textResult(String(error), true);
  }
});

server.registerTool("read_workflow_command_output", {
  description: "Read one bounded page of retained stdout, stderr, or provider findings for a Command attempt in your workflow run. Use the opaque ids from get_workflow_run or a repair packet and follow nextCursor until null. Reading another session's run requires a read-only inspection or session-control grant.",
  inputSchema: ReadWorkflowCommandOutputMcpSchema,
}, async (input) => {
  try {
    const res = await http("/mcp/workflows/read-command-output", "POST", input, true);
    return textResult(await res.text(), !res.ok);
  } catch (error) {
    return textResult(String(error), true);
  }
});

server.registerTool("configure_workflow_command", {
  description: "Set the Command one workflow slot (test, lint, typecheck, build, documentation) runs for the repository of YOUR OWN workflow run, as an override in Library > Commands. Use it when a repair packet says the configured Command does not apply to this repository - for example the machine-wide default is `make test` and there is no Makefile - instead of adding files to make that command pass. First inspect how the repository runs that slot and pass the argv you found. This tool then has Mission Control raise a request_input card on your session - naming this run, the slot, the repository and the exact argv - and BLOCKS until the operator answers. Nothing is configured unless they choose Configure this Command. The machine-wide default is never changed. Executions in which the repository did not provide a different argv are returned to the run budget so the corrected command runs on resubmission; then resubmit with trigger_workflow_action (resubmitUnchanged: true when no files changed).",
  inputSchema: ConfigureWorkflowCommandSchema,
}, async (input, extra) => {
  try {
    const configure = () => http("/mcp/workflows/configure-command", "POST", input, true);
    const first = await configure();
    if (first.status !== 403) return textResult(await first.text(), !first.ok);
    const refusal = await responseResult(first);
    const card = (refusal.body as { code?: string; confirmationReviewId?: string; confirmation?: {
      decision: { id: string };
    } } | null);
    if (card?.code !== "unconfirmed" || !card.confirmationReviewId || !card.confirmation) {
      return textResult(JSON.stringify(refusal.body), true);
    }
    // The DAEMON raised this card on the session and recorded it on the run; this only waits
    // for the operator's answer, on the same path request_input waits on.
    const review = await waitForResolution(card.confirmationReviewId, extra);
    const chose = review.selections?.find((answer) => answer.decisionId === card.confirmation!.decision.id)?.selected ?? [];
    if (review.status !== "answered" || chose.length !== 1 || chose[0] !== "configure") {
      const result = reviewToolResult(review);
      return textResult(
        `The operator did not confirm this Command, so nothing was configured. Their answer:\n${result.text}`,
        false,
      );
    }
    const second = await configure();
    return textResult(await second.text(), !second.ok);
  } catch (error) {
    return textResult(String(error), true);
  }
});

server.registerTool("trigger_workflow_action", {
  description: "Execute your own workflow's dashboard controls: grant repair rounds, cancel, retry, resubmit (resubmitUnchanged explicitly reviews unchanged work), restart, prepare PR, recheck Inspector, toggle nodes, set/remove Persona feedback, recover/retry/override evidence readiness, retry/resolve delivery, submit a binding (also Run again), reattach, or start a session review. Controlling another session's workflows requires the operator's Control other sessions opt-in on YOUR session. Inspect get_workflow_run first. Reuse the same requestId when retrying the same intent after a lost response; use a new id for a new intent. Confirmations, acknowledgedRisk, delivery target identity, limits and dashboard state checks remain enforced. Failures return without automatic retry or fallback.",
  inputSchema: WorkflowMcpActionSchema,
}, async ({ request }) => {
  try {
    const res = await http("/mcp/workflows/act", "POST", { request }, true);
    return textResult(await res.text(), !res.ok);
  } catch (error) {
    return textResult(String(error), true);
  }
});

server.registerTool(
  "read_sessions",
  {
    title: "Inspect sessions for delegated control",
    description: "Requires an operator grant for read-only inspection or Control other sessions on THIS session. Omit sessionId to list other live sessions, each with its blocker summary (set blocked: true to list only blocked sessions) and its awaiting summary: what it declared it is waiting for, how it expects to be woken, when it is due and whether it is overdue (set awaiting: true to list only sessions idle on purpose); supply it to read current state, pending reviews, approval dialogs, queued input and the full work queue (item ids, revisions, states and proposed payloads). Set transcript to include recent conversation. With sessionId, pass history: 'latest' to read a bounded transcript page, then pass history.next as history for older pages until next is null. Without sessionId, history reports that only the current live list is available. Record unavailable intervals when a session has ended. Use the returned ids, requestIds, labels and revisions when calling control_session.",
    inputSchema: SessionControlReadSchema.shape,
  },
  async (args) => {
    const res = await http("/mcp/session-control/read", "POST", args, true);
    return { content: [{ type: "text" as const, text: await res.text() }], isError: !res.ok };
  },
);
server.registerTool(
  "control_session",
  {
    title: "Steer another session on the operator's behalf",
    description: "Requires an explicit per-session controller grant. Read the target with read_sessions first. Supports messages, interruption, approval/form answers, review decisions, queued input and work queue management, rename, model, effort, permission mode, and blockers: flag_blocker_reply marks a likely answer without clearing the blocker or messaging the session, and clear_blocker clears it. Pass the blocker id from read_sessions as blockerId on both blocker actions so a replaced blocker is refused. complete does what the operator's Complete button does: it records the target's current task as done with your outcome (default \"completed\") and closes the target session; only use it once the target's work is verifiably finished. satisfyDependents releases tasks declared to wait on it without a merge, so set it only when that work is already in place on the default branch. A scout whose report is not archived is refused with the problems; confirmIncompleteScout closes it anyway, so retry with it only when losing that report is acceptable. clear_awaiting ends a session's declared wait on a background process; its awaiting id from read_sessions is required as awaitingId, so a wait declared since is refused, and prefer leaving an in-deadline wait alone, since the session resumes on its own. Never clear a blocker without evidence its resumeWhen condition is met; prefer flag_blocker_reply then message. Review ids must belong to the target. Queue approval requires the item revision returned by read_sessions; reread changed proposals before approving. Permissions and lifecycle checks still apply. Cannot enable control, alter global configuration, reset worktrees or kill sessions other than by complete. An action already accepted may finish after revocation. Check returned delivery state before retrying a message.",
    inputSchema: SessionControlRequestSchema.shape,
  },
  async (args) => {
    const res = await http("/mcp/session-control/act", "POST", args, true);
    return { content: [{ type: "text" as const, text: await res.text() }], isError: !res.ok };
  },
);

/**
 * The caller's cancellation bounded by a deadline: aborts on whichever comes first. Hand-rolled
 * rather than `AbortSignal.any`, which Node 18 before 18.17 lacks, and this server has run there.
 */
function untilCancelledOr(signal: AbortSignal, ms: number): AbortSignal {
  const bounded = new AbortController();
  const cancel = (): void => bounded.abort(signal.reason);
  const timer = setTimeout(() => bounded.abort(new Error(`Mission Control did not answer within ${ms} ms`)), ms);
  timer.unref?.();
  bounded.signal.addEventListener("abort", () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }, { once: true });
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  return bounded.signal;
}

/**
 * What the agent reads once its ask settles. `granted` records the operator's decision when it
 * was made, not current authority: a later revoke or reset ends the grant without changing it.
 */
function sessionControlRequestText(result: SessionControlRequestResult): { text: string; isError: boolean } {
  switch (result.status) {
    case "granted":
      return { isError: false, text: "Granted: the operator allowed this session to control other sessions. Use read_sessions " +
        "to inspect other live sessions and control_session to act on them. This records the operator's decision, not " +
        "current authority: the grant ends when the operator revokes it, when this conversation is reset or replaced, or " +
        "when Mission Control restarts, and read_sessions and control_session then refuse." };
    case "declined":
      return { isError: false, text: "Declined: the operator chose not to let this session control other sessions. Do not " +
        "ask again unless the operator tells you to. Carry on without it, and say what you could not do." };
    case "expired":
      return { isError: true, text: `Not granted: the request ended without a decision because ${result.detail ?? "it expired"}. ` +
        "Nothing was granted." };
    case "pending":
      return { isError: true, text: "The request is still waiting on the operator." };
  }
}

server.registerTool(
  "request_session_control",
  {
    title: "Ask the operator to let this session control other sessions",
    description: "Ask your human operator to grant THIS session Control other sessions, which read_sessions and " +
      "control_session require. Mission Control shows your reason in the attention inbox and BLOCKS until the " +
      "operator decides. Only the operator's own click on Accept in the Mission Control desktop app grants it: no " +
      "tool, answer, Foreman or other session can. Ask only when your task needs to read or steer other sessions, " +
      "and say which ones and why. Returns granted, declined, or why it ended without a decision. If this session " +
      "already holds the grant, it returns at once. If declined, do not ask again unless the operator tells you to.",
    inputSchema: {
      reason: z.string().trim().min(1).max(SESSION_CONTROL_REQUEST_REASON_MAX)
        .describe("Why this session needs to control other sessions: which sessions, and what you will do. Shown to the operator verbatim."),
    },
  },
  async ({ reason }, extra) => {
    const beat = heartbeat(extra);
    try {
      const raised = await http("/mcp/session-control/requests", "POST", { reason }, true, untilCancelledOr(extra.signal, 15_000));
      if (raised.status === 404) {
        return textResult("Not asked: session control requests are turned off in Mission Control (Settings > Feature " +
          "flags). Nothing was shown to the operator. If you need this, ask them with request_input to turn on " +
          "Control other sessions from this session's toolbar.", true);
      }
      if (!raised.ok) return textResult(`Not asked: ${await raised.text()}`, true);
      let result = (await raised.json()) as SessionControlRequestResult;
      // Best-effort: the session's status line says what it is waiting on.
      if (result.status === "pending") {
        await http("/mcp/status", "POST", { env: ENV, sessionId: SESSION_ID, activity: "Waiting for you to allow control of other sessions" },
          false, untilCancelledOr(extra.signal, 5_000)).catch(() => {});
      }
      while (result.status === "pending") {
        if (extra.signal.aborted) throw new Error("the client cancelled this request");
        const res = await http(`/mcp/session-control/requests/${encodeURIComponent(result.id)}/wait`, "GET", undefined, true, extra.signal);
        // The daemon no longer recognises this conversation as the one that asked.
        if (res.status === 403) {
          result = { id: result.id, status: "expired", detail: "this conversation changed before the operator answered" };
          break;
        }
        // The preview was switched off between rounds; that withdrew the card as well.
        if (res.status === 404 && ((await res.clone().json().catch(() => null)) as { feature?: string } | null)?.feature) {
          result = { id: result.id, status: "expired", detail: "session control requests were turned off in Settings > Feature flags" };
          break;
        }
        if (!res.ok) return textResult(`Could not wait on the request: ${await res.text()}`, true);
        result = (await res.json()) as SessionControlRequestResult;
        beat();
      }
      const answer = sessionControlRequestText(result);
      return textResult(answer.text, answer.isError);
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "request_plan_decisions",
  {
    title: "Present a plan with selectable decisions",
    description:
      "Show a plan in the Mission Control dashboard with one or more decision points the " +
      "human can resolve by selecting options and clicking Submit, or dismiss without an " +
      "answer when the decision set is stale. The result says which of two things happened. " +
      "Either it carries their selections or an explicit dismissal, because this call waited " +
      "for them; or it is a receipt saying the plan is filed and NOT answered. The form is a " +
      "gate either way: on a receipt, do only read-only preparation, make no edits, commits, " +
      "pushes or other outward action, do not file it again or poll, then say what is waiting " +
      "and end your turn. The answer arrives later as a message in this conversation, restating " +
      "the plan and each decision. A dismissal is not approval. The human " +
      "may move any decision to chat instead of choosing; the result then names it and says " +
      "how to discuss it, and you must not decide or re-ask it. When scope changes after you " +
      "filed a plan, file the revised plan with revises set to the earlier form's review id: " +
      "the operator then sees one card tagged as the revision. Use this " +
      "instead of asking open-ended questions whenever the plan's open choices can be " +
      "expressed as options.",
    inputSchema: {
      title: z.string().describe("Short title for the plan"),
      plan: z.string().describe("The plan as GitHub-flavored markdown, shown above the decisions"),
      managedPlan: PlanReviewInputSchema.optional().describe("Bind final-bundle approval to this exact saved plan and revision. The daemon appends an explicit approval decision; use again after any revision change."),
      decisions: z
        .array(
          z.object({
            id: z.string().describe("Stable id for this question, echoed back in the answer"),
            question: z.string().describe("What the human is deciding"),
            options: z
              .array(
                z.object({
                  id: z.string().describe("Stable id, echoed back in the selection"),
                  label: z.string().describe("What the human reads on the control"),
                  detail: z.string().optional().describe("One line: this option's tradeoff - what it gains and what it costs"),
                  recommended: z
                    .boolean()
                    .optional()
                    .describe("Marks a suggested choice; does not preselect"),
                }),
              )
              .min(1)
              .max(PLAN_DECISION_LIMITS.options),
            multiSelect: z
              .boolean()
              .optional()
              .describe("Checkboxes (choose many) when true, radios (choose one) otherwise"),
            allowOther: z
              .boolean()
              .optional()
              .describe("Adds a free-text 'Other' field for an answer outside the options"),
          }),
        )
        .max(PLAN_DECISION_LIMITS.decisions)
        .default([])
        .describe("Open choices; empty is allowed for managed final-bundle approval"),
      revises: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "The review id of your earlier filed plan form that this plan replaces, for example after " +
          "the operator said the scope changed. Pass it whether or not you already withdrew that form: " +
          "an open one is withdrawn for you. Only your own session's filed plan forms can be revised, " +
          "each once; revise the latest. Omit it for a new plan.",
        ),
    },
  },
  async ({ title, plan, decisions, managedPlan, revises }, extra) => {
    try {
      // `asyncCapable`: the daemon decides how this form waits (`filed-plan-decisions`). Told
      // `message`, the plan is filed and the receipt is the whole result - nothing long-polls.
      const created = await postReview({ kind: "plan-decisions", title, body: plan, decisions, managedPlan, asyncCapable: true, revises });
      if (created.wait === "message") return textResult(created.receipt);
      const review = await waitForResolution(created.id, extra, true);
      if (review.converted) return textResult(review.converted.receipt);
      const result = reviewToolResult(review);
      return textResult(result.text, result.isError);
    } catch (err) {
      if (err instanceof AskRefused) return textResult(err.message, true);
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "request_review",
  {
    title: "Request review of a diff",
    description:
      "Show a unified/git diff in the Mission Control dashboard and BLOCK until the human " +
      "approves, requests changes, or dismisses the review without a verdict. Returns their " +
      "decision so you can proceed or revise.",
    inputSchema: {
      title: z.string().describe("What this change does"),
      diff: z.string().describe("A unified or git diff"),
    },
  },
  async ({ title, diff }, extra) => {
    try {
      const id = await createReview("diff", title, diff);
      const review = await waitForResolution(id, extra);
      const result = reviewToolResult(review);
      return textResult(result.text, result.isError);
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

/** Return persisted configuration so callers can verify pins, clearing, and inheritance. */
function taskConfiguration(task: Task) {
  return {
    id: task.id,
    // Null for a resident run, and for an older task until it is next dispatched or assigned.
    workUnitId: task.workUnitId ?? null,
    title: task.title,
    intent: task.intent,
    status: task.status,
    repository: task.repoRoot,
    additionalRepositories: task.extraRepos.map((entry) => entry.repoRoot),
    kind: task.kind,
    agent: task.agent,
    model: task.model,
    effort: task.effort,
    advisorModel: task.advisorModel,
    personaId: task.personaId,
    callSign: task.callSign ?? null,
    workflowId: task.workflowId,
    planPolicy: task.planPolicy,
    enabled: task.enabled,
    priority: task.priority,
    labels: task.labels,
    dependencies: task.dependencies,
    planInputs: task.planInputs,
  };
}

server.registerTool(
  "create_task",
  {
    title: "Schedule a backlog task",
    description:
      "Create one task in the Mission Control backlog without launching it. Ship is the default kind. It targets the current repository " +
      "unless an absolute local checkout path or unique repository directory name is supplied, " +
      "and it can attach additional local repositories to the same task. " +
      "Set agent (harness), model, effort, kind, workflowId, enabled (backlog autopilot), priority, " +
      "labels, callSign, planStorage (plan tasks only), and dependencies as needed. callSign is a short spoken name " +
      "the task's session is listed under in Settings > Voice, for the operator to address it by once voice routing is available; " +
      "it is not the title and is set only when asked for. " +
      "Omitted agent uses the kind default; omitted or null " +
      "model/effort follows launch-time defaults. The advisor is not a task setting: Settings -> Harnesses " +
      "chooses it per launch model. Null workflowId opts out of an after-work workflow. " +
      "Pass direct prerequisite " +
      "task ids or depend on the calling session to create durable dependency edges; unfinished " +
      "task/session prerequisites wait for their pull requests to merge. Exact local plan-only " +
      "planPrerequisites wait for artifact publication; planInputs pin the readable Markdown revision. Repository " +
      "validity is checked locally; Git and the repository host enforce push and pull-request " +
      "authority later. A task created from a plan task's session joins that plan's work unit; any other gets its own " +
      "unless workUnit is \"inherit\". Returns the new task id, its workUnitId, saved configuration, and canonical repository set. " +
      TASK_REFERENCE_RULE,
    inputSchema: {
      ...McpTaskConfigurationSchema.shape,
      title: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "Specific task title shown on the backlog card. Name the work, not the request for it: " +
            "no \"Implement\", \"We should\" or \"I want\" framing - \"Herdr Multiplexer\", not " +
            "\"Implement Herdr Multiplexer\"",
        ),
      intent: z
        .string()
        .min(1)
        .describe(
          "Goal-level brief for the agent: the outcome to deliver, the plan or phase file paths to " +
            "read and follow, and the verification bar. This text becomes the agent's prompt and is " +
            "read as the requester's explicit requirement, so keep it concise and leave step-by-step " +
            "detail in the referenced files rather than restating it here",
        ),
      repository: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Primary repository as an absolute local checkout path or a unique repository directory " +
            "name. Omit it to use the calling session's current repository",
        ),
      additionalRepositories: z
        .array(z.string().trim().min(1))
        .max(MAX_TASK_EXTRA_REPOS)
        .optional()
        .describe(
          "Repositories to attach, each as an absolute local checkout path or unique repository " +
            "directory name",
        ),
      planInputs: TaskPlanInputsSchema.optional().describe("Exact repository key, plan id, revision and Markdown files for each managed input"),
      planPrerequisites: z.array(PlanIdentitySchema).max(16).optional().describe("Approved local plan-only artifact prerequisites. Keep implementation task dependencies separately; repository and mixed sources still use dependsOnCurrentSession."),
      dependsOnTaskIds: z
        .array(z.string().min(1))
        .max(50)
        .default([])
        .describe("Ids of direct prerequisite tasks returned by earlier create_task calls"),
      dependsOnCurrentSession: z
        .boolean()
        .default(false)
        .describe("Make the session calling this tool a direct prerequisite of the new task"),
      workUnit: McpWorkUnitChoiceSchema.optional(),
    },
  },
  async ({
    title,
    intent,
    repository,
    additionalRepositories,
    dependsOnTaskIds,
    dependsOnCurrentSession,
    planInputs, planPrerequisites,
    workUnit,
    ...configuration
  }) => {
    try {
      const explicitRepositories =
        repository !== undefined || Boolean(additionalRepositories?.length);
      const pinnedPlans = planInputs !== undefined || planPrerequisites !== undefined;
      const body = {
        env: ENV,
        sessionId: SESSION_ID,
        cwd: process.cwd(),
        repoRoot: process.cwd(),
        title,
        intent,
        dependsOnTaskIds,
        dependsOnCurrentSession,
        // Every creation route accepts it, so it does not choose the route.
        ...(workUnit !== undefined ? { workUnit } : {}),
        ...configuration,
      };
      const path = pinnedPlans || Object.keys(configuration).length > 0
        ? "/mcp/v3/tasks"
        : explicitRepositories ? "/mcp/v2/tasks" : "/mcp/tasks";
      const res = await http(
        path,
        "POST",
        explicitRepositories || pinnedPlans
          ? {
              ...body,
              targetRepository: repository,
              additionalRepositories: additionalRepositories ?? [],
              ...(pinnedPlans ? { planInputs: planInputs ?? [], planPrerequisites: planPrerequisites ?? [] } : {}),
            }
          : body,
      );
      // A missing route is plain text; a daemon refusal (for example, an unknown
      // dependency session) is JSON and must keep its actual error below.
      if (path !== "/mcp/tasks" && res.status === 404 && !res.headers.get("content-type")?.includes("application/json")) {
        return textResult(
          "Could not create task: this Mission Control daemon does not support repository " +
            "selectors, task configuration or exact plan inputs. Update or restart Mission Control and retry; no task was created.",
          true,
        );
      }
      if (!res.ok) {
        return textResult(`Could not create task (${res.status}): ${await res.text()}`, true);
      }

      const task = (await res.json()) as Task;
      return textResult(
        JSON.stringify(
          {
            ...taskConfiguration(task),
            dependsOnTaskIds,
            dependsOnCurrentSession,
            planInputs: planInputs ?? [], planPrerequisites: planPrerequisites ?? [],
          },
          null,
          2,
        ),
      );
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool("mission_settings", {
  title: "Read or change Mission Control settings",
  description: "Find supported settings with operation find and a short query. Get the current value and choices with its exact key. "
    + "Set a value only on a human's request. Pass a get result's version as expectedVersion when replacing an object or list. "
    + "Repeat find with nextCursor as cursor, or get with nextChoiceCursor as choiceCursor, to continue.",
  inputSchema: SettingsToolInputSchema,
}, async input => {
  const reply = (result: SettingsResult) => textResult(JSON.stringify(result), !result.ok);
  const parsed = SettingsRequestSchema.safeParse(input);
  if (!parsed.success) return reply(settingsFailure("invalid_request"));
  if (parsed.data.operation === "set" && !isBoundedSettingsValue(parsed.data.value)) {
    return reply(settingsFailure("value_too_large"));
  }
  try {
    const response = await http("/mcp/settings", "POST", parsed.data, true, AbortSignal.timeout(10_000));
    if (!response.headers.get("content-type")?.includes("application/json")) return reply(settingsFailure("unavailable"));
    return reply(await response.json() as SettingsResult);
  } catch {
    return reply(settingsFailure("unavailable"));
  }
});

// Schedules use the existing daemon service, never local timers or direct database writes.
const scheduleToolGuidance =
  "Requires the Recurring missions through MCP preview flag (mcp-schedules). " +
  "Use five-field cron and an explicit IANA time zone; runs must be at least an hour apart. " +
  "A due run files a backlog task, not an immediate agent launch. Foreman's existing gates govern execution. " +
  "Mission Control must be running; missed runs follow missedPolicy on wake or restart. ";

async function scheduleRequest(path: string, method: string, body?: unknown) {
  try {
    const res = await http(path, method, body, false, AbortSignal.timeout(30_000));
    if (res.status === 404 && !res.headers.get("content-type")?.includes("application/json")) {
      return textResult("This daemon does not support recurring missions through MCP. Update or restart Mission Control; no schedule was created.", true);
    }
    if (!res.ok) return textResult(`Schedule request failed (${res.status}): ${await res.text()}`, true);
    return textResult(JSON.stringify(await res.json(), null, 2));
  } catch (err) {
    return textResult(`Could not reach Mission Control: ${String(err)}. If creating a schedule, check list_schedules before retrying; the outcome may be unknown.`, true);
  }
}

server.registerTool("create_schedule", {
  title: "Create a recurring mission",
  description: scheduleToolGuidance +
    "Save a recurring task template with its name, cadence and task intent. Preview first with preview_schedule. " +
    "Enabled by default; enabled:false saves paused. Defaults: skip active work, coalesce missed runs to the latest, " +
    "manual completion, inherited kind agent and no after-work workflow. Choose auto-on-conclusion for runs " +
    "Foreman may complete without a merged PR. Returns the durable schedule, canonical repository and nextRunAt. " +
    "Use list_schedules to inspect saved missions and the Missions dashboard to edit, pause or archive them.",
  inputSchema: McpCreateScheduleSchema,
}, async (input) => scheduleRequest("/mcp/schedules", "POST", {
  ...input, template: { ...input.template, repoRoot: resolve(input.template.repoRoot) },
}));

server.registerTool("preview_schedule", {
  title: "Preview a recurring mission",
  description: scheduleToolGuidance +
    "Validate the exact unsaved definition and enumerate its next occurrences without writing a schedule or task. " +
    "Returns UTC instants, offsets, DST shifts and collisions; optional standby simulation uses the same missed-run policy as execution.",
  inputSchema: McpSchedulePreviewSchema,
}, async (input) => scheduleRequest("/mcp/schedules/preview", "POST", {
  ...input, template: { ...input.template, repoRoot: resolve(input.template.repoRoot) },
}));

server.registerTool("list_schedules", {
  title: "List recurring missions",
  description: "Read-only: list saved, non-archived recurring missions, including paused missions, task templates, " +
    "schedule ids, nextRunAt and health. Requires the Recurring missions through MCP preview flag (mcp-schedules). " +
    "Use this to check whether a mission already exists before creating one or retrying an uncertain create.",
  inputSchema: {},
}, async () => scheduleRequest("/mcp/schedules", "GET"));

/** Saved task facts only: never resolve another session's private state. */
function taskReadResult(task: McpTaskSnapshot, includeIntent: boolean) {
  const { intent, ...configuration } = taskConfiguration(task);
  return {
    ...configuration,
    ...(includeIntent ? { intent } : {}),
    sessionId: task.sessionId,
    outcomeUrl: task.outcomeUrl,
    prUrl: task.prUrl,
    repoPrs: task.repoPrs,
    outcome: task.outcome,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    dispatchedAt: task.dispatchedAt,
    completedAt: task.completedAt,
    // What task shaping added to the launch this session received, as one line. Absent when
    // nothing was added, or when the record describes an earlier launch's session.
    ...withTaskShapingRead(task),
  };
}

function withTaskShapingRead(task: McpTaskSnapshot): { shaping?: TaskShapingRead } {
  const shaping = taskShapingRead(task, task.shapingAfterWork ?? null);
  return shaping ? { shaping } : {};
}

server.registerTool(
  "list_tasks",
  {
    title: "List saved tasks (read-only)",
    description: "Read-only: list saved Mission Control tasks in any status, without launching, modifying or reordering anything. " +
      "Uses the same daemon-token access as create_task and update_task; no Control other sessions opt-in is required. " +
      "Returns {tasks, nextCursor}, newest createdAt first with task id as a descending tie-breaker. " +
      "Omit filters to read all tasks; combine filters with AND. Intent is omitted unless includeIntent is true. " +
      "Each task includes saved configuration, its workUnitId, plan inputs, linked sessionId, prUrl and per-repository repoPrs, " +
      "and shaping {state, sessionId, summary, skills?, afterWork?} when task shaping added context to the launch that session received. " +
      "Pass workUnitId to list the tasks of one work unit. " +
      "Pass nextCursor as cursor with unchanged filters to continue. This is a live listing, not a frozen snapshot. " +
      TASK_REFERENCE_RULE,
    inputSchema: McpListTasksSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (query) => {
    try {
      const res = await http("/mcp/tasks/list", "POST", query);
      if (!res.ok) return textResult(`Could not list tasks (${res.status}): ${await res.text()}`, true);
      const page = await res.json() as { tasks: McpTaskSnapshot[]; nextCursor: string | null };
      return textResult(JSON.stringify({
        tasks: page.tasks.map((task) => taskReadResult(task, query.includeIntent)),
        nextCursor: page.nextCursor,
      }, null, 2));
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "get_task",
  {
    title: "Read a saved task (read-only)",
    description: "Read-only: get a task's full saved configuration, including intent and plan inputs, by taskId in any status. " +
      "Includes linked sessionId, prUrl, per-repository repoPrs, and shaping {state, sessionId, summary, skills?, afterWork?} " +
      "when task shaping added context to the launch that session received. " +
      "Uses the same daemon-token access as update_task, without a Control other sessions opt-in. " +
      "Never launches, modifies or reorders work and does not read session-private state. " +
      TASK_REFERENCE_RULE,
    inputSchema: McpGetTaskSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ taskId }) => {
    try {
      const res = await http("/mcp/tasks/get", "POST", { taskId });
      if (!res.ok) return textResult(`Could not get task (${res.status}): ${await res.text()}`, true);
      return textResult(JSON.stringify(taskReadResult(await res.json() as McpTaskSnapshot, true), null, 2));
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "update_task",
  {
    title: "Edit a backlog task",
    description:
      "Edit an existing Mission Control backlog task by taskId. Only supplied fields change; " +
      "running or finished tasks are refused. Supports title, intent, kind, agent (harness), " +
      "model, effort, workflowId, enabled (backlog autopilot), priority, labels, callSign (a short spoken name; null clears it; a resident's task takes none), " +
      "dependencies, planInputs, " +
      "planInputChange ({from, to}, each an exact repoKey, planId, revision and files), and previewOnly. " +
      "With the Change pinned plan revision preview enabled, planInputChange replaces only that pin and its " +
      "superseded originating prerequisites, preserving unrelated dependencies. Do not combine it with " +
      "planInputs or dependencies. previewOnly validates without saving; inspect before and after, then " +
      "repeat with previewOnly false to save. Never choose a newer revision automatically. Supports " +
      "repository, and additionalRepositories. Null model/effort clears the override; advisorModel accepts " +
      "only null, which clears an advisor pin saved before the advisor moved to Settings -> Harnesses; changing " +
      "agent clears omitted model/effort overrides. Null workflowId opts out of the workflow; " +
      "null priority clears it. Arrays replace the saved set; [] clears it. Dependencies use " +
      "{type: 'task', taskId} or {type: 'session', sessionId}. Repository selectors accept an " +
      "absolute local checkout path or unique repository directory name. An empty title derives " +
      "a new title from the intent. Returns the saved task configuration without launching it. " +
      TASK_REFERENCE_RULE,
    inputSchema: {
      taskId: z.string().min(1).describe("Id of the backlog task to edit"),
      ...McpUpdateTaskSchema.shape,
    },
  },
  async ({ taskId, ...patch }) => {
    try {
      const res = await http(`/mcp/tasks/${encodeURIComponent(taskId)}/update`, "POST", patch);
      if (!res.ok) {
        return textResult(`Could not update task (${res.status}): ${await res.text()}`, true);
      }
      const result = (await res.json()) as { task: Task; before?: Task };
      return textResult(JSON.stringify(result.before ? { before: taskConfiguration(result.before), after: taskConfiguration(result.task) } : taskConfiguration(result.task), null, 2));
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "dispatch_task",
  {
    title: "Dispatch a saved task",
    description:
      "Launch a saved Mission Control task by taskId, including work just scheduled with create_task. " +
      "Uses the dashboard's dispatch rules: dependencies, workflow readiness, task kind, and " +
      "launch preflights still apply. Disabled backlog work is refused unless overrideDisabled is true. " +
      "The calling agent may set that override itself; disabled is an autopilot hold, not a human approval boundary. " +
      "defaultModel fills only an unpinned task's model. Returns the task and its current status; " +
      "dispatching means launch was accepted, not that the agent is running. Use get_task to check progress. " +
      "Uses the same daemon-token access as create_task; no Control other sessions opt-in is required.",
    inputSchema: {
      taskId: z.string().trim().min(1).describe("Id of the saved task to launch"),
      // Not the pause override: the operator's launch hold is not an agent's to lift, and the
      // daemon ignores the claim from this route anyway.
      ...DispatchBacklogTaskSchema.omit({ overridePauseHold: true }).shape,
    },
  },
  async ({ taskId, ...options }) => {
    try {
      const res = await http(`/mcp/tasks/${encodeURIComponent(taskId)}/dispatch`, "POST", options);
      if (!res.ok) {
        return textResult(`Could not dispatch task (${res.status}): ${await res.text()}`, true);
      }
      return textResult(JSON.stringify(await res.json(), null, 2));
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "cancel_task",
  {
    title: "Cancel a task",
    description:
      "Cancel a Mission Control task by taskId, including a running task with no sessionId. " +
      "Uses the dashboard's cancellation rules: stops agents launched for the task, preserves " +
      "archives, and cleans up owned resources. Assigned tasks stop being tracked without " +
      "killing the operator's existing session. Cleanup failures are returned and resources " +
      "remain tracked for retry; use get_task to inspect the resulting status. " +
      "Keeps the task record; use delete_task afterward to remove it. Uses the same daemon-token " +
      "access as create_task and delete_task; no Control other sessions opt-in is required. " +
      TASK_REFERENCE_RULE,
    inputSchema: McpCancelTaskSchema,
  },
  async ({ taskId }) => {
    const signal = AbortSignal.timeout(30_000);
    try {
      const res = await http("/mcp/tasks/cancel", "POST", { taskId }, false, signal);
      if (!res.ok) {
        return textResult(`Could not cancel task (${res.status}): ${await res.text()}`, true);
      }
      return textResult(JSON.stringify({ taskId, cancelled: true }));
    } catch (err) {
      const reason = signal.aborted ? "The cancellation request timed out." : `Could not reach Mission Control: ${String(err)}.`;
      return textResult(`${reason} Cancellation outcome is unknown; the task may already have changed. Use get_task to inspect its status before retrying.`, true);
    }
  },
);

server.registerTool(
  "delete_task",
  {
    title: "Delete a task",
    description:
      "Delete one Mission Control task by taskId. Backlog and finished tasks can be deleted; " +
      "running or dispatching tasks must be cancelled with cancel_task first. Uses the dashboard's deletion " +
      "rules, including archive preservation and resource cleanup. If cleanup is refused, " +
      "the task record remains and the error is returned. Returns the deleted task id. " +
      TASK_REFERENCE_RULE,
    inputSchema: McpDeleteTaskSchema,
  },
  async ({ taskId }) => {
    try {
      const res = await http("/mcp/tasks/delete", "POST", { taskId });
      if (!res.ok) {
        return textResult(`Could not delete task (${res.status}): ${await res.text()}`, true);
      }
      return textResult(JSON.stringify({ taskId, deleted: true }));
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

// This is the replacement for Claude's built-in `AskUserQuestion`, which dispatched sessions
// have taken away from them (see `src/server/ask-channel.ts`). It therefore has to cover what
// the built-in covered: a question with discrete options, answered by clicking one. `options`
// is optional so the same tool still serves a genuinely open-ended ask - one tool for the
// redirect prompt to name, with the agent choosing the SHAPE from the question rather than
// choosing between two tools.
//
// The description says what the tool DOES and what a decision asked through it carries
// (`DECISION_CONTEXT_RULE`: the decision, its context, each option's tradeoff) - true for
// every session that can call it. It deliberately does NOT claim
// that nobody is reading your terminal, or that this is the only way to reach your human:
// this one MCP server is shared by every session on the machine, including the ones a human
// started themselves, which keep `AskUserQuestion` on purpose and whose terminal usually IS
// being watched. Asserting it here would be false for that half of the fleet, and would push
// exactly those sessions off the built-in menu this change deliberately preserved for them.
// That instruction is dispatch-scoped and lives in `REDIRECT_PROMPT` (`ask-channel.ts`),
// which only ever reaches the sessions it is true for.
server.registerTool(
  "request_input",
  {
    title: "Ask the human a question",
    description:
      "File a question for your human operator in the Mission Control dashboard. The result " +
      "says which of two things happened. Either it carries their answer, selections, or an " +
      "explicit dismissal, because this call waited for them; or it is a receipt saying the " +
      "question is filed and NOT answered, in which case keep working on everything that does " +
      "not depend on it, do not ask it again or poll, and expect the answer later as a message " +
      "in this conversation. If you then run out of work, say what is waiting on the answer and " +
      "end your turn; Mission Control wakes you with it. Pass `meanwhile` to tell the operator " +
      "what you will do while the question is open. " +
      "The operator can always type an answer. With `options`, they can also " +
      "pick choices and add typed context. They may choose to chat about it, in which case the result tells you " +
      "how to proceed. Do not decide or re-ask that question yourself. They may also choose Remind me later. " +
      "the tool then returns at once WITHOUT an answer, saying how to carry on meanwhile (your " +
      "best judgment, a provisional option, or holding the dependent work). Follow it, do not " +
      "ask the question again, and expect the answer later as a message in this conversation. " +
      "If an earlier request_input call ended before the human answered (for example it timed " +
      "out) and you ask the same decision again, say so in the question (for example \"The " +
      "earlier request timed out.\") and offer exactly the same options. Mission Control " +
      "withdraws the earlier card only when it recognizes the new ask as the same decision with " +
      "the same options; otherwise both cards stay and the human may answer both. A different " +
      "question, or different options, never withdraws an earlier one. " +
      "Pass `options` whenever the answer is a choice between discrete alternatives. Omit " +
      "`options` only for open-ended asks. " +
      DECISION_CONTEXT_RULE,
    inputSchema: {
      question: z.string().describe("The decision or question itself, in one or two sentences"),
      context: z
        .string()
        .max(DECISION_CONTEXT_MAX_CHARS)
        .optional()
        .describe(
          "What the human needs to answer without your context: what is being decided, why it " +
            "came up, what you found, and the tradeoffs. Shown beneath the question. Write context as markdown.",
        ),
      options: z
        .array(
          z.object({
            label: z.string().describe("What the human reads on the control"),
            detail: z.string().optional().describe("One line: this option's tradeoff - what it gains and what it costs"),
            recommended: z
              .boolean()
              .optional()
              .describe("Marks a suggested choice; does not preselect"),
          }),
        )
        .max(PLAN_DECISION_LIMITS.options)
        .optional()
        .describe("Discrete choices. Omit entirely for a free-text answer."),
      multiSelect: z
        .boolean()
        .optional()
        .describe("Checkboxes (choose many) when true, radios (choose one) otherwise"),
      allowOther: z
        .boolean()
        .optional()
        .describe("Deprecated compatibility field. The text box is always available."),
      meanwhile: z
        .string()
        .max(MEANWHILE_MAX_CHARS)
        .optional()
        .describe(
          "One line, shown on the operator's card: what you will do while the question is open - " +
            "the assumption you proceed on, or the work you hold back until the answer arrives.",
        ),
    },
  },
  async ({ question, context, options, multiSelect, meanwhile }, extra) => {
    // Refused before any review exists: a card the human cannot answer would leave this call,
    // and the session, waiting on something nobody can resolve. The daemon's schema enforces
    // the same rule; checking here first lets the agent read why instead of a transport error.
    const problem = inputQuestionProblem(question, options);
    if (problem) {
      return textResult(
        `Not asked: ${problem}. Nothing was shown to the human and nothing is waiting on them. ` +
          "Fix the question and call request_input again.",
        true,
      );
    }
    try {
      // One construction for every `request_input` review (`@shared/request-input.ts`): a
      // heading clipped from the question, the question followed by its context as the body
      // (`inputReviewBody`), and positional option ids, which the human's answer never shows the
      // agent - it comes back as LABELS. A resident's proposed instruction changes are asked
      // through the same builder.
      const ask = requestInputReview({ question, context, options, multiSelect });
      // `asyncCapable`: the daemon decides how this ask waits. Told `message`, the question is
      // filed and the receipt is the whole result - nothing long-polls, so nothing can time out.
      const created = await postReview({
        kind: ask.kind, title: ask.title, body: ask.body, decisions: ask.decisions,
        snoozable: true, asyncCapable: true, ...(meanwhile?.trim() ? { meanwhile } : {}),
      });
      if (created.wait === "message") return textResult(created.receipt);
      const review = await waitForResolution(created.id, extra, true);
      if (review.converted) return textResult(review.converted.receipt);
      const result = reviewToolResult(review);
      return textResult(result.text, result.isError);
    } catch (err) {
      if (err instanceof AskRefused) return textResult(err.message, true);
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "list_open_questions",
  {
    title: "List your open questions",
    description: "List your own outstanding request_input questions, including snoozed questions and questions waiting in a call, and your filed request_plan_decisions forms. Each entry names its kind. Requires async-input. Use for housekeeping, never to poll for answers: answers arrive as messages.",
    inputSchema: {},
  },
  async () => {
    try {
      const res = await http("/mcp/questions/list", "POST", { env: ENV, sessionId: SESSION_ID, cwd: process.cwd() }, false, AbortSignal.timeout(30_000));
      return textResult(await res.text(), !res.ok);
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "withdraw_question",
  {
    title: "Withdraw your question",
    description: "Withdraw one of your own open message-mode questions, or a filed request_plan_decisions form, that you no longer need, with a reason - for example because the operator told you the plan's scope changed. Requires async-input. Cannot withdraw another session's ask or one whose tool call waits for an answer. No answer message is sent.",
    inputSchema: { id: z.string().min(1), reason: z.string().trim().min(1).max(2000) },
  },
  async ({ id, reason }) => {
    try {
      const res = await http(`/mcp/questions/${encodeURIComponent(id)}/withdraw`, "POST", { env: ENV, sessionId: SESSION_ID, cwd: process.cwd(), reason }, false, AbortSignal.timeout(30_000));
      return textResult(await res.text(), !res.ok);
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

/**
 * The when-to-report paragraph for `post_report`, read once as this child starts: the operator's
 * guidance from Settings > Reports, or the default when the daemon does not answer in time, has
 * the `inbox` flag off, or answers anything unexpected. Read once, so a session keeps the
 * guidance it started with and an edit reaches the sessions started after it.
 */
async function readPostReportGuidance(): Promise<string> {
  try {
    const res = await http("/mcp/reports/guidance", "GET", undefined, false, AbortSignal.timeout(1_500));
    if (!res.ok) return REPORT_GUIDANCE;
    const body = (await res.json()) as { guidance?: unknown };
    const guidance = typeof body.guidance === "string" ? body.guidance.slice(0, REPORT_GUIDANCE_LIMIT) : null;
    return postReportGuidance(guidance);
  } catch {
    return REPORT_GUIDANCE;
  }
}
const POST_REPORT_GUIDANCE = await readPostReportGuidance();

// An agent's report for the operator to read (`inbox` flag). Non-blocking, like
// `respond_to_file_comments`: the daemon stores it and the receipt is the whole result, so the
// agent carries on. It is not a question and never waits on anyone.
server.registerTool(
  "post_report",
  {
    title: "Post a report for the operator to read",
    description:
      "Post a report to your human operator's Mission Control inbox, where it waits to be read. " +
      POST_REPORT_GUIDANCE + " " +
      "Returns at once with the report's id; do not wait for a reply. To correct or update a report " +
      "you posted earlier, pass its id as `replaces`: the new report takes the earlier one's place " +
      "in the inbox. Reports posted without `replaces` stack.",
    inputSchema: {
      title: z.string().trim().min(1).max(REPORT_LIMITS.title)
        .describe("One line: what the operator reads as the heading, e.g. 'Build failure diagnosed'"),
      body: z.string().trim().min(1).max(REPORT_LIMITS.body)
        .describe("Markdown: what you found or did, and what the operator should do with it"),
      file: z.string().trim().min(1).max(REPORT_LIMITS.path).optional()
        .describe("A checkout-relative .html or .md document to attach. Mission Control keeps a copy."),
      url: z.string().trim().url().max(REPORT_LIMITS.url)
        .refine((v) => /^https?:\/\//i.test(v), { message: "must be an http(s) URL" })
        .optional()
        .describe("An http(s) link to go with the report, e.g. a pull request"),
      replaces: z.string().trim().regex(REPORT_ID_PATTERN, "must be a report id such as r-12").optional()
        .describe("The id of one of your earlier reports, still unread, that this one replaces"),
    },
  },
  async (input) => {
    try {
      const res = await http("/mcp/reports", "POST", { env: ENV, sessionId: SESSION_ID, cwd: process.cwd(), ...input },
        false, AbortSignal.timeout(30_000));
      const body = (await res.json().catch(() => ({}))) as { receipt?: string; error?: string; feature?: string };
      if (res.status === 404 && body.feature) {
        return textResult("Not posted: agent reports are turned off in Mission Control (Settings > Feature flags > " +
          "Reports and inbox upgrades). Nothing was shown to the operator. Say what you would have reported in " +
          "your reply instead.", true);
      }
      if (!res.ok || !body.receipt) {
        return textResult(`Not posted (${res.status}): ${body.error ?? "Mission Control refused the report"}`, true);
      }
      return textResult(body.receipt);
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

// The MCP entry point uses the dashboard's report contract and daemon service.
const productIssueTransport = {
  requestId: randomUUID,
  preview: async (request: ProductIssueRequest) => responseResult(await http(
    "/mcp/product-issues/preview", "POST",
    { env: ENV, sessionId: SESSION_ID, cwd: process.cwd(), ...request },
  )),
  submit: async (request: ProductIssueRequest) => responseResult(await http(
    "/mcp/product-issues", "POST",
    { env: ENV, sessionId: SESSION_ID, cwd: process.cwd(), ...request },
  )),
};

server.registerTool(
  "report_product_issue",
  {
    title: "Report a Mission Control product issue",
    description:
      "Prepare a public GitHub issue draft when the user explicitly requests a Mission Control report. " +
      "For the built-in Bug Fix Inspector, the operator's launch is a standing request to prepare drafts " +
      "for confirmed defects on the first and scheduled passes of that run. Each draft still requires separate " +
      "human approval: Mission Control shows the exact public content in the dashboard and BLOCKS until " +
      "the human selects Submit public issue or dismisses it. Optional screenshot " +
      "upload ids must come from Mission Control and require GitHub CLI 2.99.0 or newer.",
    inputSchema: {
      ...ProductIssueDraftSchema.shape,
      expectedTarget: z.string().min(1).max(140).optional()
        .describe("GitHub owner/repository already checked for duplicates. A mismatch stops the report before approval."),
    },
  },
  async (draft, extra) => {
    try {
      const result = await reportProductIssueWithConfirmation(
        draft,
        PRODUCT_ISSUE_CLIENT,
        {
          ...productIssueTransport,
          createReview: ({ title: reviewTitle, body, decisions }) =>
            createReview("input", reviewTitle, body, decisions),
          waitForResolution: (id: string) => waitForResolution(id, extra),
        },
      );
      return textResult(result.text, result.isError);
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "report_status",
  {
    title: "Report a status line",
    description: "Update this session's one-line activity in the Mission Control dashboard.",
    inputSchema: { activity: z.string().describe("A short status, e.g. 'running the test suite'") },
  },
  async ({ activity }) => {
    try {
      await http("/mcp/status", "POST", { env: ENV, sessionId: SESSION_ID, activity });
      return textResult("ok");
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

// The blocked session's own record. Validated here AND in `McpReportBlockerSchema`, the
// project's rule for MCP arguments (see docs/agent-guides/change-contracts.md).
const blockerLine = (max: number, what: string) =>
  z.string().trim().min(1).max(max).refine((v) => !/[\r\n]/.test(v), { message: "must be one line" }).describe(what);

server.registerTool(
  "report_blocker",
  {
    title: "Report that this session is blocked",
    description:
      "Use only when you are waiting on someone or something other than the operator. For a " +
      "decision the operator can make, call request_input instead. Ask your question where its " +
      "owner will see it first (for example Commonroom), then report the blocker with a link " +
      "to that question, and end your turn. Mission Control keeps the blocker across turns and " +
      "restarts and holds automatic completion while it stands. Calling it again updates the " +
      "blocker and keeps its start time.",
    inputSchema: {
      kind: z.enum(SESSION_BLOCKER_KINDS).describe(
        "question: asked someone else, somewhere else; dependency: waiting on a PR, task or " +
          "another team; service: a service, environment or credential is unavailable; other.",
      ),
      reason: blockerLine(SESSION_BLOCKER_LIMITS.reason, "One line: what you cannot do yet"),
      waitingOn: blockerLine(SESSION_BLOCKER_LIMITS.waitingOn, "Who owns the answer, e.g. 'Dana (platform) in #data-platform'"),
      resumeWhen: blockerLine(SESSION_BLOCKER_LIMITS.resumeWhen, "One line: the condition that unblocks you"),
      referenceUrl: z.string().trim().url().max(SESSION_BLOCKER_LIMITS.url)
        .refine((v) => /^https?:\/\//i.test(v), { message: "must be an http(s) URL" })
        .optional()
        .describe("http(s) link to the question, PR or status page"),
      details: z.string().trim().max(SESSION_BLOCKER_LIMITS.details).optional()
        .describe("Markdown for the operator to review: options considered, context"),
    },
  },
  async (input) => {
    try {
      const res = await http("/mcp/blocker", "POST", { env: ENV, sessionId: SESSION_ID, ...input });
      const body = (await res.json()) as { created?: boolean; error?: string };
      if (!res.ok) {
        return textResult(`Mission Control refused this blocker (${res.status}): ${body.error ?? "unknown refusal"}`, true);
      }
      return textResult(
        `${body.created ? "Blocker recorded" : "Blocker updated"}. End your turn now. Mission Control will ` +
          "not run automatic completion while it stands. When you are told to check again, check: if it " +
          "is resolved, call clear_blocker and continue the work; otherwise call report_blocker again " +
          "and end your turn.",
      );
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "clear_blocker",
  {
    title: "Clear this session's blocker",
    description:
      "Call when what you reported with report_blocker is resolved, then continue the work. " +
      "Clearing a session with no blocker does nothing.",
    inputSchema: {
      resolution: blockerLine(SESSION_BLOCKER_LIMITS.resolution, "One line: what resolved it").optional(),
    },
  },
  async ({ resolution }) => {
    try {
      const res = await http("/mcp/blocker/clear", "POST", { env: ENV, sessionId: SESSION_ID, resolution });
      const body = (await res.json()) as { cleared?: boolean; error?: string };
      if (!res.ok) {
        return textResult(`Mission Control refused this clear (${res.status}): ${body.error ?? "unknown refusal"}`, true);
      }
      return textResult(body.cleared ? "Blocker cleared. Continue the work." : "There was no blocker to clear.");
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

// A session idle on purpose while a background process finishes. Validated here AND in
// `McpReportAwaitingSchema`, the project's rule for MCP arguments.
server.registerTool(
  "report_awaiting",
  {
    title: "Declare that this session is waiting on a background process",
    description:
      "Use when you have handed work to a background process and have nothing to do until it finishes: " +
      "CI checks on a pull request you pushed, a long build or test run you started in the background, a " +
      "monitor watching a deploy, or a scheduled wakeup you set for yourself. You must expect to be woken " +
      "by that process (a background command's completion notification, a monitor, or a wakeup) and intend " +
      "to finish the work then. Mission Control shows the wait on your card and holds idle automation " +
      "(completion nudges, stuck-session alerts) until expectedBy passes. The wait ends on its own " +
      "when your next turn starts, so when you wake and the process is still running, call this again. " +
      "Do NOT use it to wait on a person: for the operator call request_input, for anyone else call " +
      "report_blocker. Refused while you have a request_input question pending or a blocker standing.",
    inputSchema: {
      what: blockerLine(SESSION_AWAITING_LIMITS.what, "One line: what you are waiting for, e.g. 'CI checks on PR #1612'"),
      wakeSource: z.enum(SESSION_AWAITING_WAKE_SOURCES).describe(
        "How you will be woken. command: a background command's completion notification; monitor: a " +
          "monitor or watcher you started; wakeup: a scheduled wakeup you set; other.",
      ),
      expectedBy: z.string().trim().datetime({ offset: true })
        .describe(
          "Required. When the process should be done, as an ISO 8601 date-time with a time zone, e.g. " +
            "2026-11-20T15:40:00Z or 2026-11-20T10:40:00-05:00. It must be in the future and at most " +
            `${SESSION_AWAITING_LIMITS.maxMinutes} minutes from now (read the time with ` +
            "`date -u +%Y-%m-%dT%H:%M:%SZ` if you need it). Past it the card turns Overdue and the normal " +
            "stuck-session handling applies again, so give a realistic bound, not a hopeful one.",
        ),
      referenceUrl: z.string().trim().url().max(SESSION_AWAITING_LIMITS.url)
        .refine((v) => /^https?:\/\//i.test(v), { message: "must be an http(s) URL" })
        .optional()
        .describe("http(s) link to the pull request checks, run or deploy"),
      details: z.string().trim().max(SESSION_AWAITING_LIMITS.details).optional()
        .describe("Markdown notes for the operator, e.g. the command you started"),
    },
  },
  async (input) => {
    try {
      // The session's signed credential names the caller; the daemon refuses a body naming another.
      const res = await http("/mcp/awaiting", "POST", { env: ENV, sessionId: SESSION_ID, ...input }, true);
      const body = (await res.json().catch(() => ({}))) as { created?: boolean; error?: string; feature?: string };
      if (res.status === 404 && body.feature) {
        return textResult(
          "Not recorded: declaring a wait is turned off in Mission Control (Settings > Feature flags). " +
            "End your turn as you would have; you will still be woken by your background process.",
          true,
        );
      }
      if (!res.ok) {
        return textResult(`Mission Control refused this wait (${res.status}): ${body.error ?? "unknown refusal"}`, true);
      }
      return textResult(
        `${body.created ? "Wait recorded" : "Wait updated"}. End your turn now. Mission Control holds idle ` +
          `automation until the deadline, and the wait ends by itself when your next turn starts. If you wake ` +
          "and the process is still running, call report_awaiting again before ending that turn. If the work " +
          "turns out not to need the process after all, call clear_awaiting.",
      );
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "clear_awaiting",
  {
    title: "End this session's declared wait",
    description:
      "Call when the wait you declared with report_awaiting no longer applies, for example you cancelled " +
      "the background process. You do not need to call it after being woken: your next turn ends the wait " +
      "by itself. Clearing a session with no wait does nothing.",
    inputSchema: {
      resolution: blockerLine(SESSION_AWAITING_LIMITS.resolution, "One line: why the wait ended").optional(),
    },
  },
  async ({ resolution }) => {
    try {
      const res = await http("/mcp/awaiting/clear", "POST", { env: ENV, sessionId: SESSION_ID, resolution }, true);
      // A non-JSON reply (an empty body, an HTML error page) still reached Mission Control: report
      // its real status rather than "could not reach".
      const body = (await res.json().catch(() => ({}))) as { cleared?: boolean; error?: string };
      if (!res.ok) {
        return textResult(`Mission Control refused this clear (${res.status}): ${body.error ?? "unknown refusal"}`, true);
      }
      return textResult(body.cleared ? "Wait cleared." : "There was no wait to clear.");
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

// Answer one line comment a human left on a file, in the thread it was written in.
//
// Non-blocking: no `extra`, no long poll. The agent posts its answer
// and carries on with the work the comment asked for - waiting on a human here would stall the
// very turn the comment exists to steer.
server.registerTool(
  "respond_to_file_comments",
  {
    title: "Answer a line comment",
    description:
      "Answer a line comment Mission Control delivered, quoting the id it was delivered " +
      "with. The answer appears in that comment's thread, on that line, for the human to " +
      "read, and it is what releases the next comment in the review. Returns immediately " +
      "without waiting.",
    inputSchema: {
      commentId: z
        .string()
        .describe(
          "The id the comment was delivered with, exactly as the message printed it - " +
            "'MC-a41f.2', short id and delivery ordinal. NOT a uuid. The trailing ordinal " +
            "is what says which delivery you are answering, so quote the whole thing.",
        ),
      body: z.string().describe("Your answer, as the human will read it in the thread"),
      addressed: z
        .boolean()
        .optional()
        .describe(
          "True when you actually changed the code or document this comment asked about. " +
            "It marks the thread as handled for the human; only they can resolve it.",
        ),
    },
  },
  async ({ commentId, body, addressed }) => {
    try {
      const res = await http("/mcp/file-comments/replies", "POST", {
        env: ENV,
        sessionId: SESSION_ID,
        cwd: process.cwd(),
        commentId,
        body,
        addressed,
      });
      const result = (await res.json()) as {
        commentId?: string;
        released?: boolean;
        error?: string;
      };
      if (!res.ok) {
        return textResult(
          `Mission Control refused this answer (${res.status}): ${result.error ?? "unknown refusal"}`,
          true,
        );
      }
      // The two outcomes read differently on purpose. A reply that released the turn means
      // the next comment is on its way; one that did not is a late answer to a comment the
      // review has already moved past, and saying so is what stops the agent waiting for a
      // comment that is not coming because of this call.
      return textResult(
        result.released
          ? `Answered ${result.commentId}. The next comment follows if the review has one.`
          : `Answered ${result.commentId}. It was not the comment currently out with you, so it advanced nothing.`,
      );
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "adopt_pipeline_run",
  {
    title: "Adopt an existing Pipeline run",
    description:
      "Use only when this managed Pipeline Engineer host resumes an existing run whose slug differs from the reserved run in its launch instruction.",
    inputSchema: { slug: z.string().trim().min(1).describe("The observed existing run slug") },
  },
  async ({ slug }) => {
    if (!PIPELINE_CALLER_CREDENTIAL) {
      return textResult("Mission Control did not issue Pipeline host identity to this session.", true);
    }
    try {
      const res = await http(
        "/mcp/pipelines/adopt",
        "POST",
        { slug },
        false,
        undefined,
        { [PIPELINE_CALLER_CREDENTIAL_HEADER]: PIPELINE_CALLER_CREDENTIAL },
      );
      const body = (await res.json()) as { replayed?: boolean; error?: string };
      if (!res.ok) {
        return textResult(
          `Mission Control refused Pipeline run adoption (${res.status}): ${body.error ?? "unknown refusal"}`,
          true,
        );
      }
      return textResult(
        body.replayed
          ? `This task already continues in ${slug}.`
          : `This task now continues in ${slug}.`,
      );
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "report_pipeline_workspace",
  {
    title: "Report the Pipeline authoring workspace",
    description:
      "Use from a managed Pipeline Engineer host immediately after creating or entering its provider-owned authoring worktree, before editing files there.",
    inputSchema: {
      path: z.string().trim().min(1).describe("Absolute path to the Engineer authoring worktree"),
    },
  },
  async ({ path }) => {
    if (!PIPELINE_CALLER_CREDENTIAL) {
      return textResult("Mission Control did not issue Pipeline host identity to this session.", true);
    }
    try {
      const res = await http(
        "/mcp/pipelines/workspace",
        "POST",
        { path },
        false,
        undefined,
        { [PIPELINE_CALLER_CREDENTIAL_HEADER]: PIPELINE_CALLER_CREDENTIAL },
      );
      const body = (await res.json()) as { replayed?: boolean; error?: string };
      if (!res.ok) {
        return textResult(
          `Mission Control refused the Pipeline workspace (${res.status}): ${body.error ?? "unknown refusal"}`,
          true,
        );
      }
      return textResult(
        body.replayed
          ? `Mission Control is already tracking ${path}.`
          : `Mission Control now tracks Pipeline files and diffs in ${path}.`,
      );
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

// The no-change exit for a POST-MERGE retro follow-up. It accepts no task id, outcome, or
// dependency instruction: the daemon derives the calling Task from inherited session evidence
// and refuses the operation unless that Task owns a durable retro-followup relation.
server.registerTool(
  "complete_retro_no_change",
  {
    title: "Complete a retro with no approved changes",
    description:
      "Use only when this post-merge retro follow-up has no approved memory changes. " +
      "Mission Control completes this retro task without a commit, pull request, or review.",
    inputSchema: {},
  },
  async () => {
    try {
      const res = await http("/mcp/retros/no-change", "POST", {
        env: ENV,
        sessionId: SESSION_ID,
        cwd: process.cwd(),
      });
      if (!res.ok) {
        return textResult(
          `Mission Control refused no-change retro completion (${res.status}): ${await res.text()}`,
          true,
        );
      }
      const body = (await res.json()) as { replayed?: boolean };
      return textResult(
        body.replayed
          ? "This retro was already completed with no approved memory changes."
          : "Retro completed with no approved memory changes. No commit or pull request is needed.",
      );
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

// Submit this ensemble member's finished work for comparison. The member NEVER names itself: the
// daemon derives which member from this session's pane/id/cwd, so the arguments carry only the
// member's own bounded claims - no ensemble, member, task, session, worktree, artifact or ref id.
// The zod here is a hand-written mirror of `SubmitEnsembleResultSchema` in `@shared/protocol.ts`;
// the two are duplicated deliberately, and change together.
server.registerTool(
  "submit_ensemble_result",
  {
    title: "Submit an ensemble result",
    description:
      "When your ensemble candidate is ready to be compared, submit it. Mission Control captures " +
      "your working tree as an immutable snapshot and records your summary and reported checks as " +
      "claims. Do not push, open a PR, or run the shipping gate - a winner is chosen afterwards.",
    inputSchema: {
      summary: z
        .string()
        .min(1)
        .max(ENSEMBLE_LIMITS.submissionSummary)
        .describe("A concise summary of what you did."),
      checks: z
        .array(z.string().min(1).max(ENSEMBLE_LIMITS.submissionCheck))
        .max(ENSEMBLE_LIMITS.submissionChecks)
        .optional()
        .describe("The checks you actually ran. Do not claim a check you did not run."),
      testEvidence: z
        .string()
        .max(ENSEMBLE_LIMITS.submissionTestEvidence)
        .optional()
        .describe("Optional test output you chose to include."),
    },
  },
  async ({ summary, checks, testEvidence }) => {
    try {
      const res = await http("/mcp/ensembles/submit", "POST", {
        env: ENV,
        sessionId: SESSION_ID,
        cwd: process.cwd(),
        result: { summary, checks: checks ?? [], testEvidence: testEvidence ?? null },
      });
      if (!res.ok) {
        const detail = await res.text();
        return textResult(`Mission Control refused the submission (${res.status}): ${detail}`, true);
      }
      const body = (await res.json()) as {
        artifact?: { kind?: string; shortSha?: string; fingerprint?: string };
        replayed?: boolean;
      };
      const ref = body.artifact?.shortSha ?? body.artifact?.fingerprint ?? "captured";
      return textResult(
        body.replayed
          ? `Already submitted; returning the existing snapshot (${ref}). You can stop.`
          : `Submitted. Your work was captured as an immutable snapshot (${ref}). You can stop.`,
      );
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "get_plan_publication_context",
  {
    title: "Read plan PR ownership",
    description: "Before a planning skill creates a pull request, read who owns publication. " +
      "A workflow owner means finish planning and yield; a skill owner means the skill may follow " +
      "its direct PR path, subject to the task's instructions. Unavailable context is not permission " +
      "to publish. This read never authorizes merge or overrides a no-PR/completion handoff.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const response = await http("/mcp/plan-publication", "POST", {
        env: ENV, sessionId: SESSION_ID, cwd: process.cwd(),
      });
      if (!response.ok) return textResult(`Could not read plan publication ownership (${response.status}): ${await response.text()}`, true);
      const context = PlanPublicationContextSchema.parse(await response.json());
      return textResult(JSON.stringify(context), context.owner === "unavailable");
    } catch (error) {
      return textResult(`Could not read plan publication ownership: ${String(error)}`, true);
    }
  },
);

async function managedPlanCall(operation: string, input: unknown) {
  try {
    const payload = operation === "read" ? { input } : input;
    const response = await http(`/mcp/plans/${operation}`, "POST", {
      ...payload as object, env: ENV, sessionId: SESSION_ID, cwd: process.cwd(),
    });
    return textResult(await response.text(), !response.ok);
  } catch (error) { return textResult(`Managed plan ${operation} failed: ${String(error)}`, true); }
}
server.registerTool("get_pull_request_policy", {
  description: "Read the current machine-wide PR creation policy from Settings > Skills. Call immediately before creating each PR, including workflow PR phases. When alwaysDraftPr is true, create with --draft and leave promotion to the human. An unavailable policy is not permission to create a ready PR.",
  inputSchema: {}, annotations: { readOnlyHint: true },
}, async () => {
  try {
    const response = await http("/api/skills/pull-request-policy", "GET");
    if (!response.ok) return textResult(`Could not read pull request policy (${response.status}): ${await response.text()}`, true);
    // No default here: an old daemon or malformed response is not an opt-out.
    const policy = z.object({ alwaysDraftPr: z.boolean() }).parse(await response.json());
    return textResult(JSON.stringify(policy));
  } catch (error) {
    return textResult(`Could not read pull request policy: ${String(error)}`, true);
  }
});
server.registerTool("schedule_next_iteration", {
  description: "Set the next resident wake delay within your pinned profile bounds. During a turn the delay starts at completion. Returns a callId; replay that id after any unknown outcome to read the original receipt safely. A new callId is a new intent.",
  inputSchema: ScheduleNextIterationSchema.extend({ callId: z.string().min(1).max(200).optional() }).shape,
}, async (input) => {
  const result = await scheduleResidentIteration(input, (body, signal) =>
    http("/mcp/residents/schedule-next-iteration", "POST", body, true, signal));
  return textResult(JSON.stringify(result), "code" in result);
});
// A resident reading and editing its own standing role. Neither tool names a session, run or
// profile: the daemon attributes the signed session, as it does for schedule_next_iteration.
server.registerTool("get_resident_instructions", {
  title: "Read your resident standing instructions",
  description:
    "Residents only. Read the CURRENT text of your resident profile's instructions and of the " +
    "Persona guidance it names, with their revisions and whether each can be edited. Copy passages " +
    "from here, exactly, into propose_resident_instruction_changes. You keep running on the revision " +
    "you launched with (runProfileRevision) until the operator chooses Restart on new profile.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  try {
    const res = await http("/mcp/residents/instructions", "GET", undefined, true);
    return textResult(await res.text(), !res.ok);
  } catch (err) {
    return textResult(`Could not reach Mission Control: ${String(err)}`, true);
  }
});
server.registerTool("propose_resident_instruction_changes", {
  title: "Propose changes to your resident standing instructions",
  description:
    "Residents only. Ask the operator, as a request_input question listing every change in full, " +
    "which changes to your profile instructions (target profile) or your Persona's guidance " +
    "(target persona) to apply, and BLOCK until they answer. They select the changes; Mission " +
    "Control writes only those, as the next profile or Persona revision, and returns what was " +
    "applied and any guidance they wrote. Do not ask the same thing with request_input yourself. " +
    "Each change either replaces " +
    "one passage (find, copied exactly from get_resident_instructions, occurring once) with " +
    "replace, removes it (empty replace), or appends replace as a new passage (omit find). Put " +
    "how this resident should work in the profile; use the Persona only for guidance every user " +
    "of that Persona should follow. Never edit files or settings to make these changes yourself. " +
    "If this call ends before they answer, their selection is still applied when they do.",
  inputSchema: ProposeResidentInstructionChangesSchema.shape,
}, async (input, extra) => {
  try {
    const res = await http("/mcp/residents/instructions/proposals", "POST", input, true);
    if (!res.ok) {
      return textResult(
        `${await res.text()} (${res.status}). Nothing was shown to the operator and nothing changed.`,
        true,
      );
    }
    const { reviewId } = (await res.json()) as { reviewId: string };
    await waitForResolution(reviewId, extra);
    const read = await http(`/mcp/residents/instructions/proposals/${encodeURIComponent(reviewId)}`, "GET", undefined, true);
    if (!read.ok) {
      return textResult(
        `The operator answered, but the outcome could not be read (${read.status}): ${await read.text()}. ` +
          "Call get_resident_instructions to see the current text.",
        true,
      );
    }
    const outcome = (await read.json()) as ResidentInstructionOutcome;
    return textResult(
      residentInstructionOutcomeText(outcome),
      outcome.status === "stale" || outcome.status === "refused" || outcome.status === "orphaned",
    );
  } catch (err) {
    return textResult(`Could not reach Mission Control: ${String(err)}`, true);
  }
});
server.registerTool("get_plan_context", {
  description: "Resolve the registered session's repository plan policy and local preview store. Call before authoring a managed plan. A missing registration refuses; never fall back to unmanaged HTML writes.",
  inputSchema: PlanContextInputSchema.shape, annotations: { readOnlyHint: true },
}, async (input) => managedPlanCall("context", input));
server.registerTool("save_plan", {
  description: "Save a complete immutable Markdown and static HTML plan bundle. Use a UUID requestId for retries, expectedRevision 0 for creation, then the returned planId/revision. The daemon pins policy and writes eligible checkout files. Saving does not approve, commit, push or publish. Files are flat bounded UTF-8 content; each Markdown file needs a same-name HTML rendering.",
  inputSchema: SavePlanInputSchema.shape,
}, async (input) => managedPlanCall("save", input));
server.registerTool("publish_plan", {
  description: "Publish an exact approved local plan-only revision. The daemon verifies current human approval, work episode, clean plan-only checkout and successful applicable workflow. No Git or PR is created. Workflow completion also reconciles owed receipts. Mixed/code tasks retain merge publication.",
  inputSchema: PlanReviewInputSchema.shape,
}, async (input) => managedPlanCall("publish", input));
server.registerTool("read_plan", {
  description: "Read an exact managed plan revision and optionally one file, or list the authorized repository's saved plans. Catalog reads return {plans, nextCursor}; pass nextCursor as cursor with the same repoSlot until nextCursor is null. Revisions and local previews survive authoring-worktree cleanup.",
  inputSchema: ReadPlanInputSchema.shape, annotations: { readOnlyHint: true },
}, async (input) => managedPlanCall("read", input));

// Register workflow evidence without letting the caller select a session, task, or root. The
// daemon attributes the existing launch environment and resolves repository slots itself.
// The zod here mirrors the locator bounds in `SubmitWorkflowEvidenceSchema`; the bridge adds
// the fixed `agent` discriminator and its own launch identity to the authenticated request.
server.registerTool(
  "submit_workflow_evidence",
  {
    title: "Register workflow evidence",
    description:
      "Register gitignored screenshots, focused UTF-8 text/log artifacts, or the exact command, exit " +
      "code, and output from a completed focused check for the Persona workflow that will run when " +
      "this task completes. Optionally map acceptance criteria to that evidence with proof classes and " +
      "roles. Mission Control freezes applicable evidence and coverage into the immutable submission. " +
      "Do not commit evidence artifacts.",
    inputSchema: {
      images: z.array(z.object({
        clientItemId: z.string().min(1).max(WORKFLOW_IMAGE_LIMITS.clientItemIdChars)
          .describe("Stable caller id used to make an identical registration idempotent."),
        path: z.string().min(1).max(WORKFLOW_IMAGE_LIMITS.relativePathChars)
          .describe("Path relative to the issued repository checkout."),
        caption: z.string().trim().min(1).max(WORKFLOW_IMAGE_LIMITS.captionChars)
          .describe("A precise statement of what the screenshot demonstrates."),
        repositoryScope: z.union([
          z.literal("all"),
          z.string().regex(/^repo-\d{2}$/),
        ]).describe("An issued repository slot such as repo-01, or all."),
      }))
        .max(WORKFLOW_IMAGE_LIMITS.maxCount)
        .refine(
          (value) => new Set(value.map((item) => item.clientItemId)).size === value.length,
          "Workflow evidence client item ids must be unique",
        )
        .refine(
          (value) => Buffer.byteLength(JSON.stringify(value)) <= WORKFLOW_IMAGE_LIMITS.locatorJsonBytes,
          `Workflow evidence locators exceed ${WORKFLOW_IMAGE_LIMITS.locatorJsonBytes} UTF-8 bytes`,
        )
        .optional()
        .describe("Optional gitignored screenshot evidence."),
      artifacts: z.array(z.object({
        clientItemId: z.string().min(1).max(WORKFLOW_TEXT_EVIDENCE_LIMITS.clientItemIdChars)
          .describe("Stable caller id used to make an identical registration idempotent."),
        path: z.string().min(1).max(WORKFLOW_TEXT_EVIDENCE_LIMITS.relativePathChars)
          .describe("Path to a UTF-8 text or log file, relative to the issued repository checkout."),
        caption: z.string().trim().min(1).max(WORKFLOW_TEXT_EVIDENCE_LIMITS.captionChars)
          .describe("A precise statement of what the text or log demonstrates."),
        repositoryScope: z.union([
          z.literal("all"),
          z.string().regex(/^repo-\d{2}$/),
        ]).describe("An issued repository slot such as repo-01, or all."),
      }))
        .max(WORKFLOW_TEXT_EVIDENCE_LIMITS.maxCount)
        .refine(
          (value) => new Set(value.map((item) => item.clientItemId)).size === value.length,
          "Workflow evidence client item ids must be unique",
        )
        .refine(
          (value) => Buffer.byteLength(JSON.stringify(value)) <= WORKFLOW_TEXT_EVIDENCE_LIMITS.locatorJsonBytes,
          `Workflow text evidence locators exceed ${WORKFLOW_TEXT_EVIDENCE_LIMITS.locatorJsonBytes} UTF-8 bytes`,
        )
        .optional()
        .describe("Optional gitignored focused test output or other UTF-8 text evidence."),
      commandOutputs: z.array(z.object({
        clientItemId: z.string().min(1).max(WORKFLOW_TEXT_EVIDENCE_LIMITS.clientItemIdChars)
          .describe("Stable caller id used to make an identical registration idempotent."),
        command: z.string().trim().min(1).max(WORKFLOW_LIMITS.checkCommandLength)
          .describe("The exact focused command that completed."),
        exitCode: WorkflowCommandExitCodeSchema
          .describe("The completed command's process exit code."),
        output: z.string().max(WORKFLOW_TEXT_EVIDENCE_LIMITS.maxBytesPerArtifact)
          .describe("The exact completed stdout/stderr output. Empty is allowed when the command printed nothing."),
        caption: z.string().trim().min(1).max(WORKFLOW_TEXT_EVIDENCE_LIMITS.captionChars)
          .describe("A precise statement of the behavior this command output demonstrates."),
        repositoryScope: z.union([
          z.literal("all"),
          z.string().regex(/^repo-\d{2}$/),
        ]).describe("An issued repository slot such as repo-01, or all."),
      }).superRefine((value, ctx) => {
        if (
          Buffer.byteLength(workflowCommandEvidenceContent(value))
          > WORKFLOW_TEXT_EVIDENCE_LIMITS.maxBytesPerArtifact
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["output"],
            message: `Workflow command evidence exceeds ${WORKFLOW_TEXT_EVIDENCE_LIMITS.maxBytesPerArtifact} UTF-8 bytes`,
          });
        }
      }))
        .max(WORKFLOW_TEXT_EVIDENCE_LIMITS.maxCount)
        .refine(
          (value) => new Set(value.map((item) => item.clientItemId)).size === value.length,
          "Workflow evidence client item ids must be unique",
        )
        .refine(
          (value) => value.reduce(
            (sum, item) => sum + Buffer.byteLength(workflowCommandEvidenceContent(item)),
            0,
          ) <= WORKFLOW_TEXT_EVIDENCE_LIMITS.maxAggregateBytes,
          `Workflow command evidence exceeds ${WORKFLOW_TEXT_EVIDENCE_LIMITS.maxAggregateBytes} aggregate UTF-8 bytes`,
        )
        .optional()
        .describe("Optional exact output from completed focused commands, without creating a temporary file."),
      withdrawClientCriterionIds: z.array(z.string().min(1)
        .max(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.clientCriterionIdChars))
        .max(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.maxClaims).optional()
        .describe("Withdraw these caller claim ids from future submissions, including inherited claims. Idempotent; frozen history is unchanged."),
      coverage: z.array(z.object({
        clientCriterionId: z.string().min(1)
          .max(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.clientCriterionIdChars)
          .describe("Stable caller id for this acceptance criterion."),
        criterion: z.string().trim().min(1)
          .max(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.criterionBytes)
          .refine(
            (value) => Buffer.byteLength(value)
              <= WORKFLOW_EVIDENCE_COVERAGE_LIMITS.criterionBytes,
            `Workflow coverage criterion exceeds ${WORKFLOW_EVIDENCE_COVERAGE_LIMITS.criterionBytes} UTF-8 bytes`,
          )
          .describe("The material acceptance criterion the linked evidence is intended to prove."),
        supersedes: z.array(z.string().min(1).max(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.clientCriterionIdChars))
          .max(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.maxClaims).optional()
          .describe("Caller claim ids this registration replaces atomically. Use for differently worded replacements."),
        criterionId: z.string().min(1).max(200).optional()
          .describe(
            "The workflow's own criterion id, copied exactly from an evidence preflight repair"
            + " message. Supplying it binds this claim to that criterion with no text matching."
            + " Unknown ids are rejected during registration. A new claim bound to the same id"
            + " replaces the session's prior claims for that criterion. Omit this field when no"
            + " repair message has named the criteria. Use withdrawClientCriterionIds to retire claims.",
          ),
        proofClass: z.enum(WORKFLOW_EVIDENCE_PROOF_CLASSES)
          .describe("The author's proof class, which selects deterministic required evidence roles."),
        repositoryScope: z.union([
          z.literal("all"),
          z.string().regex(/^repo-\d{2}$/),
        ]).describe("An issued repository slot such as repo-01, or all."),
        links: z.array(z.object({
          clientItemId: z.string().min(1).max(WORKFLOW_IMAGE_LIMITS.clientItemIdChars)
            // "Staged" read as a restriction to this call's tray, which it never was: a claim may
            // cite evidence an earlier round registered, and in a repair round that is usually the
            // point. Saying so is the difference between re-proving work and re-running a suite.
            .describe(
              "An evidence client item id registered in this call or an earlier one, including"
                + " one an earlier submission already froze.",
            ),
          role: z.enum(WORKFLOW_EVIDENCE_PROOF_ROLES)
            .describe("How this evidence item contributes to the criterion."),
        })).max(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.linksPerClaim).refine(
          (links) => new Set(
            links.map((link) => `${link.clientItemId}\0${link.role}`),
          ).size === links.length,
          "Workflow coverage links must be unique by evidence item and proof role",
        ),
      }))
        .max(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.maxClaims)
        .refine(
          (value) => new Set(value.map((claim) => claim.clientCriterionId)).size === value.length,
          "Workflow coverage criterion ids must be unique",
        )
        .refine(
          (value) => Buffer.byteLength(JSON.stringify(value))
            <= WORKFLOW_EVIDENCE_COVERAGE_LIMITS.aggregateJsonBytes,
          `Workflow coverage exceeds ${WORKFLOW_EVIDENCE_COVERAGE_LIMITS.aggregateJsonBytes} UTF-8 bytes`,
        )
        .optional()
        .describe("Optional acceptance criteria mapped to registered evidence and proof roles."),
    },
  },
  async ({ images, artifacts, commandOutputs, coverage, withdrawClientCriterionIds }) => {
    const result = await submitWorkflowEvidenceToDaemon(
      { images, artifacts, commandOutputs, coverage, withdrawClientCriterionIds },
      { env: ENV, sessionId: SESSION_ID, cwd: process.cwd() },
      http,
    );
    return textResult(result.text, result.isError);
  },
);

// Submit this scout's finished report and the evidence worth keeping. The scout NEVER names
// itself or its destination: the daemon verifies the signed checkout credential this bridge
// reads at call time, then derives the task, work episode, checkouts and archive identity. The
// arguments carry only what the scout wrote - no task, session, episode, producer, archive,
// digest or absolute path. The zod here is a hand-written mirror of
// `SubmitScoutArtifactsSchema` in `@shared/protocol.ts`; the two are duplicated deliberately,
// and change together.
server.registerTool(
  "submit_scout_artifacts",
  {
    title: "Submit a scout report",
    description:
      "When your scout report is written, submit it. Mission Control captures the report " +
      "files you explicitly select with files, even if Git ignores them, into a durable local archive that outlives " +
      "this session, its checkout and its task card. Include reportPath in files; only selected files are copied. " +
      "Omit files for legacy directory capture. Any session may publish when instructed. " +
      "Call once per report using a unique directory. Reusing the directory returns the existing " +
      "immutable report; use a new slug for a revision. Submission does not complete your task. The report must " +
      `be a self-contained static page at ${SCOUT_REPORT_PATH_SHAPE} with no JavaScript and no ` +
      "external requests. Do not open a pull request for the report.",
    inputSchema: {
      files: z.array(z.object({
        repoSlot: z.string().describe("An issued repository slot, e.g. repo-01"),
        path: z.string().min(1).max(SCOUT_SUBMISSION_LIMITS.sourcePathChars)
          .describe("Checkout-relative file path"),
      })).min(1).max(SCOUT_SUBMISSION_LIMITS.selectedFiles).optional()
        .describe("Complete explicit selection, including reportPath and each evidence file. Accepts Git-ignored files. No automatic neighbors. Do not combine with supporting."),
      title: z.string().trim().min(1).max(SCOUT_SUBMISSION_LIMITS.title).optional()
        .describe("Optional display title for this report."),
      reportPath: z
        .string()
        .min(1)
        .max(SCOUT_SUBMISSION_LIMITS.sourcePathChars)
        .describe(`Checkout-relative path of the report, at ${SCOUT_REPORT_PATH_SHAPE}`),
      summary: z
        .string()
        .min(1)
        .max(SCOUT_SUBMISSION_LIMITS.summary)
        .describe("A short plain-text summary of the finding, for search results and listings."),
      tags: z
        .array(z.string().min(1).max(SCOUT_SUBMISSION_LIMITS.tag))
        .max(SCOUT_SUBMISSION_LIMITS.tags)
        .optional()
        .describe("Optional short tags for later search."),
      supporting: z
        .array(
          z.object({
            repoSlot: z.string().describe("A repository slot issued in your task's prompt, e.g. repo-01"),
            path: z
              .string()
              .min(1)
              .max(SCOUT_SUBMISSION_LIMITS.sourcePathChars)
              .describe("Path relative to that checkout"),
          }),
        )
        .max(SCOUT_SUBMISSION_LIMITS.supportingFiles)
        .optional()
        .describe(
          "Additional files worth preserving. Files already beside the report are captured " +
            "automatically and must not be listed here.",
        ),
    },
  },
  async ({ title, reportPath, summary, tags, supporting, files }) => {
    try {
      const health = await http("/api/health", "GET");
      const healthBody: unknown = health.ok ? await health.json() : null;
      if (!daemonHealthSupports(healthBody, DAEMON_PROTOCOL_CAPABILITIES.multipleScoutReports)) {
        return textResult("The running Mission Control daemon does not support multiple scout reports. Update/restart the daemon before submitting; no report was sent.", true);
      }
      if (files !== undefined && !daemonHealthSupports(healthBody, DAEMON_PROTOCOL_CAPABILITIES.explicitScoutFiles)) {
        return textResult("The running Mission Control daemon does not support explicit report files. Update/restart the daemon before submitting; no report was sent.", true);
      }
      const res = await http("/mcp/scouts/submit", "POST", {
        files,
        title,
        reportPath,
        summary,
        tags: tags ?? [],
        supporting: supporting ?? [],
      }, true);
      if (!res.ok) {
        const detail = await res.text();
        return textResult(
          `Mission Control refused the scout submission (${res.status}): ${detail}`,
          true,
        );
      }
      const body = (await res.json()) as {
        replayed?: boolean;
        archive?: { key?: string; artifactCount?: number; captureStatus?: string };
      };
      const fileCount = body.archive?.artifactCount ?? 0;
      return textResult(
        body.replayed
          ? `Already submitted; the existing immutable archive of ${fileCount} file(s) still stands. Edited source bytes were not republished. Report: #/scouts/${body.archive?.key ?? ""}. Continue the requested work.`
          : `Submitted. This report and ${Math.max(0, fileCount - 1)} supporting file(s) were archived. Report: #/scouts/${body.archive?.key ?? ""}. This does not complete your task; continue the requested work.`,
      );
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

await server.connect(new StdioServerTransport());
