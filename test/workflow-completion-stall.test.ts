import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { workflowCompletionStall, workflowCompletionStallReason } from "../src/web/lib/held.ts";
import { WorkflowCompletionStallNotice, stallRunUnreconciled } from "../src/web/workflows/WorkflowBindingDialog.tsx";
import type { Session } from "../src/shared/types.ts";
import type { WorkflowBindingSummary, WorkflowRunSummary } from "../src/shared/workflow.ts";
import { LADDER_SUMMARY } from "./helpers/workflow-ladder.ts";
import { hasTooltip } from "./helpers/markup.ts";

// A Foreman-complete binding gets its run only from Foreman's claim, and Foreman claims only
// against a resolved goal. A finished work cycle under an unresolved goal is therefore a dead
// end, and before this predicate nothing on screen said so. Each conjunct is load-bearing: drop
// any one and the chip would either cry stall on a healthy binding or stay silent on a stuck one.

type StallSession = Pick<Session, "goal" | "workCycle">;
type StallBinding = Pick<WorkflowBindingSummary, "workflowName" | "workflowVersion" | "triggerMode" | "state">;

const STALLED: StallSession = {
  goal: {
    text: "Move advisor settings to the harness page",
    source: "model",
    relationship: "unclear",
    objectiveVersion: 1,
    promptRevision: 3,
    resolvedPromptRevision: 3,
    updatedAt: 1,
  },
  workCycle: { logicalKey: "k", generation: 2, active: false, completedAt: 100, updatedAt: 100 },
};

const BINDING: StallBinding = {
  workflowName: "No-Mistakes Review",
  workflowVersion: 8,
  triggerMode: "foreman_complete",
  state: "active",
};

const REASON =
  "No-Mistakes Review v8 is waiting on this session's goal: Foreman cannot call the work complete "
  + "while the latest instruction is unresolved.";

const run = (status: WorkflowRunSummary["status"]): WorkflowRunSummary => ({ ...LADDER_SUMMARY, status });

test("a finished cycle under an unclear goal stalls a Foreman-complete binding, naming it", () => {
  assert.equal(workflowCompletionStallReason(STALLED, BINDING, null), REASON);
  assert.equal(workflowCompletionStall(STALLED, BINDING, null), `${REASON} Click for ways to proceed.`);
});

test("a goal still reconciling its latest instruction stalls it too", () => {
  const session: StallSession = {
    ...STALLED,
    goal: { ...STALLED.goal!, relationship: "steer", promptRevision: 4, resolvedPromptRevision: 3 },
  };
  assert.equal(workflowCompletionStallReason(session, BINDING, []), REASON);
});

test("a terminal run does not hold the stall off; only an open one does", () => {
  assert.equal(workflowCompletionStallReason(STALLED, BINDING, [run("completed")]), REASON);
  assert.equal(workflowCompletionStallReason(STALLED, BINDING, [run("completed"), run("running")]), null);
});

test("each conjunct, made false on its own, yields null", () => {
  const cases: Array<[string, StallSession, StallBinding | null, readonly WorkflowRunSummary[] | null]> = [
    ["no binding", STALLED, null, null],
    ["a manual binding", STALLED, { ...BINDING, triggerMode: "manual" }, null],
    ["a paused binding", STALLED, { ...BINDING, state: "paused" }, null],
    ["an orphaned binding", STALLED, { ...BINDING, state: "orphaned" }, null],
    ["an open run", STALLED, BINDING, [run("waiting_for_session")]],
    ["no goal", { ...STALLED, goal: null }, BINDING, null],
    [
      "a resolved, settled goal",
      { ...STALLED, goal: { ...STALLED.goal!, relationship: "steer" } },
      BINDING,
      null,
    ],
    ["no work cycle on record", { goal: STALLED.goal }, BINDING, null],
    ["no completed generation", { ...STALLED, workCycle: { ...STALLED.workCycle!, generation: 0 } }, BINDING, null],
    ["a cycle still running", { ...STALLED, workCycle: { ...STALLED.workCycle!, active: true } }, BINDING, null],
    ["a cycle never completed", { ...STALLED, workCycle: { ...STALLED.workCycle!, completedAt: null } }, BINDING, null],
  ];
  for (const [label, session, binding, runs] of cases) {
    assert.equal(workflowCompletionStallReason(session, binding, runs), null, label);
    assert.equal(workflowCompletionStall(session, binding, runs), null, label);
  }
});

// ---- the dialog's notice -----------------------------------------------------------------

function notice(hasObjective: boolean, reconciling = true): string {
  return renderToStaticMarkup(createElement(WorkflowCompletionStallNotice, {
    sessionId: "s1",
    reason: REASON,
    hasObjective,
    reconciling,
    disabled: false,
  }));
}

// The notice NAMES the footer's Submit bound version instead of repeating it: a second button
// with the same name and effect made the dialog's submit ambiguous (two `Submit bound version`
// buttons in one dialog) for a screen reader and for every spec selecting it by role.
test("the notice is a bleed band that states the stall and offers both ways forward", () => {
  const html = notice(true);
  assert.match(html, /^<section class="modal-bleed workflow-binding-stall" role="status"/);
  assert.ok(html.includes(`<p>${REASON.replace(/'/g, "&#x27;")}</p>`), "the band carries the dialog's sentence");
  assert.match(html, />Accept objective as is<\/button>/);
  assert.match(html, /Or use <strong>Submit bound version<\/strong> below/);
  assert.doesNotMatch(html, />Submit bound version<\/button>/, "the footer owns the only submit button");
  assert.ok(hasTooltip(
    html,
    "Record the pending instructions as steering and let Foreman judge completion against this objective",
  ));
  // Inside the dialog the click the chip invites has already happened.
  assert.doesNotMatch(html, /Click for ways to proceed/);
});

test("a stalled goal with no objective offers Submit bound version only", () => {
  const html = notice(false);
  assert.match(html, /workflow-binding-stall/);
  assert.doesNotMatch(html, /Accept objective as is/);
  assert.match(html, /Use <strong>Submit bound version<\/strong> below/);
});

// The badge promise holds only for the still-reconciling stall. A latest instruction already
// judged "needs more context" is resolved, and the daemon does not badge a run frozen then.
test("the notice promises the unreconciled badge only while an instruction is still reconciling", () => {
  assert.match(notice(true, true), /while the latest instruction is still reconciling, that run is marked unreconciled\./);
  const settled = notice(true, false);
  assert.doesNotMatch(settled, /unreconciled/);
  assert.match(settled, /against the objective as it\s+stands\.<\/p>/);
});

test("the badge rule matches the daemon's freeze-time classifier", () => {
  const goal = (promptRevision: number, resolvedPromptRevision: number, relationship: "unclear" | "steer") =>
    ({ goal: { ...STALLED.goal!, promptRevision, resolvedPromptRevision, relationship } });
  assert.equal(stallRunUnreconciled(goal(3, 2, "steer")), true, "a pending later revision");
  assert.equal(stallRunUnreconciled(goal(3, 3, "unclear")), false, "needs more context, resolved");
  assert.equal(stallRunUnreconciled(goal(1, 0, "steer")), false, "the opening ask never counts");
  assert.equal(stallRunUnreconciled({ goal: null }), false);
});
