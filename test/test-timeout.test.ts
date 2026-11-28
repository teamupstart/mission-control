import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tempDir } from "./temp-root.mjs";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

test("Node test commands bound a hung test instead of waiting for the workflow deadline", (t) => {
  const commands = Object.entries(scripts).filter(([, command]) => command.startsWith("node --test "));
  assert.ok(commands.some(([name]) => name === "test"));
  for (const [name, command] of commands) {
    const timeout = command.match(/--test-timeout=(\d+)/)?.[0];
    assert.equal(timeout, "--test-timeout=120000", `${name} needs the two-minute default`);
  }

  const root = tempDir("mission-test-timeout-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "hang.test.mjs");
  writeFileSync(file, `
    import test from 'node:test';
    test('deliberately stalled backup await', async (t) => {
      const keepalive = setInterval(() => {}, 60_000);
      t.after(() => clearInterval(keepalive));
      await new Promise(() => {});
    });
  `);
  // Exercise the same CLI option with a short deadline, not a two-minute regression test.
  // A nested runner otherwise refuses to launch under its parent worker context.
  // Keep the inherited test-state isolation markers and home.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--test", "--test-timeout=200", "--import", "./test/setup-state.mjs", file,
  ], { encoding: "utf8", timeout: 5_000, env });
  assert.equal(result.error, undefined, "the runner must exit before the parent watchdog");
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /test timed out after 200ms/);
});
