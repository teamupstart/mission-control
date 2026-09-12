import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ReviewItem } from "@shared/types.ts";
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
  readScoutSubmissionCredential,
} from "@shared/harness-runtime.mjs";
import { titleLine } from "@shared/title.ts";
import {
  PRODUCT_ISSUE_CLIENT_ENV,
  productIssueClientFromEnvironment,
  type ProductIssueRequest,
} from "@shared/product-issues.ts";
import { reportProductFeedback, reportProductIssueWithConfirmation } from "./product-issues.ts";
import {
  PIPELINE_CALLER_CREDENTIAL_HEADER,
} from "@shared/pipeline.ts";
import { MAX_TASK_EXTRA_REPOS, ProductIssueDraftSchema, WorkflowCommandExitCodeSchema } from "@shared/protocol.ts";
import { readPipelineCallerCredential } from "./pipeline-credential.ts";
import { submitWorkflowEvidenceToDaemon } from "./workflow-evidence.ts";

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
    ...extraHeaders,
    "content-type": "application/json",
    "x-harness-token": readClientToken(),
  };
  if (scoutCredential) {
    const credential = readScoutSubmissionCredential(process.cwd());
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
): Promise<string> {
  const res = await http("/mcp/reviews", "POST", {
    env: ENV,
    sessionId: SESSION_ID,
    cwd: process.cwd(),
    kind,
    title,
    body,
    decisions,
  });
  if (!res.ok) throw new Error(`harness ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
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

/**
 * Long-poll the daemon until the human resolves the review.
 *
 * `call` is optional so a caller with nothing to report in can still wait; passing it buys
 * two things. The heartbeat above, and an exit: without a signal this loop re-polls every
 * thirty seconds FOR EVER, including long after the client cancelled the tool call and threw
 * away whatever it returns, so an abandoned ask left a poller hammering the daemon for the
 * rest of the session's life. Aborting the in-flight fetch ends it at the cancellation.
 */
async function waitForResolution(id: string, call?: BlockingCall): Promise<ReviewItem> {
  const beat = heartbeat(call);
  try {
    for (;;) {
      if (call?.signal.aborted) throw new Error("the client cancelled this request");
      const res = await http(`/mcp/reviews/${id}/wait`, "GET", undefined, false, call?.signal);
      if (!res.ok) throw new Error(`harness wait ${res.status}`);
      const review = (await res.json()) as ReviewItem;
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

const server = new McpServer({ name: "mission-control", version: "0.1.0" });

server.registerTool(
  "share_plan",
  {
    title: "Share a plan with the human",
    description:
      "Display a readable markdown plan in the Mission Control dashboard for the human to skim. Returns immediately without waiting.",
    inputSchema: {
      title: z.string().describe("Short title for the plan"),
      plan: z.string().describe("The plan as GitHub-flavored markdown"),
    },
  },
  async ({ title, plan }) => {
    try {
      await createReview("plan", title, plan);
      return textResult("Plan shared to the Mission Control dashboard.");
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
      "answer when the decision set is stale. BLOCK until they submit or dismiss. Returns " +
      "their selections or an explicit dismissal so you can proceed appropriately. Use this " +
      "instead of asking open-ended questions whenever the plan's open choices can be " +
      "expressed as options.",
    inputSchema: {
      title: z.string().describe("Short title for the plan"),
      plan: z.string().describe("The plan as GitHub-flavored markdown, shown above the decisions"),
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
                  detail: z.string().optional().describe("Optional one-line elaboration"),
                  recommended: z
                    .boolean()
                    .optional()
                    .describe("Marks a suggested choice; does not preselect"),
                }),
              )
              .min(1),
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
        .min(1)
        .describe("The decision points to present"),
    },
  },
  async ({ title, plan, decisions }, extra) => {
    try {
      const id = await createReview("plan-decisions", title, plan, decisions);
      const review = await waitForResolution(id, extra);
      const result = reviewToolResult(review);
      return textResult(result.text, result.isError);
    } catch (err) {
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

server.registerTool(
  "create_task",
  {
    title: "Schedule an implementation task",
    description:
      "Create one ship task in the Mission Control backlog. It targets the current repository " +
      "unless an absolute local checkout path or unique repository directory name is supplied, " +
      "and it can attach additional local repositories to the same task. " +
      "The task uses the default agent, model, and reasoning effort. Pass direct prerequisite " +
      "task ids or depend on the calling session to create durable dependency edges; unfinished " +
      "prerequisites keep the new task backlogged until their pull requests merge. Repository " +
      "validity is checked locally; Git and the repository host enforce push and pull-request " +
      "authority later. Returns the new task id and canonical repository set.",
    inputSchema: {
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
      dependsOnTaskIds: z
        .array(z.string().min(1))
        .max(50)
        .default([])
        .describe("Ids of direct prerequisite tasks returned by earlier create_task calls"),
      dependsOnCurrentSession: z
        .boolean()
        .default(false)
        .describe("Make the session calling this tool a direct prerequisite of the new task"),
    },
  },
  async ({
    title,
    intent,
    repository,
    additionalRepositories,
    dependsOnTaskIds,
    dependsOnCurrentSession,
  }) => {
    try {
      const explicitRepositories =
        repository !== undefined || Boolean(additionalRepositories?.length);
      const body = {
        env: ENV,
        sessionId: SESSION_ID,
        cwd: process.cwd(),
        repoRoot: process.cwd(),
        title,
        intent,
        dependsOnTaskIds,
        dependsOnCurrentSession,
      };
      const res = await http(
        explicitRepositories ? "/mcp/v2/tasks" : "/mcp/tasks",
        "POST",
        explicitRepositories
          ? {
              ...body,
              targetRepository: repository,
              additionalRepositories: additionalRepositories ?? [],
            }
          : body,
      );
      if (explicitRepositories && res.status === 404) {
        return textResult(
          "Could not create task: this Mission Control daemon does not support repository " +
            "selectors. Update or restart Mission Control and retry; no task was created.",
          true,
        );
      }
      if (!res.ok) {
        return textResult(`Could not create task (${res.status}): ${await res.text()}`, true);
      }

      const task = (await res.json()) as {
        id: string;
        title: string;
        status: string;
        repoRoot: string;
        extraRepos: Array<{ repoRoot: string }>;
      };
      return textResult(
        JSON.stringify(
          {
            id: task.id,
            title: task.title,
            status: task.status,
            repository: task.repoRoot,
            additionalRepositories: task.extraRepos.map((entry) => entry.repoRoot),
            dependsOnTaskIds,
            dependsOnCurrentSession,
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

// This is the replacement for Claude's built-in `AskUserQuestion`, which dispatched sessions
// have taken away from them (see `src/server/ask-channel.ts`). It therefore has to cover what
// the built-in covered: a question with discrete options, answered by clicking one. `options`
// is optional so the same tool still serves a genuinely open-ended ask - one tool for the
// redirect prompt to name, with the agent choosing the SHAPE from the question rather than
// choosing between two tools.
//
// The description says what the tool DOES and stops there. It deliberately does NOT claim
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
      "Ask your human operator a question in the Mission Control dashboard and BLOCK until " +
      "they resolve it. Without `options`, they answer in free text or dismiss without an " +
      "answer. With `options`, they can submit clickable choices or dismiss without choosing; " +
      "the tool returns their answer, selections, or an explicit dismissal. " +
      "Pass `options` whenever the answer is a choice between discrete alternatives. Omit " +
      "`options` only for open-ended asks.",
    inputSchema: {
      question: z.string().describe("The question to ask"),
      options: z
        .array(
          z.object({
            label: z.string().describe("What the human reads on the control"),
            detail: z.string().optional().describe("Optional one-line elaboration"),
            recommended: z
              .boolean()
              .optional()
              .describe("Marks a suggested choice; does not preselect"),
          }),
        )
        .optional()
        .describe("Discrete choices. Omit entirely for a free-text answer."),
      multiSelect: z
        .boolean()
        .optional()
        .describe("Checkboxes (choose many) when true, radios (choose one) otherwise"),
      allowOther: z
        .boolean()
        .optional()
        .describe("Adds a free-text 'Other' field for an answer outside the options"),
    },
  },
  async ({ question, options, multiSelect, allowOther }, extra) => {
    try {
      // Option ids are positional and generated here rather than asked of the agent. The
      // human's answer comes back as LABELS (see `formatResponse`), so an id is only ever a
      // wire-level handle between the form and its submit - making the agent invent stable
      // ids for something it never reads back would be ceremony with a chance of collision.
      const decisions = options?.length
        ? [
            {
              id: "q",
              question,
              options: options.map((o, i) => ({ ...o, id: `o${i}` })),
              multiSelect,
              allowOther,
            },
          ]
        : undefined;
      // The title is a HEADING and the body is the question itself, so a long or multi-line
      // ask is readable rather than folded into a bold one-liner with its newlines collapsed.
      // Sending the question as both (which this did) made them equal for every review the
      // tool produced, and the modal's de-duplication then suppressed the readable paragraph
      // in every case - including the ones it exists to protect. `titleLine` is the shared
      // clipper (word boundary, ellipsis, `TITLE_MAX_CHARS`), so a heading here and a heading
      // on a task card are cut the same way; a question already short enough comes back
      // unchanged, which keeps the equal case genuinely equal and still de-duplicated.
      const id = await createReview("input", titleLine(question), question, decisions);
      const review = await waitForResolution(id, extra);
      const result = reviewToolResult(review);
      return textResult(result.text, result.isError);
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

// Both MCP entry points use the dashboard's report contract and daemon service.
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
  "report_product_feedback",
  {
    title: "Report product feedback",
    description:
      "Report product feedback about Mission Control as a public GitHub issue only after the user " +
      "explicitly asks you to report it. Publishes automatically without a second dashboard approval " +
      "and returns the issue URL. Choose the report type from the user's request. " +
      "Include only public-safe details, never secrets, private repository content, or personal data. " +
      "Optional attachmentUploadIds must be daemon-issued screenshot ids, never filesystem paths.",
    inputSchema: ProductIssueDraftSchema.shape,
  },
  async (draft) => {
    try {
      const result = await reportProductFeedback(draft, PRODUCT_ISSUE_CLIENT, productIssueTransport);
      return textResult(result.text, result.isError);
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

server.registerTool(
  "report_product_issue",
  {
    title: "Report a Mission Control product issue",
    description:
      "Prepare a public GitHub issue about Mission Control only after the user explicitly " +
      "asked you to report it. Mission Control shows the exact public content in the dashboard " +
      "and BLOCKS until the human selects Submit public issue or dismisses it. Optional screenshot " +
      "upload ids must come from Mission Control and require GitHub CLI 2.99.0 or newer.",
    inputSchema: ProductIssueDraftSchema.shape,
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

// Answer one line comment a human left on a file, in the thread it was written in.
//
// Non-blocking and `share_plan`-shaped: no `extra`, no long poll. The agent posts its answer
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
  async ({ images, artifacts, commandOutputs, coverage }) => {
    const result = await submitWorkflowEvidenceToDaemon(
      { images, artifacts, commandOutputs, coverage },
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
      "directory and the additional files you name into a durable local archive that outlives " +
      "this session, its checkout and its task card, then lets the task finish. The report must " +
      `be a self-contained static page at ${SCOUT_REPORT_PATH_SHAPE} with no JavaScript and no ` +
      "external requests. Do not open a pull request for the report.",
    inputSchema: {
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
  async ({ reportPath, summary, tags, supporting }) => {
    try {
      const res = await http("/mcp/scouts/submit", "POST", {
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
        archive?: { artifactCount?: number; captureStatus?: string };
      };
      const files = body.archive?.artifactCount ?? 0;
      return textResult(
        body.replayed
          ? `Already submitted; the existing archive of ${files} file(s) still stands. You can stop.`
          : `Submitted. Your report and ${Math.max(0, files - 1)} supporting file(s) were archived. You can stop.`,
      );
    } catch (err) {
      return textResult(`Could not reach Mission Control: ${String(err)}`, true);
    }
  },
);

await server.connect(new StdioServerTransport());
