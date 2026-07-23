import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const nodeSource = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowNode.tsx", import.meta.url)), "utf8");
const librarySource = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");

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
  assert.match(librarySource, /No checkpoint node/);
  assert.match(librarySource, /Inspector is a final-gate setting/);
});
