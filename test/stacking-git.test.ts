import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

// Stacked pull requests against real git: the one-branch refresh at the repository root, the
// stacked review diff after the parent moved, and the merge-based restack after a squash.
// Each fixture is a bare "origin" plus clones, so nothing leaves the temp dir.

const home = mkdtempSync(join(tmpdir(), "mission-stacking-git-"));
process.env.HARNESS_HOME = home;
const { freshRemoteBranchSha } = await import("../src/server/git/remote-default.ts");
const { computeStackedDiff } = await import("../src/server/diff.ts");
const { resolveStackDiffBase, StackDiffBaseError } = await import("../src/server/stacking/diff-base.ts");
const { openDb, adoptInspectorPr, recordInspectorPrLineage, updateInspectorPr } = await import("../src/server/db.ts");
const { defaultStackGitHub } = await import("../src/server/stacking/github.ts");
openDb();
after(() => rmSync(home, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
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

/** origin (bare), a "remote author" clone that pushes, and the operator's main checkout. */
function fixture(): { origin: string; author: string; checkout: string } {
  const root = mkdtempSync(join(home, "repo-"));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const author = join(root, "author");
  git(root, "clone", "-q", origin, author);
  git(author, "checkout", "-q", "-b", "main");
  commit(author, "base.txt", "base\n", "base");
  git(author, "push", "-q", "origin", "main");
  git(author, "checkout", "-q", "-b", "feat/parent");
  commit(author, "parent.txt", "parent v1\n", "parent v1");
  git(author, "push", "-q", "origin", "feat/parent");
  const checkout = join(root, "checkout");
  git(root, "clone", "-q", origin, checkout);
  return { origin, author, checkout };
}

test("freshRemoteBranchSha fetches one branch and returns the tip origin advertises", async () => {
  const { author, checkout } = fixture();
  const tip = git(author, "rev-parse", "feat/parent");
  const result = await freshRemoteBranchSha(checkout, "feat/parent");
  assert.deepEqual(result, { ok: true, value: tip });
  assert.equal(git(checkout, "rev-parse", "refs/remotes/origin/feat/parent"), tip);
  // The worktree's checkout is untouched: still on main, nothing staged.
  assert.equal(git(checkout, "rev-parse", "--abbrev-ref", "HEAD"), "main");
});

test("freshRemoteBranchSha refuses a deleted branch, a bad name, and a disagreement", async () => {
  const { author, checkout } = fixture();
  git(author, "push", "-q", "origin", "--delete", "feat/parent");
  const gone = await freshRemoteBranchSha(checkout, "feat/parent");
  assert.equal(gone.ok, false);
  assert.equal((await freshRemoteBranchSha(checkout, "--upload-pack=evil")).ok, false);
  assert.equal((await freshRemoteBranchSha(checkout, "a..b")).ok, false);

  // The remote moved between the fetch and the observation.
  const fake = async (_cmd: string, args: readonly string[]) => {
    const verb = args[2];
    const out = verb === "ls-remote" ? `${"a".repeat(40)}\trefs/heads/feat/x\n` : verb === "rev-parse" ? `${"b".repeat(40)}\n` : "";
    return { code: 0, stdout: out, stderr: "", outcomeUnknown: false, overflowed: false } as never;
  };
  const moved = await freshRemoteBranchSha("/repo", "feat/x", fake as never);
  assert.equal(moved.ok, false);
  assert.match(!moved.ok ? moved.reason : "", /moved during the observation/);
});

test("a stacked review diff refreshes a parent that moved after the child was cut", async () => {
  const { author, checkout } = fixture();
  // The child is a LINKED WORKTREE of the main checkout, as a native task slot is, cut from
  // the parent's head as it stood at dispatch.
  git(checkout, "fetch", "-q", "origin");
  const cutAt = git(checkout, "rev-parse", "origin/feat/parent");
  const worktree = join(dirname(checkout), "child-worktree");
  git(checkout, "worktree", "add", "-q", "-b", "feat/child", worktree, cutAt);
  commit(worktree, "child.txt", "child\n", "child work");
  const childHead = git(worktree, "rev-parse", "HEAD");
  // The parent takes a review repair on the remote; the local remote-tracking ref is stale.
  git(author, "checkout", "-q", "feat/parent");
  const repaired = commit(author, "parent.txt", "parent v2\n", "parent repair");
  git(author, "push", "-q", "origin", "feat/parent");
  assert.equal(git(checkout, "rev-parse", "origin/feat/parent"), cutAt, "precondition: stale locally");

  const task = mkTask({
    id: "child", status: "running", repoRoot: checkout, stackParentTaskId: "parent",
    stackBaseBranch: "feat/parent", stackBaseSha: cutAt, stackPrUrl: "https://github.com/acme/repo/pull/7",
  });
  const registry = {
    taskForSession: () => task,
    workEpisodeForSession: () => ({ episodeId: "ep1" }),
  };
  // Every git command the resolver itself runs, with the directory it runs in.
  const calls: { root: string; args: readonly string[] }[] = [];
  const recordingGit = async (root: string, args: readonly string[]) => {
    calls.push({ root, args });
    try {
      return { ok: true, stdout: execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }) };
    } catch {
      return { ok: false, stdout: "" };
    }
  };
  const base = await resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, null, undefined, worktree, recordingGit);
  assert.deepEqual(base, { branch: "feat/parent", sha: repaired, mergeBase: cutAt, repoRoot: checkout, head: childHead, headBranch: "feat/child" });
  // The boundary the review held this phase to: the child's HEAD is read from the repository
  // root (`worktree list`) and the merge base computed there from explicit commit ids. No
  // stacking git command runs inside the child's worktree.
  assert.deepEqual(calls.map((call) => call.args[0]), ["worktree", "merge-base"]);
  assert.ok(calls.every((call) => call.root === checkout), "every resolver git command runs at the repository root");
  assert.deepEqual(calls[1]!.args, ["merge-base", childHead, repaired], "the merge base is computed from explicit commit ids");

  const diff = await computeStackedDiff({
    repoRoot: base!.repoRoot, worktree, head: base!.head, branch: base!.headBranch, mergeBase: base!.mergeBase, label: base!.branch,
  });
  assert.equal(diff.ok, true, diff.error ?? "");
  assert.equal(diff.base, "feat/parent");
  assert.equal(diff.baseSha, cutAt.slice(0, 12));
  assert.match(diff.patch, /child\.txt/);
  assert.doesNotMatch(diff.patch, /parent\.txt/, "the parent's own work is not the child's diff");

  // A run reviewing a secondary repository is never stacked; an unstacked task keeps its rule.
  assert.equal(await resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, "/elsewhere"), null);
  assert.equal(await resolveStackDiffBase({ ...registry, taskForSession: () => mkTask({ id: "plain" }) }, { id: "s1", cwd: worktree }, null), null);
  // A checkout that is not one of this repository's worktrees fails visibly.
  await assert.rejects(
    resolveStackDiffBase(registry, { id: "s1", cwd: author }, null, undefined, author),
    (error: unknown) => error instanceof StackDiffBaseError && /is not a worktree of/.test(String(error)),
  );

  // The remote branch is gone: the diff fails visibly instead of using the stale ref.
  git(author, "push", "-q", "origin", "--delete", "feat/parent");
  await assert.rejects(
    resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, null),
    (error: unknown) => error instanceof StackDiffBaseError && /stacked base could not be refreshed/.test(String(error)),
  );
  // So does a fetch that cannot reach origin at all.
  git(checkout, "remote", "set-url", "origin", join(home, "does-not-exist.git"));
  await assert.rejects(resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, null), StackDiffBaseError);
});

