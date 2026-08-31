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

  assert.match(pullRequestWorkflow, /types: \[opened, edited, synchronize, reopened\]/);
  assert.match(pullRequestWorkflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(pullRequestWorkflow, /RELEASE_COMMIT_SUBJECT: \$\{\{ github\.event\.pull_request\.title \}\}/);
  assert.match(pullRequestWorkflow, /node scripts\/assert-release-commit\.mjs/);

  const checkout = releaseWorkflow.indexOf("name: Check out the release input");
  const guard = releaseWorkflow.indexOf("name: Assert Release Please can parse the new commits");
  const token = releaseWorkflow.indexOf("name: Mint the mission-control-release installation token");
  assert.ok(checkout >= 0 && checkout < guard && guard < token);
  assert.match(releaseWorkflow, /fetch-depth: 0/);
  assert.match(releaseWorkflow, /RELEASE_BASE_SHA: \$\{\{ github\.event\.before \}\}/);
  assert.match(releaseWorkflow, /RELEASE_HEAD_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(releaseWorkflow, /node scripts\/assert-release-commit\.mjs/);
  assert.match(releaseWorkflow, /uses: googleapis\/release-please-action@v5/);
  assert.doesNotMatch(releaseWorkflow, /uses: googleapis\/release-please-action@v4/);
});
