import { useMemo, useRef, useState } from "react";
import { personasForDisplay, WORKFLOW_CHECK_SLOTS } from "@shared/workflow.ts";
import type {
  PersonaId,
  PersonaView,
  WorkflowCheckSlot,
  WorkflowDraftGraph,
} from "@shared/workflow.ts";
import {
  checkLabel,
  compileStages,
  projectStages,
  stageContents,
  stageName,
  stageSummary,
  type Stage,
  type StageMember,
  type StagePipeline,
} from "@shared/workflow-stages.ts";
import {
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

const seeded = (seed: StageMemberSeed): StageMember => ({ ...seed, nodeId: null });

const withStages = (pipeline: StagePipeline, stages: Stage[]): StagePipeline =>
  ({ ...pipeline, stages });

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
  if (!pipeline.stages[stageIndex]) return pipeline;
  return withStages(pipeline, pipeline.stages.map((stage, index) => index === stageIndex
    ? { ...stage, members: [...stage.members, seeded(seed)] }
    : stage));
}

export function insertStage(
  pipeline: StagePipeline,
  at: number,
  seed: StageMemberSeed,
): StagePipeline {
  const stages = [...pipeline.stages];
  const index = Math.max(0, Math.min(stages.length, at));
  stages.splice(index, 0, { joinId: null, members: [seeded(seed)] });
  return withStages(pipeline, stages);
}

export function removeMember(pipeline: StagePipeline, ref: MemberRef): StagePipeline {
  if (!pipeline.stages[ref.stage]?.members[ref.member]) return pipeline;
  return withStages(pipeline, pipeline.stages.flatMap((stage, index) => {
    if (index !== ref.stage) return [stage];
    const members = stage.members.filter((_, member) => member !== ref.member);
    return members.length === 0 ? [] : [{ ...stage, members }];
  }));
}

export function removeStage(pipeline: StagePipeline, stageIndex: number): StagePipeline {
  if (!pipeline.stages[stageIndex]) return pipeline;
  return withStages(pipeline, pipeline.stages.filter((_, index) => index !== stageIndex));
}

export function moveStage(pipeline: StagePipeline, from: number, to: number): StagePipeline {
  const stages = [...pipeline.stages];
  const moved = stages[from];
  if (!moved || to < 0 || to >= stages.length || from === to) return pipeline;
  stages.splice(from, 1);
  stages.splice(to, 0, moved);
  return withStages(pipeline, stages);
}

/** Moves one member, within its stage or into another one. */
export function moveMember(
  pipeline: StagePipeline,
  from: MemberRef,
  to: MemberRef,
): StagePipeline {
  const source = pipeline.stages[from.stage];
  const moved = source?.members[from.member];
  const target = pipeline.stages[to.stage];
  if (!source || !moved || !target) return pipeline;
  if (from.stage === to.stage) {
    if (to.member < 0 || to.member >= source.members.length || to.member === from.member) {
      return pipeline;
    }
    const members = [...source.members];
    members.splice(from.member, 1);
    members.splice(to.member, 0, moved);
    return withStages(pipeline, pipeline.stages.map((stage, index) => index === from.stage
      ? { ...stage, members }
      : stage));
  }
  const stages = pipeline.stages.map((stage, index) => {
    if (index === from.stage) {
      return { ...stage, members: stage.members.filter((_, member) => member !== from.member) };
    }
    if (index === to.stage) {
      const members = [...stage.members];
      members.splice(Math.max(0, Math.min(members.length, to.member)), 0, moved);
      return { ...stage, members };
    }
    return stage;
  });
  return withStages(pipeline, stages.filter((stage) => stage.members.length > 0));
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
      ...stage.members.map((_, member) => `member:${index}:${member}`),
    ]),
    "end",
  ];
}

/** What a stage seam says about the gate its predecessor has to clear. */
export function seamGate(stage: Stage | undefined): string | null {
  if (!stage) return null;
  return stage.members.length > 1 ? "all pass" : "pass";
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
  const emptiesSource = from.stage !== to.stage
    && pipeline.stages[from.stage]?.members.length === 1;
  return emptiesSource && to.stage > from.stage ? to.stage - 1 : to.stage;
}

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

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

