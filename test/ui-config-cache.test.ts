import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// What is at stake: this is the rescue path for settings the product's own renames
// stranded, and it only ever runs once per machine.
//
// The dashboard's preferences were per-setting localStorage keys under three product
// names in turn - `ai-harness.` (6862653), `fleet-control.` (52f220f), `mission-control.`
// - and each rename left the previous generation unreadable. The fallback that shipped
// knew about ONE generation, and named the wrong one, so it could never fire. Walking
// every generation newest-first is what makes adoption correct, and getting it wrong here
// is silent: the operator just sees defaults and assumes they chose them.

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

const { readCache, readLegacySettings, writeCache } = await import("../src/web/lib/uiCache.ts");

beforeEach(() => store.clear());

test("nothing stored anywhere reads as the shipped defaults", () => {
  const config = readCache();
  assert.equal(config.layout, "console");
  assert.equal(config.conversationView, "terminal");
  // Condensed, which is deliberately NOT the no-op default - see `UI_CONFIG_DEFAULTS`.
  // Pinned here because this one line decides the Line's band height for every profile
  // that has never touched the control.
  assert.equal(config.lineDensity, "condensed");
  assert.equal(config.richText, true);
  assert.deepEqual(config.alerts, { notifications: false, sound: true });
  assert.equal(config.keybindingHints, true);
  assert.equal(config.guidedDispatch, true);
  assert.equal(config.guidedTour, true);
  // NOT empty. The shipped default is "the card the previous release drew", and `worktree`
  // is the one registry item no card drew before - so it ships hidden and an upgrade moves
  // nothing on screen. See `UI_CONFIG_DEFAULTS` for the whole reasoning.
  assert.deepEqual(config.hiddenDisplayItems, ["worktree"]);
});

test("a written cache round-trips", () => {
  writeCache({
    layout: "console",
    conversationView: "chat",
    lineDensity: "expanded",
    keybindings: { select: "shift+Tab" },
    alerts: { notifications: true, sound: false },
    richText: false,
    keybindingHints: false,
    guidedDispatch: false,
    guidedTour: false,
    trustStaged: ["/work/staged"],
    hiddenDisplayItems: ["cost"],
    // FALSE, deliberately, because this field's default is true: a cache that read a stored
    // `false` with `||` would hand back the default and re-group the board on every cold paint
    // for the one operator who turned it off. Asserting the non-default value is the only way
    // round-tripping this field says anything.
    groupBoardByRepo: false,
  });
  const config = readCache();
  assert.equal(config.layout, "console");
  assert.equal(config.conversationView, "chat");
  assert.equal(config.lineDensity, "expanded");
  assert.deepEqual(config.keybindings, { select: "shift+Tab" });
  assert.deepEqual(config.alerts, { notifications: true, sound: false });
  assert.equal(config.richText, false);
  assert.equal(config.keybindingHints, false);
  assert.equal(config.guidedDispatch, false);
  assert.equal(config.guidedTour, false);
  assert.deepEqual(config.trustStaged, ["/work/staged"]);
  assert.deepEqual(config.hiddenDisplayItems, ["cost"]);
  assert.equal(config.groupBoardByRepo, false);
});

test("a preference this cache forgets to copy would reset on every cold paint", () => {
  // `coerce` picks field by field on purpose (see its comment), which makes an omitted
  // field the ONE failure mode this module has: it type-checks, it round-trips through the
  // daemon, and the setting silently snaps back to the default on every fresh load - only
  // on a cold cache, so never where you are looking. Named for `guidedDispatch` because it
  // is the newest field, and it is really a test of the copy.
  store.set("mission-control.ui", JSON.stringify({ guidedDispatch: false }));
  assert.equal(readCache().guidedDispatch, false, "the cached preference was dropped");

  // The same failure, for the newest field, in both directions - because this one has a
  // NON-empty default and so can be dropped two ways. A hidden item forgotten by `coerce`
  // comes back on the next cold paint, and an item the operator switched ON is hidden
  // again by a fallback that reaches for `[]` instead of the shipped default.
  store.set("mission-control.ui", JSON.stringify({ hiddenDisplayItems: ["cost", "model"] }));
  assert.deepEqual(readCache().hiddenDisplayItems, ["cost", "model"]);
  store.set("mission-control.ui", JSON.stringify({ hiddenDisplayItems: [] }));
  assert.deepEqual(
    readCache().hiddenDisplayItems,
    [],
    "a stored empty list is a real answer, not a miss",
  );

  // And the same failure for the density, where dropping the copy is VISIBLE rather than
  // merely wrong: the default is `condensed`, so an operator who chose `expanded` would
  // get a 38.5px strip on the first frame and an 86px one the moment the daemon answered,
  // stepping the whole conversation pane down a line on every cold load.
  store.set("mission-control.ui", JSON.stringify({ lineDensity: "expanded" }));
  assert.equal(readCache().lineDensity, "expanded", "the cached density was dropped");
});

