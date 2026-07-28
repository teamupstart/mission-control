import {
  DEFAULT_WORKFLOW_BINDING_DEFAULTS,
  normalizeWorkflowName,
  type PersonaId,
  type PersonaSnapshot,
  type PublishedWorkflowGraph,
  type WorkflowCompletionPolicy,
  type WorkflowDefinition,
  type WorkflowCheckSlot,
  type WorkflowDraftGraph,
  type WorkflowEdge,
  type WorkflowBindingDefaults,
  type WorkflowVersion,
} from "@shared/workflow.ts";
import { CreateWorkflowSchema } from "@shared/protocol.ts";
import { compileStages, type StageMember, type StagePipeline } from "@shared/workflow-stages.ts";
import { BUILTIN_PERSONAS, builtinPersonaId } from "./builtin-personas.ts";

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
 * rule lives in the plan: a change to a `docs/personas/*.md` document a shipped built-in
 * references appends a new built-in workflow version in the same commit.
 */
export const BUILTIN_WORKFLOW_ID_PREFIX = "builtin-workflow:";

/**
 * Durable and human-readable.
 *
 * The prefix deliberately differs from `BUILTIN_PERSONA_ID_PREFIX`, so a lookup that reached
 * for the wrong catalog finds nothing rather than finding a Persona where a workflow was
 * meant.
 */
export function builtinWorkflowId(slug: string): string {
  return `${BUILTIN_WORKFLOW_ID_PREFIX}${slug}`;
}

/** The synthetic version id a binding or a run stores. Append-only, per version. */
export function builtinWorkflowVersionId(slug: string, version: number): string {
  return `${builtinWorkflowId(slug)}@${version}`;
}

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
    ...pipeline.stages.flatMap((stage) => [
      ...(stage.members.length > 1 && stage.joinId !== null ? [stage.joinId] : []),
      ...stage.members.map((member) => member.nodeId ?? ""),
    ]),
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
  return {
    sourcePersonaId: persona.id,
    sourceRevision: persona.revision,
    name: persona.name,
    description: persona.description,
    guidanceMarkdown: persona.guidanceMarkdown,
    runner: persona.runner,
    model: persona.model,
  };
}

/** The same draft-to-published projection `publishWorkflow` performs, over the shipped graph. */
function publishBuiltinGraph(graph: WorkflowDraftGraph): PublishedWorkflowGraph {
  return {
    nodes: graph.nodes.map((node) =>
      node.kind === "persona"
        ? {
            id: node.id,
            kind: "persona" as const,
            position: node.position,
            persona: builtinPersonaSnapshot(node.personaId),
          }
        : node),
    edges: graph.edges,
  };
}

interface BuiltinWorkflowSource {
  slug: string;
  name: string;
  description: string;
  /** Ascending. Index 0 is version 1, and the last entry is what the draft shows. */
  versions: readonly {
    pipeline: StagePipeline;
    completionPolicy: WorkflowCompletionPolicy;
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

const NO_MISTAKES_REVIEW_SLUG = "no-mistakes-review";

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
  end: "nmr-end",
} as const;

const reviewer = (nodeId: string, slug: string): StageMember =>
  ({ nodeId, kind: "persona", personaId: builtinPersonaId(slug) });

const check = (nodeId: string, slot: WorkflowCheckSlot): StageMember =>
  ({ nodeId, kind: "check", slot });

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
      joinId: null,
      members: [reviewer(NO_MISTAKES_REVIEW_NODES.intent, "intent-conformance-judge")],
    },
    {
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
      joinId: null,
      members: [reviewer(NO_MISTAKES_REVIEW_NODES.intent, "intent-conformance-judge")],
    },
    {
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
      joinId: NO_MISTAKES_REVIEW_NODES.build,
      members: [
        check(NO_MISTAKES_REVIEW_NODES.typecheck, "typecheck"),
        check(NO_MISTAKES_REVIEW_NODES.test, "test"),
      ],
    },
    {
      joinId: null,
      members: [reviewer(NO_MISTAKES_REVIEW_NODES.intent, "intent-conformance-judge")],
    },
    {
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

export const BUILTIN_WORKFLOWS: readonly BuiltinWorkflow[] = [
  builtinWorkflow({
    slug: NO_MISTAKES_REVIEW_SLUG,
    name: "No-Mistakes Review",
    description:
      "A typecheck and test stage, then four built-in review roles composed as designed: "
      + "Intent Conformance as the cheap first judge, then Code Risk, "
      + "Test Evidence and Documentation in parallel behind it. This build does not yet spawn "
      + "configured commands, so configured checks are recorded as not run and passed; "
      + "unconfigured slots are skipped and pass. Every fail returns to the session for repair, "
      + "and a passed review is gated on the Inspector finding nothing on the pull request.",
    // Versions 1 and 2 remain addressable exactly as shipped. Version 2 changed only the
    // binding posture; version 3 appends the deterministic gate and retains Live delivery.
    // Version 4 keeps that graph but repairs Inspector findings by repushing, then checking
    // Inspector again instead of rerunning the already-passed review workflow. Version 5
    // automatically hands a passed, PR-less review back to the session for shipping. Version
    // 6 makes Foreman Complete the default trigger without rewriting any prior binding posture.
    versions: [
      {
        pipeline: NO_MISTAKES_REVIEW_V1,
        completionPolicy: {
          kind: "inspector",
          onFindings: "restart_workflow",
          missingPrAction: "offer_prepare_pr",
        },
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
        bindingDefaults: NO_MISTAKES_REVIEW_LIVE_DEFAULTS,
        sourceDraftRevision: 5,
      },
    ],
  }),
];
