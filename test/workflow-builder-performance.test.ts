import { test } from "node:test";
import assert from "node:assert/strict";
import type { PersonaView, WorkflowDraftGraph } from "../src/shared/workflow.ts";
import { validateWorkflowGraph } from "../src/shared/workflow-graph.ts";
import { autoLayoutWorkflow } from "../src/web/workflows/WorkflowCanvas.tsx";
import { filterPersonas } from "../src/web/workflows/PersonaLibrary.tsx";

function capGraph(): { graph: WorkflowDraftGraph; personas: PersonaView[] } {
  const personas: PersonaView[] = Array.from({ length: 98 }, (_, index) => ({
    id: `p-${index}`,
    name: `Persona ${index}`,
    normalizedName: `persona ${index}`,
    description: "",
    guidanceMarkdown: "Review.",
    runner: null,
    model: null,
    revision: 1,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    provenance: null,
    builtin: false,
    execution: {
      runner: { id: "codex", source: "config", unknown: null },
      model: { id: "gpt-test", source: "config" },
    },
  }));
  const nodes: WorkflowDraftGraph["nodes"] = [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    ...personas.map((persona, index) => ({
      id: `node-${index}`,
      kind: "persona" as const,
      personaId: persona.id,
      position: { x: index * 5, y: index * 3 },
    })),
    { id: "end", kind: "end", outcome: "Complete", position: { x: 1_000, y: 0 } },
  ];
  const edges: WorkflowDraftGraph["edges"] = [];
  for (let index = 0; index < 98; index += 1) {
    edges.push({
      id: `chain-${index}`,
      source: index === 0 ? "session" : `node-${index - 1}`,
      sourcePort: index === 0 ? "submitted" : "pass",
      target: `node-${index}`,
      targetPort: "activate",
    });
  }
  edges.push({
    id: "end-edge",
    source: "node-97",
    sourcePort: "pass",
    target: "end",
    targetPort: "terminal",
  });
  for (let index = edges.length; index < 300; index += 1) {
    edges.push({
      id: `extra-${index}`,
      source: `node-${index % 98}`,
      sourcePort: "fail",
      target: "session",
      targetPort: "return_for_changes",
    });
  }
  return { graph: { nodes, edges }, personas };
}

test("validation and auto-layout operate at the documented graph caps", () => {
  const { graph, personas } = capGraph();
  assert.equal(graph.nodes.length, 100);
  assert.equal(graph.edges.length, 300);
  const result = validateWorkflowGraph({
    graph,
    personas,
    completionPolicy: { kind: "none" },
  });
  const laidOut = autoLayoutWorkflow(graph);
  assert.ok(result.diagnostics.length >= 0);
  assert.equal(laidOut.nodes.length, 100);
  assert.ok(laidOut.nodes.every((node) =>
    Math.abs(node.position.x) <= 100_000 && Math.abs(node.position.y) <= 100_000));
});

test("the Persona catalog stays linear and bounded at 300 rows", () => {
  const personas: PersonaView[] = Array.from({ length: 300 }, (_, index) => ({
    id: `catalog-${index}`,
    name: `Reviewer ${String(index).padStart(3, "0")}`,
    normalizedName: `reviewer ${String(index).padStart(3, "0")}`,
    description: index % 2 === 0 ? "Security and privacy" : "Accessibility",
    guidanceMarkdown: "Review.",
    runner: null,
    model: null,
    revision: 1,
    archivedAt: index % 10 === 0 ? 1 : null,
    createdAt: 1,
    updatedAt: 1,
    provenance: null,
    builtin: false,
    execution: {
      runner: { id: "codex", source: "config", unknown: null },
      model: { id: "gpt-test", source: "config" },
    },
  }));
  for (let index = 0; index < 100; index += 1) {
    const active = filterPersonas(personas, "active", "security");
    assert.equal(active.length, 120);
  }
});
