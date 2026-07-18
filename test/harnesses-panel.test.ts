import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessesPanel } from "../src/web/components/HarnessesPanel.tsx";
import type { HarnessesState } from "../src/web/useHarnesses.ts";
import type { HarnessesConfig } from "../src/shared/protocol.ts";

// The Harnesses settings panel, rendered. Static markup rather than a driven browser:
// the dashboard's SSE stream hangs headless automation, and these are questions about
// words and structure (the same convention as skills-panel / settings-sidebar-render).
//
// What's at stake is that the panel never over-promises the toggle's SCOPE. Auto mode
// on dispatch touches only the sessions the app launches, and does nothing to a codex
// session - a row that says only "auto mode" is claiming more than it delivers.

function mkState(config: HarnessesConfig | null, over: Partial<HarnessesState> = {}): HarnessesState {
  return { config, update: async () => {}, error: null, ...over };
}

function render(config: HarnessesConfig | null, over: Partial<HarnessesState> = {}): string {
  return renderToStaticMarkup(createElement(HarnessesPanel, { state: mkState(config, over) }));
}

test("the panel scopes the toggle to dispatched sessions before you click anything", () => {
  // The contract the setting promises: it never touches a session you started yourself
  // and the app merely discovered. Said up front, not buried.
  const html = render({ autoModeOnDispatch: false });
  assert.match(html, /dispatches/i);
  assert.match(html, /never touch/i);
});

test("the auto-mode row is claude-only", () => {
  // Codex has no permission mode, so the dispatch path skips it. A toggle that silently
  // no-ops on half the fleet is the failure the badge exists to prevent.
  assert.match(render({ autoModeOnDispatch: false }), /claude only/i);
});

test("an enabled setting renders the switch checked", () => {
  assert.match(render({ autoModeOnDispatch: true }), /checked/);
});

test("a disabled setting renders the switch unchecked", () => {
  assert.doesNotMatch(render({ autoModeOnDispatch: false }), /checked/);
});

test("the switch is disabled until the first config read lands", () => {
  // It mounts inside the settings modal, so the first paint happens with config: null.
  // A togglable switch there would race the fetch and could write a value onto defaults
  // it never actually read.
  const html = render(null);
  assert.match(html, /Harnesses/);
  assert.match(html, /<input[^>]*disabled/);
  // Off is the shipped default, so the pre-poll switch reads off, not checked.
  assert.doesNotMatch(html, /checked/);
});

test("a rejected edit says so", () => {
  assert.match(
    render({ autoModeOnDispatch: false }, { error: "That didn't stick: no." }),
    /That didn&#x27;t stick: no\./,
  );
});
