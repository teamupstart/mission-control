import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ArchivePersonaSchema,
  CreatePersonaSchema,
  CreateWorkflowBindingSchema,
  CreateWorkflowSchema,
  PublishedWorkflowGraphSchema,
  ReattachWorkflowBindingSchema,
  UpdatePersonaSchema,
  WorkflowCompletionPolicySchema,
  WorkflowDraftGraphSchema,
  WorkflowNodeAttemptStateSchema,
  WorkflowRunStatusSchema,
  WorkflowSubmissionModeSchema,
  WorkflowSubmissionStatusSchema,
} from "../src/shared/protocol.ts";
import {
  WORKFLOW_LIMITS,
  WORKFLOW_PERSONA_MODEL_ENV,
  WORKFLOW_PERSONA_MODEL_SPEC,
  normalizePersonaName,
} from "../src/shared/workflow.ts";

// What is at stake: every later workflow phase persists values declared here. Widening a node
// union, accepting an unknown lifecycle state, or silently normalizing Persona guidance after
// published versions exist would turn one Phase 1 edit into incompatible durable history.

test("workflow limits are finite front-door contracts", () => {
  assert.deepEqual(WORKFLOW_LIMITS, {
    personaName: 100,
    personaDescription: 500,
    personaGuidanceBytes: 100_000,
    workflowName: 120,
    graphNodes: 100,
    graphEdges: 300,
    graphJsonBytes: 500_000,
    eventPayloadBytes: 64_000,
    canvasCoordinateAbs: 100_000,
    repairRoundsMin: 1,
    repairRoundsMax: 20,
  });
});

test("Persona uniqueness normalization is Unicode-stable and English-lowercased", () => {
  assert.equal(normalizePersonaName("  Ｃode\t  QUALITY  "), "code quality");
  assert.equal(normalizePersonaName("Straße"), "straße");
});

test("accepted Persona Markdown is returned byte-for-byte", () => {
  const guidanceMarkdown = "# Review\r\n\r\nKeep trailing space  \r\n\u0000";
  const parsed = CreatePersonaSchema.parse({ name: "Review", guidanceMarkdown });
  assert.equal(parsed.guidanceMarkdown, guidanceMarkdown);
  assert.equal(parsed.description, "");
  assert.equal(parsed.runner, null);
  assert.equal(parsed.model, null);
});

test("Persona guidance is bounded by UTF-8 bytes rather than UTF-16 code units", () => {
  const within = "é".repeat(WORKFLOW_LIMITS.personaGuidanceBytes / 2);
  assert.equal(CreatePersonaSchema.parse({ name: "Within", guidanceMarkdown: within }).guidanceMarkdown, within);
  assert.throws(() =>
    CreatePersonaSchema.parse({ name: "Too large", guidanceMarkdown: `${within}é` }),
  );
});

test("Persona writes distinguish omission from an explicit override clear", () => {
  assert.throws(() => UpdatePersonaSchema.parse({ expectedRevision: 1 }));
  assert.deepEqual(UpdatePersonaSchema.parse({ expectedRevision: 1, runner: null }), {
    expectedRevision: 1,
    runner: null,
  });
  assert.deepEqual(ArchivePersonaSchema.parse({ expectedRevision: 2 }), { expectedRevision: 2 });
  assert.throws(() => CreatePersonaSchema.parse({ name: "Bad", guidanceMarkdown: "# x", runner: "other" }));
});

