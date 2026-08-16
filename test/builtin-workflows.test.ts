import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_MISTAKES_REVIEW_WORKFLOW_ID,
  NO_MISTAKES_REVIEW_WORKFLOW_SLUG,
} from "../src/shared/builtin-workflow.ts";
import {
  DEFAULT_WORKFLOW_CONFIG,
  DEFAULT_WORKFLOW_BINDING_DEFAULTS,
  normalizeWorkflowName,
  personaSnapshotIsOutdated,
} from "../src/shared/workflow.ts";
import type {
  PublishedWorkflowGraph,
  WorkflowDraftGraph,
  WorkflowDraftNode,
} from "../src/shared/workflow.ts";
import { validateWorkflowGraph } from "../src/shared/workflow-graph.ts";
import { compileStages, projectStages, stageBlockers } from "../src/shared/workflow-stages.ts";
import type { EvaluationStage, Stage } from "../src/shared/workflow-stages.ts";
import { WORKFLOW_CHECK_SLOTS } from "../src/shared/workflow.ts";
import { BUILTIN_PERSONAS } from "../src/server/workflows/builtin-personas.ts";
import { BUILTIN_SESSION_ACTIONS } from "../src/server/workflows/builtin-session-actions.ts";
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
    nodes: graph.nodes.map((node): WorkflowDraftNode => {
      if (node.kind === "persona") {
        return { id: node.id, kind: "persona", personaId: node.persona.sourcePersonaId, position: node.position };
      }
      if (node.kind === "session_action") {
        return {
          id: node.id,
          kind: "session_action",
          sessionActionId: node.action.sourceSessionActionId,
          position: node.position,
        };
      }
      return node;
    }),
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
    assert.equal(
      definition.draftRevision,
      versions[versions.length - 1]!.sourceDraftRevision,
      "the draft revision matches the newest version's source draft",
    );
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
    });
    assert.equal(definition.currentVersionId, versions[versions.length - 1]!.id);
    assert.deepEqual(
      definition.completionPolicy,
      versions[versions.length - 1]!.completionPolicy,
      "the definition exposes the newest version's completion policy",
    );
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

const noMistakesReview = () => {
  const builtin = BUILTIN_WORKFLOWS.find(
    (candidate) => candidate.definition.id === NO_MISTAKES_REVIEW_WORKFLOW_ID,
  );
  assert.ok(builtin, "the shipped slug is append-only; Phase 3 must not rename it");
  return builtin;
};

test("new tasks default to the newest immutable No-Mistakes Review version", () => {
  const builtin = noMistakesReview();
  assert.equal(DEFAULT_WORKFLOW_CONFIG.defaultWorkflowId, builtin.definition.id);
  assert.equal(builtin.definition.id, builtinWorkflowId(NO_MISTAKES_REVIEW_WORKFLOW_SLUG));
  assert.equal(
    builtin.definition.currentVersionId,
    builtinWorkflowVersionId(NO_MISTAKES_REVIEW_WORKFLOW_SLUG, 10),
  );
  assert.equal(
    builtin.definition.currentVersionId,
    builtin.versions.at(-1)!.id,
    "the stable task default must resolve through the definition's newest immutable version",
  );
});

/**
 * Narrows a stage to an evaluation wave rather than casting, so a stage that changed kind is
 * an assertion failure at the line that assumed otherwise instead of a confusing shape later.
 * Version 8 is the first shipped version to carry a stage that is NOT one - see `shapeOf`.
 */
const evaluation = (stage: Stage | undefined): EvaluationStage => {
  assert.ok(stage && stage.kind === "evaluation", "expected an evaluation wave");
  return stage;
};

/**
 * The members of each stage, named by Persona id, by slot, or by the action a singleton stage
 * runs, so a mixed pipeline reads as one list.
 *
 * The action arm is what stops a session action stage being INVISIBLE here: mapping only
 * evaluation members would have printed the same shape for version 3 and version 8, and the
 * whole difference between them is the stage this arm names.
 */
const shapeOf = (graph: WorkflowDraftGraph) => {
  const pipeline = projectStages(graph);
  assert.ok(pipeline, "a shipped version must render in the Pipeline editor");
  return pipeline.stages.map((stage) =>
    stage.kind === "session_action"
      ? [`action:${stage.member.sessionActionId}`]
      : stage.members.map((member) =>
        member.kind === "persona" ? member.personaId : `check:${member.slot}`));
};

