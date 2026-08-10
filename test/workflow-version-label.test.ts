import assert from "node:assert/strict";
import test from "node:test";
import {
  builtinWorkflowVersionId,
  NO_MISTAKES_REVIEW_WORKFLOW_ID,
  parseBuiltinWorkflowVersionId,
} from "../src/shared/builtin-workflow.ts";
import { workflowVersionLabel, type WorkflowNamingSource } from "../src/shared/workflow.ts";

// What is at stake: a binding stores only an immutable version id, and three surfaces render
// one. They used to render `id.slice(0, 8)`, which turns the shipped review workflow into
// "builtin-" - so the notice telling an operator their session was ALREADY bound to
// No-Mistakes Review named nothing at all, and the session read as unbound.

const NO_MISTAKES: WorkflowNamingSource = {
  id: NO_MISTAKES_REVIEW_WORKFLOW_ID,
  name: "No-Mistakes Review",
  currentVersionId: builtinWorkflowVersionId("no-mistakes-review", 8),
  publishedVersion: 8,
};

const OPERATOR: WorkflowNamingSource = {
  id: "4f1c0f4e-0000-4000-8000-000000000001",
  name: "Bypass",
  currentVersionId: "9a2b0f4e-0000-4000-8000-000000000002",
  publishedVersion: 1,
};

const CATALOG = [OPERATOR, NO_MISTAKES];

test("parses the workflow and number out of a built-in version id", () => {
  assert.deepEqual(parseBuiltinWorkflowVersionId("builtin-workflow:no-mistakes-review@8"), {
    workflowId: "builtin-workflow:no-mistakes-review",
    version: 8,
  });
});

test("round-trips whatever builtinWorkflowVersionId produces", () => {
  for (const version of [1, 7, 8, 12]) {
    const id = builtinWorkflowVersionId("no-mistakes-review", version);
    assert.deepEqual(parseBuiltinWorkflowVersionId(id), {
      workflowId: NO_MISTAKES_REVIEW_WORKFLOW_ID,
      version,
    });
  }
});

test("refuses ids that are not built-in version ids", () => {
  // An operator workflow's version id is a bare UUID: no prefix, nothing to parse.
  assert.equal(parseBuiltinWorkflowVersionId(OPERATOR.currentVersionId!), null);
  // The workflow id itself carries no version.
  assert.equal(parseBuiltinWorkflowVersionId(NO_MISTAKES_REVIEW_WORKFLOW_ID), null);
  // A prefix with an empty slug is not a workflow, however well-formed the tail looks.
  assert.equal(parseBuiltinWorkflowVersionId("builtin-workflow:@8"), null);
  assert.equal(parseBuiltinWorkflowVersionId("builtin-workflow:no-mistakes-review@"), null);
  assert.equal(parseBuiltinWorkflowVersionId("builtin-workflow:no-mistakes-review@nope"), null);
  assert.equal(parseBuiltinWorkflowVersionId("builtin-workflow:no-mistakes-review@0"), null);
});

test("names the built-in every dispatch arms, rather than truncating its id", () => {
  const label = workflowVersionLabel(NO_MISTAKES.currentVersionId!, CATALOG);
  assert.equal(label, "No-Mistakes Review · v8");
  // The regression this exists to prevent.
  assert.notEqual(label, "builtin-");
});

test("names an operator workflow from its catalog entry", () => {
  assert.equal(workflowVersionLabel(OPERATOR.currentVersionId!, CATALOG), "Bypass · v1");
});

test("keeps naming a superseded built-in version after a newer one ships", () => {
  // A session bound to v7 while v8 is current is exactly the case the dialog exists to show,
  // and the catalog holds only v8 - so the id's own structure has to carry the answer.
  assert.equal(
    workflowVersionLabel(builtinWorkflowVersionId("no-mistakes-review", 7), CATALOG),
    "No-Mistakes Review · v7",
  );
});

test("falls back to the id rather than inventing a name", () => {
  // Deliberately the raw id: an operator can paste it into a bug report, and "Unknown" cannot.
  const orphan = "0000ffff-0000-4000-8000-00000000dead";
  assert.equal(workflowVersionLabel(orphan, CATALOG), orphan);
  assert.equal(workflowVersionLabel(NO_MISTAKES.currentVersionId!, []), NO_MISTAKES.currentVersionId);
});

test("does not confuse two workflows that share a version number", () => {
  // Both catalogs entries publish a v1 here; matching must be on identity, not on number.
  const twoV1 = [
    { id: "a", name: "Alpha", currentVersionId: "ver-a", publishedVersion: 1 },
    { id: "b", name: "Beta", currentVersionId: "ver-b", publishedVersion: 1 },
  ];
  assert.equal(workflowVersionLabel("ver-b", twoV1), "Beta · v1");
});
