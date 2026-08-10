// What is at stake is identity across an edit. The pipeline editor never touches edges: it
// projects the draft into stages, edits stages, and compiles a whole graph back. Autosave diffs,
// undo/redo history and version comparison all read node and edge ids, so a compiler that reminted
// an id an edit did not touch would manufacture CAS churn and silently break undo while the screen
// looked correct. Round-trip equality and id reuse are therefore pinned here, before any UI exists
// to hide a mistake - together with the projection's refusal to describe a graph it cannot express.
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  Persona,
  PublishedWorkflowGraph,
  PublishedWorkflowNode,
  WorkflowCheckSlot,
  WorkflowDraftGraph,
} from "../src/shared/workflow.ts";
import { validateWorkflowGraph } from "../src/shared/workflow-graph.ts";
import {
  compileStages,
  nodeLabel,
  projectStages,
  stageBlockers,
  stageExpressible,
  stageContents,
  stageName,
  stageSummary,
  type EvaluationStage,
  type Stage,
  type StagePipeline,
} from "../src/shared/workflow-stages.ts";

const personas: Persona[] = [
  ["intent", "Intent Conformance Judge"],
  ["security", "Security reviewer"],
  ["style", "Style reviewer"],
  ["docs", "Docs reviewer"],
].map(([id, name]) => ({
  id: id!, name: name!, normalizedName: name!.toLowerCase(), description: "",
  guidanceMarkdown: "# Judge", runner: null, model: null, revision: 1,
  archivedAt: null, createdAt: 1, updatedAt: 1, provenance: null, builtin: false,
}));

const empty: WorkflowDraftGraph = { nodes: [], edges: [] };

const freshDraft = (): WorkflowDraftGraph => ({
  nodes: [
    { id: "session", kind: "session", position: { x: 60, y: 60 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 400, y: 60 } },
  ],
  edges: [],
});

const pipeline = (stages: StagePipeline["stages"]): StagePipeline => ({
  sessionId: "session",
  endId: "end",
  endOutcome: "Complete",
  stages,
});

const solo = (personaId: string, nodeId: string | null = personaId): Stage => ({
  kind: "evaluation",
  joinId: null,
  members: [{ nodeId, kind: "persona", personaId }],
});

const parallel = (joinId: string | null, ids: readonly string[]): Stage => ({
  kind: "evaluation",
  joinId,
  members: ids.map((id) => ({ nodeId: id, kind: "persona", personaId: id })),
});

/** A check member, named by its slot the way `solo` is named by its Persona. */
const gate = (slot: WorkflowCheckSlot, nodeId: string | null = `check-${slot}`): Stage => ({
  kind: "evaluation",
  joinId: null,
  members: [{ nodeId, kind: "check", slot }],
});

const mixed = (joinId: string | null, members: EvaluationStage["members"]): Stage =>
  ({ kind: "evaluation", joinId, members });

/** A singleton session action stage, the only shape the union allows for one. */
const action = (sessionActionId: string, nodeId: string | null = sessionActionId): Stage => ({
  kind: "session_action",
  member: { nodeId, kind: "session_action", sessionActionId },
});

/**
 * Narrow to the evaluation arm with an assertion rather than a cast, so a test that reads
 * `.members` off a stage the projection decided was an action fails loudly instead of
 * silently reading `undefined`.
 */
const evaluation = (stage: Stage | undefined): EvaluationStage => {
  assert.ok(stage && stage.kind === "evaluation", "expected an evaluation stage");
  return stage;
};

const validation = (graph: WorkflowDraftGraph) =>
  validateWorkflowGraph({ graph, personas, completionPolicy: { kind: "none" } });

const edgeKeys = (graph: WorkflowDraftGraph) => new Map(graph.edges.map((edge) =>
  [`${edge.source} ${edge.sourcePort} ${edge.target} ${edge.targetPort}`, edge.id]));

