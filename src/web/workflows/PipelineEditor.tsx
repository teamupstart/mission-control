import { useMemo, useRef, useState } from "react";
import {
  addableSessionActions,
  personasForDisplay,
  sessionActionChoiceLabel,
  sessionActionChoicesForDisplay,
  sessionActionCompletionLabel,
  sessionActionSkillLabel,
  WORKFLOW_CHECK_SLOTS,
} from "@shared/workflow.ts";
import type {
  PersonaId,
  PersonaView,
  SessionAction,
  SessionActionCompletionKind,
  SessionActionId,
  WorkflowCheckSlot,
  WorkflowCompletionPolicy,
  WorkflowDraftGraph,
} from "@shared/workflow.ts";
import {
  checkLabel,
  compileStages,
  projectStages,
  stageContents,
  stageMembers,
  stageName,
  stageSeamGate,
  stageSummary,
  type EvaluationStage,
  type Stage,
  type StageMember,
  type StagePipeline,
} from "@shared/workflow-stages.ts";
import {
  InspectorFooter,
  PipelineFrame,
  ReviewerRow,
  StageCard,
  StageSeam,
  TerminusCard,
  type PipelineItemState,
} from "./pipeline-bits.tsx";
import type { WorkflowConfirmRequest } from "./WorkflowConfirmModal.tsx";
import { Tooltip } from "../components/Tooltip.tsx";

/**
 * Authoring a workflow as stages of Persona reviewers and deterministic Checks.
 *
 * The editor holds NO pipeline state of its own. After every edit its state is
 * `projectStages(draft)` again, which is what keeps id minting where phase 1 put it: a
 * member being added is constructed with `nodeId: null`, `compileStages` mints the real id,
 * and the next projection hands it back. An editor that kept its own pipeline between edits
 * would have to mint ids to fill those nulls, and two minters is how undo and the CAS
 * autosave start disagreeing about which node is which.
 *
 * Joins, fail routes, return edges and reachability are never authored here - they fall out
 * of `compileStages`. That is the whole point: the grammar the canvas made an operator
 * hand-draw (and then scolded them with codes for missing) is unrepresentable instead of
 * policed.
 *
 * The local state below is transient UI only: which seam has its picker open, and which item
 * is being dragged.
 */

export interface MemberRef {
  stage: number;
  member: number;
}

/**
 * A member an edit is about to ADD, before any graph has given it an identity.
 *
 * `StageMember` minus `nodeId`, written out rather than `Omit`ed: `Omit` over a union keeps
 * only the keys both arms share, which here is `nodeId` alone - exactly the field being
 * dropped - so the result would be an empty object type that accepts anything.
 */
export type StageMemberSeed =
  | { kind: "persona"; personaId: PersonaId }
  | { kind: "check"; slot: WorkflowCheckSlot };

/**
 * A whole STAGE an edit is about to create, which is one more thing than a member seed.
 *
 * A Persona or a Check seeds an evaluation stage that can later gain siblings; a session
 * action seeds a stage that is complete the moment it exists and can never hold a second
 * thing. Kept as one union because the two are alternatives at exactly one control - the
 * insert picker - and splitting them there would give an operator two "add" gestures for
 * what is, to them, one decision about what comes next.
 */
export type StageSeed =
  | StageMemberSeed
  | { kind: "session_action"; sessionActionId: SessionActionId };

const seeded = (seed: StageMemberSeed): StageMember => ({ ...seed, nodeId: null });

/** The stage a seed means, with no identity yet - `compileStages` is still the only minter. */
const seededStage = (seed: StageSeed): Stage => seed.kind === "session_action"
  ? { kind: "session_action", member: { nodeId: null, ...seed } }
  : { kind: "evaluation", joinId: null, members: [seeded(seed)] };

const withStages = (pipeline: StagePipeline, stages: Stage[]): StagePipeline =>
  ({ ...pipeline, stages });

/**
 * The stage at `index`, but only if it is an evaluation wave.
 *
 * Only the MEMBER operations go through this now - add, remove, and move one thing inside or
 * between stages - because those are the edits that are meaningless on a session action: it
 * holds exactly one thing by construction, so there is nothing to add beside it and nothing
 * to take out of it that would leave a stage behind. Stage-level edits (insert, remove,
 * reorder) deliberately do NOT use it: an action stage moves and is removed exactly like an
 * evaluation stage, and routing them through an evaluation-only lookup is what made those
 * affordances disappear in the phase before authoring shipped.
 *
 * Returning `null` rather than throwing keeps every edit a no-op on a shape it does not
 * understand, which is the same thing these functions already do for an out-of-range index.
 */
function evaluationStage(pipeline: StagePipeline, index: number): EvaluationStage | null {
  const stage = pipeline.stages[index];
  return stage?.kind === "evaluation" ? stage : null;
}

/**
 * The structural edits, as pure functions over a pipeline.
 *
 * Every surviving identity is carried verbatim so `compileStages` reuses it; only genuinely
 * new members carry `nodeId: null`. A stage that loses its last member stops being a stage
 * rather than being emitted as an empty one - the compiler drops empty stages anyway, and
 * leaving one behind would make the editor's shape disagree with the next projection.
 *
 * They are "member" operations rather than "reviewer" ones because a stage now holds two
 * kinds of thing, and every one of them treats both identically: a check reorders, moves
 * between stages and is removed by exactly the code path a Persona is.
 */
