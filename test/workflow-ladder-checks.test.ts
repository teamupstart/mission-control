import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowLadder } from "../src/web/workflows/WorkflowLadder.tsx";
import { checkStatusView } from "../src/web/workflows/run-model.ts";
import {
  attempt,
  LADDER_NODE,
  ladderDetail,
} from "./helpers/workflow-ladder.ts";

test("a skipped check never reads as passed", () => {
  const detail = ladderDetail("reviewing");
  detail.attempts = detail.attempts
    .filter((item) => item.nodeId !== LADDER_NODE.typecheck)
    .concat(attempt(LADDER_NODE.typecheck, {
      output: {
        status: "skipped",
        slot: "typecheck",
        command: null,
        exitCode: null,
        output: "",
        truncatedBytes: 0,
        note: "No command is configured.",
      },
      // The engine advances a skipped check with a synthetic pass verdict. The recorded
      // outcome must win over it on the reading surface.
      verdict: {
        verdict: "pass",
        summary: "The unconfigured check did not block.",
        approvalDetails: { reason: "No command was configured.", evidence: [] },
        confidence: 1,
      },
    }));
  const html = renderToStaticMarkup(createElement(WorkflowLadder, {
    summary: detail.summary,
    detail,
    onOpenRun: () => {},
  }));
  const row = html.match(
    /<li class="wf-ladder-member[^"]*"[^>]*>[\s\S]*?Check · typecheck[\s\S]*?<\/li>/,
  )?.[0] ?? "";
  assert.match(row, /Skipped/);
  assert.doesNotMatch(row, />Passed</);
  assert.ok(html.includes(checkStatusView("skipped").sentence));
});
