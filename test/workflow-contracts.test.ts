import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ArchivePersonaSchema,
  CreatePersonaSchema,
  CreateWorkflowBindingSchema,
  CreateWorkflowSchema,
  PublishedWorkflowGraphSchema,
  ReattachWorkflowBindingSchema,
  RestartFullWorkflowSchema,
  SetWorkflowNodesDisabledSchema,
  UpdatePersonaSchema,
  WorkflowCaptureExpectationSchema,
  WorkflowCompletionPolicySchema,
  WorkflowDraftGraphSchema,
  WorkflowNodeAttemptStateSchema,
  WorkflowInspectorGateStateSchema,
  WorkflowRunStatusSchema,
  WorkflowRunActionSchema,
  WorkflowSubmissionModeSchema,
  WorkflowSubmissionStatusSchema,
  WorkflowTriggerSourceSchema,
} from "../src/shared/protocol.ts";
import { INSPECTOR_LIMITS } from "../src/shared/inspector.ts";
import {
  WORKFLOW_EXTERNAL_SOURCE_KINDS,
  WORKFLOW_LIMITS,
  WORKFLOW_PERSONA_MODEL_ENV,
  WORKFLOW_PERSONA_MODEL_SPEC,
  WORKFLOW_TRIGGER_MODES,
  WORKFLOW_TRIGGER_SOURCES,
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
    personaDirectiveBytes: 8_000,
    // A READ ceiling on the stored import-provenance blob rather than a budget anyone spends:
    // generous against the sum of its own bounded fields, so one malformed write cannot make
    // every later read of that Persona expensive.
    personaProvenanceJsonBytes: 16_000,
    sessionActionName: 100,
    sessionActionDescription: 500,
    // DERIVED, not chosen: the packet budget less the envelope allowance. The two used to be
    // set independently, and the gap between them was a published action that types only a
    // prefix of its immutable instruction.
    sessionActionPromptBytes: 58_000,
    sessionActionEnvelopeBytes: 2_000,
    // Looser than the authoring bound on purpose, so a row written before the ceiling was
    // tied to the packet budget stays readable and therefore fixable. It still cannot be
    // published - the snapshot schema holds it to `sessionActionPromptBytes`.
    sessionActionPromptReadBytes: 100_000,
    sessionActionSkillId: 200,
    // Deliberately NOT `feedbackPayloadBytes`. That budget bounds prose the daemon composes
    // from verdicts; this bounds the operator's own authored instruction, so it is the
    // delivery row's own ceiling less envelope headroom - the widest prompt that can be
    // stored is the widest that can be sent.
    sessionActionPacketBytes: 60_000,
    workflowName: 120,
    graphNodes: 100,
    graphEdges: 300,
    graphJsonBytes: 500_000,
    eventPayloadBytes: 64_000,
    canvasCoordinateAbs: 100_000,
    repairRoundsMin: 1,
    repairRoundsMax: 20,
    feedbackFieldBytes: 4_000,
    feedbackPayloadBytes: 8_000,
    externalSourceId: 200,
    externalSourceSegment: 200,
    externalSourceKey: 1_000,
    // A check command is a durable blob an operator types, so it is bounded three ways:
    // how many arguments, how long each is, and how long the whole argv is. The last is the
    // one that matters - 32 arguments of 1,000 characters is an argv no execve would take.
    checkRepoRoot: 4_096,
    checkCommands: 200,
    commandOverrides: 200,
    // A Command's per-run execution budget. The floor is one rather than zero because "never
    // run this gate" is already expressible by leaving the slot unconfigured, and the ceiling
    // is `repairRoundsMax` so that a budget set there can never be spent - which is the only
    // honest way to say "run it every round, as it always did".
    commandMaxRunsMin: 1,
    commandMaxRunsMax: 21,
    checkCommandArgs: 32,
    checkCommandArg: 1_000,
    checkCommandLength: 4_000,
  });
});