export function addMember(
  pipeline: StagePipeline,
  stageIndex: number,
  seed: StageMemberSeed,
): StagePipeline {
  const target = evaluationStage(pipeline, stageIndex);
  if (!target) return pipeline;
  return withStages(pipeline, pipeline.stages.map((stage, index) => index === stageIndex
    ? { ...target, members: [...target.members, seeded(seed)] }
    : stage));
}

export function insertStage(
  pipeline: StagePipeline,
  at: number,
  seed: StageSeed,
): StagePipeline {
  const stages = [...pipeline.stages];
  const index = Math.max(0, Math.min(stages.length, at));
  stages.splice(index, 0, seededStage(seed));
  return withStages(pipeline, stages);
}

/**
 * Point an existing action stage at a different action.
 *
 * The node id is CARRIED, which is the whole point: swapping which action a stage sends is a
 * change of reference, not a new stage, so `compileStages` reuses the node and every edge
 * around it and the autosave sees one field move rather than a delete and an insert.
 */
export function replaceStageAction(
  pipeline: StagePipeline,
  stageIndex: number,
  sessionActionId: SessionActionId,
): StagePipeline {
  const stage = pipeline.stages[stageIndex];
  if (stage?.kind !== "session_action") return pipeline;
  if (stage.member.sessionActionId === sessionActionId) return pipeline;
  return withStages(pipeline, pipeline.stages.map((candidate, index) => index === stageIndex
    ? { kind: "session_action", member: { ...stage.member, sessionActionId } }
    : candidate));
}

export function removeMember(pipeline: StagePipeline, ref: MemberRef): StagePipeline {
  const target = evaluationStage(pipeline, ref.stage);
  if (!target?.members[ref.member]) return pipeline;
  return withStages(pipeline, pipeline.stages.flatMap((stage, index) => {
    if (index !== ref.stage) return [stage];
    const members = target.members.filter((_, member) => member !== ref.member);
    return members.length === 0 ? [] : [{ ...target, members }];
  }));
}

export function removeStage(pipeline: StagePipeline, stageIndex: number): StagePipeline {
  if (!pipeline.stages[stageIndex]) return pipeline;
  return withStages(pipeline, pipeline.stages.filter((_, index) => index !== stageIndex));
}

/**
 * Whether a stage may travel from one position to another.
 *
 * Now a pure range check, and the absence of a session-action clause is the change this
 * phase makes rather than an omission. The barrier that used to be here existed because an
 * action was unauthorable: moving one - or moving another stage PAST one, which splices it
 * to a new index - would have edited a card the whole surface drew as read-only. Both halves
 * of that reasoning are gone. An action may appear anywhere a pipeline allows, `compileStages`
 * rewrites the routes around it the same way it does for any neighbour, and the operator who
 * moved it is the one who authored it.
 *
 * Still exported, and the reorder handlers still ask BEFORE they announce: an out-of-range
 * move is a silent no-op, and announcing it would tell a screen-reader user a stage moved
 * when nothing did.
 */
export function stageReorderAllowed(pipeline: StagePipeline, from: number, to: number): boolean {
  if (!pipeline.stages[from]) return false;
  return to >= 0 && to < pipeline.stages.length && from !== to;
}

export function moveStage(pipeline: StagePipeline, from: number, to: number): StagePipeline {
  if (!stageReorderAllowed(pipeline, from, to)) return pipeline;
  const stages = [...pipeline.stages];
  const [moved] = stages.splice(from, 1);
  stages.splice(to, 0, moved!);
  return withStages(pipeline, stages);
}

/** Moves one member, within its stage or into another one. */
export function moveMember(
  pipeline: StagePipeline,
  from: MemberRef,
  to: MemberRef,
): StagePipeline {
  const source = evaluationStage(pipeline, from.stage);
  const moved = source?.members[from.member];
  // BOTH ends have to be an evaluation wave. A member dropped into a session action stage
  // would make a mixed stage the runtime cannot execute, and one dragged out of it does not
  // exist. This refusal is permanent - it is the singleton rule, not a phase gate.
  const target = evaluationStage(pipeline, to.stage);
  if (!source || !moved || !target) return pipeline;
  if (from.stage === to.stage) {
    if (to.member < 0 || to.member >= source.members.length || to.member === from.member) {
      return pipeline;
    }
    const members = [...source.members];
    members.splice(from.member, 1);
    members.splice(to.member, 0, moved);
    return withStages(pipeline, pipeline.stages.map((stage, index) => index === from.stage
      ? { ...source, members }
      : stage));
  }
  const stages: Stage[] = pipeline.stages.map((stage, index) => {
    if (index === from.stage) {
      return { ...source, members: source.members.filter((_, member) => member !== from.member) };
    }
    if (index === to.stage) {
      const members = [...target.members];
      members.splice(Math.max(0, Math.min(members.length, to.member)), 0, moved);
      return { ...target, members };
    }
    return stage;
  });
  return withStages(
    pipeline,
    stages.filter((stage) => stage.kind !== "evaluation" || stage.members.length > 0),
  );
}

/**
 * The roving tab order across the whole strip, in reading order. Exported because it is the
 * one place that decides what "next" means, and the a11y suite asserts against it rather
 * than against rendered markup.
 */
