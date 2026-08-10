import { test } from "node:test";
import assert from "node:assert/strict";
import type { Persona, SessionAction, WorkflowDraftGraph } from "../src/shared/workflow.ts";
import { SESSION_ACTION_COMPLETION_CAPABILITIES } from "../src/shared/workflow.ts";
import {
  WORKFLOW_NODE_CAPABILITIES,
  WORKFLOW_NODE_SOURCE_PORTS,
  WORKFLOW_NODE_TARGET_PORTS,
  connectionAllowed,
  validateWorkflowGraph,
} from "../src/shared/workflow-graph.ts";

// What is at stake: a SessionAction is the first node kind that is neither structure nor a
// judge. Every rule that used to be spelled as "persona or join or check" had to become a
// question about a node's declared capability, and the failure mode of getting one wrong is
// quiet - an action demanded to emit a `pass` it has no port for, or allowed into a Join where
// the engine would wait forever for a verdict it never produces.

const personas: Persona[] = [{
  id: "intent", name: "intent", normalizedName: "intent", description: "",
  guidanceMarkdown: "# Judge", runner: null, model: null, revision: 1,
  archivedAt: null, createdAt: 1, updatedAt: 1, provenance: null, builtin: false,
}];

const actions: SessionAction[] = [{
  id: "pr", name: "Pull Request", normalizedName: "pull request", description: "",
  promptMarkdown: "# Pull Request\n", requiredSkillId: "pull-request",
  completion: { kind: "pull_request" }, revision: 1, archivedAt: null,
  createdAt: 1, updatedAt: 1, builtin: false,
}];

