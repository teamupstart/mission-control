import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorktreeSettingsPanel } from "../src/web/components/WorktreeSettingsPanel.tsx";
import type { WorktreesState } from "../src/web/useWorktrees.ts";

const noop = async () => {};
const state: WorktreesState = {
  inventory: {
    config: { enabled: true, maxSlots: 16, repositories: { "/repo/mission-control/.git": { maxSlots: 1, setupArgv: ["npm", "install"] } } },
    observedAt: 1,
    revision: "a".repeat(64),
    repositories: [{
      id: "pool-1",
      name: "mission-control",
      root: "/repo/mission-control",
      commonDirectory: "/repo/mission-control/.git",
      poolPath: "/state/worktrees/pool-1",
      policy: { enabled: true, maxSlots: 1, setupArgv: ["npm", "install"] },
      counts: { total: 2, leased: 1, available: 0, quarantined: 1, overCapacity: 1 },
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
    }],
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
  },
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

test("the panel renders policy, native lifecycle, exact path actions, and legacy remediation", () => {
  const html = renderToStaticMarkup(createElement(WorktreeSettingsPanel, { state }));
  assert.match(html, /data-anchor="worktrees\/policy"/);
  assert.match(html, /data-anchor="worktrees\/native-pools"/);
  assert.match(html, /data-anchor="worktrees\/legacy-drain"/);
  assert.match(html, /over capacity/);
  assert.match(html, /Destroy fixed pool set/);
  assert.match(html, /Terminal backend for slot 1/);
  assert.match(html, /Use global defaults/);
  assert.match(html, /Treehouse status cannot provide stable lease identity/);
  assert.doesNotMatch(html, /Force/);
});
