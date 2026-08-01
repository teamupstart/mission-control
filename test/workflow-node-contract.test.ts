import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDroppedNode } from "../src/web/workflows/new-node.ts";

const nodeSource = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowNode.tsx", import.meta.url)), "utf8");
const librarySource = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
const propertiesSource = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowProperties.tsx", import.meta.url)), "utf8");
const newNodeSource = readFileSync(fileURLToPath(new URL("../src/web/workflows/new-node.ts", import.meta.url)), "utf8");

test("every node kind routes through one shared custom node leaf", () => {
  assert.match(nodeSource, /export function WorkflowNode/);
  for (const kind of ["session", "persona", "all_pass", "check", "session_action", "end"]) {
    assert.match(nodeSource, new RegExp(`${kind}: WorkflowNode`));
  }
});

test("a session action draws one complete handle and no pass/fail pair", () => {
  // The whole reason it is a separate branch. A `fail` handle here would invite a route back
  // to Session for what is a delivery or infrastructure problem, and a `pass` handle would
  // let a Join treat "the session did the thing" as a favourable verdict.
  assert.match(nodeSource, /data\.kind === "session_action"/);
  assert.match(nodeSource, /id="complete"/);
  assert.doesNotMatch(
    nodeSource,
    /data\.kind === "session_action"[\s\S]{0,400}id="fail"/,
    "an action has no fail port to draw",
  );
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
  // A session action is NOT a palette kind in this build: nothing can execute one yet, so
  // the drag route must not be a way to author what the palette deliberately does not offer.
  assert.equal(parseDroppedNode(JSON.stringify({ kind: "session_action" })), null);
  assert.equal(
    parseDroppedNode(JSON.stringify({ kind: "session_action", sessionActionId: "a1" })),
    null,
  );
  assert.doesNotMatch(librarySource, /addNode\(\{ kind: "session_action"/);
  // Not ours, and not an error: a canvas is handed other applications' payloads routinely.
  assert.equal(parseDroppedNode(""), null);
  assert.equal(parseDroppedNode("not json"), null);
  assert.equal(parseDroppedNode("null"), null);
  assert.equal(parseDroppedNode("[]"), null);
});
