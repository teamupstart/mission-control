import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessesPanel } from "../src/web/components/HarnessesPanel.tsx";
import type { HarnessesState } from "../src/web/useHarnesses.ts";
import type { HarnessesConfig } from "../src/shared/protocol.ts";
import { AGENT_TYPES } from "../src/shared/types.ts";
import { AGENT_IDENTITY } from "../src/shared/agent.ts";
import { autoModeAgents } from "../src/shared/harness-capabilities.ts";

/** Who the switch reaches, from the same declaration the panel reads. */
const AUTO = autoModeAgents();
const EXCLUDED = AGENT_TYPES.filter((a) => !AUTO.includes(a));

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

/** A full config from the one or two keys a test actually cares about. */
function mkConfig(over: Partial<HarnessesConfig>): HarnessesConfig {
  return {
    autoModeOnDispatch: false,
    defaultModel: { claude: null, codex: null, pi: null },
    defaultEffort: { claude: null, codex: null, pi: null },
    ...over,
  };
}

function render(
  config: Partial<HarnessesConfig> | null,
  over: Partial<HarnessesState> = {},
): string {
  const state = mkState(config ? mkConfig(config) : null, over);
  return renderToStaticMarkup(createElement(HarnessesPanel, { state }));
}

test("the panel scopes the toggle to dispatched sessions before you click anything", () => {
  // The contract the setting promises: it never touches a session you started yourself
  // and the app merely discovered. Said up front, not buried.
  const html = render({ autoModeOnDispatch: false });
  assert.match(html, /dispatches/i);
  assert.match(html, /never touch/i);
});

test("the auto-mode row names exactly the harnesses it reaches", () => {
  // A toggle that silently no-ops on half the fleet is the failure the badge exists to
  // prevent - and the scope is read off `permissionModes.onDispatch`, not written out,
  // so this asserts the PAIR: reached agents named, unreached agents never claimed.
  const html = render({ autoModeOnDispatch: false });
  assert.match(html, new RegExp(`${AUTO.join(" / ")} only`, "i"));
  for (const a of AUTO) assert.match(html, new RegExp(`Every[^<]*${AGENT_IDENTITY[a].label}`));
  for (const a of EXCLUDED) {
    // Named only inside the badge's title, which says why it is left alone - never in
    // the sentence describing what the switch does.
    assert.doesNotMatch(html, new RegExp(`Every[^<]*${AGENT_IDENTITY[a].label}`));
    assert.match(html, new RegExp(`${AGENT_IDENTITY[a].label} has no permission mode`));
  }
});

test("the auto-mode row makes no promise about harnesses it doesn't reach", () => {
  // It used to say "Codex support comes later" - a commitment this panel is in no
  // position to make on a vendor's behalf, and one nothing would ever come back to.
  assert.doesNotMatch(render({ autoModeOnDispatch: false }), /comes later|coming soon/i);
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

// ---- default model rows ----

test("both harnesses get their own default-model row", () => {
  // One row per harness, because a model id is not portable across them - a single
  // shared picker would offer Codex models to Claude.
  const html = render({});
  assert.match(html, /Default model/);
  assert.match(html, /aria-label="Default model for dispatched Claude Code sessions"/);
  assert.match(html, /aria-label="Default model for dispatched Codex sessions"/);
});

test("no default reads as 'the harness decides', not as an empty setting", () => {
  // The shipped state is real and has to describe itself: nothing is passed to the CLI,
  // so the harness's own configured model wins. "Blank" would look like a broken read.
  const html = render({});
  assert.match(html, /Harness default/);
  assert.match(html, /no --model flag/);
});

test("a configured default names the flag the dispatcher will actually pass", () => {
  const html = render({ defaultModel: { claude: "claude-opus-4-8", codex: null, pi: null } });
  assert.match(html, /--model claude-opus-4-8/);
  // Selected, so reopening Settings shows the setting rather than resetting it.
  assert.match(html, /<option value="claude-opus-4-8" selected/);
});

test("a default this build doesn't know is still shown as selected", () => {
  // Set by a newer build or straight at the route. Dropping it would render the select
  // on its empty option - claiming "no default" for a setting that has one, and writing
  // that lie back on the operator's next unrelated edit.
  const html = render({ defaultModel: { claude: "claude-opus-9-9", codex: null, pi: null } });
  assert.match(html, /<option value="claude-opus-9-9" selected/);
  assert.match(html, /not in this build/);
});

test("the model pickers are disabled until the first config read lands", () => {
  // Same race as the switch: a writable select on a config we haven't read yet would
  // patch a default over a value we never saw.
  const html = render(null);
  assert.match(html, /<select[^>]*disabled/);
});

test("both harnesses get a configurable default effort", () => {
  const html = render({ defaultEffort: { claude: "high", codex: "xhigh", pi: null } });
  assert.match(html, /Default effort/);
  assert.match(html, /aria-label="Default effort for dispatched Claude Code sessions"/);
  assert.match(html, /aria-label="Default effort for dispatched Codex sessions"/);
  assert.match(html, /<option value="high" selected/);
  assert.match(html, /<option value="xhigh" selected/);
});
