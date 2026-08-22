import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorktreeSettingsPanel } from "../src/web/components/WorktreeSettingsPanel.tsx";
import { capacityGeometry } from "../src/web/lib/worktree-capacity.ts";
import type { WorktreeInventory, WorktreeRepositoryView } from "../src/shared/worktrees.ts";
import type { WorktreesState } from "../src/web/useWorktrees.ts";

const noop = async () => {};

/**
 * The over-capacity pool is the plan's worked example: 17 leased, 1 quarantined, 18 total,
 * against a configured maximum of 16. Its two slot-count-to-width cases are the ones the
 * geometry is easy to get wrong on, so they are pinned as arithmetic below as well as
 * asserted through the rendered markup here.
 */
const overCapacityPool: WorktreeRepositoryView = {
  id: "pool-1",
  name: "mission-control",
  root: "/repo/mission-control",
  commonDirectory: "/repo/mission-control/.git",
  poolPath: "/state/worktrees/pool-1",
  policy: { enabled: true, maxSlots: 16, setupArgv: ["npm", "install"] },
  counts: { total: 18, leased: 17, available: 0, quarantined: 1, overCapacity: 2 },
  diskBytes: 4096,
  lastReconciledAt: 1,
  reconciliationError: "one slot needs attention",
  status: "attention",
  slots: [{
    id: "slot-1",
    poolId: "pool-1",
    provider: "mission",
    ordinal: 1,
    state: "leased",
    version: 3,
    path: "/state/worktrees/pool-1/1/mission-control",
    owner: { kind: "task", key: "task-1:0", label: "Ship Worktrees" },
    leaseAgeMs: 500,
    head: "b".repeat(40),
    defaultRelation: "unmerged",
    dirty: true,
    processes: { state: "known", count: 1, reason: null },
    diskBytes: 4096,
    quarantineReason: null,
    diagnostic: null,
    actions: ["return", "destroy"],
  }],
};

/** The within-maximum worked example: 8 leased, 4 available, 12 total, maximum 16. */
const roomToGrowPool: WorktreeRepositoryView = {
  id: "pool-2",
  name: "line-drawers",
  root: "/repo/line-drawers",
  commonDirectory: "/repo/line-drawers/.git",
  poolPath: "/state/worktrees/pool-2",
  policy: { enabled: true, maxSlots: 16, setupArgv: null },
  counts: { total: 12, leased: 8, available: 4, quarantined: 0, overCapacity: 0 },
  diskBytes: 8192,
  lastReconciledAt: 1,
  reconciliationError: null,
  status: "ready",
  slots: [],
};

const inventory: WorktreeInventory = {
  config: { enabled: true, maxSlots: 16, repositories: { "/repo/mission-control/.git": { maxSlots: 16, setupArgv: ["npm", "install"] } } },
  observedAt: 1,
  revision: "a".repeat(64),
  repositories: [overCapacityPool, roomToGrowPool],
  legacy: {
    capability: { kind: "diagnostic-only", version: "2.0.0", diagnostic: "conditional cleanup requires v2.1.1 or newer" },
    totals: { ownedExact: 0, identityUnverifiable: 1, foreign: 0, unreadable: 0 },
    items: [{
      id: "legacy-1",
      classification: "identityUnverifiable",
      repoRoot: "/repo/old",
      path: "/legacy/old",
      owner: { kind: "task", id: "task-old", position: 0 },
      leaseId: null,
      holder: "mission-control",
      acquiredAt: null,
      processes: { state: "unknown", count: null, reason: "not observed" },
      dirty: null,
      canReturn: false,
      diagnostic: "Treehouse status cannot provide stable lease identity",
    }],
  },
};

const state: WorktreesState = {
  inventory,
  loading: false,
  error: null,
  preview: null,
  previewError: null,
  previewChanged: false,
  busy: false,
  refresh: noop,
  updateConfig: noop,
  requestPreview: noop,
  executePreview: async () => true,
  discardPreview: () => {},
};

function render(next: Partial<WorktreesState> = {}): string {
  return renderToStaticMarkup(createElement(WorktreeSettingsPanel, { state: { ...state, ...next } }));
}

test("the panel renders policy, native lifecycle, exact path actions, and legacy remediation", () => {
  const html = render();
  assert.match(html, /data-anchor="worktrees\/policy"/);
  assert.match(html, /data-anchor="worktrees\/native-pools"/);
  assert.match(html, /data-anchor="worktrees\/legacy-drain"/);
  assert.match(html, /over the maximum/);
  assert.match(html, /Destroy fixed pool set/);
  assert.match(html, /Terminal backend for slot 1/);
  assert.match(html, /Use global defaults/);
  assert.match(html, /Treehouse status cannot provide stable lease identity/);
  assert.doesNotMatch(html, /Force/);
});

