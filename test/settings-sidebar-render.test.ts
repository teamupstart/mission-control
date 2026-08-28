import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPage } from "../src/web/components/SettingsPage.tsx";
import {
  SETTINGS_CATEGORIES,
  SETTINGS_GROUPS,
  SETTINGS_SCOPES,
  type SettingsCategoryId,
} from "../src/web/lib/settings-registry.ts";
import { LAYOUTS } from "../src/web/lib/layout.ts";
import { CONVERSATION_VIEW_OPTIONS } from "../src/web/lib/conversation-view.ts";
import type { ForemanState } from "../src/web/useForeman.ts";
import type { CostState } from "../src/web/useCost.ts";
import type { LlmState } from "../src/web/useLlm.ts";
import type { SetupChecksState } from "../src/web/useSetupChecks.ts";
import type { SettingsStatus } from "../src/shared/types.ts";
import { ForemanConfigSchema } from "../src/shared/protocol.ts";
import type { TourId } from "../src/web/tour/contracts.ts";
import { TOUR_ENTRIES } from "../src/web/tour/entries.ts";

// What is at stake: Settings is a page now, and the rail is the only inventory of what the
// app can be told to do. A category that silently fails to render is one whose switches
// nobody can see or change while the daemon goes on acting on whatever was last stored -
// which is worst exactly where the blast radius is largest (Inspector posts, Shipping
// merges). So every category is proved reachable, and the rail is proved to say how far
// each group's writes reach.
//
// Rendered rather than driven through a browser: the dashboard's SSE stream holds the
// connection open, which hangs headless automation (same reason as plan-decisions-render).
// Static markup is enough to prove the two-pane structure - the rail lists every category,
// and the route's category selects which panel renders - since the only thing a click does
// is navigate, which we exercise here through the `category` prop.

// Foreman config is owned by App and passed in; null config is the pre-poll state, which
// renders the panel's defaults. Static render never runs effects, so nothing fetches.
const FOREMAN: ForemanState = {
  config: null,
  status: null,
  backlogPlan: null,
  episodes: [],
  update: async () => true,
  refresh: async () => {},
  error: null,
};

// Cost is owned by App and passed in for the same reason as Foreman - the topbar strip
// reads the same view setting. A null status is the pre-poll state, which renders the
// panel's shipped defaults with its controls disabled.
const COST: CostState = { status: null, update: async () => {}, error: null };
const LLM: LlmState = {
  config: null,
  status: null,
  personaDefaults: null,
  update: async () => {},
  error: null,
};
const SETUP: SetupChecksState = {
  view: null,
  loading: false,
  error: null,
  refresh: async () => {},
  dismissBanner: async () => null,
};

// The layout is owned by App too, for the same reason as Foreman: the dashboard renders
// it, so the panel only edits what it's handed.
//
// `settingsStatus` defaults to null - the pre-snapshot "unknown", which draws none of the
// SSE-fed dots. A test that cares about the dots passes one, and may override `foreman` to
// exercise the Foreman dot (which is App-owned, not part of the status payload).
function render(
  category: SettingsCategoryId = "display",
  opts: {
    settingsStatus?: SettingsStatus | null;
    foreman?: ForemanState;
    onStartTour?: (tourId: TourId) => void;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(SettingsPage, {
      category,
      onNavigate: () => {},
      onLeave: () => {},
      foreman: opts.foreman ?? FOREMAN,
      cost: COST,
      llm: LLM,
      setup: SETUP,
      layout: "console",
      onLayoutChange: () => {},
      settingsStatus: opts.settingsStatus ?? null,
      onStartTour: opts.onStartTour ?? (() => {}),
    }),
  );
}

/** The outer category rail only. A category may legitimately render its own nested tabs. */
function railMarkup(html: string): string {
  return html.slice(html.indexOf('<div class="settings-nav"'), html.indexOf('<div class="settings-pane"'));
}

/** A status tuple with every fact off, so a test flips exactly the one it is about. */
function status(over: Partial<SettingsStatus> = {}): SettingsStatus {
  return {
    inspector: { enabled: false, mode: "dry-run" },
    shipping: { autoMerge: false },
    taskSources: { failing: 0 },
    pipelines: { present: true, observing: 0 },
    ...over,
  };
}

