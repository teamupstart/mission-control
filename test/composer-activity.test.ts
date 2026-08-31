import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSER_FOCUS_LEASE_MS,
  COMPOSER_INPUT_GUARD_MS,
  ComposerActivityTracker,
} from "../src/server/composer-activity.ts";

test("a focused composer blocks Foreman only while its renewable lease is live", () => {
  const activity = new ComposerActivityTracker();
  activity.record("session-1", "tab-a", { focused: true, typed: false }, 1_000);

  assert.equal(activity.blocksForeman("session-1", 1_000), true);
  assert.equal(activity.blocksForeman("session-1", 1_000 + COMPOSER_FOCUS_LEASE_MS - 1), true);
  assert.equal(activity.blocksForeman("session-1", 1_000 + COMPOSER_FOCUS_LEASE_MS), false);
});

test("a typed composer blocks Foreman for one minute after blur", () => {
  const activity = new ComposerActivityTracker();
  activity.record("session-1", "tab-a", { focused: true, typed: true }, 5_000);
  activity.record("session-1", "tab-a", { focused: false, typed: false }, 6_000);

  assert.equal(activity.blocksForeman("session-1", 5_000 + COMPOSER_INPUT_GUARD_MS - 1), true);
  assert.equal(activity.blocksForeman("session-1", 5_000 + COMPOSER_INPUT_GUARD_MS), false);
});

test("one dashboard tab cannot clear another tab's composer protection", () => {
  const activity = new ComposerActivityTracker();
  activity.record("session-1", "tab-a", { focused: true, typed: false }, 10_000);
  activity.record("session-1", "tab-b", { focused: true, typed: false }, 10_000);
  activity.record("session-1", "tab-a", { focused: false, typed: false }, 11_000);

  assert.equal(activity.blocksForeman("session-1", 11_000), true);
  assert.equal(activity.blocksForeman("another-session", 11_000), false);
});
