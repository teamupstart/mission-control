import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..");
const script = join(repo, "scripts", "init.mjs");

test("local and CI concurrency are explicit for their runner capacity", () => {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const workflow = readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8");
  const e2eConfig = readFileSync(join(repo, "e2e", "playwright.config.ts"), "utf8");
  const testCommand = pkg.scripts.test;

  assert.ok(testCommand);
  assert.match(testCommand, /--test-concurrency=\$\{MISSION_TEST_CONCURRENCY:-6\}/);
  assert.match(workflow, /^\s+MISSION_TEST_CONCURRENCY: '2'$/m);
  assert.match(e2eConfig, /^  workers: process\.env\.CI \? 2 : 4,$/m);
});

test("CI uses repository-accessible standard Linux runners", () => {
  const workflow = readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8");
  const runnerLabels = [
    ...workflow.matchAll(/^  (gates|unit|e2e):\n    name:.*\n    runs-on: (.+)$/gm),
  ].map(([, job, runner]) => [job, runner]);

  assert.doesNotMatch(workflow, /blacksmith/i);
  assert.deepEqual(runnerLabels, [
    ["gates", "ubuntu-latest"],
    ["unit", "ubuntu-latest"],
    ["e2e", "ubuntu-latest"],
  ]);
});

test("init dry-run has no external worktree installer or configuration step", () => {
  const output = execFileSync(
    process.execPath,
    [script, "--dry-run", "--skip-build", "--skip-hooks"],
    { cwd: repo, encoding: "utf8" },
  );
  assert.doesNotMatch(output, /^\s*(?:\d+\.\s+)?treehouse|curl -fsSL|go install/im);
  assert.match(output, /Node\.js prerequisite/);
  assert.match(output, /Node dependencies/);
  assert.match(output, /Claude status hooks/);
});

test("init source cannot invoke the retired Treehouse bootstrap", () => {
  const source = readFileSync(script, "utf8");
  const makefile = readFileSync(join(repo, "Makefile"), "utf8");
  assert.doesNotMatch(source, /treehouse|kunchenguid|curl -fsSL|go install/i);
  assert.doesNotMatch(makefile, /treehouse|kunchenguid|curl -fsSL|go install/i);
});
