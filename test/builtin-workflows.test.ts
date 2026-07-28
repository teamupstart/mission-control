import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WORKFLOW_BINDING_DEFAULTS,
  normalizeWorkflowName,
  personaSnapshotIsOutdated,
} from "../src/shared/workflow.ts";
import type { PublishedWorkflowGraph, WorkflowDraftGraph } from "../src/shared/workflow.ts";
import { validateWorkflowGraph } from "../src/shared/workflow-graph.ts";
import { compileStages, projectStages, stageBlockers } from "../src/shared/workflow-stages.ts";
import { BUILTIN_PERSONAS } from "../src/server/workflows/builtin-personas.ts";
import {
  BUILTIN_WORKFLOWS,
  BUILTIN_WORKFLOW_ID_PREFIX,
  builtinWorkflowId,
  builtinWorkflowVersionId,
} from "../src/server/workflows/builtin-workflows.ts";

// What is at stake: the catalog is a promise that a fresh install has a WORKING review
// workflow, so every claim it makes has to be true of the shipped data rather than of the
// code that assembles it. A graph that fails validation is a flagship nobody can publish or
// bind. A graph that is not stage-expressible drops the flagship into Graph view, which is
// the surface the Pipeline editor exists to replace. A node or edge identity minted at module
// load orphans every attempt and receipt written before the last restart, because those
// columns are durable. And a version list that is not append-only strands the bindings an
// operator already holds the first time this workflow improves.

/** A published graph, read back as the draft it was published from. */
function asDraft(graph: PublishedWorkflowGraph): WorkflowDraftGraph {
  return {
    nodes: graph.nodes.map((node) => node.kind === "persona"
      ? { id: node.id, kind: "persona" as const, personaId: node.persona.sourcePersonaId, position: node.position }
      : node),
    edges: [...graph.edges],
  };
}

test("the shipped graph validates clean against the real built-in Persona catalog", () => {
  assert.ok(BUILTIN_WORKFLOWS.length > 0);
  for (const builtin of BUILTIN_WORKFLOWS) {
    for (const version of builtin.versions) {
      const result = validateWorkflowGraph({
        graph: asDraft(version.graph),
        personas: BUILTIN_PERSONAS,
        completionPolicy: version.completionPolicy,
      });
      assert.deepEqual(result.diagnostics, [], `${version.id} is not a publishable graph`);
      assert.equal(result.valid, true);
    }
    const draft = validateWorkflowGraph({
      graph: builtin.definition.draft,
      personas: BUILTIN_PERSONAS,
      completionPolicy: builtin.definition.completionPolicy,
    });
    assert.deepEqual(draft.diagnostics, [], `${builtin.definition.id}'s draft is not publishable`);
  }
});

test("every shipped version renders in the Pipeline editor and round-trips to itself", () => {
  for (const builtin of BUILTIN_WORKFLOWS) {
    // Two claims, and they are not the same one: `stageBlockers` says WHY the Pipeline cannot
    // draw a graph, and the compiler says the graph the editor would write back is the graph
    // that shipped. A shipped workflow that projected but did not round-trip would silently
    // rewrite its own durable node ids the first time somebody opened it.
    assert.deepEqual(
      stageBlockers(builtin.definition.draft, BUILTIN_PERSONAS),
      [],
      `${builtin.definition.id} would open in Graph view`,
    );
    const pipeline = projectStages(builtin.definition.draft);
    assert.notEqual(pipeline, null);
    assert.deepEqual(
      compileStages(pipeline!, builtin.definition.draft),
      builtin.definition.draft,
    );
  }
});

test("every node and route identity is derived, never minted", () => {
  // A UUID here would be a fresh id on every daemon start, and `workflow_node_attempts.node_id`
  // plus `workflow_receipts.edge_id` are durable columns: the run in flight across a restart
  // would stop recognising its own receipts.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const builtin of BUILTIN_WORKFLOWS) {
    const graphs = [builtin.definition.draft, ...builtin.versions.map((version) => version.graph)];
    for (const graph of graphs) {
      for (const node of graph.nodes) assert.doesNotMatch(node.id, uuid);
      for (const edge of graph.edges) {
        assert.doesNotMatch(edge.id, uuid);
        assert.equal(
          edge.id,
          `${edge.source}~${edge.sourcePort}~${edge.target}~${edge.targetPort}`,
        );
      }
    }
  }
});

test("every Persona node names a shipped Persona and carries this build's guidance", () => {
  const shipped = new Map(BUILTIN_PERSONAS.map((persona) => [persona.id, persona]));
  for (const builtin of BUILTIN_WORKFLOWS) {
    for (const node of builtin.definition.draft.nodes) {
      if (node.kind !== "persona") continue;
      assert.ok(shipped.has(node.personaId), `${node.personaId} is not a shipped Persona`);
    }
    for (const version of builtin.versions) {
      const personaNodes = version.graph.nodes.filter((node) => node.kind === "persona");
      assert.ok(personaNodes.length > 0);
      for (const node of personaNodes) {
        if (node.kind !== "persona") continue;
        const current = shipped.get(node.persona.sourcePersonaId);
        assert.ok(current, `${node.persona.sourcePersonaId} is not a shipped Persona`);
        assert.equal(node.persona.guidanceMarkdown, current.guidanceMarkdown);
        // The point of the line above: a shipped workflow must never open reporting its own
        // shipped Personas as outdated.
        assert.equal(personaSnapshotIsOutdated(node.persona, current), false);
      }
    }
  }
});

