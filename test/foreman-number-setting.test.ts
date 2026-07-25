/**
 * What is at stake: the Foreman popover's number fields (max agents, fix attempts, fix
 * rounds) auto-save now - a change commits on its own, on a debounce and again on blur and
 * on unmount, so you never press Enter, and closing the popover mid-edit no longer drops the
 * change. That last one WAS the bug: the field committed only on blur, and clicking outside
 * closed (unmounted) the popover before blur could fire, so the edit was lost unless you
 * pressed Enter.
 *
 * Two layers are pinned here. `pendingCommit` is the "what may we send" gate - with auto-save
 * on, a half-typed or refused number would reach the daemon the instant the debounce fires,
 * so the gate has to hold. `createNumberFieldSaver` is the debounce-and-flush timing the
 * component runs on; pulled out of the component precisely so it can be driven by a fake
 * clock here, where there is no jsdom to advance a real timer. The unmount-flush test is the
 * regression for the click-outside failure: it FAILS if `flush` stops committing the armed
 * value, which is exactly the pre-fix behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { pendingCommit, createNumberFieldSaver } from "../src/web/components/ForemanBar.tsx";

// ---- the "what may we send" gate ----

test("a valid in-range change is the value to commit", () => {
  assert.equal(pendingCommit("6", 8, 1, 20), 6);
  assert.equal(pendingCommit("1", 8, 1, 20), 1); // the min itself
  assert.equal(pendingCommit("20", 8, 1, 20), 20); // the max itself
});

test("an unchanged draft commits nothing, so idle blur/debounce is a no-op", () => {
  assert.equal(pendingCommit("8", 8, 1, 20), null);
});

test("an emptied field never commits - not even where 0 would be in range", () => {
  // The Shipping soak window makes 0 legal ("no soak"), so `Number("") === 0` must NOT slip
  // through as a value the moment the debounce fires; clearing to retype waits for a number.
  assert.equal(pendingCommit("", 5, 0, 60), null);
  assert.equal(pendingCommit("   ", 5, 0, 60), null);
  assert.equal(pendingCommit("", 8, 1, 20), null);
});

test("out-of-range and non-integer drafts are refused, so the daemon never sees them", () => {
  assert.equal(pendingCommit("0", 8, 1, 20), null); // below min
  assert.equal(pendingCommit("21", 8, 1, 20), null); // above max
  assert.equal(pendingCommit("1.5", 8, 1, 20), null); // not an integer
  assert.equal(pendingCommit("abc", 8, 1, 20), null); // not a number
});

// ---- the debounce-and-flush timing ----

/** A hand-advanced clock, so debounce and flush are tested without a real timer or a DOM. */
function fakeClock() {
  let seq = 0;
  let now = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  return {
    setTimer: (fn: () => void, ms: number): number => {
      const id = ++seq;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (h: unknown): void => void timers.delete(h as number),
    tick(ms: number): void {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: (): number => timers.size,
  };
}

function saverOn(clock: ReturnType<typeof fakeClock>, commits: number[]) {
  return createNumberFieldSaver((n) => commits.push(n), {
    delayMs: 400,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
}

test("a valid edit saves after the debounce, with no Enter and no blur", () => {
  const clock = fakeClock();
  const commits: number[] = [];
  const saver = saverOn(clock, commits);

  saver.edit("6", 8, 1, 20);
  clock.tick(399);
  assert.deepEqual(commits, [], "committed before the debounce elapsed");
  clock.tick(1);
  assert.deepEqual(commits, [6], "the debounce did not commit on its own");
});

test("closing before the debounce flushes the pending value - the click-outside bug", () => {
  const clock = fakeClock();
  const commits: number[] = [];
  const saver = saverOn(clock, commits);

  saver.edit("3", 4, 1, 10);
  clock.tick(100); // still well inside the debounce window
  assert.deepEqual(commits, [], "sanity: nothing has auto-saved yet");

  saver.flush(); // the popover closes / the field unmounts
  assert.deepEqual(commits, [3], "the pending edit was dropped on close - the original bug");

  clock.tick(1000);
  assert.deepEqual(commits, [3], "the cancelled debounce timer must not fire a second write");
  assert.equal(clock.pending(), 0);
});

test("rapid edits debounce to a single write of the final value", () => {
  const clock = fakeClock();
  const commits: number[] = [];
  const saver = saverOn(clock, commits);

  saver.edit("1", 8, 1, 20); // "1" on the way to "12"
  clock.tick(200);
  saver.edit("12", 8, 1, 20); // resets the debounce
  clock.tick(399);
  assert.deepEqual(commits, [], "the timer did not reset on the second keystroke");
  clock.tick(1);
  assert.deepEqual(commits, [12], "the intermediate '1' should never have been written");
});

test("an empty, unchanged, or out-of-range edit arms nothing, so flush stays silent", () => {
  const clock = fakeClock();
  const commits: number[] = [];
  const saver = saverOn(clock, commits);

  saver.edit("", 8, 1, 20); // emptied
  saver.edit("8", 8, 1, 20); // unchanged
  saver.edit("99", 8, 1, 20); // out of range
  assert.equal(clock.pending(), 0, "a non-committable draft still armed a timer");
  saver.flush();
  clock.tick(1000);
  assert.deepEqual(commits, [], "a value the human never chose reached the daemon");
});
