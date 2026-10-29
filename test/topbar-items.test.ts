import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The Top bar preference: the registry, the two lists it writes, and the bar that reads them.
 *
 * Static markup is the right layer for "what does the bar draw for a given layout", and it is
 * cheap enough to sweep every item. Whether a click in Settings reaches the real bar is
 * `e2e/specs/topbar-customization.spec.ts`; whether the bar still fits one row is the ladder's
 * own spec.
 */

// A fake `localStorage` and an accepting fetch, installed BEFORE the modules below load, for
// the reason `board-card-items.test.ts` gives: `uiConfig.ts` seeds itself from the cache at
// import, and a refused write would undo every optimistic toggle in this file.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
});

const {
  DEFAULT_TOPBAR_LAYOUT,
  PAGE_SEGMENTS,
  TOPBAR_ITEMS,
  nextCompactTopbarItems,
  nextHiddenTopbarItems,
} = await import("../src/web/lib/topbar-items.ts");
const { PREVIEW_FOREMAN, PREVIEW_TOPBAR_FLEET, previewFleetCost } = await import(
  "../src/web/lib/topbar-preview.ts"
);
const { Topbar } = await import("../src/web/components/Topbar.tsx");
const { TopbarPanel } = await import("../src/web/components/TopbarPanel.tsx");
const { UI_CONFIG_DEFAULTS, UiConfigSchema } = await import("../src/shared/protocol.ts");
const { uiConfig, updateUiConfig } = await import("../src/web/lib/uiConfig.ts");

type Layout = { hidden: readonly string[]; compact: readonly string[] };

const noop = (): void => {};

/** The bar against the preview's fixture fleet, which populates every optional item. */
function bar(layout: Layout, scheduleAttentionCount = 0): string {
  return renderToStaticMarkup(
    createElement(Topbar, {
      layout,
      page: "fleet",
      onNavigatePage: noop,
      filter: "",
      onFilterChange: noop,
      connected: true,
      keepAwake: null,
      ...PREVIEW_TOPBAR_FLEET,
      onOpenInbox: noop,
      fleetCost: previewFleetCost(Date.now()),
      costView: "usd",
      onOpenCostSettings: noop,
      scheduleAttentionCount,
      onOpenMissions: noop,
      foreman: PREVIEW_FOREMAN,
      onOpenModels: noop,
      onOpenForemanSettings: noop,
      onOpenDispatch: noop,
      onOpenFeedback: noop,
      gearDot: null,
      gearPhrase: null,
      onGear: noop,
      alertSettings: UI_CONFIG_DEFAULTS.alerts,
      updateAlerts: noop,
      away: null,
      setAway: async () => {},
      buffered: null,
    }),
  );
}

/** What each optional item draws on the bar - present by default, absent once hidden. */
const OPTIONAL_MARKERS: Record<string, RegExp> = {
  sessions: /<span class="pulse-n">4<\/span><span class="tb-label">sessions<\/span>/,
  needYou: /<span class="tb-label">need you<\/span>/,
  working: /<span class="tb-label">working<\/span>/,
  search: /class="filter-box"/,
  cost: /class="spend-chip"/,
  feedback: /aria-label="Report product feedback"/,
  alerts: /aria-label="Alerts &amp; away mode - muted"/,
};

/** Every control that may be minimized, located by the class the bar puts on it. */
const COMPACT_MARKERS: Record<string, RegExp> = {
  ...Object.fromEntries(
    PAGE_SEGMENTS.map(({ label }) => [
      label.toLowerCase(),
      new RegExp(`<button class="page-seg-btn[^"]*"[^>]*>(?:(?!</button>).)*>${label}</span>`),
    ]),
  ),
  missions: /<button class="ghost-btn missions-btn[^"]*"/,
  foreman: /<button class="ghost-btn foreman-btn[^"]*"/,
};

