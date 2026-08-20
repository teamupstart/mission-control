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
const { provisionWorktree, resolveDispatchBase, resolveTaskBases, verifyPinnedBase } =
  await import("../src/server/dispatcher.ts");
const { currentRemoteDefaultSha, originConfigured, parseLsRemoteHeadSha, parseSymrefHeadBranch } =
  await import("../src/server/git/remote-default.ts");
const { verifyHeadIs } = await import("../src/server/git/ensemble-snapshot.ts");

after(() => rmSync(home, { recursive: true, force: true }));

// Every one of these cases provisions into a plain `git worktree`, so there is nothing
// for a reap to consider and nothing held: no live session, no task, and no check lease.
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
  const wt = await provisionWorktree(repo, "unpinned-task", "slug", "abc123");

  assert.equal(wt.provider, "git");
  assert.equal(wt.branch, "harness/slug-abc123");
  assert.equal(git(wt.path, "rev-parse", "HEAD"), second);
  assert.equal(readFileSync(join(wt.path, "file.txt"), "utf8"), "second\n");

  // …and it follows HEAD, which is exactly the behaviour a pin exists to opt OUT of.
  writeFileSync(join(repo, "file.txt"), "third\n");
  git(repo, "commit", "-qam", "third");
  const third = git(repo, "rev-parse", "HEAD");
  const later = await provisionWorktree(repo, "unpinned-later", "slug", "def456");
  assert.equal(git(later.path, "rev-parse", "HEAD"), third);
});

// ---- the pin ---------------------------------------------------------------------------

test("two members pinned to one commit are identical even after the source moves", async () => {
  const { repo, first } = mkRepo("pinned");

  const a = await provisionWorktree(repo, "member-a", "slug", "aaa111", first);
  // The source checkout moves between the two launches - the exact race the pin removes.
  writeFileSync(join(repo, "file.txt"), "moved on\n");
  git(repo, "commit", "-qam", "moved on");
  const b = await provisionWorktree(repo, "member-b", "slug", "bbb222", first);

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
    provisionWorktree(repo, "absent-task", "slug", "ccc333", absent),
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
  const wt = await provisionWorktree(repo, "verify-head-task", "slug", "eee555", first);
  await verifyHeadIs(wt.path, first);
  await assert.rejects(verifyHeadIs(wt.path, second), new RegExp(`expected ${second}`));
});

// ---- where an ORDINARY task starts ------------------------------------------------------
//
// Everything above is about a caller that named a commit. This half is about the caller
// that named nothing, which is every scheduled task - and where those used to start was
// "whatever the main checkout's HEAD happened to be at that instant". Two failures live in
// that sentence. The checkout is stale by however long it has been since somebody pulled,
// so a task scheduled to run after its dependency merged would build on a base that does
// not contain it; and the checkout may be sitting on somebody's feature branch, so the base
// is one nobody chose. `resolveDispatchBase` replaces it with a freshly fetched
// remote-default commit, frozen to one full id before a single tree is taken.
//
// The low-level `provisionWorktree()` above keeps its local-HEAD default on purpose. It is
// called directly by local tooling and by tests that have no remote at all; the new policy
// belongs to the production dispatcher, which resolves the id and hands it down.

/**
 * A bare `origin` with one commit on `main`, a clone of it, and a seed checkout to push
 * more commits from. Real git throughout: a stale clone, an advancing remote and a
 * server-side default rename are all things a mock would have to be told about, and being
 * told is exactly what went wrong the first time.
 */
