import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureWorktreeSnapshot,
  ensembleSnapshotRef,
  materializeSnapshotDiff,
  resetWorktreeToCommit,
  resolveEnsembleRef,
  restoreSnapshotIntoWorktree,
} from "../src/server/git/ensemble-snapshot.ts";

// What is at stake: taking a picture of an agent's work without touching the work.
//
// A member may be mid-task with a deliberately staged index, an amended commit behind it,
// and a warm `node_modules` it did not pay for twice. A capture that ran `git add` and
// `git commit` through the real index would silently rewrite the first, move the branch,
// and hand back an "artifact" that is really an edit. None of that is visible afterwards:
// the agent just finds its staging area different from how it left it.
//
// So the properties here are (1) the snapshot contains the COMPLETE submitted worktree -
// committed, staged, unstaged, deleted, renamed, binary and untracked-but-nonignored - and
// (2) nothing about the member's own git state moved: index bytes, HEAD, branch, files.
// Plus the two things the artifact exists for: it outlives the worktree, and it restores
// exactly.

const tmp = mkdtempSync(join(tmpdir(), "mission-ensemble-snapshot-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();
}

/** The git dir of this exact checkout - a linked worktree has its own, holding its own index. */
function indexBytes(dir: string): Buffer {
  return readFileSync(join(git(dir, "rev-parse", "--absolute-git-dir"), "index"));
}

/**
 * A repo whose base commit has the shape the member edits below need, plus a linked
 * worktree cut from that commit - which is what a dispatched task actually gets.
 */
function mkRepoWithMember(name: string): { repo: string; member: string; baseSha: string } {
  const repo = join(tmp, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@test");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), "cache/\n");
  writeFileSync(join(repo, "keep.txt"), "base\n");
  writeFileSync(join(repo, "staged.txt"), "before staging\n");
  writeFileSync(join(repo, "unstaged.txt"), "before editing\n");
  writeFileSync(join(repo, "doomed.txt"), "about to be deleted\n");
  writeFileSync(join(repo, "moves.txt"), "this file gets renamed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const baseSha = git(repo, "rev-parse", "HEAD");

  const member = join(tmp, `${name}-member`);
  git(repo, "worktree", "add", "-q", "-b", `member/${name}`, member, baseSha);
  git(member, "config", "user.email", "m@test");
  git(member, "config", "user.name", "m");
  return { repo, member, baseSha };
}

/** Every way a working tree can differ from its base, all at once. */
function diverge(member: string): void {
  // Committed on top of the base.
  writeFileSync(join(member, "committed.txt"), "landed in a commit\n");
  git(member, "add", "committed.txt");
  git(member, "commit", "-qm", "member commit");
  // Staged but not committed.
  writeFileSync(join(member, "staged.txt"), "after staging\n");
  git(member, "add", "staged.txt");
  // Edited and left unstaged.
  writeFileSync(join(member, "unstaged.txt"), "after editing\n");
  // Deleted.
  rmSync(join(member, "doomed.txt"));
  // Renamed (staged, which is how git records a rename).
  git(member, "mv", "moves.txt", "moved.txt");
  // Binary.
  writeFileSync(join(member, "logo.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x7f]));
  // Untracked and NOT ignored - real work that has never been added.
  writeFileSync(join(member, "untracked.txt"), "written but never added\n");
  // Ignored - a warm cache the pool paid for once. Must not become the artifact.
  mkdirSync(join(member, "cache"), { recursive: true });
  writeFileSync(join(member, "cache", "warm.bin"), "expensive\n");
}

/** `path -> content` for every file in a commit's tree. */
function treeOf(repo: string, sha: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of git(repo, "ls-tree", "-r", "--name-only", sha).split("\n").filter(Boolean)) {
    out[line] = execFileSync("git", ["-C", repo, "show", `${sha}:${line}`], { stdio: "pipe" })
      .toString("latin1");
  }
  return out;
}

// ---- what the snapshot contains -------------------------------------------------------

test("a snapshot is the complete submitted worktree, ignored caches excluded", async () => {
  const { repo, member } = mkRepoWithMember("complete");
  diverge(member);

  const captured = await captureWorktreeSnapshot({
    worktreePath: member,
    ensembleId: randomUUID(),
    artifactId: randomUUID(),
  });

  const tree = treeOf(repo, captured.snapshotSha);
  assert.equal(tree["committed.txt"], "landed in a commit\n", "committed after the base");
  assert.equal(tree["staged.txt"], "after staging\n", "staged");
  assert.equal(tree["unstaged.txt"], "after editing\n", "unstaged - the worktree wins");
  assert.equal(tree["doomed.txt"], undefined, "deleted");
  assert.equal(tree["moves.txt"], undefined, "renamed away");
  assert.equal(tree["moved.txt"], "this file gets renamed\n", "renamed to");
  assert.equal(tree["untracked.txt"], "written but never added\n", "untracked but not ignored");
  assert.ok("logo.bin" in tree, "binary");
  assert.equal(tree["cache/warm.bin"], undefined, "an ignored warm cache is not the artifact");

  // The parent is the member's own HEAD, so the artifact reads as a commit on their work
  // rather than as an orphan.
  assert.equal(captured.parentSha, git(member, "rev-parse", "HEAD"));
  assert.equal(git(repo, "rev-parse", `${captured.snapshotSha}^{tree}`), captured.treeSha);
});

test("capturing does not touch the member's index, HEAD, branch or files", async () => {
  const { member } = mkRepoWithMember("untouched");
  diverge(member);

  const before = {
    index: indexBytes(member),
    head: git(member, "rev-parse", "HEAD"),
    branch: git(member, "rev-parse", "--abbrev-ref", "HEAD"),
    status: git(member, "status", "--porcelain"),
    unstaged: readFileSync(join(member, "unstaged.txt"), "utf8"),
    cache: readFileSync(join(member, "cache", "warm.bin"), "utf8"),
  };

  await captureWorktreeSnapshot({
    worktreePath: member,
    ensembleId: randomUUID(),
    artifactId: randomUUID(),
  });

  // Byte-for-byte, because the staged/unstaged SPLIT is the thing a real-index commit
  // would have silently collapsed - and `status` alone would still look plausible after it.
  assert.deepEqual(indexBytes(member), before.index, "the real index is untouched");
  assert.equal(git(member, "rev-parse", "HEAD"), before.head);
  assert.equal(git(member, "rev-parse", "--abbrev-ref", "HEAD"), before.branch);
  assert.equal(git(member, "status", "--porcelain"), before.status);
  assert.equal(readFileSync(join(member, "unstaged.txt"), "utf8"), before.unstaged);
  assert.equal(readFileSync(join(member, "cache", "warm.bin"), "utf8"), before.cache);
});

test("an unborn branch snapshots rather than failing", async () => {
  // A freshly `git init`ed tree is a real state, and `read-tree HEAD` cannot describe it.
  const repo = join(tmp, "unborn");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "first.txt"), "no commits yet\n");

  const captured = await captureWorktreeSnapshot({
    worktreePath: repo,
    ensembleId: randomUUID(),
    artifactId: randomUUID(),
  });
  assert.equal(captured.parentSha, null);
  assert.equal(treeOf(repo, captured.snapshotSha)["first.txt"], "no commits yet\n");
});

// ---- the ref -------------------------------------------------------------------------

test("a ref component that is not a generated id never reaches update-ref", () => {
  for (const bad of ["../../heads/main", "main", "", "..", `${randomUUID()}/x`]) {
    assert.throws(() => ensembleSnapshotRef(bad, randomUUID()), /generated UUID/, `should reject: ${bad}`);
    assert.throws(() => ensembleSnapshotRef(randomUUID(), bad), /generated UUID/, `should reject: ${bad}`);
  }
  const ok = ensembleSnapshotRef("11111111-2222-3333-4444-555555555555", "66666666-7777-8888-9999-aaaaaaaaaaaa");
  assert.equal(ok, "refs/mission-control/ensembles/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-aaaaaaaaaaaa");
});

test("the ref outlives the worktree it came from, and restores the exact tree", async () => {
  const { repo, member, baseSha } = mkRepoWithMember("outlives");
  diverge(member);
  const captured = await captureWorktreeSnapshot({
    worktreePath: member,
    ensembleId: randomUUID(),
    artifactId: randomUUID(),
  });
  const expected = treeOf(repo, captured.snapshotSha);

  // Exactly what teardown does to a git-provider tree, plus its throwaway branch.
  const branch = git(member, "rev-parse", "--abbrev-ref", "HEAD");
  git(repo, "worktree", "remove", "--force", member);
  git(repo, "branch", "-D", branch);
  assert.equal(existsSync(member), false);

  // Refs live in the SHARED git dir, so the artifact is still there and still names its
  // commit - which is what keeps the commit itself from being collected.
  assert.equal(await resolveEnsembleRef(repo, captured.ref), captured.snapshotSha);

  // Put it back into a fresh tree cut from the base, the way a restore does.
  const fresh = join(tmp, "outlives-restored");
  git(repo, "worktree", "add", "-q", "--detach", fresh, baseSha);
  await restoreSnapshotIntoWorktree({
    worktreePath: fresh,
    ref: captured.ref,
    snapshotSha: captured.snapshotSha,
  });

  assert.equal(git(fresh, "rev-parse", "HEAD"), captured.snapshotSha);
  assert.equal(git(fresh, "status", "--porcelain"), "", "the restored tree is exactly the commit");
  for (const [path, content] of Object.entries(expected)) {
    assert.equal(readFileSync(join(fresh, path), "latin1"), content, path);
  }
});

test("a restore whose ref no longer names the expected commit refuses to reset anything", async () => {
  const { repo, member } = mkRepoWithMember("mismatch");
  writeFileSync(join(member, "keep.txt"), "member work\n");
  const captured = await captureWorktreeSnapshot({
    worktreePath: member,
    ensembleId: randomUUID(),
    artifactId: randomUUID(),
  });
  const other = git(repo, "rev-parse", "HEAD");

  await assert.rejects(
    restoreSnapshotIntoWorktree({ worktreePath: member, ref: captured.ref, snapshotSha: other }),
    /resolves to/,
  );
  // The refusal is the point: a hard reset had not run, so the member's edit is still here.
  assert.equal(readFileSync(join(member, "keep.txt"), "utf8"), "member work\n");

  await assert.rejects(
    restoreSnapshotIntoWorktree({
      worktreePath: member,
      ref: "refs/heads/main",
      snapshotSha: captured.snapshotSha,
    }),
    /not a Mission Control ensemble ref/,
  );
});

// ---- resetting a tree to a commit ------------------------------------------------------

test("a reset drops untracked work but keeps ignored caches", async () => {
  const { member, baseSha } = mkRepoWithMember("reset");
  diverge(member);

  await resetWorktreeToCommit(member, baseSha);

  assert.equal(git(member, "rev-parse", "HEAD"), baseSha);
  assert.equal(git(member, "status", "--porcelain"), "", "nothing tracked or untracked is left over");
  assert.equal(existsSync(join(member, "untracked.txt")), false, "someone else's leftovers go");
  assert.equal(existsSync(join(member, "committed.txt")), false, "so does a commit past the base");
  // `-fd`, never `-fdx`: erasing this is the difference between a pre-warmed pool and one
  // that re-pays every install.
  assert.equal(readFileSync(join(member, "cache", "warm.bin"), "utf8"), "expensive\n");
});

test("only a full commit id can drive a reset", async () => {
  const { member, baseSha } = mkRepoWithMember("reset-ids");
  for (const bad of [baseSha.slice(0, 12), "main", "HEAD", "$(id)", ""]) {
    await assert.rejects(resetWorktreeToCommit(member, bad), /full 40-character commit id/);
  }
});

// ---- materializing the difference ------------------------------------------------------

test("the diff is base-to-snapshot exactly, with renames and binaries marked", async () => {
  const { repo, member, baseSha } = mkRepoWithMember("diff");
  diverge(member);
  // Rebase-like history rewriting before submission is legal, and the snapshot is still an
  // exact artifact - which is why this diffs two commits rather than walking a merge-base.
  git(member, "commit", "-q", "--amend", "-m", "amended after the base");
  const captured = await captureWorktreeSnapshot({
    worktreePath: member,
    ensembleId: randomUUID(),
    artifactId: randomUUID(),
  });

  const diff = await materializeSnapshotDiff({
    repoPath: repo,
    baseSha,
    snapshotSha: captured.snapshotSha,
  });

  assert.equal(diff.baseSha, baseSha);
  assert.equal(diff.snapshotSha, captured.snapshotSha);
  const byPath = new Map(diff.files.map((f) => [f.path, f]));
  assert.equal(byPath.get("moved.txt")?.oldPath, "moves.txt", "a rename names where it came from");
  assert.equal(byPath.get("logo.bin")?.binary, true);
  assert.equal(byPath.get("logo.bin")?.insertions, 0, "a binary reports no line counts");
  assert.ok(byPath.has("untracked.txt"), "untracked work is part of the difference");
  assert.ok(byPath.has("doomed.txt"), "so is a deletion");
  assert.equal(diff.filesChanged, diff.files.length);
  assert.equal(diff.truncated, false);
  assert.equal(diff.omittedBytes, 0);
  assert.match(diff.patch, /^diff --git /m);
});

test("truncation reports exactly how much it left out", async () => {
  const { repo, member, baseSha } = mkRepoWithMember("truncation");
  writeFileSync(join(member, "big.txt"), Array.from({ length: 4000 }, (_, i) => `line ${i}\n`).join(""));
  const captured = await captureWorktreeSnapshot({
    worktreePath: member,
    ensembleId: randomUUID(),
    artifactId: randomUUID(),
  });

  const whole = await materializeSnapshotDiff({
    repoPath: repo,
    baseSha,
    snapshotSha: captured.snapshotSha,
    maxPatchBytes: 10_000_000,
  });
  const capped = await materializeSnapshotDiff({
    repoPath: repo,
    baseSha,
    snapshotSha: captured.snapshotSha,
    maxPatchBytes: 2048,
  });

  assert.equal(whole.truncated, false);
  assert.equal(capped.truncated, true);
  const keptBytes = Buffer.byteLength(capped.patch, "utf8");
  assert.ok(keptBytes <= 2048, `kept ${keptBytes} bytes for a 2048 budget`);
  // Honest means the two numbers add up to the patch that exists, not to a guess.
  assert.equal(keptBytes + capped.omittedBytes, Buffer.byteLength(whole.patch, "utf8"));
  assert.ok(capped.patch.endsWith("\n"), "cut at a line boundary, not mid-hunk");
  // The statistics are never capped - a truncated patch beside complete counts is what
  // lets a reader tell a small change from a large one they only saw the start of.
  assert.deepEqual(capped.files, whole.files);
});

test("a diff between ids that are not full commits is refused", async () => {
  const { repo, baseSha } = mkRepoWithMember("diff-ids");
  await assert.rejects(
    materializeSnapshotDiff({ repoPath: repo, baseSha: "HEAD", snapshotSha: baseSha }),
    /full 40-character commit id/,
  );
});
