import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_CONFIG_ENTRIES } from "../src/shared/app-config-entries.ts";

// What is at stake: the dashboard's preferences have to be durable, and the dashboard has
// to be able to tell "never configured" from "configured to the defaults".
//
// That distinction is the whole safety of the one-time adoption. On a cold origin the web
// app offers whatever an older product name left in localStorage; if it ran against a
// daemon that already had a config, a stray from two renames ago would overwrite the
// settings actually in use. An unset key parses to the defaults, so the config alone
// cannot carry the difference - `configured` does. Real db, so the round-trip through
// zod's defaults is exercised rather than mocked. Mirrors harnesses-config.test.ts.

const home = mkdtempSync(join(tmpdir(), "mission-ui-cfg-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { getAppConfig, openDb, setAppConfig } = await import("../src/server/db.ts");
const { getUiConfig, setUiConfig, uiConfigView } = await import("../src/server/ui-config.ts");
const { DISPLAY_ITEM_SEEDS, UI_CONFIG_DEFAULTS } = await import(
  "../src/shared/protocol.ts",
);

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
});

test("an unset key reads as the shipped defaults", () => {
  const config = getUiConfig();
  assert.equal(config.layout, "board");
  assert.equal(config.conversationView, "terminal");
  assert.equal(config.richText, true);
  assert.deepEqual(config.alerts, { notifications: false, sound: true });
  assert.deepEqual(config.keybindings, {});
  assert.equal(config.keybindingHints, true);
  assert.equal(config.guidedDispatch, true);
  assert.equal(config.guidedTour, true);
});

test("an existing profile before guided-tour onboarding remains off after upgrade", () => {
  // A stored record identifies an upgraded profile, unlike an absent record for a new profile.
  // The upgrade writes the explicit off value back so later reads retain that distinction.
  setAppConfig(APP_CONFIG_ENTRIES.ui, { layout: "board" });
  const upgraded = getUiConfig();
  assert.equal(upgraded.guidedDispatch, true);
  assert.equal(upgraded.guidedTour, false);
  assert.equal(
    (getAppConfig(APP_CONFIG_ENTRIES.ui) as Record<string, unknown>).guidedTour,
    false,
  );
  setUiConfig({ guidedDispatch: false });
  const config = getUiConfig();
  assert.equal(config.guidedDispatch, false);
  assert.equal(config.guidedTour, false);
  assert.equal(config.layout, "board", "an unrelated patch cleared the layout");
});

test("the conversation rendering round-trips, and an unknown one is refused", () => {
  // Stored as a named mode rather than a boolean, so the daemon can reject a value this
  // build does not ship instead of coercing it to "not chat".
  setUiConfig({ conversationView: "chat" });
  assert.equal(getUiConfig().conversationView, "chat");
  assert.throws(() => setUiConfig({ conversationView: "hologram" } as never));
  assert.equal(getUiConfig().conversationView, "chat", "a refused patch changed the store");
});

test("the skin defaults to Default, round-trips, and only a shipped id can be written", async () => {
  const { UiConfigPatchSchema, UiConfigSchema } = await import("../src/shared/protocol.ts");
  assert.equal(getUiConfig().skin, "default", "a missing key reads as today's look");
  setUiConfig({ skin: "daylight" });
  assert.equal(getUiConfig().skin, "daylight");
  // Strict on write, at the route's schema and at the store: a bad id is refused, never
  // stored as Default by the read schema's fallback.
  assert.equal(UiConfigPatchSchema.safeParse({ skin: "nope" }).success, false);
  assert.equal(UiConfigPatchSchema.safeParse({ skin: "daylight" }).success, true);
  assert.throws(() => setUiConfig({ skin: "nope" } as never));
  assert.equal(getUiConfig().skin, "daylight", "a refused skin changed the store");
  // Tolerant on read: a skin written by a newer build (a downgrade) opens as Default, and the
  // rest of the record survives it.
  setAppConfig(APP_CONFIG_ENTRIES.ui, { skin: "from-a-newer-build", layout: "console" });
  assert.equal(getUiConfig().skin, "default");
  assert.equal(getUiConfig().layout, "console", "an unknown skin failed the whole ui record");
  assert.equal(UiConfigSchema.parse({ skin: 42 }).skin, "default");
});