function mkRemote(name: string): { origin: string; clone: string; seed: string; base: string } {
  const origin = join(home, `${name}-origin`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = join(home, `${name}-seed`);
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  git(seed, "config", "user.email", "t@test");
  git(seed, "config", "user.name", "t");
  writeFileSync(join(seed, "file.txt"), "base\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "base");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  const clone = join(home, `${name}-clone`);
  execFileSync("git", ["clone", "-q", origin, clone]);
  return { origin, clone, seed, base: git(seed, "rev-parse", "HEAD") };
}

/** One more commit on `branch`, pushed - the remote moving on while the clone does not. */
function advance(seed: string, branch: string, text: string): string {
  git(seed, "checkout", "-q", "-B", branch);
  writeFileSync(join(seed, "file.txt"), `${text}\n`);
  git(seed, "commit", "-qam", text);
  git(seed, "push", "-q", "origin", branch);
  return git(seed, "rev-parse", "HEAD");
}

test("an ordinary task starts from the freshly fetched remote default, not the stale clone", async () => {
  const { clone, seed, base } = mkRemote("fresh-default");
  const moved = advance(seed, "main", "merged while the clone slept");

  // The clone has not fetched, so BOTH its local HEAD and its `origin/main` still name the
  // old commit. That is the exact state a dispatcher used to freeze.
  assert.equal(git(clone, "rev-parse", "HEAD"), base);
  assert.equal(git(clone, "rev-parse", "origin/main"), base);

  assert.equal(await resolveDispatchBase(clone), moved);
});

test("a server-side default rename is followed even while the clone's origin/HEAD is stale", async () => {
  const { origin, clone, seed } = mkRemote("renamed-default");
  const trunk = advance(seed, "trunk", "life after main");
  // The server changes which branch it publishes as HEAD. A `git fetch` does NOT refresh
  // the clone's cached `refs/remotes/origin/HEAD`, so anything reading that cache keeps
  // starting tasks on a branch the server stopped calling default - silently, forever.
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/trunk"]);
  assert.equal(git(clone, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"), "origin/main");

  assert.equal(await resolveDispatchBase(clone), trunk);
  // Asked of the remote, so the stale cache is still stale afterwards. Nothing here
  // depends on having repaired it.
  assert.equal(git(clone, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"), "origin/main");
});

test("a configured origin that cannot be fetched fails rather than falling back to local HEAD", async () => {
  const { clone } = mkRemote("dead-origin");
  git(clone, "remote", "set-url", "origin", join(home, "no-such-repository"));

  await assert.rejects(resolveDispatchBase(clone), /could not freeze .*remote default branch/);
});

test("a remote that advertises no branch as HEAD is refused, not approximated", async () => {
  const { origin, clone } = mkRemote("unborn-default");
  // The remote's HEAD points at a branch it does not have, so `ls-remote --symref` prints
  // no symref line at all. `main` is still right there and still fetchable, and taking it
  // would be the nearest-plausible-branch guess this refuses to make.
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/ghost"]);

  await assert.rejects(resolveDispatchBase(clone), /did not advertise a branch as its HEAD/);
});

test("a default branch missing from the remote-tracking refs is refused", async () => {
  // The other half of the same rule, driven directly because a real remote will not both
  // advertise a branch and fail to serve it: the branch is named, the fetch did not bring
  // it down, and there is therefore no commit to check out. Resolving through
  // `refs/remotes/origin/<branch>` rather than through the advertised sha is what makes
  // this a refusal instead of a checkout that fails later, inside a leased slot.
  const probed = await currentRemoteDefaultSha("/anywhere", async (_bin, args) =>
    args.includes("ls-remote")
      ? {
          stdout: `ref: refs/heads/trunk\tHEAD\n${"c".repeat(40)}\tHEAD\n`,
          stderr: "", code: 0, outcomeUnknown: false, overflowed: false,
        }
      : { stdout: "", stderr: "", code: 1, outcomeUnknown: false, overflowed: false },
  );
  assert.equal(probed.ok, false);
  assert.equal(probed.ok === false && probed.outcomeUnknown, false);
  assert.match(
    probed.ok === false ? probed.reason : "",
    /trunk is not in this repository's remote-tracking refs/,
  );
});

test("a repository with no origin at all still freezes its own local HEAD", async () => {
  // Not a fallback so much as the whole answer: a scratch checkout with no remote has
  // exactly one base, and refusing to dispatch into it would break local work for a rule
  // written about scheduled tasks.
  const { repo, second } = mkRepo("no-origin");
  assert.equal(await resolveDispatchBase(repo), second);
});

test("an origin listing that never answered fails closed instead of taking that fallback", async () => {
  // The dangerous direction. `git remote` reports a repository with no origin as an exit 0
  // with empty stdout, which is byte-identical to a killed child - so a caller reading the
  // exit code alone would take the local-HEAD path for a repository that HAS an origin,
  // which is the stale base this whole path exists to remove.
  const killed = await originConfigured("/anywhere", async () => ({
    stdout: "", stderr: "", code: 0, outcomeUnknown: true, overflowed: false,
  }));
  assert.equal(killed.ok, false);
  assert.equal(killed.ok === false && killed.outcomeUnknown, true);

  const listed = await originConfigured("/anywhere", async () => ({
    stdout: "upstream\norigin\nfork\n", stderr: "", code: 0, outcomeUnknown: false, overflowed: false,
  }));
  assert.deepEqual(listed, { ok: true, value: true });
  // Exact names only: a remote called `origins` or `my-origin` is not origin.
  const near = await originConfigured("/anywhere", async () => ({
    stdout: "origins\nmy-origin\n", stderr: "", code: 0, outcomeUnknown: false, overflowed: false,
  }));
  assert.deepEqual(near, { ok: true, value: false });
});

test("a remote that moved between the fetch and the observation is refused, not frozen stale", async () => {
  // The window this closes. `ls-remote` is asked AFTER the fetch, so its answer can already
  // describe a commit the fetch did not bring down. Taking the branch NAME from that answer
  // and the SHA from `refs/remotes/origin/<branch>` would silently freeze the older commit
  // and report it as a fresh remote default - the exact drift this path exists to remove,
  // wearing the disguise of a successful resolution.
  const advertised = "d".repeat(40);
  const fetched = "e".repeat(40);
  const raced = await currentRemoteDefaultSha("/anywhere", async (_bin, args) =>
    args.includes("ls-remote")
      ? {
          stdout: `ref: refs/heads/main\tHEAD\n${advertised}\tHEAD\n`,
          stderr: "", code: 0, outcomeUnknown: false, overflowed: false,
        }
      : { stdout: `${fetched}\n`, stderr: "", code: 0, outcomeUnknown: false, overflowed: false },
  );
  assert.equal(raced.ok, false);
  assert.match(
    raced.ok === false ? raced.reason : "",
    /advertised main at d{40} but this repository fetched e{40}/,
  );
  // Refused rather than repaired: nothing has been provisioned, so a retry is free and sees
  // a settled remote. Guessing which of the two commits was meant is not on the menu.

  // The agreeing case returns the commit the REMOTE stated, which is the same object the
  // fetch brought down - that agreement is the proof, not a coincidence worth ignoring.
  const settled = await currentRemoteDefaultSha("/anywhere", async (_bin, args) =>
    args.includes("ls-remote")
      ? {
          stdout: `ref: refs/heads/main\tHEAD\n${advertised}\tHEAD\n`,
          stderr: "", code: 0, outcomeUnknown: false, overflowed: false,
        }
      : { stdout: `${advertised}\n`, stderr: "", code: 0, outcomeUnknown: false, overflowed: false },
  );
  assert.deepEqual(settled, { ok: true, value: advertised });
});

test("an advertisement with no commit id behind it is refused", async () => {
  // A remote that names a branch and states no object for it has not answered the question
  // asked. There is a perfectly good local `refs/remotes/origin/main` to fall back on, and
  // falling back to it is precisely how a stale commit would get frozen.
  const bare = await currentRemoteDefaultSha("/anywhere", async () => ({
    stdout: "ref: refs/heads/main\tHEAD\n", stderr: "", code: 0, outcomeUnknown: false, overflowed: false,
  }));
  assert.equal(bare.ok, false);
  assert.match(bare.ok === false ? bare.reason : "", /advertised main as its HEAD without a commit id/);
});

test("only a well-formed symref line names a default branch", () => {
  assert.equal(parseSymrefHeadBranch("ref: refs/heads/main\tHEAD\n"), "main");
  // Taken whole rather than split on "/", or a repo whose default is `release/next` would
  // be read as the branch `release`.
  assert.equal(parseSymrefHeadBranch("ref: refs/heads/release/next\tHEAD\n"), "release/next");
  for (const malformed of [
    "",
    "abc123\tHEAD\n",
    "ref: refs/tags/v1\tHEAD\n",
    "ref: refs/heads/\tHEAD\n",
    "ref: refs/heads/main\trefs/heads/main\n",
  ]) {
    assert.equal(parseSymrefHeadBranch(malformed), null, `should not name a branch: ${malformed}`);
  }

  // The other half of the same answer, and the half that makes the freeze current.
  const sha = "9".repeat(40);
  assert.equal(parseLsRemoteHeadSha(`ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n`), sha);
  for (const malformed of [
    "",
    "ref: refs/heads/main\tHEAD\n",
    `${sha}\trefs/heads/main\n`,
    "nonsense\tHEAD\n",
    `${sha.slice(0, 12)}\tHEAD\n`,
  ]) {
    assert.equal(parseLsRemoteHeadSha(malformed), null, `should not name a commit: ${malformed}`);
  }
});

// ---- freezing every repository before the first tree is taken ---------------------------

test("an explicit pin wins over a remote default that has moved on", async () => {
  const { clone, seed, base } = mkRemote("pinned-wins");
  advance(seed, "main", "newer than the pin");
  const asked: string[] = [];

  const bases = await resolveTaskBases({ primary: clone, extras: [] }, base, async (repo) => {
    asked.push(repo);
    return "f".repeat(40);
  });

  assert.deepEqual(bases, { primary: base, extras: [] });
  // Not merely "the pin won" - the remote was never consulted for the primary at all, so a
  // pinned dispatch costs no fetch and cannot fail on one.
  assert.deepEqual(asked, []);
});

test("every attached repository is frozen before the loop, and one failure freezes nothing", async () => {
  const asked: string[] = [];
  const resolve = async (repo: string): Promise<string> => {
    asked.push(repo);
    if (repo === "/c") throw new Error("origin unreachable");
    return "a".repeat(40);
  };

  const bases = await resolveTaskBases({ primary: "/a", extras: ["/b", "/a"] }, null, resolve);
  // One resolution per DISTINCT root, in a fixed order: two fetches racing in one
  // repository contend for the same lock file for no benefit.
  assert.deepEqual(asked, ["/a", "/b"]);
  assert.deepEqual(bases, { primary: "a".repeat(40), extras: ["a".repeat(40), "a".repeat(40)] });

  asked.length = 0;
  await assert.rejects(
    resolveTaskBases({ primary: "/a", extras: ["/b", "/c", "/d"] }, null, resolve),
    /origin unreachable/,
  );
  // It stopped AT the failure and never reached `/d` - and, more to the point, the caller
  // never reached provisioning, so there is no earlier repository's lease to unwind.
  assert.deepEqual(asked, ["/a", "/b", "/c"]);
});
