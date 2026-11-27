import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_CONFIG_ENTRIES } from "../src/shared/app-config-entries.ts";

// What is at stake: while Shipping cannot accept a local review as merge provenance, a
// repository holding the merge grant keeps the GitHub review for every head. Reading the grant
// must therefore fail toward "holds it": a setting that cannot be read is never an empty
// allowlist, or a corrupt value would quietly let a head skip its GitHub review.

const home = mkdtempSync(join(tmpdir(), "mission-merge-grant-"));
// Set before importing anything that resolves the state dir.
process.env.MISSION_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { repositoryHoldsMergeGrant, setShippingConfig } = await import("../src/server/shipping/config.ts");

const KEY = APP_CONFIG_ENTRIES.shipping.key;
const store = (value: string) =>
  openDb().prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)`).run(KEY, value);

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => { openDb().prepare(`DELETE FROM app_config WHERE key = ?`).run(KEY); });

test("an absent Shipping setting is the empty allowlist: no repository holds the grant", () => {
  assert.equal(repositoryHoldsMergeGrant("/repo", "/repo"), false);
});

test("a repository on Shipping's allowlist holds the grant, and one off it does not", () => {
  setShippingConfig({ repoAllowlist: ["/repo"] });
  assert.equal(repositoryHoldsMergeGrant("/repo", "/repo"), true);
  assert.equal(repositoryHoldsMergeGrant("/other", "/other"), false);
});

for (const [name, value] of [
  ["JSON that does not parse", "{ not json"],
  ["a shape the schema refuses", JSON.stringify({ repoAllowlist: 5 })],
] as const) {
  test(`a stored setting with ${name} reads as holding the grant, keeping the GitHub review`, () => {
    store(value);
    assert.equal(repositoryHoldsMergeGrant("/other", "/other"), true);
  });
}
