import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPage } from "../src/web/components/SettingsPage.tsx";
import {
  BINDABLE_CONTROL_IDS,
  SETTINGS_CONTROLS,
  buildSettingsBindings,
} from "../src/web/lib/settings-search.ts";
import {
  SETTINGS_CATEGORIES,
  type SettingsCategoryId,
} from "../src/web/lib/settings-registry.ts";
import { ACTIONS } from "../src/web/lib/keybindings.ts";
import type { ForemanState } from "../src/web/useForeman.ts";
import type { CostState } from "../src/web/useCost.ts";
import type { LlmState } from "../src/web/useLlm.ts";
import type { SettingsStatus } from "../src/shared/types.ts";

// What is at stake: the palette is the only way to reach a control by half-remembering it,
// and it reaches it by ANCHOR. An index entry whose anchor names a control the page does
// not render is a search hit that jumps to nothing - worse than no hit, because the
// operator believes the setting is gone. So the load-bearing test here is the same one
// Phase 1 pinned for the anchors themselves, run from the other side: every entry in the
// one control-level index points at an anchor the rendered page actually carries.
//
// This file is the INDEX. What the ⌘K palette draws over it - the provider registry, the
// grouped rows, the kind chips - is `palette-index.test.ts` and `palette-render.test.ts`.
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
  episodes: [],
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

/**
 * A status with every conditional category AVAILABLE.
 *
 * This file asks whether the panel that owns an anchor renders it - a question about the
 * panels, not about which of them a particular operator has. Rendering with `null` here
 * would silently exclude every conditional category from the sweeps below, so a control
 * pointing at an anchor no panel renders would pass for the wrong reason.
 * `settings-sidebar-render.test.ts` is where availability itself is pinned.
 */
