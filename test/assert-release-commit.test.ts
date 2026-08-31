import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertReleaseCommits,
  firstParentSubjects,
  releaseCommitProblem,
} from "../scripts/assert-release-commit.mjs";

const repo = join(import.meta.dirname, "..");

function topLevelMappingLines(workflow: string, key: string): string[] {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf(`${key}:`);
  assert.notEqual(start, -1, `missing top-level ${key} mapping`);

  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || !/^[ \t]+\S/.test(line)) break;
    values.push(line);
  }
  return values;
}

function namedWorkflowStep(workflow: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step ${JSON.stringify(name)}`);
  const next = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

test("Release Please-compatible commit subjects are accepted", () => {
  for (const subject of [
    "fix: repair release input",
    "feat(pipelines): preserve commission continuity",
    "feat(dispatch/report)!: change the report contract",
    "chore(main): release 1.3.2",
    "deps: update a dependency",
  ]) {
    assert.equal(releaseCommitProblem(subject), null, subject);
  }
});

test("the subjects omitted by the broken release run are rejected", () => {
  for (const subject of [
    "Place dispatching task ghosts in the Working column (#845)",
    "Activate end-to-end Pipeline commission continuity (#842)",
    "no-mistakes: a hyphenated type is not parsed by Release Please",
    "fix(scope):",
    "",
  ]) {
    assert.match(String(releaseCommitProblem(subject)), /expected|empty/, subject);
  }
  assert.equal(assertReleaseCommits(["Place dispatching task ghosts in the Working column (#845)"]), 1);
});

test("first-parent validation checks merge subjects without inspecting private branch commits", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "mission-release-subjects-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

  try {
    git("init", "-b", "main");
    git("config", "user.name", "Mission Control Test");
    git("config", "user.email", "mission-control@example.test");
    git("commit", "--allow-empty", "-m", "chore: establish base");
    const baseSha = git("rev-parse", "HEAD");

    git("checkout", "-b", "feature");
    git("commit", "--allow-empty", "-m", "Private branch checkpoint");
    git("checkout", "main");
    git("merge", "--no-ff", "feature", "-m", "feat(release): merge the feature");

    assert.deepEqual(firstParentSubjects({ repoRoot, baseSha }), [
      "feat(release): merge the feature",
    ]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("the pull request and release workflows enforce the same validator", () => {
  const pullRequestWorkflow = readFileSync(
    join(repo, ".github", "workflows", "pull-request-title.yml"),
    "utf8",
  );
  const releaseWorkflow = readFileSync(join(repo, ".github", "workflows", "release.yml"), "utf8");

  assert.match(pullRequestWorkflow, /pull_request_target:/);
  assert.doesNotMatch(pullRequestWorkflow, /^  pull_request:/m);
  assert.match(pullRequestWorkflow, /types: \[opened, edited, synchronize, reopened\]/);
  assert.deepEqual(topLevelMappingLines(pullRequestWorkflow, "permissions"), ["  contents: read"]);
  assert.doesNotMatch(pullRequestWorkflow, /^[ \t]+permissions:/m);

  const titleCheckout = namedWorkflowStep(
    pullRequestWorkflow,
    "Check out the trusted title validator",
  );
  assert.match(titleCheckout, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  const titleGuard = namedWorkflowStep(
    pullRequestWorkflow,
    "Assert Release Please can parse the pull request title",
  );
  assert.match(titleGuard, /RELEASE_COMMIT_SUBJECT: \$\{\{ github\.event\.pull_request\.title \}\}/);
  assert.match(titleGuard, /node scripts\/assert-release-commit\.mjs/);

  const checkout = releaseWorkflow.indexOf("name: Check out the release input");
  const guard = releaseWorkflow.indexOf("name: Assert Release Please can parse the new commits");
  const token = releaseWorkflow.indexOf("name: Mint the mission-control-release installation token");
  assert.ok(checkout >= 0 && checkout < guard && guard < token);
  assert.match(releaseWorkflow, /^on:\n  push:\n    branches: \[main\]$/m);
  assert.doesNotMatch(releaseWorkflow, /workflow_dispatch:/);
  assert.match(releaseWorkflow, /fetch-depth: 0/);
  const releaseGuard = namedWorkflowStep(
    releaseWorkflow,
    "Assert Release Please can parse the new commits",
  );
  assert.doesNotMatch(releaseGuard, /^\s+if:/m);
  assert.match(releaseGuard, /RELEASE_BASE_SHA: \$\{\{ github\.event\.before \}\}/);
  assert.match(releaseGuard, /RELEASE_HEAD_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(releaseGuard, /node scripts\/assert-release-commit\.mjs/);
  assert.match(releaseWorkflow, /uses: googleapis\/release-please-action@v5/);
  assert.doesNotMatch(releaseWorkflow, /uses: googleapis\/release-please-action@v4/);
});
