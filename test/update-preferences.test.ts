import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readUpdatePreferences, writeUpdatePreferences } from "../src/main/update-preferences.ts";
import { createDefaultUpdaterPort, UpdateController } from "../src/main/updater.ts";
import { binaryOffer } from "./helpers/binary-update.ts";

test("alpha defaults off, persists across reads, and rejects invalid writes without losing the preference", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mission-alpha-preferences-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "update-preferences.json");
  assert.deepEqual(readUpdatePreferences(path), { alpha: false, snoozedUntil: {} });
  writeFileSync(path, "{}");
  assert.deepEqual(readUpdatePreferences(path), { alpha: false, snoozedUntil: {} });
  writeUpdatePreferences(path, { alpha: true, snoozedUntil: {} });
  assert.deepEqual(readUpdatePreferences(path), { alpha: true, snoozedUntil: {} });
  const before = readFileSync(path, "utf8");
  assert.throws(() => writeUpdatePreferences(path, { alpha: "true" }));
  assert.equal(readFileSync(path, "utf8"), before);
  for (const until of [-1, 1.5, Infinity, "tomorrow"]) {
    assert.throws(() => writeUpdatePreferences(path, { alpha: true, snoozedUntil: { "v1.2.4": until } }));
    assert.equal(readFileSync(path, "utf8"), before);
  }
  writeUpdatePreferences(path, { alpha: false, snoozedUntil: {} });
  assert.deepEqual(readUpdatePreferences(path), { alpha: false, snoozedUntil: {} });
  writeFileSync(path, "broken json");
  assert.deepEqual(readUpdatePreferences(path), { alpha: false, snoozedUntil: {} });
  writeFileSync(path, JSON.stringify({ alpha: true }));
  assert.deepEqual(readUpdatePreferences(path), { alpha: true, snoozedUntil: {} }, "old preferences keep their channel");
});

test("update snoozes survive a controller restart and alpha preference changes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mission-update-snooze-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "update-preferences.json");
  let now = Date.parse("2026-10-28T12:00:00Z");
  const port = createDefaultUpdaterPort({
    packaged: true, arch: "arm64", currentVersion: () => "1.2.3", currentCommit: () => null,
    stateDirectory: dir, helperSource: "", requestQuit: () => {},
    installSnapshot: () => ({ receipt: { schema: 1, repo: "teamupstart/mission-control", sourceClone: dir,
      appPath: join(dir, "fixture.app"), installedVersion: "1.2.3", releaseTag: "v1.2.3", installedAt: "2026-10-28T00:00:00Z" }, problem: null }),
    dialogs: { available: async () => "defer", ready: async () => "defer", error: async () => {},
      upToDate: async () => {}, preparing: async () => {}, applying: async () => {}, outcome: async () => {} },
  });
  port.now = () => now;
  port.latestRelease = async () => ({ tagName: "v1.2.4", name: "1.2.4", body: "Update", publishedAt: "2026-10-28T00:00:00Z",
    isDraft: false, isPrerelease: false, binary: binaryOffer() });
  const first = new UpdateController(port);
  t.after(() => first.stop());
  await first.start();
  await first.check(false);
  first.defer();
  first.stop();
  const expires = now + 48 * 60 * 60 * 1000;
  assert.deepEqual(readUpdatePreferences(path), { alpha: false, snoozedUntil: { "v1.2.4": expires } });
  port.writeAlpha(true);
  assert.deepEqual(readUpdatePreferences(path), { alpha: true, snoozedUntil: { "v1.2.4": expires } });
  port.writeAlpha(false);
  const restarted = new UpdateController(port);
  t.after(() => restarted.stop());
  await restarted.start();
  now = expires - 1;
  assert.equal((await restarted.check(false)).phase, "idle");
  now = expires;
  assert.equal((await restarted.check(false)).phase, "available");
});
