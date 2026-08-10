import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  addMember,
  insertStage,
  moveMember,
  moveStage,
  parseStageOption,
  PipelineEditor,
  pipelineFocusOrder,
  removeStage,
  replaceStageAction,
  stageOptionValue,
  stageReorderAllowed,
  stageSeedNoun,
} from "../src/web/workflows/PipelineEditor.tsx";
import { WorkflowProperties } from "../src/web/workflows/WorkflowProperties.tsx";
import { WorkflowVersionDetail } from "../src/web/workflows/WorkflowVersionHistory.tsx";
import { compileStages, projectStages } from "../src/shared/workflow-stages.ts";
import { validateWorkflowGraph } from "../src/shared/workflow-graph.ts";
import { parseDroppedNode } from "../src/web/workflows/new-node.ts";
import type { Stage, StagePipeline } from "../src/shared/workflow-stages.ts";
import type {
  PublishedWorkflowNode,
  SessionAction,
  SessionActionCompletionKind,
  WorkflowDefinition,
  WorkflowDraftGraph,
  WorkflowVersion,
} from "../src/shared/workflow.ts";

/**
 * What is at stake: this phase turns the session action from something the builder could only
 * DRAW into something an operator authors. The load-bearing assertions have flipped with it -
 * the negatives that used to pin "no control exists" are now positives pinning that each
 * control exists AND says what it acts on, plus one negative that has to survive forever: no
 * surface may describe an action in the vocabulary of a reviewer.
 *
 * `renderToStaticMarkup`, no jsdom (house rule), so this covers render and the exported pure
 * edit functions. Behaviour a browser owns is asserted in `e2e/specs/workflow-session-action*`.
 */

const TURN_ONLY = new Set<SessionActionCompletionKind>(["session_turn"]);
const BOTH = new Set<SessionActionCompletionKind>(["session_turn", "pull_request"]);

const action: SessionAction = {
  id: "bbbbbbbb-0000-4000-8000-000000000001",
  name: "Pull Request",
  normalizedName: "pull request",
  description: "Prepare the reviewed work",
  promptMarkdown: "# Pull Request\n\nOpen it.\n",
  requiredSkillId: "pull-request",
  completion: { kind: "pull_request" },
  revision: 2,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  builtin: false,
};

/** A second, runnable action - what the pickers are allowed to offer in this build. */
const tidy: SessionAction = {
  ...action,
  id: "bbbbbbbb-0000-4000-8000-000000000002",
  name: "Tidy the workspace",
  normalizedName: "tidy the workspace",
  description: "Remove the scratch files",
  promptMarkdown: "# Tidy\n\nRemove the scratch files.\n",
  requiredSkillId: null,
  completion: { kind: "session_turn" },
};

const SESSION_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const END_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const ACTION_NODE_ID = "cccccccc-0000-4000-8000-000000000003";

const EMPTY: WorkflowDraftGraph = {
  nodes: [
    { id: SESSION_ID, kind: "session", position: { x: 0, y: 0 } },
    { id: END_ID, kind: "end", outcome: "Complete", position: { x: 300, y: 0 } },
  ],
  edges: [],
};

const PIPELINE: StagePipeline = {
  sessionId: SESSION_ID,
  endId: END_ID,
  endOutcome: "Complete",
  stages: [{
    kind: "session_action",
    member: { nodeId: ACTION_NODE_ID, kind: "session_action", sessionActionId: action.id },
  }],
};

const graph = compileStages(PIPELINE, EMPTY);

const workflow: WorkflowDefinition = {
  id: "dddddddd-0000-4000-8000-000000000004",
  name: "Ship it",
  normalizedName: "ship it",
  description: "",
  draft: graph,
  completionPolicy: { kind: "none" },
  resumptionPolicy: "auto",
  bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
  draftRevision: 1,
  currentVersionId: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  builtin: false,
};

const pipelineMarkup = (
  sessionActions: SessionAction[],
  extra: Partial<Parameters<typeof PipelineEditor>[0]> = {},
): string =>
  renderToStaticMarkup(createElement(PipelineEditor, {
    graph,
    personas: [],
    sessionActions,
    availableCompletions: BOTH,
    onChange: () => {},
    onConfirm: () => {},
    onAnnounce: () => {},
    ...extra,
  }));

