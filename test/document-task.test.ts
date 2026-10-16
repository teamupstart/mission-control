import assert from "node:assert/strict";
import test from "node:test";
import { DispatchSchema, UpdateTaskSchema, WorkflowDraftGraphSchema, PublishedWorkflowGraphSchema } from "../src/shared/protocol.ts";
import { TaskSourceDefaultsSchema } from "../src/shared/task-source.ts";
import { hasReviewableDiff, isShippingTaskKind, taskDefaultWorkflowId, taskKindAllowsBacklog } from "../src/shared/task.ts";
import { taskCompletionContract } from "../src/shared/task-completion.ts";
import { withTaskKindContract } from "../src/server/task-contract.ts";
import { automaticWrapupBlock } from "../src/server/foreman/wrapup-eligibility.ts";
import { BUILTIN_WORKFLOWS } from "../src/server/workflows/builtin-workflows.ts";
import { projectStages, compileStages } from "../src/shared/workflow-stages.ts";
import { setMemberRecheckAfterRepair } from "../src/web/workflows/PipelineEditor.tsx";
import { mkTask } from "./helpers/session-fixture.ts";

test("document is a reviewable, schedulable shipping kind with its own default", () => {
  assert.equal(DispatchSchema.safeParse({ repoRoot: "/repo", title: "Document setup", intent: "Update setup instructions", kind: "document", backlog: true }).success, true);
  assert.equal(UpdateTaskSchema.safeParse({ kind: "document" }).success, true);
  assert.equal(TaskSourceDefaultsSchema.safeParse({ kind: "document" }).success, true);
  assert.equal(hasReviewableDiff("document"), true);
  assert.equal(taskKindAllowsBacklog("document"), true);
  assert.equal(isShippingTaskKind("document"), true);
  assert.equal(taskDefaultWorkflowId("document", "machine-choice"), "builtin-workflow:documentation-review");
  assert.equal(taskDefaultWorkflowId("ship", "machine-choice"), "machine-choice");
  assert.equal(automaticWrapupBlock({ taskKind: "document", workflowId: null, objective: "Write a documentation page", changedPaths: ["docs/setup.md"], skipScoutWrapup: true, skipReviewArtifactWrapup: true }), null);
});

test("document handoff preserves intent and asks for current comparison text only with Persona review", () => {
  const task = mkTask({ kind: "document" });
  const contract = taskCompletionContract("document");
  assert.ok(contract);
  assert.equal(contract.kind, "document");
  assert.deepEqual(contract.deferred, taskCompletionContract("ship")!.deferred);
  const prompt = withTaskKindContract(task, "Update the setup guide", { workflowEvidence: true });
  assert.ok(prompt.startsWith("Update the setup guide\n\n"));
  assert.match(prompt, /Document task completion handoff/);
  assert.match(prompt, /Documentation review evidence/);
  assert.match(prompt, /unchanged/);
  assert.match(prompt, /after every repair/);
  assert.match(prompt, /git history patches and commit messages/);
  assert.match(prompt, /destination text/);
  assert.doesNotMatch(withTaskKindContract(task, "Update the setup guide"), /Documentation review evidence/);
  assert.doesNotMatch(withTaskKindContract(mkTask({ kind: "ship" }), "Implement it", { workflowEvidence: true }), /Documentation review evidence/);
});

test("Documentation Review composes the documentation gate and three specialists before publication", () => {
  const workflow = BUILTIN_WORKFLOWS.find(item => item.definition.id === "builtin-workflow:documentation-review");
  assert.ok(workflow);
  const version = workflow.versions.at(-1)!;
  const pipeline = projectStages(version.graph)!;
  assert.ok(pipeline);
  assert.deepEqual(pipeline.stages.map(stage => stage.kind === "session_action"
    ? stage.member.sessionActionId
    : stage.members.map(member => member.kind === "check" ? member.slot : member.personaId)), [
    ["documentation"],
    ["builtin:intent-conformance-judge"],
    ["builtin:documentation-steward", "builtin:documentation-consistency-judge", "builtin:conciseness-reference-judge"],
    "builtin:pull-request",
  ]);
  assert.equal(version.bindingDefaults.maxRepairRounds, 5);
  assert.equal(version.resumptionPolicy, "auto");
  assert.equal(version.completionPolicy.kind, "none");
  for (const node of version.graph.nodes.filter(node => node.kind === "persona")) {
    assert.equal(node.recheckAfterRepair, true);
  }
  assert.deepEqual(PublishedWorkflowGraphSchema.parse(version.graph), version.graph);
});

test("repair policy survives stage edits without changing neighboring judges", () => {
  const workflow = BUILTIN_WORKFLOWS.find(item => item.definition.id === "builtin-workflow:documentation-review")!;
  const draft = WorkflowDraftGraphSchema.parse(workflow.definition.draft);
  const pipeline = projectStages(draft)!;
  const changed = setMemberRecheckAfterRepair(pipeline, { stage: 2, member: 1 }, false);
  const graph = compileStages(changed, draft);
  const reviewers = graph.nodes.filter(node => node.kind === "persona");
  assert.deepEqual(reviewers.map(node => [node.id, node.recheckAfterRepair]), [
    ["dr-intent", true], ["dr-steward", true], ["dr-consistency", false], ["dr-conciseness", true],
  ]);
  assert.deepEqual(compileStages(projectStages(graph)!, graph), graph);
  const invalid = { ...graph, nodes: graph.nodes.map(node => node.kind === "persona" ? { ...node, recheckAfterRepair: "yes" } : node) };
  assert.equal(WorkflowDraftGraphSchema.safeParse(invalid).success, false);
  for (const builtin of BUILTIN_WORKFLOWS.filter(item => item !== workflow)) {
    for (const version of builtin.versions) {
      assert.ok(version.graph.nodes.every(node => !Object.hasOwn(node, "recheckAfterRepair")));
    }
  }
});
