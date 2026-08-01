import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  Persona,
  PublishedWorkflowGraph,
  PublishedWorkflowNode,
  SessionAction,
  WorkflowDraftGraph,
} from "../src/shared/workflow.ts";
import {
  compileStages,
  nodeLabel,
  projectStages,
  stageBlockers,
  stageContents,
  stageMemberKey,
  stageMembers,
  stageName,
  stageNodeIds,
  stageSeamGate,
  stageSummary,
  type Stage,
  type StagePipeline,
} from "../src/shared/workflow-stages.ts";

// What is at stake: the pipeline is a PROJECTION, and its round trip is the contract every
// editor edit rests on. A SessionAction is the first stage that is not an evaluation wave, so
// the union has to survive `projectStages(compileStages(p, g)) === p` in every position, reuse
// every surviving identity, and leave an old graph byte-identical when nothing about it moved.

const personas: Persona[] = ["intent", "security"].map((id) => ({
  id, name: id, normalizedName: id, description: "", guidanceMarkdown: "# Judge",
  runner: null, model: null, revision: 1, archivedAt: null, createdAt: 1, updatedAt: 1,
  builtin: false,
}));

const actions: SessionAction[] = [
  ["pr", "Pull Request"],
  ["notify", "Notify"],
].map(([id, name]) => ({
  id: id!, name: name!, normalizedName: name!.toLowerCase(), description: "",
  promptMarkdown: "# Do it\n", requiredSkillId: null, completion: { kind: "session_turn" as const },
  revision: 1, archivedAt: null, createdAt: 1, updatedAt: 1, builtin: false,
}));

const empty: WorkflowDraftGraph = { nodes: [], edges: [] };

