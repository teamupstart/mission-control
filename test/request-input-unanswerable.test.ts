// The agent-facing half of the rule: `request_input` refuses an ask its dashboard card could
// not carry, says why in the tool result, and never creates the review a human could not answer.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = mkdtempSync(join(tmpdir(), "mission-request-input-"));
after(() => rmSync(home, { recursive: true, force: true }));

test("request_input refuses an unanswerable card without asking the daemon, and still asks a valid one", async (t) => {
  const posted: string[] = [];
  const body = async (req: IncomingMessage) => { let raw = ""; for await (const chunk of req) raw += chunk; return raw; };
  const daemon = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    await body(req);
    posted.push(`${req.method} ${path}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && path === "/mcp/reviews") return res.end(JSON.stringify({ id: "r1", sessionId: "s1" }));
    if (path.startsWith("/mcp/reviews/r1")) {
      return res.end(JSON.stringify({ id: "r1", sessionId: "s1", kind: "input", title: "Pick", body: "Pick", status: "approved",
        response: "Hold", decisions: [{ id: "q", question: "Pick", options: [{ id: "o0", label: "Ship" }, { id: "o1", label: "Hold" }] }],
        selections: [{ decisionId: "q", optionIds: ["o1"] }], createdAt: 0, resolvedAt: 1 }));
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
  const address = daemon.address();
  assert.ok(address && typeof address !== "string");
  const client = new Client({ name: "request-input-test", version: "1" });
  t.after(async () => { await client.close(); await new Promise<void>((resolve) => daemon.close(() => resolve())); });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
    env: { ...process.env, MISSION_HOME: home, MISSION_API_TOKEN: "test-token", MISSION_PORT: String(address.port) } as Record<string, string>,
    stderr: "pipe" }));
  const ask = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "request_input", arguments: args });
    return { isError: Boolean(result.isError), text: (result.content as Array<{ text: string }>).map((c) => c.text).join("\n") };
  };

  for (const [args, reason] of [
    [{ question: "Ship it?", options: [{ label: "Ship" }, { label: "ship" }] }, /more than one option is labelled "ship"/],
    [{ question: "Ship it?", options: [{ label: "Ship" }, { label: " " }] }, /option 2 has an empty label/],
    [{ question: "  ", options: [{ label: "Ship" }] }, /the question is empty/],
  ] as const) {
    const result = await ask(args);
    assert.equal(result.isError, true, result.text);
    assert.match(result.text, /^Not asked: /);
    assert.match(result.text, reason);
    assert.match(result.text, /Nothing was shown to the human/);
  }
  assert.deepEqual(posted.filter((p) => p.startsWith("POST /mcp/reviews")), [], "no unanswerable review reached the daemon");

  const valid = await ask({ question: "Pick", options: [{ label: "Ship", recommended: true }, { label: "Hold" }], allowOther: true });
  assert.equal(valid.isError, false, valid.text);
  assert.match(valid.text, /Hold/);
  assert.ok(posted.includes("POST /mcp/reviews"));
});
