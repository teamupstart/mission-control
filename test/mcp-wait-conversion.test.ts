import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { asyncInputReceipt } from "../src/shared/async-input.ts";
import { requestInputReview } from "../src/shared/request-input.ts";
import { app, home, pending, registry, reviews, token } from "./helpers/voice-http.ts";

test("the MCP child recovers its dropped receipt when the operator answers before the retry", async t => {
  const sessionId = "sdk:Will";
  const question = "Which build?";
  const ask = requestInputReview({ question });
  const row = reviews.create(sessionId, ask.kind, ask.title, ask.body, null, { snoozable: true });
  reviews.startContinuationRecovery((review, text, kind) =>
    pending.submitReviewContinuation(review.id, review.sessionId, text, kind).ok,
  );
  let polls = 0;
  const receipts: string[] = [];
  const listener = getRequestListener(app.fetch);
  const daemon = createServer(async (req, res) => {
    if (!req.url?.startsWith(`/mcp/reviews/${row.id}/wait`)) return listener(req, res);
    polls++;
    const waiting = app.request(req.url, { headers: { "x-harness-token": token } });
    if (polls === 1) reviews.convertToFiled(row.id);
    const result = await (await waiting).json();
    receipts.push(result.converted?.receipt);
    if (polls === 1) {
      reviews.resolve(row.id, "answer", "Use the nightly build.");
      return res.destroy();
    }
    res.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve));
  t.after(() => daemon.close());
  const address = daemon.address();
  assert.ok(address && typeof address !== "string");
  const client = new Client({ name: "voice-wait-test", version: "1" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
    env: { ...process.env, MISSION_PORT: String(address.port), MISSION_HOME: home,
      MISSION_API_TOKEN: token, MISSION_SESSION_ID: sessionId } as Record<string, string>,
  }));
  const result = await client.callTool({ name: "request_input", arguments: { question } });
  const receipt = asyncInputReceipt(row);
  assert.deepEqual(result.content, [{ type: "text", text: receipt }]);
  assert.deepEqual(receipts, [receipt, receipt]);
  assert.equal(polls, 2);
  const messages = registry.getSession(sessionId)!.pendingTurns;
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.text, /Use the nightly build\./);
});
