// User-requested feedback must be discoverable and finish without a dashboard review.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProductIssueDraftSchema } from "../src/shared/protocol.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("feedback is listed and publishes through preview and submit without a review", { timeout: 150_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-feedback-mcp-"));
  writeFileSync(join(home, "token"), "fixture-token\n");
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let outcome = "created";
  const daemon = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      assert.equal(req.headers["x-harness-token"], "fixture-token");
      const request = JSON.parse(body);
      calls.push({ path: req.url!, body: request });
      if (outcome === "transport-failure") {
        req.socket.destroy();
        return;
      }
      res.setHeader("content-type", "application/json");
      if (req.url === "/mcp/product-issues/preview" && outcome === "configuration") {
        res.end(JSON.stringify({ outcome, message: "GitHub is not configured", retrySafe: true }));
      } else if (req.url === "/mcp/product-issues/preview") {
        res.end(JSON.stringify({
          outcome: "preview", requestId: request.requestId, draftIdentity: "a".repeat(64),
          draft: { type: request.type, title: request.title, details: request.details, attachmentUploadIds: request.attachmentUploadIds },
          target: "owner/issues", labels: ["bug", "status:needs-triage", "source:agent"],
          environment: { missionControlVersion: "1.0.0", platform: "macOS", architecture: "arm64", client: "browser" },
          body: request.details, attachments: { enabled: false, reason: "fixture" },
        }));
      } else if (req.url === "/mcp/product-issues") {
        res.end(JSON.stringify(outcome === "created"
          ? { outcome, issueUrl: "https://github.com/owner/issues/issues/1", target: "owner/issues" }
          : { outcome, message: "Publication timed out", retrySafe: false }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Unexpected review request" }));
      }
    });
  });
  const client = new Client({ name: "feedback-test", version: "1" });
  try {
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    const address = daemon.address();
    assert.ok(address && typeof address !== "string");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
      env: { ...process.env, MISSION_HOME: home, MISSION_API_TOKEN: "fixture-token", MISSION_PORT: String(address.port), MISSION_SESSION_ID: "sdk:feedback-test" } as Record<string, string>,
      stderr: "pipe",
    });
    await client.connect(transport);
    const listed = await client.listTools();
    const tool = listed.tools.find((item) => item.name === "report_product_feedback");
    assert.ok(tool);
    assert.equal(tool.title, "Report product feedback");
    const legacy = listed.tools.find((item) => item.name === "report_product_issue");
    assert.ok(legacy);
    assert.deepEqual(tool.inputSchema, legacy.inputSchema);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(),
      Object.keys(ProductIssueDraftSchema.shape).sort(), "MCP exposes every shared report field");
    const args = { type: "bug", title: "Focus disappears", details: "Keep focus on the selected task." };
    const result = await client.callTool({ name: tool.name, arguments: args });
    assert.equal(result.isError, false);
    assert.match(JSON.stringify(result.content), /https:\/\/github.com\/owner\/issues\/issues\/1/);
    assert.deepEqual(calls.map((call) => call.path), ["/mcp/product-issues/preview", "/mcp/product-issues"]);
    assert.deepEqual(calls[0]!.body, calls[1]!.body);
    assert.equal(calls[0]!.body.sessionId, "sdk:feedback-test");
    assert.deepEqual(calls[0]!.body.attachmentUploadIds, []);
    const invalid = await client.callTool({ name: tool.name, arguments: { ...args, title: "" } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 2);
    outcome = "unknown";
    const unknown = await client.callTool({ name: tool.name, arguments: args });
    assert.equal(unknown.isError, true);
    assert.match(JSON.stringify(unknown.content), /Do not retry/);
    assert.equal(calls.length, 4);
    outcome = "configuration";
    const refused = await client.callTool({ name: tool.name, arguments: args });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /GitHub is not configured/);
    assert.equal(calls.length, 5, "a failed preview must not submit");
    await t.test("report_product_feedback returns an MCP error when the preview transport fails", async () => {
      outcome = "transport-failure";
      const failed = await client.callTool({ name: tool.name, arguments: args });
      assert.equal(failed.isError, true);
      assert.deepEqual(failed.content, [{
        type: "text",
        text: "Could not reach Mission Control: TypeError: fetch failed",
      }]);
      assert.deepEqual(calls.slice(5).map((call) => call.path), ["/mcp/product-issues/preview"],
        "a broken preview connection must not submit or retry");
    });
  } finally {
    await client.close();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
