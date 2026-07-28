import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  dropRunActions,
  isRunActionPending,
  registerRunActionRefresh,
  runAction,
  useRunActions,
} from "../src/web/workflows/run-action-store.ts";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

function ActionError({ runId }: { runId: string }): React.JSX.Element {
  const controller = useRunActions(runId, () => {});
  return createElement("span", null, controller.error);
}

function actionError(runId: string): string {
  return renderToStaticMarkup(createElement(ActionError, { runId }));
}

test("one run action survives a page switch and refuses a second submission", async () => {
  const runId = "run-page-switch";
  const first = deferred();
  let sends = 0;
  let secondSurfaceSends = 0;
  let requestId = "";
  runAction(
    runId,
    "recheck-inspector",
    (id) => {
      sends++;
      requestId = id;
      return first.promise;
    },
    () => {},
  );

  assert.equal(isRunActionPending(runId, "recheck-inspector"), true);
  assert.equal(isRunActionPending(runId, "prepare-pr"), false);
  assert.equal(isRunActionPending("another-run", "recheck-inspector"), false);

  // The first surface unmounted. A second surface reads the same module-level entry.
  runAction(
    runId,
    "recheck-inspector",
    async () => {
      secondSurfaceSends++;
    },
    () => {},
  );
  assert.equal(sends, 1);
  assert.equal(secondSurfaceSends, 0);

  first.reject(new Error("connection dropped"));
  await settle();
  assert.equal(isRunActionPending(runId, "recheck-inspector"), false);

  const retry = deferred();
  let retryId = "";
  runAction(
    runId,
    "recheck-inspector",
    (id) => {
      retryId = id;
      return retry.promise;
    },
    () => {},
  );
  assert.equal(retryId, requestId, "a failed request keeps its idempotency key");
  retry.resolve();
  await settle();
  assert.equal(isRunActionPending(runId, "recheck-inspector"), false);

  let afterSuccessId = "";
  runAction(
    runId,
    "recheck-inspector",
    async (id) => {
      afterSuccessId = id;
    },
    () => {},
  );
  await settle();
  assert.notEqual(afterSuccessId, requestId, "success clears the retained request id");
  dropRunActions(runId);
});

test("dropping a removed run clears pending entries permanently", async () => {
  const runId = "run-removed";
  const active = deferred();
  runAction(runId, "prepare-pr", () => active.promise, () => {});
  assert.equal(isRunActionPending(runId, "prepare-pr"), true);
  dropRunActions(runId);
  assert.equal(isRunActionPending(runId, "prepare-pr"), false);
  active.reject(new Error("late response"));
  await settle();
  assert.equal(isRunActionPending(runId, "prepare-pr"), false);
});

test("starting another action clears stale errors but preserves later concurrent failures", async () => {
  const runId = "run-stale-error";
  runAction(
    runId,
    "recheck-inspector",
    async () => {
      throw new Error("old Inspector failure");
    },
    () => {},
  );
  await settle();
  assert.match(actionError(runId), /old Inspector failure/);

  const successful = deferred();
  runAction(runId, "prepare-pr", () => successful.promise, () => {});
  assert.doesNotMatch(actionError(runId), /old Inspector failure/);

  runAction(
    runId,
    "delivery:delivery:mark_delivered",
    async () => {
      throw new Error("later delivery failure");
    },
    () => {},
  );
  await settle();
  assert.match(actionError(runId), /later delivery failure/);

  successful.resolve();
  await settle();
  assert.match(actionError(runId), /later delivery failure/);

  runAction(runId, "recheck-inspector", async () => {}, () => {});
  assert.doesNotMatch(actionError(runId), /later delivery failure/);
  await settle();
  dropRunActions(runId);
});

test("a successful action stays pending until its refreshed detail is committed", async () => {
  const runId = "run-refresh-pending";
  const refresh = deferred();
  let duplicateSends = 0;
  runAction(
    runId,
    "prepare-pr",
    async () => {},
    () => refresh.promise,
  );
  await settle();

  assert.equal(isRunActionPending(runId, "prepare-pr"), true);
  runAction(
    runId,
    "prepare-pr",
    async () => {
      duplicateSends++;
    },
    () => {},
  );
  assert.equal(duplicateSends, 0);

  refresh.resolve();
  await settle();
  assert.equal(isRunActionPending(runId, "prepare-pr"), false);
  dropRunActions(runId);
});

test("a cross-page action refreshes the surface mounted when its request settles", async () => {
  const runId = "run-cross-page";
  const sent = deferred();
  const refreshed = deferred();
  let sourceRefreshes = 0;
  let targetRefreshes = 0;

  const unregisterSource = registerRunActionRefresh(runId, () => {
    sourceRefreshes++;
  });
  runAction(runId, "recheck-inspector", () => sent.promise, () => {
    sourceRefreshes++;
  });
  unregisterSource();
  const unregisterTarget = registerRunActionRefresh(runId, () => {
    targetRefreshes++;
    return refreshed.promise;
  });

  sent.resolve();
  await settle();
  assert.equal(sourceRefreshes, 0);
  assert.equal(targetRefreshes, 1);
  assert.equal(isRunActionPending(runId, "recheck-inspector"), true);

  refreshed.resolve();
  await settle();
  assert.equal(isRunActionPending(runId, "recheck-inspector"), false);
  unregisterTarget();
  dropRunActions(runId);
});

test("an unmounted source transfers its successful action refresh to the destination", async () => {
  const runId = "run-refresh-transfer";
  const sent = deferred();
  const sourceRefresh = deferred();
  const targetRefresh = deferred();
  let targetRefreshes = 0;

  const unregisterSource = registerRunActionRefresh(runId, () => sourceRefresh.promise);
  runAction(runId, "delivery:delivery:discard_and_new_round", () => sent.promise, () => {});
  sent.resolve();
  await settle();
  assert.equal(isRunActionPending(
    runId,
    "delivery:delivery:discard_and_new_round",
  ), true);

  // React may release the source component's private barrier before useSyncExternalStore
  // unregisters it. Promise callbacks run after both synchronous cleanups.
  sourceRefresh.resolve();
  unregisterSource();
  await settle();
  assert.equal(
    isRunActionPending(runId, "delivery:delivery:discard_and_new_round"),
    true,
    "releasing the source surface cannot acknowledge its abandoned detail refresh",
  );

  const unregisterTarget = registerRunActionRefresh(runId, () => {
    targetRefreshes++;
    return targetRefresh.promise;
  });
  await settle();
  assert.equal(targetRefreshes, 1);
  assert.equal(isRunActionPending(
    runId,
    "delivery:delivery:discard_and_new_round",
  ), true);

  targetRefresh.resolve();
  await settle();
  assert.equal(isRunActionPending(
    runId,
    "delivery:delivery:discard_and_new_round",
  ), false);

  unregisterTarget();
  dropRunActions(runId);
});

test("an inactive historical surface leaves no refresh marker behind", async () => {
  const runId = "run-historical-surface";
  const unregister = registerRunActionRefresh(runId, () => {
    assert.fail("an unmounted historical surface cannot be refreshed");
  });
  unregister();

  let fallbackRefreshes = 0;
  runAction(runId, "recheck-inspector", async () => {}, () => {
    fallbackRefreshes++;
  });
  await settle();

  assert.equal(fallbackRefreshes, 1);
  assert.equal(
    isRunActionPending(runId, "recheck-inspector"),
    false,
    "a direct action after unmount must not wait for the run to be viewed again",
  );
  dropRunActions(runId);
});
