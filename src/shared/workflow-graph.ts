import type {
  Persona,
  WorkflowCompletionPolicy,
  WorkflowDiagnostic,
  WorkflowDraftGraph,
  WorkflowDraftNode,
  WorkflowEdge,
  WorkflowSourcePort,
  WorkflowTargetPort,
  WorkflowValidationResult,
} from "./workflow.ts";
import { WORKFLOW_LIMITS } from "./workflow.ts";

export interface WorkflowGraphValidationInput {
  graph: WorkflowDraftGraph;
  personas?: readonly Pick<Persona, "id" | "archivedAt">[];
  completionPolicy?: WorkflowCompletionPolicy;
}

const sourcePorts: Record<WorkflowDraftNode["kind"], readonly WorkflowSourcePort[]> = {
  session: ["submitted"],
  persona: ["pass", "fail"],
  all_pass: ["pass", "fail"],
  check: ["pass", "fail"],
  end: [],
};

const targetPorts: Record<WorkflowDraftNode["kind"], readonly WorkflowTargetPort[]> = {
  session: ["return_for_changes"],
  persona: ["activate"],
  all_pass: ["result"],
  check: ["activate"],
  end: ["terminal"],
};

/**
 * How each kind is spoken to a human in a diagnostic.
 *
 * A lookup rather than the two-way ternary this replaced: that ternary said "Persona" for
 * everything that was not a Join, so the third kind to route through it would have been
 * diagnosed under another kind's name.
 */
const NODE_LABELS: Record<WorkflowDraftNode["kind"], string> = {
  session: "Session",
  persona: "Persona",
  all_pass: "Join",
  check: "Check",
  end: "End",
};

/** Kinds that decide an outcome, so both routes off them have to exist. */
const OUTCOME_KINDS: readonly WorkflowDraftNode["kind"][] = ["persona", "all_pass", "check"];

const diagnostic = (
  code: WorkflowDiagnostic["code"],
  message: string,
  at: Pick<WorkflowDiagnostic, "nodeId" | "edgeId"> = {},
): WorkflowDiagnostic => ({ code, severity: "error", message, ...at });

function duplicates(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return repeated;
}

