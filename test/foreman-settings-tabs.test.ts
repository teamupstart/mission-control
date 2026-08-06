import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ForemanSettingsPanel } from "../src/web/components/ForemanSettingsPanel.tsx";
import {
  FOREMAN_SETTINGS_TABS,
  foremanTabForAnchor,
} from "../src/web/lib/foreman-settings-tabs.ts";
import { SETTINGS_CONTROLS } from "../src/web/lib/settings-search.ts";
import type { ForemanState } from "../src/web/useForeman.ts";

const OUTSIDE_TABS = new Set([
  "foreman/live-repos",
  "foreman/health",
  "foreman/episodes",
]);

function renderedAnchors(): Set<string> {
  const state: ForemanState = {
    config: null,
    status: null,
    backlogPlan: null,
    episodes: [],
    update: async () => true,
    error: null,
  };
  const html = renderToStaticMarkup(
    createElement(ForemanSettingsPanel, { state, onNavigate: () => {} }),
  );
  return new Set([...html.matchAll(/data-anchor="([^"]+)"/g)].map((match) => match[1]!));
}

test("every grouped Foreman anchor has exactly one owner", () => {
  const seen = new Set<string>();
  for (const group of FOREMAN_SETTINGS_TABS) {
    for (const anchor of group.anchors) {
      assert.ok(!seen.has(anchor), `${anchor} appears in more than one Foreman tab`);
      seen.add(anchor);
      assert.equal(foremanTabForAnchor(anchor), group.id);
    }
  }
});

test("the group table and the panel's rendered anchors cannot drift", () => {
  const rendered = renderedAnchors();
  for (const group of FOREMAN_SETTINGS_TABS) {
    for (const anchor of group.anchors) {
      assert.ok(rendered.has(anchor), `${anchor} is grouped but no longer rendered`);
    }
  }
  for (const anchor of rendered) {
    assert.ok(
      foremanTabForAnchor(anchor) !== null || OUTSIDE_TABS.has(anchor),
      `${anchor} renders without a tab owner or deliberate outside placement`,
    );
  }
});

test("every searchable Foreman control resolves to a tab or a deliberate outsider", () => {
  for (const control of SETTINGS_CONTROLS.filter((candidate) => candidate.category === "foreman")) {
    assert.ok(
      foremanTabForAnchor(control.anchor) !== null || OUTSIDE_TABS.has(control.anchor),
      `${control.id} points at ${control.anchor}, which cannot select a Foreman tab`,
    );
  }
});

test("the read-only and ledger anchors stay outside the configuration tabs", () => {
  for (const anchor of OUTSIDE_TABS) assert.equal(foremanTabForAnchor(anchor), null);
});
