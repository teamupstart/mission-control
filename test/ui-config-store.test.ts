import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const { openDb, setAppConfig } = await import("../src/server/db.ts");
const { getUiConfig, setUiConfig, uiConfigView } = await import("../src/server/ui-config.ts");
const { UI_CONFIG_DEFAULTS } = await import("../src/shared/protocol.ts");

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
});

test("an unset key reads as the shipped defaults", () => {
  const config = getUiConfig();
  assert.equal(config.layout, "grid");
  assert.equal(config.conversationView, "terminal");
  assert.equal(config.richText, true);
  assert.deepEqual(config.alerts, { notifications: false, sound: true });
  assert.deepEqual(config.keybindings, {});
  assert.equal(config.keybindingHints, true);
  assert.equal(config.guidedDispatch, false);
});

test("the guided dispatch preference round-trips, and a row from before it parses", () => {
  // Two directions, one key. Forward: a config saved by a build that had never heard of
  // this preference still opens, and reads as the shipped default rather than throwing -
  // which is what `.default()` on the field buys, and the reason adding a preference owes
  // no migration. Backward: what an operator turns on is what comes back.
  setUiConfig({ layout: "board" });
  assert.equal(getUiConfig().guidedDispatch, false);
  setUiConfig({ guidedDispatch: true });
  const config = getUiConfig();
  assert.equal(config.guidedDispatch, true);
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

test("a key from a retired preference is dropped rather than carried forever", () => {
  // `usageBarCollapsed` folded the topbar's second row, which the spend popover retired.
  // The schema is not `.strict()`, so a config saved by an older build still OPENS - the
  // dead key is simply not read back out. This is the whole migration.
  setAppConfig("ui", { layout: "board", usageBarCollapsed: true });
  const config = getUiConfig();
  assert.equal(config.layout, "board");
  assert.ok(!("usageBarCollapsed" in config));
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
  // grid has configured this, and adoption must not fire over the top of that choice.
  setUiConfig({ layout: "grid" });
  assert.equal(uiConfigView().configured, true);
  assert.deepEqual(uiConfigView().config, UI_CONFIG_DEFAULTS);
});

test("a patch merges over the stored config rather than replacing it", () => {
  setUiConfig({ layout: "console" });
  setUiConfig({ richText: false });
  const config = getUiConfig();
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
