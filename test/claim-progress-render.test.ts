import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatElapsed } from "../src/web/components/ClaimProgress.tsx";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { PendingList } from "../src/web/components/PendingDispatch.tsx";
import { TaskClaimWarnings } from "../src/web/components/session-bits.tsx";
import type { TaskClaimWarning, TaskProvisioning } from "../src/shared/types.ts";
import { containsMarkup } from "./helpers/markup.ts";
import { mkSession, mkTask, mkTaskSummary } from "./helpers/session-fixture.ts";
import { mkSessionView } from "./helpers/session-view.ts";

// The task card's side of a dependency claim: the dispatch placeholder while it waits on one,
// and the session's task band once a failed claim handed its tree over anyway.

const PROVISIONING: TaskProvisioning = {
  phase: "installingDependencies",
  repoRoot: "/Users/dev/work/web",
  slotId: "slot-1",
  claimId: "claim-1",
  startedAt: Date.now() - 65_000,
  step: { step: 1, stepCount: 2, command: "yarn install --immutable", startedAt: Date.now() - 5_000 },
};

const WARNING: TaskClaimWarning = {
  repoRoot: "/Users/dev/work/web",
  step: 1,
  stepCount: 2,
  command: "yarn install --immutable",
  reason: "exited with code 1",
  tail: "YN0035: the registry answered 401\n",
  truncatedBytes: 0,
};

function pending(variant: "tile" | "rail", provisioning: TaskProvisioning | null): string {
  const task = mkTask({ id: "t-claim", title: "Fix the build", status: "dispatching", provisioning });
  return renderToStaticMarkup(createElement(PendingList, { tasks: [task], variant }));
}

test("a dispatch waiting on a claim says Installing dependencies, with the step, its elapsed time and Stop", () => {
  for (const variant of ["tile", "rail"] as const) {
    const html = pending(variant, PROVISIONING);
    assert.match(html, /Installing dependencies/, variant);
    assert.doesNotMatch(html, /Provisioning its worktree/, variant);
    assert.match(html, /Step 1 of 2/, variant);
    assert.match(html, /1:0\d elapsed/, variant);
    assert.match(html, /aria-label="Stop installing dependencies for Fix the build"/, variant);
    assert.match(html, />Stop<\/button>/, variant);
  }
  // A single-repo task never names the repository: there is only one tree it could be.
  assert.doesNotMatch(pending("tile", PROVISIONING), / in web/);
});

test("a dispatch provisioning without a running claim step keeps the ordinary placeholder", () => {
  const html = pending("tile", null);
  assert.match(html, /Provisioning its worktree/);
  assert.doesNotMatch(html, /Installing dependencies|claim-stop/);
  assert.match(html, /pend-skel-a/);
});

test("the session's task band shows each failed claim, the shared leaf on both layouts", () => {
  const session = mkSession({ task: mkTaskSummary({ claimWarnings: [WARNING] }) });
  const html = renderToStaticMarkup(createElement(ConsoleDetail, { session, view: mkSessionView(session) }));
  const leaf = renderToStaticMarkup(createElement(TaskClaimWarnings, { warnings: [WARNING] }));
  assert.ok(containsMarkup(html, leaf), "the detail renders the shared leaf");
  assert.match(leaf, /Dependency install failed in web: step 1 of 2 exited with code 1\./);
  assert.match(leaf, /aria-label="Failed command: yarn install --immutable"/);
  assert.match(leaf, /YN0035: the registry answered 401/);
});

test("no failed claim, no warning band", () => {
  const session = mkSession({ task: mkTaskSummary() });
  const html = renderToStaticMarkup(createElement(ConsoleDetail, { session, view: mkSessionView(session) }));
  assert.equal(html.includes("task-claim-warning"), false);
  assert.equal(renderToStaticMarkup(createElement(TaskClaimWarnings, { warnings: [] })), "");
  assert.equal(renderToStaticMarkup(createElement(TaskClaimWarnings, { warnings: undefined })), "");
});

test("elapsed time reads m:ss, then h:mm:ss, and never goes negative", () => {
  assert.equal(formatElapsed(-5_000), "0:00");
  assert.equal(formatElapsed(65_000), "1:05");
  assert.equal(formatElapsed(3_725_000), "1:02:05");
});
