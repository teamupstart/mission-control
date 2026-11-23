import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stacked child's review diff fails CLOSED when its working tree cannot be captured. Every
// git process the daemon starts goes through a shim (the daemon's git override,
// `MISSION_GIT_BIN`) that records its arguments and can be told to fail one subcommand. The
// capture must then report an unsuccessful diff with the step that failed, and compute no
// diff at all afterwards: no ordinary diff against the default branch, and no partial one.
// The workflow capture that calls it turns an unsuccessful diff into "Could not capture
// repository diff" (`readRepositoryWorkEvidence`), so nothing is reviewed.

const home = mkdtempSync(join(tmpdir(), "mission-stacking-diff-failure-"));
process.env.HARNESS_HOME = home;
const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const log = join(home, "git-calls.log");
const failFile = join(home, "fail-subcommand");
const shim = join(home, "git-shim");
writeFileSync(failFile, "");
writeFileSync(
  shim,
  `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
fail=$(cat '${failFile}')
if [ -n "$fail" ]; then
  for arg in "$@"; do
    if [ "$arg" = "$fail" ]; then
      echo "fatal: scripted failure of $fail" >&2
      exit 128
    fi
  done
fi
exec '${realGit}' "$@"
`,
);
chmodSync(shim, 0o755);
process.env.MISSION_GIT_BIN = shim;

const { computeStackedDiff } = await import("../src/server/diff.ts");
after(() => rmSync(home, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync(realGit, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
  }).trim();
}

/** A main checkout with a linked child worktree cut from a parent branch, with work in it. */
function stackedChild(): { root: string; worktree: string; head: string; mergeBase: string } {
  const root = join(realpathSync(home), `root-${Math.random().toString(36).slice(2, 8)}`);
  git(home, "init", "-q", "-b", "main", root);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "feat/parent");
  writeFileSync(join(root, "parent.txt"), "parent\n");
  git(root, "add", "parent.txt");
  git(root, "commit", "-q", "-m", "parent");
  const mergeBase = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  const worktree = `${root}-child`;
  git(root, "worktree", "add", "-q", "-b", "feat/child", worktree, mergeBase);
  writeFileSync(join(worktree, "child.txt"), "child\n");
  git(worktree, "add", "child.txt");
  git(worktree, "commit", "-q", "-m", "child");
  writeFileSync(join(worktree, "child.txt"), "child\nuncommitted\n");
  return { root, worktree, head: git(worktree, "rev-parse", "HEAD"), mergeBase };
}

for (const [subcommand, error] of [
  ["add", "could not stage the child's working tree"],
  ["write-tree", "could not capture the child's working tree"],
] as const) {
  test(`a stacked review diff whose ${subcommand} fails is unsuccessful, names the step, and computes no diff`, async () => {
    const child = stackedChild();
    writeFileSync(log, "");
    writeFileSync(failFile, subcommand);
    let diff;
    try {
      diff = await computeStackedDiff({
        repoRoot: child.root, worktree: child.worktree, head: child.head, branch: "feat/child",
        mergeBase: child.mergeBase, label: "feat/parent",
      });
    } finally {
      writeFileSync(failFile, "");
    }
    assert.equal(diff.ok, false, "the capture fails closed");
    assert.equal(diff.error, error);
    assert.equal(diff.patch, "", "no patch is offered for review");
    assert.equal(diff.filesChanged, 0);
    assert.equal(diff.base, "feat/parent", "the failure still describes the stacked base, not the default branch");

    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    const failedAt = calls.findIndex((call) => call.split(" ").includes(subcommand));
    assert.ok(failedAt >= 0, `the shim saw the ${subcommand} call`);
    assert.deepEqual(
      calls.slice(failedAt + 1),
      [],
      "nothing runs after the failed step: no ordinary diff, no merge-base against the default branch",
    );
    assert.ok(!calls.some((call) => / diff /.test(` ${call} `)), "no diff of any kind was computed");
    assert.ok(!calls.some((call) => /origin\/main|\bmain\b/.test(call)), "the default branch was never consulted");
  });
}

test("the same capture succeeds once the step is not failed, so the failure above is the step and not the setup", async () => {
  const child = stackedChild();
  const diff = await computeStackedDiff({
    repoRoot: child.root, worktree: child.worktree, head: child.head, branch: "feat/child",
    mergeBase: child.mergeBase, label: "feat/parent",
  });
  assert.equal(diff.ok, true, diff.error ?? "");
  assert.match(diff.patch, /\+uncommitted/);
  assert.doesNotMatch(diff.patch, /parent\.txt/);
});