// Distinctive text that appears ONLY inside a given panel (not in the nav), so matching it
// proves that panel is the one rendered.
const KEYBOARD_ONLY = /Anywhere/; // a keyboard action group label
const SKILLS_ONLY = /Enable Mission Control skills/; // the skills master toggle
const LAYOUT_ONLY = /Dashboard layout/; // the picker's radiogroup label
const HARNESSES_ONLY = /Auto mode on dispatch/; // the harnesses toggle label
const APPEARANCE_ONLY = /Format messages/; // the rich-text toggle label
const CONVERSATION_ONLY = /Conversation rendering/; // the view picker's radiogroup label
const COST_ONLY = /Track Claude estimated cost/; // the telemetry master toggle label
const INSPECTOR_ONLY = /Run GitHub Inspector/; // the inspector master toggle label
const SHIPPING_ONLY = /YOLO mode - merge/; // the auto-merge master toggle label
const TASK_SOURCES_ONLY = /never dispatches an agent/; // the task-sources safety sentence
const MODELS_ONLY = /Background jobs/; // the LLM panel's per-job group label
const CONDUCTOR_ONLY = /Conductor commissioning progress/; // the Conductor panel's setup path
const SETUP_ONLY = /Runnable remedies open in a visible terminal where you can watch them and read the exit code/;
const STANDING_INSTRUCTIONS_ONLY = /A rule here beats the default/; // the repositories group's rule