test("No-Mistakes Review ships the adopted graph, defaults and local completion", () => {
  const builtin = noMistakesReview();
  assert.equal(builtin.definition.name, "No-Mistakes Review");
  assert.equal(builtin.versions.length, 10);
  assert.deepEqual(builtin.versions[0]!.bindingDefaults, {
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
  });
  for (const historical of builtin.versions.slice(1, 5)) {
    assert.deepEqual(historical.bindingDefaults, {
      triggerMode: "manual",
      deliveryMode: "live",
      maxRepairRounds: 5,
    });
  }
  for (const recent of builtin.versions.slice(5)) {
    assert.deepEqual(recent.bindingDefaults, {
      ...DEFAULT_WORKFLOW_BINDING_DEFAULTS,
      deliveryMode: "live",
    });
  }
  assert.deepEqual(builtin.definition.bindingDefaults, builtin.versions.at(-1)!.bindingDefaults);
  assert.deepEqual(builtin.definition.completionPolicy, { kind: "none" });

  // Version 1's shape, read from version 1 rather than from the draft: the draft is now
  // version 3, and a test that kept reading it would silently stop checking v1 the moment a
  // new version appended - which is exactly the regression this phase can produce.
  const v1 = asDraft(builtin.versions[0]!.graph);
  const pipeline = projectStages(v1);
  assert.ok(pipeline);
  assert.equal(pipeline.endOutcome, "Complete");
  assert.deepEqual(
    shapeOf(v1),
    [
      ["builtin:intent-conformance-judge"],
      [
        "builtin:code-risk-reviewer",
        "builtin:test-evidence-auditor",
        "builtin:documentation-steward",
      ],
    ],
  );
  assert.equal(evaluation(pipeline.stages[0]).joinId, null, "one reviewer needs no join");
  assert.notEqual(evaluation(pipeline.stages[1]).joinId, null, "the parallel stage aggregates at a join");

  // The adopted edge table, spelled out: every fail returns to Session, both outcomes of each
  // parallel reviewer reach the join, and only the join's pass reaches End.
  const draft = v1;
  const session = pipeline.sessionId;
  const join = evaluation(pipeline.stages[1]).joinId!;
  const route = (source: string, port: string) =>
    draft.edges.filter((edge) => edge.source === source && edge.sourcePort === port)
      .map((edge) => `${edge.target}:${edge.targetPort}`).sort();
  const intent = evaluation(pipeline.stages[0]).members[0]!.nodeId!;
  assert.deepEqual(route(session, "submitted"), [`${intent}:activate`]);
  assert.deepEqual(route(intent, "fail"), [`${session}:return_for_changes`]);
  assert.deepEqual(
    route(intent, "pass"),
    evaluation(pipeline.stages[1]).members.map((member) => `${member.nodeId}:activate`).sort(),
  );
  for (const member of evaluation(pipeline.stages[1]).members) {
    assert.deepEqual(route(member.nodeId!, "pass"), [`${join}:result`]);
    assert.deepEqual(route(member.nodeId!, "fail"), [`${join}:result`]);
  }
  assert.deepEqual(route(join, "fail"), [`${session}:return_for_changes`]);
  assert.deepEqual(route(join, "pass"), [`${pipeline.endId}:terminal`]);
});

// ---- Version 1 is history, and history does not get rewritten ----
//
// This is the single most important compatibility fact in the phase that added the check gate.
// Bindings and runs store `builtin-workflow:no-mistakes-review@1` durably, and the graph they
// resolve has to be the graph they were bound to. Asserting it against a LITERAL rather than
// against the builder is the point: a future edit to the current pipeline, or to
// `compileStages`' layout, would otherwise rewrite version 1 underneath every existing
// binding and every test here would still pass.

const NO_MISTAKES_REVIEW_V1_NODES = [
  ["nmr-session", "session", 60, 60],
  ["nmr-intent-conformance", "persona", 340, 60],
  ["nmr-code-risk", "persona", 620, 60],
  ["nmr-test-evidence", "persona", 620, 230],
  ["nmr-documentation", "persona", 620, 400],
  ["nmr-depth-join", "all_pass", 900, 230],
  ["nmr-end", "end", 1180, 60],
];

