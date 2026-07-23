import { test } from "node:test";
import assert from "node:assert/strict";
import type { Persona, WorkflowDraftGraph } from "../src/shared/workflow.ts";
import { validateWorkflowGraph } from "../src/shared/workflow-graph.ts";

const personas: Persona[] = ["code", "maint", "design"].map((id) => ({
  id, name: id, normalizedName: id, description: "", guidanceMarkdown: "# Judge",
  runner: null, model: null, revision: 1, archivedAt: null, createdAt: 1, updatedAt: 1,
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
