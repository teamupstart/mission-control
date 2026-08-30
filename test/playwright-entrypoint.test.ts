import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const stateHome = mkdtempSync(join(tmpdir(), "mission-playwright-entrypoint-"));

after(() => rmSync(stateHome, { recursive: true, force: true }));

test("a bare Playwright command discovers only the browser E2E suite", () => {
  const rootConfig = join(repoRoot, "playwright.config.ts");
  assert.equal(
    existsSync(rootConfig),
    true,
    "the root config must stop bare Playwright commands before discovery reaches test/",
  );

  const env: Record<string, string | undefined> = { ...process.env, MISSION_HOME: stateHome };
  delete env.FLEET_HOME;
  delete env.HARNESS_HOME;
  delete env.MISSION_TEST_STATE;
  delete env.NODE_TEST_CONTEXT;

  // This is the exact command shape an agent used during the live-state incident, with
  // --list added so discovery is exercised without starting browsers or application daemons.
  const result = spawnSync(join(repoRoot, "node_modules", ".bin", "playwright"), ["test", "--list"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /\u203a [^\n]+\.spec\.ts:/, "the browser specs were not discovered");
  assert.doesNotMatch(output, /\u203a test\//, "Playwright discovered the Node unit-test tree");
});
