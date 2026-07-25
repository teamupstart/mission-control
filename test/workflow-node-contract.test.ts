import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const nodeSource = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowNode.tsx", import.meta.url)), "utf8");
const librarySource = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
const propertiesSource = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowProperties.tsx", import.meta.url)), "utf8");

test("all four node kinds route through one shared custom node leaf", () => {
  assert.match(nodeSource, /export function WorkflowNode/);
  assert.match(nodeSource, /session: WorkflowNode/);
  assert.match(nodeSource, /persona: WorkflowNode/);
  assert.match(nodeSource, /all_pass: WorkflowNode/);
  assert.match(nodeSource, /end: WorkflowNode/);
});

test("the palette has no checkpoint or Inspector graph node", () => {
  assert.doesNotMatch(librarySource, /addNode\("checkpoint"\)/);
  assert.doesNotMatch(librarySource, /addNode\("inspector"\)/);
  // The claim used to be pinned to a palette footnote saying so. The footnote is gone -
  // it was a design note to the reader, in a panel that now only renders for the Graph
  // view - so the claim is pinned where it is actually decided: `addNode`'s three kinds.
  assert.match(
    librarySource,
    /const addNode = \(kind: "persona" \| "all_pass" \| "end"/,
    "a fourth palette node kind would have to be added here first",
  );
  // Inspector approval is a workflow SETTING, on the completion policy, not a node.
  assert.match(propertiesSource, /<option value="inspector">Inspector approval<\/option>/);
});