/**
 * The EMPTY pipeline, whose one card carries an expanded stage picker.
 *
 * The seam pickers collapse to a `＋ Stage` button until they are clicked, and static markup
 * cannot click. This is the same control with the same options, rendered open, so the option
 * groups are assertable here and the click itself is asserted in the browser suite.
 */
const emptyPipelineMarkup = (
  sessionActions: SessionAction[],
  available: ReadonlySet<SessionActionCompletionKind>,
): string =>
  renderToStaticMarkup(createElement(PipelineEditor, {
    graph: EMPTY,
    personas: [],
    sessionActions,
    availableCompletions: available,
    onChange: () => {},
    onConfirm: () => {},
    onAnnounce: () => {},
  }));

/**
 * What a reader actually sees, with every attribute removed.
 *
 * The "no id on screen" rule is about TEXT: a `<select>` has to carry a machine value on each
 * option, exactly as the Persona picker beside it does, and the browser suite asserts the
 * same thing with `toContainText`. Asserting over raw markup would fail on the one attribute
 * HTML requires and pass on a label that printed a uuid.
 */
const visibleText = (html: string): string => html.replaceAll(/<[^>]*>/g, " ");

test("an action stage names itself, says what it needs, and says what proves it done", () => {
  const html = pipelineMarkup([action]);
  assert.match(html, /Pull Request/);
  assert.match(html, /Session action/, "the badge says what this row is, beside reviewers");
  assert.match(html, /Skill · pull-request/);
  assert.match(html, /Completes when pull request is opened and verified/);
  // The one thing an operator most needs to know about the stage below it.
  assert.match(html, /later stages review new evidence/);
  // Its seam says `complete`, not `pass`: everything after it reads new evidence.
  assert.match(html, /complete/);

  // The negative that motivated the whole surface: no id may reach the screen.
  const text = visibleText(html);
  for (const id of [action.id, ACTION_NODE_ID, SESSION_ID, END_ID]) {
    assert.doesNotMatch(text, new RegExp(id), `${id} reached the screen`);
  }
});

test("the action stage carries the SAME authoring controls an evaluation stage does", () => {
  const html = pipelineMarkup([action, tidy]);
  // Remove, and a drag handle. Both were deliberately absent while nothing could execute an
  // action; both are the affordance an author needs now that one can.
  assert.match(html, /aria-label="Remove Stage 1"/);
  assert.match(html, /draggable="true"/);
  assert.match(html, /data-focus-key="stage:0"/);
  // Its one member still contributes no roving stop: the CARD is what moves and is removed,
  // and a second stop on the singleton inside it would answer none of those keys differently.
  assert.doesNotMatch(html, /data-focus-key="member:0:0"/);

  // A REPLACE picker, not an Add picker. An action runs alone, so "add a reviewer to this
  // stage" is a control that would list four options and refuse every one.
  assert.match(html, /Choose the session action Stage 1 sends/);
  assert.doesNotMatch(html, /Add a reviewer or check to Stage 1/);

  // The screen-reader name says the KIND, ahead of the summary. Without it the card sounds
  // exactly like a one-reviewer stage.
  assert.match(html, /session action stage, Stage 1 of 1/);
});

test("the replace picker offers only what this daemon can run, and retains what is chosen", () => {
  // `pull_request` unavailable, and the stage already points at a `pull_request` action.
  const html = pipelineMarkup([action, tidy], { availableCompletions: TURN_ONLY });
  // Retained, and labelled with the reason rather than silently dropped - a select whose
  // value is absent from its options paints something else as chosen.
  assert.match(html, /Pull Request \(Not available in this build\)/);
  // And the runnable one is offered as the replacement.
  assert.match(html, /Tidy the workspace/);
});

test("the stage picker offers session actions as a third kind of stage", () => {
  const html = emptyPipelineMarkup([action, tidy], TURN_ONLY);
  assert.match(html, /<optgroup label="Reviewers"|<optgroup label="Checks">/);
  const group = /<optgroup label="Session actions">([\s\S]*?)<\/optgroup>/.exec(html);
  assert.ok(group, "the third group is offered beside Reviewers and Checks");
  // Only the runnable one. Offering the other would author a stage the server refuses to
  // publish, which is a control that lies about what it will do.
  assert.match(group[1]!, /Tidy the workspace/);
  assert.doesNotMatch(group[1]!, /Pull Request/);
  // And the empty pipeline no longer promises reviewers only.
  assert.match(html, /a reviewer, a check or a session action/);
});