function graphBytes(graph: WorkflowDraftGraph): number {
  try {
    return new TextEncoder().encode(JSON.stringify(graph)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function policyValid(policy: WorkflowCompletionPolicy | undefined): boolean {
  if (policy === undefined || policy.kind === "none") return true;
  return policy.kind === "inspector" &&
    (policy.onFindings === "restart_workflow" || policy.onFindings === "inspector_only") &&
    (policy.missingPrAction === "wait" || policy.missingPrAction === "offer_prepare_pr");
}

/** Tarjan SCC over the already-filtered adjacency map. */
function stronglyConnected(nodes: readonly string[], outgoing: Map<string, string[]>): string[][] {
  let nextIndex = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (id: string): void => {
    index.set(id, nextIndex);
    low.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);
    for (const target of outgoing.get(id) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(id, Math.min(low.get(id)!, low.get(target)!));
      } else if (onStack.has(target)) {
        low.set(id, Math.min(low.get(id)!, index.get(target)!));
      }
    }
    if (low.get(id) !== index.get(id)) return;
    const component: string[] = [];
    while (stack.length) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    components.push(component);
  };

  for (const id of nodes) if (!index.has(id)) visit(id);
  return components;
}

/**
 * Authoritative, browser-safe graph validation. The browser and daemon call this exact
 * function; persistence schemas still reject malformed JSON before it reaches here.
 */
export function validateWorkflowGraph(input: WorkflowGraphValidationInput): WorkflowValidationResult {
  const { graph } = input;
  const diagnostics: WorkflowDiagnostic[] = [];
  if (graph.nodes.length > WORKFLOW_LIMITS.graphNodes) {
    diagnostics.push(diagnostic("node_limit", `Workflows support at most ${WORKFLOW_LIMITS.graphNodes} nodes.`));
  }
  if (graph.edges.length > WORKFLOW_LIMITS.graphEdges) {
    diagnostics.push(diagnostic("edge_limit", `Workflows support at most ${WORKFLOW_LIMITS.graphEdges} edges.`));
  }
  if (graphBytes(graph) > WORKFLOW_LIMITS.graphJsonBytes) {
    diagnostics.push(diagnostic("graph_size", `Workflow graph exceeds ${WORKFLOW_LIMITS.graphJsonBytes} UTF-8 bytes.`));
  }

  for (const id of duplicates(graph.nodes.map((node) => node.id))) {
    diagnostics.push(diagnostic("duplicate_node_id", `Node id “${id}” is used more than once.`, { nodeId: id }));
  }
  for (const id of duplicates(graph.edges.map((edge) => edge.id))) {
    diagnostics.push(diagnostic("duplicate_edge_id", `Edge id “${id}” is used more than once.`, { edgeId: id }));
  }

  const nodes = new Map<string, WorkflowDraftNode>();
  for (const node of graph.nodes) {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) {
      diagnostics.push(diagnostic("invalid_position", "Node coordinates must be finite numbers.", { nodeId: node.id }));
    } else if (
      Math.abs(node.position.x) > WORKFLOW_LIMITS.canvasCoordinateAbs ||
      Math.abs(node.position.y) > WORKFLOW_LIMITS.canvasCoordinateAbs
    ) {
      diagnostics.push(diagnostic("coordinate_limit", `Node coordinates must stay within ±${WORKFLOW_LIMITS.canvasCoordinateAbs}.`, { nodeId: node.id }));
    }
  }

  const sessions = graph.nodes.filter((node) => node.kind === "session");
  if (sessions.length === 0) diagnostics.push(diagnostic("missing_session", "Add exactly one Session node."));
  if (sessions.length > 1) diagnostics.push(diagnostic("multiple_sessions", "A workflow may contain only one Session node."));
  if (!graph.nodes.some((node) => node.kind === "end")) diagnostics.push(diagnostic("missing_end", "Add at least one End node."));
  if (!policyValid(input.completionPolicy)) {
    diagnostics.push(diagnostic("invalid_completion_policy", "Choose a supported final-gate policy."));
  }

  const validEdges: WorkflowEdge[] = [];
  for (const edge of graph.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) {
      diagnostics.push(diagnostic("dangling_edge", "Edge references a node that does not exist.", { edgeId: edge.id }));
      continue;
    }
    let valid = true;
    if (!sourcePorts[source.kind].includes(edge.sourcePort)) {
      diagnostics.push(diagnostic("invalid_source_port", `${source.kind} cannot emit “${edge.sourcePort}”.`, { edgeId: edge.id, nodeId: source.id }));
      valid = false;
    }
    if (!targetPorts[target.kind].includes(edge.targetPort)) {
      diagnostics.push(diagnostic("invalid_target_port", `${target.kind} cannot receive “${edge.targetPort}”.`, { edgeId: edge.id, nodeId: target.id }));
      valid = false;
    }
    if (target.kind === "session" && (edge.sourcePort !== "fail" || edge.targetPort !== "return_for_changes")) {
      diagnostics.push(diagnostic("session_return_route", "Only a fail route may return work to Session.", { edgeId: edge.id, nodeId: target.id }));
      valid = false;
    }
    if (valid) validEdges.push(edge);
  }

  const outgoingEdges = (id: string): WorkflowEdge[] => validEdges.filter((edge) => edge.source === id);
  for (const session of sessions) {
    // At-least-one, not exactly-one: parallel first-wave review is N reviewers on one submission,
    // and the engine already writes one idempotent receipt per outgoing edge. Zero routes is still
    // an error - nothing would ever run.
    const submitted = outgoingEdges(session.id).filter((edge) => edge.sourcePort === "submitted");
    if (submitted.length === 0) {
      diagnostics.push(diagnostic("session_submitted_route", "Session needs a submitted route.", { nodeId: session.id }));
    }
  }
  for (const node of graph.nodes) {
    if (!OUTCOME_KINDS.includes(node.kind)) continue;
    const outgoing = outgoingEdges(node.id);
    if (!outgoing.some((edge) => edge.sourcePort === "pass")) {
      diagnostics.push(diagnostic("missing_pass_route", `${NODE_LABELS[node.kind]} needs a pass route.`, { nodeId: node.id }));
    }
    if (!outgoing.some((edge) => edge.sourcePort === "fail")) {
      diagnostics.push(diagnostic("missing_fail_route", `${NODE_LABELS[node.kind]} needs a fail route.`, { nodeId: node.id }));
    }
  }

  for (const join of graph.nodes.filter((node) => node.kind === "all_pass")) {
    const incoming = validEdges.filter((edge) => edge.target === join.id && edge.targetPort === "result");
    const predecessorIds = [...new Set(incoming.map((edge) => edge.source))];
    if (predecessorIds.length < 2) {
      diagnostics.push(diagnostic("join_predecessors", "An all-pass Join needs at least two distinct predecessors.", { nodeId: join.id }));
    }
    for (const predecessorId of predecessorIds) {
      const predecessor = nodes.get(predecessorId)!;
      // Anything that decides a pass/fail outcome may feed a Join, which is now three kinds.
      // Session and End are still refused: one produces a submission rather than a verdict,
      // and the other consumes one.
      if (!OUTCOME_KINDS.includes(predecessor.kind)) {
        diagnostics.push(diagnostic("join_predecessor_kind", "A Join predecessor must be a Persona, a Check, or another Join.", { nodeId: join.id }));
      }
      for (const port of ["pass", "fail"] as const) {
        const count = incoming.filter((edge) => edge.source === predecessorId && edge.sourcePort === port).length;
        if (count === 0) diagnostics.push(diagnostic("join_missing_outcome", `Join predecessor “${predecessorId}” is missing its ${port} route.`, { nodeId: join.id }));
        if (count > 1) diagnostics.push(diagnostic("join_duplicate_outcome", `Join predecessor “${predecessorId}” has more than one ${port} route.`, { nodeId: join.id }));
      }
    }
  }

  if (input.personas) {
    const personas = new Map(input.personas.map((persona) => [persona.id, persona]));
    for (const node of graph.nodes) {
      if (node.kind !== "persona") continue;
      const persona = personas.get(node.personaId);
      if (!persona) diagnostics.push(diagnostic("missing_persona", "Persona no longer exists.", { nodeId: node.id }));
      else if (persona.archivedAt !== null) diagnostics.push(diagnostic("archived_persona", "Archived Personas cannot be published in a new version.", { nodeId: node.id }));
    }
  }

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of nodes.keys()) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const edge of validEdges) {
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
  }
  const sessionId = sessions.length === 1 ? sessions[0]!.id : null;
  if (sessionId) {
    const reachable = new Set<string>([sessionId]);
    const queue = [sessionId];
    while (queue.length) {
      for (const id of outgoing.get(queue.shift()!) ?? []) {
        if (!reachable.has(id)) { reachable.add(id); queue.push(id); }
      }
    }
    for (const node of graph.nodes) if (!reachable.has(node.id)) {
      diagnostics.push(diagnostic("unreachable_node", "Node cannot be reached from Session.", { nodeId: node.id }));
    }

    const terminating = new Set<string>([
      sessionId,
      ...graph.nodes.filter((node) => node.kind === "end").map((node) => node.id),
    ]);
    const reverseQueue = [...terminating];
    while (reverseQueue.length) {
      for (const id of incoming.get(reverseQueue.shift()!) ?? []) {
        if (!terminating.has(id)) { terminating.add(id); reverseQueue.push(id); }
      }
    }
    for (const node of graph.nodes) if (reachable.has(node.id) && !terminating.has(node.id)) {
      diagnostics.push(diagnostic("no_terminal_path", "Node cannot reach an End or return work to Session.", { nodeId: node.id }));
    }

    for (const component of stronglyConnected([...nodes.keys()], outgoing)) {
      const cyclic = component.length > 1 || (outgoing.get(component[0]!) ?? []).includes(component[0]!);
      if (cyclic && !component.includes(sessionId)) {
        diagnostics.push(diagnostic("cycle_without_session", "Every workflow cycle must return through Session.", { nodeId: component[0] }));
      }
    }
  }

  return { valid: diagnostics.every((item) => item.severity !== "error"), diagnostics };
}

/** Cheap drop-time validation used by the canvas before it creates an edge. */
export function connectionAllowed(
  source: WorkflowDraftNode,
  sourcePort: WorkflowSourcePort,
  target: WorkflowDraftNode,
  targetPort: WorkflowTargetPort,
): boolean {
  return sourcePorts[source.kind].includes(sourcePort) &&
    targetPorts[target.kind].includes(targetPort) &&
    (target.kind !== "session" || (sourcePort === "fail" && targetPort === "return_for_changes"));
}