test("the pane keeps the house style: no numbered eyebrows and no selection accent", () => {
  const html = render();
  for (const eyebrow of ["01 ·", "02 ·", "03 ·", "Pool ledger", "Manager-owned paths only"]) {
    assert.ok(!html.includes(eyebrow), `${eyebrow} should no longer be rendered`);
  }
  // Pools first, then Defaults, then Treehouse - the order the anchors are now bound to.
  const order = ["worktrees/native-pools", "worktrees/policy", "worktrees/legacy-drain"]
    .map((anchor) => html.indexOf(anchor));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order.every((at) => at > 0));
});

test("the capacity bar composes leased, available, quarantined and room to grow to exactly 100%", () => {
  const within = capacityGeometry(roomToGrowPool.counts, roomToGrowPool.policy.maxSlots);
  assert.deepEqual(within.segments.map((segment) => [segment.key, segment.percent]), [
    ["leased", 50],
    ["available", 25],
    ["room", 25],
  ]);
  assert.equal(within.segments.reduce((sum, segment) => sum + segment.percent, 0), 100);
  assert.equal(within.overflow, null);
  assert.equal(within.summary, "12 of 16 slots");

  // The track cannot paint a 0%-wide quarantine, but the pane still has to say there is
  // none: the legend names all four lifecycle counts in every state, and the composed
  // image label is built from the legend rather than from the drawn segments.
  assert.deepEqual(within.legend.map((entry) => entry.label), [
    "8 leased",
    "4 available",
    "0 quarantined",
    "4 more may be created",
  ]);
  assert.equal(within.label, "8 leased, 4 available, 0 quarantined, 4 more may be created, maximum 16");
});

test("over capacity fills the ceiling and spills; it never rescales the track to occupancy", () => {
  const over = capacityGeometry(overCapacityPool.counts, overCapacityPool.policy.maxSlots);
  // The maximum, not the occupancy: 16, not the 18 slots that exist.
  assert.equal(over.denominator, 16);
  // 17 leased against a ceiling of 16 consumes the whole track, so the clamp leaves the
  // quarantined slot no width. It is still stated in the legend below.
  assert.deepEqual(over.segments.map((segment) => [segment.key, segment.percent]), [
    ["leased", 100],
  ]);
  assert.equal(over.segments.reduce((sum, segment) => sum + segment.percent, 0), 100);
  assert.deepEqual(over.overflow, {
    count: 2,
    percentOfMaximum: 12.5,
    label: "2 over the maximum",
  });
  assert.deepEqual(over.legend.map((entry) => entry.label), [
    "17 leased",
    "0 available",
    "1 quarantined",
    "0 more may be created",
  ]);
  assert.equal(over.label, "17 leased, 0 available, 1 quarantined, 0 more may be created, 2 over the maximum, maximum 16");
});

test("lowering a maximum reflows the whole bar rather than sliding a marker along it", () => {
  // The regression this pins: with an occupancy-derived denominator, a 12-slot pool draws
  // an identical 8/4 track at a maximum of 16, 12, or 8, and only an overlay boundary moves.
  // Scaled to the configured maximum, every segment rewidths and one slot is a constant
  // fraction of the track for a given maximum.
  const counts = roomToGrowPool.counts;
  const widthOfLeased = (max: number) =>
    capacityGeometry(counts, max).segments.find((segment) => segment.key === "leased")?.percent;

  assert.equal(widthOfLeased(16), 50);
  assert.equal(widthOfLeased(32), 25);
  // Below the occupancy the bar saturates rather than growing past its own track.
  assert.equal(widthOfLeased(8), 100);

  const tight = capacityGeometry(counts, 8);
  assert.equal(tight.denominator, 8);
  assert.deepEqual(tight.overflow, {
    count: 4,
    percentOfMaximum: 50,
    label: "4 over the maximum",
  });
  // Nothing was pruned to say so: the counts are the ones the server reported, unchanged.
  assert.equal(tight.total, 12);
  assert.equal(tight.label, "8 leased, 4 available, 0 quarantined, 0 more may be created, 4 over the maximum, maximum 8");
});

