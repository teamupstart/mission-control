import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorkflowLoadAcknowledgement,
  createWorkflowLoadCommitBarrier,
  createWorkflowRefreshQueue,
} from "../src/web/workflows/workflow-load-commit.ts";

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test("an older ready-state commit cannot settle the next workflow refresh", async () => {
  const barrier = createWorkflowLoadCommitBarrier();
  let settled = false;
  void barrier.waitFor(1).then(() => { settled = true; });

  barrier.commit(0);
  await settle();
  assert.equal(settled, false);

  barrier.commit(1);
  await settle();
  assert.equal(settled, true);
});

test("a ladder refresh acknowledges only after its generation renders loading", () => {
  const acknowledgement = createWorkflowLoadAcknowledgement();

  assert.equal(
    acknowledgement.observe(1, false),
    false,
    "stale ready data cannot acknowledge the newly requested generation",
  );
  assert.equal(acknowledgement.observe(1, true), false);
  assert.equal(acknowledgement.observe(1, false), true);

  assert.equal(
    acknowledgement.observe(2, false),
    false,
    "the prior generation's loading transition cannot acknowledge the next one",
  );
});

test("a second ladder refresh waits while the prior generation remains loading", async () => {
  const queue = createWorkflowRefreshQueue();
  const first = deferred();
  const started: number[] = [];

  const firstRefresh = queue.enqueue(() => {
    started.push(1);
    return first.promise;
  });
  const secondRefresh = queue.enqueue(async () => {
    started.push(2);
  });
  await settle();
  assert.deepEqual(started, [1]);

  first.resolve();
  await firstRefresh;
  await secondRefresh;
  assert.deepEqual(started, [1, 2]);
});

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
