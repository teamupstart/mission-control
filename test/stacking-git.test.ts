import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import type { PrRefs } from "../src/server/inspector/github.ts";
import type { WorkflowBinding } from "../src/shared/workflow.ts";

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

function parentGitHub(over: Partial<PrRefs> = {}) {
  return {
    ...defaultStackGitHub,
    prRefs: async () => ({ ok: true, value: {
      state: "OPEN" as const, isDraft: false, headSha: "a".repeat(40),
      headRefName: "feat/parent", baseRefName: "main", defaultBranch: "main", mergeCommitSha: null,
      ...over,
    } }),
  };
}

for (const parentState of ["MERGED", "OPEN"] as const) {
  test(`workflow capture and resubmit probe recover with parent state ${parentState} and deleted branch`, async (t) => {
    const { author, checkout } = fixture();
    const cutAt = git(checkout, "rev-parse", "origin/feat/parent");
    const worktree = join(dirname(checkout), "child-capture");
    git(checkout, "worktree", "add", "-q", "-b", "feat/child-capture", worktree, cutAt);
    commit(worktree, "child.txt", "child\n", "child work");
    git(author, "checkout", "-q", "main");
    if (parentState === "MERGED") {
      git(author, "merge", "-q", "--squash", "feat/parent");
      git(author, "commit", "-q", "-m", "Parent (#7)");
      git(author, "push", "-q", "origin", "main");
    }
    git(author, "push", "-q", "origin", "--delete", "feat/parent");
    const squash = git(author, "rev-parse", "main");
    const task = mkTask({
      id: "child-capture", status: "running", repoRoot: checkout, stackParentTaskId: "parent",
      stackBaseBranch: "feat/parent", stackBaseSha: cutAt, stackPrUrl: "https://github.com/acme/repo/pull/7",
      dependencies: [{ type: "task", taskId: "parent", title: "Parent", episodeId: "parent-episode", sessionId: null,
        agentSessionId: null, branch: "feat/parent", prUrl: "https://github.com/acme/repo/pull/7",
        selectedAt: 1, satisfiedAt: parentState === "MERGED" ? 2 : null, mode: "stack", stackReadyAt: 1,
        stackBaseBranch: "feat/parent", stackBaseSha: cutAt, stackPrUrl: "https://github.com/acme/repo/pull/7" }],
    });
    const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
    const { readWorkflowContextRaw, readWorkflowEvidenceProbe, probeMatchesEvidence, captureBoundaryChanged } =
      await import("../src/server/workflows/context.ts");
    const registry = new Registry();
    const session = mkSession({ id: "capture-session", cwd: worktree, repoRoot: checkout, gitBranch: "feat/child-capture" });
    t.mock.method(registry, "getSession", () => session);
    t.mock.method(registry, "taskForSession", () => task);
    t.mock.method(registry, "workEpisodeForSession", () => null);
    t.mock.method(defaultStackGitHub, "prRefs", async (cwd: string, url: string) => {
      assert.equal(cwd, checkout);
      assert.equal(url, task.stackPrUrl);
      return { ok: true, value: { state: parentState, isDraft: false, headSha: cutAt,
        headRefName: "feat/parent", baseRefName: "main", defaultBranch: "main", mergeCommitSha: parentState === "MERGED" ? squash : null } };
    });
    const binding = { id: "capture-binding", sessionId: session.id, noteKey: noteKeyFor(session), repoRoot: checkout, sessionCwd: worktree } as WorkflowBinding;
    const before = git(worktree, "rev-parse", "HEAD");
    // Even before restacking, capture must succeed without changing the child's branch.
    const captured = await readWorkflowContextRaw(registry, binding);
    assert.match(captured.raw.evidence.diff, /child\.txt/);
    assert.equal(git(worktree, "rev-parse", "HEAD"), before);
    assert.equal(await captureBoundaryChanged(registry, binding, captured.boundary), false);
    assert.equal(probeMatchesEvidence(await readWorkflowEvidenceProbe(registry, binding), captured.context.evidence), true);
    const base = await resolveStackDiffBase(registry, session, checkout);
    assert.equal(base?.branch, "main");
    assert.equal(base?.sha, squash);
    // The session merges the new base. A merged parent's work then leaves the diff;
    // an unmerged parent's work must remain visible when reviewing against default.
    git(worktree, "merge", "-q", "--no-edit", "origin/main");
    writeFileSync(join(worktree, "draft.txt"), "uncommitted child work\n");
    const restacked = await readWorkflowContextRaw(registry, binding);
    assert.match(restacked.raw.evidence.diff, /child\.txt/);
    assert.match(restacked.raw.evidence.diff, /draft\.txt/);
    if (parentState === "MERGED") assert.doesNotMatch(restacked.raw.evidence.diff, /parent\.txt/);
    else assert.match(restacked.raw.evidence.diff, /parent\.txt/, "unmerged parent work remains visible against default");
    assert.equal(probeMatchesEvidence(await readWorkflowEvidenceProbe(registry, binding), restacked.context.evidence), true);
    assert.equal(task.stackBaseSha, cutAt, "dispatch provenance is retained for lineage and release checks");
  });
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

test("a stack without a parent PR URL captures against the freshly verified parent branch", async () => {
  const { author, checkout } = fixture();
  const cutAt = git(checkout, "rev-parse", "origin/feat/parent");
  const worktree = join(dirname(checkout), "child-no-parent-pr");
  git(checkout, "worktree", "add", "-q", "-b", "feat/child-no-parent-pr", worktree, cutAt);
  commit(worktree, "child.txt", "child\n", "child work");
  const moved = commit(author, "parent.txt", "parent v2\n", "parent repair");
  git(author, "push", "-q", "origin", "feat/parent");
  const task = mkTask({
    id: "child-no-parent-pr", status: "running", repoRoot: checkout, stackParentTaskId: "parent",
    stackBaseBranch: "feat/parent", stackBaseSha: cutAt, stackPrUrl: null,
  });
  const registry = { taskForSession: () => task, workEpisodeForSession: () => null };
  const base = await resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, checkout, {
    ...defaultStackGitHub,
    prRefs: async () => { throw new Error("no parent PR exists to query"); },
  });
  assert.ok(base);
  assert.equal(base.branch, "feat/parent");
  assert.equal(base.sha, moved, "the recorded branch is refreshed, not the dispatch-time SHA");
  const diff = await computeStackedDiff({
    repoRoot: base.repoRoot, worktree, head: base.head, branch: base.headBranch, mergeBase: base.mergeBase, label: base.branch,
  });
  assert.equal(diff.ok, true, diff.error ?? "");
  assert.match(diff.patch, /child\.txt/);
  assert.doesNotMatch(diff.patch, /parent\.txt/);
});

