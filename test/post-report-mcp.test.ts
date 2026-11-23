import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REPORT_GUIDANCE, REPORT_LIMITS } from "../src/shared/reports.ts";

// The MCP child's half of `post_report`: one request to `/mcp/reports` carrying the caller's own
// identity, the daemon's receipt handed back verbatim, nothing long-polled, and a flag-off refusal
// turned into a sentence that says where the switch is. The description says when to report.
//
// Drives the real MCP server over stdio against a stub daemon that records every request.

const home = mkdtempSync(join(tmpdir(), "post-report-mcp-"));
type Seen = { method: string; path: string; body: Record<string, unknown> };
const seen: Seen[] = [];
let mode: "ok" | "flag-off" | "refused" | "unreachable" = "ok";
const RECEIPT = "Report r-7 posted to your operator's inbox. Do not wait for a reply: stub.";
const daemon = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
  req.on("end", () => {
    const path = req.url ?? "";
    seen.push({ method: req.method ?? "", path, body: raw ? JSON.parse(raw) : {} });
    const reply = (status: number, value: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (req.method === "POST" && path === "/mcp/reports") {
      // The daemon accepted the connection and then dropped it with no response at all.
      if (mode === "unreachable") return req.socket.destroy();
      if (mode === "flag-off") return reply(404, { error: "This feature is disabled.", feature: "inbox" });
      if (mode === "refused") return reply(409, { error: 'r-3 is not one of your reports waiting to be read. Your reports waiting to be read: r-2 "Alpha".' });
      return reply(200, { report: { id: "r-7" }, receipt: RECEIPT });
    }
    res.writeHead(404).end("unexpected");
  });
});
const client = new Client({ name: "post-report-mcp", version: "1" });

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
      MISSION_SESSION_ID: "sdk:post-report-mcp",
    } as Record<string, string>,
    stderr: "inherit",
  }));
});
after(async () => {
  await client.close();
  await new Promise<void>((resolve) => daemon.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

async function post(args: Record<string, unknown>) {
  const from = seen.length;
  const result = await client.callTool({ name: "post_report", arguments: args });
  const text = (result.content as { type: string; text: string }[]).map((item) => item.text).join("\n");
  return { isError: Boolean(result.isError), text, requests: seen.slice(from) };
}

test("post_report sends one request as its own session and returns the receipt at once", async () => {
  mode = "ok";
  const outcome = await post({ title: "Build failure diagnosed", body: "The cache was stale.", url: "https://example.com/pr/1", replaces: "r-6" });
  assert.equal(outcome.isError, false);
  assert.equal(outcome.text, RECEIPT);
  assert.deepEqual(outcome.requests.map((r) => `${r.method} ${r.path}`), ["POST /mcp/reports"]);
  const sent = outcome.requests[0]!.body;
  assert.equal(sent.sessionId, "sdk:post-report-mcp");
  assert.deepEqual([sent.title, sent.body, sent.url, sent.replaces], ["Build failure diagnosed", "The cache was stale.", "https://example.com/pr/1", "r-6"]);
  assert.equal(typeof sent.cwd, "string");
});

test("with the flag off the tool says where to turn it on; a refusal is passed on as written", async () => {
  mode = "flag-off";
  const off = await post({ title: "t", body: "b" });
  assert.equal(off.isError, true);
  assert.match(off.text, /^Not posted: agent reports are turned off in Mission Control \(Settings > Feature flags > Reports and inbox upgrades\)/);
  mode = "refused";
  const refused = await post({ title: "t", body: "b", replaces: "r-3" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /^Not posted \(409\): r-3 is not one of your reports waiting to be read\. Your reports waiting to be read: r-2 "Alpha"\./);
});

test("when the daemon cannot be reached the tool says so as an error, and nothing claims the report was posted", async () => {
  mode = "unreachable";
  try {
    const outcome = await post({ title: "Build failure diagnosed", body: "The cache was stale." });
    assert.equal(outcome.isError, true);
    assert.match(outcome.text, /^Could not reach Mission Control: /);
    assert.doesNotMatch(outcome.text, /posted/);
    assert.deepEqual(outcome.requests.map((r) => `${r.method} ${r.path}`), ["POST /mcp/reports"], "the one attempt reached the daemon and got no answer");
  } finally {
    mode = "ok";
  }
});

test("the tool describes when to report and bounds its fields; a bad field never reaches the daemon", async () => {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "post_report")!;
  assert.ok(tool.description?.includes(REPORT_GUIDANCE), "the when-to-report paragraph");
  assert.match(tool.description ?? "", /do not wait for a reply/);
  assert.match(tool.description ?? "", /pass its id as `replaces`/);
  const props = (tool.inputSchema as { properties: Record<string, { maxLength?: number }>; required?: string[] }).properties;
  assert.deepEqual(Object.keys(props).sort(), ["body", "file", "replaces", "title", "url"]);
  assert.deepEqual((tool.inputSchema as { required?: string[] }).required?.sort(), ["body", "title"]);
  assert.equal(props.title?.maxLength, REPORT_LIMITS.title);
  assert.equal(props.body?.maxLength, REPORT_LIMITS.body);
  for (const bad of [{ title: "", body: "b" }, { title: "t", body: "b", replaces: "seven" }, { title: "t", body: "b", url: "ftp://x" }]) {
    const outcome = await post(bad);
    assert.equal(outcome.isError, true, JSON.stringify(bad));
    assert.deepEqual(outcome.requests, [], `${JSON.stringify(bad)} was refused before the daemon was asked`);
  }
});
