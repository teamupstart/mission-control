import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pipelineFocusOrder } from "../src/web/workflows/PipelineEditor.tsx";
import type { StagePipeline } from "../src/shared/workflow-stages.ts";

const canvas = readFileSync(new URL("../src/web/workflows/WorkflowCanvas.tsx", import.meta.url), "utf8");
const node = readFileSync(new URL("../src/web/workflows/WorkflowNode.tsx", import.meta.url), "utf8");
const library = readFileSync(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url), "utf8");
const runs = readFileSync(new URL("../src/web/workflows/WorkflowRuns.tsx", import.meta.url), "utf8");
const strip = readFileSync(new URL("../src/web/components/LineStrip.tsx", import.meta.url), "utf8");
const drawer = readFileSync(new URL("../src/web/components/line/LineDrawer.tsx", import.meta.url), "utf8");
const properties = readFileSync(new URL("../src/web/workflows/WorkflowProperties.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
const editor = readFileSync(new URL("../src/web/workflows/PipelineEditor.tsx", import.meta.url), "utf8");

test("builder exposes semantic names, roving focus, live state, and focus restoration", () => {
  assert.match(canvas, /focusable: node\.id === focusNodeId/);
  assert.match(canvas, /incoming connections/);
  assert.match(canvas, /outgoing connections/);
  assert.match(canvas, /ariaLabel="Workflow minimap"/);
  assert.match(node, /aria-description/);
  assert.match(node, /aria-label="Pass output"/);
  assert.match(node, /aria-label="Fail output"/);
  assert.match(library, /aria-live="polite"/);
  assert.match(library, /role="group"/);
  assert.match(library, /connectTrigger\.current\?\.focus/);
  assert.match(library, /aria-live="assertive"/);
  assert.match(runs, /role="alert"/);
  assert.match(runs, /aria-live="assertive"/);
  // The Workflows page's tablist retired with the page. What replaced it as the way into
  // the execution surfaces is the Line's strip and its drawers, and the disclosure has to
  // announce itself: an expandable stage says so, says what it controls while it is open,
  // and the panel it opens is a named region that takes focus.
  assert.match(strip, /"aria-expanded": openStage === fold\.stage/);
  assert.match(strip, /"aria-controls": LINE_DRAWER_DOM_ID/);
  assert.match(strip, /lineStageHasDrawer\(fold\.stage\)/);
  assert.match(drawer, /aria-label=\{`\$\{title\} drawer`\}/);
  assert.match(drawer, /tabIndex=\{-1\}/);
  assert.match(drawer, /frame\.current\?\.focus/);
  assert.match(drawer, /aria-label=\{`Close the \$\{title\} drawer`\}/);
  assert.match(properties, /<span tabIndex=\{0\}>/);
  assert.match(properties, /aria-label=\{`Remove \$\{edge\.sourcePort\} connection/);
});

/**
 * The pipeline's whole claim is that an operator reads persona and stage NAMES. If focus
 * order or an announcement ever falls back to a node id, the surface has quietly become the
 * UUID wall it replaced - and nothing else in the suite would notice, because the ids render
 * perfectly well.
 */
test("the pipeline editor roves by name and announces in names", () => {
  const pipeline: StagePipeline = {
    sessionId: "session",
    endId: "end",
    endOutcome: "Complete",
    stages: [
      {
        kind: "evaluation",
        joinId: "join",
        members: [
          { nodeId: "a", kind: "persona", personaId: "pa" },
          { nodeId: "b", kind: "check", slot: "typecheck" },
        ],
      },
      {
        kind: "evaluation",
        joinId: null,
        members: [{ nodeId: "c", kind: "persona", personaId: "pc" }],
      },
    ],
  };
  // Reading order: the two termini bracket every stage header and its members. A check is a
  // roving stop exactly like a reviewer - it is reordered and deleted by the same keys, so it
  // has to be reachable by the same ones.
  assert.deepEqual(pipelineFocusOrder(pipeline), [
    "session",
    "stage:0",
    "member:0:0",
    "member:0:1",
    "stage:1",
    "member:1:0",
    "end",
  ]);
  // Exactly one roving tab stop, and the arrow keys are what move it.
  assert.match(editor, /tabIndex: current === key \? 0 : -1/);
  assert.match(editor, /tabIndex: current === stageKey \? 0 : -1/);
  assert.match(editor, /event\.key === "ArrowRight" \|\| event\.key === "ArrowDown"/);
  assert.match(editor, /event\.altKey && \(event\.key === "ArrowLeft" \|\| event\.key === "ArrowRight"\)/);
  assert.match(editor, /event\.altKey && \(event\.key === "ArrowUp" \|\| event\.key === "ArrowDown"\)/);
  // Every announcement and every aria label is composed from `labelOfMember` / `refOfStage` /
  // `labelOfStage`, never from a member's `nodeId` - and `labelOfMember` is what makes a check
  // say its own slot instead of falling through the Persona lookup as "Missing persona".
  assert.match(editor, /`Added \$\{labelOfMember\(seeded\(seed\)\)\} to \$\{refOfStage\(stageIndex\)\}`/);
  // One phrase names WHICH member, and the row plus both of its buttons all use it. The
  // position is what makes it an identity: a stage may hold the same Persona twice, so a
  // name built from the reviewer and the stage alone collides across two rows and leaves a
  // screen-reader user unable to tell their Routing and Remove buttons apart.
  assert.match(editor, /const memberRef =\n\s*`\$\{label\}, \$\{noun\} \$\{memberIndex \+ 1\} of \$\{stage\.members\.length\} in \$\{stageRef\}`/);
  assert.match(editor, /ariaLabel: memberRef,/);
  assert.match(editor, /aria-label=\{`Model routing for \$\{memberRef\}`\}/);
  assert.match(editor, /aria-label=\{`Remove \$\{memberRef\}`\}/);
  assert.match(editor, /member\.kind === "check" \? checkLabel\(member\.slot\) : nameOf\(member\.personaId\)/);
  // The stage's own name, then its KIND when it has one worth saying, then its position. The
  // kind clause is not decoration: a session action card otherwise sounds exactly like a
  // one-reviewer stage to a screen-reader user, and the two do opposite things.
  assert.match(
    editor,
    /ariaLabel: `\$\{stageLabel\}, \$\{isAction \? "session action stage, " : ""\}\$\{stageRef\} of \$\{pipeline\.stages\.length\}/,
  );
  // A stage is REFERRED to positionally in every sentence about it or its members. The
  // derived name of a one-reviewer stage is that reviewer, so naming it any other way
  // produced "remove Security reviewer from Security reviewer".
  assert.match(editor, /const refOfStage = \(index: number\): string => `Stage \$\{index \+ 1\}`/);
  assert.doesNotMatch(editor, /from \$\{stageLabel\}/);
  assert.doesNotMatch(editor, /in \$\{stageLabel\}/);
  // No node id may be interpolated into anything the surface says out loud.
  assert.doesNotMatch(editor, /\$\{[^}]*nodeId[^}]*\}/);
});

test("workflow meaning is not color-only and reduced motion is honored", () => {
  assert.match(node, /runtimeStatus\.replaceAll/);
  assert.match(styles, /\.workflow-runtime-fail \.workflow-node::before/);
  assert.match(styles, /content: "!"/);
  assert.match(styles, /\.workflow-edge-fail path \{ stroke: var\(--danger\); stroke-dasharray:/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.workflow-port-label/);
  assert.match(styles, /\.workflow-node:focus-within/);
});

test("canvas nodes have a definite measured width for readable labels", () => {
  // React Flow positions its wrapper using the node's first measured box. A min-width can
  // leave that wrapper character-wide when a read-only graph is mounted, even while the
  // visible shell overflows it. Keep the canvas geometry definite so title and subtitle use
  // the same readable line width as the shell.
  const workflowNodeStyles = styles.match(/\.workflow-node\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(workflowNodeStyles, /width: 180px;/);
  assert.doesNotMatch(workflowNodeStyles, /min-width: 150px;/);
});