test("the hidden list is handed back as a fresh array the panel can build a patch from", () => {
  // Same rule `trustStaged` follows: the default is a shared frozen literal, and the panel
  // computes its next patch from what it reads here. Mutating the constant would change
  // the default for every later cold paint in this process.
  store.set("mission-control.ui", JSON.stringify({ hiddenDisplayItems: ["cost"] }));
  readCache().hiddenDisplayItems.push("model");
  assert.deepEqual(readCache().hiddenDisplayItems, ["cost"]);
  store.clear();
  readCache().hiddenDisplayItems.push("goal");
  assert.deepEqual(readCache().hiddenDisplayItems, ["worktree"]);
});

test("a rendering this build does not ship reads as the shipped one", () => {
  // Same rule the layout has, and for the same reason: a hand-edit or a mode from a future
  // build must not be adopted out of this cache and PUT to the daemon as if it were real.
  store.set("mission-control.ui", JSON.stringify({ conversationView: "hologram" }));
  assert.equal(readCache().conversationView, "terminal");
});

test("a density this build does not ship reads as the shipped one", () => {
  // The third member the study drew and held in reserve - `hidden`, at zero height - is
  // the realistic version of this: a profile that used a build which shipped it must not
  // paint a strip this build cannot draw, and must not PUT the value back as if it were
  // real. It falls to the shipped default, which is a strip you can see.
  store.set("mission-control.ui", JSON.stringify({ lineDensity: "hidden" }));
  assert.equal(readCache().lineDensity, "condensed");
});

test("a corrupt cache falls back to the defaults instead of throwing", () => {
  // A half-written value must cost a fetch, never a crash on the first paint.
  store.set("mission-control.ui", "{not json");
  assert.equal(readCache().layout, "console");
});

test("no legacy settings on this origin reports nothing, not empty defaults", () => {
  // The caller only PUTs a real find. "Found, and it says use the defaults" has to stay
  // distinguishable from "found nothing", or every cold origin would write to the daemon.
  assert.equal(readLegacySettings(), null);
});

test("settings from any generation of the product name are adopted", () => {
  store.set("ai-harness.layout", "board");
  const found = readLegacySettings();
  assert.ok(found, "a pre-rename setting was left behind");
  assert.equal(found.layout, "board");
});

test("the newest generation wins when several are present", () => {
  // A machine that lived through both renames has all three. The last one the operator
  // actually used is the newest, so it takes precedence rather than being overwritten.
  store.set("ai-harness.layout", "grid");
  store.set("fleet-control.layout", "console");
  store.set("mission-control.layout", "board");
  assert.equal(readLegacySettings()?.layout, "board");
});

test("a retired Cards preference is adopted as Console", () => {
  store.set("mission-control.ui", JSON.stringify({ layout: "grid" }));
  assert.equal(readCache().layout, "console");
  store.clear();
  store.set("mission-control.layout", "grid");
  assert.equal(readLegacySettings()?.layout, "console");
});

test("the generations are read per setting, not as one block", () => {
  // The renames landed at different times, so a machine can hold keybindings from one
  // generation and alerts from another. Picking a single generation would drop half.
  store.set("fleet-control.keybindings", JSON.stringify({ select: "shift+Tab" }));
  store.set("ai-harness.rich-text", "0");
  const found = readLegacySettings();
  assert.deepEqual(found?.keybindings, { select: "shift+Tab" });
  assert.equal(found?.richText, false);
});

test("dead fields from before away mode moved server-side are dropped", () => {
  // The stored alerts blob still carries `afk` and `digestMinutes` on old installs.
  // Forwarding them would store them in the daemon forever; nothing reads them.
  store.set(
    "fleet-control.alerts",
    JSON.stringify({ notifications: false, sound: true, afk: false, digestMinutes: 15 }),
  );
  const found = readLegacySettings();
  assert.deepEqual(found?.alerts, { notifications: false, sound: true });
});

test("an unrecognised layout is not adopted as if it were real", () => {
  // A mode from a future build (or a hand-edit) must not be PUT to the daemon looking
  // valid. Store the Console fallback the renderer will draw.
  store.set("mission-control.layout", "kanban");
  assert.equal(readLegacySettings()?.layout, "console");
});

test("a corrupt legacy value falls back rather than discarding the rest", () => {
  store.set("mission-control.keybindings", "{not json");
  store.set("mission-control.layout", "console");
  const found = readLegacySettings();
  assert.ok(found);
  assert.deepEqual(found.keybindings, {}, "a bad chord map should not survive");
  assert.equal(found.layout, "console", "one bad key discarded a good one");
});

test("rich text is only off when the old build explicitly wrote off", () => {
  // An unset key means "never chosen", which is the default (on) - not off.
  store.set("mission-control.rich-text", "1");
  assert.equal(readLegacySettings()?.richText, true);
  store.clear();
  store.set("mission-control.rich-text", "0");
  assert.equal(readLegacySettings()?.richText, false);
});
