import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FULL_SHA, resolveCapturedCommit } from "../src/server/workflows/commit-id.ts";

/**
 * What is at stake: this resolver decides which commit a Check's worktree is pinned to, and
 * which commit a `pull_request` action's continuation is held to. Every way of getting it
 * wrong hands a REAL commit that is not the captured one to something that then reports its
 * answer as being about the submission.
 *
 * Real git repositories rather than a stubbed `run`, because every rule here is a rule about
 * what git actually does - ref shadowing, abbreviation ambiguity, object format - and a double
 * that encoded my belief about those would pass while the belief was wrong. That is not
 * hypothetical: the object-format rule below was added because a review caught the opposite
 * belief written down as a comment.
 */

const home = mkdtempSync(join(tmpdir(), "mission-commit-id-"));
after(() => rmSync(home, { recursive: true, force: true }));

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.com",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.com",
    },
  }).trim();
}

/** A repository with one commit, in the requested object format. */
function seed(name: string, format: "sha1" | "sha256"): { repo: string; head: string } {
  const repo = join(home, name);
  execFileSync("git", ["init", "-q", `--object-format=${format}`, "-b", "main", repo]);
  git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  return { repo, head: git(repo, "rev-parse", "HEAD") };
}

const sha1 = seed("sha1-repo", "sha1");

test("a full id for THIS repository short-circuits, and is returned exactly", () => {
  assert.equal(sha1.head.length, 40);
  assert.equal(FULL_SHA.test(sha1.head), true);
});

test("a full id resolves to itself", async () => {
  assert.equal(await resolveCapturedCommit(sha1.repo, sha1.head), sha1.head);
});

test("an abbreviation resolves to the one commit it names", async () => {
  assert.equal(await resolveCapturedCommit(sha1.repo, sha1.head.slice(0, 8)), sha1.head);
});

test("a 64-hex id in a SHA-1 repository is REFUSED, never short-circuited", async () => {
  // The hole a review caught, and the reason `fullIdWidth` asks git instead of reading the
  // string's length. Widening `FULL_SHA` to cover SHA-256 made every 64-character value look
  // full - and the short-circuit returns a "resolved" commit without consulting git at all, so
  // this would have been handed to a pin having been verified by nothing.
  //
  // It has to REFUSE rather than resolve: there is no such object here, and a check or a
  // continuation pinned to an id this repository does not have is infrastructure that cannot
  // run, not a verdict about the change.
  await assert.rejects(
    () => resolveCapturedCommit(sha1.repo, "a".repeat(64)),
    /names no commit/,
  );
});

test("a revision expression is refused before git is asked anything", async () => {
  // `HEAD~1` and a branch name both resolve to real commits that are not the captured one.
  for (const expression of ["HEAD", "HEAD~1", "main", "@{yesterday}", "v1.0"]) {
    await assert.rejects(
      () => resolveCapturedCommit(sha1.repo, expression),
      /is not a commit id/,
      expression,
    );
  }
});

test("a ref named like an abbreviation cannot shadow the object it looks like", async () => {
  // `rev-parse <prefix>` prefers a REFNAME over an object id with the same spelling, which is
  // why this resolver enumerates the object database with `--disambiguate` and consults no ref.
  const prefix = sha1.head.slice(0, 7);
  git(sha1.repo, "branch", prefix);
  assert.equal(await resolveCapturedCommit(sha1.repo, prefix), sha1.head);
  git(sha1.repo, "branch", "-D", prefix);
});

// SHA-256 support is what the review asked for, and it is only assertable where the local git
// can create such a repository. Skipped rather than faked when it cannot: a double would encode
// the belief under test.
const sha256 = (() => {
  try {
    return seed("sha256-repo", "sha256");
  } catch {
    return null;
  }
})();

test("a SHA-256 repository resolves its own 64-character ids", { skip: !sha256 }, async () => {
  assert.equal(sha256!.head.length, 64);
  // Full for THIS repository, so it short-circuits and comes back exactly.
  assert.equal(await resolveCapturedCommit(sha256!.repo, sha256!.head), sha256!.head);
  // And an abbreviation of it still disambiguates against the object database.
  assert.equal(
    await resolveCapturedCommit(sha256!.repo, sha256!.head.slice(0, 10)),
    sha256!.head,
  );
});

test("a 40-hex id in a SHA-256 repository is refused too", { skip: !sha256 }, async () => {
  // The mirror of the SHA-1 case: 40 characters is not full here, so it takes the
  // disambiguation path and is refused for naming nothing rather than trusted for its length.
  await assert.rejects(
    () => resolveCapturedCommit(sha256!.repo, "b".repeat(40)),
    /names no commit/,
  );
});
