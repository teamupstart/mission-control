import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUnpushedCommits } from "../src/server/git/unpushed.ts";
import type { UnpushedDeps } from "../src/server/git/unpushed.ts";
import { unpushedClause, hasUnpushedCommits } from "../src/shared/unpushed.ts";
import { run, stubRun } from "../src/server/util/exec.ts";
import { gitIn, mkCloneOnBranch, mkOriginAndClone } from "./helpers/git-fixture.ts";

// What a checkout can say about commits origin has never seen, and - far more of this file -
// what it must REFUSE to say.
//
// The reason the refusals outnumber the answers is that this reader feeds a sentence a person
// reads as an accusation: "you have commits that are not pushed". Getting that wrong on a
// branch that simply has no remote sends someone looking for a mistake they never made, so
// every state that is not a positive, gated count has its own test proving it stays quiet.
//
// Real git throughout, because every interesting case here IS a git state - a tracking ref, a
// detached HEAD, a branch pushed under another name - and none of them survive being mocked.
// The exec seam is used only for the two failures real git will not perform on demand: a
// child that dies without answering, and a count that comes back unparsable.

/** A repo with an identity, so a commit here does not depend on the operator's git config. */
function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "pipe" });
  gitIn(dir, "config", "user.email", "t@test");
  gitIn(dir, "config", "user.name", "t");
}

/** Commit a change in `dir` and return nothing - the shape "the agent fixed the findings". */
function commitWork(dir: string, text: string): void {
  writeFileSync(join(dir, "keep.txt"), `base\n${text}\n`);
  gitIn(dir, "commit", "-qam", text);
}

/**
 * A clone on `main`, tracking `origin/main`, with nothing local yet.
 *
 * The origin is a non-bare repo with `main` checked out, so it refuses a push to the branch
 * it is standing on. Allowing it keeps the push tests testing THIS reader rather than a
 * property of the fixture; nothing here ever looks at the origin's worktree.
 */
function cloneOnMain(): string {
  const { origin, clone } = mkOriginAndClone("harness-unpushed-");
  gitIn(origin, "config", "receive.denyCurrentBranch", "ignore");
  return clone;
}

test("a committed-but-unpushed head reports the count, the branch and the tracking ref", async () => {
  const clone = cloneOnMain();
  commitWork(clone, "the fix the Inspector asked for");

  const obs = await readUnpushedCommits(clone);

  assert.deepEqual(obs, {
    state: "ahead",
    commits: 1,
    branch: "main",
    upstream: "origin/main",
  });
  assert.equal(hasUnpushedCommits(obs), true);
  assert.equal(unpushedClause(obs), "you have 1 commit that is not pushed");
});

test("several unpushed commits are counted, and the clause reads as a plural", async () => {
  const clone = cloneOnMain();
  commitWork(clone, "first");
  commitWork(clone, "second");
  commitWork(clone, "third");

  const obs = await readUnpushedCommits(clone);

  assert.equal(obs.state, "ahead");
  assert.equal(obs.state === "ahead" && obs.commits, 3);
  assert.equal(unpushedClause(obs), "you have 3 commits that are not pushed");
});

test("a checkout level with its remote claims nothing", async () => {
  const clone = cloneOnMain();

  const obs = await readUnpushedCommits(clone);

  assert.deepEqual(obs, { state: "pushed", branch: "main", upstream: "origin/main" });
  // `pushed` is a positive observation and still says nothing: a push is not the missing
  // step, which is a fact about what NOT to say rather than something to say.
  assert.equal(unpushedClause(obs), null);
  assert.equal(hasUnpushedCommits(obs), false);
});

test("pushing the work clears the claim", async () => {
  const clone = cloneOnMain();
  commitWork(clone, "the fix");
  assert.equal((await readUnpushedCommits(clone)).state, "ahead");

  gitIn(clone, "push", "-q", "origin", "main");

  assert.deepEqual(await readUnpushedCommits(clone), {
    state: "pushed",
    branch: "main",
    upstream: "origin/main",
  });
});

