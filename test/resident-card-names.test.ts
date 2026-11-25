import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Settings > Display > Board card > Resident name with call sign: a resident's board card keeps
 * the call sign (reference name) it answers to as its title, and shows the resident's profile
 * name beside it as a muted Subtitle, inside an Expanding chip, or both - each style its own
 * checkbox. Offered only while the `resident-card-names` preview is on; the stored styles are
 * ignored, not erased, while it is off.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

// A fake `localStorage` and a fetch that accepts, installed BEFORE the modules below are
// imported, for the reason `board-card-items.test.ts` gives: `updateUiConfig` reverts its
// optimistic commit when the daemon refuses.
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

const { RESIDENT_CARD_NAME_STYLES, UI_CONFIG_DEFAULTS, UiConfigPatchSchema, UiConfigSchema } = await import(
  "../src/shared/protocol.ts"
);
const { FEATURE_FLAGS, RESIDENT_CARD_NAMES_FLAG_ID } = await import("../src/shared/feature-flag-registry.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { DISPLAY_CHOICES, RESIDENT_CARD_NAME_SETTING, setResidentCardNameStyle } = await import(
  "../src/web/lib/board-card.ts"
);
const { uiConfig: getUiConfig, updateUiConfig } = await import("../src/web/lib/uiConfig.ts");
const { PREVIEW_RESIDENT } = await import("../src/web/lib/board-card-preview.ts");
const { residentCardProfileName } = await import("../src/web/residents/marker.ts");
const { FeatureFlagsContext } = await import("../src/web/useFeatureFlag.ts");
const { BoardCardPanel } = await import("../src/web/components/BoardCardPanel.tsx");
const { SessionTile } = await import("../src/web/components/layouts/SessionTile.tsx");
const { mkSession } = await import("./helpers/session-fixture.ts");

type Style = (typeof RESIDENT_CARD_NAME_STYLES)[number];
type Mark = typeof PREVIEW_RESIDENT;

/** "Triage Bot", answering to "Scout", as a listening resident with a reference name does. */
const CALLED: Mark = { ...PREVIEW_RESIDENT, listeningTitle: '"Scout"' };

const FLAG_ON = { enableAll: false, overrides: { [RESIDENT_CARD_NAMES_FLAG_ID]: true } };
const FLAG_OFF = { enableAll: false, overrides: {} };

function withFlags(on: boolean, element: ReactElement): string {
  return renderToStaticMarkup(createElement(FeatureFlagsContext.Provider, { value: on ? FLAG_ON : FLAG_OFF }, element));
}

async function withStyles<T>(styles: Style[], fn: () => T): Promise<T> {
  await updateUiConfig({ residentCardNameStyles: styles });
  try {
    return fn();
  } finally {
    await updateUiConfig({ residentCardNameStyles: [...UI_CONFIG_DEFAULTS.residentCardNameStyles] });
  }
}

function tile(resident: Mark | null, flag = true): string {
  return withFlags(
    flag,
    createElement(SessionTile, {
      session: mkSession({ name: "triage-loop", state: "idle" }),
      onOpen: () => {},
      draggingRepo: null,
      onDropped: () => {},
      onDropError: () => {},
      onDropConfirm: () => {},
      resident,
    }),
  );
}

/** The tile's head: from its opening tag to the loop status row that follows it. */
function head(html: string): string {
  const start = html.indexOf('class="tile-head');
  assert.ok(start >= 0, "no tile head in the render");
  const end = html.indexOf('class="resident-card-loop"', start);
  return html.slice(start, end < 0 ? undefined : end);
}

const SUBTITLE =
  /<span class="tile-name-stack"[^>]*><span class="tile-name">&quot;Scout&quot;<\/span><span class="tile-name-sub">Triage Bot<\/span><\/span>/;
const CHIP =
  /<span class="resident-chip has-expanded-name"[^>]*>.*<span class="resident-chip-name" aria-hidden="true"><span class="resident-chip-name-sep">·<\/span>Triage Bot<\/span><\/span>/;

// ---- which name the card adds ----

test("the card adds the profile name only while its title is a call sign that says something else", () => {
  assert.equal(residentCardProfileName(CALLED), "Triage Bot");
  // Titled by the session name: voice is not listening, or the profile has no reference name.
  assert.equal(residentCardProfileName(PREVIEW_RESIDENT), null);
  assert.equal(residentCardProfileName(null), null);
  assert.equal(residentCardProfileName(undefined), null);
  // The call sign already says the profile name, in any case or spacing: nothing to repeat.
  assert.equal(residentCardProfileName({ ...PREVIEW_RESIDENT, listeningTitle: '"triage  bot"' }), null);
  assert.equal(residentCardProfileName({ ...PREVIEW_RESIDENT, name: "  ", listeningTitle: '"Scout"' }), null);
});

