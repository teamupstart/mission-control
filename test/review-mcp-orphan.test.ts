import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { reviewToolResult } from "../src/shared/review-item.ts";
import type { ReviewItem, ReviewKind } from "../src/shared/types.ts";

const source = readFileSync(fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url)), "utf8");

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake daemon did not bind TCP");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("request_input prefers the Mission Control session identity", { timeout: 10_000 }, async () => {
  const missionHome = mkdtempSync(join(tmpdir(), "mission-review-mcp-"));
  writeFileSync(join(missionHome, "token"), "integration-token\n");
  const captured = { review: null as Record<string, unknown> | null };
  const daemon = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && request.url === "/mcp/reviews") {
        captured.review = JSON.parse(body) as Record<string, unknown>;
        response.end(JSON.stringify({ id: "review-identity" }));
        return;
      }
      if (request.method === "GET" && request.url === "/mcp/reviews/review-identity/wait") {
        response.end(
          JSON.stringify({
            id: "review-identity",
            sessionId: captured.review?.sessionId ?? null,
            kind: "input",
            title: "Which identity owns this review?",
            body: "Which identity owns this review?",
            status: "orphaned",
            response: null,
            createdAt: 1,
            resolvedAt: 2,
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "unexpected fake-daemon route" }));
    });
  });
  let transport: StdioClientTransport | null = null;
  let client: Client | null = null;

  try {
    const port = await listen(daemon);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url)),
      ],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        MISSION_HOME: missionHome,
        MISSION_PORT: String(port),
        MISSION_SESSION_ID: "sdk:mission",
        CLAUDE_SESSION_ID: "claude:legacy",
      } as Record<string, string>,
      stderr: "pipe",
    });
    client = new Client({ name: "review-identity-test", version: "1" });
    await client.connect(transport, { timeout: 5_000 });
    await client.callTool(
      {
        name: "request_input",
        arguments: { question: "Which identity owns this review?" },
      },
      undefined,
      { timeout: 5_000 },
    );
    assert.equal(captured.review?.sessionId, "sdk:mission");
  } finally {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    await close(daemon);
    rmSync(missionHome, { recursive: true, force: true });
  }
});

function toolSource(name: string, nextName: string): string {
  const start = source.indexOf(`server.registerTool(\n  "${name}"`);
  const end = source.indexOf(`server.registerTool(\n  "${nextName}"`, start);
  assert.notEqual(start, -1, `${name} registration is missing`);
  assert.notEqual(end, -1, `${name} registration has no boundary`);
  return source.slice(start, end);
}

const cases = [
  ["request_plan_decisions", "request_review", "plan-decisions"],
  ["request_review", "create_task", "diff"],
  ["request_input", "report_status", "input"],
] as const satisfies ReadonlyArray<readonly [string, string, ReviewKind]>;

for (const [name, nextName, kind] of cases) {
  test(`${name} reports orphaning as an unanswered error`, () => {
    const body = toolSource(name, nextName);
    assert.match(body, /reviewToolResult\(review\)/, "the tool bypasses the shared translation");
    const result = reviewToolResult({
      id: "review-1",
      sessionId: "session-1",
      kind,
      title: "review",
      body: "body",
      status: "orphaned",
      response: null,
      createdAt: 1,
      resolvedAt: 2,
    } satisfies ReviewItem);
    assert.deepEqual(result, {
      text: "Review channel went away before a human answered.",
      isError: true,
    });
  });
}

// ---- staying alive long enough that nobody has to ask twice ------------------------------

// What is at stake: the duplicate cards in the review queue.
//
// Every tool above BLOCKS on a human. The MCP client in front of them does not wait that
// long - it abandons the tool call on its own timeout and hands the model an error - and the
// model's recovery is to ask again, which is where a second identical row came from.
// `ReviewManager.create` is the floor under that (it re-attaches an identical pending ask),
// and this is the half that delays the retry when a client elects to reset its timeout on a
// progress notification. A protocol-compliant maximum can still cancel the request, so the
// source must also notify the daemon that the result channel detached.
//
// Scanned rather than driven, like the cases above, because importing `src/mcp/server.ts`
// stands a whole MCP server up on stdio. What a scan can still pin is the defect actually
// seen: a blocking tool that forgets to hand its `extra` down, which silently reverts that
// tool - and only that tool - to timing out and duplicating.

test("waitForResolution reports in, and gives up when the client cancels", () => {
  const start = source.indexOf("type BlockingCall = {");
  const end = source.indexOf("function textResult(");
  assert.ok(start !== -1 && end > start, "the blocking-wait section is missing");
  const wait = source.slice(start, end);
  assert.match(wait, /async function waitForResolution\(/);
  assert.match(wait, /notifications\/progress/, "nothing keeps the client's timeout at bay");
  assert.match(wait, /call\?\.signal\.aborted/, "a cancelled call still polls the daemon");
  assert.match(wait, /call\?\.signal\)/, "the in-flight long poll is not cancelled with it");
  assert.match(wait, /\/detach/, "a cancelled call can still strand the human's answer");
  assert.match(
    wait,
    /const response = await http\([\s\S]*?if \(!response\.ok\)[\s\S]*?detachFailure = detachError;[\s\S]*?throw new AggregateError/,
    "a rejected detach response is retained instead of being discarded as a successful handoff",
  );
  assert.match(
    wait,
    /if \(review\.status !== "pending"\) \{\s*\/\/[\s\S]*?if \(call\?\.signal\.aborted\)[\s\S]*?return review;/,
    "cancellation after a resolved long poll bypasses the durable detach handoff",
  );
});

for (const [name, nextName] of [
  ["request_plan_decisions", "request_review"],
  ["request_review", "create_task"],
  ["request_input", "report_status"],
  ["report_product_issue", "report_status"],
] as const) {
  test(`${name} hands its request context to the wait`, () => {
    const body = toolSource(name, nextName);
    assert.match(
      body,
      /waitForResolution\((?:id|reviewId|\(id: string\) => waitForResolution\(id), extra\)/,
      "the wait cannot report progress for a call it was not told about",
    );
  });
}