test("every skin write keeps the desktop window's launch colour, browser or desktop alike", async () => {
  // A browser tab has no desktop bridge, so the daemon is the one place every skin write passes
  // through. Without this, Daylight chosen in a browser would open the next desktop launch on a
  // dark frame.
  const { readFileSync, rmSync: remove, existsSync } = await import("node:fs");
  const { syncWindowBackground } = await import("../src/server/ui-config.ts");
  const launch = join(home, "state", "window-background.json");
  const color = (): string => (JSON.parse(readFileSync(launch, "utf8")) as { color: string }).color;
  remove(launch, { force: true });

  setUiConfig({ skin: "daylight" });
  assert.equal(color(), "#f5f7fa", "picking Daylight left no launch colour for the shell");
  setUiConfig({ skin: "default" });
  assert.equal(color(), "#0a0c0f");

  // A write that is not about the skin leaves the file alone.
  remove(launch);
  setUiConfig({ richText: false });
  assert.equal(existsSync(launch), false, "an unrelated preference rewrote the launch colour");

  // Startup and post-restore reconciliation read whatever is stored, however it got there.
  setAppConfig(APP_CONFIG_ENTRIES.ui, { skin: "daylight" });
  syncWindowBackground();
  assert.equal(color(), "#f5f7fa");
});

test("a malformed field elsewhere cannot abort startup or fail the page, and a valid skin survives it", async () => {
  // Startup and the dashboard document read the skin outside any settings request. A strict
  // parse of the whole record would throw on one bad field and take the daemon or every page
  // load down with it; reading the skin alone keeps a valid Daylight in force.
  const { readFileSync, rmSync: remove } = await import("node:fs");
  const { storedSkin, syncWindowBackground } = await import("../src/server/ui-config.ts");
  const launch = join(home, "state", "window-background.json");
  const color = (): string => (JSON.parse(readFileSync(launch, "utf8")) as { color: string }).color;

  setAppConfig(APP_CONFIG_ENTRIES.ui, { skin: "daylight", layout: "hologram" } as never);
  assert.throws(() => getUiConfig(false), "the premise: a strict parse of this record throws");
  assert.equal(storedSkin(), "daylight");
  remove(launch, { force: true });
  assert.doesNotThrow(() => syncWindowBackground());
  assert.equal(color(), "#f5f7fa", "startup did not record the valid stored skin");

  // An unknown skin, or a record that is not an object at all, reads as Default and never throws.
  setAppConfig(APP_CONFIG_ENTRIES.ui, { skin: "from-a-newer-build", layout: "hologram" } as never);
  assert.equal(storedSkin(), "default");
  setAppConfig(APP_CONFIG_ENTRIES.ui, "not an object" as never);
  assert.equal(storedSkin(), "default");
  assert.doesNotThrow(() => syncWindowBackground());
  assert.equal(color(), "#0a0c0f");
});

test("a launch colour that cannot be written never fails the skin write or startup", async (t) => {
  // The launch colour is a convenience for the next desktop launch; the skin choice is the
  // setting. A failed write - a full disk, a read-only state home, something in the way - must
  // leave the skin saved and the caller unharmed. A non-empty directory where the file belongs
  // makes the atomic rename fail on every platform, with no permission trick root would ignore.
  const { mkdirSync, writeFileSync: write, rmSync: remove, statSync } = await import("node:fs");
  const { syncWindowBackground } = await import("../src/server/ui-config.ts");
  const launch = join(home, "state", "window-background.json");
  remove(launch, { recursive: true, force: true });
  mkdirSync(launch, { recursive: true });
  write(join(launch, "occupied"), "");
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => void warnings.push(args));
  try {
    setUiConfig({ skin: "default" });
    warnings.length = 0;

    assert.doesNotThrow(() => setUiConfig({ skin: "daylight" }), "a failed launch-colour write failed the skin write");
    assert.equal(getUiConfig().skin, "daylight", "the skin was not saved when its launch colour could not be");
    assert.doesNotThrow(() => syncWindowBackground(), "a failed launch-colour write would abort daemon startup");
    assert.ok(statSync(launch).isDirectory(), "the premise: the launch file really could not be written");
    assert.equal(warnings.length, 2, "each failed write is reported, not swallowed silently");
    assert.match(String(warnings[0]![0]), /could not remember the window background/);
  } finally {
    remove(launch, { recursive: true, force: true });
  }
});

