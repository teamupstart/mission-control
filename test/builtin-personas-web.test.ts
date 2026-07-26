import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PersonaView, WorkflowDraftGraph } from "../src/shared/workflow.ts";
import { personasForDisplay } from "../src/shared/workflow.ts";
import { validateWorkflowGraph } from "../src/shared/workflow-graph.ts";
import { PersonaLibrary } from "../src/web/workflows/PersonaLibrary.tsx";
import { PipelineEditor } from "../src/web/workflows/PipelineEditor.tsx";
import { WorkflowCanvas } from "../src/web/workflows/WorkflowCanvas.tsx";
import { workflowPublishBlocked } from "../src/web/workflows/useWorkflowDraft.ts";

const persona = (
  id: string,
  name: string,
  builtin: boolean,
): PersonaView => ({
  id,
  name,
  normalizedName: "code risk reviewer",
  description: "",
  guidanceMarkdown: "# Code Risk Reviewer",
  runner: null,
  model: null,
  revision: builtin ? 1 : 3,
  archivedAt: null,
  createdAt: builtin ? 0 : 1,
  updatedAt: builtin ? 0 : 1,
  builtin,
  execution: {
    runner: { id: "claude", source: "default", unknown: null },
    model: { id: "claude-haiku-4-5", source: "default" },
  } as PersonaView["execution"],
});

const operator = persona("operator", "CODE RISK REVIEWER", false);
const builtin = persona("builtin:code-risk-reviewer", "Code Risk Reviewer", true);
const personas = [operator, builtin];
const graph: WorkflowDraftGraph = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "judge", kind: "persona", personaId: builtin.id, position: { x: 220, y: 0 } },
    { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
  ],
  edges: [
    { id: "start", source: "session", sourcePort: "submitted", target: "judge", targetPort: "activate" },
    { id: "pass", source: "judge", sourcePort: "pass", target: "end", targetPort: "terminal" },
    { id: "fail", source: "judge", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ],
};

test("shadowed built-ins resolve while Persona pickers show the operator row", () => {
  assert.deepEqual(personasForDisplay(personas).map((persona) => persona.id), [operator.id]);

  const validation = validateWorkflowGraph({
    graph,
    personas,
    completionPolicy: { kind: "none" },
  });
  assert.equal(validation.valid, true);
  assert.equal(workflowPublishBlocked({
    dirty: false,
    saving: false,
    conflicted: false,
    valid: validation.valid,
    alreadyPublished: false,
    archived: false,
  }), false);

  const canvas = renderToStaticMarkup(createElement(WorkflowCanvas, {
    graph,
    personas,
    readOnly: false,
  }));
  assert.match(canvas, /Code Risk Reviewer/);
  assert.doesNotMatch(canvas, /Missing Persona/);

  const pipeline = renderToStaticMarkup(createElement(PipelineEditor, {
    graph,
    personas,
    onChange: () => {},
    onConfirm: () => {},
    onAnnounce: () => {},
  }));
  assert.match(pipeline, /Code Risk Reviewer/);
  assert.doesNotMatch(pipeline, /Missing persona/);
  assert.match(pipeline, /<option value="operator">CODE RISK REVIEWER<\/option>/);
  assert.doesNotMatch(pipeline, /<option value="builtin:code-risk-reviewer">/);

  const library = renderToStaticMarkup(createElement(PersonaLibrary, {
    personas,
    providers: [],
    defaults: null,
    isOverlayOpen: () => false,
    onDirtyChange: () => {},
  }));
  assert.equal(library.match(/class="persona-list-item/g)?.length, 1);
  assert.doesNotMatch(library, /class="persona-list-tag">Built-in</);
});
