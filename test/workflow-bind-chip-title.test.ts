import assert from "node:assert/strict";
import test from "node:test";
import { workflowBindChipTitle } from "../src/web/lib/held.ts";
import { WORKFLOW_TRIGGER_MODES, type WorkflowBindingSummary } from "../src/shared/workflow.ts";

// What is at stake: the bind chip's tooltip is the one sentence telling an operator whether a
// review is coming on its own. It was written twice, in SessionCard and ConsoleDetail, and both
// copies claimed the workflow "runs when this session's work is complete" for EVERY binding.
// That holds only for `foreman_complete`. A `manual` binding waits for an explicit submit, so
// the sentence promised an automatic review that was never coming.

function binding(
  triggerMode: WorkflowBindingSummary["triggerMode"],
): Pick<WorkflowBindingSummary, "workflowName" | "workflowVersion" | "triggerMode"> {
  return { workflowName: "No-Mistakes Review", workflowVersion: 8, triggerMode };
}

test("a Foreman-complete binding says it runs at completion", () => {
  assert.equal(
    workflowBindChipTitle(binding("foreman_complete")),
    "No-Mistakes Review v8 runs when this session's work is complete - click to change it",
  );
});

test("a manual binding does NOT claim it runs at completion", () => {
  const title = workflowBindChipTitle(binding("manual"));
  assert.match(title, /No-Mistakes Review v8/);
  assert.match(title, /submit/);
  // The regression this exists to prevent: the old text was trigger-blind.
  assert.doesNotMatch(title, /runs when this session's work is complete/);
});

test("nothing bound reads as an offer rather than a claim about a workflow", () => {
  assert.equal(workflowBindChipTitle(null), "Bind a published workflow version");
  assert.equal(workflowBindChipTitle(undefined), "Bind a published workflow version");
});

test("every trigger mode is given words, and each names the workflow", () => {
  // `WORKFLOW_TRIGGER_MODES` is append-only. A mode added there without words here would fall
  // out of the switch as `undefined`, and this is what catches that before a card renders it.
  for (const mode of WORKFLOW_TRIGGER_MODES) {
    const title = workflowBindChipTitle(binding(mode));
    assert.equal(typeof title, "string", `${mode} has no words`);
    assert.match(title, /No-Mistakes Review v8/, `${mode} does not name the workflow`);
    assert.match(title, /click to change it/, `${mode} does not say the chip is actionable`);
  }
});

test("the version rides along, so two versions of one workflow read differently", () => {
  assert.match(
    workflowBindChipTitle({ ...binding("foreman_complete"), workflowVersion: 7 }),
    /No-Mistakes Review v7/,
  );
});
