import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REPORT_GUIDANCE, REPORT_GUIDANCE_RULES } from "../src/shared/reports.ts";
import { tempDir } from "./temp-root.mjs";

// The MCP child reads the operator's report guidance once, as it starts, and puts it in
// `post_report`'s description. The fixed half (progress goes to report_status, decisions are
// questions) always follows it. When the daemon does not answer, the child still starts, with
// the default guidance.
//
// Drives the real MCP server over stdio against stub daemons.

const home = tempDir("post-report-guidance-mcp-");
after(() => rmSync(home, { recursive: true, force: true }));

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A stub daemon and a connected MCP child that started against it. */
async function childAgainst(handler: Handler): Promise<{ description: string; seen: { path: string; token: string | undefined }[] }> {
  const seen: { path: string; token: string | undefined }[] = [];
  const daemon = createServer((req, res) => {
    const token = req.headers["x-harness-token"];
    seen.push({ path: req.url ?? "", token: typeof token === "string" ? token : undefined });
    handler(req, res);
  });
  await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
  const address = daemon.address();
  assert.ok(address && typeof address !== "string");
  const client = new Client({ name: "post-report-guidance-mcp", version: "1" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
      env: {
        ...process.env,
        MISSION_HOME: home,
        HARNESS_HOME: home,
        MISSION_API_TOKEN: "stub-token",
        MISSION_PORT: String(address.port),
        MISSION_SESSION_ID: "sdk:post-report-guidance-mcp",
      } as Record<string, string>,
      stderr: "inherit",
    }));
    const { tools } = await client.listTools();
    return { description: tools.find((tool) => tool.name === "post_report")?.description ?? "", seen };
  } finally {
    await client.close();
    daemon.closeAllConnections();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
  }
}

test("the tool's description carries the operator's guidance, then the fixed rules", async () => {
  const custom = "Only post a report when a pull request is ready for review.";
  const { description, seen } = await childAgainst((req, res) => {
    if (req.method === "GET" && req.url === "/mcp/reports/guidance") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ guidance: custom }));
      return;
    }
    res.writeHead(404).end("unexpected");
  });
  assert.ok(description.includes(`${custom} ${REPORT_GUIDANCE_RULES}`), description);
  assert.ok(!description.includes(REPORT_GUIDANCE), "the default is not also there");
  const read = seen.filter((request) => request.path === "/mcp/reports/guidance");
  assert.equal(read.length, 1, "read once, as the child starts");
  assert.equal(read[0]!.token, "stub-token", "with the machine token");
});

test("a daemon that never answers leaves the default guidance, and the child still starts", async () => {
  const started = Date.now();
  // Accepts the request and never responds: the child's own short timeout ends the wait.
  const { description, seen } = await childAgainst(() => undefined);
  assert.ok(description.includes(REPORT_GUIDANCE), description);
  assert.ok(seen.some((request) => request.path === "/mcp/reports/guidance"));
  assert.ok(Date.now() - started < 15_000, "the read is bounded");
});

test("with the inbox flag off the daemon refuses the read, and the default guidance is used", async () => {
  const { description } = await childAgainst((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "This feature is disabled.", feature: "inbox" }));
  });
  assert.ok(description.includes(REPORT_GUIDANCE), description);
});