export function pipelineFocusOrder(pipeline: StagePipeline): string[] {
  return [
    "session",
    ...pipeline.stages.flatMap((stage, index) => [
      `stage:${index}`,
      // A session action stage contributes its CARD and no member stop, and that is still
      // right now that one is authorable: the card IS the action - it is what reorders, what
      // Delete removes, and what the replace picker belongs to. A second roving stop on the
      // singleton inside it would answer none of those keys differently.
      ...(stage.kind === "evaluation"
        ? stage.members.map((_, member) => `member:${index}:${member}`)
        : []),
    ]),
    "end",
  ];
}

/**
 * What a stage seam says about the gate its predecessor has to clear.
 *
 * The word itself comes from `stageSeamGate`, which the run monitor reads too; this wrapper
 * only adds the editor's "no stage here" answer.
 */
export function seamGate(stage: Stage | undefined): string | null {
  return stage ? stageSeamGate(stage) : null;
}

/**
 * Where a moved member's destination stage ENDS UP, which is not always where the drop aimed.
 *
 * Taking the last member out of a stage removes that stage (`moveMember`), and every
 * later stage shifts down one - so dragging the only member of Stage 1 into Stage 2 lands
 * it in what is now Stage 1. The move was always right; naming the destination by its
 * pre-move index is what made the announcement say "Stage 2" about a stage that no longer
 * exists. Only a CROSS-stage move can empty a stage, so a reorder within one is unaffected.
 */
export function landedStageIndex(
  pipeline: StagePipeline,
  from: MemberRef,
  to: MemberRef,
): number {
  const source = pipeline.stages[from.stage];
  const emptiesSource = from.stage !== to.stage
    && source !== undefined
    && stageMembers(source).length === 1;
  return emptiesSource && to.stage > from.stage ? to.stage - 1 : to.stage;
}

/**
 * How a member reaches the add pickers and comes back, since a `<select>` carries one string.
 *
 * Prefixed rather than bare so a Persona whose id happened to spell a slot cannot be read as a
 * check, and so an unparseable value (a stale option from an older build) is `null` and adds
 * nothing rather than adding the wrong kind of thing.
 */
export function memberOptionValue(seed: StageMemberSeed): string {
  return seed.kind === "check" ? `check:${seed.slot}` : `persona:${seed.personaId}`;
}

export function parseMemberOption(value: string): StageMemberSeed | null {
  if (value.startsWith("persona:")) {
    const personaId = value.slice("persona:".length);
    return personaId ? { kind: "persona", personaId } : null;
  }
  if (!value.startsWith("check:")) return null;
  const slot = WORKFLOW_CHECK_SLOTS.find((candidate) => candidate === value.slice("check:".length));
  return slot ? { kind: "check", slot } : null;
}

/** The same encoding widened to whole stages, so one `<select>` can offer all three. */
export function stageOptionValue(seed: StageSeed): string {
  return seed.kind === "session_action"
    ? `session_action:${seed.sessionActionId}`
    : memberOptionValue(seed);
}

export function parseStageOption(value: string): StageSeed | null {
  if (value.startsWith("session_action:")) {
    const sessionActionId = value.slice("session_action:".length);
    return sessionActionId ? { kind: "session_action", sessionActionId } : null;
  }
  return parseMemberOption(value);
}

/**
 * The noun a seed IS, for the sentence that announces adding it.
 *
 * Separate from the label because the announcement needs both: "Inserted a stage at position
 * 2 with Tidy the workspace" says nothing about what kind of thing just entered the pipeline,
 * and the difference between a reviewer and an action is the one an operator must not miss.
 */
export function stageSeedNoun(seed: StageSeed): string {
  if (seed.kind === "session_action") return "session action";
  return seed.kind === "check" ? "check" : "reviewer";
}

/**
 * A module constant rather than a `?? new Set()` default, so a caller that omits it does not
 * hand this component a new identity on every render and re-run every memo hanging off it.
 */
const EMPTY_COMPLETIONS: ReadonlySet<SessionActionCompletionKind> = new Set();

/** The same reason, for the policy: a stable identity, and the honest default of no footer. */
const NO_COMPLETION_POLICY: WorkflowCompletionPolicy = { kind: "none" };

