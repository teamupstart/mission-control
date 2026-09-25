import assert from "node:assert/strict";
import test from "node:test";
import { BULK_SELECTION_LIMIT, changeSelection } from "../src/web/lib/worktree-selection.ts";
import { WORKTREE_INVENTORY_LIMITS } from "../src/shared/worktrees.ts";

const ids = (count: number, prefix = "slot") => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

test("the bulk selection limit is the request schema's limit", () => {
  assert.equal(BULK_SELECTION_LIMIT, WORKTREE_INVENTORY_LIMITS.bulkSlots);
  assert.equal(BULK_SELECTION_LIMIT, 128);
});

test("Select all fills the selection up to the limit and reports what did not fit", () => {
  const all = changeSelection(new Set(), ids(129), true);
  assert.equal(all.next.size, 128);
  assert.equal(all.refused, 1);
  assert.ok(!all.next.has("slot-128"), "the pool's last slot is the one left out");

  const exact = changeSelection(new Set(), ids(128), true);
  assert.equal(exact.next.size, 128);
  assert.equal(exact.refused, 0);
});

test("a selection spanning pools is capped as a whole, and a full one refuses one more tick", () => {
  const firstPool = changeSelection(new Set(), ids(100, "a"), true);
  const secondPool = changeSelection(firstPool.next, ids(40, "b"), true);
  assert.equal(secondPool.next.size, 128);
  assert.equal(secondPool.refused, 12);
  const oneMore = changeSelection(secondPool.next, ["c-0"], true);
  assert.equal(oneMore.next.size, 128);
  assert.equal(oneMore.refused, 1);
  // Re-ticking something already selected is not a refusal.
  assert.equal(changeSelection(secondPool.next, ["a-0"], true).refused, 0);
});

test("unticking is never limited and frees room for another slot", () => {
  const full = changeSelection(new Set(), ids(128), true).next;
  const freed = changeSelection(full, ["slot-0"], false);
  assert.equal(freed.next.size, 127);
  assert.equal(freed.refused, 0);
  const added = changeSelection(freed.next, ["late"], true);
  assert.equal(added.next.size, 128);
  assert.ok(added.next.has("late"));
});
