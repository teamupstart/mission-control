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