const NO_MISTAKES_REVIEW_V1_EDGES = [
  "nmr-session~submitted~nmr-intent-conformance~activate",
  "nmr-intent-conformance~fail~nmr-session~return_for_changes",
  "nmr-intent-conformance~pass~nmr-code-risk~activate",
  "nmr-intent-conformance~pass~nmr-test-evidence~activate",
  "nmr-intent-conformance~pass~nmr-documentation~activate",
  "nmr-code-risk~pass~nmr-depth-join~result",
  "nmr-code-risk~fail~nmr-depth-join~result",
  "nmr-test-evidence~pass~nmr-depth-join~result",
  "nmr-test-evidence~fail~nmr-depth-join~result",
  "nmr-documentation~pass~nmr-depth-join~result",
  "nmr-documentation~fail~nmr-depth-join~result",
  "nmr-depth-join~fail~nmr-session~return_for_changes",
  "nmr-depth-join~pass~nmr-end~terminal",
];

test("version 1 of No-Mistakes Review is frozen, asserted against a literal", () => {
  const version = noMistakesReview().versions[0]!;
  assert.equal(version.id, builtinWorkflowVersionId("no-mistakes-review", 1));
  assert.equal(version.version, 1);
  assert.equal(version.sourceDraftRevision, 1);
  assert.deepEqual(
    version.graph.nodes.map((node) => [node.id, node.kind, node.position.x, node.position.y]),
    NO_MISTAKES_REVIEW_V1_NODES,
  );
  assert.deepEqual(version.graph.edges.map((edge) => edge.id), NO_MISTAKES_REVIEW_V1_EDGES);
  // No check node reached version 1. Adding the gates was an APPEND, and a version 1 that
  // grew them would be a graph an existing binding never agreed to run commands under.
  assert.equal(version.graph.nodes.filter((node) => node.kind === "check").length, 0);
  assert.deepEqual(shapeOf(asDraft(version.graph)), [
    ["builtin:intent-conformance-judge"],
    [
      "builtin:code-risk-reviewer",
      "builtin:test-evidence-auditor",
      "builtin:documentation-steward",
    ],
  ]);
});

test("version 5 adds automatic PR preparation after the Inspector-only repair policy", () => {
  const builtin = noMistakesReview();
  assert.equal(builtin.versions.length, 10, "one workflow, ten versions");
  for (const priorVersion of builtin.versions.slice(0, 3)) {
    assert.deepEqual(priorVersion.completionPolicy, {
      kind: "inspector",
      onFindings: "restart_workflow",
      missingPrAction: "offer_prepare_pr",
    });
  }
  const prior = builtin.versions[1]!;
  assert.equal(prior.sourceDraftRevision, 1);
  assert.equal(prior.graph.nodes.filter((node) => node.kind === "check").length, 0);
  assert.deepEqual(prior.graph, builtin.versions[0]!.graph);

  const version = builtin.versions[2]!;
  assert.equal(version.sourceDraftRevision, 2);

  // The adopted stage order: the cheap deterministic gate, the cheap intent gate, the fan-out.
  // Both checks sit in ONE stage, so `compileStages` mints a join and both must pass before a
  // single model call is spent - which is the whole reason this version exists.
  const draft = asDraft(version.graph);
  assert.deepEqual(shapeOf(draft), [
    ["check:typecheck", "check:test"],
    ["builtin:intent-conformance-judge"],
    [
      "builtin:code-risk-reviewer",
      "builtin:test-evidence-auditor",
      "builtin:documentation-steward",
    ],
  ]);
  const pipeline = projectStages(draft)!;
  assert.notEqual(evaluation(pipeline.stages[0]).joinId, null, "two checks aggregate at an all-pass join");
  assert.equal(pipeline.endOutcome, "Complete");

  // Every slot named is one this build ships. A version naming a slot the vocabulary does not
  // carry is a gate that can never be configured and silently always skips.
  const slots = version.graph.nodes.flatMap((node) => node.kind === "check" ? [node.slot] : []);
  assert.deepEqual(slots, ["typecheck", "test"]);
  for (const slot of slots) assert.ok(WORKFLOW_CHECK_SLOTS.includes(slot), `${slot} is not a shipped slot`);

  // A check node carries its slot and NOTHING else. An argv baked into a shipped version
  // would be executable content reaching every install through the version export route, and
  // it would be wrong on every repository that is not the one it was written in - the
  // operator describes the machine, the version describes the gate.
  for (const node of version.graph.nodes) {
    if (node.kind !== "check") continue;
    assert.deepEqual(
      Object.keys(node).sort(),
      ["id", "kind", "position", "slot"],
      "a check node carries no command",
    );
  }

  // The reviewers kept their identities across the version bump, so an attempt row written
  // against a prior version's Intent Conformance still names the same node in version 3.
  for (const id of ["nmr-intent-conformance", "nmr-code-risk", "nmr-test-evidence", "nmr-documentation"]) {
    assert.ok(version.graph.nodes.some((node) => node.id === id), `${id} was re-identified`);
  }
  const inspectorOnly = builtin.versions[3]!;
  assert.equal(inspectorOnly.sourceDraftRevision, 3);
  assert.deepEqual(inspectorOnly.graph, version.graph, "policy changes append without rewriting v3");
  assert.deepEqual(inspectorOnly.completionPolicy, {
    kind: "inspector",
    onFindings: "inspector_only",
    missingPrAction: "offer_prepare_pr",
  });
  const current = builtin.versions[4]!;
  assert.equal(current.sourceDraftRevision, 4);
  assert.deepEqual(current.graph, inspectorOnly.graph, "v5 changes policy without rewriting v4");
  assert.deepEqual(current.completionPolicy, {
    kind: "inspector",
    onFindings: "inspector_only",
    missingPrAction: "prepare_pr",
  });
  // And the draft the library opens is the NEWEST version, whichever that has become, still
  // round-tripping through the Pipeline compiler without reminting an identity.
  assert.deepEqual(builtin.definition.draft.edges, builtin.versions.at(-1)!.graph.edges);
  assert.deepEqual(
    compileStages(projectStages(builtin.definition.draft)!, builtin.definition.draft),
    builtin.definition.draft,
  );
});

