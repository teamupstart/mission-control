import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addMember,
  insertStage,
  landedStageIndex,
  memberOptionValue,
  moveMember,
  moveStage,
  parseMemberOption,
  pipelineFocusOrder,
  removeMember,
  removeStage,
  seamGate,
} from "../src/web/workflows/PipelineEditor.tsx";
import { workflowEditorMode } from "../src/web/workflows/WorkflowLibrary.tsx";
import { pipelineValidationSentences } from "../src/web/workflows/WorkflowProperties.tsx";
import { compileStages, projectStages, stageBlockers } from "../src/shared/workflow-stages.ts";
import type { EvaluationStage, Stage, StagePipeline } from "../src/shared/workflow-stages.ts";
import { validateWorkflowGraph } from "../src/shared/workflow-graph.ts";
import type { PersonaView, WorkflowDraftGraph } from "../src/shared/workflow.ts";

/**
 * What is at stake: the editor is allowed to be stateless over `projectStages(draft)` only
 * because every edit it makes compiles to a graph that is (a) valid and (b) made of the SAME
 * ids wherever nothing moved. Break (a) and an operator authors a workflow that cannot
 * publish through a surface that offered them no way to go wrong. Break (b) and every edit
 * re-mints ids nobody changed, which manufactures CAS churn and breaks undo while looking
 * completely correct on screen.
 *
 * So each case drives one of the editor's exported handlers and then asks the SHARED
 * validator and the SHARED projector, rather than asserting a compiled shape by hand.
 */

const persona = (id: string, name: string, archivedAt: number | null = null): PersonaView => ({
  id,
  name,
  normalizedName: name.toLowerCase(),
  description: "",
  guidanceMarkdown: "",
  runner: null,
  model: null,
  revision: 1,
  archivedAt,
  createdAt: 1,
  updatedAt: 1,
  provenance: null,
  builtin: false,
  execution: {
    runner: { id: "claude", source: "default", unknown: null },
    model: { id: "claude-haiku-4-5", source: "default" },
  } as PersonaView["execution"],
});

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const P3 = "33333333-3333-4333-8333-333333333333";
const personas = [persona(P1, "Security"), persona(P2, "Docs"), persona(P3, "Judge")];

const FRESH: WorkflowDraftGraph = {
  nodes: [
    { id: "session-node", kind: "session", position: { x: 0, y: 0 } },
    { id: "end-node", kind: "end", outcome: "Complete", position: { x: 300, y: 0 } },
  ],
  edges: [],
};

const project = (graph: WorkflowDraftGraph): StagePipeline => {
  const pipeline = projectStages(graph);
  assert.ok(pipeline, `expected a stage-expressible graph, blockers: ${stageBlockers(graph).join(" ")}`);
  return pipeline;
};

/** One edit, exactly as the editor performs it: compile, then re-project the result. */
function edit(
  graph: WorkflowDraftGraph,
  change: (pipeline: StagePipeline) => StagePipeline,
): { graph: WorkflowDraftGraph; pipeline: StagePipeline } {
  const next = compileStages(change(project(graph)), graph);
  return { graph: next, pipeline: project(next) };
}

const validate = (graph: WorkflowDraftGraph): ReturnType<typeof validateWorkflowGraph> =>
  validateWorkflowGraph({ graph, personas, completionPolicy: { kind: "none" } });

/** A Persona seed, since every edit now says which KIND of member it is adding. */
const R = (personaId: string) => ({ kind: "persona" as const, personaId });
const C = (slot: "test" | "lint" | "typecheck" | "build") => ({ kind: "check" as const, slot });

/**
 * Narrow to the evaluation arm with an assertion rather than a cast. Every edit in this file
 * builds evaluation stages, so a stage that is not one means an edit produced a shape it was
 * never asked for - which should fail loudly rather than read `undefined.members`.
 */
const evaluation = (stage: Stage | undefined): EvaluationStage => {
  assert.ok(stage && stage.kind === "evaluation", "expected an evaluation stage");
  return stage;
};

/** Each stage's members, named by Persona id or by slot, so a mixed stage reads in one list. */
const memberIdsOf = (pipeline: StagePipeline): string[][] =>
  pipeline.stages.map((stage) => evaluation(stage).members.map((member) =>
    member.kind === "persona" ? member.personaId : member.slot));

