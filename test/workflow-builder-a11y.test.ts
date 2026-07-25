import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pipelineFocusOrder } from "../src/web/workflows/PipelineEditor.tsx";
import type { StagePipeline } from "../src/shared/workflow-stages.ts";

const canvas = readFileSync(new URL("../src/web/workflows/WorkflowCanvas.tsx", import.meta.url), "utf8");
const node = readFileSync(new URL("../src/web/workflows/WorkflowNode.tsx", import.meta.url), "utf8");
const library = readFileSync(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url), "utf8");
const runs = readFileSync(new URL("../src/web/workflows/WorkflowRuns.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/web/workflows/WorkflowPage.tsx", import.meta.url), "utf8");
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
  assert.match(page, /role="tablist"/);
  assert.match(page, /role="tab"/);
  assert.match(page, /role="tabpanel"/);
  assert.match(page, /event\.key === "ArrowRight"/);
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
      { joinId: "join", members: [{ nodeId: "a", personaId: "pa" }, { nodeId: "b", personaId: "pb" }] },
      { joinId: null, members: [{ nodeId: "c", personaId: "pc" }] },
    ],
  };
  // Reading order: the two termini bracket every stage header and its reviewers.
  assert.deepEqual(pipelineFocusOrder(pipeline), [
    "session",
    "stage:0",
    "reviewer:0:0",
    "reviewer:0:1",
    "stage:1",
    "reviewer:1:0",
    "end",
  ]);
  // Exactly one roving tab stop, and the arrow keys are what move it.
  assert.match(editor, /tabIndex: current === key \? 0 : -1/);
  assert.match(editor, /tabIndex: current === stageKey \? 0 : -1/);
  assert.match(editor, /event\.key === "ArrowRight" \|\| event\.key === "ArrowDown"/);
  assert.match(editor, /event\.altKey && \(event\.key === "ArrowLeft" \|\| event\.key === "ArrowRight"\)/);
  assert.match(editor, /event\.altKey && \(event\.key === "ArrowUp" \|\| event\.key === "ArrowDown"\)/);
  // Every announcement and every aria label is composed from `nameOf` / `refOfStage` /
  // `labelOfStage`, never from a member's `nodeId`.
  assert.match(editor, /`Added \$\{nameOf\(personaId\)\} to \$\{refOfStage\(stageIndex\)\}`/);
  assert.match(editor, /ariaLabel: `\$\{reviewer\}, reviewer \$\{memberIndex \+ 1\}/);
  assert.match(editor, /ariaLabel: `\$\{stageLabel\}, \$\{stageRef\} of \$\{pipeline\.stages\.length\}/);
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
