import type {
  Persona,
  SessionAction,
  WorkflowCompletionPolicy,
  WorkflowDiagnostic,
  WorkflowDiagnosticCode,
  WorkflowDraftGraph,
  WorkflowDraftNode,
  WorkflowEdge,
  WorkflowSourcePort,
  WorkflowTargetPort,
  WorkflowValidationResult,
} from "./workflow.ts";
import { WORKFLOW_LIMITS, WORKFLOW_MISSING_PR_ACTIONS } from "./workflow.ts";

export interface WorkflowGraphValidationInput {
  graph: WorkflowDraftGraph;
  personas?: readonly Pick<Persona, "id" | "archivedAt">[];
  /**
   * Optional for `personas`' reason: a caller that only wants structural answers should not
   * have to hold a catalog, and reference diagnostics must not fire merely because nobody
   * supplied one. Pass it wherever a missing or archived source should block a publish.
   */
  sessionActions?: readonly Pick<SessionAction, "id" | "archivedAt">[];
  completionPolicy?: WorkflowCompletionPolicy;
  /**
   * Whether the CALLER's build can execute an action node. Defaults to this build's answer.
   *
   * A parameter rather than a bare module read for the reason `WorkflowStore.builtins` is
   * injectable: the snapshot and transaction rules have to be provable without depending on
   * which phase happens to be shipping. Production callers omit it.
   */
  sessionActionRuntimeAvailable?: boolean;
}

/**
 * Whether this build can EXECUTE a published `session_action` node.
 *
 * Phase 1 ships the durable representation - catalog, snapshot, node, ports, stage shape -
 * and deliberately not the runtime that delivers an action turn, waits for it, and captures
 * the continuation evidence. Publishing a graph containing one would mint an immutable
 * version that no daemon in this build can run: every run binding it would park forever with
 * nothing on screen to say why.
 *
 * A single named constant rather than a condition spread across the validator, the store and
 * the browser, so Phase 2 turns the capability on by flipping ONE value and deleting the
 * diagnostic it feeds. Drafts still save, so API round trips and fixtures keep working.
 */
export const SESSION_ACTION_RUNTIME_AVAILABLE = false;

/**
 * What one node kind can do, in one place.
 *
 * This replaced three parallel `Record<kind, …>` tables plus an `OUTCOME_KINDS` array, and
 * the reason is the failure they shared: adding a kind meant remembering all four, and
 * forgetting one was silent. A Check that had been left out of `OUTCOME_KINDS` would have
 * published with no fail route and dead-ended a submission at runtime; a SessionAction left
 * in it would be required to emit a `pass` it has no port for.
 *
 * `requiredSourcePorts` is the honest generalisation of "both routes off an outcome node
 * have to exist": Session must route `submitted`, an evaluator must route both `pass` and
 * `fail`, and an action must route `complete`. `joinPredecessor` is separate from having
 * pass/fail ports because they are separate questions - a Join has both and may feed
 * another Join, while an action has neither and must never reach one.
 */
export interface WorkflowNodeCapability {
  /** How this kind is spoken to a human in a diagnostic. Never the wire spelling. */
  label: string;
  /**
   * What the node IS, for readers that group kinds rather than name them.
   * `structural` is Session, Join and End; `evaluation` produces a verdict; `action`
   * writes to the bound session and produces only completion.
   */
  role: "structural" | "evaluation" | "action";
  sourcePorts: readonly WorkflowSourcePort[];
  targetPorts: readonly WorkflowTargetPort[];
  /** Ports this kind must route somewhere, or the graph dead-ends at runtime. */
  requiredSourcePorts: readonly WorkflowSourcePort[];
  /** Whether this kind may feed an all-pass Join's `result` input. */
  joinPredecessor: boolean;
}

export const WORKFLOW_NODE_CAPABILITIES: Record<
  WorkflowDraftNode["kind"],
  WorkflowNodeCapability
> = {
  session: {
    label: "Session",
    role: "structural",
    sourcePorts: ["submitted"],
    targetPorts: ["return_for_changes"],
    requiredSourcePorts: ["submitted"],
    joinPredecessor: false,
  },
  persona: {
    label: "Persona",
    role: "evaluation",
    sourcePorts: ["pass", "fail"],
    targetPorts: ["activate"],
    requiredSourcePorts: ["pass", "fail"],
    joinPredecessor: true,
  },
  all_pass: {
    label: "Join",
    role: "structural",
    sourcePorts: ["pass", "fail"],
    targetPorts: ["result"],
    requiredSourcePorts: ["pass", "fail"],
    joinPredecessor: true,
  },
  check: {
    label: "Check",
    role: "evaluation",
    sourcePorts: ["pass", "fail"],
    targetPorts: ["activate"],
    requiredSourcePorts: ["pass", "fail"],
    joinPredecessor: true,
  },
  session_action: {
    label: "Session action",
    role: "action",
    // One port, and no `fail`. Delivery refusal, an uncertain write, a lost session or a
    // failed verifier are ATTEMPT and RUN states, not graph outcomes: routing them back to
    // Session would ask the agent to fix a code problem that does not exist.
    sourcePorts: ["complete"],
    targetPorts: ["activate"],
    requiredSourcePorts: ["complete"],
    joinPredecessor: false,
  },
  end: {
    label: "End",
    role: "structural",
    sourcePorts: [],
    targetPorts: ["terminal"],
    requiredSourcePorts: [],
    joinPredecessor: false,
  },
};