test("adding the first reviewer to a fresh draft publishes-valid, and adding a second parallelizes it", () => {
  // The headline complaint the migration exists to kill: two reviewers on the submission was
  // a validation error nobody could author around.
  const first = edit(FRESH, (pipeline) => insertStage(pipeline, 0, R(P1)));
  assert.deepEqual(validate(first.graph), { valid: true, diagnostics: [] });
  assert.deepEqual(memberIdsOf(first.pipeline), [[P1]]);

  const second = edit(first.graph, (pipeline) => addMember(pipeline, 0, R(P2)));
  assert.deepEqual(validate(second.graph), { valid: true, diagnostics: [] });
  assert.deepEqual(memberIdsOf(second.pipeline), [[P1, P2]]);
  // Two submitted routes, one join, and neither was drawn by hand.
  const submitted = second.graph.edges.filter((edge) => edge.sourcePort === "submitted");
  assert.equal(submitted.length, 2);
  assert.equal(second.graph.nodes.filter((node) => node.kind === "all_pass").length, 1);
  assert.ok(evaluation(second.pipeline.stages[0]).joinId);
});

test("every edit keeps the ids of everything it did not touch", () => {
  const base = edit(
    edit(edit(FRESH, (p) => insertStage(p, 0, R(P1))).graph, (p) => addMember(p, 0, R(P2))).graph,
    (p) => insertStage(p, 1, R(P3)),
  );
  const before = base.pipeline;
  assert.deepEqual(memberIdsOf(before), [[P1, P2], [P3]]);

  const survivors = (graph: WorkflowDraftGraph): Set<string> =>
    new Set([...graph.nodes.map((node) => node.id), ...graph.edges.map((edge) => edge.id)]);
  const baseIds = survivors(base.graph);

  // Reordering reviewers within a stage moves NO identity: the same nodes, the same routes.
  const reordered = edit(base.graph, (p) => moveMember(p, { stage: 0, member: 0 }, { stage: 0, member: 1 }));
  assert.deepEqual([...survivors(reordered.graph)].sort(), [...baseIds].sort());
  assert.deepEqual(memberIdsOf(reordered.pipeline), [[P2, P1], [P3]]);

  // Reordering stages keeps every node, and re-routes rather than re-minting the nodes.
  const swapped = edit(base.graph, (p) => moveStage(p, 0, 1));
  assert.deepEqual(memberIdsOf(swapped.pipeline), [[P3], [P1, P2]]);
  for (const node of base.graph.nodes) {
    assert.ok(survivors(swapped.graph).has(node.id), `stage reorder re-minted a node`);
  }
  assert.deepEqual(validate(swapped.graph), { valid: true, diagnostics: [] });

  // Removing a reviewer keeps every id that is still in the pipeline.
  const trimmed = edit(base.graph, (p) => removeMember(p, { stage: 0, member: 1 }));
  assert.deepEqual(memberIdsOf(trimmed.pipeline), [[P1], [P3]]);
  assert.equal(
    evaluation(trimmed.pipeline.stages[0]).members[0]!.nodeId,
    evaluation(before.stages[0]).members[0]!.nodeId,
  );
  assert.equal(
    evaluation(trimmed.pipeline.stages[1]).members[0]!.nodeId,
    evaluation(before.stages[1]).members[0]!.nodeId,
  );
  // Down to one member the stage needs no join, so the join node is gone from the graph.
  assert.equal(trimmed.graph.nodes.filter((node) => node.kind === "all_pass").length, 0);
  assert.deepEqual(validate(trimmed.graph), { valid: true, diagnostics: [] });
});

test("a reviewer dragged between stages leaves no empty stage behind", () => {
  const base = edit(
    edit(FRESH, (p) => insertStage(p, 0, R(P1))).graph,
    (p) => insertStage(p, 1, R(P2)),
  );
  assert.deepEqual(memberIdsOf(base.pipeline), [[P1], [P2]]);
  const merged = edit(base.graph, (p) => moveMember(p, { stage: 1, member: 0 }, { stage: 0, member: 1 }));
  assert.deepEqual(memberIdsOf(merged.pipeline), [[P1, P2]]);
  assert.deepEqual(validate(merged.graph), { valid: true, diagnostics: [] });
  // The moved reviewer keeps its node; only its routes changed.
  assert.equal(
    evaluation(merged.pipeline.stages[0]).members[1]!.nodeId,
    evaluation(base.pipeline.stages[1]).members[0]!.nodeId,
  );
});

