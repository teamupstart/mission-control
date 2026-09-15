import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readUpdatePreferences, writeUpdatePreferences } from "../src/main/update-preferences.ts";

test("alpha defaults off, persists across reads, and rejects invalid writes without losing the preference", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mission-alpha-preferences-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "update-preferences.json");
  assert.deepEqual(readUpdatePreferences(path), { alpha: false });
  writeFileSync(path, "{}");
  assert.deepEqual(readUpdatePreferences(path), { alpha: false });
  writeUpdatePreferences(path, { alpha: true });
  assert.deepEqual(readUpdatePreferences(path), { alpha: true });
  const before = readFileSync(path, "utf8");
  assert.throws(() => writeUpdatePreferences(path, { alpha: "true" }));
  assert.equal(readFileSync(path, "utf8"), before);
  writeUpdatePreferences(path, { alpha: false });
  assert.deepEqual(readUpdatePreferences(path), { alpha: false });
  writeFileSync(path, "broken json");
  assert.deepEqual(readUpdatePreferences(path), { alpha: false });
});
