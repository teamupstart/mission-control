import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: two agents that were supposed to start from the same place, and did not.
//
// Ordinary dispatch provisions from whatever HEAD or pool lease is available at the moment
// it runs. That is right for one agent and wrong for a comparison: if the source checkout
// moves between two launches, or a warm pool tree happens to sit on a different commit,
// then two candidates diverge for a reason nobody chose and nothing afterwards can detect -
// the diffs simply look different. Pinning is what removes that, and the post-provision
// re-read of HEAD is what proves the pin took rather than assuming it.
//
// The other half is that this must cost NORMAL dispatch nothing. Absent a pinned base every
// path here is the one that shipped: `git worktree add … HEAD`, a lease taken as it comes.
//
// The treehouse arm is exercised through `pinLeasedWorktree` directly. `provisionWorktree`
// only reaches it on a machine with the pool binary installed and a `treehouse.toml` repo,
// and making the suite depend on either would make it pass or fail for reasons that have
// nothing to do with this code.

const home = mkdtempSync(join(tmpdir(), "mission-pinned-base-"));
// Set before importing anything that resolves the state dir - WORKTREES_DIR hangs off it.
process.env.HARNESS_HOME = join(home, "state");

const { WORKTREES_DIR } = await import("../src/server/config.ts");
const { pinLeasedWorktree, provisionWorktree, verifyPinnedBase } =
  await import("../src/server/dispatcher.ts");
const { verifyHeadIs } = await import("../src/server/git/ensemble-snapshot.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const NO_PINS = () => ({ sessionCwds: [], taskWorktrees: [] });

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();
}

/** A repo with two commits, so "the base" and "where HEAD moved to" are different things. */
function mkRepo(name: string): { repo: string; first: string; second: string } {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@test");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "first\n");
  // In the BASE commit, because the rules that decide what a clean spares are the ones the
  // tree is being reset to - a `.gitignore` added later is not in force at that moment.
  writeFileSync(join(repo, ".gitignore"), "cache/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first");
  const first = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "file.txt"), "second\n");
  git(repo, "commit", "-qam", "second");
  return { repo, first, second: git(repo, "rev-parse", "HEAD") };
}

// ---- normal dispatch is unchanged ------------------------------------------------------

test("with no pinned base a worktree still starts at whatever HEAD is now", async () => {
  const { repo, second } = mkRepo("unpinned");
  const wt = await provisionWorktree(repo, "unpinned-task", "slug", "abc123", NO_PINS);

  assert.equal(wt.provider, "git");
  assert.equal(wt.branch, "harness/slug-abc123");
  assert.equal(git(wt.path, "rev-parse", "HEAD"), second);
  assert.equal(readFileSync(join(wt.path, "file.txt"), "utf8"), "second\n");

  // …and it follows HEAD, which is exactly the behaviour a pin exists to opt OUT of.
  writeFileSync(join(repo, "file.txt"), "third\n");
  git(repo, "commit", "-qam", "third");
  const third = git(repo, "rev-parse", "HEAD");
  const later = await provisionWorktree(repo, "unpinned-later", "slug", "def456", NO_PINS);
  assert.equal(git(later.path, "rev-parse", "HEAD"), third);
});

// ---- the pin ---------------------------------------------------------------------------

test("two members pinned to one commit are identical even after the source moves", async () => {
  const { repo, first } = mkRepo("pinned");

  const a = await provisionWorktree(repo, "member-a", "slug", "aaa111", NO_PINS, first);
  // The source checkout moves between the two launches - the exact race the pin removes.
  writeFileSync(join(repo, "file.txt"), "moved on\n");
  git(repo, "commit", "-qam", "moved on");
  const b = await provisionWorktree(repo, "member-b", "slug", "bbb222", NO_PINS, first);

  assert.equal(git(a.path, "rev-parse", "HEAD"), first);
  assert.equal(git(b.path, "rev-parse", "HEAD"), first);
  assert.equal(readFileSync(join(a.path, "file.txt"), "utf8"), "first\n");
  assert.equal(readFileSync(join(b.path, "file.txt"), "utf8"), "first\n");
  // Still their own isolated trees on their own throwaway branches - the pin changes where
  // they start, not what they are.
  assert.notEqual(a.path, b.path);
  assert.equal(a.branch, "harness/slug-aaa111");
  assert.equal(b.branch, "harness/slug-bbb222");
});

