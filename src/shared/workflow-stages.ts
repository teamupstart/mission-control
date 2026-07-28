import type {
  Persona,
  PersonaId,
  PublishedWorkflowNode,
  WorkflowDraftGraph,
  WorkflowCheckSlot,
  WorkflowDraftNode,
  WorkflowEdge,
} from "./workflow.ts";

// Stages are a PROJECTION of the graph, never a second persisted model. The daemon stores and
// executes `WorkflowDraftGraph` / `PublishedWorkflowGraph` exactly as before; this module reads
// the pipeline a graph expresses and emits the graph a pipeline means. Nothing here may acquire
// a node: import - the dashboard runs it on every edit.
//
// The hard invariant is round-trip stability: `projectStages(compileStages(p, g))` equals `p`,
// and every id that survives an edit is REUSED from `previousGraph`. Autosave diffs, undo/redo
// and version comparison all read those ids, so a compiler that reminted them would manufacture
// CAS churn and break undo while looking correct on screen.

/** Either graph shape. Both `WorkflowDraftGraph` and `PublishedWorkflowGraph` satisfy it. */
export interface StageGraph {
  readonly nodes: readonly StageNode[];
  readonly edges: readonly WorkflowEdge[];
}

export type StageNode = WorkflowDraftNode | PublishedWorkflowNode;

/** Only the two fields naming resolution needs, so a `PersonaView[]` passes unchanged. */
export type StagePersonaNames = readonly Pick<Persona, "id" | "name">[];

/**
 * One thing a stage runs: a Persona reviewing, or a Check gating.
 *
 * `nodeId: null` marks a member that exists in no graph yet - the editor adding one constructs
 * it that way. `compileStages` is the only minter of real ids; callers recover them by
 * re-projecting the compiled graph.
 *
 * The discriminant is on BOTH arms rather than only on the check, and that is the point of
 * writing it this way: every existing `member.personaId` read fails typecheck until it has
 * said which kind it meant. A bare Persona arm plus an optional `slot` would compile
 * everywhere and be silently wrong in each place nobody revisited.
 */
export type StageMember =
  | { nodeId: string | null; kind: "persona"; personaId: PersonaId }
  | { nodeId: string | null; kind: "check"; slot: WorkflowCheckSlot };

/** The node kinds a stage member is drawn from. Session, End and Join are structure. */
export type StageMemberNode = Extract<StageNode, { kind: "persona" | "check" }>;

const isMemberKind = (kind: StageNode["kind"]): kind is "persona" | "check" =>
  kind === "persona" || kind === "check";

/** The member a node IS, which is the projection's half of the round trip. */
function memberOf(node: StageMemberNode): StageMember {
  return node.kind === "check"
    ? { nodeId: node.id, kind: "check", slot: node.slot }
    : { nodeId: node.id, kind: "persona", personaId: personaIdOf(node) };
}

export interface Stage {
  /**
   * The stage's `all_pass` node. `null` means no join node is bound: the stage has one member
   * (a single member needs no join), or the stage is new and `compileStages` will mint one.
   * The compiler emits a join exactly when `members.length > 1`.
   */
  joinId: string | null;
  members: StageMember[];
}

export interface StagePipeline {
  sessionId: string;
  endId: string;
  endOutcome: string;
  /** Zero or more stages, in execution order. `[]` is the valid empty pipeline. */
  stages: Stage[];
}

/** Coherent with `autoLayout` in `WorkflowCanvas.tsx`: same origin, column and row spacing. */
const LAYOUT = { originX: 60, originY: 60, columnStride: 280, rowStride: 170 } as const;

const isKind = <K extends StageNode["kind"]>(kind: K) =>
  (node: StageNode): node is Extract<StageNode, { kind: K }> => node.kind === kind;
const isPersonaNode = isKind("persona");

/** A published Persona node carries its snapshot; a draft node points at a live Persona. */
function personaIdOf(node: Extract<StageNode, { kind: "persona" }>): PersonaId {
  return "persona" in node ? node.persona.sourcePersonaId : node.personaId;
}

function personaName(
  node: Extract<StageNode, { kind: "persona" }>,
  personas: StagePersonaNames,
): string {
  if ("persona" in node) return node.persona.name;
  return personas.find((persona) => persona.id === node.personaId)?.name ?? "Missing persona";
}