export function PipelineEditor({
  graph,
  personas,
  readOnly = false,
  onChange,
  onConfirm,
  onAnnounce,
}: {
  graph: WorkflowDraftGraph;
  personas: PersonaView[];
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
    member.kind === "check" ? "check" : "reviewer";
  /** The stage's derived NAME, which is what its card is titled. */
  const labelOfStage = (index: number): string =>
    stageName(pipeline.stages[index]!, index, personas);
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
    const stage = pipeline.stages[ref.stage];
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
    const names = stage.members.map(labelOfMember).join(", ");
    onConfirm({
      title: "Remove stage",
      body: `Remove ${stageRef} and its ${stageContents(stage)}: ${names}?`,
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

  const insert = (at: number, value: string): void => {
    const seed = parseMemberOption(value);
    if (!seed) return;
    setInsertAt(null);
    apply(
      insertStage(pipeline, at, seed),
      `Inserted a stage at position ${at + 1} with ${labelOfMember(seeded(seed))}`,
    );
  };

  const reorderMember = (ref: MemberRef, delta: number): void => {
    const stage = pipeline.stages[ref.stage];
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
    if (to < 0 || to >= pipeline.stages.length) return;
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
    const moved = pipeline.stages[dragging.ref.stage]?.members[dragging.ref.member];
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
      const moved = pipeline.stages[dragging.ref.stage]?.members[dragging.ref.member];
      const to = { stage: stageIndex, member: pipeline.stages[stageIndex]?.members.length ?? 0 };
      if (moved && dragging.ref.stage !== stageIndex) {
        apply(
          moveMember(pipeline, dragging.ref, to),
          `Moved ${labelOfMember(moved)} into ${refOfStage(landedStageIndex(pipeline, dragging.ref, to))}`,
        );
      }
    }
    endDrag();
  };

  const dropOnSeam = (at: number) => (event: React.DragEvent<HTMLElement>): void => {
    event.preventDefault();
    if (!dragging || dragging.kind !== "stage") return endDrag();
    // Removing the stage first shifts every later position down by one.
    const to = at > dragging.index ? at - 1 : at;
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
      <optgroup label="Checks">
        {WORKFLOW_CHECK_SLOTS.map((slot) => (
          <option key={slot} value={memberOptionValue({ kind: "check", slot })}>
            {checkLabel(slot)}
          </option>
        ))}
      </optgroup>
    </>
  );

  /** Said once, wherever an empty Persona list needs explaining without blocking the control. */
  const personaHint = activePersonas.length === 0
    ? " No Personas authored yet, so only checks are available."
    : "";

  const addPicker = (stageIndex: number, stageRef: string): React.JSX.Element => (
    <Tooltip label={`Add a reviewer or check to ${stageRef}.${personaHint}`}>
      <label className="wf-pipeline-add">
        <span className="sr-only">{`Add a reviewer or check to ${stageRef}`}</span>
        <select
          disabled={readOnly}
          value=""
          onChange={(event) => add(stageIndex, event.target.value)}
        >
          <option value="">＋ Add reviewer or check…</option>
          {memberOptions}
        </select>
      </label>
    </Tooltip>
  );

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
            <option value="">Choose a reviewer or check…</option>
            {memberOptions}
          </select>
        </label>
      </Tooltip>
    ) : (
      <Tooltip label={`${label}.${personaHint}`}>
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
        repair={pipeline.stages.length > 0
          ? "Any fail returns the submission to Session for repair, then the whole pipeline runs again."
          : null}
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

        <StageSeam gate="submitted">
          {pipeline.stages.length > 0 && insertPicker(0, `Insert a stage before ${refOfStage(0)}`)}
        </StageSeam>

        {pipeline.stages.length === 0 && (
          <StageCard
            name="No reviewers yet"
            subtitle="Add one, and the submission routes through it"
            state="idle"
          >
            <ul className="wf-pipeline-members">
              <li className="wf-pipeline-empty">
                Session completes on submission until a reviewer or a check stands between it
                and the End.
              </li>
            </ul>
            <div className="wf-pipeline-stage-foot">
              <Tooltip label={`Add the first reviewer or check.${personaHint}`}>
                <label className="wf-pipeline-add">
                  <span className="sr-only">Add the first reviewer or check</span>
                  <select
                    disabled={readOnly}
                    value=""
                    onChange={(event) => insert(0, event.target.value)}
                  >
                    <option value="">＋ Add reviewer or check…</option>
                    {memberOptions}
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
                  ariaLabel: `${stageLabel}, ${stageRef} of ${pipeline.stages.length}, ${subtitle}`,
                  draggable: !readOnly,
                  onFocus: () => setFocusKey(stageKey),
                  onDragStart: (event) => {
                    beginDrag(event, "stage");
                    setDragging({ kind: "stage", index });
                  },
                  onDragEnd: endDrag,
                  onKeyDown: (event) => {
                    if (navigate(event)) return;
                    if (readOnly) return;
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
                actions={!readOnly && (
                  <Tooltip label={`Remove ${stageRef} and every reviewer in it`}>
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
                  {stage.members.map((member, memberIndex) => {
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
                      ? "Deterministic gate · passes when no command is configured"
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
                <div className="wf-pipeline-stage-foot">{addPicker(index, stageRef)}</div>
              </StageCard>

              <div
                className="wf-pipeline-seam-slot"
                onDragOver={acceptDrop(`seam:${index + 1}`)}
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
      </PipelineFrame>
      <p className="wf-pipeline-keys">
        Arrow keys move between cards. Alt+Left / Alt+Right reorders a stage, Alt+Up / Alt+Down
        reorders a reviewer or check, Delete removes the focused card after a confirmation.
      </p>
    </div>
  );
}
