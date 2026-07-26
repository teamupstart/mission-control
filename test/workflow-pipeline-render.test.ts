import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PipelineEditor } from "../src/web/workflows/PipelineEditor.tsx";
import { WorkflowPipelineProperties } from "../src/web/workflows/WorkflowProperties.tsx";
import { compileStages } from "../src/shared/workflow-stages.ts";
import type { StagePipeline } from "../src/shared/workflow-stages.ts";
import type {
  PersonaView,
  WorkflowDefinition,
  WorkflowDraftGraph,
} from "../src/shared/workflow.ts";

/**
 * What is at stake: the review that motivated this migration found a builder that named
 * every node by UUID. The pipeline is supposed to be the surface where an operator reads
 * their own words back - persona names, stage names, "all pass" - so the load-bearing
 * assertion here is the NEGATIVE one: no node or edge id may reach the markup. That is easy
 * to regress silently, because a UUID renders perfectly well.
 *
 * `renderToStaticMarkup`, no jsdom (house rule), so this covers render only. Focus movement
 * and the edit handlers are pinned by `workflow-builder-a11y.test.ts` and
 * `workflow-pipeline-editor.test.ts` respectively.
 */

const persona = (id: string, name: string): PersonaView => ({
  id,
  name,
  normalizedName: name.toLowerCase(),
  description: "",
  guidanceMarkdown: "",
  runner: null,
  model: null,
  revision: 1,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  builtin: false,
  execution: {
    runner: { id: "claude", source: "default", unknown: null },
    model: { id: "claude-haiku-4-5", source: "default" },
  } as PersonaView["execution"],
});

const personas = [
  persona("11111111-1111-4111-8111-111111111111", "Security reviewer"),
  persona("22222222-2222-4222-8222-222222222222", "Docs reviewer"),
  persona("33333333-3333-4333-8333-333333333333", "Release judge"),
];

const EMPTY: WorkflowDraftGraph = {
  nodes: [
    { id: "aaaaaaaa-0000-4000-8000-000000000001", kind: "session", position: { x: 0, y: 0 } },
    { id: "aaaaaaaa-0000-4000-8000-000000000002", kind: "end", outcome: "Complete", position: { x: 300, y: 0 } },
  ],
  edges: [],
};

/** Two stages: a parallel first wave behind an all-pass join, then one judge. */
const TWO_STAGE: StagePipeline = {
  sessionId: EMPTY.nodes[0]!.id,
  endId: EMPTY.nodes[1]!.id,
  endOutcome: "Complete",
  stages: [
    {
      joinId: "bbbbbbbb-0000-4000-8000-000000000001",
      members: [
        { nodeId: "cccccccc-0000-4000-8000-000000000001", personaId: personas[0]!.id },
        { nodeId: "cccccccc-0000-4000-8000-000000000002", personaId: personas[1]!.id },
      ],
    },
    {
      joinId: null,
      members: [{ nodeId: "cccccccc-0000-4000-8000-000000000003", personaId: personas[2]!.id }],
    },
  ],
};

const editor = (graph: WorkflowDraftGraph): string => renderToStaticMarkup(createElement(
  PipelineEditor,
  { graph, personas, onChange: () => {}, onConfirm: () => {}, onAnnounce: () => {} },
));

test("a two-stage pipeline reads as reviewers, stages and gates", () => {
  const html = editor(compileStages(TWO_STAGE, EMPTY));
  assert.match(html, /Session/);
  assert.match(html, /Security reviewer/);
  assert.match(html, /Docs reviewer/);
  // A single-reviewer stage takes the persona's name; a parallel one is "Stage N".
  assert.match(html, /Stage 1/);
  assert.match(html, /Release judge/);
  assert.match(html, /2 reviewers · all must pass/);
  // The gate marks: what leaves Session, and what each stage has to clear.
  assert.match(html, /submitted/);
  assert.match(html, /all pass/);
  assert.match(html, /Complete/);
  // The repair loop is stated once instead of being drawn as N identical return edges.
  assert.match(html, /returns the submission to Session for repair/);
});

test("no node or edge id reaches the pipeline markup", () => {
  const graph = compileStages(TWO_STAGE, EMPTY);
  const html = editor(graph);
  // Node and edge ids are absent ENTIRELY, attributes included: the editor addresses stages
  // and members by position, so nothing it renders has a reason to carry one. A roving focus
  // key or a drag payload keyed by node id would pass a text-only check and then leak the
  // moment someone rendered it in a title.
  for (const id of [...graph.nodes.map((node) => node.id), ...graph.edges.map((edge) => edge.id)]) {
    assert.ok(!html.includes(id), `the pipeline markup carries the identity ${id}`);
  }
  // Persona ids DO survive, as the `value` of the add-reviewer options - that is what a form
  // control submits, and it is never displayed. So the vocabulary claim is about what an
  // operator can read: no UUID in any shape reaches the rendered text.
  const text = html.replace(/<[^>]*>/g, " ");
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  for (const item of personas) assert.ok(!text.includes(item.id));
});

test("a brand-new workflow opens on an empty stage affordance, not an error wall", () => {
  // Phase 1's zero-stage projection: Session and End with no edges at all. Opening it must
  // not edit it, so the strip is drawn from what is there - one placeholder between the
  // termini - and the graph reaches the compiler only on the first real edit.
  const html = editor(EMPTY);
  assert.match(html, /No reviewers yet/);
  assert.match(html, /Add a reviewer to route the submission|Add one, and the submission routes through it/);
  assert.match(html, /Add reviewer…/);
  // Every active Persona is offered inline; the sidebar palette is a graph-mode affordance.
  for (const item of personas) assert.match(html, new RegExp(item.name));
  assert.doesNotMatch(html, /Stage 1/);
});

test("archived Personas are not offered as new reviewers", () => {
  const html = renderToStaticMarkup(createElement(PipelineEditor, {
    graph: EMPTY,
    personas: [...personas, { ...persona("44444444-4444-4444-8444-444444444444", "Retired reviewer"), archivedAt: 9 }],
    onChange: () => {},
    onConfirm: () => {},
    onAnnounce: () => {},
  }));
  assert.doesNotMatch(html, /Retired reviewer/);
});

test("the pipeline rail states validation as a sentence, with no diagnostic codes", () => {
  const workflow: WorkflowDefinition = {
    id: "w",
    name: "Release review",
    normalizedName: "release review",
    description: "",
    draft: EMPTY,
    completionPolicy: { kind: "none" },
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 3 },
    draftRevision: 1,
    currentVersionId: null,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const fresh = renderToStaticMarkup(createElement(WorkflowPipelineProperties, {
    workflow,
    diagnostics: [
      { code: "session_submitted_route", severity: "error", message: "Session needs a submitted route." },
      { code: "no_terminal_path", severity: "error", message: "No path reaches a terminal outcome." },
    ],
    stageCount: 0,
    readOnly: false,
    onUpdate: () => {},
  }));
  assert.match(fresh, /Add a reviewer to route the submission\./);
  assert.doesNotMatch(fresh, /session_submitted_route/);
  assert.doesNotMatch(fresh, /no_terminal_path/);

  const ready = renderToStaticMarkup(createElement(WorkflowPipelineProperties, {
    workflow,
    diagnostics: [],
    stageCount: 2,
    readOnly: false,
    onUpdate: () => {},
  }));
  assert.match(ready, /Ready to publish\./);
  // A pipeline author never selects a node or an edge, so the rail carries neither list.
  assert.doesNotMatch(ready, /Connections ·/);
});