function joinLabel(graph: StageGraph, node: StageNode): string {
  const predecessors = new Set(
    graph.edges
      .filter((edge) => edge.target === node.id && edge.targetPort === "result")
      .map((edge) => edge.source),
  );
  return `All-pass join · ${predecessors.size} predecessor${predecessors.size === 1 ? "" : "s"}`;
}

/** The label a node carries with no stage context - what blockers and Graph view fall back to. */
function baseLabel(graph: StageGraph, node: StageNode, personas: StagePersonaNames): string {
  if (node.kind === "session") return "Session";
  if (node.kind === "end") return node.outcome;
  if (node.kind === "all_pass") return joinLabel(graph, node);
  if (node.kind === "check") return checkLabel(node.slot);
  return personaName(node, personas);
}

/**
 * A Check names its slot and nothing else, so its label is the slot with the word that says
 * what kind of thing it is - "test" alone next to a Persona's name reads as a reviewer.
 */
export function checkLabel(slot: WorkflowCheckSlot): string {
  return `Check · ${slot}`;
}

/** Published snapshots win over the live list, which is empty for a published graph anyway. */
function withSnapshotNames(graph: StageGraph, personas: StagePersonaNames): StagePersonaNames {
  const snapshots = graph.nodes.filter(isPersonaNode).flatMap((node) =>
    "persona" in node ? [{ id: node.persona.sourcePersonaId, name: node.persona.name }] : []);
  return snapshots.length === 0 ? personas : [...snapshots, ...personas];
}

/**
 * Derived stage naming (plan decision 3: no persisted stage label). A single member names its
 * own stage; a parallel stage is "Stage N", 1-based as an operator counts.
 *
 * A pipeline projected from a PUBLISHED graph carries the snapshot's `sourcePersonaId`, so a
 * caller naming published stages passes the snapshot names - `nodeLabel` already does.
 */
export function stageName(stage: Stage, index: number, personas: StagePersonaNames): string {
  const only = stage.members.length === 1 ? stage.members[0] : null;
  if (!only) return `Stage ${index + 1}`;
  if (only.kind === "check") return checkLabel(only.slot);
  return personas.find((persona) => persona.id === only.personaId)?.name ?? "Missing persona";
}

/**
 * What a stage HOLDS, counted by kind: "1 reviewer", "2 checks", "1 reviewer, 1 check".
 *
 * Shared rather than spelled at each surface because the editor and the run monitor draw the
 * same stage: "2 reviewers" was correct only while a member could not be anything else, and
 * two surfaces each growing their own check-aware variant of it is how the same stage starts
 * describing itself two ways.
 */
export function stageContents(stage: Stage): string {
  const reviewers = stage.members.filter((member) => member.kind === "persona").length;
  const checks = stage.members.length - reviewers;
  return [
    ...(reviewers > 0 ? [`${reviewers} reviewer${reviewers === 1 ? "" : "s"}`] : []),
    ...(checks > 0 ? [`${checks} check${checks === 1 ? "" : "s"}`] : []),
  ].join(", ");
}

/**
 * The stage's subtitle: what it holds, plus the rule it runs under.
 *
 * Split from `stageContents` rather than trimmed back out of it by the callers that want only
 * the count - a caller doing string surgery on this suffix would silently stop trimming the
 * day the wording changed, and say "and its 3 reviewers · all must pass:" in the middle of a
 * confirmation sentence.
 */
export function stageSummary(stage: Stage): string {
  const contents = stageContents(stage);
  return stage.members.length > 1 ? `${contents} · all must pass` : contents;
}

/**
 * The one human name for a node, for every surface. Never an id.
 *
 * `graph` is required because an `all_pass` node carries no stage context of its own: in a
 * stage-expressible graph its label is its stage's name, and otherwise it is described by how
 * many predecessors feed it.
 */
export function nodeLabel(
  graph: StageGraph,
  node: StageNode,
  personas: StagePersonaNames,
): string {
  if (node.kind !== "all_pass") return baseLabel(graph, node, personas);
  const pipeline = projectStages(graph);
  const index = pipeline?.stages.findIndex((stage) => stage.joinId === node.id) ?? -1;
  if (!pipeline || index < 0) return joinLabel(graph, node);
  return stageName(pipeline.stages[index]!, index, withSnapshotNames(graph, personas));
}

interface Analysis {
  pipeline: StagePipeline | null;
  blockers: string[];
}

