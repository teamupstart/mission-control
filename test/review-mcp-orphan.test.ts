import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url)), "utf8");

function toolSource(name: string, nextName: string): string {
  const start = source.indexOf(`server.registerTool(\n  "${name}"`);
  const end = source.indexOf(`server.registerTool(\n  "${nextName}"`, start);
  assert.notEqual(start, -1, `${name} registration is missing`);
  assert.notEqual(end, -1, `${name} registration has no boundary`);
  return source.slice(start, end);
}

const cases = [
  ["request_plan_decisions", "request_review", "(no selections given)"],
  ["request_review", "create_task", 'status === "approved" ? "APPROVED" : "CHANGES REQUESTED"'],
  ["request_input", "report_status", "(no answer given)"],
] as const;

for (const [name, nextName, normalOutcome] of cases) {
  test(`${name} reports orphaning as an unanswered error`, () => {
    const body = toolSource(name, nextName);
    const branch = body.indexOf('if (review.status === "orphaned")');
    const fallback = body.indexOf(normalOutcome);

    assert.notEqual(branch, -1, "orphaned status is not handled");
    assert.notEqual(fallback, -1, "normal outcome translation is missing");
    assert.ok(branch < fallback, "orphaned status falls through to a normal human outcome");

    const result = body.slice(branch, body.indexOf("\n      }", branch));
    assert.match(
      result,
      /return textResult\("Review channel went away before a human answered\.", true\);/,
    );
  });
}

// ---- staying alive long enough that nobody has to ask twice ------------------------------

// What is at stake: the duplicate cards in the review queue.
//
// Every tool above BLOCKS on a human. The MCP client in front of them does not wait that
// long - it abandons the tool call on its own timeout and hands the model an error - and the
// model's recovery is to ask again, which is where a second identical row came from.
// `ReviewManager.create` is the floor under that (it re-attaches an identical pending ask),
// and this is the half that stops the retry happening at all: a progress notification, which
// a receiving client MUST use to restart its timeout for the request.
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
