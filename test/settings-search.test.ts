import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPage } from "../src/web/components/SettingsPage.tsx";
import { SettingsSearch } from "../src/web/components/SettingsSearch.tsx";
import {
  BINDABLE_CONTROL_IDS,
  SETTINGS_CONTROLS,
  searchSettings,
  type SettingsBindings,
} from "../src/web/lib/settings-search.ts";
import {
  SETTINGS_CATEGORIES,
  type SettingsCategoryId,
} from "../src/web/lib/settings-registry.ts";
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

test("the risky set is exactly the D5 exemption - YOLO and the Inspector's enable and mode", () => {
  const risky = SETTINGS_CONTROLS.filter((c) => c.risky).map((c) => c.id).sort();
  assert.deepEqual(risky, ["inspector-enabled", "inspector-mode", "yolo"]);
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

test("an empty query previews a handful of controls and no category jumps", () => {
  const { controls, categories } = searchSettings("");
  assert.ok(controls.length > 0 && controls.length <= SETTINGS_CONTROLS.length);
  assert.deepEqual(categories, []);
});

test("a category-name match is offered as a Jump-to hit via its registry keywords", () => {
  // "hotkey" is a Keyboard keyword, not a control label, so it should surface the category.
  assert.ok(searchSettings("hotkey").categories.includes("keyboard"));
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