test("ids are prefixed, versions ascend, and the definition names the newest", () => {
  for (const builtin of BUILTIN_WORKFLOWS) {
    const { definition, versions } = builtin;
    assert.equal(definition.builtin, true);
    assert.equal(definition.archivedAt, null);
    assert.equal(definition.draftRevision, 1);
    assert.equal(definition.createdAt, 0);
    assert.equal(definition.updatedAt, 0);
    assert.equal(definition.normalizedName, normalizeWorkflowName(definition.name));
    assert.ok(definition.id.startsWith(BUILTIN_WORKFLOW_ID_PREFIX));
    // The prefix differs from the Persona catalog's, so a lookup that reached for the wrong
    // catalog finds nothing rather than finding a Persona where a workflow was meant.
    assert.ok(!definition.id.startsWith("builtin:"));

    const slug = definition.id.slice(BUILTIN_WORKFLOW_ID_PREFIX.length);
    assert.equal(builtinWorkflowId(slug), definition.id);
    assert.ok(versions.length > 0);
    versions.forEach((version, index) => {
      assert.equal(version.version, index + 1, "versions must ascend from 1 with no gaps");
      assert.equal(version.id, builtinWorkflowVersionId(slug, index + 1));
      assert.equal(version.workflowId, definition.id);
      assert.equal(version.publishedAt, 0);
      assert.deepEqual(version.completionPolicy, definition.completionPolicy);
    });
    assert.equal(definition.currentVersionId, versions[versions.length - 1]!.id);
    assert.deepEqual(definition.bindingDefaults, versions[versions.length - 1]!.bindingDefaults);
    // The draft is the newest version's graph with the snapshots taken back off, so opening
    // the built-in shows what a binding to its current version would run.
    assert.deepEqual(
      definition.draft.edges,
      versions[versions.length - 1]!.graph.edges,
    );
  }
  const ids = BUILTIN_WORKFLOWS.map((builtin) => builtin.definition.id);
  assert.equal(new Set(ids).size, ids.length);
  const names = BUILTIN_WORKFLOWS.map((builtin) => builtin.definition.normalizedName);
  assert.equal(new Set(names).size, names.length);
});

test("No-Mistakes Review ships the adopted graph, defaults and final gate", () => {
  const builtin = BUILTIN_WORKFLOWS.find(
    (candidate) => candidate.definition.id === builtinWorkflowId("no-mistakes-review"),
  );
  assert.ok(builtin, "the shipped slug is append-only; Phase 3 must not rename it");
  assert.equal(builtin.definition.name, "No-Mistakes Review");
  assert.equal(builtin.versions.length, 2);
  assert.deepEqual(builtin.versions[0]!.bindingDefaults, DEFAULT_WORKFLOW_BINDING_DEFAULTS);
  assert.deepEqual(builtin.versions[1]!.bindingDefaults, {
    ...DEFAULT_WORKFLOW_BINDING_DEFAULTS,
    deliveryMode: "live",
  });
  assert.deepEqual(builtin.definition.bindingDefaults, builtin.versions[1]!.bindingDefaults);
  assert.deepEqual(builtin.definition.completionPolicy, {
    kind: "inspector",
    onFindings: "restart_workflow",
    missingPrAction: "offer_prepare_pr",
  });

  // Intent first as the cheap gate, then the other three in parallel behind it. Asserted as
  // the stage projection rather than as coordinates, because the shape is the adopted
  // decision and the coordinates are `compileStages`' business.
  const pipeline = projectStages(builtin.definition.draft);
  assert.ok(pipeline);
  assert.equal(pipeline.endOutcome, "Complete");
  assert.deepEqual(
    pipeline.stages.map((stage) => stage.members.map((member) => member.personaId)),
    [
      ["builtin:intent-conformance-judge"],
      [
        "builtin:code-risk-reviewer",
        "builtin:test-evidence-auditor",
        "builtin:documentation-steward",
      ],
    ],
  );
  assert.equal(pipeline.stages[0]!.joinId, null, "one reviewer needs no join");
  assert.notEqual(pipeline.stages[1]!.joinId, null, "the parallel stage aggregates at a join");

  // The adopted edge table, spelled out: every fail returns to Session, both outcomes of each
  // parallel reviewer reach the join, and only the join's pass reaches End.
  const draft = builtin.definition.draft;
  const session = pipeline.sessionId;
  const join = pipeline.stages[1]!.joinId!;
  const route = (source: string, port: string) =>
    draft.edges.filter((edge) => edge.source === source && edge.sourcePort === port)
      .map((edge) => `${edge.target}:${edge.targetPort}`).sort();
  const intent = pipeline.stages[0]!.members[0]!.nodeId!;
  assert.deepEqual(route(session, "submitted"), [`${intent}:activate`]);
  assert.deepEqual(route(intent, "fail"), [`${session}:return_for_changes`]);
  assert.deepEqual(
    route(intent, "pass"),
    pipeline.stages[1]!.members.map((member) => `${member.nodeId}:activate`).sort(),
  );
  for (const member of pipeline.stages[1]!.members) {
    assert.deepEqual(route(member.nodeId!, "pass"), [`${join}:result`]);
    assert.deepEqual(route(member.nodeId!, "fail"), [`${join}:result`]);
  }
  assert.deepEqual(route(join, "fail"), [`${session}:return_for_changes`]);
  assert.deepEqual(route(join, "pass"), [`${pipeline.endId}:terminal`]);
});
