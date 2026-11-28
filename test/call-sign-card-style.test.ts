import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The call sign on an Always-on card (Settings > Display > Board card > Call sign): the card
 * keeps the session's title and draws the call sign beside it, in one of four styles or not at
 * all. Subtitle line is the default. Push-to-talk still titles the card by its call sign.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

// A fake `localStorage` and an accepting fetch before the modules load, for the reason
// `task-kind-mark.test.ts` gives: `updateUiConfig` reverts a write the daemon refuses.
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
  value: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
});

const { SessionTile } = await import("../src/web/components/layouts/SessionTile.tsx");
const { RailRow } = await import("../src/web/components/layouts/RailRow.tsx");
const { BoardCardPanel } = await import("../src/web/components/BoardCardPanel.tsx");
const { FeatureFlagsContext } = await import("../src/web/useFeatureFlag.ts");
const { DISPLAY_CHOICES } = await import("../src/web/lib/board-card.ts");
const { updateUiConfig } = await import("../src/web/lib/uiConfig.ts");
const { CALL_SIGN_CARD_STYLES, UI_CONFIG_DEFAULTS, UiConfigPatchSchema, UiConfigSchema } = await import("../src/shared/protocol.ts");
const { voiceCardCallSignMode } = await import("../src/shared/voice.ts");
const { PREVIEW_CALL_SIGN } = await import("../src/web/lib/board-card-preview.ts");
const { mkSession, mkTaskSummary } = await import("./helpers/session-fixture.ts");

type Style = (typeof CALL_SIGN_CARD_STYLES)[number];
const TITLE = "Migrate the billing reconciliation job";

function session() {
  const task = mkTaskSummary({ kind: "ship", title: TITLE, callSign: "Juniper" });
  return mkSession({ name: TITLE, task });
}

async function withStyle<T>(style: Style, fn: () => T): Promise<T> {
  await updateUiConfig({ callSignCardStyle: style });
  try {
    return fn();
  } finally {
    await updateUiConfig({ callSignCardStyle: UI_CONFIG_DEFAULTS.callSignCardStyle });
  }
}

function tile(props: { callSign?: string; callSignElement?: string }): string {
  return renderToStaticMarkup(createElement(SessionTile, {
    session: session(), onOpen: () => {}, draggingRepo: null, onDropped: () => {}, onDropError: () => {}, onDropConfirm: () => {}, ...props,
  }));
}

function name(html: string): string {
  return /<span class="tile-name"[^>]*>([^<]*)<\/span>/.exec(html)?.[1] ?? "";
}

test("Always-on draws the call sign beside the title; Push-to-talk makes it the title; otherwise neither", () => {
  assert.equal(voiceCardCallSignMode({ mode: "listening" }), "element");
  assert.equal(voiceCardCallSignMode({ mode: "waiting-for-key", pushToTalkSession: "p" }), "title");
  assert.equal(voiceCardCallSignMode({ mode: "push-to-talk", pushToTalkSession: "p" }), "title");
  for (const mode of ["muted", "auto-muted", "off", "unavailable"] as const) {
    assert.equal(voiceCardCallSignMode({ mode }), null, mode);
  }
  assert.equal(voiceCardCallSignMode({ mode: "push-to-talk" }), null, "a hold during an Always-on auto-mute is not the dedicated mode");
});

test("Subtitle line is the default, stored and read leniently, and written strictly", () => {
  assert.equal(UI_CONFIG_DEFAULTS.callSignCardStyle, "subtitle");
  assert.deepEqual([...CALL_SIGN_CARD_STYLES], ["subtitle", "badge", "chip", "tab", "off"]);
  assert.equal(UiConfigSchema.parse({}).callSignCardStyle, "subtitle");
  assert.equal(UiConfigSchema.parse({ callSignCardStyle: "ribbon" }).callSignCardStyle, "subtitle", "a newer build's style reads as the default");
  assert.equal(UiConfigPatchSchema.safeParse({ callSignCardStyle: "ribbon" }).success, false);
  assert.equal(UiConfigPatchSchema.parse({ callSignCardStyle: "off" }).callSignCardStyle, "off");
});