/** Session -> intent reviewer -> Pull Request action -> End. */
const graph = (): WorkflowDraftGraph => ({
  nodes: [
    { id: "s", kind: "session", position: { x: 0, y: 0 } },
    { id: "intent", kind: "persona", personaId: "intent", position: { x: 200, y: 0 } },
    { id: "act", kind: "session_action", sessionActionId: "pr", position: { x: 400, y: 0 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 600, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "s", sourcePort: "submitted", target: "intent", targetPort: "activate" },
    { id: "e2", source: "intent", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
    { id: "e3", source: "intent", sourcePort: "pass", target: "act", targetPort: "activate" },
    { id: "e4", source: "act", sourcePort: "complete", target: "end", targetPort: "terminal" },
  ],
});

const validate = (candidate: WorkflowDraftGraph) =>
  validateWorkflowGraph({
    graph: candidate,
    personas,
    sessionActions: actions,
    completionPolicy: { kind: "none" },
  });

const codes = (candidate: WorkflowDraftGraph) =>
  validate(candidate).diagnostics.map((item) => item.code);

test("the capability registry states an action's ports once, and the port tables derive from it", () => {
  const capability = WORKFLOW_NODE_CAPABILITIES.session_action;
  assert.equal(capability.role, "action");
  assert.deepEqual(capability.sourcePorts, ["complete"]);
  assert.deepEqual(capability.targetPorts, ["activate"]);
  assert.deepEqual(capability.requiredSourcePorts, ["complete"]);
  assert.equal(capability.joinPredecessor, false);
  // The two exported tables are projections, so they cannot disagree with the registry.
  assert.deepEqual(WORKFLOW_NODE_SOURCE_PORTS.session_action, ["complete"]);
  assert.deepEqual(WORKFLOW_NODE_TARGET_PORTS.session_action, ["activate"]);
  // The evaluation kinds are unchanged by the generalisation.
  assert.deepEqual(WORKFLOW_NODE_SOURCE_PORTS.persona, ["pass", "fail"]);
  assert.deepEqual(WORKFLOW_NODE_TARGET_PORTS.check, ["activate"]);
});

test("an action activates, emits complete, and needs no pass or fail route", () => {
  // The whole diagnostic list, not a membership check: an action demanded to emit a `pass`
  // would show up here as a `missing_pass_route` on a node with no such port.
  const found = validate(graph()).diagnostics;
  assert.deepEqual(
    found.map((item) => item.code),
    [],
    "a well-formed action graph this build can run draws no complaint at all",
  );
});

test("an action with nowhere to send its completion is diagnosed, and named as one", () => {
  const candidate = graph();
  candidate.edges = candidate.edges.filter((edge) => edge.id !== "e4");
  const diagnostic = validate(candidate).diagnostics
    .find((item) => item.code === "missing_complete_route" && item.nodeId === "act");
  assert.ok(diagnostic, "expected missing_complete_route for the action");
  // Named as itself. The label lookup exists because a two-way ternary once said "Persona"
  // for anything that was not a Join, so a third kind was diagnosed under another's name.
  assert.match(diagnostic.message, /^Session action needs a complete route\./);
  // And it is diagnosed as MISSING a route rather than as having an unreachable node.
  assert.ok(codes(candidate).includes("no_terminal_path"));
});

test("an action emits nothing but complete, and receives nothing but activate", () => {
  for (const port of ["pass", "fail", "submitted"] as const) {
    const candidate = graph();
    candidate.edges.push({ id: "bad", source: "act", sourcePort: port, target: "end", targetPort: "terminal" });
    assert.ok(codes(candidate).includes("invalid_source_port"), `${port} must not be emitted`);
  }
  const receiving = graph();
  receiving.nodes.push({ id: "join", kind: "all_pass", position: { x: 300, y: 200 } });
  receiving.edges.push({ id: "bad", source: "join", sourcePort: "pass", target: "act", targetPort: "result" });
  assert.ok(codes(receiving).includes("invalid_target_port"));
});

test("an action can never return work to Session", () => {
  const candidate = graph();
  candidate.edges.push({
    id: "bad", source: "act", sourcePort: "complete", target: "s", targetPort: "return_for_changes",
  });
  // Delivery refusal, an uncertain write and a failed verifier are ATTEMPT states. Routing
  // completion back to Session would ask the agent to fix a change nobody requested.
  assert.ok(codes(candidate).includes("session_return_route"));
  assert.equal(
    connectionAllowed(
      { id: "act", kind: "session_action", sessionActionId: "pr", position: { x: 0, y: 0 } },
      "complete",
      { id: "s", kind: "session", position: { x: 0, y: 0 } },
      "return_for_changes",
    ),
    false,
  );
});

test("an action cannot feed a Join, and says so in one sentence rather than three", () => {
  const candidate = graph();
  candidate.nodes.push({ id: "join", kind: "all_pass", position: { x: 500, y: 100 } });
  candidate.edges = candidate.edges.filter((edge) => edge.id !== "e4");
  candidate.edges.push(
    { id: "j1", source: "act", sourcePort: "complete", target: "join", targetPort: "result" },
    { id: "j2", source: "intent", sourcePort: "pass", target: "join", targetPort: "result" },
    { id: "j3", source: "intent", sourcePort: "fail", target: "join", targetPort: "result" },
    { id: "j4", source: "join", sourcePort: "pass", target: "end", targetPort: "terminal" },
    { id: "j5", source: "join", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
  );
  const found = validate(candidate).diagnostics;
  const join = found.find((item) => item.code === "session_action_join");
  assert.ok(join, "expected the action-specific Join refusal");
  assert.match(join.message, /runs alone/);
  // And NOT the generic pass/fail complaints about ports it can never have, which would bury
  // the real reason under two sentences about routes that cannot exist.
  assert.equal(
    found.some((item) => item.code === "join_missing_outcome" && item.nodeId === "join"
      && item.message.includes("act")),
    false,
  );
  assert.equal(
    connectionAllowed(
      { id: "act", kind: "session_action", sessionActionId: "pr", position: { x: 0, y: 0 } },
      "complete",
      { id: "join", kind: "all_pass", position: { x: 0, y: 0 } },
      "result",
    ),
    false,
    "the canvas declines the drop rather than drawing an edge validation then rejects",
  );
});

test("a missing or archived action reference is conditional on the catalog being supplied", () => {
  // No catalog means a STRUCTURAL question, and inventing "no longer exists" for every action
  // node would make that question unanswerable - the same rule Persona references follow.
  const structural = validateWorkflowGraph({ graph: graph(), completionPolicy: { kind: "none" } });
  assert.equal(structural.diagnostics.some((item) => item.code === "missing_session_action"), false);

  const missing = validateWorkflowGraph({
    graph: graph(),
    personas,
    sessionActions: [],
    completionPolicy: { kind: "none" },
  });
  assert.ok(missing.diagnostics.some((item) =>
    item.code === "missing_session_action" && item.nodeId === "act"));

  const archived = validateWorkflowGraph({
    graph: graph(),
    personas,
    sessionActions: actions.map((action) => ({ ...action, archivedAt: 9 })),
    completionPolicy: { kind: "none" },
  });
  assert.ok(archived.diagnostics.some((item) =>
    item.code === "archived_session_action" && item.nodeId === "act"));
});

test("an action participates in reachability and cycle rules like any other node", () => {
  const orphan = graph();
  orphan.edges = orphan.edges.filter((edge) => edge.id !== "e3");
  orphan.edges.push({ id: "e3b", source: "intent", sourcePort: "pass", target: "end", targetPort: "terminal" });
  assert.ok(codes(orphan).includes("unreachable_node"));

  // A loop back through the reviewer is LEGAL, because the reviewer's fail route puts
  // Session inside that cycle - which is the rule, and it does not change for an action.
  const throughSession = graph();
  throughSession.edges = throughSession.edges.filter((edge) => edge.id !== "e4");
  throughSession.edges.push({
    id: "loop", source: "act", sourcePort: "complete", target: "intent", targetPort: "activate",
  });
  assert.equal(codes(throughSession).includes("cycle_without_session"), false);

  // A completion routed back into the action itself is not.
  const selfLoop = graph();
  selfLoop.edges = selfLoop.edges.filter((edge) => edge.id !== "e4");
  selfLoop.edges.push({
    id: "loop", source: "act", sourcePort: "complete", target: "act", targetPort: "activate",
  });
  assert.ok(codes(selfLoop).includes("cycle_without_session"));
});

test("the publish gate is per ADAPTER, and says why on the node", () => {
  // The gate asks about the PROOF an action selected, not about the runtime as a whole, and
  // one boolean could not have expressed that. It stays a DIAGNOSTIC rather than a store-only
  // refusal so the Publish control is disabled where the operator can read the reason, instead
  // of becoming a 409 on a button that looked enabled.
  //
  // Both shipped adapters run now, so the unavailable half is stated through the injected
  // capability map rather than through whichever adapter happens to be unfinished. That is
  // deliberate: the gate has to keep working for the NEXT completion kind, which arrives
  // registered - so a version naming it stays readable - and refused.
  assert.equal(SESSION_ACTION_COMPLETION_CAPABILITIES.pull_request.available, true);
  assert.equal(SESSION_ACTION_COMPLETION_CAPABILITIES.session_turn.available, true);
  const result = validateWorkflowGraph({
    graph: graph(),
    personas,
    sessionActions: actions,
    completionPolicy: { kind: "none" },
    sessionActionCompletionCapabilities: {
      session_turn: { available: true, unavailableReason: null },
      pull_request: { available: false, unavailableReason: "This build cannot be published." },
    },
  });
  assert.equal(result.valid, false);
  const gate = result.diagnostics.find((item) => item.code === "session_action_runtime_unavailable");
  assert.ok(gate);
  assert.equal(gate.nodeId, "act");
  assert.match(gate.message, /cannot be published/);

  // This build's own answer carries no gate for the very same graph.
  const turnOnly = validate(graph());
  assert.equal(turnOnly.valid, true);
  assert.deepEqual(
    turnOnly.diagnostics.filter((item) => item.code === "session_action_runtime_unavailable"),
    [],
  );

  // And a graph with no action node is entirely unaffected by the gate.
  const withoutAction: WorkflowDraftGraph = {
    nodes: [
      { id: "s", kind: "session", position: { x: 0, y: 0 } },
      { id: "intent", kind: "persona", personaId: "intent", position: { x: 200, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "s", sourcePort: "submitted", target: "intent", targetPort: "activate" },
      { id: "e2", source: "intent", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
      { id: "e3", source: "intent", sourcePort: "pass", target: "end", targetPort: "terminal" },
    ],
  };
  assert.deepEqual(validate(withoutAction), { valid: true, diagnostics: [] });
});