test("trigger source is an append-only registry and is not a trigger mode", () => {
  // Both tuples are persisted, and they answer different questions. A trigger MODE is
  // recurring binding behaviour an operator chose; a trigger SOURCE records which caller
  // produced one submission. Letting `ensemble` into the mode union would offer an operator
  // a recurring behaviour that nothing implements.
  assert.deepEqual([...WORKFLOW_TRIGGER_SOURCES], ["manual", "foreman", "ensemble", "session"]);
  assert.deepEqual([...WORKFLOW_TRIGGER_MODES], ["manual", "foreman_complete"]);
  assert.equal(WorkflowTriggerSourceSchema.parse("ensemble"), "ensemble");
  // `session` is the engine's resumption observer, and it is a SOURCE and not a mode for the
  // same reason `ensemble` is: it names the caller that produced one submission, while the
  // mode union is the recurring behaviour an operator picked when they bound the workflow.
  assert.equal(WorkflowTriggerSourceSchema.parse("session"), "session");
  assert.equal(
    WORKFLOW_TRIGGER_MODES.includes("session" as (typeof WORKFLOW_TRIGGER_MODES)[number]),
    false,
  );
  assert.equal(WorkflowTriggerSourceSchema.parse("manual"), "manual");
  assert.equal(WorkflowTriggerSourceSchema.parse("foreman"), "foreman");
  assert.throws(() => WorkflowTriggerSourceSchema.parse("inspector"));
  assert.equal(
    WORKFLOW_TRIGGER_MODES.includes("ensemble" as (typeof WORKFLOW_TRIGGER_MODES)[number]),
    false,
  );
  // Every external source kind must also be a trigger source, because the kind IS the source
  // a run is filed under. A kind with no matching source would file its runs as somebody
  // else's.
  for (const kind of WORKFLOW_EXTERNAL_SOURCE_KINDS) {
    assert.equal(WorkflowTriggerSourceSchema.parse(kind), kind);
  }
});

