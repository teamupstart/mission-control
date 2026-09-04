import {
  DEFAULT_WORKFLOW_BINDING_DEFAULTS,
  normalizeWorkflowName,
  personaSnapshotOf,
  sessionActionSnapshotOf,
  type PersonaId,
  type PersonaSnapshot,
  type PublishedWorkflowGraph,
  type PublishedWorkflowNode,
  type SessionActionId,
  type SessionActionSnapshot,
  type WorkflowCompletionPolicy,
  type WorkflowDefinition,
  type WorkflowResumptionPolicy,
  type WorkflowCheckSlot,
  type WorkflowDraftGraph,
  type WorkflowEdge,
  type WorkflowBindingDefaults,
  type WorkflowVersion,
} from "@shared/workflow.ts";
import {
  builtinWorkflowId,
  builtinWorkflowVersionId,
  NO_MISTAKES_REVIEW_WORKFLOW_SLUG,
} from "@shared/builtin-workflow.ts";
import { CreateWorkflowSchema } from "@shared/protocol.ts";
import {
  compileStages,
  stageNodeIds,
  type Stage,
  type StageMember,
  type StagePipeline,
} from "@shared/workflow-stages.ts";
import { BUILTIN_PERSONAS, builtinPersonaId } from "./builtin-personas.ts";
import {
  BUILTIN_SESSION_ACTIONS,
  PULL_REQUEST_SESSION_ACTION_ID,
} from "./builtin-session-actions.ts";

export {
  BUILTIN_WORKFLOW_ID_PREFIX,
  builtinWorkflowId,
  builtinWorkflowVersionId,
} from "@shared/builtin-workflow.ts";

/**
 * The review workflows that ship with the application.
 *
 * These are app data, not operator data, and - exactly like `BUILTIN_PERSONAS` - they are
 * never rows. The catalog merges into every workflow read (`WorkflowStore`), which is what
 * makes them visible to the library, to the binding dialog and to run resolution without a
 * seeding step that could half-run, and what makes "always the graph this build was made
 * from" true rather than aspirational.
 *
 * The consequences of not being a row are the point:
 * - Nothing to migrate, so an install that never opened the Workflows tab still has them.
 * - No draft history to keep, because there is only ever one draft of a build's copy.
 * - Edits, archives and publishes are refused in the store rather than in each caller, so a
 *   customized copy is one gesture with an honest name: Duplicate.
 *
 * Two things here reach durable storage and are therefore APPEND-ONLY. `builtinWorkflowId`
 * is stored nowhere itself, but `builtinWorkflowVersionId` lands in
 * `workflow_bindings.workflow_version_id` and `workflow_runs.workflow_version_id`, so
 * renaming a slug silently repoints a binding an operator already holds. And every NODE and
 * EDGE id in a shipped graph is durable too: `workflow_node_attempts.node_id` and
 * `workflow_receipts.edge_id` name them. That is why nothing in this module mints a UUID -
 * a fresh id per process start would orphan every receipt written before the last restart.
 *
 * `versions` is a LIST, newest current, and it is a list on day one deliberately. Improving a
 * shipped workflow means APPENDING a version, never editing one in place, so that a binding
 * pinned to the older version keeps resolving and keeps running the graph it was bound to. A
 * single-version catalog would strand those bindings the first time this shipped graph
 * changed.
 *
 * Persona snapshots are taken from `BUILTIN_PERSONAS` at module load, so a shipped version
 * always carries the guidance THIS build was made from and `personaSnapshotIsOutdated` never
 * reports the shipped workflow as stale against the shipped Personas. The other half of that
 * rule lives in the plan: a change to a `personas/*.md` document a shipped built-in
 * references appends a new built-in workflow version in the same commit.
 */
export interface BuiltinWorkflow {
  /** `builtin: true`, and `currentVersionId` names the NEWEST entry in `versions`. */
  definition: WorkflowDefinition;
  /** Ascending by version number. Every version ever shipped stays here. */
  versions: readonly WorkflowVersion[];
}

/**
 * A route's identity, derived from what it connects rather than minted.
 *
 * `compileStages` mints a UUID for any edge it cannot find in the previous graph, and there
 * is no previous graph here. The tuple is unique within a compiled pipeline by construction -
 * the compiler emits each `(source, port, target, port)` at most once - and it is the same
 * string on every machine and every restart, which is what `workflow_receipts.edge_id`
 * requires.
 */
function builtinEdgeId(edge: WorkflowEdge): string {
  return `${edge.source}~${edge.sourcePort}~${edge.target}~${edge.targetPort}`;
}

