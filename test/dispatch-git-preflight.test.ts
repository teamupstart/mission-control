import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// What is at stake: an operator being told a confident, false thing about their repository.
//
// Every git preflight in a dispatch runs through `run`, and `run` reports a child that DIED
// as `code: 1` with empty stdout - identical to a git that ran and answered "no". A caller
// reading `code` alone cannot tell the two apart, so "git was killed before it answered"
// becomes "this is not a git repository", which is a fact about the operator's checkout that
// nobody established. It ends the dispatch, and it sends whoever reads the task off
// investigating a repo that was never broken.
//
// That happened. A dispatch failed with `… is not a git repository` against a checkout that
// had served a `git pull` twelve seconds earlier and provisioned the next dispatch fifteen
// seconds later. The phase that depended on its pull request then sat in the backlog
// forever, because a dependency is satisfied by a MERGE and no PR was ever opened.
//
// So these tests pin the three-way distinction, and the two negatives matter as much as the
// positive: a real "no" has to stay a "no", or the fix is just a guard that never fires.

const home = mkdtempSync(join(tmpdir(), "mission-git-preflight-"));
process.env.HARNESS_HOME = join(home, "state");

const { provisionWorktree, verifyPinnedBase } = await import("../src/server/dispatcher.ts");
const { locateExecutableSync } = await import("../src/server/executables/locator.ts");
const realGit = locateExecutableSync("git")?.path;
assert.ok(realGit, "the Git preflight tests require a real Git executable");
const originalGitOverride = process.env.MISSION_GIT_BIN;
process.env.MISSION_GIT_BIN = realGit;

after(() => {
  if (originalGitOverride === undefined) delete process.env.MISSION_GIT_BIN;
  else process.env.MISSION_GIT_BIN = originalGitOverride;
  rmSync(home, { recursive: true, force: true });
});

/**
 * A `git` that dies without reporting an exit of its own.
 *
 * SIGKILL to itself rather than a sleep the timeout eventually reaps: it produces the very
 * same `outcomeUnknown` through the route that does NOT cost the test the full preflight
 * budget, and it is the more honest reproduction anyway - the OOM killer and an operator's
 * `pkill` reach a real dispatch far more often than our own ceiling does.
 */
function fakeGitThatDies(): string {
  const dir = join(home, "bin-dies");
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "git");
  writeFileSync(bin, "#!/bin/sh\nkill -9 $$\n");
  chmodSync(bin, 0o755);
  return dir;
}

/** Run `fn` with an explicit Git override, then restore the operator configuration. */
async function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  const originalOverride = process.env.MISSION_GIT_BIN;
  process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
  process.env.MISSION_GIT_BIN = join(dir, "git");
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
    if (originalOverride === undefined) delete process.env.MISSION_GIT_BIN;
    else process.env.MISSION_GIT_BIN = originalOverride;
  }
}

function mkRepo(name: string): { repo: string; head: string } {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
  git("config", "user.email", "t@test");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "first\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  return { repo, head: git("rev-parse", "HEAD") };
}

// ---- the bug ---------------------------------------------------------------------------

test("a git that dies before answering is never reported as 'not a git repository'", async () => {
  const { repo } = mkRepo("alive-and-well");
  const err = await withPath(fakeGitThatDies(), () =>
    provisionWorktree(repo, "task-id", "slug", "abc123").then(
      () => null,
      (e: unknown) => e as Error,
    ),
  );

  assert.ok(err, "the dispatch still has to fail - we genuinely do not know");
  // The whole point. This repository is fine, and the error must not say otherwise.
  assert.doesNotMatch(
    err.message,
    /is not a git repository/,
    "a killed check said nothing about the repository",
  );
  assert.match(err.message, /could not determine/, "it has to say what it failed to find out");
  assert.match(
    err.message,
    /can be retried/,
    "a read-only check provisioned nothing, and the operator needs to know that",
  );
});

test("a pinned base is not refused on the word of a git that died", async () => {
  const { repo, head } = mkRepo("pinned-alive");
  const err = await withPath(fakeGitThatDies(), () =>
    verifyPinnedBase(repo, head).then(
      () => null,
      (e: unknown) => e as Error,
    ),
  );

  assert.ok(err);
  assert.doesNotMatch(
    err.message,
    /is not a commit in/,
    "that commit exists - nothing looked for it",
  );
  assert.match(err.message, /could not determine/);
});

// ---- the negatives still fire ----------------------------------------------------------

test("a directory that really is not a repository still says so", async () => {
  const plain = join(home, "not-a-repo");
  mkdirSync(plain, { recursive: true });

  await assert.rejects(
    provisionWorktree(plain, "task-id", "slug", "abc123"),
    /is not a git repository/,
    "git ran and answered, so the confident message is the correct one",
  );
});

test("a base that really is absent is still refused", async () => {
  const { repo } = mkRepo("pinned-missing");

  await assert.rejects(
    verifyPinnedBase(repo, "0".repeat(40)),
    /is not a commit in/,
    "an empty --quiet answer from a git that exited is a real 'no'",
  );
});