test("version 6 defaults submission to Foreman complete without rewriting history", () => {
  const builtin = noMistakesReview();
  for (const historical of builtin.versions.slice(0, 5)) {
    assert.equal(historical.bindingDefaults.triggerMode, "manual");
  }
  const previous = builtin.versions[4]!;
  const current = builtin.versions[5]!;
  assert.equal(current.sourceDraftRevision, 5);
  assert.deepEqual(current.graph, previous.graph, "v6 changes defaults without rewriting v5");
  assert.deepEqual(current.completionPolicy, previous.completionPolicy);
  assert.deepEqual(current.bindingDefaults, {
    triggerMode: "foreman_complete",
    deliveryMode: "live",
    maxRepairRounds: 5,
  });
});

test("version 7 turns on engine-owned resumption and leaves every prior version manual", () => {
  const builtin = noMistakesReview();
  // The whole point of appending rather than editing: a binding pinned to any earlier version
  // keeps the posture it was published with, so upgrading this build cannot start resubmitting
  // runs on somebody's machine.
  for (const historical of builtin.versions.slice(0, 6)) {
    assert.equal(historical.resumptionPolicy, "manual");
  }
  const previous = builtin.versions[5]!;
  const version7 = builtin.versions[6]!;
  assert.equal(version7.id, builtinWorkflowVersionId("no-mistakes-review", 7));
  assert.equal(version7.sourceDraftRevision, 6);
  assert.equal(version7.resumptionPolicy, "auto");
  assert.deepEqual(version7.graph, previous.graph, "v7 changes policy without rewriting v6");
  assert.deepEqual(version7.completionPolicy, {
    kind: "inspector",
    onFindings: "inspector_only",
    missingPrAction: "prepare_pr",
  });
  assert.deepEqual(version7.bindingDefaults, {
    triggerMode: "foreman_complete",
    deliveryMode: "live",
    maxRepairRounds: 5,
  });
  assert.equal(builtin.definition.resumptionPolicy, "auto");
});

// ---- Version 8: the pull request becomes an authored stage ----
//
// The literal node and edge tables below are the same device version 1's are: asserted against
// a written-out list rather than against the builder, so an edit to `compileStages`' layout or
// to a later pipeline cannot rewrite this version underneath a binding already pinned to it.