/**
 * The graph a hand-written pipeline means, with every identity ours.
 *
 * Positions come from `compileStages` rather than being typed out, so a shipped graph cannot
 * drift from the coordinates the Pipeline editor would produce for the same pipeline - which
 * is what keeps `stageExpressible` true and keeps the flagship built-in out of Graph view.
 */
function compileBuiltinGraph(pipeline: StagePipeline): WorkflowDraftGraph {
  const declared = new Set<string>([
    pipeline.sessionId,
    pipeline.endId,
    // `stageNodeIds` answers this for both stage kinds, including the join a parallel
    // evaluation stage owns. A hand-written union here would have to be updated in step with
    // every new stage shape, and the failure of forgetting is a shipped workflow whose node
    // ids are minted UUIDs - different on every machine, which is what this check exists to
    // prevent.
    ...pipeline.stages.flatMap(stageNodeIds),
  ]);
  const compiled = compileStages(pipeline, { nodes: [], edges: [] });
  for (const node of compiled.nodes) {
    if (!declared.has(node.id)) {
      throw new Error(`built-in workflow node ${node.id} was minted rather than named`);
    }
  }
  const edges = compiled.edges.map((edge) => ({ ...edge, id: builtinEdgeId(edge) }));
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) {
    throw new Error("built-in workflow compiled two routes with the same identity");
  }
  return { nodes: compiled.nodes, edges };
}

/**
 * Fail at module load rather than shipping a node that cannot resolve.
 *
 * A shipped workflow naming a Persona this build does not carry would validate as
 * `missing_persona` on every install, which is a broken flagship discovered by an operator
 * instead of by the process that built it.
 */
function builtinPersonaSnapshot(personaId: PersonaId): PersonaSnapshot {
  const persona = BUILTIN_PERSONAS.find((candidate) => candidate.id === personaId);
  if (!persona) {
    throw new Error(`built-in workflow references Persona ${personaId}, which this build does not ship`);
  }
  return personaSnapshotOf(persona);
}

/** The same draft-to-published projection `publishWorkflow` performs, over the shipped graph. */
function publishBuiltinGraph(graph: WorkflowDraftGraph): PublishedWorkflowGraph {
  return {
    nodes: graph.nodes.map((node): PublishedWorkflowNode => {
      if (node.kind === "persona") {
        return {
          id: node.id,
          kind: "persona" as const,
          position: node.position,
          persona: builtinPersonaSnapshot(node.personaId),
        };
      }
      // No shipped workflow authors one yet - the runtime that would execute it arrives in a
      // later phase - but the projection has to be total, or the day one does it would be
      // published with a live id where its frozen prompt belongs.
      if (node.kind === "session_action") {
        return {
          id: node.id,
          kind: "session_action" as const,
          position: node.position,
          action: builtinSessionActionSnapshot(node.sessionActionId),
        };
      }
      return node;
    }),
    edges: graph.edges,
  };
}

/** The action half of `builtinPersonaSnapshot`, refusing an id this build does not ship. */
function builtinSessionActionSnapshot(sessionActionId: SessionActionId): SessionActionSnapshot {
  const action = BUILTIN_SESSION_ACTIONS.find((candidate) => candidate.id === sessionActionId);
  if (!action) {
    throw new Error(
      `built-in workflow references session action ${sessionActionId}, which this build does not ship`,
    );
  }
  return sessionActionSnapshotOf(action);
}

interface BuiltinWorkflowSource {
  slug: string;
  name: string;
  description: string;
  /** Ascending. Index 0 is version 1, and the last entry is what the draft shows. */
  versions: readonly {
    pipeline: StagePipeline;
    completionPolicy: WorkflowCompletionPolicy;
    /**
     * Stated per version, never defaulted. Same rule as `bindingDefaults` below: a shipped
     * version is immutable app data, so deriving it from today's application default would
     * silently change how versions 1-6 behave the next time that default moves.
     */
    resumptionPolicy: WorkflowResumptionPolicy;
    bindingDefaults: WorkflowBindingDefaults;
    sourceDraftRevision: number;
  }[];
}