type Entry =
  | { kind: "end" }
  | { kind: "members"; ids: string[] }
  | { kind: "blocked"; blocker: string };

/**
 * One walk answering both public questions, so `projectStages` returns non-null exactly when
 * `stageBlockers` is empty. Two implementations would agree only by luck.
 */
function analyze(graph: StageGraph, personas: StagePersonaNames): Analysis {
  const blocked = (blocker: string): Analysis => ({ pipeline: null, blockers: [blocker] });
  const sessions = graph.nodes.filter(isKind("session"));
  const ends = graph.nodes.filter(isKind("end"));
  const structural: string[] = [];
  if (sessions.length === 0) structural.push("This graph has no Session node.");
  if (sessions.length > 1) {
    structural.push(`This graph has ${sessions.length} Session nodes; a pipeline has exactly one.`);
  }
  if (ends.length === 0) structural.push("This graph has no End node.");
  if (ends.length > 1) {
    structural.push(`This graph has ${ends.length} End nodes; a pipeline has exactly one.`);
  }
  if (new Set(graph.nodes.map((node) => node.id)).size !== graph.nodes.length) {
    structural.push("This graph has nodes with duplicate identities; every pipeline node needs a unique identity.");
  }
  if (new Set(graph.edges.map((edge) => edge.id)).size !== graph.edges.length) {
    structural.push("This graph has routes with duplicate identities; every pipeline route needs a unique identity.");
  }
  if (structural.length > 0) return { pipeline: null, blockers: structural };

  const session = sessions[0]!;
  const end = ends[0]!;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const label = (node: StageNode): string => baseLabel(graph, node, personas);
  const outgoing = (id: string, port: WorkflowEdge["sourcePort"]): WorkflowEdge[] =>
    graph.edges.filter((edge) => edge.source === id && edge.sourcePort === port);
  const used = new Set<string>();
  const visited = new Set<string>([session.id, end.id]);

  /** Where a `submitted` or `pass` port leads: the next stage's members, or the End. */
  const entryFrom = (edges: WorkflowEdge[], from: string, noRoute: string): Entry => {
    if (edges.length === 0) return { kind: "blocked", blocker: noRoute };
    const targets = edges.map((edge) => byId.get(edge.target));
    if (targets.some((target) => !target)) {
      return { kind: "blocked", blocker: `${from} routes to a node that does not exist.` };
    }
    const kinds = new Set(targets.map((target) => target!.kind));
    // Reviewers and checks MIX inside one stage - they are both things that produce a verdict
    // on the same submission - so the split that is still refused is a route reaching the End
    // and something else, which is a fork no stage can stand for.
    if (kinds.has("end") && kinds.size > 1) {
      return { kind: "blocked", blocker: `${from} splits between the End node and the rest of the pipeline.` };
    }
    for (const edge of edges) used.add(edge.id);
    if (kinds.has("end")) {
      if (edges.length > 1) {
        return { kind: "blocked", blocker: `${from} reaches the End node more than once.` };
      }
      if (edges[0]!.targetPort !== "terminal") {
        return { kind: "blocked", blocker: `${from} does not reach the End node's terminal input.` };
      }
      return { kind: "end" };
    }
    const stranger = targets.find((target) => !isMemberKind(target!.kind));
    if (stranger) {
      return { kind: "blocked", blocker: `${from} routes to ${label(stranger)}, which is neither a reviewer nor a check.` };
    }
    if (edges.some((edge) => edge.targetPort !== "activate")) {
      return { kind: "blocked", blocker: `${from} routes to ${label(targets[0]!)} without activating it.` };
    }
    const ids = edges.map((edge) => edge.target);
    if (new Set(ids).size !== ids.length) {
      return { kind: "blocked", blocker: `${from} routes to the same node more than once.` };
    }
    return { kind: "members", ids };
  };

  const returnsToSession = (edges: WorkflowEdge[]): boolean =>
    edges.length === 1 && edges[0]!.target === session.id
    && edges[0]!.targetPort === "return_for_changes";

  const submitted = outgoing(session.id, "submitted");
  // A fresh draft is Session plus End with no edges at all. It is the zero-stage pipeline, which
  // is what lets a brand-new workflow open in Pipeline mode without being edited by opening it.
  let entry: Entry = submitted.length === 0 && graph.edges.length === 0
    ? { kind: "end" }
    : entryFrom(submitted, "Session", "Session has no submitted route.");

  const stages: Stage[] = [];
  while (entry.kind === "members") {
    const members = entry.ids.map((id) => byId.get(id) as StageMemberNode);
    const repeated = members.find((node) => visited.has(node.id));
    if (repeated) return blocked(`${label(repeated)} appears more than once in the pipeline.`);
    for (const node of members) visited.add(node.id);

    let onwardEdges: WorkflowEdge[];
    let onwardFrom: string;
    if (members.length === 1) {
      const only = members[0]!;
      const fail = outgoing(only.id, "fail");
      if (!returnsToSession(fail)) {
        return blocked(`${label(only)}'s fail route does not return to Session.`);
      }
      used.add(fail[0]!.id);
      stages.push({ joinId: null, members: [memberOf(only)] });
      onwardEdges = outgoing(only.id, "pass");
      onwardFrom = `${label(only)}'s pass route`;
    } else {
      // A parallel stage is named the way `stageName` names it, so a blocker and the editor's
      // stage heading say the same word about the same thing.
      const stageLabel = `Stage ${stages.length + 1}`;
      const joins = new Set<string>();
      for (const node of members) {
        const pass = outgoing(node.id, "pass");
        const fail = outgoing(node.id, "fail");
        const paired = [...pass, ...fail];
        const routesOneJoin = pass.length === 1 && fail.length === 1
          && paired.every((edge) => byId.get(edge.target)?.kind === "all_pass"
            && edge.targetPort === "result")
          && pass[0]!.target === fail[0]!.target;
        if (!routesOneJoin) {
          return blocked(`${label(node)} does not route both outcomes into one all-pass join with the rest of ${stageLabel}.`);
        }
        joins.add(pass[0]!.target);
        for (const edge of paired) used.add(edge.id);
      }
      if (joins.size > 1) {
        return blocked(`${stageLabel}'s reviewers route into ${joins.size} different all-pass joins.`);
      }
      const join = byId.get([...joins][0]!)!;
      if (visited.has(join.id)) {
        return blocked(`${stageLabel}'s all-pass join appears more than once in the pipeline.`);
      }
      const feeding = graph.edges.filter((edge) => edge.target === join.id);
      if (feeding.length !== members.length * 2) {
        return blocked(`${stageLabel}'s all-pass join also receives routes from outside the stage.`);
      }
      const joinFail = outgoing(join.id, "fail");
      if (!returnsToSession(joinFail)) {
        return blocked(`${stageLabel}'s all-pass join does not return its fail route to Session.`);
      }
      used.add(joinFail[0]!.id);
      visited.add(join.id);
      stages.push({ joinId: join.id, members: members.map(memberOf) });
      onwardEdges = outgoing(join.id, "pass");
      onwardFrom = `${stageLabel}'s pass route`;
    }
    entry = entryFrom(onwardEdges, onwardFrom, `${onwardFrom} leads nowhere.`);
  }
  if (entry.kind === "blocked") return blocked(entry.blocker);

  const blockers: string[] = [];
  for (const node of graph.nodes) {
    if (!visited.has(node.id)) blockers.push(`${label(node)} is not part of the pipeline.`);
  }
  const straySources = new Set<string>();
  for (const edge of graph.edges) {
    if (used.has(edge.id)) continue;
    straySources.add(edge.source);
  }
  for (const sourceId of straySources) {
    const source = byId.get(sourceId);
    blockers.push(source ? `${label(source)} has a route the pipeline shape does not allow.`
      : "A route starts from a node that does not exist.");
  }
  if (blockers.length > 0) return { pipeline: null, blockers };
  return {
    pipeline: { sessionId: session.id, endId: end.id, endOutcome: end.outcome, stages },
    blockers: [],
  };
}