test("a merge-based restack after a squash merge leaves only the child's own change", () => {
  const { author, checkout } = fixture();
  git(checkout, "fetch", "-q", "origin");
  git(checkout, "checkout", "-q", "-b", "feat/child", "origin/feat/parent");
  commit(checkout, "child.txt", "child\n", "child work");
  // The parent squash-merges into main on the remote.
  git(author, "checkout", "-q", "main");
  git(author, "merge", "-q", "--squash", "feat/parent");
  git(author, "commit", "-q", "-m", "Parent (#7)");
  git(author, "push", "-q", "origin", "main");
  // The child restacks by MERGING the new base in - no rebase, no force-push.
  git(checkout, "fetch", "-q", "origin");
  git(checkout, "merge", "-q", "--no-edit", "origin/main");
  const changed = git(checkout, "diff", "--name-only", "origin/main...HEAD").split("\n").filter(Boolean);
  assert.deepEqual(changed, ["child.txt"]);
  // And the squash commit is now in the child's ancestry - the release check's condition.
  const squash = git(checkout, "rev-parse", "origin/main");
  assert.doesNotThrow(() => git(checkout, "merge-base", "--is-ancestor", squash, "HEAD"));
});

test("a stacked child's review diff uses its pull request's CURRENT base, read from GitHub, not the dispatch-time branch", async () => {
  const { author, checkout } = fixture();
  // A second branch on origin, which the child's pull request actually targets.
  git(author, "checkout", "-q", "main");
  git(author, "checkout", "-q", "-b", "feat/other");
  const otherTip = commit(author, "other.txt", "other\n", "other base");
  git(author, "push", "-q", "origin", "feat/other");
  git(checkout, "fetch", "-q", "origin");
  const cutAt = git(checkout, "rev-parse", "origin/feat/parent");
  const worktree = join(dirname(checkout), "child-current-base");
  git(checkout, "worktree", "add", "-q", "-b", "feat/child-cb", worktree, cutAt);
  commit(worktree, "child.txt", "child\n", "child work");

  const task = mkTask({
    id: "child-cb", status: "running", repoRoot: checkout, stackParentTaskId: "parent",
    stackBaseBranch: "feat/parent", stackBaseSha: cutAt, stackPrUrl: "https://github.com/acme/repo/pull/7",
  });
  const registry = { taskForSession: () => task, workEpisodeForSession: () => ({ episodeId: "ep-cb" }) };
  // The child's pull request was adopted moments ago: its row has lineage but no polled base.
  const childUrl = "https://github.com/acme/repo/pull/71";
  adoptInspectorPr({
    key: "acme/repo#71", url: childUrl, owner: "acme", repo: "repo", number: 71, repoRoot: checkout, cwd: worktree,
    sessionId: "s1", source: "hook", state: "open", headSha: null, reviewPosture: null, round: 0, lastReviewedAt: null,
    lastError: null, failCount: 0, lastFailKind: null, nextAttemptAt: null, lastAttemptSha: null, mergedAt: null,
    mergeBlock: null, observedHeadSha: null, observedState: null, observedAt: null, headRefName: null, title: null,
    adoptedAt: 1, updatedAt: 1,
  });
  recordInspectorPrLineage("acme/repo#71", { taskId: "child-cb", episode: "ep-cb", adoptedAt: 1, parentPrUrl: task.stackPrUrl!, baseSha: cutAt, history: [] });
  const asked: string[] = [];
  const seam = (base: string | null, ok = true) => ({
    ...defaultStackGitHub,
    prRefs: async (_cwd: string | null, url: string) => {
      asked.push(url);
      return ok
        ? { ok: true, value: { state: "OPEN" as const, isDraft: false, headSha: "f".repeat(40), headRefName: "feat/child-cb", baseRefName: base ?? "", defaultBranch: "main", mergeCommitSha: null } }
        : { ok: false, error: "HTTP 502 (fake)" };
    },
  });

  const base = await resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, null, seam("feat/other"), worktree);
  assert.deepEqual(asked, [childUrl], "the child's own pull request was read for this review");
  assert.equal(base?.branch, "feat/other", "the PR's current base, not the dispatch-time feat/parent");
  assert.equal(base?.sha, otherTip, "and that base's verified tip");

  // A stale polled value loses to GitHub's current answer too.
  updateInspectorPr("acme/repo#71", { baseRefName: "feat/parent" }, 2);
  assert.equal((await resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, null, seam("feat/other"), worktree))?.branch, "feat/other");

  // Unreadable or unreported: the capture fails visibly instead of guessing a base.
  await assert.rejects(
    resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, null, seam(null, false), worktree),
    (error: unknown) => error instanceof StackDiffBaseError && /could not read the current base of .*pull\/71.*HTTP 502/.test(String(error)),
  );
  await assert.rejects(resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, null, seam(null), worktree), StackDiffBaseError);
});