function builtinWorkflow(source: BuiltinWorkflowSource): BuiltinWorkflow {
  if (source.versions.length === 0) {
    throw new Error(`built-in workflow ${source.slug} ships no published version`);
  }
  const graphs = source.versions.map((version) => compileBuiltinGraph(version.pipeline));
  const versions = graphs.map((graph, index) => ({
    id: builtinWorkflowVersionId(source.slug, index + 1),
    workflowId: builtinWorkflowId(source.slug),
    version: index + 1,
    sourceDraftRevision: source.versions[index]!.sourceDraftRevision,
    graph: publishBuiltinGraph(graph),
    completionPolicy: source.versions[index]!.completionPolicy,
    resumptionPolicy: source.versions[index]!.resumptionPolicy,
    bindingDefaults: source.versions[index]!.bindingDefaults,
    // Not published on this machine and carrying no edit history, so there is no instant to
    // report. Surfaces print "Built-in" where they print a row's dates.
    publishedAt: 0,
  }));
  const current = versions[versions.length - 1]!;
  const duplicateSeed = {
    name: source.name,
    description: source.description,
    draft: graphs[graphs.length - 1]!,
    completionPolicy: current.completionPolicy,
    resumptionPolicy: current.resumptionPolicy,
    bindingDefaults: current.bindingDefaults,
  };
  const duplicable = CreateWorkflowSchema.safeParse(duplicateSeed);
  if (!duplicable.success) {
    throw new Error(
      `built-in workflow ${source.slug} cannot pass the Duplicate create boundary: ${duplicable.error.message}`,
    );
  }
  return {
    definition: {
      id: builtinWorkflowId(source.slug),
      name: source.name,
      normalizedName: normalizeWorkflowName(source.name),
      description: source.description,
      draft: graphs[graphs.length - 1]!,
      completionPolicy: current.completionPolicy,
      resumptionPolicy: current.resumptionPolicy,
      bindingDefaults: current.bindingDefaults,
      draftRevision: current.sourceDraftRevision,
      currentVersionId: current.id,
      archivedAt: null,
      createdAt: 0,
      updatedAt: 0,
      builtin: true,
    },
    versions,
  };
}

/**
 * Node identities for No-Mistakes Review, shared by every version that runs the same node.
 *
 * Named after the role rather than the position, because a later version may reorder the
 * stages and the id has to keep meaning the same reviewer to every attempt row already
 * written against it. Version 3 is the worked example: it puts a deterministic stage in front
 * of Intent Conformance, and Intent Conformance is still `nmr-intent-conformance`.
 */
const NO_MISTAKES_REVIEW_NODES = {
  session: "nmr-session",
  typecheck: "nmr-check-typecheck",
  test: "nmr-check-test",
  build: "nmr-build-join",
  intent: "nmr-intent-conformance",
  risk: "nmr-code-risk",
  evidence: "nmr-test-evidence",
  documentation: "nmr-documentation",
  depth: "nmr-depth-join",
  quality: "nmr-code-quality-judge",
  design: "nmr-code-design",
  slop: "nmr-slop-filter",
  evidenceDocumentation: "nmr-evidence-documentation-join",
  pullRequest: "nmr-pull-request",
  end: "nmr-end",
} as const;

const reviewer = (nodeId: string, slug: string): StageMember =>
  ({ nodeId, kind: "persona", personaId: builtinPersonaId(slug) });

const check = (nodeId: string, slot: WorkflowCheckSlot): StageMember =>
  ({ nodeId, kind: "check", slot });

/** One session action, alone in its own stage - which is the only shape the runtime executes. */
const action = (nodeId: string, sessionActionId: SessionActionId): Stage =>
  ({ kind: "session_action", member: { nodeId, kind: "session_action", sessionActionId } });

/**
 * Intent first as the cheap gate, then the three deep reviews in parallel behind it.
 *
 * There is no point spending three deeper reviews on a change that has already drifted from
 * what was asked, and the three that follow judge disjoint things - risk, evidence and
 * documentation - so they run on the same submission and aggregate into one repair packet at
 * the join rather than sending the session three separate rounds.
 */
const NO_MISTAKES_REVIEW_V1: StagePipeline = {
  sessionId: NO_MISTAKES_REVIEW_NODES.session,
  endId: NO_MISTAKES_REVIEW_NODES.end,
  endOutcome: "Complete",
  stages: [
    {
      kind: "evaluation",
      joinId: null,
      members: [reviewer(NO_MISTAKES_REVIEW_NODES.intent, "intent-conformance-judge")],
    },
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.depth,
      members: [
        reviewer(NO_MISTAKES_REVIEW_NODES.risk, "code-risk-reviewer"),
        reviewer(NO_MISTAKES_REVIEW_NODES.evidence, "test-evidence-auditor"),
        reviewer(NO_MISTAKES_REVIEW_NODES.documentation, "documentation-steward"),
      ],
    },
  ],
};

/**
 * Version 2: the version 1 graph with Live delivery as its binding default.
 *
 * Kept as its own literal so a later graph edit cannot change a version that existing bindings
 * already name.
 */
