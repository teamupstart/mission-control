import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// `createElement` rather than JSX because the runner's glob only matches .test.ts.

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
const { RailRow } = await import("../src/web/components/layouts/RailRow.tsx");
const { mkSession } = await import("./helpers/session-fixture.ts");

type Style = (typeof RESIDENT_CARD_NAME_STYLES)[number];
type Mark = typeof PREVIEW_RESIDENT;

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

function tile(resident: Mark | null, flag = true, callSign?: string): string {
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
      callSign,
    }),
  );
}

function railRow(resident: Mark | null, callSign?: string): string {
  return withFlags(true, createElement(RailRow, {
    session: mkSession({ name: "triage-loop", state: "idle" }),
    selected: false,
    onSelect: () => {},
    resident,
    callSign,
  }));
}

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

test("the card adds the profile name only while its title is a call sign that says something else", () => {
  assert.equal(residentCardProfileName(CALLED), "Triage Bot");
  assert.equal(residentCardProfileName(PREVIEW_RESIDENT), null);
  assert.equal(residentCardProfileName(null), null);
  assert.equal(residentCardProfileName(undefined), null);
  assert.equal(residentCardProfileName({ ...PREVIEW_RESIDENT, listeningTitle: '"triage  bot"' }), null);
  assert.equal(residentCardProfileName({ ...PREVIEW_RESIDENT, name: "  ", listeningTitle: '"Scout"' }), null);
});

test("Resident name with call sign ships with no style on, is a backed-up setting, and stores each style once in order", () => {
  assert.deepEqual(UI_CONFIG_DEFAULTS.residentCardNameStyles, []);
  assert.deepEqual([...RESIDENT_CARD_NAME_STYLES], ["subtitle", "chip"]);
  assert.deepEqual(UiConfigSchema.parse({}).residentCardNameStyles, []);
  assert.deepEqual(UiConfigSchema.parse({ residentCardNameStyles: ["chip", "subtitle", "chip"] }).residentCardNameStyles, ["subtitle", "chip"]);
  assert.deepEqual(UiConfigSchema.parse({ residentCardNameStyles: ["tooltip", "chip"] }).residentCardNameStyles, ["chip"]);
  assert.deepEqual(UiConfigSchema.parse({ residentCardNameStyles: "chip" }).residentCardNameStyles, []);
  assert.equal(UiConfigPatchSchema.safeParse({ residentCardNameStyles: ["tooltip"] }).success, false);
  assert.equal(UiConfigPatchSchema.safeParse({ residentCardNameStyles: "chip" }).success, false);
  const both = UiConfigPatchSchema.safeParse({ residentCardNameStyles: ["chip", "subtitle"] });
  assert.ok(both.success);
  assert.deepEqual(both.data.residentCardNameStyles, ["subtitle", "chip"]);
  assert.equal(UiConfigPatchSchema.safeParse({ residentCardNameStyles: [] }).success, true);
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
  assert.ok(!DISPLAY_CHOICES.some((choice) => (choice.key as string) === "residentCardNameStyles"));
});

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
    plain(await withStyles(styles, () => head(tile(CALLED, false))));
    const uncalled = await withStyles(styles, () => head(tile(PREVIEW_RESIDENT)));
    plain(uncalled);
    assert.match(uncalled, /<span class="tile-name"[^>]*>triage-loop<\/span>/);
    plain(await withStyles(styles, () => head(tile(null))));
  }
});

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
  assert.match(none, /<span class="tile-name"[^>]*>&quot;Scout&quot;<\/span>/, "the preview is not titled by the call sign");
  assert.ok(!none.includes("tile-name-sub"));

  const both = await withStyles(["subtitle", "chip"], () => withFlags(true, createElement(BoardCardPanel)));
  const checked = both.slice(both.indexOf('aria-label="Board card: Resident name with call sign"'));
  assert.equal((checked.slice(0, checked.indexOf("</div>")).match(/checked=""/g) ?? []).length, 2, "both checkboxes are not checked");
  assert.ok(both.includes('<span class="tile-name-sub">Triage Bot</span>'), "the preview has no subtitle");
  assert.ok(both.includes("resident-chip has-expanded-name"), "the preview chip does not expand");
});

test("a card's title, its Open label and its rail row name an agent by one precedence: listening title, call sign, ordinary name", () => {
  const cases: [Mark | null, string | undefined, string][] = [
    // A resident task never carries a call sign today (`sessionCallSign`); if one ever did, every
    // surface would still agree on the resident's listening title.
    [CALLED, "Atlas", "&quot;Scout&quot;"],
    [null, "Atlas", "Atlas"],
    [null, undefined, "triage-loop"],
  ];
  for (const [resident, callSign, name] of cases) {
    const card = tile(resident, true, callSign);
    assert.match(card, new RegExp(`<span class="tile-name"[^>]*>${name}</span>`), `tile title for ${callSign ?? "no call sign"}`);
    assert.match(card, new RegExp(`aria-label="Open ${name}"`), `Open label for ${callSign ?? "no call sign"}`);
    assert.match(railRow(resident, callSign), new RegExp(`aria-label="${name}"`), `rail row for ${callSign ?? "no call sign"}`);
  }
});