const EVERY_CATEGORY: SettingsStatus = {
  inspector: { enabled: false, mode: "dry-run" },
  shipping: { autoMerge: false },
  taskSources: { failing: 0 },
  pipelines: { present: true, observing: 0 },
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
      layout: "console",
      onLayoutChange: () => {},
      settingsStatus: EVERY_CATEGORY,
      onStartSeeWorkTour: () => {},
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

// The Conversation rendering picker, named on its own rather than left to the sweeps above.
//
// The sweeps are the reason this index holds together, but each of them only asks its
// question of whatever happens to be in the array: a control that was never added passes
// every one of them by not existing. This is the other half - that this particular control
// IS in the index, points where it says it points, and behaves as the kind it declares -
// and it is the shape a new control should copy.
test("the Conversation rendering picker is indexed under Display, anchored at the panel that draws it", () => {
  const control = SETTINGS_CONTROLS.find((c) => c.id === "conversation-view");
  assert.ok(control, "the Conversation rendering picker is not in the search index at all");
  assert.equal(control.category, "display");
  assert.equal(control.anchor, "display/conversation-view");
  // Anchored at a control the DISPLAY panel renders, specifically. The sweep above proves
  // every anchor is rendered by some category; this proves the jump lands on the page the
  // row promises, which is the failure a union over all categories cannot see.
  assert.match(renderCategory("display"), /data-anchor="display\/conversation-view"/);
});

test("the Conversation rendering picker jumps, because a picker has nothing to flip", () => {
  const control = SETTINGS_CONTROLS.find((c) => c.id === "conversation-view")!;
  // `toggle` is for a boolean the palette can flip in place. This is a choice between named
  // renderings, so there is no "on" to set from a search row - and declaring it a toggle
  // would draw a switch whose state means nothing.
  assert.equal(control.kind, "jump");
  assert.ok(!control.risky, "a display preference is not consent-gated");
  assert.ok(
    !BINDABLE_CONTROL_IDS.includes("conversation-view"),
    "a jump must never be handed a binding - that is what makes it a jump",
  );
});

test("the Conversation rendering is reachable by the words someone would half-remember", () => {
  const control = SETTINGS_CONTROLS.find((c) => c.id === "conversation-view")!;
  // The palette matches over the row's title, detail and keywords, so what this pins is
  // that the INDEX carries the vocabulary - that the operator who wants this setting can
  // arrive from either side of the choice, and from the words the feature is described
  // with rather than only its label. How the matcher walks that text is palette-index's
  // own test; what it has to walk is this.
  const searchable = [control.label, control.description, ...control.keywords]
    .join(" ")
    .toLowerCase();
  // Spelled out rather than looped from `control.keywords`, which would pass whatever that
  // array happened to hold - the keywords ARE most of the haystack, so reading them back
  // out of it asserts nothing.
  //
  // What this loop guards is that each word REACHES the control, by whichever field carries
  // it. That is the operator-facing property, and it is narrower than "the keywords contain
  // these": `pty`, `shell`, `stdout`, `prompt` and `transcript` live only in the keywords,
  // so dropping one of those fails here - but `terminal`, `chat` and `stream` also appear in
  // the description ("a chat log or as a terminal stream"), so removing those from the
  // keywords leaves the loop green. The check below is what catches that, and is NOT
  // redundant with this one.
  const TERMS = ["terminal", "pty", "shell", "stdout", "prompt", "transcript", "chat", "stream"];
  for (const term of TERMS) {
    assert.ok(searchable.includes(term), `"${term}" reaches nothing in the settings index`);
  }
  // The literal list held to the entry itself. Two failures live here and nowhere else: a
  // keyword leaving `control.keywords` while the description still happens to carry the
  // word, and a hand-written subset falling behind the entry - the first version of this
  // test pinned seven of the eight words declared, and nothing said so.
  assert.deepEqual(
    [...control.keywords].sort(),
    [...TERMS].sort(),
    "the entry's keywords and the vocabulary this test pins have drifted apart",
  );
  // And it is not findable only as a synonym of another control: the label is its own.
  const labels = SETTINGS_CONTROLS.filter((c) => c.id !== control.id).map((c) => c.label);
  assert.ok(!labels.includes(control.label), "two controls answer to the same name");
});

// Guided dispatch, named on its own for the reason above the Conversation picker: the
// sweeps only ask their questions of whatever the array happens to hold, so a control that
// was never added passes every one of them by not existing. This one has a second thing to
// pin that the picker does not - it is the whole point of the Settings home. The preference
// was reachable ONLY from the dispatch modal's header, which is to say only to someone
// already dispatching. If it stops being indexed, it goes back to being undiscoverable and
// nothing else in the suite notices.
test("guided dispatch is indexed under Dispatch, anchored at the panel that draws it", () => {
  const control = SETTINGS_CONTROLS.find((c) => c.id === "guided-dispatch");
  assert.ok(control, "the guided-dispatch preference is not in the search index at all");
  assert.equal(control.category, "dispatch");
  assert.equal(control.anchor, "dispatch/guided");
  // Rendered by the DISPATCH panel specifically. The sweep above proves every anchor is
  // rendered by some category; this proves the jump lands on the page the row promises.
  assert.match(renderCategory("dispatch"), /data-anchor="dispatch\/guided"/);
  // And the panel draws the control itself, not merely an anchored container: the row is a
  // checkbox, which is what makes the palette's in-place flip and the panel agree.
  assert.match(renderCategory("dispatch"), /data-anchor="dispatch\/guided"[^>]*>.*?type="checkbox"/s);
});

test("guided dispatch flips from a search row rather than jumping", () => {
  const control = SETTINGS_CONTROLS.find((c) => c.id === "guided-dispatch")!;
  // A boolean with shipped defaults and no consent copy to read first, so the palette can
  // set it in place. Declaring it a `jump` would still work and be worse: ⌘K would open the
  // panel and leave the operator to find the switch they already named.
  assert.equal(control.kind, "toggle");
  assert.ok(!control.risky, "a preference about how a form asks questions is not consent-gated");
  assert.ok(
    BINDABLE_CONTROL_IDS.includes("guided-dispatch"),
    "a non-risky toggle must be bindable, or the palette row degrades to a jump",
  );
});

test("guided dispatch is reachable by the words someone would half-remember", () => {
  const control = SETTINGS_CONTROLS.find((c) => c.id === "guided-dispatch")!;
  const searchable = [control.label, control.description, ...control.keywords]
    .join(" ")
    .toLowerCase();
  // Spelled out rather than looped from `control.keywords`, which would pass whatever that
  // array happened to hold. "wizard" and "walkthrough" are the words for this feature that
  // are nowhere in its own label or description - someone who never read either will type
  // one of them - and "kind", "harness" and "after work" are the questions themselves, which
  // is what an operator who met the pass and wants it gone actually remembers about it.
  const TERMS = [
    "guided",
    "wizard",
    "walkthrough",
    "steps",
    "questions",
    "kind",
    "harness",
    "after work",
  ];
  for (const term of TERMS) {
    assert.ok(searchable.includes(term), `"${term}" reaches nothing in the settings index`);
  }
  assert.deepEqual(
    [...control.keywords].sort(),
    [...TERMS].sort(),
    "the entry's keywords and the vocabulary this test pins have drifted apart",
  );
  // "dispatch" alone must NOT be what this row rests on: the Dispatch shortcut, both harness
  // cards and the Harnesses category already answer to that word, so a preference findable
  // only as "dispatch" is a preference buried under four better-matching rows.
  assert.ok(
    !control.keywords.includes("dispatch"),
    "leaning on the word four other controls already carry is not being findable",
  );
  const labels = SETTINGS_CONTROLS.filter((c) => c.id !== control.id).map((c) => c.label);
  assert.ok(!labels.includes(control.label), "two controls answer to the same name");
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

// A daemon-backed toggle must not be flippable from the palette before its config has
// loaded: the panels disable the control until the first read, and a pre-poll flip would
// write against an assumed default or no-op on a refused update. `buildSettingsBindings`
// withholds the binding until the source is present, so the control degrades to a jump.
test("daemon-backed toggles get no binding until their config has loaded", () => {
  const noop = () => {};
  const loading = buildSettingsBindings({
    formatMessages: { value: true, set: noop },
    guidedDispatch: { value: false, set: noop },
    autoMode: null,
    skillsEnabled: null,
    costTrack: null,
  });
  // The two browser-local toggles are always bindable (shipped defaults, no poll).
  assert.ok(loading.has("format-messages"));
  assert.ok(loading.has("guided-dispatch"));
  // The three daemon-backed toggles are withheld until loaded.
  assert.ok(!loading.has("auto-mode"));
  assert.ok(!loading.has("skills-enabled"));
  assert.ok(!loading.has("cost-track"));

  const loaded = buildSettingsBindings({
    formatMessages: { value: true, set: noop },
    guidedDispatch: { value: false, set: noop },
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