test("with nothing runnable the group is absent, and the tooltip says which reason", () => {
  const none = emptyPipelineMarkup([action], new Set());
  assert.doesNotMatch(none, /<optgroup label="Session actions">/);
  assert.match(none, /No session action here can run on this daemon yet/);

  const empty = emptyPipelineMarkup([], TURN_ONLY);
  assert.doesNotMatch(empty, /<optgroup label="Session actions">/);
  assert.match(empty, /No session actions authored yet - the Actions tab is where they live/);
});

test("the pipeline explains that an action is not a repair", () => {
  const html = pipelineMarkup([action]);
  assert.match(html, /captures fresh evidence and only the stages after it run again/);
  // And the distinction it exists to draw is stated beside it, not instead of it.
  assert.match(html, /Any fail returns the submission to Session for repair/);
});

test("a session action stage moves and is removed like any other stage", () => {
  const evaluation = (id: string): Stage => ({
    kind: "evaluation",
    joinId: null,
    members: [{ nodeId: id, kind: "persona", personaId: id }],
  });
  const act: Stage = {
    kind: "session_action",
    member: { nodeId: "act", kind: "session_action", sessionActionId: tidy.id },
  };
  const withAction: StagePipeline = {
    sessionId: SESSION_ID,
    endId: END_ID,
    endOutcome: "Complete",
    stages: [evaluation("a"), act, evaluation("b")],
  };
  const kinds = (pipeline: StagePipeline): string[] => pipeline.stages.map((stage) =>
    stage.kind === "evaluation" ? stage.members[0]!.nodeId! : "action");

  // The reorder BARRIER is gone with the reason for it. An action may travel, and another
  // stage may cross it - a phase that could not execute one had to freeze both.
  assert.equal(stageReorderAllowed(withAction, 1, 0), true);
  assert.deepEqual(kinds(moveStage(withAction, 1, 0)), ["action", "a", "b"]);
  assert.equal(stageReorderAllowed(withAction, 0, 2), true);
  assert.deepEqual(kinds(moveStage(withAction, 0, 2)), ["action", "b", "a"]);
  // Range checks survive: they are what stops an announcement claiming a move that no-op'd.
  assert.equal(stageReorderAllowed(withAction, 1, 1), false);
  assert.equal(stageReorderAllowed(withAction, 1, 3), false);
  assert.equal(stageReorderAllowed(withAction, 5, 0), false);

  assert.deepEqual(kinds(removeStage(withAction, 1)), ["a", "b"]);

  // Replacement changes the REFERENCE and nothing else. Carrying the node id is what keeps a
  // swap from reading as a delete plus an insert to autosave and undo.
  const swapped = replaceStageAction(withAction, 1, action.id);
  const swappedStage = swapped.stages[1]!;
  assert.equal(swappedStage.kind, "session_action");
  assert.equal(
    swappedStage.kind === "session_action" ? swappedStage.member.nodeId : null,
    "act",
    "the node id survives a replacement",
  );
  assert.equal(
    swappedStage.kind === "session_action" ? swappedStage.member.sessionActionId : null,
    action.id,
  );
  assert.deepEqual(replaceStageAction(withAction, 0, action.id), withAction, "not an action stage");
  assert.deepEqual(replaceStageAction(withAction, 1, tidy.id), withAction, "already this action");
});

test("an action stage is still a SINGLETON: nothing can be put in it or taken out of it", () => {
  const act: Stage = {
    kind: "session_action",
    member: { nodeId: "act", kind: "session_action", sessionActionId: tidy.id },
  };
  const evaluation: Stage = {
    kind: "evaluation",
    joinId: null,
    members: [{ nodeId: "a", kind: "persona", personaId: "a" }],
  };
  const pipeline: StagePipeline = {
    sessionId: SESSION_ID,
    endId: END_ID,
    endOutcome: "Complete",
    stages: [act, evaluation],
  };
  // This is the rule the runtime cannot execute around, not a phase gate, so it is a no-op
  // rather than an error: the surface offers no gesture that reaches it.
  assert.deepEqual(addMember(pipeline, 0, { kind: "persona", personaId: "b" }), pipeline);
  assert.deepEqual(moveMember(pipeline, { stage: 1, member: 0 }, { stage: 0, member: 0 }), pipeline);
  assert.deepEqual(moveMember(pipeline, { stage: 0, member: 0 }, { stage: 1, member: 0 }), pipeline);
  // And the focus order gives it exactly one stop: its card.
  assert.deepEqual(pipelineFocusOrder(pipeline), ["session", "stage:0", "stage:1", "member:1:0", "end"]);
});

