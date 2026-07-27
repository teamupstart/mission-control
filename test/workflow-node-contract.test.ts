import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDroppedNode } from "../src/web/workflows/new-node.ts";

const nodeSource = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowNode.tsx", import.meta.url)), "utf8");
const librarySource = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
const propertiesSource = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowProperties.tsx", import.meta.url)), "utf8");
const newNodeSource = readFileSync(fileURLToPath(new URL("../src/web/workflows/new-node.ts", import.meta.url)), "utf8");

test("all five node kinds route through one shared custom node leaf", () => {
  assert.match(nodeSource, /export function WorkflowNode/);
  assert.match(nodeSource, /session: WorkflowNode/);
  assert.match(nodeSource, /persona: WorkflowNode/);
  assert.match(nodeSource, /all_pass: WorkflowNode/);
  assert.match(nodeSource, /check: WorkflowNode/);
  assert.match(nodeSource, /end: WorkflowNode/);
});

test("the palette has no checkpoint or Inspector graph node", () => {
  assert.doesNotMatch(librarySource, /kind: "checkpoint"/);
  assert.doesNotMatch(librarySource, /kind: "inspector"/);
  // The claim used to be pinned to a palette footnote saying so. The footnote is gone -
  // it was a design note to the reader, in a panel that now only renders for the Graph
  // view - so the claim is pinned where it is actually decided: what `addNode` accepts.
  //
  // That is now `NewWorkflowNode`, ONE type shared with the drag-and-drop reader, which is
  // where a new palette kind has to be declared before either route can produce it. The
  // literal union this used to match lived only in `addNode`'s signature, so the drop
  // handler kept a second hand-written list of the same kinds beside it.
  assert.match(
    librarySource,
    /const addNode = \(spec: NewWorkflowNode/,
    "a new palette node kind would have to be added to NewWorkflowNode first",
  );
  assert.match(
    newNodeSource,
    /export type NewWorkflowNode =/,
    "the palette's node kinds are declared once, in new-node.ts",
  );
  // Inspector approval is a workflow SETTING, on the completion policy, not a node.
  assert.match(propertiesSource, /<option value="inspector">Inspector approval<\/option>/);
});

test("a Check node carries a slot and never a command", () => {
  // The whole point of the slot indirection, pinned where an operator would look for the
  // field to type an argv into: the properties panel offers a slot picker, and it says
  // where the command lives instead of offering a box for one.
  //
  // A command field HERE would put an argv on the draft graph, which is exactly the
  // executable-content problem the slot exists to avoid: a published version is exportable,
  // and a built-in workflow hard-coding `npm test` is wrong on every other repository.
  assert.match(propertiesSource, /selectedNode\.kind === "check"/);
  assert.match(propertiesSource, /slot: event\.target\.value as WorkflowCheckSlot/);
  assert.match(propertiesSource, /Settings › Workflows/);
  assert.doesNotMatch(
    propertiesSource,
    /replaceNode\(\{ \.\.\.selectedNode, command/,
    "a Check node's command must never be editable on the graph",
  );
});

// The palette's two routes - the button and the drag - now read one type, and this is the
// half that has to survive a hostile payload: a drop carries whatever the page it came from
// put on the clipboard.
test("a dropped node is parsed strictly, and anything else is declined without throwing", () => {
  assert.deepEqual(parseDroppedNode(JSON.stringify({ kind: "all_pass" })), { kind: "all_pass" });
  assert.deepEqual(parseDroppedNode(JSON.stringify({ kind: "end" })), { kind: "end" });
  assert.deepEqual(
    parseDroppedNode(JSON.stringify({ kind: "persona", personaId: "p1" })),
    { kind: "persona", personaId: "p1" },
  );
  assert.deepEqual(
    parseDroppedNode(JSON.stringify({ kind: "check", slot: "lint" })),
    { kind: "check", slot: "lint" },
  );
  // A slot this build does not know is REFUSED rather than defaulted: a check silently
  // dropped onto the wrong gate is worse than a drag that does nothing.
  assert.equal(parseDroppedNode(JSON.stringify({ kind: "check", slot: "format" })), null);
  assert.equal(parseDroppedNode(JSON.stringify({ kind: "check" })), null);
  assert.equal(parseDroppedNode(JSON.stringify({ kind: "persona" })), null);
  assert.equal(parseDroppedNode(JSON.stringify({ kind: "session" })), null);
  // Not ours, and not an error: a canvas is handed other applications' payloads routinely.
  assert.equal(parseDroppedNode(""), null);
  assert.equal(parseDroppedNode("not json"), null);
  assert.equal(parseDroppedNode("null"), null);
  assert.equal(parseDroppedNode("[]"), null);
});
