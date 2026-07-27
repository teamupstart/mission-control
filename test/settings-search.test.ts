import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPage } from "../src/web/components/SettingsPage.tsx";
import { SettingsSearch } from "../src/web/components/SettingsSearch.tsx";
import {
  BINDABLE_CONTROL_IDS,
  SETTINGS_CONTROLS,
  buildSettingsBindings,
  searchSettings,
  type SettingsBindings,
} from "../src/web/lib/settings-search.ts";
import {
  SETTINGS_CATEGORIES,
  type SettingsCategoryId,
} from "../src/web/lib/settings-registry.ts";
import { ACTIONS } from "../src/web/lib/keybindings.ts";
import type { ForemanState } from "../src/web/useForeman.ts";
import type { CostState } from "../src/web/useCost.ts";
import type { LlmState } from "../src/web/useLlm.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

// What is at stake: the palette is the only way to reach a control by half-remembering it,
// and it reaches it by ANCHOR. An index entry whose anchor names a control the page does
// not render is a search hit that jumps to nothing - worse than no hit, because the
// operator believes the setting is gone. So the load-bearing test here is the same one
// Phase 1 pinned for the anchors themselves, run from the other side: every entry in the
// one control-level index points at an anchor the rendered page actually carries.
//
// It is also where the risky-toggle exemption (D5) is held to account: the set of controls
// the page may flip from a result must never include one whose consent copy has to be on
// screen when it changes.

// Owned-by-App states passed to the page. Null is the pre-poll instant, which the panels
// render as disabled controls behind an "unknown" banner - the controls (and their
// anchors) are present, which is exactly what this test needs. Static render runs no
// effects, so nothing fetches.
const FOREMAN: ForemanState = {
  config: null,
  status: null,
  backlogPlan: null,
  update: async () => true,
  error: null,
};
const COST: CostState = { status: null, update: async () => {}, error: null };
const LLM: LlmState = {
  config: null,
  status: null,
  personaDefaults: null,
  update: async () => {},
  error: null,
};

function renderCategory(category: SettingsCategoryId): string {
  return renderToStaticMarkup(
    createElement(SettingsPage, {
      category,
      onNavigate: () => {},
      onLeave: () => {},
      foreman: FOREMAN,
      cost: COST,
      llm: LLM,
      layout: "grid",
      onLayoutChange: () => {},
      settingsStatus: null,
    }),
  );
}

/**
 * Every `data-anchor` the page renders, across all categories - the Phase 1 anchor
 * collection walked from the search side. Only the active category's panel renders, so the
 * whole set is the union over every category.
 */
function renderedAnchors(): Set<string> {
  const anchors = new Set<string>();
  for (const c of SETTINGS_CATEGORIES) {
    for (const m of renderCategory(c.id).matchAll(/data-anchor="([^"]+)"/g)) {
      anchors.add(m[1]!);
    }
  }
  return anchors;
}

test("every control names a category that exists, with a matching anchor prefix", () => {
  const ids = new Set<string>(SETTINGS_CATEGORIES.map((c) => c.id));
  for (const c of SETTINGS_CONTROLS) {
    assert.ok(ids.has(c.category), `${c.id} names missing category "${c.category}"`);
    assert.equal(
      c.anchor.split("/")[0],
      c.category,
      `${c.id}'s anchor "${c.anchor}" is not under its own category`,
    );
  }
});

test("no two controls share an id", () => {
  const seen = new Set<string>();
  for (const c of SETTINGS_CONTROLS) {
    assert.ok(!seen.has(c.id), `duplicate control id "${c.id}"`);
    seen.add(c.id);
  }
});

test("every control's anchor is one the page actually renders", () => {
  const anchors = renderedAnchors();
  for (const c of SETTINGS_CONTROLS) {
    assert.ok(
      anchors.has(c.anchor),
      `control "${c.id}" points at "${c.anchor}", which no panel renders - a jump to nothing`,
    );
  }
});

test("every category has at least one control indexed", () => {
  const covered = new Set(SETTINGS_CONTROLS.map((c) => c.category));
  for (const c of SETTINGS_CATEGORIES) {
    assert.ok(covered.has(c.id), `category "${c.id}" has no searchable control`);
  }
});

