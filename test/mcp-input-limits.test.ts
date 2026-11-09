import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PLAN_DECISION_LIMITS } from "../src/shared/protocol.ts";

/**
 * The MCP tools' own collection limits, through the real stdio tool path.
 *
 * `request_plan_decisions` and `request_input` declare their input schemas in
 * `src/mcp/server.ts`, apart from the daemon's, so the shared-schema tests do not reach them.
 * This drives the MCP server itself: an input at the limit passes the tool's validation and
 * reaches the daemon whole, and one over the limit made of elements that would each fail is
 * refused for its size alone, before the daemon is asked anything.
 *
 * The daemon here is a stub that records each review request and refuses it, so an accepted
 * call returns at once instead of waiting on a human.
 */

const home = mkdtempSync(join(tmpdir(), "mcp-input-limits-"));
const received: { path: string; body: { decisions?: { options: unknown[] }[] } }[] = [];
const daemon = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
  req.on("end", () => {
    received.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
    res.writeHead(503, { "content-type": "text/plain" }).end("stub daemon refuses every review");
  });
});
const client = new Client({ name: "mcp-input-limits", version: "1" });

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
      MISSION_SESSION_ID: "sdk:mcp-input-limits",
    } as Record<string, string>,
    stderr: "pipe",
  }));
});
after(async () => {
  await client.close();
  await new Promise<void>((resolve) => daemon.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

const times = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));
const option = (i: number) => ({ id: `o${i}`, label: `Option ${i}` });
const decision = (i: number, options = 1) => ({ id: `d${i}`, question: `Question ${i}?`, options: times(options, option) });

async function call(name: string, args: Record<string, unknown>) {
  const before = received.length;
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[]).map((item) => item.text).join("\n");
  return { isError: Boolean(result.isError), text, requests: received.slice(before) };
}

/** Accepted by the tool: it asked the daemon, with every element it was given. */
function assertReachedDaemon(outcome: Awaited<ReturnType<typeof call>>) {
  assert.doesNotMatch(outcome.text, /Input validation error/, outcome.text);
  assert.match(outcome.text, /stub daemon refuses every review/, "the call got as far as the daemon");
  assert.equal(outcome.requests.length, 1);
}

/** Refused by the tool for its size: one bound issue, no element issue, nothing sent. */
function assertRefusedForSize(outcome: Awaited<ReturnType<typeof call>>, max: number) {
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /Input validation error/, outcome.text);
  assert.match(outcome.text, new RegExp(`Too big: expected array to have <=${max} items`), outcome.text);
  assert.doesNotMatch(outcome.text, /expected string|expected object|Unrecognized key/, "no element was validated");
  assert.deepEqual(outcome.requests, [], "the daemon was never asked");
}

test(`request_plan_decisions takes ${PLAN_DECISION_LIMITS.decisions} decisions and refuses one more by its size`, async () => {
  const atLimit = await call("request_plan_decisions", { title: "Plan", plan: "#", decisions: times(PLAN_DECISION_LIMITS.decisions, (i) => decision(i)) });
  assertReachedDaemon(atLimit);
  assert.equal(atLimit.requests[0]!.body.decisions!.length, PLAN_DECISION_LIMITS.decisions);

  const over = await call("request_plan_decisions", {
    title: "Plan",
    plan: "#",
    decisions: times(PLAN_DECISION_LIMITS.decisions + 1, (i) => ({ garbage: i })),
  });
  assertRefusedForSize(over, PLAN_DECISION_LIMITS.decisions);
});

test(`request_plan_decisions takes ${PLAN_DECISION_LIMITS.options} options on a decision and refuses one more by its size`, async () => {
  const atLimit = await call("request_plan_decisions", { title: "Plan", plan: "#", decisions: [decision(0, PLAN_DECISION_LIMITS.options)] });
  assertReachedDaemon(atLimit);
  assert.equal(atLimit.requests[0]!.body.decisions![0]!.options.length, PLAN_DECISION_LIMITS.options);

  const over = await call("request_plan_decisions", {
    title: "Plan",
    plan: "#",
    decisions: [{ id: "d0", question: "Which?", options: times(PLAN_DECISION_LIMITS.options + 1, (i) => ({ garbage: i })) }],
  });
  assertRefusedForSize(over, PLAN_DECISION_LIMITS.options);
});

test(`request_input takes ${PLAN_DECISION_LIMITS.options} options and refuses one more by its size`, async () => {
  const atLimit = await call("request_input", { question: "Which?", options: times(PLAN_DECISION_LIMITS.options, (i) => ({ label: `Option ${i}` })) });
  assertReachedDaemon(atLimit);
  assert.equal(atLimit.requests[0]!.body.decisions![0]!.options.length, PLAN_DECISION_LIMITS.options);

  const over = await call("request_input", { question: "Which?", options: times(PLAN_DECISION_LIMITS.options + 1, (i) => ({ garbage: i })) });
  assertRefusedForSize(over, PLAN_DECISION_LIMITS.options);
});