test("the registry is the two lists the request names, and nothing else", () => {
  assert.deepEqual(
    TOPBAR_ITEMS.filter((item) => item.kind === "optional").map((item) => item.id),
    ["sessions", "needYou", "working", "search", "cost", "feedback", "alerts"],
  );
  assert.deepEqual(
    TOPBAR_ITEMS.filter((item) => item.kind === "compactable").map((item) => item.id),
    ["fleet", "library", "runs", "scouts", "missions", "foreman"],
  );
  // Every id is unique, so one stored id can only ever mean one item.
  assert.equal(new Set(TOPBAR_ITEMS.map((item) => item.id)).size, TOPBAR_ITEMS.length);
  // Neither marker table can drift from the registry it is testing.
  assert.deepEqual(
    Object.keys(OPTIONAL_MARKERS).sort(),
    TOPBAR_ITEMS.filter((item) => item.kind === "optional").map((item) => item.id).sort(),
  );
  assert.deepEqual(
    Object.keys(COMPACT_MARKERS).sort(),
    TOPBAR_ITEMS.filter((item) => item.kind === "compactable").map((item) => item.id).sort(),
  );
});

test("the shipped bar hides nothing and minimizes nothing", () => {
  assert.deepEqual(UI_CONFIG_DEFAULTS.hiddenTopbarItems, []);
  assert.deepEqual(UI_CONFIG_DEFAULTS.compactTopbarItems, []);
  // A stored record from before this build parses to the same, so an upgrade moves nothing.
  const parsed = UiConfigSchema.parse({ layout: "console" });
  assert.deepEqual(parsed.hiddenTopbarItems, []);
  assert.deepEqual(parsed.compactTopbarItems, []);
  // And the default bar draws every optional item with no control minimized.
  const html = bar(DEFAULT_TOPBAR_LAYOUT);
  for (const [id, marker] of Object.entries(OPTIONAL_MARKERS)) {
    assert.match(html, marker, `${id} is not drawn on the default bar`);
  }
  assert.doesNotMatch(html, /tb-compact/);
});

test("hiding an optional item removes exactly that item from the bar", () => {
  for (const [id, marker] of Object.entries(OPTIONAL_MARKERS)) {
    const html = bar({ hidden: [id], compact: [] });
    assert.doesNotMatch(html, marker, `hiding ${id} left it on the bar`);
    for (const [other, otherMarker] of Object.entries(OPTIONAL_MARKERS)) {
      if (other !== id) assert.match(html, otherMarker, `hiding ${id} also took ${other}`);
    }
  }
});

test("hiding every optional item leaves the controls and the inbox route in place", () => {
  const html = bar({ hidden: Object.keys(OPTIONAL_MARKERS), compact: [] });
  for (const [id, marker] of Object.entries(OPTIONAL_MARKERS)) {
    assert.doesNotMatch(html, marker, `${id} survived`);
  }
  // The pulse's connection segment and its `to answer` button are not optional: the second is
  // the only way into the attention inbox.
  assert.match(html, /<span class="tb-label">to answer<\/span>/);
  assert.match(html, /class="dispatch-btn"/);
  assert.match(html, /aria-label="Settings"/);
  assert.match(html, /aria-label="Pages"/);
  for (const [id, marker] of Object.entries(COMPACT_MARKERS)) {
    assert.match(html, marker, `${id} is not optional and must stay`);
  }
});

test("minimizing a control marks exactly that control, and keeps its name", () => {
  for (const [id, marker] of Object.entries(COMPACT_MARKERS)) {
    const html = bar({ hidden: [], compact: [id] });
    const button = html.match(marker)?.[0] ?? "";
    assert.match(button, /tb-compact/, `minimizing ${id} did not mark it`);
    assert.equal(html.match(/tb-compact/g)?.length, 1, `minimizing ${id} marked another control`);
  }
  // The visually hidden word is still the page segment's accessible name.
  assert.match(
    bar({ hidden: [], compact: ["library"] }),
    /class="page-seg-btn tb-compact"[^>]*>(?:(?!<\/button>).)*<span class="tb-label">Library<\/span>/,
  );
});

test("the list helpers toggle one id without duplicating or dropping others", () => {
  assert.deepEqual(nextHiddenTopbarItems([], "cost", false), ["cost"]);
  assert.deepEqual(nextHiddenTopbarItems(["cost"], "cost", false), ["cost"]);
  assert.deepEqual(nextHiddenTopbarItems(["cost", "search"], "cost", true), ["search"]);
  assert.deepEqual(nextCompactTopbarItems(["fleet"], "foreman", true), ["fleet", "foreman"]);
  assert.deepEqual(nextCompactTopbarItems(["fleet", "foreman"], "fleet", false), ["foreman"]);
  // An id a later build retired survives an unrelated toggle rather than being silently swept.
  assert.deepEqual(nextHiddenTopbarItems(["retired"], "cost", false), ["retired", "cost"]);
});