const pipeline = (stages: Stage[]): StagePipeline => ({
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

const act = (sessionActionId: string, nodeId: string | null = sessionActionId): Stage => ({
  kind: "session_action",
  member: { nodeId, kind: "session_action", sessionActionId },
});

const edgeKeys = (graph: WorkflowDraftGraph) => new Map(graph.edges.map((edge) =>
  [`${edge.source} ${edge.sourcePort} ${edge.target} ${edge.targetPort}`, edge.id]));

const routes = (graph: WorkflowDraftGraph, source: string) =>
  graph.edges
    .filter((edge) => edge.source === source)
    .map((edge) => `${edge.sourcePort}->${edge.target}:${edge.targetPort}`)
    .sort();

test("an action stage round-trips in first, middle and last position, and more than once", () => {
  const cases: StagePipeline[] = [
    pipeline([act("pr")]),
    pipeline([act("pr"), solo("intent")]),
    pipeline([solo("intent"), act("pr")]),
    pipeline([solo("intent"), act("pr"), solo("security")]),
    pipeline([parallel("gate", ["intent", "security"]), act("pr")]),
    // Two actions in one pipeline: neither is special, and neither consumes anything the
    // other needs. Phase 2's repair budget rests on that being expressible.
    pipeline([act("pr"), solo("intent"), act("notify")]),
  ];
  for (const expected of cases) {
    const compiled = compileStages(expected, empty);
    assert.deepEqual(projectStages(compiled), expected);
    assert.deepEqual(stageBlockers(compiled), []);
  }
});

test("an action's compiled routes are one activate in and one complete out - and no fail", () => {
  const graph = compileStages(pipeline([solo("intent"), act("pr"), solo("security")]), empty);
  assert.deepEqual(routes(graph, "session"), ["submitted->intent:activate"]);
  assert.deepEqual(routes(graph, "intent"), [
    "fail->session:return_for_changes",
    "pass->pr:activate",
  ]);
  // The whole route list for the action, so a fail route invented for it would show up here.
  assert.deepEqual(routes(graph, "pr"), ["complete->security:activate"]);
  assert.deepEqual(routes(graph, "security"), [
    "fail->session:return_for_changes",
    "pass->end:terminal",
  ]);
  // No join is minted for a singleton, and an action is a singleton by construction.
  assert.equal(graph.nodes.filter((node) => node.kind === "all_pass").length, 0);
});

test("a trailing action routes its completion to End rather than a pass", () => {
  const graph = compileStages(pipeline([solo("intent"), act("pr")]), empty);
  assert.deepEqual(routes(graph, "pr"), ["complete->end:terminal"]);
});

test("compiling an action keeps every identity the edit did not touch", () => {
  const before = compileStages(pipeline([solo("intent"), act("pr"), solo("security")]), empty);
  const previousKeys = edgeKeys(before);

  // Insert a reviewer AFTER the action: the action's own node id and its incoming route are
  // untouched, and only the route it emits is rewritten because its target changed.
  const after = compileStages(
    pipeline([solo("intent"), act("pr"), solo("docs", null), solo("security")]),
    before,
  );
  assert.ok(after.nodes.some((node) => node.id === "pr" && node.kind === "session_action"));
  for (const key of [
    "session submitted intent activate",
    "intent pass pr activate",
    "intent fail session return_for_changes",
    "security fail session return_for_changes",
  ]) {
    assert.equal(edgeKeys(after).get(key), previousKeys.get(key), `edge ${key} was reminted`);
  }

  // Taking the action back out returns the pipeline to what it was, ids included.
  const removed = compileStages(pipeline([solo("intent"), solo("security")]), after);
  assert.deepEqual(projectStages(removed), pipeline([solo("intent"), solo("security")]));
  assert.equal(removed.nodes.filter((node) => node.kind === "session_action").length, 0);
});

test("a new action stage mints exactly one node and nothing else", () => {
  const before = compileStages(pipeline([solo("intent")]), empty);
  const after = compileStages(pipeline([solo("intent"), act("pr", null)]), before);
  const minted = after.nodes.filter((node) => !before.nodes.some((old) => old.id === node.id));
  assert.equal(minted.length, 1);
  assert.equal(minted[0]!.kind, "session_action");
  const projected = projectStages(after)!;
  const stage = projected.stages[1]!;
  assert.equal(stage.kind, "session_action");
  assert.equal(stage.kind === "session_action" && stage.member.nodeId, minted[0]!.id);
});

test("a graph with no action is byte-stable through the round trip", () => {
  // The regression this guards is the quiet one: adding a stage kind must not reposition,
  // reorder or remint anything in a graph that predates it.
  const original = compileStages(
    pipeline([solo("intent"), parallel("gate", ["security", "docs"])]),
    empty,
  );
  const again = compileStages(projectStages(original)!, original);
  assert.equal(JSON.stringify(again), JSON.stringify(original));
});

test("a published action node projects to the same pipeline shape its draft did", () => {
  const draft = compileStages(pipeline([solo("intent"), act("pr")]), empty);
  const published: PublishedWorkflowGraph = {
    nodes: draft.nodes.map((node): PublishedWorkflowNode => {
      if (node.kind === "persona") {
        return {
          id: node.id,
          kind: "persona",
          position: node.position,
          persona: {
            sourcePersonaId: node.personaId,
            sourceRevision: 1,
            name: "Intent",
            description: "",
            guidanceMarkdown: "# Judge",
            runner: null,
            model: null,
          },
        };
      }
      if (node.kind === "session_action") {
        return {
          id: node.id,
          kind: "session_action",
          position: node.position,
          action: {
            sourceSessionActionId: node.sessionActionId,
            sourceRevision: 4,
            name: "Pull Request",
            description: "",
            promptMarkdown: "# Pull Request\n",
            requiredSkillId: "pull-request",
            completion: { kind: "pull_request" },
          },
        };
      }
      return node as PublishedWorkflowNode;
    }),
    edges: draft.edges,
  };
  assert.deepEqual(projectStages(published), projectStages(draft));
  // A published graph resolves names from its own snapshots, with no live catalog at all.
  const label = (id: string) =>
    nodeLabel(published, published.nodes.find((node) => node.id === id)!, [], []);
  assert.equal(label("pr"), "Pull Request");
});

test("a freehand action shape is refused with a sentence, not a boolean", () => {
  const base = () => compileStages(pipeline([solo("intent"), act("pr")]), empty);

  // Fanned out beside a reviewer: the action would be writing to the session while a
  // reviewer read the evidence it is about to invalidate.
  const mixed = base();
  mixed.nodes.push({ id: "sec", kind: "persona", personaId: "security", position: { x: 0, y: 0 } });
  mixed.edges.push(
    { id: "m1", source: "intent", sourcePort: "pass", target: "sec", targetPort: "activate" },
    { id: "m2", source: "sec", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    { id: "m3", source: "sec", sourcePort: "pass", target: "end", targetPort: "terminal" },
  );
  assert.deepEqual(
    stageBlockers(mixed, personas, actions),
    ["intent's pass route routes to a session action alongside another node; a session action runs on its own."],
  );

  // Two actions activated at once is the same refusal, for the same reason.
  const twin = base();
  twin.nodes.push({ id: "second", kind: "session_action", sessionActionId: "notify", position: { x: 0, y: 0 } });
  twin.edges.push(
    { id: "t1", source: "intent", sourcePort: "pass", target: "second", targetPort: "activate" },
    { id: "t2", source: "second", sourcePort: "complete", target: "end", targetPort: "terminal" },
  );
  assert.equal(stageBlockers(twin, personas, actions).length, 1);
  assert.match(stageBlockers(twin, personas, actions)[0]!, /runs on its own/);

  // A completion that leads nowhere is a pipeline that stops mid-air.
  const dangling = base();
  dangling.edges = dangling.edges.filter((edge) => edge.source !== "pr");
  assert.deepEqual(
    stageBlockers(dangling, personas, actions),
    ["Pull Request's complete route leads nowhere."],
  );
});

test("an action stage describes itself as one, and its seam says complete", () => {
  const stage = act("pr");
  assert.equal(stageContents(stage), "1 session action");
  // Not "1 check". The evaluation arm counts "everything that is not a reviewer" as a check,
  // and an action routed through that arm would have described itself as a deterministic gate.
  assert.equal(stageSummary(stage), "1 session action · later stages review new evidence");
  assert.equal(stageSummary(solo("intent")), "1 reviewer");
  assert.equal(stageSeamGate(stage), "complete");
  assert.equal(stageSeamGate(solo("intent")), "pass");
  assert.equal(stageSeamGate(parallel("g", ["intent", "security"])), "all pass");
});

test("an action stage names itself from the catalog, or says the source is gone", () => {
  assert.equal(stageName(act("pr"), 0, personas, actions), "Pull Request");
  assert.equal(stageName(act("pr"), 0, personas, []), "Missing session action");
  // A singleton always names itself, so there is no "Stage N" fallback to fall into.
  assert.equal(stageName(act("notify"), 3, personas, actions), "Notify");
});

test("the shared member and node helpers answer for both stage kinds", () => {
  assert.deepEqual(stageMembers(act("pr")).map((member) => member.kind), ["session_action"]);
  assert.deepEqual(
    stageMembers(parallel("gate", ["intent", "security"])).map((member) => member.kind),
    ["persona", "persona"],
  );
  assert.deepEqual(stageNodeIds(act("pr")), ["pr"]);
  // Members first, then the join - so a caller collecting declared identities gets all of them.
  assert.deepEqual(stageNodeIds(parallel("gate", ["intent", "security"])), ["intent", "security", "gate"]);
  assert.deepEqual(stageNodeIds(solo("intent")), ["intent"]);
  assert.equal(stageMemberKey({ nodeId: null, kind: "session_action", sessionActionId: "pr" }), "session_action:pr");
  assert.equal(stageMemberKey({ nodeId: null, kind: "check", slot: "test" }), "check:test");
  assert.equal(stageMemberKey({ nodeId: null, kind: "persona", personaId: "pr" }), "persona:pr");
});
