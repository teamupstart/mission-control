import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ReviewItem } from "@shared/types.ts";
import { BASE_URL, captureTerminalEnv, readToken } from "@shared/harness-runtime.mjs";

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

async function createReview(kind: string, title: string, body: string): Promise<string> {
  const res = await http("/mcp/reviews", "POST", {
    env: ENV,
    sessionId: SESSION_ID,
    cwd: process.cwd(),
    kind,
    title,
    body,
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

server.registerTool(
  "request_input",
  {
    title: "Ask the human a question",
    description:
      "Ask the human a question in the Mission Control dashboard and BLOCK until they answer. Returns their answer.",
    inputSchema: { question: z.string().describe("The question to ask") },
  },
  async ({ question }) => {
    try {
      const id = await createReview("input", question, question);
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