/**
 * The pipeline a graph expresses, or `null` when it expresses none. Non-null exactly when
 * `stageBlockers(graph)` is empty.
 */
export function projectStages(graph: StageGraph): StagePipeline | null {
  return analyze(graph, []).pipeline;
}

/**
 * Why the Graph view is showing instead of the Pipeline editor, as sentences an operator can act
 * on. `personas` is optional only so `stageExpressible` needs no name resolution; pass the live
 * list wherever the reason is shown to a human, or a draft reviewer reads "Missing persona".
 */
export function stageBlockers(graph: StageGraph, personas: StagePersonaNames = []): string[] {
  return analyze(graph, personas).blockers;
}

export function stageExpressible(graph: StageGraph): boolean {
  return stageBlockers(graph).length === 0;
}

const positionAt = (column: number, row: number): { x: number; y: number } => ({
  x: LAYOUT.originX + column * LAYOUT.columnStride,
  y: LAYOUT.originY + row * LAYOUT.rowStride,
});

/**
 * The graph a pipeline means, emitted deterministically.
 *
 * Identity is the whole point: session and end keep their ids, a member or join with a non-null
 * id keeps it, and an edge whose `(source, sourcePort, target, targetPort)` already exists in
 * `previousGraph` keeps that edge's id. Everything else - and only that - mints a new one.
 */