test("a drag that empties its source stage names the destination it actually landed in", () => {
  // Moving the last member out of a stage removes that stage, so every later stage shifts
  // down one. The move was always correct; the sentence describing it named the stage by
  // its pre-move index and so announced a stage that no longer existed.
  const base = edit(
    edit(FRESH, (p) => insertStage(p, 0, R(P1))).graph,
    (p) => insertStage(p, 1, R(P2)),
  ).pipeline;
  const from = { stage: 0, member: 0 };
  const to = { stage: 1, member: 1 };
  assert.equal(landedStageIndex(base, from, to), 0, "Stage 2 becomes Stage 1 once Stage 1 empties");
  const merged = moveMember(base, from, to);
  assert.deepEqual(memberIdsOf(merged), [[P2, P1]]);
  assert.equal(merged.stages.length, 1);

  // Dragging BACKWARDS empties a later stage, which shifts nothing before it.
  assert.equal(landedStageIndex(base, { stage: 1, member: 0 }, { stage: 0, member: 1 }), 0);

  // A source stage that keeps members removes nothing, so the destination stands.
  const wide = addMember(base, 0, R(P3));
  assert.equal(landedStageIndex(wide, from, to), 1);

  // And a reorder within one stage can never empty it.
  assert.equal(landedStageIndex(base, from, { stage: 0, member: 0 }), 0);
});

test("removing the last stage returns the canonical zero-stage pipeline, still valid", () => {
  const one = edit(FRESH, (p) => insertStage(p, 0, R(P1)));
  const none = edit(one.graph, (p) => removeStage(p, 0));
  assert.deepEqual(none.pipeline.stages, []);
  // A zero-reviewer workflow completes on submission - the direct route, not an empty graph.
  assert.deepEqual(
    none.graph.edges.map((edge) => [edge.sourcePort, edge.targetPort]),
    [["submitted", "terminal"]],
  );
  assert.deepEqual(validate(none.graph), { valid: true, diagnostics: [] });

  // And removing the only member of a stage is the same outcome by the other door.
  const emptied = edit(one.graph, (p) => removeMember(p, { stage: 0, member: 0 }));
  assert.deepEqual(emptied.pipeline.stages, []);
  assert.deepEqual(validate(emptied.graph), { valid: true, diagnostics: [] });
});

test("an out-of-range edit is a no-op rather than a corrupted pipeline", () => {
  const one = project(edit(FRESH, (p) => insertStage(p, 0, R(P1))).graph);
  assert.deepEqual(addMember(one, 3, R(P2)), one);
  assert.deepEqual(removeMember(one, { stage: 0, member: 4 }), one);
  assert.deepEqual(removeStage(one, 2), one);
  assert.deepEqual(moveStage(one, 0, 5), one);
  assert.deepEqual(moveStage(one, 0, 0), one);
  assert.deepEqual(moveMember(one, { stage: 0, member: 0 }, { stage: 9, member: 0 }), one);
});

test("focus order and gate marks follow the pipeline's shape", () => {
  const two = project(edit(
    edit(edit(FRESH, (p) => insertStage(p, 0, R(P1))).graph, (p) => addMember(p, 0, R(P2))).graph,
    (p) => insertStage(p, 1, R(P3)),
  ).graph);
  assert.deepEqual(pipelineFocusOrder(two), [
    "session",
    "stage:0",
    "member:0:0",
    "member:0:1",
    "stage:1",
    "member:1:0",
    "end",
  ]);
  // The gate is what the stage has to agree on before anything moves past the seam.
  assert.equal(seamGate(two.stages[0]), "all pass");
  assert.equal(seamGate(two.stages[1]), "pass");
  assert.equal(seamGate(undefined), null);
});

test("the surface a draft opens on follows what its graph expresses", () => {
  // Expressible: pipeline unless the operator said otherwise.
  assert.equal(workflowEditorMode(null, true), "pipeline");
  assert.equal(workflowEditorMode("graph", true), "graph");
  // Not expressible: graph, even if pipeline was the operator's last choice - an undo in
  // Graph view can leave a shape the Pipeline cannot draw, and stranding them on a blank
  // Pipeline would look like the editor lost their work.
  assert.equal(workflowEditorMode(null, false), "graph");
  assert.equal(workflowEditorMode("pipeline", false), "graph");
});

test("pipeline validation speaks sentences, and the fresh draft gets guidance not codes", () => {
  assert.deepEqual(pipelineValidationSentences([], 1), []);
  assert.deepEqual(
    pipelineValidationSentences(
      [
        { code: "session_submitted_route", severity: "error", message: "Session needs a submitted route." },
        { code: "no_terminal_path", severity: "error", message: "No path reaches a terminal outcome." },
      ],
      0,
    ),
    ["Add a reviewer to route the submission."],
  );
  // With stages, only Persona-level problems remain reachable, and they are already
  // sentences. Duplicates collapse - two archived reviewers is one thing to fix per message.
  assert.deepEqual(
    pipelineValidationSentences(
      [
        { code: "archived_persona", severity: "error", message: "Security is archived.", nodeId: "a" },
        { code: "archived_persona", severity: "error", message: "Security is archived.", nodeId: "b" },
        { code: "unreachable_node", severity: "warning", message: "ignored", nodeId: "c" },
      ],
      2,
    ),
    ["Security is archived."],
  );
});