test("the rail lists every category exactly once", () => {
  const html = render("display", { settingsStatus: status() });
  const items = html.match(/class="settings-nav-item/g) ?? [];
  assert.equal(items.length, SETTINGS_CATEGORIES.length);
  for (const c of SETTINGS_CATEGORIES) assert.ok(html.includes(c.label), `nav missing ${c.label}`);
});

test("without an engine installed, Conductor remains a permanent destination", () => {
  const html = render("display", { settingsStatus: status({ pipelines: { present: false, observing: 0 } }) });
  assert.equal(
    (html.match(/class="settings-nav-item/g) ?? []).length,
    SETTINGS_CATEGORIES.length,
    "engine state must not alter navigation",
  );
  assert.match(html, />Conductor</, "the rail row is permanent");
  assert.doesNotMatch(html, CONDUCTOR_ONLY, "no panel");
});

test("routing to Conductor without an engine renders its setup destination", () => {
  const html = render("conductor", { settingsStatus: status({ pipelines: { present: false, observing: 0 } }) });
  assert.match(html, CONDUCTOR_ONLY);
  assert.doesNotMatch(html, LAYOUT_ONLY);
  assert.equal((html.match(/settings-nav-item is-active/g) ?? []).length, 1);
});

test("before the daemon answers, the permanent Conductor category is already drawn", () => {
  const html = render();
  assert.match(html, />Conductor</);
});

test("Setup is a routed category with its read-only remedy boundary visible", () => {
  const html = render("setup");
  assert.match(html, SETUP_ONLY);
  assert.match(
    html,
    /<div class="settings-panel-head"><h2>Setup<\/h2><span class="settings-scope settings-scope-home-read"[^>]*>Reads ~\/<\/span>/,
  );
  assert.match(html, /Inspects tools and configuration in your home directory without changing them\./);
  assert.doesNotMatch(html, />Writes ~\/<\/span>/);
  assert.doesNotMatch(html, HARNESSES_ONLY);
});

// The rail groups by blast radius, and the groups come from the registry - never from a
// list written out in the rail's JSX, which is how a category lands in a group nothing
// draws (invisible, and therefore unreachable except by typing its hash).
test("every group is non-empty and every category belongs to exactly one", () => {
  for (const group of SETTINGS_GROUPS) {
    const members = SETTINGS_CATEGORIES.filter((c) => c.group === group.id);
    assert.ok(members.length > 0, `group ${group.id} has no categories`);
  }
  for (const c of SETTINGS_CATEGORIES) {
    const groups = SETTINGS_GROUPS.filter((g) => g.id === c.group);
    assert.equal(groups.length, 1, `${c.id} names ${groups.length} groups`);
  }
});

// The arrow keys walk the FLAT registry while the rail draws it group by group. If the two
// orders disagree, Down moves the selection somewhere the eye is not - so the registry has
// to be grouped contiguously, in group order.
test("the registry's order is the order the rail draws", () => {
  const drawn = SETTINGS_GROUPS.flatMap((g) =>
    SETTINGS_CATEGORIES.filter((c) => c.group === g.id).map((c) => c.id),
  );
  assert.deepEqual(drawn, SETTINGS_CATEGORIES.map((c) => c.id));
});

// The badge is the sentence the flat rail could not say: which settings stay in this
// browser, and which act on GitHub under your account.
test("every rail item sits under its group's scope badge", () => {
  const html = render("display", { settingsStatus: status() });
  // Tooltip injects an `aria-describedby` and a sibling description span, so the badge is
  // matched by shape rather than by exact markup.
  const headOf = (group: (typeof SETTINGS_GROUPS)[number]): RegExp =>
    new RegExp(
      `${group.label}<span class="settings-scope settings-scope-${group.scope}"[^>]*>${SETTINGS_SCOPES[group.scope].label}</span>`,
    );
  for (const [i, group] of SETTINGS_GROUPS.entries()) {
    const head = headOf(group).exec(html);
    assert.ok(head, `rail group ${group.id} is missing its ${SETTINGS_SCOPES[group.scope].label} badge`);
    // Every member is drawn after that header and before the next group's, which is what
    // makes the badge a claim about those categories rather than a loose label.
    const next = SETTINGS_GROUPS[i + 1];
    const to = next ? (headOf(next).exec(html)?.index ?? html.length) : html.length;
    const section = html.slice(head.index, to);
    for (const c of SETTINGS_CATEGORIES.filter((x) => x.group === group.id)) {
      assert.ok(section.includes(`>${c.label}</button>`), `${c.id} is not under ${group.id}`);
    }
  }
});

// The rail's badge is the group's, which can be gentler than a member's own - Skills sits
// under "This machine" and symlinks into `~/`. The panel header is where the precise claim
// gets made, so it has to be there for every category, not just the ones that differ.
test("each panel header carries its own category's scope badge", () => {
  for (const c of SETTINGS_CATEGORIES) {
    const html = render(c.id, { settingsStatus: status() });
    assert.match(
      html,
      new RegExp(
        `<div class="settings-panel-head"><h2>${c.label}</h2><span class="settings-scope settings-scope-${c.scope}"[^>]*>${SETTINGS_SCOPES[c.scope].label}</span>`,
      ),
      `${c.id} panel header is missing its scope badge`,
    );
  }
});

// The Phase 5 contract, pinned from day one: search jumps to a control by its anchor, so
// two controls sharing one - or an anchor naming a category that does not exist - is a
// jump that lands on the wrong row, or on nothing.
test("every control anchor is unique and names a real category", () => {
  const ids = new Set<string>(SETTINGS_CATEGORIES.map((c) => c.id));
  const seen = new Map<string, SettingsCategoryId>();
  for (const c of SETTINGS_CATEGORIES) {
    const html = render(c.id, { settingsStatus: status() });
    for (const match of html.matchAll(/data-anchor="([^"]+)"/g)) {
      const anchor = match[1]!;
      const prefix = anchor.split("/")[0]!;
      assert.ok(ids.has(prefix), `anchor "${anchor}" names no category`);
      assert.equal(prefix, c.id, `anchor "${anchor}" rendered inside the ${c.id} panel`);
      assert.equal(seen.get(anchor), undefined, `anchor "${anchor}" is used twice`);
      seen.set(anchor, c.id);
    }
  }
  // Every category contributes at least one anchor, or its controls are unreachable from
  // search however good the index is.
  for (const c of SETTINGS_CATEGORIES) {
    assert.ok([...seen.values()].includes(c.id), `${c.id} has no anchored control`);
  }
});

test("opens on Display by default: the layout picker shows, skills does not", () => {
  const html = render();
  assert.match(html, LAYOUT_ONLY);
  assert.doesNotMatch(html, SKILLS_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>▦<\/span>Display/);
});

// Layout, Conversation and Appearance merged into one category: three settings about how
// this browser draws the fleet, which sat as visual peers of the panel that merges pull
// requests. Stacked outside in - the arrangement, then the reading, then the formatting.
test("Display renders the layout picker, the conversation picker and the formatting toggle together", () => {
  const html = render("display");
  assert.match(html, LAYOUT_ONLY);
  assert.match(html, CONVERSATION_ONLY);
  assert.match(html, APPEARANCE_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  // Outside in, in that order: a reader scanning the pane meets the arrangement before the
  // reading before the type.
  assert.ok(
    html.indexOf("Dashboard layout") <
      html.indexOf("Conversation rendering") &&
      html.indexOf("Conversation rendering") < html.indexOf("Format messages"),
    "the display panels are stacked out of order",
  );
});

test("the conversation picker offers both renderings, with terminal the shipped default", () => {
  const html = render("display");
  const radios = (html.match(/<input[^>]*type="radio"[^>]*>/g) ?? []).filter((i) =>
    i.includes('name="conversation-view"'),
  );
  assert.equal(radios.length, CONVERSATION_VIEW_OPTIONS.length, "one radio per rendering");
  // Rendered with no daemon and no storage, so the shared config store holds the shipped
  // defaults. What this pins is that default reaching the control: a session opens as the
  // terminal stream unless someone chose otherwise.
  const checked = radios.filter((i) => i.includes("checked"));
  assert.equal(checked.length, 1, "exactly one rendering is checked");
  assert.match(checked[0]!, /value="terminal"/);
  for (const o of CONVERSATION_VIEW_OPTIONS) {
    assert.ok(html.includes(o.label), `picker missing ${o.label}`);
  }
});

test("every glyph in Settings declares its own size", () => {
  // The bug this pins: `ViewGlyph` shipped as an inline `<svg>` carrying a viewBox and
  // neither `width` nor `height`. That is not a small icon - a replaced element with an
  // intrinsic ratio and no intrinsic size resolves its width to 100% of the line and scales
  // its height by the ratio, so each glyph drew at the width of its row and the Conversation
  // section became taller than the window. What it actually measured is in
  // `e2e/specs/settings-conversation-picker.spec.ts`, which is the layer that can measure;
  // this one asserts the attribute that prevents it.
  //
  // Across every category rather than the one that broke, because the failure is a property
  // of the markup and not of this picker, and it is invisible in review: the offending tag
  // reads as an ordinary icon. CSS carries the same sizes (`.layout-glyph`, `.view-thumb`),
  // so a glyph that forgets them still lays out - this is the assertion that stops the
  // stylesheet from being the only thing standing between a picture and the whole pane.
  for (const category of SETTINGS_CATEGORIES) {
    const svgs = render(category.id, { settingsStatus: status() }).match(/<svg[^>]*>/g) ?? [];
    for (const svg of svgs) {
      assert.match(svg, /\swidth="/, `unsized glyph in ${category.id}: ${svg}`);
      assert.match(svg, /\sheight="/, `unsized glyph in ${category.id}: ${svg}`);
    }
  }
});

test("the layout picker offers only Console and Board", () => {
  const html = render("display");
  assert.deepEqual(
    LAYOUTS.map((layout) => layout.label),
    ["Board", "Console"],
    "only supported settings choices are offered",
  );
  // Scoped by `name`, because Display holds a second radio group for conversation rendering.
  const radios = (html.match(/<input[^>]*type="radio"[^>]*>/g) ?? []).filter((i) =>
    i.includes('name="layout"'),
  );
  assert.equal(radios.length, LAYOUTS.length, "one radio per supported layout");
  assert.ok(!radios.some((i) => i.includes('value="grid"')), "Cards cannot be enabled from settings");
});

test("the layout panel is absent from every other category", () => {
  for (const id of ["keyboard", "skills", "harnesses", "foreman", "cost"] as const) {
    assert.doesNotMatch(render(id), LAYOUT_ONLY, `layout picker leaked into ${id}`);
  }
});

test("message formatting is on unless it has been turned off", () => {
  // `render` mounts the page with no daemon and no storage, so the shared config store
  // holds the shipped defaults. What this pins is that default reaching the control: the
  // panel shows a checked box, not an unchecked one or no box at all. It says nothing
  // about what the daemon or the cache hold; those paths are ui-config-*.test.ts.
  const html = render("display");
  const toggle = (html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [])[0];
  assert.ok(toggle, "the display panel has a checkbox");
  assert.match(toggle, /checked/);
});

test("Keyboard is a category of its own: its panel shows, the others don't", () => {
  const html = render("keyboard");
  assert.match(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, SKILLS_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>⌨<\/span>Keyboard/);
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

// Conductor is the category that lets Mission Control READ another program's state files.
// Reachability matters for a version of the Inspector's reason turned inside out: a panel
// that silently fails to render is one whose repository switches nobody can see or turn off,
// while the daemon goes on reading whatever was last consented to. It is the only consent in
// the app whose subject is somebody else's software.
// Standing instructions is the category whose subject is a rule an agent will OBEY. Its
// reachability is worth its own assertion for a reason the other panels do not have: this is
// the ONLY place the rule can be read. A panel that silently fails to render leaves the
// stored text still being delivered to every session with nowhere to see it, which is
// exactly the "debugging an instruction you cannot see" failure the whole feature is built
// to prevent.
test("Standing instructions is a category of its own: its panel shows, the others don't", () => {
  const html = render("standing-instructions");
  assert.match(html, STANDING_INSTRUCTIONS_ONLY);
  assert.doesNotMatch(html, SKILLS_ONLY);
  assert.doesNotMatch(html, COST_ONLY);
  assert.match(
    html,
    /settings-nav-item is-active"[^>]*><span[^>]*>\u270e<\/span>Standing instructions/,
  );
});

// A static render is the pre-poll state, so this panel has not heard from the daemon yet.
// Drawing an empty repository list there would tell an operator that no checkout has a rule
// while the daemon may hold four - and this is the panel where believing that is expensive.
test("with no answer from the daemon, the Standing instructions panel says so rather than showing an empty list", () => {
  const html = render("standing-instructions");
  assert.match(html, /daemon has not answered yet/);
  assert.doesNotMatch(html, /No repository has a rule of its own/);
});

test("Conductor is a category of its own: its panel shows, the others don't", () => {
  const html = render("conductor", { settingsStatus: status() });
  assert.match(html, CONDUCTOR_ONLY);
  assert.doesNotMatch(html, TASK_SOURCES_ONLY);
  assert.doesNotMatch(html, MODELS_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>⇶<\/span>Conductor/);
});

// A static render runs no effects, so this is the pre-poll state - the state a first-run
// user sees. It must not draw an empty repository list, which asserts that the engine
// manages nothing on a machine where it may manage six.
test("with no answer from the daemon, the Conductor panel says so rather than showing an empty list", () => {
  // Engine present so the category exists, and the daemon has not answered the PANEL yet -
  // which is a different unknown from "is it installed", and the one the panel speaks to.
  const html = render("conductor", { settingsStatus: status() });
  assert.match(html, /conductor-unknown/);
  assert.match(html, /is unknown/);
  assert.doesNotMatch(
    html,
    /No repositories registered with the engine/,
    "an unanswered panel must not assert an empty list",
  );
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
  // config built on defaults the daemon never sent. Scoped to the pane, since the rail
  // beside it is full of buttons that are always live.
  const html = render("cost");
  const pane = html.slice(html.indexOf('class="settings-pane"'));
  for (const control of pane.match(/<(input|select)[^>]*>/g) ?? []) {
    assert.match(control, /disabled/, `cost control should be disabled pre-poll: ${control}`);
  }
});

test("the route's category swaps the panel: skills shows, keyboard does not", () => {
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
  const html = railMarkup(render("display", { settingsStatus: status() }));
  assert.match(html, /role="tablist"[^>]*aria-orientation="vertical"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, SETTINGS_CATEGORIES.length);
});

test("aria-selected tracks the active category, and only it", () => {
  for (const active of SETTINGS_CATEGORIES) {
    const html = railMarkup(render(active.id, { settingsStatus: status() }));
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
    const html = railMarkup(render(active.id, { settingsStatus: status() }));
    assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1);
    assert.equal((html.match(/tabindex="-1"/g) ?? []).length, SETTINGS_CATEGORIES.length - 1);
    assert.match(html, /class="settings-nav-item is-active"[^>]*tabindex="0"/);
  }
});

test("the pane is a tabpanel labelled by the active tab", () => {
  for (const active of SETTINGS_CATEGORIES) {
    const html = render(active.id, { settingsStatus: status() });
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
test("GitHub Inspector is a category of its own: its panel shows, the others don't", () => {
  const html = render("inspector");
  assert.match(html, INSPECTOR_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, SKILLS_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>⌕<\/span>GitHub Inspector/);
});

// Ships off, and ships not-live. A static render runs no effects, so this is the
// pre-poll state - which is exactly the state a first-run user sees, and it must not
// show a mode that would post anything.
test("the GitHub Inspector panel's defaults are the off position", () => {
  const html = render("inspector");
  // No checked master toggle, and no live-mode warning banner.
  assert.doesNotMatch(html, /inspector-live-warn/);
  assert.match(html, /Dry run - review and record findings, post nothing/);
});

// The same pre-poll render, from the other direction. Those defaults are the SAFE
// posture, and presenting them as the daemon's answer is how an operator reads "off, dry
// run, no repos" as fact while the stored config is enabled and live and the daemon is
// merely restarting. Disabled inputs are not a statement about what is running.
test("with no answer from the daemon, the GitHub Inspector panel says so rather than showing defaults as fact", () => {
  const html = render("inspector");
  assert.match(html, /inspector-unknown/);
  assert.match(html, /is unknown/);
  assert.doesNotMatch(
    html,
    /No repos yet - GitHub Inspector won't post anywhere/,
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

// The rail status dots (Phase 4). The colour maps a subsystem's live posture onto the nav
// without opening its panel, so the wiring worth pinning is which category lights and in
// which tone - and that "unknown" (a null status) lights nothing rather than an all-clear.
// The dot renders inside the category's own tab button, right after its label.

// Match a dot of `tone` inside the button whose label is `label`. The icon span precedes
// the label; the dot follows it, so the label text sits directly before the dot's span.
function railDot(html: string, label: string, tone: string): boolean {
  return new RegExp(`${label}<span class="settings-dot settings-dot-${tone}"`).test(html);
}

test("a null status lights none of the SSE-fed dots - unknown is not an all-clear", () => {
  const html = render("display");
  // Foreman's dot rides App-owned state, and FOREMAN.config is null here, so it is off too.
  assert.doesNotMatch(html, /settings-dot settings-dot-(live|armed|failing|foreman)/);
});

test("a live GitHub Inspector lights the GitHub Inspector dot green, and only it", () => {
  const html = render("display", {
    settingsStatus: status({ inspector: { enabled: true, mode: "live" } }),
  });
  assert.ok(railDot(html, "GitHub Inspector", "live"), "GitHub Inspector should carry the green live dot");
  // enabled-but-dry-run, or disabled, is not live - no dot.
  const dry = render("display", {
    settingsStatus: status({ inspector: { enabled: true, mode: "dry-run" } }),
  });
  assert.ok(!railDot(dry, "GitHub Inspector", "live"), "dry-run is not live and lights no dot");
});

test("armed YOLO lights the Shipping dot amber", () => {
  const html = render("display", { settingsStatus: status({ shipping: { autoMerge: true } }) });
  assert.ok(railDot(html, "Shipping", "armed"), "Shipping should carry the amber armed dot");
  const disarmed = render("display", { settingsStatus: status() });
  assert.ok(!railDot(disarmed, "Shipping", "armed"), "disarmed YOLO lights no dot");
});

test("a failing task source lights the Task sources dot red", () => {
  const html = render("display", { settingsStatus: status({ taskSources: { failing: 2 } }) });
  assert.ok(railDot(html, "Task sources", "failing"), "a failing source should light red");
  // The label counts, not just the colour: two sources, plural.
  assert.match(html, /2 task sources failed their last sweep/);
  const healthy = render("display", { settingsStatus: status({ taskSources: { failing: 0 } }) });
  assert.ok(!railDot(healthy, "Task sources", "failing"), "no failures lights no dot");
});

test("Foreman's dot follows its App-owned enabled state, not the status payload", () => {
  const on: ForemanState = { ...FOREMAN, config: ForemanConfigSchema.parse({ enabled: true }) };
  // Even with a null status (Foreman is not in the payload), the dot is knowable.
  const html = render("display", { settingsStatus: null, foreman: on });
  assert.ok(railDot(html, "Foreman", "foreman"), "Foreman on should light the purple dot");
  const off = render("display", { settingsStatus: null, foreman: FOREMAN });
  assert.ok(!railDot(off, "Foreman", "foreman"), "Foreman off (or unknown) lights no dot");
});

test("the Help & tours footer draws one row per registered tour, from the registry", () => {
  const html = render();
  for (const tour of TOUR_ENTRIES) {
    assert.ok(
      html.includes(`aria-label="${tour.settings.ariaLabel}"`),
      `no entry point for ${tour.id}`,
    );
    assert.ok(html.includes(`<strong>${tour.settings.heading}</strong>`));
    assert.ok(html.includes(`<small>${tour.settings.hint}</small>`));
  }
  // One registered tour, one row: the footer is derived, not a list kept in parallel.
  assert.equal(html.split('class="settings-tour-start"').length - 1, TOUR_ENTRIES.length);
  assert.ok(html.includes('aria-label="Start See the work tour"'));
  // The second registered tour is a row for the same reason the first is: the footer is a
  // list drawn from the registry, so the Library tour needed no Settings change of its own.
  assert.ok(html.includes('aria-label="Start Author what runs tour"'));
  assert.ok(html.includes("<strong>Author what runs</strong>"));
});