test("before a child PR exists, capture follows the current parent state and refuses unknown bases", async () => {
  const { author, checkout } = fixture();
  const cutAt = git(checkout, "rev-parse", "origin/feat/parent");
  const worktree = join(dirname(checkout), "child-state");
  git(checkout, "worktree", "add", "-q", "-b", "feat/child-state", worktree, cutAt);
  git(author, "push", "-q", "origin", "main:refs/heads/release/next", "feat/parent:refs/heads/feat/renamed");
  const task = mkTask({
    id: "child-state", status: "running", repoRoot: checkout, stackParentTaskId: "parent",
    stackBaseBranch: "feat/parent", stackBaseSha: cutAt, stackPrUrl: "https://github.com/acme/repo/pull/7",
  });
  const registry = { taskForSession: () => task, workEpisodeForSession: () => null };
  const session = { id: "state-session", cwd: worktree };
  // No satisfied edge is required: a fresh parent observation beats the watcher, and a
  // retained parent branch must not keep a finished parent as the review base either.
  for (const state of ["OPEN", "MERGED", "CLOSED"] as const) {
    const base = await resolveStackDiffBase(registry, session, checkout,
      parentGitHub({ state, headRefName: "feat/renamed", defaultBranch: "release/next" }));
    assert.equal(base?.branch, state === "OPEN" ? "feat/renamed" : "release/next");
  }
  await assert.rejects(resolveStackDiffBase(registry, session, checkout, {
    ...parentGitHub(), prRefs: async () => ({ ok: false, error: "HTTP 502 (fake)" }),
  }), /could not resolve the base from parent.*HTTP 502/);
  await assert.rejects(resolveStackDiffBase(registry, session, checkout,
    parentGitHub({ state: "MERGED", defaultBranch: "" })), StackDiffBaseError);
  await assert.rejects(resolveStackDiffBase(registry, session, checkout,
    parentGitHub({ headRefName: "" })), StackDiffBaseError);
  await assert.rejects(resolveStackDiffBase(registry, session, checkout,
    parentGitHub({ state: "MERGED", defaultBranch: "missing-default" })), /stacked base could not be refreshed: missing-default/);
});