test("a zero or absent maximum emits a bounded bar rather than NaN", () => {
  for (const max of [0, -4, Number.NaN]) {
    const geometry = capacityGeometry({ total: 3, leased: 3, available: 0, quarantined: 0, overCapacity: 3 }, max);
    assert.equal(geometry.segments.reduce((sum, segment) => sum + segment.percent, 0), 100);
    assert.equal(geometry.overflow?.count, 3);
    assert.equal(geometry.overflow?.percentOfMaximum, 300);
    assert.ok(!JSON.stringify(geometry).includes("null,"), "no NaN leaks into the geometry");
    assert.equal(geometry.label, "3 leased, 0 available, 0 quarantined, 0 more may be created, 3 over the maximum, maximum 0");
  }
  // A pool with nothing in it draws no segments at all and still states every count.
  const empty = capacityGeometry({ total: 0, leased: 0, available: 0, quarantined: 0, overCapacity: 0 }, 0);
  assert.deepEqual(empty.segments, []);
  assert.equal(empty.overflow, null);
  assert.equal(empty.legend.length, 4);
  assert.equal(empty.label, "0 leased, 0 available, 0 quarantined, 0 more may be created, maximum 0");
});

test("the bar's segment widths and composed image label reach the markup", () => {
  const html = render();
  assert.match(html, /aria-label="8 leased, 4 available, 0 quarantined, 4 more may be created, maximum 16"/);
  assert.match(html, /aria-label="17 leased, 0 available, 1 quarantined, 0 more may be created, 2 over the maximum, maximum 16"/);
  assert.match(html, /role="img"/);
  assert.match(html, /wt-bar-leased[^>]*width:50%/);
  assert.match(html, /wt-bar-available[^>]*width:25%/);
  assert.match(html, /wt-bar-room[^>]*width:25%/);
  // The over-capacity pool saturates its ceiling, and the spill cap carries no inline width:
  // its size is fixed in CSS because the track has no proportional room left to give.
  assert.match(html, /wt-bar-leased[^>]*width:100%/);
  assert.match(html, /<span class="wt-bar-over"><\/span>/);
  // Every lifecycle count is restated as text beside the bar - including the zeroes the
  // track has no width to draw - so colour, and its absence, carry none of it.
  for (const words of [
    "8 leased", "4 available", "0 quarantined", "4 more may be created",
    "17 leased", "0 available", "1 quarantined", "0 more may be created",
    "2 over the maximum",
  ]) {
    assert.ok(html.includes(words), `the legend should restate "${words}"`);
  }
  // A zero count is present and legible, not dropped and not hidden.
  assert.match(html, /wt-legend-quarantined wt-legend-zero[^>]*>[^<]*<span class="wt-swatch"[^>]*><\/span>0 quarantined/);
});

test("Default maximum does not claim authority over a pool that set its own", () => {
  // The bar is drawn from `repo.policy.maxSlots`, the pool's EFFECTIVE maximum, so a flat
  // "every bar is drawn against this number" is false for an overridden pool - and this
  // fixture has one, at 16 against a default of 16, which is exactly how a coincidence
  // hides it. Pin the qualified wording so the copy cannot drift back.
  const html = render();
  assert.match(html, /Every bar above whose pool has not set its own maximum is drawn against this number/);
  assert.ok(!html.includes("Every bar above is drawn against this number"));
});

test("loading, empty, and unavailable each get copy rather than a heading over nothing", () => {
  const loading = render({ inventory: null, loading: true });
  assert.match(loading, /wt-skeleton/);
  assert.match(loading, /Observing Git, process, and provider state/);
  assert.doesNotMatch(loading, /No pools yet/);

  const empty = render({ inventory: { ...inventory, repositories: [] } });
  assert.match(empty, /No pools yet\./);
  assert.match(empty, /the first time something needs a checkout in a repository/);

  const unavailable = render({ inventory: null, error: "Worktree inventory is unavailable." });
  assert.match(unavailable, /Pool capacity could not be observed\./);
  assert.match(unavailable, /This is an outage, not an empty machine/);
  assert.doesNotMatch(unavailable, /No pools yet/);
  assert.doesNotMatch(unavailable, /wt-skeleton/);
});

test("Treehouse states its classification counts only when at least one is non-zero", () => {
  const html = render();
  assert.match(html, /identityUnverifiable/);

  const drained = render({
    inventory: {
      ...inventory,
      legacy: {
        capability: { kind: "conditional-json", version: "v2.1.1", diagnostic: null },
        totals: { ownedExact: 0, identityUnverifiable: 0, foreign: 0, unreadable: 0 },
        items: [],
      },
    },
  });
  assert.match(drained, /Nothing left to drain\./);
  assert.doesNotMatch(drained, /wt-legacy-totals/);
});