test("work pushed under a DIFFERENT branch name is not reported as unpushed", async () => {
  // The gate-vs-count split, which is the whole reason the count spans every origin ref
  // instead of `@{upstream}..HEAD`. This session pushed its commits; they are on the remote
  // under another name. Telling it to push again would be telling it to redo done work.
  const clone = cloneOnMain();
  commitWork(clone, "the fix, pushed somewhere else");
  gitIn(clone, "push", "-q", "origin", "HEAD:refs/heads/review-fixes");

  const obs = await readUnpushedCommits(clone);

  assert.equal(obs.state, "pushed", "commits reachable from any origin ref are pushed");
  assert.equal(unpushedClause(obs), null);
});

test("a clone whose remote is not named `origin` is not accused of its whole history", async () => {
  // Regression. Scoping the count to `--remotes=origin` reported every commit in a fully
  // pushed fork as unpushed, because a clone whose remote is called `upstream` has no
  // `origin/*` refs for the count to find. The reader compares against EVERY remote-tracking
  // ref for exactly this reason.
  const root = mkdtempSync(join(tmpdir(), "harness-unpushed-fork-"));
  const origin = join(root, "origin");
  gitInit(origin);
  writeFileSync(join(origin, "keep.txt"), "base\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-qm", "base");
  commitWork(origin, "more history");

  // `--origin upstream` is what a fork's clone looks like: a real tracking ref, named
  // anything but origin.
  const fork = join(root, "fork");
  execFileSync("git", ["clone", "-q", "--origin", "upstream", origin, fork], { stdio: "pipe" });

  const clean = await readUnpushedCommits(fork);
  assert.deepEqual(
    clean,
    { state: "pushed", branch: "main", upstream: "upstream/main" },
    "a fully pushed fork must claim nothing, whatever its remote is called",
  );

  // And it still SEES genuinely local work on that same fork.
  gitIn(fork, "config", "user.email", "t@test");
  gitIn(fork, "config", "user.name", "t");
  commitWork(fork, "local only");
  const ahead = await readUnpushedCommits(fork);
  assert.equal(ahead.state, "ahead");
  assert.equal(ahead.state === "ahead" && ahead.commits, 1);
});

test("a branch that tracks nothing is UNKNOWN, never an accusation", async () => {
  // The case that must never speak. `mkCloneOnBranch` cuts a local branch and commits on it
  // without ever pushing, which is the ordinary state of work in progress - and the state a
  // naive `rev-list` would report as several forgotten commits.
  const clone = mkCloneOnBranch("harness-unpushed-noupstream-", "feature/no-remote");

  const obs = await readUnpushedCommits(clone);

  assert.deepEqual(obs, { state: "unknown", why: "no_upstream" });
  assert.equal(unpushedClause(obs), null);
  assert.equal(hasUnpushedCommits(obs), false);
});

test("a detached HEAD is UNKNOWN", async () => {
  const clone = cloneOnMain();
  commitWork(clone, "work");
  gitIn(clone, "checkout", "-q", "--detach");

  assert.deepEqual(await readUnpushedCommits(clone), { state: "unknown", why: "detached_head" });
});

test("a path outside any repository is UNKNOWN", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-unpushed-bare-"));

  assert.deepEqual(await readUnpushedCommits(dir), { state: "unknown", why: "not_a_repo" });
});

test("no checkout at all is UNKNOWN", async () => {
  assert.deepEqual(await readUnpushedCommits(null), { state: "unknown", why: "no_checkout" });
});

test("a subdirectory of the checkout answers for the whole worktree", async () => {
  const clone = cloneOnMain();
  commitWork(clone, "the fix");
  const nested = join(clone, "packages", "web");
  mkdirSync(nested, { recursive: true });

  const obs = await readUnpushedCommits(nested);

  assert.equal(obs.state, "ahead");
  assert.equal(obs.state === "ahead" && obs.commits, 1);
});

