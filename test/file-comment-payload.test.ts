// What one comment looks like when it reaches the agent.
//
// The renderer is pure, so this file needs no session, no pane and no database - which is the
// whole reason the payload is rendered server-side and separately from the machine that
// delivers it. What is pinned here is the SHAPE: an agent reads this and nothing else about
// the review, so every line in it is load-bearing.

import assert from "node:assert/strict";
import test from "node:test";

import {
  FILE_COMMENT_PAYLOAD_LIMITS,
  deliveryHandle,
  lineRangeLabel,
  renderFileCommentPayload,
} from "../src/server/file-comment-payload.ts";

const BASE = {
  path: "docs/plans/x/plan.md",
  startLine: 84,
  endLine: 86,
  quote: "the paragraph as it currently reads, quoted exactly",
  body: "This contradicts the diagram above it.",
  shortId: "MC-a41f",
  ordinal: 2,
  position: 3,
  total: 12,
} as const;

test("one comment renders as the turn plan.md specifies", () => {
  const { payload } = renderFileCommentPayload(BASE);
  assert.equal(
    payload,
    [
      "Comment 3 of 12 on this review.",
      "",
      "docs/plans/x/plan.md, lines 84-86:",
      "",
      "> the paragraph as it currently reads, quoted exactly",
      "",
      "This contradicts the diagram above it.",
      "",
      "Answer in your next turn, quoting id MC-a41f.2.",
      "Answer this comment only - the remaining 9 follow one at a time, so do not restructure beyond what this one asks for.",
    ].join("\n"),
  );
});

test("the position line states how many follow, which is the whole mitigation", () => {
  // The one thing a batch does better is that the agent can see the shape of the review. This
  // line is what buys that back, so an agent on comment three does not restructure the
  // document for the nine it has not been shown.
  const { payload } = renderFileCommentPayload(BASE);
  assert.match(payload, /^Comment 3 of 12 on this review\.$/m);
  assert.match(payload, /the remaining 9 follow one at a time/);
});

test("the LAST comment promises nothing that is not coming", () => {
  // "the remaining 0 follow" would be a lie in the direction that teaches an agent to hold
  // work back on every future review.
  const { payload } = renderFileCommentPayload({ ...BASE, position: 12, total: 12 });
  assert.match(payload, /it is the last of this review/);
  assert.doesNotMatch(payload, /remaining/);
});

test("one comment left reads as one, not as 1 follows", () => {
  const { payload } = renderFileCommentPayload({ ...BASE, position: 11, total: 12 });
  assert.match(payload, /the remaining 1 follows one at a time/);
});

test("the id carries the delivery ordinal, which is what a reply answers", () => {
  // A thread can be delivered more than once - it times out, you write a follow-up, it goes
  // round again - so a bare handle cannot say which turn is being answered.
  assert.equal(deliveryHandle("MC-a41f", 2), "MC-a41f.2");
  const { payload } = renderFileCommentPayload({ ...BASE, ordinal: 1 });
  assert.match(payload, /quoting id MC-a41f\.1\./);
});

test("phase 4 substitutes a tool name into that one line and nothing else", () => {
  const without = renderFileCommentPayload(BASE).payload;
  const withTool = renderFileCommentPayload({
    ...BASE,
    replyTool: "mcp__mission-control__respond_to_file_comments",
  }).payload;
  assert.match(
    withTool,
    /^Answer with mcp__mission-control__respond_to_file_comments quoting id MC-a41f\.2\.$/m,
  );
  // Every other line is identical: the difference is one sentence, by construction.
  const differing = withTool
    .split("\n")
    .filter((line, index) => line !== without.split("\n")[index]);
  assert.equal(differing.length, 1);
});

test("a single-line anchor reads as a line and a range as lines", () => {
  assert.equal(lineRangeLabel(84, 84), "line 84");
  assert.equal(lineRangeLabel(84, 86), "lines 84-86");
  assert.match(
    renderFileCommentPayload({ ...BASE, startLine: 84, endLine: 84 }).payload,
    /^docs\/plans\/x\/plan\.md, line 84:$/m,
  );
});

test("a multi-line quote is fenced with > rather than a code fence", () => {
  // A comment on Markdown routinely quotes text containing a fence, and a fence inside a
  // fence ends the outer one - so the quote would leak into the instruction below it.
  const { payload } = renderFileCommentPayload({
    ...BASE,
    quote: "```ts\nconst x = 1;\n```",
  });
  assert.match(payload, /^> ```ts$/m);
  assert.match(payload, /^> const x = 1;$/m);
  // The blank line inside a quote keeps its marker, so the block reads as one quotation.
  const blank = renderFileCommentPayload({ ...BASE, quote: "first\n\nthird" });
  assert.match(blank.payload, /^> first\n>\n> third$/m);
});

test("the payload hash is stable for the same comment and moves for a different one", () => {
  const a = renderFileCommentPayload(BASE);
  const b = renderFileCommentPayload({ ...BASE });
  assert.equal(a.payloadSha256, b.payloadSha256);
  assert.equal(a.payloadSha256.length, 64);
  // The position line is part of the payload, so comment 3 of 12 and comment 4 of 12 are
  // genuinely different turns even when they carry the same words.
  assert.notEqual(a.payloadSha256, renderFileCommentPayload({ ...BASE, position: 4 }).payloadSha256);
  assert.equal(a.truncated, false);
});

test("terminal control bytes never ride the wire", () => {
  // Written as ESCAPES, never as the bytes themselves. A literal control byte in a tracked
  // source file makes git diff it as binary and makes grep skip it entirely, which
  // `source-is-text.test.ts` refuses for exactly that reason.
  const { payload } = renderFileCommentPayload({
    ...BASE,
    body: "before\u0007\u001B[31mred\u001B[0m after",
    quote: "quoted\u0000text",
  });
  // The one assertion in this file that must match control characters, because refusing them
  // is the whole point of it. Escapes, not literals, so the rule's real concern - a control
  // byte sitting invisibly in a source file - does not apply.
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(payload, /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
  assert.match(payload, /before\[31mred\[0m after/);
});

test("an oversized comment is clipped, and the instruction survives the clipping", () => {
  // The tail is what tells the agent which turn it is answering and how much of the document
  // to leave alone. A packet missing either is worse than one missing the end of a quote.
  const { payload, truncated } = renderFileCommentPayload({
    ...BASE,
    quote: "x".repeat(FILE_COMMENT_PAYLOAD_LIMITS.payloadBytes * 2),
  });
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(payload, "utf8") <= FILE_COMMENT_PAYLOAD_LIMITS.payloadBytes);
  assert.match(payload, /Answer in your next turn, quoting id MC-a41f\.2\./);
  assert.match(payload, /Answer this comment only/);
  assert.match(payload, /clipped deterministically/);
});

test("an ordinary review comment is nowhere near the budget", () => {
  // The bound is a runaway guard, not a product limit: a paragraph of review about a
  // paragraph of prose is a few hundred bytes.
  const { payload, truncated } = renderFileCommentPayload(BASE);
  assert.equal(truncated, false);
  assert.ok(Buffer.byteLength(payload, "utf8") < 1_000);
});