test("a stage seed round-trips through the one string a select can carry", () => {
  const seed = { kind: "session_action" as const, sessionActionId: tidy.id };
  assert.equal(stageOptionValue(seed), `session_action:${tidy.id}`);
  assert.deepEqual(parseStageOption(stageOptionValue(seed)), seed);
  assert.deepEqual(parseStageOption("persona:p1"), { kind: "persona", personaId: "p1" });
  assert.deepEqual(parseStageOption("check:typecheck"), { kind: "check", slot: "typecheck" });
  // A stale option from an older build adds nothing rather than adding the wrong kind.
  assert.equal(parseStageOption("session_action:"), null);
  assert.equal(parseStageOption("nonsense"), null);
  assert.equal(stageSeedNoun(seed), "session action");
  assert.equal(stageSeedNoun({ kind: "check", slot: "test" }), "check");
  assert.equal(stageSeedNoun({ kind: "persona", personaId: "p1" }), "reviewer");
});

test("inserting an action anywhere compiles to a pipeline that projects back unchanged", () => {
  let pipeline = projectStages(EMPTY)!;
  pipeline = insertStage(pipeline, 0, { kind: "persona", personaId: "p1" });
  let compiled = compileStages(pipeline, EMPTY);
  pipeline = insertStage(projectStages(compiled)!, 1, {
    kind: "session_action",
    sessionActionId: tidy.id,
  });
  compiled = compileStages(pipeline, compiled);
  pipeline = insertStage(projectStages(compiled)!, 2, { kind: "check", slot: "test" });
  compiled = compileStages(pipeline, compiled);

  const projected = projectStages(compiled)!;
  assert.deepEqual(projected.stages.map((stage) => stage.kind), [
    "evaluation",
    "session_action",
    "evaluation",
  ]);
  // The identity contract every autosave and undo rests on: re-compiling an unchanged
  // projection mints nothing.
  const again = compileStages(projected, compiled);
  assert.deepEqual(again.nodes.map((node) => node.id).sort(), compiled.nodes.map((node) => node.id).sort());
  assert.deepEqual(again.edges.map((edge) => edge.id).sort(), compiled.edges.map((edge) => edge.id).sort());
});

test("the Graph palette can create an action node, and a drop payload is read as one", () => {
  assert.deepEqual(
    parseDroppedNode(JSON.stringify({ kind: "session_action", sessionActionId: tidy.id })),
    { kind: "session_action", sessionActionId: tidy.id },
  );
  // Shape only. WHICH actions may be dropped is the palette's question, and it has already
  // answered it by offering only the addable ones.
  assert.equal(parseDroppedNode(JSON.stringify({ kind: "session_action" })), null);
  assert.equal(parseDroppedNode(JSON.stringify({ kind: "session_action", sessionActionId: "" })), null);

  const source = readFileSync(
    resolve(import.meta.dirname, "..", "src", "web", "workflows", "WorkflowLibrary.tsx"),
    "utf8",
  );
  // A React Flow canvas cannot be rendered to markup here, so the palette entry and the
  // capability guard behind it are pinned at the source.
  assert.match(source, /＋ Session action/);
  assert.match(source, /addableActions\.length > 0 && \(/);
  assert.match(source, /!addableActions\.some\(\(action\) => action\.id === spec\.sessionActionId\)\) return/);
  // Duplicate copies one, but only when the palette would also offer it: node duplication is
  // the THIRD add control, so it asks `addableActions` exactly as the other two do rather than
  // becoming a side door onto an archived or unavailable action.
  assert.match(
    source,
    /return addableActions\.some\(\(action\) => action\.id === node\.sessionActionId\);/,
  );
});