test("graph vocabulary has one Session concept and no checkpoint or Inspector nodes", () => {
  const base = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "persona", kind: "persona", personaId: "p1", position: { x: 100, y: 0 } },
      { id: "join", kind: "all_pass", position: { x: 200, y: 0 } },
      { id: "end", kind: "end", outcome: "Approved", position: { x: 300, y: 0 } },
    ],
    edges: [],
  };
  assert.equal(WorkflowDraftGraphSchema.parse(base).nodes.length, 4);
  for (const kind of ["checkpoint", "inspector"]) {
    assert.throws(() =>
      WorkflowDraftGraphSchema.parse({
        ...base,
        nodes: [...base.nodes, { id: kind, kind, position: { x: 0, y: 0 } }],
      }),
    );
  }
  assert.throws(() =>
    PublishedWorkflowGraphSchema.parse({
      nodes: [{ id: "p", kind: "persona", personaId: "live-id", position: { x: 0, y: 0 } }],
      edges: [],
    }),
  );
});

test("coordinates and graph collections are bounded before later validation", () => {
  assert.throws(() =>
    WorkflowDraftGraphSchema.parse({
      nodes: [{ id: "n", kind: "session", position: { x: Number.POSITIVE_INFINITY, y: 0 } }],
      edges: [],
    }),
  );
  assert.throws(() =>
    WorkflowDraftGraphSchema.parse({
      nodes: Array.from({ length: WORKFLOW_LIMITS.graphNodes + 1 }, (_, i) => ({
        id: `n${i}`,
        kind: "session" as const,
        position: { x: i, y: 0 },
      })),
      edges: [],
    }),
  );
});

test("Inspector is a closed workflow-level completion policy", () => {
  assert.deepEqual(WorkflowCompletionPolicySchema.parse({ kind: "none" }), { kind: "none" });
  assert.deepEqual(
    WorkflowCompletionPolicySchema.parse({
      kind: "inspector",
      onFindings: "restart_workflow",
      missingPrAction: "wait",
    }),
    { kind: "inspector", onFindings: "restart_workflow", missingPrAction: "wait" },
  );
  assert.throws(() =>
    WorkflowCompletionPolicySchema.parse({
      kind: "inspector",
      onFindings: "ask_session",
      missingPrAction: "wait",
    }),
  );
});

test("future engine states are closed before any route can write them", () => {
  for (const [schema, value] of [
    [WorkflowRunStatusSchema, "running"],
    [WorkflowSubmissionModeSchema, "inspector_only"],
    [WorkflowSubmissionStatusSchema, "waiting_for_session"],
    [WorkflowNodeAttemptStateSchema, "retry_wait"],
  ] as const) {
    assert.equal(schema.parse(value), value);
    assert.throws(() => schema.parse("surprise"));
  }
});

test("new workflow drafts carry honest Phase 1 defaults", () => {
  const draft = CreateWorkflowSchema.parse({ name: "Review" });
  assert.equal(draft.draft.nodes.filter((node) => node.kind === "session").length, 1);
  assert.equal(draft.draft.edges.length, 0);
  assert.deepEqual(draft.completionPolicy, { kind: "none" });
  assert.deepEqual(draft.bindingDefaults, {
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
  });
});

test("binding requests name the live session while the daemon owns durable note keys", () => {
  assert.deepEqual(
    CreateWorkflowBindingSchema.parse({ workflowVersionId: "v1", sessionId: "s1" }),
    {
      workflowVersionId: "v1",
      sessionId: "s1",
    },
  );
  assert.deepEqual(ReattachWorkflowBindingSchema.parse({ sessionId: "s2" }), { sessionId: "s2" });
});

test("Persona model role names the working environment variable and balanced fallback", () => {
  assert.equal(WORKFLOW_PERSONA_MODEL_ENV, "WORKFLOW_PERSONA_MODEL");
  assert.equal(WORKFLOW_PERSONA_MODEL_SPEC.envVar, "MISSION_WORKFLOW_PERSONA_MODEL");
  assert.equal(WORKFLOW_PERSONA_MODEL_SPEC.fallback, "claude-sonnet-5");
  assert.equal(WORKFLOW_PERSONA_MODEL_SPEC.label, "Workflow Persona");
  assert.match(WORKFLOW_PERSONA_MODEL_SPEC.blurb, /individual Persona override wins/i);
});