test("every style keeps the session title and draws the call sign in its own place", async () => {
  const shapes: Record<Style, (html: string) => void> = {
    subtitle: (html) => assert.match(html, /<span class="tile-name-stack"[^>]*><span class="tile-name">[^<]*<\/span><span class="tile-name-sub cs-mark cs-sub">[\s\S]*Say <\/span><b>Juniper<\/b>/),
    badge: (html) => assert.match(html, /<span class="tile-name"[^>]*>[^<]*<\/span>[\s\S]*<span class="cs-mark cs-badge">[\s\S]*Juniper<\/span>/),
    chip: (html) => assert.match(html, /<span class="cs-mark cs-chip">[\s\S]*Juniper<\/span>[\s\S]*<span class="tile-name"/),
    tab: (html) => {
      assert.match(html, /<span class="tile-edge-tabs"[^>]*><span class="tk-mark tk-tab"[\s\S]*<span class="cs-mark cs-tab">[\s\S]*Juniper<\/span><\/span>/);
      assert.match(html, /class="tile [^"]*has-kind-tab/);
    },
    off: (html) => assert.doesNotMatch(html, /cs-mark|Juniper/),
  };
  for (const style of CALL_SIGN_CARD_STYLES) {
    const html = await withStyle(style, () => tile({ callSignElement: "Juniper" }));
    assert.equal(name(html), TITLE, `${style} keeps the session title`);
    assert.match(html, /aria-label="Open Migrate the billing reconciliation job"/, `${style}: the open button names the title`);
    if (style !== "off") assert.match(html, /<span class="sr-only">Call sign <\/span>/, `${style} reads as a call sign`);
    shapes[style](html);
  }
});

test("Push-to-talk's title is the call sign whatever the style, and draws no second copy", async () => {
  for (const style of CALL_SIGN_CARD_STYLES) {
    const html = await withStyle(style, () => tile({ callSign: "Juniper" }));
    assert.equal(name(html), "Juniper", style);
    assert.doesNotMatch(html, /cs-mark/, style);
  }
});

test("the Console rail row draws one compact pill for every style but Off", async () => {
  const row = (style: Style) => withStyle(style, () => renderToStaticMarkup(createElement(RailRow, {
    session: session(), selected: false, onSelect: () => {}, callSignElement: "Juniper",
  })));
  for (const style of ["subtitle", "badge", "chip", "tab"] as const) {
    const html = await row(style);
    assert.match(html, /<span class="rail-name has-call-sign"[^>]*><span class="rail-name-text">Migrate the billing reconciliation job<\/span><span class="cs-mark cs-rail">/, style);
    assert.match(html, /aria-label="Migrate the billing reconciliation job"/, `${style}: the row is still named by its title`);
  }
  const off = await row("off");
  assert.doesNotMatch(off, /cs-mark|has-call-sign/);
});

test("the Display panel offers the five styles as one radio group behind the voice flag, with a preview card", async () => {
  const choice = DISPLAY_CHOICES.find((candidate) => candidate.key === "callSignCardStyle")!;
  assert.equal(choice.group, "card");
  assert.deepEqual(choice.options.map((option) => option.label), ["Subtitle line", "Trailing badge", "Leading chip", "Edge tab", "Off"]);
  const render = (voice: boolean) => renderToStaticMarkup(createElement(FeatureFlagsContext.Provider,
    { value: { enableAll: false, overrides: { voice } } }, createElement(BoardCardPanel)));

  const hidden = render(false);
  assert.doesNotMatch(hidden, /display-choice-callSignCardStyle/, "voice off: nothing to choose");
  assert.doesNotMatch(hidden, new RegExp(PREVIEW_CALL_SIGN));

  const shown = render(true);
  assert.match(shown, /role="radiogroup" aria-label="Board card: Call sign"/);
  assert.equal(shown.match(/name="display-choice-callSignCardStyle"/g)?.length, 5);
  assert.match(shown, /name="display-choice-callSignCardStyle" checked="" value="subtitle"/);
  assert.match(shown, /cs-mark cs-sub[\s\S]*Juniper/, "the preview draws the default");

  const tabbed = await withStyle("tab", () => render(true));
  assert.match(tabbed, /name="display-choice-callSignCardStyle" checked="" value="tab"/);
  assert.match(tabbed, /cs-mark cs-tab[\s\S]*Juniper/, "the preview follows the choice");
});