test("freshRemoteBranchSha refuses a deleted branch, a bad name, and a disagreement", async () => {
  const { author, checkout } = fixture();
  git(author, "push", "-q", "origin", "--delete", "feat/parent");
  const gone = await freshRemoteBranchSha(checkout, "feat/parent");
  assert.equal(gone.ok, false);
  assert.equal(!gone.ok && gone.code, "branch_missing");
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

test("branch deletion is classified only from a successful empty remote advertisement", async () => {
  const success = { code: 0, stdout: "", stderr: "", outcomeUnknown: false, overflowed: false };
  const fetchFailure = { ...success, code: 1, stderr: "fetch failed" };
  for (const [label, fetch, listed, missing] of [
    ["deleted", fetchFailure, success, true],
    ["deleted after fetch", success, success, true],
    ["authentication failure", fetchFailure, { ...success, code: 128, stderr: "permission denied" }, false],
    ["listing timed out", fetchFailure, { ...success, outcomeUnknown: true }, false],
    ["listing overflowed", fetchFailure, { ...success, overflowed: true }, false],
    ["fetch timed out", { ...fetchFailure, outcomeUnknown: true }, success, false],
    ["fetch overflowed", { ...fetchFailure, overflowed: true }, success, false],
    ["branch exists", fetchFailure, { ...success, stdout: `${"a".repeat(40)}\trefs/heads/feat/x\n` }, false],
    ["malformed listing", fetchFailure, { ...success, stdout: "unreadable" }, false],
  ] as const) {
    const result = await freshRemoteBranchSha("/repo", "feat/x", async (_cmd, args) =>
      args[2] === "fetch" ? fetch : listed);
    assert.equal(result.ok, false, label);
    assert.equal(!result.ok && result.code === "branch_missing", missing, label);
  }
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
  const base = await resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, null, parentGitHub(), worktree, recordingGit);
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
    resolveStackDiffBase(registry, { id: "s1", cwd: author }, null, parentGitHub(), author),
    (error: unknown) => error instanceof StackDiffBaseError && /is not a worktree of/.test(String(error)),
  );

  // A confirmed missing branch selects the default even while GitHub says OPEN.
  git(author, "push", "-q", "origin", "--delete", "feat/parent");
  const recovered = await resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, null, parentGitHub());
  assert.equal(recovered?.branch, "main");
  assert.equal(recovered?.sha, git(author, "rev-parse", "main"));
  // An unreachable remote is not evidence of a missing branch and still fails.
  git(checkout, "remote", "set-url", "origin", join(home, "does-not-exist.git"));
  await assert.rejects(resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, null, parentGitHub()), StackDiffBaseError);
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

test("the lifecycle's prompts in git: catch up with a moved parent, then restack after its squash merge, never force-pushing", () => {
  const { author, checkout } = fixture();
  git(checkout, "fetch", "-q", "origin");
  // Cut from the parent, as a stacked dispatch does, and pushed as the child's pull request.
  git(checkout, "checkout", "-q", "-b", "feat/child", "origin/feat/parent");
  commit(checkout, "child.txt", "child\n", "child work");
  git(checkout, "push", "-q", "-u", "origin", "feat/child");
  // A review repair lands on the parent: the catch-up prompt merges the parent branch in.
  git(author, "checkout", "-q", "feat/parent");
  commit(author, "parent.txt", "parent v2\n", "parent repair");
  git(author, "push", "-q", "origin", "feat/parent");
  git(checkout, "fetch", "-q", "origin");
  git(checkout, "merge", "-q", "--no-edit", "origin/feat/parent");
  git(checkout, "push", "-q", "origin", "feat/child"); // a plain push: the branch only moved forward
  // The parent squash-merges (with its repair) and the restack prompt merges origin/main in.
  git(author, "checkout", "-q", "main");
  git(author, "merge", "-q", "--squash", "feat/parent");
  git(author, "commit", "-q", "-m", "Parent (#7)");
  git(author, "push", "-q", "origin", "main");
  git(checkout, "fetch", "-q", "origin");
  git(checkout, "merge", "-q", "--no-edit", "origin/main");
  git(checkout, "push", "-q", "origin", "feat/child");
  // The child's diff against main is only its own change, and main's squash commit is in its
  // history - what the release check verifies through GitHub's compare API.
  const changed = git(checkout, "diff", "--name-only", "origin/main...HEAD").split("\n").filter(Boolean);
  assert.deepEqual(changed, ["child.txt"]);
  assert.doesNotThrow(() => git(checkout, "merge-base", "--is-ancestor", git(checkout, "rev-parse", "origin/main"), "HEAD"));
  assert.equal(git(checkout, "rev-parse", "HEAD"), git(checkout, "rev-parse", "origin/feat/child"));
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

  // The same positive-absence recovery works if the child's adopted PR still names a
  // deleted base. It preserves the actual PR base whenever that branch exists.
  git(author, "push", "-q", "origin", "--delete", "feat/other");
  assert.equal((await resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, null, seam("feat/other"), worktree))?.branch, "main");

  // Unreadable or unreported: the capture fails visibly instead of guessing a base.
  await assert.rejects(
    resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, null, seam(null, false), worktree),
    (error: unknown) => error instanceof StackDiffBaseError && /could not read the current base of .*pull\/71.*HTTP 502/.test(String(error)),
  );
  await assert.rejects(resolveStackDiffBase(registry, { id: "s1", cwd: worktree }, null, seam(null), worktree), StackDiffBaseError);
});