test("an external capture expectation is one exact commit and cannot waive a clean tree", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(
    WorkflowCaptureExpectationSchema.parse({ expectedHeadSha: sha, requireCleanWorktree: true }),
    { expectedHeadSha: sha, requireCleanWorktree: true },
  );
  // A matching HEAD with uncommitted changes is not the selected artifact, so there is no
  // valid request that turns the check off.
  assert.throws(() =>
    WorkflowCaptureExpectationSchema.parse({ expectedHeadSha: sha, requireCleanWorktree: false }));
  // An abbreviated id can become ambiguous in a repository that grew since it was chosen.
  assert.throws(() =>
    WorkflowCaptureExpectationSchema.parse({ expectedHeadSha: "a".repeat(12), requireCleanWorktree: true }));
  assert.throws(() =>
    WorkflowCaptureExpectationSchema.parse({ expectedHeadSha: "A".repeat(40), requireCleanWorktree: true }));
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

// The Ensemble entry is not speculative: an external orchestrator can now start one run
// through the manager, and the temptation is to let it be a node too. It must not be. Every
// published graph has exactly one Session, and a node standing for N of them would make the
// binding, the context snapshot, delivery, the final gate and Reset all multi-subject.
test("graph vocabulary has one Session concept and no checkpoint, Inspector, or Ensemble nodes", () => {
  const base = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "persona", kind: "persona", personaId: "p1", position: { x: 100, y: 0 } },
      { id: "join", kind: "all_pass", position: { x: 200, y: 0 } },
      { id: "action", kind: "session_action", sessionActionId: "a1", position: { x: 250, y: 0 } },
      { id: "end", kind: "end", outcome: "Approved", position: { x: 300, y: 0 } },
    ],
    edges: [],
  };
  assert.equal(WorkflowDraftGraphSchema.parse(base).nodes.length, 5);
  for (const kind of ["checkpoint", "inspector", "ensemble"]) {
    assert.throws(() =>
      WorkflowDraftGraphSchema.parse({
        ...base,
        nodes: [...base.nodes, { id: kind, kind, position: { x: 0, y: 0 } }],
      }),
    );
    assert.throws(() =>
      PublishedWorkflowGraphSchema.parse({
        nodes: [{ id: kind, kind, position: { x: 0, y: 0 } }],
        edges: [],
      }),
    );
  }
  assert.throws(() =>
    PublishedWorkflowGraphSchema.parse({
      nodes: [{ id: "p", kind: "persona", personaId: "live-id", position: { x: 0, y: 0 } }],
      edges: [],
    }),
  );
  // The same refusal for the second kind whose published form differs: a version holding a
  // live action id would let a library edit change what an in-flight run types.
  assert.throws(() =>
    PublishedWorkflowGraphSchema.parse({
      nodes: [{ id: "a", kind: "session_action", sessionActionId: "live-id", position: { x: 0, y: 0 } }],
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
  assert.deepEqual(
    WorkflowCompletionPolicySchema.parse({
      kind: "inspector",
      onFindings: "restart_workflow",
      missingPrAction: "prepare_pr",
    }),
    { kind: "inspector", onFindings: "restart_workflow", missingPrAction: "prepare_pr" },
  );
  assert.throws(() =>
    WorkflowCompletionPolicySchema.parse({
      kind: "inspector",
      onFindings: "ask_session",
      missingPrAction: "wait",
    }),
  );
});

test("Inspector gate persistence covers the Inspector finding lifetime", () => {
  assert.equal(
    INSPECTOR_LIMITS.maxFindingFingerprints,
    INSPECTOR_LIMITS.maxRounds * INSPECTOR_LIMITS.maxCommentsPerRound,
  );
  const findingFingerprints = Array.from(
    { length: INSPECTOR_LIMITS.maxFindingFingerprints },
    (_, index) => `finding-${index}`,
  );
  const parsed = WorkflowInspectorGateStateSchema.parse({
    prKey: "owner/repo#1",
    prUrl: "https://github.com/owner/repo/pull/1",
    targetHeadSha: "head",
    failedHeadSha: "head",
    enteredAt: 1,
    lastObservedAt: 2,
    observedHeadSha: "head",
    reviewPosture: "live",
    waitReason: "findings",
    findingFingerprints,
  });
  assert.equal(parsed.findingFingerprints.length, INSPECTOR_LIMITS.maxFindingFingerprints);
  assert.throws(() =>
    WorkflowInspectorGateStateSchema.parse({
      ...parsed,
      findingFingerprints: [...findingFingerprints, "overflow"],
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

test("new workflow drafts default submission to Foreman complete", () => {
  const draft = CreateWorkflowSchema.parse({ name: "Review" });
  assert.equal(draft.draft.nodes.filter((node) => node.kind === "session").length, 1);
  assert.equal(draft.draft.edges.length, 0);
  assert.deepEqual(draft.completionPolicy, { kind: "none" });
  assert.deepEqual(draft.bindingDefaults, {
    triggerMode: "foreman_complete",
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

test("Inspector run actions require parsed request identity and bound restart confirmation", () => {
  assert.deepEqual(WorkflowRunActionSchema.parse({ requestId: "action-1" }), {
    requestId: "action-1",
  });
  assert.deepEqual(RestartFullWorkflowSchema.parse({
    requestId: "restart-1",
    confirmation: "RESTART FULL WORKFLOW",
  }), {
    requestId: "restart-1",
    confirmation: "RESTART FULL WORKFLOW",
  });
  assert.throws(() => WorkflowRunActionSchema.parse({ requestId: "" }));
  assert.throws(() => RestartFullWorkflowSchema.parse({}));
});

test("the per-run node disable toggle names its nodes, its direction, and its request", () => {
  assert.deepEqual(SetWorkflowNodesDisabledSchema.parse({
    requestId: "toggle-1",
    nodeIds: ["judge-node"],
    disabled: true,
  }), {
    requestId: "toggle-1",
    nodeIds: ["judge-node"],
    disabled: true,
  });
  // Both halves of the toggle are explicit; there is no "flip whatever it was" request,
  // which would race a second operator's click.
  assert.equal(SetWorkflowNodesDisabledSchema.parse({
    requestId: "toggle-2",
    nodeIds: ["a", "b"],
    disabled: false,
  }).disabled, false);
  assert.throws(() => SetWorkflowNodesDisabledSchema.parse({ requestId: "toggle-3", nodeIds: [], disabled: true }));
  assert.throws(() => SetWorkflowNodesDisabledSchema.parse({ requestId: "toggle-4", nodeIds: ["a"] }));
  assert.throws(() => SetWorkflowNodesDisabledSchema.parse({ nodeIds: ["a"], disabled: true }));
  // A repeated id would drive the same audit event twice, so the schema refuses it.
  assert.throws(() => SetWorkflowNodesDisabledSchema.parse({
    requestId: "toggle-6",
    nodeIds: ["a", "a"],
    disabled: true,
  }));
  assert.throws(() => SetWorkflowNodesDisabledSchema.parse({
    requestId: "toggle-5",
    nodeIds: Array.from({ length: WORKFLOW_LIMITS.graphNodes + 1 }, (_, index) => `node-${index}`),
    disabled: true,
  }));
});

test("Persona model role names the working environment variable and balanced fallback", () => {
  assert.equal(WORKFLOW_PERSONA_MODEL_ENV, "WORKFLOW_PERSONA_MODEL");
  assert.equal(WORKFLOW_PERSONA_MODEL_SPEC.envVar, "MISSION_WORKFLOW_PERSONA_MODEL");
  assert.equal(WORKFLOW_PERSONA_MODEL_SPEC.fallback, "claude-sonnet-5");
  assert.equal(WORKFLOW_PERSONA_MODEL_SPEC.label, "Workflow Persona");
  assert.match(WORKFLOW_PERSONA_MODEL_SPEC.blurb, /individual Persona override wins/i);
});