const NO_MISTAKES_V8_NODES = [
  ["nmr-session", "session", 60, 60],
  ["nmr-check-typecheck", "check", 340, 60],
  ["nmr-check-test", "check", 340, 230],
  ["nmr-build-join", "all_pass", 620, 145],
  ["nmr-intent-conformance", "persona", 900, 60],
  ["nmr-code-risk", "persona", 1180, 60],
  ["nmr-test-evidence", "persona", 1180, 230],
  ["nmr-documentation", "persona", 1180, 400],
  ["nmr-depth-join", "all_pass", 1460, 230],
  ["nmr-pull-request", "session_action", 1740, 60],
  ["nmr-end", "end", 2020, 60],
];

test("version 8 opens the pull request as a stage, and waits rather than preparing one", () => {
  const builtin = noMistakesReview();
  const version = builtin.versions[7]!;
  assert.equal(version.id, builtinWorkflowVersionId("no-mistakes-review", 8));
  assert.equal(version.version, 8);
  assert.equal(version.sourceDraftRevision, 7);
  assert.deepEqual(
    version.graph.nodes.map((node) => [node.id, node.kind, node.position.x, node.position.y]),
    NO_MISTAKES_V8_NODES,
  );

  // The action is LAST among the authored stages, and its complete route reaches End. That
  // ordering is the version's whole claim: End cannot be reached without a proven pull request.
  assert.deepEqual(shapeOf(asDraft(version.graph)), [
    ["check:typecheck", "check:test"],
    ["builtin:intent-conformance-judge"],
    [
      "builtin:code-risk-reviewer",
      "builtin:test-evidence-auditor",
      "builtin:documentation-steward",
    ],
    ["action:builtin:pull-request"],
  ]);
  const complete = version.graph.edges.filter((edge) => edge.source === "nmr-pull-request");
  assert.deepEqual(complete.map((edge) => [edge.sourcePort, edge.target, edge.targetPort]), [
    ["complete", "nmr-end", "terminal"],
  ]);
  // And nothing else reaches End: the depth join's pass now activates the action instead.
  assert.deepEqual(
    version.graph.edges.filter((edge) => edge.target === "nmr-end").map((edge) => edge.source),
    ["nmr-pull-request"],
  );
  assert.deepEqual(
    version.graph.edges
      .filter((edge) => edge.source === "nmr-depth-join" && edge.sourcePort === "pass")
      .map((edge) => `${edge.target}:${edge.targetPort}`),
    ["nmr-pull-request:activate"],
  );

  // The snapshot is the shipped built-in's, frozen into the version rather than resolved at
  // run time - which is what stops an edit to the shipped Markdown changing an in-flight run.
  const node = version.graph.nodes.find((candidate) => candidate.id === "nmr-pull-request");
  assert.ok(node && node.kind === "session_action");
  const shipped = BUILTIN_SESSION_ACTIONS.find((item) => item.id === "builtin:pull-request")!;
  assert.equal(node.action.sourceSessionActionId, "builtin:pull-request");
  assert.equal(node.action.sourceRevision, shipped.revision);
  assert.equal(node.action.promptMarkdown, shipped.promptMarkdown);
  assert.equal(node.action.requiredSkillId, "pull-request");
  assert.deepEqual(node.action.completion, { kind: "pull_request" });

  // `wait`, not `prepare_pr`. The graph cannot reach End without a pull request, so a gate
  // that found none has met a state its own preparation would not fix, and typing a second
  // handoff would ask for a pull request the run already has.
  assert.deepEqual(version.completionPolicy, {
    kind: "inspector",
    onFindings: "inspector_only",
    missingPrAction: "wait",
  });
  assert.equal(version.resumptionPolicy, "auto");
  assert.deepEqual(version.bindingDefaults, builtin.versions[6]!.bindingDefaults);
  assert.deepEqual(builtin.definition.bindingDefaults, version.bindingDefaults);
});

test("appending version 8 rewrote no earlier version", () => {
  // The compatibility assertion the whole phase turns on, stated once against every prior
  // version at once: none of them grew the action node, and each keeps the missing-PR posture
  // it was published with.
  const builtin = noMistakesReview();
  for (const [index, version] of builtin.versions.slice(0, 7).entries()) {
    assert.equal(
      version.graph.nodes.some((node) => node.kind === "session_action"),
      false,
      `version ${index + 1} must carry no session action node`,
    );
    assert.equal(
      version.completionPolicy.kind === "inspector" && version.completionPolicy.missingPrAction,
      index < 4 ? "offer_prepare_pr" : "prepare_pr",
      `version ${index + 1} must keep the missing-PR policy it was published with`,
    );
  }
});

