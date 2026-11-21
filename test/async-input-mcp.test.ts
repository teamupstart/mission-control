import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
let mode: "message" | "call" | "legacy" = "message";
const RECEIPT = "Filed, not answered: stub receipt.";
const daemon = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
  req.on("end", () => {
    const path = req.url ?? "";
    seen.push({ method: req.method ?? "", path, body: raw ? JSON.parse(raw) : {} });
    const json = (value: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (req.method === "POST" && path === "/mcp/reviews") {
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
    res.writeHead(404).end("unexpected");
  });
});
const client = new Client({ name: "async-input-mcp", version: "1" });

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
      MISSION_SESSION_ID: "sdk:async-input-mcp",
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
