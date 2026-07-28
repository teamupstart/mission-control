import { test } from "node:test";
import assert from "node:assert/strict";
import { elapsed, reachability } from "../src/web/lib/reachability.ts";

/**
 * What is at stake: the panel must never tell you that you are covered when you are not.
 *
 * Away mode's whole pitch is "only things blocked on you get through", and that sentence
 * is a lie on a machine with desktop notifications and sound both off - there is no path
 * left to interrupt you on. Away mode does not add one; all it can do is hand you a
 * digest when you sit back down. The old panel encoded this correctly but rendered it as
 * a grey paragraph identical to the other two, and the redesign moves it into a tone, so
 * the ordering of these branches is now load-bearing in a way a render test would not
 * catch: `muted` has to be decided BEFORE `away`, or the away card starts making the
 * promise on the exact machine that cannot keep it.
 *
 * The rest pins the wording that names live channels, because a sentence naming "desktop
 * and sound" while sound is off is the same class of untruth, quieter.
 */

const base = { desktop: true, sound: true, away: false, awayMs: null, buffered: 0 };

test("both channels live and at the desk: everything reaches you", () => {
  const r = reachability(base);
  assert.equal(r.tone, "ok");
  assert.equal(r.title, "You're reachable");
  assert.match(r.sentence, /desktop and sound/);
});

test("the sentence names only the channels that are actually live", () => {
  assert.match(reachability({ ...base, sound: false }).sentence, /via desktop as it happens/);
  assert.match(reachability({ ...base, desktop: false }).sentence, /via sound as it happens/);
});

test("both channels off at the desk: nothing can reach you, and it says so", () => {
  const r = reachability({ ...base, desktop: false, sound: false });
  assert.equal(r.tone, "muted");
  assert.equal(r.title, "Nothing can reach you");
  assert.match(r.sentence, /the dashboard is the only signal/);
});

// The invariant. Away mode is not a delivery path, and turning it on must not upgrade
// the answer from "nothing can reach you" to "blockers interrupt".
test("both channels off AND away: still muted - away mode cannot add a path", () => {
  const r = reachability({
    ...base,
    desktop: false,
    sound: false,
    away: true,
    awayMs: 3_840_000,
    buffered: 7,
  });
  assert.equal(r.tone, "muted", "away must not outrank muted");
  assert.equal(r.title, "Nothing can reach you");
  assert.doesNotMatch(
    `${r.title}. ${r.sentence}`,
    /interrupt|blockers get through|reaches you/i,
    "must not claim anything gets through when both channels are off",
  );
  assert.match(r.sentence, /only get the digest when you return/);
});

test("away with a channel live: blockers interrupt, the rest waits, and it counts", () => {
  const r = reachability({ ...base, away: true, awayMs: 3_840_000, buffered: 7 });
  assert.equal(r.tone, "away");
  assert.equal(r.title, "Away 1h 04m");
  assert.match(r.sentence, /Blockers interrupt via desktop and sound/);
  assert.match(r.sentence, /\(7 waiting\)/);
});

// A parenthetical zero reads as a broken counter rather than as the quiet it describes.
test("away with an empty buffer omits the count instead of printing zero", () => {
  const r = reachability({ ...base, away: true, awayMs: 60_000, buffered: 0 });
  assert.doesNotMatch(r.sentence, /\(0 waiting\)/);
  assert.match(r.sentence, /waits in the digest\./);
});

test("away before awaySince has loaded says Away without inventing a duration", () => {
  const r = reachability({ ...base, away: true, awayMs: null, buffered: 0 });
  assert.equal(r.title, "Away");
});

test("elapsed pads minutes past the hour so the figure stops jittering as it ticks", () => {
  assert.equal(elapsed(0), "0m");
  assert.equal(elapsed(25 * 60_000), "25m");
  assert.equal(elapsed(60 * 60_000), "1h 00m");
  assert.equal(elapsed(64 * 60_000), "1h 04m");
  assert.equal(elapsed((3 * 60 + 7) * 60_000), "3h 07m");
});