// ---- Version 9: local Code Quality Judge before verified publication ----

const NO_MISTAKES_V9_NODES = [
  ["nmr-session", "session", 60, 60],
  ["nmr-check-typecheck", "check", 340, 60],
  ["nmr-check-test", "check", 340, 230],
  ["nmr-build-join", "all_pass", 620, 145],
  ["nmr-intent-conformance", "persona", 900, 60],
  ["nmr-code-risk", "persona", 1180, 60],
  ["nmr-test-evidence", "persona", 1180, 230],
  ["nmr-documentation", "persona", 1180, 400],
  ["nmr-depth-join", "all_pass", 1460, 230],
  ["nmr-code-quality-judge", "persona", 1740, 60],
  ["nmr-pull-request", "session_action", 2020, 60],
  ["nmr-end", "end", 2300, 60],
];

test("version 9 judges code quality before the verified PR action and completes locally", () => {
  const builtin = noMistakesReview();
  const version = builtin.versions[8]!;
  assert.equal(version.id, builtinWorkflowVersionId("no-mistakes-review", 9));
  assert.equal(version.version, 9);
  assert.equal(version.sourceDraftRevision, 8);
  assert.deepEqual(
    version.graph.nodes.map((node) => [node.id, node.kind, node.position.x, node.position.y]),
    NO_MISTAKES_V9_NODES,
  );
  assert.deepEqual(shapeOf(asDraft(version.graph)), [
    ["check:typecheck", "check:test"],
    ["builtin:intent-conformance-judge"],
    [
      "builtin:code-risk-reviewer",
      "builtin:test-evidence-auditor",
      "builtin:documentation-steward",
    ],
    ["builtin:code-quality-judge"],
    ["action:builtin:pull-request"],
  ]);

  const quality = version.graph.nodes.find((node) => node.id === "nmr-code-quality-judge");
  assert.ok(quality && quality.kind === "persona");
  const shippedQuality = BUILTIN_PERSONAS.find((item) => item.id === "builtin:code-quality-judge")!;
  assert.equal(quality.persona.sourcePersonaId, shippedQuality.id);
  assert.equal(quality.persona.guidanceMarkdown, shippedQuality.guidanceMarkdown);

  const pullRequest = version.graph.nodes.find((node) => node.id === "nmr-pull-request");
  assert.ok(pullRequest && pullRequest.kind === "session_action");
  const shippedAction = BUILTIN_SESSION_ACTIONS.find((item) => item.id === "builtin:pull-request")!;
  assert.equal(pullRequest.action.promptMarkdown, shippedAction.promptMarkdown);
  assert.deepEqual(pullRequest.action.completion, { kind: "pull_request" });

  const route = (source: string, port: string) => version.graph.edges
    .filter((edge) => edge.source === source && edge.sourcePort === port)
    .map((edge) => `${edge.target}:${edge.targetPort}`);
  assert.deepEqual(route("nmr-depth-join", "pass"), ["nmr-code-quality-judge:activate"]);
  assert.deepEqual(route("nmr-code-quality-judge", "fail"), ["nmr-session:return_for_changes"]);
  assert.deepEqual(route("nmr-code-quality-judge", "pass"), ["nmr-pull-request:activate"]);
  assert.deepEqual(route("nmr-pull-request", "complete"), ["nmr-end:terminal"]);

  assert.deepEqual(version.completionPolicy, { kind: "none" });
  assert.equal(version.resumptionPolicy, "auto");
  assert.deepEqual(version.bindingDefaults, builtin.versions[7]!.bindingDefaults);
  assert.deepEqual(builtin.definition.completionPolicy, { kind: "none" });
});

test("appending version 9 rewrote no earlier version", () => {
  const builtin = noMistakesReview();
  assert.equal(builtin.versions.length, 10);
  for (const [index, version] of builtin.versions.slice(0, 8).entries()) {
    assert.equal(
      version.graph.nodes.some((node) => node.id === "nmr-code-quality-judge"),
      false,
      `version ${index + 1} grew Code Quality Judge`,
    );
    assert.equal(version.completionPolicy.kind, "inspector", `version ${index + 1} lost its gate`);
  }
  assert.deepEqual(
    builtin.versions[7]!.graph.nodes.map((node) => [node.id, node.kind, node.position.x, node.position.y]),
    NO_MISTAKES_V8_NODES,
  );
});

