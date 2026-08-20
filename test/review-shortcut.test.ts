import assert from "node:assert/strict";
import test from "node:test";

import { ACTIONS, resolveKeybindings } from "../src/web/lib/keybindings.ts";
import { reviewShortcutTarget } from "../src/web/lib/review-shortcut.ts";

/** The only two fields the resolver reads, so the fixture states only those. */
function session(id: string, pendingReviews: number): { id: string; pendingReviews: number } {
  return { id, pendingReviews };
}

test("the selected session wins whenever it is the one asking", () => {
  const visible = [session("a", 2), session("b", 1)];
  assert.deepEqual(reviewShortcutTarget(visible, "b"), { sessionId: "b", refocus: false });
});

test("a selected session with nothing waiting hands the chord to the first one that is", () => {
  // `visible` is grid order, and a pending review tones a session `attention`, so the
  // first match is the top of the "needs you" group rather than an arbitrary session.
  const visible = [session("asking", 1), session("quiet", 0)];
  assert.deepEqual(reviewShortcutTarget(visible, "quiet"), {
    sessionId: "asking",
    refocus: true,
  });
});

test("the jump case asks the caller to move the selection", () => {
  // Without this the modal would open for one session while the highlighted card stayed
  // on another - two surfaces disagreeing about which session is being talked about.
  const target = reviewShortcutTarget([session("a", 0), session("b", 3)], "a");
  assert.equal(target?.refocus, true);
});

test("no selection at all still finds the first session asking", () => {
  assert.deepEqual(reviewShortcutTarget([session("a", 0), session("b", 1)], null), {
    sessionId: "b",
    refocus: true,
  });
});

test("a fleet with nothing waiting leaves the chord unclaimed", () => {
  // Null is what keeps the handler from calling preventDefault, which is what keeps a
  // bare `e` on a quiet fleet belonging to the browser.
  assert.equal(reviewShortcutTarget([session("a", 0), session("b", 0)], "a"), null);
  assert.equal(reviewShortcutTarget([], null), null);
});

test("a selected id that is not on the grid falls through to the search", () => {
  // Filtering runs before ordering, so a selection can outlive its visibility.
  assert.deepEqual(reviewShortcutTarget([session("b", 1)], "gone"), {
    sessionId: "b",
    refocus: true,
  });
});

test("review ships bound to e, and expand moved to v rather than colliding", () => {
  const review = ACTIONS.find((a) => a.id === "review");
  assert.equal(review?.defaultBinding, "e");
  assert.equal(review?.group, "selection");

  // The collision this arrangement exists to avoid: `computeResolved` claims chords in
  // registry order, so two actions defaulting to `e` would leave the loser resolved to
  // "" - unbound, and drawing no keycap, with nothing on screen to say why.
  const resolved = resolveKeybindings({});
  assert.equal(resolved.review, "e");
  assert.equal(resolved.expand, "v");
});