// The D5 exemption set: booleans whose consent copy has to be on screen when they change,
// so they always jump to their panel rather than flipping from a search row. YOLO merges
// code and the Inspector's two publish under the operator's GitHub account; Live workflow
// delivery is the local member of the same class - it is what lets Mission Control type a
// repair packet into somebody's running agent session, and the sentence saying so lives in
// the panel it jumps to.
//
// Workflow check commands are the newest member, and the clearest case for the rule: the
// switch authorizes running a command that loads scripts and source from the branch under
// review, with the daemon's own filesystem authority. Flipping that from a one-line search
// row would grant it without the paragraph that explains what was granted ever being read.
test("the risky set is exactly the D5 exemption - YOLO, the Inspector's two, and Workflow's two", () => {
  const risky = SETTINGS_CONTROLS.filter((c) => c.risky).map((c) => c.id).sort();
  assert.deepEqual(risky, [
    "inspector-enabled",
    "inspector-mode",
    "workflow-checks",
    "workflow-live-delivery",
    "yolo",
  ]);
});

test("risky controls never appear in the bindable set - they can only jump", () => {
  for (const c of SETTINGS_CONTROLS) {
    if (c.risky) {
      assert.ok(!BINDABLE_CONTROL_IDS.includes(c.id), `risky "${c.id}" must never be bindable`);
    }
  }
  // And the bindable set is exactly the non-risky toggles: nothing else, so the page can
  // never wire a switch onto a jump or a risky control.
  const expected = SETTINGS_CONTROLS.filter((c) => c.kind === "toggle" && !c.risky).map((c) => c.id);
  assert.deepEqual([...BINDABLE_CONTROL_IDS], expected);
});

test("substring search returns the soak entry for \"soak\" and the Trust entry for \"allowlist\"", () => {
  assert.ok(
    searchSettings("soak").controls.some((c) => c.id === "soak"),
    "\"soak\" should find the soak control",
  );
  assert.ok(
    searchSettings("allowlist").controls.some((c) => c.id === "trust-grants"),
    "\"allowlist\" should find the Trust grant via its keywords",
  );
});

// Workflow settings were a drawer on another page until the migration's last phase: no rail
// row, no anchor, and therefore no way to reach them from here at all. Searching for what
// they DO - the two phrases an operator would actually type - has to land in the workflows
// category, or the move has restored the convention without restoring the discoverability
// that was the point of it.
test("\"retention\" and \"live delivery\" reach the Workflows category", () => {
  const retention = searchSettings("retention");
  assert.ok(
    retention.controls.some((c) => c.id === "workflow-retention"),
    "\"retention\" should find the workflow retention control",
  );
  assert.ok(
    retention.categories.includes("workflows"),
    "\"retention\" should offer the Workflows category as a jump",
  );
  const live = searchSettings("live delivery");
  assert.ok(
    live.controls.some((c) => c.anchor === "workflows/live-delivery"),
    "\"live delivery\" should find the Live delivery switch",
  );
  assert.ok(
    live.categories.includes("workflows"),
    "\"live delivery\" should offer the Workflows category as a jump",
  );
});

test("an empty query previews a handful of controls and no category jumps", () => {
  const { controls, categories } = searchSettings("");
  assert.ok(controls.length > 0 && controls.length <= SETTINGS_CONTROLS.length);
  assert.deepEqual(categories, []);
});

test("a category-name match is offered as a Jump-to hit via its registry keywords", () => {
  // "hotkey" is a Keyboard keyword, so it should surface the category as a jump.
  assert.ok(searchSettings("hotkey").categories.includes("keyboard"));
});

// The Keyboard panel exposes many independently rebindable controls, each with its own
// `keyboard/<id>` anchor, so collapsing them to one index entry would leave a search for a
// specific action (dispatch, kill) landing on the wrong row - or the top of the panel.
// Every shortcut in the ACTIONS registry must have its own index entry on its own anchor.
test("every keyboard shortcut is indexed on its own binding, not collapsed into one", () => {
  for (const a of ACTIONS) {
    const entry = SETTINGS_CONTROLS.find((c) => c.anchor === `keyboard/${a.id}`);
    assert.ok(entry, `no index entry lands on keyboard/${a.id} (${a.label})`);
    assert.equal(entry.category, "keyboard");
  }
});