test("every representative pipeline survives a compile and projection round trip", () => {
  const cases: StagePipeline[] = [
    pipeline([]),
    pipeline([solo("intent")]),
    pipeline([parallel("gate", ["intent", "security", "style"])]),
    pipeline([
      solo("intent"),
      parallel("gate", ["security", "style"]),
      solo("docs"),
    ]),
  ];
  for (const expected of cases) {
    const compiled = compileStages(expected, empty);
    assert.deepEqual(projectStages(compiled), expected);
    assert.deepEqual(stageBlockers(compiled), []);
    assert.deepEqual(validation(compiled), { valid: true, diagnostics: [] });
  }
});

test("a fresh Session-plus-End draft is the zero-stage pipeline, canonicalized only by an edit", () => {
  const draft = freshDraft();
  assert.deepEqual(stageBlockers(draft), []);
  assert.deepEqual(projectStages(draft), pipeline([]));
  // Draftable but not publishable: nothing is submitted anywhere yet.
  assert.ok(validation(draft).diagnostics.some((item) => item.code === "session_submitted_route"));

  const compiled = compileStages(projectStages(draft)!, draft);
  assert.deepEqual(compiled.edges.map((edge) => [edge.source, edge.sourcePort, edge.target, edge.targetPort]), [
    ["session", "submitted", "end", "terminal"],
  ]);
  assert.deepEqual(validation(compiled), { valid: true, diagnostics: [] });
  assert.deepEqual(projectStages(compiled), pipeline([]));

  // A stage with no members is not a stage. Emitting it would mean an edge with no source, which
  // persists as a graph whose diagnostics describe none of what the operator actually did.
  const emptied = compileStages(pipeline([{ kind: "evaluation", joinId: null, members: [] }]), compiled);
  assert.deepEqual(emptied, compiled);
});

test("adding a reviewer reuses every id the edit did not touch", () => {
  const before = compileStages(pipeline([solo("intent")]), empty);
  const previousKeys = edgeKeys(before);
  const after = compileStages(
    pipeline([{ kind: "evaluation", joinId: null, members: [
      { nodeId: "intent", kind: "persona", personaId: "intent" },
      { nodeId: null, kind: "persona", personaId: "security" },
    ] }]),
    before,
  );

  assert.ok(after.nodes.some((node) => node.id === "intent"));
  assert.equal(after.nodes.find((node) => node.id === "session")?.kind, "session");
  assert.equal(after.nodes.find((node) => node.id === "end")?.kind, "end");
  const keys = edgeKeys(after);
  assert.equal(keys.get("session submitted intent activate"), previousKeys.get("session submitted intent activate"));
  const projected = projectStages(after)!;
  assert.equal(evaluation(projected.stages[0]).members[0]!.nodeId, "intent");
  const minted = evaluation(projected.stages[0]).members[1]!.nodeId!;
  assert.ok(!before.nodes.some((node) => node.id === minted));
  assert.ok(!before.edges.some((edge) => edge.id === minted));
  assert.deepEqual(validation(after), { valid: true, diagnostics: [] });
});

test("removing a reviewer leaves the surviving members, join and edges untouched", () => {
  const before = compileStages(pipeline([parallel("gate", ["intent", "security", "style"])]), empty);
  const previousKeys = edgeKeys(before);
  const after = compileStages(pipeline([parallel("gate", ["intent", "style"])]), before);

  assert.deepEqual(
    after.nodes.map((node) => node.id),
    ["session", "intent", "style", "gate", "end"],
  );
  for (const [key, id] of edgeKeys(after)) {
    assert.equal(id, previousKeys.get(key), `edge ${key} was reminted`);
  }
  assert.ok(!after.edges.some((edge) => edge.source === "security"));
  assert.deepEqual(validation(after), { valid: true, diagnostics: [] });
});