test("a pinned base that this repository does not have leaves nothing behind", async () => {
  const { repo } = mkRepo("absent");
  const absent = "0".repeat(40);
  await assert.rejects(
    provisionWorktree(repo, "absent-task", "slug", "ccc333", NO_PINS, absent),
    /git worktree add failed/,
  );
  // No unrecorded worktree: nothing downstream will ever hold this path, so a directory
  // left here would be a leak no teardown could ever find.
  assert.equal(existsSync(join(WORKTREES_DIR, "absent-task")), false);
  assert.equal(git(repo, "branch", "--list", "harness/slug-ccc333"), "");
});

// ---- validating what a caller pinned ----------------------------------------------------

test("only a full commit id in this repository is accepted as a base", async () => {
  const { repo, first } = mkRepo("verify");

  assert.equal(await verifyPinnedBase(repo, first), first);

  for (const bad of [first.slice(0, 12), "main", "HEAD", "HEAD~1", "", "not a sha", "0".repeat(41)]) {
    await assert.rejects(verifyPinnedBase(repo, bad), /pinned base/, `should reject: ${bad}`);
  }
  // Syntactically perfect and simply not here. A ref name would have RESOLVED, which is the
  // subtler failure: it means something different an hour later, so a member's persisted
  // input would not describe what it actually started from.
  await assert.rejects(verifyPinnedBase(repo, "0".repeat(40)), /is not a commit in/);
});

test("a provisioned tree that is not at the requested commit is a failure, not a shrug", async () => {
  const { repo, first, second } = mkRepo("verify-head");
  const wt = await provisionWorktree(repo, "verify-head-task", "slug", "eee555", NO_PINS, first);
  await verifyHeadIs(wt.path, first);
  await assert.rejects(verifyHeadIs(wt.path, second), new RegExp(`expected ${second}`));
});

// ---- the pool arm ------------------------------------------------------------------------

test("a leased tree of this repository is reset to the base, keeping its warm caches", async () => {
  const { repo, first, second } = mkRepo("lease");

  // What a pool hands back: an existing checkout on its own branch, warm, and generally
  // NOT on the commit we want.
  const lease = join(home, "lease-tree");
  git(repo, "worktree", "add", "-q", "-b", "pool/1", lease, second);
  mkdirSync(join(lease, "cache"), { recursive: true });
  writeFileSync(join(lease, "cache", "warm.bin"), "expensive\n");
  writeFileSync(join(lease, "leftover.txt"), "a previous occupant's work\n");

  await pinLeasedWorktree(repo, lease, first);

  assert.equal(git(lease, "rev-parse", "HEAD"), first);
  assert.equal(readFileSync(join(lease, "file.txt"), "utf8"), "first\n");
  assert.equal(existsSync(join(lease, "leftover.txt")), false, "untracked leftovers go");
  // The pre-warmed dependencies the pool exists to keep must survive: this is the whole
  // difference between `clean -fd` and `clean -fdx`.
  assert.equal(readFileSync(join(lease, "cache", "warm.bin"), "utf8"), "expensive\n");
  // The pool's own branch follows the reset rather than being replaced.
  assert.equal(git(lease, "rev-parse", "--abbrev-ref", "HEAD"), "pool/1");
});

test("a lease we cannot prove belongs to this repository is never reset", async () => {
  const { repo, first } = mkRepo("lease-guard");
  const stranger = mkRepo("lease-stranger");
  writeFileSync(join(stranger.repo, "precious.txt"), "someone else's uncommitted work\n");

  await assert.rejects(
    pinLeasedWorktree(repo, stranger.repo, first),
    /refusing to reset a checkout we cannot prove/,
  );
  // The guard is on a HARD RESET, so the proof that it held is that the stranger's tree
  // still has everything in it.
  assert.equal(git(stranger.repo, "rev-parse", "HEAD"), stranger.second);
  assert.equal(readFileSync(join(stranger.repo, "precious.txt"), "utf8"), "someone else's uncommitted work\n");

  // A directory that is not a checkout at all is refused for the same reason.
  const plain = join(home, "not-a-repo");
  mkdirSync(plain, { recursive: true });
  await assert.rejects(pinLeasedWorktree(repo, plain, first), /refusing to reset a checkout we cannot prove/);
});
