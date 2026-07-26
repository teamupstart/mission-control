import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  PersonaView,
  WorkflowDefinition,
  WorkflowDraftGraph,
  WorkflowVersion,
} from "../src/shared/workflow.ts";
import {
  personaSnapshotIsOutdated,
  personasForDisplay,
} from "../src/shared/workflow.ts";
import { validateWorkflowGraph } from "../src/shared/workflow-graph.ts";
import { PersonaLibrary } from "../src/web/workflows/PersonaLibrary.tsx";
import { PipelineEditor } from "../src/web/workflows/PipelineEditor.tsx";
import { WorkflowCanvas } from "../src/web/workflows/WorkflowCanvas.tsx";
import { WorkflowProperties } from "../src/web/workflows/WorkflowProperties.tsx";
import { WorkflowVersionDetail } from "../src/web/workflows/WorkflowVersionHistory.tsx";
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
const workflow: WorkflowDefinition = {
  id: "workflow",
  name: "Review",
  normalizedName: "review",
  description: "",
  draft: graph,
  completionPolicy: { kind: "none" },
  bindingDefaults: {
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
  },
  draftRevision: 1,
  currentVersionId: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
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

  const properties = renderToStaticMarkup(createElement(WorkflowProperties, {
    workflow,
    personas,
    diagnostics: validation.diagnostics,
    selection: { kind: "node", id: "judge" },
    readOnly: false,
    onUpdate: () => {},
    onConfirm: () => {},
  }));
  assert.match(
    properties,
    /value="builtin:code-risk-reviewer"[^>]*>Code Risk Reviewer \(Built-in, shadowed by your Persona\)<\/option>/,
  );
  assert.match(properties, /value="operator">CODE RISK REVIEWER<\/option>/);

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

test("published built-in snapshots compare shipped guidance instead of revision", () => {
  const version: WorkflowVersion = {
    id: "version",
    workflowId: workflow.id,
    version: 1,
    sourceDraftRevision: workflow.draftRevision,
    graph: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        {
          id: "judge",
          kind: "persona",
          persona: {
            sourcePersonaId: builtin.id,
            sourceRevision: 1,
            name: builtin.name,
            description: builtin.description,
            guidanceMarkdown: builtin.guidanceMarkdown,
            runner: builtin.runner,
            model: builtin.model,
          },
          position: { x: 220, y: 0 },
        },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [],
    },
    completionPolicy: workflow.completionPolicy,
    bindingDefaults: workflow.bindingDefaults,
    publishedAt: 1,
  };
  const snapshot = version.graph.nodes.find((node) => node.kind === "persona")?.persona;
  assert.ok(snapshot);
  assert.equal(personaSnapshotIsOutdated(snapshot, builtin), false);

  const currentHtml = renderToStaticMarkup(createElement(WorkflowVersionDetail, {
    version,
    personas: [builtin],
  }));
  assert.doesNotMatch(currentHtml, /outdated/);
  assert.doesNotMatch(currentHtml, /source unavailable/);

  const changedBuiltin = {
    ...builtin,
    guidanceMarkdown: `${builtin.guidanceMarkdown}\n\nUpdated guidance`,
  };
  assert.equal(personaSnapshotIsOutdated(snapshot, changedBuiltin), true);
  const outdatedHtml = renderToStaticMarkup(createElement(WorkflowVersionDetail, {
    version,
    personas: [changedBuiltin],
  }));
  assert.match(outdatedHtml, /outdated/);

  const unavailableHtml = renderToStaticMarkup(createElement(WorkflowVersionDetail, {
    version,
    personas: [],
  }));
  assert.match(unavailableHtml, /source unavailable/);
  assert.doesNotMatch(unavailableHtml, /outdated/);
});
