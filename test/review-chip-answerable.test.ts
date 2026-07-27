/**
 * What is at stake: the topbar's attention segment must never count something nothing can open.
 *
 * The review modal is keyed on a SESSION - `modalSession` is `sessions.find(...)`, and
 * `modalOpen` is false without one. So a pending review whose session is gone was not merely
 * a wrong number: the click set `reviewSessionId` to an id that matched nothing and did nothing
 * at all, with no way for the operator to reach or clear the eight agents the readout said were
 * blocked on them. That is the shape the live install was in.
 *
 * The daemon settling those is the real fix (`review-session-orphan.test.ts`). This pins the
 * half that makes it unreproducible: the figure and what opens under it read ONE fold, and that
 * fold's review input is narrowed to reviews whose session is still here - which also covers
 * the seconds after a restart, before the first discovery sweep has said which agents are out
 * there. The segment now counts more than reviews (it is the attention inbox's total), which
 * makes the same-source property MORE load-bearing, not less: four kinds of obligation are
 * summed into one figure, and a fold nobody hands the narrowed list would put an unanswerable
 * row in the list AND in the count.
 *
 * Driven from source for the reason `topbar-popover-dismiss.test.ts` gives: App sits behind
 * an SSE stream that hangs headless automation, and there is no jsdom here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");

test("the inbox's review input is pending reviews narrowed to sessions that still exist", () => {
  const start = app.indexOf("const answerableReviews");
  assert.notEqual(start, -1, "the narrowed list is gone - the chip is counting orphans again");
  const body = app.slice(start, app.indexOf("}, [", start));

  // Narrowed against the session list, not against `visible`: a typed filter must not make
  // a blocked agent's question vanish from the count.
  assert.match(body, /sessions\.map\(\(s\) => s\.id\)/);
  assert.match(body, /pendingReviews\.filter/);
  assert.match(body, /live\.has\(r\.sessionId\)/);
});

test("the fold is handed that one list, and the count and the click are both the fold", () => {
  // The narrowed list reaches the topbar through `foldAttention`, so the seam to pin is that
  // call: hand it `pendingReviews` and every unanswerable question is back, in the figure and
  // in the list under it at the same time.
  const fold = app.slice(app.indexOf("foldAttention({"));
  assert.match(
    fold.slice(0, fold.indexOf("}),")),
    /reviews: answerableReviews/,
    "the fold must be handed the narrowed list, not `pendingReviews`",
  );

  // The segment now lives inside `FleetPulse` and takes ONE `inbox` prop, so the four readings
  // that used to be spelled out side by side (gate, plural, sentence, figure) cannot drift from
  // each other by construction.
  const handoff = app.slice(app.indexOf("<FleetPulse"));
  assert.match(
    handoff.slice(0, handoff.indexOf("/>")),
    /inbox=\{attention\.total\}/,
    "the pulse must be handed the fold's own total, not a second count of anything",
  );

  const pulse = app.slice(app.indexOf("function FleetPulse"));
  const chip = pulse.slice(pulse.indexOf("{inbox > 0 &&"), pulse.indexOf("</div>\n  );"));
  assert.notEqual(chip.length, 0, "the segment no longer gates on the fold's total");

  // Each reading asserted by NAME rather than by counting occurrences of `inbox`. A bare count
  // passes for the wrong reasons - reword the tooltip and the number moves, while a reading
  // that silently switched to another source keeps the total intact - and the figure itself
  // tells a later reader nothing about which four things had to agree.
  for (const [what, pattern] of [
    ["the gate", /\{inbox > 0 &&/],
    ["the figure", /n=\{inbox\}/],
    ["the tooltip's count", /\$\{inbox\} thing/],
    ["the tooltip's singular/plural", /inbox === 1/],
  ] as const) {
    assert.match(chip, pattern, `${what} no longer reads the \`inbox\` prop`);
  }
  assert.doesNotMatch(
    chip,
    /pendingReviews|answerableReviews|attention\.total/,
    "the segment reads its prop only",
  );

  // And the click, which is the half that was a dead end: it opens the inbox, which renders
  // the SAME fold object the figure counted - there is no second query behind it.
  assert.match(app, /onOpenInbox=\{\(\) => setInboxOpen\(true\)\}/);
  const inbox = app.slice(app.indexOf("<AttentionInbox"));
  assert.match(inbox.slice(0, inbox.indexOf("/>")), /fold=\{attention\}/);
});

test("`pendingReviews` itself stays whole for the callers asking a different question", () => {
  // Foreman's draft staleness asks whether a review was RESOLVED - narrowing that by session
  // liveness would report a live draft as stale the moment its agent's card went away.
  const ids = app.slice(app.indexOf("const pendingReviewIds"));
  assert.match(ids.slice(0, ids.indexOf("],")), /pendingReviews\.map\(\(r\) => r\.id\)/);
});