test("a git child that DIES without answering is UNKNOWN, not zero", async () => {
  // `outcomeUnknown` is the difference between "git said no" and "we never found out", and a
  // killed child reports a non-zero exit that looks exactly like a refusal. Reading it as a
  // count of zero would turn a dead subprocess into a confident all-clear.
  const clone = cloneOnMain();
  commitWork(clone, "the fix");

  for (const dying of ["rev-parse", "symbolic-ref", "rev-list"]) {
    const deps: UnpushedDeps = {
      run: (bin, args, opts) => {
        if (args.includes(dying)) {
          return Promise.resolve({ stdout: "", stderr: "", code: 137, outcomeUnknown: true, overflowed: false });
        }
        return run(bin, args, opts);
      },
    };

    assert.deepEqual(
      await readUnpushedCommits(clone, deps),
      { state: "unknown", why: "git_failed" },
      `a dying \`git ${dying}\` must not produce a claim`,
    );
  }
});

test("a count that is not a number is UNKNOWN rather than a confident zero", async () => {
  const clone = cloneOnMain();
  commitWork(clone, "the fix");
  const deps: UnpushedDeps = {
    run: (bin, args, opts) =>
      args.includes("rev-list")
        ? Promise.resolve(stubRun({ stdout: "warning: something\n", stderr: "", code: 0 }))
        : run(bin, args, opts),
  };

  assert.deepEqual(await readUnpushedCommits(clone, deps), { state: "unknown", why: "unreadable" });
});

test("a failing count is UNKNOWN", async () => {
  const clone = cloneOnMain();
  const deps: UnpushedDeps = {
    run: (bin, args, opts) =>
      args.includes("rev-list")
        ? Promise.resolve(stubRun({ stdout: "", stderr: "fatal: bad revision", code: 128 }))
        : run(bin, args, opts),
  };

  assert.deepEqual(await readUnpushedCommits(clone, deps), { state: "unknown", why: "git_failed" });
});

test("it reads and never writes: no push, no fetch, and the checkout is untouched", async () => {
  // The load-bearing constraint. This reader explains why a run is parked waiting for a
  // pushed head; a reader that pushed would clear the condition it was asked to describe,
  // and one that fetched would put the network on a 5-second poll.
  const clone = cloneOnMain();
  commitWork(clone, "the fix");

  const gitDir = gitIn(clone, "rev-parse", "--absolute-git-dir");
  const before = {
    head: gitIn(clone, "rev-parse", "HEAD"),
    refs: gitIn(clone, "show-ref"),
    status: gitIn(clone, "status", "--porcelain"),
    index: readFileSync(join(gitDir, "index")),
  };

  const calls: string[][] = [];
  const deps: UnpushedDeps = {
    run: (bin, args, opts) => {
      calls.push(args);
      assert.equal(bin, "git", "this reader spawns nothing but git");
      return run(bin, args, opts);
    },
  };

  const obs = await readUnpushedCommits(clone, deps);
  assert.equal(obs.state, "ahead");

  const forbidden = ["push", "fetch", "commit", "update-ref", "add", "reset", "clean", "checkout", "pull"];
  for (const args of calls) {
    for (const word of forbidden) {
      assert.ok(!args.includes(word), `\`git ${args.join(" ")}\` must not run a ${word}`);
    }
  }

  assert.equal(gitIn(clone, "rev-parse", "HEAD"), before.head, "HEAD moved");
  assert.equal(gitIn(clone, "show-ref"), before.refs, "a ref moved");
  assert.equal(gitIn(clone, "status", "--porcelain"), before.status, "the worktree changed");
  assert.deepEqual(readFileSync(join(gitDir, "index")), before.index, "the index was rewritten");
});

test("the clause is silent for every state that is not a gated count", () => {
  assert.equal(unpushedClause(null), null);
  assert.equal(unpushedClause(undefined), null);
  assert.equal(unpushedClause({ state: "pushed", branch: "main", upstream: "origin/main" }), null);
  for (
    const why of ["no_checkout", "not_a_repo", "detached_head", "no_upstream", "git_failed", "unreadable"] as const
  ) {
    assert.equal(unpushedClause({ state: "unknown", why }), null, `${why} must claim nothing`);
  }
  assert.equal(hasUnpushedCommits(null), false);
  assert.equal(hasUnpushedCommits(undefined), false);
});