/**
 * Kept as their own exports because the builder's connect controls enumerate ports per
 * kind, and a projection off the registry is one source of truth rather than two tables.
 */
export const WORKFLOW_NODE_SOURCE_PORTS: Record<
  WorkflowDraftNode["kind"],
  readonly WorkflowSourcePort[]
> = Object.fromEntries(
  Object.entries(WORKFLOW_NODE_CAPABILITIES).map(([kind, capability]) => [kind, capability.sourcePorts]),
) as Record<WorkflowDraftNode["kind"], readonly WorkflowSourcePort[]>;

export const WORKFLOW_NODE_TARGET_PORTS: Record<
  WorkflowDraftNode["kind"],
  readonly WorkflowTargetPort[]
> = Object.fromEntries(
  Object.entries(WORKFLOW_NODE_CAPABILITIES).map(([kind, capability]) => [kind, capability.targetPorts]),
) as Record<WorkflowDraftNode["kind"], readonly WorkflowTargetPort[]>;

/** The diagnostic a missing required route reports, per port. */
const MISSING_ROUTE_CODES: Record<WorkflowSourcePort, WorkflowDiagnosticCode> = {
  submitted: "session_submitted_route",
  pass: "missing_pass_route",
  fail: "missing_fail_route",
  complete: "missing_complete_route",
};

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
    WORKFLOW_MISSING_PR_ACTIONS.includes(policy.missingPrAction);
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
    if (!WORKFLOW_NODE_CAPABILITIES[source.kind].sourcePorts.includes(edge.sourcePort)) {
      diagnostics.push(diagnostic("invalid_source_port", `${source.kind} cannot emit “${edge.sourcePort}”.`, { edgeId: edge.id, nodeId: source.id }));
      valid = false;
    }
    if (!WORKFLOW_NODE_CAPABILITIES[target.kind].targetPorts.includes(edge.targetPort)) {
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
  // One loop for every required route, driven by the capability registry. Session's
  // at-least-one `submitted` rule is the same rule as a Persona's pass/fail pair - parallel
  // first-wave review is N reviewers on one submission, and the engine already writes one
  // idempotent receipt per outgoing edge - so it is stated once here rather than twice.
  for (const node of graph.nodes) {
    const capability = WORKFLOW_NODE_CAPABILITIES[node.kind];
    const outgoing = outgoingEdges(node.id);
    for (const port of capability.requiredSourcePorts) {
      if (outgoing.some((edge) => edge.sourcePort === port)) continue;
      diagnostics.push(diagnostic(
        MISSING_ROUTE_CODES[port],
        `${capability.label} needs a ${port} route.`,
        { nodeId: node.id },
      ));
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
      // A SessionAction is refused with its OWN sentence and nothing else. It has no pass or
      // fail port, so the generic rules below would bury the real reason under two
      // "missing its pass route" complaints about routes it can never have.
      if (WORKFLOW_NODE_CAPABILITIES[predecessor.kind].role === "action") {
        diagnostics.push(diagnostic("session_action_join", "A session action runs alone and cannot join an all-pass stage.", { nodeId: join.id }));
        continue;
      }
      // Anything that decides a pass/fail outcome may feed a Join, which is now three kinds.
      // Session and End are still refused: one produces a submission rather than a verdict,
      // and the other consumes one.
      if (!WORKFLOW_NODE_CAPABILITIES[predecessor.kind].joinPredecessor) {
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

  // Conditional on the catalog exactly as Persona references are: a caller that supplied no
  // catalog is asking a structural question, and inventing "no longer exists" for every
  // action node would make that question unanswerable.
  if (input.sessionActions) {
    const actions = new Map(input.sessionActions.map((action) => [action.id, action]));
    for (const node of graph.nodes) {
      if (node.kind !== "session_action") continue;
      const action = actions.get(node.sessionActionId);
      if (!action) diagnostics.push(diagnostic("missing_session_action", "Session action no longer exists.", { nodeId: node.id }));
      else if (action.archivedAt !== null) diagnostics.push(diagnostic("archived_session_action", "Archived session actions cannot be published in a new version.", { nodeId: node.id }));
    }
  }

  // The temporary Phase 1 gate. Unconditional on purpose: it has to reach the draft's own
  // error count so the Publish control is refused where the operator can see why, rather
  // than only at the store where it becomes a 409 against a button that looked enabled.
  if (!(input.sessionActionRuntimeAvailable ?? SESSION_ACTION_RUNTIME_AVAILABLE)) {
    for (const node of graph.nodes) {
      if (node.kind !== "session_action") continue;
      diagnostics.push(diagnostic(
        "session_action_runtime_unavailable",
        "This build cannot run a session action yet, so a workflow containing one cannot be published.",
        { nodeId: node.id },
      ));
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
  return WORKFLOW_NODE_CAPABILITIES[source.kind].sourcePorts.includes(sourcePort) &&
    WORKFLOW_NODE_CAPABILITIES[target.kind].targetPorts.includes(targetPort) &&
    (target.kind !== "session" || (sourcePort === "fail" && targetPort === "return_for_changes")) &&
    // An action never joins a stage. Refused at drop time as well as in validation, so the
    // canvas declines the connection instead of drawing an edge the validator then rejects.
    (target.kind !== "all_pass" || WORKFLOW_NODE_CAPABILITIES[source.kind].joinPredecessor);
}