export function compileStages(
  pipeline: StagePipeline,
  previousGraph: WorkflowDraftGraph,
): WorkflowDraftGraph {
  const edgeKey = (
    source: string,
    sourcePort: WorkflowEdge["sourcePort"],
    target: string,
    targetPort: WorkflowEdge["targetPort"],
  ): string => JSON.stringify([source, sourcePort, target, targetPort]);
  const previousEdges = new Map<string, string>();
  for (const edge of previousGraph.edges) {
    const key = edgeKey(edge.source, edge.sourcePort, edge.target, edge.targetPort);
    if (!previousEdges.has(key)) previousEdges.set(key, edge.id);
  }
  const nodes: WorkflowDraftNode[] = [];
  const edges: WorkflowEdge[] = [];
  const connect = (
    source: string,
    sourcePort: WorkflowEdge["sourcePort"],
    target: string,
    targetPort: WorkflowEdge["targetPort"],
  ): void => {
    const key = edgeKey(source, sourcePort, target, targetPort);
    edges.push({
      id: previousEdges.get(key) ?? crypto.randomUUID(),
      source,
      sourcePort,
      target,
      targetPort,
    });
  };

  nodes.push({ id: pipeline.sessionId, kind: "session", position: positionAt(0, 0) });

  let column = 1;
  // Nodes first, so a stage's onward routes can be written once the NEXT stage's ids exist. A
  // stage with no members is not a stage: it is dropped rather than emitted as a source-less edge.
  const compiled: { members: string[]; joinId: string | null }[] = [];
  for (const stage of pipeline.stages) {
    if (stage.members.length === 0) continue;
    const members = stage.members.map((member, row) => {
      const id = member.nodeId ?? crypto.randomUUID();
      const position = positionAt(column, row);
      // Identical for both kinds apart from what the node carries: a check takes the same
      // routes, the same join and the same column a Persona in its position would, which is
      // what lets the compiler treat a mixed stage as one stage.
      nodes.push(member.kind === "check"
        ? { id, kind: "check", slot: member.slot, position }
        : { id, kind: "persona", personaId: member.personaId, position });
      return id;
    });
    // A join exists exactly when the stage has to agree with itself before moving on.
    const joinId = stage.members.length > 1 ? stage.joinId ?? crypto.randomUUID() : null;
    if (joinId) {
      nodes.push({
        id: joinId,
        kind: "all_pass",
        position: positionAt(column + 1, (stage.members.length - 1) / 2),
      });
    }
    column += joinId ? 2 : 1;
    compiled.push({ members, joinId });
  }
  const endId = pipeline.endId;
  nodes.push({
    id: endId,
    kind: "end",
    outcome: pipeline.endOutcome,
    position: positionAt(column, 0),
  });

  const activate = (targets: readonly string[], source: string, port: "submitted" | "pass"): void => {
    for (const target of targets) connect(source, port, target, "activate");
  };
  if (compiled.length === 0) {
    connect(pipeline.sessionId, "submitted", endId, "terminal");
  } else {
    activate(compiled[0]!.members, pipeline.sessionId, "submitted");
  }
  compiled.forEach((stage, index) => {
    const next = compiled[index + 1];
    const gate = stage.joinId;
    if (gate) {
      for (const member of stage.members) {
        connect(member, "pass", gate, "result");
        connect(member, "fail", gate, "result");
      }
      connect(gate, "fail", pipeline.sessionId, "return_for_changes");
    } else {
      connect(stage.members[0]!, "fail", pipeline.sessionId, "return_for_changes");
    }
    const source = gate ?? stage.members[0]!;
    if (next) activate(next.members, source, "pass");
    else connect(source, "pass", endId, "terminal");
  });

  return { nodes, edges };
}