const NO_MISTAKES_REVIEW_V2: StagePipeline = {
  sessionId: NO_MISTAKES_REVIEW_NODES.session,
  endId: NO_MISTAKES_REVIEW_NODES.end,
  endOutcome: "Complete",
  stages: [
    {
      kind: "evaluation",
      joinId: null,
      members: [reviewer(NO_MISTAKES_REVIEW_NODES.intent, "intent-conformance-judge")],
    },
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.depth,
      members: [
        reviewer(NO_MISTAKES_REVIEW_NODES.risk, "code-risk-reviewer"),
        reviewer(NO_MISTAKES_REVIEW_NODES.evidence, "test-evidence-auditor"),
        reviewer(NO_MISTAKES_REVIEW_NODES.documentation, "documentation-steward"),
      ],
    },
  ],
};

/**
 * Version 3: the same two reviewer stages, behind a deterministic gate.
 *
 * Written out in full rather than composed from version 1's stages, and the duplication is
 * the POINT. A shipped version is frozen for its lifetime, so these literals are a changelog,
 * not a DRY opportunity: shared stage arrays would mean an edit intended for version 4
 * silently rewriting the graph two years of bindings are already pinned to, and the test that
 * pins version 1 against a literal would be the only thing between that and an operator.
 *
 * The gate is first because a change that does not compile should not cost four model calls.
 * The two checks sit in ONE stage, so `compileStages` emits their named join and both must pass
 * before Intent Conformance is activated - which is why Phase 2's validator had to accept a
 * Check as a Join predecessor.
 *
 * On a machine with no command configured for either slot both checks are `skipped` and pass,
 * so this version behaves exactly as version 2 did. That is what makes shipping check gates in
 * a built-in safe: the workflow is bound on repositories this build has never seen.
 */
const NO_MISTAKES_REVIEW_V3: StagePipeline = {
  sessionId: NO_MISTAKES_REVIEW_NODES.session,
  endId: NO_MISTAKES_REVIEW_NODES.end,
  endOutcome: "Complete",
  stages: [
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.build,
      members: [
        check(NO_MISTAKES_REVIEW_NODES.typecheck, "typecheck"),
        check(NO_MISTAKES_REVIEW_NODES.test, "test"),
      ],
    },
    {
      kind: "evaluation",
      joinId: null,
      members: [reviewer(NO_MISTAKES_REVIEW_NODES.intent, "intent-conformance-judge")],
    },
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.depth,
      members: [
        reviewer(NO_MISTAKES_REVIEW_NODES.risk, "code-risk-reviewer"),
        reviewer(NO_MISTAKES_REVIEW_NODES.evidence, "test-evidence-auditor"),
        reviewer(NO_MISTAKES_REVIEW_NODES.documentation, "documentation-steward"),
      ],
    },
  ],
};

/**
 * Version 8: the version 3 graph with the pull request opened as an authored STAGE.
 *
 * Written out in full for the reason every version above is, and the duplication is again the
 * point: versions 1 through 7 are frozen, and a shared array is one edit away from rewriting a
 * graph existing bindings are pinned to.
 *
 * What changes is where the pull request comes from. Versions 5 through 7 reach End first and
 * then have the completion policy type the handoff, which means the run is already "successful"
 * when the pull request is opened and nothing proves one was. Here the action is a stage like
 * any other: it runs after the reviews have passed, it types the same `pull-request` skill, and
 * its `complete` route reaches End only once an open pull request has been observed at the
 * commit the continuation captured. So End means the same thing it always did - the authored
 * graph succeeded - and by the time the Inspector claims that success there is provably
 * something for it to review.
 *
 * It is LAST among the authored stages and not first, because a pull request is the thing you
 * open once the work has been judged. Its fresh evidence segment therefore feeds End rather
 * than another evaluator, which is the cheapest possible use of a continuation and the reason
 * this version costs no extra model calls.
 */
const NO_MISTAKES_REVIEW_V4: StagePipeline = {
  sessionId: NO_MISTAKES_REVIEW_NODES.session,
  endId: NO_MISTAKES_REVIEW_NODES.end,
  endOutcome: "Complete",
  stages: [
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.build,
      members: [
        check(NO_MISTAKES_REVIEW_NODES.typecheck, "typecheck"),
        check(NO_MISTAKES_REVIEW_NODES.test, "test"),
      ],
    },
    {
      kind: "evaluation",
      joinId: null,
      members: [reviewer(NO_MISTAKES_REVIEW_NODES.intent, "intent-conformance-judge")],
    },
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.depth,
      members: [
        reviewer(NO_MISTAKES_REVIEW_NODES.risk, "code-risk-reviewer"),
        reviewer(NO_MISTAKES_REVIEW_NODES.evidence, "test-evidence-auditor"),
        reviewer(NO_MISTAKES_REVIEW_NODES.documentation, "documentation-steward"),
      ],
    },
    action(NO_MISTAKES_REVIEW_NODES.pullRequest, PULL_REQUEST_SESSION_ACTION_ID),
  ],
};