test("a check is added, reordered and removed by the same handlers a reviewer is", () => {
  // The whole claim of the union: a check is a stage MEMBER, so it takes the Persona code
  // path rather than a parallel one. A separate add/move/remove path for checks is how the
  // two drift into disagreeing about what a stage contains.
  const gated = edit(
    edit(FRESH, (p) => insertStage(p, 0, C("typecheck"))).graph,
    (p) => addMember(p, 0, C("test")),
  );
  assert.deepEqual(validate(gated.graph), { valid: true, diagnostics: [] });
  assert.deepEqual(memberIdsOf(gated.pipeline), [["typecheck", "test"]]);
  // Two checks in one stage means a minted join, exactly as two Personas would - and this is
  // the shape No-Mistakes Review v2 ships, so the validator has to accept a Check as a Join
  // predecessor for it.
  assert.equal(gated.graph.nodes.filter((node) => node.kind === "all_pass").length, 1);
  assert.ok(evaluation(gated.pipeline.stages[0]).joinId);

  // Reorder: ⌥↑ / ⌥↓ moves a check within its stage, with no identity re-minted.
  const swapped = edit(gated.graph, (p) => moveMember(p, { stage: 0, member: 0 }, { stage: 0, member: 1 }));
  assert.deepEqual(memberIdsOf(swapped.pipeline), [["test", "typecheck"]]);
  assert.deepEqual(
    swapped.graph.nodes.map((node) => node.id).sort(),
    gated.graph.nodes.map((node) => node.id).sort(),
  );

  // A mixed stage is legal, and the check keeps its node when a reviewer joins it.
  const mixed = edit(gated.graph, (p) => addMember(p, 0, R(P1)));
  assert.deepEqual(memberIdsOf(mixed.pipeline), [["typecheck", "test", P1]]);
  assert.deepEqual(validate(mixed.graph), { valid: true, diagnostics: [] });

  // Delete: removing a check leaves the rest of the stage and its ids alone.
  const trimmed = edit(mixed.graph, (p) => removeMember(p, { stage: 0, member: 1 }));
  assert.deepEqual(memberIdsOf(trimmed.pipeline), [["typecheck", P1]]);
  assert.equal(
    evaluation(trimmed.pipeline.stages[0]).members[0]!.nodeId,
    evaluation(mixed.pipeline.stages[0]).members[0]!.nodeId,
  );
  assert.deepEqual(validate(trimmed.graph), { valid: true, diagnostics: [] });
});

test("a check moves between stages, and a stage of only checks is a stage", () => {
  const base = edit(
    edit(FRESH, (p) => insertStage(p, 0, C("typecheck"))).graph,
    (p) => insertStage(p, 1, R(P1)),
  );
  assert.deepEqual(memberIdsOf(base.pipeline), [["typecheck"], [P1]]);
  assert.deepEqual(validate(base.graph), { valid: true, diagnostics: [] });
  // The deterministic gate stands alone in front of the reviewer, which is v2's shape.
  assert.equal(evaluation(base.pipeline.stages[0]).joinId, null, "one member needs no join");

  const merged = edit(base.graph, (p) => moveMember(p, { stage: 0, member: 0 }, { stage: 1, member: 0 }));
  assert.deepEqual(memberIdsOf(merged.pipeline), [["typecheck", P1]]);
  assert.deepEqual(validate(merged.graph), { valid: true, diagnostics: [] });
  assert.equal(landedStageIndex(base.pipeline, { stage: 0, member: 0 }, { stage: 1, member: 0 }), 0);
});

test("the member picker round-trips both kinds and refuses a value it cannot read", () => {
  // A `<select>` carries one string, so the kind has to survive the trip. An unreadable value
  // - a stale option from an older build, or a slot this build does not ship - must add
  // NOTHING rather than adding the wrong kind of member.
  for (const seed of [R(P1), C("test"), C("build")]) {
    assert.deepEqual(parseMemberOption(memberOptionValue(seed)), seed);
  }
  assert.equal(parseMemberOption("check:deploy"), null, "an unshipped slot adds nothing");
  assert.equal(parseMemberOption(""), null);
  assert.equal(parseMemberOption("persona:"), null);
  assert.equal(parseMemberOption(P1), null, "a bare id is not a member option");
  // Prefixed so a Persona whose id spelled a slot could never be read as a check.
  assert.notEqual(memberOptionValue(R("test")), memberOptionValue(C("test")));
});
