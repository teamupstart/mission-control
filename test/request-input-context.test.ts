import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  DECISION_CONTEXT_MAX_CHARS,
  DECISION_CONTEXT_RULE,
  inputReviewBody,
  inputReviewBodyText,
} from "../src/shared/decision-asks.ts";
import { titleLine } from "../src/shared/title.ts";

// What is at stake: a decision that reaches the operator without the context to make it.
//
// A `request_input` card is read on the dashboard, long after the agent formed the question
// and with none of its context on screen. So every harness is told the same rule - the
// decision, its background and each option's tradeoff - and the tool has a `context` field
// to carry the background without displacing the decision from the card's heading.
//
// This drives the real MCP server over stdio against a stub daemon that records each review
// request and refuses it, so an accepted call returns at once instead of waiting on a human.

const home = mkdtempSync(join(tmpdir(), "request-input-context-"));
const received: { path: string; body: { title?: string; body?: string; decisions?: { question: string; options: { detail?: string }[] }[] } }[] = [];
const daemon = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
  req.on("end", () => {
    received.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
    res.writeHead(503, { "content-type": "text/plain" }).end("stub daemon refuses every review");
  });
});
const client = new Client({ name: "request-input-context", version: "1" });

before(async () => {
  await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
  const address = daemon.address();
  assert.ok(address && typeof address !== "string");
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
    env: {
      ...process.env,
      MISSION_HOME: home,
      HARNESS_HOME: home,
      MISSION_API_TOKEN: "stub-token",
      MISSION_PORT: String(address.port),
      MISSION_SESSION_ID: "sdk:request-input-context",
    } as Record<string, string>,
    stderr: "pipe",
  }));
});
after(async () => {
  await client.close();
  await new Promise<void>((resolve) => daemon.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

async function ask(args: Record<string, unknown>) {
  const before = received.length;
  const result = await client.callTool({ name: "request_input", arguments: args });
  const text = (result.content as { type: string; text: string }[]).map((item) => item.text).join("\n");
  return { isError: Boolean(result.isError), text, requests: received.slice(before) };
}

test("request_input's description tells every harness what a decision carries", async () => {
  // The tool description is the one surface every harness reads - Claude, Codex's terminal
  // and Pi alike - so the rule is pinned here, not only in the dispatch prompts.
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "request_input");
  assert.ok(tool, "request_input is registered");
  assert.ok(tool.description?.includes(DECISION_CONTEXT_RULE), tool.description);
  const props = (tool.inputSchema as { properties: Record<string, { description?: string; maxLength?: number }> }).properties;
  assert.ok(props.context, "a context field exists for the background");
  assert.equal(props.context.maxLength, DECISION_CONTEXT_MAX_CHARS);
  assert.match(String(props.context.description), /tradeoffs/);
});

test("context reads beneath the decision without displacing it from the heading", async () => {
  const question = "Which linter should this repo use?";
  const context = "The repo has no linter. CI runs Prettier only.\nThe team asked for type-aware rules.";
  const outcome = await ask({
    question,
    context,
    options: [
      { label: "biome", detail: "fast, one binary; no type-aware rules" },
      { label: "eslint", detail: "type-aware rules; slower, more config", recommended: true },
    ],
  });
  assert.match(outcome.text, /stub daemon refuses every review/, outcome.text);
  const sent = outcome.requests[0]!.body;
  assert.equal(sent.title, question, "the heading is the decision, not the first line of context");
  assert.equal(sent.body, `${question}\n\n${context}`);
  assert.equal(sent.decisions![0]!.question, question, "the form's question carries no context");
  assert.equal(sent.decisions![0]!.options[1]!.detail, "type-aware rules; slower, more config");
  assert.equal(inputReviewBodyText(sent.title!, sent.body!), context, "the card prints the context once");
});

test("without context the review is exactly what request_input always sent", async () => {
  const outcome = await ask({ question: "Pick one", options: [{ label: "a" }, { label: "b" }] });
  const sent = outcome.requests[0]!.body;
  assert.equal(sent.title, "Pick one");
  assert.equal(sent.body, "Pick one", "no trailing separator, no empty paragraph");
});

test("context at exactly its bound reaches the daemon whole", async () => {
  const context = "c".repeat(DECISION_CONTEXT_MAX_CHARS - 1) + "!";
  const outcome = await ask({ question: "Which?", context });
  assert.doesNotMatch(outcome.text, /Input validation error/, outcome.text);
  assert.match(outcome.text, /stub daemon refuses every review/, "the call got as far as the daemon");
  assert.equal(outcome.requests.length, 1);
  assert.equal(outcome.requests[0]!.body.body, `Which?\n\n${context}`, "not one character dropped or trimmed");
  assert.equal(context.length, DECISION_CONTEXT_MAX_CHARS);
});

test("context over its bound is refused before the daemon is asked", async () => {
  const outcome = await ask({ question: "Which?", context: "x".repeat(DECISION_CONTEXT_MAX_CHARS + 1) });
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /Input validation error/, outcome.text);
  assert.deepEqual(outcome.requests, [], "the daemon was never asked");
});

test("the printed body never repeats the heading, and never loses a clipped question", () => {
  const short = "Run the migration now?";
  assert.equal(inputReviewBodyText(short, inputReviewBody(short, undefined)), "", "nothing to print twice");
  assert.equal(inputReviewBodyText(short, inputReviewBody(short, "  ")), "", "blank context is no context");
  assert.equal(inputReviewBodyText(short, inputReviewBody(short, "It locks the table.")), "It locks the table.");

  const long =
    "Should the migration run in one transaction, or in batches, given the replica lag budget " +
    "and the size of the table it rewrites tonight?";
  const title = titleLine(long);
  assert.notEqual(title, long, "precondition: the heading is clipped");
  assert.equal(
    inputReviewBodyText(title, inputReviewBody(long, "40M rows; 5s lag budget.")),
    `${long}\n\n40M rows; 5s lag budget.`,
    "a clipped question keeps its full text above the context",
  );
});

test("the daemon's review schema accepts the longest body request_input can file", async () => {
  // `request_input` joins the question and up to DECISION_CONTEXT_MAX_CHARS of context into one
  // review body. If the daemon ever capped `body` below that, a long ask would be refused with a
  // transport error after the agent built it - so the largest body the tool can produce is
  // parsed by the daemon's own schema here.
  const { CreateReviewSchema } = await import("../src/shared/protocol.ts");
  const question = "q".repeat(500);
  const body = inputReviewBody(question, "c".repeat(DECISION_CONTEXT_MAX_CHARS));
  const parsed = CreateReviewSchema.safeParse({
    env: {},
    kind: "input",
    title: titleLine(question),
    body,
    decisions: [{ id: "q", question, options: [{ id: "o0", label: "yes" }, { id: "o1", label: "no" }] }],
  });
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  assert.equal(parsed.success && parsed.data.body, body, "and keeps it whole");
});