test("a skin from a newer build survives unrelated writes in this one, and a real choice replaces it", () => {
  // After a downgrade, a skin this build does not ship reads as Default - but it must not be
  // WRITTEN as Default by a write that was not about the skin, or the operator loses their
  // choice for good on the next upgrade.
  const raw = (): unknown => (getAppConfig(APP_CONFIG_ENTRIES.ui) as { skin?: unknown }).skin;
  setAppConfig(APP_CONFIG_ENTRIES.ui, { skin: "skin-from-a-newer-build", layout: "console", guidedTour: false } as never);
  assert.equal(getUiConfig().skin, "default", "an unknown skin still reads as Default");

  setUiConfig({ richText: false });
  assert.equal(raw(), "skin-from-a-newer-build", "an unrelated setting erased the newer build's skin");
  assert.equal(getUiConfig().richText, false, "the unrelated setting itself was saved");

  // This module's own migration write keeps it too: a record without the guidedTour key is
  // rewritten on read.
  setAppConfig(APP_CONFIG_ENTRIES.ui, { skin: "skin-from-a-newer-build", layout: "console" } as never);
  getUiConfig();
  assert.equal((getAppConfig(APP_CONFIG_ENTRIES.ui) as { guidedTour?: unknown }).guidedTour, false, "the premise: the migration wrote");
  assert.equal(raw(), "skin-from-a-newer-build", "the migration write erased the newer build's skin");

  // Choosing a skin in this build is a real choice and replaces it; so does choosing Default.
  setUiConfig({ skin: "daylight" });
  assert.equal(raw(), "daylight");
  setAppConfig(APP_CONFIG_ENTRIES.ui, { skin: "skin-from-a-newer-build", guidedTour: false } as never);
  setUiConfig({ skin: "default" });
  assert.equal(raw(), "default");

  // Something that is not an id at all is not worth keeping.
  setAppConfig(APP_CONFIG_ENTRIES.ui, { skin: "<script>", guidedTour: false } as never);
  setUiConfig({ richText: true });
  assert.equal(raw(), "default");
});

test("startup tours default on for fresh and upgraded profiles independently of guidedTour", () => {
  assert.equal(getUiConfig().showToursOnStartup, true);
  for (const old of [{ layout: "board" }, { guidedTour: false }, { guidedTour: true }] as const) {
    setAppConfig(APP_CONFIG_ENTRIES.ui, old);
    assert.equal(getUiConfig().showToursOnStartup, true);
  }
  setUiConfig({ showToursOnStartup: false });
  setUiConfig({ richText: false });
  assert.equal(getUiConfig().showToursOnStartup, false);
  assert.equal((getAppConfig(APP_CONFIG_ENTRIES.ui) as Record<string, unknown>).showToursOnStartup, false);
  assert.throws(() => setUiConfig({ showToursOnStartup: "false" } as never));
  assert.equal(getUiConfig().showToursOnStartup, false);
});

test("a key from a retired preference is dropped rather than carried forever", () => {
  // `usageBarCollapsed` folded the topbar's second row, which the spend popover retired.
  // The schema is not `.strict()`, so a config saved by an older build still OPENS - the
  // dead key is simply not read back out. This is the whole migration.
  setAppConfig(APP_CONFIG_ENTRIES.ui, { layout: "board", usageBarCollapsed: true } as never);
  const config = getUiConfig();
  assert.equal(config.layout, "board");
  assert.ok(!("usageBarCollapsed" in config));
});

test("a stored Cards preference is rewritten to the shipped default", () => {
  setAppConfig(APP_CONFIG_ENTRIES.ui, { layout: "grid", richText: false } as never);
  assert.equal(getUiConfig().layout, "board");
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.ui), {
    ...UI_CONFIG_DEFAULTS,
    richText: false,
    guidedTour: false,
  });
});

test("new Cards preferences are rejected", () => {
  assert.throws(() => setUiConfig({ layout: "grid" } as never));
  assert.equal(getUiConfig().layout, "board");
});

test("the defaults the schema applies are the ones the web paints from", () => {
  // The web reads UI_CONFIG_DEFAULTS synchronously, before any fetch, to avoid pulling
  // zod into its bundle. If these drifted, a cold cache would paint one thing and the
  // daemon would then snap it to another - a flash that only shows up on a fresh profile.
  assert.deepEqual(getUiConfig(), UI_CONFIG_DEFAULTS);
});

test("configured is false until something is saved, and true once it is", () => {
  assert.equal(uiConfigView().configured, false);
  setUiConfig({ layout: "board" });
  assert.equal(uiConfigView().configured, true);
});

test("saving the defaults on purpose still counts as configured", () => {
  // The trap a value-compare would fall into: an operator who deliberately chose the
  // Board has configured this, and adoption must not fire over the top of that choice.
  setUiConfig({ layout: "board" });
  assert.equal(uiConfigView().configured, true);
  assert.deepEqual(uiConfigView().config, UI_CONFIG_DEFAULTS);
});

test("a patch merges over the stored config rather than replacing it", () => {
  setUiConfig({ layout: "console" });
  setUiConfig({ richText: false });
  const config = getUiConfig();
  // Console is no longer the default, so this also proves a stored Console survives the
  // default moving to Board.
  assert.equal(config.layout, "console", "an unrelated patch cleared the layout");
  assert.equal(config.richText, false);
});

