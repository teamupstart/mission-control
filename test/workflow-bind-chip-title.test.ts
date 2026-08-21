import assert from "node:assert/strict";
import test from "node:test";
import { ownBindingBySession, workflowBindChipTitle } from "../src/web/lib/held.ts";
import { WORKFLOW_TRIGGER_MODES, type WorkflowBindingSummary } from "../src/shared/workflow.ts";

// What is at stake: the bind chip's tooltip is the one sentence telling an operator whether a
// review is coming on its own. It is rendered in ConsoleDetail,
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

// ---- which binding the chip is even about -----------------------------------------------
//
// A multi-repo task's session owns one active binding per repository it is reviewing. Only
// one of them answers "what is this conversation armed with": the session's own. Handing the
// chip a sibling names a repository the session is not standing in, and its click opens the
// dialog ON that binding - which then refuses to reattach, because reattach compares the
// session's own cwd and repository root.

function summary(over: Partial<WorkflowBindingSummary>): WorkflowBindingSummary {
  return {
    id: "b",
    workflowVersionId: "v",
    workflowId: "w",
    workflowName: "No-Mistakes Review",
    workflowVersion: 8,
    noteKey: "note",
    sessionId: "session",
    triggerMode: "foreman_complete",
    deliveryMode: "preview",
    state: "active",
    updatedAt: 1,
    ...over,
  };
}

const REPO_ROOTS = new Map([["session", "/repo"]]);

test("the chip names the session's OWN binding, not an attached repo's newer sibling", () => {
  const own = summary({ id: "own", repoRoot: "/repo", updatedAt: 1 });
  const sibling = summary({ id: "sibling", repoRoot: "/second", updatedAt: 99 });
  assert.equal(ownBindingBySession([own, sibling], REPO_ROOTS).get("session")?.id, "own");
  // Order-independent: the fold must not depend on which summary the stream delivered first.
  assert.equal(ownBindingBySession([sibling, own], REPO_ROOTS).get("session")?.id, "own");
});

test("a binding with no repository reads as the session's own, which every old one is", () => {
  // `repoRoot` is optional and append-only on the wire: a summary written by an older daemon
  // omits it, and that binding is the conversation's own by construction.
  const legacy = summary({ id: "legacy", updatedAt: 1 });
  const sibling = summary({ id: "sibling", repoRoot: "/second", updatedAt: 99 });
  assert.equal(ownBindingBySession([legacy, sibling], REPO_ROOTS).get("session")?.id, "legacy");
});

test("within the session's own repository, newest still wins", () => {
  const older = summary({ id: "older", repoRoot: "/repo", updatedAt: 1 });
  const newer = summary({ id: "newer", repoRoot: "/repo", updatedAt: 2 });
  assert.equal(ownBindingBySession([older, newer], REPO_ROOTS).get("session")?.id, "newer");
  // Only `active` bindings arm anything - orphaned and paused ones will not run.
  const paused = summary({ id: "paused", repoRoot: "/repo", updatedAt: 3, state: "paused" });
  assert.equal(ownBindingBySession([newer, paused], REPO_ROOTS).get("session")?.id, "newer");
});

test("a session whose repository is unknown still gets its sibling-free binding", () => {
  // A session outside a repository has a null root, so nothing can match it. The sibling is
  // still the wrong answer - but it is the only one, and an armed chip is better than none.
  const sibling = summary({ id: "sibling", repoRoot: "/second", updatedAt: 1 });
  const roots = new Map<string, string | null>([["session", null]]);
  assert.equal(ownBindingBySession([sibling], roots).get("session")?.id, "sibling");
});