// ---- Version 10: code review together, then evidence and documentation ----

const NO_MISTAKES_V10_NODES = [
  ["nmr-session", "session", 60, 60],
  ["nmr-check-typecheck", "check", 340, 60],
  ["nmr-check-test", "check", 340, 230],
  ["nmr-build-join", "all_pass", 620, 145],
  ["nmr-intent-conformance", "persona", 900, 60],
  ["nmr-code-risk", "persona", 1180, 60],
  ["nmr-code-quality-judge", "persona", 1180, 230],
  ["nmr-depth-join", "all_pass", 1460, 145],
  ["nmr-test-evidence", "persona", 1740, 60],
  ["nmr-documentation", "persona", 1740, 230],
  ["nmr-evidence-documentation-join", "all_pass", 2020, 145],
  ["nmr-pull-request", "session_action", 2300, 60],
  ["nmr-end", "end", 2580, 60],
];

test("version 10 reviews code in stage 3 and evidence and documentation in stage 4", () => {
  const builtin = noMistakesReview();
  const version = builtin.versions[9]!;
  assert.equal(version.id, builtinWorkflowVersionId("no-mistakes-review", 10));
  assert.equal(version.version, 10);
  assert.equal(version.sourceDraftRevision, 9);
  assert.deepEqual(
    version.graph.nodes.map((node) => [node.id, node.kind, node.position.x, node.position.y]),
    NO_MISTAKES_V10_NODES,
  );
  assert.deepEqual(shapeOf(asDraft(version.graph)), [
    ["check:typecheck", "check:test"],
    ["builtin:intent-conformance-judge"],
    ["builtin:code-risk-reviewer", "builtin:code-quality-judge"],
    ["builtin:test-evidence-auditor", "builtin:documentation-steward"],
    ["action:builtin:pull-request"],
  ]);

  const route = (source: string, port: string) => version.graph.edges
    .filter((edge) => edge.source === source && edge.sourcePort === port)
    .map((edge) => `${edge.target}:${edge.targetPort}`)
    .sort();
  assert.deepEqual(route("nmr-intent-conformance", "pass"), [
    "nmr-code-quality-judge:activate",
    "nmr-code-risk:activate",
  ]);
  for (const nodeId of ["nmr-code-risk", "nmr-code-quality-judge"]) {
    assert.deepEqual(route(nodeId, "pass"), ["nmr-depth-join:result"]);
    assert.deepEqual(route(nodeId, "fail"), ["nmr-depth-join:result"]);
  }
  assert.deepEqual(route("nmr-depth-join", "fail"), ["nmr-session:return_for_changes"]);
  assert.deepEqual(route("nmr-depth-join", "pass"), [
    "nmr-documentation:activate",
    "nmr-test-evidence:activate",
  ]);
  for (const nodeId of ["nmr-test-evidence", "nmr-documentation"]) {
    assert.deepEqual(route(nodeId, "pass"), ["nmr-evidence-documentation-join:result"]);
    assert.deepEqual(route(nodeId, "fail"), ["nmr-evidence-documentation-join:result"]);
  }
  assert.deepEqual(route("nmr-evidence-documentation-join", "fail"), [
    "nmr-session:return_for_changes",
  ]);
  assert.deepEqual(route("nmr-evidence-documentation-join", "pass"), [
    "nmr-pull-request:activate",
  ]);
  assert.deepEqual(route("nmr-pull-request", "complete"), ["nmr-end:terminal"]);

  assert.deepEqual(version.completionPolicy, { kind: "none" });
  assert.equal(version.resumptionPolicy, "auto");
  assert.deepEqual(version.bindingDefaults, builtin.versions[8]!.bindingDefaults);
  assert.deepEqual(builtin.definition.draft, asDraft(version.graph));
  assert.deepEqual(
    builtin.versions[8]!.graph.nodes.map((node) => [node.id, node.kind, node.position.x, node.position.y]),
    NO_MISTAKES_V9_NODES,
    "appending v10 must not rewrite v9",
  );
});
