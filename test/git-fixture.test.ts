import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gitIn, mkOriginAndClone, seedGitHistory, seedGitRepo } from "./helpers/git-fixture.ts";

/** Run `body` with one more git config entry in this worker's environment, then remove it. */
function withGitConfig(key: string, value: string, body: () => void): void {
  const before = process.env.GIT_CONFIG_COUNT;
  const index = Number.parseInt(before ?? "0", 10) || 0;
  process.env[`GIT_CONFIG_KEY_${index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${index}`] = value;
  process.env.GIT_CONFIG_COUNT = String(index + 1);
  try {
    body();
  } finally {
    delete process.env[`GIT_CONFIG_KEY_${index}`];
    delete process.env[`GIT_CONFIG_VALUE_${index}`];
    if (before === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = before;
  }
}

function supportsReftable(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "mission-git-fixture-probe-"));
  try {
    execFileSync("git", ["init", "-q", "--ref-format=reftable", probe], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

test("a seeded copy is the same repository, clean and on its branch", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-git-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = { "a.txt": "a\n", "dir/b.txt": "b\n" };
  const first = seedGitRepo(join(root, "first"), { branch: "main", files });
  const copy = seedGitRepo(join(root, "copy"), { branch: "main", files });
  assert.equal(copy, first, "one seed, one commit");
  for (const dir of ["first", "copy"]) {
    const repo = join(root, dir);
    assert.equal(gitIn(repo, "rev-parse", "HEAD"), first);
    assert.equal(gitIn(repo, "symbolic-ref", "--short", "HEAD"), "main");
    assert.equal(gitIn(repo, "status", "--porcelain"), "");
    // Plumbing does not refresh the index: a stale stat cache would list every file here.
    assert.equal(gitIn(repo, "diff-index", "--name-only", "HEAD"), "");
    assert.equal(gitIn(repo, "config", "user.email"), "t@test");
  }
  const [base, second] = seedGitHistory(join(root, "history"), {
    files: { "f.txt": "one\n" },
    later: [{ files: { "f.txt": "two\n" }, message: "second" }],
  });
  assert.equal(gitIn(join(root, "history"), "rev-parse", "HEAD^"), base);
  assert.equal(gitIn(join(root, "history"), "rev-parse", "HEAD"), second);
});

test("an origin-and-clone copy fetches from its own origin, not the first one built", () => {
  const first = mkOriginAndClone("mission-git-fixture-pair-a-");
  const second = mkOriginAndClone("mission-git-fixture-pair-b-");
  try {
    assert.equal(gitIn(second.clone, "remote", "get-url", "origin"), second.origin);
    gitIn(second.origin, "commit", "--allow-empty", "-qm", "only in the second origin");
    gitIn(second.clone, "fetch", "-q", "origin");
    assert.equal(gitIn(second.clone, "rev-parse", "origin/main"), gitIn(second.origin, "rev-parse", "HEAD"));
    assert.notEqual(gitIn(first.origin, "rev-parse", "HEAD"), gitIn(second.origin, "rev-parse", "HEAD"));
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("fixtures still work when git defaults new repositories to reftable", { skip: !supportsReftable() }, (t) => {
  // A global `init.defaultRefFormat=reftable` leaves no loose branch ref to read the sha from.
  const root = mkdtempSync(join(tmpdir(), "mission-git-fixture-reftable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  withGitConfig("init.defaultRefFormat", "reftable", () => {
    const repo = join(root, "repo");
    const sha = seedGitRepo(repo, { branch: "main", files: { "keep.txt": "base\n" }, message: "unique reftable seed" });
    assert.equal(gitIn(repo, "rev-parse", "--show-ref-format"), "reftable");
    assert.equal(gitIn(repo, "rev-parse", "HEAD"), sha);
    const copy = join(root, "copy");
    assert.equal(seedGitRepo(copy, { branch: "main", files: { "keep.txt": "base\n" }, message: "unique reftable seed" }), sha);
    assert.equal(gitIn(copy, "rev-parse", "HEAD"), sha);
    assert.equal(gitIn(copy, "status", "--porcelain"), "");
  });
});