test("searching a specific action's name lands on that action's binding", () => {
  // The regression the Inspector caught: a query for the action has to reach its own row.
  const dispatch = ACTIONS.find((a) => a.id === "dispatch")!;
  const hits = searchSettings(dispatch.label).controls;
  assert.ok(
    hits.some((c) => c.anchor === "keyboard/dispatch"),
    `"${dispatch.label}" did not surface its own keyboard binding`,
  );
});

// A daemon-backed toggle must not be flippable from the palette before its config has
// loaded: the panels disable the control until the first read, and a pre-poll flip would
// write against an assumed default or no-op on a refused update. `buildSettingsBindings`
// withholds the binding until the source is present, so the control degrades to a jump.
test("daemon-backed toggles get no binding until their config has loaded", () => {
  const noop = () => {};
  const loading = buildSettingsBindings({
    formatMessages: { value: true, set: noop },
    autoMode: null,
    skillsEnabled: null,
    costTrack: null,
  });
  // The browser-local formatting toggle is always bindable (shipped defaults, no poll).
  assert.ok(loading.has("format-messages"));
  // The three daemon-backed toggles are withheld until loaded.
  assert.ok(!loading.has("auto-mode"));
  assert.ok(!loading.has("skills-enabled"));
  assert.ok(!loading.has("cost-track"));

  const loaded = buildSettingsBindings({
    formatMessages: { value: true, set: noop },
    autoMode: { value: false, set: noop },
    skillsEnabled: { value: true, set: noop },
    costTrack: { value: false, set: noop },
  });
  assert.ok(loaded.has("auto-mode"));
  assert.ok(loaded.has("skills-enabled"));
  assert.ok(loaded.has("cost-track"));
  // The switch reads its source's live value, and never binds anything outside the
  // non-risky toggle set.
  assert.equal(loaded.get("auto-mode")!.get(), false);
  assert.equal(loaded.get("skills-enabled")!.get(), true);
  for (const id of loaded.keys()) assert.ok(BINDABLE_CONTROL_IDS.includes(id), `${id} is not bindable`);
});

// ---- the palette component -------------------------------------------------

// Wrapped in a host because the palette is a screen-owning dialog now and routes through
// <Overlay>, which refuses to render without one (see overlay-registry.test.ts). The host
// is inert - static render runs no effects - so this is still purely about what it draws.
function renderPalette(open: boolean, bindings: SettingsBindings = new Map()): string {
  return renderToStaticMarkup(
    withOverlayHost(
      createElement(SettingsSearch, {
        open,
        onClose: () => {},
        onNavigate: () => {},
        bindings,
      }),
    ),
  );
}

test("a closed palette renders nothing", () => {
  assert.equal(renderPalette(false), "");
});

test("an open palette shows a search combobox, its results, and the key hints", () => {
  const html = renderPalette(true);
  // The shared Overlay backdrop is the veil now, and the panel is the dialog on top of it.
  assert.match(html, /class="modal-backdrop"/);
  assert.match(html, /class="pal"[^>]*role="dialog"/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /class="pal-foot"/);
  // The empty-query preview renders real result rows.
  assert.match(html, /Format messages/);
  assert.match(html, /Layout/);
});

test("a bound toggle draws an inline switch; every other hit draws a jump badge", () => {
  // `format-messages` is a non-risky toggle and sits in the empty-query preview. With a
  // binding it is a switch; the jumps and the unbound toggles around it are badges.
  const bound = renderPalette(
    true,
    new Map([["format-messages", { get: () => true, set: () => {} }]]),
  );
  assert.match(bound, /class="pal-switch"/, "the bound toggle should render an inline switch");
  assert.match(bound, /class="pal-badge"/, "the jumps should render an open badge");

  // With no binding, the same toggle degrades to a jump - never a dead switch.
  const unbound = renderPalette(true);
  assert.doesNotMatch(unbound, /class="pal-switch"/);
});
