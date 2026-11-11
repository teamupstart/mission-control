import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorktreeSettingsPanel } from "../src/web/components/WorktreeSettingsPanel.tsx";
import { capacityGeometry } from "../src/web/lib/worktree-capacity.ts";
import type { WorktreeInventory, WorktreeOperationView, WorktreeRepositoryView } from "../src/shared/worktrees.ts";
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
  policy: { enabled: true, maxSlots: 16, setupArgv: ["npm", "install"], claim: null },
  claimVariables: [],
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
    dependencies: null,
    warmLog: null,
  }],
};

/** The within-maximum worked example: 8 leased, 4 available, 12 total, maximum 16. */
const roomToGrowPool: WorktreeRepositoryView = {
  id: "pool-2",
  name: "line-drawers",
  root: "/repo/line-drawers",
  commonDirectory: "/repo/line-drawers/.git",
  poolPath: "/state/worktrees/pool-2",
  policy: { enabled: true, maxSlots: 16, setupArgv: null, claim: null },
  claimVariables: [],
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
  operations: [],
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
  operations: [],
  refresh: noop,
  updateConfig: async () => ({ ok: true }),
  requestPreview: noop,
  executePreview: async () => true,
  discardPreview: () => {},
  dismissOperation: noop,
  cancelOperation: noop,
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

const queuedDestroy: WorktreeOperationView = {
  id: "op-1",
  request: { action: "destroy", target: { kind: "slot", slotId: "slot-1" } },
  state: "queued",
  targets: [{ provider: "mission", id: "slot-1", path: "/state/worktrees/pool-1/1/mission-control" }],
  error: null,
  changed: false,
  removals: [{ id: "slot-1", path: "/state/worktrees/pool-1/1/mission-control" }],
  completed: [],
  queuedAt: 1,
  finishedAt: null,
  warm: null,
};

test("a destroyable slot offers a bulk selection checkbox and no bulk bar until one is ticked", () => {
  const html = render();
  assert.match(html, /aria-label="Select slot 1 for bulk destroy"/);
  assert.match(html, />Select all slots</);
  assert.doesNotMatch(html, /Bulk destroy selection/);
  assert.doesNotMatch(html, /Background cleanup/);
});

test("a slot with a queued cleanup says so and offers no second action", () => {
  const html = render({ operations: [queuedDestroy] });
  assert.match(html, /aria-label="Background cleanup"/);
  assert.match(html, /role="status"/);
  assert.match(html, /destroy queued/);
  assert.match(html, /<input[^>]*aria-label="Select slot 1 for bulk destroy"[^>]*disabled/);
  // Neither Return nor Destroy is offered while the slot's own cleanup is pending.
  assert.doesNotMatch(html, /Preview permanently removing this manager-owned slot/);
  assert.doesNotMatch(html, /Preview returning this slot/);
  // The pool's "Select all" has nothing left it could add.
  assert.doesNotMatch(html, />Select all slots</);
});

test("a failed background cleanup explains a stale preview and offers to preview again", () => {
  const html = render({
    operations: [{
      ...queuedDestroy,
      state: "failed",
      changed: true,
      error: "worktree state changed after preview; refresh before executing",
      finishedAt: 2,
    }],
  });
  assert.match(html, /State changed after this preview\./);
  assert.match(html, />Preview again</);
  assert.match(html, />Dismiss</);
  // A failure leaves the slot actionable again.
  assert.match(html, /Preview permanently removing this manager-owned slot/);
});

test("a bulk destroy that stopped partway names what it removed and retries only the rest", () => {
  const html = render({
    operations: [{
      ...queuedDestroy,
      request: { action: "destroy", target: { kind: "slots", slotIds: ["slot-1", "slot-2"] } },
      targets: [
        { provider: "mission", id: "slot-1", path: "/state/worktrees/pool-1/1/mission-control" },
        { provider: "mission", id: "slot-2", path: "/state/worktrees/pool-1/2/mission-control" },
      ],
      state: "failed",
      error: "git worktree remove failed",
      completed: [{ id: "slot-2", path: "/state/worktrees/pool-1/2/mission-control" }],
      finishedAt: 2,
    }],
  });
  assert.match(html, /partly done/);
  assert.match(html, /1 worktree was removed before this stopped; 1 left in place\./);
  assert.match(html, /aria-label="Already removed"[^]*\/state\/worktrees\/pool-1\/2\/mission-control/);
  assert.match(html, /only what this left in place/);
  assert.doesNotMatch(html, /nothing was changed by it/);
});

test("a failed operation with nothing left to retry offers only Dismiss", () => {
  const html = render({
    operations: [{
      ...queuedDestroy,
      state: "failed",
      error: "publication failed after removal",
      completed: [{ id: "slot-1", path: "/state/worktrees/pool-1/1/mission-control" }],
      finishedAt: 2,
    }],
  });
  assert.doesNotMatch(html, />Preview again</);
  assert.match(html, />Dismiss</);
});

test("a cleanup of one task-owned slot is not counted as several worktrees", () => {
  const taskTargets = [
    { provider: "git" as const, id: "task-repo-1", path: "/work/task/secondary-repo" },
    { provider: "mission" as const, id: "slot-1", path: "/state/worktrees/pool-1/1/mission-control" },
    { provider: "treehouse" as const, id: "task-repo-2", path: "/legacy/task/third-repo" },
  ];
  const returning = render({
    operations: [{
      ...queuedDestroy,
      request: { action: "return", slotId: "slot-1" },
      targets: taskTargets,
      removals: [],
    }],
  });
  assert.match(returning, /\/state\/worktrees\/pool-1\/1\/mission-control \(\+2 affected paths\)/);
  assert.doesNotMatch(returning, /3 worktrees/);

  const destroying = render({
    operations: [{
      ...queuedDestroy,
      targets: taskTargets,
      removals: [{ id: "slot-1", path: "/state/worktrees/pool-1/1/mission-control" }],
    }],
  });
  assert.match(destroying, /<code>\/state\/worktrees\/pool-1\/1\/mission-control<\/code>/);
  assert.doesNotMatch(destroying, /3 worktrees/);
});

test("Dismiss never claims a failure without confirmed removals changed nothing", () => {
  const html = render({
    operations: [{
      ...queuedDestroy,
      state: "failed",
      error: "task cleanup was refused",
      completed: [],
      finishedAt: 2,
    }],
  });
  assert.match(html, /dismissing it does not undo or retry anything/);
  assert.doesNotMatch(html, /nothing was changed/);
});

test("a pool with a claim shows its editor, each name's presence, and every slot dependency state", () => {
  const base = overCapacityPool.slots[0]!;
  const at = { fingerprintSha: null, claimedAt: null };
  const claimPool: WorktreeRepositoryView = {
    ...roomToGrowPool,
    // An attention pool renders open, so its detail and slots reach the markup.
    status: "attention",
    policy: {
      ...roomToGrowPool.policy,
      claim: {
        steps: [{ argv: ["pnpm", "install", "--frozen-lockfile"], env: ["ARTIFACTORY_AUTH_TOKEN", "NPM_TOKEN"] }],
        timeoutMinutes: 15,
        fingerprintPaths: ["pnpm-lock.yaml", "apps/*/package.json"],
        seed: { paths: ["node_modules", "apps/*/node_modules"], exclude: ["**/node_modules/.cache"] },
      },
    },
    claimVariables: [
      { name: "ARTIFACTORY_AUTH_TOKEN", present: true, source: "loginShell" },
      { name: "NPM_TOKEN", present: false, source: null },
    ],
    slots: [
      { ...base, id: "d1", ordinal: 1, dependencies: { ...at, state: "current", fingerprintSha: "c".repeat(40), defaultSha: "d".repeat(40) } },
      { ...base, id: "d2", ordinal: 2, dependencies: { ...at, state: "stale", fingerprintSha: "c".repeat(40), defaultSha: "e".repeat(40) } },
      { ...base, id: "d3", ordinal: 3, dependencies: { ...at, state: "never" } },
      {
        ...base,
        id: "d4",
        ordinal: 4,
        state: "provisioning",
        dependencies: {
          ...at,
          state: "installing",
          claimId: "claim-d4",
          startedAt: 0,
          step: { step: 1, stepCount: 2, command: "pnpm install --frozen-lockfile", startedAt: 0 },
        },
      },
      {
        ...base,
        id: "d5",
        ordinal: 5,
        dependencies: {
          ...at,
          state: "failed",
          failure: {
            step: 1, stepCount: 1, command: "pnpm install", reason: "exited with code 3", tail: "E401 Unauthorized\n", truncatedBytes: 0,
            tailWithheld: false,
          },
        },
      },
      { ...base, id: "d6", ordinal: 6, dependencies: { ...at, state: "interrupted" } },
      {
        ...base,
        id: "d7",
        ordinal: 7,
        // A failure an earlier build stored as text: the reason line and tail, no guessed command.
        dependencies: {
          ...at,
          state: "failed",
          failure: {
            step: null, stepCount: null, command: null, reason: "legacy summary line", tail: "", truncatedBytes: 0,
            tailWithheld: true,
          },
        },
      },
    ],
  };
  const html = render({ inventory: { ...inventory, repositories: [claimPool] } });
  assert.match(html, /Dependency claim, run on every task lease/);
  assert.match(html, /Step 1 command, one argument per line/);
  assert.match(html, />pnpm\ninstall\n--frozen-lockfile<\/textarea>/);
  assert.match(html, /value="ARTIFACTORY_AUTH_TOKEN NPM_TOKEN"/);
  assert.match(html, /value="15"/);
  assert.match(html, />pnpm-lock.yaml\napps\/\*\/package.json<\/textarea>/);
  assert.match(html, /Seed paths, one repository-relative glob per line<\/label><textarea[^>]*>node_modules\napps\/\*\/node_modules<\/textarea>/);
  assert.match(html, /Seed exclusions, one repository-relative glob per line<\/label><textarea[^>]*>\*\*\/node_modules\/\.cache<\/textarea>/);
  assert.match(html, /<code>ARTIFACTORY_AUTH_TOKEN<\/code><span class="wt-chip wt-chip-ready">present<\/span><span class="wt-claim-var-where">in the login shell<\/span>/);
  assert.match(html, /<code>NPM_TOKEN<\/code><span class="wt-chip wt-chip-danger">missing<\/span>/);

  assert.match(html, /aria-label="Slot 1 dependencies"[\s\S]*?>current<[\s\S]*?Matches the fetched default branch at <code>ddddddddd<\/code>/);
  assert.match(html, /aria-label="Slot 2 dependencies"[\s\S]*?>stale<[\s\S]*?default branch at <code>eeeeeeeee<\/code> needs different/);
  assert.match(html, /aria-label="Slot 3 dependencies"[\s\S]*?>never installed</);
  assert.match(html, /aria-label="Slot 4 dependencies"[\s\S]*?>installing<[\s\S]*?Step 1 of 2 · <span>[\s\S]*?elapsed<\/span>[\s\S]*?>pnpm install --frozen-lockfile<\/code>/);
  assert.match(html, /aria-label="Slot 5 dependencies"[\s\S]*?>failed<[\s\S]*?Step 1 of 1 exited with code 3\.<\/p>[\s\S]*?>pnpm install<\/code>[\s\S]*?<pre[^>]*>E401 Unauthorized<\/pre>/);
  // Only the installing slot offers Stop, named for its slot.
  assert.match(html, /aria-label="Slot 4 dependencies"[\s\S]*?aria-label="Stop slot 4 dependency claim"[^>]*>Stop<\/button>/);
  assert.equal(html.match(/dependency claim"/g)?.length, 1);
  assert.match(html, /aria-label="Slot 6 dependencies"[\s\S]*?>interrupted<[\s\S]*?a stop during a seed[\s\S]*?removes the seed paths and starts cold/);
  const legacy = html.slice(html.indexOf('aria-label="Slot 7 dependencies"'));
  assert.match(legacy, /^[\s\S]*?>failed<[\s\S]*?<p class="wt-deps-detail">legacy summary line<\/p>/);
  const legacyCard = legacy.slice(0, legacy.indexOf("</section>"));
  assert.doesNotMatch(legacyCard, /Failed command|<pre/, "nothing guessed, no output shown");
  assert.match(legacyCard, /recorded by an earlier version, before claim variable values were\s+redacted from step output, so its output is not shown\./);
  // A failure this build recorded says nothing about withheld output.
  const current = html.slice(html.indexOf('aria-label="Slot 5 dependencies"'));
  assert.doesNotMatch(current.slice(0, current.indexOf("</section>")), /its output is not shown/);
});

test("a pool without a claim shows no slot dependency state and offers to add a step", () => {
  const html = render();
  assert.doesNotMatch(html, /dependencies"/);
  assert.match(html, /No claim is configured\. Add a step to set one up\./);
});

test("Warm is offered on an idle slot and a pool with a claim, and a Warm shows its tail, Cancel, and log", () => {
  const base = overCapacityPool.slots[0]!;
  const claimPool: WorktreeRepositoryView = {
    ...roomToGrowPool,
    status: "attention",
    counts: { ...roomToGrowPool.counts, available: 2 },
    policy: {
      ...roomToGrowPool.policy,
      claim: { steps: [{ argv: ["yarn", "install"], env: [] }], timeoutMinutes: 10, fingerprintPaths: ["yarn.lock"] },
    },
    slots: [
      {
        ...base,
        id: "w1",
        ordinal: 1,
        state: "available",
        owner: null,
        actions: ["destroy", "warm"],
        warmLog: { id: "op-old", path: "/state/logs/worktree-warm/op-old.log" },
      },
      { ...base, id: "w2", ordinal: 2, state: "available", owner: null, actions: ["destroy", "warm"] },
    ],
  };
  const running: WorktreeOperationView = {
    id: "op-warm",
    request: { action: "warm", target: { kind: "pool", poolId: claimPool.id } },
    state: "running",
    targets: [{ provider: "mission", id: "w2", path: "/state/worktrees/pool-2/2/repo" }],
    error: null,
    changed: false,
    removals: [],
    completed: [],
    queuedAt: 1,
    finishedAt: null,
    warm: {
      targets: [
        { slotId: "w2", ordinal: 2, path: "/state/worktrees/pool-2/2/repo", outcome: "running", detail: null },
        { slotId: "w3", ordinal: 3, path: "/state/worktrees/pool-2/3/repo", outcome: "skipped", detail: "the slot is leased" },
      ],
      tail: "$ yarn install\nresolving packages\n",
      truncatedBytes: 0,
      log: { id: "op-warm", path: "/state/logs/worktree-warm/op-warm.log" },
      cancelRequested: false,
    },
  };
  const html = render({ inventory: { ...inventory, repositories: [claimPool] }, operations: [running] });
  assert.match(html, />Warm idle slots</);
  assert.match(html, /aria-label="Warm operations"/);
  assert.match(html, /aria-label="Warm idle slots output"[^>]*>\$ yarn install\nresolving packages</);
  assert.match(html, />Cancel</);
  assert.match(html, /href="\/api\/worktrees\/warm-logs\/op-warm"/);
  assert.match(html, /aria-label="Download the full log of Warm idle slots"/);
  assert.match(html, /skipped<\/span><span>Slot 3/);
  assert.match(html, /the slot is leased/);
  // The slot the Warm holds has a pending operation, so it offers no second Warm; the idle one does.
  const slotOne = html.slice(html.indexOf('aria-label="Slot 1"'), html.indexOf('aria-label="Slot 2"'));
  assert.match(slotOne, />Warm</);
  assert.match(slotOne, /href="\/api\/worktrees\/warm-logs\/op-old"/);
  assert.match(slotOne, />Last Warm log</);
  const slotTwo = html.slice(html.indexOf('aria-label="Slot 2"'));
  assert.match(slotTwo, /warm in progress/);
  assert.doesNotMatch(slotTwo.slice(0, slotTwo.indexOf("</article>")), />Warm<\/button>/);
  // A Warm is not a cleanup, so it is never listed among them.
  assert.doesNotMatch(html, /aria-label="Background cleanup"/);

  const finished = render({
    inventory: { ...inventory, repositories: [claimPool] },
    operations: [{ ...running, state: "finished", finishedAt: 2, warm: { ...running.warm!, cancelRequested: true } }],
  });
  assert.match(finished, />finished</);
  assert.match(finished, />Dismiss</);
  assert.doesNotMatch(finished, />Cancel</);
});
