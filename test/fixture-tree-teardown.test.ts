import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { processesUnder, tempDir } from "./temp-root.mjs";

// The failure path `teardownFixtureTree` exists for, which the detached-install Electron suite
// only reaches when something goes wrong: a fixture app is launched outside the test's process
// tree, so its pid is never learned, and the test fails before any handoff names it. A real
// `node --test` worker runs that scenario; this file checks what it left behind.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const url = (path: string) => JSON.stringify(pathToFileURL(join(REPO_ROOT, path)).href);

const FAILING_SPEC = `
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { teardownFixtureTree } from ${url("test/helpers/fixture-tree.ts")};
import { processesUnder, tempDir } from ${url("test/temp-root.mjs")};

test("a copied app is launched and the handoff never arrives", async (t) => {
  const root = realpathSync(tempDir("mission-detached-electron-"));
  t.after(() => teardownFixtureTree(root, "early failure"));
  const macos = join(root, "apps", "Mission Control.app", "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  const app = join(macos, "Mission Control");
  writeFileSync(app, "");
  // Through a launcher that exits at once, as /usr/bin/open does: the app is orphaned and this
  // test never learns its pid. Node with argv0 stands in for the app's executable, so its
  // command line starts inside the tree on every platform.
  // The path travels in the environment, so only the orphan's own command line names the tree.
  const launcher = "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { argv0: process.env.APP, detached: true, stdio: 'ignore' }).unref();";
  spawn(process.execPath, ["-e", launcher], { stdio: "ignore", env: { ...process.env, APP: app } });
  let seen;
  for (let i = 0; i < 100 && !seen; i++) {
    seen = processesUnder([root], { anywhere: true })[0];
    if (!seen) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  writeFileSync(process.env.REPORT, JSON.stringify({ root, pid: seen?.pid ?? null }));
  throw new Error("handoff never arrived");
});
`;

test("a fixture test that fails before its handoff still removes its app tree and its untracked process", { timeout: 60_000 }, async () => {
  const dir = tempDir("fixture-tree-failure-");
  const spec = join(dir, "early-failure.test.mjs");
  const report = join(dir, "report.json");
  writeFileSync(spec, FAILING_SPEC);
  const env: Record<string, string | undefined> = { ...process.env, REPORT: report };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--test", "--import", "./test/setup-state.mjs", "--import", "tsx", spec], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const status = await new Promise((resolve) => child.once("exit", resolve));

  assert.equal(status, 1, `the fixture test was supposed to fail\n${output}`);
  assert.match(output, /handoff never arrived/);
  const { root, pid } = JSON.parse(readFileSync(report, "utf8")) as { root: string; pid: number | null };
  assert.ok(pid, `the copied app never started, so this case proves nothing\n${output}`);
  assert.doesNotMatch(output, /fixture processes survived|outlived teardown/, output);
  assert.equal(existsSync(root), false, `${root} outlived the failed test`);
  assert.deepEqual(processesUnder([root], { anywhere: true }), [], "a fixture process outlived the failed test");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `the untracked app ${pid} is still running`);
});
