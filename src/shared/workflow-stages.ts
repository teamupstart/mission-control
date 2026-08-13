import type {
  Persona,
  PersonaId,
  PublishedWorkflowNode,
  SessionAction,
  SessionActionId,
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

/** The same narrow shape for session actions, so a `SessionAction[]` passes unchanged. */
export type StageSessionActionNames = readonly Pick<SessionAction, "id" | "name">[];

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

/**
 * The one thing a SessionAction stage runs.
 *
 * Its own type rather than a third arm of `StageMember`, because a stage member is
 * something an evaluation wave holds N of and an action is something a stage holds exactly
 * one of. A third arm would compile everywhere and be wrong wherever a caller put it beside
 * a reviewer - which is precisely the shape the runtime cannot execute.
 */
export type SessionActionStageMember = {
  nodeId: string | null;
  kind: "session_action";
  sessionActionId: SessionActionId;
};

/** The node kinds an evaluation member is drawn from. Session, End and Join are structure. */
export type StageMemberNode = Extract<StageNode, { kind: "persona" | "check" }>;

/** The node kind a SessionAction stage is drawn from. */
export type SessionActionStageNode = Extract<StageNode, { kind: "session_action" }>;

const isMemberKind = (kind: StageNode["kind"]): kind is "persona" | "check" =>
  kind === "persona" || kind === "check";

/** The member a node IS, which is the projection's half of the round trip. */
function memberOf(node: StageMemberNode): StageMember {
  return node.kind === "check"
    ? { nodeId: node.id, kind: "check", slot: node.slot }
    : { nodeId: node.id, kind: "persona", personaId: personaIdOf(node) };
}

function actionMemberOf(node: SessionActionStageNode): SessionActionStageMember {
  return {
    nodeId: node.id,
    kind: "session_action",
    sessionActionId: sessionActionIdOf(node),
  };
}

/**
 * An all-pass wave: one or more Personas and Checks reading the SAME evidence, agreeing
 * before the pipeline moves on, and returning to Session together when any of them fails.
 */
export interface EvaluationStage {
  kind: "evaluation";
  /**
   * The stage's `all_pass` node. `null` means no join node is bound: the stage has one member
   * (a single member needs no join), or the stage is new and `compileStages` will mint one.
   * The compiler emits a join exactly when `members.length > 1`.
   */
  joinId: string | null;
  members: StageMember[];
}

/**
 * One session action, alone.
 *
 * `member` is singular and there is no `joinId`, and both are the type saying what the
 * runtime requires rather than a convention a caller has to remember. An action writes to
 * the bound conversation and may change the repository, so it cannot run beside an evaluator
 * reading the evidence it is about to invalidate, and it emits completion rather than a
 * verdict, so there is nothing for a join to aggregate.
 */
export interface SessionActionStage {
  kind: "session_action";
  member: SessionActionStageMember;
}

/**
 * A DISCRIMINATED UNION rather than one shape with an optional field. The two kinds of
 * stage differ in arity, in what they emit and in what happens after them, and a single
 * `members` array carrying an action that only works when it is alone would compile at
 * every call site and be honest at almost none of them.
 */
export type Stage = EvaluationStage | SessionActionStage;

export const isEvaluationStage = (stage: Stage): stage is EvaluationStage =>
  stage.kind === "evaluation";

export const isSessionActionStage = (stage: Stage): stage is SessionActionStage =>
  stage.kind === "session_action";

/**
 * Every member of a stage as one ordered list, whichever kind of stage it is.
 *
 * Shared so the surfaces that walk members for FOCUS ORDER, counting, or keyboard reorder
 * do not each grow their own `stage.kind === …` fork and then disagree about whether an
 * action stage has one member or none.
 */
export function stageMembers(stage: Stage): Array<StageMember | SessionActionStageMember> {
  return stage.kind === "session_action" ? [stage.member] : stage.members;
}

/**
 * What the seam AFTER a stage says about the gate its predecessor cleared.
 *
 * Shared rather than spelled at the editor and the run monitor, because "complete" is a
 * distinction both surfaces have to draw and neither can derive from a member count: a
 * pass carries the same evidence onward, a complete means everything after it reads
 * evidence captured once the action had run.
 */
export function stageSeamGate(stage: Stage): string {
  if (stage.kind === "session_action") return "complete";
  return stage.members.length > 1 ? "all pass" : "pass";
}

/**
 * A stable render key for a member that has no node id yet, or whose id a caller would
 * rather not use. Prefixed so a Persona whose id spells a check slot cannot collide with one.
 */
export function stageMemberKey(member: StageMember | SessionActionStageMember): string {
  if (member.kind === "check") return `check:${member.slot}`;
  if (member.kind === "session_action") return `session_action:${member.sessionActionId}`;
  return `persona:${member.personaId}`;
}

/** Every graph node id a stage owns, members first and its join - if any - last. */
export function stageNodeIds(stage: Stage): string[] {
  const ids = stageMembers(stage).flatMap((member) => member.nodeId === null ? [] : [member.nodeId]);
  const joinId = stage.kind === "evaluation" ? stage.joinId : null;
  return joinId === null ? ids : [...ids, joinId];
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
const isSessionActionNode = isKind("session_action");

/** A published Persona node carries its snapshot; a draft node points at a live Persona. */
function personaIdOf(node: Extract<StageNode, { kind: "persona" }>): PersonaId {
  return "persona" in node ? node.persona.sourcePersonaId : node.personaId;
}

/** The same split for actions: a published node carries its snapshot's source id. */
function sessionActionIdOf(node: SessionActionStageNode): SessionActionId {
  return "action" in node ? node.action.sourceSessionActionId : node.sessionActionId;
}

function personaName(
  node: Extract<StageNode, { kind: "persona" }>,
  personas: StagePersonaNames,
): string {
  if ("persona" in node) return node.persona.name;
  return personas.find((persona) => persona.id === node.personaId)?.name ?? "Missing persona";
}

function sessionActionName(
  node: SessionActionStageNode,
  actions: StageSessionActionNames,
): string {
  if ("action" in node) return node.action.name;
  return actions.find((action) => action.id === node.sessionActionId)?.name
    ?? "Missing session action";
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
function baseLabel(
  graph: StageGraph,
  node: StageNode,
  personas: StagePersonaNames,
  actions: StageSessionActionNames,
): string {
  if (node.kind === "session") return "Session";
  if (node.kind === "end") return node.outcome;
  if (node.kind === "all_pass") return joinLabel(graph, node);
  if (node.kind === "check") return checkLabel(node.slot);
  if (node.kind === "session_action") return sessionActionName(node, actions);
  return personaName(node, personas);
}

/**
 * A Command names its slot and nothing else, so its label is the slot with the word that says
 * what kind of thing it is - "test" alone next to a Persona's name reads as a reviewer.
 *
 * The WORD is Command and the wire kind stays `check`. The function keeps its old name for
 * the same reason the kind does: renaming it would touch every call site and every published
 * graph's vocabulary for no reader's benefit. What a person sees is what changed.
 */
export function checkLabel(slot: WorkflowCheckSlot): string {
  return `Command · ${slot}`;
}

/** Published snapshots win over the live list, which is empty for a published graph anyway. */
function withSnapshotNames(graph: StageGraph, personas: StagePersonaNames): StagePersonaNames {
  const snapshots = graph.nodes.filter(isPersonaNode).flatMap((node) =>
    "persona" in node ? [{ id: node.persona.sourcePersonaId, name: node.persona.name }] : []);
  return snapshots.length === 0 ? personas : [...snapshots, ...personas];
}

function withSnapshotActionNames(
  graph: StageGraph,
  actions: StageSessionActionNames,
): StageSessionActionNames {
  const snapshots = graph.nodes.filter(isSessionActionNode).flatMap((node) =>
    "action" in node ? [{ id: node.action.sourceSessionActionId, name: node.action.name }] : []);
  return snapshots.length === 0 ? actions : [...snapshots, ...actions];
}

/**
 * Derived stage naming (plan decision 3: no persisted stage label). A single member names its
 * own stage; a parallel stage is "Stage N", 1-based as an operator counts.
 *
 * A pipeline projected from a PUBLISHED graph carries the snapshot's `sourcePersonaId`, so a
 * caller naming published stages passes the snapshot names - `nodeLabel` already does.
 */
export function stageName(
  stage: Stage,
  index: number,
  personas: StagePersonaNames,
  actions: StageSessionActionNames = [],
): string {
  // An action stage is always a singleton, so it always names itself - there is no
  // "Stage N" fallback for it, because there is nothing else in it to disagree with.
  if (stage.kind === "session_action") {
    return actions.find((action) => action.id === stage.member.sessionActionId)?.name
      ?? "Missing session action";
  }
  const only = stage.members.length === 1 ? stage.members[0] : null;
  if (!only) return `Stage ${index + 1}`;
  if (only.kind === "check") return checkLabel(only.slot);
  return personas.find((persona) => persona.id === only.personaId)?.name ?? "Missing persona";
}

/**
 * What a stage HOLDS, counted by kind: "1 reviewer", "2 commands", "1 reviewer, 1 command".
 *
 * Shared rather than spelled at each surface because the editor and the run monitor draw the
 * same stage: "2 reviewers" was correct only while a member could not be anything else, and
 * two surfaces each growing their own check-aware variant of it is how the same stage starts
 * describing itself two ways.
 *
 * The action arm is a separate return rather than a third counter, because the union already
 * says the count is one. The subtraction below - "everything that is not a reviewer is a
 * check" - would otherwise have quietly reported a session action as a check.
 */
export function stageContents(stage: Stage): string {
  if (stage.kind === "session_action") return "1 session action";
  const reviewers = stage.members.filter((member) => member.kind === "persona").length;
  const commands = stage.members.length - reviewers;
  return [
    ...(reviewers > 0 ? [`${reviewers} reviewer${reviewers === 1 ? "" : "s"}`] : []),
    ...(commands > 0 ? [`${commands} command${commands === 1 ? "" : "s"}`] : []),
  ].join(", ");
}

/**
 * The stage's subtitle: what it holds, plus the rule it runs under.
 *
 * Split from `stageContents` rather than trimmed back out of it by the callers that want only
 * the count - a caller doing string surgery on this suffix would silently stop trimming the
 * day the wording changed, and say "and its 3 reviewers · all must pass:" in the middle of a
 * confirmation sentence.
 *
 * The action's rule is the one an operator most needs stated: everything after it reviews
 * evidence captured AFTER the action ran, not the evidence the stages above it saw.
 */
export function stageSummary(stage: Stage): string {
  const contents = stageContents(stage);
  if (stage.kind === "session_action") {
    return `${contents} · later stages review new evidence`;
  }
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
  actions: StageSessionActionNames = [],
): string {
  if (node.kind !== "all_pass") return baseLabel(graph, node, personas, actions);
  const pipeline = projectStages(graph);
  const index = pipeline?.stages.findIndex((stage) =>
    stage.kind === "evaluation" && stage.joinId === node.id) ?? -1;
  if (!pipeline || index < 0) return joinLabel(graph, node);
  return stageName(
    pipeline.stages[index]!,
    index,
    withSnapshotNames(graph, personas),
    withSnapshotActionNames(graph, actions),
  );
}

interface Analysis {
  pipeline: StagePipeline | null;
  blockers: string[];
}

type Entry =
  | { kind: "end" }
  | { kind: "members"; ids: string[] }
  | { kind: "action"; id: string }
  | { kind: "blocked"; blocker: string };

/**
 * One walk answering both public questions, so `projectStages` returns non-null exactly when
 * `stageBlockers` is empty. Two implementations would agree only by luck.
 */
function analyze(
  graph: StageGraph,
  personas: StagePersonaNames,
  actions: StageSessionActionNames = [],
): Analysis {
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
  const label = (node: StageNode): string => baseLabel(graph, node, personas, actions);
  const outgoing = (id: string, port: WorkflowEdge["sourcePort"]): WorkflowEdge[] =>
    graph.edges.filter((edge) => edge.source === id && edge.sourcePort === port);
  const used = new Set<string>();
  const visited = new Set<string>([session.id, end.id]);

  /**
   * Where a `submitted`, `pass` or `complete` port leads: the next stage, or the End.
   *
   * "The next stage" is now two answers, and the split is deliberate rather than a shape the
   * caller has to detect afterwards - a route reaching an action and an evaluator at once is
   * a stage the runtime cannot execute, and it has to be refused HERE, where the fan-out is
   * still visible, rather than at the loop below where only a list of ids remains.
   */
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
    if (kinds.has("session_action")) {
      // A session action writes to the conversation and may change the repository, so
      // anything running beside it would be reviewing evidence the action is about to
      // invalidate. Fanning out to two actions is refused for the same reason.
      if (edges.length > 1) {
        return { kind: "blocked", blocker: `${from} routes to a session action alongside another node; a session action runs on its own.` };
      }
      if (edges[0]!.targetPort !== "activate") {
        return { kind: "blocked", blocker: `${from} routes to ${label(targets[0]!)} without activating it.` };
      }
      return { kind: "action", id: edges[0]!.target };
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
  while (entry.kind === "members" || entry.kind === "action") {
    if (entry.kind === "action") {
      const node = byId.get(entry.id) as SessionActionStageNode;
      if (visited.has(node.id)) {
        return blocked(`${label(node)} appears more than once in the pipeline.`);
      }
      visited.add(node.id);
      // No fail route to demand and no join to reconcile. An action emits `complete` and
      // nothing else, so the only onward question is where completion goes.
      stages.push({ kind: "session_action", member: actionMemberOf(node) });
      const onward = `${label(node)}'s complete route`;
      entry = entryFrom(outgoing(node.id, "complete"), onward, `${onward} leads nowhere.`);
      continue;
    }
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
      stages.push({ kind: "evaluation", joinId: null, members: [memberOf(only)] });
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
      stages.push({ kind: "evaluation", joinId: join.id, members: members.map(memberOf) });
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
 * on. `personas` and `actions` are optional only so `stageExpressible` needs no name resolution;
 * pass the live lists wherever the reason is shown to a human, or a draft reviewer reads
 * "Missing persona".
 */
export function stageBlockers(
  graph: StageGraph,
  personas: StagePersonaNames = [],
  actions: StageSessionActionNames = [],
): string[] {
  return analyze(graph, personas, actions).blockers;
}

export function stageExpressible(graph: StageGraph): boolean {
  return stageBlockers(graph).length === 0;
}

const positionAt = (column: number, row: number): { x: number; y: number } => ({
  x: LAYOUT.originX + column * LAYOUT.columnStride,
  y: LAYOUT.originY + row * LAYOUT.rowStride,
});

/** A stage after its nodes exist, reduced to the ids the wiring pass needs. */
type CompiledStage =
  | { kind: "evaluation"; members: string[]; joinId: string | null }
  | { kind: "session_action"; id: string };

/** The nodes a preceding stage activates to enter this one. */
function entryIds(stage: CompiledStage): string[] {
  return stage.kind === "session_action" ? [stage.id] : stage.members;
}

/** The node whose onward port carries the pipeline past this stage. */
function exitId(stage: CompiledStage): string {
  return stage.kind === "session_action" ? stage.id : stage.joinId ?? stage.members[0]!;
}

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
  const compiled: CompiledStage[] = [];
  for (const stage of pipeline.stages) {
    if (stage.kind === "session_action") {
      const id = stage.member.nodeId ?? crypto.randomUUID();
      nodes.push({
        id,
        kind: "session_action",
        sessionActionId: stage.member.sessionActionId,
        position: positionAt(column, 0),
      });
      // One column and no join column: an action is a singleton by construction, so there
      // is never a second row to centre a gate between.
      column += 1;
      compiled.push({ kind: "session_action", id });
      continue;
    }
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
    compiled.push({ kind: "evaluation", members, joinId });
  }
  const endId = pipeline.endId;
  nodes.push({
    id: endId,
    kind: "end",
    outcome: pipeline.endOutcome,
    position: positionAt(column, 0),
  });

  const activate = (
    targets: readonly string[],
    source: string,
    port: "submitted" | "pass" | "complete",
  ): void => {
    for (const target of targets) connect(source, port, target, "activate");
  };
  if (compiled.length === 0) {
    connect(pipeline.sessionId, "submitted", endId, "terminal");
  } else {
    activate(entryIds(compiled[0]!), pipeline.sessionId, "submitted");
  }
  compiled.forEach((stage, index) => {
    const next = compiled[index + 1];
    // The onward port is the ONE thing that differs between the two stage kinds, and it is
    // read off the stage rather than assumed: an action emits `complete` and has no fail
    // route to write, so the repair wiring below is skipped entirely rather than emitted
    // with a port the node does not have.
    if (stage.kind === "session_action") {
      if (next) activate(entryIds(next), stage.id, "complete");
      else connect(stage.id, "complete", endId, "terminal");
      return;
    }
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
    const source = exitId(stage);
    if (next) activate(entryIds(next), source, "pass");
    else connect(source, "pass", endId, "terminal");
  });

  return { nodes, edges };
}
