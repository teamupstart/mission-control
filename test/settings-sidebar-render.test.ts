import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsModal, SETTINGS_CATEGORIES } from "../src/web/components/SettingsModal.tsx";
import type { SettingsCategoryId } from "../src/web/components/SettingsModal.tsx";
import { LAYOUTS } from "../src/web/lib/layout.ts";
import type { ForemanState } from "../src/web/useForeman.ts";
import type { CostState } from "../src/web/useCost.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

// Rendered rather than driven through a browser: the dashboard's SSE stream holds the
// connection open, which hangs headless automation (same reason as plan-decisions-render).
// Static markup is enough to prove the two-pane structure - the rail lists every category,
// and the active category selects which panel renders - since the only thing a click does
// is set `active`, which we exercise here through the initialCategory prop.

// Foreman config is owned by App and passed in; null config is the pre-poll state, which
// renders the panel's defaults. Static render never runs effects, so nothing fetches.
const FOREMAN: ForemanState = { config: null, status: null, backlogPlan: null, update: async () => {}, error: null };

// Cost is owned by App and passed in for the same reason as Foreman - the topbar strip
// reads the same view setting. A null status is the pre-poll state, which renders the
// panel's shipped defaults with its controls disabled.
const COST: CostState = { status: null, update: async () => {}, error: null };

// The layout is owned by App too, for the same reason as Foreman: the dashboard behind the
// modal renders it, so the panel only edits what it's handed.
function render(initialCategory?: SettingsCategoryId): string {
  // Wrapped in a host because the modal is an <Overlay>, and an overlay outside a host
  // refuses to render - being counted as open is not optional. See helpers/overlay-host.
  return renderToStaticMarkup(
    withOverlayHost(
      createElement(SettingsModal, {
        onClose: () => {},
        foreman: FOREMAN,
        cost: COST,
        layout: "grid",
        onLayoutChange: () => {},
        initialCategory,
      }),
    ),
  );
}

// Distinctive text that appears ONLY inside a given panel (not in the nav), so matching it
// proves that panel is the one rendered.
const KEYBOARD_ONLY = /Anywhere/; // a keyboard action group label
const SKILLS_ONLY = /Enable Mission Control skills/; // the skills master toggle
const LAYOUT_ONLY = /Dashboard layout/; // the picker's radiogroup label
const HARNESSES_ONLY = /Auto mode on dispatch/; // the harnesses toggle label
const APPEARANCE_ONLY = /Format messages/; // the rich-text toggle label
const COST_ONLY = /Track Claude estimated cost/; // the telemetry master toggle label
const INSPECTOR_ONLY = /Run the Inspector/; // the inspector master toggle label
const SHIPPING_ONLY = /YOLO mode - merge/; // the auto-merge master toggle label
const TASK_SOURCES_ONLY = /never dispatches an agent/; // the task-sources safety sentence
const MODELS_ONLY = /Background jobs/; // the LLM panel's per-job group label

test("the rail lists every category exactly once", () => {
  const html = render();
  const items = html.match(/class="settings-nav-item/g) ?? [];
  assert.equal(items.length, SETTINGS_CATEGORIES.length);
  for (const c of SETTINGS_CATEGORIES) assert.ok(html.includes(c.label), `nav missing ${c.label}`);
});

test("opens on Keyboard by default: keyboard panel shows, skills panel does not", () => {
  const html = render();
  assert.match(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, SKILLS_ONLY);
  // The active item is Keyboard, not Skills.
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>⌨<\/span>Keyboard/);
});

test("Layout is a category of its own: its panel shows, the others don't", () => {
  const html = render("layout");
  assert.match(html, LAYOUT_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, SKILLS_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>▦<\/span>Layout/);
});

test("the layout picker offers every layout, with the live one checked", () => {
  const html = render("layout");
  // Every shipped layout is on offer...
  for (const l of LAYOUTS) assert.ok(html.includes(l.label), `picker missing ${l.label}`);
  // ...and the one App handed us is the checked radio, not a local guess. Rendering the
  // panel against `layout: "grid"` must not leave a different mode selected - that is the
  // bug where the picker and the dashboard behind it disagree about what you're in.
  // (React emits `checked=""` BEFORE `value`, so the attributes are matched in that order.)
  const inputs = html.match(/<input[^>]*>/g) ?? [];
  const checked = inputs.filter((i) => i.includes("checked"));
  assert.equal(inputs.length, LAYOUTS.length, "one radio per layout");
  assert.equal(checked.length, 1, "exactly one layout is checked");
  assert.match(checked[0]!, /value="grid"/);
});

