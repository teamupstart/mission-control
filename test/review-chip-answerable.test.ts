/**
 * What is at stake: the topbar chip must never count a review nothing can open.
 *
 * The review modal is keyed on a SESSION - `modalSession` is `sessions.find(...)`, and
 * `modalOpen` is false without one. So a pending review whose session is gone is not merely
 * a wrong number: `openReviews` sets `reviewSessionId` to an id that matches nothing and the
 * click does nothing at all, with no way for the operator to reach or clear the eight
 * agents the chip says are blocked on them. That is the shape the live install was in.
 *
 * The daemon settling those is the real fix (`review-session-orphan.test.ts`). This pins the
 * half that makes it unreproducible: count and click read ONE list, and that list is
 * narrowed to reviews whose session is still here - which also covers the seconds after a
 * restart, before the first discovery sweep has said which agents are out there.
 *
 * Driven from source for the reason `topbar-popover-dismiss.test.ts` gives: App sits behind
 * an SSE stream that hangs headless automation, and there is no jsdom here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");

test("the chip's list is pending reviews narrowed to sessions that still exist", () => {
  const start = app.indexOf("const answerableReviews");
  assert.notEqual(start, -1, "the narrowed list is gone - the chip is counting orphans again");
  const body = app.slice(start, app.indexOf("}, [", start));

  // Narrowed against the session list, not against `visible`: a typed filter must not make
  // a blocked agent's question vanish from the count.
  assert.match(body, /sessions\.map\(\(s\) => s\.id\)/);
  assert.match(body, /pendingReviews\.filter/);
  assert.match(body, /live\.has\(r\.sessionId\)/);
});

test("the count, the sentence and the click all read that one list", () => {
  // The chip: gate, figure and tooltip. A tooltip left on `pendingReviews` would promise
  // eight over a badge reading zero.
  const chip = app.slice(app.indexOf("{answerableReviews.length > 0 &&"));
  assert.notEqual(chip.length, 0, "the chip no longer gates on the answerable list");
  const head = chip.slice(0, chip.indexOf("</Tooltip>"));
  assert.equal(
    (head.match(/answerableReviews\.length/g) ?? []).length,
    4,
    "gate, singular/plural, sentence and figure must all come from the same list",
  );
  assert.doesNotMatch(head, /pendingReviews/, "the chip must not read the unnarrowed list");

  // And the click, which is the half that was a dead end.
  const open = app.slice(app.indexOf("function openReviews"));
  const openBody = open.slice(0, open.indexOf("\n  }"));
  assert.match(openBody, /answerableReviews\[0\]/);
  assert.doesNotMatch(openBody, /pendingReviews/);
});

test("`pendingReviews` itself stays whole for the callers asking a different question", () => {
  // Foreman's draft staleness asks whether a review was RESOLVED - narrowing that by session
  // liveness would report a live draft as stale the moment its agent's card went away.
  const ids = app.slice(app.indexOf("const pendingReviewIds"));
  assert.match(ids.slice(0, ids.indexOf("],")), /pendingReviews\.map\(\(r\) => r\.id\)/);
});
