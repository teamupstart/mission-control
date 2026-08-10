import { test } from "node:test";
import assert from "node:assert/strict";
import type { Persona, WorkflowDraftGraph } from "../src/shared/workflow.ts";
import { validateWorkflowGraph } from "../src/shared/workflow-graph.ts";

const personas: Persona[] = ["code", "maint", "design"].map((id) => ({
  id, name: id, normalizedName: id, description: "", guidanceMarkdown: "# Judge",
  runner: null, model: null, revision: 1, archivedAt: null, createdAt: 1, updatedAt: 1,
  provenance: null, builtin: false,
}));

const graph = (): WorkflowDraftGraph => ({
  nodes: [
    { id: "s", kind: "session", position: { x: 0, y: 0 } },
    { id: "code", kind: "persona", personaId: "code", position: { x: 200, y: 0 } },
    { id: "maint", kind: "persona", personaId: "maint", position: { x: 400, y: -100 } },
    { id: "design", kind: "persona", personaId: "design", position: { x: 400, y: 100 } },
    { id: "join", kind: "all_pass", position: { x: 600, y: 0 } },
    { id: "end", kind: "end", outcome: "Approved", position: { x: 800, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "s", sourcePort: "submitted", target: "code", targetPort: "activate" },
    { id: "e2", source: "code", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
    { id: "e3", source: "code", sourcePort: "pass", target: "maint", targetPort: "activate" },
    { id: "e4", source: "code", sourcePort: "pass", target: "design", targetPort: "activate" },
    { id: "e5", source: "maint", sourcePort: "pass", target: "join", targetPort: "result" },
    { id: "e6", source: "maint", sourcePort: "fail", target: "join", targetPort: "result" },
    { id: "e7", source: "design", sourcePort: "pass", target: "join", targetPort: "result" },
    { id: "e8", source: "design", sourcePort: "fail", target: "join", targetPort: "result" },
    { id: "e9", source: "join", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
    { id: "e10", source: "join", sourcePort: "pass", target: "end", targetPort: "terminal" },
  ],
});

const codes = (candidate: WorkflowDraftGraph) => validateWorkflowGraph({ graph: candidate, personas, completionPolicy: { kind: "none" } }).diagnostics.map((item) => item.code);

test("fan-out, paired Join outcomes, and repair cycles through Session are valid", () => {
  assert.deepEqual(validateWorkflowGraph({ graph: graph(), personas, completionPolicy: { kind: "none" } }), { valid: true, diagnostics: [] });
});

// Parallel first-wave review is the all-pass Join's headline case, and it was unauthorable while
// the validator demanded exactly one submitted route. The engine always fanned out; only this
// rule refused. Zero routes still has to fail - nothing would ever run.
test("Session may fan out its submitted route, but never drop it", () => {
  const parallel = graph();
  parallel.edges = [
    { id: "s-maint", source: "s", sourcePort: "submitted", target: "maint", targetPort: "activate" },
    { id: "s-design", source: "s", sourcePort: "submitted", target: "design", targetPort: "activate" },
    ...parallel.edges.filter((edge) => ["e5", "e6", "e7", "e8", "e9", "e10"].includes(edge.id)),
  ];
  parallel.nodes = parallel.nodes.filter((node) => node.id !== "code");
  assert.deepEqual(
    validateWorkflowGraph({ graph: parallel, personas, completionPolicy: { kind: "none" } }),
    { valid: true, diagnostics: [] },
  );

  const stranded = graph();
  stranded.edges = stranded.edges.filter((edge) => edge.id !== "e1");
  assert.ok(codes(stranded).includes("session_submitted_route"));
});

test("directional ports, dangling edges, and missing routes have stable diagnostics", () => {
  const candidate = graph();
  candidate.edges = candidate.edges.filter((edge) => edge.id !== "e8");
  candidate.edges.push({ id: "bad", source: "missing", sourcePort: "pass", target: "s", targetPort: "activate" });
  assert.ok(codes(candidate).includes("join_missing_outcome"));
  assert.ok(codes(candidate).includes("dangling_edge"));
});

test("Persona-only cycles are rejected while Session-centered cycles are legal", () => {
  const candidate = graph();
  candidate.edges = candidate.edges.filter((edge) => edge.id !== "e9");
  candidate.edges.push({ id: "cycle", source: "join", sourcePort: "pass", target: "maint", targetPort: "activate" });
  assert.ok(codes(candidate).includes("cycle_without_session"));
  assert.ok(!codes(graph()).includes("cycle_without_session"));
});

test("unreachable nodes and nodes without a terminal or repair path are rejected", () => {
  const candidate = graph();
  candidate.nodes.push({ id: "island", kind: "end", outcome: "Never", position: { x: 0, y: 400 } });
  assert.ok(codes(candidate).includes("unreachable_node"));
  candidate.edges = candidate.edges.filter((edge) => edge.id !== "e9" && edge.id !== "e10");
  assert.ok(codes(candidate).includes("no_terminal_path"));
});

test("finite bounded coordinates are authoritative validation, not canvas decoration", () => {
  for (const x of [Number.NaN, Number.POSITIVE_INFINITY, 100_001]) {
    const candidate = graph();
    candidate.nodes[0]!.position.x = x;
    const found = codes(candidate);
    assert.ok(found.includes(Number.isFinite(x) ? "coordinate_limit" : "invalid_position"));
  }
});

test("missing and archived Personas cannot enter a new version", () => {
  const missing = validateWorkflowGraph({ graph: graph(), personas: personas.slice(1), completionPolicy: { kind: "none" } });
  assert.ok(missing.diagnostics.some((item) => item.code === "missing_persona" && item.nodeId === "code"));
  const archived = personas.map((persona) => persona.id === "code" ? { ...persona, archivedAt: 2 } : persona);
  assert.ok(validateWorkflowGraph({ graph: graph(), personas: archived, completionPolicy: { kind: "none" } }).diagnostics.some((item) => item.code === "archived_persona"));
});

// ---- Check nodes ----
//
// A Check decides a pass/fail outcome exactly as a Persona does, so every rule that is
// really about "a node that decides an outcome" has to reach it. Each of the three below was
// written as a two-way persona-or-join test, and the failure mode of getting one wrong is
// quiet: a Check with no fail route publishes, then dead-ends a submission at runtime.

/** The same graph with `design` replaced by a Check, so the Join has mixed predecessors. */
const withCheck = (): WorkflowDraftGraph => {
  const candidate = graph();
  candidate.nodes = candidate.nodes.map((node) =>
    node.id === "design" ? { id: "design", kind: "check", slot: "test", position: { x: 400, y: 100 } } : node);
  return candidate;
};

test("a Check activates, emits pass and fail, and may feed a Join", () => {
  assert.deepEqual(
    validateWorkflowGraph({ graph: withCheck(), personas, completionPolicy: { kind: "none" } }),
    { valid: true, diagnostics: [] },
  );
});

test("a Check missing either route is diagnosed, and named as a Check", () => {
  for (const [port, code] of [["pass", "missing_pass_route"], ["fail", "missing_fail_route"]] as const) {
    const candidate = withCheck();
    candidate.edges = candidate.edges.filter((edge) => !(edge.source === "design" && edge.sourcePort === port));
    const found = validateWorkflowGraph({ graph: candidate, personas, completionPolicy: { kind: "none" } });
    const diagnostic = found.diagnostics.find((item) => item.code === code && item.nodeId === "design");
    assert.ok(diagnostic, `expected ${code} for the check`);
    // The message used to be a two-way ternary that said "Persona" for anything that was
    // not a Join, so a third kind would have been diagnosed under another kind's name.
    assert.match(diagnostic.message, /^Check needs a/);
  }
});

test("a Check may not receive a Join's result, or emit into a Session that did not fail", () => {
  const candidate = withCheck();
  candidate.edges.push({ id: "e11", source: "join", sourcePort: "pass", target: "design", targetPort: "result" });
  assert.ok(codes(candidate).includes("invalid_target_port"));
});

test("Session and End are still refused as Join predecessors", () => {
  const candidate = withCheck();
  candidate.edges.push({ id: "e11", source: "s", sourcePort: "submitted", target: "join", targetPort: "result" });
  assert.ok(codes(candidate).includes("join_predecessor_kind"));
});