test("keybindings are replaced whole, so an override can actually be dropped", () => {
  // Dropping an override IS an absent key. A per-key merge would make reset-to-default
  // unexpressible and leave resetAll silently doing nothing.
  setUiConfig({ keybindings: { select: "shift+Tab", filter: "cmd+1" } });
  setUiConfig({ keybindings: { select: "shift+Tab" } });
  assert.deepEqual(getUiConfig().keybindings, { select: "shift+Tab" });
  setUiConfig({ keybindings: {} });
  assert.deepEqual(getUiConfig().keybindings, {});
});

test("Disabled Line is stored as its own key, so a daemon from before it still opens the record", async () => {
  // A third `lineDensity` member would fail every UI preference on an older daemon - its
  // `.default()` covers a missing value only - after a downgrade, or a worktree build sharing
  // this state dir. A separate key is stripped by that daemon instead, and it draws the strip.
  const { LINE_DENSITIES, UiConfigSchema } = await import("../src/shared/protocol.ts");
  assert.deepEqual([...LINE_DENSITIES], ["expanded", "condensed"]);

  setUiConfig({ lineDensity: "expanded" });
  setUiConfig({ lineHidden: true });
  assert.equal(getUiConfig().lineHidden, true);
  assert.equal(getUiConfig().lineDensity, "expanded", "switching off kept the density to return to");
  assert.throws(() => setUiConfig({ lineDensity: "hidden" } as never));

  // What this build wrote, read by the schema of a build that never had `lineHidden`.
  const written = getAppConfig(APP_CONFIG_ENTRIES.ui);
  const older = UiConfigSchema.omit({ lineHidden: true }).parse(written);
  assert.equal(older.lineDensity, "expanded");
  assert.equal("lineHidden" in older, false);
});

test("a Disabled Line stored as lineDensity \"hidden\" by #1399 is moved to lineHidden, not refused", () => {
  openDb()
    .prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)`)
    .run("ui", JSON.stringify({ layout: "console", lineDensity: "hidden" }));
  const config = getUiConfig();
  assert.equal(config.lineHidden, true);
  assert.equal(config.lineDensity, UI_CONFIG_DEFAULTS.lineDensity);
  assert.equal(config.layout, "console", "the rest of the record survived the move");
  // Persisted, so a daemon from before `lineHidden` reading this state never sees "hidden".
  const raw = getAppConfig(APP_CONFIG_ENTRIES.ui) as Record<string, unknown>;
  assert.equal(raw.lineDensity, UI_CONFIG_DEFAULTS.lineDensity);
  assert.equal(raw.lineHidden, true);
});

test("a stored config with an unknown key still parses (schema defaults fill the rest)", () => {
  // Forward-compatibility: a value written by a newer build must not throw an older one.
  openDb()
    .prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)`)
    .run("ui", JSON.stringify({ layout: "board", somethingNew: 7 }));
  assert.equal(getUiConfig().layout, "board");
});

