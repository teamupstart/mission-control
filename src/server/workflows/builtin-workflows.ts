import {
  DEFAULT_WORKFLOW_BINDING_DEFAULTS,
  normalizeWorkflowName,
  type PersonaId,
  type PersonaSnapshot,
  type PublishedWorkflowGraph,
  type WorkflowCompletionPolicy,
  type WorkflowDefinition,
  type WorkflowDraftGraph,
  type WorkflowEdge,
  type WorkflowVersion,
} from "@shared/workflow.ts";
import { compileStages, type StagePipeline } from "@shared/workflow-stages.ts";
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
  completionPolicy: WorkflowCompletionPolicy;
  /** Ascending. Index 0 is version 1, and the last entry is what the draft shows. */
  pipelines: readonly StagePipeline[];
}

function builtinWorkflow(source: BuiltinWorkflowSource): BuiltinWorkflow {
  if (source.pipelines.length === 0) {
    throw new Error(`built-in workflow ${source.slug} ships no published version`);
  }
  const graphs = source.pipelines.map(compileBuiltinGraph);
  const versions = graphs.map((graph, index) => ({
    id: builtinWorkflowVersionId(source.slug, index + 1),
    workflowId: builtinWorkflowId(source.slug),
    version: index + 1,
    // A built-in has one draft revision, because a build has exactly one copy of the graph.
    sourceDraftRevision: 1,
    graph: publishBuiltinGraph(graph),
    completionPolicy: source.completionPolicy,
    bindingDefaults: DEFAULT_WORKFLOW_BINDING_DEFAULTS,
    // Not published on this machine and carrying no edit history, so there is no instant to
    // report. Surfaces print "Built-in" where they print a row's dates.
    publishedAt: 0,
  }));
  const current = versions[versions.length - 1]!;
  return {
    definition: {
      id: builtinWorkflowId(source.slug),
      name: source.name,
      normalizedName: normalizeWorkflowName(source.name),
      description: source.description,
      draft: graphs[graphs.length - 1]!,
      completionPolicy: source.completionPolicy,
      bindingDefaults: DEFAULT_WORKFLOW_BINDING_DEFAULTS,
      draftRevision: 1,
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
 * Node identities for No-Mistakes Review version 1.
 *
 * Named after the role rather than the position, because a later version may reorder the
 * stages and the id has to keep meaning the same reviewer to every attempt row already
 * written against it.
 */
const NO_MISTAKES_REVIEW_NODES = {
  session: "nmr-session",
  intent: "nmr-intent-conformance",
  risk: "nmr-code-risk",
  evidence: "nmr-test-evidence",
  documentation: "nmr-documentation",
  depth: "nmr-depth-join",
  end: "nmr-end",
} as const;

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
      members: [{
        nodeId: NO_MISTAKES_REVIEW_NODES.intent,
        personaId: builtinPersonaId("intent-conformance-judge"),
      }],
    },
    {
      joinId: NO_MISTAKES_REVIEW_NODES.depth,
      members: [
        {
          nodeId: NO_MISTAKES_REVIEW_NODES.risk,
          personaId: builtinPersonaId("code-risk-reviewer"),
        },
        {
          nodeId: NO_MISTAKES_REVIEW_NODES.evidence,
          personaId: builtinPersonaId("test-evidence-auditor"),
        },
        {
          nodeId: NO_MISTAKES_REVIEW_NODES.documentation,
          personaId: builtinPersonaId("documentation-steward"),
        },
      ],
    },
  ],
};

export const BUILTIN_WORKFLOWS: readonly BuiltinWorkflow[] = [
  builtinWorkflow({
    slug: NO_MISTAKES_REVIEW_SLUG,
    name: "No-Mistakes Review",
    description:
      "The four built-in review roles, composed the way they were written to compose: Intent "
      + "Conformance as the cheap first gate, then Code Risk, Test Evidence and Documentation "
      + "in parallel behind it. Every fail returns to the session for repair, and a passed "
      + "review is gated on the Inspector finding nothing on the pull request.",
    // The delivery tail the engine already owns: a passed graph waits on an adopted PR at the
    // reviewed head, findings restart the whole review, and a run with no PR yet offers
    // Prepare PR in session rather than waiting silently.
    completionPolicy: {
      kind: "inspector",
      onFindings: "restart_workflow",
      missingPrAction: "offer_prepare_pr",
    },
    pipelines: [NO_MISTAKES_REVIEW_V1],
  }),
];
