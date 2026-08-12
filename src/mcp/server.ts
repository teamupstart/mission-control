import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ReviewItem } from "@shared/types.ts";
import { ENSEMBLE_LIMITS } from "@shared/ensemble.ts";
import { SCOUT_REPORT_PATH_SHAPE, SCOUT_SUBMISSION_LIMITS } from "@shared/scouts.ts";
import { BASE_URL, captureTerminalEnv, readToken } from "@shared/harness-runtime.mjs";
import { titleLine } from "@shared/title.ts";

// This runs as a stdio MCP server, launched by Claude Code per session. Because
// it's a child of the agent it inherits the terminal env (TMUX_PANE /
// WEZTERM_PANE), which lets the daemon bind every call to the right session -
// the same join key the hook bridge uses.

const ENV = captureTerminalEnv();
const SESSION_ID = process.env.CLAUDE_SESSION_ID ?? null;

async function http(path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(BASE_URL + path, {
    method,
    headers: { "content-type": "application/json", "x-harness-token": readToken() },
    body: body ? JSON.stringify(body) : undefined,
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

/** Long-poll the daemon until the human resolves the review. */
async function waitForResolution(id: string): Promise<ReviewItem> {
  for (;;) {
    const res = await http(`/mcp/reviews/${id}/wait`, "GET");
    if (!res.ok) throw new Error(`harness wait ${res.status}`);
    const review = (await res.json()) as ReviewItem;
    if (review.status !== "pending") return review;
  }
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
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
  async ({ title, plan, decisions }) => {
    try {
      const id = await createReview("plan-decisions", title, plan, decisions);
      const review = await waitForResolution(id);
      if (review.status === "dismissed") {
        return textResult("Decision request dismissed without a response.");
      }
      if (review.status === "orphaned") {
        return textResult("Review channel went away before a human answered.", true);
      }
      return textResult(review.response ?? "(no selections given)");
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
      "Show a unified/git diff in the Mission Control dashboard and BLOCK until the human approves or requests changes. Returns their decision so you can proceed or revise.",
    inputSchema: {
      title: z.string().describe("What this change does"),
      diff: z.string().describe("A unified or git diff"),
    },
  },
  async ({ title, diff }) => {
    try {
      const id = await createReview("diff", title, diff);
      const review = await waitForResolution(id);
      if (review.status === "orphaned") {
        return textResult("Review channel went away before a human answered.", true);
      }
      const verdict = review.status === "approved" ? "APPROVED" : "CHANGES REQUESTED";
      const note = review.response ? `\nReviewer note: ${review.response}` : "";
      return textResult(`${verdict}${note}`);
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
      "Create one ship task in the Mission Control backlog for the current repository. " +
      "The task uses the default agent, model, and reasoning effort. Pass direct prerequisite " +
      "task ids or depend on the calling session to create durable dependency edges; unfinished " +
      "prerequisites keep the new task backlogged until their pull requests merge. Returns the " +
      "new task id for later calls.",
    inputSchema: {
      title: z.string().min(1).max(200).describe("Specific task title shown on the backlog card"),
      intent: z
        .string()
        .min(1)
        .describe(
          "Goal-level brief for the agent: the outcome to deliver, the plan or phase file paths to " +
            "read and follow, and the verification bar. This text becomes the agent's prompt and is " +
            "read as the requester's explicit requirement, so keep it concise and leave step-by-step " +
            "detail in the referenced files rather than restating it here",
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
  async ({ title, intent, dependsOnTaskIds, dependsOnCurrentSession }) => {
    try {
      const res = await http("/mcp/tasks", "POST", {
        env: ENV,
        sessionId: SESSION_ID,
        cwd: process.cwd(),
        repoRoot: process.cwd(),
        title,
        intent,
        dependsOnTaskIds,
        dependsOnCurrentSession,
      });
      if (!res.ok) return textResult(`Could not create task (${res.status}): ${await res.text()}`, true);

      const task = (await res.json()) as { id: string; title: string; status: string };
      return textResult(
        JSON.stringify(
          {
            id: task.id,
            title: task.title,
            status: task.status,
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
      "they resolve it. Without `options`, they answer in free text and the tool returns that " +
      "answer. With `options`, they can submit clickable choices or dismiss the stale choice " +
      "set without an answer; the tool returns their selections or an explicit dismissal. " +
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
  async ({ question, options, multiSelect, allowOther }) => {
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
      const review = await waitForResolution(id);
      if (review.status === "dismissed") {
        return textResult("Input request dismissed without a response.");
      }
      if (review.status === "orphaned") {
        return textResult("Review channel went away before a human answered.", true);
      }
      return textResult(review.response ?? "(no answer given)");
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

// Submit this scout's finished report and the evidence worth keeping. The scout NEVER names
// itself or its destination: the daemon derives the task, the work episode, the checkouts and
// the archive's identity from this session's pane/id/cwd, so the arguments carry only what the
// scout wrote - no task, session, episode, producer, archive, digest or absolute path. The zod
// here is a hand-written mirror of `SubmitScoutArtifactsSchema` in `@shared/protocol.ts`; the
// two are duplicated deliberately, and change together.
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
        env: ENV,
        sessionId: SESSION_ID,
        cwd: process.cwd(),
        reportPath,
        summary,
        tags: tags ?? [],
        supporting: supporting ?? [],
      });
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