test("the layout panel is absent from every other category", () => {
  for (const id of ["keyboard", "skills", "harnesses", "foreman", "appearance", "cost"] as const) {
    assert.doesNotMatch(render(id), LAYOUT_ONLY, `layout picker leaked into ${id}`);
  }
});

test("Appearance is a category of its own: its panel shows, the others don't", () => {
  const html = render("appearance");
  assert.match(html, APPEARANCE_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, LAYOUT_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>◐<\/span>Appearance/);
});

test("message formatting is on unless it has been turned off", () => {
  // `render` mounts the modal with no daemon and no storage, so the shared config store
  // holds the shipped defaults. What this pins is that default reaching the control: the
  // panel shows a checked box, not an unchecked one or no box at all. It says nothing
  // about what the daemon or the cache hold; those paths are ui-config-*.test.ts.
  const html = render("appearance");
  const toggle = (html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [])[0];
  assert.ok(toggle, "the appearance panel has a checkbox");
  assert.match(toggle, /checked/);
});

test("Harnesses is a category of its own: its panel shows, the others don't", () => {
  const html = render("harnesses");
  assert.match(html, HARNESSES_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, SKILLS_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>⚙<\/span>Harnesses/);
});

// Task sources is the category that lets something CREATE work without a human typing it,
// so reachability matters for the same reason the Inspector's does: a panel that silently
// fails to render is one whose sources nobody can see, switch off, or read the errors of,
// while the daemon goes on sweeping whatever was last stored.
test("Task sources is a category of its own: its panel shows, the others don't", () => {
  const html = render("task-sources");
  assert.match(html, TASK_SOURCES_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, HARNESSES_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>⇊<\/span>Task sources/);
});

// Models is the category that decides which provider does the app's own offline work and on
// which model. A panel that fails to render leaves that unanswerable from inside the app -
// which is the exact state this whole surface exists to end: three hardcoded model ids that
// nothing surfaced anywhere.
test("Models is a category of its own: its panel shows, the others don't", () => {
  const html = render("models");
  assert.match(html, MODELS_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, TASK_SOURCES_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>◈<\/span>Models/);
});

// A static render runs no effects, so this is the pre-poll state - the state a first-run
// user sees. It must not draw an empty list, which asserts that nothing is being swept.
test("with no answer from the daemon, the Task sources panel says so rather than showing an empty list", () => {
  const html = render("task-sources");
  assert.match(html, /ts-unknown/);
  assert.match(html, /is unknown/);
  assert.doesNotMatch(
    html,
    /No sources yet - nothing is being swept/,
    "an unanswered panel must not assert an empty list",
  );
});

test("Cost is a category of its own: its panel shows, the others don't", () => {
  const html = render("cost");
  assert.match(html, COST_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, HARNESSES_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>\$<\/span>Cost/);
});

test("the cost panel says every number is an estimate", () => {
  // The one thing this panel must never stop saying. Anthropic's own docs are explicit
  // that the client-side figure can differ from billing, and on a subscription the
  // dollars are notional entirely - a panel that dropped the word would be presenting a
  // guess as a bill.
  const html = render("cost");
  assert.match(html, /estimate/i);
  assert.match(html, /Standard API rates/);
  assert.match(html, /not Pro, Max, or ChatGPT plan spend/);
});

test("the cost panel's controls are disabled until the first read lands", () => {
  // `status` is null here (static render runs no effects), which is the pre-poll instant.
  // A live-looking toggle in that window would let a click race the fetch and write a
  // config built on defaults the daemon never sent.
  const html = render("cost");
  for (const control of html.match(/<(input|select)[^>]*>/g) ?? []) {
    assert.match(control, /disabled/, `cost control should be disabled pre-poll: ${control}`);
  }
});

test("initialCategory swaps the panel: skills shows, keyboard does not", () => {
  const html = render("skills");
  assert.match(html, SKILLS_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  // The active item moved to Skills.
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>✦<\/span>Skills/);
});

test("exactly one category is active at a time", () => {
  assert.equal((render().match(/settings-nav-item is-active/g) ?? []).length, 1);
  assert.equal((render("skills").match(/settings-nav-item is-active/g) ?? []).length, 1);
});

// The rail is a tab set, not navigation: buttons swap which panel renders beside them,
// so assistive tech should hear "tab 1 of 2, selected", not "current page".
test("the rail is a vertical tablist of tabs", () => {
  const html = render();
  assert.match(html, /role="tablist"[^>]*aria-orientation="vertical"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, SETTINGS_CATEGORIES.length);
  assert.doesNotMatch(html, /aria-current/);
});