test("the Graph rail lets a selected action be repointed and removed", () => {
  const html = renderToStaticMarkup(createElement(WorkflowProperties, {
    workflow,
    personas: [],
    sessionActions: [action, tidy],
    availableCompletions: BOTH,
    diagnostics: validateWorkflowGraph({
      graph,
      sessionActions: [action, tidy],
      completionPolicy: workflow.completionPolicy,
    }).diagnostics,
    selection: { kind: "node", id: ACTION_NODE_ID },
    readOnly: false,
    onUpdate: () => {},
    onConfirm: () => {},
  }));
  assert.match(html, /Pull Request/);
  assert.match(html, /Requires the pull-request skill/);
  // The capability table's own sentence, lowercased into the rail's prose. Asserted as the
  // derived wording rather than as a hand-written one so a copy change in the table shows up
  // here as a failure instead of as two surfaces quietly disagreeing.
  assert.match(html, /Completes when pull request is opened and verified/);
  assert.match(html, /Every stage after it reviews evidence captured once it has/);
  // The two halves of the authoring loop the previous phase deliberately withheld.
  assert.match(html, /<select[^>]*>[\s\S]*Tidy the workspace[\s\S]*<\/select>/);
  assert.match(html, /Delete node/);
});

test("an archived source is named on the card, not left for Publish to explain", () => {
  const archived = { ...action, archivedAt: 99 };
  const html = pipelineMarkup([archived]);
  assert.match(html, /Archived - replace it before publishing/);

  const rail = renderToStaticMarkup(createElement(WorkflowProperties, {
    workflow,
    personas: [],
    sessionActions: [archived],
    availableCompletions: BOTH,
    diagnostics: [],
    selection: { kind: "node", id: ACTION_NODE_ID },
    readOnly: false,
    onUpdate: () => {},
    onConfirm: () => {},
  }));
  assert.match(rail, /Its source is archived, so this draft cannot be published until it is replaced/);
});

test("a missing source is said plainly rather than shown as an id", () => {
  const html = pipelineMarkup([]);
  assert.match(html, /Missing session action/);
  assert.match(html, /This session action no longer exists/);
  // The picker still carries the id as its option VALUE, which is what keeps the select from
  // painting some other action as chosen. Nothing a reader sees is an id.
  assert.doesNotMatch(visibleText(html), new RegExp(action.id));
});

test("no surface describes a session action in a reviewer's vocabulary", () => {
  // The permanent negative. An action returns no verdict, so a surface that reached for
  // "passed", "approved" or "changes requested" would be claiming it judged the work.
  const html = pipelineMarkup([action, tidy]);
  for (const word of [/\bpassed\b/i, /\bapproved\b/i, /changes requested/i, /\bverdict\b/i]) {
    assert.doesNotMatch(html, word, `the action pipeline used ${word}`);
  }
});

test("a published version shows the exact instruction it froze", () => {
  const version: WorkflowVersion = {
    id: "eeeeeeee-0000-4000-8000-000000000005",
    workflowId: workflow.id,
    version: 1,
    sourceDraftRevision: 1,
    graph: {
      nodes: graph.nodes.map((node): PublishedWorkflowNode => node.kind === "session_action"
        ? {
            id: node.id,
            kind: "session_action" as const,
            position: node.position,
            action: {
              sourceSessionActionId: action.id,
              sourceRevision: 1,
              name: action.name,
              description: action.description,
              promptMarkdown: "# Pull Request\n\nThe frozen wording.\n",
              requiredSkillId: action.requiredSkillId,
              completion: action.completion,
            },
          }
        // This fixture graph holds no Persona node, so every other arm carries through.
        : node as PublishedWorkflowNode),
      edges: graph.edges,
    },
    completionPolicy: { kind: "none" },
    resumptionPolicy: "auto",
    bindingDefaults: workflow.bindingDefaults,
    publishedAt: 1,
  };
  const html = renderToStaticMarkup(createElement(WorkflowVersionDetail, {
    version,
    personas: [],
    sessionActions: [action],
  }));
  // A version that typed an instruction into somebody's session has to be able to show WHICH
  // instruction, or its audit trail stops at "an action ran".
  assert.match(html, /The frozen wording\./);
  assert.match(html, /revision 1/);
  // The live source has moved on, and history says so rather than hiding it.
  assert.match(html, /outdated/);
  assert.match(html, /Requires the pull-request skill/);
  // A `none` policy draws no footer at all - the whole visibility contract in one assertion.
  assert.doesNotMatch(html, /the fixed completion policy after End/);

  const gated = renderToStaticMarkup(createElement(WorkflowVersionDetail, {
    version: {
      ...version,
      completionPolicy: { kind: "inspector", onFindings: "restart_workflow", missingPrAction: "wait" },
    },
    personas: [],
    sessionActions: [action],
  }));
  assert.match(gated, /Inspector, the fixed completion policy after End/);
  assert.match(gated, /Set in Workflow\s+settings, not on the graph/);
});
