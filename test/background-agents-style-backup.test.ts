import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Settings > Display > Board card > Background sub-agents survives a settings backup and
 * restore: the treatment captured is the treatment the daemon reads back afterwards, through
 * the same capture, stage and transactional write the restore route uses.
 *
 * Its own state home, set above the imports as the suite requires, because a restore writes
 * `app_config`.
 */
const root = mkdtempSync(join(tmpdir(), "background-agents-style-backup-"));
process.env.MISSION_HOME = join(root, "state");
after(() => rmSync(root, { recursive: true, force: true }));

const { getUiConfig, setUiConfig } = await import("../src/server/ui-config.ts");
const { openDb } = await import("../src/server/db.ts");
const { captureSettingsConfig, stageSettingsConfigRestore, restoreSettingsConfigInTransaction } = await import(
  "../src/server/settings-backups/config-registry.ts"
);

test("a restored settings backup puts back the background sub-agents treatment it captured", () => {
  setUiConfig({ backgroundAgentsStyle: "chip" });
  assert.equal(getUiConfig().backgroundAgentsStyle, "chip");

  const captured = new Map(captureSettingsConfig().map((entry) => [entry.domain, entry.payload]));
  assert.equal((captured.get("ui") as { backgroundAgentsStyle?: string }).backgroundAgentsStyle, "chip");

  // The operator changes their mind after the backup was taken.
  setUiConfig({ backgroundAgentsStyle: "nested" });
  assert.equal(getUiConfig().backgroundAgentsStyle, "nested");

  const staged = stageSettingsConfigRestore(captured);
  const ui = staged.find((entry) => entry.domain === "ui");
  assert.ok(ui?.changed, "the ui domain was not staged as a change");
  restoreSettingsConfigInTransaction(openDb(), staged);

  assert.equal(getUiConfig().backgroundAgentsStyle, "chip", "the restore did not put Chip and popover back");
});