test("aria-selected tracks the active category, and only it", () => {
  for (const active of SETTINGS_CATEGORIES) {
    const html = render(active.id);
    assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
    assert.equal(
      (html.match(/aria-selected="false"/g) ?? []).length,
      SETTINGS_CATEGORIES.length - 1,
    );
    // The selected tab is the active one - same button that carries `is-active`.
    assert.match(
      html,
      new RegExp(`class="settings-nav-item is-active" role="tab" aria-selected="true"`),
    );
  }
});

// Roving tabindex: the rail is one Tab stop, and arrows (not Tab) move within it.
test("only the active tab is in the tab order", () => {
  for (const active of SETTINGS_CATEGORIES) {
    const html = render(active.id);
    assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1);
    assert.equal((html.match(/tabindex="-1"/g) ?? []).length, SETTINGS_CATEGORIES.length - 1);
    assert.match(html, /class="settings-nav-item is-active"[^>]*tabindex="0"/);
  }
});

test("the pane is a tabpanel labelled by the active tab", () => {
  for (const active of SETTINGS_CATEGORIES) {
    const html = render(active.id);
    assert.match(
      html,
      new RegExp(`class="settings-pane" role="tabpanel" aria-labelledby="settings-tab-${active.id}"`),
    );
    // That label points at a tab that actually exists in the rail.
    assert.match(html, new RegExp(`id="settings-tab-${active.id}"`));
  }
});

// The Inspector is the only category whose switches cause something to be PUBLISHED, so
// "is its panel reachable" is a slightly bigger question here than for the others: a
// category that silently fails to render is one whose live/dry-run state nobody can see
// or change, while the daemon goes on acting on whatever was last stored.
test("Inspector is a category of its own: its panel shows, the others don't", () => {
  const html = render("inspector");
  assert.match(html, INSPECTOR_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, SKILLS_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>⌕<\/span>Inspector/);
});

// Ships off, and ships not-live. A static render runs no effects, so this is the
// pre-poll state - which is exactly the state a first-run user sees, and it must not
// show a mode that would post anything.
test("the Inspector panel's defaults are the off position", () => {
  const html = render("inspector");
  // No checked master toggle, and no live-mode warning banner.
  assert.doesNotMatch(html, /inspector-live-warn/);
  assert.match(html, /Dry run - review and record findings, post nothing/);
});

// The same pre-poll render, from the other direction. Those defaults are the SAFE
// posture, and presenting them as the daemon's answer is how an operator reads "off, dry
// run, no repos" as fact while the stored config is enabled and live and the daemon is
// merely restarting. Disabled inputs are not a statement about what is running.
test("with no answer from the daemon, the Inspector panel says so rather than showing defaults as fact", () => {
  const html = render("inspector");
  assert.match(html, /inspector-unknown/);
  assert.match(html, /is unknown/);
  assert.doesNotMatch(
    html,
    /No repos yet - the Inspector won't post anywhere/,
    "an unanswered panel must not assert an empty allowlist",
  );
});

// Shipping is the only category whose switch MERGES code, so reachability matters here
// for a sharper version of the Inspector's reason: a panel that silently fails to render
// is one whose armed/disarmed state nobody can see or change, while the daemon goes on
// landing pull requests on whatever was last stored.
test("Shipping is a category of its own: its panel shows, the others don't", () => {
  const html = render("shipping");
  assert.match(html, SHIPPING_ONLY);
  assert.doesNotMatch(html, INSPECTOR_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>⚑<\/span>Shipping/);
});

// Ships disarmed, with the documented soak. A static render runs no effects, so this is
// the pre-poll state - the state a first-run user sees - and it must not show a config
// that would merge anything.
test("the Shipping panel's defaults are the off position, with a ten minute soak", () => {
  const html = render("shipping");
  assert.doesNotMatch(html, /ship-live-warn/, "an unarmed panel must not fly the merge warning");
  const toggle = (html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [])[0];
  assert.ok(toggle, "the shipping panel has a master toggle");
  assert.doesNotMatch(toggle, /checked/);
  assert.match(html, /value="10"/, "the soak field shows the shipped ten minutes");
});

// Same rule as the Inspector's: the fallbacks this panel draws pre-poll are the OFF
// posture, and presenting them as the daemon's answer is how an operator reads "nothing
// is merging" as fact while the stored config is armed and the daemon is merely
// restarting. Disabled inputs are not a statement about what is running.
test("with no answer from the daemon, the Shipping panel says so rather than showing defaults as fact", () => {
  const html = render("shipping");
  assert.match(html, /ship-unknown/);
  assert.match(html, /is unknown/);
  assert.doesNotMatch(
    html,
    /No repos yet - nothing will merge itself anywhere/,
    "an unanswered panel must not assert an empty allowlist",
  );
});
