import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShippingSettingsPanel } from "../src/web/components/ShippingSettingsPanel.tsx";
import type { ShippingState } from "../src/web/useShipping.ts";
import type { InspectorConfig } from "../src/shared/protocol.ts";

// What is at stake: the daemon now refuses to merge on an unpublished review, which is
// correct and completely invisible. An operator who armed YOLO mode and sees nothing ever
// merge concludes the feature is broken and turns it off - so the panel has to name which
// of the Inspector's three switches is withholding consent. These tests are the only
// thing standing between "safe" and "safe and silent".
//
// Rendered as static markup rather than driven in a browser, for the same reason as
// settings-sidebar-render: the dashboard holds an SSE connection open and hangs headless
// automation. Effects never run here, so nothing fetches.

const SHIPPING: ShippingState = {
  config: {
    autoMerge: true,
    soakMinutes: 5,
    method: "squash",
    repoAllowlist: ["/repo"],
    closeSessionAfterMerge: false,
  },
  inspections: [],
  update: async () => true,
  error: null,
};

type Posture = Pick<InspectorConfig, "enabled" | "mode" | "repoAllowlist">;

function render(inspectorConfig: Posture | null, state: ShippingState = SHIPPING): string {
  return renderToStaticMarkup(
    createElement(ShippingSettingsPanel, { state, inspectorConfig, onNavigate: () => {} }),
  );
}

test("GitHub Inspector switched off is named", () => {
  const html = render({ enabled: false, mode: "dry-run", repoAllowlist: [] });
  assert.match(html, /GitHub Inspector is switched off/);
});

// The regression's own warning. This state used to merge silently; now it merges nothing,
// and an operator with no way to tell those apart is back where they started.
test("dry run is named, and says merging is what it is stopping", () => {
  const html = render({ enabled: true, mode: "dry-run", repoAllowlist: ["/repo"] });
  assert.match(html, /dry run/i);
  assert.match(html, /will not merge/i);
  assert.doesNotMatch(html, /GitHub Inspector is switched off/, "the wrong switch would be named");
});

test("a repo missing from the INSPECTOR's allowlist is named, by path", () => {
  const html = render({ enabled: true, mode: "live", repoAllowlist: [] });
  assert.match(html, /not allowed to review/i);
  assert.match(html, /\/repo/);
});

// R11: the three warnings became navigations, not prose. Each still says what is wrong (the
// text above pins that); this pins that each now carries a real control to act on, and the
// two Inspector-posture ones point at the Inspector while the untrusted-repo one points at
// Trust (where the fix - grant the review, or revoke the merge - actually lives).
test("the GitHub Inspector-off and dry-run warnings carry a link, the untrusted one a Trust link", () => {
  const off = render({ enabled: false, mode: "dry-run", repoAllowlist: [] });
  assert.match(off, /class="settings-link"[^>]*>Turn it on in GitHub Inspector/);

  const dry = render({ enabled: true, mode: "dry-run", repoAllowlist: ["/repo"] });
  assert.match(dry, /class="settings-link"[^>]*>Set it to live in GitHub Inspector/);

  const untrusted = render({ enabled: true, mode: "live", repoAllowlist: [] });
  assert.match(untrusted, /class="settings-link"[^>]*>Fix in Trust/);
});

// The merge-repos editor moved to Trust; the panel summarizes the grant and links there.
test("the merge-repos section is a grant count that deep-links to Trust, not an editor", () => {
  const html = render({ enabled: true, mode: "live", repoAllowlist: ["/repo"] });
  assert.match(html, /YOLO may merge in 1 repository\b/);
  assert.match(html, /Manage in Trust/);
  assert.doesNotMatch(html, /placeholder="search repos or type a path…"/);
  assert.doesNotMatch(html, /aria-label="Stop auto-merging/);
});

test("fully on and trusted: no warning about GitHub Inspector at all", () => {
  const html = render({ enabled: true, mode: "live", repoAllowlist: ["/repo"] });
  assert.doesNotMatch(html, /GitHub Inspector is switched off/);
  assert.doesNotMatch(html, /dry run/i);
  assert.doesNotMatch(html, /not allowed to review/i);
});

test("after-merge wording promises completion before closing, never a Kill outcome", () => {
  const html = render({ enabled: true, mode: "live", repoAllowlist: ["/repo"] });
  assert.match(html, /Complete the task, then close its session/);
  assert.match(html, /never gives the task Kill/);
  assert.doesNotMatch(html, /Kill the agent once/);
});

// A worktree of a trusted repo is trusted everywhere else in the app; a warning that did
// not use the shared predicate would cry wolf on every pooled checkout.
test("the warning uses the shared allowlist rule, so a parent trusts its worktrees", () => {
  const state: ShippingState = {
    ...SHIPPING,
    config: { ...SHIPPING.config!, repoAllowlist: ["/repo/wt-3"] },
  };
  const html = render({ enabled: true, mode: "live", repoAllowlist: ["/repo"] }, state);
  assert.doesNotMatch(html, /not allowed to review/i);
});

// Null is "the daemon is unreachable", which is not evidence the Inspector is off. Warning
// there would tell an operator to go and switch on something that may already be on.
test("an unreachable daemon warns about reachability, not about GitHub Inspector", () => {
  const html = render(null, { ...SHIPPING, config: null });
  assert.doesNotMatch(html, /GitHub Inspector is switched off/);
  // Apostrophes render escaped, so match around one rather than through it.
  assert.match(html, /reach the daemon/);
});

// With YOLO mode disarmed none of this is a problem yet, and a settings page that warns
// about a feature the operator has not turned on trains them to ignore warnings.
test("nothing is warned about while YOLO mode is off", () => {
  const disarmed: ShippingState = {
    ...SHIPPING,
    config: { ...SHIPPING.config!, autoMerge: false },
  };
  const html = render({ enabled: false, mode: "dry-run", repoAllowlist: [] }, disarmed);
  assert.doesNotMatch(html, /GitHub Inspector is switched off/);
});

// Raised by the Inspector on this change: the Prerequisites card was gated on
// `anyBlocker || inspectorConfig !== null`, so a healthy armed install drew the card with a
// green all-clear in it - while the comment directly above that line said the card exists
// only for genuinely unmet prerequisites. The code and its own stated contract disagreed;
// the contract won. A checklist of green ticks that is always on screen is one nobody reads
// on the day a tick turns red.
test("with every prerequisite met, the Prerequisites card is not drawn at all", () => {
  const html = render({ enabled: true, mode: "live", repoAllowlist: ["/repo"] });
  assert.doesNotMatch(html, /Prerequisites/);
  assert.doesNotMatch(html, /Everything this depends on is in place/);
});

// The other half of the same rule: it IS drawn the moment something is genuinely unmet.
test("an unmet prerequisite still draws the card, with the fix beside it", () => {
  const html = render({ enabled: false, mode: "dry-run", repoAllowlist: [] });
  assert.match(html, /Prerequisites/);
  assert.match(html, /class="settings-link"[^>]*>Turn it on in GitHub Inspector/);
});
