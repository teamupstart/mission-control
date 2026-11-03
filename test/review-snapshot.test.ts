import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureReviewSnapshot,
  pruneReviewSnapshots,
  REVIEW_SNAPSHOT_REF_PREFIX,
  REVIEW_SNAPSHOT_RETENTION_MS,
  reviewSnapshotRef,
} from "../src/server/git/review-snapshot.ts";

// What is at stake: a ship task submits its work to a workflow BEFORE committing it. Commands
// and CodeRabbit run in a lease pinned to one commit, so without a snapshot they reviewed the
// base the task started from - or, for CodeRabbit, refused to run at all. The snapshot must
// hold exactly what was submitted, and capturing it must not touch the checkout.

const tmp = mkdtempSync(join(tmpdir(), "mission-review-snapshot-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();
}

let counter = 0;
function repo(): string {
  const dir = join(tmp, `repo-${counter++}`);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "kept.txt"), "base\n");
  writeFileSync(join(dir, "removed.txt"), "gone soon\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

test("a clean checkout reviews HEAD itself and writes no ref", async () => {
  const dir = repo();
  const head = git(dir, "rev-parse", "HEAD");
  const snapshot = await captureReviewSnapshot(dir);
  assert.deepEqual(snapshot, { treeOid: git(dir, "rev-parse", "HEAD^{tree}"), headOid: head, commitOid: head, ref: null });
  assert.equal(git(dir, "for-each-ref", REVIEW_SNAPSHOT_REF_PREFIX), "");
});

test("uncommitted work becomes a commit on HEAD holding exactly the submitted content", async () => {
  const dir = repo();
  const head = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "kept.txt"), "edited\n");
  writeFileSync(join(dir, "staged.txt"), "staged\n");
  git(dir, "add", "staged.txt");
  writeFileSync(join(dir, "untracked.txt"), "new file\n");
  writeFileSync(join(dir, "ignored.log"), "never reviewed\n");
  rmSync(join(dir, "removed.txt"));
  const indexBefore = readFileSync(join(dir, ".git", "index"));
  const statusBefore = git(dir, "status", "--porcelain");

  const snapshot = await captureReviewSnapshot(dir);

  assert.notEqual(snapshot.commitOid, head);
  assert.equal(snapshot.headOid, head);
  assert.equal(snapshot.ref, reviewSnapshotRef(snapshot.commitOid));
  assert.equal(git(dir, "rev-parse", `${snapshot.ref}^{commit}`), snapshot.commitOid);
  assert.equal(git(dir, "rev-parse", `${snapshot.commitOid}^`), head);
  assert.equal(git(dir, "rev-parse", `${snapshot.commitOid}^{tree}`), snapshot.treeOid);
  assert.equal(git(dir, "show", `${snapshot.commitOid}:kept.txt`), "edited");
  assert.equal(git(dir, "show", `${snapshot.commitOid}:staged.txt`), "staged");
  assert.equal(git(dir, "show", `${snapshot.commitOid}:untracked.txt`), "new file");
  assert.deepEqual(git(dir, "ls-tree", "--name-only", snapshot.commitOid).split("\n").sort(),
    [".gitignore", "kept.txt", "staged.txt", "untracked.txt"]);
  // Nothing about the checkout moved: branch, HEAD, real index and status are untouched.
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
  assert.equal(git(dir, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.deepEqual(readFileSync(join(dir, ".git", "index")), indexBefore);
  assert.equal(git(dir, "status", "--porcelain"), statusBefore);
});

test("a linked worktree of the same repository can check the snapshot out", async () => {
  const dir = repo();
  writeFileSync(join(dir, "kept.txt"), "edited\n");
  const snapshot = await captureReviewSnapshot(dir);
  const lease = join(tmp, `lease-${counter++}`);
  git(dir, "worktree", "add", "--detach", lease, snapshot.commitOid);
  assert.equal(readFileSync(join(lease, "kept.txt"), "utf8"), "edited\n");
});

test("captures fail-safe without a configured identity", async () => {
  const dir = repo();
  git(dir, "config", "--unset", "user.email");
  git(dir, "config", "--unset", "user.name");
  writeFileSync(join(dir, "kept.txt"), "edited\n");
  const snapshot = await captureReviewSnapshot(dir);
  assert.equal(git(dir, "log", "-1", "--format=%an <%ae>", snapshot.commitOid), "Mission Control <mission-control@localhost>");
});

test("expired snapshot refs are pruned and fresh ones and foreign refs are kept", async () => {
  const dir = repo();
  const now = Date.now();
  writeFileSync(join(dir, "kept.txt"), "old\n");
  const old = await captureReviewSnapshot(dir, now - REVIEW_SNAPSHOT_RETENTION_MS - 60_000);
  writeFileSync(join(dir, "kept.txt"), "fresh\n");
  const fresh = await captureReviewSnapshot(dir, now);
  git(dir, "update-ref", `${REVIEW_SNAPSHOT_REF_PREFIX}/not-an-oid`, "HEAD");
  // The fresh capture already pruned the expired ref on its way out.
  assert.deepEqual(await pruneReviewSnapshots(dir, now), []);
  const refs = git(dir, "for-each-ref", "--format=%(refname)", REVIEW_SNAPSHOT_REF_PREFIX).split("\n").sort();
  assert.deepEqual(refs, [fresh.ref, `${REVIEW_SNAPSHOT_REF_PREFIX}/not-an-oid`].sort());
  assert.ok(!refs.includes(old.ref!));
});

test("a snapshot ref name only ever carries an object id", () => {
  assert.throws(() => reviewSnapshotRef("../heads/main"), /invalid git object id/);
});
