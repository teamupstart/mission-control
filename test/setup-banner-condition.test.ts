import assert from "node:assert/strict";
import test from "node:test";

import {
  dismissSetupBanner,
  pruneSetupBannerDismissal,
  setupBannerView,
} from "../src/shared/setup-banner.ts";
import type {
  SetupBannerDismissal,
  SetupRequirement,
  SetupRowId,
  SetupRowView,
  SetupStatus,
} from "../src/shared/setup-catalog.ts";

const VIRGIN: SetupBannerDismissal = {
  firstLaunchAcknowledged: false,
  acknowledged: [],
};
const ACKNOWLEDGED: SetupBannerDismissal = {
  firstLaunchAcknowledged: true,
  acknowledged: [],
};

function row(
  rowId: SetupRowId,
  requirement: SetupRequirement,
  status: SetupStatus,
): SetupRowView {
  return {
    rowId,
    label: rowId.id,
    family: rowId.source === "derived" ? "terminals" : "github",
    requirement,
    enables: "Test capability.",
    remedy: { kind: "link", url: "https://example.test", label: "Open guide" },
    status,
  };
}

const GH_CLI: SetupRowId = { source: "dependency", id: "gh-cli" };
const GH_AUTH: SetupRowId = { source: "dependency", id: "gh-auth" };
const TERMINAL_PAIR: SetupRowId = { source: "derived", id: "terminal-pair" };

test("first launch shows once even when every required row is ready", () => {
  const rows = [row(GH_CLI, "required", { state: "satisfied", evidence: "/tools/gh" })];
  assert.equal(setupBannerView(rows, VIRGIN).visible, true);

  const dismissed = dismissSetupBanner(rows, VIRGIN);
  assert.deepEqual(dismissed, { firstLaunchAcknowledged: true, acknowledged: [] });
  assert.equal(setupBannerView(rows, dismissed).visible, false);
});

test("dismissing an already-broken machine writes both record parts and hides immediately", () => {
  const rows = [row(GH_CLI, "required", { state: "missing" })];
  const dismissed = dismissSetupBanner(rows, VIRGIN);

  assert.deepEqual(dismissed, {
    firstLaunchAcknowledged: true,
    acknowledged: [GH_CLI],
  });
  assert.equal(setupBannerView(rows, dismissed).visible, false);
});

test("required derived and needs-setup rows alert, while optional and unknown rows do not", () => {
  const optional = row(
    { source: "dependency", id: "ghostty" },
    "optional",
    { state: "missing" },
  );
  assert.equal(setupBannerView([optional], ACKNOWLEDGED).visible, false);

  const derived = row(TERMINAL_PAIR, "required", { state: "missing" });
  assert.deepEqual(setupBannerView([optional, derived], ACKNOWLEDGED), {
    visible: true,
    attentionRowIds: [TERMINAL_PAIR],
    attentionCount: 1,
  });

  const needsSetup = row(GH_AUTH, "required", {
    state: "needs-setup",
    why: "Authenticate first.",
    evidence: "/tools/gh",
  });
  assert.equal(setupBannerView([needsSetup], ACKNOWLEDGED).visible, true);

  const unknown = row(GH_AUTH, "required", {
    state: "unknown",
    why: "The check timed out.",
    evidence: null,
  });
  assert.deepEqual(setupBannerView([unknown], ACKNOWLEDGED), {
    visible: false,
    attentionRowIds: [],
    attentionCount: 0,
  });
});

test("repair retires an acknowledgement so a later regression raises the banner again", () => {
  const broken = [row(TERMINAL_PAIR, "required", { state: "missing" })];
  const dismissed = dismissSetupBanner(broken, VIRGIN);
  assert.equal(setupBannerView(broken, dismissed).visible, false);

  const unchanged = pruneSetupBannerDismissal(broken, dismissed);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.dismissal, dismissed, "a no-op prune preserves identity for no-write callers");

  const repaired = [row(TERMINAL_PAIR, "required", {
    state: "satisfied",
    evidence: "cmux: New workspace.",
  })];
  const pruned = pruneSetupBannerDismissal(repaired, dismissed);
  assert.equal(pruned.changed, true);
  assert.deepEqual(pruned.dismissal.acknowledged, []);

  assert.equal(setupBannerView(broken, pruned.dismissal).visible, true);
});

test("repairing one row leaves another broken row acknowledged rather than re-alerting", () => {
  const broken = [
    row(GH_CLI, "required", { state: "missing" }),
    row(GH_AUTH, "required", {
      state: "needs-setup",
      why: "Authenticate first.",
      evidence: "/tools/gh",
    }),
  ];
  const dismissed = dismissSetupBanner(broken, VIRGIN);
  const afterRepair = [
    row(GH_CLI, "required", { state: "satisfied", evidence: "/tools/gh" }),
    broken[1]!,
  ];
  const pruned = pruneSetupBannerDismissal(afterRepair, dismissed);

  assert.deepEqual(pruned.dismissal.acknowledged, [GH_AUTH]);
  assert.equal(setupBannerView(afterRepair, pruned.dismissal).visible, false);
});

test("a folded row that disappears is retired from the acknowledgement record", () => {
  const environment: SetupRowId = {
    source: "environment-check",
    id: "upstartclaw-core-setup",
  };
  const dismissal: SetupBannerDismissal = {
    firstLaunchAcknowledged: true,
    acknowledged: [environment],
  };
  assert.deepEqual(pruneSetupBannerDismissal([], dismissal), {
    dismissal: { firstLaunchAcknowledged: true, acknowledged: [] },
    changed: true,
  });
});
