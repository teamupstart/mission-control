import assert from "node:assert/strict";
import test from "node:test";

import { createSetupSnapshotTracker } from "../src/server/setup/snapshots.ts";
import type { SetupChecksView, SetupRowId } from "../src/shared/setup-catalog.ts";

const GH: SetupRowId = { source: "dependency", id: "gh-cli" };

function view(attentionRowIds: SetupRowId[]): SetupChecksView {
  return {
    rows: [],
    banner: {
      visible: true,
      attentionRowIds,
      attentionCount: attentionRowIds.length,
    },
  };
}

test("equivalent setup reads keep both tabs eligible to dismiss", () => {
  let sequence = 0;
  const tracker = createSetupSnapshotTracker(() => `snapshot-${++sequence}`);
  const first = tracker.issue(view([GH]));
  const second = tracker.issue(view([GH]));

  assert.equal(tracker.consume(first.snapshotToken, [GH]), true);
  assert.equal(tracker.consume(second.snapshotToken, [GH]), true);
  assert.equal(tracker.consume(first.snapshotToken, [GH]), false, "a token is single use");
});

test("repair invalidates old tokens and a dismissal must match its snapshot rows", () => {
  let sequence = 0;
  const tracker = createSetupSnapshotTracker(() => `snapshot-${++sequence}`);
  const stale = tracker.issue(view([GH]));
  tracker.issue(view([]));
  const regressed = tracker.issue(view([GH]));

  assert.equal(tracker.consume(stale.snapshotToken, [GH]), false);
  assert.equal(tracker.consume(regressed.snapshotToken, []), false);
  const current = tracker.issue(view([GH]));
  assert.equal(tracker.consume(current.snapshotToken, [GH]), true);
});
