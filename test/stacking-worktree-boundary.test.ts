import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

// Stacked pull requests: the review diff of a stacked child is read WITHOUT running git
// inside the child's worktree. The operator's boundary is literal - "never run git inside a
// worktree from the daemon" - so this test does not trust the code's own description of
// itself: every git process the daemon starts goes through a logging shim (the daemon's git
// override, `MISSION_GIT_BIN`), which records the directory it ran in and its arguments,
// and the test asserts on that record.

const home = mkdtempSync(join(tmpdir(), "mission-stacking-boundary-"));
process.env.HARNESS_HOME = home;
const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const log = join(home, "git-calls.log");
const shim = join(home, "git-shim");
writeFileSync(shim, `#!/bin/sh\nprintf '%s\\t%s\\n' "$(pwd -P)" "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
chmodSync(shim, 0o755);
process.env.MISSION_GIT_BIN = shim;

const { resolveStackDiffBase } = await import("../src/server/stacking/diff-base.ts");
const { computeStackedDiff } = await import("../src/server/diff.ts");
const { openDb } = await import("../src/server/db.ts");
openDb();
after(() => rmSync(home, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync(realGit, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
  }).trim();
}

function commit(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

test("a stacked child's review diff never runs git inside the child's worktree, and still captures its work", async () => {
  // origin, an author who pushes the parent, and the operator's main checkout.
  const origin = join(home, "origin.git");
  git(home, "init", "-q", "--bare", "-b", "main", origin);
  const author = join(home, "author");
  git(home, "clone", "-q", origin, author);
  git(author, "checkout", "-q", "-b", "main");
  commit(author, "base.txt", "base\n", "base");
  git(author, "push", "-q", "origin", "main");
  git(author, "checkout", "-q", "-b", "feat/parent");
  commit(author, "parent.txt", "parent v1\n", "parent v1");
  git(author, "push", "-q", "origin", "feat/parent");
  // Canonical paths throughout (the temp dir is a symlink on macOS), so the shim's `pwd -P`
  // can be compared with the worktree exactly.
  const checkout = join(realpathSync(home), "checkout");
  git(home, "clone", "-q", origin, checkout);
  git(checkout, "fetch", "-q", "origin");
  const cutAt = git(checkout, "rev-parse", "origin/feat/parent");

  // The child: a LINKED WORKTREE of the main checkout, as a native task slot is, with every
  // kind of work a review must see - a commit, an uncommitted edit, a new untracked file -
  // and one it must not (an ignored file).
  const worktree = join(realpathSync(home), "child-worktree");
  git(checkout, "worktree", "add", "-q", "-b", "feat/child", worktree, cutAt);
  commit(worktree, "child.txt", "child\n", "child work");
  writeFileSync(join(worktree, ".gitignore"), "*.log\n");
  git(worktree, "add", ".gitignore");
  git(worktree, "commit", "-q", "-m", "ignore logs");
  writeFileSync(join(worktree, "child.txt"), "child\nuncommitted edit\n");
  writeFileSync(join(worktree, "draft.txt"), "untracked work\n");
  writeFileSync(join(worktree, "noise.log"), "ignored\n");
  const statusBefore = git(worktree, "status", "--porcelain");
  const indexBefore = readFileSync(join(git(worktree, "rev-parse", "--git-dir"), "index"));

  // The parent takes a review repair on the remote after the child was cut.
  git(author, "checkout", "-q", "feat/parent");
  const repaired = commit(author, "parent.txt", "parent v2\n", "parent repair");
  git(author, "push", "-q", "origin", "feat/parent");

  const task = mkTask({
    id: "child", status: "running", repoRoot: checkout, stackParentTaskId: "parent",
    stackBaseBranch: "feat/parent", stackBaseSha: cutAt, stackPrUrl: "https://github.com/acme/repo/pull/7",
  });
  const registry = { taskForSession: () => task, workEpisodeForSession: () => ({ episodeId: "ep1" }) };

  writeFileSync(log, "");
  // The daemon's own path, end to end: refresh the parent at the root, read the child's head,
  // compute the merge base, and capture the diff - every git process through the shim.
  const base = await resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, null, undefined, worktree);
  assert.ok(base);
  assert.equal(base.sha, repaired, "the moved parent was refreshed");
  const diff = await computeStackedDiff({
    repoRoot: base.repoRoot, worktree, head: base.head, branch: base.headBranch, mergeBase: base.mergeBase, label: base.branch,
  });

  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const [cwd, args] = line.split("\t");
    return { cwd: cwd!, args: args ?? "" };
  });
  assert.ok(calls.length >= 6, `the shim saw the daemon's git calls (${calls.length})`);
  for (const call of calls) {
    assert.notEqual(call.cwd, worktree, `git ran inside the child's worktree: ${call.args}`);
    assert.ok(!call.cwd.startsWith(`${worktree}/`), `git ran below the child's worktree: ${call.args}`);
    assert.ok(call.args.startsWith(`-C ${checkout} `), `every git call is addressed to the repository root: ${call.args}`);
  }
  console.log(`git calls made by the stacked review path (${calls.length}), each from the repository root:\n${calls.map((call) => `  ${call.args.replace(home, "<home>").replaceAll(realpathSync(home), "<home>")}`).join("\n")}`);

  // And the diff still captures everything a review needs, against the refreshed parent.
  assert.equal(diff.ok, true, diff.error ?? "");
  assert.equal(diff.base, "feat/parent");
  assert.equal(diff.baseSha, cutAt.slice(0, 12));
  assert.equal(diff.branch, "feat/child");
  assert.equal(diff.repoRoot, worktree, "paths stay relative to the child's checkout");
  assert.match(diff.patch, /\+\+\+ b\/child\.txt/, "committed work");
  assert.match(diff.patch, /\+uncommitted edit/, "an uncommitted edit");
  assert.match(diff.patch, /\+\+\+ b\/draft\.txt/, "an untracked file");
  assert.doesNotMatch(diff.patch, /noise\.log/, "an ignored file is not review content");
  assert.doesNotMatch(diff.patch, /parent\.txt/, "the parent's own work is not the child's diff");
  assert.equal(diff.filesChanged, 3);

  // Reading it changed nothing in the child: same status, byte-identical index.
  assert.equal(git(worktree, "status", "--porcelain"), statusBefore);
  assert.deepEqual(readFileSync(join(git(worktree, "rev-parse", "--git-dir"), "index")), indexBefore);
});