// ---- the stored setting ----

test("Resident name with call sign ships with no style on, is a backed-up setting, and stores each style once in order", () => {
  assert.deepEqual(UI_CONFIG_DEFAULTS.residentCardNameStyles, []);
  assert.deepEqual([...RESIDENT_CARD_NAME_STYLES], ["subtitle", "chip"]);
  assert.deepEqual(UiConfigSchema.parse({}).residentCardNameStyles, []);
  assert.deepEqual(UiConfigSchema.parse({ residentCardNameStyles: ["chip", "subtitle", "chip"] }).residentCardNameStyles, ["subtitle", "chip"]);
  // A style a newer build stored is dropped after a downgrade, keeping the ones this build
  // knows, and a value that is not a list reads as none rather than failing the record.
  assert.deepEqual(UiConfigSchema.parse({ residentCardNameStyles: ["tooltip", "chip"] }).residentCardNameStyles, ["chip"]);
  assert.deepEqual(UiConfigSchema.parse({ residentCardNameStyles: "chip" }).residentCardNameStyles, []);
  // A write is strict: an unknown style is refused, never dropped silently.
  assert.equal(UiConfigPatchSchema.safeParse({ residentCardNameStyles: ["tooltip"] }).success, false);
  assert.equal(UiConfigPatchSchema.safeParse({ residentCardNameStyles: "chip" }).success, false);
  const both = UiConfigPatchSchema.safeParse({ residentCardNameStyles: ["chip", "subtitle"] });
  assert.ok(both.success);
  assert.deepEqual(both.data.residentCardNameStyles, ["subtitle", "chip"]);
  assert.equal(UiConfigPatchSchema.safeParse({ residentCardNameStyles: [] }).success, true);
  // A write may repeat each style up to twice (four entries) and is stored once each in order;
  // a fifth entry is refused as too long before anything is normalised.
  const four = UiConfigPatchSchema.safeParse({ residentCardNameStyles: ["chip", "subtitle", "chip", "subtitle"] });
  assert.ok(four.success, "a four-entry write was refused");
  assert.deepEqual(four.data.residentCardNameStyles, ["subtitle", "chip"]);
  const five = UiConfigPatchSchema.safeParse({ residentCardNameStyles: ["chip", "subtitle", "chip", "subtitle", "chip"] });
  assert.equal(five.success, false, "a five-entry write was accepted");
  const tooLong = five.error?.issues.find((issue) => issue.path.includes("residentCardNameStyles"));
  assert.equal(tooLong?.code, "too_big", `refused for ${JSON.stringify(five.error?.issues)}`);
  assert.equal((tooLong as { maximum?: number } | undefined)?.maximum, RESIDENT_CARD_NAME_STYLES.length * 2);
  assert.equal(APP_CONFIG_ENTRIES.ui.classification.fields.residentCardNameStyles, "setting");
});

test("each checkbox turns its own style on and off and leaves the other as it is", async () => {
  try {
    setResidentCardNameStyle([], "chip", true);
    assert.deepEqual(getUiConfig().residentCardNameStyles, ["chip"]);
    setResidentCardNameStyle(["chip"], "subtitle", true);
    assert.deepEqual(getUiConfig().residentCardNameStyles, ["subtitle", "chip"]);
    setResidentCardNameStyle(["subtitle", "chip"], "chip", false);
    assert.deepEqual(getUiConfig().residentCardNameStyles, ["subtitle"]);
    setResidentCardNameStyle(["subtitle"], "subtitle", false);
    assert.deepEqual(getUiConfig().residentCardNameStyles, []);
  } finally {
    await updateUiConfig({ residentCardNameStyles: [] });
  }
});

test("the resident-card-names flag is a preview, and offers the Resident name with call sign checkboxes", () => {
  const flag = FEATURE_FLAGS.find((definition) => definition.id === RESIDENT_CARD_NAMES_FLAG_ID);
  assert.equal(flag?.stage, "preview");
  assert.equal(RESIDENT_CARD_NAME_SETTING.flag, RESIDENT_CARD_NAMES_FLAG_ID);
  assert.equal(RESIDENT_CARD_NAME_SETTING.label, "Resident name with call sign");
  assert.deepEqual(RESIDENT_CARD_NAME_SETTING.options.map((option) => [option.id, option.label]), [
    ["subtitle", "Subtitle"],
    ["chip", "Expanding chip"],
  ]);
  // Not one of the radio choices: its styles combine.
  assert.ok(!DISPLAY_CHOICES.some((choice) => (choice.key as string) === "residentCardNameStyles"));
});