test("reordering stages keeps node ids and every route that still means the same thing", () => {
  const before = compileStages(pipeline([solo("intent"), solo("security")]), empty);
  const previousKeys = edgeKeys(before);
  const after = compileStages(pipeline([solo("security"), solo("intent")]), before);

  assert.deepEqual(new Set(after.nodes.map((node) => node.id)), new Set(before.nodes.map((node) => node.id)));
  const keys = edgeKeys(after);
  for (const key of ["intent fail session return_for_changes", "security fail session return_for_changes"]) {
    assert.equal(keys.get(key), previousKeys.get(key), `edge ${key} was reminted`);
  }
  assert.deepEqual(
    projectStages(after)!.stages.map((stage) => {
      const member = evaluation(stage).members[0]!;
      return member.kind === "persona" ? member.personaId : member.slot;
    }),
    ["security", "intent"],
  );
  assert.deepEqual(validation(after), { valid: true, diagnostics: [] });
});

test("a brand-new stage mints its own join without disturbing the stage before it", () => {
  const before = compileStages(pipeline([solo("intent")]), empty);
  const after = compileStages(
    pipeline([
      solo("intent"),
      { kind: "evaluation", joinId: null, members: [
        { nodeId: null, kind: "persona", personaId: "security" },
        { nodeId: null, kind: "persona", personaId: "style" },
      ] },
    ]),
    before,
  );
  const projected = projectStages(after)!;
  assert.equal(evaluation(projected.stages[0]).members[0]!.nodeId, "intent");
  const gate = evaluation(projected.stages[1]).joinId!;
  const minted = evaluation(projected.stages[1]).members.map((member) => member.nodeId!);
  assert.equal(new Set([gate, ...minted, "intent", "session", "end"]).size, 6);
  assert.deepEqual(
    evaluation(projected.stages[1]).members.map((member) => member.kind === "persona" ? member.personaId : member.slot),
    ["security", "style"],
  );
  assert.deepEqual(validation(after), { valid: true, diagnostics: [] });
});

