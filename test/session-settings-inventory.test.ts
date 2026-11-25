import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SETTINGS_CATEGORIES } from "../src/web/lib/settings-registry.ts";
import { ALL_SETTINGS_CONTROLS, settingsControls } from "../src/web/lib/settings-search.ts";
import { FEATURE_FLAGS_DEFAULTS } from "../src/shared/feature-flags.ts";

test("phase 1 inventory assigns each searchable Settings control, including generated and hidden controls", () => {
  const source = readFileSync(new URL("../docs/session-settings-inventory.md", import.meta.url), "utf8");
  const rows = [...source.matchAll(/^\| `([\w*-]+)` \| ([123]) \| ([^|]+) \| (.+) \|$/gm)];
  const assignments = new Map(rows.map(([, id, phase, disposition, owner]) => [id!, { phase, disposition, owner }]));
  assert.equal(assignments.size, rows.length);
  assert.deepEqual(new Set(ALL_SETTINGS_CONTROLS.map(control => control.category)),
    new Set(SETTINGS_CATEGORIES.map(category => category.id)));
  const used = new Set<string>();
  for (const control of ALL_SETTINGS_CONTROLS) {
    const key = assignments.has(control.id) ? control.id
      : ["harness-*", "keyboard-*", "feature-flag-*"].find(family => control.id.startsWith(family.slice(0, -1)));
    assert.ok(key && assignments.has(key), `Missing inventory row for ${control.id}`);
    used.add(key);
  }
  assert.deepEqual([...assignments.keys()].filter(id => !used.has(id)), []);
  assert.ok(ALL_SETTINGS_CONTROLS.some(control => control.category === "conductor"));
  assert.ok(!settingsControls(FEATURE_FLAGS_DEFAULTS).some(control => control.category === "conductor"));
  assert.equal(assignments.get("skin")?.disposition, "Read/write");
  assert.equal(assignments.get("session-settings-access")?.disposition, "Protected");
  assert.equal(assignments.get("feature-flag-session-settings-mcp")?.disposition, "Protected");
});
