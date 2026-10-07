import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missionToolsAvailability, piExtensionInstalled } from "../src/server/mission-tools.ts";
import { piExtensionPath } from "../src/server/config.ts";

test("Pi's verified installed bridge and MCP-client harnesses expose distinct capabilities", async () => {
  assert.deepEqual(await missionToolsAvailability("pi", () => true), { available: true, reason: null });
  assert.equal((await missionToolsAvailability("pi", () => false)).available, false);
  for (const agent of ["claude", "codex"] as const) {
    assert.deepEqual(await missionToolsAvailability(agent, () => { throw new Error("MCP clients do not inspect a Pi extension"); }),
      { available: true, reason: null });
  }
});

test("Pi availability degrades invalid and non-file paths to a clean refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-availability-"));
  const prior = { ...process.env };
  try {
    process.env.PI_EXTENSIONS_DIR = join(dir, "extensions");
    process.env.MISSION_HOME = join(dir, "state");
    mkdirSync(join(dir, "directory.js"));
    writeFileSync(join(dir, "index.js"), "export default () => {};\n");
    symlinkSync(join(dir, "missing.js"), join(dir, "broken.js"));
    symlinkSync(join(dir, "index.js"), join(dir, "linked.js"));
    for (const name of ["invalid.mjs", "missing.js", "directory.js", "broken.js"]) {
      process.env.MISSION_PI_EXTENSION = join(dir, name);
      assert.equal(await piExtensionInstalled(), false, name);
      const availability = await missionToolsAvailability("pi");
      assert.equal(availability.available, false, name);
      assert.ok(availability.reason);
    }
    process.env.MISSION_PI_EXTENSION = join(dir, "invalid.mjs");
    assert.throws(() => piExtensionPath(), /must end in \.js/, "build-path validation stays strict");
    for (const name of ["index.js", "linked.js"]) {
      process.env.MISSION_PI_EXTENSION = join(dir, name);
      assert.equal(await piExtensionInstalled(), false, name);
      assert.equal((await missionToolsAvailability("pi")).available, false, "an uninstalled artifact does not grant availability");
    }
  } finally {
    process.env = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