test("graphs the pipeline cannot express are refused with the reason, not a boolean", () => {
  const base = () => compileStages(pipeline([parallel("gate", ["security", "style"])]), empty);

  const duplicateNode = base();
  duplicateNode.nodes.push({ ...duplicateNode.nodes.find((node) => node.kind === "persona")! });
  assert.deepEqual(
    stageBlockers(duplicateNode),
    ["This graph has nodes with duplicate identities; every pipeline node needs a unique identity."],
  );
  assert.equal(projectStages(duplicateNode), null);

  const duplicateEdge = base();
  duplicateEdge.edges[1]!.id = duplicateEdge.edges[0]!.id;
  assert.deepEqual(
    stageBlockers(duplicateEdge),
    ["This graph has routes with duplicate identities; every pipeline route needs a unique identity."],
  );
  assert.equal(projectStages(duplicateEdge), null);

  const twoEnds = base();
  twoEnds.nodes.push({ id: "end-2", kind: "end", outcome: "Rejected", position: { x: 60, y: 400 } });
  assert.match(stageBlockers(twoEnds).join(" "), /2 End nodes/);

  const chained = compileStages(pipeline([solo("intent")]), empty);
  chained.nodes.push(
    { id: "security", kind: "persona", personaId: "security", position: { x: 600, y: 60 } },
    { id: "style", kind: "persona", personaId: "style", position: { x: 600, y: 230 } },
  );
  chained.edges = chained.edges.filter((edge) => edge.target !== "end");
  chained.edges.push(
    { id: "i-s", source: "intent", sourcePort: "pass", target: "security", targetPort: "activate" },
    { id: "i-y", source: "intent", sourcePort: "pass", target: "style", targetPort: "activate" },
    { id: "s-y", source: "security", sourcePort: "pass", target: "style", targetPort: "activate" },
    { id: "s-f", source: "security", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    { id: "y-e", source: "style", sourcePort: "pass", target: "end", targetPort: "terminal" },
    { id: "y-f", source: "style", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  );
  assert.deepEqual(
    stageBlockers(chained, personas),
    ["Security reviewer does not route both outcomes into one all-pass join with the rest of Stage 2."],
  );

  const noJoinReturn = base();
  noJoinReturn.edges = noJoinReturn.edges.filter((edge) =>
    !(edge.source === "gate" && edge.sourcePort === "fail"));
  assert.deepEqual(
    stageBlockers(noJoinReturn, personas),
    ["Stage 1's all-pass join does not return its fail route to Session."],
  );

  const crossStage = compileStages(pipeline([solo("intent"), parallel("gate", ["security", "style"])]), empty);
  crossStage.edges = crossStage.edges.map((edge) =>
    edge.source === "intent" && edge.sourcePort === "fail"
      ? { ...edge, target: "gate", targetPort: "result" as const }
      : edge);
  assert.deepEqual(
    stageBlockers(crossStage, personas),
    ["Intent Conformance Judge's fail route does not return to Session."],
  );

  const stranger = base();
  stranger.edges.push(
    { id: "extra-pass", source: "docs", sourcePort: "pass", target: "gate", targetPort: "result" },
    { id: "extra-fail", source: "docs", sourcePort: "fail", target: "gate", targetPort: "result" },
  );
  stranger.nodes.push({ id: "docs", kind: "persona", personaId: "docs", position: { x: 60, y: 400 } });
  assert.deepEqual(
    stageBlockers(stranger, personas),
    ["Stage 1's all-pass join also receives routes from outside the stage."],
  );

  const island = base();
  island.nodes.push({ id: "docs", kind: "persona", personaId: "docs", position: { x: 60, y: 400 } });
  assert.deepEqual(stageBlockers(island, personas), ["Docs reviewer is not part of the pipeline."]);

  for (const candidate of [
    duplicateNode,
    duplicateEdge,
    twoEnds,
    chained,
    noJoinReturn,
    crossStage,
    stranger,
    island,
  ]) {
    assert.equal(projectStages(candidate), null);
    assert.equal(stageExpressible(candidate), false);
  }
  assert.equal(stageExpressible(base()), true);
});

test("blocker count does not depend on persona name resolution", () => {
  const graph = compileStages(pipeline([solo("intent")]), empty);
  graph.nodes.push(
    { id: "security", kind: "persona", personaId: "security", position: { x: 600, y: 60 } },
    { id: "style", kind: "persona", personaId: "style", position: { x: 600, y: 230 } },
  );
  graph.edges.push(
    { id: "security-stray", source: "security", sourcePort: "pass", target: "missing-1", targetPort: "activate" },
    { id: "style-stray", source: "style", sourcePort: "pass", target: "missing-2", targetPort: "activate" },
  );

  const unnamed = stageBlockers(graph);
  const named = stageBlockers(graph, personas);
  assert.equal(unnamed.filter((blocker) => blocker.includes("is not part")).length, 2);
  assert.equal(unnamed.filter((blocker) => blocker.includes("has a route")).length, 2);
  assert.equal(unnamed.length, named.length);
});

test("names come from Personas and stages, and never from an id", () => {
  const draft = compileStages(
    pipeline([solo("intent"), parallel("gate", ["security", "style"])]),
    empty,
  );
  const labelOf = (id: string) =>
    nodeLabel(draft, draft.nodes.find((node) => node.id === id)!, personas);
  assert.equal(labelOf("session"), "Session");
  assert.equal(labelOf("end"), "Complete");
  assert.equal(labelOf("intent"), "Intent Conformance Judge");
  assert.equal(labelOf("gate"), "Stage 2");
  assert.equal(
    nodeLabel(draft, { id: "ghost", kind: "persona", personaId: "gone", position: { x: 0, y: 0 } }, personas),
    "Missing persona",
  );

  const projected = projectStages(draft)!;
  assert.equal(stageName(projected.stages[0]!, 0, personas), "Intent Conformance Judge");
  assert.equal(stageName(projected.stages[1]!, 1, personas), "Stage 2");

  // A published graph resolves names from its immutable snapshots, with no live Persona list.
  const published: PublishedWorkflowGraph = {
    nodes: draft.nodes.map((node): PublishedWorkflowNode => node.kind === "persona"
      ? {
          id: node.id,
          kind: "persona" as const,
          persona: {
            sourcePersonaId: node.personaId,
            sourceRevision: 1,
            name: personas.find((persona) => persona.id === node.personaId)!.name,
            description: "",
            guidanceMarkdown: "# Judge",
            runner: null,
            model: null,
          },
          position: node.position,
        }
      // This fixture draft has no action node, so every other arm carries through.
      : node as PublishedWorkflowNode),
    edges: draft.edges,
  };
  assert.deepEqual(projectStages(published), projectStages(draft));
  const publishedLabel = (id: string) =>
    nodeLabel(published, published.nodes.find((node) => node.id === id)!, []);
  assert.equal(publishedLabel("intent"), "Intent Conformance Judge");
  assert.equal(publishedLabel("gate"), "Stage 2");

  // The same Join in a graph no pipeline describes falls back to what its edges say.
  const orphaned: PublishedWorkflowGraph = {
    ...published,
    edges: published.edges.filter((edge) => !(edge.source === "gate" && edge.sourcePort === "fail")),
  };
  assert.equal(publishedLabel("gate").includes("gate"), false);
  assert.equal(
    nodeLabel(orphaned, orphaned.nodes.find((node) => node.id === "gate")!, []),
    "All-pass join · 2 predecessors",
  );

  const ids = new Set(draft.nodes.map((node) => node.id));
  for (const node of draft.nodes) assert.equal(ids.has(nodeLabel(draft, node, personas)), false);
});

// ---- Check nodes are pipeline members ----
//
// The narrowing that lived here is gone: `StageMember` is a union, so a check sits in a stage
// exactly where a Persona does. What is at stake now is that the compiler and the projection
// agree about it. The round trip is the whole contract - a shipped built-in whose graph
// projected but did not compile back to itself would silently rewrite its own durable node
// ids the first time an operator opened it - and it has to hold for a stage of checks and for
// a stage that MIXES the two, because the compiler treats members uniformly and a projection
// that special-cased either kind would be a second source of truth for what a stage contains.

test("pipelines containing checks survive the round trip, mixed stages included", () => {
  const cases: StagePipeline[] = [
    pipeline([gate("typecheck")]),
    pipeline([gate("test")]),
    // Two checks in one stage: the shape No-Mistakes Review v2 ships, and the reason Phase 2
    // had to let a Check be a Join predecessor.
    pipeline([mixed("build-gate", [
      { nodeId: "check-typecheck", kind: "check", slot: "typecheck" },
      { nodeId: "check-test", kind: "check", slot: "test" },
    ])]),
    // A Persona and a check agreeing on the same submission.
    pipeline([mixed("mixed-gate", [
      { nodeId: "intent", kind: "persona", personaId: "intent" },
      { nodeId: "check-lint", kind: "check", slot: "lint" },
    ])]),
    // The full shape: deterministic gate, cheap judge, parallel deep review.
    pipeline([
      mixed("build-gate", [
        { nodeId: "check-typecheck", kind: "check", slot: "typecheck" },
        { nodeId: "check-test", kind: "check", slot: "test" },
      ]),
      solo("intent"),
      parallel("gate", ["security", "style"]),
    ]),
  ];
  for (const expected of cases) {
    const compiled = compileStages(expected, empty);
    assert.deepEqual(projectStages(compiled), expected);
    assert.deepEqual(stageBlockers(compiled), [], "a check-containing graph is stage-expressible");
    assert.equal(stageExpressible(compiled), true);
    assert.deepEqual(validation(compiled), { valid: true, diagnostics: [] });
  }
});

test("adding and removing a check reuses every id the edit did not touch", () => {
  // Same claim as the Persona case, made separately because it is the compiler's check arm
  // that is new: an autosave that re-minted the nodes around an added gate would manufacture
  // CAS churn and break undo while the screen looked correct.
  const before = compileStages(pipeline([solo("intent")]), empty);
  const withCheck = compileStages(
    pipeline([mixed("mixed-gate", [
      { nodeId: "intent", kind: "persona", personaId: "intent" },
      { nodeId: null, kind: "check", slot: "typecheck" },
    ])]),
    before,
  );
  assert.deepEqual(validation(withCheck), { valid: true, diagnostics: [] });
  const minted = evaluation(projectStages(withCheck)!.stages[0]).members[1]!.nodeId!;
  assert.ok(minted, "the compiler mints the id for a member the editor added");
  assert.ok(withCheck.nodes.some((node) => node.id === "intent"), "the Persona kept its identity");
  // Every route that existed before and still means the same thing keeps its edge id.
  const survivingKeys = edgeKeys(before);
  for (const [key, id] of edgeKeys(withCheck)) {
    const previous = survivingKeys.get(key);
    if (previous) assert.equal(id, previous, `route ${key} was re-minted`);
  }

  // And taking it back out returns the pipeline to what it was, ids included.
  const removed = compileStages(pipeline([solo("intent")]), withCheck);
  assert.deepEqual(projectStages(removed), pipeline([solo("intent")]));
  assert.equal(removed.nodes.filter((node) => node.kind === "check").length, 0);
  assert.equal(removed.nodes.filter((node) => node.kind === "all_pass").length, 0);
  assert.deepEqual(validation(removed), { valid: true, diagnostics: [] });
});

test("a stage says what it holds, counted by kind", () => {
  // `stageContents` is the count alone, so a caller wanting it mid-sentence does not trim the
  // rule back off the end of `stageSummary` with a string replace that would silently stop
  // matching the day the wording changed.
  assert.equal(stageContents(parallel("g", ["security", "style"])), "2 reviewers");
  assert.equal(stageContents(solo("intent")), "1 reviewer");
  // One sentence, shared by the editor and the run monitor. "2 reviewers" was correct only
  // while a member could not be anything else.
  assert.equal(stageSummary(solo("intent")), "1 reviewer");
  assert.equal(stageSummary(gate("test")), "1 check");
  assert.equal(stageSummary(parallel("g", ["security", "style"])), "2 reviewers · all must pass");
  assert.equal(
    stageSummary(mixed("g", [
      { nodeId: "a", kind: "check", slot: "typecheck" },
      { nodeId: "b", kind: "check", slot: "test" },
    ])),
    "2 checks · all must pass",
  );
  assert.equal(
    stageSummary(mixed("g", [
      { nodeId: "a", kind: "persona", personaId: "intent" },
      { nodeId: "b", kind: "check", slot: "lint" },
    ])),
    "1 reviewer, 1 check · all must pass",
  );
});

test("a single-check stage is named by its slot, and a check still blocks when miswired", () => {
  const one = compileStages(pipeline([gate("build")]), empty);
  assert.equal(stageName(projectStages(one)!.stages[0]!, 0, personas), "Check · build");

  // A check parked off to the side is a stray node like any other now - the phase-2 blocker
  // that named the node KIND is gone, because the kind is no longer the reason.
  const island = compileStages(pipeline([solo("intent")]), empty);
  island.nodes.push({ id: "stray", kind: "check", slot: "lint", position: { x: 60, y: 400 } });
  assert.deepEqual(stageBlockers(island, personas), ["Check · lint is not part of the pipeline."]);
  assert.equal(projectStages(island), null);
});

test("a Check node is labelled by its slot everywhere a name is printed", () => {
  const draft = freshDraft();
  const gate = { id: "gate", kind: "check" as const, slot: "build" as const, position: { x: 220, y: 60 } };
  draft.nodes.push(gate);
  // Never "Missing persona", which is what the persona fall-through returned before the
  // label switch grew a check arm.
  assert.equal(nodeLabel(draft, gate, personas), "Check · build");
});