test("a keybinding for an action this build retired is stored, not rejected", () => {
  // Why the schema keeps `keybindings` a loose record. A build that removed an action
  // must still be able to READ a config mentioning it - the web drops unknown ids when it
  // resolves chords. Failing to parse here would make the config unreadable instead.
  openDb()
    .prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)`)
    .run("ui", JSON.stringify({ keybindings: { someRetiredAction: "cmd+9" } }));
  assert.deepEqual(getUiConfig().keybindings, { someRetiredAction: "cmd+9" });
});

// ---- a display item that must ship OFF, on a profile that already exists ----
//
// `UI_CONFIG_DEFAULTS.hiddenDisplayItems` is not enough by itself, and that is the whole
// reason `DISPLAY_ITEM_SEEDS` exists. A stored list is the operator's own answer and
// is returned verbatim; the default only reaches a record that stored no list at all. So on
// every profile that ever unchecked one card item, a newly-introduced ships-hidden item would
// resolve to SHOWN - the opposite of what it ships as, and invisible to any test that starts
// from an empty store, which is every other test in this file.

test("an existing profile that stored its own hidden list still gets a ships-hidden item off", () => {
  // The upgrade: a list this operator wrote, and no seed marker, because the build that
  // wrote it had none.
  setAppConfig(APP_CONFIG_ENTRIES.ui, { layout: "board", hiddenDisplayItems: ["cost"] });
  const upgraded = getUiConfig();
  assert.deepEqual(
    upgraded.hiddenDisplayItems,
    ["cost", "workflowDetails"],
    "a ships-hidden item arrived switched ON for an operator who had customised this panel",
  );
  // Their own answer survives, and an item that shipped before the marker is not re-hidden.
  assert.ok(upgraded.hiddenDisplayItems.includes("cost"));
  assert.ok(!upgraded.hiddenDisplayItems.includes("worktree"));
  assert.equal(upgraded.layout, "board", "the seeding rewrote an unrelated preference");

  // Persisted, not merely computed - the same rule the guided-tour migration follows. A
  // migration that only ever answered in memory would re-run on every read, and the marker
  // it writes is what makes switching the item on stick.
  const stored = getAppConfig(APP_CONFIG_ENTRIES.ui) as Record<string, unknown>;
  assert.deepEqual(stored.hiddenDisplayItems, ["cost", "workflowDetails"]);
  assert.equal(stored.hiddenDisplayItemsSeed, DISPLAY_ITEM_SEEDS.length);
});

test("a profile the previous build seeded is given only the rungs it has not had", () => {
  // An operator seeded once, for `workflowDetails`, and since then free to switch it on.
  // The working marks are hidden and shown again by the rungs they are owed, so they end
  // where they ship - on - and re-offering the first rung would switch Workflow details
  // back off for everyone who had turned it on.
  setAppConfig(APP_CONFIG_ENTRIES.ui, {
    layout: "board",
    hiddenDisplayItems: ["cost"],
    hiddenDisplayItemsSeed: 1,
  });
  const upgraded = getUiConfig();
  assert.deepEqual(upgraded.hiddenDisplayItems, ["cost"]);
  assert.equal(upgraded.hiddenDisplayItemsSeed, DISPLAY_ITEM_SEEDS.length);
});

test("a profile given the working marks off has them switched back on, once", () => {
  // The build before this one seeded the working marks hidden. This build's `show` rung
  // takes them back out, and leaves the operator's own `cost` and the still-hidden
  // `workflowDetails` alone.
  setAppConfig(APP_CONFIG_ENTRIES.ui, {
    layout: "board",
    hiddenDisplayItems: ["cost", "workflowDetails", "workingPinned", "workingProgressBar"],
    hiddenDisplayItemsSeed: 2,
  });
  const upgraded = getUiConfig();
  assert.deepEqual(upgraded.hiddenDisplayItems, ["cost", "workflowDetails"]);
  assert.equal(upgraded.hiddenDisplayItemsSeed, DISPLAY_ITEM_SEEDS.length);

  // Once: unchecking a working mark afterwards is the operator's answer, and sticks.
  setUiConfig({ hiddenDisplayItems: ["cost", "workflowDetails", "workingPinned"] });
  assert.deepEqual(
    getUiConfig().hiddenDisplayItems,
    ["cost", "workflowDetails", "workingPinned"],
    "the show rung re-ran and switched back on a mark the operator had unchecked",
  );
});

test("switching a ships-hidden item on is not undone by the next read", () => {
  // The direction an unconditional seeding gets wrong. Once the marker is at the head, an
  // absent id means the operator turned it ON; re-seeding would make the checkbox appear to
  // work and then silently revert.
  setAppConfig(APP_CONFIG_ENTRIES.ui, { layout: "board", hiddenDisplayItems: ["cost"] });
  getUiConfig();
  setUiConfig({ hiddenDisplayItems: ["cost"] });
  assert.deepEqual(getUiConfig().hiddenDisplayItems, ["cost"]);
  assert.deepEqual(
    getUiConfig().hiddenDisplayItems,
    ["cost"],
    "a second read re-hid an item the operator had switched on",
  );
});

test("a profile that never touched this panel is seeded without duplicating the defaults", () => {
  setAppConfig(APP_CONFIG_ENTRIES.ui, { layout: "board" });
  const upgraded = getUiConfig();
  assert.deepEqual(upgraded.hiddenDisplayItems, [...UI_CONFIG_DEFAULTS.hiddenDisplayItems]);
  assert.equal(upgraded.hiddenDisplayItemsSeed, DISPLAY_ITEM_SEEDS.length);
});

test("a fresh profile is born fully seeded and never migrates", () => {
  // An absent record must not look like an un-seeded one, or the item could never be
  // switched on: the schema default already carries every ships-hidden id.
  const fresh = getUiConfig();
  assert.deepEqual(fresh.hiddenDisplayItems, ["worktree", "workflowDetails"]);
  assert.equal(fresh.hiddenDisplayItemsSeed, DISPLAY_ITEM_SEEDS.length);
  assert.equal(
    getAppConfig(APP_CONFIG_ENTRIES.ui),
    undefined,
    "reading an unset config wrote one, which would defeat the configured flag",
  );
});
