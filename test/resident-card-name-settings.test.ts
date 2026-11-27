import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Its own state home, set above the imports as the suite requires, because the writes reach
// `app_config`.
const root = mkdtempSync(join(tmpdir(), "resident-card-name-settings-"));
process.env.MISSION_HOME = join(root, "state");
after(() => rmSync(root, { recursive: true, force: true }));

const { RESIDENT_CARD_NAMES_FLAG_ID } = await import("../src/shared/feature-flag-registry.ts");
const { settingsFailure } = await import("../src/shared/settings-mcp.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { dispatchSetting } = await import("../src/server/settings-dispatcher.ts");
const { typedSettings } = await import("../src/server/session-settings-owners.ts");
const { getUiConfig, setUiConfig } = await import("../src/server/ui-config.ts");

const unused = (): never => assert.fail("only the ui owner is exercised here");
const catalog = typedSettings({
  harnesses: unused, foreman: unused, inspector: unused, llm: unused, shipping: unused, skills: unused,
  cost: unused, worktrees: unused, storageLimits: unused, backups: unused, workflows: unused,
});
const run = (request: Parameters<typeof dispatchSetting>[0]) => dispatchSetting(request, catalog(), () => null);

const SUBTITLE = "ui.residentCardNameStyles.subtitle";
const CHIP = "ui.residentCardNameStyles.chip";

test("the controls are offered only while the preview flag is on, and the stored styles survive it being off", () => {
  setUiConfig({ residentCardNameStyles: ["chip"] });
  applyFeatureFlagIntent({ kind: "flag", id: RESIDENT_CARD_NAMES_FLAG_ID, enabled: false });
  for (const key of [SUBTITLE, CHIP]) {
    assert.deepEqual(run({ operation: "get", key }), settingsFailure("unknown_key"), `${key} was readable with the flag off`);
    assert.deepEqual(run({ operation: "set", key, value: true }), settingsFailure("unknown_key"), `${key} was writable with the flag off`);
  }
  const found = run({ operation: "find", query: "residentCardNameStyles" });
  assert.ok(found.ok && found.operation === "find");
  assert.deepEqual(found.matches.filter(({ key }) => key.startsWith("ui.residentCardNameStyles.")), []);
  assert.deepEqual(getUiConfig().residentCardNameStyles, ["chip"], "the flag-off refusals touched the stored styles");

  applyFeatureFlagIntent({ kind: "flag", id: RESIDENT_CARD_NAMES_FLAG_ID, enabled: true });
  const offered = run({ operation: "find", query: "residentCardNameStyles" });
  assert.ok(offered.ok && offered.operation === "find");
  assert.deepEqual(
    offered.matches.filter(({ key }) => key.startsWith("ui.residentCardNameStyles.")).map(({ key, label }) => [key, label]),
    [[SUBTITLE, "Resident name: Subtitle"], [CHIP, "Resident name: Expanding chip"]],
  );
  assert.deepEqual(run({ operation: "get", key: SUBTITLE }), { ok: true, operation: "get", key: SUBTITLE, value: false, type: "boolean" });
  assert.deepEqual(run({ operation: "get", key: CHIP }), { ok: true, operation: "get", key: CHIP, value: true, type: "boolean" });
});

test("each control turns its own style on or off, keeps the other, and stores them in order", () => {
  applyFeatureFlagIntent({ kind: "flag", id: RESIDENT_CARD_NAMES_FLAG_ID, enabled: true });
  setUiConfig({ residentCardNameStyles: ["chip"] });

  assert.deepEqual(run({ operation: "set", key: SUBTITLE, value: true }), { ok: true, operation: "set", key: SUBTITLE, value: true });
  assert.deepEqual(getUiConfig().residentCardNameStyles, ["subtitle", "chip"], "turning Subtitle on dropped the chip or broke the order");
  assert.deepEqual(run({ operation: "get", key: SUBTITLE }), { ok: true, operation: "get", key: SUBTITLE, value: true, type: "boolean" });

  assert.deepEqual(run({ operation: "set", key: CHIP, value: false }), { ok: true, operation: "set", key: CHIP, value: false });
  assert.deepEqual(getUiConfig().residentCardNameStyles, ["subtitle"], "turning the chip off dropped the subtitle");
  assert.deepEqual(run({ operation: "get", key: CHIP }), { ok: true, operation: "get", key: CHIP, value: false, type: "boolean" });

  assert.deepEqual(run({ operation: "set", key: SUBTITLE, value: true }), { ok: true, operation: "set", key: SUBTITLE, value: true });
  assert.deepEqual(getUiConfig().residentCardNameStyles, ["subtitle"]);
});

test("a non-boolean write is refused and leaves the stored styles alone", () => {
  applyFeatureFlagIntent({ kind: "flag", id: RESIDENT_CARD_NAMES_FLAG_ID, enabled: true });
  setUiConfig({ residentCardNameStyles: ["subtitle"] });
  for (const value of ["yes", 1, null, ["chip"]]) {
    assert.deepEqual(run({ operation: "set", key: CHIP, value }), settingsFailure("invalid_value"), `${JSON.stringify(value)} was accepted`);
  }
  assert.deepEqual(getUiConfig().residentCardNameStyles, ["subtitle"]);
});
