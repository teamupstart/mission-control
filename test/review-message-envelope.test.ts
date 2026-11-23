import assert from "node:assert/strict";
import test from "node:test";
import {
  formatReviewEnvelope,
  parseReviewEnvelope,
  wrapReviewEnvelope,
} from "../src/shared/review-message-envelope.ts";

// The first line Mission Control writes on every outbox message about a review (`async-input`).
// One module writes and parses it; these pin the grammar both sides read.

const A = "1b0c9f4e-2a8d-4a43-9d3e-0f6c2b7e5a10";
const B = "7d1e2f30-4b5c-4d6e-8f90-a1b2c3d4e5f6";
const BODY = "Mission Control answer to question 1b0c9f4e (asked 2 minutes ago):\n\nUse eslint";

test("one answer round-trips: the marker, a blank line, then exactly the text the agent always got", () => {
  const text = wrapReviewEnvelope("answer", [A], BODY);
  assert.equal(text, `[mission-control:answer review=${A}]\n\n${BODY}`);
  assert.deepEqual(parseReviewEnvelope(text), { kind: "answer", reviewIds: [A], rest: BODY });
});

test("coalesced answers list every id in delivery order under `reviews=`", () => {
  const text = wrapReviewEnvelope("answer", [B, A], BODY);
  assert.equal(text.split("\n")[0], `[mission-control:answer reviews=${B},${A}]`);
  assert.deepEqual(parseReviewEnvelope(text)?.reviewIds, [B, A]);
});

test("a Remind me later instruction has its own kind", () => {
  const text = wrapReviewEnvelope("remind-later", [A], "Not answered yet.");
  assert.deepEqual(parseReviewEnvelope(text), { kind: "remind-later", reviewIds: [A], rest: "Not answered yet." });
});

test("ids that are not review ids get no marker, rather than one the parser would refuse", () => {
  assert.equal(formatReviewEnvelope("answer", ["r1"]), null);
  assert.equal(formatReviewEnvelope("answer", []), null);
  assert.equal(formatReviewEnvelope("answer", [A, A]), null, "an id named twice");
  assert.equal(wrapReviewEnvelope("answer", ["r1"], BODY), BODY);
});

test("the marker is valid only as the literal first line followed by one blank line", () => {
  const line = `[mission-control:answer review=${A}]`;
  const refused: Array<[string, string]> = [
    ["a leading blank line", `\n${line}\n\n${BODY}`],
    ["leading whitespace", ` ${line}\n\n${BODY}`],
    ["a marker after the first line", `Please read this:\n${line}\n\n${BODY}`],
    ["no blank line under it", `${line}\n${BODY}`],
    ["nothing under it", line],
    ["a trailing space", `${line} \n\n${BODY}`],
    ["a carriage return", `${line}\r\n\r\n${BODY}`],
    ["an unknown kind", `[mission-control:reply review=${A}]\n\n${BODY}`],
    ["`review=` naming two", `[mission-control:answer review=${A},${B}]\n\n${BODY}`],
    ["`reviews=` naming one", `[mission-control:answer reviews=${A}]\n\n${BODY}`],
    ["a space after the comma", `[mission-control:answer reviews=${A}, ${B}]\n\n${BODY}`],
    ["a duplicated id", `[mission-control:answer reviews=${A},${A}]\n\n${BODY}`],
    ["an uppercase id", `[mission-control:answer review=${A.toUpperCase()}]\n\n${BODY}`],
    ["a partial id", `[mission-control:answer review=${A.slice(0, 20)}]\n\n${BODY}`],
    ["a missing bracket", `[mission-control:answer review=${A}\n\n${BODY}`],
    ["a non-ASCII character", `[mission-control:answer review=${A}’]\n\n${BODY}`],
    ["a lookalike hyphen", `[mission‐control:answer review=${A}]\n\n${BODY}`],
  ];
  for (const [why, text] of refused) assert.equal(parseReviewEnvelope(text), null, why);
});
