import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The MCP child's half of `clear_awaiting`: a reply that is not JSON (an empty body, a proxy's
// HTML error page) still reached Mission Control, so the agent is told the status it got, never
// that Mission Control could not be reached.
//
// Drives the real MCP server over stdio against a stub daemon.

const home = mkdtempSync(join(tmpdir(), "awaiting-mcp-"));
let reply: { status: number; type: string; body: string } = { status: 200, type: "application/json", body: "{}" };
const daemon = createServer((req: IncomingMessage, res) => {
  req.resume();
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/mcp/awaiting/clear") {
      return res.writeHead(reply.status, { "content-type": reply.type }).end(reply.body);
    }
    res.writeHead(404).end("unexpected");
  });
});
const client = new Client({ name: "awaiting-mcp", version: "1" });

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
      MISSION_SESSION_ID: "sdk:awaiting-mcp",
    } as Record<string, string>,
    stderr: "pipe",
  }));
});
after(async () => {
  await client.close();
  await new Promise<void>((resolve) => daemon.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

async function clear() {
  const result = await client.callTool({ name: "clear_awaiting", arguments: {} });
  const text = (result.content as { type: string; text: string }[]).map((item) => item.text).join("\n");
  return { isError: Boolean(result.isError), text };
}

test("an HTML error page is reported as the refusal it is, with its status", async () => {
  reply = { status: 502, type: "text/html", body: "<html><body>Bad Gateway</body></html>" };
  const outcome = await clear();
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /refused this clear \(502\)/);
  assert.doesNotMatch(outcome.text, /Could not reach/);
});

test("an empty success body is read as nothing to clear, not as an unreachable daemon", async () => {
  reply = { status: 200, type: "application/json", body: "" };
  const outcome = await clear();
  assert.equal(outcome.isError, false);
  assert.equal(outcome.text, "There was no wait to clear.");
});

test("a JSON reply is read as before", async () => {
  reply = { status: 200, type: "application/json", body: JSON.stringify({ cleared: true }) };
  assert.equal((await clear()).text, "Wait cleared.");
});