test("the panel offers a checkbox per optional item and a size choice per control", async () => {
  await updateUiConfig({ hiddenTopbarItems: ["cost"], compactTopbarItems: ["scouts"] });
  assert.deepEqual(uiConfig().hiddenTopbarItems, ["cost"]);
  const html = renderToStaticMarkup(createElement(TopbarPanel));
  assert.match(html, /data-anchor="display\/topbar"/);
  for (const item of TOPBAR_ITEMS) {
    if (item.kind === "optional") {
      const box = html.match(new RegExp(`<input type="checkbox"[^>]*aria-label="${item.label}"[^>]*>`))?.[0];
      assert.ok(box, `no checkbox for ${item.label}`);
      assert.equal(/checked=""/.test(box), item.id !== "cost", `${item.label} checkbox state`);
    } else {
      assert.match(html, new RegExp(`role="radiogroup" aria-label="Top bar: ${item.label}"`));
      const minimized = html.match(
        new RegExp(`<input type="radio"[^>]*name="topbar-size-${item.id}"[^>]*value="minimized"[^>]*>`),
      )?.[0];
      assert.ok(minimized, `no Minimized option for ${item.label}`);
      assert.equal(/checked=""/.test(minimized), item.id === "scouts", `${item.label} size`);
    }
  }
  // The preview is the real bar, configured the same way, and out of the accessibility tree.
  const preview = html.slice(html.indexOf("topbar-preview-stage"));
  assert.match(html, /class="board-card-preview-stage topbar-preview-stage"[^>]*inert=""[^>]*aria-hidden="true"/);
  assert.match(preview, /class="topbar topbar-preview"/);
  assert.doesNotMatch(preview, /class="spend-chip"/, "the hidden cost chip is still in the preview");
  assert.match(preview, /class="page-seg-btn tb-compact"[^>]*>(?:(?!<\/button>).)*Scouts/);
  // Customized, so the section offers the way back.
  assert.match(html, />Reset all</);
  await updateUiConfig({ hiddenTopbarItems: [], compactTopbarItems: [] });
  assert.doesNotMatch(renderToStaticMarkup(createElement(TopbarPanel)), />Reset all</);
});

test("minimizing Foreman hides its mode chip but never its issue count", () => {
  // The browser spec proves the cascade; this pins the selector so a cheaper run catches the
  // exemption being dropped. An issue count is the one thing on that chip that is not a mode.
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const hiding = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
    ([, selector = "", body = ""]) =>
      /\.tb-compact/.test(selector) && /\.foreman-chip/.test(selector) && /display:\s*none/.test(body),
  );
  assert.equal(hiding.length, 1, "exactly one rule hides a minimized Foreman's chip");
  const selector = hiding[0]![1]!.split(",").map((part) => part.trim())
    .find((part) => part.includes(".foreman-chip"))!;
  assert.match(selector, /\.tb-compact:not\(\.has-errors\)/, `"${selector}" hides the issue count too`);
});

test("minimizing Recurring missions keeps its attention badge in the markup", () => {
  const html = bar({ hidden: [], compact: ["missions"] }, 2);
  const button = html.match(/<button class="ghost-btn missions-btn tb-compact"(?:(?!<\/button>).)*<\/button>/)?.[0];
  assert.ok(button, "the minimized Missions button is not marked tb-compact");
  assert.match(button, /aria-label="Recurring missions - 2 need attention"/);
  assert.match(button, /<span class="ghost-badge">2<\/span>/, "the attention badge was dropped");
  // And nothing in the stylesheet hides a badge on a minimized control.
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const [, selector = ""] of css.matchAll(/([^{}]+)\{[^{}]*display:\s*none[^{}]*\}/g)) {
    for (const part of selector.split(",")) {
      assert.ok(
        !(/\.tb-compact/.test(part) && /\.ghost-badge/.test(part)),
        `"${part.trim()}" hides an attention badge on a minimized control`,
      );
    }
  }
});

