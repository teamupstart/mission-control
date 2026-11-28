import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readUnchangedRepository } from "../src/server/workflows/unchanged-repository.ts";
import { tempDir } from "./temp-root.mjs";

const home = tempDir("mission-no-change-");
after(() => rmSync(home, { recursive: true, force: true }));
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env,
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } }).trim();
}
function repo(name: string) {
  const root = join(home, name);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, "commit", "-q", "--allow-empty", "-m", "base");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "checkout", "-q", "--detach");
  return root;
}

test("a clean detached checkout at or behind origin/main proves no changes", async () => {
  const root = repo("clean");
  const head = git(root, "rev-parse", "HEAD");
  assert.deepEqual(await readUnchangedRepository(root, head), {
    headOid: head, baseOid: head, baseRef: "origin/main", treeOid: git(root, "rev-parse", "HEAD^{tree}"),
  });
  git(root, "switch", "-q", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "upstream");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "checkout", "-q", "--detach", head);
  assert.ok(await readUnchangedRepository(root, head));
});

test("dirty, staged, untracked, ahead, missing base and stale head never prove no changes", async () => {
  const root = repo("negative");
  const head = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "work.txt"), "work");
  assert.equal(await readUnchangedRepository(root, head), null);
  git(root, "add", "work.txt");
  assert.equal(await readUnchangedRepository(root, head), null);
  git(root, "commit", "-q", "-m", "work");
  assert.equal(await readUnchangedRepository(root, git(root, "rev-parse", "HEAD")), null);
  await assert.rejects(readUnchangedRepository(root, head), /HEAD changed/);
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(root, "work.txt"), "unstaged edit");
  assert.equal(await readUnchangedRepository(root, git(root, "rev-parse", "HEAD")), null);
  git(root, "update-ref", "-d", "refs/remotes/origin/main");
  git(root, "branch", "-D", "main");
  git(root, "restore", "work.txt");
  await assert.rejects(readUnchangedRepository(root, git(root, "rev-parse", "HEAD")), /default base/);
  await assert.rejects(readUnchangedRepository(join(home, "absent"), head), /status could not be read/);
});

for (const change of ["unstaged", "staged", "untracked"] as const) {
  test(`${change} work is positively changed even without a resolvable default base`, async () => {
    const root = repo(`missing-base-${change}`);
    writeFileSync(join(root, "tracked.txt"), "base");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-q", "-m", "tracked base");
    git(root, "update-ref", "-d", "refs/remotes/origin/main");
    git(root, "branch", "-D", "main");
    const head = git(root, "rev-parse", "HEAD");
    // The same clean checkout cannot supply no-change proof without its base.
    await assert.rejects(readUnchangedRepository(root, head), /default base/);
    writeFileSync(join(root, change === "untracked" ? "new.txt" : "tracked.txt"), "changed");
    if (change === "staged") git(root, "add", "tracked.txt");
    assert.equal(await readUnchangedRepository(root, head), null);
    git(root, "switch", "-q", "-c", "feature");
    assert.equal(await readUnchangedRepository(root, head), null);
  });
}


test("an empty commit ahead is still work to publish", async () => {
  const root = repo("empty-ahead");
  git(root, "switch", "-q", "-c", "feature");
  git(root, "commit", "-q", "--allow-empty", "-m", "ahead");
  assert.equal(await readUnchangedRepository(root, git(root, "rev-parse", "HEAD")), null);
});

// The proof is read while a Pull Request action's repository capture may be sealing the same
// checkout. That capture refuses when the checkout's git directory changes under it, so this
// read must never take or rewrite the index, even when its stat cache is stale.
test("reading the proof never takes the index lock or rewrites the index", async () => {
  const root = join(home, "stale-index");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  writeFileSync(join(root, "tracked.txt"), "same content\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-q", "-m", "base");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "checkout", "-q", "--detach");
  // Same bytes, new mtime: the index's cached stat data no longer matches the file, which is
  // exactly what makes a plain `git status` refresh and write the index.
  utimesSync(join(root, "tracked.txt"), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  const index = join(root, ".git", "index");
  const before = statSync(index, { bigint: true });
  const head = git(root, "rev-parse", "HEAD");
  assert.ok(await readUnchangedRepository(root, head), "an unchanged checkout still proves no changes");
  const after = statSync(index, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs, "the index was not rewritten");
  assert.equal(after.ino, before.ino, "the index was not replaced through index.lock");
});