/**
 * Version 9: the complete version 8 pipeline with local code-quality judgment before the PR.
 *
 * Written out in full so versions 1 through 8 remain immutable. Code Quality Judge is an
 * ordinary tool-less Persona: its fail route returns to Session through the shared repair loop,
 * and only its pass route activates the already-proven Pull Request action. The version's
 * completion policy is `none`, so the verified action reaches End and completes without turning
 * the optional GitHub Inspector into a final gate.
 */
const NO_MISTAKES_REVIEW_V5: StagePipeline = {
  sessionId: NO_MISTAKES_REVIEW_NODES.session,
  endId: NO_MISTAKES_REVIEW_NODES.end,
  endOutcome: "Complete",
  stages: [
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.build,
      members: [
        check(NO_MISTAKES_REVIEW_NODES.typecheck, "typecheck"),
        check(NO_MISTAKES_REVIEW_NODES.test, "test"),
      ],
    },
    {
      kind: "evaluation",
      joinId: null,
      members: [reviewer(NO_MISTAKES_REVIEW_NODES.intent, "intent-conformance-judge")],
    },
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.depth,
      members: [
        reviewer(NO_MISTAKES_REVIEW_NODES.risk, "code-risk-reviewer"),
        reviewer(NO_MISTAKES_REVIEW_NODES.evidence, "test-evidence-auditor"),
        reviewer(NO_MISTAKES_REVIEW_NODES.documentation, "documentation-steward"),
      ],
    },
    {
      kind: "evaluation",
      joinId: null,
      members: [reviewer(NO_MISTAKES_REVIEW_NODES.quality, "code-quality-judge")],
    },
    action(NO_MISTAKES_REVIEW_NODES.pullRequest, PULL_REQUEST_SESSION_ACTION_ID),
  ],
};

/**
 * Version 10: code risk and code quality run together, then evidence and documentation.
 *
 * Written out in full so version 9 remains immutable. Code Risk Reviewer and Code Quality
 * Judge inspect the same submission in stage 3 and aggregate into the existing depth join.
 * Test Evidence Auditor and Documentation Steward then run together in stage 4 and aggregate
 * into a new stable join before the unchanged verified Pull Request action.
 */
const NO_MISTAKES_REVIEW_V6: StagePipeline = {
  sessionId: NO_MISTAKES_REVIEW_NODES.session,
  endId: NO_MISTAKES_REVIEW_NODES.end,
  endOutcome: "Complete",
  stages: [
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.build,
      members: [
        check(NO_MISTAKES_REVIEW_NODES.typecheck, "typecheck"),
        check(NO_MISTAKES_REVIEW_NODES.test, "test"),
      ],
    },
    {
      kind: "evaluation",
      joinId: null,
      members: [reviewer(NO_MISTAKES_REVIEW_NODES.intent, "intent-conformance-judge")],
    },
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.depth,
      members: [
        reviewer(NO_MISTAKES_REVIEW_NODES.risk, "code-risk-reviewer"),
        reviewer(NO_MISTAKES_REVIEW_NODES.quality, "code-quality-judge"),
      ],
    },
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.evidenceDocumentation,
      members: [
        reviewer(NO_MISTAKES_REVIEW_NODES.evidence, "test-evidence-auditor"),
        reviewer(NO_MISTAKES_REVIEW_NODES.documentation, "documentation-steward"),
      ],
    },
    action(NO_MISTAKES_REVIEW_NODES.pullRequest, PULL_REQUEST_SESSION_ACTION_ID),
  ],
};

/**
 * Version 11: code design joins risk and quality in the same parallel code-review stage.
 *
 * Written out in full so version 10 remains immutable, for the reason every literal above is.
 *
 * Code Design Reviewer is a third member of the existing stage 3 rather than a stage of its own,
 * so the version costs one model call per round and no extra wall-clock stage: the three judge the
 * same submission and aggregate at the same depth join, which means a design finding reaches the
 * session in the SAME repair packet as a risk finding instead of as a second round arguing about
 * the same code. It sits here and not ahead of the deep reviews because a design objection is not
 * a cheap gate - it costs a model call to reach either way, and gating on it first would delay
 * risk feedback on a change whose shape is merely arguable.
 *
 * The role's guidance is scoped to the submitted change and forbids demanding a redesign as the
 * price of passing, which is what makes it safe to put in a blocking stage of the flagship
 * built-in rather than in an advisory position outside it.
 */
