import assert from "node:assert/strict";
import test from "node:test";

import { ACTIONS, resolveKeybindings } from "../src/web/lib/keybindings.ts";
import { reviewChordTarget, reviewShortcutTarget } from "../src/web/lib/review-shortcut.ts";

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

test("the chord takes a fleet session asking before any resident in the drawer's Needs you group", () => {
  const fleet = [session("quiet", 0), session("fleet", 1)];
  const drawer = [session("resident", 2)];
  assert.deepEqual(reviewChordTarget(fleet, null, drawer), { kind: "fleet", sessionId: "fleet", refocus: true });
  // The selected fleet session asking still wins outright.
  assert.deepEqual(reviewChordTarget([session("a", 1), session("b", 1)], "b", drawer), {
    kind: "fleet",
    sessionId: "b",
    refocus: false,
  });
});

test("with no fleet session asking, the chord opens the first drawer resident's review queue", () => {
  const drawer = [session("first", 1), session("second", 3)];
  assert.deepEqual(reviewChordTarget([session("quiet", 0)], "quiet", drawer), {
    kind: "resident",
    sessionId: "first",
    opens: "review",
  });
});

test("a drawer resident that needs you without a review opens its conversation, in drawn order", () => {
  // Parked on a menu: no review queue, but the Needs you group still names it, so `e` reaches it.
  assert.deepEqual(reviewChordTarget([], null, [session("menu", 0), session("review", 1)]), {
    kind: "resident",
    sessionId: "menu",
    opens: "conversation",
  });
});

test("the chord is unclaimed with nothing asking on the fleet and no drawer group", () => {
  assert.equal(reviewChordTarget([session("a", 0)], "a", []), null);
  assert.equal(reviewChordTarget([], null, []), null);
});

test("a resident asking without a review in the Needs you rail is still reached from the drawer group", () => {
  // A conversation is open, so the resident is a rail row (in `visible`) as well as in the drawer's
  // group. No review anywhere: the fleet step finds nothing, and the drawer step reaches it.
  const visible = [session("fleet", 0), session("menu", 0)];
  assert.deepEqual(reviewChordTarget(visible, "fleet", [session("menu", 0)], "fleet"), {
    kind: "resident",
    sessionId: "menu",
    opens: "conversation",
  });
  // The same resident with a review is still the drawer step's: it opens its review queue.
  assert.deepEqual(reviewChordTarget([session("fleet", 0), session("asks", 1)], "fleet", [session("asks", 1)], "fleet"), {
    kind: "resident",
    sessionId: "asks",
    opens: "review",
  });
});

test("a selected rail resident with a review never jumps ahead of a fleet session's review", () => {
  // A conversation is open, so the resident is a rail row in `visible`, and it is the selection.
  // The fleet step skips the drawer group's residents, so the fleet session asking comes first.
  const visible = [session("resident", 1), session("fleet", 1)];
  assert.deepEqual(reviewChordTarget(visible, "resident", [session("resident", 1)], "resident"), {
    kind: "fleet",
    sessionId: "fleet",
    refocus: true,
  });
  // With the drawer closed there is no group, and the selected session wins as it always has.
  assert.deepEqual(reviewChordTarget(visible, "resident", [], "resident"), {
    kind: "fleet",
    sessionId: "resident",
    refocus: false,
  });
});

test("the open resident with a review keeps the chord in drawn order", () => {
  // Its review queue is still something to open, so it is not passed over for the next resident.
  const drawer = [session("open", 1), session("next", 1)];
  assert.deepEqual(reviewChordTarget(drawer, "open", drawer, "open"), {
    kind: "resident",
    sessionId: "open",
    opens: "review",
  });
});

test("the drawer step passes over the open conversation while another resident is asking", () => {
  const drawer = [session("open", 0), session("next", 0)];
  assert.deepEqual(reviewChordTarget(drawer, "open", drawer, "open"), {
    kind: "resident",
    sessionId: "next",
    opens: "conversation",
  });
  // Alone, the open one is still the target: the chord puts the cursor back in its reply box.
  assert.deepEqual(reviewChordTarget([session("open", 0)], "open", [session("open", 0)], "open"), {
    kind: "resident",
    sessionId: "open",
    opens: "conversation",
  });
});
