import { test } from "node:test";
import assert from "node:assert/strict";
import { createSequencer } from "../src/web/lib/latest.ts";

// What is at stake: the Foreman settings ledger is polled on a 4s `setInterval` that does
// not wait for the previous request, so two reads are routinely in flight at once against
// a busy daemon - and nothing makes them resolve in the order they were issued.
//
// The failure that produces looks exactly like data loss. A slow tick settles AFTER a
// newer one and overwrites it with its older snapshot: a decision Foreman has just
// recorded disappears from the table, and from the count strip above it, until the next
// poll happens to succeed. On the one screen whose whole claim is that the number and the
// list are the same question, a row that appears and then un-appears is worse than a slow
// one. Raised by the Inspector on PR #285.
//
// The guard is tested here rather than through the hook because the dashboard's test
// setup is `renderToStaticMarkup` with no jsdom, so effects never run and a hook's
// ordering behaviour is unreachable. That is why it is a pure object.

test("the newest read wins, even when an older one resolves last", () => {
  const seq = createSequencer();

  // Two ticks start, in order. Tick A is slow.
  const a = seq.begin();
  const b = seq.begin();

  // B comes back first and is applied.
  assert.equal(seq.isCurrent(b), true);

  // A now finally resolves - carrying the OLDER snapshot - and must be dropped.
  assert.equal(seq.isCurrent(a), false, "a stale tick was allowed to overwrite a newer one");
});

test("a read that is never superseded still lands", () => {
  const seq = createSequencer();
  const only = seq.begin();
  assert.equal(seq.isCurrent(only), true);
});

// The ordinary case, and worth pinning because the guard must not reject everything: back
// to back ticks that do not overlap each apply in turn.
test("sequential reads each land when they do not overlap", () => {
  const seq = createSequencer();
  for (let i = 0; i < 5; i++) {
    const t = seq.begin();
    assert.equal(seq.isCurrent(t), true, `read ${i} was wrongly treated as stale`);
  }
});

// The same rule stated the other way round, which is what `update` relies on: a write
// retires every read that began before it. Otherwise a poll issued a moment earlier lands
// afterwards and repaints the control with the value the write just replaced - the exact
// "showing a value that isn't in force" failure the optimistic revert exists to prevent.
test("a write retires reads that began before it", () => {
  const seq = createSequencer();

  const pollInFlight = seq.begin(); // a tick issued just before the operator clicked
  const write = seq.begin(); // update() claims a token when the write lands

  assert.equal(seq.isCurrent(pollInFlight), false, "a pre-write poll could repaint the write away");
  assert.equal(seq.isCurrent(write), true);
});

// Tokens are not reused, so an old token can never be mistaken for a current one after
// the counter has moved on and come back - there is no coming back.
test("tokens are monotonic, so a retired one never becomes current again", () => {
  const seq = createSequencer();
  const first = seq.begin();
  seq.begin();
  seq.begin();
  assert.equal(seq.isCurrent(first), false);
});