// ---- the board card ----

test("Subtitle keeps the call sign as the card's title and puts the profile name on a line under it", async () => {
  const html = await withStyles(["subtitle"], () => head(tile(CALLED)));
  assert.match(html, /^class="tile-head has-name-sub"/);
  assert.match(html, SUBTITLE);
  assert.ok(!html.includes("resident-chip-name"), "Subtitle alone also expanded the chip");
});

test("Expanding chip puts the profile name inside the resident's chip and leaves the title alone", async () => {
  const html = await withStyles(["chip"], () => head(tile(CALLED)));
  assert.match(html, CHIP);
  assert.match(html, /<span class="tile-name"[^>]*>&quot;Scout&quot;<\/span>/);
  assert.ok(!html.includes("tile-name-sub"), "Expanding chip alone also drew a subtitle");
  // The chip is still named by its sentence, which already says the resident's name.
  assert.match(html, /role="img" aria-label="Resident Triage Bot/);
});

test("both styles on draw the subtitle and the expanding chip together", async () => {
  const html = await withStyles(["subtitle", "chip"], () => head(tile(CALLED)));
  assert.match(html, /^class="tile-head has-name-sub"/);
  assert.match(html, SUBTITLE);
  assert.match(html, CHIP);
});

test("no style, the flag off, or a card titled by its session name all draw the call sign alone, as before", async () => {
  const plain = (html: string) => {
    assert.ok(!html.includes("tile-name-sub"), "a subtitle was drawn");
    assert.ok(!html.includes("resident-chip-name"), "the chip was expanded");
    assert.ok(!html.includes("has-name-sub"), "the head was laid out for a subtitle");
  };
  plain(await withStyles([], () => head(tile(CALLED))));
  for (const styles of [["subtitle"], ["chip"], ["subtitle", "chip"]] as Style[][]) {
    // The preview flag off ignores the stored styles without erasing them.
    plain(await withStyles(styles, () => head(tile(CALLED, false))));
    // No call sign: the title is the session name, and the profile name is not added to it.
    const uncalled = await withStyles(styles, () => head(tile(PREVIEW_RESIDENT)));
    plain(uncalled);
    assert.match(uncalled, /<span class="tile-name"[^>]*>triage-loop<\/span>/);
    // Not a resident at all.
    plain(await withStyles(styles, () => head(tile(null))));
  }
});

// ---- the Settings panel ----

test("the panel offers two checkboxes only while the flag is on, and its preview answers them", async () => {
  assert.ok(!withFlags(false, createElement(BoardCardPanel)).includes("Resident name with call sign"));

  const none = withFlags(true, createElement(BoardCardPanel));
  assert.match(none, /role="group" aria-label="Board card: Resident name with call sign"/);
  const group = none.slice(none.indexOf('aria-label="Board card: Resident name with call sign"'));
  const boxes = group.slice(0, group.indexOf("</div>"));
  assert.equal((boxes.match(/type="checkbox"/g) ?? []).length, 2, "not one checkbox per style");
  assert.ok(!boxes.includes('type="radio"'), "the styles are offered as radios");
  assert.ok(!boxes.includes("checked"), "a style is on by default");
  for (const label of ["Subtitle", "Expanding chip"]) assert.ok(boxes.includes(`${label}</label>`), `no ${label} checkbox`);
  // With the flag on, the preview resident answers to a call sign, so no style shows it alone.
  assert.match(none, /<span class="tile-name"[^>]*>&quot;Scout&quot;<\/span>/, "the preview is not titled by the call sign");
  assert.ok(!none.includes("tile-name-sub"));

  const both = await withStyles(["subtitle", "chip"], () => withFlags(true, createElement(BoardCardPanel)));
  const checked = both.slice(both.indexOf('aria-label="Board card: Resident name with call sign"'));
  assert.equal((checked.slice(0, checked.indexOf("</div>")).match(/checked=""/g) ?? []).length, 2, "both checkboxes are not checked");
  assert.ok(both.includes('<span class="tile-name-sub">Triage Bot</span>'), "the preview has no subtitle");
  assert.ok(both.includes("resident-chip has-expanded-name"), "the preview chip does not expand");
});