const NO_MISTAKES_REVIEW_V7: StagePipeline = {
  sessionId: NO_MISTAKES_REVIEW_NODES.session,
  endId: NO_MISTAKES_REVIEW_NODES.end,
  endOutcome: "Complete",
  stages: [
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.build,
      members: [
        check(NO_MISTAKES_REVIEW_NODES.typecheck, "typecheck"),
        check(NO_MISTAKES_REVIEW_NODES.test, "test"),
      ],
    },
    {
      kind: "evaluation",
      joinId: null,
      members: [reviewer(NO_MISTAKES_REVIEW_NODES.intent, "intent-conformance-judge")],
    },
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.depth,
      members: [
        reviewer(NO_MISTAKES_REVIEW_NODES.risk, "code-risk-reviewer"),
        reviewer(NO_MISTAKES_REVIEW_NODES.quality, "code-quality-judge"),
        reviewer(NO_MISTAKES_REVIEW_NODES.design, "code-design-reviewer"),
      ],
    },
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.evidenceDocumentation,
      members: [
        reviewer(NO_MISTAKES_REVIEW_NODES.evidence, "test-evidence-auditor"),
        reviewer(NO_MISTAKES_REVIEW_NODES.documentation, "documentation-steward"),
      ],
    },
    action(NO_MISTAKES_REVIEW_NODES.pullRequest, PULL_REQUEST_SESSION_ACTION_ID),
  ],
};

/**
 * Version 12: Slop Filter joins Test Evidence and Documentation in stage 4.
 *
 * Written out in full so version 11 remains immutable. Slop Filter judges low-signal artifacts
 * in the same submission the evidence and documentation roles already inspect, so all three run
 * in parallel and contribute to one repair packet. The stage count, verified Pull Request action,
 * completion posture, and binding defaults do not change.
 */
const NO_MISTAKES_REVIEW_V8: StagePipeline = {
  sessionId: NO_MISTAKES_REVIEW_NODES.session,
  endId: NO_MISTAKES_REVIEW_NODES.end,
  endOutcome: "Complete",
  stages: [
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.build,
      members: [
        check(NO_MISTAKES_REVIEW_NODES.typecheck, "typecheck"),
        check(NO_MISTAKES_REVIEW_NODES.test, "test"),
      ],
    },
    {
      kind: "evaluation",
      joinId: null,
      members: [reviewer(NO_MISTAKES_REVIEW_NODES.intent, "intent-conformance-judge")],
    },
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.depth,
      members: [
        reviewer(NO_MISTAKES_REVIEW_NODES.risk, "code-risk-reviewer"),
        reviewer(NO_MISTAKES_REVIEW_NODES.quality, "code-quality-judge"),
        reviewer(NO_MISTAKES_REVIEW_NODES.design, "code-design-reviewer"),
      ],
    },
    {
      kind: "evaluation",
      joinId: NO_MISTAKES_REVIEW_NODES.evidenceDocumentation,
      members: [
        reviewer(NO_MISTAKES_REVIEW_NODES.evidence, "test-evidence-auditor"),
        reviewer(NO_MISTAKES_REVIEW_NODES.documentation, "documentation-steward"),
        reviewer(NO_MISTAKES_REVIEW_NODES.slop, "slop-filter"),
      ],
    },
    action(NO_MISTAKES_REVIEW_NODES.pullRequest, PULL_REQUEST_SESSION_ACTION_ID),
  ],
};

/**
 * The binding posture shipped before Foreman Complete became the application default.
 *
 * Built-in versions are immutable app data: deriving versions 1-5 from today's default would
 * silently change existing bindings when that default changes. Keep their historical values
 * explicit, and use the shared default only for the newly appended current version.
 */
const LEGACY_WORKFLOW_BINDING_DEFAULTS: WorkflowBindingDefaults = {
  triggerMode: "manual",
  deliveryMode: "preview",
  maxRepairRounds: 5,
};

const NO_MISTAKES_REVIEW_LEGACY_LIVE_DEFAULTS: WorkflowBindingDefaults = {
  ...LEGACY_WORKFLOW_BINDING_DEFAULTS,
  deliveryMode: "live",
};