export function PipelineEditor({
  graph,
  personas,
  sessionActions = [],
  availableCompletions = EMPTY_COMPLETIONS,
  completionPolicy = NO_COMPLETION_POLICY,
  readOnly = false,
  onChange,
  onConfirm,
  onAnnounce,
}: {
  graph: WorkflowDraftGraph;
  personas: PersonaView[];
  /**
   * The whole action catalog, archived rows included, for two jobs: naming whatever a stage
   * already points at, and populating the pickers. The pickers narrow it themselves - a row
   * this build cannot run must be nameable without being offerable.
   */
  sessionActions?: SessionAction[];
  /**
   * Completion adapters this DAEMON reported it can execute. Empty offers no action at all,
   * which is the correct answer while the capability read is in flight or has failed: an
   * action added against an adapter the server cannot run publishes to a 422.
   */
  availableCompletions?: ReadonlySet<SessionActionCompletionKind>;
  /**
   * The workflow's completion policy, which draws the fixed Inspector footer after End.
   *
   * Passed rather than edited: this editor authors the graph, and Inspector is not in it.
   * Its switches live in the settings rail, which is exactly what the footer says.
   */
  completionPolicy?: WorkflowCompletionPolicy;
  readOnly?: boolean;
  onChange: (graph: WorkflowDraftGraph) => void;
  onConfirm: (request: WorkflowConfirmRequest) => void;
  onAnnounce: (message: string) => void;
}): React.JSX.Element | null {
  const pipeline = useMemo(() => projectStages(graph), [graph]);
  const activePersonas = useMemo(
    () => personasForDisplay(personas).filter((persona) => persona.archivedAt === null),
    [personas],
  );
  const addableActions = useMemo(
    () => addableSessionActions(sessionActions, availableCompletions),
    [availableCompletions, sessionActions],
  );
  const [focusKey, setFocusKey] = useState("session");
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [dragging, setDragging] = useState<
    { kind: "member"; ref: MemberRef } | { kind: "stage"; index: number } | null
  >(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  // A graph the Pipeline view is showing is stage-expressible by construction (the toggle
  // refuses otherwise), so this is a type narrowing rather than a fallback path.
  if (!pipeline) return null;

  const order = pipelineFocusOrder(pipeline);
  const current = order.includes(focusKey) ? focusKey : order[0]!;
  const personaById = new Map(personas.map((persona) => [persona.id, persona]));
  const nameOf = (personaId: string): string => personaById.get(personaId)?.name ?? "Missing persona";
  /**
   * The one human name for a member, whichever kind it is. Every sentence, announcement and
   * aria label composes from this rather than reaching for `personaId`, which is how a check
   * gets described as itself instead of as a missing Persona.
   */
  const labelOfMember = (member: StageMember): string =>
    member.kind === "check" ? checkLabel(member.slot) : nameOf(member.personaId);
  /** What a member IS, for the sentences that need the noun rather than the name. */
  const nounOfMember = (member: StageMember): string =>
    member.kind === "check" ? "Command" : "reviewer";
  const actionById = new Map(sessionActions.map((action) => [action.id, action]));
  /**
   * What an action row says about itself: what it needs, and what proves it finished.
   *
   * The completion is spelled as the thing the runtime PROVES rather than as its adapter
   * id, so a reader learns what has to happen instead of a server-side spelling. An archived
   * source is named too - the draft is still valid to hold and edit, but it will not publish
   * until it is replaced or restored, and that is a fact the card owes its reader before the
   * Publish button turns out to be off.
   */
  const metaOfAction = (sessionActionId: string): string => {
    const action = actionById.get(sessionActionId);
    if (!action) return "This session action no longer exists";
    return [
      sessionActionSkillLabel(action.requiredSkillId),
      `Completes when ${sessionActionCompletionLabel(action.completion).toLocaleLowerCase("en-US")}`,
      ...(action.archivedAt === null ? [] : ["Archived - replace it before publishing"]),
    ].join(" · ");
  };
  const nameOfAction = (sessionActionId: string): string =>
    actionById.get(sessionActionId)?.name ?? "Missing session action";
  /** The stage's derived NAME, which is what its card is titled. */
  const labelOfStage = (index: number): string =>
    stageName(pipeline.stages[index]!, index, personas, sessionActions);
  /**
   * How a stage is REFERRED TO in a sentence about it or about its members. Positional,
   * always, because the derived name of a one-reviewer stage IS that reviewer: "remove
   * Security reviewer from Security reviewer" is what naming it any other way produces.
   * Spelled the way `stageName` and `stageBlockers` spell a parallel stage, so the same
   * stage reads the same word wherever it is mentioned.
   */
  const refOfStage = (index: number): string => `Stage ${index + 1}`;

  const moveFocus = (key: string): void => {
    setFocusKey(key);
    window.requestAnimationFrame(() => {
      root.current?.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)?.focus();
    });
  };

  const apply = (next: StagePipeline, announcement: string): void => {
    onChange(compileStages(next, graph));
    onAnnounce(announcement);
  };

  /** Arrow / Home / End navigation, shared by every roving stop. Returns true if handled. */
  const navigate = (event: React.KeyboardEvent<HTMLElement>): boolean => {
    if (event.altKey || event.metaKey || event.ctrlKey) return false;
    const index = order.indexOf(current);
    const next = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? order[index + 1]
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? order[index - 1]
        : event.key === "Home"
          ? order[0]
          : event.key === "End"
            ? order[order.length - 1]
            : undefined;
    if (!next) return false;
    event.preventDefault();
    moveFocus(next);
    return true;
  };

  const confirmRemoveMember = (ref: MemberRef): void => {
    const stage = evaluationStage(pipeline, ref.stage);
    const member = stage?.members[ref.member];
    if (!stage || !member) return;
    const label = labelOfMember(member);
    const noun = nounOfMember(member);
    const stageRef = refOfStage(ref.stage);
    onConfirm({
      title: `Remove ${noun}`,
      body: stage.members.length === 1
        ? `Remove ${label}? It is the only ${noun} in ${stageRef}, so the stage goes with it.`
        : `Remove ${label} from ${stageRef}? The rest of the stage keeps its routes.`,
      confirmLabel: `Remove ${noun}`,
      confirmHint: `Removes the ${noun} and regenerates the routes around it`,
      danger: true,
      onConfirm: () => {
        apply(removeMember(pipeline, ref), `Removed ${label} from ${stageRef}`);
        moveFocus("session");
      },
    });
  };

  const confirmRemoveStage = (index: number): void => {
    const stage = pipeline.stages[index];
    if (!stage) return;
    const stageRef = refOfStage(index);
    // An action's removal is described by what STOPS HAPPENING rather than by a member list:
    // taking one out does not merely shorten the pipeline, it removes the fresh-evidence
    // checkpoint that everything below it was reviewing against.
    const body = stage.kind === "session_action"
      ? `Remove ${stageRef}, which sends ${nameOfAction(stage.member.sessionActionId)} to the `
        + "bound session? The stages after it go back to reviewing the evidence the stages "
        + "above it saw."
      : `Remove ${stageRef} and its ${stageContents(stage)}: ${
        stage.members.map(labelOfMember).join(", ")}?`;
    onConfirm({
      title: "Remove stage",
      body,
      confirmLabel: "Remove stage",
      confirmHint: "Removes the stage and rejoins whatever sits on either side of it",
      danger: true,
      onConfirm: () => {
        apply(removeStage(pipeline, index), `Removed ${stageRef}`);
        moveFocus("session");
      },
    });
  };

  const add = (stageIndex: number, value: string): void => {
    const seed = parseMemberOption(value);
    if (!seed) return;
    apply(
      addMember(pipeline, stageIndex, seed),
      `Added ${labelOfMember(seeded(seed))} to ${refOfStage(stageIndex)}`,
    );
  };

  /** The name a seed will carry once it is a stage, for the announcement that says so. */
  const labelOfSeed = (seed: StageSeed): string => seed.kind === "session_action"
    ? nameOfAction(seed.sessionActionId)
    : labelOfMember(seeded(seed));

  const insert = (at: number, value: string): void => {
    const seed = parseStageOption(value);
    if (!seed) return;
    setInsertAt(null);
    apply(
      insertStage(pipeline, at, seed),
      `Inserted a stage at position ${at + 1} with ${stageSeedNoun(seed)} ${labelOfSeed(seed)}`,
    );
  };

  const replaceAction = (stageIndex: number, sessionActionId: string): void => {
    const stage = pipeline.stages[stageIndex];
    if (stage?.kind !== "session_action") return;
    if (stage.member.sessionActionId === sessionActionId) return;
    apply(
      replaceStageAction(pipeline, stageIndex, sessionActionId),
      `${refOfStage(stageIndex)} now sends ${nameOfAction(sessionActionId)}`,
    );
  };

  const reorderMember = (ref: MemberRef, delta: number): void => {
    const stage = evaluationStage(pipeline, ref.stage);
    const member = stage?.members[ref.member];
    if (!stage || !member) return;
    const to = ref.member + delta;
    if (to < 0 || to >= stage.members.length) return;
    apply(
      moveMember(pipeline, ref, { stage: ref.stage, member: to }),
      `Moved ${labelOfMember(member)} to position ${to + 1} of ${stage.members.length} in ${refOfStage(ref.stage)}`,
    );
    moveFocus(`member:${ref.stage}:${to}`);
  };

  const reorderStage = (index: number, delta: number): void => {
    const to = index + delta;
    // Asked BEFORE announcing. `moveStage` returning the pipeline unchanged is a silent
    // no-op, and the announcement below would still have told a screen-reader user the
    // stage had moved - and moved focus to a card that never went anywhere.
    if (!stageReorderAllowed(pipeline, index, to)) return;
    apply(
      moveStage(pipeline, index, to),
      `Moved ${refOfStage(index)} to position ${to + 1} of ${pipeline.stages.length}`,
    );
    moveFocus(`stage:${to}`);
  };

  /** Drag payloads never leave this component, so the ref travels in local state. */
  const beginDrag = (event: React.DragEvent<HTMLElement>, kind: "member" | "stage"): void => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", kind);
    event.stopPropagation();
  };

  const acceptDrop = (key: string) => (event: React.DragEvent<HTMLElement>): void => {
    if (!dragging || readOnly) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dropTarget !== key) setDropTarget(key);
  };

  const endDrag = (): void => {
    setDragging(null);
    setDropTarget(null);
  };

  const dropOnMember = (to: MemberRef) => (event: React.DragEvent<HTMLElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!dragging || dragging.kind !== "member") return endDrag();
    const moved = evaluationStage(pipeline, dragging.ref.stage)?.members[dragging.ref.member];
    if (moved) {
      apply(
        moveMember(pipeline, dragging.ref, to),
        `Moved ${labelOfMember(moved)} into ${refOfStage(landedStageIndex(pipeline, dragging.ref, to))}`,
      );
    }
    endDrag();
  };

  const dropOnStage = (stageIndex: number) => (event: React.DragEvent<HTMLElement>): void => {
    event.preventDefault();
    if (!dragging) return endDrag();
    if (dragging.kind === "member") {
      const moved = evaluationStage(pipeline, dragging.ref.stage)?.members[dragging.ref.member];
      const to = {
        stage: stageIndex,
        member: evaluationStage(pipeline, stageIndex)?.members.length ?? 0,
      };
      if (moved && dragging.ref.stage !== stageIndex) {
        apply(
          moveMember(pipeline, dragging.ref, to),
          `Moved ${labelOfMember(moved)} into ${refOfStage(landedStageIndex(pipeline, dragging.ref, to))}`,
        );
      }
    }
    endDrag();
  };

  /** The landing index a drop on the seam BEFORE `at` means, once the drag is spliced out. */
  const seamLanding = (at: number, from: number): number => (at > from ? at - 1 : at);

  /**
   * Whether a stage drag may be dropped on this seam. Consulted by the drop target itself,
   * so a seam that would be a no-op never lights up - a highlighted target that then refuses
   * the drop is worse than one that was never offered.
   */
  const seamAcceptsDrag = (at: number): boolean =>
    dragging?.kind === "stage"
    && stageReorderAllowed(pipeline, dragging.index, seamLanding(at, dragging.index));

  const dropOnSeam = (at: number) => (event: React.DragEvent<HTMLElement>): void => {
    event.preventDefault();
    if (!dragging || dragging.kind !== "stage") return endDrag();
    // Removing the stage first shifts every later position down by one.
    const to = seamLanding(at, dragging.index);
    if (to !== dragging.index) reorderStage(dragging.index, to - dragging.index);
    endDrag();
  };

  /**
   * Both kinds in one control, grouped, because they are alternatives for the same slot in a
   * stage rather than two different gestures.
   *
   * Checks are ALWAYS offered: the slots are a fixed vocabulary, not operator data, so an
   * install with no Personas authored yet can still build a deterministic pipeline. That is
   * why the pickers below no longer disable on an empty Persona list - only `readOnly` closes
   * them now.
   */
  const memberOptions = (
    <>
      {activePersonas.length > 0 && (
        <optgroup label="Reviewers">
          {activePersonas.map((persona) => (
            <option key={persona.id} value={memberOptionValue({ kind: "persona", personaId: persona.id })}>
              {persona.name}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="Commands">
        {WORKFLOW_CHECK_SLOTS.map((slot) => (
          <option key={slot} value={memberOptionValue({ kind: "check", slot })}>
            {checkLabel(slot)}
          </option>
        ))}
      </optgroup>
    </>
  );

  /**
   * The same two groups plus the third KIND of stage, for the control that creates one.
   *
   * Session actions are a group of the insert picker and deliberately not of `addPicker`: an
   * action is a whole stage, not a member, so the control that adds a thing to an existing
   * evaluation wave has nothing to do with it. Listing it there and then quietly inserting a
   * neighbouring stage instead would be an add control that does something other than what
   * it says.
   *
   * The group is OMITTED, never disabled, when nothing is addable - the daemon may report no
   * runnable adapter, or the catalog may be empty - because a group of options that all
   * refuse reads as a broken control rather than as a rule.
   */
  const stageOptions = (
    <>
      {memberOptions}
      {addableActions.length > 0 && (
        <optgroup label="Session actions">
          {addableActions.map((action) => (
            <option
              key={action.id}
              value={stageOptionValue({ kind: "session_action", sessionActionId: action.id })}
            >
              {action.name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );

  /** Said once, wherever an empty Persona list needs explaining without blocking the control. */
  const personaHint = activePersonas.length === 0
    ? " No Personas authored yet, so only Commands are available."
    : "";
  /**
   * Why the Session actions group is missing, when it is. Said in the tooltip rather than as
   * a disabled row, so the answer is where an operator looks for it and not in the list they
   * were choosing from.
   */
  const actionHint = addableActions.length > 0
    ? ""
    : sessionActions.length === 0
      ? " No session actions authored yet - the Actions tab is where they live."
      : " No session action here can run on this daemon yet, so none is offered.";

  const addPicker = (stageIndex: number, stageRef: string): React.JSX.Element => (
    <Tooltip label={`Add a reviewer or Command to ${stageRef}.${personaHint}`}>
      <label className="wf-pipeline-add">
        <span className="sr-only">{`Add a reviewer or Command to ${stageRef}`}</span>
        <select
          disabled={readOnly}
          value=""
          onChange={(event) => add(stageIndex, event.target.value)}
        >
          <option value="">＋ Add reviewer or Command…</option>
          {memberOptions}
        </select>
      </label>
    </Tooltip>
  );

  /**
   * Which action an existing action stage sends.
   *
   * A REPLACE control rather than an add: the stage already exists, so this changes one
   * reference and keeps the node id, which is what stops a swap from looking like a delete
   * and an insert to the autosave and to undo.
   */
  const actionPicker = (stageIndex: number, sessionActionId: string, stageRef: string): React.JSX.Element => {
    const choices = sessionActionChoicesForDisplay(
      sessionActions,
      [sessionActionId],
      availableCompletions,
    );
    const label = `Choose the session action ${stageRef} sends`;
    return (
      <Tooltip label={`${label}.${actionHint}`}>
        <label className="wf-pipeline-add">
          <span className="sr-only">{label}</span>
          <select
            disabled={readOnly}
            value={sessionActionId}
            onChange={(event) => replaceAction(stageIndex, event.target.value)}
          >
            {/* A source that vanished from the catalog entirely still needs an option, or
                the select would render as though a different action were chosen. */}
            {!choices.some(({ action }) => action.id === sessionActionId) && (
              <option value={sessionActionId}>Missing session action</option>
            )}
            {choices.map(({ action, retained }) => (
              <option key={action.id} value={action.id}>
                {sessionActionChoiceLabel(action, retained, availableCompletions)}
              </option>
            ))}
          </select>
        </label>
      </Tooltip>
    );
  };

  const insertPicker = (at: number, label: string): React.JSX.Element => (
    insertAt === at ? (
      <Tooltip label={`${label}. Escape cancels.`}>
        <label className="wf-pipeline-insert-picker">
          <span className="sr-only">{label}</span>
          <select
            autoFocus
            value=""
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              setInsertAt(null);
            }}
            onChange={(event) => insert(at, event.target.value)}
          >
            <option value="">Choose what this stage does…</option>
            {stageOptions}
          </select>
        </label>
      </Tooltip>
    ) : (
      <Tooltip label={`${label}.${personaHint}${actionHint}`}>
        <button
          type="button"
          className="btn btn-ghost wf-pipeline-insert"
          disabled={readOnly}
          aria-label={label}
          onClick={() => setInsertAt(at)}
        >
          ＋ Stage
        </button>
      </Tooltip>
    )
  );

  const memberState = (key: string, ref: MemberRef): PipelineItemState =>
    dragging?.kind === "member"
      && dragging.ref.stage === ref.stage
      && dragging.ref.member === ref.member
      ? "dragging"
      : dropTarget === key ? "drop-target" : "idle";

  return (
    <div className="wf-pipeline-editor" ref={root}>
      <PipelineFrame
        ariaLabel="Workflow pipeline editor"
        repair={pipeline.stages.length === 0 ? null : pipeline.stages.some(
          (stage) => stage.kind === "session_action",
        )
          // Both facts, because an operator who has just placed an action needs to know that
          // the two things a stage can do to the run are DIFFERENT: a fail spends a repair
          // round and restarts from Session, while an action captures fresh evidence and
          // carries on downstream without spending one.
          ? "Any fail returns the submission to Session for repair, then the whole pipeline"
            + " runs again. A session action finishing is not a repair: it captures fresh"
            + " evidence and only the stages after it run again, against the new evidence."
          : "Any fail returns the submission to Session for repair, then the whole pipeline runs again."}
      >
        <TerminusCard
          kind="session"
          name="Session"
          subtitle="Submits the work"
          item={{
            tabIndex: current === "session" ? 0 : -1,
            focusKey: "session",
            ariaLabel: "Session, where the pipeline starts",
            onFocus: () => setFocusKey("session"),
            onKeyDown: (event) => { navigate(event); },
          }}
        />

        {/* The top seam takes a stage drop like every other seam. Without it the FIRST
            position was reachable by Alt+Left and by nothing else, which is a gap a reader
            of "reorders any stage" would not expect. */}
        <div
          className="wf-pipeline-seam-slot"
          onDragOver={seamAcceptsDrag(0) ? acceptDrop("seam:0") : undefined}
          onDrop={dropOnSeam(0)}
        >
          <StageSeam gate="submitted">
            {pipeline.stages.length > 0 && insertPicker(0, `Insert a stage before ${refOfStage(0)}`)}
          </StageSeam>
        </div>

        {pipeline.stages.length === 0 && (
          <StageCard
            name="No stages yet"
            subtitle="Add one, and the submission routes through it"
            state="idle"
          >
            <ul className="wf-pipeline-members">
              <li className="wf-pipeline-empty">
                Session completes on submission until a reviewer, a Command or a session action
                stands between it and the End.
              </li>
            </ul>
            <div className="wf-pipeline-stage-foot">
              <Tooltip label={`Add the first stage.${personaHint}${actionHint}`}>
                <label className="wf-pipeline-add">
                  <span className="sr-only">Add the first stage</span>
                  <select
                    disabled={readOnly}
                    value=""
                    onChange={(event) => insert(0, event.target.value)}
                  >
                    <option value="">＋ Add a stage…</option>
                    {stageOptions}
                  </select>
                </label>
              </Tooltip>
            </div>
          </StageCard>
        )}

        {pipeline.stages.map((stage, index) => {
          const stageKey = `stage:${index}`;
          const stageLabel = labelOfStage(index);
          const stageRef = refOfStage(index);
          const subtitle = stageSummary(stage);
          // Only the workflow's own read-only state locks a card now. An action stage drags,
          // reorders and is removed exactly like an evaluation stage - what it does NOT have
          // is a member list to add to, which is a different control, handled below.
          const locked = readOnly;
          const isAction = stage.kind === "session_action";
          // The noun the stage's own controls use. Spelled here rather than at each button so
          // the Remove tooltip, its aria label and the confirmation cannot describe the same
          // card three ways - "every reviewer in it" is wrong for a stage with none.
          const removeHint = isAction
            ? `Remove ${stageRef} and the session action it sends`
            : `Remove ${stageRef} and every reviewer in it`;
          return (
            <div className="wf-pipeline-slot" key={stageKey}>
              <StageCard
                name={stageLabel}
                subtitle={subtitle}
                state={dragging?.kind === "stage" && dragging.index === index
                  ? "dragging"
                  : dropTarget === stageKey ? "drop-target" : "idle"}
                header={{
                  tabIndex: current === stageKey ? 0 : -1,
                  focusKey: stageKey,
                  // The KIND is in the accessible name, ahead of the summary, because a
                  // screen-reader user arriving on this card otherwise hears a name and a
                  // member count that read exactly like a one-reviewer stage.
                  ariaLabel: `${stageLabel}, ${isAction ? "session action stage, " : ""}${stageRef} of ${pipeline.stages.length}, ${subtitle}`,
                  draggable: !locked,
                  onFocus: () => setFocusKey(stageKey),
                  onDragStart: (event) => {
                    beginDrag(event, "stage");
                    setDragging({ kind: "stage", index });
                  },
                  onDragEnd: endDrag,
                  onKeyDown: (event) => {
                    if (navigate(event)) return;
                    if (locked) return;
                    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                      event.preventDefault();
                      reorderStage(index, event.key === "ArrowLeft" ? -1 : 1);
                      return;
                    }
                    if (event.key === "Delete" || event.key === "Backspace") {
                      event.preventDefault();
                      confirmRemoveStage(index);
                    }
                  },
                }}
                frame={{ onDragOver: acceptDrop(stageKey), onDrop: dropOnStage(index) }}
                actions={!locked && (
                  <Tooltip label={removeHint}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      aria-label={`Remove ${stageRef}`}
                      onClick={() => confirmRemoveStage(index)}
                    >
                      Remove
                    </button>
                  </Tooltip>
                )}
              >
                <ul className="wf-pipeline-members">
                  {stage.kind === "session_action" && (
                    <ReviewerRow
                      kind="session_action"
                      name={stageLabel}
                      meta={metaOfAction(stage.member.sessionActionId)}
                      state="idle"
                      item={{
                        tabIndex: -1,
                        focusKey: `${stageKey}:action`,
                        ariaLabel: `${stageLabel}, session action in ${stageRef}`,
                      }}
                    />
                  )}
                  {stage.kind === "evaluation" && stage.members.map((member, memberIndex) => {
                    const key = `member:${index}:${memberIndex}`;
                    const ref = { stage: index, member: memberIndex };
                    const label = labelOfMember(member);
                    const noun = nounOfMember(member);
                    // A check's row names the SLOT and says what an unconfigured one does,
                    // because that is the only thing about it an author can get wrong: the
                    // command itself is deliberately not part of the workflow.
                    const persona = member.kind === "persona"
                      ? personaById.get(member.personaId)
                      : undefined;
                    const meta = member.kind === "check"
                      ? "Deterministic gate · passes when no command is configured here"
                      : persona
                        ? `${persona.execution.runner.id} · ${persona.execution.model.id}${persona.archivedAt === null ? "" : " · archived"}`
                        : "This Persona no longer exists";
                    return (
                      <ReviewerRow
                        key={key}
                        kind={member.kind}
                        name={member.kind === "check" ? member.slot : label}
                        meta={meta}
                        state={memberState(key, ref)}
                        item={{
                          tabIndex: current === key ? 0 : -1,
                          focusKey: key,
                          ariaLabel: `${label}, ${noun} ${memberIndex + 1} of ${stage.members.length} in ${stageRef}`,
                          draggable: !readOnly,
                          onFocus: () => setFocusKey(key),
                          onDragStart: (event) => {
                            beginDrag(event, "member");
                            setDragging({ kind: "member", ref });
                          },
                          onDragEnd: endDrag,
                          onDragOver: acceptDrop(key),
                          onDrop: dropOnMember(ref),
                          onKeyDown: (event) => {
                            if (navigate(event)) return;
                            if (readOnly) return;
                            if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                              event.preventDefault();
                              reorderMember(ref, event.key === "ArrowUp" ? -1 : 1);
                              return;
                            }
                            if (event.key === "Delete" || event.key === "Backspace") {
                              event.preventDefault();
                              confirmRemoveMember(ref);
                            }
                          },
                        }}
                        actions={!readOnly && (
                          <Tooltip label={`Remove ${label} from ${stageRef}`}>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              aria-label={`Remove ${label} from ${stageRef}`}
                              onClick={() => confirmRemoveMember(ref)}
                            >
                              ✕
                            </button>
                          </Tooltip>
                        )}
                      />
                    );
                  })}
                </ul>
                {/* Two different controls, because they are two different questions. An
                    evaluation stage asks "what else reviews this?"; an action stage holds
                    exactly one thing by construction, so the only question it can answer is
                    "which one?". An Add picker on an action stage would list four reviewers
                    and refuse every one of them, which reads as a bug rather than as a rule. */}
                <div className="wf-pipeline-stage-foot">
                  {stage.kind === "session_action"
                    ? actionPicker(index, stage.member.sessionActionId, stageRef)
                    : addPicker(index, stageRef)}
                </div>
              </StageCard>

              <div
                className="wf-pipeline-seam-slot"
                onDragOver={seamAcceptsDrag(index + 1) ? acceptDrop(`seam:${index + 1}`) : undefined}
                onDrop={dropOnSeam(index + 1)}
              >
                <StageSeam gate={seamGate(stage)}>
                  {insertPicker(
                    index + 1,
                    index + 1 < pipeline.stages.length
                      ? `Insert a stage between ${stageRef} and ${refOfStage(index + 1)}`
                      : `Insert a stage after ${stageRef}`,
                  )}
                </StageSeam>
              </div>
            </div>
          );
        })}

        {pipeline.stages.length === 0 && <StageSeam />}

        <TerminusCard
          kind="end"
          name={pipeline.endOutcome}
          subtitle="Terminal outcome"
          item={{
            tabIndex: current === "end" ? 0 : -1,
            focusKey: "end",
            ariaLabel: `End, ${pipeline.endOutcome}`,
            onFocus: () => setFocusKey("end"),
            onKeyDown: (event) => { navigate(event); },
          }}
        />

        {/* After End, and outside `pipelineFocusOrder` on purpose: the roving order is the
            set of cards an operator can act on, and this is the one card they cannot. */}
        <InspectorFooter policy={completionPolicy} />
      </PipelineFrame>
      <p className="wf-pipeline-keys">
        Arrow keys move between cards. Alt+Left / Alt+Right reorders any stage, Alt+Up /
        Alt+Down reorders a reviewer or Command inside one, Delete removes the focused card after
        a confirmation.
      </p>
    </div>
  );
}
