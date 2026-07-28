import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkflowLoadCommitBarrier } from "../src/web/workflows/workflow-load-commit.ts";

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

test("superseded workflow refreshes settle with the replacement commit", async () => {
  const barrier = createWorkflowLoadCommitBarrier();
  let firstSettled = false;
  let replacementSettled = false;
  void barrier.waitFor(1).then(() => { firstSettled = true; });
  void barrier.waitFor(3).then(() => { replacementSettled = true; });

  barrier.commit(1);
  await settle();
  assert.equal(firstSettled, false);
  assert.equal(replacementSettled, false);

  barrier.commit(3);
  await settle();
  assert.equal(firstSettled, true);
  assert.equal(replacementSettled, true);
});

test("unmount releases every outstanding workflow refresh", async () => {
  const barrier = createWorkflowLoadCommitBarrier();
  let settled = false;
  void barrier.waitFor(1).then(() => { settled = true; });

  barrier.release();
  await settle();
  assert.equal(settled, true);
});
