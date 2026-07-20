import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ReviewItem } from "@shared/types.ts";
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
      "human answers by selecting options and clicking Submit, then BLOCK until they do. " +
      "Returns their selections so you can proceed. Use this instead of asking open-ended " +
      "questions whenever the plan's open choices can be expressed as options.",
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
      const verdict = review.status === "approved" ? "APPROVED" : "CHANGES REQUESTED";
      const note = review.response ? `\nReviewer note: ${review.response}` : "";
      return textResult(`${verdict}${note}`);
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
      "they answer. Returns their answer. Pass `options` whenever the answer is a choice " +
      "between discrete alternatives - they become real controls the human clicks, which is " +
      "faster and less ambiguous than free text. Omit `options` only for open-ended asks.",
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

await server.connect(new StdioServerTransport());