const NO_MISTAKES_REVIEW_LIVE_DEFAULTS: WorkflowBindingDefaults = {
  ...DEFAULT_WORKFLOW_BINDING_DEFAULTS,
  deliveryMode: "live",
};

/**
 * The resumption posture every version shipped before the engine could resume itself.
 *
 * Written out rather than derived from `LEGACY_WORKFLOW_RESUMPTION_POLICY` for the reason
 * `LEGACY_WORKFLOW_BINDING_DEFAULTS` states: these six literals are a changelog of what was
 * shipped, and a shared constant is one edit away from rewriting six frozen versions.
 */
const SHIPPED_MANUAL_RESUMPTION = "manual" as const;

export const BUILTIN_WORKFLOWS: readonly BuiltinWorkflow[] = [
  builtinWorkflow({
    slug: NO_MISTAKES_REVIEW_WORKFLOW_SLUG,
    name: "No-Mistakes Review",
    description:
      "Typecheck and test, then seven built-in review roles: Intent Conformance first; Code Risk, "
      + "Code Quality and Code Design in parallel; then Test Evidence and Documentation in "
      + "parallel with Slop Filter. Configured checks run for real, while unconfigured slots skip "
      + "and pass. Every "
      + "failure returns to the session for repair. The current version finishes both review "
      + "stages before opening and verifying the pull request, then completes without requiring "
      + "the optional GitHub Inspector gate.",
    // Versions 1 and 2 remain addressable exactly as shipped. Version 2 changed only the
    // binding posture; version 3 appends the deterministic gate and retains Live delivery.
    // Version 4 keeps that graph but repairs Inspector findings by repushing, then checking
    // Inspector again instead of rerunning the already-passed review workflow. Version 5
    // automatically hands a passed, PR-less review back to the session for shipping. Version
    // 6 makes Foreman Complete the default trigger without rewriting any prior binding posture.
    // Version 7 turns on engine-owned resumption, so a parked repair round no longer waits on
    // a human click; versions 1-6 keep the `manual` posture they were published with.
    versions: [
      {
        pipeline: NO_MISTAKES_REVIEW_V1,
        completionPolicy: {
          kind: "inspector",
          onFindings: "restart_workflow",
          missingPrAction: "offer_prepare_pr",
        },
        resumptionPolicy: SHIPPED_MANUAL_RESUMPTION,
        bindingDefaults: LEGACY_WORKFLOW_BINDING_DEFAULTS,
        sourceDraftRevision: 1,
      },
      {
        pipeline: NO_MISTAKES_REVIEW_V2,
        completionPolicy: {
          kind: "inspector",
          onFindings: "restart_workflow",
          missingPrAction: "offer_prepare_pr",
        },
        resumptionPolicy: SHIPPED_MANUAL_RESUMPTION,
        bindingDefaults: NO_MISTAKES_REVIEW_LEGACY_LIVE_DEFAULTS,
        sourceDraftRevision: 1,
      },
      {
        pipeline: NO_MISTAKES_REVIEW_V3,
        completionPolicy: {
          kind: "inspector",
          onFindings: "restart_workflow",
          missingPrAction: "offer_prepare_pr",
        },
        resumptionPolicy: SHIPPED_MANUAL_RESUMPTION,
        bindingDefaults: NO_MISTAKES_REVIEW_LEGACY_LIVE_DEFAULTS,
        sourceDraftRevision: 2,
      },
      {
        pipeline: NO_MISTAKES_REVIEW_V3,
        completionPolicy: {
          kind: "inspector",
          onFindings: "inspector_only",
          missingPrAction: "offer_prepare_pr",
        },
        resumptionPolicy: SHIPPED_MANUAL_RESUMPTION,
        bindingDefaults: NO_MISTAKES_REVIEW_LEGACY_LIVE_DEFAULTS,
        sourceDraftRevision: 3,
      },
      {
        pipeline: NO_MISTAKES_REVIEW_V3,
        completionPolicy: {
          kind: "inspector",
          onFindings: "inspector_only",
          missingPrAction: "prepare_pr",
        },
        resumptionPolicy: SHIPPED_MANUAL_RESUMPTION,
        bindingDefaults: NO_MISTAKES_REVIEW_LEGACY_LIVE_DEFAULTS,
        sourceDraftRevision: 4,
      },
      {
        pipeline: NO_MISTAKES_REVIEW_V3,
        completionPolicy: {
          kind: "inspector",
          onFindings: "inspector_only",
          missingPrAction: "prepare_pr",
        },
        resumptionPolicy: SHIPPED_MANUAL_RESUMPTION,
        bindingDefaults: NO_MISTAKES_REVIEW_LIVE_DEFAULTS,
        sourceDraftRevision: 5,
      },
      {
        // Version 7: the version 6 graph and binding posture, with the repair loop closed.
        //
        // `resumptionPolicy: "auto"` is the whole change, and it is what makes the rest of
        // this version's posture mean what it says: Live delivery types the repair packet
        // into the pane, and the engine now picks the round back up itself once that session
        // has settled with new work, instead of parking in `waiting_for_session` until a
        // human clicks Resubmit. `onFindings: "inspector_only"` is unaffected - that policy
        // parks in `waiting_for_new_head`, which the observer never touches, because an
        // Inspector repair is resolved by a pushed head the poller observes.
        pipeline: NO_MISTAKES_REVIEW_V3,
        completionPolicy: {
          kind: "inspector",
          onFindings: "inspector_only",
          missingPrAction: "prepare_pr",
        },
        resumptionPolicy: "auto",
        bindingDefaults: NO_MISTAKES_REVIEW_LIVE_DEFAULTS,
        sourceDraftRevision: 6,
      },
      {
        // Version 8: the pull request becomes an authored stage before End.
        //
        // `missingPrAction: "wait"` is the half of this that is easy to get wrong. Versions 5
        // through 7 say `prepare_pr` because in those versions nothing has opened a pull
        // request by the time the gate is entered, so the gate has to. Here the graph cannot
        // reach End without one - that is what the action's completion proved - so a gate that
        // found none has met a state its own preparation would not fix, and typing a second
        // handoff into the session would be asking for a pull request the run already has.
        // Waiting is the honest answer, and the operator still has Prepare PR by hand.
        pipeline: NO_MISTAKES_REVIEW_V4,
        completionPolicy: {
          kind: "inspector",
          onFindings: "inspector_only",
          missingPrAction: "wait",
        },
        resumptionPolicy: "auto",
        bindingDefaults: NO_MISTAKES_REVIEW_LIVE_DEFAULTS,
        sourceDraftRevision: 7,
      },
      {
        // Version 9: local code-quality judgment precedes the verified Pull Request action.
        //
        // `completionPolicy: none` is deliberate. The graph owns the local review and cannot
        // reach End until the action has observed an open pull request at the continuation's
        // captured commit. GitHub Inspector remains an optional remote service and still owns
        // its review ledger, public GitHub behavior, and exact-head Shipping proof.
        pipeline: NO_MISTAKES_REVIEW_V5,
        completionPolicy: { kind: "none" },
        resumptionPolicy: "auto",
        bindingDefaults: NO_MISTAKES_REVIEW_LIVE_DEFAULTS,
        sourceDraftRevision: 8,
      },
      {
        // Version 10: Code Quality Judge moves alongside Code Risk Reviewer in stage 3.
        //
        // Test Evidence Auditor and Documentation Steward form stage 4, still before the
        // verified Pull Request action. The completion posture remains local: GitHub
        // Inspector is optional and Shipping continues to own its remote exact-head proof.
        pipeline: NO_MISTAKES_REVIEW_V6,
        completionPolicy: { kind: "none" },
        resumptionPolicy: "auto",
        bindingDefaults: NO_MISTAKES_REVIEW_LIVE_DEFAULTS,
        sourceDraftRevision: 9,
      },
      {
        // Version 11: Code Design Reviewer joins stage 3's parallel code review.
        //
        // Nothing else moves. Stage 4, the verified Pull Request action, the local completion
        // posture and the binding defaults are all version 10's, so the only difference an
        // operator rebinding from 10 to 11 gets is a third judgment on the same submission.
        pipeline: NO_MISTAKES_REVIEW_V7,
        completionPolicy: { kind: "none" },
        resumptionPolicy: "auto",
        bindingDefaults: NO_MISTAKES_REVIEW_LIVE_DEFAULTS,
        sourceDraftRevision: 10,
      },
      {
        // Version 12: Slop Filter joins stage 4's parallel review.
        //
        // Versions 1 through 11 remain frozen. Stage 4 still produces one all-pass result and
        // one repair packet, and nothing changes after it, so the new version adds one focused
        // judgment without adding a serial stage or changing publication behavior.
        pipeline: NO_MISTAKES_REVIEW_V8,
        completionPolicy: { kind: "none" },
        resumptionPolicy: "auto",
        bindingDefaults: NO_MISTAKES_REVIEW_LIVE_DEFAULTS,
        sourceDraftRevision: 11,
      },
    ],
  }),
];
