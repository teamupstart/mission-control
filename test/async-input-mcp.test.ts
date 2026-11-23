import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MEANWHILE_MAX_CHARS } from "../src/shared/async-input.ts";

// The MCP child's half of `async-input`: `request_input` always says it can take a receipt,
// returns the daemon's receipt verbatim without one long poll when told `wait: "message"`, and
// long-polls exactly as before when told `call` - or told nothing, by a daemon from an older build.
//
// Drives the real MCP server over stdio against a stub daemon that records every request.

const home = mkdtempSync(join(tmpdir(), "async-input-mcp-"));
type Seen = { method: string; path: string; body: Record<string, unknown> };
const seen: Seen[] = [];
let mode: "message" | "call" | "legacy" | "limit" = "message";
let stalledQuestionPath: string | null = null;
const RECEIPT = "Filed, not answered: stub receipt.";
const daemon = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
  req.on("end", () => {
    const path = req.url ?? "";
    seen.push({ method: req.method ?? "", path, body: raw ? JSON.parse(raw) : {} });
    if (path === stalledQuestionPath) {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      return; // The daemon accepted the request but its response body never finishes.
    }
    const json = (value: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (req.method === "POST" && path === "/mcp/reviews") {
      if (mode === "limit") return res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not asked: ten open questions. Work on what you can or end your turn." }));
      if (mode === "message") return json({ id: "rev-m", sessionId: "s", wait: "message", receipt: RECEIPT });
      if (mode === "call") return json({ id: "rev-c", sessionId: "s", wait: "call" });
      return json({ id: "rev-l", sessionId: "s" });
    }
    if (path.startsWith("/mcp/reviews/") && path.endsWith("/wait")) {
      return json({
        id: path.split("/")[3], sessionId: "s", kind: "input", title: "Q", body: "Q", status: "answered",
        response: "Answered: eslint", createdAt: 1, resolvedAt: 2,
      });
    }
    if (path === "/mcp/questions/list") return json({ questions: [{ id: "q1", title: "Which?", status: "pending" }] });
    if (path === "/mcp/questions/q1/withdraw") return json({ id: "q1", status: "withdrawn" });
    res.writeHead(404).end("unexpected");
  });
});
const client = new Client({ name: "async-input-mcp", version: "1" });

function transport(extraArgs: string[] = []) {
  const address = daemon.address();
  assert.ok(address && typeof address !== "string");
  return new StdioClientTransport({
    command: process.execPath,
    args: [...extraArgs, "--import", "tsx", fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
    env: {
      ...process.env,
      MISSION_HOME: home,
      HARNESS_HOME: home,
      MISSION_API_TOKEN: "stub-token",
      MISSION_PORT: String(address.port),
      MISSION_SESSION_ID: "sdk:async-input-mcp",
    } as Record<string, string>,
    stderr: "inherit",
  });
}

before(async () => {
  await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
  await client.connect(transport());
});
after(async () => {
  await client.close();
  await new Promise<void>((resolve) => daemon.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

async function ask(args: Record<string, unknown>) {
  const from = seen.length;
  const result = await client.callTool({ name: "request_input", arguments: args });
  const text = (result.content as { type: string; text: string }[]).map((item) => item.text).join("\n");
  return { isError: Boolean(result.isError), text, requests: seen.slice(from) };
}

test("told message, request_input returns the daemon's receipt at once and never long-polls", async () => {
  mode = "message";
  const outcome = await ask({
    question: "Which linter should this repo use?",
    options: [{ label: "biome" }, { label: "eslint", recommended: true }],
    meanwhile: "proceeding with eslint; the config is one file",
  });
  assert.equal(outcome.isError, false);
  assert.equal(outcome.text, RECEIPT);
  assert.deepEqual(outcome.requests.map((r) => `${r.method} ${r.path}`), ["POST /mcp/reviews"]);
  const sent = outcome.requests[0]!.body;
  assert.equal(sent.asyncCapable, true);
  assert.equal(sent.snoozable, true);
  assert.equal(sent.meanwhile, "proceeding with eslint; the config is one file");
});

test("told call, or told nothing by an older daemon, request_input long-polls for the answer as before", async () => {
  for (const told of ["call", "legacy"] as const) {
    mode = told;
    const outcome = await ask({ question: "Which linter?" });
    assert.equal(outcome.text, "Answered: eslint", told);
    assert.deepEqual(outcome.requests.map((r) => `${r.method} ${r.path.replace(/rev-[a-z]/, "ID")}`), [
      "POST /mcp/reviews", "GET /mcp/reviews/ID/wait",
    ], told);
    assert.equal(outcome.requests[0]!.body.meanwhile, undefined, "no meanwhile line was given");
  }
});

test("request_plan_decisions says it can take a receipt, returns it when told message, and long-polls otherwise", async () => {
  const plan = async () => {
    const from = seen.length;
    const result = await client.callTool({ name: "request_plan_decisions", arguments: {
      title: "Linter plan", plan: "# Linter plan",
      decisions: [{ id: "q", question: "Which linter?", options: [{ id: "a", label: "eslint" }] }],
    } });
    const text = (result.content as { type: string; text: string }[]).map((item) => item.text).join("\n");
    return { text, requests: seen.slice(from) };
  };
  mode = "message";
  const filed = await plan();
  assert.equal(filed.text, RECEIPT);
  assert.deepEqual(filed.requests.map((r) => `${r.method} ${r.path}`), ["POST /mcp/reviews"], "no /wait request");
  assert.equal(filed.requests[0]!.body.kind, "plan-decisions");
  assert.equal(filed.requests[0]!.body.asyncCapable, true);
  assert.equal(filed.requests[0]!.body.snoozable, undefined, "never snoozable");
  for (const told of ["call", "legacy"] as const) {
    mode = told;
    const waited = await plan();
    assert.equal(waited.text, "Answered: eslint", told);
    assert.deepEqual(waited.requests.map((r) => `${r.method} ${r.path.replace(/rev-[a-z]/, "ID")}`), [
      "POST /mcp/reviews", "GET /mcp/reviews/ID/wait",
    ], told);
  }
  const { tools } = await client.listTools();
  const description = tools.find((t) => t.name === "request_plan_decisions")!.description ?? "";
  assert.doesNotMatch(description, /BLOCK until/);
  assert.match(description, /filed and NOT answered/);
  assert.match(description, /gate either way/);
  assert.match(tools.find((t) => t.name === "withdraw_question")!.description ?? "", /request_plan_decisions form/);
  assert.match(tools.find((t) => t.name === "list_open_questions")!.description ?? "", /request_plan_decisions forms/);
});

test("the tool describes both outcomes and bounds meanwhile", async () => {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "request_input")!;
  assert.match(tool.description ?? "", /filed and NOT answered/);
  assert.match(tool.description ?? "", /expect the answer later as a message/);
  assert.doesNotMatch(tool.description ?? "", /BLOCK until/);
  const props = (tool.inputSchema as { properties: Record<string, { maxLength?: number }> }).properties;
  assert.equal(props.meanwhile?.maxLength, MEANWHILE_MAX_CHARS);
  mode = "message";
  const tooLong = await ask({ question: "Which?", meanwhile: "x".repeat(MEANWHILE_MAX_CHARS + 1) });
  assert.equal(tooLong.isError, true);
  assert.deepEqual(tooLong.requests, [], "refused before the daemon is asked");
});

test("housekeeping tools carry session context and return the daemon results", async () => {
  const listed = await client.callTool({ name: "list_open_questions", arguments: {} });
  assert.ok(JSON.stringify(listed.content).includes("q1"));
  assert.equal(seen.at(-1)!.path, "/mcp/questions/list");
  assert.equal(seen.at(-1)!.body.sessionId, "sdk:async-input-mcp");
  const withdrawn = await client.callTool({ name: "withdraw_question", arguments: { id: "q1", reason: "Obsolete" } });
  assert.ok(JSON.stringify(withdrawn.content).includes("withdrawn"));
  assert.equal(seen.at(-1)!.body.reason, "Obsolete");
});

test("housekeeping tools time out when the daemon never finishes its response", { timeout: 20_000 }, async () => {
  const preload = join(home, "short-timeouts.mjs");
  writeFileSync(preload, "const timeout = AbortSignal.timeout; AbortSignal.timeout = ms => timeout(Math.min(ms, 1_000));\n");
  const timedClient = new Client({ name: "async-input-timeouts", version: "1" });
  try {
    await timedClient.connect(transport(["--import", preload]));
    for (const [name, path, args] of [
      ["list_open_questions", "/mcp/questions/list", {}],
      ["withdraw_question", "/mcp/questions/q1/withdraw", { id: "q1", reason: "Obsolete" }],
    ] as const) {
      stalledQuestionPath = path;
      const from = seen.length;
      const result = await timedClient.callTool({ name, arguments: args }, undefined, { timeout: 5_000 });
      assert.equal(result.isError, true, name);
      assert.match(JSON.stringify(result.content), /TimeoutError|timed out|aborted/i, name);
      assert.deepEqual(seen.slice(from).map((request) => request.path), [path], "a timeout does not replay the request");
    }
  } finally {
    stalledQuestionPath = null;
    await timedClient.close();
  }
});

test("withdraw_question accepts a 2000-character reason and rejects 2001 before contacting the daemon", async () => {
  const reason = "x".repeat(2000);
  const from = seen.length;
  const rejected = await client.callTool({ name: "withdraw_question", arguments: { id: "q1", reason: `${reason}x` } });
  assert.equal(rejected.isError, true);
  assert.deepEqual(seen.slice(from), [], "an overlong reason cannot withdraw the question at the daemon");

  const accepted = await client.callTool({ name: "withdraw_question", arguments: { id: "q1", reason } });
  assert.notEqual(accepted.isError, true);
  assert.ok(JSON.stringify(accepted.content).includes("withdrawn"));
  const requests = seen.slice(from);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.path, "/mcp/questions/q1/withdraw");
  assert.equal(requests[0]!.body.reason, reason, "the maximum-length reason is forwarded intact");
});

test("the bound returns an error result with recovery instructions and no wait", async () => {
  mode = "limit";
  const outcome = await ask({ question: "Eleventh?" });
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /Work on what you can or end your turn/);
  assert.equal(outcome.requests.length, 1);
});
